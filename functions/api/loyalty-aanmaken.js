// functions/api/loyalty-aanmaken.js
// Cloudflare Pages Function — POST /api/loyalty-aanmaken
//
// Maakt een nieuwe loyaliteitsaccount (spaarkaart) aan. Alleen voor
// personeel, achter een wachtwoord — zie src/kassa-loyaliteit.html.
// De teruggegeven 'code' is tegelijk het pasjesnummer én de QR-inhoud
// (net als de AH Bonuskaart): geen apart online account nodig.
//
// Benodigde environment variables:
//   STAFF_LOYALTY_PASSWORD — wachtwoord voor de personeelspagina
//   DB                     — D1-database binding
//
// Body: { wachtwoord, naam?, telefoon?, email? }
// Antwoord: { code }

const CODE_ALFABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // zonder 0/O/1/I/L — voorkomt leesfouten op een gedrukt pasje

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { wachtwoord, naam, telefoon, email } = body || {};

    if (!env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Personeelspagina is nog niet ingesteld (STAFF_LOYALTY_PASSWORD ontbreekt)." }, 500);
    }
    if (wachtwoord !== env.STAFF_LOYALTY_PASSWORD) {
      return json({ error: "Onjuist wachtwoord." }, 401);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    const nu = new Date().toISOString();

    // Genereer een unieke code; bij een (zeldzame) botsing gewoon opnieuw proberen.
    let code = null;
    for (let poging = 0; poging < 10 && !code; poging++) {
      const kandidaat = genereerCode();
      const bestaat = await env.DB.prepare(`SELECT 1 FROM loyalty_accounts WHERE code = ?`).bind(kandidaat).all();
      if (!bestaat.results || bestaat.results.length === 0) {
        code = kandidaat;
      }
    }
    if (!code) {
      return json({ error: "Kon geen unieke code genereren, probeer het nogmaals." }, 500);
    }

    await env.DB.prepare(
      `INSERT INTO loyalty_accounts (code, naam, telefoon, email, rest_bedrag, zegels, beschikbare_korting, aangemaakt_op)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)`
    )
      .bind(code, naam || null, telefoon || null, email || null, nu)
      .run();

    return json({ code });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

function genereerCode() {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CODE_ALFABET[Math.floor(Math.random() * CODE_ALFABET.length)];
  }
  return code;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
