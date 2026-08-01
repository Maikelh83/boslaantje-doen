// functions/api/integrations/personeelsportaal.js
// Cloudflare Pages Function — POST /api/integrations/personeelsportaal
//
// Ontvangt een aanroep vanuit het personeelsportaal (het losse Next.js/
// Supabase-project op Vercel, waar nieuwe medewerkers hun contract en
// loonheffingsformulier ondertekenen) zodra een medewerker klaar is met de
// hele onboarding. Maakt dan automatisch een account aan in de
// personeelsnummer+pincode-tabel (medewerkers) van dit project, zodat de
// medewerker meteen ook toegang heeft tot de planningsapp
// (personeel-rooster.html) — zonder dat iemand dit met de hand hoeft over
// te typen.
//
// Beveiliging: gedeeld geheim in een custom header (X-Webhook-Secret),
// zelfde patroon als functions/api/integrations/thuisbezorgd.js. Dit is
// een server-naar-server-aanroep (Vercel → Cloudflare), geen wachtwoord
// van een mens, dus bewust een ander geheim dan STAFF_LOYALTY_PASSWORD.
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
// PERSONEELSPORTAAL_WEBHOOK_SECRET — zelf te kiezen geheime waarde; moet
//                                     exact overeenkomen met de
//                                     X-Webhook-Secret header die het
//                                     personeelsportaal meestuurt
// DB — D1-database binding
//
// Verwachte body:
// { "naam": "Jan Jansen", "externId": "e4f3...-uuid-van-personeelsportaal" }
// - naam: verplicht, volledige naam voor de medewerkers-tabel
// - externId: verplicht, het interne medewerker-id van het personeelsportaal
//   zelf — gebruikt om te herkennen of deze medewerker al eerder is
//   aangemaakt (idempotentie bij een dubbele aanroep/retry), niet om iets
//   inhoudelijks te doen. Wordt opgeslagen in de nieuwe kolom bron_id.
//
// Antwoord bij succes: { ok: true, personeelsnummer, pincode }
// - pincode wordt hier ÉÉN keer in platte tekst teruggegeven, zodat het
//   personeelsportaal 'm direct kan mailen naar de medewerker. Er wordt
//   alleen de hash+salt van opgeslagen (zie hashWachtwoord in _lib.js) —
//   na dit ene antwoord is de platte pincode nergens meer terug te vinden,
//   ook niet door ons.
// Antwoord als externId al bekend is: { ok: true, alreadyExists: true, personeelsnummer }
//   (geen pincode — die kunnen we niet opnieuw tonen zonder 'm te resetten,
//   en dat doen we hier niet ongevraagd)

import { zorgVoorPersoneelTabel, hashWachtwoord, json } from "../auth/_lib.js";

function constantTimeGelijk(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let verschil = 0;
  for (let i = 0; i < a.length; i++) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return verschil === 0;
}

// Additieve migratie: bron_id herkent welke medewerkers via het
// personeelsportaal zijn aangemaakt (voor idempotentie), los van het
// personeelsnummer zelf (dat blijft het echte, door de gebruiker zichtbare
// nummer). Meerdere NULLs botsen niet in een UNIQUE index — zelfde patroon
// als nfc_tag_id in zorgVoorPersoneelTabel (functions/api/auth/_lib.js).
async function zorgVoorBronIdKolom(db) {
  try {
    await db.prepare(`ALTER TABLE medewerkers ADD COLUMN bron_id TEXT`).run();
  } catch (migratieErr) {
    // Kolom bestaat al — genegeerd, net als de rest van de additieve migraties.
  }
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_medewerkers_bron_id ON medewerkers(bron_id)`).run();
  } catch (indexErr) {
    // Index bestaat al — genegeerd.
  }
}

function genereerPincode() {
  // 4 cijfers, met voorloopnullen (bv. "0417") — zelfde formaat als een
  // handmatig ingevoerde pincode via kassa-personeel.html.
  const nummer = Math.floor(Math.random() * 10000);
  return String(nummer).padStart(4, "0");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.PERSONEELSPORTAAL_WEBHOOK_SECRET) {
      return json(
        { error: "Koppeling met personeelsportaal is nog niet ingesteld (PERSONEELSPORTAAL_WEBHOOK_SECRET ontbreekt)." },
        500
      );
    }
    const meegestuurdGeheim = request.headers.get("X-Webhook-Secret") || "";
    if (!constantTimeGelijk(meegestuurdGeheim, env.PERSONEELSPORTAAL_WEBHOOK_SECRET)) {
      return json({ error: "Onjuist of ontbrekend webhook-geheim." }, 401);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Ongeldige of ontbrekende JSON-body." }, 400);

    const naam = String(body.naam || "").trim();
    const externId = String(body.externId || "").trim();
    if (!naam) return json({ error: "naam is verplicht." }, 400);
    if (!externId) return json({ error: "externId is verplicht." }, 400);

    await zorgVoorPersoneelTabel(env.DB);
    await zorgVoorBronIdKolom(env.DB);

    // Idempotentie: als deze medewerker al eens via het personeelsportaal is
    // aangemaakt, geen tweede account aanmaken — gewoon het bestaande
    // personeelsnummer teruggeven.
    const bestaand = await env.DB.prepare(
      `SELECT personeelsnummer FROM medewerkers WHERE bron_id = ?`
    ).bind(externId).first();
    if (bestaand) {
      return json({ ok: true, alreadyExists: true, personeelsnummer: bestaand.personeelsnummer });
    }

    // Volgende personeelsnummer automatisch bepalen: hoogste bestaande
    // numerieke waarde + 1 (niet-numerieke/legacy nummers worden genegeerd
    // bij het bepalen van het maximum, maar blijven verder gewoon bestaan).
    const { results } = await env.DB.prepare(`SELECT personeelsnummer FROM medewerkers`).all();
    let hoogste = 0;
    for (const rij of results || []) {
      const getal = parseInt(rij.personeelsnummer, 10);
      if (Number.isFinite(getal) && getal > hoogste) hoogste = getal;
    }
    const personeelsnummer = String(hoogste + 1);

    const pincode = genereerPincode();
    const { hash, salt } = await hashWachtwoord(pincode);

    await env.DB.prepare(
      `INSERT INTO medewerkers (personeelsnummer, naam, pincode_hash, pincode_salt, actief, aangemaakt_op, bron_id)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).bind(personeelsnummer, naam, hash, salt, new Date().toISOString(), externId).run();

    return json({ ok: true, personeelsnummer, pincode });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
