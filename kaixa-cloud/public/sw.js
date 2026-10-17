// Service Worker — Kaixa Pro PWA
const CACHE = 'kaixa-v4';
const ASSETS = ['/', '/index.html', '/kaixa_icon.png', '/kaixa_mascot.png'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS.map(function(a){try{return a;}catch(e){return null;}})).catch(function(){}); }));
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.url.includes('/api/')) return; // No cachear APIs
  var esDocumento = e.request.mode === 'navigate' || e.request.destination === 'document' || e.request.url.endsWith('/index.html') || e.request.url.endsWith('/sw.js');
  if (!esDocumento) {
    e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
    return;
  }
  // El documento principal (index.html, navegaciones) se pide siempre con
  // cache:'no-store' — sin esto, un fetch "normal" puede resolverse desde
  // la caché HTTP del propio navegador sin tocar la red, aunque este
  // código diga "network-first": el navegador decide eso antes de que el
  // service worker vea nada. Eso significa que si no hay internet o el
  // servidor tarda en responder (Render puede tardar en "despertar" si
  // estuvo un rato sin tráfico), antes se dejaba al usuario esperando
  // mucho rato con la pantalla en blanco. Ahora, si la red no responde en
  // 4 segundos, se muestra de inmediato la última copia buena conocida (si
  // existe) mientras la petición de red sigue de fondo — y esa respuesta,
  // si llega bien, se guarda como la nueva "última copia buena" para la
  // próxima vez.
  e.respondWith((async function() {
    var peticion = new Request(e.request.url, { cache: 'no-store' });
    var redPromise = fetch(peticion).then(function(resp) {
      if (resp && resp.ok) {
        var copia = resp.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, copia); }).catch(function() {});
      }
      return resp;
    }).catch(function() { return null; });
    var tope = new Promise(function(resolve) { setTimeout(function() { resolve('TOPE'); }, 4000); });
    var primero = await Promise.race([redPromise, tope]);
    if (primero && primero !== 'TOPE') return primero; // la red respondió a tiempo
    var cached = await caches.match(e.request);
    if (cached) return cached; // la red tarda — mostrar lo último bueno conocido mientras tanto
    var final = await redPromise;
    return final || new Response('Sin conexión', { status: 503 });
  })());
});

// ── Notificaciones push (stock bajo / lotes por caducar) ──────
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}
  var title = data.title || 'Kaixa Pro';
  var options = {
    body: data.body || '',
    icon: '/kaixa_icon.png',
    badge: '/kaixa_icon.png',
    tag: data.tag || 'kaixa',
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(url) !== -1 && 'focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
