// ─────────────────────────────────────────────────────────────
// SENDWIZE — _third-parties.js v1.0  (Third parties: risk rules)
// Underscore prefix: not an endpoint. Read by third-parties.js.
//
// The Third parties page leads with the risk each third party puts on
// the member, not with paperwork. For every platform, lead or data
// partner and affiliate this file works out, from what Sendwize already
// knows:
//   - the risks, in plain words, each ok / watch / problem / not known
//   - one verdict: Keep, Fix this or Stop using
//   - a £ figure from the shared exposure engine (_exposure.js), so it
//     agrees with the dashboard
//   - the best next action
//   - the Paperwork (data agreement and privacy policy), shown last but
//     still part of the verdict and the score
//
// It also decides which third parties Sendwize can add by itself. Rule
// agreed with the founder: only when the match is obviously clear. A
// tracker Site Sweep names from its fixed list is clear. A List health
// source is clear only when it names a known company, or labels itself
// as a partner / affiliate / co-reg / lead gen source AND gives a name.
// Vague labels ("giveaway", "partner", "import") are never added.
//
// Deterministic: no AI in here. Same inputs, same answer.
// Not legal advice.
// ─────────────────────────────────────────────────────────────
import { getExposureConstants, getICORange, areaOf, normaliseBand, normaliseSector } from './_exposure.js';
import { transferPosition, TRACKER_VENDORS } from './_processor-rules.js';

export const FOUND_PREFIX  = 'Found by Sendwize';
export const HIDDEN_PREFIX = 'Hidden by member';
export const isHidden = f => new RegExp('^' + HIDDEN_PREFIX, 'i').test(String(f?.Notes || ''));
export const isFound  = f => new RegExp('^' + FOUND_PREFIX, 'i').test(String(f?.Notes || ''));

const DPA_CONFIRMED = ['Confirmed', 'Confirmed and signed', 'In place'];
const agreed = s => DPA_CONFIRMED.includes(s || '');
const safeJSON = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const lc = s => String(s || '').toLowerCase().trim();

// ── What each kind of platform gets ───────────────────────────
const DATA_BY_CATEGORY = {
  esp:         'Names, email addresses, what people open and click, and often what they bought.',
  sms:         'Mobile numbers, names and which messages people respond to.',
  crm:         'Your full customer records: contact details, history and notes.',
  analytics:   'Which pages people visit, how they arrived, their device and rough location.',
  advertising: 'What people do on your site (visits, sign-ups, purchases), matched to their accounts on the ad platform.',
  payments:    'Names, card and payment details, billing addresses and order values.',
  support:     'Names, emails and everything customers write to you.',
  forms:       'Whatever people type into your forms.',
  agency:      'Whatever customer data you share for campaigns.',
  other:       'Customer data you share with it. Tell us what in the paperwork section.',
};

// ── Does the platform use the data for its own purposes? ──────
// Conservative on purpose: 'yes' only where the platform's own terms
// say so. 'likely' for ad networks whose model depends on it. Anything
// else is left for the member to answer.
const OWN_USE = [
  { match: /\b(meta|facebook|instagram)\b/, use: 'yes', text: 'Meta uses what its pixel collects on your site to target and measure ads for its own systems. Courts treat the site and Meta as joint controllers for collecting it (Fashion ID, 2019).' },
  { match: /\bgoogle ads\b|adwords|doubleclick/, use: 'yes', text: 'Google uses conversion and remarketing data across its own ad network, under its controller terms for ads.' },
  { match: /\btiktok\b/, use: 'yes', text: 'TikTok uses pixel data to target and measure ads on TikTok, not only for you.' },
  { match: /\blinkedin\b/, use: 'yes', text: 'LinkedIn uses Insight Tag data for its own ad targeting, and its terms treat you as joint controllers.' },
  { match: /\b(pinterest|snapchat|snap|criteo|x ads|twitter|microsoft ads|microsoft advertising|bing)\b/, use: 'likely', text: 'Ad networks usually build their own audience profiles from pixel data. Check their ad terms to confirm.' },
  { match: /\bgoogle analytics\b|\bga4\b/, use: 'settings', text: 'Google can use Analytics data for its own products if the data sharing settings in your Analytics account are switched on.' },
  { match: /\bhotjar\b/, use: 'no', text: 'Hotjar acts only on your instructions (as your processor).' },
];
export function ownUseFact(name, category) {
  const n = lc(name);
  const hit = OWN_USE.find(o => o.match.test(n));
  if (hit) return hit;
  if (['esp', 'sms', 'crm'].includes(category)) {
    return { use: 'unknown', text: 'Many email and CRM platforms now use customer data to train AI features. Check the AI settings in your account, or answer below.' };
  }
  return { use: 'unknown', text: 'Not known yet. Check their terms, or answer below.' };
}

