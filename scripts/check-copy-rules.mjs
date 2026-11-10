// Checks the Copy Checker's house rules without calling the AI.
//   node scripts/check-copy-rules.mjs
// 1. The facts read by code from each email in data/copy-test-set.json.
// 2. Findings like the ones round 1 got wrong (10 Nov 2026), run through
//    reviewFindings(), with the verdict and the case each one would show.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyFacts, reviewFindings, copyScore, markNewFigures } from '../api/_copy-review.js';
import { caseForIssue, closestCases } from '../api/_exposure.js';
import { issueOf } from '../api/_copy-issues.js';
import { sendCall } from '../api/_send-call.js';

const set = JSON.parse(readFileSync(new URL('../data/copy-test-set.json', import.meta.url)));
const byId = Object.fromEntries(set.emails.map(e => [e.id, e]));
const facts = id => copyFacts(byId[id].channel, byId[id].text);

console.log('── Facts read by code ──');
for (const e of set.emails) {
  const f = copyFacts(e.channel, e.text);
  console.log(`${e.id.padEnd(3)} ${e.channel.padEnd(10)} optOut=${f.optOut ? 'y' : 'n'} sender=${f.senderNamed ? 'y' : 'n'} company=${f.corporateRecipient ? 'y' : 'n'} deadline=${f.deadline.padEnd(8)} countdown=${f.countdown ? 'y' : 'n'}${f.profanity ? ' SWEARING' : ''}`);
}

const F = (issue_type, severity, issue, extra = {}) => ({ regulation: '', location: '', recommendation: '', requiresEvidence: false, issue_type, severity, issue, ...extra });
const run = (id, findings, opts) => {
  const out = reviewFindings(findings, facts(id), opts);
  return { out, call: sendCall(out).verdict, score: copyScore(out) };
};
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };

console.log('\n── Round 1 mistakes ──');
check('B: a named SMS sender is not flagged', () => {
  const { out } = run('B', [F('opt_out_missing', 'critical', 'No STOP'), F('sender_details', 'low', 'brightside.link not clearly identifiable')]);
  assert.deepEqual(out.map(v => v.issue_type), ['opt_out_missing']);
});
check('A: "midnight tonight" is medium plus an evidence check, not critical', () => {
  const { out } = run('A', [F('fake_urgency', 'critical', "'Ends at MIDNIGHT TONIGHT' gives no specific date")]);
  assert.equal(out[0].severity, 'medium');
  assert.equal(out[0].issue_type, 'deadline_unclear');
  assert.ok(out.some(v => v.requiresEvidence && v.issue_type === 'fake_urgency'));
});
check('A: "only 2 left" becomes an evidence check', () => {
  const { out } = run('A', [F('scarcity', 'critical', "'Only 2 left in stock'")]);
  assert.equal(out[0].requiresEvidence, true);
});
check('F: a 10-minute countdown stays critical', () => {
  const { call } = run('F', [F('fake_urgency', 'critical', "'Checkout in the next 10 minutes'")]);
  assert.equal(call, 'hold');
});
check('12: a dated deadline is an evidence check, not a finding', () => {
  const { out } = run('12', [F('fake_urgency', 'high', 'Deadline may not be genuine')]);
  assert.equal(out[0].requiresEvidence, true);
});
check('14: no consent finding on a company email address', () => {
  const { out, call } = run('14', [F('consent_basis', 'low', "We can't find how consent was established")]);
  assert.equal(out.length, 0); assert.equal(call, 'go');
});
check('D: an unsubscribe finding on an email that has one is dropped', () => {
  assert.equal(run('D', [F('opt_out_missing', 'critical', 'No unsubscribe')]).out.length, 0);
});
check('F: no unsubscribe finding on a push notification', () => {
  assert.equal(run('F', [F('opt_out_missing', 'critical', 'No unsubscribe')]).out.length, 0);
});
check('I: the sender is raised once, the member\'s own answer first', () => {
  const ctx = [{ ...F('sender_hidden', 'critical', 'From name does not match'), _fromContext: true }];
  const { out } = run('I', [F('sender_hidden', 'critical', 'The sender is a different entity')], { contextFindings: ctx });
  assert.equal(out.filter(v => v.issue_type === 'sender_hidden').length, 1);
  assert.ok(out[0]._fromContext);
});
check('H: an RRP comparison becomes an evidence check', () => {
  assert.equal(run('H', [F('reference_price', 'critical', "'Now £59 (RRP £129)'")]).out[0].requiresEvidence, true);
});
check('26: swearing is a Hold even if the AI finds nothing', () => {
  const { call, out } = run('26', [], { contentKind: 'not_marketing' });
  assert.equal(call, 'hold'); assert.ok(out.some(v => v.issue_type === 'harm_offence'));
});
check('Not marketing is never a Go', () => {
  assert.equal(copyFacts('email', 'hello').profanity, null);
  const out = reviewFindings([], copyFacts('email', 'hello'), { contentKind: 'not_marketing' });
  assert.equal(sendCall(out).verdict, 'fix_first');
});
check('13: a service message with no findings is a Go', () => {
  assert.equal(run('13', [], { contentKind: 'service' }).call, 'go');
});

