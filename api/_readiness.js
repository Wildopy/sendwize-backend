// ─────────────────────────────────────────────────────────────
// SENDWIZE — _readiness.js v1.1 (Nov 2026)
// v1.1: interactive rehearsal. Each item carries the dated records a
// member can attach to an answer (evidence), the open findings it would
// close (fixIds) and the steps to close it. findTrigger() names the thing
// in the member's own data most likely to start a case, beside the
// published case that began the same way. fineModel() lets the page
// recompute the likely ICO fine as gaps close.
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
import { loadRecentCampaigns } from './_memory.js';
import { CASES, caseOutcome, sameIssueTypes } from './_case-library.js';
import { areaOf, CLUSTER } from './_exposure.js';
import { COMPLAINT_LIMIT } from './_campaign-insights.js';

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
  const [profile, lists, optouts, suppression, sweeps, vendors, partners, affiliates, copyChecks, evidence, dossiers, campaigns] = await Promise.all([
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
    loadRecentCampaigns(userId).catch(() => []),
  ]);
  return { profile: profile[0]?.fields || {}, lists, optouts, suppression, sweeps, vendors, partners, affiliates, copyChecks, evidence, dossiers, campaigns };
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
        'list-intelligence.html', { at: last, evidence: ls.slice(0, 4).map(f => ({ label: `List check: "${f.ListName || 'List'}", ${(f.TotalContacts || 0).toLocaleString('en-GB')} contacts`, date: f.CheckDate, tool: 'List health' })) });
    }
  }

  // 2. Opt-outs honoured
  {
    const o = rec.optouts[0]?.fields || rec.suppression[0]?.fields;
    const open = openOf(['suppression_breach']);
    if (!o) add('optouts', ['ICO'], 'Proof that opt-outs are honoured across lists', 'missing', 'No opt-out or suppression check on record.', 'list-intelligence.html');
    else add('optouts', ['ICO'], 'Proof that opt-outs are honoured across lists', open.length ? 'partial' : (ageDays(o.CheckDate) <= FRESH.list ? 'available' : 'partial'),
      `Opt-outs last checked on ${fmtDate(o.CheckDate)}.` + (open.length ? ` ${plural(open.length, 'open finding')} about people who opted out still being on a list.` : ''),
      'list-intelligence.html', { at: o.CheckDate, evidence: [{ label: 'Opt-out check across your lists', date: o.CheckDate, tool: 'List health' }] });
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
      'site-sweep.html', { at: sw.at, evidence: [{ label: `Website sweep of ${sw.domain}` + (cat === 'cookies' && sw.guard ? ', with site guard records' : ''), date: sw.at, tool: 'Site sweep' }] });
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
      'vendor-checker.html', { evidence: ok.slice(0, 4).map(f => ({ label: `Agreement on file: ${f.VendorName || 'platform'}`, date: f.LastChecked || null, tool: 'Third parties' })) });
  }

  // 7. Partners and affiliates who send or collect for you
  {
    const ps = rec.partners.map(r => r.fields).filter(f => f.DataRelationship && f.DataRelationship !== 'none');
    const as = rec.affiliates.map(r => r.fields).filter(f => (f.AffiliateDataRole || 'unknown') !== 'no_mailing');
    const all = [...ps, ...as];
    if (all.length) {
      const ok = all.filter(f => f.ConsentChainVerified && (DPA_OK.includes(f.Article26Status) || DPA_OK.includes(f.DataAgreementStatus) || DPA_OK.includes(f.DPAStatus)));
      add('partner_chain', ['ICO'], 'Consent and agreements for partners and affiliates who market for you', ok.length === all.length ? 'available' : ok.length ? 'partial' : 'missing',
        `${ok.length} of ${plural(all.length, 'partner or affiliate')} have both the agreement and the consent wording confirmed.`, 'vendor-checker.html',
        { evidence: ok.slice(0, 4).map(f => ({ label: `Agreement and consent wording: ${f.PartnerName || f.AffiliateName || f.Name || 'partner'}`, date: null, tool: 'Third parties' })) });
    }
    const ads = [...rec.partners, ...rec.affiliates].map(r => r.fields).filter(f => /influencer|joint_ads|co_branded/.test(String(f.RelationshipActivity || f.AffiliateType || '').toLowerCase()));
    if (ads.length) {
      const rv = ads.filter(f => f.AdComplianceReviewed || f.MarketingMaterialsReviewed);
      add('partner_ads', ['ASA', 'CMA'], 'Checks on ads that partners and creators run for you', rv.length === ads.length ? 'available' : rv.length ? 'partial' : 'missing',
        `${rv.length} of ${plural(ads.length, 'partner or creator')} running ads for you have had their content reviewed.`, 'vendor-checker.html',
        { evidence: rv.slice(0, 4).map(f => ({ label: `Ad content reviewed: ${f.PartnerName || f.AffiliateName || f.Name || 'partner'}`, date: null, tool: 'Third parties' })) });
    }
  }

  // 8. Copy checked before it went out
  {
    const c = rec.copyChecks.map(r => r.fields);
    const recent = c.filter(f => ageDays(f.CheckDate) !== null && ageDays(f.CheckDate) <= FRESH.copy);
    add('copy_checks', ['ASA', 'CMA', 'ICO'], 'A record that ads and emails were checked before they went out', recent.length ? 'available' : c.length ? 'partial' : 'missing',
      c.length ? `${plural(c.length, 'copy check')} on record, ${recent.length} in the last ${FRESH.copy} days. Latest on ${fmtDate(c[0].CheckDate)}.` : 'No copy checks on record.',
      'ai-checker.html', { at: c[0]?.CheckDate, evidence: c.slice(0, 4).map(f => ({ label: `Copy check: ${f.FileName || 'marketing copy'}${f.Verdict ? ` (${f.Verdict})` : ''}`, date: f.CheckDate, tool: 'Copy checker' })) });
  }

  // 9. Evidence behind claims
  {
    const ev = rec.evidence.map(r => r.fields);
    const open = openOf(['misleading_claim', 'partner_pricing_claims', 'affiliate_misleading_claims']);
    add('claims_evidence', ['ASA', 'CMA'], 'Evidence for the claims you make ("best", "save", "proven", "eco")',
      ev.length && !open.length ? 'available' : ev.length || !open.length && rec.copyChecks.length ? 'partial' : 'missing',
      (ev.length ? `${plural(ev.length, 'claim')} confirmed as backed by evidence on file, latest on ${fmtDate(ev[0].CertifiedDate)}.` : 'No claims confirmed as backed by evidence.') +
      (open.length ? ` ${plural(open.length, 'claim')} still waiting for evidence.` : ''),
      'ai-checker.html', { at: ev[0]?.CertifiedDate, evidence: ev.slice(0, 4).map(f => ({ label: `Evidence confirmed: ${String(f.Issue || f.Regulation || 'claim').slice(0, 90)}`, date: f.CertifiedDate, tool: 'Copy checker' })) });
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
      'campaign-defence.html', { evidence: approved.sort((a, b) => String(b.ApprovedAt).localeCompare(String(a.ApprovedAt))).slice(0, 4).map(f => ({ label: `Campaign sign-off: ${f.CampaignTitle || 'campaign'}${f.ApprovedBy ? `, by ${String(f.ApprovedBy).split(' (')[0]}` : ''}`, date: f.ApprovedAt, tool: 'Campaign defence' })) });
  }

  // 11. Pricing and offers (CMA)
  {
    const d = rec.dossiers.map(r => r.fields).filter(f => f.PageScanAt);
    const open = openOf(['misleading_reference_price', 'fake_urgency']);
    add('pricing_records', ['CMA', 'ASA'], 'Records for "was" prices, discounts and deadlines',
      d.length && !open.length ? 'available' : d.length || !open.length && rec.copyChecks.length ? 'partial' : 'missing',
      (d.length ? `${plural(d.length, 'landing page scan')} on record, latest on ${fmtDate(d.map(f => f.PageScanAt).sort().pop())}.` : 'No landing pages scanned.') +
      (open.length ? ` ${plural(open.length, 'open finding')} about prices or deadlines.` : ''),
      'campaign-defence.html', { evidence: d.slice(0, 4).map(f => ({ label: `Landing page scan: ${f.CampaignTitle || 'campaign'}`, date: f.PageScanAt, tool: 'Campaign defence' })) });
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
      replies || said === 'Yes' ? 'campaign-defence.html' : 'profile.html',
      { evidence: replies ? [{ label: `${plural(replies, 'complaint reply')} drafted from campaign records`, date: null, tool: 'Campaign defence' }] : said === 'No' ? [{ label: 'Profile: no complaints received', date: null, tool: 'Your profile' }] : [] });
  }

  return linkFixes(items, pending).map(i => ({ ...i, evidence: i.evidence || [], close: CLOSE_STEPS[i.id] || null }));
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

