// functions/api/personeel/planning.js
// Cloudflare Pages Function — GET/POST /api/personeel/planning?sessie=...
//
// Medewerker-kant van de personeelsplanning (src/personeel-rooster.html):
// de medewerker logt in met personeelsnummer+pincode of NFC (zelfde route
// als de bezorger-app, /api/personeel/login.js) en krijgt daarmee een
// sessieToken uit de bezorger_sessies-tabel (zie controleerBezorgerSessie
// in auth/_lib.js — inmiddels breder dan alleen bezorgers, naam bewust
// ongewijzigd gelaten). Die sessie wordt hier hergebruikt in plaats van een
// apart personeelswachtwoord: de medewerker ziet en beheert alleen zijn/
// haar eigen gegevens, nooit die van collega's.
//
// GET  ?sessie=...&week=YYYY-MM-DD (maandag van de gewenste week)
//      -> { naam, personeelsnummer, week, shifts (eigen, die week),
//           beschikbaarheid (eigen, die week), verlofAanvragen (eigen,
//           alle openstaande + laatste 90 dagen), werkuren (eigen, laatste
//           30 dagen) }
// POST : { actie: 'beschikbaarheid_doorgeven', datum, dagdeel, status, opmerking }
//        { actie: 'verlof_aanvragen', vanDatum, totDatum, type, reden }
//        { actie: 'uren_indienen', datum, startTijd, eindTijd, pauzeMinuten, shiftId }
//
// Benodigde environment variables:
// DB — D1-database binding

import {
  zorgVoorPersoneelTabel,
  zorgVoorBezorgerSessieTabel,
  zorgVoorPlanningTabellen,
  controleerBezorgerSessie,
  json,
} from "../auth/_lib.js";

async function haalSessieOp(request, env) {
  if (!env.DB) return { fout: json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500) };

  await zorgVoorPersoneelTabel(env.DB);
  await zorgVoorBezorgerSessieTabel(env.DB);
  await zorgVoorPlanningTabellen(env.DB);

  const url = new URL(request.url);
  const sessieToken = url.searchParams.get("sessie") || "";
  const sessie = await controleerBezorgerSessie(env.DB, sessieToken);
  if (!sessie.geldig) {
    return { fout: json({ error: "Sessie is verlopen of ongeldig — log opnieuw in." }, 401) };
  }
  return { sessie };
}

