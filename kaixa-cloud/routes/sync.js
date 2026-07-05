// routes/sync.js — Empuje (push) y jalón (pull) de datos entre cajas
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');

// ── POST /api/sync/push ──────────────────────────────────────
// La caja manda todo lo que cambió localmente (mientras estaba
// offline, o en el momento si está conectada). Cada registro ya
// trae su UUID generado en la caja, así que insertar dos veces
// el mismo registro no genera duplicados (ON CONFLICT DO NOTHING/UPDATE).
router.post('/push', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const { productos = [], clientes = [], ventas = [], movimientos = [] } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Productos — se crean o actualizan (mutable)
    for (const p of productos) {
      await client.query(
        `INSERT INTO productos
          (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
           stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         ON CONFLICT (id) DO UPDATE SET
           nombre=$4, emoji=$5, imagen_url=$6, codigo_barras=$7, precio=$8, costo=$9,
           stock_minimo=$10, categoria_id=$11, giro=$12, por_peso=$13, unidad_peso=$14,
           tiene_prescripcion=$15, actualizado_en=now()`,
        [p.uuid, negocio_id, sucursal_id, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
         p.precio||0, p.costo||0, p.stock_minimo||5, p.categoria_id||null, p.giro||'tienda',
         !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion]
      );
    }

    // Clientes — se crean o actualizan (mutable: puntos/saldo cambian)
    for (const c of clientes) {
      await client.query(
        `INSERT INTO clientes (id, negocio_id, nombre, telefono, email, rfc, giro, puntos, saldo, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (id) DO UPDATE SET
           nombre=$3, telefono=$4, email=$5, rfc=$6, giro=$7, puntos=$8, saldo=$9, actualizado_en=now()`,
        [c.uuid, negocio_id, c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.giro||'tienda',
         c.puntos||0, c.saldo||0]
      );
    }

    // Ventas — son inmutables una vez creadas (append-only)
    for (const v of ventas) {
      await client.query(
        `INSERT INTO ventas
          (id, negocio_id, sucursal_id, caja_id, folio, cliente_id, subtotal, descuento, iva, total,
           forma_pago, efectivo_recibido, cambio, cajero, giro, estado, referencia_externa, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [v.uuid, negocio_id, sucursal_id, caja_id, v.folio, v.cliente_uuid||null,
         v.subtotal||0, v.descuento||0, v.iva||0, v.total||0, v.forma_pago||'efectivo',
         v.efectivo_recibido||0, v.cambio||0, v.cajero||'', v.giro||'tienda',
         v.estado||'completada', v.referencia_externa||null, v.creado_en||new Date()]
      );

      // Detalle de la venta
      for (const item of (v.items||[])) {
        await client.query(
          `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [item.uuid, v.uuid, item.producto_uuid||null, item.nombre_producto||'',
           item.cantidad||1, item.precio_unitario||0, (item.cantidad||1)*(item.precio_unitario||0)]
        );
      }
    }

    // Movimientos de stock — append-only, así nunca chocan dos cajas
    for (const m of movimientos) {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [m.uuid, negocio_id, sucursal_id, m.producto_uuid, caja_id, m.cantidad, m.motivo||'venta',
         m.venta_uuid||null, m.creado_en||new Date()]
      );
    }

    await client.query('UPDATE cajas SET ultimo_sync = now() WHERE id = $1', [caja_id]);
    await client.query('COMMIT');

    // Avisar en tiempo real a las demás cajas conectadas del mismo negocio
    const io = req.app.get('io');
    if (io) {
      io.to('negocio:' + negocio_id).emit('sync:cambios', {
        de_caja: caja_id,
        productos: productos.length, clientes: clientes.length,
        ventas: ventas.length, movimientos: movimientos.length
      });
    }

    res.json({ ok: true, recibidos: {
      productos: productos.length, clientes: clientes.length,
      ventas: ventas.length, movimientos: movimientos.length
    }});
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error en sync push:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/sync/pull?since=ISO_TIMESTAMP ───────────────────
// La caja pide todo lo que cambió DESDE la última vez que se
// conectó, hecho por OTRAS cajas del mismo negocio.
router.get('/pull', async (req, res) => {
  const { negocio_id, id: caja_id } = req.caja;
  const since = req.query.since || '1970-01-01T00:00:00Z';

  try {
    const { sucursal_id } = req.caja;
    const [productos, clientes, ventas, movimientos] = await Promise.all([
      // Productos: filtrar por sucursal — cada sucursal tiene su propio inventario
      pool.query(
        `SELECT * FROM productos WHERE negocio_id=$1 AND sucursal_id=$2 AND actualizado_en > $3 ORDER BY actualizado_en`,
        [negocio_id, sucursal_id, since]
      ),
      // Clientes: compartidos en todo el negocio (monedero unificado)
      pool.query(
        `SELECT * FROM clientes WHERE negocio_id=$1 AND actualizado_en > $2 ORDER BY actualizado_en`,
        [negocio_id, since]
      ),
      // Ventas: filtrar por sucursal — solo ver ventas de esta sucursal
      pool.query(
        `SELECT v.*, json_agg(json_build_object(
            'producto_id', vd.producto_id, 'nombre_producto', vd.nombre_producto,
            'cantidad', vd.cantidad, 'precio_unitario', vd.precio_unitario
          )) AS items
         FROM ventas v
         LEFT JOIN venta_detalle vd ON vd.venta_id = v.id
         WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND v.creado_en > $3 AND v.caja_id IS DISTINCT FROM $4
         GROUP BY v.id ORDER BY v.creado_en`,
        [negocio_id, sucursal_id, since, caja_id]
      ),
      // Movimientos de stock: filtrar por sucursal
      pool.query(
        `SELECT * FROM stock_movimientos WHERE negocio_id=$1 AND sucursal_id=$2 AND creado_en > $3 AND caja_id IS DISTINCT FROM $4 ORDER BY creado_en`,
        [negocio_id, sucursal_id, since, caja_id]
      )
    ]);

    res.json({
      ok: true,
      ahora: new Date().toISOString(),
      productos: productos.rows,
      clientes: clientes.rows,
      ventas: ventas.rows,
      movimientos: movimientos.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/sync/stock/:producto_id — stock actual calculado ──
router.get('/stock/:producto_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1`,
      [req.params.producto_id]
    );
    res.json({ stock: parseInt(r.rows[0].stock) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
