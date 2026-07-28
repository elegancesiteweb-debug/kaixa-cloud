// routes/producto-extras.js — Extras opcionales de producto (ej. "+queso +$10"),
// calcado de routes/variantes.js (mismas convenciones: UUID, scoping por
// negocio/sucursal/producto). Elegibles al personalizar el pedido en
// mesero/PC Cobrar/kiosko (pos-mexico) y en la tienda en línea.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
function uuid() { return crypto.randomUUID(); }

async function ensureExtrasTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS producto_extras (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id    UUID NOT NULL REFERENCES sucursales(id),
      producto_id    UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      nombre         TEXT NOT NULL,
      precio_extra   NUMERIC(12,2) DEFAULT 0,
      activo         BOOLEAN DEFAULT true,
      creado_en      TIMESTAMPTZ DEFAULT now(),
      actualizado_en TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_extras_producto ON producto_extras(producto_id);
  `);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS tiene_extras BOOLEAN DEFAULT false`);
}

// ── GET /api/producto-extras/producto/:id — extras activos de un producto ──
router.get('/producto-extras/producto/:id', async (req, res) => {
  try {
    await ensureExtrasTable();
    const r = await pool.query(
      `SELECT * FROM producto_extras WHERE producto_id=$1 AND negocio_id=$2 AND activo=true ORDER BY nombre`,
      [req.params.id, req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/producto-extras/producto/:id — reemplaza el set de extras ──
router.post('/producto-extras/producto/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureExtrasTable();
    const { negocio_id, sucursal_id } = req.caja;
    const extras = req.body.extras || [];

    await client.query('BEGIN');
    const prod = await client.query('SELECT id FROM productos WHERE id=$1 AND negocio_id=$2', [req.params.id, negocio_id]);
    if (!prod.rows.length) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });

    await client.query('UPDATE producto_extras SET activo=false, actualizado_en=now() WHERE producto_id=$1', [req.params.id]);

    for (const e of extras) {
      await client.query(
        `INSERT INTO producto_extras (id, negocio_id, sucursal_id, producto_id, nombre, precio_extra, activo)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [uuid(), negocio_id, sucursal_id, req.params.id, e.nombre||'', parseFloat(e.precio_extra)||0]
      );
    }
    await client.query('UPDATE productos SET tiene_extras=$1, actualizado_en=now() WHERE id=$2',
      [extras.length > 0, req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true, guardados: extras.length });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = { router, ensureExtrasTable };
