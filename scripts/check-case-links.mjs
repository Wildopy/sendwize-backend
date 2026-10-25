// ─────────────────────────────────────────────────────────────
// SENDWIZE — scripts/check-case-links.mjs
// Spot-check for the case library: fetches every case's source page and
// checks that it loads, sits on the regulator's own site, names the party
// and, where the case has a fine, states the amount. PDFs are read with
// pdftotext when it is installed, otherwise only the link is checked.
//
// Run: node scripts/check-case-links.mjs
// Exits 1 if any case fails, so CI flags it. Writes a table to
// $GITHUB_STEP_SUMMARY when run in GitHub Actions.
// ─────────────────────────────────────────────────────────────
import { CASES, matchWords } from '../api/_case-library.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OFFICIAL = /^https:\/\/(www\.)?(ico\.org\.uk|asa\.org\.uk|gov\.uk)\//;
const UA = 'Mozilla/5.0 (compatible; SendwizeCaseCheck/1.0; +https://sendwize.co.uk)';
const dir = mkdtempSync(join(tmpdir(), 'cases-'));

// Ways a regulator writes an amount: £140,000 · £140k · £4.8 million · £14m
function amountForms(n) {
  const forms = [n.toLocaleString('en-GB'), String(n)];
  if (n % 1000 === 0 && n < 1e6) forms.push(`${n / 1000}k`);
  if (n >= 1e6) { const m = String(n / 1e6); forms.push(`${m} million`, `${m}m`, `${m}M`); }
  return forms;
}
const plain = t => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/\s+/g, ' ');

function pdfText(buf, id) {
  try {
    const f = join(dir, id + '.pdf');
    writeFileSync(f, buf);
    return execFileSync('pdftotext', ['-q', f, '-'], { encoding: 'utf8', maxBuffer: 50e6 });
  } catch { return null; }
}

// One fetch per source: many imported ICO cases share the penalties register
const pages = new Map();
function load(c) {
  if (!pages.has(c.url)) pages.set(c.url, (async () => {
    let res;
    try { res = await fetch(c.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
    catch (e) { return { problem: 'could not load: ' + e.message }; }
    if (!res.ok) return { problem: 'HTTP ' + res.status };
    const type = res.headers.get('content-type') || '';
    if (/pdf/i.test(type) || /\.pdf$/i.test(c.url)) return { url: res.url, text: pdfText(Buffer.from(await res.arrayBuffer()), c.id) };
    return { url: res.url, text: plain(await res.text()) };
  })());
  return pages.get(c.url);
}
const squash = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function check(c) {
  const out = { id: c.id, name: c.name, url: c.url, problems: [], note: '' };
  if (!OFFICIAL.test(c.url || '')) { out.problems.push('not an official regulator URL'); return out; }
  const page = await load(c);
  if (page.problem) { out.problems.push(page.problem); return out; }
  if (!OFFICIAL.test(page.url)) out.problems.push('redirected off the regulator site to ' + page.url);
  const text = page.text;
  if (text == null) { out.note = 'PDF: link works, contents not read (pdftotext missing)'; return out; }
  const words = matchWords(c);
  if (!squash(text).includes(squash(words))) out.problems.push(`page does not mention "${words}"`);
  if (c.penalty && !amountForms(c.penalty).some(f => text.includes(f))) out.problems.push(`page does not state £${c.penalty.toLocaleString('en-GB')}`);
  return out;
}

const results = [];
for (let i = 0; i < CASES.length; i += 6) results.push(...await Promise.all(CASES.slice(i, i + 6).map(check)));

const bad = results.filter(r => r.problems.length);
for (const r of results) console.log(`${r.problems.length ? 'FAIL' : 'ok  '}  ${r.id.padEnd(28)} ${r.problems.join('; ') || r.note}`);
console.log(`\n${results.length - bad.length} of ${results.length} cases verified against their source page.`);

if (process.env.GITHUB_STEP_SUMMARY) {
  // Every failure, and the hand-checked cases; imported passes are only counted
  const rows = results.filter(r => r.problems.length || !CASES.find(c => c.id === r.id)?.imported).map(r => `| ${r.problems.length ? '❌' : '✅'} | [${r.name.replace(/\|/g, '/')}](${r.url}) | ${r.problems.join('; ') || r.note || 'Party and amount found'} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Case library check\n\n${results.length - bad.length} of ${results.length} cases verified against their source page.\n\n| | Case | Result |\n|---|---|---|\n${rows.join('\n')}\n`);
}
process.exit(bad.length ? 1 : 0);
