// functions/api/order.js
// Cloudflare Pages Function — POST /api/order
//
// Ontvangt de winkelwagen vanaf bestellen.html, herberekent de prijs
// server-side (nooit de klant vertrouwen — ook niet voor extras,
// gratis-productacties of kortingscodes), en start een iDEAL-betaling
// via Mollie. Geeft de checkout-URL terug zodat de klant kan afrekenen.
//
// Benodigde environment variables (Cloudflare Pages > Settings > Environment variables):
//   MOLLIE_API_KEY  — test_... of live_... key uit het Mollie-dashboard
//   DB              — D1-database binding (optioneel; als afwezig wordt orderlogging overgeslagen)
//   MAKE_WEBHOOK_URL — optioneel; Make.com-webhook voor WeFact-facturatie bij 'op factuur'-orders (zelfde webhook als mollie-webhook.js)
//   MAPBOX_ACCESS_TOKEN — access token uit het Mapbox-dashboard, nodig voor de bezorgzone-afstandscontrole hieronder

import { zorgVoorAccountTabellen, haalIngelogdeGebruikerOp, haalMinimumFactuurbedrag, berekenFactuurGeschiktheid, controleerBezorgzone } from "./auth/_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { items, customer, levering, tijdslot, couponCode, loyaliteitsCode, betaalmethode } = body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: "Winkelwagen is leeg." }, 400);
    }
    if (!customer || !customer.naam || !customer.telefoon || !customer.email) {
      return json({ error: "Naam, telefoonnummer en e-mail zijn verplicht." }, 400);
    }
    if (levering === "bezorgen" && (!customer.adres || !customer.postcode || !customer.plaats)) {
      return json({ error: "Adres, postcode en plaats zijn verplicht bij bezorgen." }, 400);
    }

    // Geografische bezorgzone-check (werkelijke rijafstand via Mapbox): de
    // klant heeft dit adres mogelijk al eerder in bestellen.html laten
    // controleren via /api/bezorgzone-afstand (live UI-feedback), maar dat
    // wordt hier nooit vertrouwd — de server voert de controle helemaal
    // opnieuw uit, vanaf nul, met dezelfde controleerBezorgzone-functie
    // (auth/_lib.js) zodat beide plekken altijd exact dezelfde uitkomst geven.
    let bezorgAfstandKm = null;
    let bezorgkosten = 0;
    if (levering === "bezorgen") {
      if (!env.DB) {
        return json({ error: "Bezorgen is momenteel niet beschikbaar (database niet gekoppeld)." }, 400);
      }
      await zorgVoorAccountTabellen(env.DB);
      const bezorgzoneResultaat = await controleerBezorgzone(env, customer);
      if (!bezorgzoneResultaat.ok) {
        return json({ error: bezorgzoneResultaat.error }, bezorgzoneResultaat.status || 400);
      }
      if (!bezorgzoneResultaat.binnenBereik) {
        return json({ error: bezorgzoneResultaat.foutmelding }, 400);
      }
      bezorgAfstandKm = bezorgzoneResultaat.afstandKm;
      bezorgkosten = bezorgzoneResultaat.bezorgkosten || 0;
    }


// Pijler 7: het exclusieve tijdslot 'vrijdag-lunch' is alleen bedoeld voor
// goedgekeurde zakelijke klanten, en alleen vóór de cut-off (zie
// vrijdagLunchCutoffBereikt hieronder). bestellen.html toont deze optie
// alleen als UI-gemak aan klanten die volgens /api/auth/me goedgekeurd
// zakelijk zijn — dat wordt hier nooit vertrouwd: de server controleert
// de sessie en de cut-off zelf, opnieuw, vanaf nul.
if (tijdslot === "vrijdag-lunch") {
 if (vrijdagLunchCutoffBereikt(new Date())) {
 return json({ error: "Het tijdslot 'Vrijdag lunch' is niet meer beschikbaar (de cut-off is gepasseerd)." }, 400);
 }
 if (!env.DB) {
 return json({ error: "Dit tijdslot is momenteel niet beschikbaar." }, 400);
 }
 await zorgVoorAccountTabellen(env.DB);
 const gebruiker = await haalIngelogdeGebruikerOp(env.DB, request);
 const magVrijdagLunch = !!(
 gebruiker &&
 gebruiker.account.account_type === "business" &&
 gebruiker.business &&
 gebruiker.business.business_approved
 );
 if (!magVrijdagLunch) {
 return json({ error: "Het tijdslot 'Vrijdag lunch' is alleen beschikbaar voor goedgekeurde zakelijke klanten." }, 400);
 }
}

