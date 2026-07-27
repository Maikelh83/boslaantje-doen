// functions/api/bezorger-ritten.js
// Cloudflare Pages Function — GET/POST /api/bezorger-ritten?wachtwoord=...
//
// Backend voor de PWA Bezorger-app (src/kassa-bezorger.html). De chauffeur
// wordt geïdentificeerd met een personeelsnummer (zie het personeelsnummer-
// fundament in auth/_lib.js: medewerkers-tabel + /api/personeel/login.js) —
// dat inloggen gebeurt vóórdat deze endpoints worden aangeroepen; hier wordt
// het personeelsnummer alleen nog gecontroleerd tegen de medewerkers-tabel
// (moet bestaan én actief zijn) zodat we nooit een naam van de client zelf
// vertrouwen. Ritten worden klaargezet door personeel via
// /api/admin/ritten.js (src/kassa-ritten.html).
//
// GET ?wachtwoord=...&ritId=...
//   Geeft de volledige details (incl. stops) van één specifieke rit terug -
//   gebruikt om een net gestarte of eerder gestarte rit (opnieuw) te tonen.
// GET ?wachtwoord=...&chauffeur=<personeelsnummer>
//   Geeft { beschikbareRitten: [...], actieveRit: {...} | null, openstaandeOrders: [...] }
//   terug: beschikbareRitten is elke rit met status PENDING (klaar om te
//   starten, meestal door personeel klaargezet via /api/admin/ritten.js),
//   actieveRit is - als het personeelsnummer meegegeven is - de rit die deze
//   chauffeur al IN_TRANSIT heeft staan (voor het geval de app ververst is),
//   openstaandeOrders zijn de nog niet ingedeelde bezorgorders (rit_id NULL)
//   zodat de bezorger ze evt. zelf tot een rit kan bundelen (zie 'start_eigen_rit'
//   hieronder) zonder de personeelspagina kassa-ritten.html nodig te hebben.
//
// POST ?wachtwoord=... body { actie: 'start', ritId, personeelsnummer }
//   Koppelt de rit aan de chauffeur (naam wordt hier server-side opgezocht
//   in de medewerkers-tabel, nooit van de client aangenomen), zet de rit +
//   alle orders erin op IN_TRANSIT, en geeft de volledige rit-details terug
//   (1-druk-op-de-knop).
// POST ?wachtwoord=... body { actie: 'start_eigen_rit', orderIds: [...], personeelsnummer }
//   Zelfde controles als /api/admin/ritten.js (elke order moet bestaan,
//   bezorgen zijn, betaald zijn en nog niet in een rit zitten), maar in
//   plaats van een PENDING rit klaar te zetten voor een willekeurige
//   bezorger, wordt de rit meteen aan déze chauffeur gekoppeld en op
//   IN_TRANSIT gezet - de bezorger kiest dus zelf zijn orders in de app en
//   rijdt meteen weg, zonder tussenstap via kassa-ritten.html.
// POST ?wachtwoord=... body { actie: 'afgeleverd', orderId }
//   Zet deze ene stop op DELIVERED. Als dit de laatste openstaande stop in
//   de rit was, wordt de hele rit automatisch op COMPLETED gezet.
// POST ?wachtwoord=... body { actie: 'markeer_betaald', orderId, sumupTxCode? }
//   Bevestigt de betaling van een 'aan de deur'-order (betaalmethode
//   'aan_de_deur' in order.js): zet betaalstatus op 'betaald' (en bewaart
//   SumUp's tx-code als die is meegegeven). Alleen dán verdwijnt de
//   PIN-betalingsknop in kassa-bezorger.html en telt de order mee in de
//   omzetcijfers van dashboard-data.js.
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// DB — D1-database binding

import { zorgVoorAccountTabellen, zorgVoorRittenTabellen, zorgVoorKlantgegevensKolommen, zorgVoorPersoneelTabel, zorgVoorBetaalmethodeKolommen, json } from "./auth/_lib.js";

