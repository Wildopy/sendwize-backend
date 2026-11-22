// Checks Campaign Defence's claim watch (api/_claims-bank.js) without
// calling the AI or Airtable.
//   node scripts/check-claims-bank.mjs
import assert from 'node:assert/strict';
import {
  claimIssues, rulingIssues, shortlist, readMatches, alertFor, applyResponse,
  newClaimFields, claimKey, claimFromRecord, rulingFromFeed, matchPrompt, openAlerts,
} from '../api/_claims-bank.js';

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };

const claim = (id, text, claimType, extra = {}) => {
  const f = newClaimFields('memA', { claim: text, claimType }, { source: 'Copy checker', campaign: 'Spring' });
  return { ...claimFromRecord({ id, fields: f }), ...extra };
};
const green = claim('recGreen00000000a', '100% recyclable packaging', 'environmental_claim');
const price = claim('recPrice00000000a', 'Was £50, now £25', 'pricing_claim');
const urgent = claim('recUrgnt00000000a', 'Ends midnight tonight!', 'urgency_claim');
const greenRuling = rulingFromFeed({ id: 'recRul0000000000a', fields: { Regulator: 'ASA', CompanyName: 'EcoCo Ltd', PublishedDate: '2026-11-19', RulingSummary: 'The ASA found the claim "100% recyclable" was not substantiated and the environmental claim was misleading.', ClaimTypes: '["misleading_claim"]', RulingUrl: 'https://www.asa.org.uk/rulings/ecoco.html' } });
const consentRuling = rulingFromFeed({ id: 'recRul0000000000b', fields: { Regulator: 'ICO', CompanyName: 'TextCo', RulingSummary: 'Sent unsolicited marketing texts without consent.', ClaimTypes: '["consent_missing"]' } });

check('claims are tagged with specific issues, not broad types', () => {
  assert.ok(green.issues.includes('green_claim'));
  assert.ok(price.issues.includes('reference_price'));
  assert.ok(urgent.issues.includes('fake_urgency'));
});
check('a green ruling shortlists the green claim only', () => {
  assert.deepEqual(rulingIssues(greenRuling).includes('green_claim'), true);
  assert.deepEqual(shortlist(greenRuling, [green, price, urgent]).map(c => c.id), [green.id]);
});
check('an ICO consent ruling never touches ad claims', () => {
  assert.deepEqual(rulingIssues(consentRuling), []);
  assert.deepEqual(shortlist(consentRuling, [green, price, urgent]), []);
});
check('a claim already matched to a ruling, or not live, is not shortlisted again', () => {
  const done = { ...green, alerts: [alertFor(greenRuling, 'x')] };
  const off = { ...green, id: 'recOff0000000000a', status: 'taken_down' };
  assert.deepEqual(shortlist(greenRuling, [done, off]), []);
});
check('the same wording gives the same key; other members differ', () => {
  assert.equal(claimKey('memA', '100% Recyclable packaging!'), claimKey('memA', '100%  recyclable packaging'));
  assert.notEqual(claimKey('memA', '100% recyclable packaging'), claimKey('memB', '100% recyclable packaging'));
});
check('AI matches: out-of-range numbers dropped, legal-judgement wording removed', () => {
  const got = readMatches({ matches: [{ n: 1, why: 'The ASA found an unqualified "100% recyclable" claim misleading; yours uses the same words.' }, { n: 7, why: 'x' }, { n: 1, why: 'dup' }] }, [green]);
  assert.equal(got.length, 1);
  assert.ok(got[0].why.includes('100% recyclable'));
  const bad = readMatches({ matches: [{ n: 1, why: 'Your claim is in breach of CAP 11.' }] }, [green]);
  assert.equal(bad[0].why, '');
  assert.ok(!/breach|illegal|unlawful|non-compliant/i.test(alertFor(greenRuling, bad[0].why).why));
});
check('the prompt tells the AI not to judge the saved claim', () => {
  const { system, user } = matchPrompt(greenRuling, [green]);
  assert.ok(/Never say the saved claim breaks a rule/.test(system));
  assert.ok(user.includes('1. "100% recyclable packaging"'));
});
check('alert wording is informational', () => {
  const a = alertFor(greenRuling, '');
  assert.equal(a.title, 'Similar to a claim the ASA ruled on (EcoCo Ltd)');
  assert.equal(a.status, 'open');
  assert.equal(a.url, 'https://www.asa.org.uk/rulings/ecoco.html');
});

const withAlert = { ...green, alerts: [alertFor(greenRuling, 'Same words.', '2026-11-22T07:30:00Z')] };
const alertId = withAlert.alerts[0].id;
check('answers need a name', () => {
  assert.ok(applyResponse(withAlert, { alertId, action: 'taken_down' }).error);
});
check('taken down: claim stops being watched, alert answered, record dated and named', () => {
  const out = applyResponse(withAlert, { alertId, action: 'taken_down', by: 'Sam', note: 'Removed from product page', at: '2026-11-22T10:00:00Z' });
  assert.equal(out.status, 'taken_down');
  assert.equal(out.alerts[0].status, 'answered');
  assert.equal(out.alerts[0].answer.by, 'Sam');
  assert.equal(out.history.at(-1).label, 'Taken down');
  assert.equal(openAlerts({ alerts: out.alerts }).length, 0);
});
check('changed: needs new wording, keeps the old wording in the record, re-tags issues', () => {
  assert.ok(applyResponse(withAlert, { alertId, action: 'changed', by: 'Sam' }).error);
  assert.ok(applyResponse(withAlert, { alertId, action: 'changed', by: 'Sam', newText: '100% recyclable packaging' }).error);
  const out = applyResponse(withAlert, { alertId, action: 'changed', by: 'Sam', newText: 'Packaging made from 80% recycled card' });
  assert.equal(out.status, 'live');
  assert.equal(out.text, 'Packaging made from 80% recycled card');
  assert.equal(out.history.at(-1).oldText, '100% recyclable packaging');
  assert.ok(out.issues.includes('green_claim'));
});
check('kept: needs the evidence, which is added to the claim', () => {
  assert.ok(applyResponse(withAlert, { alertId, action: 'kept', by: 'Sam' }).error);
  const out = applyResponse(withAlert, { alertId, action: 'kept', by: 'Sam', note: 'Recyclability certificate ref 1234' });
  assert.equal(out.status, 'live');
  assert.ok(out.evidence.includes('Recyclability certificate ref 1234'));
});
check('an alert can only be answered once', () => {
  const out = applyResponse(withAlert, { alertId, action: 'taken_down', by: 'Sam' });
  assert.ok(applyResponse({ ...withAlert, alerts: out.alerts }, { alertId, action: 'kept', by: 'Sam', note: 'x' }).error);
});
check('new claims: unknown types become other, empty text is ignored, bad record ids dropped', () => {
  assert.equal(newClaimFields('memA', { claim: 'Best in the UK', claimType: 'made_up' }, {}).ClaimType, 'other');
  assert.equal(newClaimFields('memA', { claim: '   ' }, {}), null);
  assert.equal(newClaimFields('memA', { claim: 'x' }, { sourceRecordId: "rec') OR 1=1" }).SourceRecordId, '');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
