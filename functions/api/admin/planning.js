// functions/api/admin/planning.js
// Cloudflare Pages Function — GET/POST /api/admin/planning?wachtwoord=...
//
// Beheerscherm (src/kassa-planning.html) voor de personeelsplanning van
// Snackbar De Boslaan: weekrooster samenstellen, beschikbaarheid van
// medewerkers inzien als hulpmiddel daarbij, verlof-/ziekmeldingen
// goedkeuren of afwijzen, en ingediende werkuren goedkeuren. Zelfde
// personeelswachtwoord-gate als de andere admin-endpoints (medewerkers,
// zakelijke-klanten, bezorgzone-instellingen, ritten).
//
// GET  ?wachtwoord=...&week=YYYY-MM-DD (maandag van de gewenste week)
//      -> { medewerkers, shifts (die week), beschikbaarheid (die week),
//           verlofAanvragen (open + laatste 30 dagen), werkuren (open) }
// POST : { actie: 'shift_toevoegen', personeelsnummer, datum, startTijd, eindTijd, functie, notitie }
//        { actie: 'shift_bewerken', shiftId, startTijd, eindTijd, functie, notitie }
//        { actie: 'shift_verwijderen', shiftId }
//        { actie: 'verlof_beoordelen', verlofId, beslissing: 'goedkeuren' | 'afwijzen' }
//        { actie: 'uren_beoordelen', urenId, beslissing: 'goedkeuren' | 'afwijzen' }
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// DB — D1-database binding

import { zorgVoorPersoneelTabel, zorgVoorPlanningTabellen, json } from "../auth/_lib.js";

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

// Geeft de maandag terug van de week waarin de meegegeven datum valt
// (YYYY-MM-DD in, YYYY-MM-DD uit). Als er geen/een ongeldige datum
// meekomt, wordt de huidige week gebruikt.
function maandagVanWeek(datumStr) {
  const basis = datumStr && !isNaN(Date.parse(datumStr)) ? new Date(datumStr + "T00:00:00") : new Date();
  const dag = basis.getDay(); // 0 = zondag
  const offsetNaarMaandag = dag === 0 ? -6 : 1 - dag;
  const maandag = new Date(basis);
  maandag.setDate(basis.getDate() + offsetNaarMaandag);
  return maandag.toISOString().slice(0, 10);
}

