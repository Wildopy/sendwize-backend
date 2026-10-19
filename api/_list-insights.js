// ─────────────────────────────────────────────────────────────
// SENDWIZE — _list-insights.js v1.0
// The reveals List Intelligence leads with. Pure functions over the
// normalised contacts (see _normalise.js normaliseListRow), so the
// same upload always gives the same answer.
//
//   realList       Green / amber / red: who you can safely market to
//                  today, whose consent is ageing, and who you can't
//                  legally or usefully contact, with the reasons.
//   provenance     Quality of each signup source, joined to the form
//                  findings from Site Sweep.
//   softOptIn      Contacts held on soft opt-in with no purchase.
//   evidence       How much of the list has a provable consent record.
//   leaks          Active contacts who opted out in an earlier upload
//                  (any list). Matched on truncated email hashes.
//   caseTwin       The published case this list most resembles.
//   peak           Contacts whose consent runs out before Black Friday.
//
// Works with any export: every check says when the columns it needs
// are missing instead of guessing.
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { matchCase, TWIN_MIN } from './_cases.js';

export const DEFAULT_CONSENT_MONTHS = 24;
export const EXPIRING_WINDOW_DAYS = 90;
const DORMANT_DAYS = 365;
const DAY = 86400000;

const DISPOSABLE = new Set(['mailinator.com','guerrillamail.com','10minutemail.com','throwam.com','yopmail.com','tempmail.com','fakeinbox.com','trashmail.com','sharklasers.com','guerrillamailblock.com','grr.la','guerrillamail.info','spam4.me','tempr.email','dispostable.com','mailnull.com']);
const ROLE = new Set(['admin','info','support','help','contact','sales','marketing','noreply','no-reply','postmaster','webmaster','abuse','hello','office','team','billing','accounts','enquiries','enquiry','mail','email']);
const TYPO = new Set(['gmai.com','gmial.com','gamil.com','hotmial.com','hotmai.com','yahooo.com','yaho.com','outlok.com','outloo.com','livee.com','iclod.com']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Reason codes. Red stops marketing; amber needs attention.
export const REASONS = {
  invalid:          { band: 'red',   label: 'Invalid email address' },
  disposable:       { band: 'red',   label: 'Disposable email address' },
  opted_out:        { band: 'red',   label: 'Unsubscribed or complained' },
  leak:             { band: 'red',   label: 'Opted out in an earlier upload but active here' },
  bounced:          { band: 'red',   label: 'Bounced or cleaned' },
  not_subscribed:   { band: 'red',   label: 'Never subscribed to marketing' },
  third_party:      { band: 'red',   label: 'Bought, rented or partner data' },
  soft_optin_no_purchase: { band: 'red', label: 'Soft opt-in with no purchase' },
  consent_expired:  { band: 'red',   label: 'No sign-up or engagement within your consent period' },
  consent_expiring: { band: 'amber', label: 'Consent period ends within 90 days' },
  dormant:          { band: 'amber', label: 'No engagement in 12 months' },
  unknown_basis:    { band: 'amber', label: 'Consent basis not recorded' },
  no_signup_record: { band: 'amber', label: 'No record of when they signed up' },
  role_based:       { band: 'amber', label: 'Role address (info@, sales@)' },
  typo_domain:      { band: 'amber', label: 'Likely typo in the domain' },
};
const RED_ORDER = ['invalid', 'disposable', 'opted_out', 'leak', 'bounced', 'not_subscribed', 'third_party', 'soft_optin_no_purchase', 'consent_expired'];
const AMBER_ORDER = ['consent_expiring', 'dormant', 'unknown_basis', 'no_signup_record', 'role_based', 'typo_domain'];

// Finding type each reason matches in the case library (_cases.js).
// Only reasons where the member would actually be marketing to people
// without a valid basis: never-subscribed contacts are simply not
// marketable, so they don't get a fine comparison.
const REASON_FIX_TYPE = { third_party: 'third_party_list', soft_optin_no_purchase: 'consent_missing', leak: 'suppression_breach' };
const CASE_ISSUE = { third_party_list: 'marketing to bought or third-party data', consent_missing: 'marketing to people without valid consent', suppression_breach: 'marketing to people who had opted out' };

const time = d => (d instanceof Date && !isNaN(d)) ? d.getTime() : (d ? (t => isNaN(t) ? null : t)(new Date(d).getTime()) : null);
const pct = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;
const fmt = n => Number(n || 0).toLocaleString('en-GB');
const gbp = n => '£' + Math.round(n || 0).toLocaleString('en-GB');

// 12 hex chars of sha256: 48 bits, so collisions are negligible at list scale
export function emailKey(email) {
  return crypto.createHash('sha256').update(String(email || '').toLowerCase().trim()).digest('hex').slice(0, 12);
}

// Black Friday: the day after the fourth Thursday of November
export function nextBlackFriday(now = new Date()) {
  for (let y = now.getUTCFullYear(); y <= now.getUTCFullYear() + 1; y++) {
    const nov1 = new Date(Date.UTC(y, 10, 1));
    const firstThu = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
    const bf = new Date(Date.UTC(y, 10, firstThu + 21 + 1));
    if (bf.getTime() > now.getTime()) return bf;
  }
  return null;
}

export function normaliseConsentBasis(raw) {
  const s = String(raw || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!s || /^(n\/?a|none|null|unknown|-)$/.test(s)) return null;
  if (/soft|existing customer|customer relationship|similar product/.test(s)) return 'soft_opt_in';
  if (/double|confirmed opt|confirmed/.test(s)) return 'double_opt_in';
  if (/legitimate|\bli\b/.test(s)) return 'legitimate_interest';
  if (/purchas|bought|rented|acquired|third party|3rd party|data broker|list rental/.test(s)) return 'purchased';
  if (/partner|co ?reg|affiliate|lead gen|referral partner/.test(s)) return 'partner';
  if (/opt ?in|consent|express|explicit|single|subscribed|checkbox|form/.test(s)) return 'express';
  return 'other';
}

// "yes", "SUBSCRIBED", "accepts marketing" → consented; "no", "NEVER_SUBSCRIBED" → not
export function normaliseMarketingConsent(raw) {
  const s = String(raw || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!s || /^(n\/?a|null|unknown|-)$/.test(s)) return null;
  if (/unsub|opted out|opt out|revoked|withdrawn/.test(s)) return 'opted_out';
  if (/never|not subscribed|non subscribed|^no$|^false$|^0$|pending|declined/.test(s)) return 'not_subscribed';
  if (/^yes$|^true$|^1$|subscribed|opted in|opt in|granted|accept/.test(s)) return 'subscribed';
  return null;
}

function isTruthy(raw) { return /^(yes|true|1|y|unsubscribed|opted out)$/i.test(String(raw || '').trim()); }

// One verdict per contact: band, every reason, and the consent clock
export function classifyContact(c, opts) {
  const { now, validityDays, has, optoutKeys } = opts;
  const reasons = [];
  const email = c.email || '';
  const [local = '', domain = ''] = email.split('@');

  if (!EMAIL_RE.test(email)) reasons.push('invalid');
  else if (DISPOSABLE.has(domain)) reasons.push('disposable');

  const consent = c.marketingConsent || null;
  const status = c.status || null;
  if (status === 'unsubscribed' || status === 'complained' || consent === 'opted_out' || c.unsubTime || c.unsubscribedFlag) reasons.push('opted_out');
  else if (optoutKeys && optoutKeys.has(emailKey(email))) reasons.push('leak');
  if (status === 'bounced' || status === 'cleaned') reasons.push('bounced');
  if (consent === 'not_subscribed' || status === 'not_subscribed' || status === 'pending' || status === 'transactional') reasons.push('not_subscribed');

  const basis = c.consentBasis || null;
  if (basis === 'purchased' || basis === 'partner') reasons.push('third_party');
  const boughtEvidence = !!(time(c.lastPurchase) || (c.orderValue > 0) || (c.orderCount > 0));
  if (basis === 'soft_opt_in' && has.purchase && !boughtEvidence) reasons.push('soft_optin_no_purchase');

  // Consent clock: the latest sign-up or sign of interest, against the member's chosen period
  const signup = time(c.optinTime) || time(c.confirmTime) || time(c.dateAdded);
  // An engagement rating of 3+ (e.g. Mailchimp's 1-5 stars) reflects recent activity
  // even when the export has no activity date; count it as seen in the last 90 days.
  const ratingSeen = Number(c.engagementScore) >= 3 ? now - 90 * DAY : 0;
  const lastSeen = Math.max(time(c.lastEngagement) || 0, time(c.lastClick) || 0, time(c.lastPurchase) || 0, ratingSeen);
  const anchor = Math.max(signup || 0, lastSeen || 0) || null;
  let daysLeft = null;
  if (anchor) {
    daysLeft = Math.round((anchor + validityDays * DAY - now) / DAY);
    if (daysLeft <= 0) reasons.push('consent_expired');
    else if (daysLeft <= EXPIRING_WINDOW_DAYS) reasons.push('consent_expiring');
  } else if (has.signup) reasons.push('no_signup_record');

  if (has.engagement) {
    const rating = Number(c.engagementScore);
    const engagedRecently = lastSeen && (now - lastSeen) <= DORMANT_DAYS * DAY;
    const ratedEngaged = Number.isFinite(rating) && rating >= 3;
    const ratedLow = Number.isFinite(rating) && rating <= 1;
    const oldEnough = signup ? (now - signup) > DORMANT_DAYS * DAY : true;
    if (ratedLow || (!engagedRecently && !ratedEngaged && oldEnough)) reasons.push('dormant');
  }
  if (has.basis && !basis) reasons.push('unknown_basis');
  if (ROLE.has(local.split('+')[0].split('.')[0])) reasons.push('role_based');
  if (TYPO.has(domain)) reasons.push('typo_domain');

  const red = RED_ORDER.filter(r => reasons.includes(r));
  const amber = AMBER_ORDER.filter(r => reasons.includes(r));
  const band = red.length ? 'red' : amber.length ? 'amber' : 'green';
  return { band, reasons: red.concat(amber), primary: red[0] || amber[0] || null, daysLeft, signup, lastSeen: lastSeen || null, bought: boughtEvidence, basis };
}

// What the mapped columns let us check
export function capabilities(mapping) {
  const v = new Set(Object.values(mapping || {}));
  const any = (...f) => f.some(x => v.has(x));
  return {
    signup: any('date_added', 'optin_time', 'confirm_time'),
    engagement: any('last_engagement', 'last_click', 'last_purchase', 'engagement_score'),
    purchase: any('last_purchase', 'order_value', 'order_count'),
    basis: v.has('consent_basis'),
    source: v.has('source'),
    status: any('status', 'marketing_consent', 'unsub_time', 'unsubscribed_flag'),
    optinTime: v.has('optin_time'),
    optinIp: v.has('optin_ip'),
    confirmTime: v.has('confirm_time'),
    value: any('order_value'),
  };
}

// Site Sweep capture findings that a source name points at
const SOURCE_STOP = new Set(['form', 'signup', 'sign', 'up', 'page', 'website', 'site', 'web', 'the', 'and', 'list', 'email', 'subscribe', 'newsletter']);
function tokens(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !SOURCE_STOP.has(t)); }
function sweepMatches(source, sweepFindings) {
  const st = new Set(tokens(source));
  if (!st.size) return [];
  return (sweepFindings || []).filter(f => tokens(f.page).some(t => st.has(t)));
}
const RISKY_SOURCE = /giveaway|competition|comp\b|contest|prize|sweepstake|purchas|bought|rented|partner|co ?reg|affiliate|lead ?gen|import|upload|csv|data/i;

