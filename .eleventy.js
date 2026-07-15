module.exports = function (eleventyConfig) {

  // Statische bestanden 1-op-1 meekopiëren naar de build-output.
  // (cart.js blijft ongewijzigd — de nieuwe kaarten krijgen exact dezelfde
  // data-name/data-unit/data-price-structuur, dus cart.js hoeft niet aangepast.)
  eleventyConfig.addPassthroughCopy("src/cart.js");
  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/sitemap.xml");
  eleventyConfig.addPassthroughCopy("src/index.html");
  eleventyConfig.addPassthroughCopy("src/voorwaarden.html");

  // Actie-pop-up (homepage): platte JSON-databestand, door Decap CMS
  // rechtstreeks in dit formaat weggeschreven (geen Eleventy-verwerking
  // nodig — index.html haalt 'm zelf op met fetch("actie.json")).
  eleventyConfig.addPassthroughCopy("src/actie.json");

  // Decap CMS admin-UI (config.yml + index.html) gewoon meekopiëren.
  eleventyConfig.addPassthroughCopy("admin");

  // Collectie "producten": alle .md-bestanden die Decap CMS beheert.
  eleventyConfig.addCollection("producten", (api) =>
    api.getFilteredByGlob("src/producten/*.md")
  );

  // Collectie "faq": vraag/antwoord-items voor catering.html + verhuur.html,
  // gesorteerd op het "volgorde"-veld (laag naar hoog).
  eleventyConfig.addCollection("faq", (api) =>
    api
      .getFilteredByGlob("src/faq/*.md")
      .sort((a, b) => (a.data.volgorde || 0) - (b.data.volgorde || 0))
  );

  // Collectie "vacatures": open functies voor solliciteren.html.
  eleventyConfig.addCollection("vacatures", (api) =>
    api.getFilteredByGlob("src/vacatures/*.md")
  );

  // Helper in templates: geeft true terug als een product nog een
  // placeholder is (geen (echte) prijs ingevuld — zelfde logica als de
  // huidige "tofill"-kaarten op de site).
  eleventyConfig.addFilter("isPlaceholder", (prijs) => {
    return !prijs || Number(prijs) <= 0;
  });

  // Prijs met komma i.p.v. punt, twee decimalen (bijv. 14.75 -> 14,75).
  eleventyConfig.addFilter("euro", (prijs) => {
    const n = Number(prijs) || 0;
    return n.toFixed(2).replace(".", ",");
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
    // BELANGRIJK: alleen .njk (onze pagina's) en .md (de CMS-content) zijn
    // "templates" die Eleventy/Nunjucks verwerkt. index.html en
    // voorwaarden.html zijn kant-en-klare, statische bestanden — als .html
    // hier ook in staat, probeert Eleventy ze als Nunjucks-template te
    // parsen (en verandert het zelfs hun bestandspad), wat de echte inhoud
    // kan verminken. addPassthroughCopy hierboven kopieert ze daarom 1-op-1.
    templateFormats: ["njk", "md"],
  };
};
