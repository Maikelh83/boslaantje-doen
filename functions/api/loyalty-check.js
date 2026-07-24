// functions/api/loyalty-check.js
// Cloudflare Pages Function — POST /api/loyalty-check
//
// Lichte, publieke preview-check zodat een klant op de bestelsite vóór het
// afrekenen al ziet of zijn spaarkaart-code klopt en hoeveel korting er
// beschikbaar is. De echte, bindende toepassing gebeurt hierna nogmaals in
// /api/order (nooit de client vertrouwen) — dit endpoint mag daarom NOOIT
// meer teruggeven dan het bedrag: geen naam, telefoon, e-mail of
// zegelaantal, want de code is publiek in te voeren (geen wachtwoord) en
// zou anders persoonsgegevens van andere klanten kunnen lekken.
//
// Benodigde environment variables:
//   DB — D1-database binding

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { code } = body || {};

    if (!code || typeof code !== "string") {
      return json({ geldig: false, foutmelding: "Vul een spaarkaart-code in." });
    }
    if (!env.DB) {
      return json({ geldig: false, foutmelding: "Loyaliteitssysteem is nog niet beschikbaar." });
    }

    const account = await env.DB.prepare(`SELECT beschikbare_korting FROM loyalty_accounts WHERE code = ?`)
      .bind(code.trim().toUpperCase())
      .first();

    if (!account) {
      return json({ geldig: false, foutmelding: "Deze code is niet bekend." });
    }

    return json({ geldig: true, beschikbareKorting: account.beschikbare_korting });
  } catch (err) {
    return json({ geldig: false, foutmelding: "Onverwachte fout bij het controleren van de code." });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
