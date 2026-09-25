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

    // ── 4b. Servicios (no llevan inventario) ──
    console.log('\n4b. Servicios sin inventario');
    const serv = uuid();
    await push(cajaA, {
      productos: [{ uuid: serv, nombre: 'Servicio E2E', precio: 100, costo: 0, sucursal_id: s1, es_servicio: true }],
      movimientos: [{ uuid: uuid(), producto_uuid: serv, cantidad: -2, motivo: 'venta', sucursal_id: s1, creado_en: ahora() }]
    });
    check('vender un servicio no mueve stock (queda en 0, no en -2)', (await stockDe(cajaA, serv)) === 0);
    const listaProd = await http('GET', '/api/productos', { token: cajaA });
    const pServ = (Array.isArray(listaProd.data) ? listaProd.data : []).find(p => p.id === serv);
    check('la app móvil recibe el servicio marcado como servicio y con stock 0', pServ && pServ.es_servicio === true && Number(pServ.stock) === 0, pServ);
    const sug = await http('GET', '/api/pedidos/sugeridos', { token: cajaA });
    check('un servicio no aparece en pedidos sugeridos por stock bajo', Array.isArray(sug.data) && !sug.data.some(p => p.id === serv), sug.status);
    // La PC manda las fotos en un segundo envío que no trae "es_servicio": no debe quitarle la marca.
    await push(cajaA, { productos: [{ uuid: serv, nombre: 'Servicio E2E', precio: 100, costo: 0, sucursal_id: s1, imagen_url: 'data:image/png;base64,iVBORw0KGgo=' }] });
    const listaFoto = await http('GET', '/api/productos', { token: cajaA });
    const pServFoto = (Array.isArray(listaFoto.data) ? listaFoto.data : []).find(p => p.id === serv);
    check('el envío de la foto de un servicio no le quita la marca de servicio', pServFoto && pServFoto.es_servicio === true, pServFoto && pServFoto.es_servicio);

    // ── 4c. Cuenta de cliente de la tienda en línea ──
    console.log('\n4c. Cuenta de cliente en la tienda en línea');
    const pc = uuid();
    await push(cajaA, {
      productos: [{ uuid: pc, nombre: 'Producto Tienda E2E', precio: 50, costo: 20, sucursal_id: s1 }],
      movimientos: [{ uuid: uuid(), producto_uuid: pc, cantidad: 10, motivo: 'recepcion', sucursal_id: s1, creado_en: ahora() }]
    });
    const cuenta = '/api/tienda/' + slug + '/cuenta';
    const tel = '33' + String(Math.floor(10000000 + Math.random() * 89999999));
    let rr = await http('POST', cuenta + '/registro', { body: { nombre: 'Cliente E2E', telefono: tel, pin: '123456' } });
    check('crear cuenta responde ok y da sesión', rr.status === 200 && rr.data.ok && rr.data.token, rr);
    const tokCli = rr.data && rr.data.token;
    rr = await http('POST', cuenta + '/registro', { body: { nombre: 'Otro', telefono: tel, pin: '999999' } });
    check('no se puede crear otra cuenta con el mismo teléfono', rr.status === 409, rr.status);
    rr = await http('POST', cuenta + '/registro', { body: { nombre: 'X', telefono: '12', pin: '1' } });
    check('rechaza teléfono y PIN inválidos', rr.status === 400, rr.status);
    rr = await http('POST', cuenta + '/login', { body: { telefono: tel, pin: '000000' } });
    check('un PIN incorrecto no entra', rr.status === 401, rr.status);
    rr = await http('POST', cuenta + '/login', { body: { telefono: tel, pin: '123456' } });
    check('con el PIN correcto entra', rr.status === 200 && rr.data.ok, rr.status);
    const tokCli2 = rr.data && rr.data.token;

    async function tiendaHttp(method, ruta, t, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (t) headers['Authorization'] = 'Bearer ' + t;
      const res = await fetch(BASE + ruta, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await res.json(); } catch (e) {}
      return { status: res.status, data };
    }
    rr = await tiendaHttp('GET', cuenta + '/me', null);
    check('sin sesión no se ve el perfil', rr.status === 401, rr.status);
    rr = await tiendaHttp('GET', cuenta + '/me', tokCli);
    check('con sesión se ve el perfil', rr.status === 200 && rr.data.perfil && rr.data.perfil.nombre === 'Cliente E2E', rr.data);

    rr = await tiendaHttp('POST', '/api/tienda/' + slug + '/pedidos', tokCli, {
      sucursal_id: s1, cliente_nombre: 'Cliente E2E', cliente_telefono: tel, items: [{ producto_id: pc, cantidad: 2 }] });
    check('pedir con la sesión iniciada funciona', rr.status === 200 && rr.data.ok, rr.data);
    rr = await tiendaHttp('POST', '/api/tienda/' + slug + '/pedidos', null, {
      sucursal_id: s1, cliente_nombre: 'Anónimo', cliente_telefono: tel, items: [{ producto_id: pc, cantidad: 1 }] });
    check('pedir sin cuenta sigue funcionando', rr.status === 200 && rr.data.ok, rr.data);
    rr = await tiendaHttp('GET', cuenta + '/pedidos', tokCli);
    check('el historial muestra solo el pedido hecho con la cuenta', rr.status === 200 && rr.data.pedidos.length === 1 && rr.data.pedidos[0].items[0].cantidad === 2, rr.data);
    rr = await tiendaHttp('PUT', cuenta + '/me', tokCli, { direccion_calle: 'Calle Prueba', direccion_colonia: 'Centro' });
    check('se guarda la dirección en la cuenta', rr.status === 200 && rr.data.perfil.direccion_calle === 'Calle Prueba', rr.data);
    rr = await tiendaHttp('POST', cuenta + '/logout', tokCli);
    rr = await tiendaHttp('GET', cuenta + '/me', tokCli);
    check('al cerrar sesión el token deja de servir', rr.status === 401, rr.status);
    rr = await tiendaHttp('GET', cuenta + '/me', tokCli2);
    check('otra sesión de la misma cuenta sigue activa', rr.status === 200, rr.status);

    const tel2 = '33' + String(Math.floor(10000000 + Math.random() * 89999999));
    await http('POST', cuenta + '/registro', { body: { nombre: 'Bloqueo E2E', telefono: tel2, pin: '654321' } });
    for (let i = 0; i < 5; i++) await http('POST', cuenta + '/login', { body: { telefono: tel2, pin: '111111' } });
    rr = await http('POST', cuenta + '/login', { body: { telefono: tel2, pin: '654321' } });
    check('tras 5 PIN incorrectos la cuenta se bloquea unos minutos (aunque luego se acierte)', rr.status === 429, rr.status);

    // ── 4d. Citas para servicios ──
    console.log('\n4d. Citas para servicios');
    const horarioAbierto = {};
    for (let d = 0; d <= 6; d++) horarioAbierto[d] = { abierto: true, desde: '09:00', hasta: '18:00' };
    let cr = await http('PUT', '/api/citas-config', { token: cajaA, body: { activo: true, duracion_min: 60, simultaneas: 1, anticipacion_horas: 0, dias_adelante: 14, domicilio: true, costo_domicilio: 50, horario: horarioAbierto } });
    check('el negocio activa las citas y define su horario', cr.status === 200 && cr.data.ok, cr);
    cr = await http('PUT', '/api/citas-config', { token: cajaA, body: { horario: { 1: { abierto: true, desde: '18:00', hasta: '09:00' } } } });
    check('rechaza un horario donde cierra antes de abrir', cr.status === 400, cr.status);
    const info = await http('GET', '/api/tienda/' + slug + '/info');
    check('la tienda sabe que las citas están activas', info.data && info.data.negocio && info.data.negocio.citas_activo === true, info.data && info.data.negocio && info.data.negocio.citas_activo);
    const cat = await http('GET', '/api/tienda/' + slug + '/productos?sucursal_id=' + s1);
    check('con citas activas el servicio aparece en el catálogo de la tienda', Array.isArray(cat.data) && cat.data.some(p => p.id === serv && p.es_servicio === true));

    const disp = await http('GET', '/api/tienda/' + slug + '/citas/disponibilidad?sucursal_id=' + s1);
    check('la tienda ofrece días y horas libres', disp.status === 200 && disp.data.activo && disp.data.dias.length > 0 && disp.data.dias[0].horas.length > 0, disp.data);
    const dia1 = disp.data.dias[0], hora1 = dia1.horas[0], hora2 = dia1.horas[1];
    const cuerpoCita = (hora, prod) => ({ sucursal_id: s1, producto_id: prod || serv, fecha: dia1.fecha, hora, cliente_nombre: 'Cliente Cita', cliente_telefono: tel, notas: 'prueba' });
    let cita = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', tokCli2, cuerpoCita(hora1));
    check('agendar una cita funciona', cita.status === 200 && cita.data.ok && cita.data.folio, cita.data);
    const citaId = cita.data && cita.data.id;
    const otra = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(hora1), { cliente_nombre: 'Otra persona', cliente_telefono: '3399999999' }));
    check('el mismo horario ya no se puede reservar dos veces', otra.status === 409, otra.data);
    const noServ = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, cuerpoCita(hora2, prod));
    check('no se puede agendar cita de un producto que no es servicio', noServ.status === 400, noServ.data);
    const sinTel = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(hora2), { cliente_telefono: '12' }));
    check('pide un teléfono válido para confirmar', sinTel.status === 400, sinTel.status);
    check('la tienda sabe que se ofrece servicio a domicilio y su costo', disp.data.domicilio === true && disp.data.costo_domicilio === 50, [disp.data.domicilio, disp.data.costo_domicilio]);
    const domSinDir = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(hora2), { a_domicilio: true }));
    check('una cita a domicilio exige la dirección', domSinDir.status === 400, domSinDir.data);
    // Un servicio con la casilla "A domicilio" apagada (Inventario → Otros) no se ofrece a domicilio.
    const servSoloNeg = uuid();
    await push(cajaA, { productos: [{ uuid: servSoloNeg, nombre: 'Servicio Solo Negocio', precio: 80, costo: 0, sucursal_id: s1, es_servicio: true, disponible_domicilio: false }] });
    const catSolo = await http('GET', '/api/tienda/' + slug + '/productos?sucursal_id=' + s1);
    const pSolo = Array.isArray(catSolo.data) && catSolo.data.find(p => p.id === servSoloNeg);
    check('la tienda sabe que ese servicio no es a domicilio', pSolo && pSolo.disponible_domicilio === false, pSolo && pSolo.disponible_domicilio);
    const domNo = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(hora2, servSoloNeg), {
      a_domicilio: true, direccion_calle: 'Av. Prueba', direccion_colonia: 'Centro' }));
    check('no deja agendar a domicilio un servicio que no se ofrece a domicilio', domNo.status === 400, domNo.data);
    const enNeg = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(dia1.horas[2] || hora2, servSoloNeg), { cliente_telefono: '3388888888' }));
    check('ese mismo servicio sí se puede agendar en el negocio', enNeg.status === 200 && enNeg.data.ok, enNeg.data);
    const domOk = await tiendaHttp('POST', '/api/tienda/' + slug + '/citas', null, Object.assign(cuerpoCita(hora2), {
      cliente_nombre: 'Cliente Domicilio', a_domicilio: true, direccion_calle: 'Av. Prueba', direccion_numero: '123', direccion_colonia: 'Centro', direccion_ciudad: 'Guadalajara', direccion_cp: '44100', direccion_referencias: 'casa azul' }));
    check('agendar una cita a domicilio con dirección funciona y cobra el costo', domOk.status === 200 && domOk.data.ok && domOk.data.a_domicilio === true && domOk.data.costo_domicilio === 50, domOk.data);
    const listaDom = await http('GET', '/api/citas', { token: cajaA });
    const citaDom = Array.isArray(listaDom.data) && listaDom.data.find(c => c.id === (domOk.data && domOk.data.id));
    check('el negocio ve la dirección del cliente en la cita a domicilio', citaDom && citaDom.a_domicilio === true && citaDom.direccion_calle === 'Av. Prueba' && citaDom.direccion_colonia === 'Centro', citaDom);
    const disp2 = await http('GET', '/api/tienda/' + slug + '/citas/disponibilidad?sucursal_id=' + s1);
    check('el horario reservado desaparece de la disponibilidad', !disp2.data.dias[0] || disp2.data.dias[0].fecha !== dia1.fecha || !disp2.data.dias[0].horas.includes(hora1), disp2.data.dias[0]);

    const lista = await http('GET', '/api/citas', { token: cajaA });
    const enLista = Array.isArray(lista.data) && lista.data.find(c => c.id === citaId);
    check('el negocio ve la cita pendiente en su app', enLista && enLista.estado === 'pendiente' && enLista.cliente_nombre === 'Cliente Cita', lista.data);
    cr = await http('PUT', '/api/citas/' + citaId + '/estado', { token: cajaA, body: { estado: 'confirmada' } });
    check('el negocio confirma la cita', cr.status === 200 && cr.data.ok, cr);
    cr = await http('PUT', '/api/citas/' + citaId + '/estado', { token: cajaA, body: { estado: 'confirmada' } });
    check('no se puede confirmar dos veces la misma cita', cr.status === 404, cr.status);
    const misCitas = await tiendaHttp('GET', cuenta + '/citas', tokCli2);
    check('el cliente ve su cita en su cuenta como confirmada', misCitas.status === 200 && misCitas.data.citas.length === 1 && misCitas.data.citas[0].estado === 'confirmada', misCitas.data);
    const canc = await tiendaHttp('PUT', cuenta + '/citas/' + citaId + '/cancelar', tokCli2);
    check('el cliente puede cancelar su cita', canc.status === 200 && canc.data.ok, canc.data);
    const disp3 = await http('GET', '/api/tienda/' + slug + '/citas/disponibilidad?sucursal_id=' + s1);
    check('al cancelar, el horario vuelve a quedar libre', disp3.data.dias[0].fecha === dia1.fecha && disp3.data.dias[0].horas.includes(hora1), disp3.data.dias[0]);

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

      console.log('\n7. Tope de dispositivos por licencia');
      const licCrear = await http('POST', '/api/lic/licencias', { admin: adm, body: { cliente_nombre: 'ZZ_TEST_E2E_' + sufijo, plan: 'basico', vence_meses: 1 } });
      check('crear licencia sin max_usuarios explícito toma el default del plan (básico = 1)', licCrear.status === 200 && licCrear.data.licencia.max_usuarios === 1, licCrear.data);
      const licId = licCrear.data.licencia && licCrear.data.licencia.id;
      const licEditar = await http('PUT', '/api/lic/licencias/' + licId, { admin: adm, body: { cliente_nombre: 'ZZ_TEST_E2E_' + sufijo, plan: 'pro', max_usuarios: 2 } });
      const licLista = await http('GET', '/api/lic/licencias?q=ZZ_TEST_E2E_' + sufijo, { admin: adm });
      const licGuardada = (licLista.data || []).find(l => l.id === licId);
      check('editar la licencia con max_usuarios explícito lo respeta (2, no el default de pro=3)', licEditar.status === 200 && licGuardada && licGuardada.max_usuarios === 2, licGuardada);
      const licVincular = await http('PUT', '/api/lic/licencias/' + licId + '/vincular', { admin: adm, body: { negocio_id: negocioId } });
      check('vincular la licencia al negocio de prueba', licVincular.status === 200 && licVincular.data.ok, licVincular.data);

      // El negocio de prueba ya tiene 3 cajas activas (A, B, C) de las pruebas anteriores — de sobra para 2.
      const cajaExtra = await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s1, nombre: 'Caja Extra Tope', tipo: 'extra' } });
      check('con el tope ya rebasado (3 activas, límite 2), crear una caja más se rechaza', cajaExtra.status === 409, cajaExtra.data);

      // Con límite 2 y 3 activas (A,B,C), hay que liberar DOS para quedar bajo el límite (1 activa) y poder crear otra.
      const listaCajas = await http('GET', '/api/admin/cajas/' + negocioId);
      const cajaBId = (listaCajas.data || []).find(c => c.nombre === 'B');
      const cajaCId = (listaCajas.data || []).find(c => c.nombre === 'C');
      await http('PUT', '/api/admin/cajas/' + (cajaBId && cajaBId.id) + '/desactivar', { body: {} });
      const desactivarC = await http('PUT', '/api/admin/cajas/' + (cajaCId && cajaCId.id) + '/desactivar', { body: {} });
      check('desactivar cajas responde ok', desactivarC.status === 200, desactivarC.data);
      const cajaTrasLiberar = await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s1, nombre: 'Caja Extra Tope 2', tipo: 'extra' } });
      check('tras liberar lugares (1 activa de 2), sí se puede crear otra caja', cajaTrasLiberar.status === 200 && cajaTrasLiberar.data.ok, cajaTrasLiberar.data);
      const cajaTrasLimite = await http('POST', '/api/admin/cajas', { body: { negocio_id: negocioId, sucursal_id: s1, nombre: 'Caja Extra Tope 3', tipo: 'extra' } });
      check('al volver a llegar al límite (2/2), se rechaza de nuevo', cajaTrasLimite.status === 409, cajaTrasLimite.data);

      console.log('\n8. Control de dispositivos que activan una licencia (misma clave, límite 2)');
      const clave = licCrear.data.licencia.clave;
      const verif = (dispId, nombre) => http('POST', '/api/verificar', { body: { clave, dispositivo_id: dispId, nombre_equipo: nombre } });
      const d1 = await verif('e2e-dispositivo-1', 'PC Mostrador');
      check('primer dispositivo activa sin problema', d1.status === 200 && d1.data.ok, d1.data);
      const d1otra = await verif('e2e-dispositivo-1', 'PC Mostrador');
      check('el mismo dispositivo vuelve a verificar sin gastar otro lugar', d1otra.status === 200 && d1otra.data.ok, d1otra.data);
      const d2 = await verif('e2e-dispositivo-2', 'Laptop Bodega');
      check('segundo dispositivo (distinto) activa hasta llegar al límite (2/2)', d2.status === 200 && d2.data.ok, d2.data);
      const d3 = await verif('e2e-dispositivo-3', 'PC Pirata');
      check('un tercer dispositivo nuevo se rechaza por exceder el límite', d3.status === 200 && d3.data.ok === false, d3.data);
      check('el rechazo por límite trae estado "limite_dispositivos" (para que la app sepa bloquear sin dar opción de bypass)', d3.data.estado === 'limite_dispositivos', d3.data);
      const listaDisp = await http('GET', '/api/lic/licencias/' + licId + '/dispositivos', { admin: adm });
      check('el panel lista los 2 dispositivos activos y sus nombres', Array.isArray(listaDisp.data) && listaDisp.data.filter(x => x.activo).length === 2 && listaDisp.data.some(x => x.nombre_equipo === 'PC Mostrador'), listaDisp.data);
      const dispALiberar = listaDisp.data.find(x => x.dispositivo_id === 'e2e-dispositivo-2');
      const liberar = await http('PUT', '/api/lic/licencias/' + licId + '/dispositivos/' + dispALiberar.id + '/liberar', { admin: adm });
      check('liberar un dispositivo responde ok', liberar.status === 200 && liberar.data.ok, liberar.data);
      const d3tras = await verif('e2e-dispositivo-3', 'PC Pirata');
      check('tras liberar un lugar, el dispositivo que antes se rechazó ahora sí activa', d3tras.status === 200 && d3tras.data.ok, d3tras.data);

      console.log('\n9. Suspender / reactivar licencia (botón del panel)');
      const suspender = await http('PUT', '/api/lic/licencias/' + licId + '/estado', { admin: adm, body: { estado: 'suspendida' } });
      check('el botón "Suspender" responde ok', suspender.status === 200 && suspender.data.ok, suspender.data);
      const verTrasSuspender = await verif('e2e-dispositivo-1', 'PC Mostrador');
      check('un dispositivo YA activado se rechaza en cuanto la licencia se suspende (no solo los nuevos)', verTrasSuspender.status === 200 && verTrasSuspender.data.ok === false, verTrasSuspender.data);
      check('el rechazo por suspensión trae estado "suspendida" (para que la app bloquee sin dar opción de bypass)', verTrasSuspender.data.estado === 'suspendida', verTrasSuspender.data);
      const activar = await http('PUT', '/api/lic/licencias/' + licId + '/estado', { admin: adm, body: { estado: 'activa' } });
      check('el botón "Activar" responde ok', activar.status === 200 && activar.data.ok, activar.data);
      const verTrasActivar = await verif('e2e-dispositivo-1', 'PC Mostrador');
      check('al reactivar, ese mismo dispositivo vuelve a pasar de inmediato', verTrasActivar.status === 200 && verTrasActivar.data.ok, verTrasActivar.data);

      const licSinLimite = await http('POST', '/api/lic/licencias', { admin: adm, body: { cliente_nombre: 'ZZ_TEST_E2E_' + sufijo + '_ilimitado', plan: 'ilimitado' } });
      check('el plan "ilimitado" guarda max_usuarios = null (sin límite)', licSinLimite.status === 200 && licSinLimite.data.licencia.max_usuarios === null, licSinLimite.data);
      await http('DELETE', '/api/lic/licencias/' + (licSinLimite.data.licencia && licSinLimite.data.licencia.id), { admin: adm });
      await http('DELETE', '/api/lic/licencias/' + licId, { admin: adm });
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
