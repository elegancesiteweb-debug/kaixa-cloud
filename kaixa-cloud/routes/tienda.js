// routes/tienda.js — Tienda en línea pública (sin login) por negocio
// Los pedidos se apartan aquí; se confirman desde la PC o la app móvil
// (ver /api/pedidos-online en routes/api.js), lo que descuenta stock y
// registra la venta — el cliente paga en tienda, no en línea.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');

// ── Promociones vigentes (solo por producto o "todo el inventario") ──
// Las de categoría se evalúan únicamente en el POS: la tabla categorias de
// esta base nunca se llena desde pos-mexico (el sync de productos no manda
// categoria_id), así que no hay forma confiable de saber a qué categoría
// pertenece un producto aquí — aplicar por categoría_nombre podría acertar
// por coincidencia de texto en unos negocios y fallar silenciosamente en
// otros, así que se prefiere no aplicarlas en línea antes que aplicarlas mal.
async function promocionesVigentesNegocio(negocioId) {
  try {
    const r = await pool.query(
      `SELECT * FROM promociones
       WHERE negocio_id=$1 AND activo=true AND categoria_nombre IS NULL
         AND fecha_inicio <= CURRENT_DATE AND fecha_fin >= CURRENT_DATE`,
      [negocioId]
    );
    return r.rows;
  } catch(e) { return []; }
}

function mejorPromoParaProducto(productoId, vigentes) {
  const porProducto = vigentes.filter(p => p.producto_id === productoId);
  const porTodos = vigentes.filter(p => !p.producto_id);
  const candidatas = porProducto.length ? porProducto : porTodos;
  if (!candidatas.length) return null;
  let mejor = null, mejorPct = -1;
  candidatas.forEach(p => {
    const pct = p.tipo === 'pct' ? parseFloat(p.valor) || 0 : 0;
    if (pct > mejorPct) { mejorPct = pct; mejor = p; }
  });
  return candidatas.length === 1 ? candidatas[0] : mejor;
}