// ── Clear-match rules for List health sources ─────────────────
// Real UK affiliate networks, cashback, voucher and comparison sites.
// Matching one of these names in a source label is a clear match.
export const KNOWN_SOURCE_PARTIES = {
  'topcashback':        { name: 'TopCashback',        kind: 'affiliate', type: 'Cashback Site' },
  'quidco':             { name: 'Quidco',             kind: 'affiliate', type: 'Cashback Site' },
  'awin':               { name: 'Awin',               kind: 'affiliate', type: 'Publisher Network' },
  'rakuten':            { name: 'Rakuten Advertising',kind: 'affiliate', type: 'Publisher Network' },
  'cj affiliate':       { name: 'CJ Affiliate',       kind: 'affiliate', type: 'Publisher Network' },
  'partnerize':         { name: 'Partnerize',         kind: 'affiliate', type: 'Publisher Network' },
  'webgains':           { name: 'Webgains',           kind: 'affiliate', type: 'Publisher Network' },
  'tradedoubler':       { name: 'Tradedoubler',       kind: 'affiliate', type: 'Publisher Network' },
  'vouchercodes':       { name: 'VoucherCodes',       kind: 'affiliate', type: 'Voucher Site' },
  'wowcher':            { name: 'Wowcher',            kind: 'affiliate', type: 'Voucher Site' },
  'groupon':            { name: 'Groupon',            kind: 'affiliate', type: 'Voucher Site' },
  'uswitch':            { name: 'Uswitch',            kind: 'affiliate', type: 'Comparison Site' },
  'moneysupermarket':   { name: 'MoneySuperMarket',   kind: 'affiliate', type: 'Comparison Site' },
  'gocompare':          { name: 'GoCompare',          kind: 'affiliate', type: 'Comparison Site' },
  'compare the market': { name: 'Compare the Market', kind: 'affiliate', type: 'Comparison Site' },
  'confused.com':       { name: 'Confused.com',       kind: 'affiliate', type: 'Comparison Site' },
};

// Role words that say "this source is a third party", and which register.
const ROLE_WORDS = [
  { re: /\b(co[\s-]?reg(istration)?)\b/i,        kind: 'partner',   type: 'Co-registration partner' },
  { re: /\blead[\s-]?gen(eration|erator)?\b/i,   kind: 'partner',   type: 'Lead Generation Partner' },
  { re: /\bdata partner\b|\bdata supplier\b|\blist (rental|broker)\b/i, kind: 'partner', type: 'Data Sharing Partner' },
  { re: /\bpartner(ship)?\b/i,                   kind: 'partner',   type: 'Lead Generation Partner' },
  { re: /\baffiliate\b/i,                        kind: 'affiliate', type: 'Email Affiliate' },
  { re: /\binfluencer\b/i,                       kind: 'affiliate', type: 'Influencer' },
  { re: /\bcashback\b/i,                         kind: 'affiliate', type: 'Cashback Site' },
];
// Words that are never a company name on their own
const GENERIC = new Set(['partner', 'partners', 'partnership', 'affiliate', 'affiliates', 'lead', 'leads', 'gen', 'generation', 'generator',
  'co', 'reg', 'coreg', 'registration', 'data', 'supplier', 'list', 'rental', 'broker', 'influencer', 'influencers', 'cashback',
  'via', 'from', 'the', 'and', 'our', 'with', 'campaign', 'campaigns', 'promo', 'promotion', 'giveaway', 'competition', 'comp', 'prize',
  'contest', 'form', 'signup', 'sign', 'up', 'website', 'site', 'web', 'page', 'landing', 'import', 'imported', 'upload', 'csv', 'manual',
  'newsletter', 'email', 'social', 'organic', 'paid', 'ads', 'ad', 'event', 'events', 'trade', 'show', 'popup', 'pop', 'checkout',
  'other', 'misc', 'unknown', 'test', 'new', 'old', 'uk', 'q1', 'q2', 'q3', 'q4', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul',
  'aug', 'sep', 'oct', 'nov', 'dec', 'spring', 'summer', 'autumn', 'winter', 'black', 'friday', 'christmas', 'xmas', 'sale', 'offer',
  'free', 'win', 'entry', 'entries', 'bought', 'purchased', 'rented', 'external', 'third', 'party', 'scheme', 'network', 'programme', 'program']);
// Platforms: a lead form on these is the member's own form, not a partner
const PLATFORM_WORDS = /\b(facebook|meta|instagram|google|tiktok|linkedin|pinterest|snapchat|twitter|klaviyo|mailchimp|hubspot|shopify|typeform|wix|squarespace|webflow|wordpress)\b/i;

function words(s) { return lc(s).split(/[^a-z0-9.&]+/).filter(Boolean); }

// A list source label → { name, kind, type, reason } or null.
export function sourceParty(label) {
  const l = lc(label);
  if (!l || l.length < 3) return null;
  for (const [key, p] of Object.entries(KNOWN_SOURCE_PARTIES)) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(l)) return { ...p, reason: `names ${p.name}` };
  }
  const role = ROLE_WORDS.find(r => r.re.test(l));
  if (!role) return null;
  if (PLATFORM_WORDS.test(l)) return null;
  // The name is whatever is left once the role words and filler are
  // removed, kept in the member's own spelling. At least one word must
  // be more than filler, or the label is too vague to act on.
  const FILLER = new Set(['via', 'from', 'the', 'and', 'by', 'with', 'our', 'source']);
  const kept = String(label).replace(new RegExp(role.re.source, 'ig'), ' ').split(/[\s:|\-–—_/()[\],]+/)
    .filter(w => w && !FILLER.has(w.toLowerCase()));
  const real = kept.filter(w => !GENERIC.has(w.toLowerCase().replace(/[^a-z0-9.&]/g, '')) && !/^\d+$/.test(w));
  if (!real.length || kept.length > 5) return null;
  const name = real.join(' ').trim();
  if (name.replace(/[^a-z]/gi, '').length < 3) return null;
  return { name, kind: role.kind, type: role.type, reason: `labelled as ${role.type.toLowerCase()}` };
}

