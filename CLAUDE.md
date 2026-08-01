# CLAUDE.md

Deze repo is de volledige website + bestel-/kassasysteem van **Snackbar De Boslaan** (Boslaantje Doen), Veenendaal. Dit bestand geeft een AI-assistent (of een nieuwe developer) de context om hierin te werken zonder alle geschiedenis opnieuw te hoeven ontdekken.

## Wat dit project is

Één Cloudflare Pages-project (`boslaantjedoen.com`) dat drie dingen tegelijk is:

1. **Marketingsite** — homepage, menu, FAQ, voorwaarden, vacatures. Gebouwd met Eleventy (statische site generator) + Decap CMS voor content die niet-technisch beheerd moet kunnen worden.
2. **Klant-bestelsysteem** — `bestellen.html`: menu, winkelwagen, extra's, coupons/acties, bezorgzone-check, tijdslot-kiezer, Mollie-betaling, zakelijke accounts (op factuur).
3. **Intern bedrijfssysteem voor personeel** — kassa (POS), keukenscherm, bezorger-app (PWA) met routes/ritten, personeelsplanning, loyaliteitssysteem, marketingdashboard. Allemaal los toegankelijke `/kassa-*.html`-pagina's, wachtwoord- of personeelsnummer-gated.

Geen React/Vue/framework: alles is losse HTML-bestanden met inline `<script>`/`<style>`, vanilla JS, `fetch()` naar Cloudflare Pages Functions. Bewuste keuze — simpel te onderhouden zonder buildstap voor logica.

## Techstack & architectuur

- **Hosting**: Cloudflare Pages, gekoppeld aan GitHub-repo `Maikelh83/boslaantje-doen`, branch `main`. Elke commit op `main` triggert automatisch een nieuwe deploy (~30–60 sec).
- **Static site generator**: Eleventy (`.eleventy.js`). Input `src/`, output `_site/`. Let op: alleen `.njk` en `.md` worden door Eleventy als templates verwerkt — losse `.html`-bestanden (zoals `index.html`, `bestellen.html`, alle `kassa-*.html`) worden 1-op-1 gekopieerd via `addPassthroughCopy`, *niet* door Nunjucks geparsed. Nieuw `.html`-bestand toevoegen aan `src/`? Vergeet niet de passthrough-regel in `.eleventy.js` toe te voegen, anders komt het niet in de build terecht.
- **Backend**: Cloudflare Pages Functions (`functions/api/**/*.js`). Elke functie exporteert `onRequestGet`/`onRequestPost` enz. Serverless, draait per request.
- **Database**: Cloudflare D1 (SQLite), database `boslaantje-orders`. Geen ORM — rechtstreeks `env.DB.prepare(sql).bind(...).all()/.first()/.run()`.
- **CMS**: Decap CMS (`admin/`) voor content-collecties die niet-technisch beheerd worden (producten, FAQ, vacatures, actie-pop-up), via GitHub OAuth.
- **Betalingen**: Mollie (online, klant-bestellingen) + SumUp Tap-to-Pay (aan de deur / kassa, via affiliate-link `generateSumUpUrl`).
- **Kaarten/afstand**: Mapbox (geocoding + afstandsberekening voor bezorgzone en bezorger-app).
- **Automatisering buiten deze repo**: Make.com-scenario's (storingsmeldingen naar Facebook/Instagram, WeFact-facturatie voor zakelijke klanten) en een losse Cloudflare Worker (`cf-worker-status/`) voor storing-detectie.

## Belangrijke conventies (niet doorbreken zonder reden)

