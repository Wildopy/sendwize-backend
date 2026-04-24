// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v4.25
// Campaign Compliance Dossier (Tool 5) + Campaign Brief Checker (Tool 7).
//
// POST ?action=dossier-save    { userId, dossierId, module, evidenceJson }
// GET  ?action=dossier-get&dossierId=x&userId=x
// POST ?action=dossier-submit  { userId, dossierId, issues[] }
// POST ?action=brief-check     { userId, campaignName, ...fields, issues[], dossierPrefill{} }
//
// v4.25 changes from v4.22:
//   - dossierId clarification: dossierId passed from frontend = CampaignID
//     (the Campaigns table record ID). dossier-get filters on CampaignID,
//     not the Campaign_Dossiers record ID. This is intentional — do not
//     change this join without updating the frontend.
//   - Brief_Checks TotalExposureEstimate patch now guarded: only fires
//     if the Brief_Checks table has that field (non-fatal if absent).
//   - SoftOptInQualified and ConsentTimelineJson removed from Brief_Checks
//     save (fields deleted from Airtable).
//   - handleBriefCheck now explicitly documents the dossierId convention
//     in the response comment.
//   - Minor: all non-fatal Airtable errors log consistently.
// ─────────────────────────────────────────────────────────────

const APP_URL = 'https://sendwize-backend.vercel.app';

const DOSSIER_MODULES = [
  'ListProvenance', 'ConsentMechanism', 'ContentCheck', 'Suppression', 'SenderIdentity',
];

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

// ── ISSUE_TO_FIX — dossier submit only ───────────────────────
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

// ── Fix type → exposure for brief-check fix generation ────────
const BRIEF_FIX_TYPES = {
  no_consent:                 'no_consent',
  expired_consent:            'expired_consent',
  third_party_list:           'third_party_list',
  invalid_consent_mechanism:  'invalid_consent_mechanism',
  no_soft_optin:              'no_soft_optin',
  suppressed_contact:         'suppressed_contact',
  missing_unsubscribe:        'missing_unsubscribe',
  concealed_sender:           'concealed_sender',
  misleading_reference_price: 'misleading_reference_price',
  fake_urgency:               'fake_urgency',
  unauthorised_health_claim:  'unauthorised_health_claim',
  unlawful_incentive:         'unlawful_incentive',
  misleading_free_claim:      'misleading_free_claim',
  misleading_claim:           'misleading_claim',
};

