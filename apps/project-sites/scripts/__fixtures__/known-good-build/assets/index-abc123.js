// Synthetic known-good bundle: carries the exact string markers the bundle-grep validators
// require (validateLightboxPresence → data-zoomable + data-gallery; validateThemeFontLoader
// → ps-theme-fonts). Real builds minify these; the string literals survive minification.
(function () {
  var lightbox = { selector: '[data-zoomable]', gallery: '[data-gallery]' };
  function injectThemeFonts() {
    var l = document.createElement('link');
    l.id = 'ps-theme-fonts';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter&display=swap';
    document.head.appendChild(l);
  }
  injectThemeFonts();
  return lightbox;
})();
