// server.js — Kaixa Cloud: servidor central de sincronización multi-sucursal
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

// ── Archivos estáticos (PWA + admin) ─────────────────────────────────────
// Sirve public/index.html (la app móvil) y public/admin.html
app.use(express.static(path.join(__dirname, 'public')));

// ── Esquema de BD ─────────────────────────────────────────────────────────
async function aplicarEsquema() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } catch (e) {
    console.error('⚠️  pgcrypto:', e.message);
  }
  try {
    const sqlCompleto = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    const sql = sqlCompleto.replace(/CREATE EXTENSION[^;]*;/i, '');
    await pool.query(sql);
    console.log('✅ Esquema verificado/aplicado');
  } catch (e) {
    console.error('⚠️  Esquema:', e.message);
  }
}

// ── Salud ─────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const tablas = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' ORDER BY table_name
    `);
    res.json({
      ok: true, db: 'conectada',
      tablas: tablas.rows.map(r => r.table_name),
      total_tablas: tablas.rows.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Versión (sin auth, para actualizaciones automáticas) ──────────────────
app.get('/version', (req, res) => {
  res.json({
    version: '2.0.0',
    nombre: 'Kaixa Pro',
    fecha: '2026-06-29',
    notas: 'Version estable — multi-sucursal, mayoreo, monedero, lotes, PWA movil',
    critica: false,
    archivos: ['frontend/public/index.html']
  });
});

// ── Archivos de actualización (descarga automática desde Kaixa Pro) ───────
const updatesDir = path.join(__dirname, 'updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
app.get('/files/*', (req, res) => {
  const archivo = req.params[0];
  if (archivo.includes('..')) return res.status(400).json({ error: 'Ruta inválida' });
  const filePath = path.join(updatesDir, archivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.sendFile(filePath);
});

// ── Login para la PWA (sin authCaja, verifica token interno) ─────────────
// La PWA usa el mismo token de caja como Bearer — no necesita login separado
// Este endpoint es opcional si ya existe en routes/api.js
app.post('/api/auth/login', authCaja, async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });

    // Buscar empleado en la BD del negocio de esta caja
    const negocio_id = req.caja.negocio_id;
    const emp = await pool.query(
      `SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 AND activo=true LIMIT 1`,
      [id, negocio_id]
    );
    if (!emp.rows.length) return res.status(401).json({ ok: false, error: 'Empleado no encontrado' });

    const e = emp.rows[0];
    // Verificar contraseña (bcrypt o texto plano según implementación)
    let ok = false;
    try {
      const bcrypt = require('bcrypt');
      ok = await bcrypt.compare(password, e.password_hash || e.password || '');
    } catch(err) {
      // Fallback a texto plano
      ok = password === (e.password || e.password_hash || '');
    }
    if (!ok) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });

    res.json({ ok: true, empleado: { id: e.id, nombre: e.nombre, rol: e.rol, usuario: e.usuario } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Administración (sin token de caja) ────────────────────────────────────
app.use('/api/admin', require('./routes/negocios'));

// ── Info de la caja (para la PWA: nombre del negocio, giro, etc.) ─────────
app.get('/api/caja-info', authCaja, (req, res) => {
  res.json(req.caja);
});

// ── Rutas con autenticación de caja ───────────────────────────────────────
app.use('/api/sync',      authCaja, require('./routes/sync'));
app.use('/api/dashboard', authCaja, require('./routes/dashboard'));
app.use('/api',           authCaja, require('./routes/api'));

// ── SPA fallback: cualquier ruta no encontrada devuelve index.html ─────────
// Esto permite que la PWA maneje sus propias rutas en el navegador
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ ok: true, servicio: 'Kaixa Cloud', version: '2.0.0', hora: new Date().toISOString() });
  }
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
    if (r.rows.length === 0) return next(new Error('Token inválido'));
    socket.caja = r.rows[0];
    next();
  } catch (e) { next(e); }
});

io.on('connection', (socket) => {
  const sala = 'negocio:' + socket.caja.negocio_id;
  socket.join(sala);
  console.log('🟢 Caja conectada:', socket.caja.nombre, '→', sala);
  socket.on('disconnect', () => {
    console.log('🔴 Caja desconectada:', socket.caja.nombre);
  });
});

// ── Arrancar ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4500;
aplicarEsquema().then(() => {
  server.listen(PORT, () => {
    console.log('🚀 Kaixa Cloud v2.0 corriendo en puerto', PORT);
    console.log('📱 PWA disponible en la raíz /');
    console.log('🔧 Admin en /admin.html');
  });
});
