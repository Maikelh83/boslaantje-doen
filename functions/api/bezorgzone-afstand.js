// functions/api/bezorgzone-afstand.js
// Cloudflare Pages Function — POST /api/bezorgzone-afstand
//
// Live bezorgzone-check tijdens het invullen van het adres in bestellen.html
// (checkout-stap 'Bezorgen'): geocodeert het klantadres via Mapbox en
// berekent de werkelijke rijafstand vanaf het restaurant (Oleander 1a,
// Veenendaal). Retourneert of het adres binnen de ingestelde bezorgzone valt
// en, zo ja, de bijbehorende (gestaffelde) bezorgkosten.
//
// Dit endpoint is puur voor live UI-feedback aan de klant - order.js voert
// vóór het accepteren van de betaling exact dezelfde controle opnieuw uit
// (via dezelfde controleerBezorgzone-functie in auth/_lib.js). Nooit alleen
// op dit endpoint vertrouwen voor de daadwerkelijke validatie.
//
// Benodigde environment variable (Cloudflare Pages > Settings > Environment variables):
//   MAPBOX_ACCESS_TOKEN — access token uit het Mapbox-dashboard (Geocoding + Directions API)

import { controleerBezorgzone, zorgVoorAccountTabellen } from "./auth/_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Ongeldige of ontbrekende JSON-body." }, 400);
    }

    const adres = String(body.adres || "").trim();
    const postcode = String(body.postcode || "").trim();
    const plaats = String(body.plaats || "").trim();

    if (!adres || !postcode) {
      return json({ error: "Adres en postcode zijn verplicht." }, 400);
    }
    if (!env.DB) {
      return json({ error: "Bezorgzone-controle is niet beschikbaar (database niet gekoppeld)." }, 500);
    }

    await zorgVoorAccountTabellen(env.DB);

    const resultaat = await controleerBezorgzone(env, { adres, postcode, plaats });
    if (!resultaat.ok) {
      return json({ error: resultaat.error }, resultaat.status || 400);
    }

    return json({
      binnenBereik: resultaat.binnenBereik,
      afstandKm: resultaat.afstandKm,
      maxBezorgafstandKm: resultaat.maxBezorgafstandKm,
      bezorgkosten: resultaat.bezorgkosten || 0,
      foutmelding: resultaat.foutmelding || null,
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
