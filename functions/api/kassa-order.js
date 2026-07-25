// functions/api/kassa-order.js
// Cloudflare Pages Function — POST /api/kassa-order
//
// Verwerkt een afgeronde kassaverkoop aan de balie. Er is BEWUST geen
// Mollie-stap: personeel bevestigt dit scherm pas nadat er fysiek is
// afgerekend (contant, of voorlopig een bedrag dat handmatig wordt
// overgetypt op het losse pinapparaat — zie project-notitie over de
// CCV-koppeling, die later apart wordt toegevoegd). Daarom slaan we de
// order meteen op als 'paid' en ronden we een eventuele loyaliteitskorting/
// zegel-toekenning direct af, in plaats van te wachten op een webhook.
//
// Prijzen worden — net als bij /api/order — altijd server-side herberekend
// uit producten.json ("nooit de klant/het scherm vertrouwen"), ook al is
// dit een personeelspagina: zo kan een verkeerd cachet scherm nooit een
// fout bedrag wegschrijven.
//
// Extras: de kassa gebruikt het kassaExtras-veld in producten.json (exacte
// CashDesk-keuzegroepen, 1:1 overgenomen — zie task #218/#219), NIET het
// extras-veld dat bestellen.html/de webshop gebruikt. Elke groep heeft een
// min/max (single-select = max 1, multi-select = max N) en kan optioneel
// vervangtPrijs dragen (de gekozen optieprijs vervangt dan de basisprijs
// i.p.v. dat hij erbij opgeteld wordt — bv. Gezinszak "Hoeveel personen?").
// Een eventuele kassaToeslag (bv. Verpakkingskosten bij Bittergarnituur) is
// een verplichte vaste toeslag die niet via een keuzegroep loopt.
// Body-item extras heeft de vorm { groepId: [optieIndex, ...] }.
//
// Alleen voor personeel, achter hetzelfde wachtwoord als de
// loyaliteitspagina (STAFF_LOYALTY_PASSWORD) — dezelfde balie-omgeving.
//
// Benodigde environment variables:
//   STAFF_LOYALTY_PASSWORD — wachtwoord voor personeelspagina's
//   DB                     — D1-database binding
//
// Body: { wachtwoord, items: [{id, aantal, extras?}], loyaliteitsCode?, kortingGebruikt? }
// Antwoord: { orderId, totaal, items, loyaliteit? }

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { wachtwoord, items, loyaliteitsCode, kortingGebruikt } = body || {};

    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: "Winkelwagen is leeg." }, 400);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    // Productenlijst + prijzen server-side ophalen — nooit de prijs
    // vertrouwen die eventueel vanuit het kassascherm meegestuurd wordt.
    const productenUrl = new URL("/producten.json", request.url);
    const productenRes = await fetch(productenUrl.toString());
    if (!productenRes.ok) {
      return json({ error: "Kon productenlijst niet laden." }, 500);
    }
    const catalogus = await productenRes.json();
    const alleProducten = catalogus.categorieen.flatMap((c) => c.producten);
    const productMap = new Map(alleProducten.map((p) => [p.id, p]));

    const orderRegels = [];
    let totaal = 0;

    for (const regel of items) {
      const product = productMap.get(regel.id);
      if (!product) {
        return json({ error: `Onbekend product: ${regel.id}` }, 400);
      }
      const aantal = Math.max(1, Math.min(50, parseInt(regel.aantal, 10) || 1));

      let basisPrijs = product.prijs;
      let extraPrijs = 0;
      const extraOmschrijvingen = [];
      const gekozenExtras = (regel.extras && typeof regel.extras === "object") ? regel.extras : {};

      if (Array.isArray(product.kassaExtras)) {
        for (const groep of product.kassaExtras) {
          const idxs = Array.isArray(gekozenExtras[groep.id]) ? gekozenExtras[groep.id] : [];
          const min = groep.min || 0;
          const max = groep.max || 1;
          if (idxs.length < min) {
            return json({ error: `Kies minimaal ${min} optie(s) bij "${groep.naam}" voor ${product.naam}.` }, 400);
          }
          if (idxs.length > max) {
            return json({ error: `Te veel keuzes bij "${groep.naam}" voor ${product.naam}.` }, 400);
          }
          for (const idx of idxs) {
            const optie = groep.opties[idx];
            if (!optie) {
              return json({ error: `Ongeldige keuze bij "${groep.naam}" voor ${product.naam}.` }, 400);
            }
            if (groep.vervangtPrijs) {
              basisPrijs = optie.prijs;
            } else {
              extraPrijs += optie.prijs || 0;
            }
            extraOmschrijvingen.push(optie.naam);
          }
        }
      }
      if (product.kassaToeslag) {
        extraPrijs += product.kassaToeslag.prijs || 0;
        extraOmschrijvingen.push(product.kassaToeslag.naam);
      }

      const perStuk = Math.round((basisPrijs + extraPrijs) * 100) / 100;
      const subtotaal = Math.round(perStuk * aantal * 100) / 100;
      totaal += subtotaal;

      orderRegels.push({
        id: product.id,
        naam: product.naam,
        prijs: perStuk,
        extras: extraOmschrijvingen.join(", "),
        aantal,
        subtotaal,
      });
    }
    totaal = Math.round(totaal * 100) / 100;

    if (totaal <= 0) {
      return json({ error: "Ongeldig totaalbedrag." }, 400);
    }

    // Loyaliteit: personeel mag aangeven hoeveel van de beschikbare korting nu
    // verzilverd wordt, maar de server bepaalt zelf het maximum (nooit het
    // scherm vertrouwen) — zelfde regels als loyalty-stempel.js.
    let loyaliteitContext = null;
    if (loyaliteitsCode && String(loyaliteitsCode).trim()) {
      const code = String(loyaliteitsCode).trim().toUpperCase();
      const account = await env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE code = ?`).bind(code).first();
      if (!account) {
        return json({ error: "Onbekende spaarkaart-code." }, 400);
      }

      let kortingGebruiktNum = Number(kortingGebruikt) || 0;
      kortingGebruiktNum = Math.max(0, Math.min(kortingGebruiktNum, account.beschikbare_korting, totaal));
      kortingGebruiktNum = Math.round(kortingGebruiktNum * 100) / 100;

      const nettoBedrag = Math.round((totaal - kortingGebruiktNum) * 100) / 100;

      const uitkomst = berekenZegels({
        restBedragOud: account.rest_bedrag,
        zegelsOud: account.zegels,
        beschikbareKortingOud: account.beschikbare_korting,
        nettoBedrag,
        kortingGebruikt: kortingGebruiktNum,
      });

      loyaliteitContext = { code, kortingGebruikt: kortingGebruiktNum, nettoBedrag, uitkomst };
      totaal = nettoBedrag; // het daadwerkelijk te betalen bedrag is na korting
    }

    const orderId = "BD-KASSA-" + Date.now().toString(36).toUpperCase();
    const nu = new Date().toISOString();

    // Order meteen als 'paid' opslaan: personeel bevestigt dit scherm pas
    // ná fysiek afrekenen, dus er is (nog) geen aparte betaalbevestiging
    // zoals bij Mollie nodig.
    try {
      await env.DB.prepare(
        `INSERT INTO orders (order_id, status, totaal, korting, coupon_code, klant_email, klant_telefoon, levering, items_json, acties_json, aangemaakt_op, betaald_op, loyalty_code, loyalty_korting_gebruikt)
         VALUES (?, 'paid', ?, 0, NULL, NULL, NULL, 'kassa', ?, '[]', ?, ?, ?, ?)`
      )
        .bind(
          orderId,
          totaal,
          JSON.stringify(orderRegels),
          nu,
          nu,
          loyaliteitContext ? loyaliteitContext.code : null,
          loyaliteitContext ? loyaliteitContext.kortingGebruikt : 0
        )
        .run();
    } catch (dbErr) {
      return json({ error: "Kon de verkoop niet opslaan.", detail: String(dbErr) }, 500);
    }

    // Loyaliteit pas ná het succesvol wegschrijven van de order afronden, nu
    // mét het echte order_id (in tegenstelling tot handmatige stempelacties
    // via kassa-loyaliteit.html, waar geen bijbehorende order bestaat).
    let loyaliteitAntwoord = null;
    if (loyaliteitContext) {
      const { code, kortingGebruikt: kg, nettoBedrag, uitkomst } = loyaliteitContext;
      try {
        await env.DB.prepare(
          `UPDATE loyalty_accounts SET rest_bedrag = ?, zegels = ?, beschikbare_korting = ?, laatst_gebruikt_op = ? WHERE code = ?`
        )
          .bind(uitkomst.restBedragNieuw, uitkomst.zegelsNieuw, uitkomst.beschikbareKortingNieuw, nu, code)
          .run();

        await env.DB.prepare(
          `INSERT INTO loyalty_transacties (code, bedrag, bron, zegels_erbij, korting_erbij, korting_gebruikt, order_id, moment)
           VALUES (?, ?, 'kassa', ?, ?, ?, ?, ?)`
        )
          .bind(code, nettoBedrag, uitkomst.zegelsErbij, uitkomst.kortingErbij, kg, orderId, nu)
          .run();

        loyaliteitAntwoord = {
          code,
          kortingGebruikt: kg,
          zegelsErbij: uitkomst.zegelsErbij,
          kortingErbij: uitkomst.kortingErbij,
          zegelsNieuw: uitkomst.zegelsNieuw,
          beschikbareKortingNieuw: uitkomst.beschikbareKortingNieuw,
        };
      } catch (loyErr) {
        console.error("kassa-order: order is opgeslagen, maar loyaliteit kon niet bijgewerkt worden", loyErr);
        // De verkoop zelf is al veiliggesteld; we laten de kassa-transactie
        // hier bewust niet op mislukken — personeel krijgt wel een melding.
        loyaliteitAntwoord = { fout: "Verkoop is opgeslagen, maar de spaarkaart kon niet worden bijgewerkt." };
      }
    }

    return json({ orderId, totaal, items: orderRegels, loyaliteit: loyaliteitAntwoord });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

// Zelfde cumulatieve zegel-logica als in loyalty-stempel.js / mollie-webhook.js
// — bewust hier ook gedupliceerd, zelfde stijl als de rest van dit project
// (elke Cloudflare Pages Function staat op zichzelf).
function berekenZegels({ restBedragOud, zegelsOud, beschikbareKortingOud, nettoBedrag, kortingGebruikt }) {
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
