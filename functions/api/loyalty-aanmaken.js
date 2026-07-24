// functions/api/loyalty-aanmaken.js
// Cloudflare Pages Function — POST /api/loyalty-aanmaken
//
// Maakt een nieuwe loyaliteitsaccount (spaarkaart) aan. Alleen voor
// personeel, achter een wachtwoord — zie src/kassa-loyaliteit.html.
// De teruggegeven 'code' is tegelijk het pasjesnummer én de QR-inhoud
// (net als de AH Bonuskaart): geen apart online account nodig.
//
// Twee manieren om een code te krijgen:
//   1. Geen 'bestaandeCode' meegestuurd  -> we genereren zelf een nieuwe,
//      unieke code (voor als de klant geen fysiek pasje heeft en de QR
//      op het scherm gebruikt of een los geprint kaartje krijgt).
//   2. Wel 'bestaandeCode' meegestuurd   -> dit is de waarde die van een
//      al bestaand, nog niet gebruikt fysiek pasje (bv. de oude
//      onbeschreven voorraad in onze eigen huisstijl) is gescand. We
//      controleren alleen of hij nog niet in gebruik is en gebruiken 'm
//      1-op-1 als primaire sleutel — het maakt niet uit wat er precies
//      in die QR staat (kort nummer, lange code, url), zolang hij uniek is.
//
// Benodigde environment variables:
//   STAFF_LOYALTY_PASSWORD — wachtwoord voor de personeelspagina
//   DB                     — D1-database binding
//
// Body: { wachtwoord, naam?, telefoon?, email?, bestaandeCode? }
// Antwoord: { code, viaBestaandPasje }

const CODE_ALFABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // zonder 0/O/1/I/L — voorkomt leesfouten op een gedrukt pasje

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { wachtwoord, naam, telefoon, email, bestaandeCode } = body || {};

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
    let code = null;
    let viaBestaandPasje = false;

    if (bestaandeCode && String(bestaandeCode).trim()) {
      const kandidaat = String(bestaandeCode).trim();
      const bestaat = await env.DB.prepare(`SELECT 1 FROM loyalty_accounts WHERE code = ?`).bind(kandidaat).all();
      if (bestaat.results && bestaat.results.length > 0) {
        return json({ error: "Dit pasje is al gekoppeld aan een spaarkaart." }, 409);
      }
      code = kandidaat;
      viaBestaandPasje = true;
    } else {
      // Genereer een unieke code; bij een (zeldzame) botsing gewoon opnieuw proberen.
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
    }

    await env.DB.prepare(
      `INSERT INTO loyalty_accounts (code, naam, telefoon, email, rest_bedrag, zegels, beschikbare_korting, aangemaakt_op)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)`
    )
      .bind(code, naam || null, telefoon || null, email || null, nu)
      .run();

    return json({ code, viaBestaandPasje });
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
