// ─────────────────────────────────────────────────────────────
// SENDWIZE — _readiness.js v1.0 (Nov 2026)
// "Could you answer the regulator today?"
//
// Builds the evidence a regulator would ask for (ICO, ASA or CMA) from
// the records Sendwize already holds for a member, and marks each item
// Ready / Partly / Missing with the date and the tool it came from.
// Deterministic: no AI. Same records in, same answer out.
//
// Used by the Regulator simulator (data.js simulation-run) for the
// background check, the document checklist, the answer under each letter
// question, the readiness score and the response pack.
//
// Every table and field is read defensively: a missing table or field
// means "no record", never a crash.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const DAY = 86400000;
const FRESH = { list: 90, sweep: 90, copy: 90, campaign: 180, vendor: 365 };
const DPA_OK = ['Confirmed', 'Confirmed and signed', 'In place'];

async function list(table, formula, { sort = null, max = 50 } = {}) {
  let url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort) url += `&sort%5B0%5D%5Bfield%5D=${encodeURIComponent(sort)}&sort%5B0%5D%5Bdirection%5D=desc`;
  try {
    const r = await atFetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (r.ok) return (await r.json()).records || [];
    // A sort field that doesn't exist yet: try once without sorting
    if (sort && r.status === 422) return list(table, formula, { max });
    return [];
  } catch { return []; }
}

const json = (s, fb) => { try { return JSON.parse(s || ''); } catch { return fb; } };
const ageDays = d => (d ? Math.floor((Date.now() - new Date(d)) / DAY) : null);
export function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── Gather every record we use, in parallel ──────────────────
export async function gatherRecords(userId) {
  const u = `{UserID}='${esc(userId)}'`;
  const [profile, lists, optouts, suppression, sweeps, vendors, partners, affiliates, copyChecks, evidence, dossiers] = await Promise.all([
    list('User_Profile', u, { max: 1 }),
    list('List_Intelligence_Checks', u, { sort: 'CheckDate', max: 20 }),
    list('List_Optouts', u, { sort: 'CheckDate', max: 5 }),
    list('Suppression_Checks', u, { sort: 'CheckDate', max: 5 }),
    list('Site_Sweeps', u, { max: 10 }),
    list('Vendor_Register', u, { max: 100 }),
    list('Partner_Register', u, { max: 100 }),
    list('Affiliate_Register', u, { max: 100 }),
    list('AI_Compliance_Checks', u, { sort: 'CheckDate', max: 50 }),
    list('Evidence_Certifications', u, { sort: 'CertifiedDate', max: 100 }),
    list('Campaign_Dossiers', u, { max: 100 }),
  ]);
  return { profile: profile[0]?.fields || {}, lists, optouts, suppression, sweeps, vendors, partners, affiliates, copyChecks, evidence, dossiers };
}

// Latest finished sweep on a verified domain
function latestSweep(sweeps) {
  const done = sweeps.filter(s => s.fields.VerifiedAt && s.fields.SweepJson)
    .sort((a, b) => String(b.fields.LastSweptAt || '').localeCompare(String(a.fields.LastSweptAt || '')));
  if (!done[0]) return null;
  return { domain: done[0].fields.Domain, at: done[0].fields.LastSweptAt, guard: !!done[0].fields.GuardEnabledAt, data: json(done[0].fields.SweepJson, {}) };
}
const sweepFindings = (sw, cat) => (sw?.data?.findings || []).filter(f => f.category === cat);

