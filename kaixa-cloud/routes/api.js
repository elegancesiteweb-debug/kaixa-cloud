// routes/api.js — Rutas que usan las CAJAS EXTRA (siempre conectadas)
// Operan directo contra PostgreSQL, sin cola local — no necesitan
// resolver conflictos porque siempre están en línea.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');

function uuid() { return crypto.randomUUID(); }

// ── GET /api/productos — inventario con stock calculado ─────────
router.get('/productos', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const { giro, q } = req.query;
    let sql = `
      SELECT p.*, COALESCE(s.stock,0) AS stock, c.nombre AS categoria_nombre, c.emoji AS categoria_emoji
      FROM productos p
      LEFT JOIN stock_actual s ON s.producto_id = p.id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id = $1 AND p.activo = true`;
    const params = [negocio_id];
    if (giro) { params.push(giro); sql += ` AND p.giro = $${params.length}`; }
    if (q)    { params.push('%'+q+'%'); sql += ` AND (p.nombre ILIKE $${params.length} OR p.codigo_barras ILIKE $${params.length})`; }
    sql += ' ORDER BY p.nombre';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/productos — crear producto ─────────────────────────
router.post('/productos', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const p = req.body;
    const id = uuid();
    await pool.query(
      `INSERT INTO productos (id, negocio_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
        stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, negocio_id, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
       p.precio||0, p.costo||0, p.stock_minimo||5, p.categoria_id||null, p.giro||'tienda',
       !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion]
    );
    // Si viene con stock inicial, registrar el movimiento
    if (p.stock_inicial > 0) {
      await pool.query(
        `INSERT INTO stock_movimientos (id, negocio_id, producto_id, caja_id, cantidad, motivo)
         VALUES ($1,$2,$3,$4,$5,'recepcion')`,
        [uuid(), negocio_id, id, req.caja.id, p.stock_inicial]
      );
    }
    broadcast(req, 'productos:nuevo', { id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/productos/:id — editar producto ─────────────────────
router.put('/productos/:id', async (req, res) => {
  try {
    const p = req.body;
    await pool.query(
      `UPDATE productos SET nombre=$1, emoji=$2, imagen_url=$3, codigo_barras=$4, precio=$5,
        costo=$6, stock_minimo=$7, categoria_id=$8, por_peso=$9, unidad_peso=$10,
        tiene_prescripcion=$11, actualizado_en=now()
       WHERE id=$12 AND negocio_id=$13`,
      [p.nombre, p.emoji, p.imagen_url, p.codigo_barras, p.precio, p.costo, p.stock_minimo,
       p.categoria_id||null, !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion,
       req.params.id, req.caja.negocio_id]
    );
    broadcast(req, 'productos:editado', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/clientes ─────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const { q } = req.query;
    let sql = `SELECT * FROM clientes WHERE negocio_id=$1 AND activo=true`;
    const params = [negocio_id];
    if (q) { params.push('%'+q+'%'); sql += ` AND nombre ILIKE $${params.length}`; }
    sql += ' ORDER BY nombre';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/clientes — crear cliente ───────────────────────────
router.post('/clientes', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const c = req.body;
    const id = uuid();
    await pool.query(
      `INSERT INTO clientes (id, negocio_id, nombre, telefono, email, rfc, giro)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, negocio_id, c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.giro||'tienda']
    );
    broadcast(req, 'clientes:nuevo', { id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/clientes/:id — actualizar puntos/saldo ──────────────
router.put('/clientes/:id', async (req, res) => {
  try {
    const c = req.body;
    await pool.query(
      `UPDATE clientes SET nombre=$1, telefono=$2, email=$3, rfc=$4, puntos=$5, saldo=$6, actualizado_en=now()
       WHERE id=$7 AND negocio_id=$8`,
      [c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.puntos||0, c.saldo||0,
       req.params.id, req.caja.negocio_id]
    );
    broadcast(req, 'clientes:editado', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ventas — cobrar (caja extra, en vivo) ──────────────
router.post('/ventas', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const v = req.body;
  if (!v.items || !v.items.length) return res.status(400).json({ error: 'La venta debe tener productos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ventaId = uuid();
    const ultimo = await client.query(
      `SELECT folio FROM ventas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 1`, [negocio_id]
    );
    let num = 1;
    if (ultimo.rows[0]) {
      const m = ultimo.rows[0].folio.match(/(\d+)$/);
      if (m) num = parseInt(m[1]) + 1;
    }
    const folio = (v.giro||'VTA').toUpperCase().slice(0,3) + '-' + Date.now().toString().slice(-8) + '-' + String(num).padStart(4,'0');

    const subtotal = v.items.reduce((s,i) => s + i.precio*i.cantidad, 0);
    const descuento = v.descuento || 0;
    const base = subtotal - descuento;
    const iva = v.iva_activo ? parseFloat((base*0.16).toFixed(2)) : 0;
    const total = base + iva;

    await client.query(
      `INSERT INTO ventas (id, negocio_id, sucursal_id, caja_id, folio, cliente_id, subtotal, descuento,
        iva, total, forma_pago, efectivo_recibido, cambio, cajero, giro, referencia_externa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [ventaId, negocio_id, sucursal_id, caja_id, folio, v.cliente_id||null, subtotal, descuento,
       iva, total, v.forma_pago||'efectivo', v.efectivo_recibido||total,
       Math.max(0,(v.efectivo_recibido||total)-total), v.cajero||'', v.giro||'tienda',
       v.referencia_externa||null]
    );

    for (const item of v.items) {
      await client.query(
        `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), ventaId, item.id||null, item.nombre, item.cantidad, item.precio, item.cantidad*item.precio]
      );
      // Movimiento de stock (salida)
      if (item.id) {
        await client.query(
          `INSERT INTO stock_movimientos (id, negocio_id, producto_id, caja_id, cantidad, motivo, venta_id)
           VALUES ($1,$2,$3,$4,$5,'venta',$6)`,
          [uuid(), negocio_id, item.id, caja_id, -item.cantidad, ventaId]
        );
      }
    }

    await client.query('COMMIT');

    broadcast(req, 'venta:nueva', { id: ventaId, folio, total, caja_id });
    res.json({ ok: true, id: ventaId, folio, total });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ventas — historial ──────────────────────────────────
router.get('/ventas', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const r = await pool.query(
      `SELECT v.*, s.nombre AS sucursal_nombre, c.nombre AS caja_nombre
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       LEFT JOIN cajas c ON c.id = v.caja_id
       WHERE v.negocio_id=$1 ORDER BY v.creado_en DESC LIMIT 200`,
      [negocio_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function broadcast(req, evento, data) {
  const io = req.app.get('io');
  if (io) io.to('negocio:' + req.caja.negocio_id).emit(evento, data);
}

module.exports = router;
