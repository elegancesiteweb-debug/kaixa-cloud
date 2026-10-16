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
  // El documento principal (index.html, navegaciones) se pide siempre con
  // cache:'no-store' — sin esto, un fetch "normal" puede resolverse desde
  // la caché HTTP del propio navegador sin tocar la red, aunque este
  // código diga "network-first": el navegador decide eso antes de que el
  // service worker vea nada. Resultado real: el teléfono podía quedarse
  // viendo una versión vieja del código indefinidamente aunque hubiera
  // internet y ya se hubiera subido una versión nueva al servidor.
  var esDocumento = e.request.mode === 'navigate' || e.request.destination === 'document' || e.request.url.endsWith('/index.html') || e.request.url.endsWith('/sw.js');
  var peticion = esDocumento ? new Request(e.request.url, { cache: 'no-store' }) : e.request;
  e.respondWith(
    fetch(peticion).catch(function() { return caches.match(e.request); })
  );
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
