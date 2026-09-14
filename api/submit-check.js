// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v5.1
// v5.1 changes:
//   + Campaign Defence: defence-assemble, defence-approve,
//     defence-add-event endpoints added (clearly marked below)
//   + Complaint-ready response pack generation on approval
//   + Evidence hashing (SHA-256 tamper-evident timestamps)
//   + Multi-channel support (channel selector, adaptive evidence)
//   + Claim-to-fix pipeline feeds dashboard £ exposure
//   + handleDossierGet returns all Defence fields
//   + handleDossierList returns defenceStatus + channels
//
// v4.32: Campaign monitoring integration.
//        - MonitoringActive set true on submit
//        - extractLandingPageUrls() captures URLs for drift detection
//        - RefPriceAlertStage initialised for reference price expiry
//        - handleDossierGet returns monitoring fields
//
// v4.31: "The Letter" — dossier-submit now returns a letter object.
//        Clear campaigns get a Clearance Notice (no AI call).
//        Weak/Adequate campaigns get a Claude-drafted simulated
//        regulator letter in the appropriate voice (ICO, ASA, CMA).
//        Every letter is watermarked SIMULATION — NOT ACTUAL
//        REGULATOR CORRESPONDENCE.
//        One Claude call per submit, weakest lens first.
//        Model: claude-sonnet-4-6, max_tokens 1000.
//
// v4.30: All direct Airtable calls now go through atFetch() for
//        429/5xx retry with backoff.
// v4.29: Dossier re-verification (stickiness). LastVerified stamp.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

const APP_URL      = 'https://sendwize-backend.vercel.app';
const REVERIFY_DAYS = 90;

const DOSSIER_MODULES = [
  'ListProvenance', 'ConsentMechanism', 'ContentCheck', 'Suppression', 'SenderIdentity',
];

function serialiseModuleFields(key, fields) {
  if (!fields || typeof fields !== 'object') return '';
  const lines = [];
  if (key === 'ListProvenance') {
    if (fields.listSource)       lines.push(`List source: ${fields.listSource}`);
    if (fields.collectionUrl)    lines.push(`Collection URL: ${fields.collectionUrl}`);
    if (fields.collectionMech)   lines.push(`Collection mechanism: ${fields.collectionMech}`);
    if (fields.dateFrom)         lines.push(`Date range: ${fields.dateFrom}${fields.dateTo ? ` – ${fields.dateTo}` : ''}`);
    if (fields.ownership)        lines.push(`Ownership: ${fields.ownership}`);
    if (fields.notes)            lines.push(`Notes: ${fields.notes}`);
  }
  if (key === 'ConsentMechanism') {
    if (fields.lawfulBasis)      lines.push(`Lawful basis: ${fields.lawfulBasis}`);
    if (fields.consentWording)   lines.push(`Consent wording: ${fields.consentWording}`);
    if (fields.dateFrom)         lines.push(`Consent collected: ${fields.dateFrom}${fields.dateTo ? ` – ${fields.dateTo}` : ''}`);
    if (fields.softOptIn1)       lines.push(`Soft opt-in — own similar products: ${fields.softOptIn1 ? 'Yes' : 'No'}`);
    if (fields.softOptIn2)       lines.push(`Soft opt-in — chance to opt out at collection: ${fields.softOptIn2 ? 'Yes' : 'No'}`);
    if (fields.softOptIn3)       lines.push(`Soft opt-in — opt-out in every message: ${fields.softOptIn3 ? 'Yes' : 'No'}`);
    if (fields.softOptIn4)       lines.push(`Soft opt-in — B2C contact: ${fields.softOptIn4 ? 'Yes' : 'No'}`);
    if (fields.liaSummary)       lines.push(`LIA summary: ${fields.liaSummary}`);
    if (fields.notes)            lines.push(`Notes: ${fields.notes}`);
  }
  if (key === 'ContentCheck') {
    if (fields.aiCheckerRun)         lines.push(`AI Copy Checker: ${fields.aiCheckerRun}`);
    if (fields.aiCheckerScore)       lines.push(`AI Checker score: ${fields.aiCheckerScore}`);
    if (fields.asaReviewed)          lines.push(`ASA CAP Code review: ${fields.asaReviewed}`);
    if (fields.substantiatedClaims)  lines.push(`Substantiated claims: ${fields.substantiatedClaims}`);
    if (fields.pricingCompliant)     lines.push(`Pricing compliance: ${fields.pricingCompliant}`);
    if (fields.referencePriceEvidence) lines.push(`Reference price evidence: ${fields.referencePriceEvidence}`);
    if (fields.urgencyGenuine)       lines.push(`Urgency genuine: ${fields.urgencyGenuine}`);
    if (fields.amendments)           lines.push(`Amendments made: ${fields.amendments}`);
    if (fields.notes)                lines.push(`Notes: ${fields.notes}`);
  }
  if (key === 'Suppression') {
    if (fields.suppressionApplied)   lines.push(`Suppression applied: ${fields.suppressionApplied}`);
    if (fields.dateApplied)          lines.push(`Date applied: ${fields.dateApplied}`);
    if (fields.listLastUpdated)      lines.push(`List last updated: ${fields.listLastUpdated}`);
    if (fields.contactsCount !== undefined) lines.push(`Contacts suppressed: ${fields.contactsCount}`);
    if (fields.hardBouncesExcluded)  lines.push(`Hard bounces excluded: ${fields.hardBouncesExcluded}`);
    if (fields.sendwizeCheckScore)   lines.push(`Sendwize suppression check: ${fields.sendwizeCheckScore}/100`);
    if (fields.notes)                lines.push(`Notes: ${fields.notes}`);
  }
  if (key === 'SenderIdentity') {
    if (fields.fromName)             lines.push(`From name: ${fields.fromName}`);
    if (fields.fromEmail)            lines.push(`From email: ${fields.fromEmail}`);
    if (fields.matchesTradingName)   lines.push(`Matches trading name: ${fields.matchesTradingName}`);
    if (fields.businessAddress)      lines.push(`Business address in footer: ${fields.businessAddress}`);
    if (fields.unsubscribePresent)   lines.push(`Unsubscribe present: ${fields.unsubscribePresent}`);
    if (fields.replyToAddress)       lines.push(`Reply-to: ${fields.replyToAddress}`);
    if (fields.replyToMonitor)       lines.push(`Reply-to monitored: ${fields.replyToMonitor}`);
    if (fields.notes)                lines.push(`Notes: ${fields.notes}`);
  }
  return lines.join('\n');
}

const REQUIRED_FIELDS = {
  ListProvenance:   ['listSource', 'collectionMech', 'ownership'],
  ConsentMechanism: ['lawfulBasis', 'consentWording', 'dateFrom'],
  ContentCheck:     ['aiCheckerRun', 'asaReviewed', 'pricingCompliant'],
  Suppression:      ['suppressionApplied', 'dateApplied', 'listLastUpdated'],
  SenderIdentity:   ['fromName', 'fromEmail', 'matchesTradingName', 'unsubscribePresent'],
};

const OPTIONAL_FIELDS = {
  ListProvenance:   ['collectionUrl', 'dateFrom', 'dateTo', 'notes'],
  ConsentMechanism: ['softOptIn1', 'softOptIn2', 'softOptIn3', 'softOptIn4', 'liaSummary', 'dateTo', 'notes'],
  ContentCheck:     ['aiCheckerScore', 'substantiatedClaims', 'amendments', 'referencePriceEvidence', 'urgencyGenuine', 'notes'],
  Suppression:      ['contactsCount', 'hardBouncesExcluded', 'sendwizeCheckScore', 'notes'],
  SenderIdentity:   ['businessAddress', 'replyToAddress', 'replyToMonitor', 'notes'],
};

function calculateModuleStrength(key, fields) {
  if (!fields || typeof fields !== 'object') return 'Weak';
  const req = REQUIRED_FIELDS[key] || [];
  const opt = OPTIONAL_FIELDS[key] || [];
  const reqFilled = req.filter(f => { const v = fields[f]; return v !== undefined && v !== null && v !== '' && v !== false; }).length;
  const optFilled = opt.filter(f => { const v = fields[f]; return v !== undefined && v !== null && v !== '' && v !== false; }).length;
  if (reqFilled < req.length) return 'Weak';
  if (optFilled === 0) return 'Adequate';
  return 'Strong';
}

