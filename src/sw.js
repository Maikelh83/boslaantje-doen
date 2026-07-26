// Boslaantje Doen — service worker
//
// Doel: alleen installeerbaarheid van de PWA mogelijk maken (Chrome/Android
// vereist een geregistreerde service worker met fetch-handler voordat het
// 'beforeinstallprompt'-event wordt aangeboden).
//
// BEWUST GEEN caching van dynamische content: menu, prijzen, voorraad,
// accountgegevens en bestelstatus moeten altijd live/vers zijn. Een
// cache-first strategie zou verouderde prijzen of afhaaltijden kunnen tonen
// — dat risico nemen we hier niet. Simpele network-passthrough dus.

self.addEventListener('install', (event) => {
  // Meteen actief worden, niet wachten tot alle tabbladen gesloten zijn.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Altijd gewoon naar het netwerk — geen cache-laag.
  event.respondWith(fetch(event.request));
});
