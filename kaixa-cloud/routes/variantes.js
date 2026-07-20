// routes/variantes.js — Variantes genéricas de producto (hasta 2 atributos:
// ej. Talla+Color, Tamaño+Material) para CUALQUIER giro. No toca el sistema
// especializado de "ropa" (tallas/cambios/liquidación), que vive aparte y
// sigue siendo 100% local en la PC.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
function uuid() { return crypto.randomUUID(); }

async function ensureVariantesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS producto_variantes (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id       UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id      UUID NOT NULL REFERENCES sucursales(id),
      producto_id      UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      atributo1_nombre TEXT DEFAULT '',
      atributo1_valor  TEXT DEFAULT '',
      atributo2_nombre TEXT DEFAULT '',
      atributo2_valor  TEXT DEFAULT '',
      sku              TEXT DEFAULT '',
      precio_extra     NUMERIC(12,2) DEFAULT 0,
      stock            INTEGER DEFAULT 0,
      stock_minimo     INTEGER DEFAULT 0,
      imagen_url       TEXT DEFAULT '',
      activo           BOOLEAN DEFAULT true,
      creado_en        TIMESTAMPTZ DEFAULT now(),
      actualizado_en   TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_variantes_producto ON producto_variantes(producto_id);
  `);
  await pool.query(`ALTER TABLE producto_variantes ADD COLUMN IF NOT EXISTS imagen_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS tiene_variantes BOOLEAN DEFAULT false`);
  // Especificaciones extra (lista abierta de {nombre, valor}) — solo consulta
  // interna al gestionar la variante, no se usa en el carrito ni en tickets.
  await pool.query(`ALTER TABLE producto_variantes ADD COLUMN IF NOT EXISTS especificaciones JSONB DEFAULT '[]'`);
}

// ── GET /api/variantes/producto/:id — variantes activas de un producto ──
router.get('/variantes/producto/:id', async (req, res) => {
  try {
    await ensureVariantesTable();
    const r = await pool.query(
      `SELECT * FROM producto_variantes WHERE producto_id=$1 AND negocio_id=$2 AND activo=true
       ORDER BY atributo1_valor, atributo2_valor`,
      [req.params.id, req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/variantes/producto/:id — reemplaza el set de variantes ──
router.post('/variantes/producto/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureVariantesTable();
    const { negocio_id, sucursal_id } = req.caja;
    const variantes = req.body.variantes || [];

    await client.query('BEGIN');
    const prod = await client.query('SELECT id FROM productos WHERE id=$1 AND negocio_id=$2', [req.params.id, negocio_id]);
    if (!prod.rows.length) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });

    // Desactivar las anteriores (igual que el sistema de ropa: no se borran, se conservan por historial)
    await client.query('UPDATE producto_variantes SET activo=false, actualizado_en=now() WHERE producto_id=$1', [req.params.id]);

    for (const v of variantes) {
      await client.query(
        `INSERT INTO producto_variantes
           (id, negocio_id, sucursal_id, producto_id, atributo1_nombre, atributo1_valor,
            atributo2_nombre, atributo2_valor, sku, precio_extra, stock, stock_minimo, imagen_url, especificaciones, activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
        [uuid(), negocio_id, sucursal_id, req.params.id,
         v.atributo1_nombre||'', v.atributo1_valor||'', v.atributo2_nombre||'', v.atributo2_valor||'',
         v.sku||'', parseFloat(v.precio_extra)||0, parseInt(v.stock)||0, parseInt(v.stock_minimo)||0, v.imagen_url||'',
         JSON.stringify(Array.isArray(v.especificaciones) ? v.especificaciones : [])]
      );
    }
    await client.query('UPDATE productos SET tiene_variantes=$1, actualizado_en=now() WHERE id=$2',
      [variantes.length > 0, req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true, guardadas: variantes.length });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/variantes/:id/stock — ajuste rápido de stock de una variante ──
router.put('/variantes/:id/stock', async (req, res) => {
  try {
    await ensureVariantesTable();
    await pool.query(
      'UPDATE producto_variantes SET stock=$1, actualizado_en=now() WHERE id=$2 AND negocio_id=$3',
      [parseInt(req.body.stock) || 0, req.params.id, req.caja.negocio_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, ensureVariantesTable };
