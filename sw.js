const CACHE = 'kyc-v5';
const PRECACHE = [
  '/',
  '/index.html',
  '/pipeline.html',
  '/liveness.html',
  '/handoff.html',
  '/styles/app.css',
  '/scripts/state.js',
  '/scripts/id.js',
  '/scripts/countries.js',
  '/scripts/pipeline.js',
  '/scripts/liveness.js',
  '/scripts/handoff.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network first, cache fallback — keeps models and CDN assets fresh
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // The admin backoffice is actively edited and must never be served from
  // the PWA cache — registering this worker at scope '/' means it would
  // otherwise silently intercept and cache /admin/* too, hiding every
  // change behind stale JS/CSS even after a hard refresh.
  if (new URL(e.request.url).pathname.startsWith('/admin')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
