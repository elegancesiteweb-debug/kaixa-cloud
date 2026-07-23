// routes/sync.js — Empuje (push) y jalón (pull) de datos entre cajas
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');

let _ventasFechaPagoColOk = false;
async function ensureVentasFechaPagoColumn() {
  if (_ventasFechaPagoColOk) return;
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_pago DATE`);
  _ventasFechaPagoColOk = true;
}
let _pedidoItemsRecepcionColOk = false;
async function ensurePedidoItemsRecepcionColumn() {
  if (_pedidoItemsRecepcionColOk) return;
  await pool.query(`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS cantidad_recibida INTEGER DEFAULT 0`);
  _pedidoItemsRecepcionColOk = true;
}
let _autofacturaTokenColOk = false;
async function ensureAutofacturaTokenColumn() {
  if (_autofacturaTokenColOk) return;
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS autofactura_token TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_autofactura_token ON ventas(autofactura_token) WHERE autofactura_token IS NOT NULL`);
  _autofacturaTokenColOk = true;
}
let _clientesFiadoColOk = false;
async function ensureClientesFiadoColumns() {
  if (_clientesFiadoColOk) return;
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_proximo_pago DATE`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS frecuencia_pago TEXT DEFAULT 'mensual'`);
  _clientesFiadoColOk = true;
}
let _coberturaM2ColOk = false;
async function ensureCoberturaM2Column() {
  if (_coberturaM2ColOk) return;
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS cobertura_m2 NUMERIC(10,3) DEFAULT 0`);
  _coberturaM2ColOk = true;
}
let _dimensionesColOk = false;
async function ensureDimensionesColumns() {
  if (_dimensionesColOk) return;
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS peso_kg NUMERIC(10,3) DEFAULT 0`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS largo_cm NUMERIC(10,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS ancho_cm NUMERIC(10,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS alto_cm NUMERIC(10,2) DEFAULT 0`);
  _dimensionesColOk = true;
}

let _monedaCostoColOk = false;
async function ensureMonedaCostoColumns() {
  if (_monedaCostoColOk) return;
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS moneda_costo TEXT DEFAULT 'MXN'`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS costo_moneda NUMERIC(10,2) DEFAULT 0`);
  _monedaCostoColOk = true;
}

// ── POST /api/sync/push ──────────────────────────────────────
router.post('/push', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const { productos = [], clientes = [], ventas = [], movimientos = [], lotes = [] } = req.body;
  const variantes = req.body.variantes || [];
  const proveedores = req.body.proveedores || [];
  const pedidos = req.body.pedidos || [];
  const client = await pool.connect();
  try {
    await ensureVentasFechaPagoColumn();
    await ensureAutofacturaTokenColumn();
    await ensurePedidoItemsRecepcionColumn();
    await ensureClientesFiadoColumns();
    await ensureCoberturaM2Column();
    await ensureDimensionesColumns();
    await ensureMonedaCostoColumns();
    await client.query('BEGIN');

    // Proveedores (van primero: los productos pueden referenciarlos por uuid)
    for (const pv of proveedores) {
      try {
        const activoPv = (pv.activo === false || pv.activo === 0) ? false : true;
        await client.query(
          `INSERT INTO proveedores (id, negocio_id, nombre, telefono, email, activo)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET nombre=$3, telefono=$4, email=$5, activo=$6`,
          [pv.uuid, negocio_id, pv.nombre, pv.telefono||'', pv.email||'', activoPv]
        );
      } catch(e) { console.warn('Proveedor push error:', e.message); }
    }

    // Productos
    for (const p of productos) {
      const activoProd = (p.activo === false || p.activo === 0) ? false : true;
      const prodSucursalId = p.sucursal_id || sucursal_id;
      const imagenesExtraStr = typeof p.imagenes_extra === 'string' ? p.imagenes_extra : JSON.stringify(p.imagenes_extra||[]);
      await client.query(
        `INSERT INTO productos
          (id, negocio_id, sucursal_id, nombre, emoji, imagen_url, codigo_barras, precio, costo,
           stock_minimo, categoria_id, giro, por_peso, unidad_peso, tiene_prescripcion, cobertura_m2,
           peso_kg, largo_cm, ancho_cm, alto_cm, activo, proveedor_id, actualizado_en, moneda_costo, costo_moneda, imagenes_extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now(), $23,$24,$25)
         ON CONFLICT (id) DO UPDATE SET
           sucursal_id=COALESCE(productos.sucursal_id, $3),
           nombre=$4, emoji=$5, imagen_url=COALESCE(NULLIF($6,''), productos.imagen_url), codigo_barras=$7, precio=$8, costo=$9,
           stock_minimo=$10, categoria_id=$11, giro=$12, por_peso=$13, unidad_peso=$14,
           tiene_prescripcion=$15, cobertura_m2=$16, peso_kg=$17, largo_cm=$18, ancho_cm=$19, alto_cm=$20,
           activo=$21, proveedor_id=COALESCE($22, productos.proveedor_id), actualizado_en=now(),
           moneda_costo=$23, costo_moneda=$24,
           imagenes_extra=COALESCE(NULLIF($25,'[]'), productos.imagenes_extra)`,
        [p.uuid, negocio_id, prodSucursalId, p.nombre, p.emoji||'📦', p.imagen_url||'', p.codigo_barras||'',
         p.precio||0, p.costo||0, p.stock_minimo||5, p.categoria_id||null, p.giro||'tienda',
         !!p.por_peso, p.unidad_peso||'kg', !!p.tiene_prescripcion, parseFloat(p.cobertura_m2)||0,
         parseFloat(p.peso_kg)||0, parseFloat(p.largo_cm)||0, parseFloat(p.ancho_cm)||0, parseFloat(p.alto_cm)||0,
         activoProd, p.proveedor_uuid||null, p.moneda_costo||'MXN', parseFloat(p.costo_moneda)||0, imagenesExtraStr]
      );
      // Ajuste de stock si viene stock
      if (p.stock !== undefined && p.stock !== null) {
        const stockNuevo = parseInt(p.stock) || 0;
        const stockActual = await client.query(
          `SELECT COALESCE(SUM(cantidad),0) as stock FROM stock_movimientos WHERE producto_id=$1 AND sucursal_id=$2`,
          [p.uuid, prodSucursalId]
        );
        const stockActualNum = parseInt(stockActual.rows[0].stock) || 0;
        const diferencia = stockNuevo - stockActualNum;
        if (diferencia !== 0) {
          await client.query(
            `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo)
             VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'ajuste')`,
            [negocio_id, prodSucursalId, p.uuid, caja_id, diferencia]
          );
        }
      }
    }

    // Clientes
    for (const c of clientes) {
      const activoVal = (c.activo === false || c.activo === 0) ? false : true;
      await client.query(
        `INSERT INTO clientes (id, negocio_id, nombre, telefono, email, rfc, giro, puntos, saldo, foto, activo,
          fecha_proximo_pago, frecuencia_pago, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (id) DO UPDATE SET
           nombre=$3, telefono=$4, email=$5, rfc=$6, giro=$7, puntos=$8, saldo=$9,
           foto=COALESCE($10, clientes.foto), activo=$11,
           fecha_proximo_pago=$12, frecuencia_pago=$13, actualizado_en=now()`,
        [c.uuid, negocio_id, c.nombre, c.telefono||'', c.email||'', c.rfc||'', c.giro||'tienda',
         c.puntos||0, c.saldo||0, c.foto||null, activoVal,
         c.fecha_proximo_pago||null, c.frecuencia_pago||'mensual']
      );
    }

    // Ventas
    for (const v of ventas) {
      await client.query(
        `INSERT INTO ventas
          (id, negocio_id, sucursal_id, caja_id, folio, cliente_id, subtotal, descuento, iva, total,
           forma_pago, efectivo_recibido, cambio, cajero, giro, estado, referencia_externa, creado_en, fecha_pago, autofactura_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET
           cliente_id = COALESCE(EXCLUDED.cliente_id, ventas.cliente_id),
           fecha_pago = COALESCE(EXCLUDED.fecha_pago, ventas.fecha_pago),
           autofactura_token = COALESCE(ventas.autofactura_token, EXCLUDED.autofactura_token)`,
        [v.uuid, negocio_id, sucursal_id, caja_id,
         v.folio + '-' + caja_id.substring(0,4), v.cliente_uuid||null,
         v.subtotal||0, v.descuento||0, v.iva||0, v.total||0, v.forma_pago||'efectivo',
         v.efectivo_recibido||0, v.cambio||0, v.cajero||'', v.giro||'tienda',
         v.estado||'completada', v.referencia_externa||null, v.creado_en||new Date(), v.fecha_pago||null,
         v.autofactura_token||null]
      );
      for (const item of (v.items||[])) {
        await client.query(
          `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [item.uuid, v.uuid, item.producto_uuid||null, item.nombre_producto||'',
           item.cantidad||1, item.precio_unitario||0, (item.cantidad||1)*(item.precio_unitario||0)]
        );
      }
    }

    // Movimientos de stock
    for (const m of movimientos) {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [m.uuid, negocio_id, m.sucursal_id||sucursal_id, m.producto_uuid, caja_id, m.cantidad, m.motivo||'venta',
         m.venta_uuid||null, m.creado_en||new Date()]
      );
    }

    // Lotes
    for (const l of lotes) {
      const activoLote = (l.activo === false || l.activo === 0) ? false : true;
      try {
        await client.query(
          `INSERT INTO lotes (id, negocio_id, sucursal_id, producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad, activo, actualizado_en)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           ON CONFLICT (id) DO UPDATE SET
             numero_lote=$6, cantidad=$7, fecha_caducidad=$8, activo=$9, actualizado_en=now()`,
          [l.uuid, negocio_id, sucursal_id, l.producto_uuid||null, '',
           l.numero_lote, l.cantidad||0, l.fecha_caducidad||null, activoLote]
        );
      } catch(e) {
        // Si falla por schema diferente, intentar sin id
        await client.query(
          `INSERT INTO lotes (negocio_id, sucursal_id, producto_id, nombre_producto, numero_lote, cantidad, fecha_caducidad, activo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [negocio_id, sucursal_id, l.producto_uuid||null, '', l.numero_lote, l.cantidad||0, l.fecha_caducidad||null, activoLote]
        ).catch(()=>{});
      }
    }

    // Kits
    for (const k of (req.body.kits || [])) {
      try {
        await client.query(`
          INSERT INTO kits (id, negocio_id, sucursal_id, nombre, emoji, descripcion, precio, activo, actualizado_en)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
          ON CONFLICT (id) DO UPDATE SET
            nombre=$4, emoji=$5, descripcion=$6, precio=$7, activo=$8, actualizado_en=now()`,
          [k.id, negocio_id, k.sucursal_id||sucursal_id, k.nombre, k.emoji||'🎁',
           k.descripcion||'', k.precio||0, k.activo!==false]
        );
        if (k.items && k.items.length > 0) {
          await client.query('DELETE FROM kit_items WHERE kit_id=$1', [k.id]);
          for (const item of k.items) {
            await client.query(`
              INSERT INTO kit_items (kit_id, producto_id, nombre_producto, cantidad, precio_unitario)
              VALUES ($1,$2,$3,$4,$5)`,
              [k.id, item.producto_id||null, item.nombre_producto||'', item.cantidad||1, item.precio_unitario||0]
            );
          }
        }
      } catch(e) { console.warn('Kit push error:', e.message); }
    }

    // Promociones — categoria_nombre se guarda tal cual (texto), no como FK a
    // categorias: esa tabla nunca se llena desde pos-mexico (el sync de
    // productos no manda categoria_id), así que no hay id de categoría
    // confiable para referenciar en la nube. La tienda en línea evalúa
    // promociones por producto/todos; las de categoría solo aplican en el POS.
    for (const pr of (req.body.promociones || [])) {
      try {
        await client.query(`
          INSERT INTO promociones (id, negocio_id, sucursal_id, nombre, tipo, categoria_nombre, producto_id,
            valor, nxm_compra, nxm_paga, fecha_inicio, fecha_fin, activo, actualizado_en)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
          ON CONFLICT (id) DO UPDATE SET
            nombre=$4, tipo=$5, categoria_nombre=$6, producto_id=$7,
            valor=$8, nxm_compra=$9, nxm_paga=$10, fecha_inicio=$11, fecha_fin=$12, activo=$13, actualizado_en=now()`,
          [pr.id, negocio_id, pr.sucursal_id||sucursal_id, pr.nombre, pr.tipo, pr.categoria_nombre||null, pr.producto_id||null,
           pr.valor||0, pr.nxm_compra||0, pr.nxm_paga||0, pr.fecha_inicio||null, pr.fecha_fin||null, pr.activo!==false]
        );
      } catch(e) { console.warn('Promoción push error:', e.message); }
    }

    // Divisas — sin resolución de id/nombre, codigo/nombre/tipo_cambio son
    // valores planos (a diferencia de promociones, no hay tabla local a la
    // que referenciar).
    for (const dv of (req.body.divisas || [])) {
      try {
        await client.query(`
          INSERT INTO divisas (id, negocio_id, sucursal_id, codigo, nombre, simbolo, tipo_cambio, activo, actualizado_en)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
          ON CONFLICT (id) DO UPDATE SET
            codigo=$4, nombre=$5, simbolo=$6, tipo_cambio=$7, activo=$8, actualizado_en=now()`,
          [dv.id, negocio_id, dv.sucursal_id||sucursal_id, dv.codigo, dv.nombre, dv.simbolo||'$', dv.tipo_cambio||1, dv.activo!==false]
        );
      } catch(e) { console.warn('Divisa push error:', e.message); }
    }

    // Variantes de producto (genéricas, cualquier giro)
    for (const v of variantes) {
      try {
        await client.query(`
          INSERT INTO producto_variantes
            (id, negocio_id, sucursal_id, producto_id, atributo1_nombre, atributo1_valor,
             atributo2_nombre, atributo2_valor, sku, precio_extra, stock, stock_minimo, imagen_url, activo, actualizado_en, especificaciones)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15)
          ON CONFLICT (id) DO UPDATE SET
            atributo1_nombre=$5, atributo1_valor=$6, atributo2_nombre=$7, atributo2_valor=$8,
            sku=$9, precio_extra=$10, stock=$11, stock_minimo=$12,
            imagen_url=COALESCE(NULLIF($13,''), producto_variantes.imagen_url), activo=$14, actualizado_en=now(),
            especificaciones=$15`,
          [v.id, negocio_id, v.sucursal_id||sucursal_id, v.producto_uuid,
           v.atributo1_nombre||'', v.atributo1_valor||'', v.atributo2_nombre||'', v.atributo2_valor||'',
           v.sku||'', v.precio_extra||0, v.stock||0, v.stock_minimo||0, v.imagen_url||'', v.activo!==false,
           (typeof v.especificaciones === 'string' ? v.especificaciones : JSON.stringify(v.especificaciones||[]))]
        );
        if (v.producto_uuid) {
          await client.query(
            `UPDATE productos SET tiene_variantes=true WHERE id=$1`,
            [v.producto_uuid]
          );
        }
      } catch(e) { console.warn('Variante push error:', e.message); }
    }

    // Pedidos a proveedores
    for (const p of pedidos) {
      try {
        await client.query(`
          INSERT INTO pedidos (id, negocio_id, sucursal_id, proveedor_id, proveedor_nombre, estado, total, notas, creado_en, actualizado_en)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
          ON CONFLICT (id) DO UPDATE SET
            estado=$6, total=$7, notas=$8, actualizado_en=now()`,
          [p.id, negocio_id, p.sucursal_id||sucursal_id, p.proveedor_id||null, p.proveedor_nombre||'',
           p.estado||'pendiente', p.total||0, p.notas||'', p.creado_en||new Date()]
        );
        if (p.items && p.items.length > 0) {
          await client.query('DELETE FROM pedido_items WHERE pedido_id=$1', [p.id]);
          for (const item of p.items) {
            await client.query(`
              INSERT INTO pedido_items (pedido_id, producto_id, nombre_producto, cantidad, costo_unitario, subtotal, cantidad_recibida)
              VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [p.id, item.producto_id||null, item.nombre_producto||'', item.cantidad||1, item.costo_unitario||0,
               (item.cantidad||1)*(item.costo_unitario||0), item.cantidad_recibida||0]
            );
          }
        }
        // El aumento de stock por recepción (total o parcial) ya viaja por el
        // canal genérico de "movimientos" (motivo='recepcion') que la PC arma
        // con el delta exacto — aquí solo se refleja cantidad_recibida arriba,
        // sin volver a tocar stock_movimientos (evita duplicar el stock).
      } catch(e) { console.warn('Pedido push error:', e.message); }
    }
    await client.query('UPDATE cajas SET ultimo_sync = now() WHERE id = $1', [caja_id]);
    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      io.to('negocio:' + negocio_id).emit('sync:cambios', {
        de_caja: caja_id,
        productos: productos.length, clientes: clientes.length,
        ventas: ventas.length, movimientos: movimientos.length, lotes: lotes.length
      });
    }
    res.json({ ok: true, recibidos: {
      productos: productos.length, clientes: clientes.length,
      ventas: ventas.length, movimientos: movimientos.length, lotes: lotes.length,
      proveedores: proveedores.length, pedidos: pedidos.length
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
router.get('/pull', async (req, res) => {
  const { negocio_id, sucursal_id, id: caja_id } = req.caja;
  const since = req.query.since || '1970-01-01T00:00:00Z';
  try {
    await ensureVentasFechaPagoColumn();
    await ensureAutofacturaTokenColumn();
    await ensureClientesFiadoColumns();
    await ensureCoberturaM2Column();
    await ensureDimensionesColumns();
    await ensureMonedaCostoColumns();
    const [productos, clientes, ventas, movimientos, lotesPull, kitsPull, promocionesPull, divisasPull, variantesPull, proveedoresPull, pedidosPull, empleadosPull] = await Promise.all([
      pool.query(
        `SELECT p.id, p.negocio_id, p.sucursal_id, p.nombre, p.emoji, p.codigo_barras,
                p.precio, p.costo, p.stock_minimo, p.categoria_id, p.giro, p.por_peso,
                p.unidad_peso, p.tiene_prescripcion, p.cobertura_m2,
                p.peso_kg, p.largo_cm, p.ancho_cm, p.alto_cm, p.activo, p.creado_en, p.actualizado_en,
                p.imagen_url, p.imagenes_extra, p.proveedor_id, p.moneda_costo, p.costo_moneda,
                COALESCE(s.stock,0) AS stock_actual
         FROM productos p
         LEFT JOIN stock_actual s ON s.producto_id = p.id AND s.sucursal_id = $2
         WHERE p.negocio_id=$1 AND p.sucursal_id=$2 AND p.actualizado_en > $3
         ORDER BY p.actualizado_en`,
        [negocio_id, sucursal_id, since]
      ),
      pool.query(
        `SELECT * FROM clientes WHERE negocio_id=$1 AND actualizado_en > $2 ORDER BY actualizado_en`,
        [negocio_id, since]
      ),
      pool.query(
        // Antes excluía las ventas de esta misma caja (v.caja_id IS DISTINCT
        // FROM $4) asumiendo que "si es mía, ya la tengo local" — cierto para
        // una venta normal (se crea local y luego se empuja), pero falso para
        // una venta creada directamente en la nube y atribuida a esta caja
        // (cotización o pedido en línea confirmados): esa nunca llega a la
        // base local y la pantalla de Ventas la mostraba como si no existiera.
        // El pull es idempotente por uuid (ver sync-engine.js), así que quitar
        // el filtro es seguro — a lo más re-toca un UPDATE inofensivo.
        `SELECT v.*, json_agg(json_build_object(
            'producto_id', vd.producto_id, 'nombre_producto', vd.nombre_producto,
            'cantidad', vd.cantidad, 'precio_unitario', vd.precio_unitario
          )) AS items
         FROM ventas v
         LEFT JOIN venta_detalle vd ON vd.venta_id = v.id
         WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND v.creado_en > $3
         GROUP BY v.id ORDER BY v.creado_en`,
        [negocio_id, sucursal_id, since]
      ),
      pool.query(
        // Excluir los movimientos que esta MISMA caja generó: ella ya aplicó
        // el descuento de stock localmente en el momento de la venta (UPDATE
        // directo), así que si el pull se los regresa se aplican DOS veces
        // (una vez local al vender, otra vez aquí) y el stock queda negativo
        // hasta que un pull posterior lo corrige con el stock_actual real.
        // Los movimientos de OTRAS cajas (o de la nube, caja_id NULL —
        // pedidos en línea confirmados, etc.) sí deben llegar por aquí.
        `SELECT * FROM stock_movimientos WHERE negocio_id=$1 AND sucursal_id=$2 AND creado_en > $3
         AND caja_id IS DISTINCT FROM $4 ORDER BY creado_en`,
        [negocio_id, sucursal_id, since, caja_id]
      ),
      pool.query(
        `SELECT * FROM lotes WHERE negocio_id=$1 AND (sucursal_id=$2 OR sucursal_id IS NULL) AND actualizado_en > $3 ORDER BY actualizado_en`,
        [negocio_id, sucursal_id, since]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT k.*, 
          COALESCE(json_agg(json_build_object(
            'id', ki.id,
            'producto_id', ki.producto_id,
            'nombre_producto', ki.nombre_producto,
            'cantidad', ki.cantidad,
            'precio_unitario', ki.precio_unitario
          )) FILTER (WHERE ki.id IS NOT NULL), '[]') AS items
         FROM kits k
         LEFT JOIN kit_items ki ON ki.kit_id = k.id
         WHERE k.negocio_id=$1 AND k.sucursal_id=$2 AND k.actualizado_en > $3
         GROUP BY k.id ORDER BY k.actualizado_en`,
        [negocio_id, sucursal_id, since]
      ).catch(() => ({ rows: [] })),
      // Sin filtro de sucursal a propósito: una promoción es una regla de
      // negocio que debe verse igual en todas las sucursales (mismo patrón
      // que proveedores más abajo), a diferencia de kits que sí son por sucursal.
      pool.query(
        `SELECT * FROM promociones WHERE negocio_id=$1 AND actualizado_en > $2 ORDER BY actualizado_en`,
        [negocio_id, since]
      ).catch(() => ({ rows: [] })),
      // Igual que promociones — el tipo de cambio es del negocio completo, sin filtro de sucursal.
      pool.query(
        `SELECT * FROM divisas WHERE negocio_id=$1 AND actualizado_en > $2 ORDER BY actualizado_en`,
        [negocio_id, since]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM producto_variantes
         WHERE negocio_id=$1 AND sucursal_id=$2 AND actualizado_en > $3
         ORDER BY actualizado_en`,
        [negocio_id, sucursal_id, since]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM proveedores WHERE negocio_id=$1 ORDER BY nombre`,
        [negocio_id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT p.*,
          COALESCE(json_agg(json_build_object(
            'producto_id', pi.producto_id, 'nombre_producto', pi.nombre_producto,
            'cantidad', pi.cantidad, 'costo_unitario', pi.costo_unitario
          )) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
         FROM pedidos p
         LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
         WHERE p.negocio_id=$1 AND (p.sucursal_id=$2 OR p.sucursal_id IS NULL) AND p.actualizado_en > $3
         GROUP BY p.id ORDER BY p.actualizado_en`,
        [negocio_id, sucursal_id, since]
      ).catch(() => ({ rows: [] })),
      // Sin filtro incremental — igual que proveedores, una lista de
      // empleados es chica y no vale la pena rastrear actualizado_en.
      pool.query(
        `SELECT nombre, rol, foto, activo FROM empleados WHERE negocio_id=$1`,
        [negocio_id]
      ).catch(() => ({ rows: [] }))
    ]);

    res.json({
      ok: true,
      ahora: new Date().toISOString(),
      productos: productos.rows,
      clientes: clientes.rows,
      ventas: ventas.rows,
      movimientos: movimientos.rows,
      lotes: lotesPull.rows,
      kits: kitsPull.rows,
      promociones: promocionesPull.rows,
      divisas: divisasPull.rows,
      variantes: variantesPull.rows,
      proveedores: proveedoresPull.rows,
      pedidos: pedidosPull.rows,
      empleados: empleadosPull.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/sync/stock/:producto_id ──
router.get('/stock/:producto_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(cantidad),0) AS stock FROM stock_movimientos WHERE producto_id=$1`,
      [req.params.producto_id]
    );
    res.json({ stock: parseInt(r.rows[0].stock) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/sync/sucursales ──
router.get('/sucursales', async (req, res) => {
  try {
    const { negocio_id } = req.caja;
    const r = await pool.query(
      'SELECT id, nombre FROM sucursales WHERE negocio_id=$1 AND activo=true ORDER BY nombre',
      [negocio_id]
    );
    res.json({ ok: true, sucursales: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