function provenance(rows, total, has, sweepFindings) {
  if (!has.source) return { available: false, note: 'Add a source or sign-up form column to see which sources bring good contacts.' };
  const groups = {};
  for (const r of rows) {
    const key = (r.c.source || '').trim() || '(no source recorded)';
    const g = groups[key] || (groups[key] = { source: key, count: 0, red: 0, amber: 0, green: 0, neverEngaged: 0, buyers: 0, evidence: 0, reasons: {} });
    g.count++; g[r.v.band]++;
    if (!r.v.lastSeen) g.neverEngaged++;
    if (r.v.bought) g.buyers++;
    if (r.v.signup) g.evidence++;
    for (const x of r.v.reasons) g.reasons[x] = (g.reasons[x] || 0) + 1;
  }
  const list = Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 25).map(g => {
    const topReason = Object.entries(g.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const sweep = sweepMatches(g.source, sweepFindings);
    const flagged = g.count >= 20 && (pct(g.red, g.count) >= 40 || pct(g.neverEngaged, g.count) >= 80 || sweep.length > 0 || RISKY_SOURCE.test(g.source));
    return {
      source: g.source, count: g.count, sharePct: pct(g.count, total),
      greenPct: pct(g.green, g.count), amberPct: pct(g.amber, g.count), redPct: pct(g.red, g.count),
      neverEngagedPct: has.engagement ? pct(g.neverEngaged, g.count) : null,
      buyersPct: has.purchase ? pct(g.buyers, g.count) : null,
      evidencePct: pct(g.evidence, g.count),
      topReason, topReasonLabel: topReason ? REASONS[topReason].label : null,
      sweepFindings: sweep.map(f => ({ title: f.title, page: f.page, fixType: f.fixType })),
      flagged,
    };
  });
  const scored = list.filter(g => g.count >= 20 && g.source !== '(no source recorded)');
  const best = has.purchase
    ? [...scored].sort((a, b) => b.buyersPct - a.buyersPct)[0]
    : [...scored].sort((a, b) => b.greenPct - a.greenPct)[0];
  const worst = [...scored].sort((a, b) => (b.redPct + (b.neverEngagedPct || 0)) - (a.redPct + (a.neverEngagedPct || 0)))[0];
  let sentence = null;
  if (worst && best && worst.source !== best.source) {
    const describe = g => has.purchase
      ? `${g.buyersPct}% bought from you${g.neverEngagedPct != null ? ` and ${g.neverEngagedPct}% never engaged` : ''}`
      : `${g.greenPct}% are safe to market${g.neverEngagedPct != null ? ` and ${g.neverEngagedPct}% never engaged` : ''}`;
    sentence = `"${worst.source}" added ${fmt(worst.count)} contacts: ${describe(worst)}. "${best.source}" added ${fmt(best.count)}: ${describe(best)}.`;
  }
  const formIssues = (sweepFindings || []).filter(f => /capture/.test(f.fixType || ''));
  return { available: true, sources: list, best: best?.source || null, worst: worst?.source || null, sentence, formIssues };
}

