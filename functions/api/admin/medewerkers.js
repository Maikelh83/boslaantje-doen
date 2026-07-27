// functions/api/admin/medewerkers.js
// Cloudflare Pages Function — GET/POST /api/admin/medewerkers?wachtwoord=...
//
// Beheerscherm (src/kassa-personeel.html) voor het personeelsnummer-
// fundament: medewerkers toevoegen, pincode resetten, (de)activeren.
// Zelfde personeelswachtwoord-gate als de andere admin-endpoints
// (zakelijke-klanten, bezorgzone-instellingen, ritten).
//
// GET  : lijst medewerkers (personeelsnummer, naam, actief, aangemaakt_op) —
//        pincode-hash/-salt worden nooit teruggegeven.
// POST : { actie: 'toevoegen', personeelsnummer, naam, pincode }
//        { actie: 'reset_pincode', personeelsnummer, nieuwePincode }
//        { actie: 'activeren' | 'deactiveren', personeelsnummer }
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// DB — D1-database binding

import { zorgVoorPersoneelTabel, hashWachtwoord, json } from "../auth/_lib.js";

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

function pincodeGeldig(pincode) {
  return typeof pincode === "string" && /^[0-9]{4,6}$/.test(pincode);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorPersoneelTabel(env.DB);

    const { results } = await env.DB.prepare(
      `SELECT personeelsnummer, naam, actief, aangemaakt_op FROM medewerkers ORDER BY naam ASC`
    ).all();

    return json({
      medewerkers: (results || []).map((m) => ({
        personeelsnummer: m.personeelsnummer,
        naam: m.naam,
        actief: !!m.actief,
        aangemaaktOp: m.aangemaakt_op,
      })),
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorPersoneelTabel(env.DB);

    const body = await request.json();
    const actie = body && body.actie;
    const personeelsnummer = String((body && body.personeelsnummer) || "").trim();

    if (!personeelsnummer) {
      return json({ error: "Personeelsnummer is verplicht." }, 400);
    }

    if (actie === "toevoegen") {
      const naam = String((body && body.naam) || "").trim();
      const pincode = String((body && body.pincode) || "").trim();
      if (!naam) return json({ error: "Naam is verplicht." }, 400);
      if (!pincodeGeldig(pincode)) return json({ error: "Pincode moet 4 tot 6 cijfers zijn." }, 400);

      const bestaat = await env.DB.prepare(
        `SELECT personeelsnummer FROM medewerkers WHERE personeelsnummer = ?`
      ).bind(personeelsnummer).first();
      if (bestaat) return json({ error: "Dit personeelsnummer bestaat al." }, 400);

      const { hash, salt } = await hashWachtwoord(pincode);
      await env.DB.prepare(
        `INSERT INTO medewerkers (personeelsnummer, naam, pincode_hash, pincode_salt, actief, aangemaakt_op)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).bind(personeelsnummer, naam, hash, salt, new Date().toISOString()).run();

      return json({ ok: true });
    }

    if (actie === "reset_pincode") {
      const nieuwePincode = String((body && body.nieuwePincode) || "").trim();
      if (!pincodeGeldig(nieuwePincode)) return json({ error: "Pincode moet 4 tot 6 cijfers zijn." }, 400);

      const medewerker = await env.DB.prepare(
        `SELECT personeelsnummer FROM medewerkers WHERE personeelsnummer = ?`
      ).bind(personeelsnummer).first();
      if (!medewerker) return json({ error: "Medewerker niet gevonden." }, 404);

      const { hash, salt } = await hashWachtwoord(nieuwePincode);
      await env.DB.prepare(
        `UPDATE medewerkers SET pincode_hash = ?, pincode_salt = ? WHERE personeelsnummer = ?`
      ).bind(hash, salt, personeelsnummer).run();

      return json({ ok: true });
    }

    if (actie === "activeren" || actie === "deactiveren") {
      const medewerker = await env.DB.prepare(
        `SELECT personeelsnummer FROM medewerkers WHERE personeelsnummer = ?`
      ).bind(personeelsnummer).first();
      if (!medewerker) return json({ error: "Medewerker niet gevonden." }, 404);

      await env.DB.prepare(
        `UPDATE medewerkers SET actief = ? WHERE personeelsnummer = ?`
      ).bind(actie === "activeren" ? 1 : 0, personeelsnummer).run();

      return json({ ok: true });
    }

    return json({ error: "Onbekende actie." }, 400);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
