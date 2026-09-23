// routes/resumen.js — Resumen diario de ventas para el dueño (push + campana + WhatsApp)
const pool = require('../db/pool');
const { enviarASucursal, crearNotificacion } = require('./push');
const { enviarWhatsapp } = require('./whatsapp');

const ZONA = 'America/Mexico_City';
const HORA_ENVIO = 21;

const dinero = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fechaHoyMx() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());
}
function horaMx() {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(new Date()), 10);
}

// Calcula el resumen del día (hora de México) de una sucursal. Solo lee.
async function construirResumen(negocioId, sucursalId) {
  const dia = `(v.creado_en AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date`;
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS ventas, COALESCE(SUM(v.total),0) AS total
     FROM ventas v WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND v.estado='completada' AND ${dia}`,
    [negocioId, sucursalId]
  );
  const { ventas, total } = tot.rows[0];
  const top = await pool.query(
    `SELECT d.nombre_producto, SUM(d.cantidad) AS unidades
     FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
     WHERE v.negocio_id=$1 AND v.sucursal_id=$2 AND v.estado='completada' AND ${dia}
     GROUP BY d.nombre_producto ORDER BY SUM(d.subtotal) DESC LIMIT 3`,
    [negocioId, sucursalId]
  );
  const bajos = await pool.query(
    `SELECT COUNT(*)::int AS n FROM productos p
     LEFT JOIN stock_actual sa ON sa.producto_id = p.id AND sa.sucursal_id = p.sucursal_id
     WHERE p.negocio_id=$1 AND p.sucursal_id=$2 AND p.activo=true AND COALESCE(p.es_servicio,false)=false
       AND COALESCE(sa.stock,0) <= p.stock_minimo`,
    [negocioId, sucursalId]
  );
  const caducan = await pool.query(
    `SELECT COUNT(*)::int AS n FROM lotes
     WHERE negocio_id=$1 AND sucursal_id=$2 AND activo=true AND fecha_caducidad IS NOT NULL
       AND fecha_caducidad BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`,
    [negocioId, sucursalId]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const datos = {
    ventas, total: Number(total),
    ticket_promedio: ventas ? Number(total) / ventas : 0,
    top: top.rows.map(r => ({ producto: r.nombre_producto, unidades: Number(r.unidades) })),
    stock_bajo: bajos.rows[0].n,
    lotes_por_caducar: caducan.rows[0].n
  };

  const lineas = [ventas + ' venta(s) por ' + dinero(datos.total) + ' (ticket promedio ' + dinero(datos.ticket_promedio) + ')'];
  if (datos.top.length) lineas.push('Lo más vendido: ' + datos.top.map(t => t.producto + ' x' + t.unidades).join(', '));
  if (datos.stock_bajo) lineas.push(datos.stock_bajo + ' producto(s) con stock bajo');
  if (datos.lotes_por_caducar) lineas.push(datos.lotes_por_caducar + ' lote(s) caducan en 7 días');
  return { datos, texto: lineas.join('\n') };
}

// Reclama el envío de un día en forma atómica: solo una vez por sucursal/tipo/fecha.
async function reclamar(sucursalId, tipo, fecha) {
  const r = await pool.query(
    `INSERT INTO alertas_enviadas (sucursal_id, tipo, clave) VALUES ($1,$2,$3)
     ON CONFLICT (sucursal_id, tipo, clave) DO NOTHING RETURNING id`,
    [sucursalId, tipo, fecha]
  );
  return r.rows.length > 0;
}

// Envía el resumen de un negocio. forzar=true ignora la hora y el "ya se envió hoy" (pruebas).
async function enviarResumenNegocio(negocioId, { forzar = false } = {}) {
  const fecha = fechaHoyMx();
  const suc = await pool.query(
    'SELECT s.id, s.nombre FROM sucursales s WHERE s.negocio_id=$1 AND s.activo=true ORDER BY s.creado_en', [negocioId]);
  const enviados = [];
  const lineasWa = [];
  for (const s of suc.rows) {
    const { datos, texto } = await construirResumen(negocioId, s.id);
    if (!datos.ventas) continue;
    if (!forzar && !(await reclamar(s.id, 'resumen_diario', fecha))) continue;
    const titulo = '📊 Resumen del día — ' + s.nombre;
    await enviarASucursal(s.id, negocioId, { title: titulo, body: texto, tag: 'resumen_diario' });
    await crearNotificacion(negocioId, s.id, 'resumen_diario', titulo, texto, fecha);
    lineasWa.push('*' + s.nombre + '*\n' + texto);
    enviados.push({ sucursal: s.nombre, ...datos });
  }
  let whatsapp = 'no_aplica';
  if (lineasWa.length) {
    const neg = await pool.query('SELECT whatsapp_alertas_telefono FROM negocios WHERE id=$1', [negocioId]).catch(() => ({ rows: [] }));
    const tel = neg.rows[0] && neg.rows[0].whatsapp_alertas_telefono;
    if (tel) {
      const r = await enviarWhatsapp(negocioId, tel, '📊 Resumen del día\n\n' + lineasWa.join('\n\n'));
      whatsapp = r.ok ? 'enviado' : 'error: ' + r.error;
    } else whatsapp = 'sin_telefono_configurado';
  }
  return { fecha, sucursales: enviados, whatsapp };
}

// Corre cada ~30 min desde server.js; solo actúa a partir de las 9 pm hora de México.
async function revisarResumenDiario() {
  try {
    if (horaMx() < HORA_ENVIO) return;
    const negs = await pool.query('SELECT id FROM negocios WHERE activo=true');
    for (const n of negs.rows) {
      try { await enviarResumenNegocio(n.id); }
      catch (e) { console.error('⚠️ Resumen diario del negocio ' + n.id + ':', e.message); }
    }
  } catch (e) { console.error('❌ Error en resumen diario:', e.message); }
}

module.exports = { construirResumen, enviarResumenNegocio, revisarResumenDiario };
