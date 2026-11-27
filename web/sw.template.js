// Service worker: keeps the app's own files in the browser so it opens
// without a connection. vite.config.ts fills in the two placeholders at build
// time. Your data is not here — that lives in IndexedDB.

const CACHE = 'gym-tracker-__VERSION__';
const FILES = __FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Past the browser's own HTTP cache: an old "./" from there, stored next to
      // the new hashed files, would be a page asking for scripts that no longer exist.
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith('gym-tracker-') && name !== CACHE).map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The analyzer's own addresses are never answered from the cache. Only the
  // ones asked with GET are listed; nothing ties them to the start of the path,
  // because the app may live in a sub-folder and calls the analyzer relative to its page.
  if (/\/(health|models|connections|strava\/(connect|callback)|inbox\/[\w-]+)$/.test(url.pathname)) return;
  // Matched by address alone: many servers send "Vary" headers that would
  // otherwise make the copy stored at install time miss for the page's own requests.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true, ignoreVary: true })
      .then((cached) => cached ?? fetch(event.request)),
  );
});
