// routes/autofactura.js — Autofactura pública por QR (sin login)
// El cliente escanea el QR del ticket, llega aquí con un token de 128 bits
// único por venta (ventas.autofactura_token), captura sus datos fiscales y
// se timbra la factura usando la misma lógica que ya usan la PC y la app
// móvil (crearFacturaParaNegocio, en ./cfdi.js) — sin exponer nunca el token
// en ningún listado ni endpoint autenticado.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { crearFacturaParaNegocio, resendRequest, descargarPDFFactura } = require('./cfdi');

async function buscarVentaPorToken(token) {
  if (!token || token.length < 10) return null;
  const r = await pool.query(
    `SELECT v.id, v.negocio_id, v.folio, v.total, v.forma_pago, v.cfdi_uuid, v.creado_en,
            n.nombre AS negocio_nombre
     FROM ventas v JOIN negocios n ON n.id = v.negocio_id
     WHERE v.autofactura_token = $1 LIMIT 1`,
    [token]
  );
  return r.rows[0] || null;
}

// ── GET /api/autofactura/:token — resumen de la venta para mostrar en la página ──
router.get('/autofactura/:token', async (req, res) => {
  try {
    const venta = await buscarVentaPorToken(req.params.token);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    if (venta.cfdi_uuid) return res.json({ ok: true, ya_facturada: true });

    const det = await pool.query(
      `SELECT nombre_producto, cantidad, precio_unitario FROM venta_detalle WHERE venta_id=$1`,
      [venta.id]
    );
    res.json({
      ok: true, ya_facturada: false,
      negocio_nombre: venta.negocio_nombre, folio: venta.folio,
      total: venta.total, forma_pago: venta.forma_pago, fecha: venta.creado_en,
      items: det.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/autofactura/:token — timbrar la factura con los datos del cliente ──
router.post('/autofactura/:token', async (req, res) => {
  try {
    const venta = await buscarVentaPorToken(req.params.token);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    if (venta.cfdi_uuid) return res.status(400).json({ error: 'Esta venta ya fue facturada' });

    const { rfc_receptor, nombre_receptor, email_receptor, uso_cfdi, regimen_fiscal_receptor, cp_receptor } = req.body;

    const det = await pool.query(
      `SELECT nombre_producto, cantidad, precio_unitario FROM venta_detalle WHERE venta_id=$1`,
      [venta.id]
    );
    const items = det.rows.map(d => ({
      nombre: d.nombre_producto, cantidad: d.cantidad, precio_unitario: d.precio_unitario
    }));

    const resultado = await crearFacturaParaNegocio(venta.negocio_id, {
      venta_id: venta.id, rfc_receptor, nombre_receptor, email_receptor,
      uso_cfdi, regimen_fiscal_receptor, cp_receptor, items, forma_pago: venta.forma_pago
    });
    if (resultado.error) return res.status(resultado.status || 400).json({ error: resultado.error });

    // El cliente no tiene token de caja para descargar el PDF por el endpoint
    // autenticado, así que se regresa aquí mismo en base64 (una sola vez).
    let pdfBase64 = null;
    try {
      const negR = await pool.query(
        'SELECT facturapi_key, resend_api_key, resend_from_email, razon_social_emisor FROM negocios WHERE id=$1',
        [venta.negocio_id]);
      const cfg = negR.rows[0] || {};
      const pdfR = await descargarPDFFactura(resultado.facturaapi_id, cfg.facturapi_key, 'pdf');
      if (pdfR.status === 200) {
        pdfBase64 = pdfR.buffer.toString('base64');
        if (email_receptor && cfg.resend_api_key) {
          await resendRequest('POST', '/emails', {
            from: cfg.resend_from_email || 'facturas@resend.dev',
            to: [email_receptor],
            subject: 'Tu factura de ' + (cfg.razon_social_emisor || venta.negocio_nombre || 'tu compra'),
            html: '<p>Adjunto encontrarás tu factura CFDI folio ' + resultado.folio + ' por $' + Number(resultado.total).toFixed(2) + '.</p><p>Gracias por tu compra.</p>',
            attachments: [{ filename: 'factura_' + resultado.folio + '.pdf', content: pdfBase64 }]
          }, cfg.resend_api_key);
        }
      }
    } catch(e) { /* la factura ya se timbró; un fallo aquí no debe aparentar que todo falló */ }

    res.json({ ...resultado, pdf_base64: pdfBase64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };
