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

// ════════════════════════════════════════════════════════════════════════════
// ── POST /api/admin/sync/venta — recibe venta desde una caja del .exe ──────
// El .exe hace POST aquí después de cada venta exitosa, enviando
// el token de su caja. Railway valida el token, identifica el negocio/
// sucursal/caja y guarda la venta en su propia BD para el admin.
// ════════════════════════════════════════════════════════════════════════════
router.post('/sync/venta', async (req, res) => {
  try {
    // Token viene en el header x-kaixa-token
    const token = req.headers['x-kaixa-token'] || req.body.token;
    if (!token) return res.status(401).json({ error: 'Token requerido (header x-kaixa-token)' });

    // Validar token → obtener caja, sucursal y negocio
    const cajaR = await pool.query(
      `SELECT c.id AS caja_id, c.nombre AS caja_nombre, c.tipo AS caja_tipo,
              s.id AS sucursal_id, s.nombre AS sucursal_nombre,
              s.negocio_id
       FROM cajas c
       JOIN sucursales s ON s.id = c.sucursal_id
       WHERE c.token = $1 AND c.activo = true`,
      [token]
    );
    if (!cajaR.rows.length) {
      return res.status(401).json({ error: 'Token inválido o caja desactivada' });
    }

    const caja = cajaR.rows[0];
    const {
      folio, total, subtotal, descuento = 0,
      iva = 0, forma_pago, cajero, items = [], creado_en
    } = req.body;

    if (!folio || !total || !forma_pago) {
      return res.status(400).json({ error: 'folio, total y forma_pago son requeridos' });
    }

    // Insertar la venta en la BD de Railway
    const r = await pool.query(
      `INSERT INTO ventas
         (negocio_id, sucursal_id, caja_id,
          folio, total, subtotal, descuento, iva,
          forma_pago, cajero, items_json, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (folio, negocio_id) DO NOTHING
       RETURNING id`,
      [
        caja.negocio_id,
        caja.sucursal_id,
        caja.caja_id,
        folio,
        parseFloat(total)    || 0,
        parseFloat(subtotal) || parseFloat(total) || 0,
        parseFloat(descuento)|| 0,
        parseFloat(iva)      || 0,
        forma_pago,
        cajero || 'Caja',
        JSON.stringify(items),
        creado_en ? new Date(creado_en) : new Date()
      ]
    );

    if (!r.rows.length) {
      // ON CONFLICT — venta ya existía (reintento del .exe), responder OK igual
      return res.json({ ok: true, duplicado: true, mensaje: 'Venta ya registrada' });
    }

    res.json({
      ok:             true,
      id:             r.rows[0].id,
      negocio_id:     caja.negocio_id,
      sucursal_nombre:caja.sucursal_nombre,
      caja_nombre:    caja.caja_nombre
    });

  } catch (e) {
    console.error('sync/venta error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
