const CACHE_NAME = 'todoapp-shell-v14';
const SHELL_FILES = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/db.js',
  'js/sync-config.js',
  'js/sync.js',
  'js/push-config.js',
  'js/push.js',
  'js/util.js',
  'js/nlp.js',
  'js/store.js',
  'js/geofence.js',
  'js/map.js',
  'js/ui-shell.js',
  'js/ui-tasks.js',
  'js/ui-settings.js',
  'js/ui-record.js',
  'js/app.js',
  'icons/icon.svg',
];

const CDN_LIB_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache =>
        Promise.all([...SHELL_FILES, ...CDN_LIB_FILES].map(url => cache.add(url).catch(() => {})))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCachedLib = CDN_LIB_FILES.includes(event.request.url);

  if (!isSameOrigin && !isCachedLib) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});

// A reminder pushed by the send-reminders Edge Function. The payload is JSON
// built by that function; anything unparseable still shows a generic
// notification rather than nothing, because Chrome requires every push to
// produce one.
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: 'Task due', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Task due';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      tag: payload.taskId || undefined,
      data: { url: payload.url || '.' },
      badge: 'icons/icon.svg',
      icon: 'icons/icon.svg',
      renotify: !!payload.taskId,
    })
  );
});

// Push services rotate endpoints. Without this the device silently stops
// receiving reminders and nothing indicates why.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true })
      .then(subscription =>
        self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
          // Hand it to any open page, which can store it via the authenticated
          // Supabase client. If none is open, the app re-registers on next launch.
          clients.forEach(c => c.postMessage({ type: 'push-subscription-changed', subscription: subscription.toJSON() }));
        })
      )
      .catch(() => {})
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '.';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
