const CACHE_NAME = 'movement-cache-v2.5.3';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API requests, POSTs, or external origins
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  if(url.pathname.endsWith('.apk')||url.pathname.startsWith('/app-debug.apk'))return;
  // Fetch current HTML and assets together; cached data is an offline fallback.
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok&&response.type==='basic')event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(event.request,response.clone())).catch(()=>{}));
    return response;
  }).catch(async()=>await caches.match(event.request)||Response.error()));
});
