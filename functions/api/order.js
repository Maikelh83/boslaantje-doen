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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { items, customer, levering, couponCode } = body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: "Winkelwagen is leeg." }, 400);
    }
    if (!customer || !customer.naam || !customer.telefoon || !customer.email) {
      return json({ error: "Naam, telefoonnummer en e-mail zijn verplicht." }, 400);
    }
    if (levering === "bezorgen" && (!customer.adres || !customer.postcode || !customer.plaats)) {
      return json({ error: "Adres, postcode en plaats zijn verplicht bij bezorgen." }, 400);
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

    if (totaal < 0.5) {
      return json({ error: "Het bedrag na korting is te laag om af te rekenen." }, 400);
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
          couponCode: toegepasteCode,
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
        await env.DB.prepare(
          `INSERT INTO orders (order_id, status, totaal, korting, coupon_code, klant_email, klant_telefoon, levering, items_json, acties_json, aangemaakt_op)
           VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            new Date().toISOString()
          )
          .run();
      } catch (dbErr) {
        console.error("order.js: kon order niet loggen in D1", dbErr);
      }
    }

    return json({ checkoutUrl, orderId, totaal, korting });
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
