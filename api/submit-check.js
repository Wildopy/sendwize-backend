// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v4.26
//
// POST ?action=dossier-create  { userId, campaignTitle, ownerName, dossierSource?, prefill? }
// GET  ?action=dossier-list    ?userId=x&limit=x
// POST ?action=dossier-save    { userId, dossierId, module, moduleFields }
// GET  ?action=dossier-get     ?dossierId=x&userId=x
// POST ?action=dossier-submit  { userId, dossierId, issues[] }
// POST ?action=brief-check     { userId, campaignName, ...fields, issues[], dossierPrefill{} }
//
// v4.26 changes from v4.25:
//   - dossier-create: creates standalone dossier without requiring a
//     Campaigns parent record. DossierSource tracks origin.
//   - dossier-list: returns all dossiers for a userId. Used by dashboard
//     instead of direct Airtable call (security fix — no token in client JS).
//   - dossier-save: accepts moduleFields{} (structured fields object) in
//     addition to legacy evidenceJson. Serialises to Long text fields AND
//     stores raw structured JSON in ModuleFieldsJson.
//   - dossier-submit: appends version snapshot to VersionHistory before
//     marking Submitted. Calculates EvidenceStrength.
//   - brief-check: no longer auto-creates dossier. Returns briefCheckId,
//     scores, and dossierPrefill{} for the frontend to use if user clicks
//     the optional "Create dossier" button.
// ─────────────────────────────────────────────────────────────

const APP_URL = 'https://sendwize-backend.vercel.app';

const DOSSIER_MODULES = [
  'ListProvenance', 'ConsentMechanism', 'ContentCheck', 'Suppression', 'SenderIdentity',
];

// ── Structured field serialiser ───────────────────────────────
// Converts structured module fields object → human-readable long text
// stored in the Airtable module field. This is what appears on the certificate.
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
    if (fields.aiCheckerRun)     lines.push(`AI Copy Checker run: ${fields.aiCheckerRun}`);
    if (fields.aiCheckerScore)   lines.push(`AI Copy Checker score: ${fields.aiCheckerScore}`);
    if (fields.asaReviewed)      lines.push(`ASA CAP Code review confirmed: ${fields.asaReviewed ? 'Yes' : 'No'}`);
    if (fields.substantiatedClaims) lines.push(`Substantiated claims: ${fields.substantiatedClaims}`);
    if (fields.pricingCompliant) lines.push(`Pricing compliance confirmed: ${fields.pricingCompliant ? 'Yes' : 'No'}`);
    if (fields.amendments)       lines.push(`Amendments made: ${fields.amendments}`);
    if (fields.notes)            lines.push(`Notes: ${fields.notes}`);
  }

  if (key === 'Suppression') {
    if (fields.suppressionApplied) lines.push(`Suppression list applied: ${fields.suppressionApplied ? 'Yes' : 'No'}`);
    if (fields.dateApplied)      lines.push(`Date applied: ${fields.dateApplied}`);
    if (fields.listLastUpdated)  lines.push(`Suppression list last updated: ${fields.listLastUpdated}`);
    if (fields.contactsCount !== undefined) lines.push(`Contacts suppressed: ${fields.contactsCount}`);
    if (fields.hardBouncesExcluded) lines.push(`Hard bounces excluded: ${fields.hardBouncesExcluded ? 'Yes' : 'No'}`);
    if (fields.sendwizeCheckScore) lines.push(`Sendwize suppression check score: ${fields.sendwizeCheckScore}/100`);
    if (fields.notes)            lines.push(`Notes: ${fields.notes}`);
  }

  if (key === 'SenderIdentity') {
    if (fields.fromName)         lines.push(`From name: ${fields.fromName}`);
    if (fields.fromEmail)        lines.push(`From email: ${fields.fromEmail}`);
    if (fields.matchesTradingName) lines.push(`Matches registered trading name: ${fields.matchesTradingName ? 'Yes' : 'No'}`);
    if (fields.businessAddress)  lines.push(`Business address in footer: ${fields.businessAddress ? 'Yes' : 'No'}`);
    if (fields.unsubscribePresent) lines.push(`Unsubscribe link present and functional: ${fields.unsubscribePresent ? 'Yes' : 'No'}`);
    if (fields.replyToAddress)   lines.push(`Reply-to address: ${fields.replyToAddress}`);
    if (fields.replyToMonitor)   lines.push(`Reply-to monitored by: ${fields.replyToMonitor}`);
    if (fields.notes)            lines.push(`Notes: ${fields.notes}`);
  }

  return lines.join('\n');
}