// Datum+tijdslot-kiezer ("Kies zelf een moment" in bestellen.html): de klant
// kiest een eigen datum+tijd, aangeleverd als tijdslot = "DD-MM-JJJJ UU:MM".
// De server is hier de enige bron van waarheid — valideert format, opening-
// stijden/vakantie, minimale voorbereidingstijd en het toegestane aantal
// dagen vooruit, helemaal opnieuw, ook al heeft bestellen.html dezelfde
// selects al gevuld met geldige opties.
let gewenstTijdstip = null;
if (typeof tijdslot === "string" && isEigenTijdslotFormaat(tijdslot)) {
  // Op vrijdag geldt voor bezorgen een verruimd venster (11:00-20:30) exclusief
  // voor goedgekeurde zakelijke klanten (zelfde doelgroep als 'vrijdag-lunch'
  // hierboven) - anders geldt het particuliere venster (16:30-20:30). Nooit de
  // client vertrouwen: opnieuw, zelf, opzoeken wie er is ingelogd.
  let magZakelijkBezorgenVrijdag = false;
  if (env.DB) {
    try {
      await zorgVoorAccountTabellen(env.DB);
      const tijdslotGebruiker = await haalIngelogdeGebruikerOp(env.DB, request);
      magZakelijkBezorgenVrijdag = !!(
        tijdslotGebruiker &&
        tijdslotGebruiker.account.account_type === "business" &&
        tijdslotGebruiker.business &&
        tijdslotGebruiker.business.business_approved
      );
    } catch (magZakelijkErr) {
      // faalt stil - dan geldt gewoon het particuliere bezorgvenster
    }
  }
  const validatie = valideerEigenTijdslot(tijdslot, levering, magZakelijkBezorgenVrijdag);
  if (!validatie.geldig) {
    return json({ error: validatie.foutmelding }, 400);
  }
  gewenstTijdstip = tijdslot;
}
    // Productenlijst + prijzen ophalen van de eigen, live site (nooit de
    // prijs die de klant meestuurt vertrouwen).
    const productenUrl = new URL("/producten.json", request.url);
    const productenRes = await fetch(productenUrl.toString());
    if (!productenRes.ok) {
      return json({ error: "Kon productenlijst niet laden." }, 500);
    }
    const catalogus = await productenRes.json();
    const alleProducten = catalogus.categorieen.flatMap((c) =>
      c.producten.map((p) => Object.assign({}, p, { _categorie: c.naam }))
    );
    const productMap = new Map(alleProducten.map((p) => [p.id, p]));

    const acties = await laadActies(request);

    // Eerst de gewone (niet-gratis) regels doorrekenen, zodat we daarna
    // weten of een gratis-productactie daadwerkelijk ontgrendeld is.
    let subtotaalGewoneRegels = 0;
    const categorienInOrder = new Set();
    const productIdsInOrder = new Set();
    const gewoneRegels = items.filter((r) => !r.gratisActie);
    const gratisRegels = items.filter((r) => r.gratisActie);

    const orderRegels = [];
    const toegepasteActies = [];

    for (const regel of gewoneRegels) {
      const product = productMap.get(regel.id);
      if (!product) {
        return json({ error: `Onbekend product: ${regel.id}` }, 400);
      }
      const aantal = Math.max(1, Math.min(20, parseInt(regel.aantal, 10) || 1));

      let extraPrijs = 0;
      const extraOmschrijvingen = [];
      const gekozenExtras = (regel.extras && typeof regel.extras === "object") ? regel.extras : {};

      if (Array.isArray(product.extras)) {
        for (const groep of product.extras) {
          const idx = gekozenExtras[groep.id];
          if (idx === undefined || idx === null) {
            if (groep.verplicht) {
              return json({ error: `Kies een optie bij "${groep.naam}" voor ${product.naam}.` }, 400);
            }
            continue;
          }
          const optie = groep.opties[idx];
          if (!optie) {
            return json({ error: `Ongeldige keuze bij "${groep.naam}" voor ${product.naam}.` }, 400);
          }
          extraPrijs += optie.prijs || 0;
          if (optie.prijs > 0 || groep.type === "keuze") {
            extraOmschrijvingen.push(optie.naam);
          }
        }
      }

      const perStuk = Math.round((product.prijs + extraPrijs) * 100) / 100;
      const subtotaal = Math.round(perStuk * aantal * 100) / 100;
      subtotaalGewoneRegels += subtotaal;
      categorienInOrder.add(product._categorie);
      productIdsInOrder.add(product.id);

      orderRegels.push({
        id: product.id,
        naam: product.naam,
        prijs: perStuk,
        extras: extraOmschrijvingen.join(", "),
        aantal,
        subtotaal,
      });
    }
    subtotaalGewoneRegels = Math.round(subtotaalGewoneRegels * 100) / 100;

    // Gratis-productacties: server herbeoordeelt zelf of de trigger klopt
    // (nooit vertrouwen dat de client dit terecht heeft toegevoegd).
    for (const regel of gratisRegels) {
      const product = productMap.get(regel.id);
      if (!product) {
        return json({ error: `Onbekend gratis product: ${regel.id}` }, 400);
      }
      const actie = acties.find(
        (a) => a.naam === regel.gratisActie && a.type === "gratis_product" && a.automatisch === true
      );
      if (!actie || actie.actief === false || !actieBinnenBereik(actie)) {
        return json({ error: `Actie "${regel.gratisActie}" is niet (meer) geldig.` }, 400);
      }
      if (actie.gratisProductId !== product.id) {
        return json({ error: `"${product.naam}" hoort niet bij de actie "${actie.naam}".` }, 400);
      }
      const trigger = actie.trigger || {};
      let ontgrendeld = true;
      if (trigger.minimumBedrag && subtotaalGewoneRegels < trigger.minimumBedrag) ontgrendeld = false;
      if (trigger.vereistCategorie && !categorienInOrder.has(trigger.vereistCategorie)) ontgrendeld = false;
      if (trigger.vereistProductId && !productIdsInOrder.has(trigger.vereistProductId)) ontgrendeld = false;
      if (!ontgrendeld) {
        return json({ error: `Je bestelling voldoet niet (meer) aan de voorwaarden voor "${actie.omschrijving}".` }, 400);
      }

      orderRegels.push({
        id: product.id,
        naam: product.naam + " (gratis actie)",
        prijs: 0,
        extras: "",
        aantal: 1,
        subtotaal: 0,
      });
      toegepasteActies.push(actie.naam);
    }

    let totaal = subtotaalGewoneRegels;

    if (totaal <= 0) {
      return json({ error: "Ongeldig totaalbedrag." }, 400);
    }


    // Pijler 7: automatische zakelijke korting voor goedgekeurde accounts.
    // custom_discount_percentage staat in business_profiles en wordt hier
    // altijd toegepast als dat van toepassing is - de klant hoeft er niets
    // voor te doen of in te vullen. Dit staat los van kortingscodes hieronder
    // en wordt vóór de kortingscode verrekend.
    let zakelijkeKortingBedrag = 0;
    let zakelijkeKortingPercentage = 0;
    let factuurGeschiktheid = { toegestaan: false, reden: "Op factuur betalen is niet beschikbaar voor dit account." };
    if (env.DB) {
      await zorgVoorAccountTabellen(env.DB);
      const zakelijkeGebruiker = await haalIngelogdeGebruikerOp(env.DB, request);
      if (
        zakelijkeGebruiker &&
        zakelijkeGebruiker.account.account_type === "business" &&
        zakelijkeGebruiker.business &&
        zakelijkeGebruiker.business.business_approved
      ) {
        if (zakelijkeGebruiker.business.custom_discount_percentage > 0) {
          zakelijkeKortingPercentage = zakelijkeGebruiker.business.custom_discount_percentage;
          zakelijkeKortingBedrag = Math.round(totaal * (zakelijkeKortingPercentage / 100) * 100) / 100;
          totaal = Math.round((totaal - zakelijkeKortingBedrag) * 100) / 100;
          toegepasteActies.push(`Zakelijke korting (${zakelijkeKortingPercentage}%)`);
        }
        const minimumFactuurbedrag = await haalMinimumFactuurbedrag(env.DB);
        factuurGeschiktheid = berekenFactuurGeschiktheid(zakelijkeGebruiker.business, minimumFactuurbedrag, totaal);
      }
    }
    
    // Onthoud het laatst gebruikte bezorgadres op het account (particulier +
    // zakelijk), zodat bestellen.html dit de volgende keer kan voorinvullen.
    // Puur gemaks-functie - heeft geen invloed op prijsberekening, korting of
    // factuurlogica hierboven, en faalt stil als het niet lukt.
    if (env.DB && levering === "bezorgen" && customer && customer.adres) {
      try {
        const ingelogdeKlant = await haalIngelogdeGebruikerOp(env.DB, request);
        if (ingelogdeKlant) {
          await env.DB
            .prepare(`UPDATE accounts SET laatst_adres = ?, laatst_postcode = ?, laatst_plaats = ? WHERE id = ?`)
            .bind(customer.adres || null, customer.postcode || null, customer.plaats || null, ingelogdeKlant.account.id)
            .run();
        }
      } catch (adresErr) {
        console.error("order.js: kon laatst gebruikte adres niet opslaan", adresErr);
      }
    }

