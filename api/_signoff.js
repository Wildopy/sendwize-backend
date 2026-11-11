// ─────────────────────────────────────────────────────────────
// SENDWIZE — _signoff.js v1.0
// Sign-off for Campaign Defence: the pieces that don't touch Airtable,
// so they can be tested on their own.
//   buildSignoffSummary  — every check on one campaign as Go / Fix first /
//                          Hold, so the approver only reads what's flagged
//   parseOfferEnd        — "Ends midnight Sunday" → the date it ends
//   offerMarkers         — the bits of an offer to look for on a page
//                          after it should have ended
//   complaintPrompt      — what Claude is given to draft a reply
// ─────────────────────────────────────────────────────────────
import { createHash, randomBytes } from 'node:crypto';

export const SIGNOFF_DAYS = 14;
export const newToken = () => randomBytes(24).toString('base64url');
export const hashToken = t => createHash('sha256').update(String(t)).digest('hex');
export const isToken = t => typeof t === 'string' && /^[A-Za-z0-9_-]{30,40}$/.test(t);

const j = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

// ── Summary of every check, for the approver ──────────────────
// verdict: go | fix | hold | gap (nothing on file)
export function buildSignoffSummary(f = {}) {
  const items = [];
  const ch = j(f.Channels, ['email']);
  const needC = ch.some(c => ['email', 'sms'].includes(c));
  const ai = j(f.AICheckResultJson, null);
  const mf = j(f.ModuleFieldsJson, {});
  const ps = j(f.PageScanJson, null);
  const list = j(f.ListSummarySnapshot, null);
  const claims = j(f.ClaimsExtracted, []);

  if (ai || f.AICheckId) {
    const issues = (ai?.issues || []).slice(0, 6).map(i => i.issue || i.title || i.description || i.text || '').filter(Boolean);
    const v = String(ai?.verdict || ai?.Verdict || '');
    const verdict = /hold|do not send|critical/i.test(v) ? 'hold' : /fix|review|minor|significant/i.test(v) || issues.length ? 'fix' : 'go';
    items.push({ id: 'copy', label: 'Copy check', verdict, detail: verdict === 'go' ? 'No changes needed.' : `${issues.length || 'Some'} item${issues.length === 1 ? '' : 's'} to review${issues.length ? `: ${issues.slice(0, 3).join('; ')}` : ''}.` });
  } else items.push({ id: 'copy', label: 'Copy check', verdict: 'gap', detail: 'The copy has not been checked.' });

  if (ps) {
    const t = ps.totals || {};
    items.push({ id: 'pages', label: 'Landing pages', verdict: t.needsAttention ? 'fix' : 'go', detail: t.needsAttention ? `${t.findings || 0} item${t.findings === 1 ? '' : 's'} to review across ${t.pages} page${t.pages === 1 ? '' : 's'}${t.conflicts ? `, including ${t.conflicts} that don't match the campaign` : ''}.` : `${t.pages || 0} page${t.pages === 1 ? '' : 's'} checked against the campaign.` });
  } else if (j(f.ConnectedUrls, []).length) items.push({ id: 'pages', label: 'Landing pages', verdict: 'gap', detail: 'Connected pages have not been scanned.' });

  const proof = claims.filter(c => c.evidenceRequired || /health|environmental|comparative|testimonial/.test(c.claimType || ''));
  if (claims.length) items.push({ id: 'claims', label: 'Claims', verdict: proof.length ? 'fix' : 'go', detail: proof.length ? `${proof.length} claim${proof.length === 1 ? '' : 's'} need proof on file: ${proof.slice(0, 3).map(c => `"${String(c.claim || '').slice(0, 60)}"`).join(', ')}.` : `${claims.length} claim${claims.length === 1 ? '' : 's'} found, none needing extra proof.` });

  if (needC) {
    if (list) items.push({ id: 'list', label: 'List', verdict: list.gateVerdict === 'SAFE' ? 'go' : 'fix', detail: `${Number(list.totalContacts || 0).toLocaleString('en-GB')} contacts · ${list.gateVerdict || 'checked'}${list.checkDate ? ` (checked ${list.checkDate})` : ''}.` });
    else items.push({ id: 'list', label: 'List', verdict: 'gap', detail: 'No List health check linked.' });
    const c = mf.ConsentMechanism || {};
    items.push({ id: 'consent', label: 'Consent basis', verdict: c.consentWording ? 'go' : c.lawfulBasis ? 'fix' : 'gap', detail: c.lawfulBasis ? `${c.lawfulBasis}${c.consentWording ? `, wording on file` : ', wording not on file'}.` : 'Not documented.' });
    const s = mf.Suppression || {};
    const sOk = String(s.suppressionApplied || '').includes('Yes');
    items.push({ id: 'suppression', label: 'Opt-outs removed', verdict: sOk ? 'go' : 'gap', detail: sOk ? `Applied${s.dateApplied ? ` ${s.dateApplied}` : ''}.` : 'Not confirmed.' });
  }
  if (ch.includes('email')) {
    const si = mf.SenderIdentity || {};
    items.push({ id: 'sender', label: 'Sender', verdict: si.matchesTradingName === 'Yes' ? 'go' : si.fromName ? 'fix' : 'gap', detail: si.fromName ? `${si.fromName}${si.fromEmail ? ` <${si.fromEmail}>` : ''}.` : 'Not documented.' });
  }
  const flagged = items.filter(i => i.verdict !== 'go');
  const hold = items.some(i => i.verdict === 'hold');
  return { items, flaggedCount: flagged.length, clearCount: items.length - flagged.length, hold };
}

// ── Offer end dates ───────────────────────────────────────────
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = d => d.toISOString().slice(0, 10);

// Returns { date: 'YYYY-MM-DD', phrase } or null. `from` is when the
// campaign was approved: weekdays mean the next one on or after it.
export function parseOfferEnd(text, from = new Date()) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const base = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const lead = '(?:ends?|ending|closes?|until|till|offer ends|sale ends|last day|expires?)';
  // ends 30 November / ends 30th Nov
  let m = t.match(new RegExp(`${lead}\\s+(?:at\\s+)?(?:midnight\\s+)?(?:on\\s+)?(?:[a-z]+day\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*`));
  if (m) {
    const day = Number(m[1]), mon = MONTHS.indexOf(m[2]);
    let d = new Date(Date.UTC(base.getUTCFullYear(), mon, day));
    if (d < base) d = new Date(Date.UTC(base.getUTCFullYear() + 1, mon, day));
    if (d.getUTCDate() === day) return { date: iso(d), phrase: m[0] };
  }
  // ends 30/11
  m = t.match(new RegExp(`${lead}\\s+(?:on\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?`));
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getUTCFullYear();
    let d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (!m[3] && d < base) d = new Date(Date.UTC(y + 1, Number(m[2]) - 1, Number(m[1])));
    if (!Number.isNaN(d.getTime())) return { date: iso(d), phrase: m[0] };
  }
  // ends midnight Sunday / ends Sunday / until Friday
  m = t.match(new RegExp(`${lead}\\s+(?:at\\s+)?(?:midnight\\s+)?(?:on\\s+)?(?:this\\s+)?(${DAYS.join('|')})`));
  if (m) {
    const target = DAYS.indexOf(m[1]);
    const add = (target - base.getUTCDay() + 7) % 7;
    return { date: iso(new Date(base.getTime() + add * 86400000)), phrase: m[0] };
  }
  // ends tonight / today / tomorrow / midnight
  m = t.match(new RegExp(`${lead}\\s+(?:at\\s+)?(tonight|today|tomorrow|midnight)`));
  if (m) return { date: iso(new Date(base.getTime() + (m[1] === 'tomorrow' ? 86400000 : 0))), phrase: m[0] };
  return null;
}

