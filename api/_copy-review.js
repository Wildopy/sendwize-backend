// ─────────────────────────────────────────────────────────────
// SENDWIZE: _copy-review.js  v1.0  (shared by analyze-copy and free-check)
// The parts of a copy check that must not depend on the AI's mood:
//
//   copyFacts()     plain facts read from the copy by code (is there an
//                   unsubscribe, a STOP line, a named sender, a dated or
//                   relative deadline, swearing...). Sent to the AI as
//                   settled, and used again after it answers.
//   reviewFindings() applies the house rules to the AI's findings:
//                   drops findings that contradict the facts, keeps one
//                   finding per single issue, turns relative deadlines,
//                   stock claims and was/now prices into the right kind
//                   of item, and adds the offence and not-marketing checks.
//   copyScore()     the 0-100 score from the final findings, so the same
//                   findings always give the same number.
//   guardRewrite()  makes sure the suggested rewrite adds no fact, price,
//                   date or claim the original didn't make.
//
// v1.0 (10 Nov 2026): first version, from the 25-email test set.
// ─────────────────────────────────────────────────────────────
import { claudeFetch, parseJson } from './_claude.js';
import { ISSUES, ISSUE_IDS } from './_copy-issues.js';

const FREEMAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|btinternet|sky|virginmedia|talktalk|protonmail|proton)\./i;
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const PROFANITY = /\b(fuck\w*|f\*+k\w*|shit\w*|cunts?|wank\w*|bollocks|twats?|bastards?|dickheads?|motherfuck\w*|piss off|arseholes?|assholes?)\b/i;

