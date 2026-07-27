// functions/api/bezorger-sumup-config.js
// Cloudflare Pages Function — GET /api/bezorger-sumup-config?sessie=...
//
// Levert de twee waarden die kassa-bezorger.html client-side nodig heeft om
// een SumUp App-Switch deep link (sumupmerchant://pay/1.0?...) te bouwen
// voor de "💳 PIN betaling starten"-knop bij 'aan de deur'-orders. Dit zijn
// geen geheimen zoals MOLLIE_API_KEY (die nooit de browser bereikt, zie
// order.js) — de affiliate-key en app-id moeten juist letterlijk in de
// deep link staan om te werken. Toch geven we ze niet zomaar prijs: dit
// endpoint zit achter dezelfde sessie-token als de rest van de bezorger-app
// (zie controleerBezorgerSessie in auth/_lib.js, zelfde patroon als
// bezorger-ritten.js) - de chauffeur moet dus ingelogd zijn via NFC of
// werknemernummer+pincode.
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
//   SUMUP_AFFILIATE_KEY — te genereren op me.sumup.com/developers
//   SUMUP_APP_ID        — de app-id die bij die affiliate-key hoort
//   DB — D1-database binding

import { zorgVoorBezorgerSessieTabel, controleerBezorgerSessie, json } from "./auth/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    await zorgVoorBezorgerSessieTabel(env.DB);

    const url = new URL(request.url);
    const sessieToken = url.searchParams.get("sessie") || "";
    const sessie = await controleerBezorgerSessie(env.DB, sessieToken);
    if (!sessie.geldig) {
      return json({ error: "Sessie verlopen of ongeldig. Log opnieuw in." }, 401);
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
