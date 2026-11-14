/* ─────────────────────────────────────────────────────────────
   SENDWIZE: sw-connect.js v1.0  (browser)
   "Pull straight from Klaviyo, Mailchimp or HubSpot" panel for List health and
   Audience read. Connect once with a read-only API key; after that one
   click pulls the data in the same shape as the platform's CSV export,
   and the page carries on exactly as if a file had been dropped in.

     SWConnect.mount(el, { mode: 'contacts' | 'campaigns', userId, onData })
     onData({ headers, rows, name, truncated, total })   rows are objects
   ───────────────────────────────────────────────────────────── */
(function () {
  var API = 'https://sendwize-backend.vercel.app/api/connections';
  var NAMES = { klaviyo: 'Klaviyo', mailchimp: 'Mailchimp', hubspot: 'HubSpot' };
  var HINTS = {
    klaviyo: 'In Klaviyo: Settings → API keys → Create private API key. Choose <b>Read-only</b> access and paste the key (it starts pk_).',
    mailchimp: 'In Mailchimp: Profile → Extras → API keys → Create a key. Paste it here (it ends in something like -us21).',
    hubspot: 'In HubSpot: Settings → Integrations → Private apps → Create a private app. On Scopes tick <b>crm.objects.contacts.read</b>, <b>crm.lists.read</b> and <b>content</b> (for email results), create it, then copy the access token (it starts pat-).'
  };
  var CSS = '.swc{border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:0 0 18px;background:#fff;font-family:inherit}' +
    '.swc-h{font-size:14px;font-weight:700;margin:0 0 4px;color:#111}.swc-s{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.5}' +
    '.swc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.swc-b{border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:#111}' +
    '.swc-b.pri{background:#111;color:#fff;border-color:#111}.swc-b:disabled{opacity:.5;cursor:not-allowed}.swc-in,.swc-sel{border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;min-width:0;flex:1 1 220px;max-width:100%}' +
    '.swc-link{background:none;border:none;color:#6b7280;font-size:12px;text-decoration:underline;cursor:pointer;padding:0;font-family:inherit}.swc-msg{font-size:12px;margin-top:8px;color:#6b7280}.swc-msg.er{color:#b91c1c}.swc-ok{color:#15803d;font-weight:600}';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function f(url, opts) { return (window.swFetch || fetch)(url, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); }
  function addCss() { if (document.getElementById('swc-css')) return; var s = document.createElement('style'); s.id = 'swc-css'; s.textContent = CSS; document.head.appendChild(s); }

  function mount(el, opts) {
    addCss();
    var st = { conns: [], picking: null, lists: null, busy: false, msg: '', err: false };
    var q = function (a) { return API + '?action=' + a + '&userId=' + encodeURIComponent(opts.userId || ''); };
    var post = function (a, body) { return f(q(a), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ userId: opts.userId }, body)) }); };
    var what = opts.mode === 'campaigns' ? 'campaign results' : 'contacts';

    function say(m, err) { st.msg = m; st.err = !!err; render(); }

    function render() {
      var c = st.conns[0];
      var h = '<div class="swc"><div class="swc-h">Pull straight from your email platform</div>';
      if (!c) {
        h += '<div class="swc-s">No export needed. Connect once with a read-only key and Sendwize pulls your ' + what + ' whenever you ask. Your key is stored encrypted and you can disconnect at any time.</div>';
        if (!st.picking) {
          h += '<div class="swc-row"><button class="swc-b" data-pick="klaviyo">Connect Klaviyo</button><button class="swc-b" data-pick="mailchimp">Connect Mailchimp</button><button class="swc-b" data-pick="hubspot">Connect HubSpot</button></div>';
        } else {
          h += '<div class="swc-s" style="margin-bottom:8px">' + HINTS[st.picking] + '</div><div class="swc-row"><input class="swc-in" type="password" autocomplete="off" placeholder="Paste your ' + NAMES[st.picking] + ' API key" id="swc-key"><button class="swc-b pri" data-act="connect"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Checking…' : 'Connect') + '</button><button class="swc-link" data-act="cancel">Cancel</button></div>';
        }
      } else {
        h += '<div class="swc-s"><span class="swc-ok">✓ Connected to ' + esc(c.name) + '</span>' + (c.account ? ' · ' + esc(c.account) : '') + ' · <button class="swc-link" data-act="disconnect">Disconnect</button></div>';
        if (opts.mode === 'campaigns') {
          h += '<div class="swc-row"><button class="swc-b pri" data-act="pull"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Pulling…' : 'Pull the last 12 months of campaigns') + '</button></div>';
        } else if (!st.lists) {
          h += '<div class="swc-msg">Loading your lists…</div>';
        } else if (!st.lists.length) {
          h += '<div class="swc-msg">No lists found in ' + esc(c.name) + '.</div>';
        } else {
          h += '<div class="swc-row"><select class="swc-sel" id="swc-list">' + st.lists.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + (l.count != null ? ' (' + Number(l.count).toLocaleString() + ')' : '') + '</option>'; }).join('') + '</select><button class="swc-b pri" data-act="pull"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Pulling… this can take up to a minute' : 'Pull this list') + '</button></div>';
        }
      }
      if (st.msg) h += '<div class="swc-msg' + (st.err ? ' er' : '') + '">' + esc(st.msg) + '</div>';
      el.innerHTML = h + '</div>';
    }

    function loadLists() {
      var c = st.conns[0];
      if (!c || opts.mode === 'campaigns') return;
      f(q('lists') + '&provider=' + c.provider).then(function (j) { st.lists = j.lists || []; render(); }).catch(function (e) { st.lists = []; say(e.message, true); });
    }

    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-pick],[data-act]');
      if (!t || st.busy) return;
      if (t.dataset.pick) { st.picking = t.dataset.pick; st.msg = ''; render(); var i = document.getElementById('swc-key'); if (i) i.focus(); return; }
      var act = t.dataset.act;
      if (act === 'cancel') { st.picking = null; st.msg = ''; render(); return; }
      if (act === 'connect') {
        var key = (document.getElementById('swc-key') || {}).value || '';
        if (!key.trim()) return say('Paste your API key first.', true);
        st.busy = true; render();
        post('connect', { provider: st.picking, apiKey: key.trim() }).then(function (j) {
          st.busy = false; st.picking = null; st.conns = [j.connection]; st.msg = ''; render(); loadLists();
        }).catch(function (e) { st.busy = false; say(e.message, true); });
        return;
      }
      if (act === 'disconnect') {
        var c = st.conns[0];
        st.busy = true; render();
        post('disconnect', { provider: c.provider }).then(function () { st.busy = false; st.conns = []; st.lists = null; say('Disconnected. Your key has been deleted.'); }).catch(function (e) { st.busy = false; say(e.message, true); });
        return;
      }
      if (act === 'pull') {
        var c2 = st.conns[0], sel = document.getElementById('swc-list');
        var listName = sel ? sel.options[sel.selectedIndex].text.replace(/ \([\d,]+\)$/, '') : '';
        st.busy = true; st.msg = ''; render();
        var body = { provider: c2.provider };
        if (sel) body.listId = sel.value;
        post(opts.mode === 'campaigns' ? 'pull-campaigns' : 'pull-contacts', body).then(function (j) {
          st.busy = false;
          var rows = (j.rows || []).map(function (r) { var o = {}; j.headers.forEach(function (hh, i) { o[hh] = r[i] == null ? '' : String(r[i]); }); return o; });
          if (!rows.length) return say('Nothing came back from ' + c2.name + (opts.mode === 'campaigns' ? ' for sent campaigns in the last year.' : ' for that list.'), true);
          say(rows.length.toLocaleString() + ' ' + (opts.mode === 'campaigns' ? 'campaigns' : 'contacts') + ' pulled from ' + c2.name + (j.truncated ? '. That\'s the most we pull in one go; the rest of the list wasn\'t included.' : '.'));
          opts.onData({ headers: j.headers, rows: rows, name: listName || (c2.name + ' campaigns'), provider: c2.provider, truncated: !!j.truncated, total: j.total });
        }).catch(function (e) { st.busy = false; say(e.message, true); });
      }
    });

    render();
    f(q('status')).then(function (j) { st.conns = j.connections || []; if (j.setupRequired) { el.innerHTML = ''; return; } render(); loadLists(); }).catch(function () { el.innerHTML = ''; });
  }

  window.SWConnect = { mount: mount };
})();
