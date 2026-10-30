// ─────────────────────────────────────────────────────────────
// SENDWIZE — _cases.js v1.1
// v1.1: twins only when close (TWIN_MIN, audience within 100x, no
// low-severity findings), so distant cases don't alarm anyone.
// Case Twin: each open finding is set beside the real published case
// it most resembles, so a member sees who was caught doing the same
// thing, what it cost them, and how far they are from clear.
//
// Library = the verified case library (_case-library.js, via
// CASE_ANCHORS) plus the rulings the daily regulator feed writes to
// Sector_Intelligence_Feed, so the twins sharpen as rulings land.
//
// Matching is deterministic: same issue type, same sector, similar
// audience size, how recent. The match strength is shown with its
// reasons, never as a prediction.
//
// Also holds the effort estimates per finding type, used for "Quick
// wins" and ranking "Start here" by value for time.
// ─────────────────────────────────────────────────────────────
import { CASE_ANCHORS, ICO_ACTION_URL, areaOf } from './_exposure.js';
import { caseOutcome, sameIssueTypes, subjectsOf, channelsOf, subjectFit } from './_case-library.js';

// Feed claim types (regulatory-feed-update.js) → the finding types they match
export const CLAIM_TO_FIX = {
  fake_urgency:      ['fake_urgency'],
  misleading_claim:  ['misleading_claim', 'asa_liability', 'affiliate_misleading_claims', 'unreviewed_joint_ads'],
  fake_reviews:      ['misleading_claim', 'fake_reviews'],
  health_claim:      ['misleading_claim', 'asa_liability'],
  reference_pricing: ['misleading_reference_price', 'partner_pricing_claims'],
  drip_pricing:      ['misleading_reference_price', 'partner_pricing_claims', 'drip_pricing'],
  undisclosed_ad:    ['undisclosed_ad', 'affiliate_ad_disclosure'],
  consent_missing:   ['consent_missing', 'consent_expired', 'invalid_consent_mechanism', 'third_party_list', 'lead_gen_consent_gap', 'affiliate_consent_unverified'],
  suppression_breach:['suppression_breach'],
  legitimate_interest_abuse: ['legitimate_interest_abuse'],
  data_breach:       ['dpa_breach', 'data_quality', 'no_article26_agreement', 'partner_no_data_sharing_agreement'],
};

// Rough time to fix, for a typical SME marketing team. Estimates only.
// dev: usually needs a developer or a contract change.
export const EFFORT = {
  undisclosed_ad:                { mins: 10,  label: '10 minutes' },
  affiliate_ad_disclosure:       { mins: 15,  label: '15 minutes' },
  fake_urgency:                  { mins: 15,  label: '15 minutes' },
  misleading_claim:              { mins: 30,  label: '30 minutes' },
  misleading_reference_price:    { mins: 30,  label: '30 minutes' },
  partner_pricing_claims:        { mins: 30,  label: '30 minutes' },
  unreviewed_joint_ads:          { mins: 30,  label: '30 minutes' },
  asa_liability:                 { mins: 30,  label: '30 minutes' },
  consent_expired:               { mins: 60,  label: 'About an hour' },
  suppression_breach:            { mins: 60,  label: 'About an hour' },
  data_quality:                  { mins: 60,  label: 'About an hour' },
  affiliate_misleading_claims:   { mins: 60,  label: 'About an hour' },
  partner_brand_risk:            { mins: 60,  label: 'About an hour' },
  sector_risk_unreviewed:        { mins: 60,  label: 'About an hour' },
  dpa_breach:                    { mins: 120, label: 'A couple of hours' },
  third_party_list:              { mins: 120, label: 'A couple of hours' },
  affiliate_sender_identity_breach: { mins: 120, label: 'A couple of hours' },
  consent_missing:               { mins: 240, label: 'Half a day', dev: true },
  invalid_consent_mechanism:     { mins: 240, label: 'Half a day', dev: true },
  legitimate_interest_abuse:     { mins: 240, label: 'Half a day' },
  affiliate_consent_unverified:  { mins: 240, label: 'Half a day' },
  partner_no_data_sharing_agreement: { mins: 240, label: 'Half a day', dev: true },
  no_article26_agreement:        { mins: 240, label: 'Half a day', dev: true },
  lead_gen_consent_gap:          { mins: 480, label: 'A day or more', dev: true },
};
export function effortFor(fixType) {
  const e = EFFORT[fixType] || { mins: 60, label: 'About an hour' };
  return { ...e, quick: e.mins <= 30 };
}

// Same vocabulary as the profile and the feed (ecommerce, finance, health…)
const SECTOR_ALIASES = { retail: 'ecommerce', healthcare: 'health' };
export function sectorKey(s) {
  const k = String(s || '').trim().toLowerCase();
  return !k || k === 'general' || k === 'other' ? null : (SECTOR_ALIASES[k] || k);
}