// ── v1.1: what closes each gap ───────────────────────────────
// Open findings (fixType) that each record would answer. A finding goes
// to the first item that lists it, so it is never counted twice when the
// page recomputes the fine.
const ITEM_FIX_TYPES = [
  ['consent_records', [/^consent_/, /^no_consent$/, /^expired_consent$/, /^stale_consent/, 'invalid_consent_mechanism', 'third_party_list', 'no_soft_optin', 'soft_optin_no_optout', 'bundled_consent', 'form_consent_not_specific']],
  ['optouts', ['suppression_breach', 'suppression_not_synced', 'objection_not_synced', 'missing_unsubscribe', 'suppressed_contact']],
  ['privacy_notice', [/^privacy_/, 'legitimate_interest_abuse', 'purpose_creep', 'data_quality']],
  ['cookie_consent', [/^cookies?_/, 'custom_audience_no_basis']],
  ['signup_consent', [/^capture_/]],
  ['business_identity', [/^identity_/, 'missing_address', 'affiliate_sender_identity_breach', 'sender_identity_unclear', 'concealed_sender']],
  ['processor_dpas', ['dpa_breach', 'no_dpa']],
  ['partner_chain', ['no_article26_agreement', 'partner_no_data_sharing_agreement', 'no_data_sharing_agreement', 'affiliate_consent_unverified', 'lead_gen_consent_gap']],
  ['partner_ads', ['unreviewed_joint_ads', 'affiliate_ad_disclosure', 'affiliate_misleading_claims', 'partner_pricing_claims', 'partner_brand_risk']],
  ['claims_evidence', ['misleading_claim', 'asa_liability', 'fake_reviews', 'misleading_testimonial', 'unauthorised_health_claim', 'sector_risk_unreviewed']],
  ['pricing_records', ['misleading_reference_price', 'misleading_pricing', 'reference_pricing', 'drip_pricing', 'fake_urgency', 'fake_scarcity', 'urgency', 'stock_urgency', 'dark_pattern', 'missing_terms']],
  ['copy_checks', ['undisclosed_ad', 'ad_disclosure']],
];
const typeMatches = (t, pats) => pats.some(p => (p instanceof RegExp ? p.test(t) : p === t));
export function itemForFixType(fixType, present = null) {
  const t = String(fixType || '').toLowerCase();
  for (const [id, pats] of ITEM_FIX_TYPES) if ((!present || present.has(id)) && typeMatches(t, pats)) return id;
  return null;
}
function linkFixes(items, pending) {
  const present = new Set(items.map(i => i.id));
  const by = {};
  for (const f of pending) { const id = itemForFixType(f.fixType, present); if (id) (by[id] ||= []).push(f.id); }
  return items.map(i => ({ ...i, fixIds: by[i.id] || [] }));
}

