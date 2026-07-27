// routes/delivery/adapters/didifood.js — Kaixa Cloud
// Normaliza el payload de pedidos de DiDi Food. La documentación pública de
// developer.didi-food.com no expone el esquema exacto del webhook sin cuenta
// de partner aprobada — este adaptador usa nombres de campo razonables
// (consistentes con el resto de plataformas de reparto) como punto de
// partida, y se ajusta en cuanto haya un payload real de prueba.
function normalizar(payload) {
  const p = payload || {};
  const items = (p.products || p.items || []).map(function(it) {
    return {
      nombre: it.name || 'Producto',
      cantidad: parseInt(it.quantity || 1) || 1,
      precio_unitario: parseFloat(it.price || it.unit_price || 0) || 0,
      notas: it.remark || it.notes || ''
    };
  });
  const cliente = p.customer || p.consumer || {};
  return {
    folio_externo: String(p.order_id || p.orderId || p.id || ''),
    cliente_nombre: cliente.name || '',
    cliente_telefono: cliente.phone || cliente.mobile || '',
    direccion_texto: p.delivery_address || (p.address && p.address.detail) || '',
    notas: p.remark || '',
    items: items,
    subtotal: parseFloat(p.subtotal || p.food_amount || 0) || 0,
    costo_envio: parseFloat(p.delivery_fee || p.shipping_fee || 0) || 0,
    total: parseFloat(p.total_amount || p.total || 0) || 0
  };
}

// Sin esquema de firma confirmado públicamente para DiDi Food — se identifica
// la integración vía el webhook_token en la URL, igual que Rappi.
function verificarFirma(req, credenciales) {
  return true;
}

const { requestJson } = require('./_http');

// De las 3 plataformas directas, DiDi Food es la que menos documentación
// pública expone sin cuenta de partner aprobada — este flujo OAuth2 y los
// endpoints de abajo son la conjetura MÁS especulativa de las 3 (ni siquiera
// se confirmó el nombre del host). Tratar como plantilla a corregir por
// completo en cuanto un cliente real tenga acceso a developer.didi-food.com.
async function obtenerToken(credenciales) {
  if (!credenciales || !credenciales.client_id || !credenciales.client_secret) return null;
  const r = await requestJson('POST', 'openapi.didi-food.com', '/v1/oauth/token', {
    grant_type: 'client_credentials', client_id: credenciales.client_id, client_secret: credenciales.client_secret
  });
  return (r.data && r.data.access_token) || null;
}

async function aceptarEnPlataforma(pedido, credenciales) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de DiDi Food — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'openapi.didi-food.com', '/v1/orders/' + pedido.folio_externo + '/confirm', {}, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('DiDi Food respondió ' + r.status) : (r.error || '') };
}

async function rechazarEnPlataforma(pedido, credenciales, motivo) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de DiDi Food — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'openapi.didi-food.com', '/v1/orders/' + pedido.folio_externo + '/cancel', { reason: motivo || '' }, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('DiDi Food respondió ' + r.status) : (r.error || '') };
}

module.exports = { normalizar, verificarFirma, obtenerToken, aceptarEnPlataforma, rechazarEnPlataforma };