function evidenceSummary(rows, total, has) {
  const n = k => rows.filter(r => r.c[k]).length;
  const withSignup = rows.filter(r => r.v.signup).length;
  const withSource = rows.filter(r => r.c.source).length;
  const withOptinTime = n('optinTime'), withIp = n('optinIp'), withConfirm = n('confirmTime');
  // A full record says when they signed up and either where, or the opt-in IP / confirmation
  const full = rows.filter(r => r.v.signup && (r.c.source || r.c.optinIp || r.c.confirmTime)).length;
  const coverage = {
    signupDate: pct(withSignup, total), source: pct(withSource, total),
    optinTimestamp: has.optinTime ? pct(withOptinTime, total) : null,
    optinIp: has.optinIp ? pct(withIp, total) : null,
    doubleOptIn: has.confirmTime ? pct(withConfirm, total) : null,
  };
  const fullPct = pct(full, total);
  const grade = fullPct >= 90 ? 'strong' : (coverage.signupDate >= 80 && coverage.source >= 50) ? 'partial' : 'weak';
  const missing = total - withSignup;
  const sentence = grade === 'strong'
    ? `${fullPct}% of your contacts have a full consent record: when they signed up, plus where (source) or how (opt-in IP or double opt-in).`
    : `If the ICO asked how ${fmt(total)} people agreed to hear from you, you could show a full record for ${fullPct}%. ${missing > 0 ? `${fmt(missing)} have no record of when they signed up.` : ''}`.trim();
  return { grade, fullRecordPct: fullPct, coverage, noSignupRecord: missing, sentence };
}

