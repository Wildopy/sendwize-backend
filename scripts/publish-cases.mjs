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
const FIELDS = ['id', 'regulator', 'name', 'match', 'date', 'penalty', 'refunds', 'outcome', 'volume', 'sector', 'summary', 'types', 'url', 'noPage'];
const live = review.ready.filter(c => ok.has(c.id) && !no.has(c.id))
  .map(c => Object.fromEntries(FIELDS.filter(k => c[k] !== undefined && c[k] !== null).map(k => [k, c[k]])));

const missing = approved.filter(id => !review.ready.some(c => c.id === id));
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