// Steps to close each gap, in the member's words. `tool` is where they do it.
export const CLOSE_STEPS = {
  consent_records:   { tool: 'List health', steps: ['Export each list you market to from your email or SMS platform, with sign-up date and source.', 'Upload it to List health. It dates the check and shows who has no consent evidence.', 'Suppress the contacts it flags before your next send.'] },
  optouts:           { tool: 'List health', steps: ['Export your unsubscribes and suppression list from every platform you send from.', 'Run the opt-out check in List health so anyone who opted out on one list is caught on the others.', 'Add the suppress file it gives you to each platform.'] },
  privacy_notice:    { tool: 'Site sweep', steps: ['Check your privacy notice says you send marketing, on which channels, and how to opt out.', 'Link it from every sign-up form and your site footer.', 'Run Site sweep again so the fix is dated.'] },
  cookie_consent:    { tool: 'Site sweep', steps: ['Make sure tracking and ad tags only load after a visitor accepts.', 'Give "Reject" the same weight as "Accept" on your banner.', 'Run Site sweep again and turn on site guard to record consent on real visits.'] },
  signup_consent:    { tool: 'Site sweep', steps: ['Untick any marketing box that is ticked by default.', 'Ask separately for email and SMS, and say what people will get.', 'Run Site sweep again so the corrected forms are on record.'] },
  business_identity: { tool: 'Site sweep', steps: ['Show your company name, registered address and a contact email on your site.', 'Put the same details in the footer of every marketing email.', 'Run Site sweep again so it is dated.'] },
  processor_dpas:    { tool: 'Third parties', steps: ['List every platform that holds your customer data: email, SMS, CRM, ads.', 'Download each one\'s data processing agreement (most are on their legal page) and confirm it in Third parties.', 'Re-check any marked as missing.'] },
  partner_chain:     { tool: 'Third parties', steps: ['Ask each partner or affiliate who sends or collects for you for their consent wording and a signed data agreement.', 'Record both in Third parties.', 'Stop using data from any partner who can\'t provide them.'] },
  partner_ads:       { tool: 'Third parties', steps: ['Ask each creator or partner for the ads they run for you.', 'Check they are labelled as ads and the claims match yours.', 'Mark them reviewed in Third parties.'] },
  claims_evidence:   { tool: 'Copy checker', steps: ['Run your live ads and emails through the Copy checker.', 'For each claim it flags ("best", "save", "proven", "eco"), attach the evidence you hold.', 'Change or remove any claim you can\'t back up.'] },
  pricing_records:   { tool: 'Campaign defence', steps: ['Keep a dated record of the price you compare against and how long you charged it.', 'Make sure every deadline or "only X left" is true, and record when offers really end.', 'Scan the landing page in Campaign defence so it is on file.'] },
  copy_checks:       { tool: 'Copy checker', steps: ['Run the next ad or email through the Copy checker before it goes out.', 'Make that a habit: the dated check is your record.'] },
  campaign_records:  { tool: 'Campaign defence', steps: ['Open your next campaign in Campaign defence.', 'Attach the copy check, list check and landing page scan.', 'Have the person responsible approve it by name, so the evidence is frozen and dated.'] },
  complaints:        { tool: 'Campaign defence', steps: ['Record in your profile whether you have had complaints about your marketing.', 'When one arrives, paste it into Campaign defence to draft a reply from your records.'] },
};

