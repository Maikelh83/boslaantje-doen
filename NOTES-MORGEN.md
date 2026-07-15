# Wat er klaarstaat + wat morgen nog moet

## Wat af is en getest
Deze map is een **complete, echt gebouwde en gecontroleerde** Eleventy-site + Decap CMS-config — geen losse fragmenten. `npx eleventy` draait foutloos en produceert alle vijf pagina's (`index.html`, `catering.html`, `verhuur.html`, `solliciteren.html`, `voorwaarden.html`) met exact dezelfde styling, data-attributen en cart.js-koppeling als nu live staat. Ik heb de bestaande site (jouw eigen lokale kopie, incl. het echte lettertype, logo en de favicons) gebruikt als bron, dus dit is geen nabouwsel maar de site zelf, nu CMS-gestuurd op vier punten:

1. **Producten** (`src/producten/*.md`, 9 stuks) — catering- en verhuurkaarten op `catering.html`/`verhuur.html`.
2. **Veelgestelde vragen** (`src/faq/*.md`, 11 stuks) — FAQ-secties op beide pagina's.
3. **Vacatures** (`src/vacatures/*.md`, 2 stuks) — vacaturekaarten én de functie-keuzelijst op `solliciteren.html`.
4. **Actie-pop-up** (`src/actie.json`, 1 bestand) — de pop-up op de homepage, nu foto-gebaseerd.

Alles is met `npx eleventy --output=/tmp/...` gebouwd en gecontroleerd: geen placeholders meer, geen kapotte paden, het echte lettertype/logo (base64) staat er letterlijk in — niet als "vervang dit morgen"-tekst.

### Producten
- `src/_includes/product-card.njk` genereert de `.pkg`-kaart, inclusief de "tofill"-placeholderstijl (prijs = 0) en cart.js-compatibele `data-name`/`data-unit`/`data-price`.
- Twee bewuste, kleine afwijkingen van je oorspronkelijke 5-veldenlijst (Naam/Omschrijving/Prijs+eenheid/Categorie/Foto):
  1. **Subcategorie (select, verplicht)** — nodig om de bestaande indeling in blokjes ("Feest & BBQ"/"Borrel & hapjes" enz.) te behouden. Zonder dit veld komt alles in één grid.
  2. **Eenheid beperkt tot 3 keuzes** (p.p. / per stuk / per dag), exact zoals in je briefing — een paar prijsregels tonen daardoor iets korter (bijv. Statafel: "per dag" i.p.v. "stuk · per dag"). Cosmetisch, geen functionele impact.
- Zonder geüploade foto tonen kaarten een neutraal camera-icoontje i.p.v. de huidige unieke handgetekende icoontjes. Prima tijdelijk, overweeg pas te vervangen zodra er (ook telefoon-)foto's zijn.

### FAQ en Vacatures
- Werken op dezelfde manier als Producten: aanmaken/bewerken/verwijderen in het CMS, volgorde instelbaar bij FAQ, vacatures met een "Actief"-schakelaar zodat je een vacature kunt verbergen zonder 'm te verwijderen.
- `solliciteren.html` is nu volledig CMS-gestuurd: de kaarten én de opties in de "Functie"-keuzelijst van het sollicitatieformulier komen automatisch uit de Vacatures-collectie.

### Actie-pop-up (nieuw t.o.v. je oorspronkelijke plan — jij vroeg hierom)
De bestaande tekst/prijslijst-pop-up ("Winterspecials") is vervangen door een **foto-gebaseerde** versie: jij ontwerpt de hele pop-up zelf in Canva (bijv. "Gesloten met vakantie") en uploadt 'm als één plaatje.
- CMS-collectie "Actie-pop-up (homepage)" → één foto, aan/uit-schakelaar, optionele link (bijv. naar de bestelpagina — leeg laten = niet klikbaar), vertraging in seconden, aantal dagen niet opnieuw tonen, optionele einddatum.
- Technisch: dit is een los databestand (`src/actie.json`) dat Decap rechtstreeks wegschrijft; `index.html` haalt het bij het laden op. Geen Eleventy-sjabloon nodig, dus de rest van de homepage blijft **volledig ongewijzigd** — precies zoals je had gevraagd ("teksten, layout en homepage blijven vast").
- Staat standaard op **uit** (`actief: false`) tot je 'm morgen zelf aanzet met een echte foto.

## Wat NIET (meer) hoeft te gebeuren
Deze stonden in een eerdere versie van deze notities als "morgen nog doen" — dat is nu al gedaan:
- ~~Base64-placeholders voor lettertype/logo handmatig kopiëren~~ — al verwerkt, uit je eigen live bestand overgenomen.
- ~~images/, sitemap.xml, index.html, solliciteren.html, voorwaarden.html losstaand toevoegen~~ — al in `src/` gezet en in `.eleventy.js` correct meegenomen. (De oude statische `solliciteren.html` is vervangen door het nieuwe CMS-gestuurde `src/solliciteren.njk`.)

## Morgen, in volgorde
1. **Repo koppelen aan Cloudflare Pages** — build command `npx @11ty/eleventy`, output directory `_site`.
2. **GitHub OAuth-app + Cloudflare Worker-proxy** voor Decap-login instellen (verwacht lastigste stap — reken op wat troubleshooting).
3. In `admin/config.yml`: `repo:` en `base_url:` controleren/invullen (staan nu als duidelijke placeholder-comments).
4. **End-to-end testen**, per collectie:
   - Producten: prijs aanpassen → committen → site bouwt opnieuw → kaart verandert → aanvraaglijst werkt nog.
   - FAQ/Vacatures: een vraag of vacature toevoegen → verschijnt op de juiste pagina.
   - Actie-pop-up: een Canva-foto uploaden, "actief" aanzetten → pop-up verschijnt na een paar seconden op de homepage, wegklikken werkt, komt na X dagen niet meteen terug.
5. Als alles werkt: Chantal een korte rondleiding geven in de CMS-login (Settings → toegang, of gewoon het GitHub-account gebruiken dat je instelt).