function calculateOverallStrength(allModuleFields) {
  const strengths = DOSSIER_MODULES.map(k => calculateModuleStrength(k, allModuleFields[k] || {}));
  const score = strengths.reduce((s, v) => s + (v === 'Strong' ? 2 : v === 'Adequate' ? 1 : 0), 0);
  if (score >= 8) return 'Strong';
  if (score >= 4) return 'Adequate';
  return 'Weak';
}

const MODULE_WEIGHTS = {
  ListProvenance: 16.67, ConsentMechanism: 25, ContentCheck: 16.67, Suppression: 25, SenderIdentity: 16.66,
};

function calculateHealthScore(allModuleFields) {
  let total = 0;
  for (const [key, weight] of Object.entries(MODULE_WEIGHTS)) {
    const strength = calculateModuleStrength(key, allModuleFields[key] || {});
    const moduleScore = strength === 'Strong' ? 100 : strength === 'Adequate' ? 65 : 20;
    total += (moduleScore * weight) / 100;
  }
  return Math.round(total);
}

// ── THE LETTER — v4.31 ──────────────────────────────────────────────────────
function determineWeakestLens(moduleFields) {
  const ico = ['ListProvenance', 'ConsentMechanism', 'Suppression', 'SenderIdentity'];
  const asa = ['ContentCheck', 'SenderIdentity'];
  const cma = ['ContentCheck'];

  const score = mods => mods.reduce((s, k) => {
    const st = calculateModuleStrength(k, moduleFields[k] || {});
    return s + (st === 'Weak' ? 2 : st === 'Adequate' ? 1 : 0);
  }, 0);

  const scores = { ico: score(ico), asa: score(asa), cma: score(cma) };
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function buildGapSummary(moduleFields) {
  const gaps = [];
  for (const key of DOSSIER_MODULES) {
    const fields = moduleFields[key] || {};
    const req = REQUIRED_FIELDS[key] || [];
    const missing = req.filter(f => {
      const v = fields[f];
      return v === undefined || v === null || v === '' || v === false;
    });
    if (missing.length > 0) {
      gaps.push(`${key}: missing ${missing.join(', ')}`);
    }
    if (key === 'ContentCheck') {
      if (fields.pricingCompliant && fields.pricingCompliant.toLowerCase().includes('no')) gaps.push('ContentCheck: pricing compliance not confirmed');
      if (fields.urgencyGenuine && fields.urgencyGenuine === 'Not confirmed') gaps.push('ContentCheck: urgency/scarcity not verified');
      if (fields.aiCheckerRun && fields.aiCheckerRun.includes('issues found')) gaps.push('ContentCheck: AI checker found unresolved issues');
    }
    if (key === 'Suppression') {
      if (fields.suppressionApplied === 'No — not yet applied') gaps.push('Suppression: suppression list not applied');
    }
    if (key === 'ConsentMechanism') {
      if (fields.lawfulBasis === 'Legitimate interest (UK GDPR)' && !fields.liaSummary) gaps.push('ConsentMechanism: LI basis claimed but no LIA on record');
    }
  }
  return gaps.join('\n');
}

function buildClearanceNotice(campaignTitle, ownerName, dossierId, healthScore) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `CAMPAIGN COMPLIANCE CLEARANCE NOTICE
─────────────────────────────────────────────
Dossier Reference: ${dossierId ? dossierId.slice(0, 12).toUpperCase() : 'SW-DRAFT'}
Date: ${today}
Prepared by: Sendwize Compliance Documentation

CAMPAIGN: ${campaignTitle || 'Untitled Campaign'}
OWNER: ${ownerName || '—'}
DOSSIER HEALTH SCORE: ${healthScore}/100

This notice confirms that the above-named campaign has a completed compliance evidence file covering all five required modules: List Provenance, Consent Mechanism, Content Check, Suppression, and Sender Identity.

EVIDENCE SUMMARY
─────────────────
All five dossier modules are complete. Required fields are populated across List Provenance, Consent Mechanism, Content Check, Suppression, and Sender Identity.

The evidence on file demonstrates:
• A documented lawful basis for sending
• A clear record of how contact data was collected
• Content reviewed against ICO, ASA and CMA requirements
• Suppression lists applied before send
• Sender clearly identified with a functional unsubscribe mechanism

This dossier was prepared and submitted via Sendwize on ${today}.

─────────────────────────────────────────────
INFORMATION ONLY — NOT LEGAL ADVICE
This certificate documents evidence provided by the campaign owner and does not constitute legal compliance assurance. Regulatory outcomes depend on circumstances at the time of any investigation.`;
}

function buildLetterPrompt(lens, campaignTitle, ownerName, gaps) {
  const lensConfig = {
    ico: {
      from: 'Information Commissioner\'s Office\nWycliffe House, Water Lane, Wilmslow, Cheshire, SK9 5AF\nhttps://ico.org.uk',
      subject: `Information Notice — ${campaignTitle || 'Email Marketing Campaign'}`,
      openingStyle: 'formal information notice, numbered paragraphs, ICO register. Cites specific PECR Regulation numbers (Reg 22, Reg 23) and UK GDPR articles. Requests specific documentary evidence with a response deadline. Tone: legal, precise, measured — not aggressive.',
      evidenceRequests: 'consent records and collection mechanism documentation, suppression list records and opt-out processing logs, legitimate interest assessment if LI basis claimed, data retention policy',
    },
    asa: {
      from: 'Advertising Standards Authority\nCastle House, 37–45 Paul Street, London EC2A 4LS\nhttps://www.asa.org.uk',
      subject: `Formal Investigation Notice — ${campaignTitle || 'Email Marketing Campaign'}`,
      openingStyle: 'ASA investigation opener. References specific CAP Code rule numbers (e.g. 3.1, 3.3, 3.7, 8.1). Identifies the specific claim or pricing issue at stake. Notes possible outcomes: ruling, withdrawal, mandatory pre-vetting. Tone: regulatory but practical, not legal.',
      evidenceRequests: 'evidence substantiating any claims made, pricing history for any reference prices used, basis for any urgency or scarcity language, sender identity documentation',
    },
    cma: {
      from: 'Competition and Markets Authority\nThe Cabot, 25 Cabot Square, London E14 4QZ\nhttps://www.gov.uk/cma',
      subject: `CMA Formal Enquiry — ${campaignTitle || 'Email Marketing Campaign'}`,
      openingStyle: 'CMA enquiry letter under DMCCA 2024. Frames in consumer protection terms. For first-time issues: undertakings framing, not immediate enforcement. Cites DMCCA 2024 Schedule 1 or Part 4 as relevant. Requests commercial documentation. Tone: consumer protection authority, businesslike, clear consequences stated.',
      evidenceRequests: 'pricing history for any reference prices (minimum 28 consecutive days at advertised "was" price), evidence for any scarcity or urgency claims, review authenticity documentation if reviews referenced',
    },
  };

  const cfg = lensConfig[lens];

  return `You are drafting a realistic simulated regulatory letter for Sendwize, a UK marketing compliance SaaS. This letter will be shown to users to help them understand the regulatory consequences of the gaps in their campaign compliance dossier.

IMPORTANT RULES:
1. Begin the letter with this exact watermark line on its own: "SIMULATION — NOT ACTUAL REGULATOR CORRESPONDENCE"
2. Then a blank line, then start the letter
3. Write in the authentic voice and format of: ${cfg.from.split('\n')[0]}
4. Address the letter to: ${ownerName || 'The Marketing Team'}
5. Subject: ${cfg.subject}
6. Style: ${cfg.openingStyle}
7. Reference the specific gaps found in this dossier (listed below) — do not invent facts
8. Request the following evidence: ${cfg.evidenceRequests}
9. Keep total length to 350-450 words
10. End with the sender's name/title and office — realistic but not a real person's name

FROM:
${cfg.from}

COMPLIANCE GAPS FOUND IN THIS DOSSIER:
${gaps || 'General compliance gaps identified across the dossier modules.'}

CAMPAIGN DETAILS:
Campaign: ${campaignTitle || 'Unnamed campaign'}
Owner: ${ownerName || 'Not specified'}

Write the letter now. Start with the watermark line, then the letter. No preamble or explanation — just the letter.`;
}