// ── Evidence strength calculator ──────────────────────────────
// Required fields per module. All must be present for Adequate.
// Optional fields push to Strong.
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
  ContentCheck:     ['aiCheckerScore', 'substantiatedClaims', 'amendments', 'notes'],
  Suppression:      ['contactsCount', 'hardBouncesExcluded', 'sendwizeCheckScore', 'notes'],
  SenderIdentity:   ['businessAddress', 'replyToAddress', 'replyToMonitor', 'notes'],
};

function calculateModuleStrength(key, fields) {
  if (!fields || typeof fields !== 'object') return 'Weak';
  const req  = REQUIRED_FIELDS[key]  || [];
  const opt  = OPTIONAL_FIELDS[key]  || [];
  const reqFilled = req.filter(f => {
    const v = fields[f];
    return v !== undefined && v !== null && v !== '' && v !== false;
  }).length;
  const optFilled = opt.filter(f => {
    const v = fields[f];
    return v !== undefined && v !== null && v !== '' && v !== false;
  }).length;
  if (reqFilled < req.length) return 'Weak';
  if (optFilled === 0)        return 'Adequate';
  return 'Strong';
}

function calculateOverallStrength(allModuleFields) {
  const strengths = DOSSIER_MODULES.map(k => calculateModuleStrength(k, allModuleFields[k] || {}));
  const score = strengths.reduce((s, v) => s + (v === 'Strong' ? 2 : v === 'Adequate' ? 1 : 0), 0);
  if (score >= 8) return 'Strong';
  if (score >= 4) return 'Adequate';
  return 'Weak';
}

// ── Health score calculator ───────────────────────────────────
// Consent (25%) + Suppression (25%) + others (16.67% each)
// Mirrors ICO investigation priority weighting.
const MODULE_WEIGHTS = {
  ListProvenance:   16.67,
  ConsentMechanism: 25,
  ContentCheck:     16.67,
  Suppression:      25,
  SenderIdentity:   16.66,
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

// ── Fix type → severity refinement ───────────────────────────
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

// ── Router ────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// dossier-create (NEW v4.26)
// Creates a blank standalone dossier — no Campaigns parent required.
// Also used when Brief Checker user clicks "Create dossier" button,
// in which case dossierSource='Brief Checker' and prefill{} is passed.
// ─────────────────────────────────────────────────────────────
async function handleDossierCreate(req, res) {
  const { userId, campaignTitle, ownerName, dossierSource = 'Standalone', prefill } = req.body ?? {};
  if (!userId)       return res.status(400).json({ error: 'Missing userId' });
  if (!campaignTitle) return res.status(400).json({ error: 'Missing campaignTitle' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const today          = new Date().toISOString().split('T')[0];

  const fields = {
    UserID:        userId,
    CampaignTitle: campaignTitle,
    OwnerName:     ownerName || '',
    Status:        'Draft',
    DossierSource: dossierSource,
    CreatedDate:   today,
  };

  // If pre-fill provided (from Brief Checker), serialise into module text fields
  if (prefill && typeof prefill === 'object') {
    for (const key of DOSSIER_MODULES) {
      if (prefill[key]) {
        // prefill values may be plain text (from brief) or structured fields object
        fields[key] = typeof prefill[key] === 'string'
          ? prefill[key]
          : serialiseModuleFields(key, prefill[key]);
      }
    }
    // Store raw structured prefill JSON for later editing
    if (Object.keys(prefill).some(k => DOSSIER_MODULES.includes(k))) {
      fields.ModuleFieldsJson = JSON.stringify(prefill);
    }
  }

  const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ records: [{ fields }] }),
  });
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to create dossier' });

  const record   = (await r.json()).records?.[0];
  const dossierId = record?.id;

  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(() => {});

  return res.json({ success: true, dossierId, campaignTitle, status: 'Draft' });
}

