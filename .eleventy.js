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
