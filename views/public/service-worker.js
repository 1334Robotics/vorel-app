// Minimal service worker - no caching, network only
const CACHE_NAME = 'vorel-app-v1-shell';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Only cache the minimal app shell during installation
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
  // Activate immediately
  self.skipWaiting();
});

// Always use network for all requests
self.addEventListener('fetch', (event) => {
  // Let the browser handle all requests normally
  // This ensures all data is always fresh from the network
  return;
});

// Clean up any old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
});