// Does a source label clearly refer to a register name?
export function sourceMatchesName(label, name) {
  const n = lc(name).replace(/\b(ltd|limited|plc|llp|inc)\b\.?/g, '').trim();
  if (n.replace(/[^a-z0-9]/g, '').length < 4) return lc(label) === n;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(lc(label));
}

// Site Sweep trackers → register platforms. Every tracker name Site
// Sweep reports comes from its fixed list (TRACKER_VENDORS), so it is
// a clear match by design.
export function sweepParties(sweep) {
  if (!sweep || !Array.isArray(sweep.trackers)) return [];
  return sweep.trackers.filter(t => t && t.vendor && Object.values(TRACKER_VENDORS).some(d => d.vendor === t.vendor));
}

// ── Contacts a source brought, as shown on the page ───────────
export function performanceFor(name, lists) {
  const rows = [];
  for (const l of lists || []) {
    for (const s of l.sources || []) {
      if (s.source && sourceMatchesName(s.source, name)) rows.push({ list: l.listName, checkedAt: l.checkDate, ...s });
    }
  }
  if (!rows.length) return null;
  const count = rows.reduce((a, r) => a + (r.count || 0), 0);
  const w = k => { const has = rows.filter(r => r[k] != null); const c = has.reduce((a, r) => a + r.count, 0); return c ? Math.round(has.reduce((a, r) => a + r[k] * r.count, 0) / c) : null; };
  return {
    count, lists: [...new Set(rows.map(r => r.list))], checkedAt: rows.map(r => r.checkedAt).sort().pop() || null,
    greenPct: w('greenPct'), redPct: w('redPct'), neverEngagedPct: w('neverEngagedPct'), buyersPct: w('buyersPct'),
    labels: [...new Set(rows.map(r => r.source))],
  };
}

function performanceRisk(perf, name) {
  if (!perf) return null;
  const n = perf.count.toLocaleString('en-GB');
  const bits = [];
  if (perf.greenPct != null) bits.push(`${perf.greenPct}% are safe to email`);
  if (perf.neverEngagedPct != null) bits.push(`${perf.neverEngagedPct}% never opened or clicked`);
  if (perf.buyersPct != null) bits.push(`${perf.buyersPct}% bought from you`);
  const poor = (perf.redPct != null && perf.redPct >= 40) || (perf.neverEngagedPct != null && perf.neverEngagedPct >= 80);
  return {
    key: 'performance', title: 'How their contacts do on your list',
    status: poor ? 'warn' : 'ok', info: !poor,
    answer: `${n} contacts from ${name}`,
    detail: (bits.length ? bits.join(', ') + '. ' : '') + `From List health (${perf.lists.join(', ')}).` + (poor ? ' Poor engagement is a sign people did not expect to hear from you.' : ''),
  };
}

// ── £ figure from the shared engine ───────────────────────────
// Each open ICO risk takes the published-case range for its fix type
// (revenue band × sector). Risks a regulator would look at together
// (same area) are combined the engine's way: the largest plus 25% of
// each other one, capped at twice the largest. Areas are then added.
// ASA and CMA risks are never turned into £ here (same rule as the
// dashboard).
export function exposureFor(risks, profile = {}) {
  const band = profile.revenueBand ? normaliseBand(profile.revenueBand) : 'under_1m';
  const sector = normaliseSector(profile.sector || 'general');
  const groups = {};
  const other = [];
  for (const r of risks) {
    if (!r.fixType || r.status === 'ok' || r.info) continue;
    const def = getExposureConstants(r.fixType);
    if (!def) continue;
    if (def.category !== 'ICO') { other.push(def.category); continue; }
    const range = getICORange(def, band, sector);
    const area = areaOf(r.fixType);
    (groups[area] = groups[area] || []).push({ low: range.low, high: range.high, mid: Math.round((range.low + range.high) / 2) });
  }
  let low = 0, high = 0, mid = 0;
  for (const list of Object.values(groups)) {
    const s = [...list].sort((a, b) => b.high - a.high);
    const lead = s[0], rest = s.slice(1);
    const sum = k => rest.reduce((a, x) => a + x[k], 0);
    low  += Math.min(lead.low * 2,  lead.low  + 0.25 * sum('low'));
    high += Math.min(lead.high * 2, lead.high + 0.25 * sum('high'));
    mid  += Math.min(lead.mid * 2,  lead.mid  + 0.25 * sum('mid'));
  }
  const round = n => n >= 10000 ? Math.round(n / 1000) * 1000 : Math.round(n / 100) * 100;
  return {
    low: round(low), high: round(high), likely: round(mid),
    asa: other.filter(c => c === 'ASA').length, cma: other.filter(c => c === 'CMA').length,
    basis: 'Comparable published ICO cases for your turnover band and sector. Not a prediction, not legal advice.',
  };
}

