/* Sendwize Site guard v1.0
   One line on your site:
   <script src="https://sendwize-backend.vercel.app/g.js" data-site="YOUR_KEY" async></script>
   What it reports, once per page view: which known marketing tags sent
   data, whether that happened before a cookie choice, the consent
   state, the page path (no query string) and any "was £X" price shown.
   It sets no cookies, stores nothing on the device and sends no
   personal data. */
(function () {
  try {
    var me = document.currentScript || document.querySelector('script[data-site][src*="/g.js"]');
    var key = me && me.getAttribute('data-site');
    if (!key || !/^[a-f0-9]{20,40}$/.test(key) || window.__swGuard) return;
    window.__swGuard = 1;
    var END = (me.src.split('/g.js')[0] || 'https://sendwize-backend.vercel.app') + '/api/guard?action=collect';

    var TAGS = [
      ['Google Analytics', /google-analytics\.com\/(g\/)?collect|analytics\.google\.com\/g\/collect|\.google-analytics\.com\/g\/collect/i],
      ['Google Ads', /googleadservices\.com\/pagead\/conversion|doubleclick\.net\/(pagead|activity)|google\.[a-z.]+\/pagead\/1p-conversion/i],
      ['Meta Pixel', /facebook\.com\/tr[/?]/i],
      ['TikTok Pixel', /analytics\.tiktok\.com\/api/i],
      ['Microsoft Ads', /bat\.bing\.com\/action/i],
      ['Microsoft Clarity', /\.clarity\.ms\/collect/i],
      ['Hotjar', /hotjar\.(com|io)\/(api|c)\b|content\.hotjar\.io/i],
      ['LinkedIn Insight', /px\.ads\.linkedin\.com/i],
      ['Pinterest Tag', /ct\.pinterest\.com\/v3/i],
      ['Snap Pixel', /tr\.snapchat\.com/i],
      ['Criteo', /(sslwidget|dis)\.criteo\.(com|net)/i],
      ['X (Twitter) Ads', /analytics\.twitter\.com|t\.co\/i\/adsct/i],
      ['Reddit Pixel', /alb\.reddit\.com\/rp\.gif/i],
      ['Klaviyo', /a\.klaviyo\.com\/(client|api)\//i]
    ];

    function cookie(n) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }

    // Google Consent Mode, read from the dataLayer
    function consentMode() {
      var dl = window.dataLayer, d = 'missing', u = 0, last = null;
      if (!dl || !dl.length) return { d: d, u: u, last: last };
      for (var i = 0; i < dl.length; i++) {
        var e = dl[i];
        if (!e || e[0] !== 'consent' || !e[2]) continue;
        var g = e[2].ad_storage === 'granted' || e[2].analytics_storage === 'granted';
        if (e[1] === 'default') d = g ? 'granted' : 'denied';
        if (e[1] === 'update') { if (g) u = 1; last = g ? 'granted' : 'denied'; }
      }
      return { d: d, u: u, last: last };
    }

    // Which consent tool, and what the visitor has chosen so far
    function readConsent() {
      var w = window, c;
      try {
        if (w.Cookiebot) return { c: 'Cookiebot', s: !w.Cookiebot.hasResponse ? 'none' : (w.Cookiebot.consent && (w.Cookiebot.consent.marketing || w.Cookiebot.consent.statistics)) ? 'accepted' : 'rejected' };
        if (w.OneTrust || w.OnetrustActiveGroups) {
          if (!cookie('OptanonAlertBoxClosed')) return { c: 'OneTrust', s: 'none' };
          var g = ',' + (w.OnetrustActiveGroups || '') + ',';
          return { c: 'OneTrust', s: /,C000[234],/.test(g) ? 'accepted' : 'rejected' };
        }
        if ((c = cookie('cookieyes-consent'))) {
          if (!/action:yes/.test(c)) return { c: 'CookieYes', s: 'none' };
          return { c: 'CookieYes', s: /(advertisement|analytics):yes/.test(c) ? 'accepted' : 'rejected' };
        }
        if (w.Didomi && w.Didomi.shouldConsentBeCollected) {
          if (w.Didomi.shouldConsentBeCollected()) return { c: 'Didomi', s: 'none' };
          var st = w.Didomi.getCurrentUserStatus && w.Didomi.getCurrentUserStatus(), any = false;
          if (st && st.purposes) for (var p in st.purposes) if (st.purposes[p] && st.purposes[p].enabled) any = true;
          return { c: 'Didomi', s: any ? 'accepted' : 'rejected' };
        }
        if (w.UC_UI && w.UC_UI.isInitialized && w.UC_UI.isInitialized()) {
          if (w.UC_UI.isConsentRequired && w.UC_UI.isConsentRequired()) return { c: 'Usercentrics', s: 'none' };
          var sv = (w.UC_UI.getServicesBaseInfo && w.UC_UI.getServicesBaseInfo()) || [], ok = false;
          for (var i = 0; i < sv.length; i++) if (sv[i].consent && sv[i].consent.status && sv[i].categorySlug !== 'essential') ok = true;
          return { c: 'Usercentrics', s: ok ? 'accepted' : 'rejected' };
        }
        if (w.Shopify && w.Shopify.customerPrivacy && w.Shopify.customerPrivacy.currentVisitorConsent) {
          var v = w.Shopify.customerPrivacy.currentVisitorConsent() || {};
          if (v.marketing === 'yes' || v.analytics === 'yes') return { c: 'Shopify', s: 'accepted' };
          if (v.marketing === 'no' && v.analytics === 'no') return { c: 'Shopify', s: 'rejected' };
          return { c: 'Shopify', s: 'none' };
        }
        if ((c = cookie('cmplz_marketing')) || cookie('cmplz_banner-status')) return { c: 'Complianz', s: c === 'allow' || cookie('cmplz_statistics') === 'allow' ? 'accepted' : c === 'deny' ? 'rejected' : 'none' };
        if (w.Osano && w.Osano.cm && w.Osano.cm.getConsent) { var o = w.Osano.cm.getConsent() || {}; return { c: 'Osano', s: o.MARKETING === 'ACCEPT' || o.ANALYTICS === 'ACCEPT' ? 'accepted' : 'none' }; }
        if (w._iub && w._iub.cs && w._iub.cs.api && w._iub.cs.api.isConsentGiven) return { c: 'Iubenda', s: w._iub.cs.api.isConsentGiven() ? 'accepted' : 'none' };
        if (w.Termly || document.querySelector('script[src*="termly.io"]')) { var tm = consentMode(); return { c: 'Termly', s: tm.last === 'granted' ? 'accepted' : tm.last === 'denied' ? 'rejected' : 'none' }; }
      } catch (e) {}
      var gm = consentMode();
      if (gm.d !== 'missing') return { c: 'Google Consent Mode', s: gm.last === 'granted' ? 'accepted' : gm.last === 'denied' ? 'rejected' : gm.d === 'granted' ? 'accepted' : 'none' };
      return { c: 'None', s: 'unknown' };
    }

    // When consent was given on this page (ms since navigation start)
    var start = readConsent(), grantAt = start.s === 'accepted' ? 0 : null, state = start;
    var poll = setInterval(function () {
      state = readConsent();
      if (grantAt === null && state.s === 'accepted') grantAt = performance.now();
    }, 500);

    var seen = {};
    function look(entries) {
      for (var i = 0; i < entries.length; i++) {
        var url = entries[i].name || '';
        for (var j = 0; j < TAGS.length; j++) {
          if (!TAGS[j][1].test(url)) continue;
          var name = TAGS[j][0];
          // Google tags with Consent Mode denied (gcs=G100) send no cookies: not counted as early
          var deniedPing = /[?&]gcs=G100/.test(url);
          var early = !deniedPing && (grantAt === null || entries[i].startTime < grantAt - 600);
          if (!seen[name]) seen[name] = { pre: early };
          else if (early) seen[name].pre = true;
        }
      }
    }
    try { look(performance.getEntriesByType('resource')); } catch (e) {}
    var po = null;
    try { po = new PerformanceObserver(function (l) { look(l.getEntries()); }); po.observe({ type: 'resource', buffered: true }); } catch (e) {}

    function prices() {
      var out = [], t = '';
      try { t = (document.body && document.body.innerText || '').slice(0, 200000); } catch (e) {}
      var re = /\b(?:was|rrp)\s*:?\s*£\s?(\d(?:[\d,]*\d)?(?:\.\d{1,2})?)/gi, m;
      while ((m = re.exec(t)) && out.length < 3) if (out.indexOf(m[1]) < 0) out.push(m[1]);
      return out;
    }

    var sent = false;
    function send() {
      if (sent) return; sent = true;
      clearInterval(poll);
      try { look(performance.getEntriesByType('resource')); } catch (e) {}
      state = readConsent();
      if (grantAt === null && state.s === 'accepted') grantAt = performance.now();
      var c2 = consentMode(), t = [];
      for (var n in seen) t.push([n, seen[n].pre && state.s !== 'unknown' ? 1 : 0]);
      var body = JSON.stringify({ v: 1, k: key, p: location.pathname, c: state.c, s: state.s, t: t, cm: { d: c2.d, u: c2.u }, w: prices() });
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(END, new Blob([body], { type: 'text/plain' }));
        else fetch(END, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' });
      } catch (e) {}
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); });
    addEventListener('pagehide', send);
  } catch (e) {}
})();
