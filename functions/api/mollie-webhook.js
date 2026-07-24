// functions/api/mollie-webhook.js
// Cloudflare Pages Function — POST /api/mollie-webhook
//
// Mollie roept dit adres aan zodra de betaalstatus van een betaling
// verandert. Wij vragen de actuele status bij Mollie zelf op (nooit de
// binnenkomende data blind vertrouwen), werken de orderstatus bij in D1
// (voor het marketingdashboard) en sturen de bestelling bij een geslaagde
// betaling door naar een Make.com-webhook — hetzelfde bewezen patroon dat
// al voor de WeFact-facturatie wordt gebruikt.
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
//   MOLLIE_API_KEY    — zelfde key als bij /api/order
//   MAKE_WEBHOOK_URL  — webhook-URL van het Make.com-scenario dat de bestelling verwerkt
//   DB                — D1-database binding (optioneel)

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const form = await request.formData();
    const paymentId = form.get("id");

    if (!paymentId) {
      return new Response("Geen payment id ontvangen", { status: 400 });
    }

    if (!env.MOLLIE_API_KEY) {
      console.error("mollie-webhook: MOLLIE_API_KEY ontbreekt");
      return new Response("OK", { status: 200 });
    }

    const res = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });

    if (!res.ok) {
      console.error("mollie-webhook: kon betaling niet ophalen bij Mollie", await res.text());
      return new Response("OK", { status: 200 });
    }

    const payment = await res.json();
    const orderId = payment.metadata && payment.metadata.orderId;

    // Was deze order al eerder als 'paid' verwerkt? Mollie kan de webhook
    // meerdere keren aanroepen — zonder deze check zou een klant bij een
    // dubbele aanroep dubbel zegels krijgen en dubbel de loyaliteitskorting
    // verzilverd zien.
    let wasAlBetaald = false;
    if (env.DB && orderId) {
      try {
        const bestaandeOrder = await env.DB.prepare(`SELECT status FROM orders WHERE order_id = ?`).bind(orderId).first();
        wasAlBetaald = !!(bestaandeOrder && bestaandeOrder.status === "paid");
      } catch (dbErr) {
        console.error("mollie-webhook: kon orderstatus niet vooraf controleren", dbErr);
      }
    }

    if (env.DB && orderId) {
      try {
        await env.DB.prepare(`UPDATE orders SET status = ?, betaald_op = ? WHERE order_id = ?`)
          .bind(payment.status, payment.paidAt || null, orderId)
          .run();
      } catch (dbErr) {
        console.error("mollie-webhook: kon orderstatus niet bijwerken in D1", dbErr);
      }
    }

    // Loyaliteitssysteem afronden — alleen bij een bevestigde betaling, en
    // alleen de allereerste keer dat we deze order als 'paid' zien (zie
    // 'nooit de klant vertrouwen'-filosofie: zegels/korting worden nooit
    // vooraf, alleen na bevestigde betaling, toegekend/verzilverd).
    const loyaltyCode = payment.metadata && payment.metadata.loyaltyCode;
    if (env.DB && payment.status === "paid" && !wasAlBetaald && loyaltyCode) {
      try {
        const account = await env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE code = ?`).bind(loyaltyCode).first();
        if (account) {
          const betaaldBedrag = payment.amount && payment.amount.value ? Number(payment.amount.value) : 0;
          const loyaltyKortingGebruikt = (payment.metadata && Number(payment.metadata.loyaltyKorting)) || 0;

          const uitkomst = berekenZegels({
            restBedragOud: account.rest_bedrag,
            zegelsOud: account.zegels,
            beschikbareKortingOud: account.beschikbare_korting,
            nettoBedrag: betaaldBedrag,
            kortingGebruikt: loyaltyKortingGebruikt,
          });

          const nu = new Date().toISOString();

          await env.DB.prepare(
            `UPDATE loyalty_accounts SET rest_bedrag = ?, zegels = ?, beschikbare_korting = ?, laatst_gebruikt_op = ? WHERE code = ?`
          )
            .bind(uitkomst.restBedragNieuw, uitkomst.zegelsNieuw, uitkomst.beschikbareKortingNieuw, nu, loyaltyCode)
            .run();

          await env.DB.prepare(
            `INSERT INTO loyalty_transacties (code, bedrag, bron, zegels_erbij, korting_erbij, korting_gebruikt, order_id, moment)
             VALUES (?, ?, 'online', ?, ?, ?, ?, ?)`
          )
            .bind(loyaltyCode, betaaldBedrag, uitkomst.zegelsErbij, uitkomst.kortingErbij, loyaltyKortingGebruikt, orderId, nu)
            .run();
        } else {
          console.error("mollie-webhook: onbekende loyaliteitscode bij afronden", loyaltyCode);
        }
      } catch (loyErr) {
        console.error("mollie-webhook: kon loyaliteitssysteem niet bijwerken", loyErr);
      }
    }

    if (payment.status === "paid" && env.MAKE_WEBHOOK_URL) {
      await fetch(env.MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          status: payment.status,
          bedrag: payment.amount,
          levering: payment.metadata && payment.metadata.levering,
          klant: payment.metadata && payment.metadata.customer,
          items: payment.metadata && payment.metadata.items,
          betaaldOp: payment.paidAt,
        }),
      });
    }

    // Mollie verwacht altijd een 200, ook als de status nog niet 'paid' is
    // (bijv. 'open' of 'canceled') — anders blijft Mollie het opnieuw proberen.
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("mollie-webhook fout:", err);
    return new Response("OK", { status: 200 });
  }
}

// Zelfde cumulatieve zegel-logica als in functions/api/loyalty-stempel.js
// (in centen gerekend om afrondingsfouten met floats te voorkomen) —
// bewust hier gedupliceerd in plaats van gedeeld geïmporteerd, zodat elke
// Cloudflare Pages Function op zichzelf staat (zelfde stijl als de
// json()/round2()-helpers elders in dit project).
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