// rows: [{ c: contact, v: classifyContact(...) }]
function realList(rows, total, values) {
  const by = { green: 0, amber: 0, red: 0 };
  const reasonCounts = {};
  for (const r of rows) {
    by[r.v.band]++;
    if (r.v.primary) reasonCounts[r.v.primary] = (reasonCounts[r.v.primary] || 0) + 1;
  }
  const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, band: REASONS[code].band, label: REASONS[code].label, count, pct: pct(count, total) }));
  const sum = (list, f) => Math.round(list.reduce((s, r) => s + (f(r) || 0), 0));
  const spent = r => (r.c.orderValue > 0 ? r.c.orderValue : 0);
  const amber = rows.filter(r => r.v.band === 'amber');
  const expiring60 = rows.filter(r => r.v.daysLeft != null && r.v.daysLeft > 0 && r.v.daysLeft <= 60);
  return {
    total, green: by.green, amber: by.amber, red: by.red,
    greenPct: pct(by.green, total), amberPct: pct(by.amber, total), redPct: pct(by.red, total),
    reasons, amberValue: sum(amber, values), amberSpent: sum(amber, spent),
    expiring60: expiring60.length, expiring60Value: sum(expiring60, values), expiring60Spent: sum(expiring60, spent),
  };
}

function caseTwinFor(counts, library, ctx) {
  let best = null;
  for (const [reason, count] of Object.entries(counts)) {
    const fixType = REASON_FIX_TYPE[reason];
    if (!fixType || !count) continue;
    for (const c of library || []) {
      const m = matchCase({ fixType, contactVolume: count }, c, ctx);
      if (!m || m.score < TWIN_MIN) continue;
      if (!best || m.score > best.match || (m.score === best.match && (c.penalty || 0) > (best.penalty || 0))) {
        best = { caseId: c.id, name: c.name, regulator: c.regulator, date: c.date, penalty: c.penalty || null, summary: c.summary, url: c.url, match: m.score, reasons: m.reasons, issue: REASONS[reason].label, yourCount: count, reason };
      }
    }
  }
  if (!best) return null;
  const year = String(best.date || '').slice(0, 4);
  best.sentence = `${best.name} was ${best.penalty ? `fined ${gbp(best.penalty)}` : 'subject to enforcement'} by the ${best.regulator}${year ? ` in ${year}` : ''} for ${CASE_ISSUE[REASON_FIX_TYPE[best.reason]]}. ${fmt(best.yourCount)} of your contacts fall into the same category: ${best.issue.toLowerCase()}.`;
  return best;
}