// ── v1.1: the trigger ────────────────────────────────────────
// What in the member's own records would most likely start a case with
// this regulator, beside the published case that started the same way.
// `same` is true only where the case summary shows it began that way
// (spam reports, bought data...); otherwise it is the closest case on the
// same issue and the page says so.
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const caseOut = (c, why, same) => c && ({ id: c.id, name: c.name, regulator: c.regulator, date: c.date, penalty: c.penalty || null, outcome: caseOutcome(c), summary: c.summary, url: c.url || null, why, same });
function pickCase(regulator, fixType, { start = null, volume = null } = {}) {
  const types = sameIssueTypes(fixType);
  const pool = CASES.filter(c => c.regulator === regulator && c.types.some(t => types.includes(t)));
  if (!pool.length) return null;
  const v = Number(volume) || null;
  const gap = c => (v && c.volume ? Math.abs(Math.log10(c.volume) - Math.log10(v)) : 3);
  const rank = c => (start && start.test(c.summary || '') ? -10 : 0) + (c.curated ? -1 : 0) + (c.penalty ? -1 : 0) + 0.5 * gap(c);
  const best = [...pool].sort((a, b) => rank(a) - rank(b) || String(b.date).localeCompare(String(a.date)))[0];
  return { c: best, same: !!(start && start.test(best.summary || '')) };
}
const pctTxt = x => (x * 100).toFixed(2) + '%';

