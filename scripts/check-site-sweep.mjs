// Runs the Site sweep against the two planted test sites, offline.
//   node scripts/check-site-sweep.mjs            summary + checks
//   node scripts/check-site-sweep.mjs --json     also writes data/test-sites/sample-sweep.json
// data/test-sites/problems is the test pack's twilight-site (every planted
// problem); data/test-sites/fixed is twilight-site-fixed (should score 100).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runSweep } from '../api/site-sweep.js';

const DOMAIN = 'brightside-test.netlify.app';
const siteFetch = dir => async url => {
  const path = new URL(url).pathname.replace(/^\/$/, '/index.html');
  const file = new URL(`../data/test-sites/${dir}${path}`, import.meta.url);
  if (!existsSync(file)) return { ok: false, error: 'HTTP 404', finalUrl: url };
  return { ok: true, html: readFileSync(file, 'utf8'), httpStatus: 200, finalUrl: url };
};
const noBrowser = async () => ({ status: 'unavailable', reason: 'Headless browser not installed' });

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };
const ids = s => s.findings.map(f => f.checkId);

const problems = await runSweep(DOMAIN, { fetch: siteFetch('problems'), browserTest: noBrowser, reloadWaitMs: 2100, revenueBand: '£1M–£10M', sector: 'ecommerce' });
console.log(`\nProblems site: score ${problems.score}, ${problems.findings.length} findings`);
for (const f of problems.findings) console.log(`  ${f.severity.padEnd(6)} ${f.checkId.padEnd(32)} ${f.where || ''} ${f.case ? '· case: ' + f.case.name : ''}`);
console.log('  pages:', problems.pages.map(p => `${p.role}:${new URL(p.url).pathname}`).join(' '));

const expected = ['signup_purpose_unclear', 'signup_sms_wording', 'popup_hidden_decline', 'cookies_reject_layer_down', 'urgency_timer_resets',
  'claim_superlative_claim', 'claim_credential_claim', 'claim_green_claim', 'reviews_only_top', 'reviews_no_check_statement', 'ad_label_missing'];
check('every planted marketing problem is found', () => { const got = ids(problems); assert.deepEqual(expected.filter(x => !got.includes(x)), []); });
check('the earlier findings are still there', () => { for (const x of ['capture_pre_ticked', 'capture_no_privacy_link', 'privacy_notice_incomplete', 'cookies_no_policy', 'identity_company_details']) assert.ok(ids(problems).includes(x), x); });
check('sale and partner pages are read', () => { const roles = problems.pages.map(p => p.role); assert.ok(roles.includes('offers') && roles.includes('partner'), roles.join()); });
check('the timer is caught by both the page script and the second load', () => {
  const f = problems.findings.find(x => x.checkId === 'urgency_timer_resets');
  assert.equal(f.evidence.length, 2, JSON.stringify(f.evidence));
});
check('every ICO, CMA and ASA finding carries a cost line', () => {
  for (const f of problems.findings.filter(x => x.severity !== 'low' && ['ICO', 'CMA', 'ASA'].includes(x.regulator))) assert.ok(f.cost?.label, f.checkId);
});
check('ICO figures come from the exposure engine for the member\'s size', () => {
  const f = problems.findings.find(x => x.checkId === 'signup_sms_wording');
  assert.ok(f.cost.low > 0 && f.cost.high > f.cost.low, JSON.stringify(f.cost));
});
check('real cases are pinned where they fit, and none where none fits', () => {
  const c = id => problems.findings.find(x => x.checkId === id)?.case?.id;
  assert.equal(c('signup_sms_wording'), 'hellofresh_2024');
  assert.equal(c('urgency_timer_resets'), 'emma_cma_2026');
  assert.equal(c('reviews_only_top'), 'google_cma_2025');
  assert.equal(c('ad_label_missing'), 'sancarlo_asa_2026');
  assert.equal(problems.findings.find(x => x.checkId === 'cookies_reject_layer_down').case, null);
});
check('ready-to-paste fixes use the brand name', () => {
  assert.match(problems.findings.find(x => x.checkId === 'signup_sms_wording').fix.paste, /Brightside Home/);
});
check('first run explains the never-changes check', () => assert.ok(problems.notes.some(n => /a week or more/.test(n))));

// Second sweep 10 days later with the same claims: urgency that never ends
const later = { ...problems, urgencySnapshot: Object.fromEntries(Object.entries(problems.urgencySnapshot).map(([k, v]) => [k, { ...v, at: new Date(Date.now() - 10 * 864e5).toISOString() }])) };
const rerun = await runSweep(DOMAIN, { fetch: siteFetch('problems'), browserTest: noBrowser, reloadWaitMs: 0, previous: later });
check('claims unchanged after 10 days are flagged', () => { assert.ok(ids(rerun).includes('urgency_never_ends')); assert.ok(ids(rerun).includes('scarcity_never_changes')); });
check('first-seen date is kept across re-runs', () => assert.equal(rerun.urgencySnapshot['/sale.html'].at, later.urgencySnapshot['/sale.html'].at));

const fixed = await runSweep(DOMAIN, { fetch: siteFetch('fixed'), browserTest: noBrowser, reloadWaitMs: 0, previous: problems });
console.log(`\nFixed site: score ${fixed.score}, ${fixed.findings.length} findings: ${ids(fixed).join(', ') || 'none'}`);
check('the fixed site scores 100 with nothing to flag', () => { assert.equal(fixed.score, 100); assert.deepEqual(ids(fixed), []); });

if (process.argv.includes('--json')) writeFileSync(new URL('../data/test-sites/sample-sweep.json', import.meta.url), JSON.stringify(problems, null, 1));
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
