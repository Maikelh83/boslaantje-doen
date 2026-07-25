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
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als kassa/loyaliteit
// DB — D1-database binding
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

return json({ ok: true });
} catch (err) {
return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
}
}

function json(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: { "Content-Type": "application/json" },
});
}