export function findTrigger(rec, pending, regulator) {
  const mine = pending.filter(f => f.exposure?.category === regulator).sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4));
  const fromFinding = f => {
    const p = pickCase(regulator, f.fixType, { volume: f.contactVolume });
    const what = String(f.description || '').replace(/\s+/g, ' ').trim();
    return {
      kind: 'finding', fixType: f.fixType, severity: f.severity || null, itemId: itemForFixType(f.fixType),
      title: what ? (what.length > 180 ? what.slice(0, 177) + '…' : what) : `An open ${String(f.fixType).replace(/_/g, ' ')} finding`,
      source: `Open ${f.severity || ''} finding from ${f.tool || 'Sendwize'}`.replace(/\s+/g, ' '), at: f.createdDate || null,
      starts: regulator === 'ASA' ? 'Most ASA cases start with one complaint from a customer or a competitor about an ad like this.'
        : regulator === 'CMA' ? 'The CMA sweeps whole sectors for practices like this, without waiting for a complaint.'
        : 'ICO cases usually start with complaints from the people on the receiving end.',
      case: p ? caseOut(p.c, `Published ${p.c.regulator} case on the same issue`, false) : null,
    };
  };

  if (regulator === 'ICO') {
    // 1. A send over the 0.3% spam-complaint limit
    const sends = (rec.campaigns || []).map(c => {
      const base = c.delivered_count || c.volume_sent;
      return { ...c, base, rate: c.complaint_count != null && base ? c.complaint_count / base : null };
    }).filter(c => c.rate != null && c.rate >= COMPLAINT_LIMIT).sort((a, b) => b.rate - a.rate);
    if (sends[0]) {
      const s = sends[0];
      const p = pickCase('ICO', 'consent_missing', { start: /spam report|complain/i, volume: s.base });
      return {
        kind: 'complaints', fixType: 'consent_missing', itemId: 'consent_records',
        title: `"${s.campaign_name || 'Campaign'}" drew ${Number(s.complaint_count).toLocaleString('en-GB')} spam complaints from ${Number(s.base).toLocaleString('en-GB')} people (${pctTxt(s.rate)}), over the 0.3% limit.`,
        source: `Audience read, sent ${fmtDate(s.date)}${sends.length > 1 ? `. ${sends.length - 1} more send${sends.length > 2 ? 's' : ''} also went over` : ''}`, at: s.date,
        starts: 'People who mark your email as spam can also report it to the ICO. Spam reports are how most ICO marketing cases begin.',
        case: p ? caseOut(p.c, p.same ? 'Started the same way: with spam reports from recipients' : 'Published ICO case on the same issue', p.same) : null,
      };
    }
    // 2. Bought or partner contacts, 3. people who opted out still on a list
    for (const [code, fixType, start, label, why] of [
      ['third_party', 'third_party_list', /partner|bought|third.part|list|data broker|purchas/i, 'bought or partner contacts', 'Started the same way: marketing to data bought or shared by other companies'],
      ['leak', 'suppression_breach', /asked it to stop|opted out|unsubscrib|objected/i, 'people who had already opted out', 'Started the same way: people contacted after asking it to stop'],
    ]) {
      const hit = rec.lists.map(r => ({ f: r.fields, ins: json(r.fields.Results, {})?.insights })).find(x => (x.ins?.reasonCounts?.[code] || 0) > 0);
      if (hit) {
        const n = hit.ins.reasonCounts[code];
        const p = pickCase('ICO', fixType, { start, volume: hit.f.TotalContacts });
        return {
          kind: code, fixType, itemId: code === 'leak' ? 'optouts' : 'consent_records',
          title: `${n.toLocaleString('en-GB')} contacts on "${hit.f.ListName || 'your list'}" are ${label}.`,
          source: `List health check on ${fmtDate(hit.f.CheckDate)}`, at: hit.f.CheckDate,
          starts: 'The first time one of these people complains, the ICO asks how you got their details and when they agreed to hear from you.',
          case: p ? caseOut(p.c, p.same ? why : 'Published ICO case on the same issue', p.same) : null,
        };
      }
    }
  }
  if (regulator === 'CMA') {
    // The CMA also acts on pricing and urgency findings the copy checker files under ASA
    const pricing = pending.filter(f => ['misleading_reference_price', 'drip_pricing', 'fake_urgency', 'fake_reviews', 'partner_pricing_claims'].some(t => sameIssueTypes(f.fixType).includes(t)))
      .sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4));
    const f = mine[0] || pricing[0];
    if (f) return fromFinding(f);
  } else if (mine[0]) return fromFinding(mine[0]);

  return {
    kind: 'none', fixType: null, itemId: null,
    title: 'Nothing in your records stands out as the thing that would start a case.',
    source: 'Every Sendwize record we hold for you', at: null,
    starts: regulator === 'ASA' ? 'So this rehearsal starts the way most ASA cases do: one complaint about one of your ads.'
      : regulator === 'CMA' ? 'So this rehearsal starts the way the CMA usually does: a sweep of businesses in your sector.'
      : 'So this rehearsal starts the way most ICO cases do: a complaint from someone on your list.',
    case: null,
  };
}