export function copyFacts(channel, text) {
  const t = String(text || '');
  const from = (t.match(/^\s*From:\s*(.+)$/im) || [])[1] || '';
  const to = (t.match(/^\s*To:\s*(.+)$/im) || [])[1] || '';
  const fromName = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  const smsSender = channel === 'sms' ? ((t.match(/^\s*([A-Z][\w&' .-]{1,30}):/) || [])[1] || '') : '';
  const optOut = channel === 'sms'
    ? /\b(reply|text|txt|send)\s+["'“]?stop\b|\bstop\s+to\s+(opt|end|unsub|stop)|\bopt[- ]?out\b|\bunsubscribe\b/i.test(t)
    : /\bunsubscribe\b|\bopt[- ]?out\b|\bmanage (your )?(email |marketing )?preferences\b|\bstop receiving\b/i.test(t);
  const company = /\b(ltd|limited|plc|llp)\b/i.test(t);
  const postcode = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(t);
  const corporateRecipient = /@[\w.-]+\.[a-z]{2,}/i.test(to) && !FREEMAIL.test(to);
  const datedDeadline = new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b\\d{1,2}/\\d{1,2}(/\\d{2,4})?\\b`, 'i').test(t);
  // "Shop today" is a call to action, not a deadline: only count "today" tied to an end
  const relative = /\b(tonight|2nite|midnight|today only|(ends?|ending|until|till|expires?|valid|by|before|only) (today|tomorrow|tonight|this (weekend|week)|end of (the )?(day|week)|(mon|tues|wednes|thurs|fri|satur|sun)day))\b/i.test(t);
  const countdown = /\b(next|within|in)\s+(the\s+next\s+)?\d+\s*(secs?|seconds?|mins?|minutes?|hrs?|hours?)\b|\b(ends?|ending) soon\b/i.test(t);
  const swear = PROFANITY.exec(t);
  return {
    channel, fromName: fromName || smsSender, optOut,
    senderNamed: !!(fromName || smsSender || company),
    companyName: company, postcode, corporateRecipient,
    deadline: datedDeadline ? 'dated' : relative ? 'relative' : 'none',
    countdown, profanity: swear ? swear[0] : null,
    words: (t.match(/[a-z0-9£%]+/gi) || []).length,
  };
}

export function factsBlock(f) {
  const yn = b => (b ? 'yes' : 'no');
  const lines = ['[FACTS CHECKED BY CODE: treat these as settled. Do not raise a finding that contradicts them.]'];
  if (['email', 'sms', 'directmail'].includes(f.channel)) lines.push(`Opt-out or unsubscribe present: ${yn(f.optOut)}${f.channel === 'sms' ? ' (STOP line)' : ''}`);
  lines.push(`Sender named: ${f.senderNamed ? `yes${f.fromName ? ` ("${f.fromName}")` : ''}` : 'no'}`);
  if (f.channel === 'email' || f.channel === 'directmail') lines.push(`Company name present: ${yn(f.companyName)}. Postal address present: ${yn(f.postcode)}`);
  if (f.corporateRecipient) lines.push('Recipient: a company email address (corporate subscriber). Do not raise consent.');
  lines.push(`Deadline: ${{ dated: 'a specific date is given', relative: 'relative only ("tonight", "midnight", "before Friday"), no date', none: 'none stated' }[f.deadline]}`);
  lines.push(`Countdown in minutes or open-ended urgency ("ends soon"): ${yn(f.countdown)}`);
  if (f.profanity) lines.push(`Contains swearing: yes ("${f.profanity}")`);
  lines.push('[END FACTS]');
  return lines.join('\n');
}

// Best guess at the issue for a finding the AI didn't label (older saved
// checks, or a missing field). Only used when issue_type is absent.
export function guessIssue(v) {
  const s = `${v.issue || ''} ${v.regulation || ''} ${v.recommendation || ''}`.toLowerCase();
  if (/offen[cs]|swear|profan|obscen|harm and offence|cap 4\.1/.test(s)) return 'harm_offence';
  if (/sender|reg\s*23|identif(y|ies) (the )?(sender|business)|postal address|registered address/.test(s)) return /disguis|conceal|hide|hidden/.test(s) ? 'sender_hidden' : 'sender_details';
  if (/unsubscribe|opt.out|\bstop\b/.test(s)) return 'opt_out_missing';
  if (/partners?"|third.party|purchased|bought/.test(s)) return 'third_party_consent';
  if (/consent|soft opt.in|reg\s*22/.test(s)) return 'consent_basis';
  if (/#ad|influencer|identifiable as (an )?ad/.test(s)) return 'hidden_ad';
  if (/countdown|urgency|deadline|midnight|tonight/.test(s)) return 'fake_urgency';
  if (/only \d+ left|scarcity|stock|sell out/.test(s)) return 'scarcity';
  if (/was.*now|reference pric|rrp|saving/.test(s)) return 'reference_price';
  if (/drip|handling fee|hidden fee|total price/.test(s)) return 'drip_pricing';
  if (/\bfree\b/.test(s)) return 'free_claim';
  if (/green|sustainab|eco|carbon|environment/.test(s)) return 'green_claim';
  if (/cure|treat|medicinal/.test(s)) return 'medicinal_claim';
  if (/health claim|nhc|immun/.test(s)) return 'health_claim';
  if (/review|rating|testimonial/.test(s)) return 'review_claim';
  if (/terms|conditions|exclusion|limitation/.test(s)) return 'hidden_conditions';
  return 'other';
}

const SEV = ['low', 'medium', 'high', 'critical'];
const rank = s => SEV.indexOf(String(s || '').toLowerCase());
const evidence = (issue_type, regulation, issue, location, recommendation) =>
  ({ regulation, severity: 'high', issue, location, recommendation, requiresEvidence: true, issue_type });

// Apply the house rules. `context` findings (from the member's own answers
// about the send) always win over the AI's version of the same issue.
export function reviewFindings(aiFindings, facts, { contentKind = 'marketing', contextFindings = [] } = {}) {
  const ch = facts.channel;
  const out = [];
  for (const raw of aiFindings || []) {
    const v = { ...raw, issue_type: ISSUES[raw.issue_type] ? raw.issue_type : guessIssue(raw) };
    const t = v.issue_type, sev = rank(v.severity);

    // A service message (order, delivery, account) isn't marketing: no opt-out or consent rules
    if (contentKind === 'service' && ['opt_out_missing', 'consent_basis', 'third_party_consent'].includes(t)) continue;
    // Facts the code has already settled
    if (t === 'opt_out_missing' && (facts.optOut || ch === 'social' || ch === 'push')) continue;
    if (t === 'sender_details' && (ch === 'social' || ch === 'push' || (ch === 'sms' && facts.senderNamed))) continue;
    if ((t === 'sender_details' || t === 'sender_hidden') && facts.senderNamed && sev <= rank('medium')) continue;
    if (t === 'consent_basis' || t === 'third_party_consent') {
      if (facts.corporateRecipient || ch === 'social') continue;
      // The copy can't show whether someone consented: it's something to hold on file
      if (!v.requiresEvidence && t === 'consent_basis') Object.assign(v, { requiresEvidence: true, severity: 'medium' });
    }
    // Deadlines: a countdown or an open-ended "ends soon" is the real danger;
    // "tonight" with no date needs the date; a dated deadline needs proof it's real
    if ((t === 'fake_urgency' || t === 'deadline_unclear') && !v.requiresEvidence && !facts.countdown) {
      if (facts.deadline === 'relative') Object.assign(v, { issue_type: 'deadline_unclear', severity: sev > rank('medium') ? 'medium' : v.severity });
      else if (facts.deadline === 'dated') Object.assign(v, { requiresEvidence: true, severity: 'high' });
    }
    // Stock and was/now claims are fine when true: ask for the proof
    if ((t === 'scarcity' || t === 'reference_price') && !v.requiresEvidence) Object.assign(v, { requiresEvidence: true, severity: 'high' });
    out.push(v);
  }

  // A relative deadline always gets its "is it real?" check
  if (facts.deadline === 'relative' && !facts.countdown && !out.some(v => v.requiresEvidence && (v.issue_type === 'fake_urgency' || v.issue_type === 'deadline_unclear'))
      && out.some(v => v.issue_type === 'deadline_unclear')) {
    out.push(evidence('fake_urgency', 'DMCCA 2024 Schedule 20 / CAP Code 3.1',
      'The offer has a deadline. We can\'t verify from the copy that the offer really ends then.',
      'Deadline wording', 'Confirm the offer genuinely ends at the stated time and is not repeated or extended straight after.'));
  }

  // Swearing or abuse: caught by code, never left to chance
  if (facts.profanity && !out.some(v => v.issue_type === 'harm_offence' && rank(v.severity) >= rank('high'))) {
    out.push({ regulation: 'CAP Code 4.1 (harm and offence)', severity: 'critical', issue_type: 'harm_offence', requiresEvidence: false,
      issue: `The copy contains "${facts.profanity}". The ASA expects marketing not to cause serious or widespread offence, and swearing or abuse aimed at the reader is very likely to.`,
      location: `"${facts.profanity}"`, recommendation: 'Remove the offensive wording before sending.' });
  }
  // Not recognisable as marketing (or a test): never a Go
  if (contentKind === 'not_marketing' && !out.some(v => v.issue_type === 'not_marketing')) {
    out.push({ regulation: 'Sendwize check', severity: 'medium', issue_type: 'not_marketing', requiresEvidence: false,
      issue: 'This doesn\'t read as marketing copy, so we can\'t give it a Go. There is no product, offer or brand message for the rules to be checked against.',
      location: 'Whole message', recommendation: 'Paste the full message you plan to send, including the subject line and footer.' });
  }

  // One finding per single issue: the member's own answers first, then the most serious
  const all = [...contextFindings, ...out];
  const seen = new Map();
  const keep = [];
  for (const v of all) {
    const t = v.issue_type;
    if (!ISSUES[t]?.single) { keep.push(v); continue; }
    const key = `${t}|${v.requiresEvidence ? 'e' : 'f'}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, v); keep.push(v); continue; }
    if (!prev._fromContext && rank(v.severity) > rank(prev.severity)) { keep[keep.indexOf(prev)] = v; seen.set(key, v); }
  }
  return keep;
}

export function copyScore(findings) {
  let s = 100;
  for (const v of findings || []) {
    if (v.requiresEvidence) { s -= 5; continue; }
    s -= { critical: 30, high: 15, medium: 7, low: 2 }[String(v.severity || '').toLowerCase()] || 0;
  }
  return Math.max(0, s);
}

// ── The rewrite must not say anything the original didn't ──
// 1. Figures (prices, percentages, times, dates) that are new in the
//    rewrite, outside [placeholders], become [check: ...].
// 2. A second, small AI read lists any new factual claim (a material, an
//    endorsement, that a fee is included, how data was collected...), and
//    each one is turned into a [check: ...] placeholder too.
const FIGURE = new RegExp(`£\\s?\\d[\\d,]*(\\.\\d+)?|\\b\\d+(\\.\\d+)?\\s?%|\\b\\d{1,2}[:.]\\d{2}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH}(\\s+\\d{4})?\\b`, 'gi');
const norm = s => String(s).toLowerCase().replace(/\s+/g, '').replace(/\.00\b/, '');
function outsideBrackets(text, fn) {
  return text.split(/(\[[^\]]*\])/).map(part => (part.startsWith('[') ? part : fn(part))).join('');
}
export function markNewFigures(original, rewrite) {
  const known = new Set((String(original).match(FIGURE) || []).map(norm));
  return outsideBrackets(String(rewrite), part => part.replace(FIGURE, m => (known.has(norm(m)) ? m : `[check: ${m}]`)));
}

const ADDED_SCHEMA = {
  type: 'object',
  properties: { added: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'], additionalProperties: false } } },
  required: ['added'], additionalProperties: false,
};
const ADDED_PROMPT = `You compare a marketing message (ORIGINAL) with a suggested REWRITE.
List every phrase in the REWRITE that states something as fact which the ORIGINAL did not say. That includes: product facts or materials, benefits or endorsements, prices or what a price includes, conditions, dates or times, stock levels, how or why the reader's details were collected, a lawful basis, and company details.
Do NOT list: text inside [square brackets]; wording that removes, softens or qualifies a claim already in the ORIGINAL; an "Offer terms:" line that only restates conditions already in the ORIGINAL; a plain unsubscribe or "Reply STOP to opt out" line.
Quote each phrase exactly as it appears in the REWRITE, as short as possible while still being the whole claim. If there are none, return an empty list.`;

export async function guardRewrite(original, rewrite, { timeoutMs = 20000 } = {}) {
  if (!rewrite || !String(rewrite).trim()) return rewrite;
  let out = markNewFigures(original, rewrite);
  // Not enough time left in the request for the second read: the figure check still applies
  if (timeoutMs < 6000) return out;
  try {
    const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(Math.min(20000, timeoutMs - 2000)),
      body: JSON.stringify({ max_tokens: 800, system: ADDED_PROMPT, messages: [{ role: 'user', content: `ORIGINAL:\n${original}\n\nREWRITE:\n${out}` }] }),
    }, { effort: 'low', schema: ADDED_SCHEMA });
    if (r.ok) {
      const a = parseJson((await r.json()).content?.[0]?.text);
      for (const { quote } of a?.added || []) {
        const q = String(quote || '').trim();
        if (q.length < 3 || q.startsWith('[')) continue;
        const i = out.indexOf(q);
        if (i >= 0 && !/\[[^\]]*$/.test(out.slice(0, i))) out = out.slice(0, i) + `[check: ${q}]` + out.slice(i + q.length);
      }
    }
  } catch (e) {
    console.warn('[copy-review] rewrite guard skipped:', e.message);
  }
  return out;
}

export { ISSUE_IDS };
