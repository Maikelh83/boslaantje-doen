// functions/api/keuken-klaar.js
// Cloudflare Pages Function — POST /api/keuken-klaar
//
// Markeert één bestelling als klaargemaakt vanuit het keukenscherm
// (src/kassa-keuken.html). Schrijft NOOIT naar de 'orders'-tabel zelf
// (die 'status'-kolom blijft gereserveerd voor "betaald ja/nee", zie
// keuken-orders.js) — in plaats daarvan een regel in de aparte
// 'keuken_klaar'-tabel, die keuken-orders.js gebruikt om afgehandelde
// bestellingen uit te sluiten.
//
// Thuisbezorgd-koppeling (spec-onderdeel C, statusupdate): als de order
// bron = 'thuisbezorgd' heeft én er is een extern_order_id + een
// geconfigureerde THUISBEZORGD_STATUS_WEBHOOK_URL, proberen we een
// statusupdate 'afgerond' naar die URL te sturen op het moment dat de
// keuken de bestelling klaarmeldt. LET OP: dit KDS kent geen aparte
// 'onderweg'-tussenstatus (er is geen eigen bezorgers-tracking) — de enige
// statusovergang die hier écht bestaat is "klaargemeld door de keuken",
// dus dat is het enige moment waarop we iets terugsturen. Als er ooit een
// losstaande 'onderweg'-stap nodig is (bijv. bij eigen bezorging), is dat
// een aparte feature, niet iets wat we hier stilzwijgend bijbouwen. Dit
// hele blok faalt bewust stil: een niet-bereikbare of nog niet bestaande
// koppeling mag de 'klaar'-actie voor het personeel nooit blokkeren.
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als kassa/loyaliteit
// DB — D1-database binding
// THUISBEZORGD_STATUS_WEBHOOK_URL — optioneel; ontvangt { externOrderId, status: 'afgerond', tijdstip }
//
// Body: { wachtwoord, orderId }

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { wachtwoord, orderId } = body || {};

    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!orderId || typeof orderId !== "string") {
      return json({ error: "Geen geldig ordernummer meegestuurd." }, 400);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS keuken_klaar (order_id TEXT PRIMARY KEY, klaar_op TEXT)`).run();

    await env.DB.prepare(`INSERT OR IGNORE INTO keuken_klaar (order_id, klaar_op) VALUES (?, ?)`)
      .bind(orderId, new Date().toISOString())
      .run();

    await stuurThuisbezorgdStatusUpdateIndienNodig(env, orderId);

    return json({ ok: true });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

async function stuurThuisbezorgdStatusUpdateIndienNodig(env, orderId) {
  try {
    if (!env.THUISBEZORGD_STATUS_WEBHOOK_URL || !env.DB) return;

    const order = await env.DB.prepare(`SELECT bron, extern_order_id FROM orders WHERE order_id = ?`)
      .bind(orderId)
      .first();
    if (!order || order.bron !== "thuisbezorgd" || !order.extern_order_id) return;

    await fetch(env.THUISBEZORGD_STATUS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externOrderId: order.extern_order_id,
        status: "afgerond",
        tijdstip: new Date().toISOString(),
      }),
    });
  } catch (webhookErr) {
    console.error("keuken-klaar: kon Thuisbezorgd-statusupdate niet versturen", webhookErr);
    // De 'klaar'-actie zelf is al veiliggesteld — dit mag daar nooit op stuklopen.
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
