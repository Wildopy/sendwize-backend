// ─────────────────────────────────────────────────────────────
// SENDWIZE — _guard.js v1.0
// Site guard: the logic behind the one-line script (public/g.js).
// Pure functions, so they can be tested without Redis or Airtable.
//
// How the numbers flow:
//   g.js on a customer's site  →  POST /api/guard?action=collect
//   → one Redis hash per site per day (counters only, no personal data)
//   → nightly rollup (/api/guard?action=rollup) summarises yesterday,
//     keeps 35 days of summaries on the Site_Sweeps record (GuardJson),
//     opens and closes alerts, raises and closes dashboard fixes.
//
// Nothing here identifies a visitor: no cookies set, no ids, no IPs
// stored. Only which known tags fired, the consent state at the time,
// the page path and any "was £X" price shown.
// ─────────────────────────────────────────────────────────────

// Tag names g.js may report. Anything else is dropped server-side, so
// nobody can write arbitrary fields into a site's counters.
export const GUARD_TRACKERS = [
  'Google Analytics', 'Google Ads', 'Meta Pixel', 'TikTok Pixel', 'Microsoft Ads',
  'Microsoft Clarity', 'Hotjar', 'LinkedIn Insight', 'Pinterest Tag', 'Snap Pixel',
  'Criteo', 'X (Twitter) Ads', 'Reddit Pixel', 'Klaviyo',
];
export const GUARD_CMPS = ['OneTrust', 'Cookiebot', 'CookieYes', 'Didomi', 'Usercentrics', 'Termly', 'Iubenda', 'Shopify', 'Osano', 'Complianz', 'Google Consent Mode', 'Other', 'None'];
const STATES = ['accepted', 'rejected', 'none', 'unknown'];
const GOOGLE_TAGS = ['Google Analytics', 'Google Ads'];

export const DAILY_KEEP = 35;
export const PRICE_STALE_DAYS = 28;
export const MAX_DAILY_VISITS = 300000; // per site per day, then counting stops
const MIN_PRE_HITS = 3;                  // page views with a tag firing early before we alert
const RESOLVE_QUIET_DAYS = 2;            // days with no early firing before an alert closes
const RESOLVE_MIN_VISITS = 30;

export function dayKey(d = new Date()) { return new Date(d).toISOString().slice(0, 10); }
export function siteDayKey(siteKey, day) { return `sw:g:${siteKey}:${day}`; }
export function sitePagesKey(siteKey, day) { return `sw:g:${siteKey}:${day}:pg`; }
export function siteLastKey(siteKey) { return `sw:g:${siteKey}:last`; }
export function siteMapKey(siteKey) { return `sw:gk:${siteKey}`; }

export function isGuardKey(k) { return typeof k === 'string' && /^[a-f0-9]{20,40}$/.test(k); }

