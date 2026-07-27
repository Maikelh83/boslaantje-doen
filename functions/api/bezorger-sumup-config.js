// functions/api/bezorger-sumup-config.js
// Cloudflare Pages Function — GET /api/bezorger-sumup-config?wachtwoord=...
//
// Levert de twee waarden die kassa-bezorger.html client-side nodig heeft om
// een SumUp App-Switch deep link (sumupmerchant://pay/1.0?...) te bouwen
// voor de "💳 PIN betaling starten"-knop bij 'aan de deur'-orders. Dit zijn
// geen geheimen zoals MOLLIE_API_KEY (die nooit de browser bereikt, zie
// order.js) — de affiliate-key en app-id moeten juist letterlijk in de
// deep link staan om te werken. Toch geven we ze niet zomaar prijs: dit
// endpoint zit achter dezelfde ?wachtwoord=-poort als de rest van de
// bezorger-app (zelfde patroon als bezorger-ritten.js), zodat alleen
// personeelsapparaten met het gedeelde personeelswachtwoord ze kunnen
// opvragen.
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
//   SUMUP_AFFILIATE_KEY — te genereren op me.sumup.com/developers
//   SUMUP_APP_ID        — de app-id die bij die affiliate-key hoort
//   STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*

import { json } from "./auth/_lib.js";

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

    if (!env.SUMUP_AFFILIATE_KEY || !env.SUMUP_APP_ID) {
      return json({
        ingesteld: false,
        error: "PIN-betalen via SumUp is nog niet ingesteld (SUMUP_AFFILIATE_KEY/SUMUP_APP_ID ontbreken in Cloudflare Pages).",
      }, 200);
    }

    return json({
      ingesteld: true,
      affiliateKey: env.SUMUP_AFFILIATE_KEY,
      appId: env.SUMUP_APP_ID,
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
