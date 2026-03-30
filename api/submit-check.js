// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v4.19
// Campaign Compliance Dossier (Tool 5) + Campaign Brief Checker (Tool 7).
// PECR questionnaire removed. Submissions table no longer written.
//
// POST ?action=dossier-save    { userId, dossierId, module, evidenceJson, evidenceFiles? }
// GET  ?action=dossier-get&dossierId=x&userId=x
// POST ?action=dossier-submit  { userId, dossierId }
// POST ?action=brief-check     { userId, campaignName, ...8 brief fields }
//
// CRITICAL: ISSUE_TO_FIX map and refineSeverity() preserved from v4.8.
// ─────────────────────────────────────────────────────────────

const APP_URL = 'https://sendwize-backend.vercel.app';

const DOSSIER_MODULES = ['list_provenance', 'consent_mechanism', 'content_check', 'suppression', 'sender_identity'];

// ── Option A: Dynamic severity refinement ────────────────────
// Returns refined severity string or null (use ISSUE_TO_FIX default).
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

// ── ISSUE_TO_FIX — preserved from v4.8 ───────────────────────
// Maps dossier issue labels to fixType + default severity.
// Used by dossier-submit action.
const ISSUE_TO_FIX = {

  // ── List provenance ───────────────────────────────────────
  'No suppression list system': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: No suppression list system in place. Implement and screen before every campaign.' },
  'No suppression list screening (email)': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: Suppression list not screened before email campaign.' },
  'Purchased email data lacks named consent': { fixType: 'third_party_list', severity: 'high', description: 'Dossier: Purchased email list lacks consent naming this organisation.' },
  'Third-party data due diligence incomplete': { fixType: 'no_dpa', severity: 'high', description: 'Dossier: Due diligence on third-party data source not completed before use.' },
  'Third-party data provenance unverifiable': { fixType: 'no_dpa', severity: 'high', description: 'Dossier: Cannot verify provenance of purchased/rented data — must not use.' },

  // ── Consent mechanism ─────────────────────────────────────
  'Consent not freely given': { fixType: 'invalid_consent_mechanism', severity: 'critical', description: 'Dossier: Consent was not freely given — bundled, conditioned, or pre-ticked.' },
  'No opt-out mechanism': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: No opt-out mechanism included in marketing communications.' },
  'No opt-out at point of collection': { fixType: 'missing_unsubscribe', severity: 'high', description: 'Dossier: No opt-out offered when contact details were first collected.' },
  'No opt-out in every communication': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: Opt-out not included in every communication (soft opt-in condition).' },
  'PECR consent invalid': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: PECR consent does not meet the required standard for electronic mail marketing.' },
  'Soft opt-in for different products': { fixType: 'no_soft_optin', severity: 'high', description: 'Dossier: Soft opt-in applied to marketing for different products/services — express consent required.' },
  'Third-party consent unusable for email': { fixType: 'missing_unsubscribe', severity: 'critical', description: 'Dossier: Third-party consent cannot be used for email — does not specifically name this organisation.' },

  // ── Content check ─────────────────────────────────────────
  'Misleading claim in content': { fixType: 'misleading_claim', severity: 'high', description: 'Dossier: Content contains a misleading claim that requires evidence or correction.' },
  'Fake urgency or scarcity': { fixType: 'fake_urgency', severity: 'medium', description: 'Dossier: Content uses urgency or scarcity language that may not reflect genuine constraints.' },
  'Misleading pricing': { fixType: 'misleading_pricing', severity: 'high', description: 'Dossier: Content contains reference pricing or fee presentation that does not comply with DMCCA 2024.' },
  'Health claim not authorised': { fixType: 'unauthorised_health_claim', severity: 'high', description: 'Dossier: Content includes a health claim not on the UK authorised health claims register.' },
  'No T&Cs linked in promotion': { fixType: 'missing_terms', severity: 'low', description: 'Dossier: Promotional content does not link to terms and conditions.' },
  'Dark pattern in content': { fixType: 'dark_pattern', severity: 'high', description: 'Dossier: Content uses a dark pattern that may constitute an unfair commercial practice under DMCCA 2024.' },

  // ── Suppression ───────────────────────────────────────────
  'Suppressed contacts not excluded': { fixType: 'suppressed_contact', severity: 'critical', description: 'Dossier: Suppressed contacts (opted-out or TPS-registered) not excluded from send list.' },
  'No TPS screening': { fixType: 'suppressed_contact', severity: 'high', description: 'Dossier: TPS not screened before telephone marketing.' },
  'Opt-outs not processed': { fixType: 'missing_unsubscribe', severity: 'high', description: 'Dossier: Previous opt-out requests not processed before this campaign.' },

  // ── Sender identity ───────────────────────────────────────
  'Sender not clearly identified': { fixType: 'concealed_sender', severity: 'high', description: 'Dossier: Sender identity not clearly disclosed in marketing communication — PECR Reg 23 requirement.' },
  'No postal address in email': { fixType: 'missing_address', severity: 'medium', description: 'Dossier: Email does not include a postal address for the sender.' },
  'No privacy policy link': { fixType: 'no_privacy_policy', severity: 'medium', description: 'Dossier: Email does not link to a privacy policy.' },
  'No Data Processing Agreement': { fixType: 'no_dpa', severity: 'high', description: 'Dossier: No written DPA with ESP or other processors used in this campaign — UK GDPR Article 28 breach.' },
};

