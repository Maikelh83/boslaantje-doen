// functions/api/order.js
// Cloudflare Pages Function — POST /api/order
//
// Ontvangt de winkelwagen vanaf bestellen.html, herberekent de prijs
// server-side (nooit de klant vertrouwen — ook niet voor extras of
// kortingscodes), en start een iDEAL-betaling via Mollie. Geeft de
// checkout-URL terug zodat de klant kan afrekenen.
//
// Benodigde environment variable (Cloudflare Pages > Settings > Environment variables):
//   MOLLIE_API_KEY  — test_... of live_... key uit het Mollie-dashboard

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
    const alleProducten = catalogus.categorieen.flatMap((c) => c.producten);
    const productMap = new Map(alleProducten.map((p) => [p.id, p]));

    let totaal = 0;
    const orderRegels = [];
    for (const regel of items) {
      const product = productMap.get(regel.id);
      if (!product) {
        return json({ error: `Onbekend product: ${regel.id}` }, 400);
      }
      const aantal = Math.max(1, Math.min(20, parseInt(regel.aantal, 10) || 1));

      // Extras server-side herberekenen — nooit een door de klant
      // meegestuurde prijs vertrouwen, alleen de gekozen optie-index.
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
      totaal += subtotaal;
      orderRegels.push({
        id: product.id,
        naam: product.naam,
        prijs: perStuk,
        extras: extraOmschrijvingen.join(", "),
        aantal,
        subtotaal,
      });
    }
    totaal = Math.round(totaal * 100) / 100;

    if (totaal <= 0) {
      return json({ error: "Ongeldig totaalbedrag." }, 400);
    }

    // Kortingscode — server-side de enige bron van waarheid.
    let korting = 0;
    let toegepasteCode = null;
    if (couponCode) {
      const coupon = await vindGeldigeCoupon(request, couponCode, totaal);
      if (!coupon.geldig) {
        return json({ error: coupon.foutmelding || "Deze kortingscode is niet (meer) geldig." }, 400);
      }
      korting = coupon.korting;
      toegepasteCode = coupon.code;
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

    return json({ checkoutUrl, orderId, totaal, korting });
  } catch (err) {
    return json({ error: "Onverwachte fout.", detail: String(err) }, 500);
  }
}

async function vindGeldigeCoupon(request, code, subtotaal) {
  const couponsUrl = new URL("/coupons.json", request.url);
  const res = await fetch(couponsUrl.toString());
  if (!res.ok) {
    return { geldig: false, foutmelding: "Kon kortingscodes niet controleren." };
  }
  const data = await res.json();
  const lijst = Array.isArray(data.coupons) ? data.coupons : [];
  const coupon = lijst.find((c) => (c.code || "").toUpperCase() === String(code).toUpperCase());

  if (!coupon || coupon.actief === false) {
    return { geldig: false, foutmelding: "Deze kortingscode bestaat niet (meer)." };
  }
  if (coupon.geldigTot && new Date(coupon.geldigTot) < new Date()) {
    return { geldig: false, foutmelding: "Deze kortingscode is verlopen." };
  }
  if (coupon.minimumBedrag && subtotaal < coupon.minimumBedrag) {
    return {
      geldig: false,
      foutmelding: `Deze code is geldig vanaf een besteding van ${coupon.minimumBedrag.toFixed(2).replace(".", ",")} euro.`,
    };
  }

  let korting = 0;
  if (coupon.type === "percentage") {
    korting = subtotaal * (coupon.waarde / 100);
  } else {
    korting = Math.min(coupon.waarde, subtotaal);
  }
  korting = Math.round(korting * 100) / 100;

  return { geldig: true, korting, code: coupon.code, type: coupon.type, waarde: coupon.waarde, omschrijving: coupon.omschrijving };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
