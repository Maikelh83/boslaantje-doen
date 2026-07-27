// functions/api/bezorger-kaart.js
// Cloudflare Pages Function — GET /api/bezorger-kaart?wachtwoord=...&adres=...&postcode=...&plaats=...
//
// Geeft een klein kaartplaatje (PNG) terug met een pin op het bezorgadres,
// voor gebruik in de PWA Bezorger-app (src/kassa-bezorger.html) boven de
// bestaande "Bel klant"/"Open in Google Maps"/"Afgeleverd"-knoppen per stop.
//
// Het adres wordt hier server-side gegeocodeerd met dezelfde Mapbox
// Geocoding API v6 als de bezorgzone-controle (zie geocodeAdres in
// auth/_lib.js, hier hergebruikt in plaats van gedupliceerd - in
// tegenstelling tot de meeste Cloudflare Functions in dit project, die
// bewust op zichzelf staan, is auth/_lib.js al een gedeelde module die door
// meerdere functions wordt geïmporteerd). Daarna wordt er bij de Mapbox
// Static Images API een kant-en-klare kaartafbeelding opgehaald - dit
// endpoint proxyt die afbeelding 1-op-1 door, zodat de MAPBOX_ACCESS_TOKEN
// nooit in de HTML/JS van de bezorger-app terechtkomt (zelfde reden waarom
// bezorger-sumup-config.js de SumUp-sleutel nooit teruggeeft aan de client,
// alleen gebruikt).
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// MAPBOX_ACCESS_TOKEN — zelfde Mapbox-token als de bezorgzone-controle

import { geocodeAdres, json } from "./auth/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const wachtwoord = url.searchParams.get("wachtwoord") || "";

    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "De bezorger-app is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!env.MAPBOX_ACCESS_TOKEN) {
      return json({ error: "Kaartje is nog niet ingesteld (MAPBOX_ACCESS_TOKEN ontbreekt)." }, 500);
    }

    const adres = (url.searchParams.get("adres") || "").trim();
    const postcode = (url.searchParams.get("postcode") || "").trim();
    const plaats = (url.searchParams.get("plaats") || "").trim();
    if (!adres) return json({ error: "adres is verplicht." }, 400);

    const geocodeResultaat = await geocodeAdres(env, adres, postcode, plaats);
    if (!geocodeResultaat.ok) {
      return json({ error: geocodeResultaat.error }, geocodeResultaat.status || 400);
    }

    const { lat, lng } = geocodeResultaat;
    // Klein kaartje, past ruim boven de knoppenstapel op een telefoonscherm.
    const breedte = 320;
    const hoogte = 180;
    const zoom = 15;
    // Terracotta pin (zelfde kleurfamilie als de rest van de huisstijl)
    // exact op de gegeocodeerde coördinaat.
    const staticUrl =
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/` +
      `pin-s+9C6355(${lng},${lat})/${lng},${lat},${zoom},0/${breedte}x${hoogte}@2x` +
      `?access_token=${env.MAPBOX_ACCESS_TOKEN}`;

    let afbeeldingResponse;
    try {
      afbeeldingResponse = await fetch(staticUrl);
    } catch (fetchErr) {
      return json({ error: "Kon geen verbinding maken met de kaartendienst." }, 502);
    }
    if (!afbeeldingResponse.ok) {
      return json({ error: "Kon geen kaartje ophalen bij Mapbox." }, 502);
    }

    return new Response(afbeeldingResponse.body, {
      status: 200,
      headers: {
        "Content-Type": afbeeldingResponse.headers.get("Content-Type") || "image/png",
        // Adressen veranderen niet, dus dit kaartje mag best even in de
        // (browser-)cache blijven - scheelt herhaalde Mapbox-aanroepen als
        // de bezorger een stopscherm meerdere keren opnieuw laadt.
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
