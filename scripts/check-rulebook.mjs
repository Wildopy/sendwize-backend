// Checks the rulebook, house rules and document reading without calling the AI.
//   node scripts/check-rulebook.mjs
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { selectRules, RULE_PACKS } from '../api/_rulebook.js';
import { cleanHouseRules, houseFindings, houseBlock, isApprovedClaim } from '../api/_house-rules.js';
import { readDocument } from '../api/_doc-text.js';
import { reviewFindings, copyFacts } from '../api/_copy-review.js';
import { sendCall } from '../api/_send-call.js';

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };
const ids = o => o.packs.map(p => p.id);

console.log(`── Rulebook: ${RULE_PACKS.length} packs, ${RULE_PACKS.reduce((n, p) => n + p.rules, 0)} rules ──`);
check('core packs on every check', () => {
  const r = ids(selectRules({ channel: 'social', text: 'New lamp out now' }));
  assert.ok(r.includes('cap_core') && r.includes('cma_dmcca'));
  assert.ok(!r.includes('pecr_gdpr'), 'no PECR on social');
});
check('PECR for email', () => assert.ok(ids(selectRules({ channel: 'email', text: 'hi' })).includes('pecr_gdpr')));
check('finance sector gets FCA rules even without finance words', () => assert.ok(ids(selectRules({ sector: 'finance', channel: 'email', text: 'Spring newsletter' })).includes('finance')));
check('ecommerce brand selling gin gets the alcohol rules', () => assert.ok(ids(selectRules({ sector: 'ecommerce', channel: 'social', text: 'Our new gin is here, 20% off' })).includes('alcohol')));
check('crypto copy gets the investment rules', () => {
  const r = selectRules({ channel: 'social', text: 'Buy Bitcoin with zero fees' });
  assert.ok(ids(r).includes('finance_invest'));
  assert.match(r.block, /should not expect to be protected/);
});
check('weight-loss injection copy gets the medicines rules', () => assert.ok(ids(selectRules({ channel: 'social', text: 'Mounjaro weight loss jabs from £99' })).includes('health_medicines')));
check('credit copy gets CONC', () => assert.match(selectRules({ channel: 'email', text: 'Spread the cost: 0% finance, representative 19.9% APR' }).block, /CONC 3\.5/));
check('a prize draw gets the promotions rules', () => assert.ok(ids(selectRules({ channel: 'social', text: 'Win a weekend away! Enter now' })).includes('promotions')));
check('a PDF with nothing to read gets every pack', () => assert.equal(selectRules({ channel: 'document', unread: true }).packs.length, RULE_PACKS.filter(p => !p.channels || p.channels.includes('document')).length));
check('everyday shop copy does not pull in sector rules', () => {
  for (const t of ['Free returns within 30 days. Treat yourself to our new range.', 'Better together: our house blend coffee pods, flat £5 delivery', 'Terms and conditions apply. See our privacy policy.', 'Team spirit! Our winter package is here']) {
    const r = ids(selectRules({ channel: 'social', text: t })).filter(i => !['cap_core', 'cma_dmcca', 'consumer_terms'].includes(i));
    assert.deepEqual(r, [], `${t} → ${r.join(', ')}`);
  }
});
check('plain copy stays small', () => assert.ok(selectRules({ channel: 'social', text: 'Our cosiest jumper yet' }).packs.length <= 3));

console.log('\n── House rules ──');
const house = cleanHouseRules({
  banned: [{ phrase: 'guaranteed', severity: 'hold', reason: 'Legal: never guarantee results.' }, { phrase: 'cheapest', severity: 'fix' }, { phrase: 'x' }],
  disclaimers: [{ text: 'Capital at risk.', channels: [], whenContains: 'invest' }, { text: 'T&Cs apply. See site for details.', channels: ['email'] }],
  approved: [{ claim: 'Rated 4.8 on Trustpilot', evidence: 'Trustpilot page' }],
  notes: 'We are FCA authorised.',
});
check('cleaning drops a one-letter phrase', () => assert.equal(house.banned.length, 2));
check('a banned phrase marked hold holds the copy', () => {
  const f = houseFindings('Guaranteed results in 30 days', house, 'social');
  assert.equal(f.length, 1); assert.equal(f[0].severity, 'critical'); assert.equal(sendCall(f).verdict, 'hold');
});
check('a banned phrase needs whole words ("cheapest" not in "cheapestore")', () => assert.equal(houseFindings('Visit cheapestore.com', house, 'social').length, 0));
check('required wording only when its trigger word appears', () => {
  assert.equal(houseFindings('Our new savings app', house, 'social').length, 0);
  const f = houseFindings('Invest from £1 today', house, 'social');
  assert.equal(f.length, 1); assert.equal(f[0].severity, 'high');
});
check('required wording found despite curly quotes and line breaks', () => assert.equal(houseFindings('Invest today.\nCapital\nat risk.', house, 'social').length, 0));
check('a channel-only disclaimer is skipped on other channels', () => {
  assert.equal(houseFindings('Big sale', house, 'sms').length, 0);
  assert.equal(houseFindings('Big sale', house, 'email').length, 1);
});
check('no disclaimer findings when an image might hold the wording', () => assert.equal(houseFindings('Invest today', house, 'social', { disclaimers: false }).length, 0));
check('approved claim drops its evidence check', () => {
  assert.ok(isApprovedClaim({ requiresEvidence: true, location: '"Rated 4.8 on Trustpilot"', issue: 'Rating needs proof' }, house));
  assert.ok(!isApprovedClaim({ requiresEvidence: true, location: '"Rated 4.9 on Trustpilot"', issue: '' }, house));
});
check('house findings survive the review and keep their label', () => {
  const facts = copyFacts('social', 'Guaranteed results');
  const out = reviewFindings([], facts, { contextFindings: houseFindings('Guaranteed results', house, 'social') });
  assert.equal(out[0].regulation, 'Your house rules');
});
check('the AI is told about approved claims and notes', () => {
  const b = houseBlock(house);
  assert.match(b, /Rated 4\.8 on Trustpilot/); assert.match(b, /FCA authorised/);
});