// Kortingscode — server-side de enige bron van waarheid.
    let korting = 0;
    let toegepasteCode = null;
    if (couponCode) {
      const coupon = vindGeldigeCoupon(acties, couponCode, totaal);
      if (!coupon.geldig) {
        return json({ error: coupon.foutmelding || "Deze kortingscode is niet (meer) geldig." }, 400);
      }
      korting = coupon.korting;
      toegepasteCode = coupon.code;
      toegepasteActies.push(coupon.omschrijving || coupon.code);
      totaal = Math.round((totaal - korting) * 100) / 100;
    }

    // Loyaliteitscode — alleen van toepassing als er daadwerkelijk
    // beschikbare korting op de spaarkaart staat. Nooit de klant zelf laten
    // opgeven hoeveel korting er staat: dat halen we hier zelf op uit D1.
    let loyaliteitsKorting = 0;
    let loyaliteitsCodeGeldig = null;
    if (loyaliteitsCode && env.DB) {
      const code = String(loyaliteitsCode).trim().toUpperCase();
      try {
        const account = await env.DB.prepare(`SELECT code, beschikbare_korting FROM loyalty_accounts WHERE code = ?`)
          .bind(code)
          .first();
        if (!account) {
          return json({ error: "Loyaliteitscode niet gevonden." }, 400);
        }
        if (account.beschikbare_korting > 0) {
          // Nooit het totaal onder de Mollie-minimumgrens (€0,50) laten zakken.
          loyaliteitsKorting = Math.min(account.beschikbare_korting, Math.max(0, totaal - 0.5));
          loyaliteitsKorting = Math.round(loyaliteitsKorting * 100) / 100;
          loyaliteitsCodeGeldig = code;
          totaal = Math.round((totaal - loyaliteitsKorting) * 100) / 100;
        } else {
          loyaliteitsCodeGeldig = code; // code is geldig, alleen nog niets te verzilveren
        }
      } catch (loyErr) {
        console.error("order.js: kon loyaliteitscode niet controleren", loyErr);
        return json({ error: "Kon loyaliteitscode niet controleren." }, 500);
      }
    }

    // Bezorgkosten worden pas hier, ná alle kortingen, opgeteld — een
    // kortingscode of spaarkaartkorting slaat alleen op de bestelling zelf,
    // niet op de bezorgkosten.
    if (levering === "bezorgen" && bezorgkosten > 0) {
      totaal = Math.round((totaal + bezorgkosten) * 100) / 100;
    }

    if (totaal < 0.5) {
      return json({ error: "Het bedrag na korting is te laag om af te rekenen." }, 400);
    }


    // Pijler 7: 'Op factuur' betalen — alleen voor goedgekeurde zakelijke
    // accounts en alleen als de order de factuurdrempel haalt (zie
    // berekenFactuurGeschiktheid in auth/_lib.js, hierboven al berekend).
    // Er wordt geen Mollie-betaling aangemaakt; de order gaat direct door
    // naar de keuken (status 'paid') en wordt naar het Make.com-webhook
    // gestuurd zodat WeFact een factuur kan aanmaken — hetzelfde webhook
    // dat mollie-webhook.js ook al gebruikt.
    if (betaalmethode === "factuur") {
      if (!factuurGeschiktheid.toegestaan) {
        return json({ error: factuurGeschiktheid.reden }, 400);
      }

      const factuurOrderId = "BD-" + Date.now().toString(36).toUpperCase();
      const factuurMoment = new Date().toISOString();
      toegepasteActies.push("Betaalmethode: op factuur");

      const factuurGebruiker = await haalIngelogdeGebruikerOp(env.DB, request);
      const factuurBusiness = factuurGebruiker && factuurGebruiker.business;

      if (env.MAKE_WEBHOOK_URL) {
        try {
          await fetch(env.MAKE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: factuurOrderId,
              betaalmethode: "factuur",
              status: "paid",
              bedrag: { currency: "EUR", value: totaal.toFixed(2) },
              levering: levering || "afhalen",
              klant: customer,
              business: factuurBusiness
                ? {
                    bedrijfsnaam: factuurBusiness.bedrijfsnaam,
                    kvkNummer: factuurBusiness.kvk_nummer,
                    btwNummer: factuurBusiness.btw_nummer,
                    afdeling: factuurBusiness.afdeling,
                    factuurEmail: factuurBusiness.factuur_email,
                  }
                : null,
              items: orderRegels,
              korting,
              zakelijkeKorting: zakelijkeKortingBedrag,
              betaaldOp: factuurMoment,
            }),
          });
        } catch (webhookErr) {
          console.error("order.js: kon WeFact/Make-webhook niet aanroepen", webhookErr);
        }
      }

      if (env.DB) {
        try {
          await zorgVoorGewenstTijdstipKolom(env.DB);
          await zorgVoorBezorgzoneKolommen(env.DB);
          await env.DB
            .prepare(
              `INSERT INTO orders (order_id, status, totaal, korting, coupon_code, klant_email, klant_telefoon, levering, items_json, acties_json, aangemaakt_op, loyalty_code, loyalty_korting_gebruikt, betaald_op, gewenst_tijdstip, bezorg_afstand_km, bezorgkosten)
               VALUES (?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              factuurOrderId,
              totaal,
              korting,
              toegepasteCode,
              customer.email || null,
              customer.telefoon || null,
              levering || "afhalen",
              JSON.stringify(orderRegels),
              JSON.stringify(toegepasteActies),
              factuurMoment,
              null,
              0,
              factuurMoment,
              gewenstTijdstip,
              bezorgAfstandKm,
              bezorgkosten
            )
            .run();
        } catch (dbErr) {
          console.error("order.js: kon factuurorder niet loggen in D1", dbErr);
        }
      }

      return json({
        checkoutUrl: new URL(`/bestellen-bedankt.html?order=${factuurOrderId}`, request.url).toString(),
        orderId: factuurOrderId,
        totaal,
        korting,
        loyaliteitsKorting: 0,
        zakelijkeKorting: zakelijkeKortingBedrag,
        zakelijkeKortingPercentage,
        opFactuur: true,
        bezorgkosten,
        bezorgAfstandKm,
      });
    }
    if (!env.MOLLIE_API_KEY) {
      return json(
        { error: "Betaalprovider is nog niet ingesteld (MOLLIE_API_KEY ontbreekt in Cloudflare Pages)." },
        500
      );
    }

    const orderId = "BD-" + Date.now().toString(36).toUpperCase();

    const mollieRes = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: totaal.toFixed(2) },
        description: `Boslaantje Doen bestelling ${orderId}`,
        redirectUrl: new URL(`/bestellen-bedankt.html?order=${orderId}`, request.url).toString(),
        webhookUrl: new URL("/api/mollie-webhook", request.url).toString(),
        metadata: {
          orderId,
          levering: levering || "afhalen",
          customer,
          items: orderRegels,
          korting,
              zakelijkeKorting: zakelijkeKortingBedrag,
              zakelijkeKortingPercentage,
          couponCode: toegepasteCode,
          loyaltyCode: loyaliteitsCodeGeldig,
          loyaltyKorting: loyaliteitsKorting,
        },
      }),
    });

    if (!mollieRes.ok) {
      const detail = await mollieRes.text();
      return json({ error: "Mollie kon de betaling niet aanmaken.", detail }, 502);
    }

    const payment = await mollieRes.json();
    const checkoutUrl = payment && payment._links && payment._links.checkout && payment._links.checkout.href;

    if (!checkoutUrl) {
      return json({ error: "Geen checkout-URL ontvangen van Mollie." }, 502);
    }

    // Bestelling loggen in D1 (voor het marketingdashboard). Dit gebeurt
    // vóór de betaling is bevestigd (status 'open') — de webhook werkt de
    // status bij naar 'paid' zodra Mollie dat meldt. Als de database niet
    // gekoppeld is (env.DB ontbreekt), slaan we dit stilletjes over: de
    // bestelling zelf mag hier nooit op stuklopen.
    if (env.DB) {
      try {
        await zorgVoorGewenstTijdstipKolom(env.DB);
        await zorgVoorBezorgzoneKolommen(env.DB);
        await env.DB.prepare(
          `INSERT INTO orders (order_id, status, totaal, korting, coupon_code, klant_email, klant_telefoon, levering, items_json, acties_json, aangemaakt_op, loyalty_code, loyalty_korting_gebruikt, gewenst_tijdstip, bezorg_afstand_km, bezorgkosten)
           VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            orderId,
            totaal,
            korting,
            toegepasteCode,
            customer.email || null,
            customer.telefoon || null,
            levering || "afhalen",
            JSON.stringify(orderRegels),
            JSON.stringify(toegepasteActies),
            new Date().toISOString(),
            loyaliteitsCodeGeldig,
            loyaliteitsKorting,
            gewenstTijdstip,
            bezorgAfstandKm,
            bezorgkosten
          )
          .run();
      } catch (dbErr) {
        console.error("order.js: kon order niet loggen in D1", dbErr);
      }
    }

    return json({
      checkoutUrl,
      orderId,
      totaal,
      korting,
      loyaliteitsKorting,
      zakelijkeKorting: zakelijkeKortingBedrag,
      zakelijkeKortingPercentage,
      magOpFactuur: factuurGeschiktheid.toegestaan,
      factuurReden: factuurGeschiktheid.reden || null,
      bezorgkosten,
      bezorgAfstandKm,
    });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