function maandagVanWeek(datumStr) {
  const basis = datumStr && !isNaN(Date.parse(datumStr)) ? new Date(datumStr + "T00:00:00") : new Date();
  const dag = basis.getDay();
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

const GELDIGE_BESCHIKBAARHEID_STATUSSEN = ["beschikbaar", "niet_beschikbaar", "voorkeur"];
const GELDIGE_DAGDELEN = ["ochtend", "middag", "avond", "hele_dag"];
const GELDIGE_VERLOF_TYPES = ["verlof", "ziek"];

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const { fout, sessie } = await haalSessieOp(request, env);
    if (fout) return fout;

    const url = new URL(request.url);
    const weekMaandag = maandagVanWeek(url.searchParams.get("week"));
    const weekZondag = plusDagen(weekMaandag, 6);
    const negentigDagenGeleden = plusDagen(new Date().toISOString().slice(0, 10), -90);
    const dertigDagenGeleden = plusDagen(new Date().toISOString().slice(0, 10), -30);

    const { results: shifts } = await env.DB.prepare(
      `SELECT id, datum, start_tijd, eind_tijd, functie, notitie
       FROM shifts WHERE personeelsnummer = ? AND datum BETWEEN ? AND ?
       ORDER BY datum ASC, start_tijd ASC`
    ).bind(sessie.personeelsnummer, weekMaandag, weekZondag).all();

    const { results: beschikbaarheid } = await env.DB.prepare(
      `SELECT datum, dagdeel, status, opmerking
       FROM beschikbaarheid WHERE personeelsnummer = ? AND datum BETWEEN ? AND ?
       ORDER BY datum ASC`
    ).bind(sessie.personeelsnummer, weekMaandag, weekZondag).all();

    const { results: verlofAanvragen } = await env.DB.prepare(
      `SELECT id, van_datum, tot_datum, type, reden, status, aangemaakt_op
       FROM verlof_aanvragen
       WHERE personeelsnummer = ? AND (status = 'aangevraagd' OR aangemaakt_op >= ?)
       ORDER BY aangemaakt_op DESC`
    ).bind(sessie.personeelsnummer, negentigDagenGeleden).all();

    const { results: werkuren } = await env.DB.prepare(
      `SELECT id, datum, start_tijd, eind_tijd, pauze_minuten, status
       FROM werkuren
       WHERE personeelsnummer = ? AND datum >= ?
       ORDER BY datum DESC`
    ).bind(sessie.personeelsnummer, dertigDagenGeleden).all();

    return json({
      naam: sessie.naam,
      personeelsnummer: sessie.personeelsnummer,
      week: weekMaandag,
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
    const { fout, sessie } = await haalSessieOp(request, env);
    if (fout) return fout;

    const body = await request.json();
    const actie = body && body.actie;

    if (actie === "beschikbaarheid_doorgeven") {
      const datum = String((body && body.datum) || "").trim();
      const dagdeel = String((body && body.dagdeel) || "hele_dag").trim();
      const status = String((body && body.status) || "").trim();
      const opmerking = String((body && body.opmerking) || "").trim() || null;

      if (!datum || isNaN(Date.parse(datum))) return json({ error: "Geldige datum is verplicht." }, 400);
      if (!GELDIGE_DAGDELEN.includes(dagdeel)) return json({ error: "Ongeldig dagdeel." }, 400);
      if (!GELDIGE_BESCHIKBAARHEID_STATUSSEN.includes(status)) return json({ error: "Ongeldige status." }, 400);

      await env.DB.prepare(
        `INSERT INTO beschikbaarheid (personeelsnummer, datum, dagdeel, status, opmerking, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (personeelsnummer, datum, dagdeel)
         DO UPDATE SET status = excluded.status, opmerking = excluded.opmerking, aangemaakt_op = excluded.aangemaakt_op`
      ).bind(sessie.personeelsnummer, datum, dagdeel, status, opmerking, new Date().toISOString()).run();

      return json({ ok: true });
    }

    if (actie === "verlof_aanvragen") {
      const vanDatum = String((body && body.vanDatum) || "").trim();
      const totDatum = String((body && body.totDatum) || "").trim();
      const type = String((body && body.type) || "verlof").trim();
      const reden = String((body && body.reden) || "").trim() || null;

      if (!vanDatum || isNaN(Date.parse(vanDatum))) return json({ error: "Geldige begindatum is verplicht." }, 400);
      if (!totDatum || isNaN(Date.parse(totDatum))) return json({ error: "Geldige einddatum is verplicht." }, 400);
      if (totDatum < vanDatum) return json({ error: "Einddatum ligt voor begindatum." }, 400);
      if (!GELDIGE_VERLOF_TYPES.includes(type)) return json({ error: "Ongeldig type (verlof of ziek)." }, 400);

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO verlof_aanvragen (id, personeelsnummer, van_datum, tot_datum, type, reden, status, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, 'aangevraagd', ?)`
      ).bind(id, sessie.personeelsnummer, vanDatum, totDatum, type, reden, new Date().toISOString()).run();

      return json({ ok: true, verlofId: id });
    }

    if (actie === "uren_indienen") {
      const datum = String((body && body.datum) || "").trim();
      const startTijd = String((body && body.startTijd) || "").trim();
      const eindTijd = String((body && body.eindTijd) || "").trim();
      const pauzeMinuten = Number.isFinite(Number(body && body.pauzeMinuten)) ? Number(body.pauzeMinuten) : 0;
      const shiftId = String((body && body.shiftId) || "").trim() || null;

      if (!datum || isNaN(Date.parse(datum))) return json({ error: "Geldige datum is verplicht." }, 400);
      if (!startTijd || !eindTijd) return json({ error: "Start- en eindtijd zijn verplicht." }, 400);
      if (pauzeMinuten < 0) return json({ error: "Pauzeminuten kunnen niet negatief zijn." }, 400);

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO werkuren (id, personeelsnummer, datum, start_tijd, eind_tijd, pauze_minuten, shift_id, status, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ingediend', ?)`
      ).bind(id, sessie.personeelsnummer, datum, startTijd, eindTijd, pauzeMinuten, shiftId, new Date().toISOString()).run();

      return json({ ok: true, urenId: id });
    }

    return json({ error: "Onbekende actie." }, 400);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