// ── The checklist ────────────────────────────────────────────
// status: 'available' | 'partial' | 'missing'. `tool` is the page that
// fills the gap. `regs` lists the regulators who would ask for it.
export function buildChecklist(rec, pending = []) {
  const items = [];
  const add = (id, regs, name, status, detail, tool, extra = {}) => items.push({ id, regs, name, status, detail, tool, ...extra });
  const p = rec.profile;
  const openOf = types => pending.filter(f => types.includes(f.fixType));

  // 1. Consent records for the people you market to
  {
    const latest = {};
    for (const r of rec.lists) { const n = r.fields.ListName || 'List'; if (!latest[n]) latest[n] = r.fields; }
    const ls = Object.values(latest);
    const fresh = ls.filter(f => ageDays(f.CheckDate) !== null && ageDays(f.CheckDate) <= FRESH.list);
    const total = ls.reduce((s, f) => s + (f.TotalContacts || 0), 0);
    const weak = ls.reduce((s, f) => s + (f.LiabilityCount || 0), 0);
    const pct = total ? Math.round((weak / total) * 100) : 0;
    if (!ls.length) {
      add('consent_records', ['ICO'], 'Consent records for everyone you email or text', p.ConsentRecords === 'all' ? 'partial' : 'missing',
        p.ConsentRecords === 'all' ? 'Your profile says you keep opt-in records, but no list has been checked in Sendwize, so there is nothing dated to show.' : 'No list has been checked, so there is no record of when and how people opted in.',
        'list-intelligence.html');
    } else {
      const last = ls.map(f => f.CheckDate).sort().pop();
      const ok = fresh.length === ls.length && pct <= 10 && p.ConsentRecords !== 'none';
      add('consent_records', ['ICO'], 'Consent records for everyone you email or text', ok ? 'available' : 'partial',
        `${plural(ls.length, 'list')} checked, last on ${fmtDate(last)}: ${total.toLocaleString('en-GB')} contacts, ${pct}% without strong consent evidence.` +
        (fresh.length < ls.length ? ` ${plural(ls.length - fresh.length, 'list')} not re-checked in the last ${FRESH.list} days.` : ''),
        'list-intelligence.html', { at: last });
    }
  }

  // 2. Opt-outs honoured
  {
    const o = rec.optouts[0]?.fields || rec.suppression[0]?.fields;
    const open = openOf(['suppression_breach']);
    if (!o) add('optouts', ['ICO'], 'Proof that opt-outs are honoured across lists', 'missing', 'No opt-out or suppression check on record.', 'list-intelligence.html');
    else add('optouts', ['ICO'], 'Proof that opt-outs are honoured across lists', open.length ? 'partial' : (ageDays(o.CheckDate) <= FRESH.list ? 'available' : 'partial'),
      `Opt-outs last checked on ${fmtDate(o.CheckDate)}.` + (open.length ? ` ${plural(open.length, 'open finding')} about people who opted out still being on a list.` : ''),
      'list-intelligence.html', { at: o.CheckDate });
  }

  // 3–5. Website: privacy notice, cookies, sign-up forms, business identity
  const sw = latestSweep(rec.sweeps);
  const siteItem = (id, regs, name, cat, worst) => {
    if (!sw) return add(id, regs, name, 'missing', 'Your website hasn\'t been swept, so there is no dated record of what it shows.', 'site-sweep.html');
    const f = sweepFindings(sw, cat);
    const bad = f.filter(x => worst.includes(x.checkId || x.key));
    const stale = ageDays(sw.at) > FRESH.sweep;
    const status = bad.length ? 'missing' : f.length || stale ? 'partial' : 'available';
    add(id, regs, name, status,
      `${sw.domain} swept on ${fmtDate(sw.at)}: ` + (f.length ? f.slice(0, 2).map(x => x.title).join('; ') + (f.length > 2 ? ` and ${f.length - 2} more` : '') + '.' : 'nothing flagged.') +
      (stale ? ` Last sweep is over ${FRESH.sweep} days old.` : '') + (cat === 'cookies' && sw.guard ? ' Site guard is recording consent on real visits.' : ''),
      'site-sweep.html', { at: sw.at });
  };
  siteItem('privacy_notice', ['ICO', 'CMA'], 'Privacy notice that explains your marketing', 'privacy', ['privacy_no_notice', 'privacy_notice_unreachable']);
  siteItem('cookie_consent', ['ICO'], 'Cookie consent before tracking', 'cookies', ['cookies_trackers_before_consent', 'cookies_no_consent_banner']);
  siteItem('signup_consent', ['ICO'], 'Sign-up forms that ask for consent properly', 'capture', ['capture_pre_ticked']);
  siteItem('business_identity', ['CMA', 'ICO'], 'Who you are and how to contact you', 'identity', []);

  // 6. Processor agreements (ESP, CRM, SMS provider…)
  {
    const v = rec.vendors.map(r => r.fields);
    const ok = v.filter(f => DPA_OK.includes(f.DPAStatus || f.AgreementStatus));
    if (!v.length) add('processor_dpas', ['ICO'], 'Agreements with the platforms that hold your data (Article 28)', 'missing', 'No platforms recorded. Every email or SMS tool you use processes your customers\' data and needs an agreement on file.', 'vendor-checker.html');
    else add('processor_dpas', ['ICO'], 'Agreements with the platforms that hold your data (Article 28)', ok.length === v.length ? 'available' : ok.length ? 'partial' : 'missing',
      `${ok.length} of ${plural(v.length, 'platform')} have a confirmed agreement on file.` + (ok.length < v.length ? ` Missing: ${v.filter(f => !ok.includes(f)).slice(0, 3).map(f => f.VendorName).filter(Boolean).join(', ')}.` : ''),
      'vendor-checker.html');
  }

  // 7. Partners and affiliates who send or collect for you
  {
    const ps = rec.partners.map(r => r.fields).filter(f => f.DataRelationship && f.DataRelationship !== 'none');
    const as = rec.affiliates.map(r => r.fields).filter(f => (f.AffiliateDataRole || 'unknown') !== 'no_mailing');
    const all = [...ps, ...as];
    if (all.length) {
      const ok = all.filter(f => f.ConsentChainVerified && (DPA_OK.includes(f.Article26Status) || DPA_OK.includes(f.DataAgreementStatus) || DPA_OK.includes(f.DPAStatus)));
      add('partner_chain', ['ICO'], 'Consent and agreements for partners and affiliates who market for you', ok.length === all.length ? 'available' : ok.length ? 'partial' : 'missing',
        `${ok.length} of ${plural(all.length, 'partner or affiliate')} have both the agreement and the consent wording confirmed.`, 'vendor-checker.html');
    }
    const ads = [...rec.partners, ...rec.affiliates].map(r => r.fields).filter(f => /influencer|joint_ads|co_branded/.test(String(f.RelationshipActivity || f.AffiliateType || '').toLowerCase()));
    if (ads.length) {
      const rv = ads.filter(f => f.AdComplianceReviewed || f.MarketingMaterialsReviewed);
      add('partner_ads', ['ASA', 'CMA'], 'Checks on ads that partners and creators run for you', rv.length === ads.length ? 'available' : rv.length ? 'partial' : 'missing',
        `${rv.length} of ${plural(ads.length, 'partner or creator')} running ads for you have had their content reviewed.`, 'vendor-checker.html');
    }
  }

  // 8. Copy checked before it went out
  {
    const c = rec.copyChecks.map(r => r.fields);
    const recent = c.filter(f => ageDays(f.CheckDate) !== null && ageDays(f.CheckDate) <= FRESH.copy);
    add('copy_checks', ['ASA', 'CMA', 'ICO'], 'A record that ads and emails were checked before they went out', recent.length ? 'available' : c.length ? 'partial' : 'missing',
      c.length ? `${plural(c.length, 'copy check')} on record, ${recent.length} in the last ${FRESH.copy} days. Latest on ${fmtDate(c[0].CheckDate)}.` : 'No copy checks on record.',
      'ai-checker.html', { at: c[0]?.CheckDate });
  }

  // 9. Evidence behind claims
  {
    const ev = rec.evidence.map(r => r.fields);
    const open = openOf(['misleading_claim', 'partner_pricing_claims', 'affiliate_misleading_claims']);
    add('claims_evidence', ['ASA', 'CMA'], 'Evidence for the claims you make ("best", "save", "proven", "eco")',
      ev.length && !open.length ? 'available' : ev.length || !open.length && rec.copyChecks.length ? 'partial' : 'missing',
      (ev.length ? `${plural(ev.length, 'claim')} confirmed as backed by evidence on file, latest on ${fmtDate(ev[0].CertifiedDate)}.` : 'No claims confirmed as backed by evidence.') +
      (open.length ? ` ${plural(open.length, 'claim')} still waiting for evidence.` : ''),
      'ai-checker.html', { at: ev[0]?.CertifiedDate });
  }

  // 10. Campaign sign-off records
  {
    const d = rec.dossiers.map(r => r.fields);
    const approved = d.filter(f => f.ApprovedAt);
    const recent = approved.filter(f => ageDays(f.ApprovedAt) <= FRESH.campaign);
    const signed = approved.filter(f => json(f.SignoffJson, null)?.decision === 'approved' || f.ApprovedBy);
    add('campaign_records', ['ASA', 'CMA', 'ICO'], 'Dated sign-off for each campaign, with what was checked',
      recent.length ? 'available' : approved.length ? 'partial' : 'missing',
      approved.length ? `${plural(approved.length, 'campaign')} approved with frozen evidence${signed.length ? `, ${signed.length} signed off by name` : ''}. Latest on ${fmtDate(approved.map(f => f.ApprovedAt).sort().pop())}.` : d.length ? `${plural(d.length, 'campaign')} started but none approved yet.` : 'No campaign records.',
      'campaign-defence.html');
  }

  // 11. Pricing and offers (CMA)
  {
    const d = rec.dossiers.map(r => r.fields).filter(f => f.PageScanAt);
    const open = openOf(['misleading_reference_price', 'fake_urgency']);
    add('pricing_records', ['CMA', 'ASA'], 'Records for "was" prices, discounts and deadlines',
      d.length && !open.length ? 'available' : d.length || !open.length && rec.copyChecks.length ? 'partial' : 'missing',
      (d.length ? `${plural(d.length, 'landing page scan')} on record, latest on ${fmtDate(d.map(f => f.PageScanAt).sort().pop())}.` : 'No landing pages scanned.') +
      (open.length ? ` ${plural(open.length, 'open finding')} about prices or deadlines.` : ''),
      'campaign-defence.html');
  }

  // 12. Complaints
  {
    const replies = rec.dossiers.reduce((n, r) => n + (json(r.fields.ComplaintsJson, []) || []).length, 0);
    const said = p.ComplaintsReceived;
    add('complaints', ['ICO', 'ASA', 'CMA'], 'How you handle complaints about your marketing',
      said === 'No' || (said === 'Yes' && replies) ? 'available' : 'partial',
      said === 'No' ? 'Your profile says no complaints received. Campaign defence will draft a reply from your records if one arrives.'
        : said === 'Yes' ? (replies ? `${plural(replies, 'complaint reply')} drafted from your campaign records.` : 'Your profile says you have had complaints, but no reply is recorded in Sendwize.')
        : 'Complaints history not recorded in your profile.',
      replies || said === 'Yes' ? 'campaign-defence.html' : 'profile.html');
  }

  return items;
}

