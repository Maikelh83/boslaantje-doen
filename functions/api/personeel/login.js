// functions/api/personeel/login.js
// Cloudflare Pages Function — POST /api/personeel/login
//
// Personeelsnummer-fundament: identificeert WIE er achter een
// personeelsapparaat zit (bezorger-app: NFC-druppel of werknemernummer+
// pincode - kassa-bezorger.html kiest zelf welke). Dit is nu de ENIGE
// toegangspoort tot de bezorger-app - het aparte gedeelde
// STAFF_LOYALTY_PASSWORD is hier bewust losgelaten. Voorheen moest de
// chauffeur dat wachtwoord óók nog intypen, boven op NFC/pincode - dat gaf
// onnodige wrijving voor een app die toch al een eigen identiteitscheck
// heeft (zie Maikel's verzoek: alleen nog NFC of werknemernummer/pin).
//
// Bij succes geven we een kortlevende sessie-token terug (bezorger_sessies-
// tabel, zie zorgVoorBezorgerSessieTabel/maakBezorgerSessie in auth/_lib.js)
// die de bezorger-app vervolgens meestuurt als ?sessie=... naar
// bezorger-ritten.js/bezorger-kaart.js/bezorger-sumup-config.js, in plaats
// van het oude gedeelde wachtwoord.
//
// Body (JSON): { personeelsnummer, pincode }  — handmatig, via numpad-fallback
//          of: { nfcTagId }                    — NFC-druppel tegen de telefoon
// Bij succes (beide): { ok: true, sessieToken, personeelsnummer, naam }
//
// Benodigde environment variables:
// DB — D1-database binding

import {
  zorgVoorPersoneelTabel,
  zorgVoorBezorgerSessieTabel,
  maakBezorgerSessie,
  wachtwoordKlopt,
  json,
} from "../auth/_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.DB) {
      return json({ error: "Database is niet gekoppeld (D1-binding 'DB' ontbreekt)." }, 500);
    }

    await zorgVoorPersoneelTabel(env.DB);
    await zorgVoorBezorgerSessieTabel(env.DB);

    const body = await request.json();
    const nfcTagId = String((body && body.nfcTagId) || "").trim();

    // NFC-druppel: als nfcTagId is meegestuurd, loggen we daarmee in (geen
    // personeelsnummer/pincode nodig) - dit is de "NFC-eerst"-hoofdroute in
    // kassa-bezorger.html. Anders vallen we terug op de bestaande
    // personeelsnummer+pincode-controle (numpad-fallback, voor als de
    // chauffeur zijn druppel niet bij zich heeft).
    if (nfcTagId) {
      const medewerkerViaNfc = await env.DB.prepare(
        `SELECT * FROM medewerkers WHERE nfc_tag_id = ?`
      ).bind(nfcTagId).first();

      if (!medewerkerViaNfc || !medewerkerViaNfc.actief) {
        return json({ error: "Onbekende of niet-actieve NFC-druppel." }, 401);
      }

      const sessieToken = await maakBezorgerSessie(env.DB, medewerkerViaNfc.personeelsnummer);
      return json({
        ok: true,
        sessieToken,
        personeelsnummer: medewerkerViaNfc.personeelsnummer,
        naam: medewerkerViaNfc.naam,
      });
    }

    const personeelsnummer = String((body && body.personeelsnummer) || "").trim();
    const pincode = String((body && body.pincode) || "").trim();

    if (!personeelsnummer || !pincode) {
      return json({ error: "Personeelsnummer en pincode zijn verplicht." }, 400);
    }

    const medewerker = await env.DB.prepare(
      `SELECT * FROM medewerkers WHERE personeelsnummer = ?`
    ).bind(personeelsnummer).first();

    if (!medewerker || !medewerker.actief) {
      return json({ error: "Onbekend of niet-actief personeelsnummer." }, 401);
    }

    const klopt = await wachtwoordKlopt(pincode, medewerker.pincode_hash, medewerker.pincode_salt);
    if (!klopt) {
      return json({ error: "Onjuiste pincode." }, 401);
    }

    const sessieToken = await maakBezorgerSessie(env.DB, medewerker.personeelsnummer);
    return json({ ok: true, sessieToken, personeelsnummer: medewerker.personeelsnummer, naam: medewerker.naam });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}