// What to look for on a page once the offer should have ended
export function offerMarkers(copy) {
  const t = String(copy || '');
  const out = new Set();
  for (const m of t.matchAll(/\b\d{1,2}\s?% off\b/gi)) out.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  for (const m of t.matchAll(/(?:now|only|just)\s*£\s?\d[\d,]*(?:\.\d{2})?/gi)) out.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  const end = parseOfferEnd(t);
  if (end) out.add(end.phrase);
  for (const m of t.matchAll(/\b(black friday|cyber monday|flash sale|summer sale|winter sale|boxing day)\b/gi)) out.add(m[0].toLowerCase());
  return [...out].slice(0, 8);
}

export function markersOnPage(markers, pageText) {
  const p = String(pageText || '').toLowerCase().replace(/\s+/g, ' ');
  return markers.filter(m => p.includes(m));
}

// ── Complaint reply ───────────────────────────────────────────
export function complaintPrompt(f, complaint) {
  const events = j(f.CampaignEventsJson, []).slice(-25).map(e => `- ${String(e.date || '').slice(0, 16)} ${e.title}${e.detail ? `: ${String(e.detail).slice(0, 220)}` : ''}`).join('\n');
  const claims = j(f.ClaimsExtracted, []).slice(0, 12).map(c => `- ${c.claimType}: "${String(c.claim || '').slice(0, 120)}"${c.ruleRef ? ` (${c.ruleRef})` : ''}`).join('\n');
  const snaps = j(f.UrlSnapshots, []).slice(0, 6).map(s => `- ${s.url} captured ${s.capturedAt || ''}${s.hash ? ` (fingerprint ${String(s.hash).slice(0, 12)})` : ''}: "${String(s.snippet || '').slice(0, 300)}"`).join('\n');
  const summary = buildSignoffSummary(f).items.map(i => `- ${i.label}: ${i.verdict.toUpperCase()}. ${i.detail}`).join('\n');
  const so = j(f.SignoffJson, null);
  return `A UK marketing team has received the complaint or enquiry below about one of their campaigns. Draft their reply using ONLY the facts in the campaign record. Never invent evidence, dates or documents. Where the record does not show something the complaint asks about, say plainly that it needs checking, in square brackets, e.g. [Check: was the offer extended?].

COMPLAINT OR ENQUIRY:
"""
${String(complaint).slice(0, 6000)}
"""

CAMPAIGN RECORD
Title: ${f.CampaignTitle || 'Untitled'}
Owner: ${f.OwnerName || 'Marketing team'}
Channels: ${j(f.Channels, ['email']).join(', ')}
Approved: ${f.ApprovedAt || 'not approved'}${f.ApprovedBy ? ` by ${f.ApprovedBy}` : ''}${so?.decidedBy ? ` (signed off by ${so.decidedBy})` : ''}
Approval fingerprint: ${f.ApprovalHash ? String(f.ApprovalHash).slice(0, 16) : 'none'}
Launched: ${f.LaunchDate || 'not recorded'}${f.TakedownDate ? `; taken down ${f.TakedownDate}` : ''}

Approved copy:
"""
${String(f.CampaignCopySnapshot || '').slice(0, 3000)}
"""

Checks at approval:
${summary || '- none'}

Claims found:
${claims || '- none'}

Pages as captured at approval:
${snaps || '- none'}

Timeline (oldest first):
${events || '- none'}

Return JSON only, with this shape:
{"regulator":"ASA|CMA|ICO|Customer|Other","reply":"the draft reply, 200-350 words, plain professional English, starting with: DRAFT, review before sending.","evidence":[{"item":"what to attach","from":"which part of the record it comes from"}],"gaps":["anything the record does not cover that the team must check before replying"]}`;
}
