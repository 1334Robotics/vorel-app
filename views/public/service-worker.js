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

// Clean up any old caches and update app shell cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Clean up old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      }),
      
      // Update the app shell cache with fresh versions
      caches.open(CACHE_NAME).then((cache) => {
        console.log('Checking for app shell updates on boot');
        
        // Only try to update if online
        if (self.navigator.onLine) {
          return Promise.all(
            APP_SHELL.map(url => {
              // Fetch fresh version of resource
              return fetch(url, { cache: 'no-store' })
                .then(response => {
                  if (response.ok) {
                    // Update the cache with fresh version
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
  
  // Claim clients so the service worker takes control immediately
  self.clients.claim();
});