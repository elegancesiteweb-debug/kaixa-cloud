// routes/delivery/adapters/_http.js — Kaixa Cloud
// Helper HTTPS mínimo compartido por los adaptadores de reparto para llamar
// de vuelta a la API de cada plataforma (obtener token, aceptar/rechazar
// pedido, traer detalle). No se usa ninguna librería externa (mismo criterio
// que routes/pagos.js, que ya hace sus llamadas a Mercado Pago con el módulo
// nativo `https`, sin agregar axios/node-fetch como dependencia nueva).
const https = require('https');

function requestJson(method, hostname, path, body, headers, contentType) {
  return new Promise((resolve) => {
    const isForm = contentType === 'form';
    const bodyStr = body
      ? (isForm ? body : JSON.stringify(body))
      : '';
    const req = https.request({
      hostname, path, method,
      headers: Object.assign({
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }, headers || {})
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, data: json, raw: data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = { requestJson };
