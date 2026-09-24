// routes/tienda-cuenta.js — Cuenta de cliente de la tienda en línea (pública)
// El cliente se registra con nombre + teléfono + PIN, y con eso ve su historial
// de pedidos, vuelve a pedir en un toque y ve sus puntos de lealtad.
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');
const router  = express.Router();

const DIAS_SESION = 90;
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

let _tablasOk = false;
async function ensureCuentaTables() {
  if (_tablasOk) return;
  const { ensureTiendaTables } = require('./tienda');
  await ensureTiendaTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_clientes (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      telefono          TEXT NOT NULL,
      nombre            TEXT NOT NULL,
      email             TEXT DEFAULT '',
      pin_salt          TEXT NOT NULL,
      pin_hash          TEXT NOT NULL,
      direccion_calle   TEXT DEFAULT '',
      direccion_numero  TEXT DEFAULT '',
      direccion_colonia TEXT DEFAULT '',
      direccion_ciudad  TEXT DEFAULT '',
      direccion_cp      TEXT DEFAULT '',
      direccion_referencias TEXT DEFAULT '',
      intentos_fallidos INTEGER DEFAULT 0,
      bloqueado_hasta   TIMESTAMPTZ,
      creado_en         TIMESTAMPTZ DEFAULT now(),
      ultimo_acceso     TIMESTAMPTZ,
      UNIQUE (negocio_id, telefono)
    );
    CREATE TABLE IF NOT EXISTS tienda_sesiones (
      token_hash  TEXT PRIMARY KEY,
      cliente_id  UUID NOT NULL REFERENCES tienda_clientes(id) ON DELETE CASCADE,
      negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      expira_en   TIMESTAMPTZ NOT NULL,
      creado_en   TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tienda_sesiones_cliente ON tienda_sesiones(cliente_id);
    ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS tienda_cliente_id UUID;
    CREATE INDEX IF NOT EXISTS idx_pedidos_online_tienda_cliente ON pedidos_online(tienda_cliente_id);
  `);
  _tablasOk = true;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normalizarTel = t => String(t || '').replace(/\D/g, '').slice(-10);
const pinValido = p => /^\d{4,8}$/.test(String(p || ''));

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function pinCoincide(pin, salt, hashGuardado) {
  const a = Buffer.from(hashPin(pin, salt), 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Freno por IP contra registros/intentos en masa (en memoria, por proceso).
const _intentosIp = new Map();
function frenoIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const ahora = Date.now();
  const lista = (_intentosIp.get(ip) || []).filter(t => ahora - t < 10 * 60 * 1000);
  lista.push(ahora);
  _intentosIp.set(ip, lista);
  if (_intentosIp.size > 5000) _intentosIp.clear();
  return lista.length > 60;
}

async function negocioDeSlug(slug) {
  const r = await pool.query('SELECT id, nombre FROM negocios WHERE slug=$1 AND activo=true', [slug]);
  return r.rows[0] || null;
}

async function crearSesion(clienteId, negocioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO tienda_sesiones (token_hash, cliente_id, negocio_id, expira_en)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [sha256(token), clienteId, negocioId, String(DIAS_SESION)]
  );
  await pool.query('UPDATE tienda_clientes SET ultimo_acceso=now() WHERE id=$1', [clienteId]);
  return token;
}

// Devuelve el cliente dueño del token (o null). Se usa también al crear un pedido.
async function clienteDeRequest(req, negocioId) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  await ensureCuentaTables();
  const r = await pool.query(
    `SELECT c.* FROM tienda_sesiones s JOIN tienda_clientes c ON c.id = s.cliente_id
     WHERE s.token_hash=$1 AND s.negocio_id=$2 AND s.expira_en > now()`,
    [sha256(m[1]), negocioId]
  );
  return r.rows[0] || null;
}

function perfilPublico(c) {
  return {
    nombre: c.nombre, telefono: c.telefono, email: c.email || '',
    direccion_calle: c.direccion_calle || '', direccion_numero: c.direccion_numero || '',
    direccion_colonia: c.direccion_colonia || '', direccion_ciudad: c.direccion_ciudad || '',
    direccion_cp: c.direccion_cp || '', direccion_referencias: c.direccion_referencias || ''
  };
}

// ── POST /api/tienda/:slug/cuenta/registro ──
router.post('/tienda/:slug/cuenta/registro', async (req, res) => {
  try {
    if (frenoIp(req)) return res.status(429).json({ error: 'Demasiados intentos, espera unos minutos.' });
    await ensureCuentaTables();
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const { nombre, telefono, pin, email = '' } = req.body || {};
    const tel = normalizarTel(telefono);
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Escribe tu nombre' });
    if (tel.length !== 10) return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
    if (!pinValido(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 a 8 números' });

    const salt = crypto.randomBytes(16).toString('hex');
    let cli;
    try {
      const r = await pool.query(
        `INSERT INTO tienda_clientes (negocio_id, telefono, nombre, email, pin_salt, pin_hash)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [neg.id, tel, String(nombre).trim().slice(0, 120), String(email).trim().slice(0, 160), salt, hashPin(pin, salt)]
      );
      cli = r.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese teléfono. Inicia sesión.' });
      throw e;
    }
    const token = await crearSesion(cli.id, neg.id);
    res.json({ ok: true, token, perfil: perfilPublico(cli) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tienda/:slug/cuenta/login ──
router.post('/tienda/:slug/cuenta/login', async (req, res) => {
  try {
    if (frenoIp(req)) return res.status(429).json({ error: 'Demasiados intentos, espera unos minutos.' });
    await ensureCuentaTables();
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const tel = normalizarTel((req.body || {}).telefono);
    const pin = (req.body || {}).pin;
    const r = await pool.query('SELECT * FROM tienda_clientes WHERE negocio_id=$1 AND telefono=$2', [neg.id, tel]);
    const cli = r.rows[0];
    const generico = { error: 'Teléfono o PIN incorrecto' };
    if (!cli) return res.status(401).json(generico);
    if (cli.bloqueado_hasta && new Date(cli.bloqueado_hasta) > new Date()) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos.' });
    }
    if (!pinValido(pin) || !pinCoincide(pin, cli.pin_salt, cli.pin_hash)) {
      const intentos = (cli.intentos_fallidos || 0) + 1;
      if (intentos >= MAX_INTENTOS) {
        await pool.query(
          `UPDATE tienda_clientes SET intentos_fallidos=0, bloqueado_hasta = now() + ($2 || ' minutes')::interval WHERE id=$1`,
          [cli.id, String(MINUTOS_BLOQUEO)]);
      } else {
        await pool.query('UPDATE tienda_clientes SET intentos_fallidos=$2 WHERE id=$1', [cli.id, intentos]);
      }
      return res.status(401).json(generico);
    }
    await pool.query('UPDATE tienda_clientes SET intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=$1', [cli.id]);
    const token = await crearSesion(cli.id, neg.id);
    res.json({ ok: true, token, perfil: perfilPublico(cli) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tienda/:slug/cuenta/logout ──
router.post('/tienda/:slug/cuenta/logout', async (req, res) => {
  try {
    const m = (req.headers['authorization'] || '').match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (m) { await ensureCuentaTables(); await pool.query('DELETE FROM tienda_sesiones WHERE token_hash=$1', [sha256(m[1])]); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tienda/:slug/cuenta/me — perfil + puntos ──
router.get('/tienda/:slug/cuenta/me', async (req, res) => {
  try {
    await ensureCuentaTables();
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cli = await clienteDeRequest(req, neg.id);
    if (!cli) return res.status(401).json({ error: 'Sesión vencida' });
    // Puntos: el cliente de la caja (POS) con el mismo teléfono, si existe.
    let puntos = null;
    try {
      const p = await pool.query(
        `SELECT puntos FROM clientes
         WHERE negocio_id=$1 AND activo=true AND right(regexp_replace(COALESCE(telefono,''),'\\D','','g'),10) = $2
         ORDER BY puntos DESC NULLS LAST LIMIT 1`, [neg.id, cli.telefono]);
      if (p.rows.length) puntos = Number(p.rows[0].puntos) || 0;
    } catch (e) {}
    res.json({ ok: true, perfil: perfilPublico(cli), puntos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/tienda/:slug/cuenta/me — editar perfil / cambiar PIN ──
router.put('/tienda/:slug/cuenta/me', async (req, res) => {
  try {
    await ensureCuentaTables();
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cli = await clienteDeRequest(req, neg.id);
    if (!cli) return res.status(401).json({ error: 'Sesión vencida' });
    const b = req.body || {};
    const campos = ['nombre', 'email', 'direccion_calle', 'direccion_numero', 'direccion_colonia', 'direccion_ciudad', 'direccion_cp', 'direccion_referencias'];
    const sets = []; const vals = [];
    campos.forEach(c => {
      if (b[c] === undefined) return;
      const v = String(b[c]).trim().slice(0, 200);
      if (c === 'nombre' && !v) return;
      vals.push(v); sets.push(c + '=$' + vals.length);
    });
    if (b.pin_nuevo !== undefined) {
      if (!pinValido(b.pin_nuevo)) return res.status(400).json({ error: 'El PIN nuevo debe ser de 4 a 8 números' });
      if (!pinValido(b.pin_actual) || !pinCoincide(b.pin_actual, cli.pin_salt, cli.pin_hash)) {
        return res.status(401).json({ error: 'Tu PIN actual no es correcto' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      vals.push(salt); sets.push('pin_salt=$' + vals.length);
      vals.push(hashPin(b.pin_nuevo, salt)); sets.push('pin_hash=$' + vals.length);
    }
    if (sets.length) {
      vals.push(cli.id);
      await pool.query(`UPDATE tienda_clientes SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }
    const r = await pool.query('SELECT * FROM tienda_clientes WHERE id=$1', [cli.id]);
    res.json({ ok: true, perfil: perfilPublico(r.rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tienda/:slug/cuenta/pedidos — historial (solo pedidos hechos con la sesión iniciada) ──
router.get('/tienda/:slug/cuenta/pedidos', async (req, res) => {
  try {
    await ensureCuentaTables();
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cli = await clienteDeRequest(req, neg.id);
    if (!cli) return res.status(401).json({ error: 'Sesión vencida' });
    const r = await pool.query(
      `SELECT id, sucursal_id, folio, estado, subtotal, COALESCE(costo_envio,0) AS costo_envio,
              tipo_entrega, creado_en, rechazo_motivo
       FROM pedidos_online WHERE tienda_cliente_id=$1 AND negocio_id=$2
       ORDER BY creado_en DESC LIMIT 30`, [cli.id, neg.id]);
    const pedidos = r.rows;
    if (pedidos.length) {
      const it = await pool.query(
        `SELECT pedido_id, producto_id, nombre_producto, cantidad, precio_unitario, variante_id, variante_texto, kit_id, extras
         FROM pedido_online_items WHERE pedido_id = ANY($1::uuid[]) ORDER BY id`, [pedidos.map(p => p.id)]);
      const porPedido = {};
      it.rows.forEach(i => { (porPedido[i.pedido_id] = porPedido[i.pedido_id] || []).push(i); });
      pedidos.forEach(p => {
        p.items = porPedido[p.id] || [];
        p.total = Number(p.subtotal) + Number(p.costo_envio);
      });
    }
    res.json({ ok: true, pedidos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, clienteDeRequest, ensureCuentaTables };
