// functions/api/order-status.js
// Cloudflare Pages Function — GET /api/order-status?order=ORDERID
//
// Geeft de actuele status van een bestelling terug voor de live
// orderstatuspagina (bestellen-bedankt.html). Leest ALLEEN uit D1,
// vraagt nooit Mollie rechtstreeks aan — dat doet de webhook al
// (zie mollie-webhook.js), die orders.status bijwerkt zodra Mollie
// een statuswijziging meldt.
//
// orders.status betekent ALTIJD alleen "is dit betaald" (open/paid/
// canceled/expired) — nooit keukenstatus. Keukenstatus komt uit de
// aparte keuken_klaar-tabel (zie keuken-orders.js/keuken-klaar.js),
// en wordt hier pas geraadpleegd zodra een bestelling betaald is.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");

  if (!orderId) {
    return json({ error: "Geen bestelnummer opgegeven" }, 400);
  }
  if (!env.DB) {
    return json({ error: "Database niet beschikbaar" }, 500);
  }

  try {
    const order = await env.DB
      .prepare("SELECT order_id, status, levering, aangemaakt_op FROM orders WHERE order_id = ?")
      .bind(orderId)
      .first();

    if (!order) {
      return json({ error: "Bestelling niet gevonden" }, 404);
    }

    if (order.status !== "paid") {
      // Nog niet (bevestigd) betaald — alleen betaalstatus doorgeven,
      // geen keukenstatus (die is pas relevant na betaling).
      return json({ orderId: order.order_id, status: "wachten_op_betaling" });
    }

    await env.DB
      .prepare("CREATE TABLE IF NOT EXISTS keuken_klaar (order_id TEXT PRIMARY KEY, klaar_op TEXT)")
      .run();

    const klaarRow = await env.DB
      .prepare("SELECT klaar_op FROM keuken_klaar WHERE order_id = ?")
      .bind(orderId)
      .first();

    const status = klaarRow ? "klaar" : "bereiden";

    return json({
      orderId: order.order_id,
      status: status,
      levering: order.levering,
    });
  } catch (err) {
    console.error("order-status fout:", err);
    return json({ error: "Er ging iets mis" }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
