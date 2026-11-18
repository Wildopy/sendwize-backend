/* ─────────────────────────────────────────────────────────────
   SENDWIZE: sw-auth.js v1.0  (browser)
   Sends the signed-in member's Memberstack token with every API call,
   so the backend knows who is calling instead of trusting ?userId=.

   1. On every tool page (campaign-defence.html, site-sweep.html,
      ai-checker.html, dashboard embed, etc.):
        <script src="https://sendwize-backend.vercel.app/sw-auth.js"></script>
      then use swFetch(...) instead of fetch(...) for /api calls.

   2. On Webflow, paste the same script tag ONCE in Site settings → Custom code → HEAD code (not footer, so it loads before the dashboard embed).
      Links to the tools on sendwize-backend.vercel.app automatically
      carry the token in the URL #fragment (never sent to servers or
      logs). The tool page stores it for that tab and removes it from
      the address bar.

   Where the token comes from, in order: Memberstack on this page →
   #swt= fragment → this tab's sessionStorage.

   v1.1: client workspaces (agency plan). SW.setWorkspace(id) picks the
   client every API call is about (X-Sendwize-Workspace header). Links
   into the tools carry it as #sww=, like the token. '' = own account.
   ───────────────────────────────────────────────────────────── */
(function () {
  var KEY = 'sw_token';
  var BACKEND = /^https:\/\/sendwize-backend\.vercel\.app\//;
  // The one place the dashboard URL lives: every tool page's Dashboard link
  // and back button follow it. Change STAGING_DASHBOARD's replacement here
  // (or set window.SW_DASHBOARD_URL before this script) when the live URL moves.
  var STAGING_DASHBOARD = 'https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy';
  var DASHBOARD = window.SW_DASHBOARD_URL || STAGING_DASHBOARD;
  var cached = null;
  var WS_KEY = 'sw_ws';
  var ON_BACKEND = BACKEND.test(location.href);
  // The dashboard (Webflow) remembers the open client; tool pages keep it per tab
  function wsStore() { try { return ON_BACKEND ? sessionStorage : localStorage; } catch (e) { return null; } }
  var workspace = (function () { var st = wsStore(); try { return (st && st.getItem(WS_KEY)) || ''; } catch (e) { return ''; } })();
  function setWorkspace(id) {
    workspace = /^ws[a-z0-9]{10}$/.test(id || '') ? id : '';
    var st = wsStore();
    try { if (st) { if (workspace) st.setItem(WS_KEY, workspace); else st.removeItem(WS_KEY); } } catch (e) {}
    return workspace;
  }

  // Token handed over in the URL fragment by a Webflow link
  (function readFragment() {
    var w = location.hash.match(/[#&]sww=([^&]*)/);
    if (w) {
      setWorkspace(decodeURIComponent(w[1]));
      var restW = location.hash.replace(/[#&]sww=[^&]*/, '').replace(/^&/, '#');
      try { history.replaceState(null, '', location.pathname + location.search + (restW === '#' ? '' : restW)); } catch (e) {}
    }
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

  // Shown when the member has no active paid plan (API returns 402)
  var PRICING = window.SW_PRICING_URL || 'https://new-mvp-v2.webflow.io/marketing-templates/marketing-template-1/pricing-1';
  function showPlanRequired() {
    if (document.getElementById('sw-plan-banner')) return;
    var d = document.createElement('div');
    d.id = 'sw-plan-banner';
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;background:#0f0f0d;color:#fff;padding:14px 18px;border-radius:10px;font:500 14px/1.5 "DM Sans",-apple-system,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.2)';
    d.innerHTML = 'Your Sendwize plan isn\'t active. <a href="' + PRICING + '" style="color:#EA7317;font-weight:600">Choose a plan</a> to keep using the tools.';
    (document.body || document.documentElement).appendChild(d);
  }

  async function swFetch(url, opts) {
    opts = opts || {};
    var headers = new Headers(opts.headers || {});
    // Only ever send the login to Sendwize's own API, never to other sites
    var target = new URL(typeof url === 'string' ? url : url.url, location.href);
    var ours = target.origin === 'https://sendwize-backend.vercel.app' || target.origin === location.origin && /^\/api\//.test(target.pathname);
    var t = ours ? await getToken() : null;
    if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
    if (ours && workspace && !headers.has('X-Sendwize-Workspace')) headers.set('X-Sendwize-Workspace', workspace);
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401) showExpired();
    if (res.status === 403 && workspace) {
      // The client was archived or isn't on this account: go back to the member's own
      var body = await res.clone().json().catch(function () { return {}; });
      if (body && body.code === 'workspace_not_found') { setWorkspace(''); location.reload(); }
    }
    if (res.status === 402) showPlanRequired();
    return res;
  }

  // Webflow side: add the token to links into the tools
  function decorateLinks() {
    // Keep the cache warm so the click handler can stay synchronous.
    // Memberstack may load after this script, so retry quickly at first,
    // then refresh every minute (tokens expire).
    var tries = 0;
    (function warm() {
      getToken().then(function (t) {
        tries++;
        setTimeout(warm, t ? 60000 : (tries < 40 ? 250 : 5000));
      });
    })();
    document.addEventListener('pointerdown', function () { getToken(); }, true);
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !BACKEND.test(a.href) || !cached) return;
      var base = a.href.replace(/#.*$/, '');
      var hash = a.hash ? a.hash.slice(1).replace(/(^|&)(swt|sww)=[^&]*/g, '').replace(/^&/, '') : '';
      a.href = base + '#' + (hash ? hash + '&' : '') + 'sww=' + encodeURIComponent(workspace) + '&swt=' + encodeURIComponent(cached);
    }, true);
  }

  window.swFetch = swFetch;
  // For code that navigates with location.href instead of a link
  // (e.g. the dashboard's tool buttons): adds the login to a tool URL.
  function withToken(u) {
    var abs;
    try { abs = new URL(u, location.href).href; } catch (e) { return u; }
    if (!cached || !BACKEND.test(abs)) return u;
    var hashAt = abs.indexOf('#');
    var base = hashAt === -1 ? abs : abs.slice(0, hashAt);
    var hash = hashAt === -1 ? '' : abs.slice(hashAt + 1).replace(/(^|&)(swt|sww)=[^&]*/g, '').replace(/^&/, '');
    return base + '#' + (hash ? hash + '&' : '') + 'sww=' + encodeURIComponent(workspace) + '&swt=' + encodeURIComponent(cached);
  }

  window.SW = { getToken: getToken, fetch: swFetch, decorateLinks: decorateLinks, withToken: withToken, dashboard: DASHBOARD,
    workspace: function () { return workspace; }, setWorkspace: setWorkspace };

  // Tool pages: point hard-coded dashboard links at DASHBOARD
  function retargetDashboardLinks() {
    if (DASHBOARD === STAGING_DASHBOARD) return;
    var links = document.querySelectorAll('a[href^="' + STAGING_DASHBOARD + '"]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute('href', DASHBOARD + links[i].getAttribute('href').slice(STAGING_DASHBOARD.length));
  }
  if (BACKEND.test(location.href)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retargetDashboardLinks);
    else retargetDashboardLinks();
  }

  // Auto-enable link decoration on pages that are not the backend itself
  if (!BACKEND.test(location.href)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorateLinks);
    else decorateLinks();
  }
})();
