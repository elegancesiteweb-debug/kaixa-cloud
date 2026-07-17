// routes/tienda.js — Tienda en línea pública (sin login) por negocio
// Los pedidos se apartan aquí; se confirman desde la PC o la app móvil
// (ver /api/pedidos-online en routes/api.js), lo que descuenta stock y
// registra la venta — el cliente paga en tienda, no en línea.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');

function slugify(str) {
  return (str || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'tienda';
}

function folioPedido() {
  return 'PED-' + Date.now().toString().slice(-8) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

async function asignarSlug(negocioId, nombre) {
  const base = slugify(nombre);
  let slug = base;
  let intento = 0;
  while (true) {
    const existe = await pool.query('SELECT id FROM negocios WHERE slug=$1 AND id<>$2', [slug, negocioId]);
    if (!existe.rows.length) break;
    intento++;
    slug = base + '-' + crypto.randomBytes(2).toString('hex');
    if (intento > 5) { slug = negocioId; break; }
  }
  await pool.query('UPDATE negocios SET slug=$1 WHERE id=$2', [slug, negocioId]);
  return slug;
}

async function ensureTiendaTables() {
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS slug TEXT`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_imagen_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_descripcion TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_logo_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_telefono TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_direccion TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_horario TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tienda_mostrar_kits BOOLEAN DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_online (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id       UUID NOT NULL REFERENCES sucursales(id),
      folio             TEXT NOT NULL,
      cliente_nombre    TEXT NOT NULL,
      cliente_telefono  TEXT DEFAULT '',
      cliente_email     TEXT DEFAULT '',
      notas             TEXT DEFAULT '',
      estado            TEXT DEFAULT 'pendiente',
      subtotal          NUMERIC(12,2) DEFAULT 0,
      venta_id          UUID REFERENCES ventas(id),
      rechazo_motivo    TEXT DEFAULT '',
      creado_en         TIMESTAMPTZ DEFAULT now(),
      confirmado_en     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS pedido_online_items (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pedido_id         UUID NOT NULL REFERENCES pedidos_online(id) ON DELETE CASCADE,
      producto_id       UUID REFERENCES productos(id),
      nombre_producto   TEXT DEFAULT '',
      cantidad          INTEGER DEFAULT 1,
      precio_unitario   NUMERIC(12,2) DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_online_sucursal ON pedidos_online(sucursal_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_online_negocio  ON pedidos_online(negocio_id);
  `);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS variante_id UUID`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS variante_texto TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS kit_id UUID`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS componentes JSONB DEFAULT '[]'`);
  const sinSlug = await pool.query("SELECT id, nombre FROM negocios WHERE slug IS NULL OR slug=''");
  for (const n of sinSlug.rows) { await asignarSlug(n.id, n.nombre); }
}

function textoVariante(v) {
  if (!v) return '';
  const partes = [];
  if (v.atributo1_valor) partes.push(v.atributo1_valor);
  if (v.atributo2_valor) partes.push(v.atributo2_valor);
  return partes.join('/');
}

// ── GET /api/tienda/:slug/info — datos del negocio + sucursales ──
router.get('/tienda/:slug/info', async (req, res) => {
  try {
    await ensureTiendaTables();
    const neg = await pool.query(
      `SELECT id, nombre, giro_principal, tienda_imagen_url, tienda_descripcion,
              tienda_logo_url, tienda_telefono, tienda_direccion, tienda_horario,
              COALESCE(tienda_mostrar_kits,false) AS tienda_mostrar_kits
       FROM negocios WHERE slug=$1 AND activo=true`,
      [req.params.slug]
    );
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const sucs = await pool.query(
      'SELECT id, nombre FROM sucursales WHERE negocio_id=$1 AND activo=true ORDER BY nombre',
      [neg.rows[0].id]
    );
    res.json({ negocio: neg.rows[0], sucursales: sucs.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tienda/:slug/productos?sucursal_id=X — catálogo con stock ──
router.get('/tienda/:slug/productos', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { sucursal_id } = req.query;
    if (!sucursal_id) return res.status(400).json({ error: 'Falta sucursal_id' });
    const neg = await pool.query('SELECT id FROM negocios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const r = await pool.query(`
      SELECT p.id, p.nombre, p.emoji, p.imagen_url, p.precio, p.categoria_id, c.nombre AS categoria_nombre,
             COALESCE(p.tiene_variantes,false) AS tiene_variantes,
             COALESCE(s.stock,0) AS stock
      FROM productos p
      LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = p.sucursal_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id=$1 AND p.sucursal_id=$2 AND p.activo=true
        AND (COALESCE(p.tiene_variantes,false) = true OR COALESCE(s.stock,0) > 0)
      ORDER BY p.nombre`,
      [neg.rows[0].id, sucursal_id]
    );
    const productos = r.rows;

    // Adjuntar variantes activas de los productos que las tienen
    const conVariantes = productos.filter(p => p.tiene_variantes);
    if (conVariantes.length) {
      const ids = conVariantes.map(p => p.id);
      const vr = await pool.query(
        `SELECT * FROM producto_variantes WHERE producto_id = ANY($1) AND activo=true
         ORDER BY atributo1_valor, atributo2_valor`,
        [ids]
      );
      const porProducto = {};
      vr.rows.forEach(v => { (porProducto[v.producto_id] = porProducto[v.producto_id] || []).push(v); });
      productos.forEach(p => { if (p.tiene_variantes) p.variantes = porProducto[p.id] || []; });
    }

    res.json(productos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tienda/:slug/kits?sucursal_id=X — kits activos con fotos de sus productos ──
router.get('/tienda/:slug/kits', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { sucursal_id } = req.query;
    if (!sucursal_id) return res.status(400).json({ error: 'Falta sucursal_id' });
    const neg = await pool.query(
      'SELECT id, COALESCE(tienda_mostrar_kits,false) AS mostrar FROM negocios WHERE slug=$1 AND activo=true',
      [req.params.slug]
    );
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    if (!neg.rows[0].mostrar) return res.json([]);

    const r = await pool.query(`
      SELECT k.id, k.nombre, k.emoji, k.descripcion, k.precio, k.imagen_url,
        COALESCE(json_agg(json_build_object(
          'producto_id', ki.producto_id, 'nombre_producto', ki.nombre_producto,
          'cantidad', ki.cantidad, 'imagen_url', p.imagen_url,
          'stock', COALESCE(s.stock, 0)
        ) ORDER BY ki.id) FILTER (WHERE ki.id IS NOT NULL), '[]') AS items
      FROM kits k
      LEFT JOIN kit_items ki ON ki.kit_id = k.id
      LEFT JOIN productos p ON p.id = ki.producto_id
      LEFT JOIN stock_actual s ON s.producto_id = ki.producto_id AND s.sucursal_id = $2
      WHERE k.negocio_id=$1 AND k.sucursal_id=$2 AND k.activo=true
      GROUP BY k.id ORDER BY k.nombre`,
      [neg.rows[0].id, sucursal_id]
    );

    const kits = r.rows.map(function(k) {
      const items = (k.items || []).filter(i => i.producto_id);
      const stockKit = items.length
        ? Math.min.apply(null, items.map(i => Math.floor((parseFloat(i.stock)||0) / (parseFloat(i.cantidad)||1))))
        : 0;
      return Object.assign({}, k, { items, stock: stockKit });
    }).filter(k => k.stock > 0);

    res.json(kits);
  } catch(e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/tienda/:slug/pedidos — apartar un pedido (paga en tienda) ──
router.post('/tienda/:slug/pedidos', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTiendaTables();
    const { sucursal_id, cliente_nombre, cliente_telefono='', cliente_email='', notas='', items=[] } = req.body;
    if (!sucursal_id) return res.status(400).json({ error: 'Falta la sucursal' });
    if (!cliente_nombre || !cliente_nombre.trim()) return res.status(400).json({ error: 'Falta tu nombre' });
    if (!items.length) return res.status(400).json({ error: 'El pedido está vacío' });

    const neg = await pool.query('SELECT id FROM negocios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const negocioId = neg.rows[0].id;

    const suc = await pool.query(
      'SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2 AND activo=true',
      [sucursal_id, negocioId]
    );
    if (!suc.rows.length) return res.status(404).json({ error: 'Sucursal no válida' });

    await client.query('BEGIN');

    // Validar productos (y variantes) y calcular subtotal en el servidor
    // (no confiar en precios ni stock que mande el navegador)
    let subtotal = 0;
    const itemsValidados = [];
    for (const it of items) {
      const cantidad = Math.max(1, parseInt(it.cantidad) || 1);

      if (it.kit_id) {
        const kitRes = await client.query(
          'SELECT id, nombre, emoji, precio FROM kits WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
          [it.kit_id, negocioId, sucursal_id]
        );
        if (!kitRes.rows.length) continue;
        const kit = kitRes.rows[0];
        const compRes = await client.query(
          `SELECT ki.producto_id, ki.cantidad, COALESCE(s.stock,0) AS stock
           FROM kit_items ki LEFT JOIN stock_actual s ON s.producto_id = ki.producto_id AND s.sucursal_id = $2
           WHERE ki.kit_id = $1`,
          [kit.id, sucursal_id]
        );
        const componentes = compRes.rows.filter(c => c.producto_id);
        if (!componentes.length) continue;
        const stockKit = Math.min(...componentes.map(c => Math.floor((parseFloat(c.stock)||0) / (parseFloat(c.cantidad)||1))));
        if (stockKit < cantidad) continue; // sin stock suficiente para armar el kit — se ignora

        subtotal += parseFloat(kit.precio) * cantidad;
        itemsValidados.push({
          producto_id: null, nombre_producto: (kit.emoji||'🎁') + ' ' + kit.nombre, cantidad,
          precio_unitario: parseFloat(kit.precio), variante_id: null, variante_texto: '',
          kit_id: kit.id, componentes: componentes.map(c => ({ producto_id: c.producto_id, cantidad: c.cantidad }))
        });
        continue;
      }

      const prod = await client.query(
        'SELECT id, nombre, precio FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
        [it.producto_id, negocioId, sucursal_id]
      );
      if (!prod.rows.length) continue;
      const p = prod.rows[0];

      let varianteId = null, varianteTexto = '', precioUnit = parseFloat(p.precio);
      if (it.variante_id) {
        const vRes = await client.query(
          'SELECT * FROM producto_variantes WHERE id=$1 AND producto_id=$2 AND activo=true',
          [it.variante_id, p.id]
        );
        if (!vRes.rows.length) continue; // variante inválida — se ignora el item
        const v = vRes.rows[0];
        if (v.stock < cantidad) continue; // sin stock suficiente en esa variante — se ignora
        varianteId = v.id;
        varianteTexto = textoVariante(v);
        precioUnit = parseFloat(p.precio) + parseFloat(v.precio_extra || 0);
      }

      subtotal += precioUnit * cantidad;
      itemsValidados.push({
        producto_id: p.id, nombre_producto: p.nombre, cantidad, precio_unitario: precioUnit,
        variante_id: varianteId, variante_texto: varianteTexto, kit_id: null, componentes: []
      });
    }
    if (!itemsValidados.length) {
      throw Object.assign(new Error('Ningún producto del pedido está disponible'), { status: 400 });
    }

    const folio = folioPedido();
    const pedido = await client.query(
      `INSERT INTO pedidos_online (negocio_id, sucursal_id, folio, cliente_nombre, cliente_telefono, cliente_email, notas, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, folio`,
      [negocioId, sucursal_id, folio, cliente_nombre.trim(), cliente_telefono, cliente_email, notas, subtotal]
    );
    const pedidoId = pedido.rows[0].id;

    for (const it of itemsValidados) {
      await client.query(
        `INSERT INTO pedido_online_items (pedido_id, producto_id, nombre_producto, cantidad, precio_unitario, variante_id, variante_texto, kit_id, componentes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pedidoId, it.producto_id, it.nombre_producto, it.cantidad, it.precio_unitario, it.variante_id, it.variante_texto,
         it.kit_id || null, JSON.stringify(it.componentes || [])]
      );
    }

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocioId).emit('pedido_online:nuevo', { id: pedidoId, folio, sucursal_id });

    // Notificación push (mismo mecanismo de stock bajo / lotes)
    try {
      const { enviarASucursal } = require('./push');
      if (enviarASucursal) {
        await enviarASucursal(sucursal_id, negocioId, {
          title: '🛍️ Nuevo pedido en línea',
          body: cliente_nombre.trim() + ' — folio ' + folio,
          tag: 'pedido_online'
        });
      }
    } catch(e) {}

    res.json({ ok: true, folio, id: pedidoId, subtotal });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = { router, ensureTiendaTables, asignarSlug };
