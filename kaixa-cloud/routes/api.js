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
    const { negocio_id, sucursal_id } = req.caja;
    const { giro, q } = req.query;
    let sql = `
      SELECT p.*, COALESCE(s.stock,0) AS stock, c.nombre AS categoria_nombre, c.emoji AS categoria_emoji
      FROM productos p
      LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = $2
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id = $1
        AND (p.sucursal_id = $2 OR p.sucursal_id IS NULL)
        AND p.activo = true`;
    const params = [negocio_id, sucursal_id];
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
    const { negocio_id, sucursal_id } = req.caja;
    const p = req.body;
    const id = uuid();
    await pool.query(
      `INSERT INTO productos (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
        stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, negocio_id, sucursal_id, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
       p.precio||0, p.costo||0, p.stock_minimo||5, p.categoria_id||null, p.giro||'tienda',
       !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion]
    );
    // Si viene con stock inicial, registrar el movimiento
    if (p.stock_inicial > 0) {
      await pool.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
         VALUES ($1,$2,$3,$4,$5,$6,'recepcion')`,
        [uuid(), negocio_id, sucursal_id, id, req.caja.id, p.stock_inicial]
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



// ═══════════════════════════════════════════════════════════
// EMPLEADOS
// ═══════════════════════════════════════════════════════════
router.get('/empleados', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT * FROM empleados
       WHERE negocio_id=$1 AND (sucursal_id=$2 OR sucursal_id IS NULL) AND activo=true
       ORDER BY nombre`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/empleados/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 LIMIT 1',
      [req.params.id, req.caja.negocio_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/empleados', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { nombre, rol='cajero', usuario, password } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const r = await pool.query(
      `INSERT INTO empleados (negocio_id, sucursal_id, nombre, rol, usuario, password, activo)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [negocio_id, sucursal_id, nombre, rol, usuario||null, password||null]
    );
    res.json({ ok: true, empleado: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/empleados/:id', async (req, res) => {
  try {
    const { nombre, rol, usuario, password } = req.body;
    let sql = 'UPDATE empleados SET nombre=$1, rol=$2, usuario=$3';
    const vals = [nombre, rol, usuario||null];
    if (password) { sql += `, password=$${vals.length+1}`; vals.push(password); }
    sql += ` WHERE id=$${vals.length+1} AND negocio_id=$${vals.length+2}`;
    vals.push(req.params.id, req.caja.negocio_id);
    await pool.query(sql, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/empleados/:id/entrada', async (req, res) => {
  try {
    await pool.query('UPDATE empleados SET ultima_entrada=NOW(), ultima_salida=NULL WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/empleados/:id/salida', async (req, res) => {
  try {
    await pool.query('UPDATE empleados SET ultima_salida=NOW() WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { id, password } = req.body;
    const r = await pool.query(
      'SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 AND activo=true LIMIT 1',
      [id, req.caja.negocio_id]
    );
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Empleado no encontrado' });
    const e = r.rows[0];
    if (password !== (e.password || '')) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    res.json({ ok: true, empleado: { id: e.id, nombre: e.nombre, rol: e.rol } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOTES
// ═══════════════════════════════════════════════════════════
router.get('/lotes', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT * FROM lotes WHERE negocio_id=$1 AND (sucursal_id=$2 OR sucursal_id IS NULL) AND activo=true
       ORDER BY fecha_caducidad ASC NULLS LAST`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/lotes/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM lotes WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/lotes', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad } = req.body;
    if (!numero_lote) return res.status(400).json({ error: 'Número de lote requerido' });
    const r = await pool.query(
      `INSERT INTO lotes (negocio_id, sucursal_id, producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [negocio_id, sucursal_id, producto_id||null, nombre_producto||'', numero_lote,
       parseInt(cantidad)||0, fecha_caducidad||null]
    );
    res.json({ ok: true, lote: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/lotes/:id', async (req, res) => {
  try {
    const { numero_lote, cantidad, fecha_caducidad } = req.body;
    await pool.query(
      'UPDATE lotes SET numero_lote=$1, cantidad=$2, fecha_caducidad=$3, actualizado_en=NOW() WHERE id=$4',
      [numero_lote, parseInt(cantidad)||0, fecha_caducidad||null, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query('UPDATE lotes SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// PEDIDOS A PROVEEDORES
// ═══════════════════════════════════════════════════════════
router.get('/pedidos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT p.*, json_agg(pi.*) FILTER(WHERE pi.id IS NOT NULL) as items
       FROM pedidos p
       LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
       WHERE p.negocio_id=$1 AND (p.sucursal_id=$2 OR p.sucursal_id IS NULL)
       GROUP BY p.id ORDER BY p.creado_en DESC LIMIT 50`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pedidos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { proveedor_id, proveedor_nombre, items=[], notas='' } = req.body;
    const total = items.reduce((s, i) => s + (i.cantidad * i.costo_unitario), 0);
    const r = await pool.query(
      `INSERT INTO pedidos (negocio_id, sucursal_id, proveedor_id, proveedor_nombre, total, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [negocio_id, sucursal_id, proveedor_id||null, proveedor_nombre||'', total, notas]
    );
    const pedidoId = r.rows[0].id;
    for (const item of items) {
      await pool.query(
        `INSERT INTO pedido_items (pedido_id, producto_id, nombre_producto, cantidad, costo_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pedidoId, item.producto_id||null, item.nombre_producto||'', item.cantidad||1,
         item.costo_unitario||0, (item.cantidad||1)*(item.costo_unitario||0)]
      );
    }
    res.json({ ok: true, id: pedidoId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/pedidos/:id/recibir', async (req, res) => {
  try {
    const { negocio_id, sucursal_id, id: caja_id } = req.caja;
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!pedido.rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const items = await pool.query('SELECT * FROM pedido_items WHERE pedido_id=$1', [req.params.id]);
    for (const item of items.rows) {
      if (item.producto_id) {
        await pool.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'recepcion')`,
          [negocio_id, sucursal_id, item.producto_id, caja_id, item.cantidad]
        );
      }
    }
    await pool.query("UPDATE pedidos SET estado='recibido', actualizado_en=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CORTES DE CAJA
// ═══════════════════════════════════════════════════════════
router.get('/caja/resumen', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const hoy = new Date().toISOString().substring(0,10);
    const v = await pool.query(
      `SELECT COUNT(*) AS total_ventas, COALESCE(SUM(total),0) AS total_monto,
              COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total END),0) AS efectivo,
              COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total END),0) AS tarjeta,
              COALESCE(SUM(CASE WHEN forma_pago='transferencia' THEN total END),0) AS transferencia
       FROM ventas
       WHERE negocio_id=$1 AND sucursal_id=$2 AND DATE(creado_en)=$3 AND estado!='cancelada'`,
      [negocio_id, sucursal_id, hoy]
    );
    const top = await pool.query(
      `SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty, SUM(vd.subtotal) AS monto
       FROM venta_detalle vd JOIN ventas v ON v.id=vd.venta_id
       WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND DATE(v.creado_en)=$3 AND v.estado!='cancelada'
       GROUP BY vd.nombre_producto ORDER BY qty DESC LIMIT 5`,
      [negocio_id, sucursal_id, hoy]
    );
    const d = v.rows[0];
    res.json({
      total_ventas: parseInt(d.total_ventas)||0,
      total_monto:  parseFloat(d.total_monto)||0,
      efectivo:     parseFloat(d.efectivo)||0,
      tarjeta:      parseFloat(d.tarjeta)||0,
      transferencia:parseFloat(d.transferencia)||0,
      ticket_promedio: parseInt(d.total_ventas) > 0 ? parseFloat(d.total_monto)/parseInt(d.total_ventas) : 0,
      top_productos: top.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/caja/corte', async (req, res) => {
  try {
    const { negocio_id, sucursal_id, id: caja_id } = req.caja;
    const { tipo='parcial', cajero_nombre='', notas='' } = req.body;
    const hoy = new Date().toISOString().substring(0,10);
    const v = await pool.query(
      `SELECT COUNT(*) AS tv, COALESCE(SUM(total),0) AS monto,
              COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total END),0) AS ef,
              COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total END),0) AS tj,
              COALESCE(SUM(CASE WHEN forma_pago='transferencia' THEN total END),0) AS tr
       FROM ventas WHERE negocio_id=$1 AND sucursal_id=$2 AND DATE(creado_en)=$3 AND estado!='cancelada'`,
      [negocio_id, sucursal_id, hoy]
    );
    const d = v.rows[0];
    const r = await pool.query(
      `INSERT INTO cortes_caja (negocio_id, sucursal_id, caja_id, tipo, total_ventas, total_monto,
         efectivo, tarjeta, transferencia, cajero_nombre, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [negocio_id, sucursal_id, caja_id, tipo, parseInt(d.tv)||0, parseFloat(d.monto)||0,
       parseFloat(d.ef)||0, parseFloat(d.tj)||0, parseFloat(d.tr)||0, cajero_nombre, notas]
    );
    res.json({ ok: true, id: r.rows[0].id, folio: 'CTE-'+String(r.rows[0].id).substring(0,8).toUpperCase() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/caja/historial', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT * FROM cortes_caja WHERE negocio_id=$1 AND sucursal_id=$2
       ORDER BY creado_en DESC LIMIT 20`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// PROVEEDORES
// ═══════════════════════════════════════════════════════════
router.get('/proveedores', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM proveedores WHERE negocio_id=$1 AND activo=true ORDER BY nombre',
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/proveedores', async (req, res) => {
  try {
    const { nombre, telefono='', email='' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const r = await pool.query(
      'INSERT INTO proveedores (negocio_id, nombre, telefono, email) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.caja.negocio_id, nombre, telefono, email]
    );
    res.json({ ok: true, proveedor: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── POST /api/vincular-licencia — vincular licencia al negocio correcto ──
// Se llama automáticamente al configurar multi-sucursal en la PC
router.post('/vincular-licencia', async (req, res) => {
  try {
    const { clave, negocio_id } = req.body;
    if (!clave || !negocio_id) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    const r = await pool.query(
      'UPDATE licencias SET negocio_id=$1 WHERE clave=$2 RETURNING clave, negocio_id',
      [negocio_id, clave]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
    console.log('✅ Licencia', clave, 'vinculada a negocio', negocio_id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── POST /api/productos/:uuid/copiar-sucursal ─────────────────────────────
// Copia un producto de una sucursal a otra dentro del mismo negocio
router.post('/productos/:uuid/copiar-sucursal', async (req, res) => {
  try {
    const { sucursal_id_destino } = req.body;
    const { negocio_id } = req.caja;
    if (!sucursal_id_destino) return res.status(400).json({ error: 'Falta sucursal_id_destino' });

    // Verificar que la sucursal destino pertenece al mismo negocio
    const suc = await pool.query(
      'SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2',
      [sucursal_id_destino, negocio_id]
    );
    if (!suc.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });

    // Obtener el producto original
    const prod = await pool.query(
      'SELECT * FROM productos WHERE id=$1 AND negocio_id=$2',
      [req.params.uuid, negocio_id]
    );
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const p = prod.rows[0];

    // Verificar que no existe ya en la sucursal destino
    const existe = await pool.query(
      'SELECT id FROM productos WHERE negocio_id=$1 AND sucursal_id=$2 AND nombre=$3',
      [negocio_id, sucursal_id_destino, p.nombre]
    );
    if (existe.rows.length) return res.json({ ok: false, mensaje: 'El producto ya existe en esa sucursal' });

    // Copiar el producto a la sucursal destino con nuevo UUID
    const { v4: uuidv4 } = require('uuid');
    const nuevo_id = uuidv4();
    await pool.query(
      `INSERT INTO productos (id, negocio_id, sucursal_id, nombre, emoji, imagen_url,
        codigo_barras, precio, costo, stock_minimo, categoria_id, giro, por_peso,
        unidad_peso, tiene_prescripcion, actualizado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
      [nuevo_id, negocio_id, sucursal_id_destino, p.nombre, p.emoji||'📦',
       p.imagen_url||'', p.codigo_barras||'', p.precio, p.costo, p.stock_minimo,
       p.categoria_id, p.giro, p.por_peso, p.unidad_peso, p.tiene_prescripcion]
    );

    console.log('✅ Producto copiado:', p.nombre, '→ sucursal', sucursal_id_destino);
    res.json({ ok: true, nuevo_id, mensaje: `Producto "${p.nombre}" copiado correctamente` });
  } catch(e) {
    console.error('Error copiando producto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
