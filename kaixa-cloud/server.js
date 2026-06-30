// server.js — Kaixa Cloud v2.0 + Sistema de Licencias integrado
require('dotenv').config();
const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { Server } = require('socket.io');
const pool     = require('./db/pool');
const { authCaja } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.set('io', io);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
// ESQUEMA — crear tablas si no existen
// ═══════════════════════════════════════════════════════════════
async function aplicarEsquema() {
  try { await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'); } catch(e) {}
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')
                  .replace(/CREATE EXTENSION[^;]*;/i, '');
    await pool.query(sql);
    console.log('✅ Esquema principal verificado');
  } catch(e) { console.error('⚠️ Esquema:', e.message); }

  // Tabla de licencias en PostgreSQL
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licencias (
        id                SERIAL PRIMARY KEY,
        clave             TEXT UNIQUE NOT NULL,
        cliente_nombre    TEXT DEFAULT '',
        cliente_email     TEXT DEFAULT '',
        cliente_tel       TEXT DEFAULT '',
        negocio_nombre    TEXT DEFAULT '',
        giro              TEXT DEFAULT 'tienda',
        plan              TEXT DEFAULT 'pro',
        modulos           TEXT DEFAULT '[]',
        estado            TEXT DEFAULT 'activa',
        max_usuarios      INTEGER DEFAULT 3,
        notas             TEXT DEFAULT '',
        vence_en          DATE DEFAULT (CURRENT_DATE + INTERVAL '1 year'),
        creado_en         TIMESTAMPTZ DEFAULT NOW(),
        ultima_verificacion TIMESTAMPTZ,
        negocio_id        TEXT
      )
    `);
    try { await pool.query('ALTER TABLE licencias ADD COLUMN IF NOT EXISTS negocio_id TEXT'); } catch(e) {}
    console.log('✅ Tabla licencias lista');
  } catch(e) { console.error('⚠️ licencias:', e.message); }

  // Tabla de admins del panel de licencias
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins_licencias (
        id       SERIAL PRIMARY KEY,
        usuario  TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nombre   TEXT DEFAULT 'Administrador'
      )
    `);
    await pool.query(`
      INSERT INTO admins_licencias (usuario, password, nombre)
      VALUES ('kaixa_admin','Kaixa2026$','Administrador Kaixa')
      ON CONFLICT (usuario) DO NOTHING
    `);
    console.log('✅ Tabla admins_licencias lista');
  } catch(e) { console.error('⚠️ admins_licencias:', e.message); }

  // Tabla empleados para PWA
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS empleados (
        id              SERIAL PRIMARY KEY,
        negocio_id      INTEGER NOT NULL,
        nombre          TEXT NOT NULL,
        rol             TEXT DEFAULT 'cajero',
        usuario         TEXT,
        password        TEXT,
        activo          BOOLEAN DEFAULT true,
        ultima_entrada  TIMESTAMPTZ,
        ultima_salida   TIMESTAMPTZ,
        creado_en       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Tabla empleados lista');
  } catch(e) { console.error('⚠️ empleados:', e.message); }

  // Negocios (si no existe ya por schema.sql)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS negocios (
        id          SERIAL PRIMARY KEY,
        nombre      TEXT NOT NULL,
        creado_en   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Si la tabla ya existía sin estas columnas, agregarlas
    await pool.query("ALTER TABLE negocios ADD COLUMN IF NOT EXISTS giro TEXT DEFAULT 'tienda'");
  } catch(e) { console.error('⚠️ negocios:', e.message); }

  // Cajas (si no existe ya por schema.sql)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cajas (
        id          SERIAL PRIMARY KEY,
        negocio_id  INTEGER NOT NULL,
        nombre      TEXT DEFAULT 'Caja principal',
        token       TEXT UNIQUE,
        tipo        TEXT DEFAULT 'madre',
        activo      BOOLEAN DEFAULT true,
        creado_en   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE cajas ADD COLUMN IF NOT EXISTS nombre TEXT DEFAULT 'Caja principal'");
    await pool.query("ALTER TABLE cajas ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'madre'");
    await pool.query("ALTER TABLE cajas ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true");
  } catch(e) { console.error('⚠️ cajas:', e.message); }

  // Sucursales (si no existe ya por schema.sql)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sucursales (
        id          SERIAL PRIMARY KEY,
        negocio_id  INTEGER NOT NULL,
        nombre      TEXT NOT NULL,
        creado_en   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE sucursales ADD COLUMN IF NOT EXISTS giro TEXT DEFAULT 'tienda'");
    await pool.query("ALTER TABLE sucursales ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true");
  } catch(e) { console.error('⚠️ sucursales:', e.message); }
}

