/* ─────────────────────────────────────────────────────────────
   SENDWIZE — sw-dashboard.js v1.4  (browser)
   The member dashboard, served from Vercel so the Webflow embed stays
   a few lines long. Needs sw-auth.js in the Webflow site head and
   sw-dashboard.css on the page. Renders into <div id="sw-dashboard">.

   Every figure comes from /api/dashboard (one call, shared exposure
   engine). "Why this number?" comes from /api/exposure. Briefing,
   campaigns and recent checks load after first paint.

   v1.4: easier to use. A "My Sendwize portal" header; Case Twin, then
   "Start here" as one-line rows with Fix it; three headline figures with
   the full breakdown one tap away; a three-step start for new accounts;
   plainer wording throughout.

   v1.3: the business profile is required. Until turnover, list size,
   opt-in records and complaint / regulator history are answered, the
   dashboard shows a short profile form in place of any £ figure. Every
   figure links to "The Sendwize exposure algorithm" page, which explains
   the method from the live engine constants.

   v1.3: "Sendwize noticed": alerts worked out from past uploads.

   v1.2: action items are compact. Each risk area folds (only the riskiest
   opens), shows its three best-value fixes first, and every row has
   one-tap Fix it and ✓ buttons without opening it.

   v1.1: Case Twin (closest published case, side by side), fixes
   grouped by risk area and expandable in place with a ready-to-use
   fix, effort chips and Quick wins, What-if mode, clickable areas,
   interactive score trend, animated figures and a small celebration
   when a fix closes.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var API = 'https://sendwize-backend.vercel.app';
  var root, userId, member = null, D = null;
  var st = { detail: false, filter: 'all', area: null, twinOnly: false, whatif: false, picked: {}, open: {}, raMode: 'month', lane: {}, laneMore: {}, noticedAll: false, page: { ai: 0, verdict: 0, simulation: 0, vendor: 0, audience: 0 }, histTab: 'ai' };
  var drafts = {}, nums = {}, lastRing = null;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var AREA_LABELS = { consent: 'Marketing consent', suppression: 'Opt-outs and suppression', processors: 'Processors and data sharing', transparency: 'Transparency and identity', lawful_basis: 'Legitimate interests', ASA: 'Advertising claims (ASA)', CMA: 'Consumer law (CMA)', Commercial: 'Commercial', other: 'Other' };

  // Tools grouped by the job a marketer is doing. Names match each tool's
  // own page and the switcher in /sw-tool-nav.js; change all three together.
  var TOOL_GROUPS = [
    { l: 'Before you send', tools: [
      { k: 'verdict',   l: 'Send-day verdict',    u: '/send-verdict.html',      d: 'Go, fix first or hold for a campaign', hot: true },
      { k: 'copy',      l: 'Copy checker',        u: '/ai-checker.html',        d: 'Check the wording of an email or ad' },
    ] },
    { l: 'Your list', tools: [
      { k: 'list',      l: 'List health',         u: '/list-intelligence.html', d: 'Consent, value and who to remove' },
      { k: 'audience',  l: 'Audience read',       u: '/audience-read.html',     d: 'What your last send did to your list' },
    ] },
    { l: 'Your website and suppliers', tools: [
      { k: 'sweep',     l: 'Site sweep',          u: '/site-sweep.html',        d: 'Cookies, privacy notice and sign-up forms' },
      { k: 'vendor',    l: 'Third parties',       u: '/vendor-checker.html',    d: 'Suppliers who handle your data' },
    ] },
    { l: 'Records and practice', tools: [
      { k: 'defence',   l: 'Campaign defence',    u: '/campaign-defence.html',  d: 'Keep proof you checked each campaign' },
      { k: 'simulator', l: 'Regulator simulator', u: '/ico-simulator.html',     d: 'Rehearse an ICO, ASA or CMA investigation' },
    ] },
  ];
  // Which page re-runs the check that raised a fix (verified fixes get full credit)
  var TOOL_PAGE = {
    'ai checker': '/ai-checker.html', 'ai-checker': '/ai-checker.html', 'copy': '/ai-checker.html',
    'vendor checker': '/vendor-checker.html', 'vendor': '/vendor-checker.html', 'dpa scan': '/vendor-checker.html',
    'list intelligence': '/list-intelligence.html', 'database audit': '/list-intelligence.html', 'suppression': '/list-intelligence.html',
    'audience read': '/audience-read.html', 'site sweep': '/site-sweep.html', 'campaign defence': '/campaign-defence.html',
  };
  var BANDS = ['Under £1M', '£1M–£10M', '£10M–£50M', 'Over £50M'];
  var SECTORS = [['ecommerce', 'Ecommerce / Retail'], ['b2b', 'B2B / Professional Services'], ['saas', 'SaaS / Technology'], ['media', 'Media / Publishing / Newsletter'], ['finance', 'Finance / Financial Services'], ['health', 'Health / Healthcare'], ['gambling', 'Gambling'], ['charity', 'Charity / Non-profit'], ['general', 'Agency or Other']];
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
  // "About £54k", the most likely figure; falls back to the band alone
  function likely(ml, lo, hi) { return ml ? 'About ' + gbpK(ml) : range(lo, hi); }
  var CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
  function confChip(c) { return c ? '<span class="sw-conf ' + esc(c) + '">' + esc(CONF[c] || c) + '</span>' : ''; }
  function date(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function nice(s) { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }
  function $(sel, el) { return (el || root).querySelector(sel); }
  function link(path, query) { var u = API + path + '?' + (userId ? 'userId=' + encodeURIComponent(userId) : '') + (query ? '&' + query : ''); return window.SW && SW.withToken ? SW.withToken(u) : u; }
  function go(path, query) { location.href = link(path, query); }
  function algoLink(label) { return '<a class="sw-link sw-algo" href="' + esc(link('/exposure-algorithm.html')) + '">' + esc(label || 'The Sendwize exposure algorithm') + '</a>'; }
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

  // ── motion: figures count to their new value, the ring fills ──
  var FMT = { int: function (n) { return String(Math.round(n)); }, gbpK: gbpK, about: function (n) { return 'About ' + gbpK(n); } };
  function cu(k, v, f) { return '<span class="sw-cu" data-k="' + k + '" data-v="' + (Number(v) || 0) + '" data-f="' + f + '">' + FMT[f](REDUCED ? v : nums[k] != null ? nums[k] : 0) + '</span>'; }
  function animate() {
    root.querySelectorAll('.sw-cu').forEach(function (el) {
      var k = el.getAttribute('data-k'), to = +el.getAttribute('data-v'), fmt = FMT[el.getAttribute('data-f')];
      var from = nums[k] != null ? nums[k] : 0;
      nums[k] = to;
      if (REDUCED || from === to) { el.textContent = fmt(to); return; }
      var t0 = performance.now(), dur = 900;
      (function step() {
        var p = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(from + (to - from) * e);
        if (p < 1) requestAnimationFrame(step);
      })();
    });
    var ring = $('#sw-ring-fg');
    if (ring) {
      var target = ring.getAttribute('data-to');
      lastRing = +target;
      requestAnimationFrame(function () { requestAnimationFrame(function () { ring.setAttribute('stroke-dashoffset', target); }); });
    }
  }

  // Small burst of confetti from an element (skipped for reduced motion)
  function celebrate(fromEl, big) {
    if (REDUCED) return;
    var r = fromEl && fromEl.isConnected ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    var box = document.createElement('div'); box.className = 'sw-confetti'; box.setAttribute('aria-hidden', 'true');
    box.style.left = (r.left + r.width / 2) + 'px'; box.style.top = (r.top + r.height / 2) + 'px';
    var cols = ['#EA7317', '#16a34a', '#ca8a04', '#7c3aed', '#0ea5e9'];
    for (var i = 0, n = big ? 46 : 26; i < n; i++) {
      var p = document.createElement('i'), a = Math.random() * Math.PI * 2, d = 60 + Math.random() * (big ? 160 : 100);
      p.style.background = cols[i % cols.length];
      p.style.setProperty('--x', Math.cos(a) * d + 'px'); p.style.setProperty('--y', (Math.sin(a) * d - 40) + 'px'); p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      p.style.animationDelay = (Math.random() * 80) + 'ms';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 1400);
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
    member = m.data;
    st.detail = !!store('detail_' + userId);
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
    if (D.profile && D.profile.complete === false) { renderGate(); return; }
    render();
    if (D.profile && !D.profile.revenueBandSet) bandModal();
    loadBriefing(); loadCampaigns(); loadHistory();
  }

  // ── render ──
  function render() {
    rotateVisits();
    var changed = whatChanged(), first = firstRun();
    // The scoreboard leads, then Case Twin and what to do next
    root.innerHTML =
      portalHead() + toolsNav() + changed + scoreboard() +
      (st.detail ? '<div class="sw-det"><div class="sw-det-tiles">' + heroTiles() + '</div>' + '<div class="sw-open"><div class="sw-lbl">Score trend</div><div id="sw-spark"></div></div>' + clustersCard() + '</div>' : '') +
      (first ? first : twinCard() + startHere()) + noticedCard() +
      '<div class="sw-quiet">' + expiryCard() + briefingCard() + listValueCard() + '</div>' +
      (first && !(D.fixes.pending || []).length ? '<div id="sw-fixes" hidden></div>' : '<div class="sw-open sw-fixes" id="sw-fixes">' + fixesSection() + '</div>') +
      '<div class="sw-sec"><div class="sw-sec-h"><span class="sw-h2">Campaigns</span><a class="sw-link" href="' + esc(link('/campaign-defence.html')) + '">Open Campaign Defence</a></div><div id="sw-camps" class="sw-ld"><div class="sw-spin"></div></div></div>' +
      '<div class="sw-sec"><div class="sw-sec-h"><span class="sw-h2">Recent checks</span><span>' +
        ['ai', 'verdict', 'simulation', 'vendor', 'audience'].map(function (k) { return '<button class="sw-flt' + (st.histTab === k ? ' on' : '') + '" data-act="hist" data-k="' + k + '">' + { ai: 'Copy', verdict: 'Verdicts', simulation: 'Simulations', vendor: 'Third parties', audience: 'Audience' }[k] + '</button>'; }).join('') +
      '</span></div><div id="sw-hist" class="sw-ld"><div class="sw-spin"></div></div></div>' +
      '<div class="sw-foot">' + esc(D.disclaimer || '') + ' <a href="' + esc(link('/exposure-algorithm.html')) + '">The Sendwize exposure algorithm</a> · <a href="' + esc(link('/profile.html')) + '">Your business profile</a></div>';
    drawSpark(); animate();
  }

  // ── Business profile gate: no £ figure until these are answered ──
  function renderGate() {
    var a = (D.profile && D.profile.answers) || {}, n = (D.counts && D.counts.pending) || 0;
    function opt(v, l, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>'; }
    function yn(id, label, why, cur) {
      return '<div class="sw-tf"><label for="' + id + '">' + label + '</label><select id="' + id + '"><option value="">Choose</option>' + opt('No', 'No', cur) + opt('Yes', 'Yes', cur) + '</select><div class="sw-note">' + why + '</div></div>';
    }
    root.innerHTML = portalHead() + toolsNav() +
      '<div class="sw-card sw-gate"><div class="sw-gate-h"><div class="sw-lbl">Step 1 · Required</div><div class="sw-gate-t">Set up your business profile</div>' +
        '<div class="sw-hs">Every £ figure on your dashboard is scaled to your business: regulators fine a £500k shop and a £40M retailer very differently. Six answers, about a minute. Your dashboard opens as soon as they are saved.' +
        (n ? ' You already have <b>' + n + '</b> open finding' + (n > 1 ? 's' : '') + ' waiting to be priced.' : '') + '</div></div>' +
      '<div class="sw-gate-grid">' +
        '<div class="sw-tf"><label for="sw-g-sector">Sector</label><select id="sw-g-sector">' + SECTORS.map(function (x) { return opt(x[0], x[1], a.sector); }).join('') + '</select><div class="sw-note">Finance, health and gambling are fined more heavily; charities and B2B less.</div></div>' +
        '<div class="sw-tf"><label for="sw-g-turn">Annual turnover (£)</label><input id="sw-g-turn" type="number" min="1" inputmode="numeric" placeholder="e.g. 3500000" value="' + esc(a.annualTurnover || '') + '"><div class="sw-note">An estimate is fine. Sets the size band of published cases we compare you with.</div></div>' +
        '<div class="sw-tf"><label for="sw-g-list">People on your marketing list</label><input id="sw-g-list" type="number" min="1" inputmode="numeric" placeholder="e.g. 25000" value="' + esc(a.listSize || '') + '"><div class="sw-note">Audience size is one of the biggest factors in published fines.</div></div>' +
        '<div class="sw-tf"><label for="sw-g-cons">Do you keep a dated record of each opt-in?</label><select id="sw-g-cons"><option value="">Choose</option>' + opt('all', 'Yes, for everyone', a.consentRecords) + opt('some', 'For some contacts, or not sure', a.consentRecords) + opt('none', 'No', a.consentRecords) + '</select><div class="sw-note">Proof of consent is the first thing the ICO asks for.</div></div>' +
        yn('sw-g-comp', 'Complaints from recipients in the last two years?', 'Complaints usually trigger investigations.', a.complaintsReceived) +
        yn('sw-g-reg', 'Contact from the ICO, ASA or CMA in the last two years?', 'Earlier regulator contact counts against you.', a.priorRegulatorContact) +
      '</div>' +
      '<button class="sw-wide-btn" data-act="save-gate">Save and open my dashboard</button>' +
      '<div class="sw-note" style="margin-top:10px;text-align:center">How each answer moves your figures: ' + algoLink() + '. You can change them any time in your profile.</div></div>';
  }

  async function saveGate(btn) {
    function v(id) { var el = root.querySelector('#' + id); return el ? el.value.trim() : ''; }
    var body = { userId: userId, sector: v('sw-g-sector'), annualTurnover: parseFloat(v('sw-g-turn')) || null, listSize: parseFloat(v('sw-g-list')) || null,
      consentRecords: v('sw-g-cons'), complaintsReceived: v('sw-g-comp'), priorRegulatorContact: v('sw-g-reg') };
    var miss = [];
    if (!(body.annualTurnover > 0)) miss.push('turnover');
    if (!(body.listSize > 0)) miss.push('list size');
    if (!body.consentRecords) miss.push('opt-in records');
    if (!body.complaintsReceived) miss.push('complaints');
    if (!body.priorRegulatorContact) miss.push('regulator contact');
    if (miss.length) { toast('Still needed: ' + miss.join(', '), 'er'); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/profile?action=save', { method: 'POST', body: body });
      root.innerHTML = '<div class="sw-ld"><div class="sw-spin"></div>Working out your figures…</div>';
      await load(); toast('Profile saved. Figures updated.', 'ok');
    } catch (e) { btn.disabled = false; btn.textContent = 'Save and open my dashboard'; toast(e.message, 'er'); }
  }

  // "Scaled to: £3.5M turnover, 25,000 contacts, ecommerce · Edit"
  function profileLine() {
    var a = (D.profile && D.profile.answers) || {}, bits = [];
    if (a.annualTurnover) bits.push(gbpK(a.annualTurnover) + ' turnover');
    if (a.listSize) bits.push(Number(a.listSize).toLocaleString('en-GB') + ' contacts');
    if (a.sector) bits.push(nice(a.sector));
    return bits.length ? '<div class="sw-note" style="margin-top:6px">Scaled to your business: ' + esc(bits.join(', ')) + ' · <a class="sw-link" style="font-size:10px" href="' + esc(link('/profile.html')) + '">Edit</a></div>' : '';
  }

  // "My Sendwize portal": who is signed in, today's date and the account links
  function portalHead() {
    var cf = (member && member.customFields) || {}, a = (D && D.profile && D.profile.answers) || {}, bits = [];
    var co = cf.company || cf['company-name'] || '';
    if (co) bits.push(co);
    if (a.sector) bits.push(nice(a.sector));
    if (a.annualTurnover) bits.push(gbpK(a.annualTurnover) + ' turnover');
    if (a.listSize) bits.push(Number(a.listSize).toLocaleString('en-GB') + ' contacts');
    return '<header class="sw-portal"><div><div class="sw-portal-t">My Sendwize portal</div>' +
      (bits.length ? '<div class="sw-portal-s">' + esc(bits.join(' · ')) + '</div>' : '') + '</div>' +
      '<nav class="sw-portal-links" aria-label="Account"><a href="' + esc(link('/profile.html')) + '">Business profile</a>' +
      '<a href="' + esc(link('/exposure-algorithm.html')) + '">Method</a></nav></header>';
  }

  function toolsNav() {
    // One bar, in the order of the groups; hover or long-press shows what each is for
    return '<nav class="sw-tools" aria-label="Tools">' + TOOL_GROUPS.map(function (g) {
      return g.tools.map(function (t) {
        return '<button class="sw-nt' + (t.hot ? ' hot' : '') + '" data-act="tool" data-u="' + esc(t.u) + '" title="' + esc(g.l + ': ' + t.d) + '">' + esc(t.l) + '</button>';
      }).join('');
    }).join('') + '</nav>';
  }

  // New accounts: three first checks instead of a page of empty cards
  function firstRun() {
    var n = D.counts || {};
    if ((n.pending || 0) + (n.completed || 0) > 0 || store('firstrun_hide_' + userId)) return '';
    var fixes = (D.fixes.pending || []).concat(D.fixes.completed || []);
    function ran(tool) { return fixes.some(function (f) { return String(f.tool || '').toLowerCase() === tool; }); }
    var steps = [
      [!!(D.listValue && D.listValue.hasData), 'Upload your marketing list', 'See who you can legally email, whose consent is running out and what the list is worth. Any ESP export works.', '/list-intelligence.html', 'Upload a list'],
      [false, 'Check your next campaign', 'Paste the email or ad before it goes out. You get one answer: go, fix first or hold.', '/send-verdict.html', 'Check a campaign'],
      [ran('site sweep'), 'Sweep your website', 'Finds gaps in cookies, your privacy notice and sign-up forms across the whole site.', '/site-sweep.html', 'Sweep my site'],
    ];
    var done = steps.filter(function (s) { return s[0]; }).length;
    return '<div class="sw-open sw-first"><div class="sw-first-h"><div><div class="sw-lbl">Get started · ' + done + ' of 3 done</div><div class="sw-h2">Three checks to see where you stand</div>' +
      '<div class="sw-hs">Findings appear here with their £ exposure and the fix.</div></div>' +
      '<button class="sw-link" data-act="first-hide">Hide this</button></div><div class="sw-first-steps">' + steps.map(function (s, i) {
        return '<div class="sw-first-s' + (s[0] ? ' done' : '') + '"><div class="sw-step-n">' + (s[0] ? '✓' : i + 1) + '</div><div class="sw-fx-body"><div class="sw-row-t">' + esc(s[1]) + '</div><div class="sw-row-s">' + esc(s[2]) + '</div>' +
          (s[0] ? '<div class="sw-note">Done</div>' : '<button class="sw-btn o" data-act="tool" data-u="' + esc(s[3]) + '">' + esc(s[4]) + '</button>') + '</div></div>';
      }).join('') + '</div></div>';
  }

  // Levels on the way to 100, so each fix visibly moves you up
  var LEVELS = [[0, 'Exposed'], [40, 'Getting there'], [60, 'Solid'], [80, 'Strong'], [95, 'Audit-ready']];
  function level(v) {
    var i = LEVELS.length - 1;
    while (i > 0 && v < LEVELS[i][0]) i--;
    return { i: i, name: LEVELS[i][1], next: LEVELS[i + 1] || null, from: LEVELS[i][0] };
  }
  // Score points one fix would add
  function pts(f) { var o = {}; o[f.id] = 1; return Math.max(0, projScore(o) - (D.score.value || 0)); }
  // Weeks in a row (ending this week or last) with at least one fix
  function streakWeeks() {
    var wk = function (d) { var t = new Date(d); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.getTime(); };
    var seen = {};
    (D.fixes.completed || []).forEach(function (f) { if (f.completedDate) seen[wk(f.completedDate)] = 1; });
    var w = wk(new Date()), WEEK = 7 * 864e5, n = 0;
    if (!seen[w]) w -= WEEK;
    while (seen[w]) { n++; w -= WEEK; }
    return n;
  }

  // The scoreboard: score, fine risk and risk cleared, side by side at the top
  function scoreboard() {
    var s = D.score, e = D.exposure, ra = D.riskAddressed || {}, n = D.counts || {};
    var other = (e.asaPending || 0) + (e.cmaPending || 0);
    var fresh = !((n.pending || 0) + (n.completed || 0)) && !(D.listValue && D.listValue.hasData);
    var v = s.value || 0, lv = level(v), c = 2 * Math.PI * 52, off = c * (1 - Math.max(0, Math.min(100, v)) / 100);
    var toNext = lv.next ? Math.round((v - lv.from) / (lv.next[0] - lv.from) * 100) : 100;
    var open = e.totalMostLikely || 0, cleared = ra.allTotal || 0, pct = cleared + open ? Math.round(cleared / (cleared + open) * 100) : 0;
    var streak = streakWeeks();
    var score = fresh ? '<div class="sw-bd-ring"><div class="sw-sc-num">–</div></div><div class="sw-bd-lv">No score yet</div><div class="sw-hs">Appears after your first check.</div>'
      : '<div class="sw-bd-ring"><svg width="124" height="124" viewBox="0 0 124 124"><circle class="sw-ring-bg" cx="62" cy="62" r="52"/><circle class="sw-ring-fg" id="sw-ring-fg" cx="62" cy="62" r="52" stroke="' + esc(s.colour || '#EA7317') + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (REDUCED ? off : lastRing == null ? c : lastRing).toFixed(1) + '" data-to="' + off.toFixed(1) + '"/></svg>' +
        '<div class="sw-sc-num">' + cu('s_score', v, 'int') + '<small>score</small></div></div>' +
        '<div class="sw-bd-lv">' + esc(lv.name) + (s.change ? ' <span class="sw-note">' + (s.change > 0 ? '▲ ' : '▼ ') + Math.abs(s.change) + '</span>' : '') + '</div>' +
        (lv.next ? '<div class="sw-bd-bar"><i style="width:' + toNext + '%"></i></div><div class="sw-note">' + (lv.next[0] - v) + ' points to <b>' + esc(lv.next[1]) + '</b></div>' : '<div class="sw-note">Top level. Keep it there.</div>');
    return '<div class="sw-board">' +
      '<div class="sw-bd-col sw-bd-score">' + score + '</div>' +
      '<div class="sw-bd-col"><div class="sw-hl">ICO fine risk</div><div class="sw-bd-n">' + (e.totalHigh && e.totalMostLikely ? cu('s_ico', e.totalMostLikely, 'about') : e.totalHigh ? range(e.totalLow, e.totalHigh) : '£0') + '</div>' +
        '<div class="sw-hs">' + (e.totalHigh ? 'Likely ' + range(e.totalLow, e.totalHigh) + ', from similar published fines. ' : 'Nothing open that the ICO fines for. ') +
        (other ? other + ' advertising or consumer law finding' + (other > 1 ? 's' : '') + ' on top. ' : '') +
        (e.clusters && e.clusters.length ? '<button class="sw-link" data-act="why" data-id="' + esc(e.clusters[0].leadFixId) + '">Why?</button>' : '') + '</div></div>' +
      '<div class="sw-bd-col"><div class="sw-hl">Risk cleared</div><div class="sw-bd-n good">' + cu('s_ra', cleared, 'gbpK') + '</div>' +
        '<div class="sw-bd-bar good"><i style="width:' + pct + '%"></i></div><div class="sw-note">' + pct + '% of your fine risk cleared · ' + gbpK(ra.monthTotal || 0) + ' this month</div>' +
        '<div class="sw-bd-chips"><span class="sw-chip">' + (n.completed || 0) + ' fixed · ' + (n.pending || 0) + ' to go</span>' + (streak ? '<span class="sw-chip streak">🔥 ' + streak + '-week fixing streak</span>' : '') + '</div></div>' +
      '<button class="sw-sum-more" data-act="detail" aria-expanded="' + st.detail + '">' + (st.detail ? 'Hide the breakdown ⌃' : 'See the full breakdown ⌄') + '</button></div>';
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
    if (Math.abs(ex - prev.exposure) >= 1000) { bits.push('worst-case fine risk ' + (ex < prev.exposure ? 'down' : 'up') + ' to <b>' + gbpK(ex) + '</b>'); if (ex > prev.exposure) good = false; }
    if (!bits.length) return '';
    return '<div class="sw-changed' + (good ? ' good' : '') + '"><span>Since ' + esc(date(prev.at)) + ': ' + bits.join(', ') + '.</span><button class="sw-changed-x" data-act="close-changed" aria-label="Dismiss">✕</button></div>';
  }

  // Score trend: hover or tap a point to see what happened that day
  function drawSpark() {
    var el = $('#sw-spark'), pts = (D.score.trend || []).filter(function (p) { return typeof p.score === 'number'; });
    if (!el) return;
    if (pts.length < 2) { el.innerHTML = '<div class="sw-note">Your trend appears after a second day of activity.</div>'; return; }
    var w = 200, h = 44, n = pts.length, lo = Math.max(0, Math.min.apply(null, pts.map(function (p) { return p.score; })) - 5), hi = Math.min(100, Math.max.apply(null, pts.map(function (p) { return p.score; })) + 5);
    if (hi - lo < 10) { hi = Math.min(100, lo + 10); lo = hi - 10; }
    var xy = pts.map(function (p, i) { return [(i / (n - 1)) * w, h - 3 - ((p.score - lo) / (hi - lo)) * (h - 6)]; });
    var d = xy.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    el.innerHTML = '<div class="sw-trend"><svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" role="img" aria-label="Score over the last ' + n + ' snapshots">' +
      '<path d="' + d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z" fill="rgba(234,115,23,.10)"/><path d="' + d + '" fill="none" stroke="#EA7317" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
      '<i class="sw-trend-dot" hidden></i><div class="sw-trend-tip" hidden></div></div><div class="sw-note">Last ' + n + ' snapshots · hover for what changed</div>';
    var box = el.querySelector('.sw-trend'), dot = el.querySelector('.sw-trend-dot'), tip = el.querySelector('.sw-trend-tip');
    function day(s) { return String(s || '').slice(0, 10); }
    function at(x) {
      var r = box.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((x - r.left) / r.width * (n - 1)))), p = pts[i], k = day(p.date);
      var ev = [];
      (D.fixes.completed || []).forEach(function (f) { if (day(f.completedDate) === k) ev.push('Fixed: ' + nice(f.fixType)); });
      (D.fixes.pending || []).concat(D.fixes.completed || []).forEach(function (f) { if (day(f.createdDate) === k) ev.push('Found: ' + nice(f.fixType)); });
      var prev = i ? pts[i - 1].score : null, ch = prev == null ? '' : p.score > prev ? ' (+' + (p.score - prev) + ')' : p.score < prev ? ' (' + (p.score - prev) + ')' : '';
      dot.hidden = tip.hidden = false;
      var px = (xy[i][0] / w) * 100, py = (xy[i][1] / h) * 100;
      dot.style.left = px + '%'; dot.style.top = py + '%';
      tip.style.left = Math.max(18, Math.min(82, px)) + '%';
      tip.innerHTML = '<b>' + esc(date(p.date)) + ' · ' + p.score + esc(ch) + '</b>' + (ev.length ? '<br>' + ev.slice(0, 3).map(esc).join('<br>') + (ev.length > 3 ? '<br>+' + (ev.length - 3) + ' more' : '') : '');
    }
    box.addEventListener('mousemove', function (e) { at(e.clientX); });
    box.addEventListener('touchstart', function (e) { at(e.touches[0].clientX); }, { passive: true });
    box.addEventListener('mouseleave', function () { dot.hidden = tip.hidden = true; });
  }

  function heroTiles() {
    var e = D.exposure, ra = D.riskAddressed || {}, al = D.alreadyLost;
    var lost = al && al.amount ? '<div class="sw-hn">' + gbpK(al.amount) + '</div><div class="sw-hs">' + (al.isEstimate ? 'Estimated ' : '') + 'list value lost to ' + (al.excessUnsubs12mo || 0).toLocaleString('en-GB') + ' extra unsubscribes in 12 months' + (al.cplUsed ? ' at ' + gbp(al.cplUsed) + ' per lead' : '') + '.</div>'
      : '<div class="sw-hn">–</div><div class="sw-hs">Upload a list in List health to see what unsubscribes have cost you.</div>';
    var lk = e.likelihood ? '<span class="sw-like ' + esc(e.likelihood.level) + '" title="' + esc((e.likelihood.reasons || []).join('. ')) + '">' + 'Chance of regulator attention: ' + esc(String(e.likelihood.level).toLowerCase()) + '</span>' : '';
    var other = [];
    if (e.asaPending) other.push(e.asaPending + ' advertising finding' + (e.asaPending > 1 ? 's' : '') + ' (the ASA publishes rulings but does not fine)');
    if (e.cmaPending) other.push(e.cmaPending + ' consumer law finding' + (e.cmaPending > 1 ? 's' : '') + (e.cmaMax ? ' (CMA: ' + esc(e.cmaMax.label) + ')' : ''));
    var mc = D.marketingCost;
    if (mc && mc.count) other.push(mc.priced ? 'If ads had to be pulled or customers refunded, that could cost about <b>' + gbpK(mc.mostLikely) + '</b>' + (mc.needInputs ? ' (' + mc.needInputs + ' more need campaign figures)' : '') + ', on top of any fine.'
      : 'Add campaign figures to see the commercial cost of ' + mc.count + ' advertising or consumer law finding' + (mc.count > 1 ? 's' : '') + '.');
    var raV = st.raMode === 'month' ? ra.monthTotal : ra.allTotal;
    return '<div class="sw-grid sw-g-3" style="margin:0">' +
      '<div class="sw-ht red"><div class="sw-hl">Already lost</div>' + lost + '</div>' +
      '<div class="sw-ht amber"><div class="sw-hl">ICO fine risk</div><div class="sw-hn">' + (e.totalHigh && e.totalMostLikely ? cu('ico', e.totalMostLikely, 'about') : e.totalHigh ? range(e.totalLow, e.totalHigh) : cu('ico', 0, 'gbpK')) + '</div>' +
        (e.totalHigh && e.totalMostLikely ? '<div class="sw-hs">Likely ' + range(e.totalLow, e.totalHigh) + confChip(e.confidence) + '</div>' : '') +
        '<div class="sw-hs">Based on fines in similar published cases, grouped the way a regulator would investigate. Not a prediction.</div>' + lk + profileLine() +
        (other.length ? '<div class="sw-hs" style="margin-top:6px">' + other.join('<br>') + '</div>' : '') +
        '<div class="sw-algo-row">' + (e.clusters && e.clusters.length ? '<button class="sw-link" data-act="why" data-id="' + esc(e.clusters[0].leadFixId) + '">' + (e.confidence && e.confidence !== 'high' ? 'Why this number? Tighten it' : 'Why this number?') + '</button>' : '') + algoLink('How we calculate this') + '</div></div>' +
      '<div class="sw-ht green"><div class="sw-hl">Fine risk removed</div>' +
        '<div style="margin-top:4px"><button class="sw-tog' + (st.raMode === 'month' ? ' on' : '') + '" data-act="ra" data-m="month">This month</button><button class="sw-tog' + (st.raMode === 'all' ? ' on' : '') + '" data-act="ra" data-m="all">All time</button></div>' +
        '<div class="sw-hn">' + cu('ra_' + st.raMode, raV || 0, 'gbpK') + '</div>' +
        '<div class="sw-hs">' + (st.raMode === 'all' && ra.allTotal ? gbpK(ra.verified) + ' verified by a re-run, ' + gbpK(ra.selfAttested) + ' marked fixed by you.' : 'By the fixes you have completed.') + '</div></div></div>';
  }

  function clustersCard() {
    var cl = D.exposure.clusters || [];
    var body = cl.length ? cl.map(function (c) {
      return '<div class="sw-row sw-row-btn' + (st.area === c.area ? ' on' : '') + '" data-act="area" data-a="' + esc(c.area) + '" role="button" tabindex="0" title="Show these findings"><div class="sw-row-main"><div class="sw-row-t">' + esc(c.label) + '</div><div class="sw-row-s">' + c.count + ' finding' + (c.count > 1 ? 's' : '') + ' · see them</div></div><div class="sw-row-v">' + likely(c.mostLikely, c.low, c.high) + (c.mostLikely ? '<div class="sw-row-s">' + range(c.low, c.high) + '</div>' : '') + '</div><button class="sw-link" data-act="why" data-id="' + esc(c.leadFixId) + '">Why?</button></div>';
    }).join('') : '<div class="sw-empty">No open data protection findings.</div>';
    return '<div class="sw-open sw-areas"><div class="sw-lbl">Fine risk by area</div>' + body +
      (D.exposure.duaaWarning ? '<div class="sw-note" style="margin-top:10px">' + esc(D.exposure.duaaWarning) + '</div>' : '') +
      '<div style="margin-top:10px">' + algoLink() + '</div></div>';
  }

  // ── exposure maths in the browser (same rules as clusterExposure in
  //    _exposure.js), so What-if and Start here can try changes instantly ──
  function icoOf(list) {
    var groups = {};
    list.forEach(function (f) {
      var e = f.exposure;
      if (!e || e.category !== 'ICO' || !e.realisticHigh) return;
      (groups[f.area || 'other'] = groups[f.area || 'other'] || []).push(e);
    });
    var t = { low: 0, high: 0, likely: 0 };
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].slice().sort(function (a, b) { return b.realisticHigh - a.realisticHigh; }), lead = g[0], rest = g.slice(1);
      var sum = function (key) { return rest.reduce(function (s, e) { return s + (e[key] || 0); }, 0); };
      var ml = function (e) { return e.mostLikely || (e.realisticLow + e.realisticHigh) / 2; };
      t.low += Math.min(lead.realisticLow * 2, lead.realisticLow + 0.25 * sum('realisticLow'));
      t.high += Math.min(lead.realisticHigh * 2, lead.realisticHigh + 0.25 * sum('realisticHigh'));
      t.likely += Math.min(ml(lead) * 2, ml(lead) + 0.25 * rest.reduce(function (s, e) { return s + ml(e); }, 0));
    });
    return t;
  }
  function without(ids) { return (D.fixes.pending || []).filter(function (f) { return !ids[f.id]; }); }
  // ICO exposure (most likely) that closing this one finding removes
  function removes(f) { var o = {}; o[f.id] = 1; return Math.max(0, icoOf(D.fixes.pending || []).likely - icoOf(without(o)).likely); }
  var SEV_W = { critical: 8, high: 5, medium: 3, low: 1 };
  function weight(f) { var w = (D.score.model && D.score.model.weights) || SEV_W; return w[f.severity] || 3; }
  function projScore(ids) {
    var m = D.score.model;
    if (!m || !m.total) return D.score.value || 0;
    var add = (D.fixes.pending || []).filter(function (f) { return ids[f.id] && !(f.exposure && f.exposure.category === 'Commercial'); }).reduce(function (s, f) { return s + weight(f); }, 0);
    return Math.min(100, Math.round(((m.earned + add) / m.total) * 100));
  }
  function effort(f) { return f.effort || { mins: 60, label: 'About an hour' }; }
  function effortChip(f) {
    var e = effort(f);
    return '<span class="sw-chip ' + (e.quick || e.mins <= 30 ? 'quick' : e.dev ? 'dev' : '') + '" title="Rough time for a typical team">' + (e.quick || e.mins <= 30 ? '⚡ ' : '') + esc(e.label) + (e.dev ? ' · may need a developer' : '') + '</span>';
  }
  // Value for time: £ removed (ICO) or a stand-in from severity, per minute
  function valueForTime(f) {
    var m = f.exposure && f.exposure.marketingCost, v = removes(f) + (m && m.available ? m.mostLikely * 0.25 : 0) + weight(f) * 1500;
    return v / Math.max(10, effort(f).mins);
  }

  // Top three open findings by value for the time they take
  function startHere() {
    var top = (D.fixes.pending || []).slice().sort(function (a, b) { return valueForTime(b) - valueForTime(a); }).slice(0, 3);
    var body = top.length ? top.map(function (f, i) {
      var r = removes(f);
      return '<div class="sw-nx sw-row-btn" data-act="next" data-id="' + esc(f.id) + '" role="button" tabindex="0"><span class="sw-step-n">' + (i + 1) + '</span>' +
        '<div class="sw-nx-main"><div class="sw-row-t">' + esc(nice(f.fixType)) + '</div><div class="sw-row-s sw-nx-d">' + esc(f.description) + '</div></div>' +
        effortChip(f) + '<span class="sw-nx-v">' + (pts(f) ? '<b>+' + pts(f) + ' pts</b>' : '') + (r >= 1000 ? '<small>−' + gbpK(r) + ' risk</small>' : '') + '</span><span class="sw-btn o">Fix it</span></div>';
    }).join('') : '<div class="sw-empty">Nothing open. <button class="sw-link" data-act="tool" data-u="/send-verdict.html">Check your next campaign</button> before it goes out.</div>';
    var more = (D.fixes.pending || []).length - top.length;
    return '<div class="sw-open sw-next"><div class="sw-next-h"><div class="sw-lbl">Start here · best value for your time</div>' +
      (more > 0 ? '<button class="sw-link" data-act="all-fixes">All ' + (more + top.length) + ' findings</button>' : '') + '</div>' + body + '</div>';
  }

  function expLine(f) {
    var e = f.exposure;
    if (!e) return '';
    if (e.category === 'ICO' && e.realisticHigh) return '<div class="sw-fx-exp"><span class="sw-badge ico">ICO</span> <span class="sw-fx-range">' + likely(e.mostLikely, e.realisticLow, e.realisticHigh) + (e.mostLikely ? ' (' + range(e.realisticLow, e.realisticHigh) + ')' : '') + '</span>' + (e.basis === 'assessed' ? ' <span class="sw-badge est">AI-assessed</span>' : '') + ' <button class="sw-link" data-act="why" data-id="' + esc(f.id) + '">Why?</button></div>';
    if (e.category === 'ASA' || e.category === 'CMA') {
      var m = e.marketingCost;
      var head = e.category === 'ASA' ? '<span class="sw-badge asa">ASA</span> Published ruling risk, no fine' : '<span class="sw-badge cma">CMA</span> Statutory maximum applies';
      var cost = m && m.available ? ' · ' + esc(m.label) + ': about ' + gbpK(m.mostLikely) : '';
      return '<div class="sw-fx-exp">' + head + cost + ' <button class="sw-link" data-act="why" data-id="' + esc(f.id) + '">' + (m && !m.available ? 'Add campaign figures' : 'Why?') + '</button></div>';
    }
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
    return '<div class="sw-card sw-pad"><div class="sw-lbl">Consent running out</div>' + body + '</div>';
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

  // ── Sendwize noticed: alerts worked out from past uploads ──
  var AUDIENCE_KINDS = { complaints_over: 1, complaints_near: 1, complaints_rising: 1, next_send: 1, forecast: 1 };
  function noticedCard() {
    var a = D.alerts || [];
    if (!a.length) return '';
    var shown = st.noticedAll ? a : a.slice(0, 3);
    return '<div class="sw-card sw-pad sw-noticed"><div class="sw-lbl">Sendwize noticed</div>' + shown.map(function (x) {
      var u = AUDIENCE_KINDS[x.kind] ? '/audience-read.html' : '/list-intelligence.html';
      var cta = x.kind === 'lapsing' ? 'Write the email' : x.kind === 'lapsed' || x.kind === 'stale_list' ? 'Upload latest' : x.kind === 'ruling' ? 'See the list' : 'Open';
      return '<div class="sw-ntc"><span class="sw-ntc-dot ' + esc(x.severity) + '"></span><div class="sw-ntc-t">' + esc(x.text) + '</div><button class="sw-btn q" data-act="tool" data-u="' + u + '">' + cta + '</button></div>';
    }).join('') + (a.length > 3 && !st.noticedAll ? '<button class="sw-link" data-act="noticed-all">Show ' + (a.length - 3) + ' more</button>' : '') + '</div>';
  }

  // ── Case Twin ──
  function twinOf(f) { var t = D.caseTwin && D.caseTwin.byFix && D.caseTwin.byFix[f.id]; return t ? { t: t, c: D.caseTwin.cases[t.caseId] } : null; }
  function outcome(c) {
    var when = c.date ? ' · ' + esc(date(c.date.length === 4 ? c.date + '-06-01' : c.date.length === 7 ? c.date + '-01' : c.date).replace(/^\d+ /, '')) : '';
    if (c.penalty) return 'Fined <b>' + gbp(c.penalty) + '</b> by the ' + esc(c.regulator) + when;
    if (c.regulator === 'ASA') return 'Upheld ASA ruling, published under their name' + when;
    return esc(c.regulator) + ' action' + when;
  }
  function twinCard() {
    var T = D.caseTwin, pend = D.fixes.pending || [];
    if (!T) return '';
    if (!T.hero) {
      return '<div class="sw-twin calm"><div class="sw-twin-main"><div class="sw-lbl">Case Twin</div><div class="sw-twin-name">' + (pend.length ? 'No published case is close to your open findings' : 'No twin. Nothing open looks like a published case') + '</div>' +
        '<div class="sw-hs">We compare every open finding with ' + (T.librarySize || 0) + ' published ICO, ASA and CMA cases and only show one when the issue matches and so does your sector or audience size.</div></div></div>';
    }
    var h = T.hero, c = T.cases[h.caseId], open = h.openFixIds.length, done = h.doneFixIds.length, pct = Math.round(done / Math.max(1, open + done) * 100);
    return '<div class="sw-twin"><div class="sw-twin-main"><div class="sw-lbl">Your closest case twin</div>' +
      '<div class="sw-twin-name">' + esc(c.name) + '</div><div class="sw-twin-out">' + outcome(c) + '</div>' +
      '<div class="sw-hs">' + esc(c.summary) + '</div>' +
      '<div class="sw-chips">' + h.reasons.map(function (r) { return '<span class="sw-chip">' + esc(r) + '</span>'; }).join('') + '</div>' +
      '<div class="sw-twin-btns"><button class="sw-btn o" data-act="twin" data-id="' + esc(h.fixId) + '">See it side by side</button><button class="sw-btn q" data-act="twin-only">Show the ' + open + ' finding' + (open > 1 ? 's' : '') + '</button></div></div>' +
      '<div class="sw-twin-side"><div class="sw-meter" style="--p:' + h.match + '"><div><b>' + h.match + '%</b><span>match</span></div></div>' +
      '<div class="sw-twin-gap"><b>' + open + ' fix' + (open > 1 ? 'es' : '') + '</b> away from clear</div>' +
      '<div class="sw-prog"><i style="width:' + pct + '%"></i></div><div class="sw-note">' + (done ? done + ' related fix' + (done > 1 ? 'es' : '') + ' already done' : 'Each fix moves you further from this case') + '</div></div></div>';
  }
  function twinDrawer(fixId) {
    var f = (D.fixes.pending || []).filter(function (x) { return x.id === fixId; })[0], tw = f && twinOf(f);
    if (!tw) return;
    ensureLayers();
    overlay.innerHTML = ''; overlay.classList.add('on'); drawer.classList.add('on', 'wide');
    var c = tw.c, related = function (x) { return c.types.indexOf(x.fixType) >= 0; };
    var open = (D.fixes.pending || []).filter(related), done = (D.fixes.completed || []).filter(related);
    var you = [];
    if (f.contactVolume) you.push('Audience: ' + Number(f.contactVolume).toLocaleString('en-GB') + (c.volume ? ' (theirs: ' + Number(c.volume).toLocaleString('en-GB') + ')' : ''));
    if (D.profile && D.profile.sector) you.push('Sector: ' + nice(D.profile.sector));
    var h = '<button class="sw-dr-x" data-act="close" aria-label="Close">✕</button><div class="sw-dr-h"><div class="sw-lbl">Case Twin · ' + tw.t.match + '% match</div><div class="sw-h2">You and ' + esc(c.name) + '</div></div>' +
      '<div class="sw-vs"><div class="sw-vs-col them"><div class="sw-lbl">Them</div><div class="sw-row-t">' + esc(c.name) + '</div><div class="sw-twin-out">' + outcome(c) + '</div><div class="sw-hs">' + esc(c.summary) + '</div>' +
        (c.url ? '<a class="sw-link" href="' + esc(c.url) + '" target="_blank" rel="noopener">' + (c.source === 'curated' ? esc(c.regulator) + ' enforcement page' : 'Read the ruling') + '</a>' : '') + '</div>' +
      '<div class="sw-vs-mid" aria-hidden="true">vs</div>' +
      '<div class="sw-vs-col you"><div class="sw-lbl">You</div><div class="sw-row-t">' + esc(nice(f.fixType)) + '</div><div class="sw-hs">' + esc(f.description) + '</div>' + (you.length ? '<div class="sw-note" style="margin-top:6px">' + you.map(esc).join('<br>') + '</div>' : '') + '</div></div>' +
      '<div class="sw-dr-sec"><div class="sw-lbl">Why they match</div><div class="sw-chips">' + tw.t.reasons.map(function (r) { return '<span class="sw-chip">' + esc(r) + '</span>'; }).join('') + '</div></div>' +
      '<div class="sw-dr-sec"><div class="sw-lbl">What you have already done differently</div>' + (done.length ? done.map(function (x) {
        var v = x.completionSource === 'improved_on_rerun' || x.completionSource === 'verified';
        return '<div class="sw-fac"><span class="sw-fac-ic down">✓</span><div>' + esc(nice(x.fixType)) + '<span class="sw-src' + (v ? ' ai' : '') + '">' + (v ? 'Verified' : 'Marked by you') + '</span>' + (x.completedDate ? '<div class="sw-note">' + esc(date(x.completedDate)) + '</div>' : '') + '</div></div>';
      }).join('') : '<div class="sw-empty">Nothing yet. Each fix below puts distance between you and this case.</div>') + '</div>' +
      '<div class="sw-dr-sec"><div class="sw-lbl">Still the same · ' + open.length + ' to close</div>' + open.map(function (x) {
        return '<div class="sw-fac"><span class="sw-fac-ic up">!</span><div style="flex:1">' + esc(nice(x.fixType)) + '<div class="sw-chips">' + effortChip(x) + '</div></div><button class="sw-link" data-act="goto" data-id="' + esc(x.id) + '">Open</button></div>';
      }).join('') + '</div>' +
      '<div class="sw-dr-sec"><div class="sw-note">A published case for comparison, matched on issue, sector, audience size and date. It is not a prediction of what would happen to you, and not legal advice.</div></div>';
    drawer.innerHTML = h;
  }

  // ── Action items: grouped by area, expandable, What-if ──
  function groupOf(f) { var c = f.exposure && f.exposure.category; return f.area && f.area !== 'other' ? f.area : (c === 'ASA' || c === 'CMA' || c === 'Commercial' ? c : 'other'); }
  function valueChip(f) {
    var e = f.exposure;
    if (!e) return '';
    if (e.category === 'ICO' && e.realisticHigh) return '<span class="sw-fx-val">' + (e.mostLikely ? gbpK(e.mostLikely) : range(e.realisticLow, e.realisticHigh)) + '<small>ICO</small></span>';
    if (e.category === 'ASA') return '<span class="sw-fx-val sm">' + (e.marketingCost && e.marketingCost.available ? gbpK(e.marketingCost.mostLikely) : 'Ruling') + '<small>ASA</small></span>';
    if (e.category === 'CMA') return '<span class="sw-fx-val sm">' + (e.marketingCost && e.marketingCost.available ? gbpK(e.marketingCost.mostLikely) : 'Fine risk') + '<small>CMA</small></span>';
    return '';
  }
  function fixesSection() {
    var all = D.fixes.pending || [], heroIds = {};
    if (D.caseTwin && D.caseTwin.hero) D.caseTwin.hero.openFixIds.forEach(function (id) { heroIds[id] = 1; });
    var list = all.filter(function (f) {
      if (st.area && groupOf(f) !== st.area) return false;
      if (st.twinOnly && !heroIds[f.id]) return false;
      if (st.filter === 'all') return true;
      if (st.filter === 'improved') return !!f.improvedOnRerun;
      if (st.filter === 'quick') return effort(f).mins <= 30;
      return f.exposure && f.exposure.category === st.filter;
    });
    var flt = [['all', 'All'], ['quick', '⚡ Quick wins'], ['ICO', 'ICO'], ['ASA', 'ASA'], ['CMA', 'CMA'], ['improved', 'Improved on re-run']].map(function (x) {
      return '<button class="sw-flt' + (st.filter === x[0] ? ' on' : '') + '" data-act="flt" data-f="' + x[0] + '">' + x[1] + '</button>';
    }).join('');
    var tags = (st.area ? '<button class="sw-tag" data-act="area-clear">' + esc(AREA_LABELS[st.area] || nice(st.area)) + ' ✕</button>' : '') +
      (st.twinOnly ? '<button class="sw-tag" data-act="twin-clear">Case Twin findings ✕</button>' : '');
    var groups = {}, order = [];
    list.forEach(function (f) { var g = groupOf(f); if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(f); });
    var cl = {}; (D.exposure.clusters || []).forEach(function (c) { cl[c.area] = c; });
    order.sort(function (a, b) { return ((cl[b] && cl[b].high) || 0) - ((cl[a] && cl[a].high) || 0); });
    // Only the riskiest area opens by default; a filter opens everything it matches
    var narrowed = st.filter !== 'all' || st.area || st.twinOnly;
    var body = order.map(function (g, gi) {
      var fs = groups[g].slice().sort(function (a, b) { return valueForTime(b) - valueForTime(a); });
      var done = (D.fixes.completed || []).filter(function (f) { return groupOf(f) === g; }).length, openN = all.filter(function (f) { return groupOf(f) === g; }).length;
      var pct = Math.round(done / Math.max(1, done + openN) * 100);
      var isOpen = st.lane[g] != null ? st.lane[g] : (narrowed || gi === 0);
      var shown = st.laneMore[g] || narrowed ? fs : fs.slice(0, 3), more = fs.length - shown.length;
      return '<div class="sw-lane' + (isOpen ? ' open' : '') + '"><div class="sw-lane-h" data-act="lane" data-g="' + esc(g) + '" role="button" tabindex="0" aria-expanded="' + isOpen + '">' +
        '<span class="sw-chev">' + (isOpen ? '⌃' : '⌄') + '</span><span class="sw-lane-t">' + esc(AREA_LABELS[g] || nice(g)) + '</span> <span class="sw-cnt">' + openN + '</span>' +
        '<span class="sw-lane-p"><span class="sw-prog"><i style="width:' + pct + '%"></i></span><span class="sw-note">' + done + '/' + (done + openN) + ' fixed</span></span>' +
        (cl[g] ? '<span class="sw-lane-v">' + likely(cl[g].mostLikely, cl[g].low, cl[g].high) + '</span>' : '') + '</div>' +
        (isOpen ? shown.map(fixRow).join('') + (more > 0 ? '<button class="sw-lane-more" data-act="lane-more" data-g="' + esc(g) + '">Show ' + more + ' more</button>' : '') : '') + '</div>';
    }).join('');
    var empty = '<div class="sw-empty">' + (all.length ? 'Nothing matches this filter.' : 'Nothing to fix right now.') + '</div>';
    return '<div class="sw-fx-hdr"><span class="sw-h2">Everything to fix <span class="sw-cnt">' + all.length + '</span></span><span class="sw-fx-ctl">' + flt +
      '<button class="sw-flt wi' + (st.whatif ? ' on' : '') + '" data-act="whatif" title="Tick findings to see what fixing them would change">What if?</button></span></div>' +
      (tags ? '<div class="sw-tags">' + tags + '</div>' : '') +
      (st.whatif ? '<div class="sw-wi-hint">Tick the findings you could fix and watch your score and exposure move.</div>' : '') +
      (list.length ? body : empty) + (st.whatif ? '<div class="sw-wi" id="sw-wi">' + whatIfBar() + '</div>' : '');
  }
  function fixRow(f) {
    var open = !!st.open[f.id], tw = twinOf(f), page = TOOL_PAGE[String(f.tool || '').toLowerCase()];
    var head = '<div class="sw-fx-head" data-act="expand" role="button" tabindex="0" aria-expanded="' + open + '">' +
      (st.whatif ? '<label class="sw-pick" data-act="noop"><input type="checkbox" data-pick="' + esc(f.id) + '"' + (st.picked[f.id] ? ' checked' : '') + ' aria-label="Include in what-if"></label>' : '') +
      '<span class="sw-dot dot-' + esc(f.severity || 'medium') + '"></span><div class="sw-fx-body">' +
      (open ? '<div class="sw-fx-type">' + esc(nice(f.fixType)) + '</div>' : '<div class="sw-fx-desc one" title="' + esc(f.description) + '">' + esc(f.description) + '</div>') +
      '<div class="sw-chips">' + effortChip(f) + (tw ? '<span class="sw-chip twin">Twin: ' + esc(tw.c.name.split(' (')[0]) + (tw.c.penalty ? ', ' + gbpK(tw.c.penalty) : '') + '</span>' : '') + (f.improvedOnRerun ? '<span class="sw-chip good">Improved on re-run</span>' : '') + '</div></div>' +
      valueChip(f) +
      (open || st.whatif ? '' : '<span class="sw-fx-quick"><button class="sw-btn o" data-act="quickfix" title="Open it with the fix written for you">Fix it</button><button class="sw-btn ok" data-act="done" data-src="' + (f.improvedOnRerun ? 'improved_on_rerun' : 'manual') + '" title="Mark fixed" aria-label="Mark fixed">✓</button></span>') +
      '<span class="sw-chev">' + (open ? '⌃' : '⌄') + '</span></div>';
    if (!open) return '<div class="sw-fx" data-id="' + esc(f.id) + '">' + head + '</div>';
    var d = drafts[f.id];
    var fixBox = d && d.pasteText ? '<div class="sw-draft"><div class="sw-lbl">The fix</div><div class="sw-row-t">' + esc(d.headline) + '</div><ol>' + (d.steps || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' +
        '<div class="sw-paste"><div class="sw-paste-h"><span>' + esc(d.pasteLabel) + '</span><button class="sw-btn o" data-act="copy">Copy</button></div><pre>' + esc(d.pasteText) + '</pre></div>' +
        '<div class="sw-note">Drafted by AI from this finding. Check names, prices and dates in [brackets] before you use it. Not legal advice. <button class="sw-link" data-act="draft" data-fresh="1">Write it again</button></div></div>'
      : d && d.loading ? '<div class="sw-draft"><div class="sw-ld"><div class="sw-spin"></div>Writing the fix…</div></div>'
      : '<div class="sw-draft empty"><div><div class="sw-row-t">Want the fix written for you?</div><div class="sw-row-s">Steps plus text you can paste straight into your email, form or page.</div></div><button class="sw-btn g" data-act="draft">Write the fix for me</button></div>';
    return '<div class="sw-fx open" data-id="' + esc(f.id) + '">' + head + '<div class="sw-fx-more">' +
      '<div class="sw-fx-desc">' + esc(f.description) + '</div>' +
      '<div class="sw-fx-meta">' + (f.tool ? '<span class="sw-fx-tool">' + esc(f.tool) + '</span> · ' : '') + esc(nice(f.severity)) + (f.createdDate ? ' · found ' + esc(date(f.createdDate)) : '') + '</div>' +
      (f.improvedOnRerun ? '<div class="sw-improved">A re-run shows this has improved. Confirm to get full credit.</div>' : '') + expLine(f) +
      (tw ? '<div class="sw-twin-mini"><span><b>Case Twin:</b> ' + esc(tw.c.name) + ' · ' + outcome(tw.c) + ' · ' + tw.t.match + '% match</span><button class="sw-link" data-act="twin">Side by side</button></div>' : '') +
      fixBox +
      '<div class="sw-fx-act">' +
        (f.improvedOnRerun ? '<button class="sw-btn g" data-act="done" data-src="improved_on_rerun">Confirm improved</button>' : '<button class="sw-btn g" data-act="done" data-src="manual">Mark fixed</button>') +
        (page ? '<button class="sw-btn o" data-act="tool" data-u="' + esc(page) + '">Recheck now</button>' : '') +
        '<button class="sw-btn q" data-act="dismiss">Dismiss</button>' +
      '</div></div></div>';
  }
  function whatIfBar() {
    var ids = st.picked, n = Object.keys(ids).length;
    if (!n) return '<span class="sw-note">Nothing ticked yet.</span>';
    var picked = (D.fixes.pending || []).filter(function (f) { return ids[f.id]; });
    // Start from the server's total so the bar agrees with the exposure tile
    var s0 = D.score.value || 0, s1 = projScore(ids), all = icoOf(D.fixes.pending || []).likely;
    var e0 = D.exposure.totalMostLikely || all, e1 = Math.max(0, e0 - (all - icoOf(without(ids)).likely));
    var mins = picked.reduce(function (s, f) { return s + effort(f).mins; }, 0);
    var t = mins < 60 ? mins + ' minutes' : mins < 480 ? 'about ' + (Math.round(mins / 30) / 2) + ' hours' : 'about ' + Math.round(mins / 480 * 2) / 2 + ' days';
    return '<div class="sw-wi-t">If you fix these ' + n + ':</div>' +
      '<div class="sw-wi-k"><span>Score</span><b>' + s0 + ' → <em class="up">' + s1 + '</em></b></div>' +
      (e0 ? '<div class="sw-wi-k"><span>ICO fine risk</span><b>' + gbpK(e0) + ' → <em class="down">' + gbpK(e1) + '</em></b></div>' : '') +
      '<div class="sw-wi-k"><span>Work</span><b>' + t + '</b></div>' +
      '<button class="sw-link" data-act="wi-clear">Clear</button>';
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
        histCache[k] = k === 'verdict'
          ? ((await api('/api/verdict?action=list&userId=' + encodeURIComponent(userId))).verdicts || []).map(function (v) { return { id: v.id, fields: { CampaignName: v.campaign, Verdict: v.verdict, CreatedAt: v.createdAt, Channel: v.channel } }; })
          : (await api('/api/data?action=history&type=' + k + '&userId=' + encodeURIComponent(userId))).records || [];
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
    if (k === 'ai') { t = f.FileName || 'Copy check'; s = f.Verdict || ''; d = f.CheckDate; href = link('/ai-checker.html', 'checkId=' + encodeURIComponent(id)); }
    else if (k === 'verdict') { t = f.CampaignName || 'Send-day verdict'; s = f.Verdict || ''; d = f.CreatedAt; href = link('/send-verdict.html', 'verdictId=' + encodeURIComponent(id)); }
    else if (k === 'simulation') { t = (f.Regulator || '') + ' simulation'; s = f.Band || ''; d = f.CreatedAt; href = link('/ico-simulator.html', 'simulationId=' + encodeURIComponent(id)); }
    else if (k === 'vendor') { t = f.VendorName || f.Vendor || 'Vendor'; s = f.RiskLevel || f.Status || ''; d = f.LastChecked; href = link('/vendor-checker.html'); }
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
  function closeLayers() { if (drawer) { drawer.classList.remove('on', 'wide'); overlay.classList.remove('on'); overlay.innerHTML = ''; } }

  async function why(fixId) {
    ensureLayers();
    overlay.innerHTML = ''; overlay.classList.add('on'); drawer.classList.add('on'); drawer.classList.remove('wide');
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
      h += '<div class="sw-dr-sec"><div class="sw-hn">' + likely(e.mostLikely, e.realisticLow, e.realisticHigh) + confChip(e.confidence) + '</div>' +
        (e.mostLikely ? '<div class="sw-hs">Most likely figure. Likely range ' + range(e.realisticLow, e.realisticHigh) + '.</div>' : '') +
        '<div class="sw-hs">' + ({ assessed: 'Placed using your profile, rules and an AI reading of your evidence.', rules: 'Placed using your profile and facts we hold about this finding.', standard: 'Middle of the published-case range. Add the details below to place it more precisely.' }[e.basis] || '') + '</div>' +
        '<div class="sw-frame"><i style="left:' + Math.max(0, l).toFixed(1) + '%;width:' + Math.max(2, w).toFixed(1) + '%"></i></div>' +
        '<div class="sw-frame-l"><span>' + gbpK(e.frameLow) + '</span><span>Published-case range for your size and sector</span><span>' + gbpK(e.frameHigh) + '</span></div></div>';
      h += tightenForm(e, x, f.id);
      var fac = e.factors || [];
      h += '<div class="sw-dr-sec"><div class="sw-lbl">What moved it</div>' + (fac.length ? fac.map(function (q) {
        return '<div class="sw-fac"><span class="sw-fac-ic ' + (q.direction === 'up' ? 'up' : 'down') + '">' + (q.direction === 'up' ? '↑' : '↓') + '</span><div>' + esc(q.label) + '<span class="sw-src' + (q.source === 'ai' ? ' ai' : '') + '">' + (q.source === 'ai' ? 'AI' : q.source === 'profile' ? 'Profile' : 'Rule') + '</span>' + (q.evidence ? '<div class="sw-fac-ev">“' + esc(q.evidence) + '”</div>' : '') + '</div></div>';
      }).join('') : '<div class="sw-empty">Nothing yet. The figure sits in the middle of the published range until there is evidence.</div>') + '</div>';
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
      h += costSection(e.marketingCost, x, f.id);
    } else if (e.category === 'CMA') {
      h += '<div class="sw-dr-sec"><div class="sw-hs">Under the DMCCA 2024 the CMA can fine directly. We show the statutory maximum for your size only, because there are not yet enough published cases to estimate a realistic range.</div>' + (D && D.exposure.cmaMax ? '<div class="sw-note" style="margin-top:8px">' + esc(D.exposure.cmaMax.label) + '</div>' : '') + '</div>';
      h += costSection(e.marketingCost, x, f.id);
    } else {
      h += '<div class="sw-dr-sec"><div class="sw-hs">This is a commercial figure (lost revenue), shown separately and never added to regulatory exposure.</div></div>';
    }
    h += '<div class="sw-dr-sec"><div class="sw-note">' + esc(x.disclaimer || '') + '</div><div style="margin-top:8px">' + algoLink('Read the full method: the Sendwize exposure algorithm') + '</div></div>';
    drawer.innerHTML = h;
  }

  // Only the details we don't have yet, so the figure can be placed more precisely
  function tightenForm(e, x, fixId) {
    var need = (e.tighten || []).filter(function (t) { return t.key !== 'assess'; });
    if (!need.length) return '';
    var inp = (x.profile && x.profile.inputs) || {};
    function yn(id, label, v) {
      return '<div class="sw-tf"><label for="' + id + '">' + label + '</label><select id="' + id + '"><option value="">Choose</option><option' + (v === true ? ' selected' : '') + '>Yes</option><option' + (v === false ? ' selected' : '') + '>No</option></select></div>';
    }
    var fields = need.map(function (t) {
      if (t.key === 'listSize') return '<div class="sw-tf"><label for="sw-t-list">How many people are on your marketing list?</label><input id="sw-t-list" type="number" min="1" inputmode="numeric" placeholder="e.g. 25000"></div>';
      if (t.key === 'turnover') return '<div class="sw-tf"><label for="sw-t-turn">Approximate annual turnover (£)</label><input id="sw-t-turn" type="number" min="1" inputmode="numeric" placeholder="e.g. 3500000"></div>';
      if (t.key === 'consentRecords') return '<div class="sw-tf"><label for="sw-t-cons">Do you keep a dated record of each opt-in?</label><select id="sw-t-cons"><option value="">Choose</option><option value="all">Yes, for everyone</option><option value="some">For some contacts</option><option value="none">No</option></select></div>';
      if (t.key === 'history') return yn('sw-t-comp', 'Complaints from recipients in the last two years?', inp.complaints) + yn('sw-t-reg', 'Any contact from the ICO, ASA or CMA in the last two years?', inp.regulatorContact);
      return '';
    }).join('');
    return '<div class="sw-dr-sec"><div class="sw-lbl">Tighten this figure</div><div class="sw-hs">Answer what you can. It is saved to your profile and sharpens every figure.</div>' + fields +
      '<button class="sw-wide-btn" data-act="save-tighten" data-id="' + esc(fixId) + '" style="margin-top:12px">Update the figure</button></div>';
  }

  // ASA / CMA: what the finding could cost the business, from its own campaign figures
  function costSection(m, x, fixId) {
    if (!m) return '';
    var ci = x.campaignInputs || {};
    var h = '<div class="sw-dr-sec"><div class="sw-lbl">Commercial cost</div>';
    if (m.available) {
      h += '<div class="sw-hn">About ' + gbpK(m.mostLikely) + '</div><div class="sw-hs">' + esc(m.label) + '. Likely ' + range(m.low, m.high) + '.</div>' +
        (m.lines || []).map(function (l) { return '<div class="sw-cost-l"><span>' + esc(l.label) + '<div class="sw-note">' + esc(l.basis) + '</div></span><b>' + gbpK(l.amount) + '</b></div>'; }).join('') +
        '<div class="sw-note" style="margin-top:6px">Worked out from ' + (m.source === 'campaign' ? 'the figures you gave for this campaign' : 'your usual campaign figures') + '. Never added to regulatory exposure.</div>';
    } else {
      h += '<div class="sw-hs">Add this campaign’s figures to see what it could cost ' + (m.category === 'ASA' ? 'if the ad had to be withdrawn' : 'if customers had to be refunded') + '.</div>';
    }
    h += '<div class="sw-tf"><label for="sw-c-bud">Campaign budget (£)</label><input id="sw-c-bud" type="number" min="1" inputmode="numeric" value="' + esc(ci.campaignBudget || m.budget || '') + '" placeholder="Media and creative, e.g. 8000"></div>' +
      '<div class="sw-tf"><label for="sw-c-rev">Expected sales from the campaign (£)</label><input id="sw-c-rev" type="number" min="1" inputmode="numeric" value="' + esc(ci.campaignRevenue || m.revenue || '') + '" placeholder="e.g. 40000"></div>' +
      '<button class="sw-wide-btn" data-act="save-campaign" data-id="' + esc(fixId) + '" style="margin-top:12px">' + (m.available ? 'Update' : 'Show the cost') + '</button>' +
      '<div class="sw-note" style="margin-top:6px">' + esc(m.disclaimer || '') + '</div></div>';
    return h;
  }

  function val(id) { var el = drawer.querySelector('#' + id); return el ? el.value.trim() : ''; }

  async function saveTighten(fixId, btn) {
    var body = { userId: userId }, n;
    if ((n = parseFloat(val('sw-t-list'))) > 0) body.listSize = n;
    if ((n = parseFloat(val('sw-t-turn'))) > 0) body.annualTurnover = n;
    if (val('sw-t-cons')) body.consentRecords = val('sw-t-cons');
    if (val('sw-t-comp')) body.complaintsReceived = val('sw-t-comp');
    if (val('sw-t-reg')) body.priorRegulatorContact = val('sw-t-reg');
    if (Object.keys(body).length < 2) { toast('Answer at least one question', 'er'); return; }
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      await api('/api/profile?action=save', { method: 'POST', body: body });
      await why(fixId); toast('Figure updated', 'ok'); refreshQuiet();
    } catch (e) { btn.disabled = false; btn.textContent = 'Update the figure'; toast(e.message, 'er'); }
  }

  async function saveCampaign(fixId, btn) {
    var b = parseFloat(val('sw-c-bud')) || null, r = parseFloat(val('sw-c-rev')) || null;
    if (!b && !r) { toast('Enter a budget or expected sales', 'er'); return; }
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working it out…';
    try {
      drawWhy(await api('/api/exposure?action=inputs', { method: 'POST', body: { userId: userId, fixId: fixId, campaignBudget: b, campaignRevenue: r } }));
      toast('Cost updated', 'ok'); refreshQuiet();
    } catch (e) { btn.disabled = false; btn.textContent = label; toast(e.message, 'er'); }
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
    rerender();
  }
  // Redraw without reloading the briefing and campaigns (recent checks are cached)
  function rerender() {
    var keepB = $('#sw-brf') && $('#sw-brf').innerHTML, keepC = $('#sw-camps') && $('#sw-camps').outerHTML;
    render();
    if (keepB) { $('#sw-brf').innerHTML = keepB; if (keepB.length > 320) $('#sw-brf-more').hidden = false; }
    if (keepC) $('#sw-camps').outerHTML = keepC;
    loadHistory();
  }

  async function complete(fixId, src, btn) {
    btn.disabled = true;
    var f = (D.fixes.pending || []).filter(function (x) { return x.id === fixId; })[0], gain = f ? pts(f) : 0, was = level(D.score.value || 0).i;
    try {
      await api('/api/fixes?action=complete', { method: 'POST', body: { userId: userId, fixId: fixId, completionSource: src } });
      toast((src === 'improved_on_rerun' ? 'Confirmed. Full credit added.' : 'Marked fixed.') + (gain ? ' +' + gain + ' points.' : '') + (src === 'improved_on_rerun' ? '' : ' Re-run the check for full credit.'), 'ok');
      celebrate(btn, src === 'improved_on_rerun');
      delete st.open[fixId]; delete st.picked[fixId];
      await refreshQuiet();
      var now = level(D.score.value || 0);
      if (now.i > was) { toast('Level up: ' + now.name, 'ok'); celebrate($('.sw-board'), true); }
      var top = $('.sw-board'); if (top && top.scrollIntoView && top.getBoundingClientRect().top < 0) top.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
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

  async function draft(fixId, fresh) {
    drafts[fixId] = { loading: true }; redrawFixes();
    try {
      var r = await api('/api/exposure?action=draft', { method: 'POST', body: { userId: userId, fixId: fixId, fresh: !!fresh } });
      drafts[fixId] = r.draft;
    } catch (e) { delete drafts[fixId]; toast(e.message, 'er'); }
    redrawFixes();
  }
  function copyDraft(fixId, btn) {
    var d = drafts[fixId]; if (!d) return;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.pasteText).then(done, function () { toast('Select the text and copy it', 'er'); });
    else toast('Select the text and copy it', 'er');
  }
  function redrawFixes() { var el = $('#sw-fixes'); if (el) el.innerHTML = fixesSection(); }
  function gotoFix(id) {
    closeLayers();
    st.open[id] = true; st.area = null; st.twinOnly = false; if (st.filter !== 'all') st.filter = 'all';
    redrawFixes();
    var row = root.querySelector('.sw-fx[data-id="' + id + '"]');
    if (row) { row.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(function () { row.classList.remove('flash'); }, 1600); }
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
      case 'save-tighten': saveTighten(id, t); break;
      case 'save-campaign': saveCampaign(id, t); break;
      case 'done': complete(id, t.getAttribute('data-src'), t); break;
      case 'dismiss': dismissModal(id); break;
      case 'do-dismiss': var r = overlay.querySelector('input[name=sw-dis]:checked'); if (r) dismiss(id, r.value, t); break;
      case 'save-band': saveBand(t); break;
      case 'save-gate': saveGate(t); break;
      case 'flt': st.filter = t.getAttribute('data-f'); $('#sw-fixes').innerHTML = fixesSection(); break;
      case 'ra': st.raMode = t.getAttribute('data-m'); rerender(); break;
      case 'hist': st.histTab = t.getAttribute('data-k'); root.querySelectorAll('[data-act=hist]').forEach(function (b) { b.classList.toggle('on', b === t); }); loadHistory(); break;
      case 'pg': st.page[st.histTab] += +t.getAttribute('data-d'); loadHistory(); break;
      case 'brf-more': $('#sw-brf').classList.remove('clip'); t.hidden = true; break;
      case 'noop': break;
      case 'lane': var g = t.getAttribute('data-g'), ln = t.closest('.sw-lane'); st.lane[g] = !(ln && ln.classList.contains('open')); redrawFixes(); break;
      case 'noticed-all': st.noticedAll = true; rerender(); break;
      case 'lane-more': st.laneMore[t.getAttribute('data-g')] = true; redrawFixes(); break;
      case 'quickfix': st.open[id] = true; if (!drafts[id]) draft(id); else redrawFixes(); break;
      case 'expand': if (ev.target.closest('.sw-pick')) break; if (st.open[id]) delete st.open[id]; else st.open[id] = true; redrawFixes(); break;
      case 'goto': gotoFix(id); break;
      case 'next': gotoFix(id); if (!drafts[id]) draft(id); break;
      case 'all-fixes': $('#sw-fixes').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); break;
      case 'detail': st.detail = !st.detail; store('detail_' + userId, st.detail); rerender(); break;
      case 'first-hide': store('firstrun_hide_' + userId, true); rerender(); break;
      case 'twin': twinDrawer(id); break;
      case 'twin-only': st.twinOnly = true; st.area = null; redrawFixes(); $('#sw-fixes').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); break;
      case 'twin-clear': st.twinOnly = false; redrawFixes(); break;
      case 'area': st.area = t.getAttribute('data-a'); st.twinOnly = false; redrawFixes(); root.querySelectorAll('[data-act=area]').forEach(function (b) { b.classList.toggle('on', b === t); }); $('#sw-fixes').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); break;
      case 'area-clear': st.area = null; redrawFixes(); root.querySelectorAll('[data-act=area]').forEach(function (b) { b.classList.remove('on'); }); break;
      case 'whatif': st.whatif = !st.whatif; if (!st.whatif) st.picked = {}; redrawFixes(); break;
      case 'wi-clear': st.picked = {}; redrawFixes(); break;
      case 'draft': draft(id, t.getAttribute('data-fresh') === '1'); break;
      case 'copy': copyDraft(id, t); break;
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
      // What-if ticks update the bar without redrawing the list
      root.addEventListener('change', function (ev) {
        var id = ev.target.getAttribute && ev.target.getAttribute('data-pick');
        if (!id) return;
        if (ev.target.checked) st.picked[id] = true; else delete st.picked[id];
        var bar = $('#sw-wi'); if (bar) bar.innerHTML = whatIfBar();
      });
      // Enter or Space on rows that act as buttons
      root.addEventListener('keydown', function (ev) {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('role') === 'button') { ev.preventDefault(); ev.target.click(); }
      });
      ensureLayers();
      overlay.addEventListener('change', onChange);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
