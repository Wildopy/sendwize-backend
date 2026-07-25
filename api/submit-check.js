// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v4.31
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
// Determine which regulatory lens has the most material weakness.
// ICO: consent + suppression + list provenance + sender identity
// ASA: content check (claims, subject line) + sender identity
// CMA: content check (pricing, urgency)
function determineWeakestLens(moduleFields) {
  const ico = ['ListProvenance', 'ConsentMechanism', 'Suppression', 'SenderIdentity'];
  const asa = ['ContentCheck', 'SenderIdentity'];
  const cma = ['ContentCheck'];

  const score = mods => mods.reduce((s, k) => {
    const st = calculateModuleStrength(k, moduleFields[k] || {});
    return s + (st === 'Weak' ? 2 : st === 'Adequate' ? 1 : 0);
  }, 0);

  const scores = { ico: score(ico), asa: score(asa), cma: score(cma) };

  // Return the lens with the highest weakness score
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

// Build a summary of gaps for the Claude prompt
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
    // Flag specific weak content signals
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

// Generate clearance notice text (no Claude call)
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

// Build regulator letter prompt for Claude
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

// Main letter generation function
async function generateLetter(moduleFields, evidenceStrength, campaignTitle, ownerName, dossierId, healthScore) {
  // Strong evidence = clearance notice, no Claude call
  if (evidenceStrength === 'Strong') {
    return {
      type:    'clearance',
      lens:    null,
      content: buildClearanceNotice(campaignTitle, ownerName, dossierId, healthScore),
      generatedAt: new Date().toISOString(),
    };
  }

  // Weak or Adequate: draft a regulator letter for the weakest lens
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

    // Ensure watermark is present
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
    // Fallback: return a static placeholder letter
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action;
  try {
    if (req.method === 'POST' && action === 'dossier-create') return await handleDossierCreate(req, res);
    if (req.method === 'GET'  && action === 'dossier-list')   return await handleDossierList(req, res);
    if (req.method === 'POST' && action === 'dossier-save')   return await handleDossierSave(req, res);
    if (req.method === 'GET'  && action === 'dossier-get')    return await handleDossierGet(req, res);
    if (req.method === 'POST' && action === 'dossier-submit') return await handleDossierSubmit(req, res);
    if (req.method === 'POST' && action === 'brief-check')    return await handleBriefCheck(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('submit-check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

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
    moduleFields,
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
  // ── Generate The Letter (v4.31) ───────────────────────────────
  // Run in parallel with fix generation to keep response time reasonable
  const letterPromise = generateLetter(
    moduleFields, evidenceStrength,
    f.CampaignTitle || '', f.OwnerName || '',
    actualRecordId, healthScore
  );
  // ── Fix generation ────────────────────────────────────────────
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
  // ── Await letter + update Airtable ────────────────────────────
  const letter = await letterPromise;
  try {
    await atFetch(`${base}/Campaign_Dossiers/${actualRecordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        Status:           'Submitted',
        IssuesFound:      issueList.length,
        SubmittedAt:      now,
        LastVerified:     now.split('T')[0],
        VersionHistory:   JSON.stringify(history),
        EvidenceStrength: evidenceStrength,
        HealthScore:      healthScore,
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
    letter,  // v4.31 — { type, lens, content, generatedAt }
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
