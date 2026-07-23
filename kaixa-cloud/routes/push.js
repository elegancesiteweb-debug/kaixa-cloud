// routes/push.js — Notificaciones push (stock bajo, lotes por caducar)
// Se monta en server.js como: app.use('/api/push', authCaja, pushRouter);
// crearTablasPush() se llama desde server.js DESPUÉS de aplicarEsquema(),
// porque push_subscriptions/alertas_enviadas referencian negocios/sucursales.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const webpush = require('web-push');
const { enviarWhatsapp } = require('./whatsapp');

async function crearTablasPush() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
        sucursal_id UUID REFERENCES sucursales(id) ON DELETE CASCADE,
        endpoint    TEXT UNIQUE NOT NULL,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        creado_en   TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS alertas_enviadas (
        id          BIGSERIAL PRIMARY KEY,
        sucursal_id UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
        tipo        TEXT NOT NULL,
        clave       TEXT NOT NULL,
        enviado_en  TIMESTAMPTZ DEFAULT now(),
        UNIQUE(sucursal_id, tipo, clave)
      );
      CREATE TABLE IF NOT EXISTS notificaciones (
        id            SERIAL PRIMARY KEY,
        negocio_id    UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
        sucursal_id   UUID REFERENCES sucursales(id) ON DELETE CASCADE,
        tipo          TEXT NOT NULL,
        titulo        TEXT NOT NULL,
        cuerpo        TEXT DEFAULT '',
        referencia_id TEXT,
        leida         BOOLEAN DEFAULT false,
        creado_en     TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_notificaciones_sucursal ON notificaciones(sucursal_id, leida);
    `);
    console.log('✅ Tablas de push listas');
  } catch(e) { console.error('⚠️ Error creando tablas de push:', e.message); }
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:soporte@kaixapro.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configuradas — las notificaciones push no funcionarán');
}

// ── GET /api/push/public-key — la PWA la pide para suscribirse ──
router.get('/public-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── POST /api/push/subscribe — guarda/actualiza la suscripción del navegador ──
router.post('/subscribe', async function(req, res) {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Suscripción inválida' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (negocio_id, sucursal_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET negocio_id=$1, sucursal_id=$2, p256dh=$4, auth=$5`,
      [req.caja.negocio_id, req.caja.sucursal_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/push/subscribe — al desactivar notificaciones en el celular ──
router.delete('/subscribe', async function(req, res) {
  try {
    const { endpoint } = req.body;
    if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Envío ─────────────────────────────────────────────────────
async function enviarASucursal(sucursalId, negocioId, payload) {
  const subs = await pool.query(
    'SELECT * FROM push_subscriptions WHERE sucursal_id=$1 OR (sucursal_id IS NULL AND negocio_id=$2)',
    [sucursalId, negocioId]
  );
  for (const s of subs.rows) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch(e) {
      // 404/410 = el navegador invalidó esa suscripción (desinstaló, cambió de dispositivo, etc.)
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [s.endpoint]).catch(function(){});
      } else {
        console.error('❌ Error enviando push:', e.message);
      }
    }
  }
}

async function yaSeAviso(sucursalId, tipo, clave) {
  const r = await pool.query(
    `SELECT 1 FROM alertas_enviadas WHERE sucursal_id=$1 AND tipo=$2 AND clave=$3
     AND enviado_en > now() - interval '24 hours'`,
    [sucursalId, tipo, clave]
  );
  return r.rows.length > 0;
}
async function marcarAvisado(sucursalId, tipo, clave) {
  await pool.query(
    `INSERT INTO alertas_enviadas (sucursal_id, tipo, clave) VALUES ($1,$2,$3)
     ON CONFLICT (sucursal_id, tipo, clave) DO UPDATE SET enviado_en = now()`,
    [sucursalId, tipo, clave]
  );
}

// ── Centro de notificaciones dentro de la app (independiente del push del ──
// navegador de arriba, que requiere permiso/instalación) — usado por la
// campana 🔔 de la PWA.
async function crearNotificacion(negocioId, sucursalId, tipo, titulo, cuerpo, referenciaId) {
  try {
    await pool.query(
      `INSERT INTO notificaciones (negocio_id, sucursal_id, tipo, titulo, cuerpo, referencia_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [negocioId, sucursalId, tipo, titulo, cuerpo || '', referenciaId != null ? String(referenciaId) : null]
    );
  } catch(e) { console.error('⚠️ crearNotificacion:', e.message); }
}

// ── Chequeo periódico: stock bajo + lotes por caducar (llamado desde server.js) ──
async function revisarAlertas() {
  try {
    // Stock bajo — usa la vista stock_actual ya definida en schema.sql
    const bajos = await pool.query(`
      SELECT p.id, p.nombre, p.negocio_id, p.sucursal_id, p.stock_minimo,
             COALESCE(sa.stock, 0) AS stock
      FROM productos p
      LEFT JOIN stock_actual sa ON sa.producto_id = p.id AND sa.sucursal_id = p.sucursal_id
      WHERE p.activo = true AND p.sucursal_id IS NOT NULL
        AND COALESCE(sa.stock, 0) <= p.stock_minimo
    `);
    for (const p of bajos.rows) {
      if (await yaSeAviso(p.sucursal_id, 'stock_bajo', p.id)) continue;
      const cuerpo = p.nombre + ': quedan ' + p.stock + ' (mínimo ' + p.stock_minimo + ')';
      await enviarASucursal(p.sucursal_id, p.negocio_id, { title: '📉 Stock bajo', body: cuerpo, tag: 'stock_bajo' });
      await crearNotificacion(p.negocio_id, p.sucursal_id, 'stock_bajo', '📉 Stock bajo', cuerpo, p.id);
      await marcarAvisado(p.sucursal_id, 'stock_bajo', p.id);
    }

    // Lotes por caducar en los próximos 7 días (y que no hayan caducado ya)
    const lotes = await pool.query(`
      SELECT l.id, l.nombre_producto, l.numero_lote, l.negocio_id, l.sucursal_id,
             (l.fecha_caducidad - CURRENT_DATE) AS dias
      FROM lotes l
      WHERE l.activo = true AND l.sucursal_id IS NOT NULL AND l.fecha_caducidad IS NOT NULL
        AND l.fecha_caducidad BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
    `);
    for (const l of lotes.rows) {
      if (await yaSeAviso(l.sucursal_id, 'lote_caduca', l.id)) continue;
      const cuerpo = (l.nombre_producto || 'Producto') + ' (lote ' + l.numero_lote + '): caduca en ' + l.dias + ' día(s)';
      await enviarASucursal(l.sucursal_id, l.negocio_id, { title: '⏳ Lote por caducar', body: cuerpo, tag: 'lote_caduca' });
      await crearNotificacion(l.negocio_id, l.sucursal_id, 'lote_caduca', '⏳ Lote por caducar', cuerpo, l.id);
      await marcarAvisado(l.sucursal_id, 'lote_caduca', l.id);
    }
    // Fiado (venta a crédito) con fecha de pago vencida — se avisa al CLIENTE por WhatsApp
    const fiados = await pool.query(`
      SELECT v.id, v.negocio_id, v.sucursal_id, v.folio, v.total, v.fecha_pago,
             c.nombre AS cliente_nombre, c.telefono AS cliente_telefono
      FROM ventas v
      JOIN clientes c ON c.id = v.cliente_id
      WHERE v.forma_pago = 'credito' AND v.estado = 'completada'
        AND v.fecha_pago IS NOT NULL AND v.fecha_pago <= CURRENT_DATE
        AND c.telefono IS NOT NULL AND c.telefono <> ''
    `);
    for (const v of fiados.rows) {
      if (await yaSeAviso(v.sucursal_id, 'cobro_fiado', v.id)) continue;
      await enviarWhatsapp(v.negocio_id, v.cliente_telefono,
        'Hola ' + v.cliente_nombre + ', te recordamos que tienes un saldo pendiente de $' +
        Number(v.total).toFixed(2) + ' (folio ' + v.folio + '). ¡Gracias por tu preferencia!');
      await marcarAvisado(v.sucursal_id, 'cobro_fiado', v.id);
    }

    // Apartados con fecha de cobro vencida — se avisa al CLIENTE por WhatsApp
    const apartados = await pool.query(`
      SELECT ar.id, ar.negocio_id, ar.sucursal_id, ar.apartado_local_id, ar.folio, ar.saldo,
             ar.cliente_nombre, ar.cliente_telefono
      FROM apartados_recordatorio ar
      WHERE ar.activo = true AND ar.fecha_pago IS NOT NULL AND ar.fecha_pago <= CURRENT_DATE
        AND ar.cliente_telefono IS NOT NULL AND ar.cliente_telefono <> ''
    `);
    for (const a of apartados.rows) {
      if (await yaSeAviso(a.sucursal_id, 'cobro_apartado', a.apartado_local_id)) continue;
      await enviarWhatsapp(a.negocio_id, a.cliente_telefono,
        'Hola ' + a.cliente_nombre + ', te recordamos que tienes un apartado pendiente de $' +
        Number(a.saldo).toFixed(2) + ' (folio ' + a.folio + '). ¡Gracias por tu preferencia!');
      await marcarAvisado(a.sucursal_id, 'cobro_apartado', a.apartado_local_id);
    }
  } catch(e) {
    console.error('❌ Error revisando alertas de push:', e.message);
  }
}

module.exports = { router, revisarAlertas, crearTablasPush, enviarASucursal, crearNotificacion };
