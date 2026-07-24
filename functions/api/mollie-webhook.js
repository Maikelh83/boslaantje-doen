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

    if (env.DB && orderId) {
      try {
        await env.DB.prepare(`UPDATE orders SET status = ?, betaald_op = ? WHERE order_id = ?`)
          .bind(payment.status, payment.paidAt || null, orderId)
          .run();
      } catch (dbErr) {
        console.error("mollie-webhook: kon orderstatus niet bijwerken in D1", dbErr);
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
