// routes/citas.js — Citas para servicios: el cliente agenda desde la tienda en
// línea y el negocio las confirma o rechaza desde la app / la PC.
const express = require('express');
const pool    = require('../db/pool');
const publicRouter = express.Router();
const authRouter   = express.Router();

const ZONA = 'America/Mexico_City';
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ESTADOS_ACTIVOS = ['pendiente', 'confirmada'];

const HORARIO_DEFAULT = () => {
  const h = {};
  for (let d = 0; d <= 6; d++) h[d] = { abierto: d >= 1 && d <= 6, desde: '09:00', hasta: d === 6 ? '14:00' : '18:00' };
  return h;
};
const CONFIG_DEFAULT = () => ({ duracion_min: 60, simultaneas: 1, anticipacion_horas: 2, dias_adelante: 14, horario: HORARIO_DEFAULT() });

let _ok = false;
async function ensureCitasTables() {
  if (_ok) return;
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS citas_activo BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS citas_config TEXT DEFAULT ''`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS citas (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id       UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
      producto_id       UUID,
      servicio_nombre   TEXT DEFAULT '',
      servicio_precio   NUMERIC(12,2) DEFAULT 0,
      folio             TEXT NOT NULL,
      cliente_nombre    TEXT NOT NULL,
      cliente_telefono  TEXT DEFAULT '',
      tienda_cliente_id UUID,
      fecha             DATE NOT NULL,
      hora              TEXT NOT NULL,
      duracion_min      INTEGER DEFAULT 60,
      estado            TEXT DEFAULT 'pendiente',
      notas             TEXT DEFAULT '',
      motivo            TEXT DEFAULT '',
      creado_en         TIMESTAMPTZ DEFAULT now(),
      actualizado_en    TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_citas_sucursal_fecha ON citas(sucursal_id, fecha);
    CREATE INDEX IF NOT EXISTS idx_citas_cliente ON citas(tienda_cliente_id);
  `);
  _ok = true;
}

