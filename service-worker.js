var CACHE_NAME = 'reseats-shell-v1';
var APP_SHELL = [
  '/',
  '/index.html',
  '/vault.html',
  '/manifest.webmanifest',
  '/pwa.js',
  '/icons/reseats-192.png',
  '/icons/reseats-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(APP_SHELL);
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) {
      return name.indexOf('reseats-shell-') === 0 && name !== CACHE_NAME;
    }).map(function (name) { return caches.delete(name); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        return cached || caches.match('/vault.html');
      });
    }));
    return;
  }

  event.respondWith(caches.match(request).then(function (cached) {
    var network = fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
    });
    return cached || network;
  }));
});
