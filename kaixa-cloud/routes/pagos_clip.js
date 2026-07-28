// routes/pagos_clip.js — Cobro con terminal física Clip Pin Pad (SDK Terminal)
// Proveedor separado de Mercado Pago: credenciales propias por negocio, sin nada
// compartido con routes/pagos.js — mismo cobro "empuja a la terminal, sondea estado"
// que ya usa el kiosko con Mercado Pago Point.
const express = require('express');
const router  = express.Router();
const https   = require('https');
const pool    = require('../db/pool');

async function ensureClipTables() {
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS clip_api_key TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS clip_terminal_id TEXT DEFAULT ''`);
}

function clipRequest(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.payclip.io',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── GET /api/pagos/clip/config ───────────────────────────────────
router.get('/pagos/clip/config', async (req, res) => {
  try {
    await ensureClipTables();
    const r = await pool.query('SELECT clip_api_key, clip_terminal_id FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const cfg = r.rows[0] || {};
    const safe = {
      clip_terminal_id: cfg.clip_terminal_id || '',
      configurado: !!cfg.clip_api_key,
      clip_configurado: !!(cfg.clip_api_key && cfg.clip_terminal_id)
    };
    if (cfg.clip_api_key && cfg.clip_api_key.length > 8) {
      safe.api_key_preview = cfg.clip_api_key.substring(0,4) + '****' + cfg.clip_api_key.slice(-4);
    }
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/pagos/clip/config ───────────────────────────────────
router.put('/pagos/clip/config', async (req, res) => {
  try {
    await ensureClipTables();
    const { clip_api_key, clip_terminal_id } = req.body;
    const sets = []; const vals = [];
    if (clip_api_key !== undefined)     { vals.push(clip_api_key); sets.push(`clip_api_key=$${vals.length}`); }
    if (clip_terminal_id !== undefined) { vals.push(clip_terminal_id); sets.push(`clip_terminal_id=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.caja.negocio_id);
    await pool.query(`UPDATE negocios SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pagos/clip/pagar — empuja un cobro a la terminal Pin Pad ──
router.post('/pagos/clip/pagar', async (req, res) => {
  try {
    await ensureClipTables();
    const negR = await pool.query('SELECT clip_api_key, clip_terminal_id FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const apiKey = negR.rows[0] && negR.rows[0].clip_api_key;
    const terminalId = negR.rows[0] && negR.rows[0].clip_terminal_id;
    if (!apiKey) return res.status(400).json({ error: 'Clip no configurado. Ve a Ajustes > Pagos con tarjeta.' });
    if (!terminalId) return res.status(400).json({ error: 'Configura tu terminal Clip en Ajustes > Pagos con tarjeta.' });

    const monto = parseFloat(req.body.monto);
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });
    const referenciaExterna = req.body.referencia_externa || ('kx-clip-' + Date.now());

    const body = {
      amount: monto,
      reference: referenciaExterna,
      serial_number_pos: terminalId
    };
    const r = await clipRequest('POST', '/f2f/pinpad/v1/payment', body, apiKey);
    if (r.status !== 200 && r.status !== 201) {
      return res.status(400).json({ error: 'Error de Clip: ' + (r.data && r.data.message || JSON.stringify(r.data)) });
    }
    res.json({ ok: true, payment_id: (r.data && r.data.id) || referenciaExterna, referencia_externa: referenciaExterna });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/pagos/clip/estado/:referencia — consulta el estado de un cobro Clip ──
router.get('/pagos/clip/estado/:referencia', async (req, res) => {
  try {
    await ensureClipTables();
    const negR = await pool.query('SELECT clip_api_key FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const apiKey = negR.rows[0] && negR.rows[0].clip_api_key;
    if (!apiKey) return res.status(400).json({ error: 'No configurado' });
    const r = await clipRequest('GET', '/f2f/pinpad/v1/payment/' + encodeURIComponent(req.params.referencia), null, apiKey);
    if (r.status !== 200) return res.json({ pagado: false });
    const status = r.data && (r.data.status || r.data.state);
    const aprobado = status === 'approved' || status === 'success' || status === 'completed';
    res.json({ pagado: aprobado, status: status || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, ensureClipTables, clipRequest };
