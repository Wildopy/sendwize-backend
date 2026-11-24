// ─────────────────────────────────────────────────────────────
// SENDWIZE: _house-rules.js  v1.0
// A business's own rules, applied to every copy check on top of the
// regulators' rules. Saved on the business profile (User_Profile field
// HouseRulesJson), so each client workspace has its own.
//
//   banned       words or phrases the business never uses
//                [{ phrase, severity: 'hold'|'fix', reason }]
//   disclaimers  wording that must appear
//                [{ text, channels: ['email',...] | [], whenContains }]
//                channels empty = every channel; whenContains = only
//                when the copy mentions that word (e.g. "invest")
//   approved     claims the business has already proved, with what proves
//                them [{ claim, evidence }]. No evidence check is raised
//                for them.
//   notes        anything else the reviewer should know (tone, product
//                facts, things legal always asks for), max 2,000 chars
//
// cleanHouseRules()  validates what the profile page sends
// houseFindings()    banned phrases and missing disclaimers, found by code
//                    in the typed or extracted text (never by the AI)
// houseBlock()       the [HOUSE RULES] text for the AI, so it can also
//                    apply them to images and PDFs that code can't read
// isApprovedClaim()  is an evidence finding about an approved claim?
//
// v1.0 (24 Nov 2026): first version.
// ─────────────────────────────────────────────────────────────

const CHANNELS = ['email', 'sms', 'push', 'social', 'influencer', 'directmail', 'document'];
const LIMITS = { banned: 100, disclaimers: 30, approved: 100, notes: 2000 };

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// Curly quotes, dashes and spacing don't decide whether a phrase is there
export const normText = s => String(s || '')
  .toLowerCase()
  .replace(/[‘’‛′]/g, "'")
  .replace(/[“”‟″]/g, '"')
  .replace(/[–—−]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanHouseRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
  const banned = list(r.banned, LIMITS.banned)
    .map(b => ({ phrase: str(b?.phrase, 120), severity: b?.severity === 'hold' ? 'hold' : 'fix', reason: str(b?.reason, 300) }))
    .filter(b => b.phrase.length >= 2);
  const disclaimers = list(r.disclaimers, LIMITS.disclaimers)
    .map(d => ({
      text: str(d?.text, 600),
      channels: (Array.isArray(d?.channels) ? d.channels : []).filter(c => CHANNELS.includes(c)),
      whenContains: str(d?.whenContains, 80),
    }))
    .filter(d => d.text.length >= 3);
  const approved = list(r.approved, LIMITS.approved)
    .map(a => ({ claim: str(a?.claim, 300), evidence: str(a?.evidence, 300) }))
    .filter(a => a.claim.length >= 3);
  const notes = String(r.notes ?? '').trim().slice(0, LIMITS.notes);
  return { banned, disclaimers, approved, notes };
}

export function parseHouseRules(json) {
  if (!json) return cleanHouseRules({});
  try { return cleanHouseRules(typeof json === 'string' ? JSON.parse(json) : json); } catch { return cleanHouseRules({}); }
}

export const hasHouseRules = h => !!(h && (h.banned.length || h.disclaimers.length || h.approved.length || h.notes));

const phraseRe = p => new RegExp(`(^|[^a-z0-9])${esc(normText(p))}($|[^a-z0-9])`, 'i');
const applies = (d, channel, text) =>
  (!d.channels.length || d.channels.includes(channel)) && (!d.whenContains || phraseRe(d.whenContains).test(text));

// Disclaimers often wrap or lose punctuation when pasted: compare letters and digits only
const squash = s => normText(s).replace(/[^a-z0-9£%]+/g, '');

export function houseFindings(text, house, channel, { disclaimers = true } = {}) {
  if (!hasHouseRules(house) || !String(text || '').trim()) return [];
  const t = normText(text);
  const out = [];
  for (const b of house.banned) {
    if (!phraseRe(b.phrase).test(t)) continue;
    out.push({
      regulation: 'Your house rules', severity: b.severity === 'hold' ? 'critical' : 'medium', issue_type: 'house_rule',
      requiresEvidence: false, _fromContext: true, _noCase: true, _house: true,
      issue: `"${b.phrase}" is on your list of words and phrases not to use.${b.reason ? ` ${b.reason}` : ''}`,
      location: `"${b.phrase}"`,
      recommendation: `Remove or reword "${b.phrase}".`,
    });
  }
  const flat = squash(text);
  for (const d of disclaimers ? house.disclaimers : []) {
    if (!applies(d, channel, t)) continue;
    if (flat.includes(squash(d.text))) continue;
    out.push({
      regulation: 'Your house rules', severity: 'high', issue_type: 'house_rule',
      requiresEvidence: false, _fromContext: true, _noCase: true, _house: true,
      issue: `Your house rules say this wording must appear${d.whenContains ? ` when the copy mentions "${d.whenContains}"` : ''}, and we can't find it: "${d.text}"`,
      location: 'Whole piece',
      recommendation: `Add the required wording exactly: "${d.text}"`,
    });
  }
  return out;
}

export function houseBlock(house, { codeChecked = true } = {}) {
  if (!hasHouseRules(house)) return '';
  const lines = ['[HOUSE RULES: the business\'s own rules, on top of the regulators\']'];
  if (house.banned.length) {
    lines.push(codeChecked
      ? 'Banned words and phrases (Sendwize has already checked the typed text for these; check images and documents for them too, as issue_type house_rule):'
      : 'Banned words and phrases (raise each one you find as issue_type house_rule, regulation "Your house rules"; severity critical if marked hold, otherwise medium):');
    for (const b of house.banned) lines.push(`- "${b.phrase}"${b.severity === 'hold' ? ' [hold]' : ''}${b.reason ? `: ${b.reason}` : ''}`);
  }
  if (house.disclaimers.length) {
    lines.push(codeChecked
      ? 'Required wording (already checked by Sendwize in the typed text; do not raise these again unless the wording only appears in an image or document and is missing there):'
      : 'Required wording (raise any that is missing as issue_type house_rule, severity high):');
    for (const d of house.disclaimers) lines.push(`- "${d.text}"${d.channels.length ? ` (for: ${d.channels.join(', ')})` : ''}${d.whenContains ? ` (only when the copy mentions "${d.whenContains}")` : ''}`);
  }
  if (house.approved.length) {
    lines.push('Approved claims: the business holds evidence for these. Do NOT raise an evidence check for them. A claim that goes further than the approved wording (a bigger number, a stronger word) is still a finding.');
    for (const a of house.approved) lines.push(`- "${a.claim}"${a.evidence ? ` (evidence: ${a.evidence})` : ''}`);
  }
  if (house.notes) lines.push(`Notes from the business (follow them where they don't conflict with the law):\n${house.notes}`);
  lines.push('[END HOUSE RULES]');
  return lines.join('\n');
}

// An evidence check the AI raised about a claim the business has already proved
export function isApprovedClaim(v, house) {
  if (!v?.requiresEvidence || !house?.approved?.length) return false;
  const said = squash(`${v.location || ''} ${v.issue || ''}`);
  return house.approved.some(a => { const c = squash(a.claim); return c.length >= 6 && said.includes(c); });
}
