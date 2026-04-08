// ─────────────────────────────────────────────────────────────
// SENDWIZE — submit-check.js v4.21
// Campaign Compliance Dossier (Tool 5) + Campaign Brief Checker (Tool 7).
//
// POST ?action=dossier-save    { userId, dossierId, module, evidenceJson }
// GET  ?action=dossier-get&dossierId=x&userId=x
// POST ?action=dossier-submit  { userId, dossierId, issues[] }
// POST ?action=brief-check     { userId, campaignName, ...fields }
//
// Module keys use PascalCase matching Airtable field names:
//   ListProvenance | ConsentMechanism | ContentCheck | Suppression | SenderIdentity
//
// brief-check field values (from frontend selects):
//   lawfulBasis:    explicit_consent | soft_opt_in | legitimate_interest | contract | none | unsure
//   listSource:     own_organic | own_purchased | third_party | mixed
//   suppressionDone: yes | partial | no | unsure
//   hasUnsubscribe: yes | no | na
//   senderClear:    yes | no | unsure
//   channel:        email | sms | push | direct_mail | social_ad
// ─────────────────────────────────────────────────────────────

const APP_URL = 'https://sendwize-backend.vercel.app';

const DOSSIER_MODULES = [
  'ListProvenance',
  'ConsentMechanism',
  'ContentCheck',
  'Suppression',
  'SenderIdentity',
];

// ── Dynamic severity refinement ──────────────────────────────
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

