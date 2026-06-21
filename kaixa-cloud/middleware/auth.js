// middleware/auth.js — Identifica qué caja está llamando, vía token
const pool = require('../db/pool');

async function authCaja(req, res, next) {
  try {
    const token = req.headers['x-caja-token'];
    if (!token) {
      return res.status(401).json({ error: 'Falta el token de la caja (header x-caja-token)' });
    }

    const r = await pool.query(
      `SELECT c.id AS caja_id, c.nombre AS caja_nombre, c.tipo AS caja_tipo,
              c.sucursal_id, c.negocio_id, n.nombre AS negocio_nombre, n.activo AS negocio_activo
       FROM cajas c
       JOIN negocios n ON n.id = c.negocio_id
       WHERE c.token = $1 AND c.activo = true`,
      [token]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Token inválido o caja desactivada' });
    }

    const caja = r.rows[0];
    if (!caja.negocio_activo) {
      return res.status(403).json({ error: 'Este negocio está desactivado' });
    }

    // Adjuntar contexto a la request — todas las rutas filtran por esto
    req.caja = {
      id: caja.caja_id,
      nombre: caja.caja_nombre,
      tipo: caja.caja_tipo,
      sucursal_id: caja.sucursal_id,
      negocio_id: caja.negocio_id,
      negocio_nombre: caja.negocio_nombre
    };

    next();
  } catch (e) {
    res.status(500).json({ error: 'Error de autenticación: ' + e.message });
  }
}

module.exports = { authCaja };
