module.exports = function (eleventyConfig) {

// Statische bestanden 1-op-1 meekopiëren naar de build-output.
eleventyConfig.addPassthroughCopy('src/robots.txt');
// Cloudflare Pages-redirects (voorbereid voor fase 2 van de merksplitsing,
// zie NOTES-MORGEN.md en src/_redirects zelf voor uitleg).
eleventyConfig.addPassthroughCopy('src/_redirects');
eleventyConfig.addPassthroughCopy('src/images');
eleventyConfig.addPassthroughCopy('src/sitemap.xml');
eleventyConfig.addPassthroughCopy('src/index.html');
eleventyConfig.addPassthroughCopy('src/voorwaarden.html');
eleventyConfig.addPassthroughCopy('src/menu.html');
eleventyConfig.addPassthroughCopy('src/veelgestelde-vragen.html');
eleventyConfig.addPassthroughCopy('src/storing-paneel.html');

// Bestelpagina (test/MVP): menu + winkelwagen + koppeling met de
// Cloudflare Functions in /functions/api voor Mollie-betalingen.
eleventyConfig.addPassthroughCopy('src/bestellen.html');
eleventyConfig.addPassthroughCopy('src/bestellen-bedankt.html');
eleventyConfig.addPassthroughCopy('src/producten.json');
// Kortingscodes voor de bestelpagina — bewerk dit bestand om codes toe
// te voegen/aan te passen (zie _opmerking in het bestand zelf).
eleventyConfig.addPassthroughCopy('src/coupons.json');
// Marketingdashboard (wachtwoord-beveiligd, leest via /api/dashboard-data uit D1).
eleventyConfig.addPassthroughCopy('src/dashboard.html');
// Loyaliteitssysteem: personeelspagina (kassa) — wachtwoord-beveiligd,
// spaarkaarten aanmaken en zegels toekennen via /api/loyalty-*.
eleventyConfig.addPassthroughCopy('src/kassa-loyaliteit.html');
// POS-kassa: bestelscherm + winkelwagen voor personeel achter de balie,
// koppelt via /api/kassa-order. Fase 1: personeel toetst het te betalen
// bedrag nog zelf over op het losse pinapparaat (CCV-koppeling volgt later
// zodra duidelijk is welk protocol/terminal daarvoor werkt).
eleventyConfig.addPassthroughCopy('src/kassa.html');
// Keukenscherm: digitale werkbon voor personeel in de keuken — toont
// live alle betaalde kassa- en online bestellingen (koppelt via
// /api/keuken-orders en /api/keuken-klaar) totdat de losse bonprinter
// er is. Zie NOTES-MORGEN.md voor de afweging scherm vs. printer.
eleventyConfig.addPassthroughCopy('src/kassa-keuken.html');

// Admin/personeelspagina voor pijler 7 (zakelijke accounts): goedkeuren,
// korting/factuur-instellingen per klant beheren, drempelbedrag instellen.
// Koppelt via /api/admin/zakelijke-klanten (staff-wachtwoord-gated).
eleventyConfig.addPassthroughCopy('src/kassa-zakelijke-klanten.html');

// Actie-pop-up (homepage): platte JSON-databestand, door Decap CMS
// rechtstreeks in dit formaat weggeschreven (geen Eleventy-verwerking
// nodig — index.html haalt 'm zelf op met fetch('actie.json')).
eleventyConfig.addPassthroughCopy('src/actie.json');

// Decap CMS admin-UI (config.yml + index.html) gewoon meekopiëren.
eleventyConfig.addPassthroughCopy('admin');

// Collectie 'vacatures': open functies voor solliciteren.html.
eleventyConfig.addCollection('vacatures', (api) =>
api.getFilteredByGlob('src/vacatures/*.md')
);

return {
dir: {
input: 'src',
output: '_site',
includes: '_includes',
},
htmlTemplateEngine: 'njk',
markdownTemplateEngine: 'njk',
// BELANGRIJK: alleen .njk (onze pagina's) en .md (de CMS-content) zijn
// 'templates' die Eleventy/Nunjucks verwerkt. index.html en
// voorwaarden.html zijn kant-en-klare, statische bestanden — als .html
// hier ook in staat, probeert Eleventy ze als Nunjucks-template te
// parsen (en verandert het zelfs hun bestandspad), wat de echte inhoud
// kan verminken. addPassthroughCopy hierboven kopieert ze daarom 1-op-1.
templateFormats: ['njk', 'md'],
};
};