async function generateLetter(moduleFields, evidenceStrength, campaignTitle, ownerName, dossierId, healthScore) {
  if (evidenceStrength === 'Strong') {
    return {
      type:    'clearance',
      lens:    null,
      content: buildClearanceNotice(campaignTitle, ownerName, dossierId, healthScore),
      generatedAt: new Date().toISOString(),
    };
  }

  const lens = determineWeakestLens(moduleFields);
  const gaps = buildGapSummary(moduleFields);
  const prompt = buildLetterPrompt(lens, campaignTitle, ownerName, gaps);

  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
    const data = await r.json();
    const content = data.content?.[0]?.text || '';

    const watermarked = content.startsWith('SIMULATION')
      ? content
      : 'SIMULATION — NOT ACTUAL REGULATOR CORRESPONDENCE\n\n' + content;

    return {
      type:        'letter',
      lens,
      content:     watermarked,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('generateLetter Claude call failed (non-fatal):', e);
    return {
      type: 'letter',
      lens,
      content: `SIMULATION — NOT ACTUAL REGULATOR CORRESPONDENCE\n\nWe were unable to generate a personalised letter at this time. Based on the gaps identified in your dossier, the ${lens.toUpperCase()} would be likely to request evidence addressing: ${buildGapSummary(moduleFields) || 'the incomplete fields in your compliance record'}.\n\nPlease review and complete all required fields in your dossier.`,
      generatedAt: new Date().toISOString(),
      fallback: true,
    };
  }
}
// ── END THE LETTER ───────────────────────────────────────────────────────────

function refineSeverity(fixType, emailVolume) {
  const isLarge = ['large_send', 'enterprise_send'].includes(emailVolume);
  const isMicro = ['micro_send', 'small_send'].includes(emailVolume);
  const rules = {
    invalid_consent_mechanism: 'critical',
    missing_unsubscribe:       isLarge ? 'critical' : 'high',
    expired_consent:           isLarge ? 'critical' : isMicro ? 'medium' : 'high',
    suppressed_contact:        isLarge ? 'critical' : 'high',
    no_soft_optin:             isLarge ? 'critical' : 'high',
    frequency_abuse:           isLarge ? 'high' : 'medium',
    dark_pattern:              isLarge ? 'critical' : 'high',
    misleading_pricing:        'high',
    misleading_claim:          'high',
    fake_urgency:              'medium',
    third_party_list:          'high',
  };
  return rules[fixType] || null;
}

const ISSUE_TO_FIX = {
  'No suppression list system':               { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: No suppression list system in place.' },
  'No suppression list screening (email)':    { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Suppression list not screened before email campaign.' },
  'Purchased email data lacks named consent': { fixType: 'third_party_list',          severity: 'high',     description: 'Dossier: Purchased email list lacks consent naming this organisation.' },
  'Third-party data due diligence incomplete':{ fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: Due diligence on third-party data source not completed.' },
  'Third-party data provenance unverifiable': { fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: Cannot verify provenance of purchased/rented data.' },
  'Consent not freely given':                 { fixType: 'invalid_consent_mechanism', severity: 'critical', description: 'Dossier: Consent was not freely given.' },
  'No opt-out mechanism':                     { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: No opt-out mechanism included.' },
  'No opt-out at point of collection':        { fixType: 'missing_unsubscribe',       severity: 'high',     description: 'Dossier: No opt-out offered when contact details were collected.' },
  'No opt-out in every communication':        { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Opt-out not included in every communication.' },
  'PECR consent invalid':                     { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: PECR consent does not meet the required standard.' },
  'Soft opt-in for different products':       { fixType: 'no_soft_optin',             severity: 'high',     description: 'Dossier: Soft opt-in applied to different products — express consent required.' },
  'Third-party consent unusable for email':   { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Third-party consent cannot be used for email.' },
  'Misleading claim in content':              { fixType: 'misleading_claim',          severity: 'high',     description: 'Dossier: Content contains a misleading claim.' },
  'Fake urgency or scarcity':                 { fixType: 'fake_urgency',              severity: 'medium',   description: 'Dossier: Content uses urgency or scarcity language not reflecting genuine constraints.' },
  'Misleading pricing':                       { fixType: 'misleading_pricing',        severity: 'high',     description: 'Dossier: Reference pricing does not comply with DMCCA 2024.' },
  'Health claim not authorised':              { fixType: 'unauthorised_health_claim', severity: 'high',     description: 'Dossier: Health claim not on UK authorised register.' },
  'No T&Cs linked in promotion':              { fixType: 'missing_terms',             severity: 'low',      description: 'Dossier: Promotional content does not link to T&Cs.' },
  'Dark pattern in content':                  { fixType: 'dark_pattern',              severity: 'high',     description: 'Dossier: Dark pattern may constitute unfair commercial practice under DMCCA 2024.' },
  'Suppressed contacts not excluded':         { fixType: 'suppressed_contact',        severity: 'critical', description: 'Dossier: Suppressed contacts not excluded from send list.' },
  'No TPS screening':                         { fixType: 'suppressed_contact',        severity: 'high',     description: 'Dossier: TPS not screened before telephone marketing.' },
  'Opt-outs not processed':                   { fixType: 'missing_unsubscribe',       severity: 'high',     description: 'Dossier: Previous opt-out requests not processed.' },
  'Sender not clearly identified':            { fixType: 'concealed_sender',          severity: 'high',     description: 'Dossier: Sender identity not clearly disclosed — PECR Reg 23.' },
  'No postal address in email':               { fixType: 'missing_address',           severity: 'medium',   description: 'Dossier: Email does not include a postal address.' },
  'No privacy policy link':                   { fixType: 'no_privacy_policy',         severity: 'medium',   description: 'Dossier: Email does not link to a privacy policy.' },
  'No Data Processing Agreement':             { fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: No written DPA with ESP — UK GDPR Article 28.' },
};

const BRIEF_FIX_TYPES = {
  no_consent: 'no_consent', expired_consent: 'expired_consent', third_party_list: 'third_party_list',
  invalid_consent_mechanism: 'invalid_consent_mechanism', no_soft_optin: 'no_soft_optin',
  suppressed_contact: 'suppressed_contact', missing_unsubscribe: 'missing_unsubscribe',
  concealed_sender: 'concealed_sender', misleading_reference_price: 'misleading_reference_price',
  fake_urgency: 'fake_urgency', unauthorised_health_claim: 'unauthorised_health_claim',
  unlawful_incentive: 'unlawful_incentive', misleading_free_claim: 'misleading_free_claim',
  misleading_claim: 'misleading_claim',
};

// v7.3 — Extract monitored claim types from dossier for campaign monitoring
function extractMonitoredClaimTypes(moduleFields) {
  const cc = moduleFields?.ContentCheck || {};
  const types = [];
  if (cc.pricingCompliant && !cc.pricingCompliant.includes('no pricing')) {
    types.push('reference_pricing');
    types.push('drip_pricing');
  }
  if (cc.referencePriceEvidence) types.push('reference_pricing');
  if (cc.urgencyGenuine && cc.urgencyGenuine !== 'No urgency language used') types.push('fake_urgency');
  if (cc.substantiatedClaims) types.push('misleading_claim');
  if (cc.substantiatedClaims && /health|vitamin|supplement|wellbeing|medical/i.test(cc.substantiatedClaims)) types.push('health_claim');
  if (cc.aiCheckerRun && cc.aiCheckerRun.includes('issues found')) types.push('misleading_claim');
  const cm = moduleFields?.ConsentMechanism || {};
  if (cm.lawfulBasis === 'Legitimate interest (UK GDPR)') types.push('legitimate_interest_abuse');
  if (cm.lawfulBasis === 'Explicit consent (PECR)' || cm.lawfulBasis === 'Soft opt-in (PECR)') types.push('consent_missing');
  return [...new Set(types)];
}

// v4.32 — Extract landing page URLs from dossier for drift monitoring
function extractLandingPageUrls(moduleFields) {
  const urls = [];
  const cc = moduleFields?.ContentCheck || {};
  const lp = moduleFields?.ListProvenance || {};
  const si = moduleFields?.SenderIdentity || {};
  if (cc.referencePriceEvidence) {
    const urlMatches = cc.referencePriceEvidence.match(/https?:\/\/[^\s,;)]+/gi);
    if (urlMatches) urls.push(...urlMatches);
  }
  if (lp.collectionUrl && lp.collectionUrl.startsWith('http')) {
    urls.push(lp.collectionUrl);
  }
  if (si.unsubscribeUrl && si.unsubscribeUrl.startsWith('http')) {
    urls.push(si.unsubscribeUrl);
  }
  for (const mod of Object.values(moduleFields || {})) {
    if (mod?.notes) {
      const noteUrls = mod.notes.match(/https?:\/\/[^\s,;)]+/gi);
      if (noteUrls) urls.push(...noteUrls);
    }
  }
  return [...new Set(urls)];
}

// ══════════════════════════════════════════════════════════════
// v5.1 — CAMPAIGN DEFENCE HELPERS
// ══════════════════════════════════════════════════════════════

// ── Claim-to-fix mapping (feeds dashboard £ exposure) ─────────
const CLAIM_FIX_MAP = {
  pricing_claim:      { fixType: 'misleading_reference_price', severity: 'high' },
  urgency_claim:      { fixType: 'fake_urgency',               severity: 'medium' },
  scarcity_claim:     { fixType: 'fake_urgency',               severity: 'medium' },
  free_claim:         { fixType: 'misleading_claim',           severity: 'high' },
  health_claim:       { fixType: 'misleading_claim',           severity: 'high' },
  comparative_claim:  { fixType: 'misleading_claim',           severity: 'medium' },
  guarantee_claim:    { fixType: 'misleading_claim',           severity: 'medium' },
  environmental_claim:{ fixType: 'misleading_claim',           severity: 'medium' },
};

// ── Channel evidence requirements ─────────────────────────────
const CHANNEL_EVIDENCE = {
  email:       { needsConsent: true,  needsSuppression: true,  needsSender: true  },
  sms:         { needsConsent: true,  needsSuppression: true,  needsSender: false },
  paid_social: { needsConsent: false, needsSuppression: false, needsSender: false },
  display:     { needsConsent: false, needsSuppression: false, needsSender: false },
  affiliate:   { needsConsent: false, needsSuppression: false, needsSender: false, needsRelationship: true },
  influencer:  { needsConsent: false, needsSuppression: false, needsSender: false, needsRelationship: true, needsAdDisclosure: true },
  landing_page:{ needsConsent: false, needsSuppression: false, needsSender: false },
  other:       { needsConsent: false, needsSuppression: false, needsSender: false },
};

function getRequiredEvidence(channels) {
  const needs = { consent: false, suppression: false, sender: false, relationship: false, adDisclosure: false, claims: true, urls: true };
  for (const ch of (channels || ['email'])) {
    const cfg = CHANNEL_EVIDENCE[ch] || {};
    if (cfg.needsConsent) needs.consent = true;
    if (cfg.needsSuppression) needs.suppression = true;
    if (cfg.needsSender) needs.sender = true;
    if (cfg.needsRelationship) needs.relationship = true;
    if (cfg.needsAdDisclosure) needs.adDisclosure = true;
  }
  return needs;
}

// ── Claim extraction via Claude ───────────────────────────────
async function extractClaims(copyText) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || !copyText?.trim()) return [];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: `Analyse this marketing copy and extract every specific claim that could have regulatory implications under UK law (ICO/PECR, ASA/CAP Code, CMA/DMCCA 2024).

For each claim, return:
- claim: the exact text or a close paraphrase
- claimType: one of: pricing_claim, urgency_claim, scarcity_claim, free_claim, health_claim, comparative_claim, testimonial_claim, guarantee_claim, third_party_reference, environmental_claim, other
- ruleRef: the specific regulation it engages (e.g. "DMCCA 2024 Schedule 1", "CAP Code 3.1", "PECR Reg 22")
- evidenceNeeded: what evidence would be required to defend this claim
- exposureCategory: one of: ICO, ASA, CMA

Return ONLY a JSON array. No other text. If no claims found, return [].

COPY:
${copyText.slice(0, 4000)}` }],
      }),
    });

    if (!r.ok) return [];
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('extractClaims failed (non-fatal):', e);
    return [];
  }
}