// Descuento en pesos que aporta una promo a una línea (cantidad × precio unitario)
function descuentoPromoLinea(precioUnit, cantidad, promo) {
  if (!promo) return 0;
  if (promo.tipo === 'pct') {
    return precioUnit * cantidad * ((parseFloat(promo.valor) || 0) / 100);
  }
  if (promo.tipo === 'nxm') {
    const compra = promo.nxm_compra || 0, paga = promo.nxm_paga || 0;
    if (compra <= 0 || paga <= 0 || paga >= compra || cantidad < compra) return 0;
    const grupos = Math.floor(cantidad / compra);
    const itemsPagados = grupos * paga + (cantidad % compra);
    return Math.max(0, (cantidad - itemsPagados) * precioUnit);
  }
  return 0;
}

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
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS domicilio_habilitado BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS cotizacion_mostrar_fotos BOOLEAN DEFAULT false`);
  // Envíos por paquetería (distinto de "domicilio" — entrega local propia del negocio).
  // Tarifa plana para arrancar; zonas/CP quedan para una pasada futura si se necesita.
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS envio_habilitado BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS envio_costo NUMERIC(10,2) DEFAULT 0`);
  // Mismo interruptor de sub-funciones que routes/modulos-opcionales.js — se
  // asegura aquí también para no depender del orden en que corren las rutas.
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS modulos_opcionales TEXT DEFAULT '[]'`);
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
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS requiere_factura BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS rfc_receptor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS razon_social_receptor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS uso_cfdi TEXT DEFAULT 'G03'`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS pagado_en_linea BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS mp_payment_id TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS tipo_entrega TEXT DEFAULT 'recoger'`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_calle TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_numero TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_colonia TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_ciudad TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_cp TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS direccion_referencias TEXT DEFAULT ''`);
  // tipo_entrega también acepta 'envio' (paquetería) — usa las mismas columnas de dirección de arriba.
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS costo_envio NUMERIC(10,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS guia_rastreo TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS paqueteria TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS enviado_en TIMESTAMPTZ`);
  // Entregas programadas (florería/regalos) — opcional, distinto del envío
  // por paquetería de arriba: es la entrega propia del negocio en una fecha
  // acordada, a veces para alguien distinto de quien compra.
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS fecha_entrega DATE`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS hora_entrega TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS destinatario_nombre TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS destinatario_telefono TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS mensaje_tarjeta TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos_online ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS variante_id UUID`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS variante_texto TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS kit_id UUID`);
  await pool.query(`ALTER TABLE pedido_online_items ADD COLUMN IF NOT EXISTS componentes JSONB DEFAULT '[]'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carritos_abandonados (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id       UUID REFERENCES sucursales(id),
      cliente_nombre    TEXT DEFAULT '',
      cliente_telefono  TEXT DEFAULT '',
      cliente_email     TEXT DEFAULT '',
      items_json        JSONB DEFAULT '[]',
      subtotal          NUMERIC(12,2) DEFAULT 0,
      estado            TEXT DEFAULT 'abierto',
      creado_en         TIMESTAMPTZ DEFAULT now(),
      actualizado_en    TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_carritos_abandonados_negocio ON carritos_abandonados(negocio_id);
  `);
  // Entregas recurrentes de despensa — extensión de "entregas programadas"
  // (mismo flag SUBFUNCIONES.entregas_programadas). El pedido real se genera
  // como una fila normal en pedidos_online cada semana (ver generarPedidosRecurrentes).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_recurrentes (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id            UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id           UUID NOT NULL REFERENCES sucursales(id),
      cliente_nombre        TEXT NOT NULL,
      cliente_telefono      TEXT DEFAULT '',
      dia_semana            INTEGER NOT NULL,
      hora_entrega          TEXT DEFAULT '',
      tipo_entrega          TEXT DEFAULT 'recoger',
      direccion_calle       TEXT DEFAULT '',
      direccion_numero      TEXT DEFAULT '',
      direccion_colonia     TEXT DEFAULT '',
      direccion_ciudad      TEXT DEFAULT '',
      direccion_cp          TEXT DEFAULT '',
      direccion_referencias TEXT DEFAULT '',
      notas                 TEXT DEFAULT '',
      activo                BOOLEAN DEFAULT true,
      ultima_generacion     DATE,
      creado_en             TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pedido_recurrente_items (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pedido_recurrente_id   UUID NOT NULL REFERENCES pedidos_recurrentes(id) ON DELETE CASCADE,
      producto_id            UUID NOT NULL REFERENCES productos(id),
      cantidad               INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_recurrentes_negocio ON pedidos_recurrentes(negocio_id, sucursal_id);
  `);
  const sinSlug = await pool.query("SELECT id, nombre FROM negocios WHERE slug IS NULL OR slug=''");
  for (const n of sinSlug.rows) { await asignarSlug(n.id, n.nombre); }
}

// ── Genera los pedidos_online de la semana para cada plantilla recurrente ──
// cuyo día_semana coincide con hoy (horario de México) y que no se haya
// generado ya hoy. Se llama periódicamente desde server.js.
async function generarPedidosRecurrentes(io) {
  try {
    await ensureTiendaTables();
    const plantillas = await pool.query(`
      SELECT * FROM pedidos_recurrentes
      WHERE activo=true
        AND dia_semana = EXTRACT(DOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
        AND (ultima_generacion IS NULL OR ultima_generacion < (now() AT TIME ZONE 'America/Mexico_City')::date)
    `);
    for (const pl of plantillas.rows) {
      try {
        const neg = await pool.query('SELECT modulos_opcionales FROM negocios WHERE id=$1', [pl.negocio_id]);
        if (!neg.rows.length) continue;
        let modulos = [];
        try { modulos = JSON.parse(neg.rows[0].modulos_opcionales || '[]'); } catch(e) {}
        if (!modulos.includes('entregas_programadas')) continue;

        const itemsPlantilla = await pool.query(
          'SELECT producto_id, cantidad FROM pedido_recurrente_items WHERE pedido_recurrente_id=$1',
          [pl.id]
        );
        const itemsValidados = [];
        let subtotal = 0;
        for (const it of itemsPlantilla.rows) {
          const prod = await pool.query(
            'SELECT id, nombre, precio FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
            [it.producto_id, pl.negocio_id, pl.sucursal_id]
          );
          if (!prod.rows.length) continue;
          const p = prod.rows[0];
          const precioUnit = parseFloat(p.precio);
          subtotal += precioUnit * it.cantidad;
          itemsValidados.push({ producto_id: p.id, nombre_producto: p.nombre, cantidad: it.cantidad, precio_unitario: precioUnit });
        }
        if (!itemsValidados.length) continue;

        const folio = folioPedido();
        const notas = 'Pedido recurrente automático' + (pl.notas ? ' — ' + pl.notas : '');
        const pedido = await pool.query(
          `INSERT INTO pedidos_online (negocio_id, sucursal_id, folio, cliente_nombre, cliente_telefono, notas, subtotal,
            tipo_entrega, direccion_calle, direccion_numero, direccion_colonia, direccion_ciudad, direccion_cp, direccion_referencias,
            fecha_entrega, hora_entrega)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,(now() AT TIME ZONE 'America/Mexico_City')::date,$15)
           RETURNING id, folio`,
          [pl.negocio_id, pl.sucursal_id, folio, pl.cliente_nombre, pl.cliente_telefono, notas, subtotal,
           pl.tipo_entrega, pl.direccion_calle, pl.direccion_numero, pl.direccion_colonia, pl.direccion_ciudad, pl.direccion_cp, pl.direccion_referencias,
           pl.hora_entrega]
        );
        const pedidoId = pedido.rows[0].id;
        for (const it of itemsValidados) {
          await pool.query(
            `INSERT INTO pedido_online_items (pedido_id, producto_id, nombre_producto, cantidad, precio_unitario)
             VALUES ($1,$2,$3,$4,$5)`,
            [pedidoId, it.producto_id, it.nombre_producto, it.cantidad, it.precio_unitario]
          );
        }
        await pool.query(
          `UPDATE pedidos_recurrentes SET ultima_generacion = (now() AT TIME ZONE 'America/Mexico_City')::date WHERE id=$1`,
          [pl.id]
        );

        if (io) io.to('negocio:' + pl.negocio_id).emit('pedido_online:nuevo', { id: pedidoId, folio, sucursal_id: pl.sucursal_id });
        if (pl.cliente_telefono) {
          try {
            const { enviarWhatsapp } = require('./whatsapp');
            enviarWhatsapp(pl.negocio_id, pl.cliente_telefono,
              'Hola ' + pl.cliente_nombre + ', tu pedido recurrente de esta semana ya fue registrado — folio ' + folio
            ).catch(() => {});
          } catch(e) {}
        }
      } catch(e) { console.error('⚠️ generarPedidosRecurrentes (plantilla ' + pl.id + '):', e.message); }
    }
  } catch(e) { console.error('⚠️ generarPedidosRecurrentes:', e.message); }
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
    try { await require('./pagos').ensurePagosTables(); } catch(e) {}
    const neg = await pool.query(
      `SELECT id, nombre, giro_principal, tienda_imagen_url, tienda_descripcion,
              tienda_logo_url, tienda_telefono, tienda_direccion, tienda_horario,
              COALESCE(tienda_mostrar_kits,false) AS tienda_mostrar_kits,
              COALESCE(domicilio_habilitado,false) AS domicilio_habilitado,
              COALESCE(envio_habilitado,false) AS envio_habilitado,
              COALESCE(envio_costo,0) AS envio_costo,
              (mp_access_token IS NOT NULL AND mp_access_token != '') AS mp_habilitado,
              COALESCE(modulos_opcionales::jsonb ? 'entregas_programadas', false) AS entregas_habilitado
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
      SELECT p.id, p.nombre, p.emoji, p.imagen_url, p.imagenes_extra, p.precio, p.categoria_id, c.nombre AS categoria_nombre,
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

    // Adjuntar promociones vigentes (solo por producto o "todo el inventario" — ver comentario en promocionesVigentesNegocio)
    const promosVigentes = await promocionesVigentesNegocio(neg.rows[0].id);
    if (promosVigentes.length) {
      productos.forEach(p => {
        const promo = mejorPromoParaProducto(p.id, promosVigentes);
        if (!promo) return;
        p.promocion = { nombre: promo.nombre, tipo: promo.tipo, valor: promo.valor, nxm_compra: promo.nxm_compra, nxm_paga: promo.nxm_paga };
        if (promo.tipo === 'pct') {
          p.precio_original = p.precio;
          p.precio = parseFloat((parseFloat(p.precio) * (1 - (parseFloat(promo.valor)||0)/100)).toFixed(2));
        }
      });
    }

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
      // especificaciones es solo para consulta interna del negocio (ver
      // routes/variantes.js) — no se manda a la tienda pública.
      vr.rows.forEach(v => { delete v.especificaciones; (porProducto[v.producto_id] = porProducto[v.producto_id] || []).push(v); });
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
    const {
      sucursal_id, cliente_nombre, cliente_telefono='', cliente_email='', notas='', items=[],
      requiere_factura=false, rfc_receptor='', razon_social_receptor='', uso_cfdi='G03',
      tipo_entrega='recoger', direccion_calle='', direccion_numero='', direccion_colonia='',
      direccion_ciudad='', direccion_cp='', direccion_referencias='',
      fecha_entrega=null, hora_entrega='', destinatario_nombre='', destinatario_telefono='', mensaje_tarjeta=''
    } = req.body;
    if (!sucursal_id) return res.status(400).json({ error: 'Falta la sucursal' });
    if (!cliente_nombre || !cliente_nombre.trim()) return res.status(400).json({ error: 'Falta tu nombre' });
    if (!items.length) return res.status(400).json({ error: 'El pedido está vacío' });
    if ((tipo_entrega === 'domicilio' || tipo_entrega === 'envio') && (!direccion_calle.trim() || !direccion_colonia.trim())) {
      return res.status(400).json({ error: 'Falta la dirección de entrega' });
    }

    const neg = await pool.query('SELECT id, envio_habilitado, envio_costo FROM negocios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const negocioId = neg.rows[0].id;
    if (tipo_entrega === 'envio' && !neg.rows[0].envio_habilitado) {
      return res.status(400).json({ error: 'Este negocio no ofrece envío por paquetería' });
    }
    const costoEnvio = tipo_entrega === 'envio' ? parseFloat(neg.rows[0].envio_costo) || 0 : 0;

    const suc = await pool.query(
      'SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2 AND activo=true',
      [sucursal_id, negocioId]
    );
    if (!suc.rows.length) return res.status(404).json({ error: 'Sucursal no válida' });

    await client.query('BEGIN');

    // Promociones vigentes de este negocio, evaluadas una sola vez para todo el pedido
    const promosVigentes = await promocionesVigentesNegocio(negocioId);
    let descuentoPromoTotal = 0;

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
      // Las promociones aplican sobre el producto base, no sobre variantes con
      // precio_extra distinto — igual que en el POS, se evalúan por producto_id.
      const promo = mejorPromoParaProducto(p.id, promosVigentes);
      if (promo) descuentoPromoTotal += descuentoPromoLinea(precioUnit, cantidad, promo);
      itemsValidados.push({
        producto_id: p.id, nombre_producto: p.nombre, cantidad, precio_unitario: precioUnit,
        variante_id: varianteId, variante_texto: varianteTexto, kit_id: null, componentes: []
      });
    }
    if (!itemsValidados.length) {
      throw Object.assign(new Error('Ningún producto del pedido está disponible'), { status: 400 });
    }
    subtotal = Math.max(subtotal - descuentoPromoTotal, 0);

    const folio = folioPedido();
    const pedido = await client.query(
      `INSERT INTO pedidos_online (negocio_id, sucursal_id, folio, cliente_nombre, cliente_telefono, cliente_email, notas, subtotal,
        requiere_factura, rfc_receptor, razon_social_receptor, uso_cfdi,
        tipo_entrega, direccion_calle, direccion_numero, direccion_colonia, direccion_ciudad, direccion_cp, direccion_referencias, costo_envio,
        fecha_entrega, hora_entrega, destinatario_nombre, destinatario_telefono, mensaje_tarjeta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id, folio`,
      [negocioId, sucursal_id, folio, cliente_nombre.trim(), cliente_telefono, cliente_email, notas, subtotal,
       !!requiere_factura, rfc_receptor, razon_social_receptor, uso_cfdi,
       tipo_entrega, direccion_calle, direccion_numero, direccion_colonia, direccion_ciudad, direccion_cp, direccion_referencias, costoEnvio,
       fecha_entrega || null, hora_entrega, destinatario_nombre, destinatario_telefono, mensaje_tarjeta]
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

    // El pedido se completó — si había un carrito abandonado con el mismo
    // teléfono aún abierto, ya no hace falta seguirle: se marca convertido.
    if (cliente_telefono) {
      try {
        await pool.query(
          `UPDATE carritos_abandonados SET estado='convertido', actualizado_en=now()
           WHERE negocio_id=$1 AND cliente_telefono=$2 AND estado='abierto'`,
          [negocioId, cliente_telefono]
        );
      } catch(e) {}
    }

    res.json({ ok: true, folio, id: pedidoId, subtotal, costo_envio: costoEnvio, descuento_promo: descuentoPromoTotal });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/tienda/:slug/pagar — genera link de pago con tarjeta para un pedido ya creado ──
router.post('/tienda/:slug/pagar', async (req, res) => {
  try {
    try { await require('./pagos').ensurePagosTables(); } catch(e) {}
    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ error: 'Falta pedido_id' });
    const neg = await pool.query(
      `SELECT n.id, n.mp_access_token FROM negocios n WHERE n.slug=$1 AND n.activo=true`, [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const negocio = neg.rows[0];
    if (!negocio.mp_access_token) return res.status(400).json({ error: 'Esta tienda no acepta pago en línea todavía' });

    const ped = await pool.query(
      `SELECT id, folio, subtotal FROM pedidos_online WHERE id=$1 AND negocio_id=$2`,
      [pedido_id, negocio.id]);
    if (!ped.rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const pedido = ped.rows[0];

    const host = req.protocol + '://' + req.get('host');
    const { mpRequest } = require('./pagos');
    const r = await mpRequest('POST', '/checkout/preferences', {
      items: [{ title: 'Pedido ' + pedido.folio, quantity: 1, unit_price: parseFloat(pedido.subtotal), currency_id: 'MXN' }],
      external_reference: 'pedido:' + pedido.id,
      notification_url: host + '/api/pagos/mp/webhook/' + negocio.id,
      back_urls: { success: host + '/tienda/' + req.params.slug, failure: host + '/tienda/' + req.params.slug, pending: host + '/tienda/' + req.params.slug }
    }, negocio.mp_access_token);

    if (r.status !== 200 && r.status !== 201) {
      return res.status(400).json({ error: 'Error de Mercado Pago: ' + (r.data && r.data.message || JSON.stringify(r.data)) });
    }
    res.json({ ok: true, init_point: r.data.init_point });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tienda/:slug/carrito-abandonado — guarda un carrito en curso ──
// Se llama (con debounce) mientras el cliente escribe sus datos en el
// checkout pero aún no envía el pedido — así el negocio puede darle
// seguimiento por WhatsApp si lo deja a medias.
router.post('/tienda/:slug/carrito-abandonado', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { sucursal_id, cliente_nombre = '', cliente_telefono = '', cliente_email = '', items = [], subtotal = 0 } = req.body;
    const telLimpio = (cliente_telefono || '').replace(/\D/g, '');
    if (telLimpio.length < 10 || !items.length) return res.json({ ok: true, guardado: false });

    const neg = await pool.query('SELECT id FROM negocios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!neg.rows.length) return res.status(404).json({ error: 'Tienda no encontrada' });
    const negocioId = neg.rows[0].id;

    const existente = await pool.query(
      `SELECT id FROM carritos_abandonados
       WHERE negocio_id=$1 AND cliente_telefono=$2 AND estado='abierto'
       ORDER BY actualizado_en DESC LIMIT 1`,
      [negocioId, telLimpio]
    );
    if (existente.rows.length) {
      await pool.query(
        `UPDATE carritos_abandonados SET cliente_nombre=$1, cliente_email=$2, items_json=$3, subtotal=$4, actualizado_en=now()
         WHERE id=$5`,
        [cliente_nombre, cliente_email, JSON.stringify(items), subtotal, existente.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO carritos_abandonados (negocio_id, sucursal_id, cliente_nombre, cliente_telefono, cliente_email, items_json, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [negocioId, sucursal_id || null, cliente_nombre, telLimpio, cliente_email, JSON.stringify(items), subtotal]
      );
    }
    res.json({ ok: true, guardado: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, ensureTiendaTables, asignarSlug, generarPedidosRecurrentes };
