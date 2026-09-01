// === Service Worker – Hot Update Instantané ===
// Le nom du cache est dérivé de version.json (source unique de vérité,
// partagée avec l'affichage "Version X" dans index.html/app.js).
// Il suffit de changer version.json pour que TOUT se resynchronise.
let CACHE_NAME = 'nexttrain-v0'; // valeur de repli si version.json est inaccessible

const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/version.json',
  '/icon-192.png',
  '/icon-512.png'
];

async function resolveCacheName() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    const info = await res.json();
    return `nexttrain-v${info.version}`;
  } catch {
    return CACHE_NAME; // hors-ligne à l'install initiale : repli
  }
}

// INSTALL — met le nouveau cache et active immédiatement
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      CACHE_NAME = await resolveCacheName();
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(urlsToCache);
    })()
  );

  self.skipWaiting(); // 🔥 active le SW immédiatement — hot update
});

// ACTIVATE — supprime les vieux caches + prend le contrôle
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      CACHE_NAME = await resolveCacheName();
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
      await self.clients.claim(); // 🔥 pas besoin de fermer l'onglet
    })()
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
