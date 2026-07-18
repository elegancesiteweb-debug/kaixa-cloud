// routes/ventas-shared.js — lógica de creación de una venta completada,
// compartida entre POST /api/ventas (venta normal) y
// POST /api/ventas-pendientes/:id/cobrar (venta que nació como ticket
// pendiente en otra caja). Extraída de la lógica original de POST /api/ventas
// para no duplicarla.
const crypto = require('crypto');
function uuid() { return crypto.randomUUID(); }

// No abre ni cierra transacción — el caller ya tiene `client` dentro de un BEGIN.
// Si saltarStock=true, NO se descuenta inventario aquí (el llamador es
// responsable de que el stock ya haya sido reservado/descontado antes).
async function crearVentaCompletada(client, { negocio_id, sucursal_id, caja_id, giroReal, v, saltarStock }) {
  const ventaId = uuid();
  const ultimo = await client.query(
    `SELECT folio FROM ventas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 1`, [negocio_id]
  );
  let num = 1;
  if (ultimo.rows[0]) {
    const m = ultimo.rows[0].folio.match(/(\d+)$/);
    if (m) num = parseInt(m[1]) + 1;
  }
  const folio = (giroReal).toUpperCase().slice(0,3) + '-' + Date.now().toString().slice(-8) + '-' + String(num).padStart(4,'0');
  const subtotalCalc = v.items.reduce((s,i) => s + (parseFloat(i.precio_unitario||i.precio||0)) * (parseInt(i.cantidad||i.qty||1)), 0);
  const subtotal = subtotalCalc > 0 ? subtotalCalc : parseFloat(v.subtotal||v.total||0);
  const descuento = v.descuento || 0;
  const base = subtotal - descuento;
  const iva = v.iva_activo ? parseFloat((base*0.16).toFixed(2)) : 0;
  const total = base + iva > 0 ? base + iva : parseFloat(v.total||0);
  await client.query(
    `INSERT INTO ventas (id, negocio_id, sucursal_id, caja_id, folio, cliente_id, subtotal, descuento,
      iva, total, forma_pago, efectivo_recibido, cambio, cajero, giro, referencia_externa, fecha_pago)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [ventaId, negocio_id, sucursal_id, caja_id, folio, v.cliente_id||null, subtotal, descuento,
     iva, total, v.forma_pago||'efectivo', v.efectivo_recibido||total,
     Math.max(0,(v.efectivo_recibido||total)-total), v.cajero||'', giroReal,
     v.referencia_externa||null, v.fecha_pago||null]
  );
  for (const item of v.items) {
    // Los kits no son un producto real — no llevan producto_id propio,
    // se venden como una sola línea y su stock se descuenta por
    // componente más abajo (igual que en la PC).
    const itemId   = item.kit_id ? null : (item.producto_id || item.id || null);
    const itemNom  = item.nombre || item.nombre_producto || '';
    const itemQty  = parseInt(item.cantidad || item.qty || 1);
    const itemPrc  = parseFloat(item.precio_unitario || item.precio || 0);
    await client.query(
      `INSERT INTO venta_detalle (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), ventaId, itemId, itemNom, itemQty, itemPrc, itemQty*itemPrc]
    );
    if (saltarStock) continue;
    if (itemId) {
      await client.query(
        `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id)
         VALUES ($1,$2,$3,$4,$5,$6,'venta',$7)`,
        [uuid(), negocio_id, sucursal_id, itemId, caja_id, -itemQty, ventaId]
      );
      // Tocar actualizado_en para que el pull incremental de la PC recoja
      // el nuevo stock — antes se quedaba con el timestamp viejo y una
      // venta hecha desde el celular nunca bajaba el stock en la PC.
      await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [itemId]);
    }
    if (item.kit_id && Array.isArray(item.componentes)) {
      for (const comp of item.componentes) {
        if (!comp.producto_id) continue;
        const compCantidad = itemQty * (parseFloat(comp.cantidad) || 1);
        await client.query(
          `INSERT INTO stock_movimientos (id, negocio_id, sucursal_id, producto_id, caja_id, cantidad, motivo, venta_id)
           VALUES ($1,$2,$3,$4,$5,$6,'kit_venta',$7)`,
          [uuid(), negocio_id, sucursal_id, comp.producto_id, caja_id, -compCantidad, ventaId]
        );
        await client.query('UPDATE productos SET actualizado_en=now() WHERE id=$1', [comp.producto_id]);
      }
    }
  }
  return { ventaId, folio, subtotal, descuento, iva, total };
}

module.exports = { crearVentaCompletada };