// ── URL snapshot ──────────────────────────────────────────────
async function snapshotUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Sendwize-ComplianceMonitor/1.0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!r.ok) return { url, status: 'error', error: `HTTP ${r.status}`, capturedAt: new Date().toISOString() };

    const html = await r.text();
    const visibleText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(visibleText));
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : '';

    return { url, hash, title, snippet: visibleText.slice(0, 500), capturedAt: new Date().toISOString(), status: 'ok' };
  } catch (e) {
    return { url, status: 'error', error: e.message, capturedAt: new Date().toISOString() };
  }
}

// ── Evidence hashing (tamper-evident) ─────────────────────────
async function hashEvidence(obj) {
  const str = JSON.stringify(obj);
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Response pack generation ──────────────────────────────────
async function generateResponsePack(evidence, claims, title, owner) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const evidenceSummary = Object.entries(evidence)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');

  const claimsSummary = (claims || [])
    .map(c => `- ${c.claimType}: "${(c.claim || '').slice(0, 80)}" (${c.ruleRef || 'n/a'})`)
    .join('\n');

  const regulators = ['ico', 'asa', 'cma'];
  const pack = {};

  for (const reg of regulators) {
    const regName = { ico: "Information Commissioner's Office", asa: 'Advertising Standards Authority', cma: 'Competition and Markets Authority' }[reg];
    const focus = {
      ico: 'address consent basis, suppression records, data processing agreements',
      asa: 'address claim substantiation, pricing evidence, ad disclosure',
      cma: 'address pricing history, scarcity evidence, consumer protection compliance',
    }[reg];

    const prompt = `You are drafting a compliance response that a UK marketing team could send to the ${regName} if they received an enquiry about this campaign. The response should cite the specific evidence the team has on file.

CAMPAIGN: ${title || 'Marketing Campaign'}
OWNER: ${owner || 'Marketing Team'}

EVIDENCE ON FILE:
${evidenceSummary || 'No specific evidence provided.'}

CLAIMS IN CAMPAIGN:
${claimsSummary || 'No specific claims extracted.'}

RULES:
1. Start with: "DRAFT RESPONSE — REVIEW WITH LEGAL COUNSEL BEFORE SENDING"
2. Write as a professional compliance response from ${owner || 'the Marketing Team'} to the ${regName}
3. Reference specific evidence dates, records, and documentation that exist in the file
4. Focus: ${focus}
5. Tone: cooperative, professional, thorough
6. 250-350 words
7. End with a note offering to provide additional documentation if required

Write the response now.`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        pack[reg] = (d.content?.[0]?.text || '').trim();
      }
    } catch (e) {
      console.error(`Response pack ${reg} failed (non-fatal):`, e.message);
    }
  }

  return Object.keys(pack).length ? pack : null;
}

// ══════════════════════════════════════════════════════════════
// v5.1 — CAMPAIGN DEFENCE ENDPOINTS
// ══════════════════════════════════════════════════════════════

