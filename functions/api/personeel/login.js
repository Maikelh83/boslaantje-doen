// functions/api/personeel/login.js
// Cloudflare Pages Function — POST /api/personeel/login?wachtwoord=...
//
// Personeelsnummer-fundament: identificeert WIE er precies achter een
// personeelsapparaat zit (te beginnen bij de PWA Bezorger-app, waar dat
// nodig is voor de chauffeur-koppeling), los van het bestaande gedeelde
// STAFF_LOYALTY_PASSWORD (dat blijft de "is dit een personeelsapparaat"-
// poort, zelfde als op alle andere /kassa-*-schermen).
//
// Body (JSON): { personeelsnummer, pincode }
// Bij succes: { ok: true, personeelsnummer, naam }
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// DB — D1-database binding

import { zorgVoorPersoneelTabel, wachtwoordKlopt, json } from "../auth/_lib.js";

function controleerToegang(request, env) {
  const url = new URL(request.url);
  const wachtwoord = url.searchParams.get("wachtwoord") || "";
  if (!env.STAFF_LOYALTY_PASSWORD) {
    return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
  }
  if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
    return json({ error: "Onjuist wachtwoord." }, 401);
  }
  if (!env.DB) {
    return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorPersoneelTabel(env.DB);

    const body = await request.json();
    const personeelsnummer = String((body && body.personeelsnummer) || "").trim();
    const pincode = String((body && body.pincode) || "").trim();

    if (!personeelsnummer || !pincode) {
      return json({ error: "Personeelsnummer en pincode zijn verplicht." }, 400);
    }

    const medewerker = await env.DB.prepare(
      `SELECT * FROM medewerkers WHERE personeelsnummer = ?`
    ).bind(personeelsnummer).first();

    if (!medewerker || !medewerker.actief) {
      return json({ error: "Onbekend of niet-actief personeelsnummer." }, 401);
    }

    const klopt = await wachtwoordKlopt(pincode, medewerker.pincode_hash, medewerker.pincode_salt);
    if (!klopt) {
      return json({ error: "Onjuiste pincode." }, 401);
    }

    return json({ ok: true, personeelsnummer: medewerker.personeelsnummer, naam: medewerker.naam });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
