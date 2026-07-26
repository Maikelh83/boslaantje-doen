// functions/api/auth/register.js
// POST /api/auth/register — nieuw account aanmaken (particulier of zakelijk).
//
// Een zakelijk account komt binnen met business_approved = 0
// ("in behandeling") — pas na handmatige goedkeuring in
// /api/admin/zakelijke-klanten.js krijgt de klant toegang tot de
// exclusieve vrijdaglunch-tijdsloten, kortingen en 'op factuur' betalen.
// Inloggen kan een zakelijk account, ook hangende de goedkeuring.

import { zorgVoorAccountTabellen, hashWachtwoord, maakSessie, sessieCookieHeader, json } from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return json({ error: "Database niet beschikbaar." }, 500);
    const body = await request.json();
    const email = (body.email || "").trim().toLowerCase();
    const wachtwoord = body.wachtwoord || "";
    const accountType = body.accountType === "business" ? "business" : "private";
    const naam = (body.naam || "").trim();
    const telefoon = (body.telefoon || "").trim();

    if (!email || !email.includes("@")) return json({ error: "Vul een geldig e-mailadres in." }, 400);
    if (wachtwoord.length < 8) return json({ error: "Wachtwoord moet minimaal 8 tekens zijn." }, 400);
    if (!naam) return json({ error: "Vul je naam in." }, 400);

    let business = null;
    if (accountType === "business") {
      business = body.business || {};
      if (!business.bedrijfsnaam || !business.bedrijfsnaam.trim()) {
        return json({ error: "Vul een bedrijfsnaam in." }, 400);
      }
    }

    await zorgVoorAccountTabellen(env.DB);

    const bestaat = await env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`).bind(email).first();
    if (bestaat) return json({ error: "Er bestaat al een account met dit e-mailadres." }, 409);

    const { hash, salt } = await hashWachtwoord(wachtwoord);
    const accountId = crypto.randomUUID();
    const nu = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO accounts (id, email, wachtwoord_hash, wachtwoord_salt, account_type, naam, telefoon, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(accountId, email, hash, salt, accountType, naam, telefoon, nu).run();

    if (accountType === "business") {
      await env.DB.prepare(
        `INSERT INTO business_profiles (account_id, bedrijfsnaam, kvk_nummer, btw_nummer, afdeling, factuur_email, business_approved, factuur_toegestaan, custom_discount_percentage, override_minimum_invoice_amount, enable_monthly_consolidated_invoice, aangevraagd_op)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?)`
      ).bind(
        accountId,
        business.bedrijfsnaam.trim(),
        (business.kvkNummer || "").trim(),
        (business.btwNummer || "").trim(),
        (business.afdeling || "").trim(),
        (business.factuurEmail || "").trim() || email,
        nu
      ).run();
    }

    const { sessionId, verloopt } = await maakSessie(env.DB, accountId);

    return json(
      { ok: true, accountType, inBehandeling: accountType === "business" },
      200,
      { "Set-Cookie": sessieCookieHeader(sessionId, verloopt) }
    );
  } catch (err) {
    console.error("auth/register fout:", err);
    return json({ error: "Er ging iets mis bij het registreren." }, 500);
  }
}