async function laadActies(request) {
  const couponsUrl = new URL("/coupons.json", request.url);
  const res = await fetch(couponsUrl.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.coupons) ? data.coupons : [];
}

// Pijler 7: cut-off voor het exclusieve 'vrijdag lunch'-tijdslot.
// LET OP: deze regel moet functioneel gelijk blijven aan de UI-check in
// src/bestellen.html (functie vrijdagLunchCutoffBereikt in de losse
// script-blok onderaan die pagina). Hier gebruiken we expliciet de
// Europe/Amsterdam-tijdzone, omdat de Cloudflare Worker zelf in UTC
// draait en anders 's zomers/'s winters een uur zou verschuiven t.o.v.
// de klant in de browser.
function amsterdamDagEnUur(nu) {
 const fmt = new Intl.DateTimeFormat("en-US", {
 timeZone: "Europe/Amsterdam",
 weekday: "short",
 hour: "numeric",
 hour12: false,
 });
 const parts = fmt.formatToParts(nu);
 const weekdayStr = parts.find((p) => p.type === "weekday").value;
 const uurStr = parts.find((p) => p.type === "hour").value;
 const dagMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
 return { dag: dagMap[weekdayStr], uur: parseInt(uurStr, 10) % 24 };
}

function vrijdagLunchCutoffBereikt(nu) {
 const { dag, uur } = amsterdamDagEnUur(nu);
 if (dag >= 1 && dag <= 3) return false; // ma/di/wo: ruim op tijd
 if (dag === 4) return uur >= 17; // do: cut-off om 17:00
 return true; // vr/weekend: cut-off al gepasseerd
}