// ── v1.1: the fine model the page recomputes as gaps close ───
// ICO only: the same clustering as _exposure.js clusterExposure(), with
// each finding's range, so removing the findings a gap would close gives
// the new figure. ASA never fines; CMA shows the legal maximum only.
export function fineModel(pending, regulator, cmaMax = null) {
  if (regulator === 'ASA') return { kind: 'none' };
  if (regulator === 'CMA') return { kind: 'max', max: cmaMax || null };
  const fixes = pending.filter(f => f.exposure?.category === 'ICO' && f.exposure?.hasRange).map(f => ({
    id: f.id, area: areaOf(f.fixType), low: Math.round(f.exposure.realisticLow || 0), high: Math.round(f.exposure.realisticHigh || 0), likely: Math.round(f.exposure.mostLikely || 0),
  }));
  return { kind: 'range', share: CLUSTER.otherShare, cap: CLUSTER.cap, fixes };
}
// Same maths as the page, for tests and the saved record
export function fineFrom(model, closedFixIds = []) {
  if (!model || model.kind !== 'range') return null;
  const shut = new Set(closedFixIds), groups = {};
  for (const f of model.fixes) if (!shut.has(f.id)) (groups[f.area] ||= []).push(f);
  let low = 0, high = 0, likely = 0;
  for (const list of Object.values(groups)) {
    const s = [...list].sort((a, b) => b.high - a.high), lead = s[0], rest = s.slice(1);
    const sum = k => rest.reduce((t, f) => t + f[k], 0);
    low += Math.min(lead.low * model.cap, lead.low + model.share * sum('low'));
    high += Math.min(lead.high * model.cap, lead.high + model.share * sum('high'));
    likely += Math.min(lead.likely * model.cap, lead.likely + model.share * sum('likely'));
  }
  const nice = v => (v >= 10000 ? Math.round(v / 1000) * 1000 : Math.round(v / 100) * 100);
  return { low: Math.round(low), high: Math.round(high), likely: nice(likely), open: Object.values(groups).reduce((n, g) => n + g.length, 0) };
}
