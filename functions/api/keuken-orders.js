// functions/api/keuken-orders.js
// Cloudflare Pages Function — GET /api/keuken-orders?wachtwoord=...
//
// Levert de actieve (nog niet klaargemaakte) bestellingen voor het
// keukenscherm (src/kassa-keuken.html). Dit is de digitale werkbon die
// tot nu toe ontbrak: een afgerekende kassa-order of een betaalde
// online bestelling kwam alleen in de database terecht, zonder dat de
// keuken er iets van te zien kreeg.
//
// We wijzigen NOOIT de 'status'-kolom van de order zelf om een order als
// "klaar" te markeren — die kolom betekent voor het marketingdashboard
// (dashboard-data.js) "is dit betaald", en dat moet zo blijven ook nadat
// de keuken 'm heeft klaargemaakt. In plaats daarvan gebruiken we een
// aparte tabel 'keuken_klaar' (order_id, klaar_op) die we hier zelf
// aanmaken als hij nog niet bestaat — geen handmatige migratie nodig.
//
// We laten bewust alleen bestellingen van de laatste paar uur zien
// (KEUKEN_UUR_VENSTER), zodat het scherm bij de eerste ingebruikname niet
// ineens gevuld is met oude, allang afgehandelde bestellingen.
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als kassa/loyaliteit
// DB — D1-database binding

const KEUKEN_UUR_VENSTER = 8;

export async function onRequestGet(context) {
const { request, env } = context;

try {
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

await zorgVoorKeukenKlaarTabel(env.DB);

const { results } = await env.DB.prepare(
`SELECT order_id, totaal, levering, items_json, aangemaakt_op, klant_telefoon
FROM orders
WHERE status = 'paid'
AND aangemaakt_op >= datetime('now', ?)
AND order_id NOT IN (SELECT order_id FROM keuken_klaar)
ORDER BY aangemaakt_op ASC`
)
.bind(`-${KEUKEN_UUR_VENSTER} hours`)
.all();

const orders = (results || []).map((o) => {
let items = [];
try {
items = JSON.parse(o.items_json || "[]");
} catch (e) {
items = [];
}
return {
orderId: o.order_id,
ticket: o.order_id.slice(-5).toUpperCase(),
totaal: o.totaal,
levering: o.levering || "kassa",
aangemaaktOp: o.aangemaakt_op,
klantTelefoon: o.klant_telefoon || null,
items,
};
});

return json({ orders });
} catch (err) {
return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
}
}

async function zorgVoorKeukenKlaarTabel(db) {
await db
.prepare(`CREATE TABLE IF NOT EXISTS keuken_klaar (order_id TEXT PRIMARY KEY, klaar_op TEXT)`)
.run();
}

function json(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: { "Content-Type": "application/json" },
});
}