// Datum+tijdslot-kiezer ("Kies zelf een moment"): server-side validatie.
// LET OP: OPENINGSTIJDEN, VAKANTIES, VOORUIT_DAGEN en MIN_VOORBEREIDING_MIN
// hieronder moeten functioneel gelijk blijven aan de gelijknamige constanten
// in de losse script-blok onderaan src/bestellen.html en aan de vakantiedata
// in src/index.html (checkVakantie/VACATIONS) — dit is de server-side bron
// van waarheid, bestellen.html is alleen het UI-gemak.
const EIGEN_TIJDSLOT_PATROON = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;

// Afhalen volgt de gewone openingstijden van de snackbar. Bezorgen heeft een
// eigen, kortere venster: ma t/m za 16:30-20:30 voor iedereen, met op vrijdag
// een verruiming naar 11:00-20:30 exclusief voor goedgekeurde zakelijke
// klanten (zie magZakelijkBezorgenVrijdag hierboven).
const OPENINGSTIJDEN_AFHALEN = {
  0: null, // zondag: gesloten
  1: [16, 0, 21, 0],
  2: [16, 0, 21, 0],
  3: [16, 0, 21, 0],
  4: [16, 0, 21, 0],
  5: [11, 0, 21, 0],
  6: [16, 0, 21, 0],
};

