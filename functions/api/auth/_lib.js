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
    laatst_adres TEXT,
laatst_postcode TEXT,
laatst_plaats TEXT,
aangemaakt_op TEXT NOT NULL
  )`).run();

  // Additieve migratie voor bestaande databases: CREATE TABLE IF NOT EXISTS
  // raakt een reeds bestaande accounts-tabel niet aan, dus deze kolommen
  // worden hier los toegevoegd. ALTER TABLE ... ADD COLUMN gooit een fout
  // als de kolom al bestaat - dat vangen we stil af als teken dat de
  // migratie al eerder is uitgevoerd.
  for (const kolom of ["laatst_adres", "laatst_postcode", "laatst_plaats"]) {
    try {
      await db.prepare(`ALTER TABLE accounts ADD COLUMN ${kolom} TEXT`).run();
    } catch (migratieErr) {
      // kolom bestaat waarschijnlijk al - genegeerd
    }
  }

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

  // Bezorgzone (geografische afstandscontrole voor bezorgen, zie
  // haalBezorgzoneInstellingen/controleerBezorgzone hieronder): standaard
  // 2,5 km met twee prijs-staffels, aanpasbaar via /kassa-bezorgzone.
  await db.prepare(
    `INSERT OR IGNORE INTO instellingen (sleutel, waarde) VALUES ('max_bezorgafstand_km', '2.5')`
  ).run();
  await db.prepare(
    `INSERT OR IGNORE INTO instellingen (sleutel, waarde) VALUES ('bezorgkosten_staffels', '[{"totKm":1.5,"bedrag":2},{"totKm":2.5,"bedrag":3.5}]')`
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
    .prepare(`SELECT id, email, account_type, naam, telefoon, laatst_adres, laatst_postcode, laatst_plaats FROM accounts WHERE id = ?`)
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

// Pijler "Geographic Distance & Delivery Radius Check": geografische
// bezorgzone op basis van werkelijke rijafstand (Mapbox), met een
// instelbare maximale afstand en gestaffelde bezorgkosten. Gedeeld tussen
// /api/bezorgzone-afstand.js (live check tijdens het invullen van het adres
// in bestellen.html) en order.js (server-side eindcontrole vóór betaling),
// zodat beide altijd exact dezelfde uitkomst geven.

// Vaste coördinaten van het restaurant (Oleander 1a, Veenendaal) - zelfde
// waarden als het LocalBusiness-schema op de homepage (src/index.html).
const RESTAURANT_LAT = 52.0286;
const RESTAURANT_LNG = 5.5581;

export async function haalBezorgzoneInstellingen(db) {
  const maxRij = await db
    .prepare(`SELECT waarde FROM instellingen WHERE sleutel = 'max_bezorgafstand_km'`)
    .first();
  const staffelsRij = await db
    .prepare(`SELECT waarde FROM instellingen WHERE sleutel = 'bezorgkosten_staffels'`)
    .first();

  const maxBezorgafstandKm = maxRij ? parseFloat(maxRij.waarde) : 2.5;

  let staffels = [
    { totKm: 1.5, bedrag: 2 },
    { totKm: 2.5, bedrag: 3.5 },
  ];
  if (staffelsRij && staffelsRij.waarde) {
    try {
      const geparsed = JSON.parse(staffelsRij.waarde);
      if (Array.isArray(geparsed) && geparsed.length > 0) staffels = geparsed;
    } catch (parseErr) {
      // ongeldige JSON in de instellingen-tabel - val terug op de standaardstaffels
    }
  }

  return {
    maxBezorgafstandKm: Number.isFinite(maxBezorgafstandKm) ? maxBezorgafstandKm : 2.5,
    staffels,
  };
}

export function berekenBezorgkosten(afstandKm, staffels) {
  const gesorteerd = staffels.slice().sort((a, b) => a.totKm - b.totKm);
  for (const staffel of gesorteerd) {
    if (afstandKm <= staffel.totKm) return staffel.bedrag;
  }
  // Afstand valt buiten alle staffels maar (net) nog wel binnen de
  // maximale bezorgafstand - reken dan de hoogste staffel.
  return gesorteerd.length > 0 ? gesorteerd[gesorteerd.length - 1].bedrag : 0;
}

async function geocodeAdres(env, adres, postcode, plaats) {
  if (!env.MAPBOX_ACCESS_TOKEN) {
    return {
      ok: false,
      error: "Bezorgzone-controle is nog niet ingesteld (MAPBOX_ACCESS_TOKEN ontbreekt in Cloudflare Pages).",
      status: 500,
    };
  }

  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("address_line1", adres);
  if (postcode) url.searchParams.set("postcode", postcode);
  url.searchParams.set("place", plaats || "Veenendaal");
  url.searchParams.set("country", "nl");
  url.searchParams.set("autocomplete", "false");
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", env.MAPBOX_ACCESS_TOKEN);

  let res;
  try {
    res = await fetch(url.toString());
  } catch (fetchErr) {
    return { ok: false, error: "Kon het adres niet controleren (geen verbinding met de kaartendienst).", status: 502 };
  }
  if (!res.ok) {
    return { ok: false, error: "Kon het adres niet controleren (de kaartendienst gaf een fout).", status: 502 };
  }

  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    return { ok: false, error: "Kon dit adres niet vinden. Controleer straat, huisnummer en postcode.", status: 400 };
  }

  const [lng, lat] = feature.geometry.coordinates;
  return { ok: true, lat, lng };
}

async function berekenRijafstandKm(env, lat, lng) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${RESTAURANT_LNG},${RESTAURANT_LAT};${lng},${lat}` +
    `?overview=false&access_token=${env.MAPBOX_ACCESS_TOKEN}`;

  let res;
  try {
    res = await fetch(url);
  } catch (fetchErr) {
    return { ok: false, error: "Kon de rijafstand niet berekenen (geen verbinding met de kaartendienst).", status: 502 };
  }
  if (!res.ok) {
    return { ok: false, error: "Kon de rijafstand niet berekenen (de kaartendienst gaf een fout).", status: 502 };
  }

  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || typeof route.distance !== "number") {
    return { ok: false, error: "Kon geen rijroute naar dit adres vinden.", status: 400 };
  }

  return { ok: true, afstandKm: route.distance / 1000 };
}

