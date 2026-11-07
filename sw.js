/* Guarda la aplicación (no los datos) para que abra aunque falle el internet. */
const CACHE = 'pos-ahogaditas-v9';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'qrcode.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // la API nunca se guarda en caché
  e.respondWith(fetch(e.request, {cache: 'no-cache'}).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
