// functions/api/loyalty-opzoeken.js
// Cloudflare Pages Function — GET /api/loyalty-opzoeken?code=...&wachtwoord=...
//
// Zoekt een loyaliteitsaccount op aan de hand van de code (gescand of
// handmatig ingevoerd op de personeelspagina). Alleen voor personeel,
// achter een wachtwoord.
//
// Benodigde environment variables:
//   STAFF_LOYALTY_PASSWORD — wachtwoord voor de personeelspagina
//   DB                     — D1-database binding

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const wachtwoord = url.searchParams.get("wachtwoord") || "";
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();

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

    const account = await env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE code = ?`).bind(code).first();
    if (!account) {
      return json({ error: "Onbekende code — nog geen spaarkaart voor dit pasje." }, 404);
    }

    const { results: transacties } = await env.DB.prepare(
      `SELECT bedrag, bron, zegels_erbij, korting_erbij, korting_gebruikt, order_id, moment
       FROM loyalty_transacties WHERE code = ? ORDER BY moment DESC LIMIT 10`
    ).bind(code).all();

    return json({ account, transacties: transacties || [] });
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
