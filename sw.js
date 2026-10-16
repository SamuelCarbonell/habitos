// sw.js — Service Worker: hace que la app funcione sin conexión.
// Estrategia "stale-while-revalidate": responde al instante desde la caché
// y, en segundo plano, descarga la versión nueva para la próxima vez.

const CACHE = 'habitos-v1'; // cámbialo (v2, v3...) si quieres forzar a borrar la caché antigua

// Archivos imprescindibles para arrancar sin internet
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/logic.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// 1) install: se ejecuta una vez al instalar el SW -> precargamos los archivos
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting(); // activa el SW nuevo sin esperar a cerrar la app
});

// 2) activate: borramos cachés de versiones anteriores
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 3) fetch: intercepta cada petición de la app
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached); // sin conexión: usamos lo que haya en caché
      return cached || network;
    })
  );
});