// ── DEFENCE-ASSEMBLE ──────────────────────────────────────────
async function handleDefenceAssemble(req, res) {
  const { userId, dossierId, campaignCopy, listName, connectedUrls, campaignTitle, ownerName, channels } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const base = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const now = new Date().toISOString();
  const today = now.split('T')[0];
  const selectedChannels = Array.isArray(channels) && channels.length ? channels : ['email'];
  const evidenceReqs = getRequiredEvidence(selectedChannels);

  // 1. Create record if needed
  let recordId = dossierId;
  if (!recordId) {
    const cr = await atFetch(`${base}/Campaign_Dossiers`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ records: [{ fields: {
        UserID: userId, CampaignTitle: campaignTitle || 'Untitled Campaign',
        OwnerName: ownerName || '', Status: 'Draft',
        DossierSource: 'Campaign Defence', CreatedDate: today, DefenceStatus: 'building',
      }}]}),
    });
    if (!cr.ok) return res.status(cr.status).json({ error: 'Failed to create defence record' });
    recordId = (await cr.json()).records?.[0]?.id;
  }

  // 2. Run copy check
  let aiCheckResult = null, aiCheckId = null;
  if (campaignCopy?.trim()) {
    try {
      const checkRes = await fetch(`${APP_URL}/api/submit-check?action=check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, copy: campaignCopy, source: 'Campaign Defence' }),
      });
      if (checkRes.ok) { aiCheckResult = await checkRes.json(); aiCheckId = aiCheckResult.checkId || null; }
    } catch (e) { console.error('Copy check failed (non-fatal):', e); }
  }

  // 3. Extract claims
  const claims = campaignCopy?.trim() ? await extractClaims(campaignCopy) : [];

  // 4. List check lookup (only if consent-requiring channels)
  let listCheck = null, listCertificate = null, listSummary = null;
  if (listName?.trim() && evidenceReqs.consent) {
    try {
      const lr = await atFetch(
        `${base}/List_Intelligence_Checks?filterByFormula=AND({UserID}='${userId}',FIND('${listName.replace(/'/g, "\\'")}',{ListName}))&sort[0][field]=CheckDate&sort[0][direction]=desc&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (lr.ok) {
        const checks = (await lr.json()).records || [];
        if (checks[0]) {
          listCheck = checks[0];
          listSummary = {
            listName: listCheck.fields.ListName, checkDate: listCheck.fields.CheckDate,
            totalContacts: listCheck.fields.TotalContacts, gateVerdict: listCheck.fields.GateVerdict,
            consentHealthScore: listCheck.fields.ConsentHealthScore, checkId: listCheck.id,
          };
        }
      }
    } catch (e) { console.error('List check lookup failed (non-fatal):', e); }

    try {
      const cr = await atFetch(
        `${base}/List_Intelligence_Certificates?filterByFormula=AND({UserID}='${userId}',FIND('${listName.replace(/'/g, "\\'")}',{ListName}))&sort[0][field]=IssuedDate&sort[0][direction]=desc&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (cr.ok) { const certs = (await cr.json()).records || []; if (certs[0]) listCertificate = certs[0]; }
    } catch (e) { console.error('Certificate lookup failed (non-fatal):', e); }
  }

  // 5. Cross-reference relationships
  const linkedRelationships = [];
  if (campaignCopy?.trim()) {
    try {
      const [affiliates, partners] = await Promise.all([
        atFetch(`${base}/Affiliate_Register?filterByFormula={UserID}='${userId}'&maxRecords=50`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }).then(r => r.ok ? r.json() : { records: [] }),
        atFetch(`${base}/Partner_Register?filterByFormula={UserID}='${userId}'&maxRecords=50`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }).then(r => r.ok ? r.json() : { records: [] }),
      ]);
      const copyLower = campaignCopy.toLowerCase();
      for (const r of (affiliates.records || [])) {
        const name = r.fields.AffiliateName || '';
        if (name.length > 2 && copyLower.includes(name.toLowerCase())) {
          linkedRelationships.push({ type: 'affiliate', recordId: r.id, name, consentVerified: !!r.fields.ConsentChainVerified, senderIdentityOk: r.fields.SenderIdentityCompliant === 'Verified' });
        }
      }
      for (const r of (partners.records || [])) {
        const name = r.fields.PartnerName || '';
        if (name.length > 2 && copyLower.includes(name.toLowerCase())) {
          linkedRelationships.push({ type: 'partner', recordId: r.id, name, article26Confirmed: r.fields.Article26Status === 'Confirmed', brandSafetyFlag: !!r.fields.BrandSafetyFlag });
        }
      }
    } catch (e) { console.error('Relationship cross-ref failed (non-fatal):', e); }
  }

  // 6. Sender identity from profile
  let senderSnapshot = null;
  try {
    const pr = await atFetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) {
      const profile = (await pr.json()).records?.[0]?.fields;
      if (profile) senderSnapshot = { companyName: profile.CompanyName || '', fromEmail: profile.DefaultFromEmail || '', sector: profile.Sector || '', revenueBand: profile.RevenueBand || '' };
    }
  } catch (e) { console.error('Profile lookup failed (non-fatal):', e); }

  // 7. Format URLs
  const urls = (Array.isArray(connectedUrls) ? connectedUrls : [])
    .filter(u => u?.url?.startsWith('http'))
    .map(u => ({ url: u.url, label: u.label || '', type: u.type || 'landing_page', addedAt: now }));

  // 8. Evidence hash
  const evidenceHash = await hashEvidence({ copy: campaignCopy, claims, listSummary, linkedRelationships, senderSnapshot, urls, channels: selectedChannels, timestamp: now });

  // 9. Timeline event
  const events = [{
    type: 'defence_created', date: now, title: 'Defence assembled',
    detail: `${claims.length} claim${claims.length !== 1 ? 's' : ''} extracted across ${selectedChannels.length} channel${selectedChannels.length !== 1 ? 's' : ''}. ${linkedRelationships.length} relationship${linkedRelationships.length !== 1 ? 's' : ''} linked. Evidence hash: ${evidenceHash.slice(0, 12)}…`,
    severity: 'info',
  }];

  // 10. Update Airtable
  const patchFields = {
    DefenceStatus: 'building', CampaignCopySnapshot: campaignCopy || '',
    AICheckId: aiCheckId || '', AICheckResultJson: aiCheckResult ? JSON.stringify(aiCheckResult) : '',
    ListCheckId: listCheck?.id || '', ListCertificateId: listCertificate?.id || '',
    LinkedRelationships: JSON.stringify(linkedRelationships), ClaimsExtracted: JSON.stringify(claims),
    ConnectedUrls: JSON.stringify(urls), CampaignEventsJson: JSON.stringify(events),
    SenderIdentitySnapshot: senderSnapshot ? JSON.stringify(senderSnapshot) : '',
    ListSummarySnapshot: listSummary ? JSON.stringify(listSummary) : '',
    Channels: JSON.stringify(selectedChannels), EvidenceHash: evidenceHash, UpdatedAt: now,
  };
  if (campaignTitle) patchFields.CampaignTitle = campaignTitle;
  if (ownerName) patchFields.OwnerName = ownerName;

  try {
    await atFetch(`${base}/Campaign_Dossiers/${recordId}`, { method: 'PATCH', headers: authH, body: JSON.stringify({ fields: patchFields }) });
  } catch (e) { return res.status(500).json({ error: 'Failed to save defence record', detail: e.message }); }

  fetch(`${APP_URL}/api/profile?action=streak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) }).catch(() => {});

  return res.json({
    success: true, dossierId: recordId, defenceStatus: 'building',
    claimsExtracted: claims.length, channels: selectedChannels, evidenceRequirements: evidenceReqs,
    aiCheckResult: aiCheckResult ? { issueCount: aiCheckResult.issues?.length || 0, score: aiCheckResult.score || null } : null,
    listSummary, linkedRelationships: linkedRelationships.length, connectedUrls: urls.length, evidenceHash, events,
  });
}