const yearOf = d => { const m = String(d || '').match(/(\d{4})(?:-(\d{2}))?/); return m ? Number(m[1]) + ((Number(m[2]) || 6) - 1) / 12 : null; };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
function parseList(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

export const OFFICIAL_URL = /^https:\/\/(www\.)?(ico\.org\.uk|asa\.org\.uk|gov\.uk)\//;

// One shape for every case, curated or from the feed
export function buildLibrary(feedRecords = []) {
  const lib = CASE_ANCHORS.map(c => ({
    id: c.id, name: c.name, regulator: c.regulator, date: c.date, penalty: c.penalty || null,
    refunds: c.refunds || null, outcome: caseOutcome(c),
    volume: c.volume || null, summary: c.summary, types: c.types, sector: c.sector ?? null,
    url: c.url || (c.imported ? null : ICO_ACTION_URL), source: c.imported ? 'imported' : 'curated',
    subjects: c.subjects, channels: c.channels, curated: !!c.curated,
  }));
  const seen = new Set(lib.map(c => slug(c.name).split('_')[0]));
  for (const r of feedRecords) {
    const f = r.fields || {};
    const name = String(f.CompanyName || '').trim();
    if (!name || f.RelevantToSendwize === false) continue;
    const types = [...new Set(parseList(f.ClaimTypes).flatMap(t => CLAIM_TO_FIX[t] || []))];
    if (!types.length) continue;
    // Only rulings the regulator itself published, so nothing unverifiable is matched
    if (!OFFICIAL_URL.test(f.RulingUrl || '')) continue;
    const key = slug(name).split('_')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    lib.push({
      id: 'feed_' + r.id, name, regulator: f.Regulator || '', date: f.PublishedDate || '',
      penalty: Number(f.FineAmount) > 0 ? Number(f.FineAmount) : null, volume: null,
      outcome: caseOutcome({ penalty: Number(f.FineAmount) > 0 ? Number(f.FineAmount) : null, regulator: f.Regulator || '' }),
      summary: String(f.RulingSummary || '').slice(0, 300), types,
      sector: sectorKey(f.Sector),
      url: f.RulingUrl, source: 'feed', subjects: subjectsOf(f.RulingSummary),
    });
  }
  return lib;
}

// A twin is only shown when it is genuinely close: the same issue plus the
// same sector or an audience within 10x. A case 100x the member's size is
// never a twin, so a small list isn't set beside a 79M-email fine.
export const TWIN_MIN = 75;

// Match strength 0-98 with the reasons behind it
export function matchCase(fix, c, ctx = {}) {
  if (!c.types.some(t => sameIssueTypes(fix.fixType).includes(t))) return null;
  // Same subject too: a green-claim finding is never twinned with a health-claim case
  const subjects = subjectsOf(fix.description);
  if (c.subjects && !subjectFit(c, subjects, fix.fixType)) return null;
  const v = Number(fix.contactVolume) || Number(ctx.listSize) || null;
  const gap = v && c.volume ? Math.abs(Math.log10(c.volume) - Math.log10(v)) : null;
  if (gap != null && gap > 2) return null;
  const reasons = ['Same issue: ' + niceType(fix.fixType)];
  let score = c.source === 'curated' ? 55 : 48;
  if (c.sector && c.sector === sectorKey(ctx.sector)) { score += 15; reasons.push('Same sector'); }
  const shared = (c.subjects || []).filter(s => subjects.includes(s));
  if (shared.length) { score += 15; reasons.push('Same subject: ' + shared.join(', ')); }
  const channels = channelsOf(fix.description);
  if (channels.length && (c.channels || []).some(ch => channels.includes(ch))) { score += 5; reasons.push('Same channel'); }
  if (gap != null && gap <= 1) { score += 15; reasons.push('Similar audience size'); }
  const y = yearOf(c.date), now = ctx.now ? yearOf(ctx.now) : new Date().getFullYear() + new Date().getMonth() / 12;
  if (y && now - y <= 2) { score += 10; reasons.push('Recent ruling'); }
  if (c.penalty) score += 5;
  return { score: Math.min(98, score), reasons };
}

const niceType = t => { const s = String(t || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

// How many match points a fined case may trail by and still be chosen
const FINE_PREFERENCE = 5;

// Twin for every open finding, plus the account's headline twin
export function caseTwins(pending, completed, library, ctx = {}) {
  const byFix = {}, used = {};
  for (const f of pending) {
    if (f.severity === 'low') continue;
    const hits = [];
    for (const c of library) {
      const m = matchCase(f, c, ctx);
      if (m && m.score >= TWIN_MIN) hits.push({ c, match: m.score, reasons: m.reasons });
    }
    if (!hits.length) continue;
    // Strongest match; a case with a published fine wins if it matches about as well,
    // so the twin shows a real figure wherever one exists
    const top = Math.max(...hits.map(h => h.match));
    const near = hits.filter(h => h.match >= top - FINE_PREFERENCE);
    const best = near.filter(h => h.c.penalty).sort((a, b) => b.match - a.match || b.c.penalty - a.c.penalty)[0]
      || near.sort((a, b) => b.match - a.match)[0];
    byFix[f.id] = { caseId: best.c.id, match: best.match, reasons: best.reasons };
    used[best.c.id] = best.c;
  }
  // Headline: strongest match, then biggest penalty
  let hero = null;
  for (const [fixId, t] of Object.entries(byFix)) {
    const c = used[t.caseId];
    if (!hero || t.match > hero.match || (t.match === hero.match && (c.penalty || 0) > (used[hero.caseId].penalty || 0))) hero = { ...t, fixId };
  }
  if (hero) {
    const c = used[hero.caseId];
    const related = f => c.types.some(t => sameIssueTypes(f.fixType).includes(t));
    const open = pending.filter(related), done = completed.filter(related);
    hero.openFixIds = open.map(f => f.id);
    hero.doneFixIds = done.map(f => f.id);
    hero.area = areaOf(pending.find(f => f.id === hero.fixId)?.fixType);
  }
  return { hero, byFix, cases: used, librarySize: library.length };
}
