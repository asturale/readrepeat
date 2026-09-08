// A registered fetch handler is required by some browsers' PWA
// installability check, even a plain passthrough -- always hits the
// network, no offline caching (avoids serving stale content for an app
// that's under active development).
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload -- fall back to defaults below.
  }
  const title = data.title || 'ReadRepeat';
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(self.clients.openWindow(url));
});
