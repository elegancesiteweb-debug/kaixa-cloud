// kaixa-cloud/routes/dashboard.js
// Panel multi-sucursal — stats del día por sucursal
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');   // ← igual que server.js

// GET /api/dashboard/sucursales?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Sin desde/hasta, se comporta igual que antes (foto de hoy). Con rango,
// se vuelve un reporte consolidado histórico — ventas_hoy/monto_hoy quedan
// con esos nombres por compatibilidad con el panel en vivo, aunque con un
// rango representen el periodo completo, no solo "hoy".
router.get('/sucursales', async (req, res) => {
  try {
    const negocio_id = req.caja.negocio_id;
    const hoy = new Date().toISOString().substring(0, 10);
    const desde = req.query.desde || hoy;
    const hasta = req.query.hasta || hoy;

    // Todas las sucursales del negocio
    const sucursales = await pool.query(
      `SELECT id, nombre, giro FROM sucursales
       WHERE negocio_id=$1 AND activo=true ORDER BY nombre`,
      [negocio_id]
    );

    const result = await Promise.all(sucursales.rows.map(async (suc) => {

      // Ventas del rango (desde/hasta = hoy si no se pidió rango)
      const ventas = await pool.query(`
        SELECT
          COUNT(*)                                                              AS total_ventas,
          COALESCE(SUM(total),0)                                                AS monto_hoy,
          COALESCE(SUM(CASE WHEN forma_pago='efectivo'      THEN total END),0)  AS efectivo,
          COALESCE(SUM(CASE WHEN forma_pago='tarjeta'       THEN total END),0)  AS tarjeta,
          COALESCE(SUM(CASE WHEN forma_pago='transferencia' THEN total END),0)  AS transferencia
        FROM ventas
        WHERE sucursal_id=$1
          AND DATE(creado_en AT TIME ZONE 'America/Mexico_City') BETWEEN $2 AND $3
          AND estado != 'cancelada'
      `, [suc.id, desde, hasta]).catch(() => ({ rows:[{ total_ventas:0, monto_hoy:0, efectivo:0, tarjeta:0, transferencia:0 }] }));

      // Empleados en turno (entrada de HOY sin salida, siempre "ahora mismo" —
      // no tiene sentido historizar quién está en turno en un rango pasado)
      const emps = await pool.query(`
        SELECT nombre FROM empleados
        WHERE sucursal_id=$1 AND activo=true
          AND ultima_entrada IS NOT NULL
          AND DATE(ultima_entrada AT TIME ZONE 'America/Mexico_City')=$2
          AND ultima_salida IS NULL
        ORDER BY ultima_entrada DESC LIMIT 5
      `, [suc.id, hoy]).catch(() => ({ rows:[] }));

      // Top producto del rango
      const top = await pool.query(`
        SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty
        FROM venta_detalle vd
        JOIN ventas v ON v.id = vd.venta_id
        WHERE v.sucursal_id=$1
          AND DATE(v.creado_en AT TIME ZONE 'America/Mexico_City') BETWEEN $2 AND $3
          AND v.estado != 'cancelada'
        GROUP BY vd.nombre_producto
        ORDER BY qty DESC LIMIT 1
      `, [suc.id, desde, hasta]).catch(() => ({ rows:[] }));

      // Stock bajo — siempre estado actual, no tiene rango
      const stock = await pool.query(
        `SELECT COUNT(*) AS n FROM productos
         WHERE sucursal_id=$1 AND activo=true AND stock<=stock_minimo`,
        [suc.id]
      ).catch(() => ({ rows:[{ n:0 }] }));

      const v = ventas.rows[0];
      return {
        id:                suc.id,
        nombre:            suc.nombre,
        giro:              suc.giro || 'tienda',
        ventas_hoy:        parseInt(v.total_ventas) || 0,
        monto_hoy:         parseFloat(v.monto_hoy)  || 0,
        efectivo:          parseFloat(v.efectivo)    || 0,
        tarjeta:           parseFloat(v.tarjeta)     || 0,
        transferencia:     parseFloat(v.transferencia) || 0,
        empleados_activos: emps.rows.length,
        cajeros:           emps.rows.map(e => e.nombre.split(' ')[0]),
        top_producto:      top.rows[0]?.nombre_producto || '',
        stock_bajo:        parseInt(stock.rows[0]?.n)   || 0,
      };
    }));

    // Top 5 productos combinados de TODO el negocio en el rango (no existía:
    // el top de arriba es siempre por sucursal, nunca agregado).
    const topGlobal = await pool.query(`
      SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty
      FROM venta_detalle vd
      JOIN ventas v ON v.id = vd.venta_id
      JOIN sucursales s ON s.id = v.sucursal_id
      WHERE s.negocio_id=$1
        AND DATE(v.creado_en AT TIME ZONE 'America/Mexico_City') BETWEEN $2 AND $3
        AND v.estado != 'cancelada'
      GROUP BY vd.nombre_producto
      ORDER BY qty DESC LIMIT 5
    `, [negocio_id, desde, hasta]).catch(() => ({ rows: [] }));

    res.json({
      ok:                 true,
      negocio_id,
      fecha:              hoy,
      desde,
      hasta,
      sucursales:         result,
      total_ventas:       result.reduce((s, x) => s + x.ventas_hoy, 0),
      total_monto:        result.reduce((s, x) => s + x.monto_hoy,  0),
      top_productos_global: topGlobal.rows.map(r => ({ nombre: r.nombre_producto, cantidad: parseInt(r.qty) || 0 })),
    });

  } catch(e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── GET /api/dashboard/sucursal/:id/ventas ────────────────────────────────
router.get('/sucursal/:id/ventas', async (req, res) => {
  try {
    const hoy = new Date().toISOString().substring(0,10);
    const r = await pool.query(`
      SELECT v.*, v.cajero AS cajero_nombre
      FROM ventas v
      WHERE v.sucursal_id=$1
        AND DATE(v.creado_en AT TIME ZONE 'America/Mexico_City')=$2
        AND v.estado != 'cancelada'
      ORDER BY v.creado_en DESC LIMIT 50
    `, [req.params.id, hoy]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ── GET /api/dashboard/sucursal/:id/empleados ─────────────────────────────
router.get('/sucursal/:id/empleados', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM empleados
      WHERE sucursal_id=$1 AND activo=true
      ORDER BY nombre
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ── GET /api/dashboard/sucursal/:id/inventario ────────────────────────────
router.get('/sucursal/:id/inventario', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, COALESCE(s.stock,0) AS stock
      FROM productos p
      LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = p.sucursal_id
      WHERE p.sucursal_id=$1 AND p.activo=true
      ORDER BY COALESCE(s.stock,0) ASC, p.nombre ASC
      LIMIT 100
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
