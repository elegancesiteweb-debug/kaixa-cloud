// server.js — Kaixa Server v3 — Panel de licencias
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

const app  = express();
const PORT = 4000;
const DB   = new Database(path.join(__dirname, 'kaixa_licencias.db'));

// CORS — permite peticiones desde el POS (localhost:3000) y Electron
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-token');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── BD ────────────────────────────────────────────────────────
DB.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nombre TEXT DEFAULT 'Administrador'
  );
  CREATE TABLE IF NOT EXISTS licencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clave TEXT UNIQUE NOT NULL,
    cliente_nombre TEXT DEFAULT '',
    cliente_email TEXT DEFAULT '',
    cliente_tel TEXT DEFAULT '',
    negocio_nombre TEXT DEFAULT '',
    giro TEXT DEFAULT 'tienda',
    plan TEXT DEFAULT 'pro',
    modulos TEXT DEFAULT '[]',
    estado TEXT DEFAULT 'activa',
    max_usuarios INTEGER DEFAULT 3,
    notas TEXT DEFAULT '',
    vence_en TEXT DEFAULT (date('now','+1 year','localtime')),
    creado_en TEXT DEFAULT (datetime('now','localtime')),
    ultima_verificacion TEXT DEFAULT NULL
  );
`);

['giro TEXT','plan TEXT','modulos TEXT','max_usuarios INTEGER','cliente_tel TEXT','negocio_nombre TEXT','notas TEXT','ultima_verificacion TEXT'].forEach(col => {
  try { DB.prepare('ALTER TABLE licencias ADD COLUMN ' + col + " DEFAULT ''").run(); } catch(e) {}
});

DB.prepare("INSERT OR IGNORE INTO admins (usuario,password,nombre) VALUES ('kaixa_admin','Kaixa2026$','Administrador Kaixa')").run();

// ── Giros ─────────────────────────────────────────────────────
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

const PLANES = {
  basico:    { nombre:'Básico',    usuarios:1   },
  pro:       { nombre:'Pro',       usuarios:3   },
  business:  { nombre:'Business',  usuarios:10  },
  ilimitado: { nombre:'Ilimitado', usuarios:999 },
};

// ── Sesiones ──────────────────────────────────────────────────
const sesiones = new Map();
function crearToken(u) {
  const t = crypto.randomBytes(32).toString('hex');
  sesiones.set(t, { usuario:u, expira: Date.now() + 8*3600*1000 });
  return t;
}
function auth(req, res, next) {
  const t = (req.headers['x-token']||'').trim();
  const s = sesiones.get(t);
  if(!s || s.expira < Date.now()) return res.status(401).json({ error:'No autenticado' });
  next();
}

// ── Rutas API ─────────────────────────────────────────────────
app.post('/api/login', function(req, res) {
  try {
    var u = (req.body.usuario||'').trim();
    var p = (req.body.password||'').trim();
    console.log('Login intento — usuario:', u);
    if(!u || !p) return res.status(400).json({ error:'Faltan datos' });
    var admin = DB.prepare('SELECT * FROM admins WHERE usuario=? AND password=?').get(u, p);
    if(!admin) return res.status(401).json({ error:'Usuario o contraseña incorrectos' });
    var token = crearToken(u);
    console.log('Login OK');
    res.json({ ok:true, token:token, nombre:admin.nombre });
  } catch(e) {
    console.error('Error login:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/verificar', function(req, res) {
  try {
    var clave = (req.body.clave||'').trim().toUpperCase();
    if(!clave) return res.status(400).json({ ok:false, mensaje:'Clave requerida' });
    var lic = DB.prepare('SELECT * FROM licencias WHERE clave=?').get(clave);
    if(!lic) return res.json({ ok:false, mensaje:'Clave inválida' });
    if(lic.estado==='suspendida') return res.json({ ok:false, mensaje:'Licencia suspendida' });
    var modulos = [];
    try { modulos = JSON.parse(lic.modulos||'[]'); } catch(e) {}
    if(!modulos.length && GIROS[lic.giro]) modulos = GIROS[lic.giro].modulos;
    DB.prepare("UPDATE licencias SET ultima_verificacion=datetime('now','localtime') WHERE clave=?").run(clave);
    // Calcular días restantes
    var diasRestantes = null;
    if(lic.vence_en) {
      var msRestantes = new Date(lic.vence_en).getTime() - Date.now();
      diasRestantes = Math.ceil(msRestantes / (1000*60*60*24));
    }
    res.json({
      ok: true,
      mensaje: 'Licencia activa',
      licencia: {
        clave:          lic.clave,
        cliente:        lic.cliente_nombre,
        // Campos que espera el POS
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
  } catch(e) { res.status(500).json({ ok:false, mensaje:e.message }); }
});

app.get('/api/stats', auth, function(req, res) {
  try {
    var total   = DB.prepare('SELECT COUNT(*) as n FROM licencias').get().n;
    var activas = DB.prepare("SELECT COUNT(*) as n FROM licencias WHERE estado='activa'").get().n;
    var hoy     = DB.prepare("SELECT COUNT(*) as n FROM licencias WHERE date(creado_en)=date('now','localtime')").get().n;
    var porGiro = DB.prepare('SELECT giro, COUNT(*) as n FROM licencias GROUP BY giro ORDER BY n DESC').all();
    res.json({ total:total, activas:activas, suspendidas:total-activas, nuevas_hoy:hoy, por_giro:porGiro });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/licencias', auth, function(req, res) {
  try {
    var q = req.query.q||'';
    var giro = req.query.giro||'';
    var estado = req.query.estado||'';
    var sql = 'SELECT * FROM licencias WHERE 1=1';
    var p = [];
    if(q)      { sql += ' AND (cliente_nombre LIKE ? OR negocio_nombre LIKE ? OR clave LIKE ?)'; p.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
    if(giro)   { sql += ' AND giro=?'; p.push(giro); }
    if(estado) { sql += ' AND estado=?'; p.push(estado); }
    sql += ' ORDER BY id DESC';
    var rows = DB.prepare(sql).all.apply(DB.prepare(sql), p).map(function(r) {
      var mods = [];
      try { mods = JSON.parse(r.modulos||'[]'); } catch(e) {}
      return Object.assign({}, r, { modulos: mods });
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/licencias', auth, function(req, res) {
  try {
    var b = req.body;
    var cliente_nombre = (b.cliente_nombre||'').trim();
    var cliente_email  = (b.cliente_email||'').trim();
    var cliente_tel    = (b.cliente_tel||'').trim();
    var negocio_nombre = (b.negocio_nombre||'').trim();
    var giro           = b.giro || 'tienda';
    var plan           = b.plan || 'pro';
    var vence_meses    = parseInt(b.vence_meses) || 12;
    var notas          = (b.notas||'').trim();

    if(!cliente_nombre) return res.status(400).json({ error:'Nombre del cliente requerido' });
    if(!GIROS[giro])    return res.status(400).json({ error:'Giro inválido: ' + giro });

    var prefijos = {tienda:'TND',ropa:'RPA',joyeria:'JOY',celulares:'CEL',restaurante:'RST',salon:'SLN',papeleria:'PAP',farmacia:'FAR',ferreteria:'FER'};
    var pfx  = prefijos[giro] || 'KAI';
    var rand = crypto.randomBytes(6).toString('hex').toUpperCase();
    var clave = 'KAIXA-' + pfx + '-' + rand.slice(0,4) + '-' + rand.slice(4);
    var modulos = JSON.stringify(GIROS[giro].modulos);
    var maxU    = (PLANES[plan]||PLANES.pro).usuarios;
    var msVence = vence_meses >= 999 ? 365*10 : vence_meses * 30;
    var vence   = new Date(Date.now() + msVence * 24 * 3600 * 1000).toISOString().split('T')[0];

    DB.prepare('INSERT INTO licencias (clave,cliente_nombre,cliente_email,cliente_tel,negocio_nombre,giro,plan,modulos,max_usuarios,vence_en,notas) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(clave, cliente_nombre, cliente_email, cliente_tel, negocio_nombre, giro, plan, modulos, maxU, vence, notas);

    res.json({ ok:true, clave:clave, giro:giro, plan:plan, vence_en:vence });
  } catch(e) {
    console.error('Error crear licencia:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/licencias/:id', auth, function(req, res) {
  try {
    var id  = req.params.id;
    var lic = DB.prepare('SELECT * FROM licencias WHERE id=?').get(id);
    if(!lic) return res.status(404).json({ error:'No encontrada' });
    var b = req.body;
    var giroN    = b.giro || lic.giro;
    var modulosN = (giroN !== lic.giro && GIROS[giroN]) ? JSON.stringify(GIROS[giroN].modulos) : lic.modulos;
    DB.prepare('UPDATE licencias SET cliente_nombre=?,cliente_email=?,cliente_tel=?,negocio_nombre=?,giro=?,plan=?,modulos=?,estado=?,vence_en=?,notas=? WHERE id=?')
      .run(b.cliente_nombre||lic.cliente_nombre, b.cliente_email||lic.cliente_email, b.cliente_tel||lic.cliente_tel,
           b.negocio_nombre||lic.negocio_nombre, giroN, b.plan||lic.plan, modulosN,
           b.estado||lic.estado, b.vence_en||lic.vence_en, b.notas||lic.notas, id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/licencias/:id/estado', auth, function(req, res) {
  try {
    DB.prepare('UPDATE licencias SET estado=? WHERE id=?').run(req.body.estado, req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/licencias/:id', auth, function(req, res) {
  try {
    DB.prepare('DELETE FROM licencias WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/giros',  auth, function(req,res){ res.json(GIROS); });
app.get('/api/planes', auth, function(req,res){ res.json(PLANES); });

// ── Panel HTML ─────────────────────────────────────────────────
app.get('/', function(req,res){ res.type('html').send(PANEL); });
app.listen(PORT, function(){ console.log('✅ Kaixa Server en http://localhost:' + PORT); });

// ── HTML ───────────────────────────────────────────────────────
var PANEL = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kaixa Server — Panel de Licencias</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#ffffff;--s1:#f8f5ff;--s2:#f0ebff;--s3:#e8dfff;
  --border:#e2d9f3;--border2:#c4b5fd;
  --accent:#8b5cf6;--accent2:#d946ef;
  --warn:#f59e0b;--danger:#ef4444;
  --text:#1a1035;--text2:#6b5fa0;--text3:#a89fd4;
  --grad:linear-gradient(135deg,#8b5cf6,#d946ef);
  --ff:'Outfit',-apple-system,'Segoe UI',sans-serif;
  --fm:'Consolas',monospace
}
body{font-family:var(--ff);background:var(--bg);color:var(--text);min-height:100vh}

/* LOGIN */
#login{display:flex;align-items:center;justify-content:center;min-height:100vh;
  background:radial-gradient(ellipse at 20% 40%,rgba(139,92,246,.08) 0%,transparent 60%),
             radial-gradient(ellipse at 80% 60%,rgba(217,70,239,.06) 0%,transparent 50%),#fff}
.lcard{background:#fff;border:1.5px solid var(--border);border-radius:20px;padding:44px 40px;width:400px;
  box-shadow:0 8px 40px rgba(139,92,246,.1),0 2px 8px rgba(0,0,0,.05)}
.llogo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:6px}
.llogo-ico{width:48px;height:48px;background:var(--grad);border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;box-shadow:0 4px 16px rgba(139,92,246,.3)}
.llogo h1{font-size:28px;font-weight:900;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.lsub{font-size:12px;color:var(--text2);text-align:center;margin-bottom:28px;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
.linp{width:100%;background:var(--s1);border:1.5px solid var(--border);border-radius:10px;padding:12px 16px;
  font-size:14px;color:var(--text);outline:none;margin-bottom:12px;font-family:var(--ff);transition:border-color .2s,box-shadow .2s}
.linp:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,92,246,.1)}
.lbtn{width:100%;padding:13px;border-radius:10px;border:none;background:var(--grad);color:#fff;
  font-size:14px;font-weight:800;cursor:pointer;font-family:var(--ff);transition:opacity .15s;
  box-shadow:0 4px 16px rgba(139,92,246,.3)}
.lbtn:hover{opacity:.9}
#lerr{color:var(--danger);font-size:12px;margin-top:10px;min-height:18px;text-align:center}
.lver{font-size:11px;color:var(--text3);text-align:center;margin-top:18px}

/* APP */
#app{display:none}
.topbar{background:#fff;border-bottom:1.5px solid var(--border);padding:0 28px;
  display:flex;align-items:center;justify-content:space-between;height:60px;
  position:sticky;top:0;z-index:50;box-shadow:0 1px 8px rgba(139,92,246,.06)}
.tlogo{display:flex;align-items:center;gap:10px}
.tlogo-ico{width:36px;height:36px;background:var(--grad);border-radius:10px;
  display:flex;align-items:center;justify-content:center;font-size:19px;
  box-shadow:0 2px 10px rgba(139,92,246,.25)}
.tlogo-nm{font-size:17px;font-weight:900;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.tlogo-sub{font-size:11px;color:var(--text2);font-weight:600;margin-left:6px;text-transform:uppercase;letter-spacing:.07em}
#statBar{font-size:11px;color:var(--text2)}
.tbtn{padding:8px 16px;border-radius:8px;border:1.5px solid var(--border);background:#fff;
  color:var(--text2);font-size:12px;font-weight:700;cursor:pointer;font-family:var(--ff);transition:all .15s}
.tbtn:hover{border-color:var(--accent);color:var(--accent)}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;padding:24px 28px 0}
.stat{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:18px 20px;
  position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--grad)}
.sv{font-size:32px;font-weight:900;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sl{font-size:11px;color:var(--text2);margin-top:4px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}

/* TOOLBAR */
.toolbar{padding:20px 28px 14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.srch{flex:1;min-width:200px;max-width:320px;background:var(--s1);border:1.5px solid var(--border);
  border-radius:10px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;font-family:var(--ff);transition:all .2s}
.srch:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,92,246,.08)}
.fil{background:var(--s1);border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;
  font-size:13px;color:var(--text);outline:none;font-family:var(--ff);cursor:pointer}
.fil:focus{border-color:var(--accent)}
.btn-new{padding:10px 22px;border-radius:10px;border:none;background:var(--grad);color:#fff;
  font-size:13px;font-weight:800;cursor:pointer;font-family:var(--ff);
  box-shadow:0 3px 12px rgba(139,92,246,.25);transition:opacity .15s}
.btn-new:hover{opacity:.9}

/* TABLE */
.twrap{padding:0 28px 40px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead tr{background:var(--s1)}
th{padding:11px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--text2);font-weight:700;border-bottom:1.5px solid var(--border)}
td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:hover td{background:var(--s1)}
.clave{font-family:var(--fm);font-size:11px;color:var(--accent);letter-spacing:.04em;
  background:var(--s2);padding:4px 8px;border-radius:6px;font-weight:700}
.lic-neg{font-weight:700;font-size:13px;color:var(--text)}
.lic-sub{font-size:11px;color:var(--text2);margin-top:2px}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.b-ok{background:rgba(139,92,246,.1);color:var(--accent);border:1px solid rgba(139,92,246,.2)}
.b-err{background:rgba(239,68,68,.08);color:var(--danger);border:1px solid rgba(239,68,68,.2)}
.acts{display:flex;gap:6px;flex-wrap:nowrap}
.abtn{padding:5px 11px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;
  border:1.5px solid var(--border);background:#fff;color:var(--text2);font-family:var(--ff);transition:all .15s}
.abtn:hover{border-color:var(--accent);color:var(--accent);background:var(--s1)}
.abtn-d{color:var(--danger);border-color:rgba(239,68,68,.2)}
.abtn-d:hover{border-color:var(--danger);background:rgba(239,68,68,.05)}
.abtn-w{color:var(--warn);border-color:rgba(245,158,11,.2)}
.abtn-w:hover{border-color:var(--warn);background:rgba(245,158,11,.05)}
.empty-state{text-align:center;padding:60px;color:var(--text2)}
.empty-state .ei{font-size:48px;margin-bottom:12px;opacity:.3}

/* MODAL */
.mo{display:none;position:fixed;inset:0;background:rgba(26,16,53,.3);backdrop-filter:blur(4px);
  z-index:200;align-items:center;justify-content:center;padding:20px}
.mo.show{display:flex}
.mpb{background:#fff;border:1.5px solid var(--border);border-radius:20px;padding:32px;
  width:100%;max-width:560px;max-height:90vh;overflow-y:auto;
  box-shadow:0 20px 60px rgba(139,92,246,.15)}
.mpb h3{font-size:17px;font-weight:800;margin-bottom:22px;color:var(--text)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.mf label{font-size:10px;color:var(--text2);display:block;margin-bottom:5px;
  text-transform:uppercase;letter-spacing:.07em;font-weight:700}
.mf input,.mf select,.mf textarea{width:100%;background:var(--s1);border:1.5px solid var(--border);
  border-radius:10px;padding:11px 13px;font-size:13px;color:var(--text);outline:none;font-family:var(--ff);transition:all .2s}
.mf input:focus,.mf select:focus,.mf textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,92,246,.08)}
.mf select option{background:#fff}
.mbr{display:flex;gap:10px;margin-top:24px}
.mbc{flex:1;padding:12px;border-radius:10px;border:1.5px solid var(--border);background:#fff;
  color:var(--text2);font-size:13px;cursor:pointer;font-weight:700;font-family:var(--ff);transition:all .15s}
.mbc:hover{border-color:var(--accent);color:var(--accent)}
.mbs{flex:2;padding:12px;border-radius:10px;border:none;background:var(--grad);color:#fff;
  font-size:13px;font-weight:800;cursor:pointer;font-family:var(--ff);
  box-shadow:0 3px 12px rgba(139,92,246,.25);transition:opacity .15s}
.mbs:hover{opacity:.9}
.clave-result{background:var(--s2);border:1.5px solid var(--border2);border-radius:10px;
  padding:14px;margin-top:14px;text-align:center;display:none}
.clave-result .cr-l{font-size:11px;color:var(--text2);font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.clave-result .cr-v{font-family:var(--fm);font-size:18px;font-weight:700;color:var(--accent);letter-spacing:.06em}

/* NOTIF */
.notif{position:fixed;bottom:24px;right:24px;background:#fff;border:1.5px solid var(--accent);
  border-radius:12px;padding:13px 20px;font-size:13px;font-weight:700;color:var(--text);
  z-index:999;display:none;box-shadow:0 8px 32px rgba(139,92,246,.2)}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="login">
  <div class="lcard">
    <div class="llogo">
      <div class="llogo-ico">⚡</div>
      <h1>Kaixa</h1>
    </div>
    <p class="lsub">Panel de administración de licencias</p>
    <input class="linp" id="u" placeholder="Usuario" autocomplete="username">
    <input class="linp" id="p" type="password" placeholder="Contraseña" autocomplete="current-password">
    <button class="lbtn" id="btnLogin">Entrar al panel →</button>
    <div id="lerr"></div>
    <div class="lver">Kaixa Server v3.0 · Puerto 4000</div>
  </div>
</div>

<!-- APP -->
<div id="app">
  <div class="topbar">
    <div class="tlogo">
      <div class="tlogo-ico">⚡</div>
      <span class="tlogo-nm">Kaixa</span>
      <span class="tlogo-sub">Panel de Licencias</span>
    </div>
    <div style="display:flex;gap:12px;align-items:center">
      <span id="statBar"></span>
      <button class="tbtn" id="btnLogout">Salir</button>
    </div>
  </div>

  <div class="stats" id="sGrid"></div>

  <div class="toolbar">
    <input class="srch" id="q" placeholder="🔍 Buscar cliente, negocio o clave...">
    <select class="fil" id="fGiro">
      <option value="">Todos los giros</option>
      <option value="tienda">🛒 Tienda</option>
      <option value="ropa">👗 Ropa</option>
      <option value="joyeria">💍 Joyería</option>
      <option value="celulares">📱 Celulares</option>
      <option value="restaurante">🍕 Restaurante</option>
      <option value="salon">💈 Salón</option>
      <option value="papeleria">📚 Papelería</option>
      <option value="farmacia">🏥 Farmacia</option>
      <option value="ferreteria">🏗️ Ferretería</option>
    </select>
    <select class="fil" id="fEst">
      <option value="">Todos los estados</option>
      <option value="activa">✅ Activa</option>
      <option value="suspendida">⛔ Suspendida</option>
    </select>
    <button class="btn-new" id="btnNueva">+ Nueva licencia</button>
  </div>

  <div class="twrap">
    <table>
      <thead><tr>
        <th>Clave</th><th>Negocio / Cliente</th><th>Giro</th>
        <th>Plan</th><th>Estado</th><th>Vence</th><th>Acciones</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>
</div>

<!-- Modal nueva / editar licencia -->
<div class="mo" id="mo">
  <div class="mpb">
    <h3 id="moT">Nueva licencia</h3>
    <input type="hidden" id="moId">
    <div class="grid2">
      <div class="mf"><label>Nombre del cliente *</label><input id="moCli" placeholder="Juan Pérez"></div>
      <div class="mf"><label>Teléfono</label><input id="moTel" placeholder="33 1234 5678"></div>
      <div class="mf"><label>Email</label><input id="moEmail" placeholder="juan@correo.com"></div>
      <div class="mf"><label>Nombre del negocio</label><input id="moNeg" placeholder="Joyería El Diamante"></div>
      <div class="mf">
        <label>Giro del negocio *</label>
        <select id="moGiro">
          <option value="tienda">🛒 Tienda / Abarrotes</option>
          <option value="ropa">👗 Ropa y Moda</option>
          <option value="joyeria">💍 Joyería</option>
          <option value="celulares">📱 Celulares y Tecnología</option>
          <option value="restaurante">🍕 Restaurante / Taquería</option>
          <option value="salon">💈 Salón / Spa / Barbería</option>
          <option value="papeleria">📚 Papelería / Escolar</option>
          <option value="farmacia">🏥 Farmacia / Salud</option>
          <option value="ferreteria">🏗️ Ferretería / Materiales</option>
        </select>
      </div>
      <div class="mf">
        <label>Plan</label>
        <select id="moPlan">
          <option value="basico">Básico — 1 usuario</option>
          <option value="pro" selected>Pro — 3 usuarios</option>
          <option value="business">Business — 10 usuarios</option>
          <option value="ilimitado">Ilimitado</option>
        </select>
      </div>
      <div class="mf">
        <label>Vigencia</label>
        <select id="moMeses">
          <option value="1">1 mes</option>
          <option value="3">3 meses</option>
          <option value="6">6 meses</option>
          <option value="12" selected>12 meses (1 año)</option>
          <option value="24">24 meses (2 años)</option>
          <option value="999">Sin vencimiento</option>
        </select>
      </div>
      <div class="mf">
        <label>Estado</label>
        <select id="moEst">
          <option value="activa">✅ Activa</option>
          <option value="suspendida">⛔ Suspendida</option>
        </select>
      </div>
    </div>
    <div class="mf"><label>Notas internas</label><textarea id="moNot" rows="2" placeholder="Ej: instalación en Tlaquepaque, contacto directo..."></textarea></div>
    <div class="clave-result" id="claveResult">
      <div class="cr-l">✅ Licencia creada — clave de activación:</div>
      <div class="cr-v" id="claveVal"></div>
    </div>
    <div class="mbr">
      <button class="mbc" id="btnCerrar">Cerrar</button>
      <button class="mbs" id="btnGuardar">💾 Guardar licencia</button>
    </div>
  </div>
</div>

<div class="notif" id="notif"></div>

<script>
(function(){
  var TOKEN = '';
  var LICS  = [];
  var GIRO_ICO = {tienda:'🛒',ropa:'👗',joyeria:'💍',celulares:'📱',restaurante:'🍕',salon:'💈',papeleria:'📚',farmacia:'🏥',ferreteria:'🏗️'};
  var GIRO_NM  = {tienda:'Tienda',ropa:'Ropa',joyeria:'Joyería',celulares:'Celulares',restaurante:'Restaurante',salon:'Salón',papeleria:'Papelería',farmacia:'Farmacia',ferreteria:'Ferretería'};

  function g(id){ return document.getElementById(id); }
  var _nt;
  function notif(m){ g('notif').textContent=m; g('notif').style.display='block'; clearTimeout(_nt); _nt=setTimeout(function(){ g('notif').style.display='none'; },3500); }

  async function api(method, url, body){
    var opts = { method:method, headers:{'Content-Type':'application/json','x-token':TOKEN} };
    if(body) opts.body = JSON.stringify(body);
    var r = await fetch(url, opts);
    var ct = r.headers.get('content-type')||'';
    if(!ct.includes('application/json')){
      var txt = await r.text();
      throw new Error('Respuesta inesperada del servidor: ' + txt.substring(0,100));
    }
    var d = await r.json();
    if(!r.ok) throw new Error(d.error || 'Error '+r.status);
    return d;
  }

  async function entrar(){
    var u = g('u').value.trim();
    var p = g('p').value.trim();
    g('lerr').textContent = '';
    if(!u||!p){ g('lerr').textContent='Ingresa usuario y contraseña'; return; }
    try{
      var r = await fetch('/api/login',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({usuario:u, password:p})
      });
      var d = await r.json();
      if(!r.ok||!d.ok){ g('lerr').textContent = d.error||'Credenciales incorrectas'; return; }
      TOKEN = d.token;
      g('login').style.display='none';
      g('app').style.display='block';
      loadStats();
      loadLics();
    }catch(e){ g('lerr').textContent='Error: '+e.message; }
  }

  async function loadStats(){
    try{
      var s = await api('GET','/api/stats');
      g('sGrid').innerHTML=[
        {v:s.total,l:'Total licencias'},{v:s.activas,l:'✅ Activas'},
        {v:s.suspendidas,l:'⛔ Suspendidas'},{v:s.nuevas_hoy,l:'📅 Nuevas hoy'}
      ].map(function(k){ return '<div class="stat"><div class="sv">'+k.v+'</div><div class="sl">'+k.l+'</div></div>'; }).join('');
      if(s.por_giro&&s.por_giro.length)
        g('statBar').textContent=s.por_giro.map(function(x){ return (GIRO_ICO[x.giro]||'🏪')+' '+(GIRO_NM[x.giro]||x.giro)+': '+x.n; }).join(' · ');
    }catch(e){}
  }

  async function loadLics(){
    var q=g('q').value, giro=g('fGiro').value, est=g('fEst').value;
    var url='/api/licencias?';
    if(q)    url+='q='+encodeURIComponent(q)+'&';
    if(giro) url+='giro='+giro+'&';
    if(est)  url+='estado='+est+'&';
    try{
      LICS = await api('GET',url);
      var tb=g('tb');
      if(!LICS.length){
        tb.innerHTML='<tr><td colspan="7"><div class="empty-state"><div class="ei">📋</div>Sin licencias registradas</div></td></tr>';
        return;
      }
      tb.innerHTML=LICS.map(function(l){
        var bk=l.estado==='activa'
          ?'<span class="badge b-ok">✅ Activa</span>'
          :'<span class="badge b-err">⛔ '+l.estado+'</span>';
        var estBtn=l.estado==='activa'
          ?'<button class="abtn abtn-w" data-id="'+l.id+'" data-act="suspender">⛔ Suspender</button>'
          :'<button class="abtn" data-id="'+l.id+'" data-act="activar">✅ Activar</button>';
        return '<tr>'
          +'<td><span class="clave">'+l.clave+'</span></td>'
          +'<td><div class="lic-neg">'+(l.negocio_nombre||'—')+'</div><div class="lic-sub">'+l.cliente_nombre+(l.cliente_tel?' · '+l.cliente_tel:'')+'</div></td>'
          +'<td>'+(GIRO_ICO[l.giro]||'🏪')+' '+(GIRO_NM[l.giro]||l.giro)+'</td>'
          +'<td style="font-size:12px;color:var(--text2)">'+(l.plan||'pro')+'</td>'
          +'<td>'+bk+'</td>'
          +'<td style="font-size:12px;color:var(--text2)">'+(l.vence_en||'—')+'</td>'
          +'<td><div class="acts">'
            +'<button class="abtn" data-id="'+l.id+'" data-act="editar">✏️ Editar</button>'
            +estBtn
            +'<button class="abtn abtn-d" data-id="'+l.id+'" data-act="eliminar">🗑️</button>'
          +'</div></td>'
          +'</tr>';
      }).join('');
    }catch(e){ notif('Error: '+e.message); }
  }

  function abrirModal(lic){
    g('moT').textContent = lic ? '✏️ Editar licencia' : '📋 Nueva licencia';
    g('moId').value    = lic ? lic.id : '';
    g('moCli').value   = lic ? (lic.cliente_nombre||'') : '';
    g('moTel').value   = lic ? (lic.cliente_tel||'')    : '';
    g('moEmail').value = lic ? (lic.cliente_email||'')  : '';
    g('moNeg').value   = lic ? (lic.negocio_nombre||'') : '';
    g('moGiro').value  = lic ? (lic.giro||'tienda')     : 'tienda';
    g('moPlan').value  = lic ? (lic.plan||'pro')        : 'pro';
    g('moMeses').value = '12';
    g('moEst').value   = lic ? (lic.estado||'activa')   : 'activa';
    g('moNot').value   = lic ? (lic.notas||'')          : '';
    g('claveResult').style.display = 'none';
    g('btnGuardar').style.display  = 'inline-block';
    g('mo').classList.add('show');
    setTimeout(function(){ g('moCli').focus(); }, 100);
  }

  function cerrarModal(){ g('mo').classList.remove('show'); }

  async function guardar(){
    var id = g('moId').value;
    var body = {
      cliente_nombre: g('moCli').value.trim(),
      cliente_tel:    g('moTel').value.trim(),
      cliente_email:  g('moEmail').value.trim(),
      negocio_nombre: g('moNeg').value.trim(),
      giro:           g('moGiro').value,
      plan:           g('moPlan').value,
      vence_meses:    parseInt(g('moMeses').value)||12,
      estado:         g('moEst').value,
      notas:          g('moNot').value.trim()
    };
    if(!body.cliente_nombre){ notif('⚠️ El nombre del cliente es requerido'); return; }
    try{
      if(id){
        await api('PUT','/api/licencias/'+id, body);
        notif('✅ Licencia actualizada');
        cerrarModal();
      } else {
        var r = await api('POST','/api/licencias', body);
        g('claveVal').textContent = r.clave;
        g('claveResult').style.display = 'block';
        g('btnGuardar').style.display  = 'none';
        notif('✅ Licencia creada: '+r.clave);
      }
      loadLics();
      loadStats();
    }catch(e){ notif('❌ '+e.message); }
  }

  // Events
  g('btnLogin').addEventListener('click', entrar);
  g('u').addEventListener('keydown',function(e){ if(e.key==='Enter') g('p').focus(); });
  g('p').addEventListener('keydown',function(e){ if(e.key==='Enter') entrar(); });
  g('btnLogout').addEventListener('click',function(){ TOKEN=''; location.reload(); });
  g('btnNueva').addEventListener('click',function(){ abrirModal(null); });
  g('btnGuardar').addEventListener('click', guardar);
  g('btnCerrar').addEventListener('click', cerrarModal);
  g('mo').addEventListener('click',function(e){ if(e.target===g('mo')) cerrarModal(); });
  g('q').addEventListener('input', loadLics);
  g('fGiro').addEventListener('change', loadLics);
  g('fEst').addEventListener('change', loadLics);

  g('tb').addEventListener('click', async function(e){
    var btn = e.target.closest('button[data-act]');
    if(!btn) return;
    var id  = parseInt(btn.dataset.id);
    var act = btn.dataset.act;
    var lic = LICS.find(function(l){ return l.id===id; });
    if(act==='editar'){ if(lic) abrirModal(lic); }
    else if(act==='suspender'){
      try{ await api('PUT','/api/licencias/'+id+'/estado',{estado:'suspendida'}); notif('Licencia suspendida'); loadLics(); loadStats(); }
      catch(e){ notif('Error: '+e.message); }
    }
    else if(act==='activar'){
      try{ await api('PUT','/api/licencias/'+id+'/estado',{estado:'activa'}); notif('Licencia activada'); loadLics(); loadStats(); }
      catch(e){ notif('Error: '+e.message); }
    }
    else if(act==='eliminar'){
      if(!confirm('¿Eliminar esta licencia? No se puede deshacer.')) return;
      try{ await api('DELETE','/api/licencias/'+id); notif('Licencia eliminada'); loadLics(); loadStats(); }
      catch(e){ notif('Error: '+e.message); }
    }
  });
})();
</script>
</body>
</html>`;