// ── Verdict ───────────────────────────────────────────────────
const VERDICT = {
  keep: { label: 'Keep',        tone: 'g' },
  fix:  { label: 'Fix this',    tone: 'y' },
  stop: { label: 'Stop using',  tone: 'r' },
};
function verdictFrom(risks, paperwork) {
  if (risks.some(r => r.stop)) return 'stop';
  if (risks.some(r => !r.info && (r.status === 'bad' || r.status === 'unknown' || r.status === 'warn'))) return 'fix';
  if (!paperwork.ok) return 'fix';
  return 'keep';
}
const RANK = { bad: 0, unknown: 1, warn: 2, ok: 3 };
// Worst first: anything that means "stop", then problems, then unknowns.
// Within the same status, a risk the ICO prices comes before one it doesn't.
const priced = r => { const d = r.fixType && getExposureConstants(r.fixType); return d && d.category === 'ICO' ? 0 : 1; };
const worstFirst = (a, b) => (b.stop ? 1 : 0) - (a.stop ? 1 : 0) || RANK[a.status] - RANK[b.status] || priced(a) - priced(b);
function nextActionFrom(risks, paperwork, verdict) {
  const open = risks.filter(r => !r.info && r.status !== 'ok' && r.action).sort(worstFirst);
  if (open[0]) return open[0].action;
  if (!paperwork.ok && paperwork.action) return paperwork.action;
  return { label: verdict === 'keep' ? 'Nothing to do. We keep watching.' : 'Review the details', go: 'none' };
}
function finish(type, f, risks, paperwork, profile, extra = {}) {
  const verdict = verdictFrom(risks, paperwork);
  // The headline £ is the risks only. Missing paperwork has its own
  // figure in the Paperwork section, so a missing agreement never
  // outweighs what the third party is actually doing with the data.
  const exposure = exposureFor(risks, profile);
  exposure.unpriced = risks.filter(r => !r.info && r.status === 'bad' && !r.fixType).length;
  paperwork.exposure = paperwork.ok ? null : exposureFor(paperwork.risks || [], profile);
  const lead = risks.filter(r => !r.info && r.status !== 'ok').sort(worstFirst)[0];
  return {
    type, verdict, verdictLabel: VERDICT[verdict].label, tone: VERDICT[verdict].tone,
    rank: lead ? RANK[lead.status] : 4,
    headline: lead ? lead.headline || lead.title + ': ' + lead.answer : (paperwork.ok ? 'No open risks found.' : 'Only the paperwork is left to finish.'),
    risks, paperwork, exposure, nextAction: nextActionFrom(risks, paperwork, verdict),
    found: isFound(f) ? String(f.Notes).split('\n')[0].replace(/^Found by Sendwize:?\s*/i, '') : null,
    ...extra,
  };
}

