// routes/tarjetas-regalo.js — Tarjetas de regalo: código único, saldo
// redimible en CUALQUIER sucursal del negocio (a diferencia del monedero,
// que vive 100% local y requiere un cliente ya registrado). Por eso viven
// aquí (Postgres, tiempo real cross-branch) y no en pos-mexico/SQLite.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
function uuid() { return crypto.randomUUID(); }

async function ensureTarjetasRegaloTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarjetas_regalo (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      codigo         TEXT NOT NULL UNIQUE,
      saldo_inicial  NUMERIC(12,2) DEFAULT 0,
      saldo_actual   NUMERIC(12,2) DEFAULT 0,
      activa         BOOLEAN DEFAULT true,
      vendida_por    TEXT DEFAULT '',
      notas          TEXT DEFAULT '',
      creado_en      TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tarjeta_regalo_movimientos (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tarjeta_id  UUID NOT NULL REFERENCES tarjetas_regalo(id) ON DELETE CASCADE,
      tipo        TEXT NOT NULL, -- 'venta' | 'redencion'
      monto       NUMERIC(12,2) DEFAULT 0,
      venta_id    UUID,
      creado_en   TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tarjetas_regalo_negocio ON tarjetas_regalo(negocio_id);
  `);
}

function generarCodigo() {
  const grupo = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'TG-' + grupo() + '-' + grupo();
}

// ── POST /api/tarjetas-regalo — vender ────────────────────────
router.post('/tarjetas-regalo', async (req, res) => {
  try {
    await ensureTarjetasRegaloTables();
    const { negocio_id } = req.caja;
    const { monto, notas = '' } = req.body;
    const montoNum = parseFloat(monto);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });

    let codigo, intentos = 0;
    while (true) {
      codigo = generarCodigo();
      const existe = await pool.query('SELECT 1 FROM tarjetas_regalo WHERE codigo=$1', [codigo]);
      if (!existe.rows.length) break;
      if (++intentos > 5) return res.status(500).json({ error: 'No se pudo generar un código único, intenta de nuevo' });
    }

    const ins = await pool.query(
      `INSERT INTO tarjetas_regalo (negocio_id, codigo, saldo_inicial, saldo_actual, vendida_por, notas)
       VALUES ($1,$2,$3,$3,$4,$5) RETURNING id, codigo, saldo_actual, creado_en`,
      [negocio_id, codigo, montoNum, req.caja.nombre || '', notas]
    );
    const tarjeta = ins.rows[0];
    await pool.query(
      `INSERT INTO tarjeta_regalo_movimientos (tarjeta_id, tipo, monto) VALUES ($1,'venta',$2)`,
      [tarjeta.id, montoNum]
    );
    res.json({ ok: true, ...tarjeta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tarjetas-regalo — listar (para la pestaña del negocio) ──
router.get('/tarjetas-regalo', async (req, res) => {
  try {
    await ensureTarjetasRegaloTables();
    const q = (req.query.q || '').trim().toUpperCase();
    const params = [req.caja.negocio_id];
    let filtro = '';
    if (q) { params.push('%' + q + '%'); filtro = ' AND codigo ILIKE $2'; }
    const r = await pool.query(
      `SELECT * FROM tarjetas_regalo WHERE negocio_id=$1${filtro} ORDER BY creado_en DESC LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tarjetas-regalo/:codigo — consultar saldo ────────
router.get('/tarjetas-regalo/:codigo', async (req, res) => {
  try {
    await ensureTarjetasRegaloTables();
    const r = await pool.query(
      `SELECT * FROM tarjetas_regalo WHERE negocio_id=$1 AND codigo=$2`,
      [req.caja.negocio_id, req.params.codigo.trim().toUpperCase()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tarjetas-regalo/:codigo/redimir — usar saldo en una venta ──
router.post('/tarjetas-regalo/:codigo/redimir', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTarjetasRegaloTables();
    const { monto, venta_id = null } = req.body;
    const montoNum = parseFloat(monto);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'Monto inválido' });

    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM tarjetas_regalo WHERE negocio_id=$1 AND codigo=$2 FOR UPDATE`,
      [req.caja.negocio_id, req.params.codigo.trim().toUpperCase()]
    );
    if (!r.rows.length) throw Object.assign(new Error('Tarjeta no encontrada'), { status: 404 });
    const tarjeta = r.rows[0];
    if (!tarjeta.activa) throw Object.assign(new Error('Tarjeta inactiva'), { status: 400 });
    if (parseFloat(tarjeta.saldo_actual) < montoNum) {
      throw Object.assign(new Error('Saldo insuficiente (disponible $' + tarjeta.saldo_actual + ')'), { status: 400 });
    }

    const upd = await client.query(
      `UPDATE tarjetas_regalo SET saldo_actual = saldo_actual - $1 WHERE id=$2 RETURNING saldo_actual`,
      [montoNum, tarjeta.id]
    );
    await client.query(
      `INSERT INTO tarjeta_regalo_movimientos (tarjeta_id, tipo, monto, venta_id) VALUES ($1,'redencion',$2,$3)`,
      [tarjeta.id, montoNum, venta_id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, saldo_actual: upd.rows[0].saldo_actual });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = { router, ensureTarjetasRegaloTables };