// ─────────────────────────────────────────────────────────────
// dossier-list (NEW v4.26)
// Returns all dossiers for a userId sorted by date desc.
// Used by dashboard — replaces direct Airtable call with token in JS.
// ─────────────────────────────────────────────────────────────
async function handleDossierList(req, res) {
  const { userId, limit = '20' } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const maxRecords     = Math.min(parseInt(limit, 10) || 20, 100);

  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula={UserID}='${userId}'&sort[0][field]=CreatedDate&sort[0][direction]=desc&maxRecords=${maxRecords}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch dossiers' });

  const data    = await r.json();
  const modules = DOSSIER_MODULES;

  const dossiers = (data.records || []).map(record => {
    const f      = record.fields;
    const filled = modules.filter(m => f[m]?.trim()).length;
    const pct    = Math.round((filled / modules.length) * 100);

    // Parse structured fields if stored
    let moduleFields = {};
    try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}

    return {
      dossierId:      record.id,
      campaignTitle:  f.CampaignTitle   || 'Untitled Campaign',
      ownerName:      f.OwnerName       || '',
      status:         f.Status          || 'Draft',
      dossierSource:  f.DossierSource   || 'Standalone',
      evidenceStrength: f.EvidenceStrength || null,
      healthScore:    f.HealthScore     || null,
      modulesComplete: filled,
      modulesPct:     pct,
      createdDate:    f.CreatedDate     || '',
      updatedAt:      f.UpdatedAt       || '',
      submittedAt:    f.SubmittedAt     || '',
    };
  });

  return res.json({ dossiers });
}