function controleerToegang(request, env) {
  const url = new URL(request.url);
  const wachtwoord = url.searchParams.get("wachtwoord") || "";
  if (!env.STAFF_LOYALTY_PASSWORD) {
    return json({ error: "De bezorger-app is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
  }
  if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
    return json({ error: "Onjuist wachtwoord." }, 401);
  }
  if (!env.DB) {
    return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
  }
  return null;
}

async function haalRitDetail(db, ritId) {
  const rit = await db.prepare(`SELECT * FROM ritten WHERE id = ?`).bind(ritId).first();
  if (!rit) return null;
  const { results: stops } = await db.prepare(
    `SELECT order_id, klant_naam, klant_telefoon, adres, postcode, plaats, opmerkingen, stop_volgorde, bezorg_status, totaal, betaalmethode, betaalstatus
     FROM orders WHERE rit_id = ? ORDER BY stop_volgorde ASC`
  ).bind(ritId).all();
  return {
    ritId: rit.id,
    status: rit.status,
    chauffeurNaam: rit.chauffeur_naam || null,
    chauffeurPersoneelsnummer: rit.chauffeur_personeelsnummer || null,
    aangemaaktOp: rit.aangemaakt_op,
    gestartOp: rit.gestart_op || null,
    afgerondOp: rit.afgerond_op || null,
    stops: (stops || []).map((s) => ({
      orderId: s.order_id,
      klantNaam: s.klant_naam || null,
      klantTelefoon: s.klant_telefoon || null,
      adres: s.adres || null,
      postcode: s.postcode || null,
      plaats: s.plaats || null,
      opmerkingen: s.opmerkingen || null,
      stopVolgorde: s.stop_volgorde,
      bezorgStatus: s.bezorg_status || "PENDING",
      // 'Aan de deur betalen' (SumUp Tap to Pay / contant): de bezorger-app
      // toont de PIN-betalingsknop alleen als betaalmethode 'aan_de_deur' is
      // én betaalstatus nog 'onbetaald' - zodra bevestigd (zie de
      // 'markeer_betaald'-actie hieronder) verdwijnt de knop vanzelf.
      totaal: typeof s.totaal === "number" ? s.totaal : null,
      betaalmethode: s.betaalmethode || null,
      betaalstatus: s.betaalstatus || null,
    })),
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);
    await zorgVoorRittenTabellen(env.DB);
    await zorgVoorKlantgegevensKolommen(env.DB);
    await zorgVoorPersoneelTabel(env.DB);
    await zorgVoorBetaalmethodeKolommen(env.DB);

    const url = new URL(request.url);
    const ritId = url.searchParams.get("ritId");
    const chauffeur = (url.searchParams.get("chauffeur") || "").trim();

    if (ritId) {
      const detail = await haalRitDetail(env.DB, ritId);
      if (!detail) return json({ error: "Rit niet gevonden." }, 404);
      return json({ rit: detail });
    }

    const { results: pending } = await env.DB.prepare(
      `SELECT id, aangemaakt_op FROM ritten WHERE status = 'PENDING' ORDER BY aangemaakt_op ASC`
    ).all();

    const beschikbareRitten = [];
    for (const rit of pending || []) {
      const { results: stops } = await env.DB.prepare(
        `SELECT adres, postcode, plaats FROM orders WHERE rit_id = ? ORDER BY stop_volgorde ASC`
      ).bind(rit.id).all();
      const eersteStop = (stops || [])[0] || null;
      beschikbareRitten.push({
        ritId: rit.id,
        aangemaaktOp: rit.aangemaakt_op,
        aantalStops: (stops || []).length,
        eersteAdres: eersteStop ? [eersteStop.adres, eersteStop.plaats].filter(Boolean).join(", ") : null,
      });
    }

    let actieveRit = null;
    if (chauffeur) {
      const rit = await env.DB.prepare(
        `SELECT id FROM ritten WHERE status = 'IN_TRANSIT' AND chauffeur_personeelsnummer = ? ORDER BY gestart_op DESC LIMIT 1`
      ).bind(chauffeur).first();
      if (rit) actieveRit = await haalRitDetail(env.DB, rit.id);
    }

    // Nog niet ingedeelde bezorgorders - zodat de bezorger-app deze zelf kan
    // tonen om er (via 'start_eigen_rit' hieronder) een eigen rit mee te
    // starten. Zelfde query als /api/admin/ritten.js.
    const { results: openstaand } = await env.DB.prepare(
      `SELECT order_id, klant_naam, klant_telefoon, adres, postcode, plaats, opmerkingen, totaal, aangemaakt_op
       FROM orders
       WHERE levering = 'bezorgen' AND status = 'paid' AND rit_id IS NULL
       ORDER BY aangemaakt_op ASC`
    ).all();
    const openstaandeOrders = (openstaand || []).map((o) => ({
      orderId: o.order_id,
      klantNaam: o.klant_naam || null,
      klantTelefoon: o.klant_telefoon || null,
      adres: o.adres || null,
      postcode: o.postcode || null,
      plaats: o.plaats || null,
      opmerkingen: o.opmerkingen || null,
      totaal: o.totaal,
      aangemaaktOp: o.aangemaakt_op,
    }));

    return json({ beschikbareRitten, actieveRit, openstaandeOrders });
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
    await zorgVoorRittenTabellen(env.DB);
    await zorgVoorKlantgegevensKolommen(env.DB);
    await zorgVoorPersoneelTabel(env.DB);
    await zorgVoorBetaalmethodeKolommen(env.DB);

    const body = await request.json();

    // '1-Druk-op-de-knop' acceptatie: koppelt de hele batch aan de
    // chauffeur en zet in één keer de rit + alle orders erin op IN_TRANSIT.
    // Het personeelsnummer is al geverifieerd bij het inloggen op het
    // vergrendelscherm (/api/personeel/login) - hier wordt het nog eens
    // tegen de medewerkers-tabel gecontroleerd (moet bestaan én actief zijn)
    // en de naam wordt hier zelf opgezocht, nooit van de client aangenomen.
    if (body && body.actie === "start") {
      const ritId = body.ritId;
      const personeelsnummer = (body.personeelsnummer || "").trim();
      if (!ritId) return json({ error: "ritId is verplicht." }, 400);
      if (!personeelsnummer) return json({ error: "Log opnieuw in voordat je een rit start." }, 400);

      const medewerker = await env.DB.prepare(
        `SELECT naam, actief FROM medewerkers WHERE personeelsnummer = ?`
      ).bind(personeelsnummer).first();
      if (!medewerker || !medewerker.actief) {
        return json({ error: "Onbekend of niet-actief personeelsnummer. Log opnieuw in." }, 401);
      }

      const rit = await env.DB.prepare(`SELECT * FROM ritten WHERE id = ?`).bind(ritId).first();
      if (!rit) return json({ error: "Rit niet gevonden." }, 404);
      if (rit.status !== "PENDING") {
        return json({ error: "Deze rit is al gestart door iemand anders." }, 409);
      }

      const nu = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE ritten SET status = 'IN_TRANSIT', chauffeur_naam = ?, chauffeur_personeelsnummer = ?, gestart_op = ? WHERE id = ?`
      ).bind(medewerker.naam, personeelsnummer, nu, ritId).run();
      await env.DB.prepare(
        `UPDATE orders SET bezorg_status = 'IN_TRANSIT' WHERE rit_id = ?`
      ).bind(ritId).run();

      const detail = await haalRitDetail(env.DB, ritId);
      return json({ rit: detail });
    }

    // Bezorger kiest zelf orders (geen tussenstap via kassa-ritten.html):
    // zelfde validaties als /api/admin/ritten.js bij het aanmaken van een
    // rit, maar de rit wordt hier meteen aan déze chauffeur gekoppeld en op
    // IN_TRANSIT gezet - "1-druk-op-de-knop" voor de bezorger zelf.
    if (body && body.actie === "start_eigen_rit") {
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds : null;
      const personeelsnummer = (body.personeelsnummer || "").trim();
      if (!orderIds || orderIds.length === 0) {
        return json({ error: "Kies minimaal één bestelling voor de rit." }, 400);
      }
      if (!personeelsnummer) return json({ error: "Log opnieuw in voordat je een rit start." }, 400);

      const medewerker = await env.DB.prepare(
        `SELECT naam, actief FROM medewerkers WHERE personeelsnummer = ?`
      ).bind(personeelsnummer).first();
      if (!medewerker || !medewerker.actief) {
        return json({ error: "Onbekend of niet-actief personeelsnummer. Log opnieuw in." }, 401);
      }

      // Elke order opnieuw controleren (nooit de client vertrouwen): moet
      // bestaan, bezorgen zijn, betaald zijn, en nog niet in een rit zitten.
      for (const orderId of orderIds) {
        const order = await env.DB.prepare(
          `SELECT order_id, levering, status, rit_id FROM orders WHERE order_id = ?`
        ).bind(orderId).first();
        if (!order) return json({ error: `Bestelling ${orderId} niet gevonden.` }, 400);
        if (order.levering !== "bezorgen") return json({ error: `Bestelling ${orderId} is geen bezorgorder.` }, 400);
        if (order.status !== "paid") return json({ error: `Bestelling ${orderId} is (nog) niet betaald.` }, 400);
        if (order.rit_id) return json({ error: `Bestelling ${orderId} zit al in een andere rit.` }, 400);
      }

      const ritId = crypto.randomUUID();
      const nu = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO ritten (id, chauffeur_naam, chauffeur_personeelsnummer, status, aangemaakt_op, gestart_op) VALUES (?, ?, ?, 'IN_TRANSIT', ?, ?)`
      ).bind(ritId, medewerker.naam, personeelsnummer, nu, nu).run();

      for (let i = 0; i < orderIds.length; i++) {
        await env.DB.prepare(
          `UPDATE orders SET rit_id = ?, stop_volgorde = ?, bezorg_status = 'IN_TRANSIT' WHERE order_id = ?`
        ).bind(ritId, i + 1, orderIds[i]).run();
      }

      const detail = await haalRitDetail(env.DB, ritId);
      return json({ rit: detail });
    }

    // Eén stop afvinken. Springt automatisch door: de client bepaalt zelf
    // de volgende stop uit de teruggegeven rit-details (stops gesorteerd op
    // stop_volgorde), maar we geven ritVoltooid mee zodat het scherm naar
    // "Rit Afgerond" kan springen zodra de laatste stop klaar is.
    if (body && body.actie === "afgeleverd") {
      const orderId = body.orderId;
      if (!orderId) return json({ error: "orderId is verplicht." }, 400);

      const order = await env.DB.prepare(
        `SELECT order_id, rit_id FROM orders WHERE order_id = ?`
      ).bind(orderId).first();
      if (!order || !order.rit_id) return json({ error: "Bestelling hoort niet bij een rit." }, 400);

      await env.DB.prepare(
        `UPDATE orders SET bezorg_status = 'DELIVERED' WHERE order_id = ?`
      ).bind(orderId).run();

      const openstaandeStops = await env.DB.prepare(
        `SELECT COUNT(*) AS aantal FROM orders WHERE rit_id = ? AND bezorg_status != 'DELIVERED'`
      ).bind(order.rit_id).first();

      let ritVoltooid = false;
      if (!openstaandeStops || openstaandeStops.aantal === 0) {
        ritVoltooid = true;
        await env.DB.prepare(
          `UPDATE ritten SET status = 'COMPLETED', afgerond_op = ? WHERE id = ?`
        ).bind(new Date().toISOString(), order.rit_id).run();
      }

      const detail = await haalRitDetail(env.DB, order.rit_id);
      return json({ ritVoltooid, rit: detail });
    }

    // 'Aan de deur betalen' bevestigen: wordt aangeroepen zodra SumUp de
    // bezorger terugstuurt met status=success (via de callback-pagina,
    // kassa-bezorger-betaling.html) óf zodra de chauffeur zelf op "Contant
    // ontvangen" tikt in kassa-bezorger.html (dan zonder sumupTxCode). We
    // controleren hier dat het echt om een 'aan_de_deur'-order gaat, zodat
    // deze actie nooit per ongeluk (of moedwillig vanaf de client) een
    // normale Mollie/factuur-order als betaald kan markeren.
    if (body && body.actie === "markeer_betaald") {
      const orderId = body.orderId;
      if (!orderId) return json({ error: "orderId is verplicht." }, 400);
      const sumupTxCode = body.sumupTxCode ? String(body.sumupTxCode).trim() : null;

      const order = await env.DB.prepare(
        `SELECT order_id, rit_id, betaalmethode FROM orders WHERE order_id = ?`
      ).bind(orderId).first();
      if (!order) return json({ error: "Bestelling niet gevonden." }, 404);
      if (order.betaalmethode !== "aan_de_deur") {
        return json({ error: "Deze bestelling is geen 'aan de deur'-bestelling." }, 400);
      }

      await env.DB.prepare(
        `UPDATE orders SET betaalstatus = 'betaald', sumup_tx_code = ? WHERE order_id = ?`
      ).bind(sumupTxCode, orderId).run();

      // Rit-detail meesturen (zelfde patroon als 'afgeleverd' hierboven) zodat
      // kassa-bezorger.html het scherm meteen kan verversen - de AFGELEVERD-
      // knop verschijnt dan vanzelf, nu betaalstatus niet meer 'onbetaald' is.
      const detail = order.rit_id ? await haalRitDetail(env.DB, order.rit_id) : null;
      return json({ ok: true, rit: detail });
    }

    return json({ error: "Onbekende actie." }, 400);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}