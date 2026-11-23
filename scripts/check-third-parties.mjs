// node scripts/check-third-parties.mjs — checks the Third parties rules
// (api/_third-parties.js): only clear List health sources are added,
// and ad labels / claims are spotted in post text.
import assert from 'node:assert/strict';
import { sourceParty, checkPostText, assessPartner } from '../api/_third-parties.js';

const clear = { 'TopCashback': 'TopCashback', 'Partner: Bright Deals Ltd': 'Bright Deals Ltd', 'co-reg - SaveMore': 'SaveMore', 'influencer - Jess Taylor': 'Jess Taylor', 'Awin network': 'Awin' };
for (const [label, name] of Object.entries(clear)) assert.equal(sourceParty(label)?.name, name, label);
for (const vague of ['partner', 'Partner giveaway', 'Summer comp partner', 'Facebook lead gen', 'affiliate', 'Website footer', 'Giveaway Nov', 'import', 'Instagram influencer']) {
  assert.equal(sourceParty(vague), null, vague);
}
assert.equal(checkPostText('Love these trainers #ad').adLabel, true);
assert.equal(checkPostText('Love these trainers, the cheapest around').adLabel, false);
assert.ok(checkPostText('the best veg box in the UK').claims.length);
const stop = assessPartner({ PartnerName: 'X', RelationshipActivity: 'lead_generation', ConsentCheckResultJson: JSON.stringify({ result: 'fail' }) }, { profile: { revenueBand: '1m_10m', sector: 'ecommerce' } });
assert.equal(stop.verdict, 'stop');
assert.ok(stop.exposure.likely > 0);
console.log('Third parties rules: all checks passed');