// ── ISSUE_TO_FIX ─────────────────────────────────────────────
const ISSUE_TO_FIX = {
  'No suppression list system':               { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: No suppression list system in place. Implement and screen before every campaign.' },
  'No suppression list screening (email)':    { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Suppression list not screened before email campaign.' },
  'Purchased email data lacks named consent': { fixType: 'third_party_list',          severity: 'high',     description: 'Dossier: Purchased email list lacks consent naming this organisation.' },
  'Third-party data due diligence incomplete':{ fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: Due diligence on third-party data source not completed before use.' },
  'Third-party data provenance unverifiable': { fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: Cannot verify provenance of purchased/rented data — must not use.' },
  'Consent not freely given':                 { fixType: 'invalid_consent_mechanism', severity: 'critical', description: 'Dossier: Consent was not freely given — bundled, conditioned, or pre-ticked.' },
  'No opt-out mechanism':                     { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: No opt-out mechanism included in marketing communications.' },
  'No opt-out at point of collection':        { fixType: 'missing_unsubscribe',       severity: 'high',     description: 'Dossier: No opt-out offered when contact details were first collected.' },
  'No opt-out in every communication':        { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Opt-out not included in every communication (soft opt-in condition).' },
  'PECR consent invalid':                     { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: PECR consent does not meet the required standard for electronic mail marketing.' },
  'Soft opt-in for different products':       { fixType: 'no_soft_optin',             severity: 'high',     description: 'Dossier: Soft opt-in applied to marketing for different products/services — express consent required.' },
  'Third-party consent unusable for email':   { fixType: 'missing_unsubscribe',       severity: 'critical', description: 'Dossier: Third-party consent cannot be used for email — does not specifically name this organisation.' },
  'Misleading claim in content':              { fixType: 'misleading_claim',          severity: 'high',     description: 'Dossier: Content contains a misleading claim that requires evidence or correction.' },
  'Fake urgency or scarcity':                 { fixType: 'fake_urgency',              severity: 'medium',   description: 'Dossier: Content uses urgency or scarcity language that may not reflect genuine constraints.' },
  'Misleading pricing':                       { fixType: 'misleading_pricing',        severity: 'high',     description: 'Dossier: Content contains reference pricing or fee presentation that does not comply with DMCCA 2024.' },
  'Health claim not authorised':              { fixType: 'unauthorised_health_claim', severity: 'high',     description: 'Dossier: Content includes a health claim not on the UK authorised health claims register.' },
  'No T&Cs linked in promotion':              { fixType: 'missing_terms',             severity: 'low',      description: 'Dossier: Promotional content does not link to terms and conditions.' },
  'Dark pattern in content':                  { fixType: 'dark_pattern',              severity: 'high',     description: 'Dossier: Content uses a dark pattern that may constitute an unfair commercial practice under DMCCA 2024.' },
  'Suppressed contacts not excluded':         { fixType: 'suppressed_contact',        severity: 'critical', description: 'Dossier: Suppressed contacts (opted-out or TPS-registered) not excluded from send list.' },
  'No TPS screening':                         { fixType: 'suppressed_contact',        severity: 'high',     description: 'Dossier: TPS not screened before telephone marketing.' },
  'Opt-outs not processed':                   { fixType: 'missing_unsubscribe',       severity: 'high',     description: 'Dossier: Previous opt-out requests not processed before this campaign.' },
  'Sender not clearly identified':            { fixType: 'concealed_sender',          severity: 'high',     description: 'Dossier: Sender identity not clearly disclosed in marketing communication — PECR Reg 23 requirement.' },
  'No postal address in email':               { fixType: 'missing_address',           severity: 'medium',   description: 'Dossier: Email does not include a postal address for the sender.' },
  'No privacy policy link':                   { fixType: 'no_privacy_policy',         severity: 'medium',   description: 'Dossier: Email does not link to a privacy policy.' },
  'No Data Processing Agreement':             { fixType: 'no_dpa',                    severity: 'high',     description: 'Dossier: No written DPA with ESP or other processors used in this campaign — UK GDPR Article 28 breach.' },
};

// ─────────────────────────────────────────────────────────────
// runBriefCheck — deterministic cross-reference
//
// Field values received from frontend:
//   lawfulBasis:    explicit_consent | soft_opt_in | legitimate_interest | contract | none | unsure
//   listSource:     own_organic | own_purchased | third_party | mixed
//   suppressionDone: yes | partial | no | unsure
//   hasUnsubscribe: yes | no | na
//   senderClear:    yes | no | unsure
//   channel:        email | sms | push | direct_mail | social_ad
//   consentDate:    free text, may contain a 4-digit year
//   coreOffer:      free text — checked for high-risk keywords
//   softOptInAnswers: { existing_customer, similar_products, opt_out_given, opt_out_now } — yes | no | null
// ─────────────────────────────────────────────────────────────
function runBriefCheck(fields) {
  const issues = [];
  const {
    channel,
    lawfulBasis,
    listSource,
    suppressionDone,
    hasUnsubscribe,
    senderClear,
    consentDate,
    coreOffer,
    softOptInAnswers,
  } = fields;

  const isElectronic = ['email', 'sms', 'push'].includes(channel);

  // ── 1. Lawful basis vs channel ────────────────────────────
  if (isElectronic && lawfulBasis === 'legitimate_interest') {
    issues.push({
      field: 'lawfulBasis', severity: 'red',
      regulation: 'PECR Reg 22',
      issue: 'Legitimate interest cannot be used as a lawful basis for electronic direct marketing.',
      description: 'PECR requires express consent or soft opt-in for email, SMS, and push marketing. Legitimate interest only applies to non-electronic channels.',
      fixType: 'no_consent',
    });
  }

  if (isElectronic && (lawfulBasis === 'none' || lawfulBasis === 'unsure')) {
    issues.push({
      field: 'lawfulBasis', severity: 'red',
      regulation: 'PECR Reg 22',
      issue: `No valid consent basis confirmed for ${channel} marketing.`,
      description: 'You must have express consent or a valid soft opt-in before sending electronic marketing. Sending without a confirmed basis is a PECR breach.',
      fixType: 'no_consent',
    });
  }

  if (!isElectronic && (lawfulBasis === 'none' || lawfulBasis === 'unsure')) {
    issues.push({
      field: 'lawfulBasis', severity: 'amber',
      regulation: 'UK GDPR',
      issue: 'No confirmed lawful basis for processing contact data.',
      description: 'Even for non-electronic channels you need a confirmed UK GDPR lawful basis. Clarify before sending.',
      fixType: 'no_consent',
    });
  }

  if (lawfulBasis === 'contract' && isElectronic) {
    issues.push({
      field: 'lawfulBasis', severity: 'amber',
      regulation: 'PECR Reg 22',
      issue: 'Contract basis does not satisfy PECR for electronic marketing.',
      description: 'UK GDPR lawful basis and PECR consent are separate requirements. A contract basis satisfies UK GDPR but electronic marketing still requires PECR consent or soft opt-in.',
      fixType: 'invalid_consent_mechanism',
    });
  }

  // ── 2. List source ────────────────────────────────────────
  if (listSource === 'own_purchased' || listSource === 'third_party') {
    issues.push({
      field: 'listSource', severity: 'red',
      regulation: 'PECR Reg 22 / UK GDPR',
      issue: 'Purchased or third-party list — consent almost certainly invalid for electronic marketing.',
      description: 'PECR requires consent that specifically names your organisation. Purchased lists almost never meet this standard. If used for email or SMS this is a PECR breach.',
      fixType: 'third_party_list',
    });
  }

  if (listSource === 'mixed') {
    issues.push({
      field: 'listSource', severity: 'amber',
      regulation: 'PECR Reg 22',
      issue: 'Mixed list sources — consent validity must be verified per segment.',
      description: 'Different segments may have different consent status. Verify each source separately before sending.',
      fixType: 'third_party_list',
    });
  }

  // ── 3. Soft opt-in conditions ─────────────────────────────
  if (lawfulBasis === 'soft_opt_in' && (listSource === 'own_purchased' || listSource === 'third_party')) {
    issues.push({
      field: 'lawfulBasis', severity: 'red',
      regulation: 'PECR Reg 22',
      issue: 'Soft opt-in cannot apply to purchased or third-party data.',
      description: 'Soft opt-in only applies to contacts whose details were obtained during your own transaction. It cannot be applied to bought or partner data.',
      fixType: 'no_soft_optin',
    });
  }

  // Check soft opt-in qualifier answers — any No = RED
  if (lawfulBasis === 'soft_opt_in' && softOptInAnswers) {
    const { existing_customer, similar_products, opt_out_given, opt_out_now } = softOptInAnswers;
    const failedConditions = [];
    if (existing_customer === 'no') failedConditions.push('contacts were not obtained during a sale');
    if (similar_products  === 'no') failedConditions.push('products are not similar to those originally purchased');
    if (opt_out_given     === 'no') failedConditions.push('no opt-out was offered at point of collection');
    if (opt_out_now       === 'no') failedConditions.push('opt-out is not included in every message');

    if (failedConditions.length > 0) {
      issues.push({
        field: 'softOptIn', severity: 'red',
        regulation: 'PECR Reg 22',
        issue: `Soft opt-in conditions not met: ${failedConditions.join('; ')}.`,
        description: 'All four PECR soft opt-in conditions must be satisfied. Where any condition fails, express consent is required instead.',
        fixType: 'no_soft_optin',
      });
    }
  }

  // ── 4. Suppression ────────────────────────────────────────
  if (suppressionDone === 'no') {
    issues.push({
      field: 'suppressionDone', severity: 'red',
      regulation: 'PECR Reg 23',
      issue: 'Suppression list not applied.',
      description: 'Sending to opted-out contacts is a direct PECR breach. Apply your suppression list before every send.',
      fixType: 'suppressed_contact',
    });
  }

  if (suppressionDone === 'partial' || suppressionDone === 'unsure') {
    issues.push({
      field: 'suppressionDone', severity: 'amber',
      regulation: 'PECR Reg 23',
      issue: 'Suppression status not confirmed for all contacts.',
      description: 'Partial or uncertain suppression leaves you exposed. Confirm full suppression list application before sending.',
      fixType: 'suppressed_contact',
    });
  }

  // ── 5. Unsubscribe mechanism ──────────────────────────────
  if (isElectronic && hasUnsubscribe === 'no') {
    issues.push({
      field: 'hasUnsubscribe', severity: 'red',
      regulation: 'PECR Reg 22',
      issue: 'No unsubscribe mechanism in every message.',
      description: 'PECR Regulation 22 requires a simple, free opt-out in every electronic marketing message. This is not optional.',
      fixType: 'missing_unsubscribe',
    });
  }

  // ── 6. Sender identity ────────────────────────────────────
  if (senderClear === 'no') {
    issues.push({
      field: 'senderClear', severity: 'red',
      regulation: 'PECR Reg 23',
      issue: 'Sender not clearly identified.',
      description: 'PECR Regulation 23 requires the sender to be clearly identifiable. The From name and a contact address must be included.',
      fixType: 'concealed_sender',
    });
  }

  if (senderClear === 'unsure') {
    issues.push({
      field: 'senderClear', severity: 'amber',
      regulation: 'PECR Reg 23',
      issue: 'Sender identity not confirmed.',
      description: 'Verify that the From name matches your trading name and that a contact address is included before sending.',
      fixType: 'concealed_sender',
    });
  }

  // ── 7. Consent date ───────────────────────────────────────
  if (consentDate) {
    const lc = consentDate.toLowerCase();
    if (lc === 'unknown' || lc === "don't know" || lc === 'dont know' || lc === 'not sure') {
      if (isElectronic) {
        issues.push({
          field: 'consentDate', severity: 'red',
          regulation: 'UK GDPR / PECR',
          issue: 'Consent collection date unknown.',
          description: 'You must be able to demonstrate when and how consent was collected. If you cannot, the consent may not be valid.',
          fixType: 'expired_consent',
        });
      }
    } else {
      const yearMatch = consentDate.match(/(\d{4})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        const monthsAgo = (new Date().getFullYear() - year) * 12;
        if (monthsAgo > 24) {
          issues.push({
            field: 'consentDate', severity: 'red',
            regulation: 'UK GDPR / PECR',
            issue: `Consent collected in ${year} may be stale — over 24 months ago.`,
            description: 'ICO guidance indicates that consent should be refreshed periodically. Consent over 24 months old is unlikely to still be valid without a re-consent campaign.',
            fixType: 'expired_consent',
          });
        } else if (monthsAgo > 18) {
          issues.push({
            field: 'consentDate', severity: 'amber',
            regulation: 'UK GDPR',
            issue: `Consent collected in ${year} — approaching the 24-month refresh threshold.`,
            description: 'Consider running a re-consent campaign before consent reaches 24 months old.',
            fixType: 'expired_consent',
          });
        }
      }
    }
  }

  // ── 8. Core offer / incentive keyword check ───────────────
  if (coreOffer) {
    const offer = coreOffer.toLowerCase();

    // Prize draw / competition
    if (/prize draw|competition|prize|win a|enter to win|sweepstake/i.test(offer)) {
      issues.push({
        field: 'coreOffer', severity: 'amber',
        regulation: 'CAP Code 8 / Consumer Protection',
        issue: 'Prize draw or competition — specific ASA CAP Code rules apply.',
        description: 'Prize promotions must state odds or number of prizes, closing date, and conditions. Promoters must not exaggerate the chance of winning. Ensure T&Cs are linked in every communication.',
        fixType: 'unlawful_incentive',
      });
    }

    // Health claims
    if (/cure|treat|heal|clinically proven|medically proven|health benefit|lose weight|weight loss|slimming|detox|anti-aging|anti-ageing/i.test(offer)) {
      issues.push({
        field: 'coreOffer', severity: 'red',
        regulation: 'CAP Code 12 / MHRA',
        issue: 'Potential health claim — requires authorisation or substantiation.',
        description: 'Health and medicinal claims in marketing must be authorised under the UK register of permitted nutrition and health claims, or substantiated to ASA standards. Unauthorised claims risk ASA adjudication.',
        fixType: 'unauthorised_health_claim',
      });
    }

    // Free trial / free offer
    if (/free trial|try free|free for|no charge|completely free/i.test(offer)) {
      issues.push({
        field: 'coreOffer', severity: 'amber',
        regulation: 'CAP Code 3 / CMA',
        issue: '"Free" offer — ensure no hidden charges.',
        description: 'Promotions using "free" must not require the consumer to pay anything beyond the unavoidable cost. Ensure no auto-renewal, sign-up fees, or conditions make the offer misleading.',
        fixType: 'misleading_free_claim',
      });
    }

    // Urgency / scarcity
    if (/last chance|ends tonight|ending soon|limited time|hurry|don't miss|only \d+ left|selling fast|almost gone/i.test(offer)) {
      issues.push({
        field: 'coreOffer', severity: 'amber',
        regulation: 'CAP Code 3.3 / CMA DMCCA',
        issue: 'Urgency or scarcity language — must be genuine.',
        description: 'Artificial urgency or false scarcity is a misleading commercial practice under the DMCCA 2024. Only use time-limited or stock-limited language if the constraint is real.',
        fixType: 'fake_urgency',
      });
    }

    // Reference pricing / discounts
    if (/was [£$€]|rrp|rrp:|recommended retail|save \d+%|marked down|original price|compare at/i.test(offer)) {
      issues.push({
        field: 'coreOffer', severity: 'amber',
        regulation: 'CAP Code 3 / CMA DMCCA 2024',
        issue: 'Reference pricing — must meet the 28-day rule.',
        description: 'Under DMCCA 2024, a "was" price must have been the genuine previous price for a meaningful period. The CMA expects at least 28 consecutive days at the higher price in the last 6 months.',
        fixType: 'misleading_reference_price',
      });
    }
  }

  const redCount   = issues.filter(i => i.severity === 'red').length;
  const amberCount = issues.filter(i => i.severity === 'amber').length;
  const greenCount = Math.max(0, 8 - redCount - amberCount);
  const resultStatus = redCount > 0 ? 'Red' : amberCount > 0 ? 'Amber' : 'Green';

  return { redCount, amberCount, greenCount, issues, resultStatus };
}

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
    return res.status(400).json({ error: 'Unknown action. Use ?action=dossier-save|dossier-get|dossier-submit|brief-check' });
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

  const existingRes  = await fetch(
    `${base}/Campaign_Dossiers?filterByFormula=AND({UserID}='${userId}',{CampaignID}='${dossierId}')&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const existingData = existingRes.ok ? await existingRes.json() : { records: [] };
  const existing     = existingData.records?.[0];

  const fields = {
    UserID:     userId,
    CampaignID: dossierId,
    [module]:   moduleText,
    UpdatedAt:  new Date().toISOString(),
  };
  if (campaignTitle) fields.CampaignTitle = campaignTitle;
  if (ownerName)     fields.OwnerName     = ownerName;

  let result;
  if (existing) {
    const r = await fetch(`${base}/Campaign_Dossiers/${existing.id}`, {
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

  if (!r.ok) { console.error('Campaign_Dossiers fetch failed:', r.status); return res.status(r.status).json({ error: 'Failed to fetch dossier' }); }

  const data   = await r.json();
  const record = data.records?.[0];

  if (!record) {
    return res.json({
      CampaignTitle: '', OwnerName: '', Status: 'Draft',
      UserID: userId, CampaignID: dossierId,
      ListProvenance: '', ConsentMechanism: '', ContentCheck: '', Suppression: '', SenderIdentity: '',
    });
  }

  const f = record.fields;
  return res.json({
    recordId:         record.id,
    CampaignTitle:    f.CampaignTitle   || '',
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
    const pr = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) { console.error('Profile fetch failed:', e); }

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
        body: JSON.stringify({ userId, fixType: mapping.fixType, description: mapping.description, tool: 'Campaign Dossier', severity: finalSeverity, volume: null, sourceRecordId: dossierId }),
      });
      const fixData = await fixRes.json();
      fixResults.push({ issue: issueKey, status: fixData.skipped ? 'duplicate_skipped' : 'created', fixId: fixData.fixId });
    } catch(e) {
      console.error(`generate-fix failed for "${issueKey}":`, e);
      fixResults.push({ issue: issueKey, status: 'error' });
    }
  }

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
          body: JSON.stringify({ fields: { Status: 'Submitted', IssuesFound: issueList.length, SubmittedAt: new Date().toISOString() } }),
        })
      ));
    }
  } catch(e) { console.error('Dossier status update failed (non-fatal):', e); }

  fetch(`${APP_URL}/api/profile?action=streak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
    .catch(e => console.error('Streak failed:', e));

  return res.json({ success: true, dossierId, issuesFound: issueList.length, fixesGenerated: fixResults.filter(f => f.status === 'created').length, fixResults });
}

// ─────────────────────────────────────────────────────────────
// brief-check
// ─────────────────────────────────────────────────────────────
async function handleBriefCheck(req, res) {
  const {
    userId, campaignName,
    channel, audience, lawfulBasis, listSource,
    consentDate, coreOffer, listSize,
    suppressionDone, hasUnsubscribe, senderClear,
    softOptInAnswers,
  } = req.body ?? {};

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  // Run the deterministic checks with the full field set
  const briefFields = { channel, audience, lawfulBasis, listSource, consentDate, coreOffer, suppressionDone, hasUnsubscribe, senderClear, softOptInAnswers };
  const { redCount, amberCount, greenCount, issues, resultStatus } = runBriefCheck(briefFields);

  // Save Brief_Checks record
  let briefCheckId = null, totalExposureEstimate = 0;
  try {
    const briefRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: {
        UserID:          userId,
        CampaignName:    campaignName || `Brief ${new Date().toLocaleDateString('en-GB')}`,
        CheckDate:       new Date().toISOString().split('T')[0],
        BriefFieldsJson: JSON.stringify(briefFields),
        RedCount:        redCount,
        AmberCount:      amberCount,
        GreenCount:      greenCount,
        IssuesJson:      JSON.stringify(issues),
        ResultStatus:    resultStatus,
      }}]}),
    });
    if (briefRes.ok) briefCheckId = (await briefRes.json()).records?.[0]?.id ?? null;
  } catch(e) { console.error('Brief_Checks save failed (non-fatal):', e); }

  // emailVolume for refineSeverity
  let emailVolume = 'medium_send';
  try {
    const pr = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) emailVolume = (await pr.json()).records?.[0]?.fields?.EmailVolume || 'medium_send';
  } catch(e) {}

  // Generate fix records
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
    } catch(e) { console.error('generate-fix failed for brief issue:', e); }
  }

  if (briefCheckId && totalExposureEstimate > 0) {
    fetch(`https://api.airtable.com/v0/${BASE_ID}/Brief_Checks/${briefCheckId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { TotalExposureEstimate: totalExposureEstimate } }),
    }).catch(e => console.error('TotalExposureEstimate update failed (non-fatal):', e));
  }

  // On non-Red: create Campaigns + Campaign_Dossiers skeleton
  let dossierId = null;
  if (resultStatus !== 'Red') {
    try {
      const campRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaigns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: {
          UserID: userId,
          CampaignName: campaignName || `Campaign ${new Date().toLocaleDateString('en-GB')}`,
          CampaignType: channel || 'email',
          BriefCheckID: briefCheckId,
          Status:       'Active',
          CreatedDate:  new Date().toISOString().split('T')[0],
        }}]}),
      });
      if (campRes.ok) {
        const campaignId = (await campRes.json()).records?.[0]?.id ?? null;
        if (campaignId) {
          const dossierRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Campaign_Dossiers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields: {
              UserID:        userId,
              CampaignID:    campaignId,
              CampaignTitle: campaignName || 'Unnamed Campaign',
              OwnerName:     '',
              Status:        'Draft',
              CreatedDate:   new Date().toISOString().split('T')[0],
            }}]}),
          });
          if (dossierRes.ok) dossierId = campaignId;
        }
      }
    } catch(e) { console.error('Dossier skeleton creation failed (non-fatal):', e); }
  }

  fetch(`${APP_URL}/api/profile?action=streak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
    .catch(e => console.error('Streak failed:', e));

  return res.json({ briefCheckId, redCount, amberCount, greenCount, issues, totalExposureEstimate, resultStatus, dossierId: resultStatus !== 'Red' ? dossierId : null });
}
