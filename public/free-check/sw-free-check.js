/* Sendwize free check: embed for the marketing site.
 *
 * Paste into a Webflow Code Embed:
 *   <div id="sw-free-check"></div>
 *   <script>window.SW_SIGNUP_URL = 'https://your-site/signup';</script>
 *   <script src="https://sendwize-backend.vercel.app/free-check/sw-free-check.js" defer></script>
 *
 * While nobody is using it, the widget plays an example check on a loop.
 * Set window.SW_FREE_CHECK_DEMO = false before the script to turn that off.
 */
(function () {
  var API = window.SW_API_URL || 'https://sendwize-backend.vercel.app';
  var SIGNUP = window.SW_SIGNUP_URL || window.SW_PRICING_URL || 'https://new-mvp-v2.webflow.io/marketing-templates/marketing-template-1/pricing-1';
  var root = document.getElementById('sw-free-check');
  if (!root) return;

  var css = '' +
    '.swfc{--o:#EA7317;--t:#1a1a1a;--mu:#6b7280;--b:#e5e7eb;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--t);max-width:720px;margin:0 auto;text-align:left;box-sizing:border-box}' +
    '.swfc *,.swfc *::before,.swfc *::after{box-sizing:border-box}' +
    '.swfc-card{background:#fff;border:1px solid var(--b);border-radius:12px;padding:22px;box-shadow:0 4px 20px rgba(0,0,0,.05)}' +
    '.swfc-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}' +
    '.swfc-tab{border:1px solid var(--b);background:#fff;border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;color:var(--t)}' +
    '.swfc-tab[aria-pressed="true"]{background:var(--o);border-color:var(--o);color:#fff}' +
    '.swfc label{display:block;font-size:12px;font-weight:600;margin:12px 0 6px}' +
    '.swfc input,.swfc textarea{width:100%;font:inherit;font-size:15px;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:var(--t)}' +
    '.swfc textarea{min-height:170px;resize:vertical}' +
    '.swfc-go{margin-top:16px;width:100%;background:var(--o);color:#fff;border:none;padding:14px;border-radius:8px;font:inherit;font-size:16px;font-weight:600;cursor:pointer}' +
    '.swfc-go:disabled{opacity:.6;cursor:wait}' +
    '.swfc-small{font-size:12px;color:var(--mu);line-height:1.5;margin-top:10px}' +
    '.swfc-err{color:#dc2626;font-size:14px;margin-top:10px}' +
    '.swfc-res{margin-top:16px;border-radius:12px;padding:20px;border:2px solid}' +
    '.swfc-res.go{background:#f0fdf4;border-color:#86efac}.swfc-res.fix_first{background:#fffbeb;border-color:#fcd34d}.swfc-res.hold{background:#fef2f2;border-color:#fca5a5}' +
    '.swfc-vl{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}' +
    '.swfc-res.go .swfc-vl{color:#16a34a}.swfc-res.fix_first .swfc-vl{color:#b45309}.swfc-res.hold .swfc-vl{color:#dc2626}' +
    '.swfc-vh{font-size:20px;font-weight:700;margin:6px 0 4px;line-height:1.3}' +
    '.swfc-item{background:#fff;border:1px solid var(--b);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:14px;line-height:1.45}' +
    '.swfc-ref{display:block;font-size:11px;color:var(--mu);margin-top:3px}' +
    '.swfc-blur{filter:blur(4px);user-select:none;color:var(--mu)}' +
    '.swfc-lock{margin-top:12px;padding:14px;border:1px dashed #d1d5db;border-radius:8px;background:rgba(255,255,255,.7);font-size:14px}' +
    '.swfc-cta{display:inline-block;margin-top:10px;background:var(--t);color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px}' +
    '.swfc-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:swfcs .7s linear infinite;vertical-align:-2px;margin-right:8px}' +
    '@keyframes swfcs{to{transform:rotate(360deg)}}' +
    // Auto-playing demo: shown while nobody is using the form.
    '.swfc{position:relative}' +
    '.swfc-badge{position:absolute;top:-11px;right:16px;z-index:3;display:none;align-items:center;gap:7px;background:var(--t);color:#fff;font-size:11px;font-weight:600;letter-spacing:.04em;padding:5px 11px;border-radius:999px;box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none}' +
    '.swfc-badge i{width:7px;height:7px;border-radius:50%;background:#ef4444;animation:swfcp 1.4s ease-in-out infinite}' +
    '.swfc-demo .swfc-badge{display:inline-flex}' +
    '.swfc-demo .swfc-card{box-shadow:0 0 0 3px rgba(234,115,23,.12),0 10px 30px rgba(0,0,0,.08)}' +
    '.swfc-demo .swfc-out{min-height:330px}' +
    '.swfc-live{border-color:var(--o)!important;box-shadow:0 0 0 3px rgba(234,115,23,.18);outline:none}' +
    '.swfc-cur{position:absolute;left:0;top:0;z-index:4;width:22px;height:22px;pointer-events:none;opacity:0;transition:transform .7s cubic-bezier(.45,0,.2,1),opacity .3s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}' +
    '.swfc-demo .swfc-cur{opacity:1}' +
    '.swfc-cur::after{content:"";position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:rgba(234,115,23,.45);transform:scale(0);opacity:0}' +
    '.swfc-cur.tap::after{animation:swfct .45s ease-out}' +
    '.swfc-press{transform:scale(.97);filter:brightness(.92)}' +
    '.swfc-go,.swfc-tab{transition:transform .12s,filter .12s,background .2s,color .2s}' +
    '.swfc-scan{margin-top:16px;border:1px solid var(--b);border-radius:12px;padding:18px;background:#fff;animation:swfcin .35s ease-out}' +
    '.swfc-bar{height:4px;border-radius:4px;background:#f3f4f6;overflow:hidden;margin-bottom:14px}' +
    '.swfc-bar b{display:block;height:100%;width:0;background:var(--o);transition:width .5s ease}' +
    '.swfc-text{font-size:14px;line-height:1.6;color:#374151;background:#fafafa;border-radius:8px;padding:10px 12px;margin-bottom:12px;position:relative;overflow:hidden}' +
    '.swfc-text::after{content:"";position:absolute;top:0;bottom:0;left:-30%;width:30%;background:linear-gradient(90deg,transparent,rgba(234,115,23,.18),transparent);animation:swfcsw 1.3s ease-in-out infinite}' +
    '.swfc-text.done::after{display:none}' +
    '.swfc-text mark{background:transparent;color:inherit;border-radius:3px;padding:0 1px;transition:background .5s,box-shadow .5s}' +
    '.swfc-text mark.on{background:#fde68a;box-shadow:inset 0 -2px 0 #f59e0b}' +
    '.swfc-row{display:flex;align-items:center;gap:10px;font-size:13px;padding:6px 0;border-top:1px solid #f3f4f6;opacity:.35;transition:opacity .3s}' +
    '.swfc-row.on{opacity:1}' +
    '.swfc-row s{text-decoration:none;flex:0 0 20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:#f3f4f6;color:var(--mu)}' +
    '.swfc-row.ok s{background:#dcfce7;color:#16a34a}.swfc-row.bad s{background:#fee2e2;color:#dc2626}.swfc-row.warn s{background:#fef3c7;color:#b45309}' +
    '.swfc-row em{font-style:normal;margin-left:auto;font-size:12px;font-weight:600;color:var(--mu)}' +
    '.swfc-row.bad em{color:#dc2626}.swfc-row.warn em{color:#b45309}.swfc-row.ok em{color:#16a34a}' +
    '.swfc-res.swfc-pop{animation:swfcin .45s cubic-bezier(.2,.9,.3,1.2)}' +
    '.swfc-fade{transition:opacity .4s;opacity:0}' +
    '@keyframes swfcp{50%{opacity:.25}}' +
    '@keyframes swfct{0%{transform:scale(0);opacity:1}100%{transform:scale(2.4);opacity:0}}' +
    '@keyframes swfcsw{to{left:100%}}' +
    '@keyframes swfcin{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  root.innerHTML =
    '<div class="swfc"><div class="swfc-badge" aria-hidden="true"><i></i>Example check \u00b7 click to try your own</div>' +
    '<div class="swfc-cur" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 9.5-6.6 1.4 3.8 7.2-2.6 1.4-3.8-7.2L4 19z" fill="#1a1a1a" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg></div>' +
    '<form class="swfc-card" novalidate>' +
      '<div class="swfc-tabs" role="group" aria-label="Channel">' +
        '<button type="button" class="swfc-tab" data-ch="email" aria-pressed="true">Email</button>' +
        '<button type="button" class="swfc-tab" data-ch="sms" aria-pressed="false">SMS</button>' +
        '<button type="button" class="swfc-tab" data-ch="social" aria-pressed="false">Social post</button>' +
      '</div>' +
      '<div class="swfc-subj"><label for="swfc-subj">Subject line</label><input id="swfc-subj" maxlength="300" placeholder="Last chance: 50% off ends tonight"></div>' +
      '<label for="swfc-copy">Your campaign copy</label>' +
      '<textarea id="swfc-copy" maxlength="6000" placeholder="Paste the email, SMS or post you are about to send"></textarea>' +
      '<label for="swfc-email">Your work email</label><input id="swfc-email" type="email" autocomplete="email" maxlength="254" placeholder="you@company.com">' +
      '<button class="swfc-go" type="submit">Check it free</button>' +
      '<div class="swfc-err" role="alert"></div>' +
      '<p class="swfc-small">One free check a day. Checked against ICO, ASA and CMA rules. We use your email only to limit free checks, never for marketing. We do not keep the text you paste. Not legal advice.</p>' +
    '</form><div class="swfc-out" aria-live="polite"></div></div>';

  var form = root.querySelector('form');
  var channel = 'email';
  function setChannel(ch) {
    channel = ch;
    root.querySelectorAll('.swfc-tab').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-ch') === ch)); });
    root.querySelector('.swfc-subj').style.display = ch === 'email' ? '' : 'none';
  }
  root.querySelectorAll('.swfc-tab').forEach(function (b) {
    b.addEventListener('click', function () { setChannel(b.getAttribute('data-ch')); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('.swfc-go');
    var err = form.querySelector('.swfc-err');
    var out = root.querySelector('.swfc-out');
    err.textContent = '';
    btn.disabled = true; btn.innerHTML = '<span class="swfc-spin"></span>Checking against ICO, ASA and CMA rules…';
    fetch(API + '/api/free-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, subject: root.querySelector('#swfc-subj').value, copy: root.querySelector('#swfc-copy').value, email: root.querySelector('#swfc-email').value }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { d.status = r.status; throw d; } return d; });
    }).then(function (v) {
      var h = '<div class="swfc-res ' + esc(v.verdict) + '"><div class="swfc-vl">' + esc(v.label) + '</div><div class="swfc-vh">' + esc(v.headline) + '</div>';
      if (v.glimpse) {
        h += '<div class="swfc-item">' + esc(v.glimpse.text) + ' <span class="swfc-blur" aria-hidden="true">the rule it falls under and how to fix it</span></div>';
      }
      h += '<div class="swfc-lock">' +
        (v.issueCount ? '<strong>' + v.issueCount + ' item' + (v.issueCount === 1 ? '' : 's') + ' found.</strong> The full details, the fix for each one and a rewritten version are in the Sendwize report.' :
                        'Check your list and landing pages too, and keep a dated record that you checked, with Sendwize.') +
        '<br><a class="swfc-cta" href="' + esc(SIGNUP) + '">See the full report</a></div>';
      h += '<p class="swfc-small">' + esc(v.notice) + '</p></div>';
      out.innerHTML = h;
      out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (d) {
      err.innerHTML = esc((d && d.error) || 'The check could not run. Please try again.') +
        (d && d.status === 429 ? ' <a href="' + esc(SIGNUP) + '">Create an account</a>' : '');
    }).finally(function () {
      btn.disabled = false; btn.textContent = 'Check it free';
    });
  });
  /* Demo mode: while nobody is using the form, play a scripted example check
   * (typing, scanning, verdict) on a loop so the embed never sits static.
   * It never calls the API. Any click, tap, key or focus inside the widget
   * stops it and hands back a clean form. Turn it off with
   * window.SW_FREE_CHECK_DEMO = false. */
  if (window.SW_FREE_CHECK_DEMO === false) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var CHECKS = ['PECR: consent and opt-out', 'ASA CAP Code: claims you can prove', 'CMA: urgency and pricing', 'ASA: ads are clearly labelled'];
  var SCENES = [
    {
      ch: 'email', email: 'sam@brightbrew.co.uk',
      subject: 'LAST CHANCE: 70% off everything ends tonight!!',
      copy: "Hi there, our biggest sale ever ends at midnight. Guaranteed lowest prices in the UK, so grab yours before it's gone. Bought from us before? You're already on our list. Shop now",
      flags: ['ends at midnight', 'Guaranteed lowest prices in the UK', "You're already on our list"],
      checks: [['bad', 'No opt-out'], ['bad', 'Unproven claim'], ['warn', 'Check deadline'], ['ok', 'Clear']],
      verdict: 'hold', label: 'Hold', headline: 'Hold this send. We found 3 potential areas requiring review.', count: 3,
      glimpse: 'A "guaranteed lowest prices" claim needs evidence you can',
    },
    {
      ch: 'sms', email: 'jo@thecornercafe.co.uk',
      copy: 'Corner Cafe: 2-for-1 lattes this weekend only! Show this text at the till to claim.',
      flags: ['Show this text at the till to claim.'],
      checks: [['bad', 'No STOP option'], ['ok', 'Clear'], ['ok', 'Clear'], ['ok', 'Clear']],
      verdict: 'fix_first', label: 'Fix first', headline: 'Fix first. We found 1 potential area requiring review.', count: 1,
      glimpse: 'Marketing texts need a free, simple way',
    },
    {
      ch: 'social', email: 'alex@trailflex.com',
      copy: 'Ad | Our new Trailflex runners are in. Light, grippy and made for wet UK trails. 20% off for the first week, ends Sunday 9pm. Link in bio.',
      flags: [],
      checks: [['ok', 'Clear'], ['ok', 'Clear'], ['ok', 'Clear'], ['ok', 'Clear']],
      verdict: 'go', label: 'Go', headline: 'Go. The copy check found no potential areas requiring review.', count: 0,
    },
  ];

  var wrap = root.querySelector('.swfc');
  var cur = root.querySelector('.swfc-cur');
  var outEl = root.querySelector('.swfc-out');
  var fields = [root.querySelector('#swfc-subj'), root.querySelector('#swfc-copy'), root.querySelector('#swfc-email')];
  var goBtn = form.querySelector('.swfc-go');
  var run = 0;          // bumps on every stop, so a running script knows to quit
  var playing = false;
  var visible = false;
  var touched = false;  // the visitor has used the form: never replay over their work
  var idleTimer = null;

  function Stop() {}
  function wait(ms, id) {
    return new Promise(function (ok, no) { setTimeout(function () { id === run ? ok() : no(new Stop()); }, ms); });
  }
  function moveTo(el, id) {
    var w = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    cur.style.transform = 'translate(' + Math.round(r.left - w.left + Math.min(r.width * 0.6, 160)) + 'px,' + Math.round(r.top - w.top + r.height * 0.55) + 'px)';
    return wait(750, id);
  }
  function tap(el, id) {
    cur.classList.remove('tap'); void cur.offsetWidth; cur.classList.add('tap');
    el.classList.add('swfc-press');
    return wait(160, id).then(function () { el.classList.remove('swfc-press'); return wait(200, id); });
  }
  function type(el, text, id) {
    el.classList.add('swfc-live');
    var i = 0;
    function next() {
      if (i >= text.length) { el.classList.remove('swfc-live'); return wait(250, id); }
      // Type a few characters at a time on long copy so it reads like a fast typist.
      var step = text.length > 80 ? 2 : 1;
      i = Math.min(text.length, i + step);
      el.value = text.slice(0, i);
      el.scrollTop = el.scrollHeight;
      return wait(text.charAt(i - 1) === ' ' ? 45 : 28, id).then(next);
    }
    return next();
  }
  function marked(text, flags) {
    var h = esc(text);
    flags.forEach(function (f, n) { h = h.replace(esc(f), '<mark data-n="' + n + '">' + esc(f) + '</mark>'); });
    return h;
  }

  function scene(sc, id) {
    return moveTo(root.querySelector('.swfc-tab[data-ch="' + sc.ch + '"]'), id)
      .then(function () { return tap(root.querySelector('.swfc-tab[data-ch="' + sc.ch + '"]'), id); })
      .then(function () { setChannel(sc.ch); return wait(250, id); })
      .then(function () { return sc.subject ? moveTo(fields[0], id).then(function () { return type(fields[0], sc.subject, id); }) : null; })
      .then(function () { return moveTo(fields[1], id); })
      .then(function () { return type(fields[1], sc.copy, id); })
      .then(function () { return moveTo(fields[2], id); })
      .then(function () { return type(fields[2], sc.email, id); })
      .then(function () { return moveTo(goBtn, id); })
      .then(function () { return tap(goBtn, id); })
      .then(function () {
        goBtn.innerHTML = '<span class="swfc-spin"></span>Checking against ICO, ASA and CMA rules…';
        outEl.innerHTML = '<div class="swfc-scan"><div class="swfc-bar"><b></b></div>' +
          '<div class="swfc-text">' + marked(sc.copy, sc.flags) + '</div>' +
          CHECKS.map(function (c) { return '<div class="swfc-row"><s>·</s>' + esc(c) + '<em>Checking…</em></div>'; }).join('') + '</div>';
        cur.style.opacity = '0';
        var rows = outEl.querySelectorAll('.swfc-row'), bar = outEl.querySelector('.swfc-bar b'), marks = outEl.querySelectorAll('mark');
        var chain = wait(300, id);
        CHECKS.forEach(function (c, n) {
          chain = chain.then(function () {
            var st = sc.checks[n][0];
            rows[n].className = 'swfc-row on ' + st;
            rows[n].querySelector('s').textContent = st === 'ok' ? '✓' : '!';
            rows[n].querySelector('em').textContent = sc.checks[n][1];
            bar.style.width = ((n + 1) / CHECKS.length * 100) + '%';
            if (marks[n]) marks[n].classList.add('on');
            return wait(650, id);
          });
        });
        return chain.then(function () { outEl.querySelector('.swfc-text').classList.add('done'); return wait(700, id); });
      })
      .then(function () {
        goBtn.textContent = 'Check it free';
        cur.style.opacity = '';
        var h = '<div class="swfc-res swfc-pop ' + sc.verdict + '"><div class="swfc-vl">' + esc(sc.label) + ' · example</div><div class="swfc-vh">' + esc(sc.headline) + '</div>';
        if (sc.glimpse) h += '<div class="swfc-item">' + esc(sc.glimpse) + '… <span class="swfc-blur" aria-hidden="true">the rule it falls under and how to fix it</span></div>';
        h += '<div class="swfc-lock">' + (sc.count ? '<strong>' + sc.count + ' item' + (sc.count === 1 ? '' : 's') + ' found.</strong> The full report has the fix for each one and a rewritten version.' :
          'Clear to send. Sendwize keeps a dated record that you checked.') +
          '<br><a class="swfc-cta swfc-try" href="#swfc-copy">Check your own copy free</a></div></div>';
        outEl.innerHTML = h;
        return wait(4800, id);
      })
      .then(function () { outEl.firstChild.classList.add('swfc-fade'); return wait(450, id); })
      .then(function () { clearForm(); return wait(500, id); });
  }

  function clearForm() {
    fields.forEach(function (f) { f.value = ''; f.classList.remove('swfc-live'); });
    outEl.innerHTML = '';
    goBtn.textContent = 'Check it free';
  }

  function play() {
    if (playing || touched || !visible) return;
    playing = true;
    var id = ++run;
    wrap.classList.add('swfc-demo');
    outEl.setAttribute('aria-live', 'off');
    var n = 0;
    (function loop() {
      scene(SCENES[n++ % SCENES.length], id).then(loop, function () {});
    })();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    run++;
    wrap.classList.remove('swfc-demo');
    outEl.setAttribute('aria-live', 'polite');
    clearForm();
    setChannel('email');
  }

  // The visitor takes over: stop at once and leave them an empty form.
  function takeOver(e) {
    var wasPlaying = playing;
    stop();
    clearTimeout(idleTimer);
    if (wasPlaying && e && e.target && e.target.classList && e.target.classList.contains('swfc-try')) {
      e.preventDefault();
      setTimeout(function () { fields[1].focus(); }, 0);
    }
    // If they wander off without typing anything, start the demo again later.
    idleTimer = setTimeout(function () {
      var busy = fields.some(function (f) { return f.value; }) || outEl.innerHTML || root.contains(document.activeElement);
      if (!busy) play();
    }, 25000);
  }
  ['pointerdown', 'keydown', 'focusin', 'touchstart'].forEach(function (ev) {
    root.addEventListener(ev, takeOver, { passive: ev !== 'pointerdown' });
  });
  form.addEventListener('submit', function () { touched = true; }, true);
  fields.forEach(function (f) { f.addEventListener('input', function () { touched = true; }); });

  // Only play while the widget is on screen; restart cleanly when it comes back.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      if (visible) setTimeout(play, 900); else stop();
    }, { threshold: 0.35 }).observe(root);
  } else {
    visible = true; setTimeout(play, 1500);
  }
})();
