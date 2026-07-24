// functions/api/loyalty-stempel.js
// Cloudflare Pages Function — POST /api/loyalty-stempel
//
// Verwerkt een kassa-aankoop op een loyaliteitsaccount: telt het bedrag op,
// kent zegels toe (1 per volle €5, cumulatief via 'rest_bedrag' — ook
// kleine aankopen tellen mee) en levert een €5-korting op zodra 20 zegels
// zijn bereikt. Kan in dezelfde actie ook een al beschikbare korting laten
// verzilveren aan de kassa (kortingGebruikt).
//
// Alleen voor personeel, achter een wachtwoord — zie src/kassa-loyaliteit.html.
//
// Benodigde environment variables:
//   STAFF_LOYALTY_PASSWORD — wachtwoord voor de personeelspagina
//   DB                     — D1-database binding
//
// Body: { wachtwoord, code, bedrag, kortingGebruikt? }
//   bedrag          — het volledige aankoopbedrag vóór eventuele loyaliteitskorting
//   kortingGebruikt — optioneel: hoeveel van de beschikbare korting de klant
//                     nu aan de kassa heeft ingewisseld (mag niet meer zijn
//                     dan zowel het aankoopbedrag als de beschikbare korting)

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { wachtwoord, code: ruweCode, bedrag, kortingGebruikt } = body || {};
    const code = (ruweCode || "").trim().toUpperCase();

    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }
    if (!code) {
      return json({ error: "Geen code opgegeven." }, 400);
    }
    const bedragNum = Number(bedrag);
    if (!Number.isFinite(bedragNum) || bedragNum <= 0) {
      return json({ error: "Ongeldig bedrag." }, 400);
    }

    const account = await env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE code = ?`).bind(code).first();
    if (!account) {
      return json({ error: "Onbekende code — maak eerst een nieuwe spaarkaart aan." }, 404);
    }

    // Korting-inwisseling: nooit meer dan wat beschikbaar is, en nooit meer
    // dan het aankoopbedrag zelf (geen negatief nettobedrag).
    let kortingGebruiktNum = Number(kortingGebruikt) || 0;
    kortingGebruiktNum = Math.max(0, Math.min(kortingGebruiktNum, account.beschikbare_korting, bedragNum));
    kortingGebruiktNum = Math.round(kortingGebruiktNum * 100) / 100;

    const nettoBedrag = Math.round((bedragNum - kortingGebruiktNum) * 100) / 100;

    const uitkomst = berekenZegels({
      restBedragOud: account.rest_bedrag,
      zegelsOud: account.zegels,
      beschikbareKortingOud: account.beschikbare_korting,
      nettoBedrag,
      kortingGebruikt: kortingGebruiktNum,
    });

    const nu = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE loyalty_accounts SET rest_bedrag = ?, zegels = ?, beschikbare_korting = ?, laatst_gebruikt_op = ? WHERE code = ?`
    )
      .bind(uitkomst.restBedragNieuw, uitkomst.zegelsNieuw, uitkomst.beschikbareKortingNieuw, nu, code)
      .run();

    await env.DB.prepare(
      `INSERT INTO loyalty_transacties (code, bedrag, bron, zegels_erbij, korting_erbij, korting_gebruikt, order_id, moment)
       VALUES (?, ?, 'kassa', ?, ?, ?, NULL, ?)`
    )
      .bind(code, nettoBedrag, uitkomst.zegelsErbij, uitkomst.kortingErbij, kortingGebruiktNum, nu)
      .run();

    return json({
      code,
      zegelsErbij: uitkomst.zegelsErbij,
      kortingErbij: uitkomst.kortingErbij,
      kortingGebruikt: kortingGebruiktNum,
      account: {
        zegels: uitkomst.zegelsNieuw,
        restBedrag: uitkomst.restBedragNieuw,
        beschikbareKorting: uitkomst.beschikbareKortingNieuw,
      },
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

// Cumulatieve zegel-logica (in centen gerekend om afrondingsfouten met
// floats te voorkomen). Zelfde regels als afgesproken met Maikel:
//  - 1 zegel per volle €5 besteed, geen minimumbedrag per aankoop.
//  - Bij 20 zegels: €5 korting, en de teller loopt daarna door (meerdere
//    beloningen in één keer zijn mogelijk bij een grote besteding).
export function berekenZegels({ restBedragOud, zegelsOud, beschikbareKortingOud, nettoBedrag, kortingGebruikt }) {
  const restCentenOud = Math.round((restBedragOud || 0) * 100);
  const bedragCenten = Math.round((nettoBedrag || 0) * 100);
  const kortingGebruiktCenten = Math.round((kortingGebruikt || 0) * 100);

  const totaalCenten = restCentenOud + bedragCenten;
  const zegelsErbij = Math.floor(totaalCenten / 500);
  const restCentenNieuw = totaalCenten % 500;

  let zegelsTotaal = (zegelsOud || 0) + zegelsErbij;
  const beloningen = Math.floor(zegelsTotaal / 20);
  zegelsTotaal = zegelsTotaal % 20;
  const kortingErbijCenten = beloningen * 500;

  const beschikbareKortingCentenOud = Math.round((beschikbareKortingOud || 0) * 100);
  const beschikbareKortingCentenNieuw = beschikbareKortingCentenOud - kortingGebruiktCenten + kortingErbijCenten;

  return {
    restBedragNieuw: restCentenNieuw / 100,
    zegelsErbij,
    zegelsNieuw: zegelsTotaal,
    kortingErbij: kortingErbijCenten / 100,
    beschikbareKortingNieuw: Math.max(0, beschikbareKortingCentenNieuw) / 100,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