/**
 * contacts: normalised contacts (deduplicated), each with originalIndex
 * opts: { mapping, now, consentMonths, optoutKeys (Set), optoutSources (Map key→list name),
 *         sweepFindings, library, sector, value(contact) → £ }
 */
export function buildListInsights(contacts, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const consentMonths = Math.min(120, Math.max(6, Number(opts.consentMonths) || DEFAULT_CONSENT_MONTHS));
  const validityDays = Math.round(consentMonths * 30.44);
  const has = capabilities(opts.mapping);
  const values = r => (opts.value ? opts.value(r.c) : 0);

  const rows = contacts.map(c => ({ c, v: classifyContact(c, { now, validityDays, has, optoutKeys: opts.optoutKeys }) }));
  const total = rows.length;
  const real = realList(rows, total, values);

  // Leaks: which earlier lists they opted out of
  const leakRows = rows.filter(r => r.v.reasons.includes('leak'));
  const leakFrom = {};
  for (const r of leakRows) {
    const from = opts.optoutSources?.get(emailKey(r.c.email)) || 'an earlier upload';
    leakFrom[from] = (leakFrom[from] || 0) + 1;
  }
  const leaks = {
    checked: !!opts.optoutKeys, count: leakRows.length, comparedAgainst: opts.optoutKeys ? opts.optoutKeys.size : 0,
    from: Object.entries(leakFrom).sort((a, b) => b[1] - a[1]).map(([list, count]) => ({ list, count })),
    sentence: leakRows.length
      ? `${fmt(leakRows.length)} people who unsubscribed ${Object.keys(leakFrom).length === 1 ? `from "${Object.keys(leakFrom)[0]}"` : 'in earlier uploads'} are active on this list. Emailing them again is a breach of PECR Regulation 22 unless they re-subscribed.`
      : null,
  };

  // Soft opt-in
  const soft = rows.filter(r => r.v.basis === 'soft_opt_in');
  const softBad = rows.filter(r => r.v.reasons.includes('soft_optin_no_purchase'));
  const softOptIn = !has.basis
    ? { checked: false, note: 'Add a consent basis column to check soft opt-in.' }
    : !has.purchase
      ? { checked: false, onSoftOptIn: soft.length, note: soft.length ? `${fmt(soft.length)} contacts are on soft opt-in. Add a purchase column (last order, orders or spend) to check they actually bought.` : null }
      : { checked: true, onSoftOptIn: soft.length, noPurchase: softBad.length,
          sentence: softBad.length ? `${fmt(softBad.length)} contacts marked soft opt-in have never bought from you. Soft opt-in only covers people who bought or started to buy, so they need to opt in.` : null };

  const thirdParty = rows.filter(r => r.v.reasons.includes('third_party')).length;

  // Peak season: consent that runs out before Black Friday
  const bf = nextBlackFriday(new Date(now));
  const daysToPeak = bf ? Math.round((bf.getTime() - now) / DAY) : null;
  const lapseBeforePeak = daysToPeak != null ? rows.filter(r => r.v.daysLeft != null && r.v.daysLeft > 0 && r.v.daysLeft <= daysToPeak).length : 0;
  const peak = bf ? {
    date: bf.toISOString().slice(0, 10), daysToPeak, lapseBeforePeak,
    reachable: real.green + real.amber - lapseBeforePeak,
    sentence: `By Black Friday (${bf.toISOString().slice(0, 10)}) you can safely email about ${fmt(real.green + real.amber - lapseBeforePeak)} people on this list.${lapseBeforePeak ? ` ${fmt(lapseBeforePeak)} more lose consent before then unless they engage.` : ''}`,
  } : null;

  // Every reason count (not just primary) for fixes and the case twin
  const allReasons = {};
  for (const r of rows) for (const x of r.v.reasons) allReasons[x] = (allReasons[x] || 0) + 1;

  const twin = caseTwinFor(allReasons, opts.library, { sector: opts.sector, listSize: total, now: opts.now });
  const prov = provenance(rows, total, has, opts.sweepFindings);
  const evidence = evidenceSummary(rows, total, has);

  // Headline sentences, strongest first
  const headline = `${fmt(real.green)} of your ${fmt(total)} contacts are safe to market today.`;
  const reveals = [];
  if (leaks.sentence) reveals.push({ kind: 'leak', severity: 'red', text: leaks.sentence });
  if (softOptIn.sentence) reveals.push({ kind: 'soft_opt_in', severity: 'red', text: softOptIn.sentence });
  if (thirdParty) reveals.push({ kind: 'third_party', severity: 'red', text: `${fmt(thirdParty)} contacts came from bought, rented or partner data. The ICO's most common PECR fines start here.` });
  if (real.expiring60) {
    const worth = real.expiring60Spent ? `. They've spent ${gbp(real.expiring60Spent)} with you` : real.expiring60Value >= 100 ? `, worth an estimated ${gbp(real.expiring60Value)}` : '';
    reveals.push({ kind: 'expiring', severity: 'amber', text: `${fmt(real.expiring60)} contacts lose consent in the next 60 days${worth}. A re-permission email now keeps them.` });
  }
  if (prov.sentence) reveals.push({ kind: 'source', severity: 'info', text: prov.sentence });
  if (twin) reveals.push({ kind: 'case_twin', severity: 'info', text: twin.sentence });

  // Compact row flags for downloads: [originalIndex, band, reason codes]
  const rowFlags = rows.filter(r => r.v.band !== 'green').map(r => [r.c.originalIndex, r.v.band === 'red' ? 'r' : 'a', r.v.reasons.join('|')]);
  const indices = { green: [], amber: [], red: [] };
  for (const r of rows) indices[r.v.band].push(r.c.originalIndex);

  return {
    version: 'list-insights-1.0', consentMonths, capabilities: has,
    headline, reveals, realList: real, leaks, softOptIn, thirdParty, provenance: prov, evidence, caseTwin: twin, peak,
    reasonCounts: allReasons,
    _rowFlags: rowFlags, _indices: indices,
  };
}
