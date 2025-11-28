const CACHE_NAME = 'nexttrain-v5';
const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
  // service-worker.js - AJOUTER CECI À LA FIN DU FICHIER
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    // Forcer l'activation du Service Worker
    self.skipWaiting(); 
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    // 1. Nettoyer les anciens caches
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => {
          // Supprime tous les caches sauf le CACHE_NAME actuel (ex: v4)
          return cacheName !== CACHE_NAME;
        }).map(cacheName => {
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      // 2. Informer les clients (la page app.js) que le SW est maintenant actif.
      return self.clients.matchAll({
        includeUncontrolled: true,
        type: 'all'
      }).then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'CONTROLLER_CHANGE' });
        });
      });
    })
  );
});
});