// ─────────────────────────────────────────────────────────────
// BRIEF CHECKER — 8 field deterministic cross-reference
// ─────────────────────────────────────────────────────────────

// Maps brief field values to issues + severity + exposure estimate basis.
// Returns { redCount, amberCount, greenCount, issues[], resultStatus }.
function runBriefCheck(fields) {
  const issues = [];

  const {
    channel,        // 'email' | 'sms' | 'push' | 'social' | 'directmail'
    audience,       // 'b2b' | 'b2c' | 'mixed'
    lawfulBasis,    // 'consent' | 'soft_optin' | 'legitimate_interests' | 'other'
    listSource,     // 'own_organic' | 'own_purchased' | 'third_party' | 'mixed'
    suppressionDone, // boolean
    contentType,    // 'promotional' | 'newsletter' | 'service' | 'mixed'
    hasUnsubscribe, // boolean
    senderClear,    // boolean
  } = fields;

  // Field 1 — Channel + Lawful Basis
  if (['email','sms','push'].includes(channel) && lawfulBasis === 'legitimate_interests') {
    issues.push({ field: 'lawfulBasis', severity: 'red', issue: 'Legitimate interests cannot be used as a lawful basis for electronic direct marketing under PECR. Express consent or soft opt-in required.', fixType: 'no_consent' });
  }
  if (lawfulBasis === 'other') {
    issues.push({ field: 'lawfulBasis', severity: 'amber', issue: 'Non-standard lawful basis selected. Verify this basis is valid for direct marketing to this audience and channel.', fixType: 'misleading_claim' });
  }

  // Field 2 — List Source
  if (listSource === 'own_purchased' || listSource === 'third_party') {
    issues.push({ field: 'listSource', severity: 'red', issue: 'Purchased or third-party lists are only lawful if recipients specifically consented to receive marketing from this organisation by name. This is rarely the case with bought data.', fixType: 'third_party_list' });
  }
  if (listSource === 'mixed') {
    issues.push({ field: 'listSource', severity: 'amber', issue: 'Mixed list sources detected. Verify consent or soft opt-in validity separately for each segment.', fixType: 'third_party_list' });
  }

  // Field 3 — Soft opt-in check
  if (lawfulBasis === 'soft_optin' && listSource !== 'own_organic') {
    issues.push({ field: 'lawfulBasis', severity: 'red', issue: 'Soft opt-in only applies to contacts who purchased or negotiated to purchase from this organisation directly. It cannot be applied to third-party or purchased data.', fixType: 'no_soft_optin' });
  }

  // Field 4 — Suppression
  if (!suppressionDone) {
    issues.push({ field: 'suppressionDone', severity: 'red', issue: 'Suppression list not confirmed as screened. Sending to opted-out contacts is a PECR breach.', fixType: 'suppressed_contact' });
  }

  // Field 5 — Unsubscribe mechanism
  if (!hasUnsubscribe && ['email','sms'].includes(channel)) {
    issues.push({ field: 'hasUnsubscribe', severity: 'red', issue: 'No unsubscribe mechanism confirmed. PECR Regulation 22 requires a simple, free opt-out in every marketing message.', fixType: 'missing_unsubscribe' });
  }

  // Field 6 — Sender identification
  if (!senderClear) {
    issues.push({ field: 'senderClear', severity: 'amber', issue: 'Sender identity not confirmed as clearly disclosed. PECR Regulation 23 requires the sender to be identifiable.', fixType: 'concealed_sender' });
  }

  // Field 7 — Content type vs channel
  if (contentType === 'service' && ['promotional'].includes(contentType)) {
    issues.push({ field: 'contentType', severity: 'amber', issue: 'Service messages containing promotional content must be treated as direct marketing in their entirety.', fixType: 'misleading_claim' });
  }

  // Field 8 — B2C + no consent
  if (audience === 'b2c' && lawfulBasis === 'legitimate_interests' && ['email','sms'].includes(channel)) {
    issues.push({ field: 'audience', severity: 'red', issue: 'B2C electronic marketing requires PECR consent or soft opt-in. Legitimate interests does not apply.', fixType: 'no_consent' });
  }

  const redCount   = issues.filter(i => i.severity === 'red').length;
  const amberCount = issues.filter(i => i.severity === 'amber').length;
  const greenCount = 8 - redCount - amberCount;

  let resultStatus;
  if (redCount > 0)        resultStatus = 'Red';
  else if (amberCount > 0) resultStatus = 'Amber';
  else                     resultStatus = 'Green';

  return { redCount, amberCount, greenCount: Math.max(0, greenCount), issues, resultStatus };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    if (req.method === 'POST' && action === 'dossier-save')   return await handleDossierSave(req, res);
    if (req.method === 'GET'  && action === 'dossier-get')    return await handleDossierGet(req, res);
    if (req.method === 'POST' && action === 'dossier-submit') return await handleDossierSubmit(req, res);
    if (req.method === 'POST' && action === 'brief-check')    return await handleBriefCheck(req, res);

    return res.status(400).json({ error: 'Unknown action. Use ?action=dossier-save|dossier-get|dossier-submit|brief-check' });
  } catch (error) {
    console.error('submit-check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────
// dossier-save
// Saves/updates a single evidence module for a dossierId.
// Writes to Campaign_Dossiers.
// ─────────────────────────────────────────────────────────────
async function handleDossierSave(req, res) {
  const { userId, dossierId, module, evidenceJson } = req.body ?? {};

  if (!userId)     return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId)  return res.status(400).json({ error: 'Missing dossierId' });
  if (!module)     return res.status(400).json({ error: 'Missing module' });
  if (!DOSSIER_MODULES.includes(module)) {
    return res.status(400).json({ error: `Invalid module. Must be one of: ${DOSSIER_MODULES.join(', ')}` });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  // Check if a record already exists for this dossier+module
  const existing = await fetch(
    `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}',{Module}='${module}')&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  const existingData = existing.ok ? await existing.json() : { records: [] };
  const existingRecord = existingData.records?.[0];

  const fields = {
    UserID:       userId,
    CampaignID:   dossierId,
    Module:       module,
    EvidenceJson: typeof evidenceJson === 'string' ? evidenceJson : JSON.stringify(evidenceJson || {}),
    CompletedAt:  new Date().toISOString(),
  };

  let result;
  if (existingRecord) {
    const r = await fetch(`${base}/Campaign_Dossiers/${existingRecord.id}`, {
      method: 'PATCH', headers: authH, body: JSON.stringify({ fields }),
    });
    if (!r.ok) { console.error('Campaign_Dossiers patch failed:', r.status); return res.status(r.status).json({ error: 'Failed to save module' }); }
    result = await r.json();
  } else {
    const r = await fetch(`${base}/Campaign_Dossiers`, {
      method: 'POST', headers: authH, body: JSON.stringify({ records: [{ fields }] }),
    });
    if (!r.ok) { console.error('Campaign_Dossiers create failed:', r.status); return res.status(r.status).json({ error: 'Failed to save module' }); }
    result = (await r.json()).records?.[0];
  }

  return res.json({ success: true, recordId: result?.id, module });
}

// ─────────────────────────────────────────────────────────────
// dossier-get
// Returns full dossier state — all five modules, completion %.
// ─────────────────────────────────────────────────────────────
async function handleDossierGet(req, res) {
  const { userId, dossierId } = req.query;
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!r.ok) { console.error('Campaign_Dossiers fetch failed:', r.status); return res.status(r.status).json({ error: 'Failed to fetch dossier' }); }

  const records  = (await r.json()).records || [];
  const modules  = {};

  for (const record of records) {
    const mod = record.fields.Module;
    if (mod) {
      modules[mod] = {
        recordId:    record.id,
        evidenceJson: (() => { try { return JSON.parse(record.fields.EvidenceJson || '{}'); } catch { return {}; } })(),
        completedAt: record.fields.CompletedAt || null,
        issuesFound: record.fields.IssuesFound || 0,
      };
    }
  }

  const completedModules  = DOSSIER_MODULES.filter(m => modules[m]);
  const dossierComplete   = completedModules.length === DOSSIER_MODULES.length;

  return res.json({
    dossierId,
    modules,
    completedModules: completedModules.length,
    totalModules:     DOSSIER_MODULES.length,
    dossierComplete,
    missingModules:   DOSSIER_MODULES.filter(m => !modules[m]),
  });
}

// ─────────────────────────────────────────────────────────────
// dossier-submit
// Runs ISSUE_TO_FIX logic across submitted dossier evidence.
// Calls refineSeverity() and generate-fix.js per issue.
// Updates Campaign_Dossiers IssuesFound.
// Fires streak call.
// ─────────────────────────────────────────────────────────────
async function handleDossierSubmit(req, res) {
  const { userId, dossierId, issues } = req.body ?? {};
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  // Fetch emailVolume for refineSeverity
  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (pr.ok) {
      const pd = await pr.json();
      emailVolume = pd.records?.[0]?.fields?.EmailVolume || 'medium_send';
    }
  } catch (e) { console.error('Profile fetch failed, using default:', e); }

  const issueList  = Array.isArray(issues) ? issues : (issues ? String(issues).split(';').map(i => i.trim()).filter(Boolean) : []);
  const fixResults = [];

  for (const issue of issueList) {
    const mapping = ISSUE_TO_FIX[issue];
    if (!mapping) continue;

    const finalSeverity = refineSeverity(mapping.fixType, emailVolume) || mapping.severity;

    try {
      const fixRes  = await fetch(`${APP_URL}/api/generate-fix`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, fixType: mapping.fixType, description: mapping.description,
          tool: 'Campaign Dossier', severity: finalSeverity, volume: null, sourceRecordId: dossierId,
        })
      });
      const fixData = await fixRes.json();
      fixResults.push({ issue, status: fixData.skipped ? 'duplicate_skipped' : 'created', fixId: fixData.fixId });
    } catch (e) {
      console.error(`generate-fix failed for "${issue}":`, e);
      fixResults.push({ issue, status: 'error' });
    }
  }

  // Update IssuesFound on all module records for this dossier
  const issuesFound = issueList.length;
  try {
    const dr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (dr.ok) {
      const dRecords = (await dr.json()).records || [];
      await Promise.allSettled(dRecords.map(r =>
        fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers/${r.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { IssuesFound: issuesFound, DossierCheckedAt: new Date().toISOString() } }),
        })
      ));
    }
  } catch (e) { console.error('IssuesFound update failed (non-fatal):', e); }

  // Streak call
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(e => console.error('Streak failed:', e));

  return res.json({
    success:        true,
    dossierId,
    issuesFound,
    fixesGenerated: fixResults.filter(f => f.status === 'created').length,
    fixResults,
  });
}

// ─────────────────────────────────────────────────────────────
// brief-check
// Deterministic cross-reference of 8 campaign brief fields.
// Calls generate-fix.js per issue found.
// On non-Red result: creates Campaign_Dossiers skeleton, returns dossierId.
// ─────────────────────────────────────────────────────────────
async function handleBriefCheck(req, res) {
  const {
    userId, campaignName,
    channel, audience, lawfulBasis, listSource,
    suppressionDone, contentType, hasUnsubscribe, senderClear,
  } = req.body ?? {};

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const briefFields = { channel, audience, lawfulBasis, listSource, suppressionDone, contentType, hasUnsubscribe, senderClear };
  const { redCount, amberCount, greenCount, issues, resultStatus } = runBriefCheck(briefFields);

  // Save Brief_Checks record
  let briefCheckId = null;
  let totalExposureEstimate = 0;

  try {
    const briefRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: {
        UserID:          userId,
        BriefName:       campaignName || `Brief ${new Date().toLocaleDateString('en-GB')}`,
        CheckDate:       new Date().toISOString().split('T')[0],
        BriefFieldsJson: JSON.stringify(briefFields),
        RedCount:        redCount,
        AmberCount:      amberCount,
        GreenCount:      greenCount,
        IssuesJson:      JSON.stringify(issues),
        ResultStatus:    resultStatus,
      }}]})
    });
    if (briefRes.ok) briefCheckId = (await briefRes.json()).records?.[0]?.id ?? null;
  } catch (e) { console.error('Brief_Checks save failed (non-fatal):', e); }

  // Generate fix records for each issue
  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch (e) {}

  for (const issue of issues) {
    const mapping = ISSUE_TO_FIX[issue.issue];
    if (!mapping) continue;
    const finalSeverity = refineSeverity(mapping.fixType, emailVolume) || mapping.severity;
    try {
      const fr = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: mapping.fixType, description: mapping.description, tool: 'Campaign Brief Checker', severity: finalSeverity, volume: null, sourceRecordId: briefCheckId }),
      });
      const fd = await fr.json();
      if (!fd.skipped) totalExposureEstimate += fd.exposureEstimate || 0;
    } catch (e) { console.error(`generate-fix failed for brief issue:`, e); }
  }

  // Update TotalExposureEstimate on Brief_Checks
  if (briefCheckId && totalExposureEstimate > 0) {
    fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks/${briefCheckId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { TotalExposureEstimate: totalExposureEstimate } }),
    }).catch(e => console.error('TotalExposureEstimate update failed (non-fatal):', e));
  }

  // On non-Red: create Campaign_Dossiers skeleton + lightweight Campaigns record
  let dossierId = null;
  if (resultStatus !== 'Red') {
    try {
      // Create lightweight Campaigns record
      const campRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaigns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: {
          UserID:       userId,
          CampaignName: campaignName || `Campaign ${new Date().toLocaleDateString('en-GB')}`,
          CampaignType: channel || 'email',
          BriefCheckID: briefCheckId,
          Status:       'Active',
          CreatedDate:  new Date().toISOString().split('T')[0],
        }}]})
      });

      if (campRes.ok) {
        const campaignId = (await campRes.json()).records?.[0]?.id ?? null;

        // Create one Campaign_Dossiers skeleton record (no module yet — user fills in)
        if (campaignId) {
          const dossierRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields: {
              UserID:        userId,
              CampaignID:    campaignId,
              CampaignTitle: campaignName || 'Unnamed Campaign',
              OwnerName:     '',
            }}]})
          });
          if (dossierRes.ok) dossierId = campaignId; // use campaignId as the dossierId ref
        }
      }
    } catch (e) { console.error('Dossier skeleton creation failed (non-fatal):', e); }
  }

  // Streak call
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(e => console.error('Streak failed:', e));

  return res.json({
    briefCheckId,
    redCount, amberCount, greenCount,
    issues,
    totalExposureEstimate,
    resultStatus,
    dossierId: resultStatus !== 'Red' ? dossierId : null,
  });
}
