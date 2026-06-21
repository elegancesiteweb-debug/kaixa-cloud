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

// ── Crear las tablas automáticamente al arrancar (seguro repetirlo,
//     usa CREATE TABLE IF NOT EXISTS — no borra nada si ya existen) ──
async function aplicarEsquema() {
  // La extensión va aparte: si por permisos no se puede crear, no debe
  // tumbar el resto del esquema (las demás tablas no la necesitan).
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } catch (e) {
    console.error('⚠️  No se pudo crear la extensión pgcrypto (puede que ya exista o falten permisos):', e.message);
  }
  try {
    const sqlCompleto = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    // Quitar la línea de CREATE EXTENSION del archivo, ya se intentó arriba por separado
    const sql = sqlCompleto.replace(/CREATE EXTENSION[^;]*;/i, '');
    await pool.query(sql);
    console.log('✅ Esquema de base de datos verificado/aplicado correctamente');
  } catch (e) {
    console.error('⚠️  No se pudo aplicar el esquema automáticamente:', e.message);
    console.error('   El servidor sigue arrancando, pero revisa la conexión a la base de datos.');
  }
}

// ── Salud del servicio (Railway lo usa para verificar que sigue vivo) ──
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
      ok: true,
      db: 'conectada',
      tablas: tablas.rows.map(r => r.table_name),
      total_tablas: tablas.rows.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Rutas de administración (las usa el vendedor, sin token de caja) ──
app.use('/api/admin', require('./routes/negocios'));

// ── Rutas que SÍ requieren autenticación de caja ────────────────
app.use('/api/sync', authCaja, require('./routes/sync'));
app.use('/api', authCaja, require('./routes/api'));

// ── Socket.io — tiempo real entre cajas del mismo negocio ───────
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
