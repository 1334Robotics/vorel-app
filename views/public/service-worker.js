// Minimal service worker - no caching, network only
const CACHE_NAME = 'vorel-app-v1-shell';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching minimal app shell');
        return Promise.all(
          APP_SHELL.map(url => {
            return cache.add(url).catch(error => {
              console.error(`Failed to cache: ${url}`, error);
              return Promise.resolve();
            });
          })
        );
      })
  );
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  return;
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      }),
      
      caches.open(CACHE_NAME).then((cache) => {
        console.log('Checking for app shell updates on boot');
        if (self.navigator.onLine) {
          return Promise.all(
            APP_SHELL.map(url => {
              return fetch(url, { cache: 'no-store' })
                .then(response => {
                  if (response.ok) {
                    return cache.put(url, response);
                  }
                  return Promise.resolve();
                })
                .catch(error => {
                  console.error(`Failed to update cache for: ${url}`, error);
                  return Promise.resolve();
                });
            })
          );
        } else {
          console.log('Device offline, skipping app shell update');
          return Promise.resolve();
        }
      })
    ])
  );
  self.clients.claim();
});