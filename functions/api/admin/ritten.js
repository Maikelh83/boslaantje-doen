// functions/api/admin/ritten.js
// Cloudflare Pages Function — GET/POST /api/admin/ritten?wachtwoord=...
//
// Personeelspagina (src/kassa-ritten.html) waarmee open bezorgorders
// gebundeld worden tot een 'rit' (batch) voor de PWA Bezorger-app
// (src/kassa-bezorger.html + functions/api/bezorger-ritten.js). Zelfde
// wachtwoord-gate als /api/admin/zakelijke-klanten.js en
// /api/admin/bezorgzone-instellingen.js (STAFF_LOYALTY_PASSWORD) - er
// bestaat in dit project geen apart personeels-account-systeem.
//
// GET  : lijst met nog niet ingedeelde bezorgorders + bestaande ritten
//        (elk met hun stops), zodat het scherm de huidige stand kan tonen.
// POST : { orderIds: [...] } in de gewenste stopvolgorde -> maakt een
//        nieuwe rit aan en koppelt de orders eraan (bezorg_status
//        'PENDING'). Of { actie: 'ontkoppel', ritId } om een nog niet
//        gestarte (status PENDING) rit weer te ontbinden - de orders
//        komen dan terug bij de "nog in te delen"-lijst.
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als de rest van /kassa-*
// DB — D1-database binding

import { zorgVoorAccountTabellen, zorgVoorRittenTabellen, zorgVoorKlantgegevensKolommen, json } from "../auth/_lib.js";

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

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);
    await zorgVoorRittenTabellen(env.DB);
    await zorgVoorKlantgegevensKolommen(env.DB);

    const { results: openstaand } = await env.DB.prepare(
      `SELECT order_id, klant_naam, klant_telefoon, adres, postcode, plaats, opmerkingen, totaal, aangemaakt_op
       FROM orders
       WHERE levering = 'bezorgen' AND status = 'paid' AND rit_id IS NULL
       ORDER BY aangemaakt_op ASC`
    ).all();

    const { results: ritten } = await env.DB.prepare(
      `SELECT id, chauffeur_naam, status, aangemaakt_op, gestart_op, afgerond_op
       FROM ritten
       WHERE status != 'COMPLETED'
       ORDER BY aangemaakt_op DESC`
    ).all();

    const rittenMetStops = [];
    for (const rit of ritten || []) {
      const { results: stops } = await env.DB.prepare(
        `SELECT order_id, klant_naam, adres, postcode, plaats, klant_telefoon, stop_volgorde, bezorg_status
         FROM orders WHERE rit_id = ? ORDER BY stop_volgorde ASC`
      ).bind(rit.id).all();
      rittenMetStops.push({
        ritId: rit.id,
        chauffeurNaam: rit.chauffeur_naam || null,
        status: rit.status,
        aangemaaktOp: rit.aangemaakt_op,
        gestartOp: rit.gestart_op || null,
        stops: (stops || []).map((s) => ({
          orderId: s.order_id,
          klantNaam: s.klant_naam || null,
          adres: s.adres || null,
          postcode: s.postcode || null,
          plaats: s.plaats || null,
          klantTelefoon: s.klant_telefoon || null,
          stopVolgorde: s.stop_volgorde,
          bezorgStatus: s.bezorg_status || "PENDING",
        })),
      });
    }

    return json({
      openstaandeOrders: (openstaand || []).map((o) => ({
        orderId: o.order_id,
        klantNaam: o.klant_naam || null,
        klantTelefoon: o.klant_telefoon || null,
        adres: o.adres || null,
        postcode: o.postcode || null,
        plaats: o.plaats || null,
        opmerkingen: o.opmerkingen || null,
        totaal: o.totaal,
        aangemaaktOp: o.aangemaakt_op,
      })),
      ritten: rittenMetStops,
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

    await zorgVoorAccountTabellen(env.DB);
    await zorgVoorRittenTabellen(env.DB);
    await zorgVoorKlantgegevensKolommen(env.DB);

    const body = await request.json();

    // Rit ontbinden (alleen toegestaan zolang de rit nog niet gestart is -
    // eenmaal IN_TRANSIT zit de bezorger er al mee op pad).
    if (body && body.actie === "ontkoppel") {
      const ritId = body.ritId;
      if (!ritId) return json({ error: "ritId is verplicht." }, 400);
      const rit = await env.DB.prepare(`SELECT * FROM ritten WHERE id = ?`).bind(ritId).first();
      if (!rit) return json({ error: "Rit niet gevonden." }, 404);
      if (rit.status !== "PENDING") {
        return json({ error: "Deze rit is al gestart en kan niet meer ontbonden worden." }, 400);
      }
      await env.DB.prepare(
        `UPDATE orders SET rit_id = NULL, stop_volgorde = NULL, bezorg_status = NULL WHERE rit_id = ?`
      ).bind(ritId).run();
      await env.DB.prepare(`DELETE FROM ritten WHERE id = ?`).bind(ritId).run();
      return json({ ok: true });
    }

    // Nieuwe rit aanmaken uit een lijst order_ids, in de gewenste stopvolgorde.
    const orderIds = body && Array.isArray(body.orderIds) ? body.orderIds : null;
    if (!orderIds || orderIds.length === 0) {
      return json({ error: "Kies minimaal één bestelling voor de rit." }, 400);
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
      `INSERT INTO ritten (id, chauffeur_naam, status, aangemaakt_op) VALUES (?, NULL, 'PENDING', ?)`
    ).bind(ritId, nu).run();

    for (let i = 0; i < orderIds.length; i++) {
      await env.DB.prepare(
        `UPDATE orders SET rit_id = ?, stop_volgorde = ?, bezorg_status = 'PENDING' WHERE order_id = ?`
      ).bind(ritId, i + 1, orderIds[i]).run();
    }

    return json({ ritId });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