// ── Router ────────────────────────────────────────────────────
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
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('submit-check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────
// dossier-save
// ─────────────────────────────────────────────────────────────
async function handleDossierSave(req, res) {
  const { userId, dossierId, module, evidenceJson } = req.body ?? {};
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

  const evidence = typeof evidenceJson === 'string'
    ? (() => { try { return JSON.parse(evidenceJson); } catch { return {}; } })()
    : (evidenceJson || {});

  const moduleText    = evidence[module]       || '';
  const campaignTitle = evidence.CampaignTitle || '';
  const ownerName     = evidence.OwnerName     || '';

  // NOTE: dossierId here = CampaignID (Campaigns table record ID).
  // Campaign_Dossiers is filtered by CampaignID, not its own record ID.
  const existingRes  = await fetch(
    `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const existingData = existingRes.ok ? await existingRes.json() : { records: [] };
  const existing     = existingData.records?.[0];

  const fields = {
    UserID:    userId,
    CampaignID: dossierId,
    [module]:  moduleText,
    UpdatedAt: new Date().toISOString(),
  };
  if (campaignTitle) fields.CampaignTitle = campaignTitle;
  if (ownerName)     fields.OwnerName     = ownerName;

  let result;
  if (existing) {
    const r = await fetch(`${base}/Campaign_Dossiers/${existing.id}`, {
      method: 'PATCH', headers: authH, body: JSON.stringify({ fields }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
    result = await r.json();
  } else {
    const r = await fetch(`${base}/Campaign_Dossiers`, {
      method: 'POST', headers: authH, body: JSON.stringify({ records: [{ fields }] }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to save module' });
    result = (await r.json()).records?.[0];
  }

  return res.json({ success: true, recordId: result?.id, module });
}

// ─────────────────────────────────────────────────────────────
// dossier-get
// Returns flat field shape — all module keys at top level.
// dossierId param = CampaignID value in Campaign_Dossiers.
// ─────────────────────────────────────────────────────────────
async function handleDossierGet(req, res) {
  const { userId, dossierId } = req.query;
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch dossier' });

  const data   = await r.json();
  const record = data.records?.[0];

  // No record found — return empty draft shape so frontend can start fresh
  if (!record) {
    return res.json({
      CampaignTitle: '', OwnerName: '', Status: 'Draft', UserID: userId, CampaignID: dossierId,
      ListProvenance: '', ConsentMechanism: '', ContentCheck: '', Suppression: '', SenderIdentity: '',
    });
  }

  const f = record.fields;
  return res.json({
    recordId:         record.id,
    CampaignTitle:    f.CampaignTitle    || '',
    OwnerName:        f.OwnerName        || '',
    Status:           f.Status           || 'Draft',
    UserID:           f.UserID           || userId,
    CampaignID:       f.CampaignID       || dossierId,
    ListProvenance:   f.ListProvenance   || '',
    ConsentMechanism: f.ConsentMechanism || '',
    ContentCheck:     f.ContentCheck     || '',
    Suppression:      f.Suppression      || '',
    SenderIdentity:   f.SenderIdentity   || '',
    CreatedDate:      f.CreatedDate      || '',
    UpdatedAt:        f.UpdatedAt        || '',
  });
}

// ─────────────────────────────────────────────────────────────
// dossier-submit
// ─────────────────────────────────────────────────────────────
async function handleDossierSubmit(req, res) {
  const { userId, dossierId, issues } = req.body ?? {};
  if (!userId)    return res.status(400).json({ error: 'Missing userId' });
  if (!dossierId) return res.status(400).json({ error: 'Missing dossierId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) { console.error('Profile fetch failed (non-fatal):', e); }

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
          tool: 'Campaign Dossier', severity: finalSeverity, volume: null, sourceRecordId: dossierId,
        }),
      });
      const fixData = await fixRes.json();
      fixResults.push({ issue: issueKey, status: fixData.skipped ? 'duplicate_skipped' : 'created', fixId: fixData.fixId });
    } catch(e) {
      console.error(`generate-fix failed for dossier issue "${issueKey}" (non-fatal):`, e);
      fixResults.push({ issue: issueKey, status: 'error' });
    }
  }

  // Update Campaign_Dossiers status to Submitted
  try {
    const dr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (dr.ok) {
      const dRecords = (await dr.json()).records || [];
      await Promise.allSettled(dRecords.map(r =>
        fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers/${r.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            Status:       'Submitted',
            IssuesFound:  issueList.length,
            SubmittedAt:  new Date().toISOString(),
          }}),
        })
      ));
    }
  } catch(e) { console.error('Dossier status update failed (non-fatal):', e); }

  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(e => console.error('Streak failed (non-fatal):', e));

  return res.json({
    success:        true,
    dossierId,
    issuesFound:    issueList.length,
    fixesGenerated: fixResults.filter(f => f.status === 'created').length,
    fixResults,
  });
}

// ─────────────────────────────────────────────────────────────
// brief-check
//
// The frontend constraint engine builds issues[] before calling.
// This endpoint:
//   1. Saves a Brief_Checks record
//   2. Generates fix records for non-green issues
//   3. Creates a Campaigns record + Campaign_Dossiers skeleton
//   4. Auto-populates dossier module fields from dossierPrefill{}
//   5. Returns { briefCheckId, dossierId, redCount, amberCount,
//      greenCount, totalExposureEstimate, resultStatus }
//
// IMPORTANT: dossierId in the response = the Campaigns record ID.
// The dossier frontend passes this as ?dossierId= and dossier-get
// filters Campaign_Dossiers on {CampaignID}. Do not change this.
// ─────────────────────────────────────────────────────────────
async function handleBriefCheck(req, res) {
  const {
    userId, campaignName,
    channel, audience, lawfulBasis, listSource,
    consentDate, coreOffer, listSize,
    suppressionDone, hasUnsubscribe, senderClear,
    softOptInAnswers,
    issues:        frontendIssues,
    resultStatus:  frontendStatus,
    dossierPrefill,
  } = req.body ?? {};

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const today          = new Date().toISOString().split('T')[0];

  const issues   = Array.isArray(frontendIssues) ? frontendIssues : [];
  const nonGreen = issues.filter(i => i.severity !== 'green');
  const redCount   = issues.filter(i => i.severity === 'red').length;
  const amberCount = issues.filter(i => i.severity === 'amber').length;
  const greenCount = issues.filter(i => i.severity === 'green').length;
  const resultStatus = frontendStatus || (redCount > 0 ? 'Red' : amberCount > 0 ? 'Amber' : 'Green');

  // ── Save Brief_Checks record ──────────────────────────────────────
  // Note: SoftOptInQualified and ConsentTimelineJson excluded —
  // those fields have been removed from the Airtable table.
  let briefCheckId = null, totalExposureEstimate = 0;
  try {
    const briefRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: {
        UserID:          userId,
        CampaignName:    campaignName || `Brief ${new Date().toLocaleDateString('en-GB')}`,
        CheckDate:       today,
        BriefFieldsJson: JSON.stringify({
          channel, audience, lawfulBasis, listSource, consentDate,
          coreOffer, suppressionDone, hasUnsubscribe, senderClear,
        }),
        RedCount:        redCount,
        AmberCount:      amberCount,
        GreenCount:      greenCount,
        IssuesJson:      JSON.stringify(nonGreen),
        ResultStatus:    resultStatus,
      }}]}),
    });
    if (briefRes.ok) {
      briefCheckId = (await briefRes.json()).records?.[0]?.id ?? null;
    } else {
      console.error('Brief_Checks save failed:', await briefRes.text());
    }
  } catch(e) { console.error('Brief_Checks save error (non-fatal):', e); }

  // ── Fetch email volume for severity refinement ────────────────────
  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) { /* non-fatal */ }

  // ── Generate fix records for non-green issues ─────────────────────
  for (const issue of nonGreen) {
    if (!issue.fixType || !BRIEF_FIX_TYPES[issue.fixType]) continue;
    const finalSeverity = refineSeverity(issue.fixType, emailVolume) || (issue.severity === 'red' ? 'high' : 'medium');
    try {
      const fr = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          fixType:        issue.fixType,
          description:    `Brief Checker: ${issue.issue}. ${issue.description || ''}`.trim(),
          tool:           'Campaign Brief Checker',
          severity:       finalSeverity,
          volume:         null,
          sourceRecordId: briefCheckId,
        }),
      });
      const fd = await fr.json();
      if (!fd.skipped) totalExposureEstimate += fd.exposureEstimate || 0;
    } catch(e) { console.error('generate-fix failed for brief issue (non-fatal):', e); }
  }

  // ── Patch TotalExposureEstimate onto Brief_Checks record ──────────
  // Guard: only attempt if we have a record ID and a non-zero estimate.
  // The field may not exist yet if Brief_Checks was just created without it —
  // failure is non-fatal.
  if (briefCheckId && totalExposureEstimate > 0) {
    fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks/${briefCheckId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { TotalExposureEstimate: totalExposureEstimate } }),
    }).catch(e => console.error('TotalExposureEstimate patch failed (non-fatal):', e));
  }

  // ── Create Campaigns + Campaign_Dossiers skeleton ─────────────────
  // Blocked only when the list source is fundamentally unusable (third_party_list red).
  // All other result statuses — including Red — get a dossier so the user can
  // document what happened and what they're doing to fix it.
  const blockingIssues = nonGreen.filter(i =>
    ['third_party_list'].includes(i.fixType) && i.severity === 'red'
  );
  let dossierId = null;

  if (blockingIssues.length === 0) {
    try {
      const campRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaigns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: {
          UserID:       userId,
          CampaignName: campaignName || `Campaign ${new Date().toLocaleDateString('en-GB')}`,
          CampaignType: channel || 'email',
          BriefCheckID: briefCheckId,
          Status:       'Active',
          CreatedDate:  today,
        }}]}),
      });

      if (campRes.ok) {
        // dossierId = Campaigns record ID. This is what the dossier frontend
        // receives as ?dossierId= and what dossier-get filters CampaignID on.
        const campaignId = (await campRes.json()).records?.[0]?.id ?? null;

        if (campaignId) {
          const dossierFields = {
            UserID:        userId,
            CampaignID:    campaignId,
            CampaignTitle: campaignName || 'Unnamed Campaign',
            OwnerName:     '',
            Status:        'Draft',
            CreatedDate:   today,
          };

          // Auto-populate module fields from brief answers
          if (dossierPrefill && typeof dossierPrefill === 'object') {
            for (const key of ['ListProvenance', 'ConsentMechanism', 'ContentCheck', 'Suppression', 'SenderIdentity']) {
              if (dossierPrefill[key]) dossierFields[key] = dossierPrefill[key];
            }
          }

          const dossierRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields: dossierFields }]}),
          });
          if (dossierRes.ok) {
            dossierId = campaignId; // intentionally = CampaignID, not dossier record ID
          } else {
            console.error('Campaign_Dossiers create failed:', await dossierRes.text());
          }
        }
      }
    } catch(e) { console.error('Dossier skeleton creation failed (non-fatal):', e); }
  }

  fetch(`${APP_URL}/api/profile?action=streak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  }).catch(e => console.error('Streak failed (non-fatal):', e));

  return res.json({
    briefCheckId,
    redCount,
    amberCount,
    greenCount,
    totalExposureEstimate,
    resultStatus,
    dossierId, // = Campaigns record ID = CampaignID in Campaign_Dossiers
  });
}
