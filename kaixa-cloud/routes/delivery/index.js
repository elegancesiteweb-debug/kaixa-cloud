// routes/delivery/index.js — Kaixa Cloud
// Recibe pedidos de plataformas de reparto (Rappi, Uber Eats, DiDi Food, o
// vía un agregador tipo Deliverect) por webhook, y los expone a la caja
// (pos-mexico) igual que /api/pedidos-online — pero SIN crear la venta aquí:
// la operación real (mesa virtual, cocina, promos, propina) vive en
// pos-mexico vía mesas.js, así que este módulo solo lleva el estado del
// pedido de la plataforma hasta que la caja lo confirma o rechaza.
const express = require('express');
const router = express.Router();      // público — el webhook no puede mandar x-caja-token
const authRouter = express.Router();  // se monta con authCaja en server.js
const pool = require('../../db/pool');
const crypto = require('crypto');

const ADAPTERS = {
  rappi: require('./adapters/rappi'),
  ubereats: require('./adapters/ubereats'),
  didifood: require('./adapters/didifood'),
  agregador: require('./adapters/agregador')
};
const NOMBRE_PLATAFORMA = { rappi: 'Rappi', ubereats: 'Uber Eats', didifood: 'DiDi Food', agregador: 'Agregador' };

async function ensureDeliveryTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integraciones_delivery (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id     UUID NOT NULL REFERENCES sucursales(id),
      plataforma      TEXT NOT NULL,
      modo            TEXT NOT NULL DEFAULT 'directo',
      credenciales    JSONB DEFAULT '{}',
      webhook_token   TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16),'hex'),
      activo          BOOLEAN DEFAULT true,
      creado_en       TIMESTAMPTZ DEFAULT now(),
      UNIQUE(negocio_id, plataforma)
    );
    CREATE TABLE IF NOT EXISTS pedidos_delivery (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      sucursal_id       UUID NOT NULL REFERENCES sucursales(id),
      plataforma        TEXT NOT NULL,
      folio_externo     TEXT NOT NULL,
      folio             TEXT NOT NULL,
      cliente_nombre    TEXT DEFAULT '',
      cliente_telefono  TEXT DEFAULT '',
      direccion_texto   TEXT DEFAULT '',
      notas             TEXT DEFAULT '',
      estado            TEXT DEFAULT 'nuevo',
      subtotal          NUMERIC(12,2) DEFAULT 0,
      costo_envio       NUMERIC(12,2) DEFAULT 0,
      total             NUMERIC(12,2) DEFAULT 0,
      payload_original  JSONB,
      creado_en         TIMESTAMPTZ DEFAULT now(),
      confirmado_en     TIMESTAMPTZ,
      UNIQUE(plataforma, folio_externo)
    );
    CREATE TABLE IF NOT EXISTS pedido_delivery_items (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pedido_id       UUID NOT NULL REFERENCES pedidos_delivery(id) ON DELETE CASCADE,
      nombre_producto TEXT DEFAULT '',
      cantidad        INTEGER DEFAULT 1,
      precio_unitario NUMERIC(12,2) DEFAULT 0,
      notas           TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_delivery_negocio  ON pedidos_delivery(negocio_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_delivery_sucursal ON pedidos_delivery(sucursal_id);
    CREATE INDEX IF NOT EXISTS idx_integraciones_delivery_negocio ON integraciones_delivery(negocio_id);
  `);
}

function folioPedidoDelivery() {
  return 'DEL-' + Date.now().toString().slice(-8) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// ── POST /api/delivery/webhook/:webhook_token — público ──
// Responde 200 siempre y de inmediato (igual que el webhook de Mercado Pago
// en routes/pagos.js) para que el proveedor no reintente por un error nuestro;
// todo el procesamiento real pasa después, en el catch de errores.
router.post('/delivery/webhook/:webhook_token', async (req, res) => {
  res.sendStatus(200);
  try {
    await ensureDeliveryTables();
    const integ = await pool.query(
      'SELECT * FROM integraciones_delivery WHERE webhook_token=$1 AND activo=true',
      [req.params.webhook_token]
    );
    if (!integ.rows.length) return;
    const integracion = integ.rows[0];
    const adaptador = ADAPTERS[integracion.plataforma];
    if (!adaptador) return;

    if (adaptador.verificarFirma && !adaptador.verificarFirma(req, integracion.credenciales)) {
      console.error('Webhook delivery: firma inválida —', integracion.plataforma, integracion.negocio_id);
      return;
    }

    let normalizado = adaptador.normalizar(req.body);
    if (!normalizado.folio_externo) {
      console.error('Webhook delivery: payload sin folio_externo —', integracion.plataforma);
      return;
    }

    // Uber Eats (y potencialmente otras) mandan a veces solo una notificación
    // ligera sin items — si el adaptador sabe pedir el detalle completo, se
    // trae aquí antes de guardar, para no quedarse con un pedido "vacío".
    if ((!normalizado.items || !normalizado.items.length) && adaptador.obtenerDetalleOrden) {
      try {
        const detalle = await adaptador.obtenerDetalleOrden(normalizado.folio_externo, integracion.credenciales);
        if (detalle) normalizado = adaptador.normalizar(detalle);
      } catch(e) { console.error('Webhook delivery: no se pudo traer el detalle completo —', e.message); }
    }

    const folio = folioPedidoDelivery();
    const r = await pool.query(
      `INSERT INTO pedidos_delivery
        (negocio_id, sucursal_id, plataforma, folio_externo, folio, cliente_nombre, cliente_telefono,
         direccion_texto, notas, subtotal, costo_envio, total, payload_original)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (plataforma, folio_externo) DO NOTHING
       RETURNING id`,
      [integracion.negocio_id, integracion.sucursal_id, integracion.plataforma, normalizado.folio_externo, folio,
       normalizado.cliente_nombre, normalizado.cliente_telefono, normalizado.direccion_texto, normalizado.notas,
       normalizado.subtotal, normalizado.costo_envio, normalizado.total, JSON.stringify(req.body)]
    );
    if (!r.rows.length) return; // ya existía (reintento del proveedor) — idempotencia real vía el UNIQUE de la BD

    const pedidoId = r.rows[0].id;
    for (const it of normalizado.items) {
      await pool.query(
        'INSERT INTO pedido_delivery_items (pedido_id, nombre_producto, cantidad, precio_unitario, notas) VALUES ($1,$2,$3,$4,$5)',
        [pedidoId, it.nombre, it.cantidad, it.precio_unitario, it.notas || '']
      );
    }

    const io = req.app.get('io');
    if (io) io.to('negocio:' + integracion.negocio_id).emit('pedido_delivery:nuevo', {
      id: pedidoId, folio, sucursal_id: integracion.sucursal_id, plataforma: integracion.plataforma
    });

    try {
      const { enviarASucursal, crearNotificacion } = require('../push');
      const nombreBonito = NOMBRE_PLATAFORMA[integracion.plataforma] || integracion.plataforma;
      if (enviarASucursal) {
        await enviarASucursal(integracion.sucursal_id, integracion.negocio_id, {
          title: '🛵 Nuevo pedido de ' + nombreBonito,
          body: (normalizado.cliente_nombre || 'Cliente') + ' — folio ' + folio,
          tag: 'pedido_delivery'
        });
      }
      if (crearNotificacion) {
        await crearNotificacion(integracion.negocio_id, integracion.sucursal_id, 'pedido_delivery_nuevo',
          '🛵 Nuevo pedido de ' + nombreBonito, (normalizado.cliente_nombre || 'Cliente') + ' — folio ' + folio, pedidoId);
      }
    } catch(e) {}
  } catch(e) { console.error('Webhook delivery error:', e.message); }
});

// ═══ Rutas autenticadas (montadas con authCaja en server.js) ═══

// ── GET /api/delivery/pedidos — historial de esta sucursal, ?estado= opcional ──
authRouter.get('/delivery/pedidos', async (req, res) => {
  try {
    await ensureDeliveryTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { estado } = req.query;
    const r = await pool.query(`
      SELECT pd.*,
        COALESCE(json_agg(json_build_object(
          'nombre_producto', pdi.nombre_producto, 'cantidad', pdi.cantidad,
          'precio_unitario', pdi.precio_unitario, 'notas', pdi.notas
        )) FILTER (WHERE pdi.id IS NOT NULL), '[]') AS items
      FROM pedidos_delivery pd
      LEFT JOIN pedido_delivery_items pdi ON pdi.pedido_id = pd.id
      WHERE pd.negocio_id=$1 AND pd.sucursal_id=$2 ${estado ? 'AND pd.estado=$3' : ''}
      GROUP BY pd.id
      ORDER BY pd.creado_en DESC
      LIMIT 100`,
      estado ? [negocio_id, sucursal_id, estado] : [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Trae las credenciales guardadas de una plataforma para este negocio —
// usadas para avisarle de vuelta que se aceptó/rechazó el pedido.
async function credencialesDe(negocioId, plataforma) {
  const r = await pool.query('SELECT credenciales FROM integraciones_delivery WHERE negocio_id=$1 AND plataforma=$2', [negocioId, plataforma]);
  return r.rows[0] ? r.rows[0].credenciales : {};
}

// ── POST /api/delivery/pedidos/:id/confirmar ──
// Cambia el estado local Y avisa a la plataforma de origen que se aceptó
// (si el adaptador lo soporta) — sin ese aviso, el pedido puede autocancelarse
// del lado de la plataforma por falta de respuesta a tiempo, aunque en
// Kaixa Pro ya se haya "aceptado". La venta real (mesa, cocina, promos) se
// registra en pos-mexico vía mesas.js al aceptar el pedido, no aquí.
authRouter.post('/delivery/pedidos/:id/confirmar', async (req, res) => {
  try {
    await ensureDeliveryTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      "UPDATE pedidos_delivery SET estado='confirmado', confirmado_en=now() WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND estado='nuevo' RETURNING *",
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido no encontrado o ya procesado' });
    const pedido = r.rows[0];

    let aviso_plataforma = null;
    const adaptador = ADAPTERS[pedido.plataforma];
    if (adaptador && adaptador.aceptarEnPlataforma) {
      try {
        const credenciales = await credencialesDe(negocio_id, pedido.plataforma);
        const resultado = await adaptador.aceptarEnPlataforma(pedido, credenciales);
        if (!resultado.ok) {
          aviso_plataforma = 'No se pudo confirmar el pedido en ' + (NOMBRE_PLATAFORMA[pedido.plataforma] || pedido.plataforma)
            + ' — revísalo manualmente en su panel. ' + (resultado.mensaje || '');
        }
      } catch(e) { aviso_plataforma = 'No se pudo avisar a la plataforma: ' + e.message; }
    }
    res.json({ ok: true, aviso_plataforma });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/delivery/pedidos/:id/rechazar ──
authRouter.post('/delivery/pedidos/:id/rechazar', async (req, res) => {
  try {
    await ensureDeliveryTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { motivo = '' } = req.body || {};
    const r = await pool.query(
      "UPDATE pedidos_delivery SET estado='rechazado' WHERE id=$1 AND negocio_id=$2 AND sucursal_id=$3 AND estado='nuevo' RETURNING *",
      [req.params.id, negocio_id, sucursal_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido no encontrado o ya procesado' });
    const pedido = r.rows[0];

    let aviso_plataforma = null;
    const adaptador = ADAPTERS[pedido.plataforma];
    if (adaptador && adaptador.rechazarEnPlataforma) {
      try {
        const credenciales = await credencialesDe(negocio_id, pedido.plataforma);
        const resultado = await adaptador.rechazarEnPlataforma(pedido, credenciales, motivo);
        if (!resultado.ok) {
          aviso_plataforma = 'No se pudo rechazar el pedido en ' + (NOMBRE_PLATAFORMA[pedido.plataforma] || pedido.plataforma)
            + ' — revísalo manualmente en su panel. ' + (resultado.mensaje || '');
        }
      } catch(e) { aviso_plataforma = 'No se pudo avisar a la plataforma: ' + e.message; }
    }
    res.json({ ok: true, aviso_plataforma });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Config de integraciones (elegir plataforma, modo directo/agregador, credenciales) ──
authRouter.get('/delivery/config', async (req, res) => {
  try {
    await ensureDeliveryTables();
    const { negocio_id, sucursal_id } = req.caja;
    const r = await pool.query(
      'SELECT id, plataforma, modo, credenciales, webhook_token, activo FROM integraciones_delivery WHERE negocio_id=$1 AND sucursal_id=$2 ORDER BY plataforma',
      [negocio_id, sucursal_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

authRouter.put('/delivery/config', async (req, res) => {
  try {
    await ensureDeliveryTables();
    const { negocio_id, sucursal_id } = req.caja;
    const { plataforma, modo = 'directo', credenciales = {}, activo = true } = req.body;
    if (!ADAPTERS[plataforma]) return res.status(400).json({ error: 'Plataforma no reconocida' });
    const r = await pool.query(
      `INSERT INTO integraciones_delivery (negocio_id, sucursal_id, plataforma, modo, credenciales, activo)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (negocio_id, plataforma) DO UPDATE SET
         sucursal_id=$2, modo=$4, credenciales=$5, activo=$6
       RETURNING id, webhook_token`,
      [negocio_id, sucursal_id, plataforma, modo, JSON.stringify(credenciales), activo]
    );
    res.json({ ok: true, id: r.rows[0].id, webhook_token: r.rows[0].webhook_token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, authRouter, ensureDeliveryTables };