console.log('\n── Round 2 mistakes ──');
check('A: a missing sender name is sender details (high), not concealment', () => {
  const { out } = run('A', [F('sender_hidden', 'critical', 'The email does not name the sender, so it may be read as disguised or concealed.')]);
  // A's test copy has a From line; strip it to match what was pasted
  const r = reviewFindings([F('sender_hidden', 'critical', 'The email does not name the sender, so it may be read as disguised or concealed.')], copyFacts('email', byId.A.text.replace(/^From:.*$/m, '')));
  assert.equal(r[0].issue_type, 'sender_details'); assert.equal(r[0].severity, 'high');
  assert.equal(out.length, 0);
});
check('I: "signed up to Top Deals UK" names the sender', () => {
  assert.ok(copyFacts('email', byId.I.text.replace(/^From:.*$/m, '')).senderNamed);
  const { out } = run('I', [F('sender_hidden', 'high', 'No sender is named.')]);
  assert.equal(out.length, 0);
});
check('23: a fake delivery notice stays a hidden sender', () => {
  const { out } = run('23', [F('sender_hidden', 'critical', 'A promotional email presented as a parcel delivery notification')]);
  assert.equal(out[0].issue_type, 'sender_hidden'); assert.equal(out[0].severity, 'critical');
});
check('C: an unlabelled influencer ad is a Hold', () => {
  assert.equal(run('C', [F('hidden_ad', 'high', 'No #ad label on a post with a discount code')]).call, 'hold');
});
check('H: "100% sustainable" is a Hold, "carbon neutral" alone is not', () => {
  assert.equal(run('H', [F('green_claim', 'high', "'100% sustainable' is an absolute claim")]).call, 'hold');
  assert.equal(run('H', [F('green_claim', 'high', "'carbon neutral' with no basis")]).call, 'fix_first');
});
check('26: no unrelated case on swearing', () => {
  const { out } = run('26', [], { contentKind: 'not_marketing' });
  assert.ok(out.find(v => v.issue_type === 'harm_offence')._noCase);
});

check('Citations come from the checked list, not the AI', () => {
  const { out } = run('A', [F('drip_pricing', 'high', 'Handling fee in small print', { regulation: 'CAP Code 3.17 / DMCCA s.226' }), F('reference_price', 'high', 'RRP', { regulation: 'CAP Code 3.40' })]);
  assert.equal(out[0].regulation, 'CAP Code 3.18 / DMCCA 2024 s.230');
  assert.equal(out[1].regulation, 'CAP Code 3.39 / DMCCA 2024 s.226');
});

