// routes/modulos-opcionales.js — Sub-funciones activables por negocio
// Independientes del giro: el dueño las prende/apaga él mismo desde la PC o
// la app móvil. Separado de licencias.modulos (que controla el admin de
// Kaixa al vender el plan) para que un cambio de plan nunca borre estos
// toggles, ni al revés.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');

// Whitelist fija — el cliente nunca puede mandar una clave arbitraria.
// Cada sub-función mapea a los módulos reales que activa en el nav
// (mismas claves que ya reconoce frontend/public/index.html y GIROS).
// Las que todavía no están construidas quedan con arreglo vacío: se pueden
// guardar como "activas" sin efecto, listas para cuando se implementen.
const SUBFUNCIONES = {
  compras_recepcion:      ['proveedores', 'pedidos'],
  multi_almacen:          [],
  reportes_consolidados:  [],
  conteo_ciclico:         [],
  entregas_programadas:   [],
};

let _modulosOpcionalesColOk = false;
async function ensureModulosOpcionalesColumn() {
  if (_modulosOpcionalesColOk) return;
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS modulos_opcionales TEXT DEFAULT '[]'`);
  _modulosOpcionalesColOk = true;
}

function modulosDeOpcionales(opcionales) {
  const set = new Set();
  opcionales.forEach(op => (SUBFUNCIONES[op] || []).forEach(m => set.add(m)));
  return [...set];
}

// ── GET /api/negocio/modulos-opcionales ───────────────────────────
router.get('/negocio/modulos-opcionales', async (req, res) => {
  try {
    await ensureModulosOpcionalesColumn();
    const r = await pool.query('SELECT modulos_opcionales FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    let activos = [];
    try { activos = JSON.parse((r.rows[0] && r.rows[0].modulos_opcionales) || '[]'); } catch(e) {}
    res.json({ disponibles: Object.keys(SUBFUNCIONES), activos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/negocio/modulos-opcionales — {modulo, activo} ────────
router.put('/negocio/modulos-opcionales', async (req, res) => {
  try {
    await ensureModulosOpcionalesColumn();
    const { modulo, activo } = req.body;
    if (!SUBFUNCIONES.hasOwnProperty(modulo)) {
      return res.status(400).json({ error: 'Sub-función desconocida: ' + modulo });
    }
    const r = await pool.query('SELECT modulos_opcionales FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    let activos = [];
    try { activos = JSON.parse((r.rows[0] && r.rows[0].modulos_opcionales) || '[]'); } catch(e) {}
    const set = new Set(activos);
    if (activo) set.add(modulo); else set.delete(modulo);
    const nuevos = [...set];
    await pool.query('UPDATE negocios SET modulos_opcionales=$1 WHERE id=$2', [JSON.stringify(nuevos), req.caja.negocio_id]);
    res.json({ ok: true, activos: nuevos, modulos: modulosDeOpcionales(nuevos) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, SUBFUNCIONES, modulosDeOpcionales, ensureModulosOpcionalesColumn };
