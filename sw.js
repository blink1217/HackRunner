const SW_CACHE = 'pacebeat-v3';
const PRECACHE = [
  'index.html',
  'PaceBeatDJEngine.js',
  'PaceBeatV3.js',
  'manifest.json',
  'media/tech-house-125.mp3',
  'media/tech-house-vocal-128.mp3',
  'media/afro-vocal-122.mp3'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SW_CACHE).then(cache =>
      Promise.allSettled(PRECACHE.map(u => cache.add(new Request(u, { cache: 'reload' }))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SW_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // pass-through: fonts, YouTube, Envato

  // Media + code: cache-first (immutable-ish; versioned by SW_CACHE key)
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(SW_CACHE).then(c => c.put(req, clone));
      }
      return resp;
    }).catch(() => caches.match('index.html')))
  );
});
