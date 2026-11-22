// ─────────────────────────────────────────────────────────────
// SENDWIZE — _claims-bank.js v1.0
// The pieces of Claims Bank that don't touch Airtable, so they can be
// tested on their own (scripts/check-claims-bank.mjs).
//
// Claims Bank keeps every claim a member makes in their marketing (the
// actual wording, not a category). Each morning new ASA, ICO and CMA
// decisions from the regulator feed are matched to the specific claims
// that look similar, and the member records what they did about it:
// taken down, changed (with the new wording) or kept (with the evidence
// they hold). Every answer is dated and named, so the bank doubles as a
// record that the business acted.
//
//   extractClaims   — the claims in a piece of copy (moved here from
//                     submit-check.js so the Copy Checker can use it too)
//   claimIssues     — the specific issues (_copy-issues.js) a claim is about
//   rulingIssues    — the issues a new regulator decision is about
//   shortlist       — live claims that share an issue with a decision and
//                     haven't already been matched to it
//   matchPrompt / MATCH_SCHEMA — the AI's check that a shortlisted claim
//                     really looks like the decision (not just the topic)
//   alertFor        — the alert stored on a claim
//   applyResponse   — taken down / changed / kept, with who and when
//
// Wording: Sendwize gives information, not legal advice. An alert says a
// decision "looks similar" to a claim. It never says the claim breaks a
// rule or "breached" a ruling.
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { claudeFetch, LEGAL_RULES } from './_claude.js';
import { ISSUES, caseIssues } from './_copy-issues.js';

// Issues a claim in an ad or email can be about. Consent, sender and
// privacy issues are about how people were contacted, not what was said,
// so they never come into Claims Bank.
export const CLAIM_ISSUES = new Set([
  'fake_urgency', 'scarcity', 'reference_price', 'drip_pricing', 'hidden_conditions', 'free_claim',
  'superlative_claim', 'comparative_claim', 'performance_claim', 'green_claim', 'health_claim',
  'medicinal_claim', 'review_claim', 'incentivised_review', 'hidden_ad', 'credential_claim',
  'prize_promotion', 'subscription_terms', 'financial_promotion', 'restricted_product',
]);

export const STATUSES = ['live', 'changed', 'taken_down', 'retired'];
export const ACTIONS = {
  taken_down: 'Taken down',
  changed: 'Changed the wording',
  kept: 'Kept it, evidence on file',
};
export const SOURCES = ['Copy checker', 'Campaign defence', 'Added by hand'];
export const MAX_CLAIM_CHARS = 400;
export const MAX_CLAIMS_PER_ADD = 25;

const CLAIM_TYPES = ['pricing_claim', 'urgency_claim', 'scarcity_claim', 'free_claim', 'health_claim', 'comparative_claim', 'testimonial_claim', 'guarantee_claim', 'third_party_reference', 'environmental_claim', 'other'];

// Claim type (from extractClaims) → issues it is always about
const TYPE_ISSUES = {
  urgency_claim: ['fake_urgency'],
  scarcity_claim: ['scarcity'],
  free_claim: ['free_claim'],
  health_claim: ['health_claim', 'medicinal_claim'],
  comparative_claim: ['comparative_claim', 'superlative_claim'],
  testimonial_claim: ['review_claim'],
  guarantee_claim: ['performance_claim'],
  third_party_reference: ['credential_claim'],
  environmental_claim: ['green_claim'],
};

// Regulator feed claimTypes (regulatory-feed-update.js) → issues. The
// feed's "misleading_claim" covers almost everything, so it adds nothing
// here: the decision's own summary decides.
const FEED_ISSUES = {
  fake_urgency: ['fake_urgency', 'scarcity'],
  reference_pricing: ['reference_price'],
  drip_pricing: ['drip_pricing'],
  fake_reviews: ['review_claim', 'incentivised_review'],
  health_claim: ['health_claim', 'medicinal_claim'],
  undisclosed_ad: ['hidden_ad'],
};

const onlyClaimIssues = ids => [...new Set(ids)].filter(id => CLAIM_ISSUES.has(id));

export function cleanText(s, max = MAX_CLAIM_CHARS) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Same member + same wording (ignoring case, spacing and punctuation) → same key
export function claimKey(userId, text) {
  const norm = cleanText(text).toLowerCase().replace(/[^\p{L}\p{N}%£$€]+/gu, ' ').trim();
  return crypto.createHash('sha256').update(`${userId}|${norm}`).digest('hex').slice(0, 24);
}

