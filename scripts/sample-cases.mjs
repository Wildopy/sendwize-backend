// ─────────────────────────────────────────────────────────────
// SENDWIZE — scripts/sample-cases.mjs
// Picks a random sample from data/case-review.json for a person to check
// against the regulator pages before a batch is approved, and writes the
// full ready and held lists as CSV.
//   node scripts/sample-cases.mjs <out-dir> [seed] [keep-ids-file]
// A keep file (one case id per line) carries cases over from an earlier
// sample; the rest are picked fresh. At most one ICO phone-call case is
// picked, since those only sit beside the TPS question.
// ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [out = 'data/sample', seedArg, keepFile] = process.argv.slice(2);
const r = JSON.parse(readFileSync('data/case-review.json', 'utf8'));
let seed = Number(seedArg) || Date.now() % 2147483648;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr, n) => { const a = arr.slice(), o = []; while (o.length < n && a.length) o.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return o; };
const keepIds = keepFile ? readFileSync(keepFile, 'utf8').split(/\s+/).filter(Boolean) : [];
const kept = keepIds.map(id => r.ready.find(c => c.id === id)).filter(Boolean);
const isCall = c => c.types.includes('marketing_calls');
const by = (g, f = () => true) => r.ready.filter(c => c.regulator === g && !kept.includes(c) && f(c));
const fill = (g, n) => {
  const have = kept.filter(c => c.regulator === g);
  if (g !== 'ICO') return [...have, ...pick(by(g), n - have.length)];
  const calls = have.some(isCall) ? 0 : 1;
  const o = [...have, ...pick(by(g, isCall), Math.min(calls, n - have.length))];
  return [...o, ...pick(by(g, c => !isCall(c)), n - o.length)];
};
const sample = [...fill('ICO', 7), ...fill('CMA', 5), ...fill('ASA', 8)];
const nice = t => t.replace(/_/g, ' ');
const n = x => x.toLocaleString('en-GB');
const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
mkdirSync(out, { recursive: true });

writeFileSync(join(out, 'sample-to-check.md'), `# Case import: sample to check

The importer read every marketing case the ICO, CMA and ASA publish and found **${n(r.ready.length)} that passed the source check** (ICO ${r.counts.ready.ICO || 0}, CMA ${r.counts.ready.CMA || 0}, ASA ${r.counts.ready.ASA || 0}), on top of the hand-checked cases already live. ${n(r.held.length)} more were held back, each with a reason (see held-back-cases.csv). None of the imported cases is live yet.

Below are ${sample.length} picked at random. For each one, open the link and check that the name, date and amount (or outcome) match what the regulator says. "Matched to" is the kind of finding Sendwize would show the case beside: say if any look wrong.

Notes:
- ICO amounts come from the ICO's own penalties register (a spreadsheet), so the link opens that file. Search it for the company name.
- The ASA website lists rulings from 2021 onwards, so that is how far back ASA goes.
- Cases from before April 2014 were run by the OFT, the CMA's predecessor, and say so.

${sample.map((c, i) => `**${i + 1}. ${c.name}** (${c.regulator}, ${c.date})  
${c.penalty ? 'Fined £' + n(c.penalty) : c.outcome}. ${c.summary}  
${c.action ? `What they had to change: ${c.action}  \n` : ''}Matched to: ${c.types.map(nice).join(', ')}  
[Open the regulator page](${c.url})${c.url.endsWith('.csv') ? `  \nIn the ICO register (a spreadsheet): search for "${(c.evidence?.register_row || [])[0] || c.name}" and check the row says ${(c.evidence?.register_row || [])[3] || c.date} under Date of Final Notice and £${n(c.penalty)} under ${c.law === 'PECR' ? 'PECR fine' : 'DPA fine'}.` : ''}`).join('\n\n')}
`);
writeFileSync(join(out, 'all-ready-cases.csv'), ['regulator,name,date,amount,outcome,matched_to,url,summary',
  ...r.ready.map(c => [c.regulator, c.name, c.date, c.penalty || '', c.penalty ? '' : c.outcome, c.types.join(' '), c.url, c.summary].map(cell).join(','))].join('\n') + '\n');
writeFileSync(join(out, 'held-back-cases.csv'), ['regulator,name,date,reason,url',
  ...r.held.map(c => [c.regulator, c.name, c.date || '', c.reason, c.url].map(cell).join(','))].join('\n') + '\n');
console.log(sample.map(c => c.id).join('\n'));
