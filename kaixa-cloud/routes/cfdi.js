// routes/cfdi.js — Facturación CFDI 4.0 vía FacturAPI (misma integración que la PC,
// para que una sola cuenta de FacturAPI sirva para ventas hechas en PC, móvil y tienda en línea)
const express = require('express');
const router  = express.Router();
const https   = require('https');
const pool    = require('../db/pool');

async function ensureCfdiTables() {
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS facturapi_key TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS rfc_emisor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS razon_social_emisor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS regimen_fiscal_emisor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS cp_emisor TEXT DEFAULT ''`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      venta_id        UUID REFERENCES ventas(id),
      uuid_fiscal     TEXT DEFAULT '',
      serie           TEXT DEFAULT 'A',
      folio           TEXT DEFAULT '',
      rfc_receptor    TEXT DEFAULT '',
      nombre_receptor TEXT DEFAULT '',
      uso_cfdi        TEXT DEFAULT 'G01',
      total           NUMERIC(12,2) DEFAULT 0,
      estado          TEXT DEFAULT 'vigente',
      facturaapi_id   TEXT DEFAULT '',
      creado_en       TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_facturas_negocio ON facturas(negocio_id);
  `);
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cfdi_uuid TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS requiere_factura BOOLEAN DEFAULT false`);
}

// Llamada a FacturAPI (misma API que usa la PC — www.facturaapi.com/v2)
function facturapiRequest(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const auth    = Buffer.from(apiKey + ':').toString('base64');
    const options = {
      hostname: 'www.facturaapi.com',
      port: 443,
      path: '/v2' + path,
      method: method,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── GET /api/cfdi/config ────────────────────────────────────────
router.get('/cfdi/config', async (req, res) => {
  try {
    await ensureCfdiTables();
    const r = await pool.query(
      `SELECT facturapi_key, rfc_emisor, razon_social_emisor, regimen_fiscal_emisor, cp_emisor
       FROM negocios WHERE id=$1`, [req.caja.negocio_id]);
    const cfg = r.rows[0] || {};
    const safe = { ...cfg };
    if (safe.facturapi_key && safe.facturapi_key.length > 8) {
      safe.api_key_preview = safe.facturapi_key.substring(0,4) + '****' + safe.facturapi_key.slice(-4);
    }
    delete safe.facturapi_key;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/cfdi/config ────────────────────────────────────────
router.put('/cfdi/config', async (req, res) => {
  try {
    await ensureCfdiTables();
    const { api_key, rfc_emisor, razon_social_emisor, regimen_fiscal_emisor, cp_emisor } = req.body;
    const sets = []; const vals = [];
    if (api_key !== undefined)                { vals.push(api_key); sets.push(`facturapi_key=$${vals.length}`); }
    if (rfc_emisor !== undefined)              { vals.push(rfc_emisor); sets.push(`rfc_emisor=$${vals.length}`); }
    if (razon_social_emisor !== undefined)     { vals.push(razon_social_emisor); sets.push(`razon_social_emisor=$${vals.length}`); }
    if (regimen_fiscal_emisor !== undefined)   { vals.push(regimen_fiscal_emisor); sets.push(`regimen_fiscal_emisor=$${vals.length}`); }
    if (cp_emisor !== undefined)               { vals.push(cp_emisor); sets.push(`cp_emisor=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.caja.negocio_id);
    await pool.query(`UPDATE negocios SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cfdi/test — probar conexión con FacturAPI ─────────
router.post('/cfdi/test', async (req, res) => {
  try {
    await ensureCfdiTables();
    const r0 = await pool.query('SELECT facturapi_key FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const apiKey = r0.rows[0] && r0.rows[0].facturapi_key;
    if (!apiKey) return res.json({ ok: false, mensaje: 'Falta el API Key de FacturAPI' });
    const r = await facturapiRequest('GET', '/profile', null, apiKey);
    if (r.status === 200) {
      res.json({ ok: true, mensaje: 'Conexión exitosa con FacturAPI ✅', perfil: r.data });
    } else {
      res.json({ ok: false, mensaje: 'API Key inválido: ' + (r.data && r.data.message || r.status) });
    }
  } catch(e) { res.json({ ok: false, mensaje: 'Error de conexión: ' + e.message }); }
});

// ── POST /api/cfdi/crear — timbrar factura ───────────────────────
router.post('/cfdi/crear', async (req, res) => {
  try {
    await ensureCfdiTables();
    const negR = await pool.query(
      `SELECT facturapi_key, rfc_emisor, cp_emisor FROM negocios WHERE id=$1`, [req.caja.negocio_id]);
    const cfg = negR.rows[0] || {};
    if (!cfg.facturapi_key) return res.status(400).json({ error: 'FacturAPI no configurado. Ve a Facturación > Configuración.' });
    if (!cfg.rfc_emisor)    return res.status(400).json({ error: 'Configura el RFC del emisor en Facturación > Configuración.' });

    const {
      venta_id, rfc_receptor, nombre_receptor, email_receptor,
      uso_cfdi = 'G01', regimen_fiscal_receptor = '616',
      cp_receptor, items = []
    } = req.body;

    if (!rfc_receptor)    return res.status(400).json({ error: 'RFC del cliente requerido' });
    if (!nombre_receptor) return res.status(400).json({ error: 'Nombre del cliente requerido' });
    if (!items.length)    return res.status(400).json({ error: 'Sin productos para facturar' });

    let clienteFAPI = null;
    try {
      const buscar = await facturapiRequest('GET', '/customers?q=' + encodeURIComponent(rfc_receptor), null, cfg.facturapi_key);
      if (buscar.status === 200 && buscar.data.data && buscar.data.data.length > 0) {
        clienteFAPI = buscar.data.data[0];
      }
    } catch(e) {}

    if (!clienteFAPI) {
      const crearCliente = await facturapiRequest('POST', '/customers', {
        legal_name: nombre_receptor,
        tax_id:     rfc_receptor,
        tax_system: regimen_fiscal_receptor,
        email:      email_receptor || '',
        address: { zip: cp_receptor || cfg.cp_emisor || '44100' }
      }, cfg.facturapi_key);
      if (crearCliente.status !== 200 && crearCliente.status !== 201) {
        return res.status(400).json({ error: 'Error al crear cliente: ' + (crearCliente.data && crearCliente.data.message || crearCliente.status) });
      }
      clienteFAPI = crearCliente.data;
    }

    const conceptos = items.map(item => ({
      quantity: item.cantidad || 1,
      product: {
        description:  item.nombre,
        product_key:  item.clave_sat || '01010101',
        unit_key:     item.unidad_sat || 'H87',
        unit_name:    item.unidad_nombre || 'Pieza',
        price:        parseFloat(item.precio_unitario) || 0,
        tax_included: true,
        taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }]
      }
    }));

    const facturaBody = {
      type: 'I', customer: clienteFAPI.id, use: uso_cfdi, items: conceptos,
      currency: 'MXN', exchange: 1, conditions: 'CONTADO',
      payment_form: '01', payment_method: 'PUE'
    };

    const r = await facturapiRequest('POST', '/invoices', facturaBody, cfg.facturapi_key);
    if (r.status !== 200 && r.status !== 201) {
      return res.status(400).json({ error: 'Error de FacturAPI: ' + (r.data && r.data.message || JSON.stringify(r.data)) });
    }
    const factura = r.data;

    const ins = await pool.query(
      `INSERT INTO facturas (negocio_id, venta_id, uuid_fiscal, serie, folio, rfc_receptor, nombre_receptor, uso_cfdi, total, facturaapi_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.caja.negocio_id, venta_id || null, factura.uuid || '', factura.series || 'A', factura.folio_number || '',
       rfc_receptor, nombre_receptor, uso_cfdi, factura.total || 0, factura.id || '']
    );

    if (venta_id) {
      try { await pool.query('UPDATE ventas SET cfdi_uuid=$1 WHERE id=$2', [factura.uuid, venta_id]); } catch(e) {}
    }

    res.json({
      ok: true, id: ins.rows[0].id, uuid: factura.uuid,
      folio: (factura.series || 'A') + factura.folio_number,
      facturaapi_id: factura.id, total: factura.total,
      mensaje: 'Factura creada exitosamente'
    });
  } catch(e) {
    console.error('Error CFDI:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cfdi/descargar/:facturaapi_id/:tipo — PDF o XML ────
router.get('/cfdi/descargar/:facturaapi_id/:tipo', async (req, res) => {
  try {
    const r0 = await pool.query('SELECT facturapi_key FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const apiKey = r0.rows[0] && r0.rows[0].facturapi_key;
    if (!apiKey) return res.status(400).json({ error: 'No configurado' });
    const { facturaapi_id, tipo } = req.params;
    const auth = Buffer.from(apiKey + ':').toString('base64');
    const url  = 'https://www.facturaapi.com/v2/invoices/' + facturaapi_id + '/' + tipo;
    const r = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Authorization': 'Basic ' + auth } }, (response) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => resolve({ status: response.statusCode, buffer: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    if (r.status !== 200) return res.status(r.status).json({ error: 'No se pudo descargar' });
    const mime = tipo === 'pdf' ? 'application/pdf' : 'application/xml';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="factura_${facturaapi_id}.${tipo}"`);
    res.send(r.buffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cfdi — listar facturas del negocio ──────────────────
router.get('/cfdi', async (req, res) => {
  try {
    await ensureCfdiTables();
    const r = await pool.query(
      `SELECT * FROM facturas WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 50`, [req.caja.negocio_id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/cfdi/:facturaapi_id/cancelar ─────────────────────
router.delete('/cfdi/:facturaapi_id/cancelar', async (req, res) => {
  try {
    const r0 = await pool.query('SELECT facturapi_key FROM negocios WHERE id=$1', [req.caja.negocio_id]);
    const apiKey = r0.rows[0] && r0.rows[0].facturapi_key;
    if (!apiKey) return res.status(400).json({ error: 'No configurado' });
    const { motivo = '02' } = req.body;
    const r = await facturapiRequest('DELETE', '/invoices/' + req.params.facturaapi_id, { motive: motivo }, apiKey);
    if (r.status === 200) {
      await pool.query(`UPDATE facturas SET estado='cancelada' WHERE facturaapi_id=$1 AND negocio_id=$2`,
        [req.params.facturaapi_id, req.caja.negocio_id]);
      res.json({ ok: true, mensaje: 'Factura cancelada' });
    } else {
      res.json({ ok: false, mensaje: (r.data && r.data.message) || 'Error al cancelar' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, ensureCfdiTables };
