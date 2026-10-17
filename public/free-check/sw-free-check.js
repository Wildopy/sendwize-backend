/* Sendwize free check: embed for the marketing site.
 *
 * Paste into a Webflow Code Embed:
 *   <div id="sw-free-check"></div>
 *   <script>window.SW_SIGNUP_URL = 'https://your-site/signup';</script>
 *   <script src="https://sendwize-backend.vercel.app/free-check/sw-free-check.js" defer></script>
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
    '.swfc-lock{margin-top:12px;padding:14px;border:1px dashed #d1d5db;border-radius:8px;background:rgba(255,255,255,.7);font-size:14px}' +
    '.swfc-cta{display:inline-block;margin-top:10px;background:var(--t);color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px}' +
    '.swfc-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:swfcs .7s linear infinite;vertical-align:-2px;margin-right:8px}' +
    '@keyframes swfcs{to{transform:rotate(360deg)}}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  root.innerHTML =
    '<div class="swfc"><form class="swfc-card" novalidate>' +
      '<div class="swfc-tabs" role="group" aria-label="Channel">' +
        '<button type="button" class="swfc-tab" data-ch="email" aria-pressed="true">Email</button>' +
        '<button type="button" class="swfc-tab" data-ch="sms" aria-pressed="false">SMS</button>' +
        '<button type="button" class="swfc-tab" data-ch="social" aria-pressed="false">Social post</button>' +
      '</div>' +
      '<div class="swfc-subj"><label for="swfc-subj">Subject line</label><input id="swfc-subj" maxlength="300" placeholder="Last chance: 50% off ends tonight"></div>' +
      '<label for="swfc-copy">Your campaign copy</label>' +
      '<textarea id="swfc-copy" maxlength="6000" placeholder="Paste the email, SMS or post you are about to send"></textarea>' +
      '<button class="swfc-go" type="submit">Check it free</button>' +
      '<div class="swfc-err" role="alert"></div>' +
      '<p class="swfc-small">No sign-up. Checked against ICO, ASA and CMA rules. We do not keep the text you paste. Not legal advice.</p>' +
    '</form><div class="swfc-out" aria-live="polite"></div></div>';

  var form = root.querySelector('form');
  var channel = 'email';
  root.querySelectorAll('.swfc-tab').forEach(function (b) {
    b.addEventListener('click', function () {
      channel = b.getAttribute('data-ch');
      root.querySelectorAll('.swfc-tab').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      root.querySelector('.swfc-subj').style.display = channel === 'email' ? '' : 'none';
    });
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
      body: JSON.stringify({ channel: channel, subject: root.querySelector('#swfc-subj').value, copy: root.querySelector('#swfc-copy').value }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { d.status = r.status; throw d; } return d; });
    }).then(function (v) {
      var h = '<div class="swfc-res ' + esc(v.verdict) + '"><div class="swfc-vl">' + esc(v.label) + '</div><div class="swfc-vh">' + esc(v.headline) + '</div>';
      if (v.summary) h += '<div class="swfc-small" style="margin-top:0">' + esc(v.summary) + '</div>';
      (v.items || []).forEach(function (i) { h += '<div class="swfc-item">' + esc(i.issue) + (i.regulation ? '<span class="swfc-ref">' + esc(i.regulation) + '</span>' : '') + '</div>'; });
      var more = (v.hiddenCount || 0) + (v.lowCount || 0);
      h += '<div class="swfc-lock">' +
        (more ? '<strong>' + more + ' more item' + (more === 1 ? '' : 's') + '</strong>, the fix for each, and a rewritten version are in your Sendwize account.' :
                'Check your list and landing pages too, and keep a dated record that you checked, in your Sendwize account.') +
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
})();
