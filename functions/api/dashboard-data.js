// functions/api/dashboard-data.js
// Cloudflare Pages Function — GET /api/dashboard-data?wachtwoord=...
//
// Levert de cijfers voor het marketingdashboard (src/dashboard.html):
// omzet/gebruik per actie, AOV, nieuw vs. terugkerend, top producten.
// Alleen bestellingen met status 'paid' tellen mee voor omzetcijfers.
//
// Benodigde environment variables:
//   DASHBOARD_PASSWORD — wachtwoord om het dashboard te mogen bekijken
//   DB                 — D1-database binding
//
// LET OP — conversiepercentage: dit dashboard heeft geen zicht op hoeveel
// mensen de bestelsite bezoeken (dat zit in Google Analytics, niet in
// deze database), dus een écht conversiepercentage kunnen we hier niet
// eerlijk berekenen. We laten dat veld daarom bewust weg in plaats van
// een verzonnen getal te tonen.

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const wachtwoord = url.searchParams.get("wachtwoord") || "";

    if (!env.DASHBOARD_PASSWORD) {
      return json({ error: "Dashboard is nog niet ingesteld (DASHBOARD_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.DASHBOARD_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!env.DB) {
      return json({ error: "Database is nog niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    const { results } = await env.DB.prepare(
      `SELECT order_id, status, totaal, korting, coupon_code, klant_email, levering, items_json, acties_json, aangemaakt_op, betaald_op
       FROM orders WHERE status = 'paid' ORDER BY aangemaakt_op DESC`
    ).all();

    const orders = results || [];

    // --- klant-frequentie (nieuw vs. terugkerend) op basis van e-mail, over ALLE betaalde orders heen ---
    const bestellingenPerEmail = new Map();
    orders.forEach((o) => {
      const email = (o.klant_email || "").toLowerCase();
      if (!email) return;
      bestellingenPerEmail.set(email, (bestellingenPerEmail.get(email) || 0) + 1);
    });
    function isTerugkerend(email, tellerTotDitMoment) {
      // "terugkerend" = deze klant had al minstens 1 eerdere betaalde bestelling.
      return tellerTotDitMoment > 1;
    }

    // --- algemeen overzicht ---
    const totaleOmzet = round2(orders.reduce((s, o) => s + (o.totaal || 0), 0));
    const aantalBestellingen = orders.length;
    const gemiddeldeBestelwaarde = aantalBestellingen ? round2(totaleOmzet / aantalBestellingen) : 0;
    const uniekeKlanten = new Set(orders.map((o) => (o.klant_email || "").toLowerCase()).filter(Boolean)).size;
    let nieuweKlanten = 0, terugkerendeKlanten = 0;
    const gezienEmails = new Set();
    // orders staan DESC (nieuwste eerst); loop omgekeerd zodat we per klant chronologisch tellen
    const chronologisch = orders.slice().reverse();
    const teller = new Map();
    chronologisch.forEach((o) => {
      const email = (o.klant_email || "").toLowerCase();
      if (!email) return;
      const huidigeTeller = (teller.get(email) || 0) + 1;
      teller.set(email, huidigeTeller);
      if (huidigeTeller === 1) nieuweKlanten += 1;
      else terugkerendeKlanten += 1;
    });

    // --- per actie ---
    const actiesMap = new Map(); // naam -> { orders: [...] }
    orders.forEach((o) => {
      let actieNamen = [];
      try { actieNamen = JSON.parse(o.acties_json || "[]"); } catch (e) { actieNamen = []; }
      actieNamen.forEach((naam) => {
        if (!actiesMap.has(naam)) actiesMap.set(naam, []);
        actiesMap.get(naam).push(o);
      });
    });

    const gemiddeldeBestelwaardeZonderActie = (() => {
      const zonderActie = orders.filter((o) => {
        try { return (JSON.parse(o.acties_json || "[]")).length === 0; } catch (e) { return true; }
      });
      if (!zonderActie.length) return gemiddeldeBestelwaarde;
      return round2(zonderActie.reduce((s, o) => s + (o.totaal || 0), 0) / zonderActie.length);
    })();

    const actiesOverzicht = Array.from(actiesMap.entries()).map(([naam, actieOrders]) => {
      const omzet = round2(actieOrders.reduce((s, o) => s + (o.totaal || 0), 0));
      const aov = round2(omzet / actieOrders.length);
      const emailsInActie = actieOrders.map((o) => (o.klant_email || "").toLowerCase()).filter(Boolean);
      let nieuw = 0, terug = 0;
      emailsInActie.forEach((email) => {
        if ((bestellingenPerEmail.get(email) || 0) > 1) terug += 1; else nieuw += 1;
      });

      // top producten binnen deze actie
      const productTeller = new Map();
      actieOrders.forEach((o) => {
        let items = [];
        try { items = JSON.parse(o.items_json || "[]"); } catch (e) { items = []; }
        items.forEach((it) => {
          if (!it.naam) return;
          productTeller.set(it.naam, (productTeller.get(it.naam) || 0) + (it.aantal || 1));
        });
      });
      const topProducten = Array.from(productTeller.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([naam, aantal]) => ({ naam, aantal }));

      return {
        naam,
        aantalGebruikt: actieOrders.length,
        omzet,
        gemiddeldeBestelwaarde: aov,
        extraOmzetSchatting: round2((aov - gemiddeldeBestelwaardeZonderActie) * actieOrders.length),
        nieuweKlanten: nieuw,
        terugkerendeKlanten: terug,
        topProducten,
      };
    }).sort((a, b) => b.omzet - a.omzet);

    return json({
      algemeen: {
        aantalBestellingen,
        totaleOmzet,
        gemiddeldeBestelwaarde,
        uniekeKlanten,
        nieuweKlanten,
        terugkerendeKlanten,
      },
      acties: actiesOverzicht,
      opmerking: "Extra omzet door de actie is een schatting (verschil in gemiddelde bestelwaarde t.o.v. bestellingen zonder actie, keer aantal keer gebruikt) — geen exacte toewijzing. Conversiepercentage wordt niet getoond: daarvoor is bezoekersdata (bijv. GA4) nodig, die dit dashboard niet heeft.",
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
