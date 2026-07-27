// routes/delivery/adapters/agregador.js — Kaixa Cloud
// Normaliza el payload que manda un agregador tipo Deliverect (que ya
// normalizó por su cuenta los pedidos de Rappi/Uber Eats/DiDi/etc. antes de
// reenviarlos aquí). Los nombres de campo siguen el shape típico documentado
// por Deliverect (channelOrderId, customer.name/phone, items[].name/quantity/
// price, deliveryAddress) — ajustar contra su documentación exacta cuando se
// contrate el servicio y llegue el primer webhook real.
function normalizar(payload) {
  const p = payload || {};
  const items = (p.items || []).map(function(it) {
    return {
      nombre: it.name || it.productName || 'Producto',
      cantidad: parseInt(it.quantity || 1) || 1,
      precio_unitario: parseFloat(it.price || it.unitPrice || 0) || 0,
      notas: it.remark || it.comment || ''
    };
  });
  const cliente = p.customer || {};
  const direccion = p.deliveryAddress || p.delivery_address || {};
  return {
    folio_externo: String(p.channelOrderId || p.orderId || p.id || ''),
    cliente_nombre: cliente.name || '',
    cliente_telefono: cliente.phone || cliente.phoneNumber || '',
    direccion_texto: direccion.formattedAddress || direccion.street || '',
    notas: p.note || p.notes || '',
    items: items,
    subtotal: parseFloat(p.subTotal || p.subtotal || 0) || 0,
    costo_envio: parseFloat(p.deliveryCost || p.delivery_fee || 0) || 0,
    total: parseFloat(p.orderTotal || p.total || 0) || 0
  };
}

// El esquema de firma depende de qué agregador se contrate finalmente —
// se deja pasar hasta tener una cuenta real y su documentación de webhook.
function verificarFirma(req, credenciales) {
  return true;
}

const { requestJson } = require('./_http');

// Los agregadores tipo Deliverect suelen usar una API key directa (no OAuth
// client_credentials como las plataformas individuales) — se manda como
// Bearer con la api_key guardada en credenciales. Host/paths best-effort
// según el patrón típico de Deliverect; ajustar según el agregador real
// que el cliente contrate (no todos comparten el mismo esquema).
async function aceptarEnPlataforma(pedido, credenciales) {
  if (!credenciales || !credenciales.client_secret) return { ok: false, mensaje: 'Sin API key del agregador — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.deliverect.com', '/order/' + pedido.folio_externo + '/status', { status: 'accepted' },
    { Authorization: 'Bearer ' + credenciales.client_secret });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('El agregador respondió ' + r.status) : (r.error || '') };
}

async function rechazarEnPlataforma(pedido, credenciales, motivo) {
  if (!credenciales || !credenciales.client_secret) return { ok: false, mensaje: 'Sin API key del agregador — revisa las credenciales configuradas' };
  const r = await requestJson('POST', 'api.deliverect.com', '/order/' + pedido.folio_externo + '/status', { status: 'rejected', reason: motivo || '' },
    { Authorization: 'Bearer ' + credenciales.client_secret });
  return { ok: r.status >= 200 && r.status < 300, mensaje: r.status >= 300 ? ('El agregador respondió ' + r.status) : (r.error || '') };
}

module.exports = { normalizar, verificarFirma, aceptarEnPlataforma, rechazarEnPlataforma };
