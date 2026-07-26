// functions/api/integrations/thuisbezorgd.js
// Cloudflare Pages Function — POST /api/integrations/thuisbezorgd
//
// LET OP — dit is een FUNDAMENT, geen kant-en-klare koppeling: er is op
// het moment van bouwen nog geen partner-/API-toegang bij Thuisbezorgd
// (Just Eat Takeaway) of een middleware zoals Deliverect/HubRise. Het
// exacte payload-formaat en de authenticatiemethode van zo'n partij zijn
// daardoor nog niet bekend. Deze functie definieert daarom een eigen,
// eenvoudig JSON-formaat (zie hieronder) waar we zelf tegen kunnen testen.
// Zodra er echte API-/middleware-toegang is, moet de payload-mapping
// hieronder aangepast worden aan het echte formaat — de rest (D1-opslag,
// keukenscherm-koppeling, idempotentie) blijft dan hetzelfde.
//
// Ontvangt een inkomende bestelling en slaat 'm op in dezelfde 'orders'-
// tabel die ook door /api/order (webshop) en /api/kassa-order (balie)
// gebruikt wordt, met bron = 'thuisbezorgd'. Het keukenscherm
// (src/kassa-keuken.html) pikt 'm dan automatisch op via de bestaande
// polling op /api/keuken-orders — er is geen aparte KDS-koppeling nodig.
//
// Beveiliging: omdat we niet weten welke authenticatiemethode de
// uiteindelijke partij (Thuisbezorgd/Deliverect/HubRise) gebruikt, is hier
// gekozen voor een simpel gedeeld geheim in een custom header
// (X-Webhook-Secret). Dit moet mogelijk vervangen worden zodra bekend is
// hoe de echte partij webhooks ondertekent/autoriseert.
//
// Belangrijk verschil met /api/order en /api/kassa-order: daar wordt de
// prijs ALTIJD server-side herberekend uit producten.json ("nooit de
// klant vertrouwen"). Dat kan hier niet — Thuisbezorgd-menu-items hebben
// geen 1-op-1 koppeling met onze eigen product-id's, en de betaling is al
// buiten ons systeem om afgerond. We vertrouwen daarom noodgedwongen het
// totaalbedrag dat de afzender meestuurt, en controleren alleen dat de
// itemregels intern kloppen (som van subtotalen ≈ totaal).
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
// THUISBEZORGD_WEBHOOK_SECRET — zelf te kiezen geheime waarde; moet exact
//                                overeenkomen met de X-Webhook-Secret header
// DB — D1-database binding
// THUISBEZORGD_STATUS_WEBHOOK_URL — optioneel, zie functions/api/keuken-klaar.js
//
// Verwachte body (eigen formaat, zie toelichting hierboven):
// {
//   "externOrderId": "JET-123456",              // verplicht: ordernummer van de bezorgplatform-kant, voor idempotentie
//   "levering": "bezorgen" | "afhalen",           // optioneel, default 'bezorgen'
//   "klant": { "naam": "...", "telefoon": "...", "email": "...", "adres": "...", "postcode": "...", "plaats": "..." },
//   "items": [ { "naam": "Frikandel speciaal", "aantal": 2, "prijs": 3.25, "opmerking": "extra saus" } ],
//   "totaal": 12.50,
//   "opmerkingen": "Graag aanbellen, niet op de deur kloppen"
// }
// Antwoord: { ok: true, orderId, externOrderId, duplicate?: true }

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.THUISBEZORGD_WEBHOOK_SECRET) {
      return json(
        { error: "Thuisbezorgd-koppeling is nog niet ingesteld (THUISBEZORGD_WEBHOOK_SECRET ontbreekt)." },
        500
      );
    }
    const meegestuurdGeheim = request.headers.get("X-Webhook-Secret") || "";
    if (!constantTimeGelijk(meegestuurdGeheim, env.THUISBEZORGD_WEBHOOK_SECRET)) {
      return json({ error: "Onjuist of ontbrekend webhook-geheim." }, 401);
    }
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ error: "Ongeldige of ontbrekende JSON-body." }, 400);
    }

    const { externOrderId, levering, klant, items, totaal, opmerkingen } = body;

    if (!externOrderId || typeof externOrderId !== "string") {
      return json({ error: "externOrderId is verplicht (ordernummer van de bezorgplatform-kant)." }, 400);
    }
    if (!klant || !klant.naam || !klant.telefoon) {
      return json({ error: "klant.naam en klant.telefoon zijn verplicht." }, 400);
    }
    const leveringType = levering === "afhalen" ? "afhalen" : "bezorgen";
    if (leveringType === "bezorgen" && (!klant.adres || !klant.postcode || !klant.plaats)) {
      return json({ error: "klant.adres, klant.postcode en klant.plaats zijn verplicht bij bezorgen." }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: "items is verplicht en mag niet leeg zijn." }, 400);
    }
    const totaalNum = Number(totaal);
    if (!Number.isFinite(totaalNum) || totaalNum <= 0) {
      return json({ error: "totaal is verplicht en moet een positief bedrag zijn." }, 400);
    }

    const orderRegels = [];
    let somSubtotalen = 0;
    for (const regel of items) {
      const naam = String(regel.naam || "").trim();
      const prijs = Number(regel.prijs);
      const aantal = Math.max(1, Math.min(50, parseInt(regel.aantal, 10) || 1));
      if (!naam || !Number.isFinite(prijs) || prijs < 0) {
        return json({ error: `Ongeldige itemregel: ${JSON.stringify(regel)}` }, 400);
      }
      const subtotaal = Math.round(prijs * aantal * 100) / 100;
      somSubtotalen = Math.round((somSubtotalen + subtotaal) * 100) / 100;
      orderRegels.push({
        id: null,
        naam,
        prijs,
        extras: regel.opmerking ? String(regel.opmerking) : "",
        aantal,
        subtotaal,
      });
    }
    // Toelaatbare marge voor bijv. bezorgkosten/verpakkingskosten die de
    // platform in het totaal verwerkt maar niet als aparte itemregel stuurt.
    if (Math.abs(somSubtotalen - totaalNum) > Math.max(2, totaalNum * 0.15)) {
      return json(
        {
          error: `Som van itemregels (${somSubtotalen.toFixed(2)}) wijkt te veel af van totaal (${totaalNum.toFixed(2)}).`,
        },
        400
      );
    }

    await zorgVoorThuisbezorgdKolommen(env.DB);

    // Idempotentie: webhooks van bezorgplatforms kunnen (bij een timeout of
    // retry) meerdere keren dezelfde order versturen. We slaan 'm dan niet
    // nogmaals op, maar geven het bestaande interne orderId terug.
    const bestaande = await env.DB.prepare(
      `SELECT order_id FROM orders WHERE bron = 'thuisbezorgd' AND extern_order_id = ?`
    )
      .bind(externOrderId)
      .first();
    if (bestaande) {
      return json({ ok: true, orderId: bestaande.order_id, externOrderId, duplicate: true });
    }

    const orderId = "TB-" + Date.now().toString(36).toUpperCase();
    const nu = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO orders (order_id, status, totaal, korting, coupon_code, klant_email, klant_telefoon, levering, items_json, acties_json, aangemaakt_op, betaald_op, loyalty_code, loyalty_korting_gebruikt, bron, opmerkingen, extern_order_id)
       VALUES (?, 'paid', ?, 0, NULL, ?, ?, ?, ?, '[]', ?, ?, NULL, 0, 'thuisbezorgd', ?, ?)`
    )
      .bind(
        orderId,
        totaalNum,
        klant.email || null,
        klant.telefoon || null,
        leveringType,
        JSON.stringify(orderRegels),
        nu,
        nu,
        opmerkingen || null,
        externOrderId
      )
      .run();

    return json({ ok: true, orderId, externOrderId }, 201);
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

// Eenvoudige health-check zodat een platform-configuratiescherm dat bij het
// koppelen een GET-verzoek doet niet standaard een 404 terugkrijgt. Bevat
// bewust geen gevoelige informatie.
export async function onRequestGet() {
  return json({ ok: true, endpoint: "thuisbezorgd-webhook", methode: "POST" });
}

// Additieve migratie voor de bestaande 'orders'-tabel — zelfde stijl als
// zorgVoorAccountTabellen in functions/api/auth/_lib.js: ALTER TABLE ...
// ADD COLUMN gooit een fout als de kolom al bestaat, die vangen we stil af
// als teken dat de migratie al eerder is uitgevoerd. Bewust hier
// gedupliceerd (net als in keuken-orders.js/keuken-klaar.js) — elke
// Cloudflare Pages Function in dit project staat op zichzelf.
async function zorgVoorThuisbezorgdKolommen(db) {
  for (const migratie of [
    "ALTER TABLE orders ADD COLUMN bron TEXT",
    "ALTER TABLE orders ADD COLUMN opmerkingen TEXT",
    "ALTER TABLE orders ADD COLUMN extern_order_id TEXT",
  ]) {
    try {
      await db.prepare(migratie).run();
    } catch (migratieErr) {
      // kolom bestaat waarschijnlijk al - genegeerd
    }
  }
}

function constantTimeGelijk(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let verschil = 0;
  for (let i = 0; i < a.length; i++) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return verschil === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
