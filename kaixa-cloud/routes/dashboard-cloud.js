// ═══════════════════════════════════════════════════════
// kaixa-cloud/routes/dashboard.js
// Endpoint para el panel multi-sucursal de Kaixa Pro
// Agregar en kaixa-cloud: app.use('/api/dashboard', require('./routes/dashboard'))
// ═══════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { pool } = require('../db'); // PostgreSQL de Railway

// Middleware: verificar token de la caja
async function authMiddleware(req, res, next){
  const token = (req.headers.authorization||'').replace('Bearer ','').trim();
  if(!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const r = await pool.query('SELECT * FROM cajas WHERE token=$1 AND activo=true LIMIT 1',[token]);
    if(!r.rows.length) return res.status(403).json({ error: 'Token inválido' });
    req.caja   = r.rows[0];
    req.negocio_id = r.rows[0].negocio_id;
    next();
  } catch(e){ res.status(500).json({ error: e.message }); }
}

// ── GET /api/dashboard/sucursales ─────────────────────
// Devuelve stats de hoy de todas las sucursales del mismo negocio
router.get('/sucursales', authMiddleware, async (req, res) => {
  try {
    const negocio_id = req.negocio_id;
    const hoy = new Date().toISOString().substring(0,10); // YYYY-MM-DD

    // Obtener todas las sucursales del negocio
    const sucursales = await pool.query(
      'SELECT s.*, n.nombre AS negocio_nombre FROM sucursales s JOIN negocios n ON n.id=s.negocio_id WHERE s.negocio_id=$1 AND s.activo=true ORDER BY s.nombre',
      [negocio_id]
    );

    // Para cada sucursal, obtener stats del día
    const result = await Promise.all(sucursales.rows.map(async (suc) => {
      // Ventas del día
      const ventas = await pool.query(`
        SELECT COUNT(*) AS total_ventas,
               COALESCE(SUM(total),0) AS monto_hoy,
               COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total ELSE 0 END),0) AS efectivo,
               COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total ELSE 0 END),0) AS tarjeta
        FROM ventas
        WHERE sucursal_id=$1
          AND DATE(creado_en)=$2
          AND estado != 'cancelada'
      `, [suc.id, hoy]);

      // Empleados activos (con entrada pero sin salida hoy)
      const emps = await pool.query(`
        SELECT e.nombre FROM asistencia a
        JOIN empleados e ON e.id=a.empleado_id
        WHERE a.sucursal_id=$1
          AND DATE(a.entrada)=$2
          AND a.salida IS NULL
        ORDER BY a.entrada DESC LIMIT 5
      `, [suc.id, hoy]).catch(()=>({rows:[]}));

      // Top producto del día
      const top = await pool.query(`
        SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty
        FROM venta_detalle vd JOIN ventas v ON v.id=vd.venta_id
        WHERE v.sucursal_id=$1 AND DATE(v.creado_en)=$2
        GROUP BY vd.nombre_producto ORDER BY qty DESC LIMIT 1
      `, [suc.id, hoy]).catch(()=>({rows:[]}));

      // Stock bajo
      const stockBajo = await pool.query(
        'SELECT COUNT(*) AS n FROM productos WHERE sucursal_id=$1 AND activo=1 AND stock<=stock_minimo',
        [suc.id]
      ).catch(()=>({rows:[{n:0}]}));

      const v = ventas.rows[0];
      return {
        id:                 suc.id,
        nombre:             suc.nombre,
        giro:               suc.giro || 'tienda',
        ventas_hoy:         parseInt(v.total_ventas)||0,
        monto_hoy:          parseFloat(v.monto_hoy)||0,
        efectivo:           parseFloat(v.efectivo)||0,
        tarjeta:            parseFloat(v.tarjeta)||0,
        empleados_activos:  emps.rows.length,
        cajeros:            emps.rows.map(e=>e.nombre.split(' ')[0]),
        top_producto:       top.rows[0]?.nombre_producto||'',
        stock_bajo:         parseInt(stockBajo.rows[0]?.n)||0,
      };
    }));

    res.json({
      ok:         true,
      negocio_id,
      fecha:      hoy,
      sucursales: result,
      total_ventas: result.reduce((s,x)=>s+x.ventas_hoy,0),
      total_monto:  result.reduce((s,x)=>s+x.monto_hoy,0),
    });
  } catch(e){
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
