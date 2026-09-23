// tests/e2e.js — Prueba de punta a punta contra un servidor Kaixa en vivo.
// Crea un negocio desechable, verifica sync / stock / multi-caja / traspasos /
// tienda en línea, y lo borra al terminar. Nunca toca datos de clientes reales.
//
//   npm test                                  (usa https://kaixa-cloud.onrender.com)
//   KAIXA_URL=http://localhost:3000 npm test
//   KAIXA_ADMIN_USER=... KAIXA_ADMIN_PASS=... npm test   (además corre la auditoría)
const crypto = require('crypto');

const BASE = (process.env.KAIXA_URL || 'https://kaixa-cloud.onrender.com').replace(/\/$/, '');
const ADMIN_USER = process.env.KAIXA_ADMIN_USER;
const ADMIN_PASS = process.env.KAIXA_ADMIN_PASS;

let pasadas = 0, falladas = 0;
const fallos = [];

async function http(method, ruta, { token, admin, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-caja-token'] = token;
  if (admin) headers['x-token'] = admin;
  const res = await fetch(BASE + ruta, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function check(nombre, condicion, detalle) {
  if (condicion) { pasadas++; console.log('  ✓ ' + nombre); }
  else { falladas++; fallos.push(nombre); console.log('  ✗ ' + nombre + (detalle !== undefined ? '  → ' + JSON.stringify(detalle) : '')); }
}

async function stockDe(token, productoId) {
  const r = await http('GET', '/api/sync/stock/' + productoId, { token });
  return r.data && r.data.stock;
}

async function push(token, body) {
  return http('POST', '/api/sync/push', { token, body });
}

const uuid = () => crypto.randomUUID();
const ahora = () => new Date().toISOString();

async function main() {
  console.log('Servidor: ' + BASE);
  const sufijo = crypto.randomBytes(3).toString('hex');
  let negocioId = null;

  try {
    // ── Preparación ──
    const n = await http('POST', '/api/admin/negocios', { body: { nombre: 'ZZ_TEST_E2E_' + sufijo, giro_principal: 'tienda' } });
    if (n.status !== 200) throw new Error('No se pudo crear el negocio de prueba: ' + JSON.stringify(n.data));
    negocioId = n.data.negocio.id;
    const slug = n.data.negocio.slug;
    const s1 = (await http('POST', '/api/admin/sucursales', { body: { negocio_id: negocioId, nombre: 'Centro' } })).data.sucursal.id;
    const s2 = (await http('POST', '/api/admin/sucursales', { body: { negocio_id: negocioId, nombre: 'Norte' } })).data.sucursal.id;
    const cajaA = (await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s1, nombre: 'A', tipo: 'madre' } })).data.token;
    const cajaB = (await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s1, nombre: 'B', tipo: 'extra' } })).data.token;
    const cajaC = (await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s2, nombre: 'C', tipo: 'madre' } })).data.token;

    // ── 1. Stock inicial no se duplica ──
    console.log('\n1. Stock inicial');
    const prod = uuid();
    let r = await push(cajaA, {
      productos: [{ uuid: prod, nombre: 'Producto E2E', precio: 10, costo: 5, sucursal_id: s1 }],
      movimientos: [{ uuid: uuid(), producto_uuid: prod, cantidad: 20, motivo: 'recepcion', sucursal_id: s1, creado_en: ahora() }]
    });
    check('push de producto nuevo con stock inicial responde ok', r.status === 200 && r.data.ok, r);
    check('stock inicial = 20', (await stockDe(cajaA, prod)) === 20);

    r = await push(cajaA, {
      movimientos: [
        { uuid: uuid(), producto_uuid: prod, cantidad: 20, motivo: 'recepcion', sucursal_id: s1, creado_en: ahora() },
        { uuid: uuid(), producto_uuid: prod, cantidad: -3, motivo: 'venta', sucursal_id: s1, creado_en: ahora() }
      ]
    });
    check('una recepción duplicada no tumba el push', r.status === 200 && r.data.ok, r);
    check('la recepción duplicada se rechazó y la venta del mismo push sí se aplicó (17)', (await stockDe(cajaA, prod)) === 17);

    const idRepetido = uuid();
    const movRepetido = { uuid: idRepetido, producto_uuid: prod, cantidad: -1, motivo: 'venta', sucursal_id: s1, creado_en: ahora() };
    await push(cajaA, { movimientos: [movRepetido] });
    await push(cajaA, { movimientos: [movRepetido] });
    check('reenviar el mismo movimiento (reintento de red) no lo cuenta dos veces (16)', (await stockDe(cajaA, prod)) === 16);

    // ── 2. Multi-caja ──
    console.log('\n2. Multi-caja en la misma sucursal');
    await Promise.all([
      push(cajaA, { movimientos: [{ uuid: uuid(), producto_uuid: prod, cantidad: -5, motivo: 'venta', sucursal_id: s1, creado_en: ahora() }] }),
      push(cajaB, { movimientos: [{ uuid: uuid(), producto_uuid: prod, cantidad: -7, motivo: 'venta', sucursal_id: s1, creado_en: ahora() }] })
    ]);
    check('dos cajas vendiendo a la vez suman bien (16 - 5 - 7 = 4)', (await stockDe(cajaA, prod)) === 4);

    // ── 3. PC vs tienda en línea ──
    console.log('\n3. Consistencia PC vs tienda en línea');
    const pull = await http('GET', '/api/sync/pull?since=1970-01-01T00:00:00Z', { token: cajaB });
    const pEnPull = (pull.data.productos || []).find(p => p.id === prod);
    const tienda = await http('GET', '/api/tienda/' + slug + '/productos?sucursal_id=' + s1);
    const pEnTienda = (Array.isArray(tienda.data) ? tienda.data : []).find(p => p.id === prod);
    check('la PC (pull) ve stock 4', pEnPull && Number(pEnPull.stock_actual) === 4, pEnPull && pEnPull.stock_actual);
    check('la tienda en línea ve el mismo stock 4', pEnTienda && Number(pEnTienda.stock) === 4, pEnTienda && pEnTienda.stock);

    // ── 4. Traspasos ──
    console.log('\n4. Traspasos entre sucursales');
    const admin = { usuario_rol: 'admin', usuario_nombre: 'Test' };
    r = await http('POST', '/api/traspasos', { token: cajaA, body: { producto_id: prod, sucursal_destino_id: s2, cantidad: 100, ...admin } });
    check('no deja traspasar más de lo que hay', r.status === 400, r);
    r = await http('POST', '/api/traspasos', { token: cajaA, body: { producto_id: prod, sucursal_destino_id: s2, cantidad: 1, usuario_rol: 'cajero' } });
    check('un cajero no puede traspasar', r.status === 403, r);

    r = await http('POST', '/api/traspasos', { token: cajaA, body: { producto_id: prod, sucursal_destino_id: s2, cantidad: 3, ...admin } });
    check('crear traspaso responde ok', r.status === 200 && r.data.ok, r);
    const t1 = r.data.traspaso;
    check('al enviar, el origen baja de inmediato (4 → 1)', (await stockDe(cajaA, prod)) === 1);
    check('el destino sigue en 0 hasta que confirme', (await stockDe(cajaC, t1.producto_destino_id)) === 0);
    r = await http('PUT', '/api/traspasos/' + t1.id + '/recibir', { token: cajaC, body: {} });
    check('recibir traspaso responde ok', r.status === 200 && r.data.ok, r);
    check('al recibir, el destino sube a 3', (await stockDe(cajaC, t1.producto_destino_id)) === 3);
    check('el origen se queda en 1', (await stockDe(cajaA, prod)) === 1);

    r = await http('POST', '/api/traspasos', { token: cajaA, body: { producto_id: prod, sucursal_destino_id: s2, cantidad: 1, ...admin } });
    const t2 = r.data.traspaso;
    check('el segundo traspaso deja el origen en 0', (await stockDe(cajaA, prod)) === 0);
    r = await http('PUT', '/api/traspasos/' + t2.id + '/rechazar', { token: cajaC, body: {} });
    check('rechazar traspaso responde ok', r.status === 200 && r.data.ok, r);
    check('al rechazar, el stock regresa al origen (1)', (await stockDe(cajaA, prod)) === 1);
    check('el destino no recibió nada de lo rechazado (3)', (await stockDe(cajaC, t1.producto_destino_id)) === 3);

    // ── 5. Auditoría ──
    console.log('\n5. Auditoría de datos');
    if (ADMIN_USER && ADMIN_PASS) {
      const login = await http('POST', '/api/lic/login', { body: { usuario: ADMIN_USER, password: ADMIN_PASS } });
      const aud = await http('GET', '/api/admin/auditoria', { admin: login.data && login.data.token });
      check('la auditoría responde', aud.status === 200, aud.status);
      const criticas = ((aud.data && aud.data.resultados) || []).filter(x => x.severidad === 'critica');
      const delTest = criticas.filter(x => JSON.stringify(x.muestra).includes('ZZ_TEST_E2E_' + sufijo));
      check('la auditoría no encuentra problemas críticos en el negocio de prueba', delTest.length === 0, delTest.map(x => x.id));

      console.log('\n6. Resumen diario al dueño');
      const ventaId = uuid();
      await push(cajaA, {
        ventas: [{ uuid: ventaId, folio: 'E2E-1', subtotal: 20, total: 20, forma_pago: 'efectivo', estado: 'completada', creado_en: ahora(),
                   items: [{ uuid: uuid(), producto_uuid: prod, nombre_producto: 'Producto E2E', cantidad: 2, precio_unitario: 10 }] }]
      });
      const adm = login.data && login.data.token;
      const sinVentas = await http('POST', '/api/admin/resumen-diario/probar', { admin: adm, body: { negocio_id: negocioId } });
      const suc1 = (sinVentas.data.sucursales || []).find(x => x.sucursal === 'Centro');
      check('el resumen cuenta la venta del día', suc1 && suc1.datos.ventas === 1 && suc1.datos.total === 20, suc1 && suc1.datos);
      check('el resumen lista lo más vendido', suc1 && suc1.datos.top[0] && suc1.datos.top[0].producto === 'Producto E2E' && suc1.datos.top[0].unidades === 2);
      const env = await http('POST', '/api/admin/resumen-diario/probar', { admin: adm, body: { negocio_id: negocioId, enviar: true } });
      check('el envío de prueba genera el resumen solo de la sucursal con ventas', env.status === 200 && env.data.sucursales.length === 1, env.data);
    } else {
      console.log('  (omitida: define KAIXA_ADMIN_USER y KAIXA_ADMIN_PASS para correrla)');
    }
  } finally {
    if (negocioId) {
      const d = await http('DELETE', '/api/admin/negocios/' + negocioId);
      console.log('\nLimpieza del negocio de prueba: ' + (d.status === 200 ? 'ok' : 'FALLÓ ' + JSON.stringify(d.data)));
    }
  }

  console.log('\n' + pasadas + ' pasaron, ' + falladas + ' fallaron');
  if (falladas) { console.log('Fallaron: ' + fallos.join(' | ')); process.exit(1); }
}

main().catch(e => { console.error('Error inesperado:', e.message); process.exit(1); });
