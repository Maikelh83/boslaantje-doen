// functions/api/integrations/uitverkocht.js
// Cloudflare Pages Function — GET/POST /api/integrations/uitverkocht
//
// LET OP — dit is de interne helft van de 86-status-sync (spec-onderdeel
// C). Er is geen Thuisbezorgd-/middleware-API-toegang om deze lijst
// automatisch NAAR Thuisbezorgd te pushen (dat vereist een account bij
// Just Eat Takeaway of Deliverect/HubRise dat er nu nog niet is). Wat hier
// wél staat: een eigen bron van waarheid voor "welke producten zijn
// uitverkocht", die klaarstaat om aan zo'n koppeling te voeren zodra die
// er is. Er is in deze iteratie BEWUST geen knop in kassa.html/
// kassa-keuken.html toegevoegd om dit aan/uit te zetten — dat is een losse
// vervolgstap (personeel heeft nu nog geen UI om dit te bedienen, alleen
// deze API bestaat al).
//
// GET  — publiek, ongeauthenticeerd (net als /producten.json): levert de
//        lijst product-id's die nu uitverkocht zijn. Bevat geen
//        gevoelige gegevens, dus geen wachtwoord nodig.
// POST — alleen voor personeel (zelfde wachtwoord als kassa/keuken):
//        zet een product op uitverkocht/weer beschikbaar.
//
// Benodigde environment variables:
// STAFF_LOYALTY_PASSWORD — zelfde personeelswachtwoord als kassa/keuken (alleen voor POST)
// DB — D1-database binding

export async function onRequestGet(context) {
  const { env } = context;
  try {
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }
    await zorgVoorProduct86Tabel(env.DB);

    const { results } = await env.DB.prepare(
      `SELECT product_id, gezet_op FROM product_86 WHERE uitverkocht = 1`
    ).all();

    return json({
      uitverkocht: (results || []).map((r) => r.product_id),
      bijgewerktOp: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    const body = await request.json().catch(() => null);
    const { wachtwoord, productId, uitverkocht } = body || {};

    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!productId || typeof productId !== "string") {
      return json({ error: "Geen geldig productId meegestuurd." }, 400);
    }

    await zorgVoorProduct86Tabel(env.DB);
    const nu = new Date().toISOString();

    if (uitverkocht) {
      await env.DB.prepare(
        `INSERT INTO product_86 (product_id, uitverkocht, gezet_op) VALUES (?, 1, ?)
         ON CONFLICT(product_id) DO UPDATE SET uitverkocht = 1, gezet_op = excluded.gezet_op`
      )
        .bind(productId, nu)
        .run();
    } else {
      await env.DB.prepare(`DELETE FROM product_86 WHERE product_id = ?`).bind(productId).run();
    }

    return json({ ok: true, productId, uitverkocht: !!uitverkocht });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

async function zorgVoorProduct86Tabel(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS product_86 (product_id TEXT PRIMARY KEY, uitverkocht INTEGER NOT NULL DEFAULT 1, gezet_op TEXT)`
    )
    .run();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