const OPENINGSTIJDEN_BEZORGEN = {
  0: null, // zondag: gesloten
  1: [16, 30, 20, 30],
  2: [16, 30, 20, 30],
  3: [16, 30, 20, 30],
  4: [16, 30, 20, 30],
  5: [16, 30, 20, 30], // particulier; zakelijk goedgekeurd wordt verruimd naar 11:00
  6: [16, 30, 20, 30],
};

const VAKANTIES = [
  { schoonmaakZaterdag: "2026-08-01", dichtVanaf: "2026-08-03", dichtTotEnMet: "2026-08-16" },
  { schoonmaakZaterdag: "2027-07-31", dichtVanaf: "2027-08-02", dichtTotEnMet: "2027-08-15" },
  { schoonmaakZaterdag: "2028-07-22", dichtVanaf: "2028-07-24", dichtTotEnMet: "2028-08-06" },
];

const VOORUIT_DAGEN = 6;
const MIN_VOORBEREIDING_MIN = 20;

function isEigenTijdslotFormaat(waarde) {
  return EIGEN_TIJDSLOT_PATROON.test(waarde);
}

function amsterdamNuVolledig() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return {
    jaar: parseInt(map.year, 10),
    maand: parseInt(map.month, 10),
    dag: parseInt(map.day, 10),
    uur: parseInt(map.hour, 10) % 24,
    minuut: parseInt(map.minute, 10),
  };
}