// ── DEFENCE-APPROVE ───────────────────────────────────────────
async function handleDefenceApprove(req, res) {
  const { userId, dossierId, approvedBy } = req.body ?? {};
  if (!userId || !dossierId) return res.status(400).json({ error: 'Missing userId or dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const base = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  // Load record
  const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!dr.ok) return res.status(404).json({ error: 'Defence record not found' });
  const record = await dr.json();
  if (record.fields?.UserID !== userId) return res.status(403).json({ error: 'Not authorised' });
  const f = record.fields;

  // Freeze AI check results
  let aiCheckFrozen = f.AICheckResultJson || '';
  if (!aiCheckFrozen && f.AICheckId) {
    try {
      const cr = await atFetch(`${base}/AI_Compliance_Checks/${f.AICheckId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
      if (cr.ok) aiCheckFrozen = JSON.stringify((await cr.json()).fields || {});
    } catch (e) { console.error('AI check freeze failed (non-fatal):', e); }
  }

  // Snapshot URLs
  let connectedUrls = []; try { connectedUrls = JSON.parse(f.ConnectedUrls || '[]'); } catch {}
  let landingUrls = []; try { landingUrls = JSON.parse(f.LandingPageUrls || '[]'); } catch {}
  const allUrlsToSnapshot = [...new Set([...connectedUrls.map(u => u.url || u), ...landingUrls.filter(u => typeof u === 'string')])].slice(0, 10);
  const snapshots = [];
  for (const url of allUrlsToSnapshot) { snapshots.push(await snapshotUrl(url)); }

  // Strength & health
  let moduleFields = {}; try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}
  const evidenceStrength = calculateOverallStrength(moduleFields);
  const healthScore = calculateHealthScore(moduleFields);
  const monitoredClaimTypes = extractMonitoredClaimTypes(moduleFields);

  // Letter
  const letter = await generateLetter(moduleFields, evidenceStrength, f.CampaignTitle || '', f.OwnerName || approvedBy || '', dossierId, healthScore);

  // Response pack
  let claims = []; try { claims = JSON.parse(f.ClaimsExtracted || '[]'); } catch {}
  let listSummary = null; try { listSummary = JSON.parse(f.ListSummarySnapshot || 'null'); } catch {}
  const evidence = {
    copyChecked: !!aiCheckFrozen, listCleared: !!listSummary,
    consentBasis: moduleFields.ConsentMechanism?.lawfulBasis || '',
    suppressionApplied: moduleFields.Suppression?.suppressionApplied || '',
    senderVerified: moduleFields.SenderIdentity?.fromName || '',
    claimCount: claims.length, urlsMonitored: allUrlsToSnapshot.length,
  };
  const responsePack = await generateResponsePack(evidence, claims, f.CampaignTitle || '', f.OwnerName || approvedBy || '');

  // Approval hash
  const approvalHash = await hashEvidence({ aiCheck: aiCheckFrozen, snapshots, moduleFields, evidenceStrength, claims, timestamp: now });

  // Timeline event
  let events = []; try { events = JSON.parse(f.CampaignEventsJson || '[]'); } catch {}
  events.push({
    type: 'defence_approved', date: now, title: 'Defence approved',
    detail: `Approved by ${approvedBy || f.OwnerName || 'Campaign owner'}. ${snapshots.filter(s => s.status === 'ok').length} URL${snapshots.length !== 1 ? 's' : ''} snapshotted. Evidence strength: ${evidenceStrength}. Hash: ${approvalHash.slice(0, 12)}…`,
    severity: 'info',
  });

  // Update Airtable
  const patchFields = {
    DefenceStatus: 'approved', AICheckResultJson: aiCheckFrozen,
    UrlSnapshots: JSON.stringify(snapshots), CampaignEventsJson: JSON.stringify(events),
    ApprovedAt: today, ApprovedBy: approvedBy || f.OwnerName || '',
    MonitoringActive: true, MonitoredClaimTypes: JSON.stringify(monitoredClaimTypes),
    EvidenceStrength: evidenceStrength, HealthScore: healthScore,
    Status: 'Submitted', SubmittedAt: now, LastVerified: today, UpdatedAt: now,
    LandingPageUrls: JSON.stringify(allUrlsToSnapshot),
    RefPriceAlertStage: '', ComplianceAlertsJson: f.ComplianceAlertsJson || '[]',
    ResponsePackJson: responsePack ? JSON.stringify(responsePack) : '',
    ApprovalHash: approvalHash,
  };

  try {
    await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { method: 'PATCH', headers: authH, body: JSON.stringify({ fields: patchFields }) });
  } catch (e) { return res.status(500).json({ error: 'Failed to approve defence', detail: e.message }); }

  // Emit fixes from extracted claims → feeds dashboard £ exposure
  for (const claim of claims) {
    const mapping = CLAIM_FIX_MAP[claim.claimType];
    if (mapping) {
      fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, fixType: mapping.fixType,
          description: `Campaign Defence: "${(claim.claim || '').slice(0, 120)}" — ${claim.ruleRef || 'evidence required'}`,
          tool: 'Campaign Defence', severity: mapping.severity, sourceRecordId: dossierId,
        }),
      }).catch(e => console.error('Fix generation non-fatal:', e));
    }
  }

  fetch(`${APP_URL}/api/profile?action=streak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) }).catch(() => {});

  return res.json({
    success: true, dossierId, defenceStatus: 'approved',
    evidenceStrength, healthScore, urlsSnapshotted: snapshots.filter(s => s.status === 'ok').length,
    monitoredClaimTypes, letter, responsePack, approvalHash, events,
  });
}

// ── DEFENCE-ADD-EVENT ─────────────────────────────────────────
async function handleDefenceAddEvent(req, res) {
  const { userId, dossierId, eventType, title, detail, launchDate, takedownDate } = req.body ?? {};
  if (!userId || !dossierId || !eventType) return res.status(400).json({ error: 'Missing required fields' });

  const ALLOWED_EVENTS = new Set([
    'campaign_launched', 'creative_amended', 'offer_expired', 'campaign_paused',
    'campaign_resumed', 'campaign_takedown', 'url_added', 'url_removed',
    'evidence_updated', 'manual_note',
  ]);
  if (!ALLOWED_EVENTS.has(eventType)) {
    return res.status(400).json({ error: `Invalid eventType. Allowed: ${[...ALLOWED_EVENTS].join(', ')}` });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const base = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const now = new Date().toISOString();

  const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!dr.ok) return res.status(404).json({ error: 'Defence record not found' });
  const record = await dr.json();
  if (record.fields?.UserID !== userId) return res.status(403).json({ error: 'Not authorised' });

  const event = {
    type: eventType, date: now,
    title: title || eventType.replace(/_/g, ' '),
    detail: detail || '',
    severity: ['campaign_takedown', 'creative_amended'].includes(eventType) ? 'warning' : 'info',
  };

  let events = []; try { events = JSON.parse(record.fields.CampaignEventsJson || '[]'); } catch {}
  events.push(event);

  const patchFields = { CampaignEventsJson: JSON.stringify(events), UpdatedAt: now };

  if (eventType === 'campaign_launched') { patchFields.DefenceStatus = 'live'; patchFields.LaunchDate = launchDate || now.split('T')[0]; }
  if (eventType === 'campaign_takedown') { patchFields.DefenceStatus = 'archived'; patchFields.TakedownDate = takedownDate || now.split('T')[0]; patchFields.MonitoringActive = false; }
  if (eventType === 'creative_amended') { patchFields.DefenceStatus = 'alert'; }
  if (eventType === 'campaign_paused') { patchFields.DefenceStatus = 'paused'; patchFields.MonitoringActive = false; }
  if (eventType === 'campaign_resumed') { patchFields.DefenceStatus = 'live'; patchFields.MonitoringActive = true; }

  try {
    await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { method: 'PATCH', headers: authH, body: JSON.stringify({ fields: patchFields }) });
  } catch (e) { return res.status(500).json({ error: 'Failed to add event', detail: e.message }); }

  return res.json({ success: true, dossierId, event, defenceStatus: patchFields.DefenceStatus || record.fields.DefenceStatus, totalEvents: events.length });
}

// ══════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (preserved from v4.32)
// ══════════════════════════════════════════════════════════════