function plusDagen(datumStr, aantalDagen) {
  const d = new Date(datumStr + "T00:00:00");
  d.setDate(d.getDate() + aantalDagen);
  return d.toISOString().slice(0, 10);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorPersoneelTabel(env.DB);
    await zorgVoorPlanningTabellen(env.DB);

    const url = new URL(request.url);
    const weekMaandag = maandagVanWeek(url.searchParams.get("week"));
    const weekZondag = plusDagen(weekMaandag, 6);

    const { results: medewerkers } = await env.DB.prepare(
      `SELECT personeelsnummer, naam FROM medewerkers WHERE actief = 1 ORDER BY naam ASC`
    ).all();

    const { results: shifts } = await env.DB.prepare(
      `SELECT s.id, s.personeelsnummer, m.naam, s.datum, s.start_tijd, s.eind_tijd, s.functie, s.notitie
       FROM shifts s
       LEFT JOIN medewerkers m ON m.personeelsnummer = s.personeelsnummer
       WHERE s.datum BETWEEN ? AND ?
       ORDER BY s.datum ASC, s.start_tijd ASC`
    ).bind(weekMaandag, weekZondag).all();

    const { results: beschikbaarheid } = await env.DB.prepare(
      `SELECT b.personeelsnummer, m.naam, b.datum, b.dagdeel, b.status, b.opmerking
       FROM beschikbaarheid b
       LEFT JOIN medewerkers m ON m.personeelsnummer = b.personeelsnummer
       WHERE b.datum BETWEEN ? AND ?
       ORDER BY b.datum ASC`
    ).bind(weekMaandag, weekZondag).all();

    const dertigDagenGeleden = plusDagen(new Date().toISOString().slice(0, 10), -30);
    // Naast openstaande en recent ingediende aanvragen ook álle aanvragen die
    // over de getoonde week heen vallen: het weekrooster kleurt cellen op basis
    // van goedgekeurd verlof/ziek, en vakantie die maanden vooruit is
    // aangevraagd viel anders buiten deze lijst — dan bleef die week in het
    // rooster gewoon leeg ogen terwijl de medewerker vrij was.
    const { results: verlofAanvragen } = await env.DB.prepare(
      `SELECT v.id, v.personeelsnummer, m.naam, v.van_datum, v.tot_datum, v.type, v.reden, v.status, v.aangemaakt_op
       FROM verlof_aanvragen v
       LEFT JOIN medewerkers m ON m.personeelsnummer = v.personeelsnummer
       WHERE v.status = 'aangevraagd'
          OR v.aangemaakt_op >= ?
          OR (v.van_datum <= ? AND v.tot_datum >= ?)
       ORDER BY v.aangemaakt_op DESC`
    ).bind(dertigDagenGeleden, weekZondag, weekMaandag).all();

    const { results: werkuren } = await env.DB.prepare(
      `SELECT w.id, w.personeelsnummer, m.naam, w.datum, w.start_tijd, w.eind_tijd, w.pauze_minuten, w.status
       FROM werkuren w
       LEFT JOIN medewerkers m ON m.personeelsnummer = w.personeelsnummer
       WHERE w.status = 'ingediend' OR w.datum >= ?
       ORDER BY w.datum DESC`
    ).bind(dertigDagenGeleden).all();

    return json({
      week: weekMaandag,
      medewerkers: medewerkers || [],
      shifts: shifts || [],
      beschikbaarheid: beschikbaarheid || [],
      verlofAanvragen: verlofAanvragen || [],
      werkuren: werkuren || [],
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
    await zorgVoorPlanningTabellen(env.DB);

    const body = await request.json();
    const actie = body && body.actie;

    if (actie === "shift_toevoegen") {
      const personeelsnummer = String((body && body.personeelsnummer) || "").trim();
      const datum = String((body && body.datum) || "").trim();
      const startTijd = String((body && body.startTijd) || "").trim();
      const eindTijd = String((body && body.eindTijd) || "").trim();
      const functie = String((body && body.functie) || "").trim() || null;
      const notitie = String((body && body.notitie) || "").trim() || null;

      if (!personeelsnummer || !datum || !startTijd || !eindTijd) {
        return json({ error: "Medewerker, datum, starttijd en eindtijd zijn verplicht." }, 400);
      }

      const medewerker = await env.DB.prepare(
        `SELECT personeelsnummer FROM medewerkers WHERE personeelsnummer = ? AND actief = 1`
      ).bind(personeelsnummer).first();
      if (!medewerker) return json({ error: "Medewerker niet gevonden of niet actief." }, 404);

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO shifts (id, personeelsnummer, datum, start_tijd, eind_tijd, functie, notitie, aangemaakt_op, aangemaakt_door)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, personeelsnummer, datum, startTijd, eindTijd, functie, notitie, new Date().toISOString(), "beheer").run();

      return json({ ok: true, shiftId: id });
    }

    if (actie === "shift_bewerken") {
      const shiftId = String((body && body.shiftId) || "").trim();
      const startTijd = String((body && body.startTijd) || "").trim();
      const eindTijd = String((body && body.eindTijd) || "").trim();
      const functie = String((body && body.functie) || "").trim() || null;
      const notitie = String((body && body.notitie) || "").trim() || null;

      if (!shiftId || !startTijd || !eindTijd) {
        return json({ error: "shiftId, starttijd en eindtijd zijn verplicht." }, 400);
      }

      const bestaandeShift = await env.DB.prepare(`SELECT id FROM shifts WHERE id = ?`).bind(shiftId).first();
      if (!bestaandeShift) return json({ error: "Dienst niet gevonden." }, 404);

      await env.DB.prepare(
        `UPDATE shifts SET start_tijd = ?, eind_tijd = ?, functie = ?, notitie = ? WHERE id = ?`
      ).bind(startTijd, eindTijd, functie, notitie, shiftId).run();

      return json({ ok: true });
    }

    if (actie === "shift_verwijderen") {
      const shiftId = String((body && body.shiftId) || "").trim();
      if (!shiftId) return json({ error: "shiftId is verplicht." }, 400);

      await env.DB.prepare(`DELETE FROM shifts WHERE id = ?`).bind(shiftId).run();
      return json({ ok: true });
    }

    if (actie === "verlof_beoordelen") {
      const verlofId = String((body && body.verlofId) || "").trim();
      const beslissing = body && body.beslissing;
      if (!verlofId || !["goedkeuren", "afwijzen"].includes(beslissing)) {
        return json({ error: "verlofId en een geldige beslissing zijn verplicht." }, 400);
      }

      const aanvraag = await env.DB.prepare(`SELECT id FROM verlof_aanvragen WHERE id = ?`).bind(verlofId).first();
      if (!aanvraag) return json({ error: "Aanvraag niet gevonden." }, 404);

      await env.DB.prepare(
        `UPDATE verlof_aanvragen SET status = ?, afgehandeld_op = ?, afgehandeld_door = ? WHERE id = ?`
      ).bind(
        beslissing === "goedkeuren" ? "goedgekeurd" : "afgewezen",
        new Date().toISOString(),
        "beheer",
        verlofId
      ).run();

      return json({ ok: true });
    }

    if (actie === "uren_beoordelen") {
      const urenId = String((body && body.urenId) || "").trim();
      const beslissing = body && body.beslissing;
      if (!urenId || !["goedkeuren", "afwijzen"].includes(beslissing)) {
        return json({ error: "urenId en een geldige beslissing zijn verplicht." }, 400);
      }

      const uren = await env.DB.prepare(`SELECT id FROM werkuren WHERE id = ?`).bind(urenId).first();
      if (!uren) return json({ error: "Urenregel niet gevonden." }, 404);

      await env.DB.prepare(
        `UPDATE werkuren SET status = ?, afgehandeld_op = ?, afgehandeld_door = ? WHERE id = ?`
      ).bind(
        beslissing === "goedkeuren" ? "goedgekeurd" : "afgewezen",
        new Date().toISOString(),
        "beheer",
        urenId
      ).run();

      return json({ ok: true });
    }

    return json({ error: "Onbekende actie." }, 400);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