export function claimIssues({ text = '', claimType = '' } = {}) {
  const fromType = TYPE_ISSUES[claimType] || [];
  const fromText = caseIssues({ summary: text, regulator: 'ASA' });
  let ids = onlyClaimIssues([...fromType, ...fromText]);
  if (!ids.length && claimType === 'pricing_claim') ids = ['reference_price', 'drip_pricing'];
  return ids;
}

export function rulingIssues(item = {}) {
  const regulator = String(item.regulator || '').toUpperCase();
  const text = `${item.rulingSummary || ''} ${item.actionableNote || ''}`;
  const fromText = caseIssues({ summary: text, regulator });
  const types = Array.isArray(item.claimTypes) ? item.claimTypes : [];
  return onlyClaimIssues([...fromText, ...types.flatMap(t => FEED_ISSUES[t] || [])]);
}

// A Sector_Intelligence_Feed record → the decision fields this module uses
export function rulingFromFeed(rec) {
  const f = rec?.fields || {};
  let claimTypes = [];
  try { claimTypes = JSON.parse(f.ClaimTypes || '[]'); } catch {}
  return {
    id: rec?.id || '',
    regulator: f.Regulator || '',
    company: f.CompanyName || '',
    date: f.PublishedDate || '',
    rulingSummary: f.RulingSummary || '',
    actionableNote: f.ActionableForUsers || '',
    url: f.RulingUrl || '',
    claimTypes: Array.isArray(claimTypes) ? claimTypes : [],
  };
}

export function parseJsonField(v, fallback) {
  if (v == null || v === '') return fallback;
  try { const x = JSON.parse(v); return x ?? fallback; } catch { return fallback; }
}

// A Claims_Bank record → what the page and the matcher use
export function claimFromRecord(rec) {
  const f = rec?.fields || {};
  return {
    id: rec?.id || '',
    userId: f.UserID || '',
    text: f.ClaimText || '',
    key: f.ClaimKey || '',
    claimType: f.ClaimType || '',
    issues: parseJsonField(f.Issues, []),
    campaign: f.Campaign || '',
    channel: f.Channel || '',
    source: f.Source || '',
    sourceRecordId: f.SourceRecordId || '',
    status: STATUSES.includes(f.Status) ? f.Status : 'live',
    addedAt: f.AddedAt || '',
    updatedAt: f.UpdatedAt || '',
    alerts: parseJsonField(f.AlertsJson, []),
    history: parseJsonField(f.HistoryJson, []),
    evidence: f.Evidence || '',
  };
}

// Live claims that share an issue with the decision and haven't already
// been matched to it. Capped so one prompt stays small.
export function shortlist(ruling, claims, { max = 40 } = {}) {
  const want = new Set(rulingIssues(ruling));
  if (!want.size) return [];
  return claims
    .filter(c => c.status === 'live' && c.text)
    .filter(c => !(c.alerts || []).some(a => a.rulingId === ruling.id))
    .filter(c => (c.issues || []).some(i => want.has(i)))
    .slice(0, max);
}

export const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, why: { type: 'string' } },
        required: ['n', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

export function matchPrompt(ruling, candidates) {
  const system = `${LEGAL_RULES}

You help UK marketers keep track of the claims they make. You are given one newly published regulator decision about another company, and a numbered list of marketing claims that different businesses have saved.

Pick only the claims a careful marketer would want to look at again because of this decision: the same kind of wording or the same practice (for example both say "100% recyclable" without qualification, both show a "was" price, both use a countdown). Sharing a topic is not enough: a decision about a misleading "carbon neutral" claim does not make every green claim similar. If none are similar, return an empty list.

For each claim you pick, write "why": one sentence, at most 220 characters, saying what the claim and the decision have in common. Attribute the decision ("The ASA found..." / "The CMA said..."). Never say the saved claim breaks a rule, is misleading or must change. Say what is similar, nothing more.`;
  const issues = rulingIssues(ruling).map(i => ISSUES[i]?.label || i).join(', ');
  const user = `DECISION
Regulator: ${ruling.regulator}
Company: ${ruling.company}
Published: ${ruling.date || 'recently'}
What it was about: ${cleanText(ruling.rulingSummary, 600)}
${ruling.actionableNote ? `Note: ${cleanText(ruling.actionableNote, 300)}\n` : ''}Issues: ${issues || 'not tagged'}

SAVED CLAIMS
${candidates.map((c, i) => `${i + 1}. "${cleanText(c.text)}"`).join('\n')}

Return JSON: {"matches": [{"n": <claim number>, "why": "..."}]}`;
  return { system, user };
}

// Ask the AI which shortlisted claims really look like the decision.
// Returns [{ claim, why }]. Any failure returns [] (no alert beats a wrong one).
export async function matchClaims(ruling, candidates) {
  if (!candidates.length || !process.env.ANTHROPIC_API_KEY) return [];
  const { system, user } = matchPrompt(ruling, candidates);
  try {
    const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ max_tokens: 1200, system, messages: [{ role: 'user', content: user }] }),
    }, { schema: MATCH_SCHEMA });
    if (!r.ok) return [];
    const data = await r.json();
    let out = null;
    try { out = JSON.parse(data.content?.[0]?.text || ''); } catch {}
    return readMatches(out, candidates);
  } catch (e) {
    console.error('Claims Bank match failed (non-fatal):', e.message);
    return [];
  }
}

