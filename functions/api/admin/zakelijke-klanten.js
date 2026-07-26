// functions/api/admin/zakelijke-klanten.js
// Cloudflare Pages Function â beheer van zakelijke accounts (pijler 7).
//
// GET  /api/admin/zakelijke-klanten?wachtwoord=...
//   Geeft een lijst van alle zakelijke accounts + hun business_profiles-rij
//   terug, plus de huidige waarde van 'minimum_factuurbedrag' (instellingen).
//
// POST /api/admin/zakelijke-klanten?wachtwoord=...
//   Body (JSON), twee soorten acties:
//   1) Account bijwerken:
//      { accountId, businessApproved?, factuurToegestaan?,
//        customDiscountPercentage?, overrideMinimumInvoiceAmount?,
//        enableMonthlyConsolidatedInvoice? }
//      Alleen de meegegeven velden worden bijgewerkt. Bij het voor het
//      eerst goedkeuren (businessApproved: true) wordt 'goedgekeurd_op'
//      gezet.
//   2) Instelling bijwerken:
//      { instelling: 'minimum_factuurbedrag', waarde: '75' }
//
// Gebruikt hetzelfde personeelswachtwoord (STAFF_LOYALTY_PASSWORD) als
// kassa/keuken/loyaliteit â geen apart admin-wachtwoord nodig.

import { zorgVoorAccountTabellen, json } from "../auth/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);

    const { results } = await env.DB.prepare(
      `SELECT a.id, a.email, a.naam, a.telefoon, a.aangemaakt_op,
              b.bedrijfsnaam, b.kvk_nummer, b.btw_nummer, b.afdeling, b.factuur_email,
              b.business_approved, b.factuur_toegestaan, b.custom_discount_percentage,
              b.override_minimum_invoice_amount, b.enable_monthly_consolidated_invoice,
              b.aangevraagd_op, b.goedgekeurd_op
       FROM accounts a
       JOIN business_profiles b ON b.account_id = a.id
       WHERE a.account_type = 'business'
       ORDER BY b.aangevraagd_op DESC`
    ).all();

    const klanten = (results || []).map((r) => ({
      accountId: r.id,
      email: r.email,
      naam: r.naam,
      telefoon: r.telefoon,
      aangemaaktOp: r.aangemaakt_op,
      bedrijfsnaam: r.bedrijfsnaam,
      kvkNummer: r.kvk_nummer,
      btwNummer: r.btw_nummer,
      afdeling: r.afdeling,
      factuurEmail: r.factuur_email,
      businessApproved: !!r.business_approved,
      factuurToegestaan: !!r.factuur_toegestaan,
      customDiscountPercentage: r.custom_discount_percentage,
      overrideMinimumInvoiceAmount: !!r.override_minimum_invoice_amount,
      enableMonthlyConsolidatedInvoice: !!r.enable_monthly_consolidated_invoice,
      aangevraagdOp: r.aangevraagd_op,
      goedgekeurdOp: r.goedgekeurd_op,
    }));

    const instellingRow = await env.DB.prepare(
      `SELECT waarde FROM instellingen WHERE sleutel = 'minimum_factuurbedrag'`
    ).first();

    return json({
      klanten,
      minimumFactuurbedrag: instellingRow ? Number(instellingRow.waarde) : 50,
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const controleFout = controleerToegang(request, env);
    if (controleFout) return controleFout;

    await zorgVoorAccountTabellen(env.DB);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Ongeldige of ontbrekende JSON-body." }, 400);
    }

    // Actie 1: instelling bijwerken (bv. het factuurdrempelbedrag)
    if (body.instelling) {
      if (body.instelling !== "minimum_factuurbedrag") {
        return json({ error: "Onbekende instelling." }, 400);
      }
      const waarde = String(body.waarde ?? "").trim();
      if (!waarde || isNaN(Number(waarde))) {
        return json({ error: "Waarde moet een getal zijn." }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO instellingen (sleutel, waarde) VALUES ('minimum_factuurbedrag', ?)
         ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde`
      )
        .bind(waarde)
        .run();
      return json({ ok: true, minimumFactuurbedrag: Number(waarde) });
    }

    // Actie 2: zakelijk account bijwerken
    const accountId = body.accountId;
    if (!accountId) {
      return json({ error: "accountId is verplicht." }, 400);
    }

    const bestaand = await env.DB.prepare(
      `SELECT * FROM business_profiles WHERE account_id = ?`
    )
      .bind(accountId)
      .first();
    if (!bestaand) {
      return json({ error: "Zakelijk profiel niet gevonden." }, 404);
    }

    const velden = [];
    const waarden = [];

    if (typeof body.businessApproved === "boolean") {
      velden.push("business_approved = ?");
      waarden.push(body.businessApproved ? 1 : 0);
      if (body.businessApproved && !bestaand.goedgekeurd_op) {
        velden.push("goedgekeurd_op = ?");
        waarden.push(new Date().toISOString());
      }
    }
    if (typeof body.factuurToegestaan === "boolean") {
      velden.push("factuur_toegestaan = ?");
      waarden.push(body.factuurToegestaan ? 1 : 0);
    }
    if (typeof body.customDiscountPercentage === "number") {
      if (body.customDiscountPercentage < 0 || body.customDiscountPercentage > 100) {
        return json({ error: "customDiscountPercentage moet tussen 0 en 100 liggen." }, 400);
      }
      velden.push("custom_discount_percentage = ?");
      waarden.push(body.customDiscountPercentage);
    }
    if (typeof body.overrideMinimumInvoiceAmount === "boolean") {
      velden.push("override_minimum_invoice_amount = ?");
      waarden.push(body.overrideMinimumInvoiceAmount ? 1 : 0);
    }
    if (typeof body.enableMonthlyConsolidatedInvoice === "boolean") {
      velden.push("enable_monthly_consolidated_invoice = ?");
      waarden.push(body.enableMonthlyConsolidatedInvoice ? 1 : 0);
    }

    if (velden.length === 0) {
      return json({ error: "Geen geldige velden om bij te werken." }, 400);
    }

    waarden.push(accountId);
    await env.DB.prepare(
      `UPDATE business_profiles SET ${velden.join(", ")} WHERE account_id = ?`
    )
      .bind(...waarden)
      .run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

function controleerToegang(request, env) {
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
  return null;
}