function vindVakantie(datumObj) {
  for (const v of VAKANTIES) {
    const dichtVanaf = new Date(v.dichtVanaf + "T00:00:00");
    const dichtTot = new Date(v.dichtTotEnMet + "T00:00:00");
    if (datumObj >= dichtVanaf && datumObj <= dichtTot) return { gesloten: true, vroegSluiten: null };
    const schoonmaak = new Date(v.schoonmaakZaterdag + "T00:00:00");
    if (datumObj.getTime() === schoonmaak.getTime()) return { gesloten: false, vroegSluiten: [19, 30] };
  }
  return { gesloten: false, vroegSluiten: null };
}

function openingstijdenVoorDag(datumObj, levering, magZakelijkBezorgenVrijdag) {
  const vak = vindVakantie(datumObj);
  if (vak.gesloten) return null;
  const isBezorgen = levering === "bezorgen";
  const tabel = isBezorgen ? OPENINGSTIJDEN_BEZORGEN : OPENINGSTIJDEN_AFHALEN;
  let basis = tabel[datumObj.getDay()];
  if (!basis) return null;
  if (isBezorgen && datumObj.getDay() === 5 && magZakelijkBezorgenVrijdag) {
    basis = [11, 0, basis[2], basis[3]];
  }
  if (vak.vroegSluiten) return [basis[0], basis[1], vak.vroegSluiten[0], vak.vroegSluiten[1]];
  return basis;
}

