// routes/ventas-pendientes.js — "Caja de cobro": una caja de piso arma un
// ticket (reservando stock de inmediato) y otra caja de la misma sucursal
// lo escanea/busca para cobrarlo. Vive 100% en la nube porque la caja que
// cobra puede ser una PC distinta a la que armó el ticket.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
const { crearVentaCompletada } = require('./ventas-shared');
function uuid() { return crypto.randomUUID(); }

const MINUTOS_EXPIRACION_PENDIENTE = 120;

let _tablasOk = false;
async function ensureVentasPendientesTables() {
  if (_tablasOk) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ventas_pendientes (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id     UUID NOT NULL REFERENCES sucursales(id),
      caja_origen_id  UUID REFERENCES cajas(id),
      caja_cobro_id   UUID REFERENCES cajas(id),
      codigo          TEXT UNIQUE NOT NULL,
      cliente_id      UUID REFERENCES clientes(id),
      subtotal        NUMERIC(12,2) DEFAULT 0,
      descuento       NUMERIC(12,2) DEFAULT 0,
      iva             NUMERIC(12,2) DEFAULT 0,
      total           NUMERIC(12,2) NOT NULL,
      cajero          TEXT DEFAULT '',
      giro            TEXT DEFAULT 'tienda',
      estado          TEXT NOT NULL DEFAULT 'pendiente',
      venta_id        UUID REFERENCES ventas(id),
      expira_en       TIMESTAMPTZ NOT NULL,
      creado_en       TIMESTAMPTZ DEFAULT now(),
      cobrada_en      TIMESTAMPTZ,
      cancelada_en    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ventas_pendientes_sucursal ON ventas_pendientes(sucursal_id, estado);
    CREATE INDEX IF NOT EXISTS idx_ventas_pendientes_codigo   ON ventas_pendientes(codigo);
    CREATE TABLE IF NOT EXISTS ventas_pendientes_detalle (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      venta_pendiente_id UUID NOT NULL REFERENCES ventas_pendientes(id) ON DELETE CASCADE,
      producto_id        UUID REFERENCES productos(id),
      nombre_producto    TEXT DEFAULT '',
      cantidad           INTEGER DEFAULT 1,
      precio_unitario    NUMERIC(12,2) DEFAULT 0,
      subtotal           NUMERIC(12,2) DEFAULT 0
    );
  `);
  await pool.query(`ALTER TABLE stock_movimientos ADD COLUMN IF NOT EXISTS venta_pendiente_id UUID REFERENCES ventas_pendientes(id)`);
  _tablasOk = true;
}

function generarCodigo() {
  return 'PC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function broadcast(req, evento, data) {
  const io = req.app.get('io');
  if (io) io.to('negocio:' + req.caja.negocio_id).emit(evento, data);
}

// Revierte la reserva de stock de un ticket pendiente: por cada movimiento
// original 'reserva_pendiente' inserta el inverso y toca productos.actualizado_en
// para que el pull incremental de cada PC recoja el stock restaurado.
async function revertirReserva(client, ventaPendienteId) {
  const movs = await client.query(
    `SELECT * FROM stock_movimientos WHERE venta_pendiente_id=$1 AND motivo='reserva_pendiente'`,
    [ventaPendienteId]
  );
  for (const m of movs.rows) {
    await client.query(
      `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,'reserva_liberada')`,
      [uuid(), m.negocio_id, m.sucursal_id, m.producto_id, m.caja_id, -m.cantidad]
    );
    await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [m.producto_id]);
  }
}

async function expirarUnaPendiente(client, row) {
  await revertirReserva(client, row.id);
  await client.query(`UPDATE ventas_pendientes SET estado='expirada', cancelada_en=now() WHERE id=$1`, [row.id]);
}

// ── POST /api/ventas-pendientes — caja de piso arma el ticket ──
router.post('/ventas-pendientes', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const v = req.body;
  if (!v.items || !v.items.length) return res.status(400).json({ error: 'El ticket debe tener productos' });
  const client = await pool.connect();
  try {
    await ensureVentasPendientesTables();
    await client.query('BEGIN');
    const giroReal = req.caja.giro || v.giro || 'tienda';

    for (const item of v.items) {
      if (item.kit_id || item.variante_id) {
        throw Object.assign(new Error('Los kits y las variantes todavía no se pueden enviar a caja de cobro'), { status: 400 });
      }
      const itemId  = item.producto_id || item.id;
      const itemQty = parseInt(item.cantidad || item.qty || 1);
      if (!itemId) continue;
      const stock = await client.query(
        'SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2',
        [itemId, sucursal_id]
      );
      if (parseFloat(stock.rows[0].stock) < itemQty) {
        const nombre = item.nombre || item.nombre_producto || 'producto';
        throw Object.assign(new Error('Sin stock suficiente de "' + nombre + '"'), { status: 400 });
      }
    }

    const subtotalCalc = v.items.reduce((s,i) => s + (parseFloat(i.precio_unitario||i.precio||0)) * (parseInt(i.cantidad||i.qty||1)), 0);
    const subtotal = subtotalCalc > 0 ? subtotalCalc : parseFloat(v.subtotal||v.total||0);
    const descuento = v.descuento || 0;
    const base = subtotal - descuento;
    const iva = v.iva_activo ? parseFloat((base*0.16).toFixed(2)) : 0;
    const total = base + iva > 0 ? base + iva : parseFloat(v.total||0);
    const codigo = generarCodigo();
    const pendienteId = uuid();

    await client.query(
      `INSERT INTO ventas_pendientes (id, negocio_id, sucursal_id, caja_origen_id, codigo, cliente_id,
        subtotal, descuento, iva, total, cajero, giro, expira_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + interval '${MINUTOS_EXPIRACION_PENDIENTE} minutes')`,
      [pendienteId, negocio_id, sucursal_id, caja_id, codigo, v.cliente_id||null,
       subtotal, descuento, iva, total, v.cajero||'', giroReal]
    );

    for (const item of v.items) {
      const itemId  = item.producto_id || item.id;
      const itemNom = item.nombre || item.nombre_producto || '';
      const itemQty = parseInt(item.cantidad || item.qty || 1);
      const itemPrc = parseFloat(item.precio_unitario || item.precio || 0);
      await client.query(
        `INSERT INTO ventas_pendientes_detalle (id, venta_pendiente_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), pendienteId, itemId||null, itemNom, itemQty, itemPrc, itemQty*itemPrc]
      );
      if (itemId) {
        await client.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_pendiente_id)
           VALUES ($1,$2,$3,$4,$5,$6,'reserva_pendiente',$7)`,
          [uuid(), negocio_id, sucursal_id, itemId, caja_id, -itemQty, pendienteId]
        );
        await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [itemId]);
      }
    }

    await client.query('COMMIT');
    broadcast(req, 'sync:cambios', { venta_pendiente_nueva: true, codigo });
    res.json({ ok: true, id: pendienteId, codigo, total, expira_en_minutos: MINUTOS_EXPIRACION_PENDIENTE });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ventas-pendientes?estado=pendiente — lista de esta sucursal ──
router.get('/ventas-pendientes', async (req, res) => {
  try {
    await ensureVentasPendientesTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { estado } = req.query;
    let sql = `
      SELECT vp.*, COALESCE(json_agg(json_build_object(
          'producto_id', d.producto_id, 'nombre_producto', d.nombre_producto,
          'cantidad', d.cantidad, 'precio_unitario', d.precio_unitario
        )) FILTER (WHERE d.id IS NOT NULL), '[]') AS items
      FROM ventas_pendientes vp
      LEFT JOIN ventas_pendientes_detalle d ON d.venta_pendiente_id = vp.id
      WHERE vp.negocio_id=$1 AND vp.sucursal_id=$2`;
    const params = [negocio_id, sucursal_id];
    if (estado) { params.push(estado); sql += ` AND vp.estado=$${params.length}`; }
    sql += ' GROUP BY vp.id ORDER BY vp.creado_en DESC LIMIT 50';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ventas-pendientes/:codigo — lookup al escanear ──
router.get('/ventas-pendientes/:codigo', async (req, res) => {
  try {
    await ensureVentasPendientesTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT * FROM ventas_pendientes WHERE codigo=$1 AND negocio_id=$2 AND sucursal_id=$3`,
      [req.params.codigo, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Código no encontrado' });
    const row = r.rows[0];
    if (row.estado === 'pendiente' && new Date(row.expira_en) <= new Date()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expirarUnaPendiente(client, row);
        await client.query('COMMIT');
      } catch(e2) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      row.estado = 'expirada';
    }
    if (row.estado !== 'pendiente') {
      return res.status(410).json({ error: 'Este ticket ya no está pendiente', estado: row.estado });
    }
    const detalle = await pool.query('SELECT * FROM ventas_pendientes_detalle WHERE venta_pendiente_id=$1', [row.id]);
    res.json({ ...row, items: detalle.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ventas-pendientes/:id/cobrar — caja de cobro finaliza el pago ──
router.post('/ventas-pendientes/:id/cobrar', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const { forma_pago, efectivo_recibido, cliente_id } = req.body;
  const client = await pool.connect();
  try {
    await ensureVentasPendientesTables();
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM ventas_pendientes WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 FOR UPDATE`,
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) throw Object.assign(new Error('Ticket no encontrado'), { status: 404 });
    const row = r.rows[0];

    if (row.estado === 'pendiente' && new Date(row.expira_en) <= new Date()) {
      await expirarUnaPendiente(client, row);
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Este ticket ya expiró', estado: 'expirada' });
    }
    if (row.estado !== 'pendiente') {
      throw Object.assign(new Error('Este ticket ya no está pendiente (' + row.estado + ')'), { status: 409 });
    }

    const detalle = await client.query('SELECT * FROM ventas_pendientes_detalle WHERE venta_pendiente_id=$1', [row.id]);
    const items = detalle.rows.map(d => ({
      producto_id: d.producto_id, nombre_producto: d.nombre_producto,
      cantidad: d.cantidad, precio_unitario: d.precio_unitario
    }));
    const v = {
      items,
      subtotal: row.subtotal, descuento: row.descuento, total: row.total,
      iva_activo: parseFloat(row.iva) > 0,
      cliente_id: cliente_id || row.cliente_id,
      cajero: row.cajero,
      forma_pago: forma_pago || 'efectivo',
      efectivo_recibido: efectivo_recibido,
      referencia_externa: 'PENDIENTE:' + row.codigo
    };
    const { ventaId, folio, total } = await crearVentaCompletada(client, {
      negocio_id, sucursal_id, caja_id, giroReal: row.giro, v, saltarStock: true
    });

    // El stock ya se descontó al armar el ticket — re-apuntar esos mismos
    // movimientos a la venta real en vez de descontarlo otra vez.
    await client.query(
      `UPDATE stock_movimientos SET motivo='venta', venta_id=$1, venta_pendiente_id=NULL
       WHERE venta_pendiente_id=$2 AND motivo='reserva_pendiente'`,
      [ventaId, row.id]
    );
    await client.query(
      `UPDATE ventas_pendientes SET estado='cobrada', venta_id=$1, caja_cobro_id=$2, cobrada_en=now() WHERE id=$3`,
      [ventaId, caja_id, row.id]
    );

    await client.query('COMMIT');
    broadcast(req, 'sync:cambios', { venta_pendiente_cobrada: true, id: ventaId });
    res.json({ ok: true, venta_id: ventaId, folio, total });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/ventas-pendientes/:id/cancelar — cancelación manual ──
router.put('/ventas-pendientes/:id/cancelar', async (req, res) => {
  const { negocio_id, sucursal_id } = req.caja;
  const client = await pool.connect();
  try {
    await ensureVentasPendientesTables();
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM ventas_pendientes WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND estado='pendiente' FOR UPDATE`,
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) throw Object.assign(new Error('Ticket no encontrado o ya no está pendiente'), { status: 404 });
    await revertirReserva(client, r.rows[0].id);
    await client.query(`UPDATE ventas_pendientes SET estado='cancelada', cancelada_en=now() WHERE id=$1`, [r.rows[0].id]);
    await client.query('COMMIT');
    broadcast(req, 'sync:cambios', { venta_pendiente_cancelada: true });
    res.json({ ok: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Barrido periódico: expira los tickets que nadie fue a cobrar ──
async function expirarVentasPendientes() {
  try {
    await ensureVentasPendientesTables();
    const claim = await pool.query(
      `UPDATE ventas_pendientes SET estado='expirada', cancelada_en=now()
       WHERE estado='pendiente' AND expira_en <= now() RETURNING id`
    );
    for (const row of claim.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await revertirReserva(client, row.id);
        await client.query('COMMIT');
      } catch(e) {
        await client.query('ROLLBACK');
        console.error('⚠️ Error revirtiendo reserva de', row.id, e.message);
      } finally {
        client.release();
      }
    }
    if (claim.rows.length) console.log('🎫 Expiradas', claim.rows.length, 'ventas pendientes — stock liberado');
  } catch(e) {
    console.error('❌ Error en expirarVentasPendientes:', e.message);
  }
}

module.exports = { router, ensureVentasPendientesTables, expirarVentasPendientes };
