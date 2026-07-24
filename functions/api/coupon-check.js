// functions/api/coupon-check.js
// Cloudflare Pages Function — POST /api/coupon-check
//
// Lichte preview-check zodat de klant vóór het afrekenen al ziet of een
// kortingscode geldig is en wat de korting wordt. De echte, bindende
// controle gebeurt hierna nogmaals in /api/order (nooit de client vertrouwen).
// Alleen code-gebaseerde acties van het type 'percentage' of 'vast' kunnen
// hier worden ingevoerd — automatische acties (gratis product/drempel)
// worden rechtstreeks door bestellen.html uit coupons.json gehaald.

export async function onRequestPost(context) {
  const { request } = context;

  try {
    const body = await request.json();
    const { code, subtotaal } = body || {};

    if (!code || typeof code !== "string") {
      return json({ geldig: false, foutmelding: "Vul een kortingscode in." });
    }
    const veiligSubtotaal = Math.max(0, Number(subtotaal) || 0);

    const couponsUrl = new URL("/coupons.json", request.url);
    const res = await fetch(couponsUrl.toString());
    if (!res.ok) {
      return json({ geldig: false, foutmelding: "Kon kortingscodes niet controleren." });
    }
    const data = await res.json();
    const lijst = Array.isArray(data.coupons) ? data.coupons : [];
    const actie = lijst.find((c) => c.code && c.code.toUpperCase() === code.toUpperCase());

    if (!actie || actie.actief === false) {
      return json({ geldig: false, foutmelding: "Deze kortingscode bestaat niet (meer)." });
    }

    const nu = new Date();
    if (actie.geldigVanaf && nu < new Date(actie.geldigVanaf)) {
      return json({ geldig: false, foutmelding: "Deze kortingscode is nog niet geldig." });
    }
    if (actie.geldigTot && nu > new Date(actie.geldigTot + "T23:59:59")) {
      return json({ geldig: false, foutmelding: "Deze kortingscode is verlopen." });
    }
    if (actie.type !== "percentage" && actie.type !== "vast") {
      return json({ geldig: false, foutmelding: "Deze code kan niet via het kortingsveld worden toegepast." });
    }

    const trigger = actie.trigger || {};
    if (trigger.minimumBedrag && veiligSubtotaal < trigger.minimumBedrag) {
      return json({
        geldig: false,
        foutmelding: `Deze code is geldig vanaf een besteding van ${trigger.minimumBedrag.toFixed(2).replace(".", ",")} euro.`,
      });
    }

    return json({
      geldig: true,
      type: actie.type,
      waarde: actie.waarde,
      omschrijving: actie.omschrijving,
    });
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
