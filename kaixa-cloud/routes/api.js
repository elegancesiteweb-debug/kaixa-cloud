// routes/api.js — Rutas que usan las CAJAS EXTRA (siempre conectadas)
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
const { crearVentaCompletada } = require('./ventas-shared');
function uuid() { return crypto.randomUUID(); }

let _clientesFiadoColOk = false;
async function ensureClientesFiadoColumns() {
  if (_clientesFiadoColOk) return;
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_proximo_pago DATE`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS frecuencia_pago TEXT DEFAULT 'mensual'`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS es_mayorista BOOLEAN DEFAULT false`);
  _clientesFiadoColOk = true;
}

let _pedidoItemsRecepcionColOk = false;
async function ensurePedidoItemsRecepcionColumn() {
  if (_pedidoItemsRecepcionColOk) return;
  await pool.query(`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS cantidad_recibida INTEGER DEFAULT 0`);
  _pedidoItemsRecepcionColOk = true;
}

let _ventasFechaPagoColOk = false;
async function ensureVentasFechaPagoColumn() {
  if (_ventasFechaPagoColOk) return;
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_pago DATE`);
  _ventasFechaPagoColOk = true;
}

// Los apartados en sí viven solo en la PC de cada sucursal (no se comparten
// entre sucursales) — esta tabla es solo un espejo ligero para que el
// sistema de alertas (que corre en la nube) sepa que hay un cobro pendiente
// y pueda avisar al cliente.
let _apartadosRecordatorioOk = false;
async function ensureApartadosRecordatorioTable() {
  if (_apartadosRecordatorioOk) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apartados_recordatorio (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id         UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id        UUID NOT NULL REFERENCES sucursales(id),
      apartado_local_id  INTEGER NOT NULL,
      cliente_nombre     TEXT DEFAULT '',
      cliente_telefono   TEXT DEFAULT '',
      folio              TEXT DEFAULT '',
      saldo              NUMERIC(12,2) DEFAULT 0,
      fecha_pago         DATE,
      activo             BOOLEAN DEFAULT true,
      actualizado_en     TIMESTAMPTZ DEFAULT now(),
      UNIQUE(sucursal_id, apartado_local_id)
    );
  `);
  _apartadosRecordatorioOk = true;
}

// ── GET /api/productos ─────────────────────────────────────────
router.get('/productos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { giro, q } = req.query;
    let sql = `
      SELECT p.id, p.negocio_id, p.sucursal_id, p.nombre, p.emoji, p.codigo_barras,
             p.precio, p.costo, p.stock_minimo, p.categoria_id, p.giro, p.por_peso,
             p.unidad_peso, p.tiene_prescripcion, p.activo, p.creado_en, p.actualizado_en,
             CASE WHEN p.imagen_url IS NOT NULL AND p.imagen_url != '' THEN true ELSE false END as tiene_imagen,
             p.imagen_url, p.imagenes_extra,
             COALESCE(s.stock,0) AS stock, c.nombre AS categoria_nombre, c.emoji AS categoria_emoji
      FROM productos p
      LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = $2
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id = $1
        AND p.sucursal_id = $2
        AND p.activo = true`;
    const params = [negocio_id, sucursal_id];
    if (giro) { params.push(giro); sql += ` AND p.giro = $${params.length}`; }
    if (q)    { params.push('%'+q+'%'); sql += ` AND (p.nombre ILIKE $${params.length} OR p.codigo_barras ILIKE $${params.length})`; }
    sql += ' ORDER BY p.nombre';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/productos ─────────────────────────────────────────
router.post('/productos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const p = req.body;
    const id = uuid();
    await pool.query(
      `INSERT INTO productos (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
        stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, negocio_id, sucursal_id, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
       p.precio||0, p.costo||0, p.stock_minimo||5, p.categoria_id||null, p.giro||'tienda',
       !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion]
    );
    // Registrar stock inicial — acepta stock_inicial o stock
    const stockInicial = parseInt(p.stock_inicial || p.stock || 0);
    if (stockInicial > 0) {
      await pool.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
         VALUES ($1,$2,$3,$4,$5,$6,'recepcion')`,
        [uuid(), negocio_id, sucursal_id, id, req.caja.id, stockInicial]
      );
    }
    broadcast(req, 'productos:nuevo', { id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/productos/:id ─────────────────────────────────────
// ── GET /api/productos/:id/imagen ─────────────────────────────────────────
router.get('/productos/:id/imagen', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT imagen_url FROM productos WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]
    );
    if (!r.rows.length) return res.json({ imagen_url: null });
    res.json({ imagen_url: r.rows[0].imagen_url || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/productos/:id/imagen ──────────────────────────────────────────
router.put('/productos/:id/imagen', async (req, res) => {
  try {
    const { imagen_url } = req.body;
    console.log('PUT imagen:', req.params.id, 'body keys:', Object.keys(req.body||{}), 'img len:', imagen_url?.length||0, 'content-type:', req.headers['content-type']);
    if (!imagen_url) return res.status(400).json({ error: 'imagen_url requerida' });
    await pool.query(
      'UPDATE productos SET imagen_url=$1, actualizado_en=now() WHERE id=$2 AND negocio_id=$3',
      [imagen_url, req.params.id, req.caja.negocio_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/productos/:id/imagenes-extra — fotos adicionales del producto ──
// (imagen_url sigue siendo la portada; este arreglo son las fotos extra que
// se ven al deslizar/abrir la galería, tope de 4 validado también en el cliente)
router.put('/productos/:id/imagenes-extra', async (req, res) => {
  try {
    const { imagenes_extra } = req.body;
    if (!Array.isArray(imagenes_extra)) return res.status(400).json({ error: 'imagenes_extra debe ser un arreglo' });
    await pool.query(
      'UPDATE productos SET imagenes_extra=$1, actualizado_en=now() WHERE id=$2 AND negocio_id=$3',
      [JSON.stringify(imagenes_extra.slice(0,4)), req.params.id, req.caja.negocio_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/productos/:id', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const p = req.body;
    await pool.query(
      `UPDATE productos SET nombre=$1, emoji=$2,
        imagen_url=COALESCE(NULLIF($3,''), imagen_url),
        codigo_barras=$4, precio=$5,
        costo=$6, stock_minimo=$7, categoria_id=$8, por_peso=$9, unidad_peso=$10,
        tiene_prescripcion=$11, actualizado_en=now()
       WHERE id=$12 AND negocio_id=$13`,
      [p.nombre, p.emoji, p.imagen_url||'', p.codigo_barras||'', p.precio, p.costo, p.stock_minimo,
       p.categoria_id||null, !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion,
       req.params.id, negocio_id]
    );
    // Si viene stock, registrar movimiento de ajuste
    if (p.stock !== undefined) {
      const stockNuevo = parseInt(p.stock) || 0;
      const stockActual = await pool.query(
        `SELECT COALESCE(SUM(cantidad),0) as stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2`,
        [req.params.id, sucursal_id]
      );
      const stockActualNum = parseInt(stockActual.rows[0].stock) || 0;
      const diferencia = stockNuevo - stockActualNum;
      if (diferencia !== 0) {
        await pool.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
           VALUES ($1,$2,$3,$4,$5,$6,'ajuste')`,
          [uuid(), negocio_id, sucursal_id, req.params.id, req.caja.id, diferencia]
        );
        // Tocar actualizado_en para que el pull de la PC recoja el cambio de stock
        await pool.query(
          `UPDATE productos SET actualizado_en=now() WHERE id=$1`,
          [req.params.id]
        );
      }
    }
    broadcast(req, 'productos:editado', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/productos/:id ──────────────────────────────────
router.delete('/productos/:id', async (req, res) => {
  try {
    await pool.query('UPDATE productos SET activo=false, actualizado_en=now() WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/clientes ──────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  try {
    await ensureClientesFiadoColumns();
    const { negocio_id } = req.caja;
    const { q } = req.query;
    let sql = `SELECT id, negocio_id, nombre, telefono, email, rfc, giro, puntos, saldo, foto, activo,
               fecha_proximo_pago, frecuencia_pago, es_mayorista, creado_en, actualizado_en
               FROM clientes WHERE negocio_id=$1 AND activo=true`;
    const params = [negocio_id];
    if (q) { params.push('%'+q+'%'); sql += ` AND nombre ILIKE $${params.length}`; }
    sql += ' ORDER BY nombre';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/clientes/:id/foto ─────────────────────────────────
router.get('/clientes/:id/foto', async (req, res) => {
  try {
    const r = await pool.query('SELECT foto FROM clientes WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    if (!r.rows.length || !r.rows[0].foto) return res.json({ foto: null });
    res.json({ foto: r.rows[0].foto });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/clientes ─────────────────────────────────────────
router.post('/clientes', async (req, res) => {
  try {
    await ensureClientesFiadoColumns();
    const { negocio_id } = req.caja;
    const c = req.body;
    const id = uuid();
    await pool.query(
      `INSERT INTO clientes (id, negocio_id, nombre, telefono, email, rfc, giro, activo, es_mayorista)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
      [id, negocio_id, c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.giro||'tienda', !!c.es_mayorista]
    );
    broadcast(req, 'clientes:nuevo', { id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/clientes/:id ──────────────────────────────────────
router.put('/clientes/:id', async (req, res) => {
  try {
    await ensureClientesFiadoColumns();
    const c = req.body;
    const updateFields = [c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.puntos||0, c.saldo||0];
    let updateSql = `UPDATE clientes SET nombre=$1, telefono=$2, email=$3, rfc=$4, puntos=$5, saldo=$6`;
    if (c.foto !== undefined) {
      updateFields.push(c.foto);
      updateSql += `, foto=$${updateFields.length}`;
    }
    if (c.fecha_proximo_pago !== undefined) {
      updateFields.push(c.fecha_proximo_pago || null);
      updateSql += `, fecha_proximo_pago=$${updateFields.length}`;
    }
    if (c.frecuencia_pago !== undefined) {
      updateFields.push(c.frecuencia_pago || 'mensual');
      updateSql += `, frecuencia_pago=$${updateFields.length}`;
    }
    if (c.es_mayorista !== undefined) {
      updateFields.push(!!c.es_mayorista);
      updateSql += `, es_mayorista=$${updateFields.length}`;
    }
    updateFields.push(req.params.id, req.caja.negocio_id);
    updateSql += `, actualizado_en=now() WHERE id=$${updateFields.length-1} AND negocio_id=$${updateFields.length}`;
    await pool.query(updateSql, updateFields);
    broadcast(req, 'clientes:editado', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ventas ───────────────────────────────────────────
router.post('/ventas', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const v = req.body;
  if (!v.items || !v.items.length) return res.status(400).json({ error: 'La venta debe tener productos' });
  const client = await pool.connect();
  try {
    await ensureVentasFechaPagoColumn();
    await client.query('BEGIN');
    // Usar giro del negocio (desde auth) en lugar del que manda el cliente
    const giroReal = req.caja.giro || v.giro || 'tienda';
    const { ventaId, folio, total } = await crearVentaCompletada(client, {
      negocio_id, sucursal_id, caja_id, giroReal, v, saltarStock: false
    });
    await client.query('COMMIT');
    broadcast(req, 'venta:nueva', { id: ventaId, folio, total, caja_id });
    res.json({ ok: true, id: ventaId, folio, total });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ventas ────────────────────────────────────────────
router.get('/ventas', async (req, res) => {
  try {
    await ensureVentasFechaPagoColumn();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT v.*, s.nombre AS sucursal_nombre, c.nombre AS caja_nombre
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       LEFT JOIN cajas c ON c.id = v.caja_id
       WHERE v.negocio_id=$1 AND v.sucursal_id=$2 ORDER BY v.creado_en DESC LIMIT 200`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ventas/:id ────────────────────────────────────────
router.get('/ventas/:id', async (req, res) => {
  try {
    const v = await pool.query('SELECT * FROM ventas WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    if (!v.rows.length) return res.status(404).json({ error: 'No encontrada' });
    const items = await pool.query('SELECT * FROM venta_detalle WHERE venta_id=$1', [req.params.id]);
    res.json({ ...v.rows[0], items: items.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/ventas/:id/fecha-pago ─────────────────────────────
// Fecha de vencimiento de UNA venta fiada en particular (no del cliente).
router.put('/ventas/:id/fecha-pago', async (req, res) => {
  try {
    await ensureVentasFechaPagoColumn();
    await pool.query('UPDATE ventas SET fecha_pago=$1 WHERE id=$2 AND negocio_id=$3',
      [req.body.fecha_pago || null, req.params.id, req.caja.negocio_id]);
    broadcast(req, 'venta:editada', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/clientes/:id/creditos — fiado del cliente EN TODAS LAS SUCURSALES ──
// A diferencia de la PC (que solo ve su propia base local), esto vive en la
// nube y no filtra por sucursal — así un cliente puede deber en la Sucursal A
// y pagar en la Sucursal B sin problema.
router.get('/clientes/:id/creditos', async (req, res) => {
  try {
    await ensureVentasFechaPagoColumn();
    const r = await pool.query(
      `SELECT v.id, v.folio, v.total, v.forma_pago, v.estado, v.creado_en, v.fecha_pago,
              v.sucursal_id, s.nombre AS sucursal_nombre
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       WHERE v.negocio_id=$1 AND v.cliente_id=$2 AND v.forma_pago='credito' AND v.estado='completada'
       ORDER BY v.creado_en ASC`,
      [req.caja.negocio_id, req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cobros-pendientes — fiados y apartados con fecha de pago próxima o vencida ──
router.get('/cobros-pendientes', async (req, res) => {
  try {
    await ensureVentasFechaPagoColumn();
    await ensureApartadosRecordatorioTable();
    const fiados = await pool.query(
      `SELECT v.id, v.folio, v.total, v.fecha_pago, v.sucursal_id, s.nombre AS sucursal_nombre,
              c.id AS cliente_id, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       JOIN clientes c ON c.id = v.cliente_id
       WHERE v.negocio_id=$1 AND v.forma_pago='credito' AND v.estado='completada'
         AND v.fecha_pago IS NOT NULL
       ORDER BY v.fecha_pago ASC`,
      [req.caja.negocio_id]
    );
    const apartados = await pool.query(
      `SELECT ar.apartado_local_id AS id, ar.folio, ar.saldo, ar.fecha_pago, ar.sucursal_id,
              s.nombre AS sucursal_nombre, ar.cliente_nombre, ar.cliente_telefono
       FROM apartados_recordatorio ar
       JOIN sucursales s ON s.id = ar.sucursal_id
       WHERE ar.negocio_id=$1 AND ar.activo=true AND ar.fecha_pago IS NOT NULL
       ORDER BY ar.fecha_pago ASC`,
      [req.caja.negocio_id]
    );
    res.json({ fiados: fiados.rows, apartados: apartados.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/ventas/:id/liquidar — marca un fiado como pagado, desde cualquier sucursal ──
router.put('/ventas/:id/liquidar', async (req, res) => {
  try {
    const v = await pool.query(
      `SELECT * FROM ventas WHERE id=$1 AND negocio_id=$2`,
      [req.params.id, req.caja.negocio_id]
    );
    if (!v.rows.length) return res.status(404).json({ error: 'Venta no encontrada' });
    if (v.rows[0].forma_pago !== 'credito') return res.status(400).json({ error: 'Esta venta no es a crédito' });
    const { forma_pago = 'efectivo' } = req.body;
    await pool.query(
      `UPDATE ventas SET forma_pago=$1 WHERE id=$2 AND negocio_id=$3`,
      [forma_pago, req.params.id, req.caja.negocio_id]
    );
    broadcast(req, 'venta:editada', { id: req.params.id });
    res.json({ ok: true, mensaje: 'Venta liquidada correctamente', folio: v.rows[0].folio });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/ventas/:id/cancelar ──────────────────────────────
router.put('/ventas/:id/cancelar', async (req, res) => {
  try {
    await pool.query("UPDATE ventas SET estado='cancelada' WHERE id=$1 AND negocio_id=$2",
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function broadcast(req, evento, data) {
  const io = req.app.get('io');
  if (io) io.to('negocio:' + req.caja.negocio_id).emit(evento, data);
}

// ═══════════════════════════════════════════════════════════
// EMPLEADOS
// ═══════════════════════════════════════════════════════════
// GET /empleados, GET /empleados/:id, POST /empleados y PUT /empleados/:id
// viven en server.js (registradas ahí antes de montar este router, así que
// esas cuatro son las que realmente corren) — solo quedan aquí las rutas
// de entrada/salida del checador, que no tienen equivalente en server.js.
router.post('/empleados/:id/entrada', async (req, res) => {
  try {
    await pool.query('UPDATE empleados SET ultima_entrada=NOW(), ultima_salida=NULL WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/empleados/:id/salida', async (req, res) => {
  try {
    await pool.query('UPDATE empleados SET ultima_salida=NOW() WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// POST /auth/login vive en server.js (registrada ahí antes de montar este
// router, es la que realmente corre) — se quitó la copia muerta de aquí.

// ═══════════════════════════════════════════════════════════
// NOTIFICACIONES (campana dentro de la app)
// ═══════════════════════════════════════════════════════════
router.get('/notificaciones', async (req, res) => {
  try {
    const { sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT * FROM notificaciones WHERE sucursal_id=$1 ORDER BY creado_en DESC LIMIT 50`,
      [sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/notificaciones/:id/leida', async (req, res) => {
  try {
    await pool.query('UPDATE notificaciones SET leida=true WHERE id=$1 AND sucursal_id=$2',
      [req.params.id, req.caja.sucursal_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/notificaciones/marcar-todas-leidas', async (req, res) => {
  try {
    await pool.query('UPDATE notificaciones SET leida=true WHERE sucursal_id=$1 AND leida=false',
      [req.caja.sucursal_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOTES
// ═══════════════════════════════════════════════════════════
router.get('/lotes', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT l.*, p.nombre AS nombre_producto, p.emoji AS producto_emoji, p.imagen_url AS producto_imagen_url,
        CASE WHEN l.fecha_caducidad IS NULL THEN NULL
          ELSE (l.fecha_caducidad::date - CURRENT_DATE)
        END AS dias_restantes
       FROM lotes l
       LEFT JOIN productos p ON p.id::text = l.producto_id::text
       WHERE l.negocio_id=$1 AND (l.sucursal_id=$2 OR l.sucursal_id IS NULL) AND l.activo=true
       ORDER BY l.fecha_caducidad ASC NULLS LAST`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/lotes/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM lotes WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/lotes', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad } = req.body;
    if (!numero_lote) return res.status(400).json({ error: 'Número de lote requerido' });
    const r = await pool.query(
      `INSERT INTO lotes (negocio_id, sucursal_id, producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [negocio_id, sucursal_id, producto_id||null, nombre_producto||'', numero_lote, parseInt(cantidad)||0, fecha_caducidad||null]
    );
    res.json({ ok: true, lote: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.put('/lotes/:id', async (req, res) => {
  try {
    const { numero_lote, cantidad, fecha_caducidad } = req.body;
    await pool.query('UPDATE lotes SET numero_lote=$1, cantidad=$2, fecha_caducidad=$3, actualizado_en=NOW() WHERE id=$4',
      [numero_lote, parseInt(cantidad)||0, fecha_caducidad||null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query('UPDATE lotes SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// PEDIDOS
// ═══════════════════════════════════════════════════════════
router.get('/pedidos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    await ensurePedidoItemsRecepcionColumn();
    const r = await pool.query(
      `SELECT p.*, json_agg(pi.*) FILTER(WHERE pi.id IS NOT NULL) as items
       FROM pedidos p LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
       WHERE p.negocio_id=$1 AND (p.sucursal_id=$2 OR p.sucursal_id IS NULL)
       GROUP BY p.id ORDER BY p.creado_en DESC LIMIT 50`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/pedidos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { proveedor_id, proveedor_nombre, items=[], notas='' } = req.body;
    const total = items.reduce((s, i) => s + (i.cantidad * i.costo_unitario), 0);
    const r = await pool.query(
      `INSERT INTO pedidos (negocio_id, sucursal_id, proveedor_id, proveedor_nombre, total, notas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [negocio_id, sucursal_id, proveedor_id||null, proveedor_nombre||'', total, notas]
    );
    const pedidoId = r.rows[0].id;
    for (const item of items) {
      await pool.query(
        `INSERT INTO pedido_items (pedido_id, producto_id, nombre_producto, cantidad, costo_unitario, subtotal) VALUES ($1,$2,$3,$4,$5,$6)`,
        [pedidoId, item.producto_id||null, item.nombre_producto||'', item.cantidad||1, item.costo_unitario||0, (item.cantidad||1)*(item.costo_unitario||0)]
      );
    }
    res.json({ ok: true, id: pedidoId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// PUT /pedidos/:id/recibir — recibir mercancía (total o parcial).
// body opcional: { items: [{ id, cantidad_recibida }] } — sin body, recibe
// todo de un jalón (comportamiento anterior). Solo mueve stock_movimientos
// por el delta desde la última recepción de cada renglón, para no duplicar
// el stock si el pedido se recibe en varias entregas.
router.put('/pedidos/:id/recibir', async (req, res) => {
  try {
    const { negocio_id, sucursal_id, id: caja_id } = req.caja;
    await ensurePedidoItemsRecepcionColumn();
    const pedido = await pool.query('SELECT estado FROM pedidos WHERE id=$1 AND negocio_id=$2', [req.params.id, negocio_id]);
    if (!pedido.rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.rows[0].estado === 'recibido') return res.status(400).json({ error: 'Ya fue recibido' });

    const detalle = await pool.query('SELECT * FROM pedido_items WHERE pedido_id=$1', [req.params.id]);
    const { items } = req.body || {};
    const cantidadPorId = {};
    if (Array.isArray(items) && items.length) {
      items.forEach(i => { cantidadPorId[i.id] = Math.max(0, parseInt(i.cantidad_recibida) || 0); });
    } else {
      detalle.rows.forEach(d => { cantidadPorId[d.id] = d.cantidad; });
    }

    let completo = true;
    for (const item of detalle.rows) {
      const nuevaRecibida = Math.min(item.cantidad, cantidadPorId.hasOwnProperty(item.id) ? cantidadPorId[item.id] : (item.cantidad_recibida || 0));
      const delta = nuevaRecibida - (item.cantidad_recibida || 0);
      if (delta !== 0 && item.producto_id) {
        await pool.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'recepcion')`,
          [negocio_id, sucursal_id, item.producto_id, caja_id, delta]
        );
        await pool.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [item.producto_id]);
      }
      await pool.query('UPDATE pedido_items SET cantidad_recibida=$1 WHERE id=$2', [nuevaRecibida, item.id]);
      if (nuevaRecibida < item.cantidad) completo = false;
    }

    const nuevoEstado = completo ? 'recibido' : 'parcial';
    await pool.query("UPDATE pedidos SET estado=$1, actualizado_en=NOW() WHERE id=$2", [nuevoEstado, req.params.id]);
    res.json({ ok: true, estado: nuevoEstado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CORTES DE CAJA
// ═══════════════════════════════════════════════════════════
router.get('/caja/resumen', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const hoy = new Date().toISOString().substring(0,10);
    const v = await pool.query(
      `SELECT COUNT(*) AS total_ventas, COALESCE(SUM(total),0) AS total_monto,
              COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total END),0) AS efectivo,
              COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total END),0) AS tarjeta,
              COALESCE(SUM(CASE WHEN forma_pago='transferencia' THEN total END),0) AS transferencia
       FROM ventas WHERE negocio_id=$1 AND sucursal_id=$2 AND DATE(creado_en)=$3 AND estado!='cancelada'`,
      [negocio_id, sucursal_id, hoy]
    );
    const top = await pool.query(
      `SELECT vd.nombre_producto, SUM(vd.cantidad) AS qty, SUM(vd.subtotal) AS monto
       FROM venta_detalle vd JOIN ventas v ON v.id=vd.venta_id
       WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND DATE(v.creado_en)=$3 AND v.estado!='cancelada'
       GROUP BY vd.nombre_producto ORDER BY qty DESC LIMIT 5`,
      [negocio_id, sucursal_id, hoy]
    );
    const d = v.rows[0];
    res.json({
      total_ventas: parseInt(d.total_ventas)||0, total_monto: parseFloat(d.total_monto)||0,
      efectivo: parseFloat(d.efectivo)||0, tarjeta: parseFloat(d.tarjeta)||0,
      transferencia: parseFloat(d.transferencia)||0,
      ticket_promedio: parseInt(d.total_ventas) > 0 ? parseFloat(d.total_monto)/parseInt(d.total_ventas) : 0,
      top_productos: top.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/caja/corte', async (req, res) => {
  try {
    const { negocio_id, sucursal_id, id: caja_id } = req.caja;
    const { tipo='parcial', cajero_nombre='', notas='' } = req.body;
    const hoy = new Date().toISOString().substring(0,10);
    const v = await pool.query(
      `SELECT COUNT(*) AS tv, COALESCE(SUM(total),0) AS monto,
              COALESCE(SUM(CASE WHEN forma_pago='efectivo' THEN total END),0) AS ef,
              COALESCE(SUM(CASE WHEN forma_pago='tarjeta'  THEN total END),0) AS tj,
              COALESCE(SUM(CASE WHEN forma_pago='transferencia' THEN total END),0) AS tr
       FROM ventas WHERE negocio_id=$1 AND sucursal_id=$2 AND DATE(creado_en)=$3 AND estado!='cancelada'`,
      [negocio_id, sucursal_id, hoy]
    );
    const d = v.rows[0];
    const r = await pool.query(
      `INSERT INTO cortes_caja (negocio_id, sucursal_id, caja_id, tipo, total_ventas, total_monto, efectivo, tarjeta, transferencia, cajero_nombre, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [negocio_id, sucursal_id, caja_id, tipo, parseInt(d.tv)||0, parseFloat(d.monto)||0,
       parseFloat(d.ef)||0, parseFloat(d.tj)||0, parseFloat(d.tr)||0, cajero_nombre, notas]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// PROVEEDORES
// ═══════════════════════════════════════════════════════════
router.get('/proveedores', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM proveedores WHERE negocio_id=$1 AND activo=true ORDER BY nombre', [req.caja.negocio_id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/proveedores', async (req, res) => {
  try {
    const { nombre, telefono='', email='' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const r = await pool.query('INSERT INTO proveedores (negocio_id, nombre, telefono, email) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.caja.negocio_id, nombre, telefono, email]);
    res.json({ ok: true, proveedor: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.put('/proveedores/:id', async (req, res) => {
  try {
    const { nombre, telefono='', email='' } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    await pool.query('UPDATE proveedores SET nombre=$1, telefono=$2, email=$3 WHERE id=$4 AND negocio_id=$5',
      [nombre, telefono, email, req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/proveedores/:id', async (req, res) => {
  try {
    await pool.query('UPDATE proveedores SET activo=false WHERE id=$1 AND negocio_id=$2', [req.params.id, req.caja.negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/pedidos/sugeridos?proveedor_id=X&giro=Y — productos en stock mínimo ──
router.get('/pedidos/sugeridos', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { proveedor_id } = req.query;
    const params = [negocio_id, sucursal_id];
    let sql = `
      SELECT p.id, p.nombre, p.emoji, p.costo, p.stock_minimo, p.proveedor_id,
             pv.nombre AS proveedor_nombre, COALESCE(s.stock,0) AS stock
      FROM productos p
      LEFT JOIN proveedores pv ON pv.id = p.proveedor_id
      LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = p.sucursal_id
      WHERE p.negocio_id=$1 AND p.sucursal_id=$2 AND p.activo=true
        AND COALESCE(s.stock,0) <= p.stock_minimo`;
    if (proveedor_id) { params.push(proveedor_id); sql += ` AND p.proveedor_id=$${params.length}`; }
    sql += ' ORDER BY stock ASC';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vincular-licencia (protegido) ────────────────────
// POST /vincular-licencia vive en server.js (registrada ahí antes de montar
// este router, es la que realmente corre — valida estado/vencimiento de la
// licencia, esta copia no lo hacía y nunca se ejecutaba) — se quitó de aquí.

// ── POST /api/productos/:uuid/copiar-sucursal ──────────────────
router.post('/productos/:uuid/copiar-sucursal', async (req, res) => {
  try {
    const { sucursal_id_destino } = req.body;
    const { negocio_id } = req.caja;
    if (!sucursal_id_destino) return res.status(400).json({ error: 'Falta sucursal_id_destino' });
    const suc = await pool.query('SELECT id FROM sucursales WHERE id=$1 AND negocio_id=$2', [sucursal_id_destino, negocio_id]);
    if (!suc.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    const prod = await pool.query('SELECT * FROM productos WHERE id=$1 AND negocio_id=$2', [req.params.uuid, negocio_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const p = prod.rows[0];
    const existe = await pool.query('SELECT id FROM productos WHERE negocio_id=$1 AND sucursal_id=$2 AND nombre=$3', [negocio_id, sucursal_id_destino, p.nombre]);
    if (existe.rows.length) return res.json({ ok: false, mensaje: 'El producto ya existe en esa sucursal' });
    const nuevo_id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO productos (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo, stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion, actualizado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
      [nuevo_id, negocio_id, sucursal_id_destino, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'', p.precio, p.costo, p.stock_minimo, p.categoria_id, p.giro, p.por_peso, p.unidad_peso, p.tiene_prescripcion]
    );
    res.json({ ok: true, nuevo_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KITS / COMBOS ───────────────────────────────────────────
// GET /api/kits
router.get('/kits', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT k.*, 
        json_agg(json_build_object(
          'id', ki.id,
          'producto_id', ki.producto_id,
          'nombre_producto', ki.nombre_producto,
          'cantidad', ki.cantidad,
          'precio_unitario', ki.precio_unitario
        ) ORDER BY ki.id) FILTER (WHERE ki.id IS NOT NULL) AS items
       FROM kits k
       LEFT JOIN kit_items ki ON ki.kit_id = k.id
       WHERE k.negocio_id=$1 AND k.sucursal_id=$2 AND k.activo=true
       GROUP BY k.id ORDER BY k.nombre`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) {
    // Si la tabla no existe aún, retornar array vacío
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/kits
router.post('/kits', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const { nombre, emoji='🎁', descripcion='', precio, items=[], id } = req.body;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id UUID NOT NULL, sucursal_id UUID,
        nombre TEXT NOT NULL, emoji TEXT DEFAULT '🎁',
        descripcion TEXT DEFAULT '', precio NUMERIC(12,2) DEFAULT 0,
        activo BOOLEAN DEFAULT true, imagen_url TEXT DEFAULT '',
        actualizado_en TIMESTAMPTZ DEFAULT now()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kit_id UUID NOT NULL, producto_id UUID,
        nombre_producto TEXT DEFAULT '', cantidad NUMERIC(10,3) DEFAULT 1,
        precio_unitario NUMERIC(12,2) DEFAULT 0
      )`);
    const kitId = id || (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await pool.query(
      `INSERT INTO kits (id, negocio_id, sucursal_id, nombre, emoji, descripcion, precio, actualizado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (id) DO UPDATE SET nombre=$4,emoji=$5,descripcion=$6,precio=$7,activo=true,actualizado_en=now()`,
      [kitId, negocio_id, sucursal_id, nombre, emoji, descripcion, precio]
    );
    // Reemplazar items
    await pool.query('DELETE FROM kit_items WHERE kit_id=$1', [kitId]);
    for (const item of items) {
      await pool.query(
        `INSERT INTO kit_items (kit_id, producto_id, nombre_producto, cantidad, precio_unitario)
         VALUES ($1,$2,$3,$4,$5)`,
        [kitId, item.producto_id||null, item.nombre_producto||'', item.cantidad||1, item.precio_unitario||0]
      );
    }
    const kit = (await pool.query('SELECT * FROM kits WHERE id=$1', [kitId])).rows[0];
    res.json(kit);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/kits/:id
router.put('/kits/:id', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const { nombre, emoji, descripcion, precio, items=[] } = req.body;
    await pool.query(
      `UPDATE kits SET nombre=$1,emoji=$2,descripcion=$3,precio=$4,actualizado_en=now()
       WHERE id=$5 AND negocio_id=$6`,
      [nombre, emoji||'🎁', descripcion||'', precio, req.params.id, negocio_id]
    );
    await pool.query('DELETE FROM kit_items WHERE kit_id=$1', [req.params.id]);
    for (const item of items) {
      await pool.query(
        `INSERT INTO kit_items (kit_id, producto_id, nombre_producto, cantidad, precio_unitario)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, item.producto_id||null, item.nombre_producto||'', item.cantidad||1, item.precio_unitario||0]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/kits/:id
router.delete('/kits/:id', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    await pool.query('UPDATE kits SET activo=false,actualizado_en=now() WHERE id=$1 AND negocio_id=$2',
      [req.params.id, negocio_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// TRASPASOS — mover productos o lotes entre sucursales del mismo negocio
// Instantáneo: se descuenta de origen y se suma a destino en el mismo momento.
// Solo administradores (usuario_rol enviado por el cliente, igual de confiable
// que el resto de los checks de rol en este sistema — no hay token por empleado).
// ══════════════════════════════════════════════════════════════
async function ensureTraspasosTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS traspasos (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id           UUID NOT NULL,
      sucursal_origen_id   UUID NOT NULL,
      sucursal_destino_id  UUID NOT NULL,
      tipo                 TEXT NOT NULL DEFAULT 'producto',
      producto_origen_id   UUID,
      producto_destino_id  UUID,
      lote_origen_id       UUID,
      lote_destino_id      UUID,
      nombre_item          TEXT DEFAULT '',
      cantidad             NUMERIC(10,3) NOT NULL,
      usuario_nombre       TEXT DEFAULT '',
      notas                TEXT DEFAULT '',
      creado_en            TIMESTAMPTZ DEFAULT now()
    )`);
  // 'recibido' como default preserva el histórico: los traspasos creados
  // antes de este cambio ya eran atómicos (origen y destino aplicados de
  // un jalón), así que ya están completos.
  await pool.query(`ALTER TABLE traspasos ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'recibido'`);
  await pool.query(`ALTER TABLE traspasos ADD COLUMN IF NOT EXISTS cantidad_recibida NUMERIC(10,3)`);
  await pool.query(`ALTER TABLE traspasos ADD COLUMN IF NOT EXISTS recibido_en TIMESTAMPTZ`);
}

// ── GET /api/traspasos — historial de la sucursal (enviados y recibidos) ──
router.get('/traspasos', async (req, res) => {
  try {
    await ensureTraspasosTable();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      `SELECT t.*, so.nombre AS sucursal_origen_nombre, sd.nombre AS sucursal_destino_nombre
       FROM traspasos t
       JOIN sucursales so ON so.id = t.sucursal_origen_id
       JOIN sucursales sd ON sd.id = t.sucursal_destino_id
       WHERE t.negocio_id=$1 AND (t.sucursal_origen_id=$2 OR t.sucursal_destino_id=$2)
       ORDER BY t.creado_en DESC LIMIT 100`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/traspasos — crear un traspaso (instantáneo) ──
router.post('/traspasos', async (req, res) => {
  const { negocio_id, sucursal_id: sucursalOrigenId, id: cajaId } = req.caja;
  const {
    tipo = 'producto', producto_id, lote_id, sucursal_destino_id,
    cantidad, notas = '', usuario_nombre = '', usuario_rol = ''
  } = req.body;

  if (!(usuario_rol || '').toLowerCase().includes('admin')) {
    return res.status(403).json({ error: 'Solo un administrador puede hacer traspasos entre sucursales' });
  }
  const cant = parseFloat(cantidad);
  if (!cant || cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });
  if (!sucursal_destino_id || sucursal_destino_id === sucursalOrigenId) {
    return res.status(400).json({ error: 'Elige una sucursal destino distinta a la actual' });
  }

  const client = await pool.connect();
  try {
    await ensureTraspasosTable();
    await client.query('BEGIN');

    const destino = await client.query(
      'SELECT id, nombre FROM sucursales WHERE id=$1 AND negocio_id=$2 AND activo=true',
      [sucursal_destino_id, negocio_id]
    );
    if (!destino.rows.length) throw Object.assign(new Error('Sucursal destino no encontrada'), { status: 404 });

    let productoOrigenId = null, productoDestinoId = null, loteOrigenId = null, loteDestinoId = null, nombreItem = '';

    if (tipo === 'lote') {
      const lote = await client.query(
        'SELECT * FROM lotes WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
        [lote_id, negocio_id, sucursalOrigenId]
      );
      if (!lote.rows.length) throw Object.assign(new Error('Lote no encontrado en esta sucursal'), { status: 404 });
      const l = lote.rows[0];
      if (parseFloat(l.cantidad) < cant) throw Object.assign(new Error('No hay suficiente cantidad en ese lote (' + l.cantidad + ' disponible)'), { status: 400 });

      loteOrigenId = l.id;
      nombreItem = l.nombre_producto || '';
      await client.query('UPDATE lotes SET cantidad = cantidad - $1, actualizado_en = now() WHERE id=$2', [cant, l.id]);

      // El lote destino nace en 0 — su cantidad se llena hasta que la
      // sucursal destino confirma la recepción (PUT /traspasos/:id/recibir).
      const nuevoLote = await client.query(
        `INSERT INTO lotes (negocio_id, sucursal_id, producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad)
         VALUES ($1,$2,$3,$4,$5,0,$6) RETURNING id`,
        [negocio_id, sucursal_destino_id, l.producto_id, l.nombre_producto, l.numero_lote, l.fecha_caducidad]
      );
      loteDestinoId = nuevoLote.rows[0].id;

    } else {
      const prod = await client.query(
        'SELECT * FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
        [producto_id, negocio_id, sucursalOrigenId]
      );
      if (!prod.rows.length) throw Object.assign(new Error('Producto no encontrado en esta sucursal'), { status: 404 });
      const p = prod.rows[0];

      const stockActual = await client.query(
        `SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2`,
        [p.id, sucursalOrigenId]
      );
      if (parseFloat(stockActual.rows[0].stock) < cant) {
        throw Object.assign(new Error('No hay suficiente stock (' + stockActual.rows[0].stock + ' disponible)'), { status: 400 });
      }

      productoOrigenId = p.id;
      nombreItem = p.nombre;

      // Buscar el mismo producto (por nombre) ya existente en la sucursal destino
      const existente = await client.query(
        'SELECT id FROM productos WHERE negocio_id=$1 AND sucursal_id=$2 AND lower(nombre)=lower($3) AND activo=true',
        [negocio_id, sucursal_destino_id, p.nombre]
      );
      if (existente.rows.length) {
        productoDestinoId = existente.rows[0].id;
      } else {
        const nuevoProd = await client.query(
          `INSERT INTO productos (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
            stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion, actualizado_en)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now()) RETURNING id`,
          [negocio_id, sucursal_destino_id, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
           p.precio, p.costo, p.stock_minimo, p.categoria_id, p.giro, p.por_peso, p.unidad_peso, p.tiene_prescripcion]
        );
        productoDestinoId = nuevoProd.rows[0].id;
      }

      // Solo se resta en origen al enviar — la mercancía ya salió físicamente.
      // El movimiento de entrada en destino se aplica hasta que se confirma
      // la recepción (PUT /traspasos/:id/recibir), no aquí.
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'traspaso_salida')`,
        [negocio_id, sucursalOrigenId, productoOrigenId, cajaId, -cant]
      );
      await client.query('UPDATE productos SET actualizado_en=now() WHERE id IN ($1,$2)', [productoOrigenId, productoDestinoId]);
    }

    const traspaso = await client.query(
      `INSERT INTO traspasos (negocio_id, sucursal_origen_id, sucursal_destino_id, tipo,
         producto_origen_id, producto_destino_id, lote_origen_id, lote_destino_id,
         nombre_item, cantidad, usuario_nombre, notas, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'enviado') RETURNING *`,
      [negocio_id, sucursalOrigenId, sucursal_destino_id, tipo,
       productoOrigenId, productoDestinoId, loteOrigenId, loteDestinoId,
       nombreItem, cant, usuario_nombre, notas]
    );

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocio_id).emit('traspaso:nuevo', { id: traspaso.rows[0].id });

    res.json({ ok: true, traspaso: traspaso.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/traspasos/:id/recibir — confirma recepción (total o parcial) ──
// Solo la sucursal destino puede confirmar. body opcional {cantidad_recibida};
// sin body, confirma la cantidad completa enviada (igual que pedidos.recibir).
router.put('/traspasos/:id/recibir', async (req, res) => {
  const { negocio_id, sucursal_id: miSucursalId, id: cajaId } = req.caja;
  const client = await pool.connect();
  try {
    await ensureTraspasosTable();
    const t = await client.query('SELECT * FROM traspasos WHERE id=$1 AND negocio_id=$2', [req.params.id, negocio_id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Traspaso no encontrado' });
    const traspaso = t.rows[0];
    if (traspaso.sucursal_destino_id !== miSucursalId) {
      return res.status(403).json({ error: 'Solo la sucursal destino puede confirmar este traspaso' });
    }
    if (traspaso.estado !== 'enviado') return res.status(400).json({ error: 'Este traspaso ya fue ' + traspaso.estado });

    const cantidadRecibida = req.body && req.body.cantidad_recibida != null
      ? Math.max(0, Math.min(parseFloat(traspaso.cantidad), parseFloat(req.body.cantidad_recibida)))
      : parseFloat(traspaso.cantidad);

    await client.query('BEGIN');
    if (traspaso.tipo === 'lote') {
      await client.query('UPDATE lotes SET cantidad=$1, actualizado_en=now() WHERE id=$2', [cantidadRecibida, traspaso.lote_destino_id]);
    } else {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'traspaso_entrada')`,
        [negocio_id, miSucursalId, traspaso.producto_destino_id, cajaId, cantidadRecibida]
      );
      await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [traspaso.producto_destino_id]);
    }
    await client.query(
      `UPDATE traspasos SET estado='recibido', cantidad_recibida=$1, recibido_en=now() WHERE id=$2`,
      [cantidadRecibida, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, cantidad_recibida: cantidadRecibida });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/traspasos/:id/rechazar — la sucursal destino rechaza, el stock regresa a origen ──
router.put('/traspasos/:id/rechazar', async (req, res) => {
  const { negocio_id, sucursal_id: miSucursalId, id: cajaId } = req.caja;
  const client = await pool.connect();
  try {
    await ensureTraspasosTable();
    const t = await client.query('SELECT * FROM traspasos WHERE id=$1 AND negocio_id=$2', [req.params.id, negocio_id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Traspaso no encontrado' });
    const traspaso = t.rows[0];
    if (traspaso.sucursal_destino_id !== miSucursalId) {
      return res.status(403).json({ error: 'Solo la sucursal destino puede rechazar este traspaso' });
    }
    if (traspaso.estado !== 'enviado') return res.status(400).json({ error: 'Este traspaso ya fue ' + traspaso.estado });

    await client.query('BEGIN');
    if (traspaso.tipo === 'lote') {
      await client.query('UPDATE lotes SET cantidad = cantidad + $1, actualizado_en=now() WHERE id=$2', [traspaso.cantidad, traspaso.lote_origen_id]);
    } else {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'traspaso_salida')`,
        [negocio_id, traspaso.sucursal_origen_id, traspaso.producto_origen_id, cajaId, traspaso.cantidad]
      );
    }
    await client.query(`UPDATE traspasos SET estado='rechazado' WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════
// PEDIDOS EN LÍNEA — apartados desde la tienda pública (/tienda/:slug)
// Confirmar aquí descuenta stock y registra la venta automáticamente.
// ══════════════════════════════════════════════════════════════
const { ensureTiendaTables } = require('./tienda');

// ── GET /api/negocio/tienda — datos actuales de la tienda pública (para editar) ──
router.get('/negocio/tienda', async (req, res) => {
  try {
    await ensureTiendaTables();
    const r = await pool.query(
      `SELECT nombre, slug, tienda_imagen_url, tienda_descripcion, tienda_logo_url,
              tienda_telefono, tienda_direccion, tienda_horario,
              COALESCE(tienda_mostrar_kits,false) AS tienda_mostrar_kits,
              COALESCE(domicilio_habilitado,false) AS domicilio_habilitado,
              COALESCE(cotizacion_mostrar_fotos,false) AS cotizacion_mostrar_fotos,
              COALESCE(envio_habilitado,false) AS envio_habilitado,
              COALESCE(envio_costo,0) AS envio_costo
       FROM negocios WHERE id=$1`,
      [req.caja.negocio_id]
    );
    res.json(r.rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/negocio/tienda — banner/logo/datos de la tienda pública ──
router.put('/negocio/tienda', async (req, res) => {
  try {
    await ensureTiendaTables();
    const {
      tienda_imagen_url = null, tienda_descripcion = null, tienda_logo_url = null,
      tienda_telefono = null, tienda_direccion = null, tienda_horario = null,
      tienda_mostrar_kits = null, domicilio_habilitado = null, cotizacion_mostrar_fotos = null,
      envio_habilitado = null, envio_costo = null,
      nombre = null
    } = req.body;
    // nombre no admite NULL en la tabla — solo se actualiza si mandan algo no vacío
    const nombreVal = (nombre && nombre.trim()) ? nombre.trim() : null;
    await pool.query(
      `UPDATE negocios SET
         nombre=COALESCE($11, nombre),
         tienda_imagen_url=COALESCE($1, tienda_imagen_url),
         tienda_descripcion=COALESCE($2, tienda_descripcion),
         tienda_logo_url=COALESCE($3, tienda_logo_url),
         tienda_telefono=COALESCE($4, tienda_telefono),
         tienda_direccion=COALESCE($5, tienda_direccion),
         tienda_horario=COALESCE($6, tienda_horario),
         tienda_mostrar_kits=COALESCE($7, tienda_mostrar_kits),
         domicilio_habilitado=COALESCE($9, domicilio_habilitado),
         cotizacion_mostrar_fotos=COALESCE($10, cotizacion_mostrar_fotos),
         envio_habilitado=COALESCE($12, envio_habilitado),
         envio_costo=COALESCE($13, envio_costo)
       WHERE id=$8`,
      [tienda_imagen_url, tienda_descripcion, tienda_logo_url, tienda_telefono, tienda_direccion, tienda_horario,
       tienda_mostrar_kits, req.caja.negocio_id, domicilio_habilitado, cotizacion_mostrar_fotos, nombreVal,
       envio_habilitado, envio_costo]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/pedidos-online — historial de esta sucursal ──
router.get('/pedidos-online', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(`
      SELECT po.*,
        COALESCE(json_agg(json_build_object(
          'producto_id', poi.producto_id, 'nombre_producto', poi.nombre_producto,
          'cantidad', poi.cantidad, 'precio_unitario', poi.precio_unitario,
          'variante_id', poi.variante_id, 'variante_texto', poi.variante_texto,
          'kit_id', poi.kit_id
        )) FILTER (WHERE poi.id IS NOT NULL), '[]') AS items
      FROM pedidos_online po
      LEFT JOIN pedido_online_items poi ON poi.pedido_id = po.id
      WHERE po.negocio_id=$1 AND po.sucursal_id=$2
      GROUP BY po.id ORDER BY po.creado_en DESC LIMIT 100`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pedidos-online/:id/confirmar — descuenta stock y registra la venta ──
router.post('/pedidos-online/:id/confirmar', async (req, res) => {
  const { negocio_id, sucursal_id, id: cajaId } = req.caja;
  const client = await pool.connect();
  try {
    await ensureTiendaTables();
    await client.query('BEGIN');

    const pedido = await client.query(
      "SELECT * FROM pedidos_online WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND estado='pendiente'",
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!pedido.rows.length) throw Object.assign(new Error('Pedido no encontrado o ya procesado'), { status: 404 });
    const p = pedido.rows[0];
    const items = await client.query('SELECT * FROM pedido_online_items WHERE pedido_id=$1', [p.id]);

    // Verificar stock disponible de cada item antes de confirmar
    // (las variantes llevan su propio stock, aparte del producto general)
    for (const it of items.rows) {
      if (it.kit_id) {
        const componentes = it.componentes || [];
        for (const comp of componentes) {
          if (!comp.producto_id) continue;
          const stock = await client.query(
            'SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2',
            [comp.producto_id, sucursal_id]
          );
          const requerido = it.cantidad * (parseFloat(comp.cantidad) || 1);
          if (parseFloat(stock.rows[0].stock) < requerido) {
            throw Object.assign(new Error('Sin stock suficiente para armar "' + it.nombre_producto + '"'), { status: 400 });
          }
        }
        continue;
      }
      if (it.variante_id) {
        const vStock = await client.query('SELECT stock FROM producto_variantes WHERE id=$1', [it.variante_id]);
        const disp = vStock.rows.length ? vStock.rows[0].stock : 0;
        if (disp < it.cantidad) {
          throw Object.assign(new Error('Sin stock suficiente de "' + it.nombre_producto + ' · ' + (it.variante_texto||'') + '" (' + disp + ' disponible)'), { status: 400 });
        }
        continue;
      }
      if (!it.producto_id) continue;
      const stock = await client.query(
        'SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2',
        [it.producto_id, sucursal_id]
      );
      if (parseFloat(stock.rows[0].stock) < it.cantidad) {
        throw Object.assign(new Error('Sin stock suficiente de "' + it.nombre_producto + '" (' + stock.rows[0].stock + ' disponible)'), { status: 400 });
      }
    }

    const ventaId = uuid();
    const ultimo = await client.query('SELECT folio FROM ventas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 1', [negocio_id]);
    let num = 1;
    if (ultimo.rows[0]) { const m = ultimo.rows[0].folio.match(/(\d+)$/); if (m) num = parseInt(m[1]) + 1; }
    const folioVenta = 'WEB-' + Date.now().toString().slice(-8) + '-' + String(num).padStart(4,'0');

    // caja_id se deja NULL a propósito: esta venta no la "empujó" ninguna caja
    // local (nació directo en la nube al confirmar el pedido), así que no debe
    // excluirse del pull de la caja que confirma — ver /api/sync/pull, que
    // excluye ventas con caja_id igual al de quien pregunta.
    const costoEnvio = parseFloat(p.costo_envio) || 0;
    const totalVenta = parseFloat(p.subtotal) + costoEnvio;
    await client.query(
      `INSERT INTO ventas (id, negocio_id, sucursal_id, caja_id, folio, subtotal, descuento, iva, total,
         forma_pago, efectivo_recibido, cambio, cajero, giro, referencia_externa)
       VALUES ($1,$2,$3,NULL,$4,$5,0,0,$6,'pedido_online',$6,0,$7,'tienda',$8)`,
      [ventaId, negocio_id, sucursal_id, folioVenta, p.subtotal, totalVenta, req.body.cajero || 'Pedido en línea', p.folio]
    );

    for (const it of items.rows) {
      const nombreConVariante = it.variante_texto ? (it.nombre_producto + ' · ' + it.variante_texto) : it.nombre_producto;
      await client.query(
        `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), ventaId, it.producto_id, nombreConVariante, it.cantidad, it.precio_unitario, it.cantidad * it.precio_unitario]
      );
      if (it.kit_id) {
        const componentes = it.componentes || [];
        for (const comp of componentes) {
          if (!comp.producto_id) continue;
          const compCantidad = it.cantidad * (parseFloat(comp.cantidad) || 1);
          await client.query(
            `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id)
             VALUES ($1,$2,$3,$4,$5,$6,'kit_venta',$7)`,
            [uuid(), negocio_id, sucursal_id, comp.producto_id, cajaId, -compCantidad, ventaId]
          );
          await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [comp.producto_id]);
        }
      } else if (it.variante_id) {
        await client.query('UPDATE producto_variantes SET stock = stock - $1, actualizado_en = now() WHERE id=$2',
          [it.cantidad, it.variante_id]);
        if (it.producto_id) await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [it.producto_id]);
      } else if (it.producto_id) {
        await client.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id)
           VALUES ($1,$2,$3,$4,$5,$6,'venta',$7)`,
          [uuid(), negocio_id, sucursal_id, it.producto_id, cajaId, -it.cantidad, ventaId]
        );
        // Tocar actualizado_en para que el pull incremental de la PC recoja
        // el nuevo stock (antes se quedaba con el timestamp viejo y el
        // producto nunca volvía a bajarse de precio/stock en la PC)
        await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [it.producto_id]);
      }
    }

    await client.query(
      "UPDATE pedidos_online SET estado='confirmado', venta_id=$1, confirmado_en=now() WHERE id=$2",
      [ventaId, p.id]
    );

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocio_id).emit('pedido_online:confirmado', { id: p.id });

    // Aviso de entrega programada por WhatsApp — mejor esfuerzo, nunca lanza
    // ni bloquea la confirmación si el negocio no tiene WhatsApp configurado.
    if (p.fecha_entrega) {
      try {
        const { enviarWhatsapp } = require('./whatsapp');
        const telefono = p.destinatario_telefono || p.cliente_telefono;
        if (telefono) {
          const mensaje = 'Tu pedido ' + p.folio + ' está confirmado, entrega programada para el '
            + p.fecha_entrega + (p.hora_entrega ? ' a las ' + p.hora_entrega : '') + '.';
          enviarWhatsapp(negocio_id, telefono, mensaje).catch(() => {});
        }
      } catch (e) {}
    }

    res.json({ ok: true, venta_id: ventaId, folio_venta: folioVenta });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/pedidos-online/:id/marcar-entregado — checkpoint de entrega propia (no toca stock/venta) ──
router.post('/pedidos-online/:id/marcar-entregado', async (req, res) => {
  try {
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      "UPDATE pedidos_online SET entregado_en=now() WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND estado='confirmado' AND entregado_en IS NULL RETURNING id",
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'No se puede marcar como entregado (no existe, no está confirmado, o ya se marcó)' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pedidos-online/:id/rechazar ──
router.post('/pedidos-online/:id/rechazar', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { motivo = '' } = req.body;
    const r = await pool.query(
      "UPDATE pedidos_online SET estado='rechazado', rechazo_motivo=$1 WHERE id=$2 AND negocio_id=$3 AND sucursal_id=$4 AND estado='pendiente' RETURNING id",
      [motivo, req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido no encontrado o ya procesado' });
    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocio_id).emit('pedido_online:rechazado', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/pedidos-online/:id/enviar — capturar guía y marcar enviado ──
// No se agrega un estado nuevo — "enviado_en" es la señal de que ya se envió,
// para no tocar la máquina de estados de confirmar/rechazar.
router.post('/pedidos-online/:id/enviar', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { guia_rastreo = '', paqueteria = '' } = req.body;
    const r = await pool.query(
      `UPDATE pedidos_online SET guia_rastreo=$1, paqueteria=$2, enviado_en=now()
       WHERE id=$3 AND negocio_id=$4 AND sucursal_id=$5 AND estado='confirmado' AND tipo_entrega='envio' AND enviado_en IS NULL
       RETURNING id`,
      [guia_rastreo, paqueteria, req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido no encontrado, no confirmado, o ya marcado como enviado' });
    const io = req.app.get('io');
    if (io) io.to('negocio:' + negocio_id).emit('pedido_online:enviado', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Entregas recurrentes de despensa — plantillas que generan un pedidos_online ──
// real cada semana (ver generarPedidosRecurrentes en routes/tienda.js).
router.get('/pedidos-recurrentes', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(`
      SELECT pr.*,
        COALESCE(json_agg(json_build_object(
          'producto_id', pri.producto_id, 'cantidad', pri.cantidad, 'nombre_producto', p.nombre
        )) FILTER (WHERE pri.id IS NOT NULL), '[]') AS items
      FROM pedidos_recurrentes pr
      LEFT JOIN pedido_recurrente_items pri ON pri.pedido_recurrente_id = pr.id
      LEFT JOIN productos p ON p.id = pri.producto_id
      WHERE pr.negocio_id=$1 AND pr.sucursal_id=$2
      GROUP BY pr.id ORDER BY pr.creado_en DESC`,
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pedidos-recurrentes', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const {
      cliente_nombre, cliente_telefono = '', dia_semana, hora_entrega = '',
      tipo_entrega = 'recoger', direccion_calle = '', direccion_numero = '', direccion_colonia = '',
      direccion_ciudad = '', direccion_cp = '', direccion_referencias = '', notas = '', items = []
    } = req.body;
    if (!cliente_nombre || !cliente_nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del cliente' });
    if (dia_semana === undefined || dia_semana === null || dia_semana < 0 || dia_semana > 6) {
      return res.status(400).json({ error: 'Día de la semana inválido' });
    }
    if (!items.length) return res.status(400).json({ error: 'Agrega al menos un producto' });

    await client.query('BEGIN');
    const itemsValidos = [];
    for (const it of items) {
      const prod = await client.query(
        'SELECT id FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
        [it.producto_id, negocio_id, sucursal_id]
      );
      if (!prod.rows.length) continue;
      itemsValidos.push({ producto_id: it.producto_id, cantidad: Math.max(1, parseInt(it.cantidad) || 1) });
    }
    if (!itemsValidos.length) throw Object.assign(new Error('Ningún producto es válido'), { status: 400 });

    const pl = await client.query(
      `INSERT INTO pedidos_recurrentes (negocio_id, sucursal_id, cliente_nombre, cliente_telefono, dia_semana, hora_entrega,
        tipo_entrega, direccion_calle, direccion_numero, direccion_colonia, direccion_ciudad, direccion_cp, direccion_referencias, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [negocio_id, sucursal_id, cliente_nombre.trim(), cliente_telefono, dia_semana, hora_entrega,
       tipo_entrega, direccion_calle, direccion_numero, direccion_colonia, direccion_ciudad, direccion_cp, direccion_referencias, notas]
    );
    const plantillaId = pl.rows[0].id;
    for (const it of itemsValidos) {
      await client.query(
        'INSERT INTO pedido_recurrente_items (pedido_recurrente_id, producto_id, cantidad) VALUES ($1,$2,$3)',
        [plantillaId, it.producto_id, it.cantidad]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: plantillaId });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.put('/pedidos-recurrentes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const existe = await client.query(
      'SELECT id FROM pedidos_recurrentes WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3',
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!existe.rows.length) return res.status(404).json({ error: 'No encontrada' });

    const b = req.body || {};
    await client.query('BEGIN');
    await client.query(
      `UPDATE pedidos_recurrentes SET
        cliente_nombre = COALESCE($1, cliente_nombre),
        cliente_telefono = COALESCE($2, cliente_telefono),
        dia_semana = COALESCE($3, dia_semana),
        hora_entrega = COALESCE($4, hora_entrega),
        tipo_entrega = COALESCE($5, tipo_entrega),
        direccion_calle = COALESCE($6, direccion_calle),
        direccion_numero = COALESCE($7, direccion_numero),
        direccion_colonia = COALESCE($8, direccion_colonia),
        direccion_ciudad = COALESCE($9, direccion_ciudad),
        direccion_cp = COALESCE($10, direccion_cp),
        direccion_referencias = COALESCE($11, direccion_referencias),
        notas = COALESCE($12, notas),
        activo = COALESCE($13, activo)
       WHERE id=$14`,
      [b.cliente_nombre, b.cliente_telefono, b.dia_semana, b.hora_entrega, b.tipo_entrega,
       b.direccion_calle, b.direccion_numero, b.direccion_colonia, b.direccion_ciudad, b.direccion_cp, b.direccion_referencias,
       b.notas, typeof b.activo === 'boolean' ? b.activo : null, req.params.id]
    );
    if (Array.isArray(b.items)) {
      await client.query('DELETE FROM pedido_recurrente_items WHERE pedido_recurrente_id=$1', [req.params.id]);
      for (const it of b.items) {
        const prod = await client.query(
          'SELECT id FROM productos WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND activo=true',
          [it.producto_id, negocio_id, sucursal_id]
        );
        if (!prod.rows.length) continue;
        await client.query(
          'INSERT INTO pedido_recurrente_items (pedido_recurrente_id, producto_id, cantidad) VALUES ($1,$2,$3)',
          [req.params.id, it.producto_id, Math.max(1, parseInt(it.cantidad) || 1)]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.delete('/pedidos-recurrentes/:id', async (req, res) => {
  try {
    await ensureTiendaTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      'DELETE FROM pedidos_recurrentes WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 RETURNING id',
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/carritos-abandonados — carritos que no se convirtieron en pedido ──
router.get('/carritos-abandonados', async (req, res) => {
  try {
    await ensureTiendaTables();
    const r = await pool.query(
      `SELECT * FROM carritos_abandonados WHERE negocio_id=$1 AND estado != 'convertido'
       ORDER BY actualizado_en DESC LIMIT 100`,
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/carritos-abandonados/:id — marcar contactado/descartado ──
router.put('/carritos-abandonados/:id', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!['contactado', 'descartado', 'abierto'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    await pool.query(
      `UPDATE carritos_abandonados SET estado=$1, actualizado_en=now() WHERE id=$2 AND negocio_id=$3`,
      [estado, req.params.id, req.caja.negocio_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/apartados-recordatorio — la PC sube (upsert) el cobro pendiente de un apartado ──
router.post('/apartados-recordatorio', async (req, res) => {
  try {
    await ensureApartadosRecordatorioTable();
    const { negocio_id, sucursal_id } = req.caja;
    const {
      apartado_local_id, cliente_nombre = '', cliente_telefono = '',
      folio = '', saldo = 0, fecha_pago = null, activo = true
    } = req.body;
    if (!apartado_local_id) return res.status(400).json({ error: 'Falta apartado_local_id' });
    await pool.query(
      `INSERT INTO apartados_recordatorio
        (negocio_id, sucursal_id, apartado_local_id, cliente_nombre, cliente_telefono, folio, saldo, fecha_pago, activo, actualizado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (sucursal_id, apartado_local_id) DO UPDATE SET
         cliente_nombre=$4, cliente_telefono=$5, folio=$6, saldo=$7, fecha_pago=$8, activo=$9, actualizado_en=now()`,
      [negocio_id, sucursal_id, apartado_local_id, cliente_nombre, cliente_telefono, folio, saldo, fecha_pago, !!activo]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/apartados-recordatorio — cobros pendientes de apartados (esta sucursal o todas si eres admin viendo el negocio) ──
router.get('/apartados-recordatorio', async (req, res) => {
  try {
    await ensureApartadosRecordatorioTable();
    const r = await pool.query(
      `SELECT ar.*, s.nombre AS sucursal_nombre FROM apartados_recordatorio ar
       JOIN sucursales s ON s.id = ar.sucursal_id
       WHERE ar.negocio_id=$1 AND ar.activo=true AND ar.fecha_pago IS NOT NULL
       ORDER BY ar.fecha_pago ASC`,
      [req.caja.negocio_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
