/* ─────────────────────────────────────────────────────────────
   SENDWIZE: sw-tool-nav.js v1.1  (browser)
   The same strip under the header of every tool page: a way back to the
   dashboard and a switcher to the other tools, grouped as they are on
   the dashboard. Load it after sw-auth.js:
     <script src="https://sendwize-backend.vercel.app/sw-tool-nav.js" defer></script>

   v1.1: clearer. "Your tools" label, every tool is a chip,
     the tool you're on is filled orange, group names sit above their
     chips on wide screens, and on a phone the strip scrolls with a fade
     on the edge so it's obvious there's more. Campaign defence moves to
     "Before you send".

   Tool names match TOOL_GROUPS in dashboard/sw-dashboard.js and each
   page's own title; change all three together.
   ───────────────────────────────────────────────────────────── */
(function () {
  var GROUPS = [
    ['Before you send', [['Copy checker', 'ai-checker.html'], ['Campaign defence', 'campaign-defence.html']]],
    ['Your list', [['List health', 'list-intelligence.html'], ['Audience read', 'audience-read.html']]],
    ['Website and suppliers', [['Site sweep', 'site-sweep.html'], ['Third parties', 'vendor-checker.html']]],
    ['Practice', [['Regulator simulator', 'ico-simulator.html']]],
  ];
  var ICON = { back: '<path d="M15 5l-7 7 7 7"/>' };
  var STAGING_DASHBOARD = 'https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy';
  var CSS =
    '.swtn-w{position:relative;background:#faf9f7;border-bottom:1px solid #e8e6e1;font:500 13px/1.3 "DM Sans",-apple-system,sans-serif}' +
    '.swtn{display:flex;align-items:flex-end;gap:10px;overflow-x:auto;padding:10px 24px 12px;scrollbar-width:none}' +
    '.swtn::-webkit-scrollbar{display:none}' +
    '.swtn svg{width:15px;height:15px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '.swtn a{display:inline-flex;align-items:center;gap:7px;flex-shrink:0;text-decoration:none;white-space:nowrap;border-radius:10px;transition:background .2s,color .2s,border-color .2s,box-shadow .2s,transform .2s}' +
    '.swtn-back{color:#0c0b09;font-weight:700;padding:8px 12px;background:#fff;border:1px solid #e8e6e1}' +
    '.swtn-back:hover{border-color:#d8d5ce;box-shadow:0 4px 12px rgba(0,0,0,.06)}' +
    '.swtn-lbl{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;color:#0c0b09;font-weight:700;padding:8px 0 8px 14px;border-left:1px solid #e8e6e1}' +
    '.swtn-g{display:flex;flex-direction:column;gap:5px;flex-shrink:0}' +
    '.swtn-gn{font-size:10.5px;font-weight:700;color:#9c9890;padding-left:3px}' +
    '.swtn-gc{display:flex;gap:6px}' +
    '.swtn-t{color:#3d3a35;font-weight:600;padding:7px 13px;background:#fff;border:1px solid #e8e6e1}' +
    '.swtn-t:hover{border-color:#f1d9c4;color:#0c0b09;box-shadow:0 6px 16px rgba(234,115,23,.12);transform:translateY(-1px)}' +
    '.swtn-t[aria-current=page]{background:#EA7317;border-color:#EA7317;color:#fff;font-weight:700;box-shadow:0 6px 16px rgba(234,115,23,.25)}' +
    '.swtn-fade{position:absolute;top:0;right:0;bottom:0;width:48px;pointer-events:none;background:linear-gradient(90deg,rgba(250,249,247,0),#faf9f7 80%);opacity:0;transition:opacity .2s}' +
    '.swtn-w.more .swtn-fade{opacity:1}' +
        '@media(max-width:1180px){.swtn{align-items:center;gap:8px}.swtn-gn{display:none}.swtn-g+.swtn-g{padding-left:8px;border-left:1px solid #e8e6e1}}' +
    '@media(max-width:680px){.swtn{padding:8px 12px}.swtn-lbl{display:none}}';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function svg(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; }

  function build() {
    if (document.querySelector('.swtn')) return;
    var here = location.pathname.split('/').pop() || '';
    // Keep the member id the dashboard passed in, so the next tool knows who you are
    var m = location.search.match(/[?&]userId=([^&#]+)/), qs = m ? '?userId=' + m[1] : '';
    var dash = (window.SW && window.SW.dashboard) || STAGING_DASHBOARD;
    var html = '<a class="swtn-back" href="' + esc(dash) + '">' + svg('back') + 'Dashboard</a>' +
      '<span class="swtn-lbl"><span>Your tools</span></span>';
    GROUPS.forEach(function (g) {
      html += '<div class="swtn-g" role="group" aria-label="' + esc(g[0]) + '"><span class="swtn-gn">' + esc(g[0]) + '</span><div class="swtn-gc">';
      g[1].forEach(function (t) {
        html += '<a class="swtn-t" href="/' + t[1] + qs + '"' + (t[1] === here ? ' aria-current="page"' : '') + '>' + esc(t[0]) + '</a>';
      });
      html += '</div></div>';
    });
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var wrap = document.createElement('div'); wrap.className = 'swtn-w';
    var bar = document.createElement('nav'); bar.className = 'swtn'; bar.setAttribute('aria-label', 'Sendwize tools'); bar.innerHTML = html;
    var fade = document.createElement('span'); fade.className = 'swtn-fade';
    wrap.appendChild(bar); wrap.appendChild(fade);
    var head = document.querySelector('header.sw-ph-header') || document.querySelector('body > header');
    if (head && head.parentNode) head.parentNode.insertBefore(wrap, head.nextSibling);
    else document.body.insertBefore(wrap, document.body.firstChild);
    // Fade on the right edge while there are more tools off-screen
    function edge() { wrap.classList.toggle('more', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4); }
    bar.addEventListener('scroll', edge, { passive: true }); window.addEventListener('resize', edge); edge();
    var cur = bar.querySelector('[aria-current]');
    // Narrow screens: bring the current tool into view if it starts off-screen
    if (cur && cur.offsetLeft + cur.offsetWidth > bar.clientWidth) { bar.scrollLeft = cur.offsetLeft - 24; edge(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
