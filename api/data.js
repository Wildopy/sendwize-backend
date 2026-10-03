// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v7.5
// Commercial Relationships & Risk Register
//
// v7.5 changes (from v7.3.1):
//   + Vendor intelligence: prefillFromKnownVendor auto-fills from
//     Marketing_Vendors on create. assessUnknownVendor runs Claude
//     + web search for vendors not in curated list.
//   + Deterministic scoring: calculateVendorScore + buildScoreBreakdown
//     produce explainable 100-point score from 6 weighted components.
//   + Enforcement relevance filter: getRelevantEnforcement replaces
//     crude word-match with Claude entity/relevance verification.
//   + Partner enforcement: handlePartnerRegister uses relevance filter.
//   + Competitor claim cross-ref: matches competitor ruling types
//     against user's active Campaign Defence claim types.
//   + Monitoring: buildAlerts processor section adds score-based alerts.
//   + New Airtable fields: IntelligenceJson, ScoreBreakdownJson,
//     EnforcementRelevanceJson on Vendor_Register and Partner_Register.
//
// v7.3.1 preserved: handleRelationshipWatch response-building restored.
// v7.3 preserved: partner/affiliate ASA/CAP/CMA dimensions.
// ─────────────────────────────────────────────────────────────

import { atFetch } from './_airtable.js';

const APP_URL     = 'https://sendwize-backend.vercel.app';
const RESEND_FROM = 'alerts@sendwize.co.uk';

// ── Airtable helpers ──────────────────────────────────────────
function atHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function atGet(base, table, formula, sort, max = 50) {
  let url = `${base}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: atHeaders(process.env.AIRTABLE_TOKEN) });
  if (!r.ok) throw new Error(`Airtable GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}
async function atCreate(base, table, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
    body: JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable POST ${table}: ${r.status}`); }
  return (await r.json()).records?.[0];
}
async function atPatch(base, table, recordId, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
    body: JSON.stringify({ fields: clean }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable PATCH ${table}: ${r.status}`); }
  return await r.json();
}
async function atDelete(base, table, recordId) {
  const r = await atFetch(`${base}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'DELETE',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable DELETE ${table}: ${r.status}`); }
  return await r.json();
}

function airtableBase() {
  return `https://api.airtable.com/v0/${process.env.BASE_ID}`;
}

// ── Timeout wrapper for Claude API calls ──────────────────────
function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after ' + ms + 'ms')), ms)),
  ]);
}

// ── DPA status check helper ───────────────────────────────────
const DPA_CONFIRMED = ['Confirmed', 'Confirmed and signed', 'In place'];
function isDPAConfirmed(status) {
  return DPA_CONFIRMED.includes(status || '');
}

// Apply a default only when creating. On update, a missing value means "leave untouched".
function withDefaults(isCreate) {
  return (value, fallback) =>
    (value !== undefined && value !== null && value !== '') ? value : (isCreate ? fallback : undefined);
}

