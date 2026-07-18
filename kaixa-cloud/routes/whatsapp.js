// routes/whatsapp.js — Recordatorios de cobro al cliente vía WhatsApp Business API (Meta Cloud API)
const express = require('express');
const router  = express.Router();
const https   = require('https');
const pool    = require('../db/pool');

async function ensureWhatsappTables() {
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS whatsapp_token TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS whatsapp_phone_id TEXT DEFAULT ''`);
}

// Llamada a la API de WhatsApp Cloud (graph.facebook.com) — mensaje de texto libre.
// Nota: fuera de la ventana de 24h desde el último mensaje del cliente, Meta exige una
// plantilla pre-aprobada; un mensaje de texto libre puede ser rechazado por Meta en ese caso.
function whatsappRequest(phoneId, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'graph.facebook.com',
      port: 443,
      path: '/v20.0/' + phoneId + '/messages',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
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
    req.write(bodyStr);
    req.end();
  });
}

// Normaliza un teléfono mexicano a formato E.164 sin '+' (lo que espera la API de WhatsApp).
function normalizarTelefonoMx(tel) {
  if (!tel) return '';
  let d = String(tel).replace(/\D/g, '');
  if (d.length === 10) d = '52' + d;
  return d;
}

// Helper reutilizable: envía un mensaje de texto a un cliente para un negocio dado.
// Devuelve { ok, error? } — nunca lanza, para poder usarse en un job en segundo plano.
async function enviarWhatsapp(negocioId, telefono, mensaje) {
  try {
    await ensureWhatsappTables();
    const to = normalizarTelefonoMx(telefono);
    if (!to) return { ok: false, error: 'Sin teléfono' };
    const r0 = await pool.query(
      'SELECT whatsapp_token, whatsapp_phone_id FROM negocios WHERE id=$1', [negocioId]);
    const cfg = r0.rows[0];
    if (!cfg || !cfg.whatsapp_token || !cfg.whatsapp_phone_id) {
      return { ok: false, error: 'WhatsApp no configurado' };
    }
    const r = await whatsappRequest(cfg.whatsapp_phone_id, cfg.whatsapp_token, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: mensaje }
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, error: (r.data && r.data.error && r.data.error.message) || 'Error al enviar' };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── GET /api/whatsapp/config ────────────────────────────────────
router.get('/whatsapp/config', async (req, res) => {
  try {
    await ensureWhatsappTables();
    const r = await pool.query(
      'SELECT whatsapp_token, whatsapp_phone_id FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const cfg = r.rows[0] || {};
    const safe = { whatsapp_phone_id: cfg.whatsapp_phone_id || '' };
    if (cfg.whatsapp_token && cfg.whatsapp_token.length > 8) {
      safe.token_preview = cfg.whatsapp_token.substring(0,4) + '****' + cfg.whatsapp_token.slice(-4);
    }
    safe.configurado = !!(cfg.whatsapp_token && cfg.whatsapp_phone_id);
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/whatsapp/config ────────────────────────────────────
router.put('/whatsapp/config', async (req, res) => {
  try {
    await ensureWhatsappTables();
    const { token, phone_id } = req.body;
    const sets = []; const vals = [];
    if (token !== undefined)    { vals.push(token); sets.push(`whatsapp_token=$${vals.length}`); }
    if (phone_id !== undefined) { vals.push(phone_id); sets.push(`whatsapp_phone_id=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.caja.negocio_id);
    await pool.query(`UPDATE negocios SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/whatsapp/test ─────────────────────────────────────
router.post('/whatsapp/test', async (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ error: 'Falta teléfono' });
    const r = await enviarWhatsapp(req.caja.negocio_id, telefono,
      '✅ Prueba de WhatsApp desde Kaixa. Si recibiste este mensaje, la configuración funciona correctamente.');
    if (r.ok) res.json({ ok: true });
    else res.status(400).json({ ok: false, error: r.error });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, ensureWhatsappTables, enviarWhatsapp, normalizarTelefonoMx };