function valideerEigenTijdslot(waarde, levering, magZakelijkBezorgenVrijdag) {
  const match = waarde.match(EIGEN_TIJDSLOT_PATROON);
  if (!match) {
    return { geldig: false, foutmelding: "Ongeldig formaat voor het gekozen tijdstip." };
  }
  const dag = parseInt(match[1], 10);
  const maand = parseInt(match[2], 10);
  const jaar = parseInt(match[3], 10);
  const uur = parseInt(match[4], 10);
  const minuut = parseInt(match[5], 10);

  const gekozenDatum = new Date(jaar, maand - 1, dag);
  if (
    gekozenDatum.getFullYear() !== jaar ||
    gekozenDatum.getMonth() !== maand - 1 ||
    gekozenDatum.getDate() !== dag ||
    uur < 0 || uur > 23 || minuut < 0 || minuut > 59
  ) {
    return { geldig: false, foutmelding: "Ongeldige datum of tijd." };
  }

  const nu = amsterdamNuVolledig();
  const vandaag = new Date(nu.jaar, nu.maand - 1, nu.dag);

  if (gekozenDatum < vandaag) {
    return { geldig: false, foutmelding: "Je kunt geen tijdstip in het verleden kiezen." };
  }
  const laatsteToegestaneDag = new Date(vandaag);
  laatsteToegestaneDag.setDate(laatsteToegestaneDag.getDate() + VOORUIT_DAGEN);
  if (gekozenDatum > laatsteToegestaneDag) {
    return { geldig: false, foutmelding: `Je kunt maximaal ${VOORUIT_DAGEN} dagen vooruit een tijdstip kiezen.` };
  }

  const venster = openingstijdenVoorDag(gekozenDatum, levering, magZakelijkBezorgenVrijdag);
  if (!venster) {
    return { geldig: false, foutmelding: levering === "bezorgen" ? "We bezorgen niet op de gekozen dag/tijd." : "We zijn gesloten op de gekozen dag." };
  }

  const gekozenMin = uur * 60 + minuut;
  let startMin = venster[0] * 60 + venster[1];
  const eindMin = venster[2] * 60 + venster[3];

  if (gekozenDatum.getTime() === vandaag.getTime()) {
    const nuMin = nu.uur * 60 + nu.minuut + MIN_VOORBEREIDING_MIN;
    if (nuMin > startMin) startMin = nuMin;
  }

  if (gekozenMin < startMin || gekozenMin > eindMin) {
    return { geldig: false, foutmelding: "Het gekozen tijdstip valt buiten onze openingstijden (of is te dichtbij om te bereiden)." };
  }

  const interval = levering === "bezorgen" ? 45 : 30;
  if (gekozenMin % interval !== 0) {
    return { geldig: false, foutmelding: "Kies een geldig tijdstip uit de lijst." };
  }

  return { geldig: true };
}

// Additieve migratie: bestaande orders-tabel krijgt een gewenst_tijdstip-kolom
// (nullable TEXT) voor het door de klant gekozen "Kies zelf een moment"-tijdstip.
// Faalt stil als de kolom al bestaat (idempotent, zelfde patroon als de
// account-tabellen-migraties in auth/_lib.js).
async function zorgVoorGewenstTijdstipKolom(db) {
  try {
    await db.prepare(`ALTER TABLE orders ADD COLUMN gewenst_tijdstip TEXT`).run();
  } catch (e) {
    // kolom bestaat waarschijnlijk al — dat is prima, niets te doen.
  }
}

async function zorgVoorBezorgzoneKolommen(db) {
  for (const statement of [
    `ALTER TABLE orders ADD COLUMN bezorg_afstand_km REAL`,
    `ALTER TABLE orders ADD COLUMN bezorgkosten REAL DEFAULT 0`,
  ]) {
    try {
      await db.prepare(statement).run();
    } catch (e) {
      // kolom bestaat waarschijnlijk al — dat is prima, niets te doen.
    }
  }
}

function actieBinnenBereik(actie) {
  const nu = new Date();
  if (actie.geldigVanaf && nu < new Date(actie.geldigVanaf)) return false;
  if (actie.geldigTot && nu > new Date(actie.geldigTot + "T23:59:59")) return false;
  return true;
}

function vindGeldigeCoupon(acties, code, subtotaal) {
  const actie = acties.find(
    (a) => a.code && a.code.toUpperCase() === String(code).toUpperCase()
  );

  if (!actie || actie.actief === false) {
    return { geldig: false, foutmelding: "Deze kortingscode bestaat niet (meer)." };
  }
  if (!actieBinnenBereik(actie)) {
    return { geldig: false, foutmelding: "Deze kortingscode is niet (meer) geldig." };
  }
  const trigger = actie.trigger || {};
  if (trigger.minimumBedrag && subtotaal < trigger.minimumBedrag) {
    return {
      geldig: false,
      foutmelding: `Deze code is geldig vanaf een besteding van ${trigger.minimumBedrag.toFixed(2).replace(".", ",")} euro.`,
    };
  }
  if (actie.type !== "percentage" && actie.type !== "vast") {
    return { geldig: false, foutmelding: "Deze code kan niet via het kortingsveld worden toegepast." };
  }

  let korting = 0;
  if (actie.type === "percentage") {
    korting = subtotaal * (actie.waarde / 100);
  } else {
    korting = Math.min(actie.waarde, subtotaal);
  }
  korting = Math.round(korting * 100) / 100;

  return { geldig: true, korting, code: actie.code, type: actie.type, waarde: actie.waarde, omschrijving: actie.omschrijving };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}