// ── Third-party risk score (v7.3 — ad compliance dimensions) ──
async function calculateThirdPartyScore(userId, base) {
  const [processors, partners, affiliates, profile] = await Promise.all([
    atGet(base, 'Vendor_Register',   `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Partner_Register',  `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Affiliate_Register',`{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'User_Profile',      `{UserID}='${userId}'`, '', 1).catch(() => []),
  ]);

  function processorCategoryScore(records) {
    if (!records.length) return null;
    const noDPA  = records.filter(r => !isDPAConfirmed(r.fields.DPAStatus || r.fields.AgreementStatus)).length;
    const hiRisk = records.filter(r => r.fields.ICORiskLevel === 'High').length;
    const stale  = records.filter(r => {
      const d = r.fields.LastChecked || r.fields.LastAutoChecked;
      return d && Math.floor((Date.now() - new Date(d)) / 86400000) > 90;
    }).length;
    const dpaGap   = (noDPA / records.length)  * 50;
    const riskGap  = (hiRisk / records.length) * 30;
    const staleGap = (stale / records.length)  * 20;
    return Math.max(0, Math.round(100 - dpaGap - riskGap - staleGap));
  }

  function partnerCategoryScore(records) {
    if (!records.length) return null;
    const noA26   = records.filter(r => !isDPAConfirmed(r.fields.Article26Status)).length;
    const noChain = records.filter(r => !r.fields.ConsentChainVerified).length;
    const flagged = records.filter(r => r.fields.BrandSafetyFlag).length;
    const noAdReview = records.filter(r => {
      const activity = r.fields.RelationshipActivity || '';
      const needsReview = ['joint_ads', 'co_branded_content', 'influencer'].includes(activity);
      return needsReview && !r.fields.AdComplianceReviewed;
    }).length;
    const a26Gap    = (noA26 / records.length)       * 40;
    const chainGap  = (noChain / records.length)     * 20;
    const brandGap  = (flagged / records.length)     * 15;
    const adGap     = (noAdReview / records.length)  * 25;
    return Math.max(0, Math.round(100 - a26Gap - chainGap - brandGap - adGap));
  }

  function affiliateCategoryScore(records) {
    if (!records.length) return null;
    const noDPA        = records.filter(r => !isDPAConfirmed(r.fields.DPAStatus)).length;
    const noConsent    = records.filter(r => !r.fields.ConsentChainVerified).length;
    const noSenderID   = records.filter(r => r.fields.SenderIdentityCompliant === 'Unverified').length;
    const noMaterials  = records.filter(r => !r.fields.MarketingMaterialsReviewed).length;
    const consentGap   = (noConsent / records.length)    * 35;
    const materialsGap = (noMaterials / records.length)  * 25;
    const senderGap    = (noSenderID / records.length)   * 20;
    const dpaGap       = (noDPA / records.length)        * 20;
    return Math.max(0, Math.round(100 - consentGap - materialsGap - senderGap - dpaGap));
  }

  const proc = processorCategoryScore(processors);
  const part = partnerCategoryScore(partners);
  const aff  = affiliateCategoryScore(affiliates);

  const applicable = [proc, part, aff].filter(s => s !== null);
  const total = applicable.length
    ? Math.round(applicable.reduce((a,b) => a+b, 0) / applicable.length)
    : null;

  const lastReview = profile[0]?.fields?.LastIntelligenceFeedReview || null;
  const daysSinceReview = lastReview
    ? Math.floor((Date.now() - new Date(lastReview)) / 86400000)
    : null;

  return {
    total,
    applicableCount: applicable.length,
    breakdown: {
      processors: { score: proc, count: processors.length, applicable: proc !== null },
      partners:   { score: part, count: partners.length,   applicable: part !== null },
      affiliates: { score: aff,  count: affiliates.length, applicable: aff !== null },
    },
    intelligence: {
      lastReviewDate: lastReview,
      daysSinceReview,
      reviewedThisWeek: daysSinceReview !== null && daysSinceReview <= 7,
    },
  };
}

// ── Cross-reference violations for a named entity ─────────────
async function getViolationsForName(base, name) {
  if (!name) return [];
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return [];
  const formula = `OR(${words.map(w => `FIND('${w}',LOWER({CompanyName}))`).join(',')})`;
  return atGet(base, 'Violation_Database', formula, 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 10).catch(() => []);
}

// ── Vendor intelligence: pre-fill from Marketing_Vendors ─────
async function prefillFromKnownVendor(base, vendorName, fields) {
  if (!vendorName) return fields;
  const known = await atGet(base, 'Marketing_Vendors',
    `FIND('${vendorName.toLowerCase().replace(/'/g,"\\'")}',LOWER({VendorName}))`, '', 1
  ).catch(() => []);
  if (!known.length) return fields;
  const k = known[0].fields;
  if (!fields.DPAStatus && k.DPAStatus) fields.DPAStatus = k.DPAStatus;
  if (!fields.PrivacyPolicyUrl && k.PrivacyPolicyUrl) fields.PrivacyPolicyUrl = k.PrivacyPolicyUrl;
  if (!fields.TransferDestination && k.TransferDestination) fields.TransferDestination = k.TransferDestination;
  if (!fields.ICORiskLevel) fields.ICORiskLevel = k.ICORiskLevel || 'Low';
  const intel = {
    source: 'sendwize_curated',
    vendorLegalName: k.VendorLegalName || vendorName,
    icoRegistered: k.ICORegistered || 'Unknown',
    icoRegistrationNumber: k.ICORegistrationNumber || null,
    dpaStatus: k.DPAStatus || 'Unknown',
    dpaUrl: k.PrivacyPolicyUrl || null,
    transferMechanism: k.TransferMechanism || k.TransferMechanismConfirmed || null,
    transferDestination: k.TransferDestination || null,
    breachHistory: k.BreachHistory || 'None publicly disclosed.',
    certifications: k.Certifications || null,
    subProcessorDisclosure: k.SubProcessorDisclosure || 'Unknown',
    lastChecked: k.LastVerified || new Date().toISOString().split('T')[0],
    confidence: 'high',
    findings: [],
  };
  if (k.ICORegistered === 'Yes' || (k.ICORegistered || '').startsWith('Yes')) {
    intel.findings.push({ finding: 'Registered with the ICO', evidence: 'ICO Data Protection Register — registration ' + (k.ICORegistrationNumber || 'confirmed'), type: 'verified', status: 'passed' });
  }
  if (k.DPAStatus === 'Confirmed') {
    intel.findings.push({ finding: 'Data Processing Agreement available', evidence: k.PrivacyPolicyUrl || 'Vendor documentation', type: 'vendor_documented', status: 'passed' });
  }
  if (k.BreachHistory && k.BreachHistory !== 'None publicly disclosed.') {
    intel.findings.push({ finding: 'Breach history on record', evidence: k.BreachHistory, type: 'public_source', status: 'needs_attention' });
  } else {
    intel.findings.push({ finding: 'No relevant breach history identified', evidence: 'Public disclosure review — no incidents found in sources reviewed', type: 'public_source', status: 'passed' });
  }
  if (k.TransferMechanism || k.TransferMechanismConfirmed) {
    const dest = k.TransferDestination || fields.TransferDestination || '';
    const isUK = dest.toLowerCase().includes('uk') && !dest.toLowerCase().includes('us');
    intel.findings.push({ finding: 'International transfer mechanism documented', evidence: (k.TransferMechanism || k.TransferMechanismConfirmed) + (dest ? ' — data held in ' + dest : ''), type: 'vendor_documented', status: isUK ? 'passed' : 'needs_attention' });
  }
  if (k.Certifications) {
    intel.findings.push({ finding: 'Security certifications held', evidence: k.Certifications, type: 'vendor_documented', status: 'passed' });
  }
  fields.IntelligenceJson = JSON.stringify(intel);
  fields.ComplianceScore = calculateVendorScore(intel, fields);
  fields.ScoreBreakdownJson = JSON.stringify(buildScoreBreakdown(intel, fields));
  return fields;
}

// ── Vendor intelligence: assess unknown vendor via Claude ─────
async function assessUnknownVendor(vendorName, fields) {
  if (!process.env.ANTHROPIC_API_KEY) return fields;
  try {
    const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Research the company "${vendorName}" as a marketing/data technology vendor used by UK businesses. Find:\n1. Their correct legal entity name\n2. ICO Data Protection Register entry (registration number if found)\n3. Whether they publish a Data Processing Agreement / DPA (find the URL)\n4. Where they store/process data (countries)\n5. Transfer mechanisms (SCCs, BCRs, EU-US DPF)\n6. Any known data breaches or security incidents\n7. Security certifications (SOC 2, ISO 27001, etc)\n8. Any ICO, ASA, or CMA enforcement actions against them\n\nReturn ONLY a JSON object with these exact keys:\n{"vendorLegalName":"","icoRegistered":"Yes|No|Unknown","icoRegistrationNumber":"","dpaUrl":"","transferDestination":"","transferMechanism":"","breachHistory":"None publicly disclosed.|description if found","certifications":"","enforcementHistory":"None identified in sources reviewed.|description if found","confidence":"high|medium|low"}\nNo other text.` }],
      }),
    }), 20000);
    if (!r.ok) return fields;
    const data = await r.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fields;
    const result = JSON.parse(match[0]);
    const intel = {
      source: 'automated_assessment',
      vendorLegalName: result.vendorLegalName || vendorName,
      icoRegistered: result.icoRegistered || 'Unknown',
      icoRegistrationNumber: result.icoRegistrationNumber || null,
      dpaStatus: result.dpaUrl ? 'Available' : 'Unknown',
      dpaUrl: result.dpaUrl || null,
      transferMechanism: result.transferMechanism || null,
      transferDestination: result.transferDestination || null,
      breachHistory: result.breachHistory || 'No information found.',
      certifications: result.certifications || null,
      enforcementHistory: result.enforcementHistory || 'None identified in sources reviewed.',
      lastChecked: new Date().toISOString().split('T')[0],
      confidence: result.confidence || 'medium',
      findings: [],
    };
    if (result.icoRegistered === 'Yes') {
      intel.findings.push({ finding: 'Registered with the ICO', evidence: 'ICO Data Protection Register' + (result.icoRegistrationNumber ? ' — ' + result.icoRegistrationNumber : ''), type: 'verified', status: 'passed' });
    } else if (result.icoRegistered === 'No') {
      intel.findings.push({ finding: 'Not found on ICO register', evidence: 'Searched ICO Data Protection Register — no matching entry. May be registered under a parent entity.', type: 'verified', status: 'needs_attention' });
    } else {
      intel.findings.push({ finding: 'ICO registration status not confirmed', evidence: 'Could not verify — check ICO register directly', type: 'not_available', status: 'needs_attention' });
    }
    if (result.dpaUrl) {
      intel.findings.push({ finding: 'DPA documentation found', evidence: result.dpaUrl, type: 'vendor_documented', status: 'passed' });
      if (!fields.PrivacyPolicyUrl) fields.PrivacyPolicyUrl = result.dpaUrl;
    } else {
      intel.findings.push({ finding: 'No public DPA found', evidence: 'Web search did not find a published Data Processing Agreement. Request directly from vendor.', type: 'not_available', status: 'needs_attention' });
    }
    if (result.breachHistory && result.breachHistory !== 'None publicly disclosed.') {
      intel.findings.push({ finding: 'Breach or security incident on record', evidence: result.breachHistory, type: 'public_source', status: 'needs_attention' });
    } else {
      intel.findings.push({ finding: 'No relevant breach history identified', evidence: 'No publicly disclosed incidents found in sources reviewed', type: 'public_source', status: 'passed' });
    }
    if (result.transferDestination) {
      intel.findings.push({ finding: 'Data processing location identified', evidence: result.transferDestination + (result.transferMechanism ? ' — ' + result.transferMechanism : ''), type: result.confidence === 'high' ? 'vendor_documented' : 'ai_assessment', status: 'passed' });
      if (!fields.TransferDestination) fields.TransferDestination = result.transferDestination;
    }
    if (result.certifications) {
      intel.findings.push({ finding: 'Security certifications identified', evidence: result.certifications, type: 'vendor_documented', status: 'passed' });
    }
    if (result.enforcementHistory && result.enforcementHistory !== 'None identified in sources reviewed.') {
      intel.findings.push({ finding: 'Relevant enforcement history', evidence: result.enforcementHistory, type: 'public_source', status: 'needs_attention' });
      fields.ICORiskLevel = 'Medium';
    }
    fields.IntelligenceJson = JSON.stringify(intel);
    fields.ComplianceScore = calculateVendorScore(intel, fields);
    fields.ScoreBreakdownJson = JSON.stringify(buildScoreBreakdown(intel, fields));
    fields.LastAutoChecked = new Date().toISOString().split('T')[0];
    return fields;
  } catch (e) {
    console.error('Vendor assessment non-fatal:', e);
    return fields;
  }
}

// ── Deterministic vendor score ────────────────────────────────
function calculateVendorScore(intel, fields = {}) {
  return Object.values(buildScoreBreakdown(intel, fields)).reduce((s, c) => s + c.score, 0);
}) {
  return Object.values(buildScoreBreakdown(intel, fields)).reduce((s, c) => s + c.score, 0);
}

function buildScoreBreakdown(intel, fields = {}

// ── Marketing checks: how the USER uses each platform ─────────
// Self-assessed by the user. Each check names the rule it maps to.
const MARKETING_CATEGORY_LABELS = {
  esp: 'Email platform', sms: 'SMS platform', crm: 'CRM', analytics: 'Analytics & tracking',
  advertising: 'Advertising platform', payments: 'Payments', support: 'Customer support',
  forms: 'Forms & surveys', agency: 'Agency', other: 'Other',
};

const MARKETING_CHECKS = {
  esp: [
    { id: 'esp_consent_source', label: 'Only consented contacts imported', question: 'Do you only upload contacts with a recorded consent or valid soft opt-in to this platform?', rule: 'PECR Reg 22(2)–(3)', regulator: 'ICO', severity: 'critical', fixType: 'consent_record_missing' },
    { id: 'esp_suppression', label: 'Suppression synced from all sources', question: 'Are unsubscribes and objections from every other tool and channel synced to this platform before each send?', rule: 'PECR Reg 22 · UK GDPR Art 21(3)', regulator: 'ICO', severity: 'critical', fixType: 'suppression_not_synced' },
    { id: 'esp_unsubscribe', label: 'Opt-out in every message', question: 'Does every marketing email include a simple, free way to opt out that is honoured promptly?', rule: 'PECR Reg 22(3)(c), Reg 23', regulator: 'ICO', severity: 'high', fixType: 'missing_unsubscribe' },
    { id: 'esp_sender', label: 'Sender identity clear', question: 'Do the From name and address clearly identify your organisation, with a valid reply address?', rule: 'PECR Reg 23', regulator: 'ICO', severity: 'high', fixType: 'sender_identity_unclear' },
  ],
  sms: [
    { id: 'sms_consent_source', label: 'Only consented numbers imported', question: 'Do you only send SMS to numbers with recorded consent or valid soft opt-in?', rule: 'PECR Reg 22(2)–(3)', regulator: 'ICO', severity: 'critical', fixType: 'consent_record_missing' },
    { id: 'sms_stop', label: 'STOP works and syncs', question: 'Does every SMS include a free opt-out (e.g. reply STOP), with opt-outs synced to all channels?', rule: 'PECR Reg 22(3)(c), Reg 23', regulator: 'ICO', severity: 'high', fixType: 'missing_unsubscribe' },
    { id: 'sms_sender', label: 'Sender ID identifies you', question: 'Does the sender ID make clear the message is from your organisation?', rule: 'PECR Reg 23', regulator: 'ICO', severity: 'high', fixType: 'sender_identity_unclear' },
  ],
  crm: [
    { id: 'crm_provenance', label: 'Consent provenance stored', question: 'For each contact, does the CRM store when and how consent was given and the wording shown?', rule: 'UK GDPR Art 7(1)', regulator: 'ICO', severity: 'critical', fixType: 'consent_provenance_missing' },
    { id: 'crm_objection', label: 'Opt-outs reach sending tools', question: 'When someone opts out or objects in the CRM, does that reach every platform you send from?', rule: 'UK GDPR Art 21(3)', regulator: 'ICO', severity: 'critical', fixType: 'objection_not_synced' },
    { id: 'crm_retention', label: 'Old consent reviewed', question: 'Do you review or remove contacts whose consent is old or who have not engaged for a long time?', rule: 'UK GDPR Art 5(1)(e)', regulator: 'ICO', severity: 'medium', fixType: 'stale_consent_data' },
  ],
  analytics: [
    { id: 'an_prior_consent', label: 'Tags load only after consent', question: 'Do this tool\'s cookies or tags load only after the visitor opts in, not on page load?', rule: 'PECR Reg 6', regulator: 'ICO', severity: 'critical', fixType: 'tracking_without_consent' },
    { id: 'an_reject', label: 'Reject as easy as accept', question: 'Can visitors refuse non-essential cookies as easily as accepting them, on the first screen?', rule: 'PECR Reg 6 · ICO cookie guidance', regulator: 'ICO', severity: 'high', fixType: 'reject_not_equal' },
    { id: 'an_disclosed', label: 'Named in cookie notice', question: 'Is this tool named in your cookie or privacy notice, with its purpose?', rule: 'PECR Reg 6(2) · UK GDPR Art 13', regulator: 'ICO', severity: 'medium', fixType: 'cookie_not_disclosed' },
  ],
  advertising: [
    { id: 'ad_audience', label: 'List uploads have a lawful basis', question: 'If you upload customer lists (custom or matched audiences), is that covered by your lawful basis and disclosed in your privacy notice?', rule: 'UK GDPR Art 6, Art 13', regulator: 'ICO', severity: 'critical', fixType: 'custom_audience_no_basis' },
    { id: 'ad_pixel', label: 'Pixel loads only after consent', question: 'Does this platform\'s pixel or tag load only after cookie consent?', rule: 'PECR Reg 6', regulator: 'ICO', severity: 'critical', fixType: 'pixel_without_consent' },
    { id: 'ad_claims', label: 'Ads reviewed before launch', question: 'Is ad copy checked against the CAP Code and pricing rules before it goes live on this platform?', rule: 'CAP Code · DMCCA 2024', regulator: 'ASA', severity: 'high', fixType: 'ad_copy_unreviewed' },
  ],
  payments: [
    { id: 'pay_reuse', label: 'Payment data kept out of marketing', question: 'Is customer data from this provider kept out of marketing lists unless you have a separate basis (e.g. soft opt-in at checkout)?', rule: 'UK GDPR Art 5(1)(b) · PECR Reg 22(3)', regulator: 'ICO', severity: 'medium', fixType: 'purpose_creep' },
    { id: 'pay_checkout_optout', label: 'Opt-out offered at checkout', question: 'If you rely on soft opt-in from purchases, is a clear opt-out offered at the point of sale?', rule: 'PECR Reg 22(3)(c)', regulator: 'ICO', severity: 'high', fixType: 'soft_optin_no_optout' },
  ],
  support: [
    { id: 'sup_separate', label: 'Marketing opt-in kept separate', question: 'Is any marketing sign-up in chat or help flows a separate, unticked choice?', rule: 'UK GDPR Art 7(2) · PECR Reg 22', regulator: 'ICO', severity: 'medium', fixType: 'bundled_consent' },
    { id: 'sup_suppression', label: 'No marketing to opted-out customers', question: 'Are customers who opted out kept out of promotional messages sent through this tool?', rule: 'PECR Reg 22', regulator: 'ICO', severity: 'high', fixType: 'suppression_not_synced' },
  ],
  forms: [
    { id: 'form_specific', label: 'Consent wording is specific', question: 'Does the form name your organisation and the channels (email, SMS) people are signing up to?', rule: 'PECR Reg 22 · UK GDPR Art 4(11)', regulator: 'ICO', severity: 'critical', fixType: 'form_consent_not_specific' },
    { id: 'form_unticked', label: 'No pre-ticked or bundled boxes', question: 'Are marketing boxes unticked by default and separate from terms and conditions?', rule: 'UK GDPR Art 7(2)', regulator: 'ICO', severity: 'critical', fixType: 'bundled_consent' },
    { id: 'form_record', label: 'Each submission recorded', question: 'Is each consent saved with a timestamp and the version of the form shown?', rule: 'UK GDPR Art 7(1)', regulator: 'ICO', severity: 'high', fixType: 'consent_provenance_missing' },
  ],
  agency: [
    { id: 'ag_approval', label: 'You approve creative before launch', question: 'Does the agency get your sign-off on copy and claims before campaigns go live?', rule: 'CAP Code · DMCCA 2024', regulator: 'ASA', severity: 'high', fixType: 'ad_copy_unreviewed' },
    { id: 'ag_lists', label: 'Agency sends only to suppressed lists', question: 'Does the agency send only to lists you supply, with your suppression applied?', rule: 'PECR Reg 22', regulator: 'ICO', severity: 'critical', fixType: 'suppression_not_synced' },
    { id: 'ag_tracking', label: 'Agency tags respect consent', question: 'Do pixels or tags the agency adds go through your consent tool?', rule: 'PECR Reg 6', regulator: 'ICO', severity: 'high', fixType: 'tracking_without_consent' },
  ],
  other: [
    { id: 'oth_sends', label: 'Marketing sent only with consent', question: 'If this platform sends marketing, does it go only to consented contacts, with an opt-out?', rule: 'PECR Reg 22', regulator: 'ICO', severity: 'high', fixType: 'consent_record_missing' },
    { id: 'oth_tracks', label: 'Tracking only after consent', question: 'If it sets cookies or tags, do they load only after consent?', rule: 'PECR Reg 6', regulator: 'ICO', severity: 'high', fixType: 'tracking_without_consent' },
  ],
};

const SEVERITY_WEIGHT = { critical: 3, high: 2, medium: 1 };

function normaliseCategory(type, name) {
  const t = `${type || ''} ${name || ''}`.toLowerCase();
  if (/\b(sms|text messag|twilio|textlocal|esendex)/.test(t)) return 'sms';
  if (/(email|\besp\b|newsletter|mailchimp|klaviyo|brevo|dotdigital|activecampaign|omnisend|campaign monitor|constant contact|marketing cloud)/.test(t)) return 'esp';
  if (/(\bcrm\b|salesforce|pipedrive|zoho|hubspot)/.test(t)) return 'crm';
  if (/(analytic|hotjar|mixpanel|amplitude|tag manager|heatmap)/.test(t)) return 'analytics';
  if (/(advertis|\bads\b|google ads|meta ads|tiktok|linkedin)/.test(t)) return 'advertising';
  if (/(payment|stripe|paypal|adyen|worldpay|checkout)/.test(t)) return 'payments';
  if (/(support|helpdesk|intercom|zendesk|freshdesk|live chat)/.test(t)) return 'support';
  if (/(form|survey|typeform|jotform)/.test(t)) return 'forms';
  if (/(agenc|ogilvy|vccp|merkle|jellyfish|mediacom|mindshare)/.test(t)) return 'agency';
  return 'other';
}

function calculateMarketingScore(category, checks = {}) {
  const defs = MARKETING_CHECKS[category] || MARKETING_CHECKS.other;
  let total = 0, earned = 0;
  for (const d of defs) {
    const s = checks[d.id]?.status;
    if (s === 'not_applicable') continue;
    const w = SEVERITY_WEIGHT[d.severity] || 1;
    total += w;
    if (s === 'passed') earned += w;
    else if (s === 'needs_attention') earned += w * 0.5;
  }
  return total ? Math.round((earned / total) * 100) : 100;
}

function marketingGaps(mc) {
  if (!mc) return { gaps: [], unanswered: 0 };
  const defs = MARKETING_CHECKS[mc.category] || [];
  const gaps = defs.filter(d => ['not_evidenced', 'needs_attention'].includes(mc.checks?.[d.id]?.status));
  const unanswered = defs.filter(d => !mc.checks?.[d.id]?.status).length;
  return { gaps, unanswered };
}
) {
  const dpaStatus = fields.DPAStatus || fields.AgreementStatus || intel.dpaStatus || 'Unknown';
  const dpaConfirmed = DPA_CONFIRMED.includes(dpaStatus) || intel.dpaStatus === 'Confirmed';
  const enforcement = hasRelevantEnforcement(intel);
  const ukOnly = isUKOnly(intel.transferDestination);
  const icoYes = intel.icoRegistered === 'Yes' || (intel.icoRegistered || '').startsWith('Yes');
  const days = intel.lastChecked ? Math.floor((Date.now() - new Date(intel.lastChecked)) / 86400000) : 999;
  return {
    dpa:            { max: 30, score: dpaConfirmed ? 30 : intel.dpaUrl ? 20 : 0, label: dpaConfirmed ? 'Confirmed' : intel.dpaUrl ? 'Available but not confirmed' : 'Not found' },
    icoRegister:    { max: 15, score: icoYes ? 15 : 0, label: intel.icoRegistered || 'Unknown' },
    enforcement:    { max: 20, score: enforcement ? 5 : 20, label: enforcement ? 'Relevant history found' : 'No relevant actions identified' },
    transfers:      { max: 15, score: ukOnly ? 15 : intel.transferMechanism ? 12 : 0, label: ukOnly ? 'UK-based — no transfer' : intel.transferMechanism || 'Not documented' },
    freshness:      { max: 10, score: days <= 90 ? 10 : days <= 180 ? 6 : 2, label: days <= 90 ? 'Current' : days <= 180 ? 'Review recommended' : 'Stale' },
    certifications: { max: 10, score: intel.certifications ? 10 : 0, label: intel.certifications || 'None identified' },
  };
}

function safeJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

function isUKOnly(dest) {
  const d = (dest || '').toLowerCase();
  const uk = /\b(uk|united kingdom|great britain|england|scotland|wales)\b/.test(d);
  const elsewhere = /\b(us|usa|united states|eu|eea|europe|ireland|germany|france|netherlands|india|australia|canada|global|worldwide|international)\b/.test(d);
  return uk && !elsewhere;
}

function hasRelevantEnforcement(intel) {
  if ((intel.enforcementRelevant || []).length) return true;
  const h = intel.enforcementHistory;
  return !!h && h !== 'None identified in sources reviewed.' && h !== 'None publicly disclosed.';
}


// ── Enforcement relevance filter ──────────────────────────────
async function getRelevantEnforcement(base, name, entityType, relationshipContext) {
  if (!name) return { relevant: [], rejected: [], summary: 'No name provided.' };
  const candidates = await getViolationsForName(base, name);

  // If no candidates in Violation_Database AND we have Claude, do a web search
  if (!candidates.length && process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 800,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: `Search for any ICO, ASA, or CMA enforcement actions, fines, or regulatory rulings against "${name}" in the UK. Check ico.org.uk/action-weve-taken/enforcement/ and asa.org.uk/codes-and-rulings/rulings.html specifically.\n\nIf you find any relevant enforcement actions, return a JSON array:\n[{"regulator":"ICO|ASA|CMA","date":"YYYY-MM-DD","violation":"brief description","fine":number_or_null,"source":"URL where found","sameEntity":true,"relevanceNote":"why this is relevant","claimTypes":["pricing_claim|urgency_claim|scarcity_claim|free_claim|health_claim|comparative_claim|guarantee_claim|environmental_claim|consent|other"]}]\n\nIf you find NO relevant enforcement actions, return exactly:\n[]\n\nNo other text.` }],
        }),
      }), 20000);
      if (r.ok) {
        const data = await r.json();
        const text = data.content?.find(b => b.type === 'text')?.text || '';
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const webResults = JSON.parse(match[0]);
          if (webResults.length) {
            const relevant = webResults.map(w => ({
              CompanyName: name,
              Regulator: w.regulator || '',
              DateOfAction: w.date || '',
              Violation: w.violation || '',
              FineAmount: w.fine || null,
              source: w.source || 'Web search',
              relevanceNote: w.relevanceNote || 'Found via web search',
              sameEntity: w.sameEntity !== false,
              claimTypes: Array.isArray(w.claimTypes) ? w.claimTypes : [],
              webSearchResult: true,
            }));
            return { relevant, rejected: [], summary: relevant.length + ' enforcement action' + (relevant.length !== 1 ? 's' : '') + ' identified via web search.', source: 'web_search' };
          }
        }
      }
    } catch (e) { console.error('Enforcement web search non-fatal:', e); }
    return { relevant: [], rejected: [], summary: 'No relevant enforcement actions identified in the sources reviewed.', source: 'web_search' };
  }

  if (!candidates.length) return { relevant: [], rejected: [], summary: 'No relevant enforcement actions identified in the sources reviewed.' };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { relevant: candidates.map(v => ({ ...v.fields, recordId: v.id, relevanceNote: 'Relevance check unavailable' })), rejected: [], summary: candidates.length + ' candidate match(es) — relevance not verified.' };
  }
  try {
    const candidateSummaries = candidates.slice(0, 10).map(v => ({
      company: v.fields.CompanyName || '', regulator: v.fields.Regulator || '',
      date: v.fields.DateOfAction || '', violation: (v.fields.Violation || '').slice(0, 250),
      fine: v.fields.FineAmount || null,
    }));
    const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 800,
        messages: [{ role: 'user', content: `I searched for enforcement actions related to "${name}" (a ${entityType || 'marketing vendor'} used as a ${relationshipContext || 'data processor'}).\n\nThese candidate results came back:\n${JSON.stringify(candidateSummaries)}\n\nFor EACH candidate, determine:\n1. Is this definitely the same organisation (or parent/subsidiary)?\n2. Is the enforcement action relevant to their role as a ${relationshipContext || 'data processor/marketing platform'}?\n3. Is it relevant to a UK marketer using this vendor?\n\nReturn ONLY a JSON array where each element has:\n{"index":0,"relevant":true|false,"sameEntity":true|false,"relevanceNote":"one sentence explaining why included or excluded"}\nNo other text.` }],
      }),
    }), 15000);
    if (!r.ok) throw new Error('API ' + r.status);
    const data = await r.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array');
    const assessments = JSON.parse(match[0]);
    const relevant = [], rejected = [];
    assessments.forEach(a => {
      const candidate = candidates[a.index];
      if (!candidate) return;
      const record = { ...candidate.fields, recordId: candidate.id, relevanceNote: a.relevanceNote || '', sameEntity: a.sameEntity, claimTypes: Array.isArray(a.claimTypes) ? a.claimTypes : [] };
      if (a.relevant && a.sameEntity) relevant.push(record);
      else rejected.push(record);
    });
    const summary = relevant.length
      ? relevant.length + ' relevant enforcement action' + (relevant.length !== 1 ? 's' : '') + ' identified.'
      : 'No relevant enforcement actions identified in the sources reviewed.';
    return { relevant, rejected, summary };
  } catch (e) {
    console.error('Enforcement relevance filter non-fatal:', e);
    return { relevant: candidates.map(v => ({ ...v.fields, recordId: v.id, relevanceNote: 'Relevance check unavailable' })), rejected: [], summary: candidates.length + ' candidate match(es) — relevance not verified.' };
  }
}


// ── Fix generation helper (fire-and-forget) ──────────────────
function generateFix(payload) {
  return fetch(`${APP_URL}/api/generate-fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(e => console.error('generate-fix non-fatal:', e));
}

async function fixExistsFor(base, userId, sourceRecordId, fixType) {
  if (!sourceRecordId) return false;
  const formula = `AND({UserID}='${userId}',{SourceRecordId}='${sourceRecordId}',{FixType}='${fixType}',{Status}!='completed',{Status}!='dismissed')`;
  const existing = await atGet(base, 'Compliance_Fixes', formula, '', 1).catch(() => []);
  return existing.length > 0;
}

// ── REPORT handler ────────────────────────────────────────────
async function handleReport(req, res) {
  const { recordId, type } = req.query;
  if (!recordId || !type) return res.status(400).json({ error: 'Missing recordId or type' });
  const tables = {
    ai: 'AI_Compliance_Checks', email: 'Email_Scans', audit: 'Database_Audits',
    vendor: 'Vendor_Register', suppression: 'Suppression_Checks',
    dossier: 'Campaign_Dossiers', pecr: 'Suppression_Checks',
    audience: 'Audience_Read_Campaigns', partner: 'Partner_Register',
    affiliate: 'Affiliate_Register', competitor: 'Competitor_Watch',
  };
  const tableName = tables[type];
  if (!tableName) return res.status(400).json({ error: 'Invalid report type' });
  const base = airtableBase();
  try {
    const records = await atGet(base, tableName, `RECORD_ID()='${recordId}'`, '', 1);
    return res.json(records[0] || null);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── VENDORS handler ───────────────────────────────────────────
async function handleVendors(req, res) {
  try {
    const records = await atGet(airtableBase(), 'Marketing_Vendors', '', 'sort[0][field]=VendorName', 200);
    const vendors = records.map(r => ({
      name:                  r.fields.VendorName || '',
      vendorType:            r.fields.VendorType || '',
      icoRegistrationStatus: r.fields.ICORegistered || 'Unknown',
      dpaStatus:             r.fields.DPAStatus || 'Unknown',
      dpaLink:               r.fields.PrivacyPolicyUrl || '',
      internationalTransfer: r.fields.TransferMechanismConfirmed || 'Unknown',
      knownBreachHistory:    r.fields.BreachHistory || '',
      lastVerified:          r.fields.LastVerified || '',
    }));
    return res.json({ vendors });
  } catch (e) {
    return res.json({ vendors: [] });
  }
}

// ── VIOLATIONS handler ────────────────────────────────────────
async function handleViolations(req, res) {
  const { violationType, keyword, sector } = req.query;
  const filters = [];
  if (violationType) filters.push(`{ViolationType}='${violationType}'`);
  if (sector)        filters.push(`{Sector}='${sector}'`);
  if (keyword) {
    const kw = keyword.toLowerCase();
    filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
  }
  const formula = filters.length ? `AND(${filters.join(',')})` : '';
  try {
    const records  = await atGet(airtableBase(), 'Violation_Database', formula, 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 20);
    const totalFines = records.reduce((s, v) => s + (v.fields.FineAmount || 0), 0);
    return res.json({ violations: records, stats: { total: records.length, totalFines, avgFine: records.length ? Math.round(totalFines / records.length) : 0 } });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── LOAD handler ──────────────────────────────────────────────
async function handleLoad(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const fixesRes = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  if (!fixesRes.ok) return res.status(fixesRes.status).json({ error: 'Failed to load compliance data' });
  return res.status(200).json(await fixesRes.json());
}

// ── HISTORY handler ───────────────────────────────────────────
async function handleHistory(req, res) {
  const { type, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const tableMap = {
    audit:       { table: 'Database_Audits',        sort: 'AuditDate'   },
    vendor:      { table: 'Vendor_Register',         sort: 'LastChecked' },
    ai:          { table: 'AI_Compliance_Checks',    sort: 'CheckDate'   },
    suppression: { table: 'Suppression_Checks',      sort: 'CheckDate'   },
    audience:    { table: 'Audience_Read_Campaigns', sort: 'SendDate'    },
    partner:     { table: 'Partner_Register',         sort: 'LastChecked' },
    affiliate:   { table: 'Affiliate_Register',       sort: 'LastChecked' },
    competitor:  { table: 'Competitor_Watch',          sort: 'LastAutoChecked' },
  };
  if (!type || !tableMap[type]) return res.status(400).json({ error: `type must be one of: ${Object.keys(tableMap).join(' | ')}` });
  const { table, sort } = tableMap[type];
  try {
    const records = await atGet(airtableBase(), table, `{UserID}='${userId}'`, `sort[0][field]=${sort}&sort[0][direction]=desc`, 50);
    return res.json({ records });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── REGISTER handler (Vendor_Register — processors) — v7.5 ──
async function handleRegister(req, res) {
  const base = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try {
      await atDelete(base, 'Vendor_Register', recordId);
      return res.json({ deleted: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { recordId, vendor } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!vendor) return res.status(400).json({ error: 'vendor data required' });
    let fields = {
      UserID: userId, VendorName: vendor.VendorName, VendorType: vendor.VendorType,
      Category: vendor.Category, VendorUseCase: vendor.VendorUseCase,
      DPAStatus: vendor.DPAStatus, AgreementStatus: vendor.AgreementStatus,
      AgreementType: vendor.AgreementType, AgreementDate: vendor.AgreementDate,
      PrivacyPolicyUrl: vendor.PrivacyPolicyUrl || vendor.DPALink,
      DataProcessed: Array.isArray(vendor.DataProcessed) ? JSON.stringify(vendor.DataProcessed) : vendor.DataProcessed,
      TransferDestination: vendor.TransferDestination,
      ContactVolume: vendor.ContactVolume || null,
      ComplianceScore: vendor.ComplianceScore ?? null,
      ICORiskLevel: vendor.ICORiskLevel, ASARiskLevel: vendor.ASARiskLevel, CMARiskLevel: vendor.CMARiskLevel,
      DPAClauseResults: vendor.DPAClauseResults,
      PrivacyReviewResults: vendor.PrivacyReviewResults,
      Notes: vendor.Notes,
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      LastAutoChecked: vendor.LastAutoChecked,
    };

    // v7.5: On create — pre-fill from Marketing_Vendors or assess unknown vendor
    if (!recordId && vendor.VendorName) {
      try {
        fields = await prefillFromKnownVendor(base, vendor.VendorName, fields);
        if (!fields.IntelligenceJson) {
          fields = await assessUnknownVendor(vendor.VendorName, fields);
        }
      } catch (e) { console.error('Vendor intelligence non-fatal:', e); }
      try {
        const enforcement = await getRelevantEnforcement(base, vendor.VendorName, vendor.VendorType || 'marketing platform', 'data processor');
        if (enforcement.relevant.length) {
          fields.ICORiskLevel = enforcement.relevant.length >= 2 ? 'High' : 'Medium';
          try {
            const intel = JSON.parse(fields.IntelligenceJson || '{}');
            intel.enforcementRelevant = enforcement.relevant;
            intel.enforcementSummary = enforcement.summary;
            fields.IntelligenceJson = JSON.stringify(intel);
            fields.ComplianceScore = calculateVendorScore(intel, fields);
            fields.ScoreBreakdownJson = JSON.stringify(buildScoreBreakdown(intel, fields));
          } catch (e) {}
        }
        fields.EnforcementRelevanceJson = JSON.stringify({ relevant: enforcement.relevant, rejected: enforcement.rejected, summary: enforcement.summary });
      } catch (e) { console.error('Enforcement check non-fatal:', e); }
    }

    try {
      const record = recordId
        ? await atPatch(base, 'Vendor_Register', recordId, fields)
        : await atCreate(base, 'Vendor_Register', fields);

      const dpaStatus = vendor.DPAStatus || vendor.AgreementStatus || fields.DPAStatus || fields.AgreementStatus;
      let fixGenerated = false;
      const dpaTouched = !recordId || vendor.DPAStatus !== undefined || vendor.AgreementStatus !== undefined;
      if (dpaTouched && !isDPAConfirmed(dpaStatus)) {
        const sourceId = record?.id || recordId;
        const already  = await fixExistsFor(base, userId, sourceId, 'dpa_breach');
        if (!already) {
          generateFix({
            userId, fixType: 'dpa_breach', tool: 'Relationships Register',
            description: `Processor '${vendor.VendorName}' registered without a confirmed Article 28 Data Processing Agreement (current status: ${dpaStatus || 'Unknown'}). UK GDPR Article 28 requires a written DPA before personal data is shared with a processor.`,
            severity: 'high', sourceRecordId: sourceId,
          });
          fixGenerated = true;
        }
      }

      return res.json({ record, fixGenerated, dpaConfirmed: isDPAConfirmed(dpaStatus) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── BACKFILL-PROCESSOR-FIXES handler ─────────────────────────
async function handleBackfillProcessorFixes(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const base = airtableBase();
  const processors = await atGet(base, 'Vendor_Register', `{UserID}='${userId}'`, '', 100).catch(() => []);

  const results = { checked: processors.length, fixesGenerated: 0, skipped: 0, confirmed: 0 };

  for (const r of processors) {
    const dpaStatus = r.fields.DPAStatus || r.fields.AgreementStatus;
    if (isDPAConfirmed(dpaStatus)) { results.confirmed++; continue; }

    const already = await fixExistsFor(base, userId, r.id, 'dpa_breach');
    if (already) { results.skipped++; continue; }

    generateFix({
      userId, fixType: 'dpa_breach', tool: 'Relationships Register (backfill)',
      description: `Processor '${r.fields.VendorName}' has no confirmed Article 28 Data Processing Agreement on file (status: ${dpaStatus || 'Unknown'}). UK GDPR Article 28 requires a written DPA before personal data is shared with a processor.`,
      severity: 'high', sourceRecordId: r.id,
    });
    results.fixesGenerated++;
  }

  return res.json(results);
}

// ── CRON-STATUS handler ───────────────────────────────────────
async function handleCronStatus(req, res) {
  const base = airtableBase();
  const [recent, all] = await Promise.all([
    atGet(base, 'Sector_Intelligence_Feed', '', 'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10).catch(() => []),
    atGet(base, 'Sector_Intelligence_Feed', '', 'sort[0][field]=WeekNumber&sort[0][direction]=desc', 100).catch(() => []),
  ]);
  const now = new Date();
  const sevenDaysAgo  = new Date(now.getTime() - 7  * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);
  const inLast7  = recent.filter(r => r.fields.PublishedDate && new Date(r.fields.PublishedDate) >= sevenDaysAgo).length;
  const inLast14 = recent.filter(r => r.fields.PublishedDate && new Date(r.fields.PublishedDate) >= fourteenDaysAgo).length;
  const mostRecent = recent[0];
  const mostRecentDate = mostRecent?.fields?.PublishedDate || null;
  const daysSinceMostRecent = mostRecentDate ? Math.floor((now - new Date(mostRecentDate)) / 86400000) : null;
  const weekCounts = {};
  all.forEach(r => { const w = r.fields.WeekNumber; if (w != null) weekCounts[w] = (weekCounts[w] || 0) + 1; });
  const recentWeeks = Object.entries(weekCounts).sort((a,b) => Number(b[0]) - Number(a[0])).slice(0, 6).map(([week, count]) => ({ weekNumber: Number(week), recordCount: count }));
  return res.json({
    totalRecords: all.length, inLast7Days: inLast7, inLast14Days: inLast14,
    mostRecent: mostRecent ? { companyName: mostRecent.fields.CompanyName || null, regulator: mostRecent.fields.Regulator || null, publishedDate: mostRecentDate, addedBy: mostRecent.fields.AddedBy || null, daysAgo: daysSinceMostRecent } : null,
    recentWeeks,
    healthCheck: { cronLikelyRunning: inLast14 > 0, warning: inLast14 === 0 ? 'No records in last 14 days — cron may not be running.' : daysSinceMostRecent > 14 ? 'Most recent record is stale.' : null },
  });
}

// ── MARKETING-CHECK handler (v7.5) ────────────────────────────
async function handleMarketingCheck(req, res) {
  if (req.method === 'GET') return res.json({ categories: MARKETING_CHECKS, labels: MARKETING_CATEGORY_LABELS });

  const { userId, recordId, checkId, status, note, category } = req.body || {};
  if (!userId || !recordId) return res.status(400).json({ error: 'userId and recordId required' });
  const VALID = ['passed', 'needs_attention', 'not_evidenced', 'not_applicable', null];
  if (checkId && !VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const base = airtableBase();
  const rec = (await atGet(base, 'Vendor_Register', `RECORD_ID()='${recordId}'`, '', 1))[0];
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  if (rec.fields.UserID !== userId) return res.status(403).json({ error: 'Not authorised' });

  const mc = safeJSON(rec.fields.MarketingChecksJson, null)
    || { category: rec.fields.Category || normaliseCategory(rec.fields.VendorType, rec.fields.VendorName), checks: {} };
  if (!MARKETING_CHECKS[mc.category]) mc.category = 'other';
  if (category) {
    if (!MARKETING_CHECKS[category]) return res.status(400).json({ error: 'Unknown category' });
    mc.category = category;
  }

  let fixGenerated = false;
  if (checkId) {
    const def = MARKETING_CHECKS[mc.category].find(d => d.id === checkId);
    if (!def) return res.status(400).json({ error: 'Check does not belong to this category' });
    if (status === null) delete mc.checks[checkId];
    else mc.checks[checkId] = { status, note: note || '', updatedAt: new Date().toISOString().split('T')[0] };

    if ((status === 'not_evidenced' || status === 'needs_attention') && def.severity !== 'medium') {
      const already = await fixExistsFor(base, userId, recordId, def.fixType);
      if (!already) {
        generateFix({
          userId, fixType: def.fixType, tool: 'Relationships Register',
          description: `${rec.fields.VendorName}: ${def.label} — ${status === 'not_evidenced' ? 'not evidenced' : 'needs attention'}. ${def.question} (${def.rule})`,
          severity: def.severity === 'critical' ? 'critical' : 'high', sourceRecordId: recordId,
        });
        fixGenerated = true;
      }
    }
  }

  const marketingScore = calculateMarketingScore(mc.category, mc.checks);
  await atPatch(base, 'Vendor_Register', recordId, { MarketingChecksJson: JSON.stringify(mc), MarketingScore: marketingScore, Category: mc.category });
  return res.json({ checks: mc, marketingScore, fixGenerated });
}


const AD_ACTIVITIES      = ['joint_ads', 'co_branded_content', 'influencer'];
const PRICING_ACTIVITIES = ['joint_ads', 'co_branded_content', 'lead_generation'];

// Which agreement a partner needs depends on how data is shared.
function partnerAgreementRequirement(f) {
  const rel = f.DataRelationship || 'unknown';
  if (rel === 'none')                    return { rel, required: null, ok: true };
  if (rel === 'joint_controller')        return { rel, required: 'Article 26 joint controller arrangement', ok: isDPAConfirmed(f.Article26Status), fixType: 'no_article26_agreement' };
  if (rel === 'independent_controllers') return { rel, required: 'data sharing agreement', ok: isDPAConfirmed(f.DataAgreementStatus), fixType: 'no_data_sharing_agreement' };
  if (rel === 'processor')               return { rel, required: 'Article 28 DPA', ok: isDPAConfirmed(f.DataAgreementStatus), fixType: 'dpa_breach' };
  return { rel: 'unknown', required: 'undetermined', ok: false, fixType: 'partner_relationship_undetermined' };
}

// Which checks apply to an affiliate depends on what it does with data.
function affiliateRequirements(f) {
  const role = f.AffiliateDataRole || 'unknown';
  const act  = (f.RelationshipActivity || f.AffiliateType || '').toLowerCase();
  return {
    role,
    agreement: role === 'our_list' ? 'Article 28 DPA'
             : (role === 'own_list' || role === 'lead_capture') ? 'marketing / data sharing agreement'
             : role === 'no_mailing' ? null : 'unknown',
    consentNaming:  ['own_list', 'lead_capture', 'unknown'].includes(role) && role !== 'no_mailing',
    senderIdentity: ['own_list', 'our_list'].includes(role) || (role === 'unknown' && act.includes('email')),
    landingPage:    role === 'lead_capture' || /lead|comparison|cashback/.test(act),
    adDisclosure:   act.includes('influencer'),
  };
}

function weightedScore(items) {
  const applicable = items.filter(i => i[0]);
  const total = applicable.reduce((s, i) => s + i[2], 0);
  const got   = applicable.filter(i => i[1]).reduce((s, i) => s + i[2], 0);
  return total ? (got / total) * 100 : 100;
}
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;


// ── Consent wording analysis (v7.5) ───────────────────────────
const GENERIC_CONSENT_PATTERNS = [
  /selected (third[- ])?partners/i, /carefully (chosen|selected)/i, /trusted partners/i,
  /third[- ]part(y|ies)/i, /group companies/i, /other (companies|organisations|organizations|brands)/i,
];

function analyseConsentWording(wording, tradingName) {
  if (!wording || !tradingName) return { result: 'unchecked', reasons: ['Consent wording and trading name are both needed.'] };
  const w = wording.toLowerCase();
  const base = tradingName.toLowerCase().replace(/\b(ltd|limited|plc|llp|inc)\b\.?/g, '').replace(/\s+/g, ' ').trim();
  const named = !!base && w.includes(base);
  const channels = ['email', 'sms', 'text', 'phone', 'call', 'post'].filter(c => new RegExp(`\\b${c}`).test(w));
  const generic = GENERIC_CONSENT_PATTERNS.filter(rx => rx.test(wording)).map(rx => wording.match(rx)[0]);
  const reasons = [];

  if (!named) {
    reasons.push(`"${tradingName}" does not appear in the wording.`);
    if (generic.length) reasons.push(`It relies on generic wording ("${generic[0]}"), which does not cover your marketing.`);
    return { result: 'fail', named, channels, generic, reasons };
  }
  if (!channels.length) {
    reasons.push('Your organisation is named, but the wording does not say which channels (e.g. email, SMS) the consent covers.');
    return { result: 'warn', named, channels, generic, reasons };
  }
  if (generic.length) reasons.push(`Generic wording also present ("${generic[0]}"). Fine if your name is listed specifically alongside it.`);
  return { result: 'pass', named, channels, generic, reasons };
}

async function handleConsentCheck(req, res) {
  const { userId, recordId, type, wording, tradingName, sourceUrl } = req.body || {};
  if (!userId || !recordId) return res.status(400).json({ error: 'userId and recordId required' });
  const table = type === 'partner' ? 'Partner_Register' : 'Affiliate_Register';
  const base = airtableBase();
  const rec = (await atGet(base, table, `RECORD_ID()='${recordId}'`, '', 1))[0];
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  if (rec.fields.UserID !== userId) return res.status(403).json({ error: 'Not authorised' });

  const analysis = analyseConsentWording(wording, tradingName);
  const today = new Date().toISOString().split('T')[0];
  const patch = {
    ConsentCheckResultJson: JSON.stringify({ ...analysis, checkedAt: today, sourceUrl: sourceUrl || null }),
    ConsentChainVerified: analysis.result === 'pass',
  };
  if (type === 'partner') {
    patch.PartnerConsentWording = wording;
  } else {
    patch.ConsentWordingPasted = wording;
    patch.ConsentNameCheck = analysis.result;
    if (analysis.result === 'pass') patch.ConsentVerifiedDate = today;
    if (sourceUrl) {
      const urls = safeJSON(rec.fields.VerificationUrls, {});
      urls.signupPage = sourceUrl;
      patch.VerificationUrls = JSON.stringify(urls);
    }
  }
  await atPatch(base, table, recordId, patch);

  // Remember the trading name for next time
  if (tradingName) {
    const profile = (await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []))[0];
    if (profile && profile.fields.TradingName !== tradingName) {
      atPatch(base, 'User_Profile', profile.id, { TradingName: tradingName }).catch(e => console.error('trading name save non-fatal:', e));
    }
  }
  return res.json({ analysis });
}


// ── PARTNER-REGISTER handler (v7.5 — relevance filter) ───────
async function handlePartnerRegister(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Partner_Register', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    const { recordId, partner } = req.body;
    if (!userId)  return res.status(400).json({ error: 'userId required' });
    if (!partner) return res.status(400).json({ error: 'partner data required' });

    let violationCount = 0, lastViolationDate = null, lastViolationSummary = null;
    let reputationScore = 100, brandSafetyFlag = false, brandSafetyReason = null;
    let enforcementResult = null;
    if (!recordId && partner.PartnerName) {
      const activity = partner.RelationshipActivity || '';
      enforcementResult = await getRelevantEnforcement(base, partner.PartnerName, partner.PartnerType || 'partner', 'joint controller / co-marketing partner (' + activity + ')');
      violationCount = enforcementResult.relevant.length;
      if (enforcementResult.relevant[0]) {
        lastViolationDate    = enforcementResult.relevant[0].DateOfAction || null;
        lastViolationSummary = enforcementResult.relevant[0].Violation    || null;
      }
      for (const v of enforcementResult.relevant) {
        const daysAgo = v.DateOfAction ? Math.floor((Date.now() - new Date(v.DateOfAction)) / 86400000) : 365;
        reputationScore -= daysAgo < 180 ? 20 : daysAgo < 365 ? 12 : 6;
      }
      reputationScore = Math.max(0, reputationScore);
      if (reputationScore < 60 || violationCount >= 2) {
        brandSafetyFlag   = true;
        brandSafetyReason = `${violationCount} relevant enforcement action${violationCount !== 1 ? 's' : ''} identified in sources reviewed.`;
      }
    }

    const d = withDefaults(!recordId);

    const fields = {
      UserID: userId, PartnerName: partner.PartnerName, PartnerType: partner.PartnerType,
      RelationshipDescription: partner.RelationshipDescription,
      Article26Status: d(partner.Article26Status, 'Not yet'),
      Article26Date: partner.Article26Date,
      ConsentChainOwner: d(partner.ConsentChainOwner, 'Unknown'),
      ConsentChainVerified: d(partner.ConsentChainVerified, false),
      PrivacyPolicyUrl: partner.PrivacyPolicyUrl,
      ReputationScore: partner.ReputationScore ?? (recordId ? undefined : reputationScore),
      BrandSafetyFlag: partner.BrandSafetyFlag ?? (recordId ? undefined : brandSafetyFlag),
      BrandSafetyReason: partner.BrandSafetyReason || (recordId ? undefined : brandSafetyReason),
      ViolationCount: partner.ViolationCount ?? (recordId ? undefined : violationCount),
      LastViolationDate: partner.LastViolationDate || (recordId ? undefined : lastViolationDate),
      LastViolationSummary: partner.LastViolationSummary || (recordId ? undefined : lastViolationSummary),
      CampaignLog: partner.CampaignLog,
      CommercialTermsNotes: partner.CommercialTermsNotes,
      DataSharedDescription: partner.DataSharedDescription,
      ICORiskLevel: partner.ICORiskLevel,
      A26ClauseResults: partner.A26ClauseResults,
      PrivacyReviewResults: partner.PrivacyReviewResults,
      Notes: partner.Notes,
      AddedDate: recordId ? undefined : new Date().toISOString().split('T')[0],
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      EnforcementRelevanceJson: enforcementResult ? JSON.stringify({ relevant: enforcementResult.relevant, rejected: enforcementResult.rejected, summary: enforcementResult.summary }) : undefined,
      // v7.5 new
      AffiliateDataRole: d(affiliate.AffiliateDataRole, 'unknown'),
      LandingPageChecksJson: affiliate.LandingPageChecksJson,
      RelationshipActivity: partner.RelationshipActivity,
      MarketingChannels: Array.isArray(partner.MarketingChannels) ? JSON.stringify(partner.MarketingChannels) : partner.MarketingChannels,
      AdComplianceReviewed: d(partner.AdComplianceReviewed, false),
      PricingComplianceReviewed: d(partner.PricingComplianceReviewed, false),
      // v7.5 new
      DataRelationship: d(partner.DataRelationship, 'unknown'),
      DataAgreementStatus: partner.DataAgreementStatus,
      PartnerConsentWording: partner.PartnerConsentWording,
      ConsentChainNotes: partner.ConsentChainNotes,
      AdLastReviewed: partner.AdLastReviewed,
      AdReviewResult: partner.AdReviewResult,
      PricingLastReviewed: partner.PricingLastReviewed,
      PricingReviewResult: partner.PricingReviewResult,
    };

    try {
      const record = recordId
        ? await atPatch(base, 'Partner_Register', recordId, fields)
        : await atCreate(base, 'Partner_Register', fields);

      const fixesGenerated = [];

if (!recordId) {
        const agr = partnerAgreementRequirement(fields);
        if (agr.rel === 'unknown') {
          generateFix({ userId, fixType: 'partner_relationship_undetermined', tool: 'Relationships Register', description: `Confirm whether personal data is shared with '${partner.PartnerName}' and on what basis (joint controllers, independent controllers, processor, or none). This decides which agreement you need.`, severity: 'medium', sourceRecordId: record?.id || null });
          fixesGenerated.push('partner_relationship_undetermined');
        } else if (agr.required && !agr.ok) {
          generateFix({ userId, fixType: agr.fixType, tool: 'Relationships Register', description: `Partner '${partner.PartnerName}' — ${agr.required} not confirmed.`, severity: 'high', sourceRecordId: record?.id || null });
          fixesGenerated.push(agr.fixType);
        }
      }
      return res.json({ record, reputationScore, brandSafetyFlag, violationCount, fixesGenerated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── AFFILIATE-REGISTER handler (v7.3 preserved) ─────────────
async function handleAffiliateRegister(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Affiliate_Register', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    const { recordId, affiliate } = req.body;
    if (!userId)    return res.status(400).json({ error: 'userId required' });
    if (!affiliate) return res.status(400).json({ error: 'affiliate data required' });

    let exposureLow = 0, exposureHigh = 0;
    if (!recordId || affiliate.TotalVolumeSent !== undefined) {
      const volume = affiliate.TotalVolumeSent || 0;
      if (!affiliate.ConsentChainVerified) {
        exposureLow  = Math.min(Math.round(volume * 0.02), 50000);
        exposureHigh = Math.min(Math.round(volume * 0.08), 225000);
      }
      if (affiliate.SenderIdentityCompliant === 'Unverified') {
        exposureLow  += 5000;
        exposureHigh += 30000;
      }
    }

    // v7.5: Enforcement relevance check on affiliate create
    let enforcementResult = null;
    if (!recordId && affiliate.AffiliateName) {
      enforcementResult = await getRelevantEnforcement(base, affiliate.AffiliateName, affiliate.AffiliateType || 'affiliate', 'third-party promoter / email affiliate').catch(() => null);
    }

    const d = withDefaults(!recordId);

    const fields = {
      UserID: userId, AffiliateName: affiliate.AffiliateName, AffiliateType: affiliate.AffiliateType,
      DPAStatus: d(affiliate.DPAStatus, 'Not yet'),
      AgreementDate: affiliate.AgreementDate,
      // ConsentChainVerified can only be set TRUE by the consent-check action (2.6).
      ConsentChainVerified: recordId ? (affiliate.ConsentChainVerified === false ? false : undefined) : false,
      ConsentChainNotes: affiliate.ConsentChainNotes,
      SenderIdentityCompliant: d(affiliate.SenderIdentityCompliant, 'Unverified'),
      SenderIdentityNotes: affiliate.SenderIdentityNotes,
      FromNameUsed: affiliate.FromNameUsed,
      PrivacyPolicyUrl: affiliate.PrivacyPolicyUrl,
      CampaignLog: affiliate.CampaignLog,
      TotalVolumeSent: affiliate.TotalVolumeSent || null,
      LastCampaignDate: affiliate.LastCampaignDate,
      ICORiskLevel: affiliate.ICORiskLevel,
      DPAClauseResults: affiliate.DPAClauseResults,
      PrivacyReviewResults: affiliate.PrivacyReviewResults,
      ExposureEstimateLow: exposureLow || null,
      ExposureEstimateHigh: exposureHigh || null,
      Notes: affiliate.Notes,
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      RelationshipActivity: affiliate.RelationshipActivity,
      MarketingMaterialsReviewed: d(affiliate.MarketingMaterialsReviewed, false),
      AdDisclosureCompliant: d(affiliate.AdDisclosureCompliant, 'Unverified'),
      LandingPageReviewed: d(affiliate.LandingPageReviewed, false),
      ConsentWordingPasted: affiliate.ConsentWordingPasted,
      ConsentNameCheck: affiliate.ConsentNameCheck,
      ConsentVerifiedDate: affiliate.ConsentVerifiedDate,
      VerificationUrls: affiliate.VerificationUrls,
      CreativeLastReviewed: affiliate.CreativeLastReviewed,
      CreativeReviewResult: affiliate.CreativeReviewResult,
      FromNameUsedVerified: affiliate.FromNameUsedVerified,
      EnforcementRelevanceJson: enforcementResult ? JSON.stringify({ relevant: enforcementResult.relevant, rejected: enforcementResult.rejected, summary: enforcementResult.summary }) : undefined,
    };

    try {
      const record = recordId
        ? await atPatch(base, 'Affiliate_Register', recordId, fields)
        : await atCreate(base, 'Affiliate_Register', fields);

      const fixesGenerated = [];

if (!recordId) {
        const r = affiliateRequirements(fields);
        const name = affiliate.AffiliateName;
        const add = (fixType, description, severity, extra = {}) => {
          generateFix({ userId, fixType, tool: 'Relationships Register', description, severity, sourceRecordId: record?.id || null, ...extra });
          fixesGenerated.push(fixType);
        };
        if (r.consentNaming && !fields.ConsentChainVerified)
          add('affiliate_consent_unverified', `Affiliate '${name}': consent wording not checked. Consent an affiliate collected only covers your marketing if it names your organisation (PECR Reg 22; Saga Group 2021).`, 'critical', { exposureLow, exposureHigh });
        if (r.senderIdentity && fields.SenderIdentityCompliant === 'Unverified')
          add('affiliate_sender_identity_breach', `Affiliate '${name}' sender identity not verified. PECR Reg 23 requires the sender not be disguised or concealed.`, 'high');
        if (!fields.MarketingMaterialsReviewed)
          add('affiliate_misleading_claims', `Affiliate '${name}' marketing materials not reviewed against the CAP Code. You are responsible for claims made on your behalf.`, 'high');
        if (r.adDisclosure && fields.AdDisclosureCompliant !== 'Verified')
          add('affiliate_ad_disclosure', `Influencer '${name}' ad disclosure not verified. Paid content must be clearly identified as advertising (CAP Code 2.1).`, 'high');
        if (r.landingPage && !fields.LandingPageReviewed)
          add('lead_gen_consent_gap', `Affiliate '${name}' landing pages not reviewed. Consent captured there must name your organisation.`, 'critical');
        if (r.agreement && r.agreement !== 'unknown' && !isDPAConfirmed(fields.DPAStatus))
          add(r.role === 'our_list' ? 'dpa_breach' : 'affiliate_agreement_missing', `Affiliate '${name}' — no confirmed ${r.agreement}.`, 'high');
      }
      return res.json({ record, exposureLow, exposureHigh, fixesGenerated, enforcement: enforcementResult || { relevant: [], rejected: [], summary: 'Not checked.' } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── COMPETITOR-WATCH handler (v7.5 — claim cross-ref) ────────
async function handleCompetitorWatch(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Competitor_Watch', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    const { recordId, competitor } = req.body;
    if (!userId)     return res.status(400).json({ error: 'userId required' });
    if (!competitor) return res.status(400).json({ error: 'competitor data required' });

    let rulingCount = 0, lastRulingDate = null, lastRulingSummary = null, lastRulingRegulator = null;
    let allRulingsJson = null, recentPromoClaims = null;
    let enforcementResult = null;

    if (!recordId && competitor.CompetitorName) {
      // v7.5: Use relevance-filtered enforcement (with web search fallback)
      try {
        enforcementResult = await getRelevantEnforcement(base, competitor.CompetitorName, 'competitor', 'competitor being monitored for regulatory activity');
        rulingCount = enforcementResult.relevant.length;
        if (enforcementResult.relevant[0]) {
          lastRulingDate      = enforcementResult.relevant[0].DateOfAction || enforcementResult.relevant[0].date || null;
          lastRulingSummary   = enforcementResult.relevant[0].Violation || enforcementResult.relevant[0].violation || null;
          lastRulingRegulator = enforcementResult.relevant[0].Regulator || enforcementResult.relevant[0].regulator || null;
        }
        allRulingsJson = JSON.stringify(enforcementResult.relevant.slice(0, 5).map(v => ({
          date: v.DateOfAction || v.date || '', regulator: v.Regulator || v.regulator || '',
          summary: (v.Violation || v.violation || '').slice(0, 200), fine: v.FineAmount || v.fine || null,
          claimTypes: v.claimTypes || [],
        })));
      } catch (e) {
        console.error('Competitor enforcement non-fatal:', e);
        // Fallback to old method
        const viols = await getViolationsForName(base, competitor.CompetitorName);
        rulingCount = viols.length;
        if (viols[0]) {
          lastRulingDate      = viols[0].fields.DateOfAction || null;
          lastRulingSummary   = viols[0].fields.Violation    || null;
          lastRulingRegulator = viols[0].fields.Regulator    || null;
        }
        allRulingsJson = JSON.stringify(viols.slice(0, 5).map(v => ({
          date: v.fields.DateOfAction || '', regulator: v.fields.Regulator || '',
          summary: (v.fields.Violation || '').slice(0, 200), fine: v.fields.FineAmount || null,
        })));
      }

      // Promo tactics scan (public website only, no ad platforms)
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const promoRes = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6', max_tokens: 400,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{ role: 'user', content: `Search for current marketing promotions, discount claims, urgency claims, or pricing tactics being used by ${competitor.CompetitorName} on their public website in the UK right now. Do NOT access any advertising platforms such as Meta Ad Library, TikTok, or social media ad archives. Only check their public website and search results. Return ONLY a JSON array of up to 5 objects: [{"claimType":"fake_urgency|reference_pricing|superlative|free_claim|other","description":"brief description","complianceNote":"brief compliance observation"}]. No other text.` }],
            }),
          }), 20000);
          if (promoRes.ok) {
            const promoData = await promoRes.json();
            const text = promoData.content?.find(b => b.type === 'text')?.text || '';
            const match = text.match(/\[[\s\S]*\]/);
            if (match) recentPromoClaims = match[0];
          }
        } catch (e) { console.error('Promo scan non-fatal:', e); }
      }
    }

    const fields = {
      UserID: userId, CompetitorName: competitor.CompetitorName,
      Sector: competitor.Sector, WatchStatus: competitor.WatchStatus !== false,
      WebsiteUrl: competitor.WebsiteUrl,
      RecentPromoClaims: competitor.RecentPromoClaims || recentPromoClaims,
      RecentPromoDate: !recordId ? new Date().toISOString().split('T')[0] : undefined,
      RulingCount: competitor.RulingCount ?? rulingCount,
      LastRulingDate: competitor.LastRulingDate || lastRulingDate,
      LastRulingSummary: competitor.LastRulingSummary || lastRulingSummary,
      LastRulingRegulator: competitor.LastRulingRegulator || lastRulingRegulator,
      AllRulingsJson: competitor.AllRulingsJson || allRulingsJson,
      SectorRiskFlag: (rulingCount >= 2) || false,
      SectorRiskReason: rulingCount >= 2 ? `${rulingCount} relevant enforcement actions identified in sources reviewed.` : null,
      Notes: competitor.Notes,
      LastAutoChecked: new Date().toISOString().split('T')[0],
    };

    // v7.5: Cross-reference competitor claim types against user's active campaigns
    let claimCrossRef = null;
    if (!recordId && rulingCount > 0) {
      try {
        const dossiers = await atGet(base, 'Campaign_Dossiers',
          `AND({UserID}='${userId}',OR({DefenceStatus}='live',{DefenceStatus}='approved'))`, '', 20
        ).catch(() => []);
        if (dossiers.length) {
          const userClaimTypes = new Set();
          dossiers.forEach(d => {
            try { JSON.parse(d.fields.ClaimsExtracted || '[]').forEach(c => userClaimTypes.add(c.claimType)); } catch(e){}
          });
          const rulingTypes = [];
          const violationText = (allRulingsJson || '[]').toLowerCase();
          if (violationText.includes('price') || violationText.includes('pricing')) rulingTypes.push('pricing_claim');
          if (violationText.includes('urgency') || violationText.includes('limited')) rulingTypes.push('urgency_claim');
          if (violationText.includes('free') || violationText.includes('mislead')) rulingTypes.push('free_claim');
          const overlapping = rulingTypes.filter(t => userClaimTypes.has(t));
          if (overlapping.length) {
            claimCrossRef = { matchingClaimTypes: overlapping, activeCampaigns: dossiers.length, warning: `This competitor has enforcement history for ${overlapping.join(', ').replace(/_/g, ' ')} — you have ${dossiers.length} active campaign(s) using the same claim types.` };
          }
        }
      } catch(e) { console.error('Claim cross-ref non-fatal:', e); }
    }

    try {
      const record = recordId
        ? await atPatch(base, 'Competitor_Watch', recordId, fields)
        : await atCreate(base, 'Competitor_Watch', fields);
      return res.json({ record, rulingCount, lastRulingSummary, recentPromoClaims, claimCrossRef, enforcement: enforcementResult || { relevant: [], rejected: [], summary: 'Not checked.' } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SECTOR-INTELLIGENCE handler ──────────────────────────────
async function handleSectorIntelligence(req, res) {
  const { userId, sector, limit = '20' } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const base = airtableBase();
  let userSector = sector;
  if (!userSector) {
    const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
    userSector = profiles[0]?.fields?.Sector || 'general';
  }
  const [sectorFeed, generalFeed] = await Promise.all([
    atGet(base, 'Sector_Intelligence_Feed', `{Sector}='${userSector}'`, 'sort[0][field]=PublishedDate&sort[0][direction]=desc', parseInt(limit)).catch(() => []),
    atGet(base, 'Sector_Intelligence_Feed', `{Sector}='general'`, 'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10).catch(() => []),
  ]);
  const seen = new Set();
  const feed = [...sectorFeed, ...generalFeed].filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; }).sort((a, b) => new Date(b.fields.PublishedDate) - new Date(a.fields.PublishedDate));
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile  = profiles[0];
  if (profile?.id) {
    atPatch(base, 'User_Profile', profile.id, { LastIntelligenceFeedReview: new Date().toISOString().split('T')[0] }).catch(e => console.error('feed review update non-fatal:', e));
  }
  return res.json({ feed, sector: userSector, count: feed.length });
}

// ── COMPETITOR-INTELLIGENCE handler ──────────────────────────
async function handleCompetitorIntelligence(req, res) {
  const { userId, competitorName } = req.query;
  if (!userId || !competitorName) return res.status(400).json({ error: 'userId and competitorName required' });
  const base = airtableBase();
  const viols = await getViolationsForName(base, competitorName);
  const feedRecords = await atGet(base, 'Sector_Intelligence_Feed', `FIND('${competitorName.toLowerCase()}',LOWER({CompanyName}))`, 'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10).catch(() => []);
  return res.json({
    competitorName,
    violations: viols.slice(0, 10).map(v => ({ date: v.fields.DateOfAction || '', regulator: v.fields.Regulator || '', summary: v.fields.Violation || '', fine: v.fields.FineAmount || null })),
    feedMentions: feedRecords.length, totalRulings: viols.length,
  });
}

// ── RELATIONSHIP-WATCH handler (v7.5 — score-based alerts) ───
async function handleRelationshipWatch(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const base  = airtableBase();
  const today = new Date();
  const [vendors, partners, affiliates, competitors, profileRows] = await Promise.all([
    atGet(base, 'Vendor_Register',    `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Partner_Register',   `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Affiliate_Register', `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Competitor_Watch',   `AND({UserID}='${userId}',{WatchStatus}=1)`, '', 50).catch(() => []),
    atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []),
  ]);

  function staleDays(record) {
    const d = record.fields.LastChecked || record.fields.LastAutoChecked;
    return d ? Math.floor((today - new Date(d)) / 86400000) : null;
  }
  function anniversaryDays(dateStr) {
    if (!dateStr) return null;
    const ag = new Date(dateStr);
    const next = new Date(ag); next.setFullYear(today.getFullYear());
    if (next < today) next.setFullYear(today.getFullYear() + 1);
    return Math.floor((next - today) / 86400000);
  }
  function buildAlerts(type, name, record) {
    const alerts = [];
    const f = record.fields;
    const sd = staleDays(record);

    if (type !== 'competitor') {
      const enf = storedEnforcement(f);
      if (enf.length) alerts.push({ type: 'enforcement', severity: 'amber', text: `${enf.length} relevant enforcement action${enf.length !== 1 ? 's' : ''} identified in sources reviewed for ${name}.`, detail: enf.slice(0, 3) });
    }

    if (type === 'processor') {
      const dpa = f.DPAStatus || f.AgreementStatus || '';
      if (!isDPAConfirmed(dpa)) alerts.push({ type: 'dpa', severity: 'red', text: 'No confirmed DPA — Article 28 UK GDPR requirement not met.' });
      const { gaps, unanswered } = marketingGaps(safeJSON(f.MarketingChecksJson, null));
      if (gaps.length) alerts.push({ type: 'marketing', severity: gaps.some(g => g.severity === 'critical') ? 'red' : 'amber', text: `${gaps.length} marketing check${gaps.length !== 1 ? 's' : ''} need attention: ${gaps.map(g => g.label).join(', ')}.` });
      else if (unanswered) alerts.push({ type: 'marketing', severity: 'amber', text: `${unanswered} marketing check${unanswered !== 1 ? 's' : ''} not yet answered for how you use ${name}.` });
      if (sd !== null && sd > 90) alerts.push({ type: 'stale', severity: 'amber', text: `Evidence last reviewed ${sd} days ago. Quarterly re-review recommended.` });
      const ann = anniversaryDays(f.AgreementDate);
      if (ann !== null && ann <= 60) alerts.push({ type: 'anniversary', severity: ann <= 14 ? 'red' : 'amber', text: ann <= 0 ? 'Agreement anniversary was recent — confirm renewed.' : `Agreement anniversary in ${ann} days — review terms.` });
      if (typeof f.ComplianceScore === 'number' && f.ComplianceScore < 50) alerts.push({ type: 'assurance', severity: 'amber', text: `Vendor assurance score is ${f.ComplianceScore}/100 — review the evidence on the vendor.` });
    }

    if (type === 'partner') {
      const agr = partnerAgreementRequirement(f);
      if (agr.rel === 'unknown') alerts.push({ type: 'relationship', severity: 'amber', text: `Data relationship with ${name} not recorded — needed to know which agreement applies.` });
      else if (agr.required && !agr.ok) alerts.push({ type: 'agreement', severity: 'red', text: `No confirmed ${agr.required}.` });
      if (agr.rel !== 'none' && !f.ConsentChainVerified) alerts.push({ type: 'consent', severity: 'amber', text: `Consent for data shared with ${name} not checked.` });
      if (f.BrandSafetyFlag) alerts.push({ type: 'brand', severity: 'amber', text: f.BrandSafetyReason || 'Relevant enforcement history found.' });
      const act = f.RelationshipActivity || '';
      if (AD_ACTIVITIES.includes(act) && !f.AdComplianceReviewed) alerts.push({ type: 'ad_compliance', severity: 'amber', text: `Joint advertising content with ${name} not reviewed against CAP Code.` });
      if (PRICING_ACTIVITIES.includes(act) && !f.PricingComplianceReviewed) alerts.push({ type: 'pricing', severity: 'amber', text: `Pricing claims in campaigns with ${name} not verified against CMA/DMCCA 2024.` });
      if (agr.rel === 'joint_controller') {
        const ann = anniversaryDays(f.Article26Date);
        if (ann !== null && ann <= 60) alerts.push({ type: 'anniversary', severity: ann <= 14 ? 'red' : 'amber', text: `Article 26 arrangement review due in ${ann} days.` });
      }
    }

    if (type === 'affiliate') {
      const q = affiliateRequirements(f);
      if (q.role === 'unknown') alerts.push({ type: 'role', severity: 'amber', text: `How ${name} handles data is not recorded — this decides which checks apply.` });
      if (q.consentNaming && !f.ConsentChainVerified) alerts.push({ type: 'consent', severity: 'red', text: 'Consent wording not confirmed to name you — same exposure as sending without consent.' });
      if (q.senderIdentity && f.SenderIdentityCompliant === 'Unverified') alerts.push({ type: 'sender', severity: 'amber', text: 'Sender identity not verified — PECR Reg 23 risk.' });
      if (q.agreement && q.agreement !== 'unknown' && !isDPAConfirmed(f.DPAStatus)) alerts.push({ type: 'agreement', severity: 'amber', text: `No confirmed ${q.agreement}.` });
      if (!f.MarketingMaterialsReviewed) alerts.push({ type: 'materials', severity: 'amber', text: `Marketing materials for ${name} not reviewed against CAP Code.` });
      if (q.adDisclosure && f.AdDisclosureCompliant !== 'Verified') alerts.push({ type: 'disclosure', severity: 'red', text: `Influencer ${name} ad disclosure not verified — paid content must be clearly labelled.` });
      if (q.landingPage && !f.LandingPageReviewed) alerts.push({ type: 'landing_page', severity: 'amber', text: `Landing pages for ${name} not reviewed for consent capture.` });
    }

    if (type === 'competitor') {
      if (f.RulingCount > 0) alerts.push({ type: 'ruling', severity: 'amber', text: `${f.RulingCount} relevant enforcement action${f.RulingCount !== 1 ? 's' : ''} identified in sources reviewed.` });
      if (sd !== null && sd > 30) alerts.push({ type: 'stale', severity: 'amber', text: `Intelligence last updated ${sd} days ago.` });
    }
    return alerts;
  }

  const watch = [];
  for (const r of vendors) watch.push({ name: r.fields.VendorName || '', type: 'processor', alerts: buildAlerts('processor', r.fields.VendorName, r) });
  for (const r of partners) watch.push({ name: r.fields.PartnerName || '', type: 'partner', alerts: buildAlerts('partner', r.fields.PartnerName, r) });
  for (const r of affiliates) watch.push({ name: r.fields.AffiliateName || '', type: 'affiliate', alerts: buildAlerts('affiliate', r.fields.AffiliateName, r) });
  for (const r of competitors) watch.push({ name: r.fields.CompetitorName || '', type: 'competitor', alerts: buildAlerts('competitor', r.fields.CompetitorName, r) });

  const thirdPartyScore = await calculateThirdPartyScore(userId, base).catch(() => null);
  return res.json({ watch, thirdPartyScore, tradingName: profileRows[0]?.fields?.TradingName || '' });
}

// ── SUMMARY handler ──────────────────────────────────────────
async function handleSummary(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const [fixesRes, profileRes] = await Promise.all([
    fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`),
    fetch(`${APP_URL}/api/profile?action=get&userId=${userId}`),
  ]);
  const fixesData   = fixesRes.ok   ? await fixesRes.json()   : null;
  const profileData = profileRes.ok ? await profileRes.json() : null;
  const thirdPartyScore = await calculateThirdPartyScore(userId, airtableBase()).catch(() => null);
  return res.json({
    score: fixesData?.score ?? 0, scoreBand: fixesData?.scoreBand ?? 'Not Started',
    pendingCount: fixesData?.fixes?.pending?.length ?? 0, completedCount: fixesData?.fixes?.completed?.length ?? 0,
    actioned: fixesData?.actioned ?? { total: 0, count: 0 },
    categoryCounts: fixesData?.categoryCounts ?? { pending: { ico: 0, asa: 0, cma: 0 }, completed: { ico: 0, asa: 0, cma: 0 } },
    streak: profileData?.currentStreak ?? 0, longestStreak: profileData?.longestStreak ?? 0,
    lastCheckDate: profileData?.lastCheckDate ?? null, thirdPartyScore,
  });
}

// ── SCORE-HISTORY handler ────────────────────────────────────
async function handleScoreHistory(req, res) {
  const base = airtableBase();
  if (req.method === 'GET') {
    const { userId, limit = '30' } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const records = await atGet(base, 'Score_History', `{UserID}='${userId}'`, 'sort[0][field]=Date&sort[0][direction]=desc', Math.min(parseInt(limit) || 30, 90));
    return res.json({ snapshots: records.map(r => ({ id: r.id, date: r.fields.Date || '', score: r.fields.Score || 0, pending: r.fields.Pending || 0, completed: r.fields.Completed || 0, scoreChange: r.fields.ScoreChange || 0, triggerEvent: r.fields.TriggerEvent || '', thirdPartyRiskScore: r.fields.ThirdPartyRiskScore ?? null, processorScore: r.fields.ProcessorScore ?? null, partnerScore: r.fields.PartnerScore ?? null, affiliateScore: r.fields.AffiliateScore ?? null })) });
  }
  if (req.method === 'POST') {
    const { userId, score, pending = 0, completed = 0, triggerEvent = 'Dashboard Load' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (score === undefined) return res.status(400).json({ error: 'score required' });
    const prevRecords = await atGet(base, 'Score_History', `{UserID}='${userId}'`, 'sort[0][field]=Date&sort[0][direction]=desc', 1);
    const prevScore = prevRecords[0]?.fields?.Score ?? score;
    const scoreChange = score - prevScore;
    const thirdParty = await calculateThirdPartyScore(userId, base).catch(() => null);
    const today = new Date().toISOString().split('T')[0];
    const fields = { UserID: userId, Date: today, Score: score, Pending: pending, Completed: completed, ScoreChange: scoreChange, TriggerEvent: triggerEvent, AlertSent: false, ThirdPartyRiskScore: thirdParty?.total ?? null, ProcessorScore: thirdParty?.breakdown?.processors?.score ?? null, PartnerScore: thirdParty?.breakdown?.partners?.score ?? null, AffiliateScore: thirdParty?.breakdown?.affiliates?.score ?? null };
    const snap = await atCreate(base, 'Score_History', fields);
    let alertFired = false;
    if (scoreChange <= -10) {
      const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1);
      const profile = profiles[0];
      if (profile?.fields?.LastAlertSent !== today) {
        try {
          const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, alertType: 'score_drop', score, scoreChange }) });
          if (alertRes.ok) { alertFired = true; const patches = []; if (snap?.id) patches.push(atPatch(base, 'Score_History', snap.id, { AlertSent: true })); if (profile?.id) patches.push(atPatch(base, 'User_Profile', profile.id, { LastAlertSent: today })); await Promise.all(patches).catch(e => console.error('alert patch non-fatal:', e)); }
        } catch (e) { console.error('score-drop alert non-fatal:', e); }
      }
    }
    return res.json({ snapshotId: snap?.id, scoreChange, alertFired, thirdPartyScore: thirdParty });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SEND-ALERT handler ───────────────────────────────────────
async function handleSendAlert(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId, alertType } = req.body;
  if (!userId || !alertType) return res.status(400).json({ error: 'userId and alertType required' });
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.json({ sent: false, reason: 'RESEND_API_KEY not configured' });
  const base = airtableBase();
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const toEmail = profiles[0]?.fields?.Email;
  if (!toEmail) return res.json({ sent: false, reason: 'No email on profile' });

  const alertTemplates = {
    score_drop: { subject: `Your Sendwize compliance score dropped by ${Math.abs(req.body.scoreChange||0)} points`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Compliance score alert</h2><p style="color:#555;margin:0 0 24px;font-size:14px">Your score dropped by <strong>${Math.abs(req.body.scoreChange||0)} points</strong>, now at <strong>${req.body.score}/100</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View dashboard</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>` },
    consent_expiry: { subject: `Sendwize: consent expiry approaching`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Consent expiry notice</h2><p style="color:#555;margin:0 0 24px;font-size:14px">One or more segments have consent expiring within 30 days.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View dashboard</a></div></div>` },
    dpa_anniversary: { subject: `Sendwize: agreement anniversary approaching — ${req.body.entityName || 'a vendor'}`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Agreement anniversary alert</h2><p style="color:#555;font-size:14px">Your agreement with <strong>${req.body.entityName || 'a third party'}</strong> is due for review in <strong>${req.body.daysUntil || '30'} days</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open relationships register</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>` },
    competitor_ruling: { subject: `Sendwize: new ruling involving ${req.body.competitorName || 'a watched competitor'}`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Competitor intelligence alert</h2><p style="color:#555;font-size:14px"><strong>${req.body.competitorName || 'A competitor you watch'}</strong> appears in a new regulatory ruling: ${req.body.rulingSummary || ''}.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open sector intelligence</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>` },
    audience_damaged: { subject: `Sendwize: audience alert — ${req.body.segmentName || 'a segment'} needs attention`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Audience Read alert</h2><p style="color:#555;font-size:14px">Your <strong>${req.body.segmentName || 'audience'}</strong> segment has moved to <strong>${req.body.sentimentState || 'a negative state'}</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View Audience Read</a></div></div>` },
    dossier_compliance_change: { subject: `Sendwize: compliance change affecting ${req.body.campaignTitle || 'a campaign'}`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Campaign compliance alert</h2><p style="color:#555;margin:0 0 16px;font-size:14px">A new regulatory ruling affects claim types in <strong>${req.body.campaignTitle || 'Untitled'}</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open campaign dossier</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>` },
    segment_state_change: { subject: `Sendwize: ${req.body.segmentName || 'a segment'} moved to ${req.body.sentimentState || 'a new state'}`, html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Audience state change</h2><p style="color:#555;margin:0 0 20px;font-size:14px">Your <strong>${req.body.segmentName || 'audience'}</strong> segment has moved to <strong>${req.body.sentimentState || 'a warning state'}</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open Audience Read</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>` },
  };
  const tmpl = alertTemplates[alertType];
  if (!tmpl) return res.status(400).json({ error: `Unknown alertType: ${alertType}` });
  const resendRes = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: RESEND_FROM, to: [toEmail], subject: tmpl.subject, html: tmpl.html }) });
  if (!resendRes.ok) { const err = await resendRes.json().catch(() => ({})); return res.status(resendRes.status).json({ sent: false, reason: err.message || 'Resend error' }); }
  const data = await resendRes.json();
  return res.json({ sent: true, messageId: data.id });
}

// ── BRIEFING handler ─────────────────────────────────────────
async function handleBriefing(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const base = airtableBase();
  const today = new Date().toISOString().split('T')[0];
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile = profiles[0];
  if (profile?.fields?.LastBriefingSent === today) return res.json({ briefing: profile?.fields?.LastBriefingText || null, cached: true });
  const [fixesRes, vendors, partners, affiliates, competitors] = await Promise.all([
    fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`),
    atGet(base, 'Vendor_Register', `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Partner_Register', `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Affiliate_Register', `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Competitor_Watch', `AND({UserID}='${userId}',{WatchStatus}=1)`, '', 20).catch(() => []),
  ]);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;
  const pending = fixesData?.fixes?.pending || [];
  const score = fixesData?.score || 0;
  const thirdParty = await calculateThirdPartyScore(userId, base).catch(() => null);
for (const r of vendors.slice(0,5)) {
    const enf = safeJSON(r.fields.EnforcementRelevanceJson, {})?.relevant || [];
    if (enf.length) intelLines.push(`- Processor ${r.fields.VendorName}: ${enf.length} relevant enforcement action(s) identified.`);
    const { gaps } = marketingGaps(safeJSON(r.fields.MarketingChecksJson, null));
    if (gaps.length) intelLines.push(`- Processor ${r.fields.VendorName}: ${gaps.length} marketing check(s) need attention (${gaps.map(g => g.label).join(', ')}).`);
    const d = r.fields.LastChecked || r.fields.LastAutoChecked;
    if (d && Math.floor((Date.now()-new Date(d))/86400000) > 90) intelLines.push(`- Processor ${r.fields.VendorName}: not re-checked in 90+ days.`);
  }
  for (const r of partners.slice(0,5)) {
    const agr = partnerAgreementRequirement(r.fields);
    if (agr.rel === 'unknown') intelLines.push(`- Partner ${r.fields.PartnerName}: data relationship not recorded.`);
    else if (agr.required && !agr.ok) intelLines.push(`- Partner ${r.fields.PartnerName}: no confirmed ${agr.required}.`);
  }
  for (const r of affiliates.slice(0,5)) {
    if (affiliateRequirements(r.fields).consentNaming && !r.fields.ConsentChainVerified) intelLines.push(`- Affiliate ${r.fields.AffiliateName}: consent wording not confirmed to name you.`);
  }
  for (const r of competitors.slice(0,5)) {
    if ((r.fields.RulingCount || 0) > 0) intelLines.push(`- Competitor ${r.fields.CompetitorName}: ${r.fields.RulingCount} relevant enforcement action(s) on record.`);
  }
  const promptContext = [`Compliance score: ${score}/100`, `Third-party risk score: ${thirdParty?.total ?? 'not calculated'}/100`, `Processors: ${vendors.length}, Partners: ${partners.length}, Affiliates: ${affiliates.length}, Competitors watched: ${competitors.length}`, `Pending fixes: ${pending.length}`, intelLines.length ? `\nRelationship intelligence:\n${intelLines.join('\n')}` : '\nNo relationship alerts this week.'].join('\n');
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: `You are a compliance advisor for UK email marketers. Write a concise weekly briefing of 180-220 words. Never say "compliant" or "in breach". Never give legal advice. Plain English.`, messages: [{ role: 'user', content: `Status:\n${promptContext}\n\nWrite the weekly briefing.` }] }) });
  if (!claudeRes.ok) return res.status(claudeRes.status).json({ error: 'Failed to generate briefing' });
  const briefing = (await claudeRes.json()).content?.[0]?.text || '';
  if (profile?.id) atPatch(base, 'User_Profile', profile.id, { LastBriefingSent: today, LastBriefingText: briefing }).catch(e => console.error('briefing save non-fatal:', e));
  return res.json({ briefing, cached: false });
}

// ── CONSENT-EXPIRY-CHECK ─────────────────────────────────────
async function handleConsentExpiryCheck(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const base = airtableBase();
  const today = new Date().toISOString().split('T')[0];
  const audits = await atGet(base, 'Database_Audits', `{UserID}='${userId}'`, 'sort[0][field]=AuditDate&sort[0][direction]=desc', 1).catch(() => []);
  const audit = audits[0];
  if (!audit) return res.json({ checked: true, alertFired: false, expiringIn30: 0, expiringIn60: 0, expiringIn90: 0 });
  let expiryTimeline = []; try { expiryTimeline = JSON.parse(audit.fields.ExpiryTimeline || '[]'); } catch {}
  const d30 = new Date(); d30.setDate(d30.getDate()+30); const d60 = new Date(); d60.setDate(d60.getDate()+60); const d90 = new Date(); d90.setDate(d90.getDate()+90);
  let e30=0, e60=0, e90=0;
  expiryTimeline.forEach(s => { if (!s.expiryDate) return; const exp = new Date(s.expiryDate); const count = s.count||1; if (exp<=d30) e30+=count; else if (exp<=d60) e60+=count; else if (exp<=d90) e90+=count; });
  if (!e30) return res.json({ checked: true, alertFired: false, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile = profiles[0];
  const lastAlert = profile?.fields?.LastAlertSent || '';
  if (lastAlert && Math.floor((new Date(today)-new Date(lastAlert))/86400000) < 7) return res.json({ checked: true, alertFired: false, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
  const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, alertType: 'consent_expiry' }) }).catch(() => ({ ok: false }));
  if (profile?.id) atPatch(base, 'User_Profile', profile.id, { LastAlertSent: today }).catch(() => {});
  return res.json({ checked: true, alertFired: alertRes.ok, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
}

// ── VENDOR-WATCH (legacy compat) ─────────────────────────────
async function handleVendorWatch(req, res) { return handleRelationshipWatch(req, res); }

// ── SIMULATION-RUN ───────────────────────────────────────────
async function handleSimulationRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId, regulator } = req.body;
  if (!userId || !regulator) return res.status(400).json({ error: 'userId and regulator required' });
  if (!['ICO','CMA','ASA'].includes(regulator)) return res.status(400).json({ error: 'regulator must be ICO | CMA | ASA' });
  const base = airtableBase();
  const fixesRes = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;
  const pendingFixes = fixesData?.fixes?.pending || [];
  const score = fixesData?.score || 0;
  const criticalFixes = pendingFixes.filter(f => f.severity === 'critical');
  const highFixes = pendingFixes.filter(f => f.severity === 'high');
  const escalationBand = criticalFixes.length > 0 ? 'serious' : (highFixes.length > 0 || score < 50) ? 'elevated' : 'standard';
  const bandConfig = { standard: { label:'Standard Risk', colour:'#16a34a', bgColour:'#f0fdf4', borderColour:'#bbf7d0' }, elevated: { label:'Elevated Risk', colour:'#ca8a04', bgColour:'#fefce8', borderColour:'#fef08a' }, serious: { label:'Serious Risk', colour:'#dc2626', bgColour:'#fef2f2', borderColour:'#fecaca' } };
  const bandDescriptions = { ICO: { standard:'Your compliance data does not show the patterns the ICO most commonly investigates.', elevated:'Your data shows patterns the ICO actively investigates.', serious:'Your data shows critical compliance gaps that have formed the basis of ICO enforcement action.' }, ASA: { standard:'Your compliance data does not show the patterns the ASA most commonly receives upheld complaints about.', elevated:'Your data shows patterns associated with ASA complaints.', serious:'Your data shows critical CAP Code concerns.' }, CMA: { standard:'Your compliance data does not match the patterns the CMA has targeted.', elevated:'Your data shows patterns the CMA has identified in proactive sweeps.', serious:'Your data shows practices that may constitute Schedule 1 banned practices under DMCCA 2024.' } };
  const categoryFixes = pendingFixes.filter(f => f.exposure?.category === regulator);
  const fixList = (categoryFixes.length ? categoryFixes : pendingFixes).slice(0,8).map(f => `- ${f.fixType.replace(/_/g,' ')} (${f.severity}): ${String(f.description||'').slice(0,250)}`).join('\n') || 'No pending fixes.';
  const regCfg = { ICO: { orgName:"Information Commissioner's Office", refPrefix:'ICO-ENF', signatory:'Senior Enforcement Officer, Direct Marketing Team', tone:'formal ICO enforcement tone, reference PECR Regulation 22 and UK GDPR articles by number' }, ASA: { orgName:'Advertising Standards Authority', refPrefix:'ASA-ENQ', signatory:'Investigations Executive, ASA', tone:'formal ASA tone, reference specific CAP Code rules by number' }, CMA: { orgName:'Competition and Markets Authority', refPrefix:'CMA-CP', signatory:'Senior Director, Consumer Protection', tone:'formal CMA enforcement tone under DMCCA 2024' } }[regulator];
  let letter = {};
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:2000, messages:[{ role:'user', content: `Simulate a ${regulator} enforcement letter. USER PENDING FIXES:\n${fixList}\n\nTone: ${regCfg.tone}. Return ONLY JSON (no markdown):\n{"reference":"${regCfg.refPrefix}-XXXXX","subject":"...","opening":"...","context":"...","closing":"...","signatory":"${regCfg.signatory}","questions":[{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."}]}` }] }) });
    if (r.ok) { const text = (await r.json()).content?.[0]?.text||''; const m = text.match(/\{[\s\S]*\}/); if (m) letter = JSON.parse(m[0]); }
  } catch (e) { console.error('Letter parse non-fatal:', e); }
  const thisBand = bandConfig[escalationBand];
  return res.status(200).json({ regulator, stage1: { checks: [] }, stage2: { band: escalationBand, bandLabel: thisBand.label, bandColour: thisBand.colour, bandBg: thisBand.bgColour, bandBorder: thisBand.borderColour, bandDescription: (bandDescriptions[regulator]||bandDescriptions.ICO)[escalationBand], factors: [] }, stage3: { letter }, stage4: { documents: [] }, stage5: { penalty: { low:0, high:0, context:'' }, representations:[] } });
}

// ── DOSSIER-TOGGLE-MONITORING handler ────────────────────────
async function handleDossierToggleMonitoring(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId, dossierId, monitoringActive, complianceAlerts } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });
  const base = airtableBase();
  const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: atHeaders(process.env.AIRTABLE_TOKEN) });
  if (!dr.ok) return res.status(404).json({ error: 'Dossier not found' });
  const record = await dr.json();
  if (record.fields?.UserID !== userId) return res.status(403).json({ error: 'Not authorised' });
  const patch = {};
  if (monitoringActive !== undefined) patch.MonitoringActive = !!monitoringActive;
  if (complianceAlerts !== undefined) patch.ComplianceAlertsJson = complianceAlerts;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  try { await atPatch(base, 'Campaign_Dossiers', dossierId, patch); return res.json({ success: true, dossierId, updated: Object.keys(patch) }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    if (action === 'report'                  && req.method === 'GET')                       return await handleReport(req, res);
    if (action === 'vendors'                 && req.method === 'GET')                       return await handleVendors(req, res);
    if (action === 'violations'              && req.method === 'GET')                       return await handleViolations(req, res);
    if (action === 'load'                    && req.method === 'POST')                      return await handleLoad(req, res);
    if (action === 'history'                 && req.method === 'GET')                       return await handleHistory(req, res);
    if (action === 'summary'                 && req.method === 'GET')                       return await handleSummary(req, res);
    if (action === 'marketing-checks'         && req.method === 'GET')                      return await handleMarketingCheck(req, res);
    if (action === 'marketing-check'          && req.method === 'POST')                     return await handleMarketingCheck(req, res);
    if (action === 'consent-check'            && req.method === 'POST')                     return await handleConsentCheck(req, res);

    if (action === 'register'                && ['POST','DELETE'].includes(req.method))     return await handleRegister(req, res);
    if (action === 'score-history'           && ['GET','POST'].includes(req.method))        return await handleScoreHistory(req, res);
    if (action === 'send-alert'              && req.method === 'POST')                      return await handleSendAlert(req, res);
    if (action === 'briefing'                && req.method === 'GET')                       return await handleBriefing(req, res);
    if (action === 'consent-expiry-check'    && req.method === 'POST')                      return await handleConsentExpiryCheck(req, res);
    if (action === 'simulation-run'          && req.method === 'POST')                      return await handleSimulationRun(req, res);
    if (action === 'vendor-watch'            && req.method === 'GET')                       return await handleVendorWatch(req, res);
    if (action === 'relationship-watch'      && req.method === 'GET')                       return await handleRelationshipWatch(req, res);
    if (action === 'sector-intelligence'     && req.method === 'GET')                       return await handleSectorIntelligence(req, res);
    if (action === 'competitor-intelligence' && req.method === 'GET')                       return await handleCompetitorIntelligence(req, res);
    if (action === 'partner-register'        && ['POST','DELETE'].includes(req.method))     return await handlePartnerRegister(req, res);
    if (action === 'affiliate-register'      && ['POST','DELETE'].includes(req.method))     return await handleAffiliateRegister(req, res);
    if (action === 'competitor-watch'        && ['POST','DELETE'].includes(req.method))     return await handleCompetitorWatch(req, res);
    if (action === 'backfill-processor-fixes' && req.method === 'POST')                     return await handleBackfillProcessorFixes(req, res);
    if (action === 'cron-status'              && req.method === 'GET')                      return await handleCronStatus(req, res);
    if (action === 'dossier-toggle-monitoring' && req.method === 'POST')                     return await handleDossierToggleMonitoring(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
}
