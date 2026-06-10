// ── Werkplaats Service Worker ──────────────────────────────────
const CACHE_NAAM = 'werkplaats-v3';

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
  // Supabase en Gemini API-calls nooit cachen
  const url = e.request.url;
  if (
    url.includes('supabase.co') ||
    url.includes('googleapis.com') ||
    url.includes('generativelanguage')
  ) {
    return; // standaard netwerk-fetch
  }

  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        // Sla succesvolle responses op in cache
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
