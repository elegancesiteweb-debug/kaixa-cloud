// Service Worker — Kaixa Pro PWA
const CACHE = 'kaixa-v2';
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
  e.respondWith(
    fetch(e.request).catch(function() { return caches.match(e.request); })
  );
});
