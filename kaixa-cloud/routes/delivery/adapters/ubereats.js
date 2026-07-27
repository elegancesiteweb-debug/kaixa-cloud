// routes/delivery/adapters/ubereats.js — Kaixa Cloud
// Normaliza el payload de la Uber Eats Marketplace Order API. Uber Eats suele
// mandar primero una notificación ligera (order.notification, con solo un
// resource_id) y requiere una llamada GET /v1/eats/orders/{id} aparte para
// traer el detalle completo — esa segunda llamada NO está implementada
// todavía (falta client_id/secret real para probarla contra su sandbox), así
// que si el payload no trae items inline, el pedido se guarda igual con lo
// que haya disponible (payload_original queda completo para reprocesar).
function normalizar(payload) {
  const p = payload || {};
  const orden = p.order || p; // por si viene envuelto en {order:{...}} o plano
  const cart = orden.cart || {};
  const items = (cart.items || orden.items || []).map(function(it) {
    const nombre = (it.title && it.title.translations && it.title.translations.en) || it.title || it.name || 'Producto';
    const precioCentavos = (it.price && it.price.unit_price && it.price.unit_price.amount) || it.unit_price || 0;
    return {
      nombre: nombre,
      cantidad: parseInt(it.quantity || 1) || 1,
      precio_unitario: (parseFloat(precioCentavos) || 0) / 100,
      notas: it.special_instructions || ''
    };
  });
  const eater = orden.eater || {};
  const direccion = (orden.delivery && orden.delivery.location) || {};
  const charges = (orden.payment && orden.payment.charges) || {};
  return {
    folio_externo: String(orden.id || p.resource_id || (p.meta && p.meta.resource_id) || ''),
    cliente_nombre: eater.first_name || eater.display_name || '',
    cliente_telefono: eater.phone || '',
    direccion_texto: direccion.street_address || direccion.address || '',
    notas: orden.special_instructions || '',
    items: items,
    subtotal: (charges.sub_total && (parseFloat(charges.sub_total.amount) || 0) / 100) || 0,
    costo_envio: (charges.delivery_fee && (parseFloat(charges.delivery_fee.amount) || 0) / 100) || 0,
    total: (charges.total && (parseFloat(charges.total.amount) || 0) / 100) || 0
  };
}

// Uber documenta firma HMAC-SHA256 sobre el body crudo con el header
// 'x-uber-signature', usando un client_secret por app. El raw body ya se
// captura en server.js (req.rawBody) para cuando se active esto — se deja
// comentado porque todavía no hay client_secret real para probarlo.
function verificarFirma(req, credenciales) {
  // if (credenciales && credenciales.client_secret && req.rawBody) {
  //   const crypto = require('crypto');
  //   const firma = crypto.createHmac('sha256', credenciales.client_secret).update(req.rawBody).digest('hex');
  //   return firma === req.headers['x-uber-signature'];
  // }
  return true;
}

const { requestJson } = require('./_http');

// OAuth2 client_credentials contra login.uber.com (documentado, scope
// 'eats.order') — este es el paso mejor confirmado de los 3 directos, ya que
// Uber sí publica el flujo completo sin necesitar cuenta aprobada para verlo.
async function obtenerToken(credenciales) {
  if (!credenciales || !credenciales.client_id || !credenciales.client_secret) return null;
  const body = 'client_id=' + encodeURIComponent(credenciales.client_id)
    + '&client_secret=' + encodeURIComponent(credenciales.client_secret)
    + '&grant_type=client_credentials&scope=eats.order';
  const r = await requestJson('POST', 'login.uber.com', '/oauth/v2/token', body, {}, 'form');
  return (r.data && r.data.access_token) || null;
}

// Uber Eats suele mandar el webhook inicial sin el detalle completo del
// pedido (solo un resource_id) — esta llamada trae la orden completa para
// poder normalizarla con items/cliente/dirección reales.
async function obtenerDetalleOrden(folioExterno, credenciales) {
  const token = await obtenerToken(credenciales);
  if (!token) return null;
  const r = await requestJson('GET', 'api.uber.com', '/v1/eats/orders/' + folioExterno, null, { Authorization: 'Bearer ' + token });
  return (r.status >= 200 && r.status < 300) ? r.data : null;
}

// Nombres de endpoint basados en la convención documentada de "accept/deny
// pos order" de la Order API — confirmar el path exacto en cuanto haya
// credenciales de sandbox reales.
async function aceptarEnPlataforma(pedido, credenciales) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de Uber Eats — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.uber.com', '/v1/eats/orders/' + pedido.folio_externo + '/accept_pos_order', {}, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('Uber Eats respondió ' + r.status) : (r.error || '') };
}

async function rechazarEnPlataforma(pedido, credenciales, motivo) {
  const token = await obtenerToken(credenciales);
  if (!token) return { ok: false, mensaje: 'Sin token de Uber Eats — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.uber.com', '/v1/eats/orders/' + pedido.folio_externo + '/deny_pos_order', { reason: motivo || 'other' }, { Authorization: 'Bearer ' + token });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('Uber Eats respondió ' + r.status) : (r.error || '') };
}

module.exports = { normalizar, verificarFirma, obtenerToken, obtenerDetalleOrden, aceptarEnPlataforma, rechazarEnPlataforma };
