// routes/cotizaciones.js — Cotizaciones de productos: se generan, se envían al
// cliente (WhatsApp/PDF) y si acepta se confirman como venta real (baja stock).
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
function uuid() { return crypto.randomUUID(); }

async function ensureCotizacionesTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cotizaciones (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id       UUID REFERENCES sucursales(id),
      folio             TEXT NOT NULL,
      cliente_nombre    TEXT DEFAULT '',
      cliente_telefono  TEXT DEFAULT '',
      cliente_email     TEXT DEFAULT '',
      notas             TEXT DEFAULT '',
      subtotal          NUMERIC(12,2) DEFAULT 0,
      descuento         NUMERIC(12,2) DEFAULT 0,
      total             NUMERIC(12,2) DEFAULT 0,
      estado            TEXT DEFAULT 'pendiente',
      valida_hasta      DATE,
      venta_id          UUID REFERENCES ventas(id),
      cajero            TEXT DEFAULT '',
      creado_en         TIMESTAMPTZ DEFAULT now(),
      confirmada_en     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS cotizacion_items (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cotizacion_id     UUID NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
      producto_id       UUID REFERENCES productos(id),
      nombre_producto   TEXT DEFAULT '',
      cantidad          INTEGER DEFAULT 1,
      precio_unitario   NUMERIC(12,2) DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cotizaciones_negocio ON cotizaciones(negocio_id);
  `);
  // Copia de la imagen del producto al momento de cotizar — igual que
  // nombre_producto, es un snapshot: si luego cambia/borra la foto del
  // producto, la cotización ya emitida conserva la que tenía.
  await pool.query(`ALTER TABLE cotizacion_items ADD COLUMN IF NOT EXISTS imagen_url TEXT DEFAULT ''`);
  // Sin ON DELETE SET NULL, borrar un negocio con productos referenciados
  // por cotizaciones fallaba (FK violation) — mismo arreglo que ya se hace
  // para venta_detalle/lotes/pedido_items en server.js.
  try {
    await pool.query(`
      ALTER TABLE cotizacion_items DROP CONSTRAINT IF EXISTS cotizacion_items_producto_id_fkey;
      ALTER TABLE cotizacion_items ADD CONSTRAINT cotizacion_items_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
    `);
  } catch(e) {}
}

function folioCotizacion() {
  return 'COT-' + Date.now().toString().slice(-8) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// ── POST /api/cotizaciones — crear ────────────────────────────
router.post('/cotizaciones', async (req, res) => {
  try {
    await ensureCotizacionesTables();
    const { negocio_id, sucursal_id } = req.caja;
    const {
      cliente_nombre = '', cliente_telefono = '', cliente_email = '', notas = '',
      items = [], descuento = 0, valida_hasta = null, cajero = ''
    } = req.body;
    if (!items.length) return res.status(400).json({ error: 'La cotización debe tener al menos un producto' });

    const subtotal = items.reduce((s, i) => s + (parseFloat(i.precio_unitario) || 0) * (parseInt(i.cantidad) || 1), 0);
    const total = Math.max(subtotal - (parseFloat(descuento) || 0), 0);
    const folio = folioCotizacion();

    const ins = await pool.query(
      `INSERT INTO cotizaciones (negocio_id, sucursal_id, folio, cliente_nombre, cliente_telefono, cliente_email, notas,
        subtotal, descuento, total, valida_hasta, cajero)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, folio`,
      [negocio_id, sucursal_id || null, folio, cliente_nombre, cliente_telefono, cliente_email, notas,
       subtotal, descuento, total, valida_hasta, cajero]
    );
    const cotId = ins.rows[0].id;

    for (const it of items) {
      await pool.query(
        `INSERT INTO cotizacion_items (cotizacion_id, producto_id, nombre_producto, cantidad, precio_unitario, imagen_url)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [cotId, it.producto_id || null, it.nombre || it.nombre_producto || '', it.cantidad || 1, it.precio_unitario || 0, it.imagen_url || '']
      );
    }
    res.json({ ok: true, id: cotId, folio, subtotal, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cotizaciones — listar ────────────────────────────
router.get('/cotizaciones', async (req, res) => {
  try {
    await ensureCotizacionesTables();
    const r = await pool.query(
      `SELECT c.*,
        COALESCE(json_agg(json_build_object(
          'producto_id', ci.producto_id, 'nombre_producto', ci.nombre_producto,
          'cantidad', ci.cantidad, 'precio_unitario', ci.precio_unitario, 'imagen_url', ci.imagen_url
        )) FILTER (WHERE ci.id IS NOT NULL), '[]') AS items
       FROM cotizaciones c
       LEFT JOIN cotizacion_items ci ON ci.cotizacion_id = c.id
       WHERE c.negocio_id=$1
       GROUP BY c.id ORDER BY c.creado_en DESC LIMIT 150`,
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/cotizaciones/:id/estado — marcar enviada/cancelada ──
router.put('/cotizaciones/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!['enviada', 'cancelada', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    await pool.query(
      `UPDATE cotizaciones SET estado=$1 WHERE id=$2 AND negocio_id=$3 AND estado NOT IN ('confirmada')`,
      [estado, req.params.id, req.caja.negocio_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cotizaciones/:id/confirmar — convierte en venta real ──
router.post('/cotizaciones/:id/confirmar', async (req, res) => {
  const { negocio_id, sucursal_id, id: cajaId, giro } = req.caja;
  const client = await pool.connect();
  try {
    await ensureCotizacionesTables();
    await client.query('BEGIN');

    const cot = await client.query(
      `SELECT * FROM cotizaciones WHERE id=$1 AND negocio_id=$2 AND estado NOT IN ('confirmada','cancelada')`,
      [req.params.id, negocio_id]
    );
    if (!cot.rows.length) throw Object.assign(new Error('Cotización no encontrada o ya procesada'), { status: 404 });
    const c = cot.rows[0];
    const items = await client.query('SELECT * FROM cotizacion_items WHERE cotizacion_id=$1', [c.id]);

    const sucId = c.sucursal_id || sucursal_id;
    for (const it of items.rows) {
      if (!it.producto_id) continue;
      const stock = await client.query(
        'SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2',
        [it.producto_id, sucId]
      );
      if (parseFloat(stock.rows[0].stock) < it.cantidad) {
        throw Object.assign(new Error('Sin stock suficiente de "' + it.nombre_producto + '" (' + stock.rows[0].stock + ' disponible)'), { status: 400 });
      }
    }

    const { forma_pago = 'efectivo', efectivo_recibido = null, cajero = '' } = req.body;
    const ventaId = uuid();
    const ultimo = await client.query('SELECT folio FROM ventas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 1', [negocio_id]);
    let num = 1;
    if (ultimo.rows[0]) { const m = ultimo.rows[0].folio.match(/(\d+)$/); if (m) num = parseInt(m[1]) + 1; }
    const folioVenta = 'COT-' + Date.now().toString().slice(-8) + '-' + String(num).padStart(4,'0');
    const total = parseFloat(c.total);
    const recibido = efectivo_recibido != null ? parseFloat(efectivo_recibido) : total;

    await client.query(
      `INSERT INTO ventas (id, negocio_id, sucursal_id, caja_id, folio, subtotal, descuento, iva, total,
         forma_pago, efectivo_recibido, cambio, cajero, giro, referencia_externa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14)`,
      [ventaId, negocio_id, sucId, cajaId, folioVenta, c.subtotal, c.descuento, total,
       forma_pago, recibido, Math.max(0, recibido - total), cajero || c.cajero || 'Cotización', giro || 'tienda', c.folio]
    );

    for (const it of items.rows) {
      await client.query(
        `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), ventaId, it.producto_id, it.nombre_producto, it.cantidad, it.precio_unitario, it.cantidad * it.precio_unitario]
      );
      if (it.producto_id) {
        await client.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id)
           VALUES ($1,$2,$3,$4,$5,$6,'venta',$7)`,
          [uuid(), negocio_id, sucId, it.producto_id, cajaId, -it.cantidad, ventaId]
        );
        await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [it.producto_id]);
      }
    }

    await client.query(
      "UPDATE cotizaciones SET estado='confirmada', venta_id=$1, confirmada_en=now() WHERE id=$2",
      [ventaId, c.id]
    );

    await client.query('COMMIT');
    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocio_id).emit('cotizacion:confirmada', { id: c.id, venta_id: ventaId });
    res.json({ ok: true, venta_id: ventaId, folio_venta: folioVenta });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = { router, ensureCotizacionesTables };
