// === Service Worker – Hot Update Instantané ===
// Change juste ce numéro à chaque nouvelle version
const CACHE_NAME = 'nexttrain-v9.237';

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

// FETCH — stratégie network-first, uniquement pour l'app shell (même origine).
// Les appels vers l'API iRail (api.irail.be) ne passent PAS par le cache du SW :
// l'app gère déjà son propre fallback hors-ligne pour ces données (voir Offline.* dans app.js).
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') {
    return; // laisse passer tel quel (réseau normal)
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)) // hors-ligne → cache
  );
});
