// routes/pagos.js — Cobro con tarjeta vía Mercado Pago (Checkout Pro)
// El cajero genera un link/QR de pago, el cliente paga desde su celular
// con tarjeta, y el sistema confirma el cobro por webhook o por consulta manual.
const express = require('express');
const router  = express.Router();
const webhookRouter = express.Router(); // público — Mercado Pago no manda x-caja-token
const https   = require('https');
const pool    = require('../db/pool');

async function ensurePagosTables() {
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS mp_access_token TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS mp_public_key TEXT DEFAULT ''`);
}

function mpRequest(method, path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.mercadopago.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
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

// ── GET /api/pagos/config ────────────────────────────────────────
router.get('/pagos/config', async (req, res) => {
  try {
    await ensurePagosTables();
    const r = await pool.query('SELECT mp_access_token, mp_public_key FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const cfg = r.rows[0] || {};
    const safe = { mp_public_key: cfg.mp_public_key || '', configurado: !!cfg.mp_access_token };
    if (cfg.mp_access_token && cfg.mp_access_token.length > 8) {
      safe.access_token_preview = cfg.mp_access_token.substring(0,4) + '****' + cfg.mp_access_token.slice(-4);
    }
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/pagos/config ────────────────────────────────────────
router.put('/pagos/config', async (req, res) => {
  try {
    await ensurePagosTables();
    const { mp_access_token, mp_public_key } = req.body;
    const sets = []; const vals = [];
    if (mp_access_token !== undefined) { vals.push(mp_access_token); sets.push(`mp_access_token=$${vals.length}`); }
    if (mp_public_key !== undefined)   { vals.push(mp_public_key); sets.push(`mp_public_key=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.caja.negocio_id);
    await pool.query(`UPDATE negocios SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pagos/mp/preferencia — genera link de cobro ───────
router.post('/pagos/mp/preferencia', async (req, res) => {
  try {
    await ensurePagosTables();
    const negR = await pool.query('SELECT mp_access_token FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const accessToken = negR.rows[0] && negR.rows[0].mp_access_token;
    if (!accessToken) return res.status(400).json({ error: 'Mercado Pago no configurado. Ve a Ajustes > Pagos con tarjeta.' });

    const monto = parseFloat(req.body.monto);
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });
    const descripcion = req.body.descripcion || 'Cobro Kaixa Pos';
    const referenciaExterna = req.body.referencia_externa || ('kx-' + Date.now());

    const host = req.protocol + '://' + req.get('host');
    const body = {
      items: [{ title: descripcion, quantity: 1, unit_price: monto, currency_id: 'MXN' }],
      external_reference: referenciaExterna,
      notification_url: host + '/api/pagos/mp/webhook/' + req.caja.negocio_id,
      back_urls: { success: host, failure: host, pending: host }
    };
    const r = await mpRequest('POST', '/checkout/preferences', body, accessToken);
    if (r.status !== 200 && r.status !== 201) {
      return res.status(400).json({ error: 'Error de Mercado Pago: ' + (r.data && r.data.message || JSON.stringify(r.data)) });
    }
    res.json({
      ok: true,
      preference_id: r.data.id,
      init_point: r.data.init_point,
      referencia_externa: referenciaExterna
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/pagos/mp/estado/:referencia — consulta manual de estado ──
router.get('/pagos/mp/estado/:referencia', async (req, res) => {
  try {
    await ensurePagosTables();
    const negR = await pool.query('SELECT mp_access_token FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const accessToken = negR.rows[0] && negR.rows[0].mp_access_token;
    if (!accessToken) return res.status(400).json({ error: 'No configurado' });
    const r = await mpRequest('GET', '/v1/payments/search?external_reference=' + encodeURIComponent(req.params.referencia), null, accessToken);
    if (r.status !== 200) return res.json({ pagado: false });
    const pagos = (r.data && r.data.results) || [];
    const aprobado = pagos.find(p => p.status === 'approved');
    res.json({ pagado: !!aprobado, payment_id: aprobado ? aprobado.id : null, status: aprobado ? aprobado.status : (pagos[0] && pagos[0].status) || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pagos/mp/webhook/:negocio_id — notificación de Mercado Pago (pública, sin token de caja) ──
webhookRouter.post('/pagos/mp/webhook/:negocio_id', express.json(), async (req, res) => {
  // Siempre responder 200 rápido — Mercado Pago reintenta si no recibe 2xx
  res.sendStatus(200);
  try {
    const paymentId = (req.body && req.body.data && req.body.data.id) || req.query.id;
    const topic = (req.body && req.body.type) || req.query.topic;
    if (!paymentId || (topic && topic !== 'payment')) return;

    const negR = await pool.query('SELECT mp_access_token FROM negocios WHERE id=$1', [req.params.negocio_id]);
    const accessToken = negR.rows[0] && negR.rows[0].mp_access_token;
    if (!accessToken) return;

    const r = await mpRequest('GET', '/v1/payments/' + paymentId, null, accessToken);
    if (r.status !== 200 || r.data.status !== 'approved') return;

    const referencia = r.data.external_reference || '';
    if (referencia.startsWith('pedido:')) {
      const pedidoId = referencia.slice('pedido:'.length);
      try {
        await pool.query(
          `UPDATE pedidos_online SET pagado_en_linea=true, mp_payment_id=$1 WHERE id=$2 AND negocio_id=$3`,
          [String(paymentId), pedidoId, req.params.negocio_id]
        );
      } catch(e) {}
    }

    const io = req.app.get('io');
    if (io) {
      io.to('negocio:' + req.params.negocio_id).emit('pago_mp:aprobado', {
        referencia_externa: referencia, payment_id: paymentId, monto: r.data.transaction_amount
      });
    }
  } catch(e) { console.error('Webhook MP error:', e.message); }
});

module.exports = { router, webhookRouter, ensurePagosTables, mpRequest };