export const STATUS_WEIGHT = { available: 1, partial: 0.5, missing: 0 };
export function readinessScore(items) {
  if (!items.length) return 0;
  return Math.round(items.reduce((s, i) => s + STATUS_WEIGHT[i.status], 0) / items.length * 100);
}
export function readinessLabel(score) {
  return score >= 80 ? 'Ready to respond' : score >= 50 ? 'Partly ready' : 'Not ready yet';
}

// The background check a regulator does first (stage 1)
export function backgroundChecks(rec, pending, regulator) {
  const p = rec.profile, out = [];
  const mine = pending.filter(f => f.exposure?.category === regulator);
  const crit = mine.filter(f => f.severity === 'critical').length;
  out.push({ label: 'Previous contact from a regulator', status: p.PriorRegulatorContact === 'Yes' ? 'red' : p.PriorRegulatorContact === 'No' ? 'green' : 'amber',
    detail: p.PriorRegulatorContact === 'Yes' ? 'You have had regulator contact before. Investigators check history first.' : p.PriorRegulatorContact === 'No' ? 'No previous regulator contact recorded.' : 'Not recorded in your profile.' });
  out.push({ label: 'Complaints about your marketing', status: p.ComplaintsReceived === 'Yes' ? 'amber' : p.ComplaintsReceived === 'No' ? 'green' : 'amber',
    detail: p.ComplaintsReceived === 'Yes' ? 'Complaints are the most common reason a case is opened.' : p.ComplaintsReceived === 'No' ? 'No complaints recorded.' : 'Not recorded in your profile.' });
  out.push({ label: `Open ${regulator} findings in Sendwize`, status: crit ? 'red' : mine.length ? 'amber' : 'green',
    detail: mine.length ? `${plural(mine.length, 'open finding')}${crit ? `, ${crit} critical` : ''}.` : 'Nothing open for this regulator.' });
  if (regulator === 'ICO') {
    const sw = latestSweep(rec.sweeps);
    out.push({ label: 'What your website shows a visitor', status: !sw ? 'amber' : sweepFindings(sw, 'cookies').length || sweepFindings(sw, 'privacy').length ? 'amber' : 'green',
      detail: sw ? `${sw.domain} last swept on ${fmtDate(sw.at)}, site score ${sw.data.score ?? 'n/a'}.` : 'Website not swept yet.' });
  }
  if (p.Sector && /finance|health|gambling/i.test(p.Sector)) out.push({ label: 'Sector', status: 'amber', detail: `${p.Sector} gets closer attention from regulators.` });
  return out;
}

// What to say in reply (stage 5): strengths first, then gaps to close
export function representations(items) {
  const good = items.filter(i => i.status === 'available').slice(0, 3).map(i => `Point to your record: ${i.name.toLowerCase()}. ${i.detail}`);
  const gaps = items.filter(i => i.status !== 'available').slice(0, 3).map(i => `${i.status === 'missing' ? 'Close this gap before you reply' : 'Bring this up to date'}: ${i.name.toLowerCase()}.`);
  return [...good, ...gaps, 'Reply within the deadline, keep it factual, and show what you have changed since. This is not legal advice: for a real letter, speak to a solicitor.'];
}
