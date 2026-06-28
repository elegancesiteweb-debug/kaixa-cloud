// kaixa-cloud/routes/dashboard.js
// Panel multi-sucursal — stats del día por sucursal
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');   // ← igual que server.js

// GET /api/dashboard/sucursales
router.get('/sucursales', async (req, res) => {
  try {
    const negocio_id = req.caja.negocio_id;
    const hoy = new Date().toISOString().substring(0, 10);

    // Todas las sucursales del negocio
    const sucursales = await pool.query(
      `SELECT id, nombre, giro FROM sucursales
       WHERE negocio_id=$1 AND activo=true ORDER BY nombre`,
      [negocio_id]
    );

    const result = await Promise.all(sucursales.rows.map(async (suc) => {

      // Ventas del día
      const ventas = await pool.query(`
        SELECT
          COUNT(*)                                                          AS total_ventas,
          COALESCE(SUM(total),0)                                            AS monto_hoy,
          COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total END),0)   AS efectivo,
          COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total END),0)   AS tarjeta
        FROM ventas
        WHERE sucursal_id=$1
          AND DATE(creado_en AT TIME ZONE 'America/Mexico_City')=$2
          AND estado != 'cancelada'
      `, [suc.id, hoy]).catch(() => ({ rows:[{ total_ventas:0, monto_hoy:0, efectivo:0, tarjeta:0 }] }));

      // Empleados en turno (entrada sin salida hoy)
      const emps = await pool.query(`
        SELECT e.nombre FROM asistencia a
        JOIN empleados e ON e.id = a.empleado_id
        WHERE a.sucursal_id=$1
          AND DATE(a.entrada AT TIME ZONE 'America/Mexico_City')=$2
          AND a.salida IS NULL
        ORDER BY a.entrada DESC LIMIT 5
      `, [suc.id, hoy]).catch(() => ({ rows:[] }));

      // Top producto del día
      const top = await pool.query(`
        SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty
        FROM venta_detalle vd
        JOIN ventas v ON v.id = vd.venta_id
        WHERE v.sucursal_id=$1
          AND DATE(v.creado_en AT TIME ZONE 'America/Mexico_City')=$2
          AND v.estado != 'cancelada'
        GROUP BY vd.nombre_producto
        ORDER BY qty DESC LIMIT 1
      `, [suc.id, hoy]).catch(() => ({ rows:[] }));

      // Stock bajo
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
        empleados_activos: emps.rows.length,
        cajeros:           emps.rows.map(e => e.nombre.split(' ')[0]),
        top_producto:      top.rows[0]?.nombre_producto || '',
        stock_bajo:        parseInt(stock.rows[0]?.n)   || 0,
      };
    }));

    res.json({
      ok:           true,
      negocio_id,
      fecha:        hoy,
      sucursales:   result,
      total_ventas: result.reduce((s, x) => s + x.ventas_hoy, 0),
      total_monto:  result.reduce((s, x) => s + x.monto_hoy,  0),
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
      SELECT v.*, u.nombre AS cajero_nombre
      FROM ventas v
      LEFT JOIN usuarios u ON u.id = v.usuario_id
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
    const hoy = new Date().toISOString().substring(0,10);
    const r = await pool.query(`
      SELECT e.*,
        a.entrada AS ultima_entrada,
        a.salida  AS ultima_salida
      FROM empleados e
      LEFT JOIN (
        SELECT DISTINCT ON (empleado_id) *
        FROM asistencia
        WHERE DATE(entrada AT TIME ZONE 'America/Mexico_City')=$2
        ORDER BY empleado_id, entrada DESC
      ) a ON a.empleado_id = e.id
      WHERE e.sucursal_id=$1 AND e.activo=true
      ORDER BY e.nombre
    `, [req.params.id, hoy]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ── GET /api/dashboard/sucursal/:id/inventario ────────────────────────────
router.get('/sucursal/:id/inventario', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM productos
      WHERE sucursal_id=$1 AND activo=true
      ORDER BY stock ASC, nombre ASC
      LIMIT 100
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
