// functions/api/coupon-check.js
// Cloudflare Pages Function — POST /api/coupon-check
//
// Lichte preview-check zodat de klant vóór het afrekenen al ziet of een
// kortingscode geldig is en wat de korting wordt. De echte, bindende
// controle gebeurt hierna nogmaals in /api/order (nooit de client vertrouwen).

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
    const coupon = lijst.find((c) => (c.code || "").toUpperCase() === code.toUpperCase());

    if (!coupon || coupon.actief === false) {
      return json({ geldig: false, foutmelding: "Deze kortingscode bestaat niet (meer)." });
    }
    if (coupon.geldigTot && new Date(coupon.geldigTot) < new Date()) {
      return json({ geldig: false, foutmelding: "Deze kortingscode is verlopen." });
    }
    if (coupon.minimumBedrag && veiligSubtotaal < coupon.minimumBedrag) {
      return json({
        geldig: false,
        foutmelding: `Deze code is geldig vanaf een besteding van ${coupon.minimumBedrag.toFixed(2).replace(".", ",")} euro.`,
      });
    }

    return json({
      geldig: true,
      type: coupon.type,
      waarde: coupon.waarde,
      omschrijving: coupon.omschrijving,
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
