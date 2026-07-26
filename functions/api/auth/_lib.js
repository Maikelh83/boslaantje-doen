// functions/api/auth/_lib.js
// Gedeelde hulpfuncties voor het account-/inlogsysteem (particulier +
// zakelijk, zie pijler 7). Dit bestand start zelf GEEN Cloudflare
// Function (geen onRequest*-export) — het wordt alleen geïmporteerd
// door register.js/login.js/logout.js/me.js en door
// /api/admin/zakelijke-klanten.js.
//
// Wachtwoorden worden nooit in platte tekst opgeslagen: we gebruiken
// PBKDF2 (Web Crypto/SubtleCrypto, standaard beschikbaar in de
// Cloudflare Workers-runtime) met een per-wachtwoord salt.

const SESSIE_COOKIE_NAAM = "bd_sessie";
const SESSIE_GELDIGHEID_DAGEN = 30;

export async function zorgVoorAccountTabellen(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    wachtwoord_hash TEXT NOT NULL,
    wachtwoord_salt TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'private',
    naam TEXT,
    telefoon TEXT,
    aangemaakt_op TEXT NOT NULL
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS business_profiles (
    account_id TEXT PRIMARY KEY,
    bedrijfsnaam TEXT NOT NULL,
    kvk_nummer TEXT,
    btw_nummer TEXT,
    afdeling TEXT,
    factuur_email TEXT,
    business_approved INTEGER NOT NULL DEFAULT 0,
    factuur_toegestaan INTEGER NOT NULL DEFAULT 0,
    custom_discount_percentage REAL NOT NULL DEFAULT 0,
    override_minimum_invoice_amount INTEGER NOT NULL DEFAULT 0,
    enable_monthly_consolidated_invoice INTEGER NOT NULL DEFAULT 1,
    aangevraagd_op TEXT NOT NULL,
    goedgekeurd_op TEXT
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    aangemaakt_op TEXT NOT NULL,
    verloopt_op TEXT NOT NULL
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS instellingen (
    sleutel TEXT PRIMARY KEY,
    waarde TEXT
  )`).run();

  await db.prepare(
    `INSERT OR IGNORE INTO instellingen (sleutel, waarde) VALUES ('minimum_factuurbedrag', '50')`
  ).run();
}

export async function hashWachtwoord(wachtwoord, saltHex) {
  const encoder = new TextEncoder();
  const salt = saltHex ? hexNaarBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMateriaal = await crypto.subtle.importKey("raw", encoder.encode(wachtwoord), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMateriaal,
    256
  );
  return { hash: bytesNaarHex(new Uint8Array(bits)), salt: bytesNaarHex(salt) };
}

export async function wachtwoordKlopt(wachtwoord, opgeslagenHash, opgeslagenSalt) {
  const { hash } = await hashWachtwoord(wachtwoord, opgeslagenSalt);
  return constantTimeGelijk(hash, opgeslagenHash);
}

function constantTimeGelijk(a, b) {
  if (a.length !== b.length) return false;
  let verschil = 0;
  for (let i = 0; i < a.length; i++) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return verschil === 0;
}

function bytesNaarHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexNaarBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function maakSessie(db, accountId) {
  const sessionId = crypto.randomUUID();
  const nu = new Date();
  const verloopt = new Date(nu.getTime() + SESSIE_GELDIGHEID_DAGEN * 24 * 60 * 60 * 1000);
  await db
    .prepare(`INSERT INTO sessions (session_id, account_id, aangemaakt_op, verloopt_op) VALUES (?, ?, ?, ?)`)
    .bind(sessionId, accountId, nu.toISOString(), verloopt.toISOString())
    .run();
  return { sessionId, verloopt };
}

export function sessieCookieHeader(sessionId, verlooptOp) {
  const expires = verlooptOp.toUTCString();
  return `${SESSIE_COOKIE_NAAM}=${sessionId}; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=Lax`;
}

export function verwijderCookieHeader() {
  return `${SESSIE_COOKIE_NAAM}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

export function leesSessieIdUitCookie(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp("(?:^|; )" + SESSIE_COOKIE_NAAM + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function haalIngelogdeGebruikerOp(db, request) {
  const sessionId = leesSessieIdUitCookie(request);
  if (!sessionId) return null;

  const sessie = await db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).bind(sessionId).first();
  if (!sessie) return null;
  if (new Date(sessie.verloopt_op).getTime() < Date.now()) return null;

  const account = await db
    .prepare(`SELECT id, email, account_type, naam, telefoon FROM accounts WHERE id = ?`)
    .bind(sessie.account_id)
    .first();
  if (!account) return null;

  let business = null;
  if (account.account_type === "business") {
    business = await db.prepare(`SELECT * FROM business_profiles WHERE account_id = ?`).bind(account.id).first();
  }
  return { account, business };
}


export async function haalMinimumFactuurbedrag(db) {
  const rij = await db
    .prepare(`SELECT waarde FROM instellingen WHERE sleutel = 'minimum_factuurbedrag'`)
    .first();
  const bedrag = rij ? parseFloat(rij.waarde) : 50;
  return Number.isFinite(bedrag) ? bedrag : 50;
}

// Pijler 7: bepaalt of een zakelijk account op dit moment op factuur mag
// betalen. Dit is de enige plek waar deze regel wordt vastgelegd - zowel
// order.js als de toekomstige 'Op Factuur'-orderflow gebruiken deze
// functie, zodat de regel maar op één plek hoeft te kloppen.
export function berekenFactuurGeschiktheid(business, minimumFactuurbedrag, totaal) {
  if (!business || !business.business_approved || !business.factuur_toegestaan) {
    return { toegestaan: false, reden: "Dit account is niet goedgekeurd voor betalen op factuur." };
  }
  if (business.override_minimum_invoice_amount) {
    return { toegestaan: true, minimumbedrag: 0 };
  }
  if (totaal < minimumFactuurbedrag) {
    const drempelTekst = minimumFactuurbedrag.toFixed(2).replace(".", ",");
    const totaalTekst = totaal.toFixed(2).replace(".", ",");
    return {
      toegestaan: false,
      reden: `Op factuur betalen kan vanaf €${drempelTekst} (deze bestelling is €${totaalTekst}).`,
      minimumbedrag: minimumFactuurbedrag,
    };
  }
  return { toegestaan: true, minimumbedrag: minimumFactuurbedrag };
}

export function json(data, status = 200, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(data), { status, headers });
}
