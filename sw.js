// Minimal offline cache for the PWA shell. No dependencies, no build step —
// bump CACHE_NAME whenever a precached shell file changes so clients pick up the update.
const CACHE_NAME = 'music-studio-v3';
const SHELL_URLS = [
  './index.html',
  './manifest.webmanifest',
  './js/song-data.js',
  './js/downsample-processor.js',
  './songs/index.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Example songs are listed in songs/index.json (see CLAUDE.md: "Adding an
// example song means dropping a .json file here and adding an entry to
// index.json") — read that list at install time instead of hardcoding song
// filenames here, so a new example song gets precached without also having
// to remember to edit this file.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(SHELL_URLS);
  try {
    const res = await fetch('./songs/index.json');
    const list = await res.json();
    await cache.addAll(list.map((s) => './songs/' + s.file));
  } catch { /* songs/index.json missing or malformed — shell still works offline */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Navigations and song data need to reflect a redeploy immediately, so they
  // go network-first (falling back to cache only when actually offline) —
  // cache-first here would keep serving a stale songs/index.json forever.
  const isNavigation = req.mode === 'navigate';
  const isSongData = req.url.includes('/songs/');
  if (isNavigation || isSongData) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then((cached) => {
        if (cached) return cached;
        // Only navigations fall back to the app shell; any other offline
        // miss (e.g. a song file that isn't precached) should fail cleanly
        // instead of silently resolving with the wrong content.
        return isNavigation ? caches.match('./index.html') : Response.error();
      }))
    );
    return;
  }

  // Everything else (the static app shell: JS/manifest/icons) is cache-first
  // for speed — bump CACHE_NAME above to invalidate it on a redeploy.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
      return res;
    }))
  );
});
