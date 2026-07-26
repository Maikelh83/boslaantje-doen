// functions/api/auth/me.js
// GET /api/auth/me — huidige sessie opvragen (voor bestellen.html om te
// weten of er een ingelogde particuliere/zakelijke klant is, en om de
// exclusieve vrijdaglunch-tijdsloten + korting + factuuroptie te tonen).

import { zorgVoorAccountTabellen, haalIngelogdeGebruikerOp, json } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return json({ ingelogd: false });
    await zorgVoorAccountTabellen(env.DB);
    const gebruiker = await haalIngelogdeGebruikerOp(env.DB, request);
    if (!gebruiker) return json({ ingelogd: false });

    return json({
      ingelogd: true,
      account: {
        id: gebruiker.account.id,
        email: gebruiker.account.email,
        naam: gebruiker.account.naam,
        telefoon: gebruiker.account.telefoon,
        accountType: gebruiker.account.account_type,
      },
      business: gebruiker.business
        ? {
            bedrijfsnaam: gebruiker.business.bedrijfsnaam,
            kvkNummer: gebruiker.business.kvk_nummer,
            btwNummer: gebruiker.business.btw_nummer,
            afdeling: gebruiker.business.afdeling,
            factuurEmail: gebruiker.business.factuur_email,
            businessApproved: !!gebruiker.business.business_approved,
            factuurToegestaan: !!gebruiker.business.factuur_toegestaan,
            customDiscountPercentage: gebruiker.business.custom_discount_percentage,
            overrideMinimumInvoiceAmount: !!gebruiker.business.override_minimum_invoice_amount,
          }
        : null,
    });
  } catch (err) {
    console.error("auth/me fout:", err);
    return json({ ingelogd: false });
  }
}
