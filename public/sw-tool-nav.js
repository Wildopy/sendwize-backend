/* ─────────────────────────────────────────────────────────────
   SENDWIZE: sw-tool-nav.js v1.1  (browser)
   The same strip under the header of every tool page: a way back to the
   dashboard and a switcher to the other tools, grouped as they are on
   the dashboard. Load it after sw-auth.js:
     <script src="https://sendwize-backend.vercel.app/sw-tool-nav.js" defer></script>

   v1.1: clearer. "Your tools" label, every tool is a chip with its icon,
     the tool you're on is filled orange, group names sit above their
     chips on wide screens, and on a phone the strip scrolls with a fade
     on the edge so it's obvious there's more. Campaign defence moves to
     "Before you send".

   Tool names match TOOL_GROUPS in dashboard/sw-dashboard.js and each
   page's own title; change all three together.
   ───────────────────────────────────────────────────────────── */
(function () {
  var GROUPS = [
    ['Before you send', [['Copy checker', 'ai-checker.html', 'copy'], ['Campaign defence', 'campaign-defence.html', 'defence']]],
    ['Your list', [['List health', 'list-intelligence.html', 'list'], ['Audience read', 'audience-read.html', 'audience']]],
    ['Website and suppliers', [['Site sweep', 'site-sweep.html', 'sweep'], ['Third parties', 'vendor-checker.html', 'vendor']]],
    ['Practice', [['Regulator simulator', 'ico-simulator.html', 'simulator']]],
  ];
  var ICON = {
    copy: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9.5 14.5l2 2 3.5-4"/>',
    defence: '<path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    audience: '<path d="M3 20h18"/><path d="M6 20v-6M11 20V8M16 20v-9M21 4l-5 4-5-3-6 5"/>',
    sweep: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
    vendor: '<circle cx="8" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 20c.4-3.3 2.7-5.5 5.5-5.5s5.1 2.2 5.5 5.5M14.5 14.6c.6-.1 1.3-.1 2-.1 2.6 0 4.6 2 5 5.5"/>',
    simulator: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.5 6a2.5 2.5 0 005 0zM19 7l-2.5 6a2.5 2.5 0 005 0z"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  };
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
    '.swtn-lbl svg{color:#EA7317}' +
    '.swtn-g{display:flex;flex-direction:column;gap:5px;flex-shrink:0}' +
    '.swtn-gn{font-size:10.5px;font-weight:700;color:#9c9890;padding-left:3px}' +
    '.swtn-gc{display:flex;gap:6px}' +
    '.swtn-t{color:#3d3a35;font-weight:600;padding:7px 12px 7px 9px;background:#fff;border:1px solid #e8e6e1}' +
    '.swtn-t svg{color:#EA7317}' +
    '.swtn-t:hover{border-color:#f1d9c4;color:#0c0b09;box-shadow:0 6px 16px rgba(234,115,23,.12);transform:translateY(-1px)}' +
    '.swtn-t[aria-current=page]{background:#EA7317;border-color:#EA7317;color:#fff;font-weight:700;box-shadow:0 6px 16px rgba(234,115,23,.25)}' +
    '.swtn-t[aria-current=page] svg{color:#fff}' +
    '.swtn-fade{position:absolute;top:0;right:0;bottom:0;width:48px;pointer-events:none;background:linear-gradient(90deg,rgba(250,249,247,0),#faf9f7 80%);opacity:0;transition:opacity .2s}' +
    '.swtn-w.more .swtn-fade{opacity:1}' +
    '@media(max-width:1400px){.swtn-lbl span{display:none}.swtn-lbl{padding-left:10px}}' +
    '@media(max-width:1180px){.swtn{align-items:center;gap:8px}.swtn-gn{display:none}.swtn-g+.swtn-g{padding-left:8px;border-left:1px solid #e8e6e1}}' +
    '@media(max-width:680px){.swtn{padding:8px 12px}.swtn-lbl span{display:none}.swtn-lbl{padding-left:10px}}';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function svg(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; }

  function build() {
    if (document.querySelector('.swtn')) return;
    var here = location.pathname.split('/').pop() || '';
    // Keep the member id the dashboard passed in, so the next tool knows who you are
    var m = location.search.match(/[?&]userId=([^&#]+)/), qs = m ? '?userId=' + m[1] : '';
    var dash = (window.SW && window.SW.dashboard) || STAGING_DASHBOARD;
    var html = '<a class="swtn-back" href="' + esc(dash) + '">' + svg('back') + 'Dashboard</a>' +
      '<span class="swtn-lbl">' + svg('grid') + '<span>Your tools</span></span>';
    GROUPS.forEach(function (g) {
      html += '<div class="swtn-g" role="group" aria-label="' + esc(g[0]) + '"><span class="swtn-gn">' + esc(g[0]) + '</span><div class="swtn-gc">';
      g[1].forEach(function (t) {
        html += '<a class="swtn-t" href="/' + t[1] + qs + '"' + (t[1] === here ? ' aria-current="page"' : '') + '>' + svg(t[2]) + esc(t[0]) + '</a>';
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
