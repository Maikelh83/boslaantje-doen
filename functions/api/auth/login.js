// functions/api/auth/login.js
// POST /api/auth/login — inloggen met e-mail + wachtwoord.

import { zorgVoorAccountTabellen, wachtwoordKlopt, maakSessie, sessieCookieHeader, json } from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return json({ error: "Database niet beschikbaar." }, 500);
    const body = await request.json();
    const email = (body.email || "").trim().toLowerCase();
    const wachtwoord = body.wachtwoord || "";
    if (!email || !wachtwoord) return json({ error: "Vul e-mailadres en wachtwoord in." }, 400);

    await zorgVoorAccountTabellen(env.DB);

    const account = await env.DB.prepare(`SELECT * FROM accounts WHERE email = ?`).bind(email).first();
    if (!account) return json({ error: "E-mailadres of wachtwoord onjuist." }, 401);

    const klopt = await wachtwoordKlopt(wachtwoord, account.wachtwoord_hash, account.wachtwoord_salt);
    if (!klopt) return json({ error: "E-mailadres of wachtwoord onjuist." }, 401);

    const { sessionId, verloopt } = await maakSessie(env.DB, account.id);

    return json(
      { ok: true, accountType: account.account_type },
      200,
      { "Set-Cookie": sessieCookieHeader(sessionId, verloopt) }
    );
  } catch (err) {
    console.error("auth/login fout:", err);
    return json({ error: "Er ging iets mis bij het inloggen." }, 500);
  }
}