// ── Utilidades de fecha/hora (hora de México) ──
function ahoraMx() {
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());
  const hh = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(new Date()), 10);
  const mm = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, minute: '2-digit' }).format(new Date()), 10);
  return { fecha, minutos: (hh % 24) * 60 + mm };
}
function sumarDias(fecha, n) {
  const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaSemana = fecha => new Date(fecha + 'T12:00:00Z').getUTCDay();
const aMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const aHHMM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const hhmmValido = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const fechaValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00Z'));
const normalizarTel = t => String(t || '').replace(/\D/g, '').slice(-10);

async function cargarConfig(negocioId) {
  await ensureCitasTables();
  const r = await pool.query('SELECT COALESCE(citas_activo,false) AS activo, COALESCE(citas_config,\'\') AS cfg FROM negocios WHERE id=$1', [negocioId]);
  if (!r.rows.length) return null;
  let guardada = {};
  try { guardada = r.rows[0].cfg ? JSON.parse(r.rows[0].cfg) : {}; } catch (e) {}
  const base = CONFIG_DEFAULT();
  const cfg = Object.assign(base, guardada, { horario: Object.assign(base.horario, guardada.horario || {}) });
  cfg.activo = !!r.rows[0].activo;
  return cfg;
}

// Horas libres de un día, dadas las citas activas de ese día.
function horasLibres(cfg, fecha, existentes, ahora) {
  const dia = cfg.horario[diaSemana(fecha)];
  if (!dia || !dia.abierto || !hhmmValido(dia.desde) || !hhmmValido(dia.hasta)) return [];
  const dur = cfg.duracion_min;
  const desde = aMin(dia.desde), hasta = aMin(dia.hasta);
  const horas = [];
  for (let s = desde; s + dur <= hasta; s += dur) {
    if (fecha === ahora.fecha && s < ahora.minutos + cfg.anticipacion_horas * 60) continue;
    const ocupadas = existentes.filter(c => {
      const cs = aMin(c.hora), ce = cs + (c.duracion_min || dur);
      return cs < s + dur && ce > s;
    }).length;
    if (ocupadas >= cfg.simultaneas) continue;
    horas.push(aHHMM(s));
  }
  return horas;
}

async function citasActivasRango(db, sucursalId, desde, hasta) {
  const r = await db.query(
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, hora, duracion_min FROM citas
     WHERE sucursal_id=$1 AND fecha BETWEEN $2 AND $3 AND estado = ANY($4)`,
    [sucursalId, desde, hasta, ESTADOS_ACTIVOS]);
  return r.rows;
}

const _ipCitas = new Map();
function frenoIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const ahora = Date.now();
  const l = (_ipCitas.get(ip) || []).filter(t => ahora - t < 10 * 60 * 1000);
  l.push(ahora); _ipCitas.set(ip, l);
  if (_ipCitas.size > 5000) _ipCitas.clear();
  return l.length > 20;
}

async function negocioDeSlug(slug) {
  await ensureCitasTables();
  const r = await pool.query('SELECT id, nombre FROM negocios WHERE slug=$1 AND activo=true', [slug]);
  return r.rows[0] || null;
}

async function avisarDueno(negocioId, sucursalId, titulo, cuerpo, citaId) {
  try {
    const { enviarASucursal, crearNotificacion } = require('./push');
    await enviarASucursal(sucursalId, negocioId, { title: titulo, body: cuerpo, tag: 'cita' });
    await crearNotificacion(negocioId, sucursalId, 'cita_nueva', titulo, cuerpo, citaId);
  } catch (e) {}
}

// ════════════ PÚBLICO (tienda en línea) ════════════

// GET /api/tienda/:slug/citas/disponibilidad?sucursal_id=X
publicRouter.get('/tienda/:slug/citas/disponibilidad', async (req, res) => {
  try {
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cfg = await cargarConfig(neg.id);
    if (!cfg.activo) return res.json({ activo: false, dias: [] });
    const suc = await pool.query('SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2 AND activo=true', [req.query.sucursal_id, neg.id]).catch(() => ({ rows: [] }));
    if (!suc.rows.length) return res.status(400).json({ error: 'Elige una sucursal válida' });
    const ahora = ahoraMx();
    const ultimo = sumarDias(ahora.fecha, cfg.dias_adelante);
    const existentes = await citasActivasRango(pool, suc.rows[0].id, ahora.fecha, ultimo);
    const dias = [];
    for (let i = 0; i <= cfg.dias_adelante; i++) {
      const fecha = sumarDias(ahora.fecha, i);
      const horas = horasLibres(cfg, fecha, existentes.filter(c => c.fecha === fecha), ahora);
      if (horas.length) dias.push({ fecha, dia_nombre: DIAS[diaSemana(fecha)], horas });
    }
    res.json({ activo: true, duracion_min: cfg.duracion_min, dias });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tienda/:slug/citas
publicRouter.post('/tienda/:slug/citas', async (req, res) => {
  const client = await pool.connect();
  let enTransaccion = false;
  try {
    if (frenoIp(req)) return res.status(429).json({ error: 'Demasiados intentos, espera unos minutos.' });
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cfg = await cargarConfig(neg.id);
    if (!cfg.activo) return res.status(400).json({ error: 'Este negocio no está recibiendo citas en línea' });

    const { sucursal_id, producto_id, fecha, hora, cliente_nombre, cliente_telefono, notas = '' } = req.body || {};
    const nombre = String(cliente_nombre || '').trim().slice(0, 120);
    const tel = normalizarTel(cliente_telefono);
    if (!nombre) return res.status(400).json({ error: 'Escribe tu nombre' });
    if (tel.length !== 10) return res.status(400).json({ error: 'Escribe un teléfono de 10 dígitos para confirmarte la cita' });
    if (!fechaValida(fecha) || !hhmmValido(hora)) return res.status(400).json({ error: 'Elige día y hora' });

    const suc = await pool.query('SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2 AND activo=true', [sucursal_id, neg.id]).catch(() => ({ rows: [] }));
    if (!suc.rows.length) return res.status(400).json({ error: 'Sucursal no válida' });
    const serv = await pool.query(
      `SELECT id, nombre, precio FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true AND COALESCE(es_servicio,false)=true`,
      [producto_id, neg.id, sucursal_id]).catch(() => ({ rows: [] }));
    if (!serv.rows.length) return res.status(400).json({ error: 'Ese servicio no está disponible' });

    // Tope por teléfono: evita reservar todos los horarios "de mentiras".
    const pend = await pool.query(
      `SELECT COUNT(*)::int AS n FROM citas WHERE negocio_id=$1 AND cliente_telefono=$2 AND estado = ANY($3) AND fecha >= $4`,
      [neg.id, tel, ESTADOS_ACTIVOS, ahoraMx().fecha]);
    if (pend.rows[0].n >= 3) return res.status(429).json({ error: 'Ya tienes 3 citas pendientes con este negocio. Espera a que pasen o cancela alguna.' });

    // La cuenta del cliente (si inició sesión) se resuelve ANTES de abrir la transacción.
    let clienteCuenta = null;
    if (req.headers['authorization']) {
      try { clienteCuenta = await require('./tienda-cuenta').clienteDeRequest(req, neg.id); } catch (e) {}
    }

    await client.query('BEGIN'); enTransaccion = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sucursal_id + ':' + fecha]);
    const ahora = ahoraMx();
    const existentes = await citasActivasRango(client, sucursal_id, fecha, fecha);
    if (!horasLibres(cfg, fecha, existentes, ahora).includes(hora)) {
      await client.query('ROLLBACK'); enTransaccion = false;
      return res.status(409).json({ error: 'Ese horario ya no está disponible, elige otro.' });
    }
    const folio = 'C-' + Date.now().toString(36).toUpperCase().slice(-6);
    const ins = await client.query(
      `INSERT INTO citas (negocio_id, sucursal_id, producto_id, servicio_nombre, servicio_precio, folio, cliente_nombre,
         cliente_telefono, tienda_cliente_id, fecha, hora, duracion_min, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [neg.id, sucursal_id, serv.rows[0].id, serv.rows[0].nombre, serv.rows[0].precio, folio, nombre, tel,
       clienteCuenta ? clienteCuenta.id : null, fecha, hora, cfg.duracion_min, String(notas).slice(0, 300)]);
    await client.query('COMMIT'); enTransaccion = false;

    avisarDueno(neg.id, sucursal_id, '📅 Nueva cita', nombre + ' — ' + serv.rows[0].nombre + ' el ' + fecha + ' a las ' + hora, ins.rows[0].id);
    const io = req.app.get('io');
    if (io) io.to('negocio:' + neg.id).emit('cita:nueva', { id: ins.rows[0].id, folio, sucursal_id });
    res.json({ ok: true, folio, id: ins.rows[0].id, fecha, hora, servicio: serv.rows[0].nombre });
  } catch (e) {
    if (enTransaccion) { try { await client.query('ROLLBACK'); } catch (er) {} }
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /api/tienda/:slug/cuenta/citas — citas de la cuenta del cliente
publicRouter.get('/tienda/:slug/cuenta/citas', async (req, res) => {
  try {
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cli = await require('./tienda-cuenta').clienteDeRequest(req, neg.id);
    if (!cli) return res.status(401).json({ error: 'Sesión vencida' });
    const r = await pool.query(
      `SELECT id, folio, servicio_nombre, to_char(fecha,'YYYY-MM-DD') AS fecha, hora, estado, motivo
       FROM citas WHERE tienda_cliente_id=$1 AND negocio_id=$2 ORDER BY fecha DESC, hora DESC LIMIT 30`, [cli.id, neg.id]);
    res.json({ ok: true, citas: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/tienda/:slug/cuenta/citas/:id/cancelar
publicRouter.put('/tienda/:slug/cuenta/citas/:id/cancelar', async (req, res) => {
  try {
    const neg = await negocioDeSlug(req.params.slug);
    if (!neg) return res.status(404).json({ error: 'Tienda no encontrada' });
    const cli = await require('./tienda-cuenta').clienteDeRequest(req, neg.id);
    if (!cli) return res.status(401).json({ error: 'Sesión vencida' });
    const r = await pool.query(
      `UPDATE citas SET estado='cancelada', motivo='Cancelada por el cliente', actualizado_en=now()
       WHERE id=$1 AND tienda_cliente_id=$2 AND negocio_id=$3 AND estado = ANY($4)
       RETURNING id, sucursal_id, cliente_nombre, servicio_nombre, to_char(fecha,'YYYY-MM-DD') AS fecha, hora`,
      [req.params.id, cli.id, neg.id, ESTADOS_ACTIVOS]);
    if (!r.rows.length) return res.status(404).json({ error: 'No se encontró una cita activa para cancelar' });
    const c = r.rows[0];
    avisarDueno(neg.id, c.sucursal_id, '❌ Cita cancelada', c.cliente_nombre + ' canceló ' + c.servicio_nombre + ' del ' + c.fecha + ' a las ' + c.hora, c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════ DEL NEGOCIO (app / PC — requiere token de caja) ════════════

// GET /api/citas?todas=1 — citas de la sucursal de la caja (próximas y pendientes por defecto)
authRouter.get('/citas', async (req, res) => {
  try {
    await ensureCitasTables();
    const { negocio_id, sucursal_id } = req.caja;
    const hoy = ahoraMx().fecha;
    const filtroFecha = req.query.todas ? '' : 'AND (fecha >= $3 OR estado = \'pendiente\')';
    const params = [negocio_id, sucursal_id]; if (!req.query.todas) params.push(sumarDias(hoy, -1));
    const r = await pool.query(
      `SELECT id, folio, producto_id, servicio_nombre, servicio_precio, cliente_nombre, cliente_telefono,
              to_char(fecha,'YYYY-MM-DD') AS fecha, hora, duracion_min, estado, notas, motivo, creado_en
       FROM citas WHERE negocio_id=$1 AND sucursal_id=$2 ${filtroFecha}
       ORDER BY fecha ASC, hora ASC LIMIT 300`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const TRANSICIONES = {
  confirmada: ['pendiente'],
  rechazada:  ['pendiente'],
  cancelada:  ['pendiente', 'confirmada'],
  completada: ['confirmada'],
  no_asistio: ['confirmada']
};
const MENSAJES = {
  confirmada: (c, neg) => `Hola ${c.cliente_nombre}, tu cita de ${c.servicio_nombre} en ${neg} quedó CONFIRMADA para el ${c.fecha} a las ${c.hora}. ¡Te esperamos!`,
  rechazada:  (c, neg, m) => `Hola ${c.cliente_nombre}, no pudimos confirmar tu cita de ${c.servicio_nombre} del ${c.fecha} a las ${c.hora} en ${neg}.${m ? ' Motivo: ' + m + '.' : ''} Puedes agendar otro horario.`,
  cancelada:  (c, neg, m) => `Hola ${c.cliente_nombre}, tu cita de ${c.servicio_nombre} del ${c.fecha} a las ${c.hora} en ${neg} fue cancelada.${m ? ' Motivo: ' + m + '.' : ''}`
};

// PUT /api/citas/:id/estado {estado, motivo}
authRouter.put('/citas/:id/estado', async (req, res) => {
  try {
    await ensureCitasTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { estado, motivo = '' } = req.body || {};
    if (!TRANSICIONES[estado]) return res.status(400).json({ error: 'Estado no válido' });
    const r = await pool.query(
      `UPDATE citas SET estado=$1, motivo=$2, actualizado_en=now()
       WHERE id=$3 AND negocio_id=$4 AND sucursal_id=$5 AND estado = ANY($6)
       RETURNING id, cliente_nombre, cliente_telefono, servicio_nombre, to_char(fecha,'YYYY-MM-DD') AS fecha, hora`,
      [estado, String(motivo).slice(0, 200), req.params.id, negocio_id, sucursal_id, TRANSICIONES[estado]]);
    if (!r.rows.length) return res.status(404).json({ error: 'La cita no existe o ya no se puede cambiar a ese estado' });
    const c = r.rows[0];
    let whatsapp = 'no_aplica';
    if (MENSAJES[estado] && c.cliente_telefono) {
      try {
        const nn = await pool.query('SELECT nombre FROM negocios WHERE id=$1', [negocio_id]);
        const { enviarWhatsapp } = require('./whatsapp');
        const w = await enviarWhatsapp(negocio_id, c.cliente_telefono, MENSAJES[estado](c, nn.rows[0].nombre, motivo));
        whatsapp = w.ok ? 'enviado' : 'no_enviado';
      } catch (e) { whatsapp = 'no_enviado'; }
    }
    res.json({ ok: true, whatsapp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/citas-config
authRouter.get('/citas-config', async (req, res) => {
  try {
    const cfg = await cargarConfig(req.caja.negocio_id);
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/citas-config
authRouter.put('/citas-config', async (req, res) => {
  try {
    await ensureCitasTables();
    const b = req.body || {};
    const actual = await cargarConfig(req.caja.negocio_id);
    const num = (v, min, max, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(max, Math.max(min, n)); };
    const nuevo = {
      duracion_min: num(b.duracion_min, 15, 480, actual.duracion_min),
      simultaneas: num(b.simultaneas, 1, 50, actual.simultaneas),
      anticipacion_horas: num(b.anticipacion_horas, 0, 72, actual.anticipacion_horas),
      dias_adelante: num(b.dias_adelante, 1, 60, actual.dias_adelante),
      horario: actual.horario
    };
    if (b.horario && typeof b.horario === 'object') {
      for (let d = 0; d <= 6; d++) {
        const x = b.horario[d];
        if (!x) continue;
        const desde = hhmmValido(x.desde) ? x.desde : nuevo.horario[d].desde;
        const hasta = hhmmValido(x.hasta) ? x.hasta : nuevo.horario[d].hasta;
        if (x.abierto && aMin(desde) >= aMin(hasta)) return res.status(400).json({ error: DIAS[d] + ': la hora de cierre debe ser después de la de apertura' });
        nuevo.horario[d] = { abierto: !!x.abierto, desde, hasta };
      }
    }
    const activo = b.activo === undefined ? actual.activo : !!b.activo;
    await pool.query('UPDATE negocios SET citas_activo=$1, citas_config=$2 WHERE id=$3', [activo, JSON.stringify(nuevo), req.caja.negocio_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { publicRouter, authRouter, ensureCitasTables };
