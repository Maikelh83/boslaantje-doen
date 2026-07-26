// ============================================================================
// PWA Install Banner — herbruikbaar over meerdere merken/domeinen
// ============================================================================
// Eén <script src="/pwa-install.js" defer></script> vóór </body> regelt:
//   1. <link rel="manifest"> + theme-color meta + apple-*-meta injecteren
//   2. Service worker registreren (nodig voor installeerbaarheid)
//   3. Slimme install-banner tonen (timing + platform-afhandeling + branding)
//
// Branding per domein: zie PWA_BRAND_CONFIGS hieronder. Nu alleen Boslaantje
// Doen actief; Vers & Belegd heeft nog geen eigen site — voeg die later toe
// als apart object onder het eigen domein, de rest van de logica werkt dan
// automatisch mee (geen code-wijzigingen nodig, alleen config).
// ============================================================================

(function () {
  'use strict';

  try {
    // ------------------------------------------------------------------
    // A. Branding-configuratie per domein
    // ------------------------------------------------------------------
    var PWA_BRAND_CONFIGS = {
      'boslaantjedoen.com': {
        appName: 'Boslaantje Doen',
        tagline: 'Bestel sneller: patat, snacks & meer',
        themeColor: '#4A5D3D',
        accentColor: '#9C6355',
        backgroundColor: '#F5F3EF',
        inkColor: '#1B1B18',
        iconUrl: '/images/icon-192.png',
        manifestUrl: '/manifest.json',
        swUrl: '/sw.js'
      }
      // Voorbeeld voor later (Vers & Belegd, zodra die site live is):
      // 'versenbelegd.nl': {
      //   appName: 'Vers & Belegd',
      //   tagline: 'Bestel je zakelijke lunch',
      //   themeColor: '#...',
      //   accentColor: '#...',
      //   backgroundColor: '#...',
      //   inkColor: '#...',
      //   iconUrl: '/images/icon-192.png',
      //   manifestUrl: '/manifest.json',
      //   swUrl: '/sw.js'
      // }
    };
    var DEFAULT_BRAND_KEY = 'boslaantjedoen.com';

    function getBrandConfig() {
      var host = (window.location.hostname || '').replace(/^www\./, '');
      return PWA_BRAND_CONFIGS[host] || PWA_BRAND_CONFIGS[DEFAULT_BRAND_KEY];
    }

    var brand = getBrandConfig();
    if (!brand) return; // onbekend domein zonder fallback-config: niets doen

    // ------------------------------------------------------------------
    // B. <head> aanvullen: manifest-link + meta-tags (idempotent)
    // ------------------------------------------------------------------
    function ensureHeadTags() {
      if (!document.querySelector('link[rel="manifest"]')) {
        var link = document.createElement('link');
        link.rel = 'manifest';
        link.href = brand.manifestUrl;
        document.head.appendChild(link);
      }
      if (!document.querySelector('meta[name="theme-color"]')) {
        var meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.content = brand.themeColor;
        document.head.appendChild(meta);
      }
      var appleTags = {
        'apple-mobile-web-app-capable': 'yes',
        'apple-mobile-web-app-status-bar-style': 'black-translucent',
        'apple-mobile-web-app-title': brand.appName
      };
      Object.keys(appleTags).forEach(function (name) {
        if (!document.querySelector('meta[name="' + name + '"]')) {
          var m = document.createElement('meta');
          m.name = name;
          m.content = appleTags[name];
          document.head.appendChild(m);
        }
      });
    }
    ensureHeadTags();

    // ------------------------------------------------------------------
    // C. Service worker registreren
    // ------------------------------------------------------------------
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register(brand.swUrl).catch(function (err) {
          console.error('[pwa-install] service worker registratie mislukt:', err);
        });
      });
    }

    // ------------------------------------------------------------------
    // D. Detectie: al geïnstalleerd? Dan helemaal niets tonen.
    // ------------------------------------------------------------------
    function isAlreadyInstalled() {
      var standaloneDisplay = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      var iosStandalone = window.navigator.standalone === true; // Safari-specifiek
      return standaloneDisplay || iosStandalone;
    }
    if (isAlreadyInstalled()) return;

    // ------------------------------------------------------------------
    // E. Platform-detectie
    // ------------------------------------------------------------------
    var ua = window.navigator.userAgent || '';
    var isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
    var isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
    var isIosSafari = isIos && isSafari;
    var supportsBeforeInstallPrompt = 'onbeforeinstallprompt' in window;

    // Op platformen zonder beforeinstallprompt én zonder iOS/Safari-instructiepad
    // (bijv. Firefox desktop) laten we de banner bewust weg — anders beloven we
    // een installatie die niet werkt.
    if (!isIosSafari && !supportsBeforeInstallPrompt) return;

    // ------------------------------------------------------------------
    // F. Timing & dismissal (LocalStorage)
    // ------------------------------------------------------------------
    var LS_VISIT_KEY = 'pwaInstallVisitCount';
    var LS_DISMISSED_KEY = 'pwaInstallDismissed';

    function getVisitCount() {
      var n = parseInt(window.localStorage.getItem(LS_VISIT_KEY) || '0', 10);
      return isNaN(n) ? 0 : n;
    }
    function bumpVisitCount() {
      var n = getVisitCount() + 1;
      window.localStorage.setItem(LS_VISIT_KEY, String(n));
      return n;
    }
    function isDismissed() {
      return window.localStorage.getItem(LS_DISMISSED_KEY) === '1';
    }
    function setDismissed() {
      window.localStorage.setItem(LS_DISMISSED_KEY, '1');
    }

    if (isDismissed()) return;

    var visitCount = bumpVisitCount();

    // Android/Chrome heeft het install-event nodig vóórdat we kunnen tonen
    // (zonder dat event kan de native installatie niet getriggerd worden).
    var deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      maybeScheduleBanner();
    });

    function maybeScheduleBanner() {
      if (isDismissed() || isAlreadyInstalled()) return;
      if (!isIosSafari && !deferredPrompt) return; // Chrome: wacht op het event

      if (visitCount >= 2) {
        // 2e bezoek (of later): meteen tonen, met kleine vertraging zodat de
        // pagina eerst rustig kan laden.
        window.setTimeout(showBanner, 2000);
      } else {
        // 1e bezoek: pas na 30 seconden, om niet meteen te storen.
        window.setTimeout(function () {
          if (!isDismissed() && !isAlreadyInstalled()) showBanner();
        }, 30000);
      }
    }

    // Op iOS is er geen beforeinstallprompt-event — de timing-logica kan
    // direct starten.
    if (isIosSafari) {
      maybeScheduleBanner();
    }

    // ------------------------------------------------------------------
    // G. UI: banner + iOS-instructieoverlay (volledig zelfvoorzienend qua CSS,
    // zodat het werkt ongeacht welke pagina het script insluit)
    // ------------------------------------------------------------------
    var bannerShown = false;

    function injectStyles() {
      if (document.getElementById('pwaInstallStyles')) return;
      var css = [
        '#pwaInstallBanner{position:fixed;left:0;right:0;bottom:0;z-index:9999;',
        'display:flex;justify-content:center;padding:14px;box-sizing:border-box;',
        'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
        'animation:pwaSlideUp .35s ease-out;}',
        '@keyframes pwaSlideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}',
        '#pwaInstallBanner .pwaCard{max-width:480px;width:100%;background:' + brand.backgroundColor + ';',
        'border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25);padding:16px;',
        'display:flex;align-items:center;gap:12px;border:1px solid rgba(0,0,0,.08);}',
        '#pwaInstallBanner .pwaIcon{width:48px;height:48px;border-radius:12px;flex-shrink:0;',
        'box-shadow:0 2px 6px rgba(0,0,0,.2);}',
        '#pwaInstallBanner .pwaText{flex:1;min-width:0;}',
        '#pwaInstallBanner .pwaTitle{font-weight:700;font-size:14.5px;color:' + brand.inkColor + ';margin:0 0 2px;}',
        '#pwaInstallBanner .pwaSub{font-size:12.5px;color:' + brand.inkColor + ';opacity:.7;margin:0;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '#pwaInstallBanner .pwaActions{display:flex;flex-direction:column;gap:6px;flex-shrink:0;}',
        '#pwaInstallBanner button{border:none;cursor:pointer;font-family:inherit;}',
        '#pwaInstallBanner .pwaBtnPrimary{background:' + brand.themeColor + ';color:#fff;',
        'padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;}',
        '#pwaInstallBanner .pwaBtnSecondary{background:transparent;color:' + brand.inkColor + ';',
        'opacity:.6;padding:4px 6px;border-radius:8px;font-size:11.5px;text-decoration:underline;}',
        '#pwaIosOverlay{position:fixed;inset:0;z-index:10000;background:rgba(20,22,16,.6);',
        'display:flex;align-items:flex-end;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}',
        '#pwaIosOverlay .pwaIosCard{max-width:420px;width:100%;background:' + brand.backgroundColor + ';',
        'border-radius:20px 20px 0 0;padding:22px 20px 28px;box-sizing:border-box;',
        'animation:pwaSlideUp .3s ease-out;}',
        '#pwaIosOverlay h3{margin:0 0 10px;font-size:16px;color:' + brand.inkColor + ';}',
        '#pwaIosOverlay p{margin:0 0 14px;font-size:13.5px;line-height:1.5;color:' + brand.inkColor + ';opacity:.85;}',
        '#pwaIosOverlay .pwaIosStep{display:flex;align-items:center;gap:10px;',
        'background:rgba(0,0,0,.04);border-radius:10px;padding:10px 12px;margin-bottom:10px;',
        'font-size:13.5px;color:' + brand.inkColor + ';}',
        '#pwaIosOverlay .pwaIosStep b{color:' + brand.themeColor + ';}',
        '#pwaIosOverlay .pwaShareIcon{width:22px;height:22px;flex-shrink:0;}',
        '#pwaIosOverlay .pwaIosArrowDown{text-align:center;font-size:26px;line-height:1;',
        'margin:2px 0 14px;color:' + brand.accentColor + ';animation:pwaBounce 1.4s infinite;}',
        '@keyframes pwaBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}',
        '#pwaIosOverlay .pwaIosClose{display:block;width:100%;text-align:center;',
        'background:' + brand.themeColor + ';color:#fff;padding:11px;border-radius:10px;',
        'font-size:14px;font-weight:600;border:none;cursor:pointer;}'
      ].join('');
      var style = document.createElement('style');
      style.id = 'pwaInstallStyles';
      style.textContent = css;
      document.head.appendChild(style);
    }

    function showBanner() {
      if (bannerShown || isDismissed() || isAlreadyInstalled()) return;
      // Als een andere modal/overlay al open is (checkout-wizard, login-nudge,
      // etc.), niet overlappen — gewoon niets doen op deze pageload.
      if (document.querySelector('.modal-overlay.open, #loginNudgeOverlay.open')) return;

      bannerShown = true;
      injectStyles();

      var wrap = document.createElement('div');
      wrap.id = 'pwaInstallBanner';
      wrap.innerHTML =
        '<div class="pwaCard">' +
          '<img class="pwaIcon" src="' + brand.iconUrl + '" alt="' + brand.appName + '">' +
          '<div class="pwaText">' +
            '<p class="pwaTitle">Installeer ' + brand.appName + '</p>' +
            '<p class="pwaSub">' + brand.tagline + '</p>' +
          '</div>' +
          '<div class="pwaActions">' +
            '<button type="button" class="pwaBtnPrimary" id="pwaInstallBtn">Nu installeren</button>' +
            '<button type="button" class="pwaBtnSecondary" id="pwaLaterBtn">Misschien later</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);

      document.getElementById('pwaLaterBtn').addEventListener('click', function () {
        setDismissed();
        wrap.remove();
      });

      document.getElementById('pwaInstallBtn').addEventListener('click', function () {
        if (isIosSafari) {
          wrap.remove();
          showIosInstructions();
          return;
        }
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () {
            deferredPrompt = null;
            wrap.remove();
            // Ongeacht accepteren/weigeren: niet nogmaals op elke herlaad tonen.
            setDismissed();
          });
        } else {
          // Zou niet moeten gebeuren (banner wordt pas getoond ná het event),
          // maar defensief toch nette afhandeling.
          wrap.remove();
        }
      });
    }

    function showIosInstructions() {
      injectStyles();
      var overlay = document.createElement('div');
      overlay.id = 'pwaIosOverlay';
      overlay.innerHTML =
        '<div class="pwaIosCard">' +
          '<h3>Zet ' + brand.appName + ' op je startscherm</h3>' +
          '<p>Zo installeer je de app in een paar tikken via Safari:</p>' +
          '<div class="pwaIosStep"><span>1.</span>&nbsp;Tik onderin op het <b>Deel-icoon</b> (vierkantje met pijl omhoog)</div>' +
          '<div class="pwaIosArrowDown">&#8595;</div>' +
          '<div class="pwaIosStep"><span>2.</span>&nbsp;Kies <b>"Zet op beginscherm"</b></div>' +
          '<div class="pwaIosStep"><span>3.</span>&nbsp;Tik rechtsboven op <b>"Voeg toe"</b></div>' +
          '<button type="button" class="pwaIosClose" id="pwaIosCloseBtn">Begrepen</button>' +
        '</div>';
      document.body.appendChild(overlay);
      setDismissed();
      document.getElementById('pwaIosCloseBtn').addEventListener('click', function () {
        overlay.remove();
      });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.remove();
      });
    }
  } catch (pwaErr) {
    // Fail-silent: deze losstaande feature mag de rest van de site nooit breken.
    console.error('[pwa-install] onverwachte fout:', pwaErr);
  }
})();
