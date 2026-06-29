// server.js — Kaixa Cloud v2.0
require('dotenv').config();
const express = require('express');
const http    = require('http');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { Server } = require('socket.io');
const pool    = require('./db/pool');
const { authCaja } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.set('io', io);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Crear tablas automáticamente ─────────────────────────────────────────
async function aplicarEsquema() {
  try { await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'); } catch(e) {}
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')
                  .replace(/CREATE EXTENSION[^;]*;/i, '');
    await pool.query(sql);
    console.log('✅ Esquema verificado');
  } catch(e) { console.error('⚠️ Esquema:', e.message); }

  // Tabla empleados (para la app móvil)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS empleados (
        id           SERIAL PRIMARY KEY,
        negocio_id   INTEGER NOT NULL,
        nombre       TEXT NOT NULL,
        rol          TEXT NOT NULL DEFAULT 'cajero',
        usuario      TEXT,
        password     TEXT,
        activo       BOOLEAN DEFAULT true,
        ultima_entrada TIMESTAMPTZ,
        ultima_salida  TIMESTAMPTZ,
        creado_en    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Tabla empleados lista');
  } catch(e) { console.error('⚠️ empleados:', e.message); }
}

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    res.json({ ok:true, db:'conectada', tablas:t.rows.map(r=>r.table_name) });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── Versión (sin auth) ────────────────────────────────────────────────────
app.get('/version', (req, res) => {
  res.json({ version:'2.0.0', nombre:'Kaixa Pro', fecha:'2026-06-29',
    notas:'Version estable — multi-sucursal, mayoreo, monedero, PWA movil', critica:false });
});

// ── Archivos de actualización ─────────────────────────────────────────────
const updatesDir = path.join(__dirname, 'updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
app.get('/files/*', (req, res) => {
  const archivo = req.params[0];
  if (archivo.includes('..')) return res.status(400).json({ error:'Ruta inválida' });
  const fp = path.join(updatesDir, archivo);
  if (!fs.existsSync(fp)) return res.status(404).json({ error:'No encontrado' });
  res.sendFile(fp);
});

// ── Admin (sin token) ─────────────────────────────────────────────────────
app.use('/api/admin', require('./routes/negocios'));

// ── Info de la caja ───────────────────────────────────────────────────────
app.get('/api/caja-info', authCaja, (req, res) => res.json(req.caja));

// ── LOGIN para la PWA ─────────────────────────────────────────────────────
app.post('/api/auth/login', authCaja, async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ ok:false, error:'Faltan datos' });
    const negocio_id = req.caja.negocio_id;
    const r = await pool.query(
      `SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 AND activo=true LIMIT 1`,
      [id, negocio_id]
    );
    if (!r.rows.length) return res.status(401).json({ ok:false, error:'Empleado no encontrado' });
    const e = r.rows[0];
    // Verificar contraseña (texto plano por ahora, compatible con SQLite)
    const ok = password === (e.password || e.password_hash || '');
    if (!ok) return res.status(401).json({ ok:false, error:'Contraseña incorrecta' });
    res.json({ ok:true, empleado:{ id:e.id, nombre:e.nombre, rol:e.rol, usuario:e.usuario } });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── EMPLEADOS (para login de la PWA) ─────────────────────────────────────
app.get('/api/empleados', authCaja, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, rol, usuario, ultima_entrada, ultima_salida
       FROM empleados WHERE negocio_id=$1 AND activo=true ORDER BY nombre`,
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.get('/api/empleados/:id', authCaja, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, rol, usuario, ultima_entrada, ultima_salida
       FROM empleados WHERE id=$1 AND negocio_id=$2 LIMIT 1`,
      [req.params.id, req.caja.negocio_id]
    );
    if (!r.rows.length) return res.status(404).json({ error:'No encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/empleados', authCaja, async (req, res) => {
  try {
    const { nombre, rol='cajero', usuario, password, giro } = req.body;
    if (!nombre) return res.status(400).json({ error:'Nombre requerido' });
    const r = await pool.query(
      `INSERT INTO empleados (negocio_id, nombre, rol, usuario, password, activo)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
      [req.caja.negocio_id, nombre, rol, usuario||null, password||null]
    );
    res.json({ ok:true, empleado:r.rows[0] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/empleados/:id', authCaja, async (req, res) => {
  try {
    const { nombre, rol, usuario, password } = req.body;
    const sets = ['nombre=$2','rol=$3','usuario=$4'];
    const vals = [req.params.id, nombre, rol, usuario||null];
    if (password) { sets.push('password=$5'); vals.push(password); }
    await pool.query(
      `UPDATE empleados SET ${sets.join(',')} WHERE id=$1 AND negocio_id=$${vals.length+1}`,
      [...vals, req.caja.negocio_id]
    );
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Asistencia empleados ──────────────────────────────────────────────────
app.post('/api/empleados/:id/entrada', authCaja, async (req, res) => {
  try {
    await pool.query(`UPDATE empleados SET ultima_entrada=NOW(), ultima_salida=NULL WHERE id=$1 AND negocio_id=$2`,
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/empleados/:id/salida', authCaja, async (req, res) => {
  try {
    await pool.query(`UPDATE empleados SET ultima_salida=NOW() WHERE id=$1 AND negocio_id=$2`,
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Rutas principales ─────────────────────────────────────────────────────
app.use('/api/sync',      authCaja, require('./routes/sync'));
app.use('/api/dashboard', authCaja, require('./routes/dashboard'));
app.use('/api',           authCaja, require('./routes/api'));

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.json({ ok:true, servicio:'Kaixa Cloud', version:'2.0.0' });
});

// ── Socket.io ─────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Falta token'));
    const r = await pool.query(
      `SELECT c.id AS caja_id, c.negocio_id, c.nombre FROM cajas c WHERE c.token=$1 AND c.activo=true`,
      [token]
    );
    if (!r.rows.length) return next(new Error('Token inválido'));
    socket.caja = r.rows[0];
    next();
  } catch(e) { next(e); }
});

io.on('connection', (socket) => {
  const sala = 'negocio:' + socket.caja.negocio_id;
  socket.join(sala);
  console.log('🟢 Caja conectada:', socket.caja.nombre, '→', sala);
  socket.on('disconnect', () => console.log('🔴 Desconectada:', socket.caja.nombre));
});

// ── Arrancar ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4500;
aplicarEsquema().then(() => {
  server.listen(PORT, () => {
    console.log('🚀 Kaixa Cloud v2.0 en puerto', PORT);
    console.log('📱 PWA en /  |  🔧 Admin en /admin.html');
  });
});
