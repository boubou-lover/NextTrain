// === Service Worker – Hot Update Instantané ===
// Change juste ce numéro à chaque nouvelle version
const CACHE_NAME = 'nexttrain-v9.211';

const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icon-192.png',
  '/icon-512.png'
];

// INSTALL — met le nouveau cache et active immédiatement
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );

  self.skipWaiting(); // 🔥 active le SW immédiatement — hot update
});

// ACTIVATE — supprime les vieux caches + prend le contrôle
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // 🔥 pas besoin de fermer l’onglet
  );

  // 🔥 avertit tous les clients que la nouvelle version est active
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ type: 'UPDATE_READY' });
    });
  });
});

// FETCH — stratégie network-first (update JS instantané)
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Met à jour le cache avec la dernière version
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)) // hors-ligne → cache
  );
});
