/* ─────────────────────────────────────────────────────────────
   SENDWIZE — sw-tool-nav.js v1.0  (browser)
   The same strip under the header of every tool page: a way back to the
   dashboard and a switcher to the other tools, grouped as they are on
   the dashboard. Load it after sw-auth.js:
     <script src="https://sendwize-backend.vercel.app/sw-tool-nav.js" defer></script>

   Tool names match TOOL_GROUPS in dashboard/sw-dashboard.js and each
   page's own title; change all three together.
   ───────────────────────────────────────────────────────────── */
(function () {
  var GROUPS = [
    ['Before you send', [['Send-day verdict', 'send-verdict.html'], ['Copy checker', 'ai-checker.html']]],
    ['Your list', [['List health', 'list-intelligence.html'], ['Audience read', 'audience-read.html']]],
    ['Website and suppliers', [['Site sweep', 'site-sweep.html'], ['Third parties', 'vendor-checker.html']]],
    ['Records and practice', [['Campaign defence', 'campaign-defence.html'], ['Regulator simulator', 'ico-simulator.html']]],
  ];
  var STAGING_DASHBOARD = 'https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy';
  var CSS = '.swtn{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:8px 24px;background:#faf9f7;border-bottom:1px solid #e8e6e1;font:500 13px/1.3 "DM Sans",-apple-system,sans-serif;scrollbar-width:thin}' +
    '.swtn a{flex-shrink:0;color:#5c5852;text-decoration:none;padding:6px 10px;border-radius:8px;white-space:nowrap}' +
    '.swtn a:hover{background:#fff;color:#0c0b09}' +
    '.swtn a[aria-current=page]{background:#fff4ec;color:#c85f0f;font-weight:700}' +
    '.swtn .swtn-back{font-weight:700;color:#0c0b09;margin-right:4px}' +
    '.swtn-g{flex-shrink:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9c9890;padding-left:10px;border-left:1px solid #e8e6e1;margin-left:4px}' +
    '@media(max-width:1320px){.swtn-g{font-size:0;letter-spacing:0;padding-left:0;height:18px}}' +
    '@media(max-width:680px){.swtn{padding:6px 12px}}';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function build() {
    if (document.querySelector('.swtn')) return;
    var here = location.pathname.split('/').pop() || '';
    // Keep the member id the dashboard passed in, so the next tool knows who you are
    var m = location.search.match(/[?&]userId=([^&#]+)/), qs = m ? '?userId=' + m[1] : '';
    var dash = (window.SW && window.SW.dashboard) || STAGING_DASHBOARD;
    var html = '<a class="swtn-back" href="' + esc(dash) + '">← Dashboard</a>';
    GROUPS.forEach(function (g) {
      html += '<span class="swtn-g">' + esc(g[0]) + '</span>';
      g[1].forEach(function (t) {
        html += '<a href="/' + t[1] + qs + '"' + (t[1] === here ? ' aria-current="page"' : '') + '>' + esc(t[0]) + '</a>';
      });
    });
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var bar = document.createElement('nav'); bar.className = 'swtn'; bar.setAttribute('aria-label', 'Sendwize tools'); bar.innerHTML = html;
    var head = document.querySelector('header.sw-ph-header') || document.querySelector('body > header');
    if (head && head.parentNode) head.parentNode.insertBefore(bar, head.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
    var cur = bar.querySelector('[aria-current]');
    // Narrow screens: bring the current tool into view if it starts off-screen
    if (cur && cur.offsetLeft + cur.offsetWidth > bar.clientWidth) bar.scrollLeft = cur.offsetLeft - 24;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
