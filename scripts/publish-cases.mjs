// ─────────────────────────────────────────────────────────────
// SENDWIZE — scripts/publish-cases.mjs
// Writes api/_case-imports.js from the review list: only cases that are
// ready (passed the source check) AND approved in data/case-approvals.json,
// and never one that is rejected. Run after a batch has been signed off:
//   node scripts/publish-cases.mjs
// ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';

const review = JSON.parse(readFileSync('data/case-review.json', 'utf8'));
const { approved = [], rejected = [] } = JSON.parse(readFileSync('data/case-approvals.json', 'utf8'));
const ok = new Set(approved), no = new Set(rejected);
const FIELDS = ['id', 'regulator', 'name', 'match', 'date', 'penalty', 'refunds', 'outcome', 'volume', 'sector', 'media', 'topic', 'summary', 'action', 'types', 'url', 'noPage'];
// ASA rulings speak as the ASA ("We told X to...", "our rules"). Sendwize quotes them to its own
// users, so the speaker is named instead; nothing else in the wording changes
const VERBS = 'told|also|referred|banned|further|reminded|upheld|partially|passed|didn’t|didn\'t|did not|considered|noted|acknowledged|understood';
const asaVoice = t => !t ? t : String(t)
  .replace(new RegExp(`(^|[.!?]\\s+)We (${VERBS})\\b`, 'g'), '$1The ASA $2')
  .replace(new RegExp(`\\b[Ww]e (${VERBS})\\b`, 'g'), 'the ASA $1')
  .replace(/\bour rules\b/g, 'the advertising rules')
  .replace(/\bour (Compliance team|CAP Compliance team)\b/g, 'the CAP Compliance team');
const fresh = review.ready.filter(c => ok.has(c.id) && !no.has(c.id))
  .map(c => ({ ...c, topic: c.evidence?.topic || null, ...(c.regulator === 'ASA' ? { summary: asaVoice(c.summary), action: asaVoice(c.action) } : {}),
    ...(c.regulator === 'ICO' ? { summary: String(c.summary || '').replace(/\bour attention\b/g, "the ICO's attention") } : {}) }))
  .map(c => Object.fromEntries(FIELDS.filter(k => c[k] !== undefined && c[k] !== null).map(k => [k, c[k]])));

// The importer leaves out cases already in the library, so cases published in earlier batches
// are carried over from the current file (unless since rejected) and new approvals are added
const { IMPORTED: before = [] } = await import(new URL('../api/_case-imports.js', import.meta.url)).catch(() => ({}));
const freshIds = new Set(fresh.map(c => c.id));
const live = [...before.filter(c => !no.has(c.id) && !freshIds.has(c.id)), ...fresh];
const missing = approved.filter(id => !live.some(c => c.id === id));
if (missing.length) console.warn(`Approved but not in the ready list (left out): ${missing.join(', ')}`);

writeFileSync('api/_case-imports.js', `// ─────────────────────────────────────────────────────────────
// SENDWIZE — _case-imports.js  (generated, do not edit by hand)
// Underscore prefix: not an endpoint.
//
// Cases imported from the ICO, CMA and ASA records by
// scripts/import-cases.mjs, checked against their source and approved in
// data/case-approvals.json. Regenerate with scripts/publish-cases.mjs.
// Review list generated ${review.generated}.
// ─────────────────────────────────────────────────────────────
export const IMPORTED = ${JSON.stringify(live, null, 0).replace(/\},\{/g, '},\n  {').replace(/^\[\{/, '[\n  {').replace(/\}\]$/, '},\n]')};
`);
console.log(`Published ${live.length} imported cases.`);