// ═══════════════════════════════════════════════════════════════
// GIROS Y PLANES
// ═══════════════════════════════════════════════════════════════
const GIROS = {
  tienda:      { nombre:'Tienda / Abarrotes',      ico:'🛒', modulos:['pos','inventario','lotes','granel','bascula','monedero','servicios','proveedores','pedidos','ventas','reportes','corte','cfdi'] },
  ropa:        { nombre:'Ropa y Moda',             ico:'👗', modulos:['pos','inventario','variantes','colecciones','monedero','proveedores','ventas','reportes','corte','cfdi'] },
  joyeria:     { nombre:'Joyería',                 ico:'💍', modulos:['pos','inventario','apartados','reparaciones','serie','monedero','proveedores','ventas','reportes','corte','cfdi'] },
  celulares:   { nombre:'Celulares y Tecnología',  ico:'📱', modulos:['pos','inventario','imei','reparaciones','garantias','monedero','proveedores','ventas','reportes','corte','cfdi'] },
  restaurante: { nombre:'Restaurante / Taquería',  ico:'🍕', modulos:['pos','mesas','comandas','cocina','inventario','monedero','ventas','reportes','corte'] },
  salon:       { nombre:'Salón / Spa / Barbería',  ico:'💈', modulos:['pos','citas','servicios_salon','comisiones','monedero','ventas','reportes','corte'] },
  papeleria:   { nombre:'Papelería / Escolar',     ico:'📚', modulos:['pos','inventario','listas_escolares','kits','monedero','servicios','ventas','reportes','corte'] },
  farmacia:    { nombre:'Farmacia / Salud',        ico:'🏥', modulos:['pos','inventario','lotes','recetas','monedero','servicios','ventas','reportes','corte','cfdi'] },
  ferreteria:  { nombre:'Ferretería / Materiales', ico:'🏗️', modulos:['pos','inventario','granel','bascula','cotizaciones','credito','proveedores','ventas','reportes','corte','cfdi'] },
};

// ═══════════════════════════════════════════════════════════════
// SESIONES DEL PANEL DE LICENCIAS
// ═══════════════════════════════════════════════════════════════
const sesiones = new Map();
function crearTokenAdmin(u) {
  const t = crypto.randomBytes(32).toString('hex');
  sesiones.set(t, { usuario: u, expira: Date.now() + 8 * 3600 * 1000 });
  return t;
}
function authAdmin(req, res, next) {
  const t = (req.headers['x-token'] || '').trim();
  const s = sesiones.get(t);
  if (!s || s.expira < Date.now()) return res.status(401).json({ error: 'No autenticado' });
  next();
}

// ═══════════════════════════════════════════════════════════════
// HEALTH & VERSION (sin auth)
// ═══════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    res.json({ ok: true, db: 'conectada', tablas: t.rows.map(r => r.table_name) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/version', (req, res) => {
  res.json({ version: '2.0.0', nombre: 'Kaixa Pro', fecha: '2026-06-29',
    notas: 'Version estable — multi-sucursal, mayoreo, monedero, PWA movil', critica: false });
});

