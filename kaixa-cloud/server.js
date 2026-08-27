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
const { router: pushRouter, revisarAlertas, crearTablasPush } = require('./routes/push');
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.set('io', io);
app.use(cors());
// verify: guarda el body crudo en req.rawBody — lo necesitan los webhooks de
// integraciones de reparto (Uber Eats/etc.) para verificar firma HMAC más
// adelante (ver routes/delivery/adapters/*). No cambia nada para el resto de
// rutas, que siguen usando req.body ya parseado como siempre.
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));
async function aplicarEsquema() {
  try { await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'); } catch(e) {}
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')
                  .replace(/CREATE EXTENSION[^;]*;/i, '');
    await pool.query(sql);
    console.log('✅ Esquema principal verificado');
  } catch(e) { console.error('⚠️ Esquema:', e.message); }
  // Corrige FKs hacia productos() sin regla de borrado — bloqueaban borrar un
  // negocio en cuanto tenía ventas/lotes/pedidos reales (RESTRICT por defecto).
  // SET NULL preserva el historial (ya guardan el nombre en texto aparte).
  try {
    await pool.query(`
      ALTER TABLE venta_detalle DROP CONSTRAINT IF EXISTS venta_detalle_producto_id_fkey;
      ALTER TABLE venta_detalle ADD CONSTRAINT venta_detalle_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
      ALTER TABLE lotes DROP CONSTRAINT IF EXISTS lotes_producto_id_fkey;
      ALTER TABLE lotes ADD CONSTRAINT lotes_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
      ALTER TABLE pedido_items DROP CONSTRAINT IF EXISTS pedido_items_producto_id_fkey;
      ALTER TABLE pedido_items ADD CONSTRAINT pedido_items_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
    `);
    console.log('✅ FKs de historial hacia productos corregidas (ON DELETE SET NULL)');
  } catch(e) { console.error('⚠️ Migración FKs productos:', e.message); }
  // Mismo arreglo para tablas que crean sus propias rutas de forma perezosa
  // (pueden no existir todavía en un despliegue nuevo — no es un error si fallan)
  try {
    await pool.query(`
      ALTER TABLE pedido_online_items DROP CONSTRAINT IF EXISTS pedido_online_items_producto_id_fkey;
      ALTER TABLE pedido_online_items ADD CONSTRAINT pedido_online_items_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
    `);
  } catch(e) {}
  try {
    await pool.query(`
      ALTER TABLE cotizacion_items DROP CONSTRAINT IF EXISTS cotizacion_items_producto_id_fkey;
      ALTER TABLE cotizacion_items ADD CONSTRAINT cotizacion_items_producto_id_fkey
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
    `);
  } catch(e) {}
  try {
    await pool.query(`
      ALTER TABLE traspasos DROP CONSTRAINT IF EXISTS traspasos_producto_origen_id_fkey;
      ALTER TABLE traspasos ADD CONSTRAINT traspasos_producto_origen_id_fkey
        FOREIGN KEY (producto_origen_id) REFERENCES productos(id) ON DELETE SET NULL;
      ALTER TABLE traspasos DROP CONSTRAINT IF EXISTS traspasos_producto_destino_id_fkey;
      ALTER TABLE traspasos ADD CONSTRAINT traspasos_producto_destino_id_fkey
        FOREIGN KEY (producto_destino_id) REFERENCES productos(id) ON DELETE SET NULL;
      ALTER TABLE traspasos DROP CONSTRAINT IF EXISTS traspasos_lote_origen_id_fkey;
      ALTER TABLE traspasos ADD CONSTRAINT traspasos_lote_origen_id_fkey
        FOREIGN KEY (lote_origen_id) REFERENCES lotes(id) ON DELETE SET NULL;
      ALTER TABLE traspasos DROP CONSTRAINT IF EXISTS traspasos_lote_destino_id_fkey;
      ALTER TABLE traspasos ADD CONSTRAINT traspasos_lote_destino_id_fkey
        FOREIGN KEY (lote_destino_id) REFERENCES lotes(id) ON DELETE SET NULL;
    `);
  } catch(e) {}
  try {
    await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON productos(proveedor_id)`);
    console.log('✅ productos.proveedor_id listo');
  } catch(e) { console.error('⚠️ Migración proveedor_id:', e.message); }
  try {
    await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS imagenes_extra TEXT DEFAULT '[]'`);
    console.log('✅ productos.imagenes_extra listo');
  } catch(e) { console.error('⚠️ Migración imagenes_extra:', e.message); }
  try {
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS foto TEXT DEFAULT ''`);
    console.log('✅ empleados.foto listo');
  } catch(e) { console.error('⚠️ Migración empleados.foto:', e.message); }
  try {
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_proximo_pago DATE`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS frecuencia_pago TEXT DEFAULT 'mensual'`);
    console.log('✅ clientes.fecha_proximo_pago / frecuencia_pago listo');
  } catch(e) { console.error('⚠️ Migración clientes fiado:', e.message); }
  try {
    await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_pago DATE`);
    console.log('✅ ventas.fecha_pago listo');
  } catch(e) { console.error('⚠️ Migración ventas.fecha_pago:', e.message); }
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
        negocio_id        UUID,
        sucursal_id       UUID
      )
    `);
    // NO borrar negocio_id — solo agregar si no existe
    try { await pool.query('ALTER TABLE licencias ADD COLUMN IF NOT EXISTS negocio_id UUID'); } catch(e) {}
    try { await pool.query('ALTER TABLE licencias ADD COLUMN IF NOT EXISTS sucursal_id UUID'); } catch(e) {}
    console.log('✅ Tabla licencias lista');
  } catch(e) { console.error('⚠️ licencias:', e.message); }
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
    try { await pool.query('ALTER TABLE empleados ALTER COLUMN negocio_id TYPE TEXT USING negocio_id::TEXT'); } catch(e2) {}
    try { await pool.query('ALTER TABLE empleados ADD COLUMN IF NOT EXISTS sucursal_id UUID'); } catch(e3) {}
    try { await pool.query('ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_entrada TIMESTAMPTZ'); } catch(e4) {}
    try { await pool.query('ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_salida TIMESTAMPTZ'); } catch(e5) {}
    console.log('✅ Tabla empleados lista');
  } catch(e) { console.error('⚠️ empleados:', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id UUID NOT NULL,
        sucursal_id UUID,
        nombre TEXT NOT NULL,
        emoji TEXT DEFAULT '🎁',
        descripcion TEXT DEFAULT '',
        precio NUMERIC(12,2) DEFAULT 0,
        activo BOOLEAN DEFAULT true,
        imagen_url TEXT DEFAULT '',
        actualizado_en TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kit_id UUID NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
        producto_id UUID,
        nombre_producto TEXT DEFAULT '',
        cantidad NUMERIC(10,3) DEFAULT 1,
        precio_unitario NUMERIC(12,2) DEFAULT 0
      )
    `);
    console.log('✅ Tablas kits listas');
  } catch(e) { console.error('⚠️ kits:', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promociones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id UUID NOT NULL,
        sucursal_id UUID,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        categoria_nombre TEXT,
        producto_id UUID,
        valor NUMERIC(10,2) DEFAULT 0,
        nxm_compra INTEGER DEFAULT 0,
        nxm_paga INTEGER DEFAULT 0,
        fecha_inicio DATE,
        fecha_fin DATE,
        activo BOOLEAN DEFAULT true,
        actualizado_en TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log('✅ Tabla promociones lista');
  } catch(e) { console.error('⚠️ promociones:', e.message); }
  try {
    // Vigencia por día de la semana / horario, además del rango de fechas
    // que ya existía — dias_semana es un JSON string de enteros 0-6
    // (0=domingo), igual que en pos-mexico. NULL en cualquiera de los tres = sin restricción.
    await pool.query(`ALTER TABLE promociones ADD COLUMN IF NOT EXISTS dias_semana TEXT`);
    await pool.query(`ALTER TABLE promociones ADD COLUMN IF NOT EXISTS hora_inicio TEXT`);
    await pool.query(`ALTER TABLE promociones ADD COLUMN IF NOT EXISTS hora_fin TEXT`);
  } catch(e) { console.error('⚠️ promociones (dias/horario):', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS divisas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id UUID NOT NULL,
        sucursal_id UUID,
        codigo TEXT NOT NULL,
        nombre TEXT NOT NULL,
        simbolo TEXT DEFAULT '$',
        tipo_cambio NUMERIC(10,4) DEFAULT 1,
        activo BOOLEAN DEFAULT true,
        actualizado_en TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log('✅ Tabla divisas lista');
  } catch(e) { console.error('⚠️ divisas:', e.message); }
}
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
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname='idx_movs_recepcion_unica'`);
    res.json({ ok: true, db: 'conectada', tablas: t.rows.map(r => r.table_name), proteccion_recepcion_unica: idx.rows.length > 0 });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/version', (req, res) => {
  res.json({ version: '2.0.0', nombre: 'Kaixa Pro', fecha: '2026-06-29', notas: 'Version estable', critica: false });
});
const updatesDir = path.join(__dirname, 'updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
app.get('/files/*', (req, res) => {
  const archivo = req.params[0];
  if (archivo.includes('..')) return res.status(400).json({ error: 'Ruta inválida' });
  const fp = path.join(updatesDir, archivo);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No encontrado' });
  res.sendFile(fp);
});
app.post('/api/lic/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    const r = await pool.query('SELECT * FROM admins_licencias WHERE usuario=$1 AND password=$2', [usuario.trim(), password.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = crearTokenAdmin(usuario);
    res.json({ ok: true, token, nombre: r.rows[0].nombre });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/lic/stats', authAdmin, async (req, res) => {
  try {
    const total   = await pool.query("SELECT COUNT(*) AS n FROM licencias");
    const activas = await pool.query("SELECT COUNT(*) AS n FROM licencias WHERE estado='activa'");
    const hoy     = await pool.query("SELECT COUNT(*) AS n FROM licencias WHERE DATE(creado_en)=CURRENT_DATE");
    const porGiro = await pool.query("SELECT giro, COUNT(*) AS n FROM licencias GROUP BY giro ORDER BY n DESC");
    res.json({ total: parseInt(total.rows[0].n), activas: parseInt(activas.rows[0].n), suspendidas: parseInt(total.rows[0].n) - parseInt(activas.rows[0].n), nuevas_hoy: parseInt(hoy.rows[0].n), por_giro: porGiro.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── RUTA TEMPORAL — corrige el bug de doble conteo de stock inicial ──────
// Un producto nuevo con stock inicial se mandaba a la nube por dos caminos
// a la vez (movimiento "recepcion" + "ajuste" calculado automáticamente),
// dejando el stock casi al doble de lo real. Ya se corrigió en pos-mexico
// para que no vuelva a pasar; esta ruta identifica y corrige, sin borrar
// nada (movimiento compensatorio), los productos que ya quedaron mal antes
// del fix. Se retira una vez confirmado que ya no hace falta.
// Encuentra pares recepcion+ajuste del MISMO producto y monto, sin importar
// el orden cronológico entre ellos (en la práctica el "ajuste" a veces queda
// con timestamp anterior al "recepcion" porque se generan en dos vueltas de
// sincronización distintas, 30s aparte) — solo exige que estén razonablemente
// cerca en el tiempo (24h) y que el producto no tenga ya una corrección
// aplicada antes.
const SQL_STOCK_DUPLICADO = `
  SELECT r.id AS recepcion_id, a.id AS ajuste_id, r.producto_id, r.negocio_id, r.sucursal_id,
         r.cantidad, r.creado_en AS recepcion_en, a.creado_en AS ajuste_en,
         n.nombre AS negocio_nombre, p.nombre AS producto_nombre
  FROM stock_movimientos r
  JOIN stock_movimientos a ON a.producto_id = r.producto_id AND a.cantidad = r.cantidad AND a.motivo = 'ajuste'
  LEFT JOIN productos p ON p.id = r.producto_id
  LEFT JOIN negocios n ON n.id = r.negocio_id
  WHERE r.motivo = 'recepcion'
    AND ABS(EXTRACT(EPOCH FROM (a.creado_en - r.creado_en))) < 86400
    AND NOT EXISTS (
      SELECT 1 FROM stock_movimientos c
      WHERE c.motivo = 'correccion_bug_duplicado' AND c.producto_id = r.producto_id
    )
  ORDER BY r.creado_en DESC`;

app.get('/api/admin/stock-duplicado', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(SQL_STOCK_DUPLICADO);
    res.json({ ok: true, total: r.rows.length, casos: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPORAL — diagnóstico ampliado: todos los movimientos de un negocio,
// para ver el historial completo de un producto en vez de solo el patrón
// exacto recepcion+ajuste que ya se corrigió.
app.get('/api/admin/stock-movimientos-negocio', authAdmin, async (req, res) => {
  try {
    const { negocio } = req.query;
    const r = await pool.query(
      `SELECT sm.id, sm.producto_id, p.nombre AS producto_nombre, sm.motivo, sm.cantidad, sm.creado_en
       FROM stock_movimientos sm
       JOIN productos p ON p.id = sm.producto_id
       JOIN negocios n ON n.id = sm.negocio_id
       WHERE n.nombre = $1
       ORDER BY p.nombre, sm.creado_en`,
      [negocio]
    );
    res.json({ ok: true, total: r.rows.length, movimientos: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPORAL — ventas sin ningún renglón de detalle (venta_detalle vacío):
// señal de que el item nunca llegó a sincronizarse, así que tampoco se
// mandó el movimiento de stock de esa venta (el stock local sí bajó, pero
// la nube nunca se enteró).
app.get('/api/admin/ventas-sin-detalle', authAdmin, async (req, res) => {
  try {
    const { negocio } = req.query;
    const r = await pool.query(
      `SELECT v.id, v.folio, v.total, v.forma_pago, v.creado_en, v.cajero, c.nombre AS caja_nombre, c.tipo AS caja_tipo
       FROM ventas v
       JOIN negocios n ON n.id = v.negocio_id
       LEFT JOIN cajas c ON c.id = v.caja_id
       WHERE n.nombre = $1 AND v.estado != 'cancelada'
         AND NOT EXISTS (SELECT 1 FROM venta_detalle vd WHERE vd.venta_id = v.id)
       ORDER BY v.creado_en DESC`,
      [negocio]
    );
    res.json({ ok: true, total: r.rows.length, ventas: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPORAL — última vez que cada caja de un negocio se conectó a sincronizar.
app.get('/api/admin/cajas-negocio', authAdmin, async (req, res) => {
  try {
    const { negocio } = req.query;
    const r = await pool.query(
      `SELECT c.nombre, c.tipo, c.activo, c.ultimo_sync, s.nombre AS sucursal_nombre
       FROM cajas c
       JOIN sucursales s ON s.id = c.sucursal_id
       JOIN negocios n ON n.id = c.negocio_id
       WHERE n.nombre = $1
       ORDER BY c.ultimo_sync DESC NULLS LAST`,
      [negocio]
    );
    res.json({ ok: true, cajas: r.rows, ahora: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPORAL — fijar el stock de un producto directo desde la nube (para
// probar que la corrección baja bien a la PC, o para corregir un caso
// puntual sin depender de que el negocio lo edite).
app.get('/api/admin/recepciones-duplicadas', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT producto_id, p.nombre, n.nombre AS negocio_nombre, COUNT(*) AS n
       FROM stock_movimientos sm
       LEFT JOIN productos p ON p.id = sm.producto_id
       LEFT JOIN negocios n ON n.id = sm.negocio_id
       WHERE motivo='recepcion'
       GROUP BY producto_id, p.nombre, n.nombre
       HAVING COUNT(*) > 1
       ORDER BY n DESC`
    );
    res.json({ ok: true, total: r.rows.length, casos: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Deja SOLO la recepción más antigua de cada producto como 'recepcion' —
// cualquier recepción extra (de antes del fix de hoy) se re-etiqueta a
// 'correccion_bug_duplicado' sin tocar su cantidad (el total no cambia,
// solo dejan de contar como una segunda "recepcion"). Necesario una sola
// vez antes de poder crear el índice único que impide que esto vuelva a
// pasar.
app.post('/api/admin/recepciones-duplicadas/limpiar', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE stock_movimientos SET motivo='correccion_bug_duplicado'
       WHERE motivo='recepcion' AND id NOT IN (
         SELECT DISTINCT ON (producto_id) id FROM stock_movimientos
         WHERE motivo='recepcion' ORDER BY producto_id, creado_en ASC
       )
       RETURNING id, producto_id, cantidad`
    );
    res.json({ ok: true, relabeled: r.rows.length, filas: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORAL — retroactivo: las correcciones ya aplicadas antes de este fix
// nunca tocaron actualizado_en, así que ninguna PC las vio nunca vía pull
// incremental. Se toca una sola vez para que el próximo pull de cada caja
// por fin las recoja.
app.post('/api/admin/tocar-corregidos', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE productos SET actualizado_en=now()
       WHERE id IN (SELECT DISTINCT producto_id FROM stock_movimientos WHERE motivo IN ('correccion_bug_duplicado','ajuste'))
       RETURNING id`
    );
    res.json({ ok: true, tocados: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-stock', authAdmin, async (req, res) => {
  try {
    const { negocio, producto_nombre, stock } = req.body;
    const prod = await pool.query(
      `SELECT p.id, p.sucursal_id, p.negocio_id FROM productos p JOIN negocios n ON n.id = p.negocio_id
       WHERE n.nombre = $1 AND p.nombre = $2 LIMIT 1`,
      [negocio, producto_nombre]
    );
    if (!prod.rows.length) return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado' });
    const { id, sucursal_id, negocio_id } = prod.rows[0];
    const ins = await pool.query(
      `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, cantidad, motivo)
       SELECT gen_random_uuid(), $1, $2, $3, $4 - COALESCE(SUM(cantidad),0), 'ajuste'
       FROM stock_movimientos WHERE producto_id=$3 AND sucursal_id=$2
       HAVING ($4 - COALESCE(SUM(cantidad),0)) != 0
       RETURNING cantidad`,
      [negocio_id, sucursal_id, id, parseInt(stock)]
    );
    // Igual que arriba: sin tocar actualizado_en, el pull incremental de la
    // PC nunca ve que este producto cambió.
    if (ins.rows.length) await pool.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [id]);
    res.json({ ok: true, ajuste_aplicado: ins.rows.length ? ins.rows[0].cantidad : 0, ya_estaba_en_ese_valor: !ins.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/stock-duplicado/corregir', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const casos = (await client.query(SQL_STOCK_DUPLICADO)).rows;
    await client.query('BEGIN');
    for (const c of casos) {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, cantidad, motivo)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'correccion_bug_duplicado')`,
        [c.negocio_id, c.sucursal_id, c.producto_id, -c.cantidad]
      );
      // Sin esto, la PC nunca se entera de la corrección — el pull incremental
      // solo baja productos con actualizado_en más nuevo que la última vez
      // que esa caja sincronizó, y esta ruta insertaba el movimiento de
      // compensación sin tocar esa marca de tiempo.
      await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [c.producto_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, corregidos: casos.length, detalle: casos });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

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
app.post('/api/lic/licencias', authAdmin, async (req, res) => {
  try {
    const { cliente_nombre, cliente_email='', cliente_tel='', negocio_nombre='', giro='tienda', plan='pro', vence_meses=12, estado='activa', notas='' } = req.body;
    if (!cliente_nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const clave = 'KXP-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const modulos = JSON.stringify(GIROS[giro]?.modulos || []);
    const vence = new Date();
    vence.setMonth(vence.getMonth() + parseInt(vence_meses));
    const r = await pool.query(`INSERT INTO licencias (clave,cliente_nombre,cliente_email,cliente_tel,negocio_nombre,giro,plan,modulos,estado,notas,vence_en) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [clave, cliente_nombre, cliente_email, cliente_tel, negocio_nombre, giro, plan, modulos, estado, notas, vence.toISOString().substring(0,10)]);
    res.json({ ok: true, clave, licencia: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/lic/licencias/:id', authAdmin, async (req, res) => {
  try {
    const { cliente_nombre, cliente_email, cliente_tel, negocio_nombre, giro, plan, vence_meses, estado, notas } = req.body;
    const vence = new Date();
    vence.setMonth(vence.getMonth() + parseInt(vence_meses || 12));
    await pool.query(`UPDATE licencias SET cliente_nombre=$1, cliente_email=$2, cliente_tel=$3, negocio_nombre=$4, giro=$5, plan=$6, estado=$7, notas=$8, vence_en=$9 WHERE id=$10`,
      [cliente_nombre, cliente_email||'', cliente_tel||'', negocio_nombre||'', giro||'tienda', plan||'pro', estado||'activa', notas||'', vence.toISOString().substring(0,10), req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/lic/licencias/:id/estado', authAdmin, async (req, res) => {
  try { await pool.query('UPDATE licencias SET estado=$1 WHERE id=$2', [req.body.estado, req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/lic/licencias/:id', authAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM licencias WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
async function verificarLicenciaHandler(req, res) {
  try {
    const clave = (req.body.clave || '').trim().toUpperCase();
    if (!clave) return res.status(400).json({ ok: false, mensaje: 'Clave requerida' });
    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];
    if (lic.estado === 'suspendida') return res.json({ ok: false, mensaje: 'Licencia suspendida. Contacta a tu proveedor.' });
    if (lic.estado === 'cancelada')  return res.json({ ok: false, mensaje: 'Licencia cancelada.' });
    let diasRestantes = null;
    if (lic.vence_en) {
      const ms = new Date(lic.vence_en).getTime() - Date.now();
      diasRestantes = Math.ceil(ms / (1000 * 60 * 60 * 24));
      if (diasRestantes < 0) return res.json({ ok: false, mensaje: 'Licencia vencida. Renueva tu suscripción.' });
    }
    let modulos = [];
    try { modulos = JSON.parse(lic.modulos || '[]'); } catch(e) {}
    if (!modulos.length && GIROS[lic.giro]) modulos = GIROS[lic.giro].modulos;
    if (lic.negocio_id) {
      try {
        const { ensureModulosOpcionalesColumn, modulosDeOpcionales } = require('./routes/modulos-opcionales');
        await ensureModulosOpcionalesColumn();
        const n = await pool.query('SELECT modulos_opcionales FROM negocios WHERE id=$1', [lic.negocio_id]);
        let opcionales = [];
        try { opcionales = JSON.parse((n.rows[0] && n.rows[0].modulos_opcionales) || '[]'); } catch(e) {}
        modulos = [...new Set([...modulos, ...modulosDeOpcionales(opcionales)])];
      } catch(e) { /* si falla, seguimos con los módulos del giro/plan tal cual */ }
    }
    await pool.query('UPDATE licencias SET ultima_verificacion=NOW() WHERE clave=$1', [clave]);
    res.json({ ok: true, mensaje: 'Licencia activa', licencia: { clave: lic.clave, cliente: lic.cliente_nombre, nombre_negocio: lic.negocio_nombre, negocio: lic.negocio_nombre, dias_restantes: diasRestantes, giro: lic.giro || 'tienda', plan: lic.plan || 'pro', modulos, max_usuarios: lic.max_usuarios, vence_en: lic.vence_en, estado: lic.estado } });
  } catch(e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
app.get('/api/verificar',  verificarLicenciaHandler);
app.post('/api/verificar', verificarLicenciaHandler);
app.get('/api/lic/negocios', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT n.id, n.nombre, n.giro_principal, (SELECT COUNT(*) FROM sucursales s WHERE s.negocio_id=n.id) AS num_sucursales, (SELECT COUNT(*) FROM cajas c WHERE c.negocio_id=n.id) AS num_cajas, (SELECT COUNT(*) FROM productos p WHERE p.negocio_id=n.id) AS num_productos FROM negocios n ORDER BY n.creado_en DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/lic/licencias/:id/vincular', authAdmin, async (req, res) => {
  try {
    const { negocio_id } = req.body;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id requerido' });
    const neg = await pool.query('SELECT id, nombre FROM negocios WHERE id=$1', [negocio_id]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Negocio no encontrado' });
    await pool.query('UPDATE licencias SET negocio_id=$1, sucursal_id=NULL WHERE id=$2', [negocio_id, req.params.id]);
    res.json({ ok: true, negocio_nombre: neg.rows[0].nombre });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── VINCULAR LICENCIA (protegido: no cambia si ya tiene datos) ────────────
app.post('/api/vincular-licencia', async (req, res) => {
  try {
    const clave     = (req.body.clave || '').trim().toUpperCase();
    const negocioId = (req.body.negocio_id || '').trim();
    if (!clave || !negocioId) return res.status(400).json({ ok: false, mensaje: 'Faltan datos' });
    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];
    if (lic.estado === 'suspendida') return res.json({ ok: false, mensaje: 'Licencia suspendida' });
    if (lic.estado === 'cancelada')  return res.json({ ok: false, mensaje: 'Licencia cancelada' });
    if (lic.vence_en && new Date(lic.vence_en).getTime() < Date.now()) return res.json({ ok: false, mensaje: 'Licencia vencida' });
    // Si ya tiene negocio_id asignado, NUNCA cambiarlo
    if (lic.negocio_id) {
      if (lic.negocio_id !== negocioId) {
        console.log('⚠️ Licencia', clave, 'ya tiene negocio:', lic.negocio_id, '— ignorando solicitud de cambio a:', negocioId);
        // Si el nuevo negocio_id es diferente, algo intentó cambiarlo — registrar
        if (lic.negocio_id !== negocioId) {
          console.error('🚨 ALERTA: Intento de cambiar negocio de licencia', clave, 'de', lic.negocio_id, 'a', negocioId);
        }
      }
      // Siempre devolver el negocio correcto
      return res.json({ ok: true, sin_cambio: true, negocio_id: lic.negocio_id });
    }
    const upd = await pool.query('UPDATE licencias SET negocio_id=$1, ultima_verificacion=NOW() WHERE clave=$2 RETURNING id, clave, negocio_id', [negocioId, clave]);
    res.json({ ok: true, mensaje: 'Licencia vinculada correctamente', licencia: upd.rows[0] });
  } catch(e) {
    console.error('vincular-licencia error:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});
// ── SINCRONIZAR EMPLEADOS DESDE LA PC ───────────────────────────────────
app.post('/api/sync/empleados', async (req, res) => {
  try {
    await ensureEmpleadosFoto();
    const token = (req.headers['x-caja-token'] || '').trim();
    if (!token) return res.status(401).json({ error: 'Falta token' });
    const caja = await pool.query('SELECT c.*, n.giro_principal FROM cajas c JOIN negocios n ON n.id=c.negocio_id WHERE c.token=$1 AND c.activo=true', [token]);
    if (!caja.rows.length) return res.status(401).json({ error: 'Token inválido' });
    const { negocio_id, sucursal_id } = caja.rows[0];
    const { empleados = [] } = req.body;
    let sincronizados = 0;
    for (const e of empleados) {
      try {
        // Verificar si ya existe por nombre y negocio
        const existe = await pool.query(
          'SELECT id FROM empleados WHERE negocio_id=$1 AND nombre=$2 LIMIT 1',
          [negocio_id, e.nombre]
        );
        if (existe.rows.length) {
          // Actualizar horarios
          const activoEmp = (e.activo === false || e.activo === 0) ? false : true;
          await pool.query(
            `UPDATE empleados SET rol=$1, ultima_entrada=$2, ultima_salida=$3, sucursal_id=$4, activo=$5,
               foto=COALESCE(NULLIF($6,''), foto), comision_pct=$7 WHERE id=$8`,
            [e.rol||'cajero', e.ultima_entrada||null, e.ultima_salida||null, e.sucursal_id||sucursal_id, activoEmp, e.foto||'', e.comision_pct||0, existe.rows[0].id]
          );
        } else {
          // Insertar nuevo
          await pool.query(
            `INSERT INTO empleados (negocio_id, sucursal_id, nombre, rol, usuario, password, activo, ultima_entrada, ultima_salida, foto, comision_pct)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [negocio_id, e.sucursal_id||sucursal_id, e.nombre, e.rol||'cajero',
             e.usuario||null, e.password||null, e.activo!==false,
             e.ultima_entrada||null, e.ultima_salida||null, e.foto||'', e.comision_pct||0]
          );
        }
        sincronizados++;
      } catch(err) { console.error('Error sync empleado:', err.message); }
    }
    res.json({ ok: true, sincronizados });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FORZAR VINCULAR LICENCIA AL NEGOCIO DEL TOKEN ───────────────────────
// Solo se llama desde la PC al configurar multi-sucursal con un token válido
app.post('/api/forzar-vincular-licencia', async (req, res) => {
  try {
    const clave     = (req.body.clave || '').trim().toUpperCase();
    const negocioId = (req.body.negocio_id || '').trim();
    if (!clave || !negocioId) return res.status(400).json({ ok: false });
    // Verificar que el negocio existe
    const neg = await pool.query('SELECT id FROM negocios WHERE id=$1', [negocioId]);
    if (!neg.rows.length) return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });
    // Actualizar licencia al negocio del token
    await pool.query('UPDATE licencias SET negocio_id=$1, ultima_verificacion=NOW() WHERE clave=$2', [negocioId, clave]);
    console.log('✅ Licencia', clave, 'forzada al negocio', negocioId);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CANJEAR LICENCIA ──────────────────────────────────────────────────────
app.post('/api/lic/canjear', async (req, res) => {
  try {
    const clave = (req.body.clave || '').trim().toUpperCase();
    if (!clave) return res.status(400).json({ ok: false, mensaje: 'Clave requerida' });
    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];
    if (lic.estado === 'suspendida') return res.json({ ok: false, mensaje: 'Licencia suspendida' });
    if (lic.estado === 'cancelada')  return res.json({ ok: false, mensaje: 'Licencia cancelada' });
    if (lic.vence_en && new Date(lic.vence_en).getTime() < Date.now()) return res.json({ ok: false, mensaje: 'Licencia vencida' });
    let negocioId = lic.negocio_id;
    console.log('🔍 Canjear licencia:', clave, '— negocio_id actual:', negocioId || 'NULL');
    if (!negocioId) {
      // No auto-crear un negocio nuevo: esta licencia todavía no fue vinculada
      // desde el panel de admin (PUT /api/lic/licencias/:id/vincular). Crear uno
      // aquí a ciegas duplicaba el negocio real del cliente cada vez que activaba
      // desde un dispositivo nuevo.
      console.warn('⚠️ Licencia', clave, 'sin negocio_id — falta vincularla desde el panel de admin');
      return res.json({ ok: false, mensaje: 'Tu licencia todavía no está activada. Contacta a tu proveedor para completar la activación.' });
    }
    const sucs = await pool.query('SELECT id, nombre FROM sucursales WHERE negocio_id=$1 AND activo=true ORDER BY nombre', [negocioId]);
    await pool.query('UPDATE licencias SET ultima_verificacion=NOW() WHERE clave=$1', [clave]);
    res.json({ ok: true, negocio_id: negocioId, negocio_nombre: lic.negocio_nombre || lic.cliente_nombre, giro: lic.giro || 'tienda', sucursales: sucs.rows });
  } catch(e) {
    console.error('canjear error:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});
// ── ELEGIR SUCURSAL ───────────────────────────────────────────────────────
app.post('/api/lic/elegir-sucursal', async (req, res) => {
  try {
    const clave = (req.body.clave || '').trim().toUpperCase();
    const sucursalId = req.body.sucursal_id;
    if (!clave || !sucursalId) return res.status(400).json({ ok: false, mensaje: 'Faltan datos' });
    const r = await pool.query('SELECT * FROM licencias WHERE clave=$1', [clave]);
    if (!r.rows.length) return res.json({ ok: false, mensaje: 'Clave inválida' });
    const lic = r.rows[0];
    if (!lic.negocio_id) return res.json({ ok: false, mensaje: 'Activa la licencia primero' });
    const suc = await pool.query('SELECT * FROM sucursales WHERE id=$1 AND negocio_id=$2 LIMIT 1', [sucursalId, lic.negocio_id]);
    if (!suc.rows.length) return res.json({ ok: false, mensaje: 'Sucursal no encontrada' });
    let caja = await pool.query("SELECT * FROM cajas WHERE sucursal_id=$1 AND nombre='App móvil' LIMIT 1", [sucursalId]);
    let token;
    if (caja.rows.length) {
      token = caja.rows[0].token;
    } else {
      token = 'app_' + crypto.randomBytes(20).toString('hex');
      await pool.query('INSERT INTO cajas (negocio_id, sucursal_id, nombre, tipo, token, activo) VALUES ($1,$2,$3,$4,$5,true)', [lic.negocio_id, sucursalId, 'App móvil', 'extra', token]);
    }
    await pool.query('UPDATE licencias SET sucursal_id=$1 WHERE id=$2', [sucursalId, lic.id]);
    res.json({ ok: true, token, sucursal_nombre: suc.rows[0].nombre });
  } catch(e) {
    console.error('elegir-sucursal error:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});
app.use('/api/admin',    require('./routes/negocios'));
app.use('/api',          require('./routes/tienda').router); // público: /api/tienda/:slug/*
app.use('/api',          require('./routes/pagos').webhookRouter); // público: /api/pagos/mp/webhook/:negocio_id
app.use('/api',          require('./routes/autofactura').router); // público: /api/autofactura/:token
app.use('/api',          require('./routes/delivery').router); // público: /api/delivery/webhook/:webhook_token
app.use('/api',          require('./routes/encuestas').router); // público: /api/encuesta/:slug
app.get('/tienda/:slug', (req, res) => {
  const p = path.join(__dirname, 'public', 'tienda.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Tienda no disponible');
});
// Menú digital de solo lectura (sin carrito) — para el QR que se pone en las
// mesas. Reutiliza los mismos endpoints públicos que ya usa tienda.html
// (/api/tienda/:slug/info y /productos), pero es una página aparte y mucho
// más chica porque no necesita carrito/checkout/pago.
app.get('/menu/:slug', (req, res) => {
  const p = path.join(__dirname, 'public', 'menu.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Menú no disponible');
});
app.get('/encuesta/:slug', (req, res) => {
  const p = path.join(__dirname, 'public', 'encuesta.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Encuesta no disponible');
});
app.get('/factura/:token', (req, res) => {
  const p = path.join(__dirname, 'public', 'factura-cliente.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Página no disponible');
});
app.get('/api/caja-info', authCaja, (req, res) => res.json(req.caja));
app.post('/api/auth/login', authCaja, async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    const r = await pool.query('SELECT * FROM empleados WHERE id=$1 AND negocio_id=$2 AND activo=true LIMIT 1', [id, req.caja.negocio_id]);
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Empleado no encontrado' });
    const e = r.rows[0];
    if (password !== (e.password || '')) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    res.json({ ok: true, empleado: { id: e.id, nombre: e.nombre, rol: e.rol } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
let _empleadosFotoListo = false;
async function ensureEmpleadosFoto() {
  if (_empleadosFotoListo) return;
  try {
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS foto TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS comision_pct NUMERIC(5,2) DEFAULT 0`);
    _empleadosFotoListo = true;
  } catch(e) { console.error('⚠️ ensureEmpleadosFoto:', e.message); }
}
app.get('/api/empleados', authCaja, async (req, res) => {
  try {
    await ensureEmpleadosFoto();
    const { negocio_id, sucursal_id } = req.caja;
    const todos = req.query.todos === '1';
    let sql, params;
    if (todos) {
      sql = `SELECT e.id, e.nombre, e.rol, e.usuario, e.ultima_entrada, e.ultima_salida, e.sucursal_id, e.foto,
             COALESCE(s.nombre, 'Sin sucursal') AS sucursal_nombre
             FROM empleados e
             LEFT JOIN sucursales s ON s.id::text = e.sucursal_id::text
             WHERE e.negocio_id=$1 AND e.activo=true
             ORDER BY sucursal_nombre, e.nombre`;
      params = [negocio_id];
    } else {
      sql = `SELECT e.id, e.nombre, e.rol, e.usuario, e.ultima_entrada, e.ultima_salida, e.sucursal_id, e.foto,
             COALESCE(s.nombre, 'Sin sucursal') AS sucursal_nombre
             FROM empleados e
             LEFT JOIN sucursales s ON s.id::text = e.sucursal_id::text
             WHERE e.negocio_id=$1 AND e.sucursal_id=$2 AND e.activo=true ORDER BY e.nombre`;
      params = [negocio_id, sucursal_id];
    }
    const r = await pool.query(sql, params);
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
    await ensureEmpleadosFoto();
    const { nombre, rol='cajero', usuario, password, foto='' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const r = await pool.query('INSERT INTO empleados (negocio_id,sucursal_id,nombre,rol,usuario,password,activo,foto) VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *', [req.caja.negocio_id, req.caja.sucursal_id, nombre, rol, usuario||null, password||null, foto||'']);
    res.json({ ok: true, empleado: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/empleados/:id', authCaja, async (req, res) => {
  try {
    await ensureEmpleadosFoto();
    const { nombre, rol, usuario, password, foto } = req.body;
    let sql = 'UPDATE empleados SET nombre=$1,rol=$2,usuario=$3,foto=COALESCE(NULLIF($4,\'\'),foto)';
    const vals = [nombre, rol, usuario||null, foto||''];
    if (password) { sql += `,password=$${vals.length+1}`; vals.push(password); }
    sql += ` WHERE id=$${vals.length+1} AND negocio_id=$${vals.length+2}`;
    vals.push(req.params.id, req.caja.negocio_id);
    await pool.query(sql, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.use('/api/sync',      authCaja, require('./routes/sync'));
app.use('/api/dashboard', authCaja, require('./routes/dashboard'));
app.use('/api/push',      authCaja, pushRouter);
app.use('/api',           authCaja, require('./routes/variantes').router);
app.use('/api',           authCaja, require('./routes/producto-extras').router);
app.use('/api',           authCaja, require('./routes/cfdi').router);
app.use('/api',           authCaja, require('./routes/modulos-opcionales').router);
app.use('/api',           authCaja, require('./routes/whatsapp').router);
app.use('/api',           authCaja, require('./routes/pagos').router);
app.use('/api',           authCaja, require('./routes/pagos_clip').router);
app.use('/api',           authCaja, require('./routes/cotizaciones').router);
app.use('/api',           authCaja, require('./routes/tarjetas-regalo').router);
app.use('/api',           authCaja, require('./routes/ventas-pendientes').router);
app.use('/api',           authCaja, require('./routes/delivery').authRouter);
app.use('/api',           authCaja, require('./routes/encuestas').authRouter);
app.use('/api',           authCaja, require('./routes/api'));
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.json({ ok: true, servicio: 'Kaixa Cloud', version: '2.0.0' });
});
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Falta token'));
    const r = await pool.query('SELECT c.id AS caja_id, c.negocio_id, c.nombre FROM cajas c WHERE c.token=$1 AND c.activo=true', [token]);
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
const PORT = process.env.PORT || 4500;
aplicarEsquema().then(async () => {
  await crearTablasPush();
  try { await require('./routes/variantes').ensureVariantesTable(); } catch(e) { console.error('⚠️ producto_variantes:', e.message); }
  try { await require('./routes/producto-extras').ensureExtrasTable(); } catch(e) { console.error('⚠️ producto_extras:', e.message); }
  const { ensureVentasPendientesTables, expirarVentasPendientes } = require('./routes/ventas-pendientes');
  try { await ensureVentasPendientesTables(); } catch(e) { console.error('⚠️ ventas_pendientes:', e.message); }
  server.listen(PORT, () => {
    console.log('🚀 Kaixa Cloud v2.0 en puerto', PORT);
    console.log('📱 PWA en /  |  🔧 Admin en /admin.html');
    console.log('🔑 Panel licencias en /licencias.html');
  });
  // Revisa stock bajo y lotes por caducar cada 45 minutos
  setTimeout(revisarAlertas, 30 * 1000);
  setInterval(revisarAlertas, 45 * 60 * 1000);
  // Expira los tickets de caja de cobro que nadie fue a cobrar (ventana de 2h)
  setTimeout(expirarVentasPendientes, 20 * 1000);
  setInterval(expirarVentasPendientes, 5 * 60 * 1000);
  // Genera los pedidos de la semana para cada entrega recurrente de despensa
  const { generarPedidosRecurrentes } = require('./routes/tienda');
  setTimeout(() => generarPedidosRecurrentes(io), 40 * 1000);
  setInterval(() => generarPedidosRecurrentes(io), 60 * 60 * 1000);
});
