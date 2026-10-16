// sw.js — Service worker: guarda los archivos para jugar sin conexión.
// Al cambiar cualquier archivo, sube el número de versión para que el iPhone lo actualice.
const CACHE = 'blockblast-v1';
const FILES = [
  './',
  'index.html',
  'style.css',
  'game.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Borrar solo cachés viejas de este juego (no las de otras apps del mismo dominio)
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('blockblast-') && k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Responde con la copia guardada al instante y la actualiza en segundo plano
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        const network = fetch(event.request)
          .then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
