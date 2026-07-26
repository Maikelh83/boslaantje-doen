// functions/api/admin/bezorgzone-instellingen.js
// Cloudflare Pages Function — beheer van de bezorgzone-instellingen
// (maximale bezorgafstand + gestaffelde bezorgkosten). Gebruikt hetzelfde
// personeelswachtwoord (STAFF_LOYALTY_PASSWORD) als de andere admin-pagina's
// (kassa, keuken, loyaliteit, zakelijke klanten) — geen apart wachtwoord nodig.
//
// GET  /api/admin/bezorgzone-instellingen?wachtwoord=...
//   Geeft de huidige instellingen terug: { maxBezorgafstandKm, staffels }
//
// POST /api/admin/bezorgzone-instellingen?wachtwoord=...
//   Body (JSON): { maxBezorgafstandKm: number, staffels: [{ totKm, bedrag }] }
//   Slaat beide instellingen in één keer op (overschrijft de vorige staffels).

import { zorgVoorAccountTabellen, haalBezorgzoneInstellingen, json } from "../auth/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);
    const instellingen = await haalBezorgzoneInstellingen(env.DB);
    return json(instellingen);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Ongeldige of ontbrekende JSON-body." }, 400);
    }

    const maxBezorgafstandKm = Number(body.maxBezorgafstandKm);
    if (!Number.isFinite(maxBezorgafstandKm) || maxBezorgafstandKm <= 0) {
      return json({ error: "Maximale bezorgafstand moet een getal groter dan 0 zijn." }, 400);
    }

    if (!Array.isArray(body.staffels) || body.staffels.length === 0) {
      return json({ error: "Er moet minimaal één staffel zijn." }, 400);
    }
    const staffels = [];
    for (const rij of body.staffels) {
      const totKm = Number(rij.totKm);
      const bedrag = Number(rij.bedrag);
      if (!Number.isFinite(totKm) || totKm <= 0 || !Number.isFinite(bedrag) || bedrag < 0) {
        return json({ error: "Elke staffel moet een geldige 'tot (km)' en 'bedrag' hebben." }, 400);
      }
      staffels.push({ totKm, bedrag });
    }
    staffels.sort((a, b) => a.totKm - b.totKm);

    await env.DB.prepare(
      `INSERT INTO instellingen (sleutel, waarde) VALUES ('max_bezorgafstand_km', ?)
       ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde`
    )
      .bind(String(maxBezorgafstandKm))
      .run();

    await env.DB.prepare(
      `INSERT INTO instellingen (sleutel, waarde) VALUES ('bezorgkosten_staffels', ?)
       ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde`
    )
      .bind(JSON.stringify(staffels))
      .run();

    return json({ ok: true, maxBezorgafstandKm, staffels });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

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