// Combineert geocoderen + rijafstand + bereik/kosten-check in één functie.
// customer moet { adres, postcode, plaats } bevatten. Retourneert bij succes
// altijd { ok: true, binnenBereik, afstandKm, maxBezorgafstandKm, bezorgkosten?,
// foutmelding? } - alleen bij een technisch probleem (geen DB, geen token,
// adres niet gevonden, kaartendienst onbereikbaar) is ok: false.
export async function controleerBezorgzone(env, customer) {
  const geocodeResultaat = await geocodeAdres(env, customer.adres, customer.postcode, customer.plaats);
  if (!geocodeResultaat.ok) return geocodeResultaat;

  const afstandResultaat = await berekenRijafstandKm(env, geocodeResultaat.lat, geocodeResultaat.lng);
  if (!afstandResultaat.ok) return afstandResultaat;

  const afstandKm = Math.round(afstandResultaat.afstandKm * 100) / 100;
  const { maxBezorgafstandKm, staffels } = await haalBezorgzoneInstellingen(env.DB);

  if (afstandKm > maxBezorgafstandKm) {
    const maxTekst = String(maxBezorgafstandKm).replace(".", ",");
    return {
      ok: true,
      binnenBereik: false,
      afstandKm,
      maxBezorgafstandKm,
      foutmelding:
        `Helaas! Dit adres ligt buiten onze snelle bezorgzone (max. ${maxTekst} km). ` +
        `We willen garanderen dat onze frites en burgers bloedheet aankomen. ` +
        `Je bent uiteraard van harte welkom om je bestelling af te halen!`,
    };
  }

  const bezorgkosten = berekenBezorgkosten(afstandKm, staffels);
  return { ok: true, binnenBereik: true, afstandKm, maxBezorgafstandKm, bezorgkosten };
}

export function json(data, status = 200, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(data), { status, headers });
}