// ── Archivos de actualización ─────────────────────────────────────────────
const updatesDir = path.join(__dirname, 'updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
app.get('/files/*', (req, res) => {
  const archivo = req.params[0];
  if (archivo.includes('..')) return res.status(400).json({ error: 'Ruta inválida' });
  const fp = path.join(updatesDir, archivo);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No encontrado' });
  res.sendFile(fp);
});

// ═══════════════════════════════════════════════════════════════
// PANEL DE LICENCIAS — /api/lic/*  (sin token de caja)
// ═══════════════════════════════════════════════════════════════
// Login del panel
app.post('/api/lic/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    const r = await pool.query(
      'SELECT * FROM admins_licencias WHERE usuario=$1 AND password=$2',
      [usuario.trim(), password.trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = crearTokenAdmin(usuario);
    res.json({ ok: true, token, nombre: r.rows[0].nombre });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stats del panel
app.get('/api/lic/stats', authAdmin, async (req, res) => {
  try {
    const total    = await pool.query("SELECT COUNT(*) AS n FROM licencias");
    const activas  = await pool.query("SELECT COUNT(*) AS n FROM licencias WHERE estado='activa'");
    const hoy      = await pool.query("SELECT COUNT(*) AS n FROM licencias WHERE DATE(creado_en)=CURRENT_DATE");
    const porGiro  = await pool.query("SELECT giro, COUNT(*) AS n FROM licencias GROUP BY giro ORDER BY n DESC");
    res.json({
      total:        parseInt(total.rows[0].n),
      activas:      parseInt(activas.rows[0].n),
      suspendidas:  parseInt(total.rows[0].n) - parseInt(activas.rows[0].n),
      nuevas_hoy:   parseInt(hoy.rows[0].n),
      por_giro:     porGiro.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lista de licencias
app.get('/api/lic/licencias', authAdmin, async (req, res) => {
  try {
    const { q='', giro='', estado='' } = req.query;
    let sql = 'SELECT * FROM licencias WHERE 1=1';
    const params = [];
    if (q) { sql += ` AND (cliente_nombre ILIKE $${params.length+1} OR negocio_nombre ILIKE $${params.length+2} OR clave ILIKE $${params.length+3})`; params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
    if (giro)   { sql += ` AND giro=$${params.length+1}`;   params.push(giro); }
    if (estado) { sql += ` AND estado=$${params.length+1}`; params.push(estado); }
    sql += ' ORDER BY id DESC';
    const r = await pool.query(sql, params);
    res.json(r.rows.map(function(row) {
      var mods = [];
      try { mods = JSON.parse(row.modulos || '[]'); } catch(e) {}
      return Object.assign({}, row, { modulos: mods });
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear licencia
app.post('/api/lic/licencias', authAdmin, async (req, res) => {
  try {
    const { cliente_nombre, cliente_email='', cliente_tel='', negocio_nombre='',
            giro='tienda', plan='pro', vence_meses=12, estado='activa', notas='' } = req.body;
    if (!cliente_nombre) return res.status(400).json({ error: 'Nombre requerido' });
    // Generar clave única
    const clave = 'KXP-' + crypto.randomBytes(3).toString('hex').toUpperCase() +
                  '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const modulos = JSON.stringify(GIROS[giro]?.modulos || []);
    const vence = new Date();
    vence.setMonth(vence.getMonth() + parseInt(vence_meses));

    const r = await pool.query(`
      INSERT INTO licencias
        (clave,cliente_nombre,cliente_email,cliente_tel,negocio_nombre,giro,plan,modulos,estado,notas,vence_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [clave, cliente_nombre, cliente_email, cliente_tel, negocio_nombre,
       giro, plan, modulos, estado, notas, vence.toISOString().substring(0,10)]
    );
    res.json({ ok: true, clave, licencia: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Editar licencia
app.put('/api/lic/licencias/:id', authAdmin, async (req, res) => {
  try {
    const { cliente_nombre, cliente_email, cliente_tel, negocio_nombre,
            giro, plan, vence_meses, estado, notas } = req.body;
    const vence = new Date();
    vence.setMonth(vence.getMonth() + parseInt(vence_meses || 12));
    await pool.query(`
      UPDATE licencias SET
        cliente_nombre=$1, cliente_email=$2, cliente_tel=$3, negocio_nombre=$4,
        giro=$5, plan=$6, estado=$7, notas=$8, vence_en=$9
      WHERE id=$10`,
      [cliente_nombre, cliente_email||'', cliente_tel||'', negocio_nombre||'',
       giro||'tienda', plan||'pro', estado||'activa', notas||'',
       vence.toISOString().substring(0,10), req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cambiar estado
app.put('/api/lic/licencias/:id/estado', authAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE licencias SET estado=$1 WHERE id=$2', [req.body.estado, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Eliminar licencia
app.delete('/api/lic/licencias/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM licencias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// VERIFICAR LICENCIA — SIN AUTH — cualquier PC puede verificar
// ═══════════════════════════════════════════════════════════════
async function verificarLicenciaHandler(req, res) {
  try {
    const clave = (req.body.clave || '').trim().toUpperCase();
    if (!clave) return res.status(400).json({ ok: false, mensaje: 'Clave requerida' });
    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];
    if (lic.estado === 'suspendida') return res.json({ ok: false, mensaje: 'Licencia suspendida. Contacta a tu proveedor.' });
    if (lic.estado === 'cancelada')  return res.json({ ok: false, mensaje: 'Licencia cancelada.' });
    // Calcular días restantes
    let diasRestantes = null;
    if (lic.vence_en) {
      const ms = new Date(lic.vence_en).getTime() - Date.now();
      diasRestantes = Math.ceil(ms / (1000 * 60 * 60 * 24));
      if (diasRestantes < 0) return res.json({ ok: false, mensaje: 'Licencia vencida. Renueva tu suscripción.' });
    }
    // Módulos
    let modulos = [];
    try { modulos = JSON.parse(lic.modulos || '[]'); } catch(e) {}
    if (!modulos.length && GIROS[lic.giro]) modulos = GIROS[lic.giro].modulos;
    // Actualizar última verificación
    await pool.query('UPDATE licencias SET ultima_verificacion=NOW() WHERE clave=$1', [clave]);
    res.json({
      ok: true,
      mensaje: 'Licencia activa',
      licencia: {
        clave:          lic.clave,
        cliente:        lic.cliente_nombre,
        nombre_negocio: lic.negocio_nombre,
        negocio:        lic.negocio_nombre,
        dias_restantes: diasRestantes,
        giro:           lic.giro || 'tienda',
        plan:           lic.plan || 'pro',
        modulos:        modulos,
        max_usuarios:   lic.max_usuarios,
        vence_en:       lic.vence_en,
        estado:         lic.estado
      }
    });
  } catch(e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
// Registrar GET y POST para que funcione desde navegador y desde Kaixa Pro
app.get('/api/verificar',  verificarLicenciaHandler);
app.post('/api/verificar', verificarLicenciaHandler);

// ═══════════════════════════════════════════════════════════════
// CANJEAR LICENCIA — la app móvil usa solo la clave (sin token manual)
// Crea/reutiliza un negocio + caja propios para esta licencia y
// devuelve un token de caja transparente para el usuario.
// ═══════════════════════════════════════════════════════════════
app.post('/api/lic/canjear', async (req, res) => {
  try {
    const clave = (req.body.clave || '').trim().toUpperCase();
    if (!clave) return res.status(400).json({ ok: false, mensaje: 'Clave requerida' });

    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];

    if (lic.estado === 'suspendida') return res.json({ ok: false, mensaje: 'Licencia suspendida' });
    if (lic.estado === 'cancelada')  return res.json({ ok: false, mensaje: 'Licencia cancelada' });
    if (lic.vence_en && new Date(lic.vence_en).getTime() < Date.now())
      return res.json({ ok: false, mensaje: 'Licencia vencida' });

    let negocioId = lic.negocio_id;

    // Si esta licencia aún no tiene negocio asociado, crearlo
    if (!negocioId) {
      const neg = await pool.query(
        'INSERT INTO negocios (nombre, giro) VALUES ($1,$2) RETURNING id',
        [lic.negocio_nombre || lic.cliente_nombre || 'Mi negocio', lic.giro || 'tienda']
      );
      negocioId = neg.rows[0].id;
      await pool.query('UPDATE licencias SET negocio_id=$1 WHERE id=$2', [negocioId, lic.id]);

      // Crear sucursal principal
      await pool.query(
        'INSERT INTO sucursales (negocio_id, nombre, giro) VALUES ($1,$2,$3)',
        [negocioId, lic.negocio_nombre || 'Principal', lic.giro || 'tienda']
      );
    }

    // Buscar o crear caja "App móvil" para este negocio
    let caja = await pool.query(
      "SELECT * FROM cajas WHERE negocio_id=$1 AND nombre='App móvil' LIMIT 1",
      [negocioId]
    );
    let token;
    if (caja.rows.length) {
      token = caja.rows[0].token;
    } else {
      token = 'app_' + crypto.randomBytes(20).toString('hex');
      await pool.query(
        'INSERT INTO cajas (negocio_id, nombre, token, tipo, activo) VALUES ($1,$2,$3,$4,true)',
        [negocioId, 'App móvil', token, 'extra']
      );
    }

    // Lista de sucursales del negocio (para selector si hay varias)
    const sucs = await pool.query(
      'SELECT id, nombre, giro FROM sucursales WHERE negocio_id=$1 AND activo=true ORDER BY nombre',
      [negocioId]
    );

    await pool.query('UPDATE licencias SET ultima_verificacion=NOW() WHERE clave=$1', [clave]);

    res.json({
      ok: true,
      token,
      negocio_id: negocioId,
      negocio_nombre: lic.negocio_nombre || lic.cliente_nombre,
      giro: lic.giro || 'tienda',
      sucursales: sucs.rows
    });
  } catch(e) {
    console.error('canjear error:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// RUTAS DE LA CAJA (con auth de token)
// ═══════════════════════════════════════════════════════════════
app.use('/api/admin',    require('./routes/negocios'));
app.get('/api/caja-info', authCaja, (req, res) => res.json(req.caja));

// Login PWA
app.post('/api/auth/login', authCaja, async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    const r = await pool.query(
      'SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 AND activo=true LIMIT 1',
      [id, req.caja.negocio_id]
    );
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Empleado no encontrado' });
    const e = r.rows[0];
    const ok = password === (e.password || '');
    if (!ok) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    res.json({ ok: true, empleado: { id: e.id, nombre: e.nombre, rol: e.rol } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Empleados (PWA)
app.get('/api/empleados', authCaja, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,nombre,rol,usuario,ultima_entrada,ultima_salida FROM empleados WHERE negocio_id=$1 AND activo=true ORDER BY nombre',
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.get('/api/empleados/:id', authCaja, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 LIMIT 1', [req.params.id, req.caja.negocio_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/empleados', authCaja, async (req, res) => {
  try {
    const { nombre, rol='cajero', usuario, password } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const r = await pool.query(
      'INSERT INTO empleados (negocio_id,nombre,rol,usuario,password,activo) VALUES ($1,$2,$3,$4,$5,true) RETURNING *',
      [req.caja.negocio_id, nombre, rol, usuario||null, password||null]
    );
    res.json({ ok: true, empleado: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/empleados/:id', authCaja, async (req, res) => {
  try {
    const { nombre, rol, usuario, password } = req.body;
    let sql = 'UPDATE empleados SET nombre=$1,rol=$2,usuario=$3';
    const vals = [nombre, rol, usuario||null];
    if (password) { sql += `,password=$${vals.length+1}`; vals.push(password); }
    sql += ` WHERE id=$${vals.length+1} AND negocio_id=$${vals.length+2}`;
    vals.push(req.params.id, req.caja.negocio_id);
    await pool.query(sql, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use('/api/sync',      authCaja, require('./routes/sync'));
app.use('/api/dashboard', authCaja, require('./routes/dashboard'));
app.use('/api',           authCaja, require('./routes/api'));

// SPA fallback
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.json({ ok: true, servicio: 'Kaixa Cloud', version: '2.0.0' });
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Falta token'));
    const r = await pool.query(
      'SELECT c.id AS caja_id, c.negocio_id, c.nombre FROM cajas c WHERE c.token=$1 AND c.activo=true',
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
    console.log('🔑 Panel licencias en /licencias.html');
  });
});