const BANNED = /\b(illegal|unlawful|in breach|breach(es|ed)?|violat\w*|non-?compliant)\b/i;
export function readMatches(out, candidates) {
  const seen = new Set();
  return (Array.isArray(out?.matches) ? out.matches : [])
    .filter(m => Number.isInteger(m?.n) && m.n >= 1 && m.n <= candidates.length && !seen.has(m.n) && seen.add(m.n))
    .map(m => {
      const why = cleanText(m.why, 260);
      return { claim: candidates[m.n - 1], why: why && !BANNED.test(why) ? why : '' };
    });
}

const REG_VERB = { ASA: 'ruled on', CMA: 'acted on', ICO: 'acted on' };
export function alertFor(ruling, why, now = new Date().toISOString()) {
  const reg = ruling.regulator || 'A regulator';
  return {
    id: `al_${ruling.id || crypto.randomBytes(5).toString('hex')}`,
    rulingId: ruling.id || '',
    regulator: ruling.regulator || '',
    company: ruling.company || '',
    date: ruling.date || '',
    url: /^https?:\/\//i.test(ruling.url || '') ? ruling.url : '',
    summary: cleanText(ruling.rulingSummary, 500),
    title: `Similar to a claim the ${reg} ${REG_VERB[reg] || 'acted on'}${ruling.company ? ` (${cleanText(ruling.company, 80)})` : ''}`,
    why: why || `The ${reg} published a decision about wording like this. Take a look at your claim with it in mind.`,
    foundAt: now,
    status: 'open',
  };
}

export const openAlerts = claim => (claim.alerts || []).filter(a => a.status === 'open');

// Record what the member did. Returns the fields to save, or { error }.
//   action: taken_down | changed | kept
//   changed needs newText; kept needs a note saying what evidence is held.
export function applyResponse(claim, { alertId = '', action, note = '', newText = '', by = '', at = new Date().toISOString() } = {}) {
  if (!ACTIONS[action]) return { error: 'Choose taken down, changed or kept.' };
  const who = cleanText(by, 80);
  if (!who) return { error: 'Add your name, so the record shows who confirmed it.' };
  const cleanNote = cleanText(note, 1000);
  const wording = cleanText(newText);
  if (action === 'changed' && !wording) return { error: 'Add the new wording.' };
  if (action === 'changed' && wording.toLowerCase() === cleanText(claim.text).toLowerCase()) return { error: 'The new wording is the same as the old one.' };
  if (action === 'kept' && !cleanNote) return { error: 'Say what evidence you hold for this claim.' };

  const alerts = (claim.alerts || []).map(a => ({ ...a }));
  const alert = alertId ? alerts.find(a => a.id === alertId) : null;
  if (alertId && !alert) return { error: 'That alert was not found on this claim.' };
  if (alert && alert.status !== 'open') return { error: 'That alert has already been answered.' };

  const answer = { action, label: ACTIONS[action], by: who, at, ...(cleanNote ? { note: cleanNote } : {}) };
  if (alert) Object.assign(alert, { status: 'answered', answer });
  // One answer covers every open alert when the claim is taken down or reworded
  if (action !== 'kept') for (const a of alerts) if (a.status === 'open') Object.assign(a, { status: 'answered', answer: { ...answer, note: answer.note || 'Covered by the answer to another alert.' } });

  const entry = { at, by: who, action, label: ACTIONS[action], ...(alert ? { alertId: alert.id, ruling: alert.title } : {}), ...(cleanNote ? { note: cleanNote } : {}) };
  const out = { alerts, history: [...(claim.history || []), entry], updatedAt: at };
  if (action === 'taken_down') out.status = 'taken_down';
  if (action === 'kept') {
    out.status = 'live';
    out.evidence = [claim.evidence, `${at.slice(0, 10)} ${who}: ${cleanNote}`].filter(Boolean).join('\n').slice(-5000);
  }
  if (action === 'changed') {
    // The claim keeps its history; the new wording is what's watched from now on
    entry.oldText = cleanText(claim.text);
    entry.newText = wording;
    out.status = 'live';
    out.text = wording;
    out.issues = claimIssues({ text: wording, claimType: claim.claimType });
  }
  return out;
}

