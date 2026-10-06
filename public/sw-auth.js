/* ─────────────────────────────────────────────────────────────
   SENDWIZE — sw-auth.js v1.0  (browser)
   Sends the signed-in member's Memberstack token with every API call,
   so the backend knows who is calling instead of trusting ?userId=.

   1. On every tool page (campaign-defence.html, site-sweep.html,
      ai-checker.html, dashboard embed, etc.):
        <script src="https://sendwize-backend.vercel.app/sw-auth.js"></script>
      then use swFetch(...) instead of fetch(...) for /api calls.

   2. On Webflow pages (where Memberstack runs) include the same script.
      Links to the tools on sendwize-backend.vercel.app automatically
      carry the token in the URL #fragment (never sent to servers or
      logs). The tool page stores it for that tab and removes it from
      the address bar.

   Where the token comes from, in order: Memberstack on this page →
   #swt= fragment → this tab's sessionStorage.
   ───────────────────────────────────────────────────────────── */
(function () {
  var KEY = 'sw_token';
  var BACKEND = /^https:\/\/sendwize-backend\.vercel\.app\//;
  var DASHBOARD = 'https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy';
  var cached = null;

  // Token handed over in the URL fragment by a Webflow link
  (function readFragment() {
    var m = location.hash.match(/[#&]swt=([^&]+)/);
    if (!m) return;
    cached = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(KEY, cached); } catch (e) {}
    var rest = location.hash.replace(/[#&]swt=[^&]+/, '').replace(/^&/, '#');
    try { history.replaceState(null, '', location.pathname + location.search + (rest === '#' ? '' : rest)); } catch (e) {}
  })();

  async function fromMemberstack() {
    var ms = window.$memberstackDom;
    if (!ms || typeof ms.getMemberCookie !== 'function') return null;
    try { return (await ms.getMemberCookie()) || null; } catch (e) { return null; }
  }

  async function getToken() {
    var t = await fromMemberstack();
    if (t) { cached = t; return t; }
    if (cached) return cached;
    try { cached = sessionStorage.getItem(KEY); } catch (e) {}
    return cached;
  }

  function showExpired() {
    if (document.getElementById('sw-auth-banner')) return;
    var d = document.createElement('div');
    d.id = 'sw-auth-banner';
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;background:#0f0f0d;color:#fff;padding:14px 18px;border-radius:10px;font:500 14px/1.5 "DM Sans",-apple-system,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.2)';
    d.innerHTML = 'Your session has expired. <a href="' + DASHBOARD + '" style="color:#EA7317;font-weight:600">Return to your dashboard</a> and open this tool again.';
    (document.body || document.documentElement).appendChild(d);
  }

  async function swFetch(url, opts) {
    opts = opts || {};
    var headers = new Headers(opts.headers || {});
    var t = await getToken();
    if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401) showExpired();
    return res;
  }

  // Webflow side: add the token to links into the tools
  function decorateLinks() {
    getToken(); // warm the cache so the click handler can stay synchronous
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !BACKEND.test(a.href) || !cached) return;
      var base = a.href.replace(/#.*$/, '');
      var hash = a.hash ? a.hash.slice(1) + '&' : '';
      a.href = base + '#' + hash + 'swt=' + encodeURIComponent(cached);
    }, true);
  }

  window.swFetch = swFetch;
  window.SW = { getToken: getToken, fetch: swFetch, decorateLinks: decorateLinks };

  // Auto-enable link decoration on pages that are not the backend itself
  if (!BACKEND.test(location.href)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorateLinks);
    else decorateLinks();
  }
})();
