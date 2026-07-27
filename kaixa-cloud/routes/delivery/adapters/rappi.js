// routes/delivery/adapters/rappi.js — Kaixa Cloud
// Normaliza el payload del webhook de pedidos de Rappi (Rests API) al formato
// interno de pedidos_delivery. Basado en la documentación pública de Rappi
// (dev-portal.rappi.com/es/rests-api/) — SIN validar contra un payload real
// todavía; ajustar los nombres de campo en cuanto haya credenciales de sandbox.
function normalizar(payload) {
  const p = payload || {};
  const items = (p.products || p.items || []).map(function(it) {
    return {
      nombre: it.name || it.product_name || 'Producto',
      cantidad: parseInt(it.quantity || it.qty || 1) || 1,
      precio_unitario: parseFloat(it.unit_price || it.price || 0) || 0,
      notas: it.comment || it.notes || ''
    };
  });
  const cliente = p.client || p.customer || {};
  const direccion = p.delivery_address || p.address || {};
  return {
    folio_externo: String(p.order_id || p.id || ''),
    cliente_nombre: cliente.name || cliente.first_name || '',
    cliente_telefono: cliente.phone || cliente.phone_number || '',
    direccion_texto: direccion.address || direccion.formatted_address || '',
    notas: p.comment || p.notes || '',
    items: items,
    subtotal: parseFloat(p.subtotal || 0) || items.reduce(function(s, i) { return s + i.precio_unitario * i.cantidad; }, 0),
    costo_envio: parseFloat(p.delivery_fee || p.shipping_cost || 0) || 0,
    total: parseFloat(p.total || 0) || 0
  };
}

// Rappi no documenta públicamente un esquema de firma HMAC para webhooks
// entrantes al partner — la identificación real de la integración es el
// webhook_token en la URL (ver routes/delivery/index.js). Ajustar si Rappi
// confirma un mecanismo de firma al dar de alta credenciales reales.
function verificarFirma(req, credenciales) {
  return true;
}

const { requestJson } = require('./_http');

// OAuth2 client_credentials contra el dev-portal de Rappi — host/endpoint
// exacto SIN confirmar todavía (basado en el patrón estándar OAuth2 que
// describe la documentación pública); se ajusta con la primera credencial
// real de sandbox que dé un cliente.
async function obtenerToken(credenciales) {
  if (!credenciales || !credenciales.client_id || !credenciales.client_secret) return null;
  const r = await requestJson('POST', 'api.rappi.com', '/oauth2/token', {
    grant_type: 'client_credentials', client_id: credenciales.client_id, client_secret: credenciales.client_secret
  });
  return (r.data && r.data.access_token) || null;
}

// Avisa a Rappi que el pedido fue aceptado — SIN esta llamada, el pedido
// puede autocancelarse del lado de Rappi por falta de respuesta a tiempo,
// aunque en Kaixa Pro ya se haya "aceptado". Endpoint best-effort.
async function aceptarEnPlataforma(pedido, credenciales) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de Rappi — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.rappi.com', '/orders/' + pedido.folio_externo + '/accept', {}, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('Rappi respondió ' + r.status) : (r.error || '') };
}

async function rechazarEnPlataforma(pedido, credenciales, motivo) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de Rappi — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.rappi.com', '/orders/' + pedido.folio_externo + '/reject', { reason: motivo || '' }, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('Rappi respondió ' + r.status) : (r.error || '') };
}

module.exports = { normalizar, verificarFirma, obtenerToken, aceptarEnPlataforma, rechazarEnPlataforma };