// ─────────────────────────────────────────────────────────────
// dossier-save (updated v4.26)
// Accepts moduleFields{} (structured) or legacy evidenceJson.
// Stores serialised text in the module Long text field.
// Stores raw structured JSON in ModuleFieldsJson for editing.
// dossierId = Campaign_Dossiers record ID (standalone) OR
//             CampaignID (Brief Checker legacy). Tries record ID first.
// ─────────────────────────────────────────────────────────────
async function handleDossierSave(req, res) {
  const { userId, dossierId, module, moduleFields, evidenceJson } = req.body ?? {};
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });
  if (!module)    return res.status(400).json({ error: 'Missing module' });
  if (!DOSSIER_MODULES.includes(module)) {
    return res.status(400).json({ error: `Invalid module. Must be one of: ${DOSSIER_MODULES.join(', ')}` });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  // Resolve structured fields → module text
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

  const campaignTitle = (moduleFields?.campaignTitle) || null;
  const ownerName     = (moduleFields?.ownerName)     || null;

  // Try to find record by direct ID first (standalone), then by CampaignID (legacy)
  let existing = null;

  // Attempt direct record fetch
  try {
    const dr = await fetch(`${base}/Campaign_Dossiers/${dossierId}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    if (dr.ok) {
      const d = await dr.json();
      if (d.fields?.UserID === userId) existing = d;
    }
  } catch {}

  // Fall back to CampaignID filter (Brief Checker legacy)
  if (!existing) {
    const lr = await fetch(
      `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const ld = lr.ok ? await lr.json() : { records: [] };
    existing = ld.records?.[0] || null;
  }

  // Build update fields
  const updateFields = {
    [module]:  moduleText,
    UpdatedAt: new Date().toISOString(),
  };
  if (campaignTitle) updateFields.CampaignTitle = campaignTitle;
  if (ownerName)     updateFields.OwnerName     = ownerName;

  // Merge structured fields into ModuleFieldsJson
  if (rawFields) {
    let existingMFJ = {};
    try { existingMFJ = JSON.parse(existing?.fields?.ModuleFieldsJson || '{}'); } catch {}
    existingMFJ[module] = rawFields;
    updateFields.ModuleFieldsJson = JSON.stringify(existingMFJ);
  }

  let result;
  const recordId = existing?.id || dossierId;

  if (existing) {
    const r = await fetch(`${base}/Campaign_Dossiers/${recordId}`, {
      method: 'PATCH', headers: authH, body: JSON.stringify({ fields: updateFields }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
    result = await r.json();
  } else {
    // Create new record (shouldn't happen for standalone — dossier-create should be called first)
    const createFields = {
      UserID: userId, CampaignID: dossierId,
      [module]: moduleText, UpdatedAt: new Date().toISOString(),
      DossierSource: 'Brief Checker',
    };
    if (campaignTitle) createFields.CampaignTitle = campaignTitle;
    if (ownerName)     createFields.OwnerName     = ownerName;
    const r = await fetch(`${base}/Campaign_Dossiers`, {
      method: 'POST', headers: authH, body: JSON.stringify({ records: [{ fields: createFields }] }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
    result = (await r.json()).records?.[0];
  }

  return res.json({ success: true, recordId: result?.id || recordId, module });
}

// ─────────────────────────────────────────────────────────────
// dossier-get (updated v4.26)
// Returns flat shape + structured moduleFields from ModuleFieldsJson.
// Tries record ID first, falls back to CampaignID filter.
// ─────────────────────────────────────────────────────────────
async function handleDossierGet(req, res) {
  const { userId, dossierId } = req.query;
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;

  let record = null;

  // Try direct record ID first (standalone dossiers)
  try {
    const dr = await fetch(`${base}/Campaign_Dossiers/${dossierId}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    if (dr.ok) {
      const d = await dr.json();
      if (d.fields?.UserID === userId) record = d;
    }
  } catch {}

  // Fall back to CampaignID filter (Brief Checker legacy)
  if (!record) {
    const r = await fetch(
      `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch dossier' });
    record = (await r.json()).records?.[0] || null;
  }

  if (!record) {
    return res.json({
      dossierId, CampaignTitle: '', OwnerName: '', Status: 'Draft',
      DossierSource: 'Standalone', UserID: userId,
      ListProvenance: '', ConsentMechanism: '', ContentCheck: '',
      Suppression: '', SenderIdentity: '', moduleFields: {},
    });
  }

  const f = record.fields;
  let moduleFields = {};
  try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}

  return res.json({
    dossierId:        record.id,
    recordId:         record.id,
    CampaignTitle:    f.CampaignTitle    || '',
    OwnerName:        f.OwnerName        || '',
    Status:           f.Status           || 'Draft',
    DossierSource:    f.DossierSource    || 'Standalone',
    EvidenceStrength: f.EvidenceStrength || null,
    HealthScore:      f.HealthScore      || null,
    UserID:           f.UserID           || userId,
    CampaignID:       f.CampaignID       || null,
    ListProvenance:   f.ListProvenance   || '',
    ConsentMechanism: f.ConsentMechanism || '',
    ContentCheck:     f.ContentCheck     || '',
    Suppression:      f.Suppression      || '',
    SenderIdentity:   f.SenderIdentity   || '',
    CreatedDate:      f.CreatedDate      || '',
    UpdatedAt:        f.UpdatedAt        || '',
    SubmittedAt:      f.SubmittedAt      || '',
    moduleFields,   // structured fields object for each module
  });
}

// ─────────────────────────────────────────────────────────────
// dossier-submit (updated v4.26)
// Appends version snapshot to VersionHistory before submitting.
// Calculates EvidenceStrength and HealthScore on submit.
// ─────────────────────────────────────────────────────────────
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
    const pr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) { console.error('Profile fetch failed (non-fatal):', e); }

  // Fetch current dossier for snapshot
  let currentRecord = null;
  try {
    const dr = await fetch(`${base}/Campaign_Dossiers/${dossierId}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    if (dr.ok) {
      const d = await dr.json();
      if (d.fields?.UserID === userId) currentRecord = d;
    }
  } catch {}

  if (!currentRecord) {
    // Legacy CampaignID lookup
    const lr = await fetch(
      `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (lr.ok) currentRecord = (await lr.json()).records?.[0] || null;
  }

  const f = currentRecord?.fields || {};
  const actualRecordId = currentRecord?.id || dossierId;

  // Parse existing structured fields
  let moduleFields = {};
  try { moduleFields = JSON.parse(f.ModuleFieldsJson || '{}'); } catch {}

  // ── Build version snapshot ────────────────────────────────────────
  const snapshot = {
    snapshotAt: now,
    version: 1,
    modules: {},
  };
  for (const key of DOSSIER_MODULES) {
    snapshot.modules[key] = {
      text:   f[key] || '',
      fields: moduleFields[key] || {},
    };
  }

  // Append to existing history
  let history = [];
  try { history = JSON.parse(f.VersionHistory || '[]'); } catch {}
  snapshot.version = history.length + 1;
  history.push(snapshot);

  // ── Calculate strength and health score ───────────────────────────
  const evidenceStrength = calculateOverallStrength(moduleFields);
  const healthScore      = calculateHealthScore(moduleFields);

  // ── Generate fix records ──────────────────────────────────────────
  const issueList  = Array.isArray(issues) ? issues : [];
  const fixResults = [];

  for (const issue of issueList) {
    const issueKey = typeof issue === 'string' ? issue : issue?.issue || '';
    const mapping  = ISSUE_TO_FIX[issueKey];
    if (!mapping) continue;
    const finalSeverity = refineSeverity(mapping.fixType, emailVolume) || mapping.severity;
    try {
      const fixRes  = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, fixType: mapping.fixType, description: mapping.description,
          tool: 'Campaign Dossier', severity: finalSeverity, volume: null, sourceRecordId: actualRecordId,
        }),
      });
      const fixData = await fixRes.json();
      fixResults.push({ issue: issueKey, status: fixData.skipped ? 'duplicate_skipped' : 'created', fixId: fixData.fixId });
    } catch(e) {
      console.error(`generate-fix failed (non-fatal):`, e);
      fixResults.push({ issue: issueKey, status: 'error' });
    }
  }

  // ── Update dossier to Submitted with snapshot ─────────────────────
  try {
    await fetch(`${base}/Campaign_Dossiers/${actualRecordId}`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: {
        Status:          'Submitted',
        IssuesFound:     issueList.length,
        SubmittedAt:     now,
        VersionHistory:  JSON.stringify(history),
        EvidenceStrength: evidenceStrength,
        HealthScore:     healthScore,
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
  });
}

// ─────────────────────────────────────────────────────────────
// brief-check (updated v4.26)
// No longer auto-creates a dossier. Returns dossierPrefill{}
// which the Brief Checker frontend uses if the user clicks
// the optional "Create compliance dossier" button.
// That button calls dossier-create with dossierSource='Brief Checker'.
// ─────────────────────────────────────────────────────────────
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

  // Save Brief_Checks record
  let briefCheckId = null, totalExposureEstimate = 0;
  try {
    const briefRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: {
        UserID:          userId,
        CampaignName:    campaignName || `Brief ${new Date().toLocaleDateString('en-GB')}`,
        CheckDate:       today,
        BriefFieldsJson: JSON.stringify({ channel, audience, lawfulBasis, listSource, consentDate, coreOffer, suppressionDone, hasUnsubscribe, senderClear }),
        RedCount: redCount, AmberCount: amberCount, GreenCount: greenCount,
        IssuesJson: JSON.stringify(nonGreen), ResultStatus: resultStatus,
      }}]}),
    });
    if (briefRes.ok) briefCheckId = (await briefRes.json()).records?.[0]?.id ?? null;
    else console.error('Brief_Checks save failed:', await briefRes.text());
  } catch(e) { console.error('Brief_Checks save error (non-fatal):', e); }

  // Email volume for severity refinement
  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch {}

  // Generate fix records
  for (const issue of nonGreen) {
    if (!issue.fixType || !BRIEF_FIX_TYPES[issue.fixType]) continue;
    const finalSeverity = refineSeverity(issue.fixType, emailVolume) || (issue.severity === 'red' ? 'high' : 'medium');
    try {
      const fr = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, fixType: issue.fixType,
          description: `Brief Checker: ${issue.issue}. ${issue.description || ''}`.trim(),
          tool: 'Campaign Brief Checker', severity: finalSeverity, volume: null, sourceRecordId: briefCheckId,
        }),
      });
      const fd = await fr.json();
      if (!fd.skipped) totalExposureEstimate += fd.exposureEstimate || 0;
    } catch(e) { console.error('generate-fix failed (non-fatal):', e); }
  }

  if (briefCheckId && totalExposureEstimate > 0) {
    fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks/${briefCheckId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { TotalExposureEstimate: totalExposureEstimate } }),
    }).catch(() => {});
  }

  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(() => {});

  // Return dossierPrefill for optional button — NOT auto-created
  // Frontend should show "Create compliance dossier →" button and call
  // dossier-create with { userId, campaignTitle: campaignName, dossierSource: 'Brief Checker', prefill: dossierPrefill }
  return res.json({
    briefCheckId,
    redCount, amberCount, greenCount,
    totalExposureEstimate,
    resultStatus,
    dossierPrefill: dossierPrefill || null, // pass back to frontend for optional create
    campaignName: campaignName || '',
  });
}