- **Elke Pages Function is zelfstandig.** Logica wordt bewust gedupliceerd in plaats van gedeeld, met als enige uitzondering `functions/api/auth/_lib.js` — dat is de ene gedeelde module (sessie-helpers, wachtwoord-hashing, D1-migratiehelpers, Mapbox-geocoding, bezorgzone-logica). Nieuwe gedeelde logica hoort daar, niet in een nieuw shared-bestand.
- **D1-migraties zijn altijd additief.** Nooit `DROP TABLE`/`ALTER TABLE ... DROP COLUMN` of andere destructieve wijzigingen. Patroon: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN` in een try/catch (kolom-bestaat-al-fouten worden genegeerd). Elke `zorgVoorXTabellen(db)`-functie in `_lib.js` wordt aan het begin van elke request die de tabel nodig heeft aangeroepen — idempotent, dus geen aparte migratiestap nodig bij deploys.
- **Personeelsnummer + pincode/NFC is hét personeelslogin-systeem.** Sessies leven in de `bezorger_sessies`-tabel (14 uur geldig), via `maakBezorgerSessie`/`controleerBezorgerSessie` in `_lib.js`. De naam "bezorger_sessies" is historisch (oorspronkelijk alleen voor de bezorger-app) maar wordt nu breder gebruikt (ook personeelsplanning). Bewust niet hernoemd om niet alle bestaande call sites te hoeven aanpassen — als je hier iets aan toevoegt, gebruik dezelfde tabel, verzin geen tweede sessiesysteem.
- **Staff-wachtwoord-gate** (los van personeelsnummer-login): admin-pagina's (`kassa.html`, `kassa-ritten.html`, `kassa-planning.html`, `kassa-bezorgzone.html`, `kassa-zakelijke-klanten.html`, `kassa-personeel.html`) checken `?wachtwoord=` tegen de Cloudflare-secret `STAFF_LOYALTY_PASSWORD`. Client-side opgeslagen in `sessionStorage` (`bd_loyalty_pw`), gevalideerd via een dummy-call naar een bestaande endpoint (401 = fout wachtwoord).
- **Git-based editing workflow (geen lokale checkout nodig):** wijzigingen worden gemaakt in een tijdelijke clone, gesyntax-checked (`node --check` voor `.js`, en voor inline `<script>` in `.html` het script-blok extraheren en apart checken), en geüpload via de GitHub-webinterface (`/upload/main/<pad>`) — bestandsnaam moet exact overeenkomen om te overschrijven. Na commit: byte-verifiëren tegen `raw.githubusercontent.com`, dan live checken op `boslaantjedoen.com` (reken op ~30–60 sec Cloudflare Pages build-vertraging).
- **producten.json** is de centrale menu-catalogus (`categorieen[]` → `producten[]`, elk met id/naam/prijs/beschrijving/foto/extras). Wordt gebruikt door zowel `bestellen.html` (klant) als `kassa.html` (personeel/POS) — één bron van waarheid, dus wijzigingen hier raken beide.
- **Orders-tabel (`orders`) is de centrale tabel** voor zowel online bestellingen (Mollie) als kassa-orders als bezorgorders. Belangrijke kolommen: `status`, `betaalmethode` (`ideal`/`kassa`/`aan_de_deur`/...), `betaalstatus` (`betaald`/`onbetaald`), `levering` (`afhalen`/`bezorgen`), `rit_id` (koppeling naar bezorgritten), `items_json` (line items als JSON-string).

## Belangrijkste features (chronologisch/thematisch gebouwd)

1. **Marketingsite** — homepage, menu met echte prijzen, FAQ, voorwaarden, sollicitatiepagina, SEO (schema.org, sitemap, canonical), Meta Pixel + GA4 achter cookie-consent, PWA-installatiebanner.
2. **Decap CMS-lokale content** — producten (catering/verhuur, inmiddels grotendeels uitgefaseerd na focus-shift naar cafetaria-only), FAQ, vacatures, actie-pop-up — allemaal los beheerbare `.md`/`.json`-collecties.
3. **Storingssysteem** — handmatige storing/herstel-knoppen (`storing-paneel.html`, wachtwoord-gated, elke ochtend opnieuw vergrendeld) die een banner op de site tonen én automatisch een Facebook/Instagram-post triggeren via Make.com.
4. **Bestelsysteem (`bestellen.html`)** — volledig herbouwd in Domino's/NY Pizza-geïnspireerde UX: categorie-iconen, extra's-wizard, upsell-pop-up, promo-carrousel, sticky mobiele winkelmandbalk, gestapte checkout (gegevens/adres/tijdslot/overzicht), coupons + drempelacties + gratis-productacties, live orderstatuspagina.
5. **Betalingen** — Mollie voor online iDEAL-betalingen; webhook verwerkt status en triggert keukenscherm.
6. **Loyaliteitssysteem** — spaarkaarten (Piggy-vervanger), aanmaken/zegels toekennen via `kassa-loyaliteit.html`, gekoppeld aan checkout op `bestellen.html` én aan bestaande fysieke pasjes.
7. **POS-kassa (`kassa.html`)** — volledig kassascherm met winkelwagen, multi-select extra's (1:1 audit tegen oude CashDesk-kassa), numpad + wisselgeldberekening, Bezorgen-toggle met adresvelden.
8. **Keukenscherm (`kassa-keuken.html`)** — digitale werkbon, toont live alle betaalde bestellingen (kassa + online + Thuisbezorgd), incl. gewenst tijdstip en Thuisbezorgd-badge/opmerkingen.
9. **Thuisbezorgd-integratie** — inkomende webhook (`functions/api/integrations/thuisbezorgd.js`) zet Thuisbezorgd-orders door naar hetzelfde keukenscherm/orders-systeem.
10. **Zakelijke klanten (pijler 7)** — account-registratie/login, admin-goedkeuring + korting/factuurdrempel per klant (`kassa-zakelijke-klanten.html`), "Op Factuur"-orderflow (geen Mollie) met WeFact-koppeling, tijdslot-gating (vrijdaglunch + cut-off tijd).
11. **Bezorgzone** — Mapbox-afstandscontrole bij bezorgen: admin stelt max. afstand + gestaffelde bezorgkosten in (`kassa-bezorgzone.html`), live check + blokkade + kostenberekening in `bestellen.html`, server-side gevalideerd in `order.js`.
12. **Ritten & bezorger-app (PWA)** — orders bundelen tot ritten (`kassa-ritten.html`), bezorger-app (`kassa-bezorger.html`) met stop-voor-stop navigatie, Mapbox-kaartje per stop, "Zelf orders kiezen"-scherm, "Vergeten Producten Waarschuwing" (waarschuwt voor gekoelde items — milkshakes/ijs/dranken/salade — die makkelijk vergeten worden), PIN-betaling aan de deur via SumUp, eigen PWA-installatie-icoon (fietskoerier), los van de hoofd-personeelspagina.
13. **Personeelsnummer-fundament** — `medewerkers`-tabel (personeelsnummer, naam, pincode-hash, NFC-tag), beheerd via `kassa-personeel.html`. NFC-login + numpad-pincode-fallback voor de bezorger-app. Sessiesysteem (zie conventies hierboven) inmiddels ook hergebruikt voor personeelsplanning.
14. **Personeelsplanning** — weekrooster (grid-weergave: medewerkers × dagen, Tamigo-geïnspireerd, klik-op-cel om dienst toe te voegen/bewerken/verwijderen via modal, totaalrij/-kolom, badges voor beschikbaarheid/verlof), beschikbaarheid doorgeven, verlof/ziekmeldingen (met goedkeuren/afwijzen + tellerbadges), werkuren indienen/goedkeuren. Beheerpagina `kassa-planning.html` (staff-wachtwoord), medewerker-pagina `personeel-rooster.html` (personeelsnummer+pincode).
15. **Marketingdashboard (`dashboard.html`)** — omzet/orderoverzicht, wachtwoord-gated, leest via `/api/dashboard-data`.

## D1-schema (belangrijkste tabellen)

- `orders` — centrale ordertabel (zie conventies hierboven voor kernkolommen).
- `accounts`, `business_profiles`, `sessions` — zakelijke klantaccounts + web-sessies (cookie-based, apart van het personeelsnummer-sessiesysteem).
- `instellingen` — generieke sleutel/waarde-instellingen (o.a. minimum factuurbedrag).
- `medewerkers` — personeelsnummer (PK), naam, pincode_hash/salt, actief, nfc_tag_id.
- `bezorger_sessies` — sessie_token (PK), personeelsnummer, verloopt_op (14 uur geldig). Gebruikt door bezorger-app én personeelsplanning-medewerkerkant.
- `ritten` — bezorgritten (bundels van orders voor één bezorger/rit).
- `shifts`, `beschikbaarheid`, `verlof_aanvragen`, `werkuren` — personeelsplanning (additief toegevoegd, alle vier teruggrijpend op `medewerkers.personeelsnummer`).

Alle migraties staan als `zorgVoorXTabellen(db)`-functies in `functions/api/auth/_lib.js`.

## Benodigde environment variables / secrets (Cloudflare Pages settings)

- `DB` — D1-database binding.
- `STAFF_LOYALTY_PASSWORD` — gedeeld personeelswachtwoord voor alle `/kassa-*` admin-pagina's.
- `MOLLIE_API_KEY` — voor online betalingen.
- `MAPBOX_ACCESS_TOKEN` — geocoding + afstandsberekening.
- SumUp affiliate key + app-id — Tap-to-Pay links.
- (Losse Cloudflare Worker `cf-worker-status/` heeft eigen secrets voor storingsdetectie + Make.com-webhook.)

## Wat nog open staat / TODO

- **Domeinstrategie .com vs .nl uitzoeken** — nog geen definitieve keuze gemaakt tussen de twee domeinen.
- **Mollie API-key + Make-webhook definitief instellen en end-to-end testen in testmodus** — actiepunt bij Maikel zelf, nog niet afgerond.
- **POS-kassa: volledig testen, committen en live verifiëren** — grotendeels gebouwd maar de eind-testronde staat nog open.
- **Personeelsplanning: end-to-end testen door Maikel zelf** — het systeem (weekrooster, beschikbaarheid, verlof, uren) is gebouwd en live, maar Maikel heeft zelf nog niet bevestigd dat inloggen op zowel `kassa-planning.html` (staff-wachtwoord) als `personeel-rooster.html` (personeelsnummer 1 + eigen pincode) goed werkt.
- **Mogelijke toekomstige uitbreiding**: NFC-tik-login toevoegen aan `personeel-rooster.html` (nu alleen personeelsnummer+pincode, bewust simpel gehouden bij bouw).
- **CCV-pinkoppeling voor de kassa** — personeel toetst het bedrag nu nog handmatig over op een los pinapparaat; een directe koppeling is nog niet gebouwd (protocol/terminal nog niet vastgesteld).
- **Bonprinter in de keuken** — keukenscherm is de huidige oplossing; een fysieke bonprinter was als alternatief overwogen maar niet gebouwd.

## Werkwijze bij nieuwe wijzigingen

1. Wijziging altijd eerst syntax-checken vóór upload (`node --check` voor `.js`; extraheer en check inline `<script>`-blokken in `.html` apart).
2. Nooit destructieve D1-migraties — alleen additief (zie conventies).
3. Na commit op GitHub: wacht op de Cloudflare Pages-rebuild (~30–60 sec) voordat je live gaat verifiëren.
4. Nieuwe `.html`-pagina in `src/`? Voeg 'm toe aan `.eleventy.js` (`addPassthroughCopy`), anders verschijnt hij niet in de live build.
5. Bij twijfel over een bestaand patroon (auth, D1-migratie, admin-gating): zoek een vergelijkbare bestaande Pages Function op en volg exact hetzelfde patroon — consistentie weegt zwaarder dan een "betere" aanpak voor één losse functie.