// ── Platforms ─────────────────────────────────────────────────
export function assessPlatform(f, ctx = {}) {
  const name = f.VendorName || 'This platform';
  const mc = safeJSON(f.MarketingChecksJson, null) || {};
  const category = mc.category || f.Category || 'other';
  const answers = mc.answers || {};
  const intel = safeJSON(f.IntelligenceJson, null) || {};
  const risks = [];

  risks.push({ key: 'data', title: 'What they get', status: 'ok', info: true,
    answer: f.DataProcessed ? String(f.DataProcessed).replace(/^\[|\]$|"/g, '').replace(/,/g, ', ') : (DATA_BY_CATEGORY[category] || DATA_BY_CATEGORY.other),
    detail: '' });

  // Consent before loading (analytics and ad tags only)
  const tagCheck = { analytics: 'an_prior_consent', advertising: 'ad_pixel', agency: 'ag_tracking' }[category];
  if (tagCheck) {
    const c = (mc.checks || {})[tagCheck] || {};
    const fired = c.status === 'not_evidenced';
    const fromSweep = c.source === 'site_sweep';
    risks.push({
      key: 'consent', title: 'Loads before visitors say yes?',
      status: fired ? 'bad' : c.status === 'passed' ? 'ok' : c.status === 'needs_attention' ? 'warn' : 'unknown',
      answer: fired ? 'Yes, it sends data before any choice' : c.status === 'passed' ? 'No, it waits for consent' : 'Not checked yet',
      headline: fired ? `Sends your visitors' data before they agree` : null,
      detail: (c.note ? c.note.replace(/^Site Sweep [0-9-]+: /, 'Site Sweep: ') + ' ' : '') +
        (fired ? 'Under PECR, tags used for ads or profiling must wait for an opt-in. This is also the easiest thing for anyone to spot by opening your site.' : fromSweep ? '' : 'Run Site Sweep and we check this for you on your live site.'),
      action: fired ? { label: 'Make it wait for cookie consent', go: 'checks' } : c.status ? null : { label: 'Run Site Sweep', go: 'sweep' },
      note: 'No published fine range for cookie breaches yet, so this is not in the £ figure.',
    });
  }

  // Own use (ads or AI)
  const consentOk = (risks.find(r => r.key === 'consent') || {}).status === 'ok';
  const fact = ownUseFact(name, category);
  const own = answers.ownUse || (fact.use === 'yes' ? 'yes' : fact.use === 'no' ? 'no' : null);
  const ownAnswer = { yes: 'Yes, for its own ads or AI', no: 'No, only for you', likely: 'Probably', settings: 'Only if your settings allow it' };
  risks.push({
    key: 'ownUse', title: 'Uses your data for its own ads or AI?',
    // Allowed if the tag waits for an opt-in, so only a problem when it doesn't
    status: own === 'no' ? 'ok' : (own === 'yes' || fact.use === 'settings' || fact.use === 'likely') ? (consentOk ? 'ok' : 'warn') : 'unknown',
    answer: own ? ownAnswer[own] : (ownAnswer[fact.use] || 'Not known yet'),
    headline: !own && fact.use === 'unknown' ? 'Not known if it uses your data for its own ads or AI' : null,
    detail: fact.text + (own === 'yes' || fact.use === 'likely' || fact.use === 'settings'
      ? ' That is allowed, but people must opt in before it loads and your privacy notice must say who gets their data and why.' : ''),
    ask: fact.use === 'yes' || fact.use === 'no' ? null : 'ownUse',
    action: (own === 'yes' || fact.use === 'yes') && !consentOk ? { label: 'Make it wait for an opt-in', go: 'checks' } : !own && fact.use === 'unknown' ? { label: 'Answer: does it use your data?', go: 'ask', key: 'ownUse' } : null,
  });

  // Leaves the UK
  const t = transferPosition({ destination: f.TransferDestination || intel.transferDestination, mechanism: intel.transferMechanism || answers.mechanism });
  const tStatus = t.ok ? 'ok' : t.status === 'unknown' ? 'unknown' : t.status === 'needs_uk_tool' ? 'warn' : 'bad';
  risks.push({
    key: 'transfer', title: 'Does the data leave the UK?',
    status: tStatus,
    answer: t.status === 'none' ? 'No, it stays in the UK' : t.status === 'adequate' ? 'Yes, to the EEA or a country the UK approves' : t.status === 'safeguarded' ? `Yes, protected by ${t.mechanism}` : t.status === 'unknown' ? 'Not known yet' : 'Yes, without the UK protections',
    headline: tStatus === 'bad' ? 'Sends data abroad without the UK protections' : null,
    detail: (f.TransferDestination ? `Held in: ${f.TransferDestination}. ` : '') + (t.detail || t.label || ''),
    ask: t.status === 'unknown' ? 'transfer' : null,
    fixType: tStatus === 'bad' || tStatus === 'warn' ? 'dpa_breach' : null,
    action: tStatus === 'unknown' ? { label: 'Answer: where is the data held?', go: 'ask', key: 'transfer' } : tStatus !== 'ok' ? { label: 'Ask them which UK transfer tool they use', go: 'paperwork' } : null,
  });

  // A data agreement the vendor refused is a stop
  if (lc(f.DPAStatus || f.AgreementStatus) === 'refused') {
    risks.push({ key: 'refused', title: 'Refuses to sign a data agreement', status: 'bad', stop: true,
      answer: 'They will not sign one', headline: 'Refuses to sign a data agreement', fixType: 'dpa_breach',
      detail: 'Sharing customer data with a processor that refuses the UK GDPR Article 28 terms is a serious aggravating factor in ICO decisions. Move to another platform.',
      action: { label: 'Plan a move to another platform', go: 'paperwork' } });
  }

  const enf = enforcementOf(f);
  if (enf) risks.push(enf);

  const paperwork = platformPaperwork(f);
  return finish('platform', f, risks, paperwork, ctx.profile, { category });
}

function enforcementOf(f) {
  const enf = safeJSON(f.EnforcementRelevanceJson, null);
  const n = (enf?.relevant || []).length;
  if (!n && !f.BrandSafetyFlag) return null;
  return { key: 'record', title: 'Their own track record', status: 'warn', answer: n ? `${n} regulator action${n !== 1 ? 's' : ''} found` : 'Flagged',
    detail: f.BrandSafetyReason || 'Found in the enforcement sources we check. Make sure it is the same company before acting.' };
}

function privacyDone(f) {
  const p = safeJSON(f.PrivacyReviewResults, {});
  const v = Object.values(p);
  return { reviewed: v.length > 0, gaps: v.filter(x => x === 'no').length };
}

function platformPaperwork(f) {
  const status = f.DPAStatus || f.AgreementStatus || 'Not yet';
  const ok = agreed(status);
  const clauses = safeJSON(f.DPAClauseResults, {});
  const scanned = Object.keys(clauses).length > 0;
  const fails = Object.values(clauses).filter(c => c && c.status === 'fail').length;
  const pv = privacyDone(f);
  const items = [
    { key: 'agreement', label: 'Data processing agreement', status: ok ? (fails ? 'warn' : 'ok') : 'bad',
      answer: ok ? (scanned ? (fails ? `In place, ${fails} clause${fails !== 1 ? 's' : ''} missing` : 'In place and checked') : 'In place') : (status === 'Requested' ? 'Requested, not signed yet' : 'Not on file') },
    { key: 'privacy', label: 'Their privacy policy', status: pv.reviewed ? (pv.gaps ? 'warn' : 'ok') : 'unknown',
      answer: pv.reviewed ? (pv.gaps ? `${pv.gaps} gap${pv.gaps !== 1 ? 's' : ''}` : 'Reviewed') : 'Not reviewed' },
  ];
  return {
    ok: ok && !fails, items,
    risks: ok ? [] : [{ key: 'agreement', status: 'bad', fixType: 'dpa_breach' }],
    action: !ok ? { label: 'Get their data agreement on file', go: 'paperwork' } : fails ? { label: 'Check the missing clauses', go: 'paperwork' } : null,
  };
}

// ── Lead and data partners ────────────────────────────────────
const AD_ACTIVITIES = ['joint_ads', 'co_branded_content', 'influencer'];
const PRICING_ACTIVITIES = ['joint_ads', 'co_branded_content', 'lead_generation'];

export function assessPartner(f, ctx = {}) {
  const name = f.PartnerName || 'This partner';
  const act = f.RelationshipActivity || '';
  const rel = f.DataRelationship || 'unknown';
  const perf = ctx.performance || null;
  const bringsContacts = !!perf || ['lead_generation', 'data_sharing'].includes(act);
  const risks = [];

  if (rel !== 'none' || bringsContacts) {
    const c = safeJSON(f.ConsentCheckResultJson, null);
    const r = c?.result;
    const fail = r === 'fail';
    risks.push({
      key: 'consent', title: 'Does their consent cover you?',
      status: r === 'pass' ? 'ok' : r === 'warn' ? 'warn' : fail ? 'bad' : 'unknown',
      stop: fail && bringsContacts,
      answer: r === 'pass' ? 'Yes, it names you' : r === 'warn' ? 'Names you, wording unclear' : fail ? 'No, it does not name you' : 'Not checked yet',
      headline: fail ? `Their sign-up wording does not name you` : r ? null : `Not known if their consent covers you`,
      detail: (c?.reasons || []).join(' ') + (fail
        ? ` Stop emailing contacts from ${name} until they collect consent that names you. The ICO fined two Saga companies £150k and £75k (2021) for marketing on partner consent that did not name them.`
        : r ? '' : ` Consent collected by ${name} only counts for your marketing if it named you when people signed up.`),
      fixType: r === 'pass' ? null : (perf && perf.redPct >= 40 ? 'third_party_list' : 'lead_gen_consent_gap'),
      action: r === 'pass' ? null : { label: fail ? `Stop emailing contacts from ${name}` : 'Check their sign-up wording', go: 'consent' },
    });
  }

  const pr = performanceRisk(perf, name);
  if (pr) risks.push(pr);

  if (AD_ACTIVITIES.includes(act)) {
    const res = safeJSON(f.AdReviewResult, null);
    const issues = (res?.issues || []).length;
    risks.push({ key: 'ads', title: 'Joint ads checked?', status: !f.AdComplianceReviewed ? 'unknown' : issues ? 'warn' : 'ok',
      answer: !f.AdComplianceReviewed ? 'Not checked yet' : issues ? `${issues} issue${issues !== 1 ? 's' : ''} found` : 'Checked, no issues',
      detail: 'You are both responsible for claims in joint ads (CAP Code). An upheld ASA ruling names both brands.',
      fixType: 'unreviewed_joint_ads', action: f.AdComplianceReviewed && !issues ? null : { label: 'Check the joint ad copy', go: 'consent' } });
  }
  if (PRICING_ACTIVITIES.includes(act) && act !== 'lead_generation') {
    risks.push({ key: 'pricing', title: 'Prices and offers checked?', status: f.PricingComplianceReviewed ? 'ok' : 'unknown',
      answer: f.PricingComplianceReviewed ? 'Checked' : 'Not checked yet',
      detail: 'Fake urgency, drip pricing and false "was" prices are banned outright under the DMCCA 2024. The CMA can fine directly.',
      fixType: 'partner_pricing_claims' });
  }
  const enf = enforcementOf(f);
  if (enf) risks.push(enf);

  const paperwork = partnerPaperwork(f, rel);
  return finish('partner', f, risks, paperwork, ctx.profile, { performance: perf });
}

function partnerPaperwork(f, rel) {
  const pv = privacyDone(f);
  let agreement;
  if (rel === 'none') agreement = { status: 'ok', answer: 'Not needed: no personal data shared' };
  else if (rel === 'unknown') agreement = { status: 'unknown', answer: 'Tell us how data is shared' };
  else {
    const field = rel === 'joint_controller' ? 'Article26Status' : 'DataAgreementStatus';
    const what = rel === 'joint_controller' ? 'Joint controller arrangement' : rel === 'processor' ? 'Data processing agreement' : 'Data sharing agreement';
    const ok = agreed(f[field]);
    agreement = { status: ok ? 'ok' : 'bad', answer: ok ? `${what} in place` : `${what} not on file`, fixType: rel === 'joint_controller' ? 'no_article26_agreement' : rel === 'processor' ? 'dpa_breach' : 'partner_no_data_sharing_agreement' };
  }
  const items = [
    { key: 'agreement', label: 'Data agreement', status: agreement.status, answer: agreement.answer },
    { key: 'privacy', label: 'Their privacy policy', status: pv.reviewed ? (pv.gaps ? 'warn' : 'ok') : 'unknown', answer: pv.reviewed ? (pv.gaps ? `${pv.gaps} gap${pv.gaps !== 1 ? 's' : ''}` : 'Reviewed') : 'Not reviewed' },
  ];
  const ok = agreement.status === 'ok';
  return { ok, items,
    risks: agreement.fixType && !ok ? [{ key: 'agreement', status: 'bad', fixType: agreement.fixType }] : [],
    action: ok ? null : { label: rel === 'unknown' ? 'Tell us how data is shared with them' : 'Get the data agreement on file', go: 'paperwork' } };
}

// ── Affiliates and influencers ────────────────────────────────
export function affiliateNeeds(f) {
  const role = f.AffiliateDataRole || 'unknown';
  const act = lc(f.RelationshipActivity || f.AffiliateType);
  return {
    role,
    posts: /influencer|social|publisher|review|voucher|cashback|comparison/.test(act) || /influencer|social/.test(lc(f.AffiliateType)),
    consent: ['own_list', 'lead_capture'].includes(role) || (role === 'unknown' && /email|lead/.test(act)),
    sender: ['own_list', 'our_list'].includes(role) || (role === 'unknown' && act.includes('email')),
    landing: role === 'lead_capture' || /lead|comparison|cashback/.test(act),
    agreement: role === 'our_list' ? 'Data processing agreement' : (role === 'own_list' || role === 'lead_capture') ? 'Marketing agreement' : role === 'no_mailing' ? null : 'unknown',
  };
}

export function assessAffiliate(f, ctx = {}) {
  const name = f.AffiliateName || 'This affiliate';
  const q = affiliateNeeds(f);
  const urls = safeJSON(f.VerificationUrls, {});
  const live = urls.liveCheck || null;
  const perf = ctx.performance || null;
  const risks = [];

  // Live posts and pages: ad label and claims, re-checked monthly
  if (q.posts || (urls.livePages || []).length) {
    const pages = live?.pages || [];
    const read = pages.filter(p => p.read);
    const unlabelled = read.filter(p => !p.adLabel);
    const missesInRow = live?.missesInRow || 0;
    risks.push({
      key: 'adLabel', title: 'Are their posts labelled as ads?',
      status: !read.length ? 'unknown' : unlabelled.length ? 'bad' : 'ok',
      stop: unlabelled.length > 0 && missesInRow >= 2,
      answer: !read.length ? ((urls.livePages || []).length ? 'Could not read the pages yet' : 'No posts added yet')
        : unlabelled.length ? `${unlabelled.length} of ${read.length} with no ad label` : `All ${read.length} labelled`,
      headline: unlabelled.length ? `Posts about you are not labelled as ads` : null,
      detail: (unlabelled.length ? `No "#ad", "Ad" or "Advertisement" label found on: ${unlabelled.map(p => p.url).slice(0, 3).join(', ')}. ` : '')
        + 'Paid posts must be obviously identifiable as ads (CAP Code 2.1). The ASA names the brand as well as the influencer.'
        + (missesInRow >= 2 && unlabelled.length ? ` Still unlabelled after ${missesInRow} monthly checks: pause payments until it is fixed.` : '')
        + (live?.checkedAt ? ` Last checked ${live.checkedAt}; we re-check every month.` : ''),
      fixType: 'affiliate_ad_disclosure',
      action: !(urls.livePages || []).length ? { label: 'Add links to their posts about you', go: 'live' } : unlabelled.length ? { label: `Ask ${name} to add "#ad"`, go: 'live' } : null,
    });
    const claims = [...new Set(read.flatMap(p => p.claims || []))];
    const creative = safeJSON(f.CreativeReviewResult, null);
    const cIssues = (creative?.issues || []).length;
    risks.push({
      key: 'claims', title: 'Claims they make about you',
      status: !read.length && !f.MarketingMaterialsReviewed ? 'unknown' : (claims.length || cIssues) ? 'warn' : 'ok',
      answer: claims.length ? `${claims.length} claim${claims.length !== 1 ? 's' : ''} to back up` : cIssues ? `${cIssues} issue${cIssues !== 1 ? 's' : ''} in their copy` : (!read.length && !f.MarketingMaterialsReviewed ? 'Not checked yet' : 'Nothing risky found'),
      detail: (claims.length ? 'Found: ' + claims.slice(0, 5).map(c => `"${c}"`).join(', ') + '. ' : '') + 'You must be able to prove any claim an affiliate makes on your behalf.',
      fixType: 'affiliate_misleading_claims',
      action: claims.length || cIssues ? { label: 'Check you can prove their claims', go: 'live' } : null,
    });
  }

  if (q.consent) {
    const c = safeJSON(f.ConsentCheckResultJson, null);
    const r = c?.result;
    const fail = r === 'fail';
    risks.push({
      key: 'consent', title: 'Does their consent cover you?',
      status: r === 'pass' ? 'ok' : r === 'warn' ? 'warn' : fail ? 'bad' : 'unknown',
      stop: fail,
      answer: r === 'pass' ? 'Yes, it names you' : r === 'warn' ? 'Names you, wording unclear' : fail ? 'No, it does not name you' : 'Not checked yet',
      headline: fail ? 'Their sign-up wording does not name you' : r ? null : 'Not known if their consent covers you',
      detail: fail ? `Stop ${name} sending about you until their sign-up wording names you. The ICO fined two Saga companies £150k and £75k (2021) for this.` : 'Consent an affiliate collects only covers your marketing if it named you.',
      fixType: r === 'pass' ? null : 'affiliate_consent_unverified',
      action: r === 'pass' ? null : { label: fail ? `Stop ${name} emailing about you` : 'Check their sign-up wording', go: 'checks' },
    });
  }
  if (q.sender) {
    const s = f.SenderIdentityCompliant || 'Unverified';
    risks.push({ key: 'sender', title: 'Is it clear the email is about you?', status: s === 'Verified' || s === 'N/A' ? 'ok' : s === 'Partial' ? 'warn' : 'unknown',
      answer: s === 'Verified' ? 'Yes' : s === 'Partial' ? 'Partly' : 'Not checked yet',
      detail: 'PECR Reg 23: the sender of marketing emails must not be disguised.',
      fixType: s === 'Verified' || s === 'N/A' ? null : 'affiliate_sender_identity_breach',
      action: s === 'Verified' || s === 'N/A' ? null : { label: 'Check the From name they use', go: 'checks' } });
  }
  if (q.landing) {
    risks.push({ key: 'landing', title: 'Their sign-up page', status: f.LandingPageReviewed ? 'ok' : 'unknown',
      answer: f.LandingPageReviewed ? 'Checked' : 'Not checked yet',
      detail: 'An unticked box that names you, kept separate from their terms.',
      fixType: f.LandingPageReviewed ? null : 'lead_gen_consent_gap',
      action: f.LandingPageReviewed ? null : { label: 'Check their sign-up page', go: 'checks' } });
  }
  if (q.role === 'unknown') {
    risks.push({ key: 'role', title: 'What they do with data', status: 'unknown', answer: 'Not recorded',
      detail: 'Tells us which checks apply: do they email their own list about you, email your list, collect sign-ups for you, or just post?',
      action: { label: 'Tell us what they do', go: 'checks' } });
  }
  const pr = performanceRisk(perf, name);
  if (pr) risks.push(pr);
  const enf = enforcementOf(f);
  if (enf) risks.push(enf);

  const pv = privacyDone(f);
  const agreementOk = !q.agreement || (q.agreement !== 'unknown' && agreed(f.DPAStatus));
  const paperwork = {
    ok: agreementOk,
    items: [
      { key: 'agreement', label: q.agreement && q.agreement !== 'unknown' ? q.agreement : 'Agreement', status: !q.agreement ? 'ok' : q.agreement === 'unknown' ? 'unknown' : agreed(f.DPAStatus) ? 'ok' : 'bad',
        answer: !q.agreement ? 'Not needed: they do not handle your data' : q.agreement === 'unknown' ? 'Depends on what they do with data' : agreed(f.DPAStatus) ? 'In place' : 'Not on file' },
      { key: 'privacy', label: 'Their privacy policy', status: pv.reviewed ? (pv.gaps ? 'warn' : 'ok') : 'unknown', answer: pv.reviewed ? (pv.gaps ? `${pv.gaps} gap${pv.gaps !== 1 ? 's' : ''}` : 'Reviewed') : 'Not reviewed' },
    ],
    risks: [],
    action: agreementOk ? null : { label: 'Get the agreement on file', go: 'paperwork' },
  };
  return finish('affiliate', f, risks, paperwork, ctx.profile, { performance: perf, livePages: urls.livePages || [], liveCheck: live });
}

// ── Live page check: ad labels and claims ─────────────────────
const AD_LABEL = /(#ad\b|#advert(isement)?\b|#sponsored\b|#gifted\b|\bad\s*[|:]|\[ad\]|\(ad\)|\bpaid partnership\b|\badvertisement\b|\badvertising feature\b|\bsponsored (post|content|by)\b|\baffiliate link)/i;
const CLAIMS = [
  /\b(the )?best\b[^.!?\n]{0,40}/i, /#1\b[^.!?\n]{0,30}/i, /\bnumber one\b[^.!?\n]{0,30}/i, /\bcheapest\b[^.!?\n]{0,30}/i,
  /\blowest price[s]?\b[^.!?\n]{0,20}/i, /\bguarantee[d]?\b[^.!?\n]{0,30}/i, /\bclinically\b[^.!?\n]{0,30}/i, /\bproven\b[^.!?\n]{0,30}/i,
  /\bcure[sd]?\b[^.!?\n]{0,30}/i, /\brisk[\s-]free\b/i, /\bsave up to\b[^.!?\n]{0,20}/i, /\b\d{2,3}% off\b[^.!?\n]{0,20}/i,
  /\b(today only|ends (tonight|today|soon)|last chance|limited time)\b/i,
];
export function checkPostText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const label = t.match(AD_LABEL);
  const claims = [];
  for (const re of CLAIMS) {
    const m = t.match(re);
    if (m) claims.push(m[0].trim().slice(0, 60));
  }
  const uniq = [...new Set(claims)].filter((c, i, a) => !a.some((o, j) => j !== i && o.length > c.length && o.toLowerCase().includes(c.toLowerCase())));
  return { adLabel: !!label, labelText: label ? label[0] : null, claims: uniq.slice(0, 6) };
}

export { DATA_BY_CATEGORY, VERDICT };
