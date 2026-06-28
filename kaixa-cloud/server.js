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
app.use(express.static(path.join(__dirname, 'public')));

// ── Crear las tablas automáticamente al arrancar ──────────────────────────
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
app.get('/', (req, res) => {
  res.json({ ok: true, servicio: 'Kaixa Cloud', hora: new Date().toISOString() });
});

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

// ── Rutas de administración (sin token de caja) ───────────────────────────
app.use('/api/admin', require('./routes/negocios'));

// Info de la caja
app.get('/api/caja-info', authCaja, (req, res) => {
  res.json(req.caja);
});

// ── Rutas con autenticación de caja ──────────────────────────────────────
app.use('/api/sync',      authCaja, require('./routes/sync'));
app.use('/api/dashboard', authCaja, require('./routes/dashboard'));  // ← NUEVO
app.use('/api',           authCaja, require('./routes/api'));

// ── Socket.io — tiempo real ───────────────────────────────────────────────
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

const PORT = process.env.PORT || 4500;

aplicarEsquema().then(() => {
  server.listen(PORT, () => {
    console.log('🚀 Kaixa Cloud corriendo en puerto', PORT);
  });
});
