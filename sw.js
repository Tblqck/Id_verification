const CACHE = 'kyc-v6';
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

// The liveness face-landmarker model + WASM runtime — several MB, fetched
// by liveness.html on demand today. Warming these into the cache here means
// the download starts the moment the verification link opens (index.html
// registers this worker) and runs in the background through ID capture,
// instead of only starting once the user reaches the liveness step. Only
// the SIMD wasm build is listed: every browser this flow targets supports
// it, and the non-SIMD duplicate sitting next to it in liveness/ would
// silently double this to ~19MB for no benefit.
const MODEL_ASSETS = [
  '/liveness/vision_bundle.mjs',
  '/liveness/vision_wasm_internal_js.simd.js',
  '/liveness/vision_wasm_internal.simd.wasm',
  '/liveness/face_landmarker.task',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Keep the app-shell precache atomic (addAll all-or-nothing) but fetch
    // the heavy model assets independently — a slow/failed model download
    // must never take the app shell down with it.
    await cache.addAll(PRECACHE).catch(() => {});
    await Promise.all(MODEL_ASSETS.map(url =>
      fetch(url).then(res => res.ok && cache.put(url, res)).catch(() => {})
    ));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const path = new URL(e.request.url).pathname;
  // The admin backoffice is actively edited and must never be served from
  // the PWA cache — registering this worker at scope '/' means it would
  // otherwise silently intercept and cache /admin/* too, hiding every
  // change behind stale JS/CSS even after a hard refresh.
  if (path.startsWith('/admin')) return;

  // Model/WASM assets are large, filename-versioned, and effectively
  // immutable — serve straight from cache when we have it instead of
  // waiting on the network, so the background preload from install()
  // actually pays off instead of being re-fetched every time anyway.
  if (path.startsWith('/liveness/')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // Everything else: network first, cache fallback — keeps app code fresh.
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