// A claim the member adds or the Copy Checker / Campaign Defence sends in
export function newClaimFields(userId, c, { source, campaign = '', channel = '', sourceRecordId = '', now = new Date().toISOString() } = {}) {
  const text = cleanText(c.claim ?? c.text);
  if (!text) return null;
  const claimType = CLAIM_TYPES.includes(c.claimType) ? c.claimType : 'other';
  return {
    UserID: userId,
    ClaimText: text,
    ClaimKey: claimKey(userId, text),
    ClaimType: claimType,
    Issues: JSON.stringify(claimIssues({ text, claimType })),
    Campaign: cleanText(campaign, 120),
    Channel: cleanText(channel, 40),
    Source: SOURCES.includes(source) ? source : 'Added by hand',
    SourceRecordId: /^rec[A-Za-z0-9]{14}$/.test(sourceRecordId) ? sourceRecordId : '',
    Status: 'live',
    AddedAt: now,
    UpdatedAt: now,
    AlertsJson: '[]',
    HistoryJson: JSON.stringify([{ at: now, by: source || 'Added by hand', action: 'added', label: `Added from ${source || 'Campaign Defence'}` }]),
  };
}

// ── Claim extraction via Claude (shared with submit-check.js) ──
// The rule a claim is shown under comes from the checked list the copy
// checker uses (_copy-issues.js), not the model, wherever the type is clear
const CLAIM_ISSUE = { urgency_claim: 'fake_urgency', scarcity_claim: 'scarcity', free_claim: 'free_claim', comparative_claim: 'comparative_claim', testimonial_claim: 'review_claim', environmental_claim: 'green_claim' };
export function claimCite(c) {
  let issue = CLAIM_ISSUE[c?.claimType];
  if (c?.claimType === 'pricing_claim') {
    const t = String(c.claim || '');
    issue = /\b(was|rrp|save|saving|half price|reduced)\b|% off/i.test(t) ? 'reference_price' : /\b(fee|surcharge|handling|booking|delivery charge)\b/i.test(t) ? 'drip_pricing' : null;
  }
  return issue ? ISSUES[issue]?.cite || null : null;
}

// Images Claude accepts, as the Copy Checker sends them ({ data, mediaType })
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export function cleanImages(images, max = 3) {
  return (Array.isArray(images) ? images : [])
    .filter(i => i && typeof i.data === 'string' && i.data.length < 7_000_000 && IMAGE_TYPES.includes(i.mediaType))
    .slice(0, max);
}

// copyText and/or screenshots (images: [{ data: base64, mediaType }])
export async function extractClaims(copyText, images = []) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const pics = cleanImages(images);
  if (!anthropicKey || (!copyText?.trim() && !pics.length)) return [];

  try {
    const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        max_tokens: 800,
        messages: [{ role: 'user', content: [...pics.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: `Analyse this marketing copy${pics.length ? ` and the ${pics.length} image${pics.length > 1 ? 's' : ''} above (read every word in them, including small print)` : ''} and extract every specific claim that could have regulatory implications under UK law (ICO/PECR, ASA/CAP Code, CMA/DMCCA 2024).

For each claim, return:
- claim: the exact text or a close paraphrase
- claimType: one of: pricing_claim, urgency_claim, scarcity_claim, free_claim, health_claim, comparative_claim, testimonial_claim, guarantee_claim, third_party_reference, environmental_claim, other
- ruleRef: the specific regulation it engages (e.g. "DMCCA 2024 Schedule 1", "CAP Code 3.1", "PECR Reg 22")
- evidenceNeeded: what evidence would be required to defend this claim
- exposureCategory: one of: ICO, ASA, CMA

Return ONLY a JSON array. No other text. If no claims found, return [].

COPY:
${copyText?.trim() ? copyText.slice(0, 4000) : '(No text: the claims are in the images.)'}` }] }],
      }),
    });

    if (!r.ok) return [];
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]).map(c => ({ ...c, ruleRef: claimCite(c) || c.ruleRef || '' }));
  } catch (e) {
    console.error('extractClaims failed (non-fatal):', e);
    return [];
  }
}
