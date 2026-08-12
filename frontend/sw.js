// ── Werkplaats Service Worker ──────────────────────────────────
const CACHE_NAAM = 'werkplaats-v4';

// Bestanden die offline beschikbaar moeten zijn
const CACHE_ASSETS = [
  './werkplaats_app.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── Installatie: cache de app-shell ───────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAAM).then((cache) => cache.addAll(CACHE_ASSETS))
  );
  self.skipWaiting();
});

// ── Activatie: verwijder oude caches ──────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((sleutels) =>
      Promise.all(
        sleutels
          .filter((k) => k !== CACHE_NAAM)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: netwerk eerst, cache als fallback ───────────────────
self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Nooit intercepten: JS/CSS-bestanden (altijd vers van de server),
  // backend API-calls en externe diensten
  if (
    url.endsWith('.js') ||
    url.endsWith('.css') ||
    url.includes('.js?') ||
    url.includes('localhost:3000') ||
    url.includes('127.0.0.1:3000') ||
    url.includes('supabase.co') ||
    url.includes('googleapis.com') ||
    url.includes('generativelanguage') ||
    url.includes('cdn.jsdelivr.net')
  ) {
    return; // standaard browser-fetch, geen SW interventie
  }

  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        // Sla alleen statische assets op (HTML, afbeeldingen, manifest)
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const kopie = resp.clone();
          caches.open(CACHE_NAAM).then((cache) =>
            cache.put(e.request, kopie)
          );
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