console.log('\n── Rewrites ──');
check('A: a new time in the rewrite is marked, a known price is not', () => {
  const r = markNewFigures(byId.A.text, 'Was £249, NOW just £74.99. Ends 23:59 on [date].');
  assert.ok(r.includes('[check: 23:59]')); assert.ok(r.includes('£74.99') && !r.includes('[check: £74.99]'));
});
check('F: an invented "23:59 today" is marked', () => {
  assert.ok(markNewFigures(byId.F.text, 'Checkout by 23:59 today to keep it.').includes('[check: 23:59]'));
});
check('Placeholders are left alone', () => {
  assert.equal(markNewFigures('Sale', 'Ends [23:59 on date]'), 'Ends [23:59 on date]');
});

console.log('\n── Cases: round 1 findings and the case each now gets ──');
const CASE_TESTS = [
  ['A',  'opt_out_missing',     'No unsubscribe mechanism in this email', null],
  ['10', 'sender_details',      "We can't find the sender's identity or a valid contact address", null],
  ['10', 'hidden_conditions',   "'70% OFF EVERYTHING' is followed only by '*Terms and conditions apply'", 'any'],
  ['A',  'drip_pricing',        'The headline price excludes a £9.99 handling fee disclosed only in small print', 'any'],
  ['A',  'free_claim',          "'FREE delivery on everything!' is contradicted by the footnote: over £150, excludes furniture", 'any'],
  ['C',  'hidden_ad',           'Influencer post with a discount code and no #ad label', 'any'],
  ['H',  'green_claim',         "Absolute claims '100% sustainable' and 'carbon neutral' presented as fact", 'any'],
  ['F',  'fake_urgency',        "'Checkout in the next 10 minutes to keep your 25% off' countdown", 'any'],
  ['G',  'hidden_conditions',   'The £800 minimum order for the voucher is only in small print', 'any'],
  ['I',  'third_party_consent', "Consent given to 'Top Deals UK and our partners', not Brightside by name", 'any'],
  ['19', 'incentivised_review', '£20 off in exchange for a 5-star review on Trustpilot', 'any'],
  ['20', 'free_claim',          "The service is called 'FREE' but there is a £39 design fee", 'any'],
  ['21', 'medicinal_claim',     "'Cure insomnia' is a claim to treat a medical condition (food supplement)", 'any'],
  ['23', 'disguised_marketing', 'A promotional sofa email presented as a parcel delivery notification', 'any'],
  ['18', 'subscription_terms',  "'Just £1' then renews monthly at a price that isn't stated", 'any'],
  ['26', 'harm_offence',        'Swearing aimed at the reader', 'any'],
];
for (const [id, issue, text, want] of CASE_TESTS) {
  const c = issueOf(issue).caseable ? caseForIssue(issue, { text, channel: byId[id].channel }) : null;
  const shown = c ? `${c.name} (${c.regulator}) — ${c.summary.slice(0, 90)}` : 'no case';
  console.log(`${id.padEnd(3)} ${issue.padEnd(20)} → ${shown}`);
  if (want === null && c) { failures++; console.log('FAIL   expected no case'); }
  if (want === 'any' && !c) { failures++; console.log('FAIL   expected a case'); }
}
console.log('\n── "Why this number?" cases ──');
check('Only same-issue cases behind a stock claim', () => {
  const cs = closestCases('fake_scarcity', null, { text: "'Only 2 left in stock' claim" });
  assert.ok(cs.length && cs.every(c => !/HelloFresh/.test(c.name)));
});
check('No case rather than a loose one for a missing unsubscribe link', () => {
  assert.equal(closestCases('missing_unsubscribe', null, { text: 'No unsubscribe link in this email' }).length, 0);
});
check('Partner consent shows partner-consent cases', () => {
  assert.ok(closestCases('third_party_list', null, { text: "Consent given to 'our partners', not you by name" }).every(c => c.regulator === 'ICO'));
});
console.log(failures ? `\n${failures} failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
