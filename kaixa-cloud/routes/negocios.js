// routes/negocios.js — Alta de negocios, sucursales y cajas
// Estas rutas las usas TÚ (el vendedor de Kaixa Pro) al dar de alta
// un cliente nuevo con licencia multi-sucursal. No las usa el POS.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');

function generarToken() {
  return 'kx_' + crypto.randomBytes(24).toString('hex');
}

// ── POST /api/admin/negocios — crear negocio nuevo ─────────────
router.post('/negocios', async (req, res) => {
  try {
    const { nombre, giro_principal='tienda' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre del negocio requerido' });
    const r = await pool.query(
      `INSERT INTO negocios (nombre, giro_principal) VALUES ($1,$2) RETURNING *`,
      [nombre, giro_principal]
    );
    res.json({ ok: true, negocio: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/negocios — listar todos (panel del vendedor) ─
router.get('/negocios', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM negocios ORDER BY creado_en DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/sucursales — crear sucursal de un negocio ──
router.post('/sucursales', async (req, res) => {
  try {
    const { negocio_id, nombre, direccion='' } = req.body;
    if (!negocio_id || !nombre) return res.status(400).json({ error: 'negocio_id y nombre requeridos' });
    const r = await pool.query(
      `INSERT INTO sucursales (negocio_id, nombre, direccion) VALUES ($1,$2,$3) RETURNING *`,
      [negocio_id, nombre, direccion]
    );
    res.json({ ok: true, sucursal: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/sucursales/:negocio_id ───────────────────────
router.get('/sucursales/:negocio_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM sucursales WHERE negocio_id=$1 ORDER BY creado_en`,
      [req.params.negocio_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/cajas — crear una caja (madre o extra) ──────
// Devuelve el TOKEN que se configura en esa caja/sucursal para conectarse.
router.post('/cajas', async (req, res) => {
  try {
    const { negocio_id, sucursal_id, nombre, tipo='extra' } = req.body;
    if (!negocio_id || !sucursal_id || !nombre) {
      return res.status(400).json({ error: 'negocio_id, sucursal_id y nombre requeridos' });
    }
    if (!['madre','extra'].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'madre' o 'extra'" });
    }
    const token = generarToken();
    const r = await pool.query(
      `INSERT INTO cajas (negocio_id, sucursal_id, nombre, tipo, token) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [negocio_id, sucursal_id, nombre, tipo, token]
    );
    res.json({ ok: true, caja: r.rows[0], token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/cajas/:negocio_id — listar cajas de un negocio ─
router.get('/cajas/:negocio_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, s.nombre AS sucursal_nombre FROM cajas c
       JOIN sucursales s ON s.id = c.sucursal_id
       WHERE c.negocio_id=$1 ORDER BY c.creado_en`,
      [req.params.negocio_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/admin/cajas/:id/desactivar ─────────────────────────
router.put('/cajas/:id/desactivar', async (req, res) => {
  try {
    await pool.query(`UPDATE cajas SET activo=false WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/ventas/:negocio_id — actividad reciente ──────
// Para confirmar visualmente que la sincronización está funcionando.
router.get('/ventas/:negocio_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT v.*, s.nombre AS sucursal_nombre, c.nombre AS caja_nombre, c.tipo AS caja_tipo
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       LEFT JOIN cajas c ON c.id = v.caja_id
       WHERE v.negocio_id=$1
       ORDER BY v.creado_en DESC LIMIT 50`,
      [req.params.negocio_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/productos/:negocio_id — inventario con stock ──
router.get('/productos/:negocio_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, COALESCE(st.stock,0) AS stock
       FROM productos p
       LEFT JOIN stock_actual st ON st.producto_id = p.id
       WHERE p.negocio_id=$1 AND p.activo=true
       ORDER BY p.actualizado_en DESC LIMIT 50`,
      [req.params.negocio_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
