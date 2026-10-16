/* ─────────────────────────────────────────────────────────────
   SENDWIZE — sw-dashboard.js v1.0  (browser)
   The member dashboard, served from Vercel so the Webflow embed stays
   a few lines long. Needs sw-auth.js in the Webflow site head and
   sw-dashboard.css on the page. Renders into <div id="sw-dashboard">.

   Every figure comes from /api/dashboard (one call, shared exposure
   engine). "Why this number?" comes from /api/exposure. Briefing,
   campaigns and recent checks load after first paint.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var API = 'https://sendwize-backend.vercel.app';
  var root, userId, D = null;
  var st = { filter: 'all', raMode: 'month', page: { ai: 0, vendor: 0, audience: 0 }, histTab: 'ai' };

  var TOOLS = [
    { k: 'verdict',   l: 'Send-day verdict', u: '/send-verdict.html', hot: true },
    { k: 'copy',      l: 'Copy check',       u: '/ai-checker.html' },
    { k: 'vendor',    l: 'Vendors',          u: '/vendor-checker.html' },
    { k: 'list',      l: 'List health',      u: '/list-intelligence.html' },
    { k: 'audience',  l: 'Audience read',    u: '/audience-read.html' },
    { k: 'sweep',     l: 'Site sweep',       u: '/site-sweep.html' },
    { k: 'defence',   l: 'Campaign defence', u: '/campaign-defence.html' },
    { k: 'simulator', l: 'ICO simulator',    u: '/ico-simulator.html' },
  ];
  // Which page re-runs the check that raised a fix (verified fixes get full credit)
  var TOOL_PAGE = {
    'ai checker': '/ai-checker.html', 'ai-checker': '/ai-checker.html', 'copy': '/ai-checker.html',
    'vendor checker': '/vendor-checker.html', 'vendor': '/vendor-checker.html', 'dpa scan': '/vendor-checker.html',
    'list intelligence': '/list-intelligence.html', 'database audit': '/list-intelligence.html', 'suppression': '/list-intelligence.html',
    'audience read': '/audience-read.html', 'site sweep': '/site-sweep.html', 'campaign defence': '/campaign-defence.html',
  };
  var BANDS = ['Under £1M', '£1M–£10M', '£10M–£50M', 'Over £50M'];
  var DISMISS = [
    ['not_applicable', 'Not applicable to us', 'Leaves your score.'],
    ['false_positive', 'Sendwize got this wrong', 'Leaves your score.'],
    ['accepted_risk', 'We accept the risk', 'Still counts as open.'],
  ];

  // ── helpers ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function gbp(n) { n = Math.round(Number(n) || 0); return '£' + n.toLocaleString('en-GB'); }
  function gbpK(n) { n = Number(n) || 0; return n >= 1e6 ? '£' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? '£' + Math.round(n / 1e3) + 'k' : gbp(n); }
  function range(lo, hi) { return lo === hi ? gbpK(hi) : gbpK(lo) + '–' + gbpK(hi); }
  function date(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function nice(s) { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }
  function $(sel, el) { return (el || root).querySelector(sel); }
  function link(path, query) { var u = API + path + '?' + (userId ? 'userId=' + encodeURIComponent(userId) : '') + (query ? '&' + query : ''); return window.SW && SW.withToken ? SW.withToken(u) : u; }
  function go(path, query) { location.href = link(path, query); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem('sw_' + k) || 'null'); localStorage.setItem('sw_' + k, JSON.stringify(v)); } catch (e) { return null; } }

  async function api(path, opts) {
    opts = opts || {};
    var f = window.swFetch || fetch;
    var r = await f(API + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((j && j.error) || ('Request failed (' + r.status + ')'));
    return j || {};
  }

  var toastT;
  function toast(msg, kind) {
    var t = document.getElementById('sw-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sw-toast'; t.className = 'sw-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = 'sw-toast on ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'sw-toast'; }, 3200);
  }

  // ── boot: wait for Memberstack ──
  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function tick() { var v = test(); if (v || Date.now() - start > ms) return resolve(v); setTimeout(tick, 150); })();
    });
  }

  async function boot() {
    root = document.getElementById('sw-dashboard');
    if (!root) return;
    root.className = 'sw-wrap';
    root.innerHTML = '<div class="sw-ld"><div class="sw-spin"></div>Loading your dashboard…</div>';
    var ms = await waitFor(function () { return window.$memberstackDom; }, 10000);
    if (!ms) { root.innerHTML = '<div class="sw-err">Could not load your login. Refresh the page.</div>'; return; }
    var m = null;
    try { m = await ms.getCurrentMember(); } catch (e) {}
    userId = m && m.data && m.data.id;
    if (!userId) { root.innerHTML = '<div class="sw-err">Please log in to see your dashboard.</div>'; return; }
    await waitFor(function () { return window.swFetch; }, 5000);
    load();
  }

  async function load() {
    try {
      D = await api('/api/dashboard?userId=' + encodeURIComponent(userId));
    } catch (e) {
      root.innerHTML = '<div class="sw-err">Could not load your dashboard: ' + esc(e.message) + '. <a class="sw-link" href="#" data-act="reload">Try again</a></div>';
      return;
    }
    if (D.profile && D.profile.onboardingComplete === false) { go('/onboarding.html'); return; }
    render();
    if (D.profile && !D.profile.revenueBandSet) bandModal();
    loadBriefing(); loadCampaigns(); loadHistory();
  }

  // ── render ──
  function render() {
    rotateVisits();
    var changed = whatChanged();
    root.innerHTML =
      toolsNav() + changed +
      '<div class="sw-grid sw-g-top">' + scoreCard() + heroTiles() + '</div>' +
      '<div class="sw-grid sw-g-2">' + clustersCard() + startHere() + '</div>' +
      '<div class="sw-grid sw-g-3">' + expiryCard() + briefingCard() + listValueCard() + '</div>' +
      '<div class="sw-card sw-pad" id="sw-fixes">' + fixesSection() + '</div>' +
      '<div class="sw-sec"><div class="sw-sec-h"><span class="sw-h2">Campaigns</span><a class="sw-link" href="' + esc(link('/campaign-defence.html')) + '">Open Campaign Defence</a></div><div id="sw-camps" class="sw-ld"><div class="sw-spin"></div></div></div>' +
      '<div class="sw-sec"><div class="sw-sec-h"><span class="sw-h2">Recent checks</span><span>' +
        ['ai', 'vendor', 'audience'].map(function (k) { return '<button class="sw-flt' + (st.histTab === k ? ' on' : '') + '" data-act="hist" data-k="' + k + '">' + { ai: 'Copy', vendor: 'Vendors', audience: 'Audience' }[k] + '</button>'; }).join('') +
      '</span></div><div id="sw-hist" class="sw-ld"><div class="sw-spin"></div></div></div>' +
      '<div class="sw-foot">' + esc(D.disclaimer || '') + ' <a href="' + esc(link('/profile.html')) + '">Your profile</a></div>';
    drawSpark();
  }

  function toolsNav() {
    return '<nav class="sw-tools" aria-label="Tools">' + TOOLS.map(function (t) {
      return '<button class="sw-nt' + (t.hot ? ' hot' : '') + '" data-act="tool" data-u="' + esc(t.u) + '">' + esc(t.l) + '</button>';
    }).join('') + '</nav>';
  }

  // Compares today with the most recent visit on an earlier day (this browser)
  function rotateVisits() {
    var today = D.generatedAt.slice(0, 10), last = store('last_' + userId);
    if (last && last.day !== today) store('base_' + userId, last);
    store('last_' + userId, { at: D.generatedAt, day: today, score: D.score.value, pending: D.counts ? D.counts.pending : 0, exposure: D.exposure.totalHigh });
  }
  function whatChanged() {
    var prev = store('base_' + userId);
    if (!prev || store('dismiss_changed_' + userId) === D.generatedAt.slice(0, 10)) return '';
    var bits = [], good = true;
    var s = D.score.value, ex = D.exposure.totalHigh, p = D.counts ? D.counts.pending : 0;
    if (s !== prev.score) { bits.push('score ' + (s > prev.score ? 'up' : 'down') + ' <b>' + Math.abs(s - prev.score) + '</b> to ' + s); if (s < prev.score) good = false; }
    if (p > prev.pending) { bits.push('<b>' + (p - prev.pending) + '</b> new finding' + (p - prev.pending > 1 ? 's' : '')); good = false; }
    if (p < prev.pending) bits.push('<b>' + (prev.pending - p) + '</b> finding' + (prev.pending - p > 1 ? 's' : '') + ' closed');
    if (Math.abs(ex - prev.exposure) >= 1000) { bits.push('upper exposure ' + (ex < prev.exposure ? 'down' : 'up') + ' to <b>' + gbpK(ex) + '</b>'); if (ex > prev.exposure) good = false; }
    if (!bits.length) return '';
    return '<div class="sw-changed' + (good ? ' good' : '') + '"><span>Since ' + esc(date(prev.at)) + ': ' + bits.join(', ') + '.</span><button class="sw-changed-x" data-act="close-changed" aria-label="Dismiss">✕</button></div>';
  }

  function scoreCard() {
    var s = D.score, c = 2 * Math.PI * 44, off = c * (1 - Math.max(0, Math.min(100, s.value || 0)) / 100);
    var ch = s.change ? '<div class="sw-note" style="margin-bottom:6px">' + (s.change > 0 ? '▲ ' : '▼ ') + Math.abs(s.change) + ' since last snapshot</div>' : '';
    var n = D.counts || {};
    return '<div class="sw-card sw-sc"><div class="sw-lbl">Compliance score</div>' +
      '<div class="sw-ring"><svg width="100" height="100" viewBox="0 0 100 100"><circle class="sw-ring-bg" cx="50" cy="50" r="44"/><circle class="sw-ring-fg" cx="50" cy="50" r="44" stroke="' + esc(s.colour || '#EA7317') + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>' +
      '<div class="sw-sc-num">' + (s.value || 0) + '<small>/ 100</small></div></div>' +
      '<span class="sw-pill" style="background:' + esc(s.colour || '#EA7317') + '22;color:' + esc(s.colour || '#EA7317') + '">' + esc(s.band || '') + '</span>' + ch +
      '<div class="sw-sc-counts"><div><div class="sw-scc-n">' + (n.pending || 0) + '</div><div class="sw-scc-l">Open</div></div><div><div class="sw-scc-n">' + (n.completed || 0) + '</div><div class="sw-scc-l">Fixed</div></div></div>' +
      '<div class="sw-note">' + esc(s.note) + '</div><div class="sw-spark" id="sw-spark"></div></div>';
  }

  function drawSpark() {
    var el = $('#sw-spark'), pts = (D.score.trend || []).filter(function (p) { return typeof p.score === 'number'; });
    if (!el) return;
    if (pts.length < 2) { el.innerHTML = '<div class="sw-note">Your trend appears after a second day of activity.</div>'; return; }
    var w = 200, h = 36, n = pts.length;
    var xy = pts.map(function (p, i) { return [(i / (n - 1)) * w, h - 2 - (p.score / 100) * (h - 4)]; });
    var d = xy.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" role="img" aria-label="Score over the last ' + n + ' snapshots"><path d="' + d + '" fill="none" stroke="#EA7317" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="sw-note">Last ' + n + ' snapshots</div>';
  }

  function heroTiles() {
    var e = D.exposure, ra = D.riskAddressed || {}, al = D.alreadyLost;
    var lost = al && al.amount ? '<div class="sw-hn">' + gbpK(al.amount) + '</div><div class="sw-hs">' + (al.isEstimate ? 'Estimated ' : '') + 'list value lost to ' + (al.excessUnsubs12mo || 0).toLocaleString('en-GB') + ' extra unsubscribes in 12 months' + (al.cplUsed ? ' at ' + gbp(al.cplUsed) + ' per lead' : '') + '.</div>'
      : '<div class="sw-hn">–</div><div class="sw-hs">Upload a list in List health to see what unsubscribes have cost you.</div>';
    var lk = e.likelihood ? '<span class="sw-like ' + esc(e.likelihood.level) + '" title="' + esc((e.likelihood.reasons || []).join('. ')) + '">' + esc(e.likelihood.level) + ' attention likelihood</span>' : '';
    var other = [];
    if (e.asaPending) other.push(e.asaPending + ' advertising finding' + (e.asaPending > 1 ? 's' : '') + ' (ASA: published rulings, no fines)');
    if (e.cmaPending) other.push(e.cmaPending + ' consumer law finding' + (e.cmaPending > 1 ? 's' : '') + (e.cmaMax ? ' (CMA: ' + esc(e.cmaMax.label) + ')' : ''));
    var raV = st.raMode === 'month' ? ra.monthTotal : ra.allTotal;
    return '<div class="sw-grid sw-g-3" style="margin:0">' +
      '<div class="sw-ht red"><div class="sw-hl">Already lost</div>' + lost + '</div>' +
      '<div class="sw-ht amber"><div class="sw-hl">Open regulatory exposure (ICO)</div><div class="sw-hn">' + (e.totalHigh ? range(e.totalLow, e.totalHigh) : '£0') + '</div>' +
        '<div class="sw-hs">Grouped the way a regulator would investigate. Comparable published cases, not a prediction.</div>' + lk +
        (other.length ? '<div class="sw-hs" style="margin-top:6px">' + other.join('<br>') + '</div>' : '') +
        (e.clusters && e.clusters.length ? '<button class="sw-link" data-act="why" data-id="' + esc(e.clusters[0].leadFixId) + '">Why this number?</button>' : '') + '</div>' +
      '<div class="sw-ht green"><div class="sw-hl">Risk addressed</div>' +
        '<div style="margin-top:4px"><button class="sw-tog' + (st.raMode === 'month' ? ' on' : '') + '" data-act="ra" data-m="month">This month</button><button class="sw-tog' + (st.raMode === 'all' ? ' on' : '') + '" data-act="ra" data-m="all">All time</button></div>' +
        '<div class="sw-hn">' + gbpK(raV || 0) + '</div>' +
        '<div class="sw-hs">' + (st.raMode === 'all' && ra.allTotal ? gbpK(ra.verified) + ' verified by a re-run, ' + gbpK(ra.selfAttested) + ' marked fixed by you.' : 'Exposure removed by the fixes you have completed.') + '</div></div></div>';
  }

  function clustersCard() {
    var cl = D.exposure.clusters || [];
    var body = cl.length ? cl.map(function (c) {
      return '<div class="sw-row"><div class="sw-row-main"><div class="sw-row-t">' + esc(c.label) + '</div><div class="sw-row-s">' + c.count + ' finding' + (c.count > 1 ? 's' : '') + '</div></div><div class="sw-row-v">' + range(c.low, c.high) + '</div><button class="sw-link" data-act="why" data-id="' + esc(c.leadFixId) + '">Why?</button></div>';
    }).join('') : '<div class="sw-empty">No open data protection findings.</div>';
    return '<div class="sw-card sw-pad"><div class="sw-lbl">Exposure by area</div>' + body +
      (D.exposure.duaaWarning ? '<div class="sw-note" style="margin-top:10px">' + esc(D.exposure.duaaWarning) + '</div>' : '') + '</div>';
  }

  // Top three open findings by what fixing them removes
  function startHere() {
    var sev = { critical: 4, high: 3, medium: 2, low: 1 };
    var top = (D.fixes.pending || []).slice().sort(function (a, b) {
      var x = (b.exposure && b.exposure.realisticHigh || 0) - (a.exposure && a.exposure.realisticHigh || 0);
      return x || (sev[b.severity] || 0) - (sev[a.severity] || 0);
    }).slice(0, 3);
    var body = top.length ? '<div class="sw-steps">' + top.map(function (f, i) {
      return '<div class="sw-step"><div class="sw-fx-body"><div class="sw-row-t">' + (i + 1) + '. ' + esc(nice(f.fixType)) + '</div><div class="sw-row-s">' + esc(f.description.slice(0, 140)) + '</div></div>' + expLine(f) + '</div>';
    }).join('') + '</div>' : '<div class="sw-empty">Nothing open. Run a check before your next send.</div>';
    return '<div class="sw-card sw-pad"><div class="sw-lbl">Start here</div>' + body + '</div>';
  }

  function expLine(f) {
    var e = f.exposure;
    if (!e) return '';
    if (e.category === 'ICO' && e.realisticHigh) return '<div class="sw-fx-exp"><span class="sw-badge ico">ICO</span> <span class="sw-fx-range">' + range(e.realisticLow, e.realisticHigh) + '</span>' + (e.basis === 'assessed' ? ' <span class="sw-badge est">AI-assessed</span>' : '') + ' <button class="sw-link" data-act="why" data-id="' + esc(f.id) + '">Why?</button></div>';
    if (e.category === 'ASA') return '<div class="sw-fx-exp"><span class="sw-badge asa">ASA</span> Published ruling risk, no fine</div>';
    if (e.category === 'CMA') return '<div class="sw-fx-exp"><span class="sw-badge cma">CMA</span> Statutory maximum applies</div>';
    if (e.category === 'Commercial') return '<div class="sw-fx-exp"><span class="sw-badge est">Commercial</span> ' + (e.realisticHigh ? range(e.realisticLow, e.realisticHigh) + ' revenue' : 'Revenue impact') + '</div>';
    return '';
  }

  function expiryCard() {
    var c = D.consentExpiry;
    var body = c && (c.in30 || c.in60 || c.in90) ? '<div class="sw-bkts">' +
      [['b30', c.in30, '30 days'], ['b60', c.in60, '60 days'], ['b90', c.in90, '90 days']].map(function (b) {
        return '<div class="sw-bkt ' + b[0] + '"><div class="sw-bkn">' + (b[1] || 0).toLocaleString('en-GB') + '</div><div class="sw-bkl">' + b[2] + '</div></div>';
      }).join('') + '</div><a class="sw-link" href="' + esc(link('/list-intelligence.html')) + '">Draft a re-consent email in List health</a>'
      : '<div class="sw-empty">No consents expiring in the next 90 days' + (c ? '.' : ' on record. Upload a list in List health.') + '</div>';
    return '<div class="sw-card sw-pad"><div class="sw-lbl">Consent expiring</div>' + body + '</div>';
  }

  function briefingCard() {
    return '<div class="sw-card sw-pad"><div class="sw-lbl">This week</div><div class="sw-brf-body clip" id="sw-brf"><div class="sw-spin"></div></div><button class="sw-link" data-act="brf-more" id="sw-brf-more" hidden>Read more</button></div>';
  }

  function listValueCard() {
    var v = D.listValue;
    var body = v && v.hasData && v.total ? '<div class="sw-hn">' + gbpK(v.total) + '</div><div class="sw-hs">Unrealised value in your lists.</div>' +
      (v.top || []).map(function (o) { return '<div class="sw-row"><div class="sw-row-main"><div class="sw-row-t">' + esc(o.title || o.name || nice(o.type)) + '</div></div><div class="sw-row-v">' + gbpK(o.value || o.estimatedValue || 0) + '</div></div>'; }).join('') +
      (v.basis ? '<div class="sw-note">' + esc(v.basis) + '</div>' : '')
      : '<div class="sw-empty">Upload a list in List health to see where the value is.</div>';
    return '<div class="sw-card sw-pad"><div class="sw-lbl">List value</div>' + body + '</div>';
  }

  function fixesSection() {
    var all = D.fixes.pending || [];
    var list = all.filter(function (f) {
      if (st.filter === 'all') return true;
      if (st.filter === 'improved') return !!f.improvedOnRerun;
      return f.exposure && f.exposure.category === st.filter;
    });
    var flt = [['all', 'All'], ['ICO', 'ICO'], ['ASA', 'ASA'], ['CMA', 'CMA'], ['improved', 'Improved']].map(function (x) {
      return '<button class="sw-flt' + (st.filter === x[0] ? ' on' : '') + '" data-act="flt" data-f="' + x[0] + '">' + x[1] + '</button>';
    }).join('');
    var rows = list.length ? list.map(function (f) {
      var page = TOOL_PAGE[String(f.tool || '').toLowerCase()];
      return '<div class="sw-fx" data-id="' + esc(f.id) + '"><span class="sw-dot dot-' + esc(f.severity || 'medium') + '"></span><div class="sw-fx-body">' +
        '<div class="sw-fx-type">' + esc(nice(f.fixType)) + '</div><div class="sw-fx-desc">' + esc(f.description) + '</div>' +
        '<div class="sw-fx-meta">' + (f.tool ? '<span class="sw-fx-tool">' + esc(f.tool) + '</span> · ' : '') + esc(nice(f.severity)) + (f.createdDate ? ' · found ' + esc(date(f.createdDate)) : '') + '</div>' +
        (f.improvedOnRerun ? '<div class="sw-improved">A re-run shows this has improved. Confirm to get full credit.</div>' : '') +
        '</div>' + expLine(f) +
        '<div class="sw-fx-act">' +
          (f.improvedOnRerun ? '<button class="sw-btn g" data-act="done" data-src="improved_on_rerun">Confirm improved</button>' : '<button class="sw-btn g" data-act="done" data-src="manual">Mark fixed</button>') +
          (page ? '<button class="sw-btn o" data-act="tool" data-u="' + esc(page) + '">Re-run check</button>' : '') +
          '<button class="sw-btn q" data-act="dismiss">Dismiss</button>' +
        '</div></div>';
    }).join('') : '<div class="sw-empty">' + (all.length ? 'Nothing matches this filter.' : 'No open action items.') + '</div>';
    return '<div class="sw-fx-hdr"><span class="sw-h2">Action items <span class="sw-cnt">' + all.length + '</span></span><span>' + flt + '</span></div>' + rows;
  }

  // ── deferred sections ──
  async function loadBriefing() {
    var el = $('#sw-brf');
    try {
      var b = await api('/api/data?action=briefing&userId=' + encodeURIComponent(userId));
      if (!el) return;
      el.innerHTML = b.briefing ? esc(b.briefing).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>') : '<div class="sw-empty">Your briefing appears once you have run a check.</div>';
      if (b.briefing && b.briefing.length > 320) $('#sw-brf-more').hidden = false; else el.classList.remove('clip');
    } catch (e) { if (el) el.innerHTML = '<div class="sw-empty">Briefing unavailable right now.</div>'; }
  }

  async function loadCampaigns() {
    var el = $('#sw-camps');
    try {
      var d = await api('/api/submit-check?action=dossier-list&limit=6&userId=' + encodeURIComponent(userId));
      var ds = d.dossiers || [];
      el.className = '';
      el.innerHTML = ds.length ? '<div class="sw-cards">' + ds.map(function (c) {
        return '<a class="sw-tile" style="display:block;text-decoration:none;color:inherit" href="' + esc(link('/campaign-defence.html', 'dossierId=' + encodeURIComponent(c.dossierId))) + '"><div class="sw-tile-k">' + esc(c.defenceStatus || c.status) + (c.needsReview ? ' · needs review' : '') + '</div><div class="sw-tile-t">' + esc(c.campaignTitle) + '</div>' +
          '<div class="sw-prog"><i style="width:' + Math.max(0, Math.min(100, c.modulesPct || 0)) + '%"></i></div><div class="sw-note">' + (c.modulesPct || 0) + '% evidence recorded' + (c.launchDate ? ' · launches ' + esc(date(c.launchDate)) : '') + '</div></a>';
      }).join('') + '</div>' : '<div class="sw-empty">No campaigns yet. Start one in Campaign Defence to keep your evidence in one place.</div>';
    } catch (e) { el.className = ''; el.innerHTML = '<div class="sw-empty">Campaigns unavailable right now.</div>'; }
  }

  var histCache = {};
  async function loadHistory() {
    var el = $('#sw-hist'), k = st.histTab;
    if (!el) return;
    try {
      if (!histCache[k]) {
        el.className = 'sw-ld'; el.innerHTML = '<div class="sw-spin"></div>';
        histCache[k] = (await api('/api/data?action=history&type=' + k + '&userId=' + encodeURIComponent(userId))).records || [];
      }
      var rs = histCache[k], per = 6, pages = Math.max(1, Math.ceil(rs.length / per));
      var p = st.page[k] = Math.min(st.page[k], pages - 1);
      el.className = '';
      if (!rs.length) { el.innerHTML = '<div class="sw-empty">No checks yet.</div>'; return; }
      el.innerHTML = rs.slice(p * per, p * per + per).map(function (r) { return histRow(k, r.fields || {}, r.id); }).join('') +
        (pages > 1 ? '<div class="sw-pgn"><button class="sw-flt" data-act="pg" data-d="-1"' + (p ? '' : ' disabled') + '>Previous</button>' + (p + 1) + ' of ' + pages + '<button class="sw-flt" data-act="pg" data-d="1"' + (p < pages - 1 ? '' : ' disabled') + '>Next</button></div>' : '');
    } catch (e) { el.className = ''; el.innerHTML = '<div class="sw-empty">Recent checks unavailable right now.</div>'; }
  }
  function histRow(k, f, id) {
    var t, s, d, href;
    if (k === 'ai') { t = f.CampaignName || f.Subject || 'Copy check'; s = f.Verdict || (f.IssueCount != null ? f.IssueCount + ' issues' : ''); d = f.CheckDate; href = link('/ai-report.html', 'id=' + encodeURIComponent(id)); }
    else if (k === 'vendor') { t = f.VendorName || f.Vendor || 'Vendor'; s = f.RiskLevel || f.Status || ''; d = f.LastChecked; href = link('/vendor-report.html', 'id=' + encodeURIComponent(id)); }
    else { t = f.CampaignName || f.Name || 'Audience read'; s = f.Verdict || f.Status || ''; d = f.SendDate; href = link('/audience-read.html'); }
    return '<div class="sw-row"><div class="sw-row-main"><div class="sw-row-t">' + esc(t) + '</div><div class="sw-row-s">' + [esc(s), esc(date(d))].filter(Boolean).join(' · ') + '</div></div><a class="sw-link" href="' + esc(href) + '">Open</a></div>';
  }

  // ── "Why this number?" drawer ──
  var drawer, overlay;
  function ensureLayers() {
    if (drawer) return;
    overlay = document.createElement('div'); overlay.className = 'sw-ov'; overlay.setAttribute('data-act', 'close');
    drawer = document.createElement('aside'); drawer.className = 'sw-drawer'; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Why this number?');
    document.body.appendChild(overlay); document.body.appendChild(drawer);
    [overlay, drawer].forEach(function (el) { el.addEventListener('click', onClick); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLayers(); });
  }
  function closeLayers() { if (drawer) { drawer.classList.remove('on'); overlay.classList.remove('on'); overlay.innerHTML = ''; } }

  async function why(fixId) {
    ensureLayers();
    overlay.innerHTML = ''; overlay.classList.add('on'); drawer.classList.add('on');
    drawer.innerHTML = '<button class="sw-dr-x" data-act="close" aria-label="Close">✕</button><div class="sw-ld"><div class="sw-spin"></div>Working out the figure…</div>';
    try { drawWhy(await api('/api/exposure?action=explain&userId=' + encodeURIComponent(userId) + '&fixId=' + encodeURIComponent(fixId))); }
    catch (e) { drawer.innerHTML = '<button class="sw-dr-x" data-act="close" aria-label="Close">✕</button><div class="sw-err">' + esc(e.message) + '</div>'; }
  }

  function drawWhy(x) {
    var e = x.exposure || {}, f = x.fix || {};
    var h = '<button class="sw-dr-x" data-act="close" aria-label="Close">✕</button><div class="sw-dr-h"><div class="sw-lbl">Why this number?</div><div class="sw-h2">' + esc(nice(f.fixType)) + '</div><div class="sw-row-s">' + esc(f.description) + '</div></div>';
    if (e.category === 'ICO' && e.realisticHigh) {
      var span = (e.frameHigh - e.frameLow) || 1;
      var l = ((e.realisticLow - e.frameLow) / span) * 100, w = ((e.realisticHigh - e.realisticLow) / span) * 100;
      h += '<div class="sw-dr-sec"><div class="sw-hn">' + range(e.realisticLow, e.realisticHigh) + '</div>' +
        '<div class="sw-hs">' + ({ assessed: 'Narrowed using rules and an AI reading of your evidence.', rules: 'Narrowed using facts we hold about this finding.', standard: 'Full range for comparable published cases. No evidence yet to narrow it.' }[e.basis] || '') + '</div>' +
        '<div class="sw-frame"><i style="left:' + Math.max(0, l).toFixed(1) + '%;width:' + Math.max(2, w).toFixed(1) + '%"></i></div>' +
        '<div class="sw-frame-l"><span>' + gbpK(e.frameLow) + '</span><span>Published-case range for your size and sector</span><span>' + gbpK(e.frameHigh) + '</span></div></div>';
      var fac = e.factors || [];
      h += '<div class="sw-dr-sec"><div class="sw-lbl">What moved it</div>' + (fac.length ? fac.map(function (q) {
        return '<div class="sw-fac"><span class="sw-fac-ic ' + (q.direction === 'up' ? 'up' : 'down') + '">' + (q.direction === 'up' ? '↑' : '↓') + '</span><div>' + esc(q.label) + '<span class="sw-src' + (q.source === 'ai' ? ' ai' : '') + '">' + (q.source === 'ai' ? 'AI' : 'Rule') + '</span>' + (q.evidence ? '<div class="sw-fac-ev">“' + esc(q.evidence) + '”</div>' : '') + '</div></div>';
      }).join('') : '<div class="sw-empty">Nothing yet. The figure stays at the full published range until there is evidence.</div>') + '</div>';
      if (e.aiSummary) h += '<div class="sw-dr-sec"><div class="sw-lbl">In plain English</div><div class="sw-hs">' + esc(e.aiSummary) + '</div></div>';
      if (x.canAssess) h += '<div class="sw-dr-sec">' + (x.assessment ? '<div class="sw-note">AI read this evidence on ' + esc(date(x.assessment.assessedAt)) + ' (' + esc(x.assessment.confidence) + ' confidence).</div>' : x.assessmentStale ? '<div class="sw-note">The evidence has changed since the last AI reading.</div>' : '') +
        '<button class="sw-wide-btn" data-act="assess" data-id="' + esc(f.id) + '">' + (x.assessment ? 'Re-assess with AI' : 'Assess with AI') + '</button><div class="sw-note" style="margin-top:6px">AI can only pick from a fixed list of factors, and each must quote your evidence word for word. It never writes the number.</div></div>';
      var cases = e.closestCases || [];
      if (cases.length) h += '<div class="sw-dr-sec"><div class="sw-lbl">Closest published cases</div>' + cases.map(function (c) {
        return '<div class="sw-case"><b>' + esc(c.name) + '</b> · ' + esc(c.regulator) + ' ' + esc(c.date) + ' · ' + gbp(c.penalty) + '<div class="sw-hs">' + esc(c.summary) + '</div><a class="sw-link" href="' + esc(c.url) + '" target="_blank" rel="noopener">ICO enforcement page</a></div>';
      }).join('') + '</div>';
      if ((x.tips || []).length) h += '<div class="sw-dr-sec"><div class="sw-lbl">What would bring it down</div>' + x.tips.map(function (t) { return '<div class="sw-fac"><span class="sw-fac-ic down">↓</span><div>' + esc(t) + '</div></div>'; }).join('') + '</div>';
      h += '<div class="sw-dr-sec"><div class="sw-note">' + esc(e.rangeLabel || '') + '. Legal maximum: ' + esc(x.legalMax) + '. ' + esc(x.duaaWarning || '') + '</div></div>';
    } else if (e.category === 'ASA') {
      h += '<div class="sw-dr-sec"><div class="sw-hs">The ASA does not fine. The risk is an upheld ruling published under your brand name.</div>' + (e.referralNote ? '<div class="sw-note" style="margin-top:8px">' + esc(e.referralNote) + '</div>' : '') + '</div>';
    } else if (e.category === 'CMA') {
      h += '<div class="sw-dr-sec"><div class="sw-hs">Under the DMCCA 2024 the CMA can fine directly. We show the statutory maximum for your size only, because there are not yet enough published cases to estimate a realistic range.</div>' + (D && D.exposure.cmaMax ? '<div class="sw-note" style="margin-top:8px">' + esc(D.exposure.cmaMax.label) + '</div>' : '') + '</div>';
    } else {
      h += '<div class="sw-dr-sec"><div class="sw-hs">This is a commercial figure (lost revenue), shown separately and never added to regulatory exposure.</div></div>';
    }
    h += '<div class="sw-dr-sec"><div class="sw-note">' + esc(x.disclaimer || '') + '</div></div>';
    drawer.innerHTML = h;
  }

  async function assess(fixId, btn) {
    btn.disabled = true; btn.textContent = 'Reading your evidence…';
    try {
      var x = await api('/api/exposure?action=assess', { method: 'POST', body: { userId: userId, fixId: fixId } });
      drawWhy(x); toast(x.note || 'Assessment updated', 'ok');
      refreshQuiet();
    } catch (e) { btn.disabled = false; btn.textContent = 'Assess with AI'; toast(e.message, 'er'); }
  }

  // ── modals ──
  function modal(html) {
    ensureLayers();
    drawer.classList.remove('on');
    overlay.innerHTML = '<div class="sw-modal" role="dialog" aria-modal="true">' + html + '</div>';
    overlay.classList.add('on');
  }

  function bandModal() {
    modal('<div class="sw-h2">What is your annual revenue?</div><div class="sw-hs" style="margin:6px 0 14px">Regulators scale penalties to business size, so this sets the published-case range we compare you with.</div>' +
      BANDS.map(function (b, i) { return '<label class="sw-rb"><input type="radio" name="sw-band" value="' + i + '"> ' + esc(b) + '</label>'; }).join('') +
      '<button class="sw-wide-btn" data-act="save-band" disabled>Save</button>');
  }

  function dismissModal(fixId) {
    modal('<div class="sw-h2">Why are you dismissing this?</div><div class="sw-hs" style="margin:6px 0 14px">This changes how it counts in your score.</div>' +
      DISMISS.map(function (d) { return '<label class="sw-rb"><input type="radio" name="sw-dis" value="' + d[0] + '"> <span><b>' + esc(d[1]) + '</b><br><span class="sw-note">' + esc(d[2]) + '</span></span></label>'; }).join('') +
      '<button class="sw-wide-btn" data-act="do-dismiss" data-id="' + esc(fixId) + '" disabled>Dismiss</button>');
  }

  // ── actions ──
  async function refreshQuiet() {
    try { D = await api('/api/dashboard?userId=' + encodeURIComponent(userId)); } catch (e) { return; }
    var keepB = $('#sw-brf') && $('#sw-brf').innerHTML, keepC = $('#sw-camps') && $('#sw-camps').outerHTML;
    render();
    if (keepB) { $('#sw-brf').innerHTML = keepB; if (keepB.length > 320) $('#sw-brf-more').hidden = false; }
    if (keepC) $('#sw-camps').outerHTML = keepC;
    loadHistory();
  }

  async function complete(fixId, src, btn) {
    btn.disabled = true;
    try {
      await api('/api/fixes?action=complete', { method: 'POST', body: { userId: userId, fixId: fixId, completionSource: src } });
      toast(src === 'improved_on_rerun' ? 'Confirmed. Full credit added.' : 'Marked fixed. Re-run the check for full credit.', 'ok');
      refreshQuiet();
    } catch (e) { btn.disabled = false; toast(e.message, 'er'); }
  }

  async function dismiss(fixId, reason, btn) {
    btn.disabled = true;
    try {
      await api('/api/fixes?action=dismiss', { method: 'POST', body: { userId: userId, fixId: fixId, reason: reason } });
      closeLayers(); toast('Dismissed', 'ok'); refreshQuiet();
    } catch (e) { btn.disabled = false; toast(e.message, 'er'); }
  }

  async function saveBand(btn) {
    var c = overlay.querySelector('input[name=sw-band]:checked');
    if (!c) return;
    btn.disabled = true;
    try {
      await api('/api/profile?action=save', { method: 'POST', body: { userId: userId, revenueBand: BANDS[+c.value] } });
      closeLayers(); toast('Saved', 'ok'); refreshQuiet();
    } catch (e) { btn.disabled = false; toast(e.message, 'er'); }
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-act]');
    if (!t) return;
    var a = t.getAttribute('data-act');
    if (a === 'close' && t !== ev.target && t.classList.contains('sw-ov')) return; // clicks inside a modal
    var fx = t.closest('.sw-fx'), id = t.getAttribute('data-id') || (fx && fx.getAttribute('data-id'));
    switch (a) {
      case 'tool': go(t.getAttribute('data-u')); break;
      case 'reload': ev.preventDefault(); load(); break;
      case 'why': why(id); break;
      case 'close': closeLayers(); break;
      case 'assess': assess(id, t); break;
      case 'done': complete(id, t.getAttribute('data-src'), t); break;
      case 'dismiss': dismissModal(id); break;
      case 'do-dismiss': var r = overlay.querySelector('input[name=sw-dis]:checked'); if (r) dismiss(id, r.value, t); break;
      case 'save-band': saveBand(t); break;
      case 'flt': st.filter = t.getAttribute('data-f'); $('#sw-fixes').innerHTML = fixesSection(); break;
      case 'ra': st.raMode = t.getAttribute('data-m'); var g = $('.sw-g-top'); g.innerHTML = scoreCard() + heroTiles(); drawSpark(); break;
      case 'hist': st.histTab = t.getAttribute('data-k'); root.querySelectorAll('[data-act=hist]').forEach(function (b) { b.classList.toggle('on', b === t); }); loadHistory(); break;
      case 'pg': st.page[st.histTab] += +t.getAttribute('data-d'); loadHistory(); break;
      case 'brf-more': $('#sw-brf').classList.remove('clip'); t.hidden = true; break;
      case 'close-changed': store('dismiss_changed_' + userId, D.generatedAt.slice(0, 10)); t.parentNode.remove(); break;
    }
  }
  function onChange(ev) {
    if (ev.target.name === 'sw-band' || ev.target.name === 'sw-dis') {
      overlay.querySelectorAll('.sw-rb').forEach(function (l) { l.classList.toggle('on', l.contains(ev.target)); });
      var b = overlay.querySelector('.sw-wide-btn'); if (b) b.disabled = false;
    }
  }

  function start() {
    boot().then(function () {
      if (!root) return;
      root.addEventListener('click', onClick);
      ensureLayers();
      overlay.addEventListener('change', onChange);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