console.log('\n── Sector citations are kept ──');
check('an FCA citation is not replaced by the CAP one', () => {
  const facts = copyFacts('social', 'Borrow £5,000 today');
  const out = reviewFindings([{ regulation: 'FCA CONC 3.5', severity: 'high', issue: 'No representative example', location: 'Headline', recommendation: 'Add it', requiresEvidence: false, issue_type: 'hidden_conditions' }], facts);
  assert.equal(out[0].regulation, 'FCA CONC 3.5');
});
check('a plain CAP finding still gets the checked citation', () => {
  const facts = copyFacts('social', 'Free gift');
  const out = reviewFindings([{ regulation: 'CAP 3.9', severity: 'high', issue: 'Conditions hidden', location: 'x', recommendation: 'y', requiresEvidence: false, issue_type: 'hidden_conditions' }], facts);
  assert.equal(out[0].regulation, 'CAP Code 3.9 / 3.10');
});
check('no opt-out finding on a brochure', () => {
  const out = reviewFindings([{ regulation: 'PECR', severity: 'critical', issue: 'No unsubscribe', location: 'x', recommendation: 'y', requiresEvidence: false, issue_type: 'opt_out_missing' }], copyFacts('document', 'Our range'));
  assert.equal(out.length, 0);
});

console.log('\n── Documents ──');
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), comp = deflateRawSync(data), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); centrals.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]).toString('base64');
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
check('Word text comes out paragraph by paragraph, entities decoded', () => {
  const d = readDocument({ name: 'b.docx', mediaType: DOCX, data: zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Save 50% &amp; more</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Ends </w:t></w:r><w:r><w:t>Sunday</w:t></w:r></w:p></w:body></w:document>', 'word/footer1.xml': '<w:ftr><w:p><w:r><w:t>Capital at risk.</w:t></w:r></w:p></w:ftr>' }) });
  assert.equal(d.kind, 'text'); assert.match(d.text, /Save 50% & more\nEnds Sunday/); assert.match(d.text, /Capital at risk\./);
});
check('PowerPoint slides come out in order', () => {
  const s = n => `<p:sld><a:p><a:r><a:t>Slide text ${n}</a:t></a:r></a:p></p:sld>`;
  const d = readDocument({ name: 'deck.pptx', mediaType: PPTX, data: zip({ 'ppt/slides/slide10.xml': s(10), 'ppt/slides/slide2.xml': s(2), 'ppt/slides/slide1.xml': s(1) }) });
  assert.equal(d.pages, 3); assert.ok(d.text.indexOf('Slide text 2') < d.text.indexOf('Slide text 10'));
});
check('a PDF is passed through whole', () => assert.equal(readDocument({ name: 'a.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') }).kind, 'pdf'));
check('a fake PDF is refused', () => assert.throws(() => readDocument({ name: 'a.pdf', mediaType: 'application/pdf', data: Buffer.from('hello').toString('base64') }), /doesn't look like a PDF/));
check('an old .doc is refused with a clear message', () => assert.throws(() => readDocument({ name: 'a.doc', mediaType: 'application/msword', data: 'AAAA' }), /save it as/));
check('a broken Word file is refused, not crashed', () => assert.throws(() => readDocument({ name: 'a.docx', mediaType: DOCX, data: Buffer.from('not a zip at all').toString('base64') }), /couldn't read/));
check('over 3MB is refused', () => assert.throws(() => readDocument({ name: 'a.pdf', mediaType: 'application/pdf', data: Buffer.alloc(3.2 * 1024 * 1024).toString('base64') }), /over 3MB/));

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