// /products/123/abc?x=1 → /products/:id/abc ; first three segments only
export function normalisePath(p) {
  let s = String(p || '/').split(/[?#]/)[0].toLowerCase();
  if (!s.startsWith('/')) s = '/' + s;
  const segs = s.split('/').filter(Boolean).slice(0, 3).map(seg =>
    /^\d+$/.test(seg) || /^[a-f0-9-]{16,}$/.test(seg) ? ':id' : seg.replace(/[^a-z0-9._~-]/g, '').slice(0, 40));
  return ('/' + segs.filter(Boolean).join('/')).slice(0, 100) || '/';
}

// "48", "48.00", "1,299.99" → "48", "48", "1299.99"
function normaliseAmount(a) {
  const n = Number(String(a).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return String(Math.round(n * 100) / 100);
}

// Validates a beacon from g.js. Returns a clean object or null.
export function cleanBeacon(b) {
  if (!b || typeof b !== 'object' || !isGuardKey(b.k)) return null;
  const state = STATES.includes(b.s) ? b.s : 'unknown';
  const cmp = GUARD_CMPS.includes(b.c) ? b.c : (b.c ? 'Other' : 'None');
  const trackers = [];
  for (const t of Array.isArray(b.t) ? b.t.slice(0, 30) : []) {
    const name = Array.isArray(t) ? t[0] : t?.n;
    const pre = Array.isArray(t) ? t[1] : t?.pre;
    if (GUARD_TRACKERS.includes(name) && !trackers.some(x => x.name === name)) trackers.push({ name, pre: !!pre });
  }
  const cmDefault = ['denied', 'granted', 'missing'].includes(b.cm?.d) ? b.cm.d : 'missing';
  const cmUpdated = !!b.cm?.u;
  const prices = [...new Set((Array.isArray(b.w) ? b.w.slice(0, 3) : []).map(normaliseAmount).filter(Boolean))];
  return { key: b.k, path: normalisePath(b.p), state, cmp, trackers, cmDefault, cmUpdated, prices };
}

// The Redis commands that record one beacon
export function beaconCommands(beacon, day, nowIso = new Date().toISOString()) {
  const h = siteDayKey(beacon.key, day);
  const cmds = [
    ['HINCRBY', h, 'v', 1],
    ['HINCRBY', h, `s:${beacon.state}`, 1],
    ['HINCRBY', h, `cmp:${beacon.cmp}`, 1],
    ['HINCRBY', h, `cmd:${beacon.cmDefault}`, 1],
  ];
  if (beacon.state === 'accepted') cmds.push(['HINCRBY', h, `cmu:${beacon.cmUpdated ? 1 : 0}`, 1]);
  for (const t of beacon.trackers) {
    cmds.push(['HINCRBY', h, `t:${t.name}`, 1]);
    if (beacon.state === 'unknown') cmds.push(['HINCRBY', h, `unk:${t.name}`, 1]);
    else if (t.pre) {
      cmds.push(['HINCRBY', h, `pre:${t.name}`, 1]);
      cmds.push(['HINCRBY', h, `pp:${t.name}|${beacon.path}`, 1]);
    }
  }
  for (const a of beacon.prices) cmds.push(['HINCRBY', h, `w:${beacon.path}|${a}`, 1]);
  cmds.push(['EXPIRE', h, 60 * 60 * 24 * 40]);
  cmds.push(['PFADD', sitePagesKey(beacon.key, day), beacon.path]);
  cmds.push(['EXPIRE', sitePagesKey(beacon.key, day), 60 * 60 * 24 * 40]);
  cmds.push(['SET', siteLastKey(beacon.key), nowIso, 'EX', 60 * 60 * 24 * 60]);
  return cmds;
}

// One day's Redis hash → a compact summary kept on the record
export function summariseDay(day, hash = {}, pages = 0) {
  const sum = { d: day, v: hash.v || 0, pages: pages || 0, consent: {}, trackers: {}, prePaths: {}, cmp: {}, cm: { denied: 0, granted: 0, missing: 0 }, cmu: { yes: hash['cmu:1'] || 0, no: hash['cmu:0'] || 0 }, prices: [] };
  for (const s of STATES) sum.consent[s] = hash[`s:${s}`] || 0;
  for (const [k, n] of Object.entries(hash)) {
    if (k.startsWith('t:')) (sum.trackers[k.slice(2)] ||= { seen: 0, pre: 0, unknown: 0 }).seen = n;
    else if (k.startsWith('pre:')) (sum.trackers[k.slice(4)] ||= { seen: 0, pre: 0, unknown: 0 }).pre = n;
    else if (k.startsWith('unk:')) (sum.trackers[k.slice(4)] ||= { seen: 0, pre: 0, unknown: 0 }).unknown = n;
    else if (k.startsWith('pp:')) {
      const [name, path] = k.slice(3).split('|');
      (sum.prePaths[name] ||= []).push([path, n]);
    } else if (k.startsWith('cmp:')) sum.cmp[k.slice(4)] = n;
    else if (k.startsWith('cmd:')) sum.cm[k.slice(4)] = n;
    else if (k.startsWith('w:')) {
      const [path, amount] = k.slice(2).split('|');
      sum.prices.push([path, amount, n]);
    }
  }
  for (const name of Object.keys(sum.prePaths)) sum.prePaths[name] = sum.prePaths[name].sort((a, b) => b[1] - a[1]).slice(0, 5);
  sum.prices = sum.prices.sort((a, b) => b[2] - a[2]).slice(0, 20);
  return sum;
}

// Consent over a run of daily summaries. Rate = accepted ÷ page views
// where a consent tool was read (accepted, rejected or no choice yet).
export function consentStats(daily = []) {
  const t = { accepted: 0, rejected: 0, none: 0, unknown: 0, visits: 0 };
  for (const d of daily) {
    t.visits += d.v || 0;
    for (const s of STATES) t[s] += d.consent?.[s] || 0;
  }
  const known = t.accepted + t.rejected + t.none;
  return { ...t, known, rate: known ? t.accepted / known : null, unmeasured: t.rejected + t.none };
}

export function mainCmp(daily = []) {
  const c = {};
  for (const d of daily) for (const [k, n] of Object.entries(d.cmp || {})) c[k] = (c[k] || 0) + n;
  return Object.entries(c).filter(([k]) => k !== 'None').sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Benchmarks only appear once 5 comparable sites exist, so one site can
// never be identified from them.
export const BENCH_MIN_SITES = 5;
export const BENCH_MIN_KNOWN = 300;
export function buildBenchmarks(sites = []) {
  const ok = sites.filter(s => s.known >= BENCH_MIN_KNOWN && s.rate != null);
  const out = { overall: null, sectors: {}, updatedAt: new Date().toISOString() };
  if (ok.length >= BENCH_MIN_SITES) out.overall = { median: median(ok.map(s => s.rate)), sites: ok.length };
  const by = {};
  for (const s of ok) if (s.sector) (by[s.sector] ||= []).push(s.rate);
  for (const [sector, rates] of Object.entries(by)) if (rates.length >= BENCH_MIN_SITES) out.sectors[sector] = { median: median(rates), sites: rates.length };
  return out;
}

// ── Alerts ────────────────────────────────────────────────────
// Each alert has a stable key, so it is opened once, updated while the
// problem continues, and closed when it stops.
const TYPES = {
  pre_consent: { severity: 'high', regulator: 'ICO', ruleRef: 'PECR Reg 6', fixType: 'cookie_trackers_before_consent' },
  no_cmp: { severity: 'medium', regulator: 'ICO', ruleRef: 'PECR Reg 6', fixType: 'cookie_banner_missing' },
  consent_mode_missing: { severity: 'low', regulator: null, ruleRef: 'Google Consent Mode v2' },
  consent_mode_no_update: { severity: 'low', regulator: null, ruleRef: 'Google Consent Mode v2' },
  price_stale: { severity: 'medium', regulator: 'CMA', ruleRef: 'DMCCA 2024; CMA pricing practices guidance' },
  script_silent: { severity: 'low', regulator: null, ruleRef: '' },
};

function pctText(x) { return `${Math.round(x * 100)}%`; }

// state: GuardJson ({ daily, alerts, prices })
// latest: the summary for the day just finished
// lastSeenIso: when the script last reported
// Returns { state, opened, resolved } — opened/resolved are alert objects
export function evaluateGuard(state = {}, latest, { now = new Date(), lastSeenIso = null } = {}) {
  const s = { daily: [...(state.daily || [])], alerts: [...(state.alerts || [])].map(a => ({ ...a, events: [...(a.events || [])] })), prices: { ...(state.prices || {}) } };
  const nowIso = new Date(now).toISOString();
  const opened = [], resolved = [];
  if (latest) {
    s.daily = s.daily.filter(d => d.d !== latest.d);
    s.daily.push(latest);
    s.daily.sort((a, b) => a.d.localeCompare(b.d));
    s.daily = s.daily.slice(-DAILY_KEEP);
  }
  const byKey = new Map(s.alerts.map(a => [a.key, a]));
  const open = (key, type, fields) => {
    const existing = byKey.get(key);
    if (existing && existing.status === 'open') {
      Object.assign(existing, { lastSeen: nowIso, detail: fields.detail, count: fields.count ?? existing.count });
      return existing;
    }
    const meta = TYPES[type];
    const a = { key, type, status: 'open', severity: meta.severity, regulator: meta.regulator, ruleRef: meta.ruleRef, fixType: meta.fixType || null, firstSeen: nowIso, lastSeen: nowIso, ...fields, events: [{ at: nowIso, text: existing ? 'Started again' : 'First seen' }] };
    if (existing) Object.assign(existing, a); else { s.alerts.push(a); byKey.set(key, a); }
    opened.push(byKey.get(key));
    return a;
  };
  const close = (a, text) => {
    a.status = 'resolved'; a.resolvedAt = nowIso;
    a.events.push({ at: nowIso, text });
    resolved.push(a);
  };

  const recent = s.daily.slice(-RESOLVE_QUIET_DAYS);
  const recentVisits = recent.reduce((n, d) => n + (d.v || 0), 0);

  if (latest && latest.v > 0) {
    // 1. Tags firing before a consent choice
    for (const [name, t] of Object.entries(latest.trackers || {})) {
      if ((t.pre || 0) < MIN_PRE_HITS) continue;
      const pages = (latest.prePaths?.[name] || []).map(([p]) => p);
      open(`pre:${name}`, 'pre_consent', {
        tracker: name, page: pages[0] || '/', pages, count: t.pre,
        title: `${name} fires before anyone accepts cookies`,
        detail: `Yesterday ${name} fired before a consent choice on ${t.pre.toLocaleString('en-GB')} page view${t.pre === 1 ? '' : 's'}${pages.length ? `, mostly on ${pages.slice(0, 3).join(', ')}` : ''}. Non-essential tags need consent first. Check the tag's trigger in your tag manager or consent tool.`,
      });
    }
    // 2. Tracking with no consent tool recognised
    const cmpRead = (latest.consent?.accepted || 0) + (latest.consent?.rejected || 0) + (latest.consent?.none || 0);
    const unknownTagged = Object.values(latest.trackers || {}).reduce((n, t) => n + (t.unknown || 0), 0);
    if (latest.v >= 20 && cmpRead === 0 && unknownTagged >= MIN_PRE_HITS) {
      const names = Object.entries(latest.trackers || {}).filter(([, t]) => t.unknown).map(([n]) => n);
      open('no_cmp', 'no_cmp', {
        page: '/', count: unknownTagged,
        title: 'Tracking runs with no consent banner recognised',
        detail: `${names.join(', ')} ran on ${unknownTagged.toLocaleString('en-GB')} page view${unknownTagged === 1 ? '' : 's'} yesterday, and Sendwize could not find a consent tool on those pages. If you use one we don't recognise, check it blocks these tags until people accept.`,
      });
    }
    // 3. Google Consent Mode
    const googleSeen = GOOGLE_TAGS.some(n => (latest.trackers?.[n]?.seen || 0) > 0);
    if (googleSeen && cmpRead >= 20) {
      const cmTotal = (latest.cm?.denied || 0) + (latest.cm?.granted || 0) + (latest.cm?.missing || 0);
      const missingShare = cmTotal ? (latest.cm.missing || 0) / cmTotal : 0;
      if (missingShare > 0.8) open('cm:missing', 'consent_mode_missing', {
        page: '/', count: latest.cm.missing,
        title: 'Google Consent Mode is not set up',
        detail: 'Your Google tags run without a Consent Mode default. Without it Google cannot model the conversions you lose when people reject cookies, so your ad reports undercount and bidding works on less data.',
      });
      const acc = (latest.cmu?.yes || 0) + (latest.cmu?.no || 0);
      if (acc >= 20 && (latest.cmu?.yes || 0) / acc < 0.2) open('cm:no_update', 'consent_mode_no_update', {
        page: '/', count: latest.cmu.no,
        title: 'Google tags are not told when people accept',
        detail: `On ${pctText((latest.cmu.no || 0) / acc)} of page views where people accepted cookies, Google Consent Mode was never updated to "granted". Those visits stay unmeasured even though you have consent. This is usually one setting in your consent tool.`,
      });
    }
    // 4. "Was £X" shown for longer than 28 days
    const seenToday = new Set();
    for (const [path, amount] of latest.prices || []) {
      const k = `${path}|${amount}`;
      seenToday.add(k);
      s.prices[k] ||= { firstSeen: latest.d, lastSeen: latest.d };
      s.prices[k].lastSeen = latest.d;
      const days = Math.floor((Date.parse(latest.d) - Date.parse(s.prices[k].firstSeen)) / 86400000) + 1;
      if (days > PRICE_STALE_DAYS) open(`price:${k}`, 'price_stale', {
        page: path, count: days,
        title: `"Was £${amount}" has been shown for ${days} days`,
        detail: `Visitors to ${path} have seen a "was £${amount}" comparison since ${s.prices[k].firstSeen}. A reference price should be one the product genuinely sold at recently. Once a sale price has run longer than the higher price did, the comparison is likely to mislead. Remove the "was" price or confirm the price history.`,
      });
    }
    // Forget prices not seen for 7 days
    for (const [k, v] of Object.entries(s.prices)) if (Date.parse(latest.d) - Date.parse(v.lastSeen) > 7 * 86400000) delete s.prices[k];
  }

  // Closing: an open alert closes once the problem has stopped
  for (const a of s.alerts.filter(x => x.status === 'open')) {
    if (a.type === 'pre_consent' && recent.length >= RESOLVE_QUIET_DAYS && recentVisits >= RESOLVE_MIN_VISITS &&
        recent.every(d => (d.trackers?.[a.tracker]?.pre || 0) === 0)) {
      const waited = recent.reduce((n, d) => n + (d.trackers?.[a.tracker]?.seen || 0), 0);
      close(a, `Stopped. ${recentVisits.toLocaleString('en-GB')} page views over ${RESOLVE_QUIET_DAYS} days with no early firing${waited ? `; ${a.tracker} now waits for consent` : ''}.`);
    } else if (a.type === 'no_cmp' && latest && ((latest.consent?.accepted || 0) + (latest.consent?.rejected || 0) + (latest.consent?.none || 0)) > 0) {
      close(a, 'A consent tool is now recognised on your pages.');
    } else if (a.type === 'consent_mode_missing' && latest && (latest.cm?.missing || 0) <= 0.2 * ((latest.cm?.denied || 0) + (latest.cm?.granted || 0) + (latest.cm?.missing || 0))) {
      close(a, 'Consent Mode default now set.');
    } else if (a.type === 'consent_mode_no_update' && latest && (latest.cmu?.yes || 0) >= 0.5 * ((latest.cmu?.yes || 0) + (latest.cmu?.no || 0)) && (latest.cmu?.yes || 0) > 0) {
      close(a, 'Google tags now update when people accept.');
    } else if (a.type === 'price_stale' && latest && !(latest.prices || []).some(([p, am]) => `price:${p}|${am}` === a.key)) {
      const k = a.key.slice(6);
      const last = s.prices[k]?.lastSeen;
      if (!last || Date.parse(latest.d) - Date.parse(last) >= 3 * 86400000) close(a, 'The "was" price is no longer shown.');
    } else if (a.type === 'script_silent' && lastSeenIso && Date.parse(lastSeenIso) > Date.parse(a.firstSeen)) {
      close(a, 'The script is reporting again.');
    }
  }

  // 5. Script stopped reporting
  const hadData = s.daily.some(d => (d.v || 0) > 0);
  if (hadData && lastSeenIso && Date.parse(nowIso) - Date.parse(lastSeenIso) > 3 * 86400000 && !s.alerts.some(a => a.key === 'silent' && a.status === 'open')) {
    open('silent', 'script_silent', {
      page: '/', count: 0,
      title: 'Site guard has stopped hearing from your site',
      detail: `The last report arrived ${new Date(lastSeenIso).toISOString().slice(0, 10)}. If the script was removed in a site update, add it back so monitoring continues.`,
    });
  }

  // Keep the newest 60 alerts
  s.alerts = s.alerts.sort((a, b) => (a.status === b.status ? Date.parse(b.lastSeen) - Date.parse(a.lastSeen) : a.status === 'open' ? -1 : 1)).slice(0, 60);
  return { state: s, opened, resolved };
}

// What the page shows
export function guardView(state = {}, { benchmarks = null, sector = null } = {}) {
  const daily = state.daily || [];
  const last30 = daily.slice(-30);
  const consent = consentStats(last30);
  const trackers = {};
  for (const d of last30) for (const [n, t] of Object.entries(d.trackers || {})) {
    const x = (trackers[n] ||= { name: n, seen: 0, pre: 0 });
    x.seen += t.seen || 0; x.pre += t.pre || 0;
  }
  const bench = benchmarks ? (sector && benchmarks.sectors?.[sector] ? { ...benchmarks.sectors[sector], label: `similar ${sector} sites` } : benchmarks.overall ? { ...benchmarks.overall, label: 'sites using Site guard' } : null) : null;
  return {
    days: last30.length,
    visits: consent.visits,
    pagesSeenYesterday: daily[daily.length - 1]?.pages || 0,
    consent: { rate: consent.rate, accepted: consent.accepted, rejected: consent.rejected, noChoice: consent.none, unmeasured: consent.unmeasured, known: consent.known },
    cmp: mainCmp(last30),
    trackers: Object.values(trackers).sort((a, b) => b.seen - a.seen),
    benchmark: bench,
    alerts: (state.alerts || []).map(a => ({ key: a.key, type: a.type, status: a.status, severity: a.severity, regulator: a.regulator, ruleRef: a.ruleRef, title: a.title, detail: a.detail, page: a.page, pages: a.pages, firstSeen: a.firstSeen, lastSeen: a.lastSeen, resolvedAt: a.resolvedAt || null, events: a.events || [] })),
    daily: last30.map(d => ({ d: d.d, v: d.v, accepted: d.consent?.accepted || 0, known: (d.consent?.accepted || 0) + (d.consent?.rejected || 0) + (d.consent?.none || 0) })),
  };
}
