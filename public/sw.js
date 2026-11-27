const CACHE_NAME = 'stage21-v4';
const INBOX_CACHE = 'stage21-inbox';
const BASE = new URL('./', self.location.href);
const ENTRY = new URL('index.html', BASE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll([
          ENTRY,
          new URL('manifest.webmanifest', BASE),
          new URL('icon.svg', BASE),
          new URL('ecg-worker.js', BASE),
        ])
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== INBOX_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== BASE.origin) return;

  // Handle PWA Web Share Target POST ./receive
  if (
    event.request.method === 'POST' &&
    url.pathname === new URL('receive', BASE).pathname
  ) {
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const file = form.get('photo');
        if (
          !(file instanceof Blob) ||
          !file.type.startsWith('image/') ||
          file.size > 40 * 1024 * 1024
        ) {
          return new Response('Expected one image under 40 MiB.', { status: 400 });
        }
        const cache = await caches.open(INBOX_CACHE);
        const keys = await cache.keys();
        for (const key of keys) {
          const old = await cache.match(key);
          if (Date.now() - Number(old?.headers.get('x-time') || 0) > 300_000) {
            await cache.delete(key);
          }
        }
        const token = crypto.randomUUID();
        await cache.put(
          new URL('share-item/' + token, BASE),
          new Response(file, {
            headers: {
              'Content-Type': file.type,
              'x-time': String(Date.now()),
            },
          })
        );
        return Response.redirect(new URL('./?shared=' + token, BASE).href, 303);
      })()
    );
    return;
  }

  // Network-first fallback for navigation requests
  if (event.request.mode === 'navigate' && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(ENTRY)) || new Response('Offline', { status: 503 });
      })
    );
  }
});
