/* Gedeelde cookiebanner + toestemming-gated meting.
   Niets van Google of Meta wordt geladen vóór Accepteren.
   Weigeren laat alles uit. Consent Mode v2 staat standaard op denied,
   alleen als lokale stub — dat doet zelf geen netwerkverzoek. */
(function () {
  var CONSENT_KEY = 'bd_cookie_consent';
  var GA_ID = 'G-VJS3Q1LRKM';
  var PIXEL_ID = '1042044348475596';

  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'granted',
    wait_for_update: 500
  });

  function grantConsent() {
    window.gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted'
    });
  }

  function loadAnalytics() {
    if (window.__bdAnalyticsLoaded) return;
    window.__bdAnalyticsLoaded = true;
    grantConsent();

    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', PIXEL_ID);
    window.fbq('track', 'PageView');

    var gtagScript = document.createElement('script');
    gtagScript.async = true;
    gtagScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(gtagScript);
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  }

  function orderMethod(anchor) {
    var href = anchor.href || '';
    var parsed;
    try { parsed = new URL(href, window.location.href); } catch (e) { return null; }
    var host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'boslaantjedoen.nl') return null;
    var blob = (parsed.pathname + parsed.hash + ' ' + (anchor.textContent || '')).toLowerCase();
    if (blob.indexOf('selectstore') !== -1 || blob.indexOf('afhalen') !== -1) return 'afhalen';
    if (blob.indexOf('bezorg') !== -1 || blob.indexOf('bestel') !== -1) return 'bezorgen';
    return null;
  }

  document.addEventListener('click', function (event) {
    if (localStorage.getItem(CONSENT_KEY) !== 'accepted') return;
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a') : null;
    if (!anchor) return;
    var method = orderMethod(anchor);
    if (!method) return;
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'bestel_klik', {
        method: method,
        link_url: anchor.href,
        transport_type: 'beacon'
      });
    }
    if (typeof window.fbq === 'function') {
      window.fbq('trackCustom', 'BestelKlik', { method: method });
      window.fbq('track', 'InitiateCheckout', { method: method });
    }
  }, true);

  window.bdCookieSettings = function () {
    localStorage.removeItem(CONSENT_KEY);
    location.reload();
  };

  var consent = localStorage.getItem(CONSENT_KEY);
  if (consent === 'accepted') loadAnalytics();

  document.addEventListener('DOMContentLoaded', function () {
    if (consent === 'accepted' || consent === 'declined') return;

    var banner = document.createElement('div');
    banner.id = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookiemelding');
    banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#4a5d3d;color:#fff;padding:16px 20px;display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:center;font-family:"Open Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.15);';
    banner.innerHTML = '<p style="margin:0;flex:1 1 320px;font-size:.95rem;line-height:1.5;max-width:640px;">We gebruiken cookies voor websiteanalyse (Google Analytics) en advertenties (Meta Pixel). Ga je hiermee akkoord? <a href="/voorwaarden" style="color:#fff;text-decoration:underline;">Meer info</a></p><div style="display:flex;gap:10px;flex:0 0 auto;"><button type="button" id="cookie-decline" style="background:transparent;color:#fff;border:1px solid #fff;border-radius:999px;padding:10px 20px;font-size:.9rem;cursor:pointer;">Weigeren</button><button type="button" id="cookie-accept" style="background:#fff;color:#4a5d3d;border:1px solid #fff;border-radius:999px;padding:10px 20px;font-size:.9rem;font-weight:600;cursor:pointer;">Accepteren</button></div>';
    document.body.appendChild(banner);

    document.getElementById('cookie-accept').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'accepted');
      consent = 'accepted';
      loadAnalytics();
      banner.remove();
    });
    document.getElementById('cookie-decline').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'declined');
      consent = 'declined';
      banner.remove();
    });
  });
})();
