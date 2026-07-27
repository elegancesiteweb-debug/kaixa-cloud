// routes/encuestas.js — Kaixa Cloud
// Encuesta de satisfacción básica: una sola pregunta (calificación 1-5 +
// comentario opcional), sin constructor de encuestas multi-pregunta — mismo
// criterio de "básico" que ya se usó para Reservaciones en pos-mexico.
const express = require('express');
const router = express.Router();      // público — el cliente responde sin login
const authRouter = express.Router();  // se monta con authCaja en server.js
const pool = require('../db/pool');

async function ensureEncuestasTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS encuestas_respuestas (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      folio_venta    TEXT DEFAULT '',
      calificacion   INTEGER NOT NULL,
      comentario     TEXT DEFAULT '',
      creado_en      TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_encuestas_negocio ON encuestas_respuestas(negocio_id);
  `);
}

// ── POST /api/encuesta/:slug — público, sin x-caja-token (lo llena el cliente) ──
router.post('/encuesta/:slug', async (req, res) => {
  try {
    await ensureEncuestasTables();
    const { folio = '', calificacion, comentario = '' } = req.body;
    const cal = parseInt(calificacion);
    if (!cal || cal < 1 || cal > 5) return res.status(400).json({ error: 'Calificación inválida (debe ser de 1 a 5)' });
    const neg = await pool.query('SELECT id FROM negocios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Negocio no encontrado' });
    await pool.query(
      'INSERT INTO encuestas_respuestas (negocio_id, folio_venta, calificacion, comentario) VALUES ($1,$2,$3,$4)',
      [neg.rows[0].id, folio, cal, comentario]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/encuestas — respuestas + promedio del negocio autenticado ──
authRouter.get('/encuestas', async (req, res) => {
  try {
    await ensureEncuestasTables();
    const { negocio_id } = req.caja;
    const r = await pool.query(
      'SELECT id, folio_venta, calificacion, comentario, creado_en FROM encuestas_respuestas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 100',
      [negocio_id]
    );
    const avgR = await pool.query(
      'SELECT COALESCE(AVG(calificacion),0) as promedio, COUNT(*) as total FROM encuestas_respuestas WHERE negocio_id=$1',
      [negocio_id]
    );
    res.json({ respuestas: r.rows, promedio: parseFloat(avgR.rows[0].promedio), total: parseInt(avgR.rows[0].total, 10) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, authRouter, ensureEncuestasTables };