async function handleDossierCreate(req, res) {
  const { userId, campaignTitle, ownerName, dossierSource = 'Standalone', prefill } = req.body ?? {};
  if (!userId)        return res.status(400).json({ error: 'Missing userId' });
  if (!campaignTitle) return res.status(400).json({ error: 'Missing campaignTitle' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const today          = new Date().toISOString().split('T')[0];
  const fields = {
    UserID: userId, CampaignTitle: campaignTitle, OwnerName: ownerName || '',
    Status: 'Draft', DossierSource: dossierSource, CreatedDate: today,
  };
  if (prefill && typeof prefill === 'object') {
    for (const key of DOSSIER_MODULES) {
      if (prefill[key]) {
        fields[key] = typeof prefill[key] === 'string'
          ? prefill[key]
          : serialiseModuleFields(key, prefill[key]);
      }
    }
    if (Object.keys(prefill).some(k => DOSSIER_MODULES.includes(k))) {
      fields.ModuleFieldsJson = JSON.stringify(prefill);
    }
  }
  const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body:   JSON.stringify({ records: [{ fields }] }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    return res.status(r.status).json({ error: 'Failed to create dossier', detail: errBody });
  }
  const record    = (await r.json()).records?.[0];
  const dossierId = record?.id;
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(() => {});
  return res.json({ success: true, dossierId, campaignTitle, status: 'Draft' });
}

async function handleDossierList(req, res) {
  const { userId, limit = '20' } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const maxRecords     = Math.min(parseInt(limit, 10) || 20, 100);
  const r = await atFetch(
    `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula={UserID}='${userId}'&sort[0][field]=UpdatedAt&sort[0][direction]=desc&maxRecords=${maxRecords}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch dossiers' });
  const data = await r.json();
  const dossiers = (data.records || []).map(record => {
    const f     = record.fields;
    const filled = DOSSIER_MODULES.filter(m => f[m]?.trim()).length;
    const pct   = Math.round((filled / DOSSIER_MODULES.length) * 100);
    const verifiedRaw = f.LastVerified || f.SubmittedAt || '';
    let daysSinceVerified = null, needsReview = false;
    if (f.Status === 'Submitted' && verifiedRaw) {
      const vd = new Date(verifiedRaw);
      if (!isNaN(vd)) {
        daysSinceVerified = Math.floor((Date.now() - vd.getTime()) / 86400000);
        needsReview = daysSinceVerified > REVERIFY_DAYS;
      }
    }
    return {
      dossierId:        record.id,
      campaignTitle:    f.CampaignTitle    || 'Untitled Campaign',
      ownerName:        f.OwnerName        || '',
      status:           f.Status           || 'Draft',
      dossierSource:    f.DossierSource    || 'Standalone',
      evidenceStrength: f.EvidenceStrength || null,
      healthScore:      f.HealthScore      || null,
      modulesComplete:  filled,
      modulesPct:       pct,
      createdDate:      f.CreatedDate      || '',
      updatedAt:        f.UpdatedAt        || '',
      submittedAt:      f.SubmittedAt      || '',
      lastVerified:     f.LastVerified     || '',
      daysSinceVerified,
      needsReview,
      // v5.1 — Defence fields
      defenceStatus:    f.DefenceStatus    || null,
      launchDate:       f.LaunchDate       || '',
      channels:         f.Channels         || '[]',
    };
  });
  return res.json({ dossiers });
}

async function handleDossierSave(req, res) {
  const { userId, dossierId, module, moduleFields, evidenceJson } = req.body ?? {};
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });
  if (!module)    return res.status(400).json({ error: 'Missing module' });
  if (!DOSSIER_MODULES.includes(module)) return res.status(400).json({ error: `Invalid module` });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  let moduleText = '';
  let rawFields  = moduleFields || null;
  if (moduleFields && typeof moduleFields === 'object') {
    moduleText = serialiseModuleFields(module, moduleFields);
  } else if (evidenceJson) {
    const ev = typeof evidenceJson === 'string'
      ? (() => { try { return JSON.parse(evidenceJson); } catch { return {}; } })()
      : (evidenceJson || {});
    moduleText = ev[module] || '';
  }
  const campaignTitle = moduleFields?.campaignTitle || null;
  const ownerName     = moduleFields?.ownerName     || null;
  let existing = null;
  try {
    const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (dr.ok) { const d = await dr.json(); if (d.fields?.UserID === userId) existing = d; }
  } catch {}
  if (!existing) {
    const lr = await atFetch(`${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    const ld = lr.ok ? await lr.json() : { records: [] };
    existing = ld.records?.[0] || null;
  }
  const updateFields = { [module]: moduleText, UpdatedAt: new Date().toISOString() };
  if (campaignTitle) updateFields.CampaignTitle = campaignTitle;
  if (ownerName)     updateFields.OwnerName     = ownerName;
  if (rawFields) {
    let existingMFJ = {};
    try { existingMFJ = JSON.parse(existing?.fields?.ModuleFieldsJson || '{}'); } catch {}
    existingMFJ[module] = rawFields;
    updateFields.ModuleFieldsJson = JSON.stringify(existingMFJ);
  }
  const recordId = existing?.id || dossierId;
  if (existing) {
    const r = await atFetch(`${base}/Campaign_Dossiers/${recordId}`, {
      method: 'PATCH', headers: authH, body: JSON.stringify({ fields: updateFields }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
  } else {
    const createFields = { UserID: userId, CampaignID: dossierId, [module]: moduleText, DossierSource: 'Brief Checker' };
    if (campaignTitle) createFields.CampaignTitle = campaignTitle;
    if (ownerName)     createFields.OwnerName     = ownerName;
    const r = await atFetch(`${base}/Campaign_Dossiers`, {
      method: 'POST', headers: authH, body: JSON.stringify({ records: [{ fields: createFields }] }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
  }
  return res.json({ success: true, recordId, module });
}

async function handleDossierGet(req, res) {
  const { userId, dossierId } = req.query;
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  let record = null;
  try {
    const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (dr.ok) { const d = await dr.json(); if (d.fields?.UserID === userId) record = d; }
  } catch {}
  if (!record) {
    const r = await atFetch(`${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch dossier' });
    record = (await r.json()).records?.[0] || null;
  }
  if (!record) {
    return res.json({ dossierId, CampaignTitle: '', OwnerName: '', Status: 'Draft', DossierSource: 'Standalone', UserID: userId, ListProvenance: '', ConsentMechanism: '', ContentCheck: '', Suppression: '', SenderIdentity: '', moduleFields: {} });
  }
  const f = record.fields;
  let moduleFields = {};
  try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}
  let responsePack = null;
  try { responsePack = JSON.parse(f.ResponsePackJson || 'null'); } catch {}
  return res.json({
    dossierId: record.id, recordId: record.id,
    CampaignTitle: f.CampaignTitle || '', OwnerName: f.OwnerName || '',
    Status: f.Status || 'Draft', DossierSource: f.DossierSource || 'Standalone',
    EvidenceStrength: f.EvidenceStrength || null, HealthScore: f.HealthScore || null,
    UserID: f.UserID || userId, CampaignID: f.CampaignID || null,
    ListProvenance: f.ListProvenance || '', ConsentMechanism: f.ConsentMechanism || '',
    ContentCheck: f.ContentCheck || '', Suppression: f.Suppression || '',
    SenderIdentity: f.SenderIdentity || '',
    CreatedDate: f.CreatedDate || '', UpdatedAt: f.UpdatedAt || '',
    SubmittedAt: f.SubmittedAt || '', LastVerified: f.LastVerified || '',
    MonitoredClaimTypes: f.MonitoredClaimTypes || '[]',
    ComplianceAlertsJson: f.ComplianceAlertsJson || '[]',
    LastComplianceCheck: f.LastComplianceCheck || '',
    MonitoringActive: f.MonitoringActive !== false,
    LandingPageUrls: f.LandingPageUrls || '[]',
    RefPriceAlertStage: f.RefPriceAlertStage || '',
    // v5.1 — Defence fields
    DefenceStatus: f.DefenceStatus || null,
    CampaignCopySnapshot: f.CampaignCopySnapshot || '',
    AICheckId: f.AICheckId || '',
    AICheckResultJson: f.AICheckResultJson || '',
    ListCheckId: f.ListCheckId || '',
    ListCertificateId: f.ListCertificateId || '',
    LinkedRelationships: f.LinkedRelationships || '[]',
    ClaimsExtracted: f.ClaimsExtracted || '[]',
    ConnectedUrls: f.ConnectedUrls || '[]',
    UrlSnapshots: f.UrlSnapshots || '[]',
    CampaignEventsJson: f.CampaignEventsJson || '[]',
    ApprovedAt: f.ApprovedAt || '',
    ApprovedBy: f.ApprovedBy || '',
    LaunchDate: f.LaunchDate || '',
    TakedownDate: f.TakedownDate || '',
    SenderIdentitySnapshot: f.SenderIdentitySnapshot || '',
    ListSummarySnapshot: f.ListSummarySnapshot || '',
    Channels: f.Channels || '["email"]',
    EvidenceHash: f.EvidenceHash || '',
    ApprovalHash: f.ApprovalHash || '',
    moduleFields,
    responsePack,
  });
}

async function handleDossierSubmit(req, res) {
  const { userId, dossierId, issues } = req.body ?? {};
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const now            = new Date().toISOString();
  let emailVolume = 'medium_send';
  try {
    const pr = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) { console.error('Profile fetch failed (non-fatal):', e); }
  let currentRecord = null;
  try {
    const dr = await atFetch(`${base}/Campaign_Dossiers/${dossierId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (dr.ok) { const d = await dr.json(); if (d.fields?.UserID === userId) currentRecord = d; }
  } catch {}
  if (!currentRecord) {
    const lr = await atFetch(`${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (lr.ok) currentRecord = (await lr.json()).records?.[0] || null;
  }
  const f            = currentRecord?.fields || {};
  const actualRecordId = currentRecord?.id || dossierId;
  let moduleFields = {};
  try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}
  const snapshot = { snapshotAt: now, version: 1, modules: {} };
  for (const key of DOSSIER_MODULES) {
    snapshot.modules[key] = { text: f[key] || '', fields: moduleFields[key] || {} };
  }
  let history = [];
  try { history = JSON.parse(f.VersionHistory || '[]'); } catch {}
  snapshot.version = history.length + 1;
  history.push(snapshot);
  const evidenceStrength = calculateOverallStrength(moduleFields);
  const healthScore      = calculateHealthScore(moduleFields);
  const monitoredClaimTypes = extractMonitoredClaimTypes(moduleFields);
  const landingPageUrls     = extractLandingPageUrls(moduleFields);

  const letterPromise = generateLetter(
    moduleFields, evidenceStrength,
    f.CampaignTitle || '', f.OwnerName || '',
    actualRecordId, healthScore
  );
  const issueList  = Array.isArray(issues) ? issues : [];
  const fixResults = [];
  for (const issue of issueList) {
    const issueKey = typeof issue === 'string' ? issue : issue?.issue || '';
    const mapping  = ISSUE_TO_FIX[issueKey];
    if (!mapping) continue;
    const finalSeverity = refineSeverity(mapping.fixType, emailVolume) || mapping.severity;
    try {
      const fixRes = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: mapping.fixType, description: mapping.description, tool: 'Campaign Dossier', severity: finalSeverity, volume: null, sourceRecordId: actualRecordId }),
      });
      const fixData = await fixRes.json();
      fixResults.push({ issue: issueKey, status: fixData.skipped ? 'duplicate_skipped' : 'created', fixId: fixData.fixId });
    } catch(e) {
      console.error('generate-fix failed (non-fatal):', e);
      fixResults.push({ issue: issueKey, status: 'error' });
    }
  }
  const letter = await letterPromise;
  try {
    await atFetch(`${base}/Campaign_Dossiers/${actualRecordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        Status:              'Submitted',
        IssuesFound:         issueList.length,
        SubmittedAt:         now,
        LastVerified:        now.split('T')[0],
        VersionHistory:      JSON.stringify(history),
        EvidenceStrength:    evidenceStrength,
        HealthScore:         healthScore,
        MonitoredClaimTypes: JSON.stringify(monitoredClaimTypes),
        MonitoringActive:    true,
        LandingPageUrls:     JSON.stringify(landingPageUrls),
        RefPriceAlertStage:  '',
        ComplianceAlertsJson: '[]',
      }}),
    });
  } catch(e) { console.error('Dossier status update failed (non-fatal):', e); }
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(() => {});
  return res.json({
    success: true, dossierId: actualRecordId,
    issuesFound: issueList.length,
    fixesGenerated: fixResults.filter(f => f.status === 'created').length,
    fixResults, evidenceStrength, healthScore,
    snapshotVersion: snapshot.version,
    monitoredClaimTypes,
    landingPageUrls,
    letter,
  });
}

async function handleBriefCheck(req, res) {
  const {
    userId, campaignName, channel, audience, lawfulBasis, listSource,
    consentDate, coreOffer, listSize, suppressionDone, hasUnsubscribe,
    senderClear, softOptInAnswers, issues: frontendIssues,
    resultStatus: frontendStatus, dossierPrefill,
  } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const today          = new Date().toISOString().split('T')[0];
  const issues       = Array.isArray(frontendIssues) ? frontendIssues : [];
  const nonGreen     = issues.filter(i => i.severity !== 'green');
  const redCount     = issues.filter(i => i.severity === 'red').length;
  const amberCount   = issues.filter(i => i.severity === 'amber').length;
  const greenCount   = issues.filter(i => i.severity === 'green').length;
  const resultStatus = frontendStatus || (redCount > 0 ? 'Red' : amberCount > 0 ? 'Amber' : 'Green');
  let briefCheckId = null, totalExposureEstimate = 0;
  try {
    const briefRes = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: {
        UserID: userId,
        CampaignName: campaignName || `Brief ${new Date().toLocaleDateString('en-GB')}`,
        CheckDate: today,
        BriefFieldsJson: JSON.stringify({ channel, audience, lawfulBasis, listSource, consentDate, coreOffer, suppressionDone, hasUnsubscribe, senderClear }),
        RedCount: redCount, AmberCount: amberCount, GreenCount: greenCount,
        IssuesJson: JSON.stringify(nonGreen), ResultStatus: resultStatus,
      }}]}),
    });
    if (briefRes.ok) briefCheckId = (await briefRes.json()).records?.[0]?.id ?? null;
    else console.error('Brief_Checks save failed after retries:', await briefRes.text());
  } catch(e) { console.error('Brief_Checks save error (non-fatal):', e); }
  let emailVolume = 'medium_send';
  try {
    const pr = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch {}
  for (const issue of nonGreen) {
    if (!issue.fixType || !BRIEF_FIX_TYPES[issue.fixType]) continue;
    const finalSeverity = refineSeverity(issue.fixType, emailVolume) || (issue.severity === 'red' ? 'high' : 'medium');
    try {
      const fr = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: issue.fixType, description: `Brief Checker: ${issue.issue}. ${issue.description || ''}`.trim(), tool: 'Campaign Brief Checker', severity: finalSeverity, volume: null, sourceRecordId: briefCheckId }),
      });
      const fd = await fr.json();
      if (!fd.skipped) totalExposureEstimate += fd.exposureEstimate || 0;
    } catch(e) { console.error('generate-fix failed (non-fatal):', e); }
  }
  if (briefCheckId && totalExposureEstimate > 0) {
    atFetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks/${briefCheckId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { TotalExposureEstimate: totalExposureEstimate } }),
    }).catch(() => {});
  }
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(() => {});
  return res.json({ briefCheckId, redCount, amberCount, greenCount, totalExposureEstimate, resultStatus, dossierPrefill: dossierPrefill || null, campaignName: campaignName || '' });
}

// ── ROUTER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    // Campaign Defence (v5.1)
    if (req.method === 'POST' && action === 'defence-assemble')  return await handleDefenceAssemble(req, res);
    if (req.method === 'POST' && action === 'defence-approve')   return await handleDefenceApprove(req, res);
    if (req.method === 'POST' && action === 'defence-add-event') return await handleDefenceAddEvent(req, res);
    // Existing dossier (v4.32)
    if (req.method === 'POST' && action === 'dossier-create') return await handleDossierCreate(req, res);
    if (req.method === 'GET'  && action === 'dossier-list')   return await handleDossierList(req, res);
    if (req.method === 'POST' && action === 'dossier-save')   return await handleDossierSave(req, res);
    if (req.method === 'GET'  && action === 'dossier-get')    return await handleDossierGet(req, res);
    if (req.method === 'POST' && action === 'dossier-submit') return await handleDossierSubmit(req, res);
    if (req.method === 'POST' && action === 'brief-check')    return await handleBriefCheck(req, res);
    return res.status(400).json({ error: 'Unknown action. Use ?action=get|complete|dismiss' });
  } catch (error) {
    console.error('submit-check.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
