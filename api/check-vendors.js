// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.27
// POST { vendors: [{ name, isCustom }], userId }
//
// v4.27 changes from v4.26:
//   - processingContext now built and passed to every generate-fix
//     call. Pulls DataProcessed, ContactVolume, DPAStatus from
//     Vendor_Register for the user's existing register entry.
//     Falls back to vendor dimensions if no register entry exists.
//   - Option A pattern: reads Vendor_Register after upsert so
//     context always reflects saved state, not transient UI.
//   - processingContext shape:
//     { dataTypes, contactVolume, vendorBreachHistory,
//       dpaStatus, hasDocumentedAssessment, vendorName }
//   - All other logic unchanged from v4.26.
// ─────────────────────────────────────────────────────────────
const APP_URL = 'https://sendwize-backend.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { vendors, userId } = req.body ?? {};
    if (!userId)                             return res.status(400).json({ error: 'Missing userId' });
    if (!vendors || !Array.isArray(vendors)) return res.status(400).json({ error: 'vendors array is required' });
    if (vendors.length === 0)                return res.status(400).json({ error: 'vendors array is empty' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const atBase         = `https://api.airtable.com/v0/${BASE_ID}`;
    const atH            = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // ── 1. Fetch known vendor library records ─────────────────
    const knownNames  = vendors.filter(v => !v.isCustom).map(v => v.name.toLowerCase());
    let vendorLibrary = {};
    if (knownNames.length > 0) {
      try {
        const formula = `OR(${knownNames.map(n => `LOWER({VendorName})='${n}'`).join(',')})`;
        const libRes  = await fetch(
          `${atBase}/Marketing_Vendors?filterByFormula=${encodeURIComponent(formula)}`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        if (libRes.ok) {
          for (const r of ((await libRes.json()).records || [])) {
            vendorLibrary[r.fields.VendorName?.toLowerCase()] = r.fields;
          }
        }
      } catch (e) { console.error('Marketing_Vendors fetch failed (non-fatal):', e); }
    }

    // ── 2. Fetch existing Vendor_Register entries for this user ─
    // Used in Option A to read DataProcessed, ContactVolume, DPAStatus
    // for processingContext. Fetched once, keyed by VendorName.
    let registerEntries = {};
    try {
      const regRes = await fetch(
        `${atBase}/Vendor_Register?filterByFormula={UserID}='${userId}'&maxRecords=100`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (regRes.ok) {
        for (const r of ((await regRes.json()).records || [])) {
          if (r.fields.VendorName) {
            registerEntries[r.fields.VendorName.toLowerCase()] = { id: r.id, fields: r.fields };
          }
        }
      }
    } catch (e) { console.error('Vendor_Register pre-fetch failed (non-fatal):', e); }

    // ── 3. Analyse each vendor ────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      const result = vendor.isCustom
        ? await analyzeVendorWithAI(vendor.name)
        : handleKnownVendor(vendor.name, vendorLibrary[vendor.name.toLowerCase()] || null);
      results.push(result);
    }

    // ── 4. Save to Vendor_Checks ──────────────────────────────
    let sourceRecordId = null;
    try {
      const avgScore = results.length > 0
        ? Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length)
        : 0;
      const saveRes = await fetch(`${atBase}/Vendor_Checks`, {
        method:  'POST',
        headers: atH,
        body: JSON.stringify({ records: [{ fields: {
          UserID:         userId,
          CheckDate:      new Date().toISOString().split('T')[0],
          VendorsChecked: vendors.map(v => v.name).join(', '),
          VendorCount:    vendors.length,
          AverageScore:   avgScore,
          Results:        JSON.stringify(results),
        }}]})
      });
      if (saveRes.ok) sourceRecordId = (await saveRes.json()).records?.[0]?.id ?? null;
    } catch (e) { console.error('Vendor_Checks save error:', e); }

    // ── 5. Upsert Vendor_Register ─────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const existing = registerEntries[result.name.toLowerCase()];
        const updateFields = Object.fromEntries(Object.entries({
          LastChecked:     today,
          Category:        result.vendorType || null,
          ComplianceScore: result.score ?? null,
          CheckResults:    JSON.stringify(result),
        }).filter(([, v]) => v !== null && v !== undefined));

        if (existing) {
          await fetch(`${atBase}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: atH,
            body:    JSON.stringify({ fields: updateFields }),
          });
          // Update local cache with new score
          registerEntries[result.name.toLowerCase()].fields = {
            ...existing.fields, ...updateFields
          };
        } else {
          const createRes = await fetch(`${atBase}/Vendor_Register`, {
            method:  'POST',
            headers: atH,
            body:    JSON.stringify({ records: [{ fields: {
              UserID:     userId,
              VendorName: result.name,
              ...updateFields
            }}]}),
          });
          if (createRes.ok) {
            const created = (await createRes.json()).records?.[0];
            if (created) registerEntries[result.name.toLowerCase()] = { id: created.id, fields: created.fields };
          }
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name} (non-fatal):`, e); }
    }

    // ── 6. Generate fix records with processingContext ────────
    for (const result of results) {
      const regEntry = registerEntries[result.name.toLowerCase()];
      const fixes = buildFixesForResult(result, userId, sourceRecordId, regEntry?.fields || null);
      for (const fix of fixes) {
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(fix),
          });
        } catch (e) { console.error(`generate-fix failed for ${result.name}:`, e); }
      }
    }

    // ── 7. Streak ─────────────────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    return res.status(200).json({ results });

  } catch (error) {
    console.error('check-vendors error:', error);
    return res.status(500).json({ error: 'Vendor check failed' });
  }
}

// ─────────────────────────────────────────────────────────────
// buildProcessingContext
// Builds the processingContext object for generate-fix.
// Option A: reads from Vendor_Register fields (already saved).
// Falls back to vendor dimensions if register entry is absent.
// ─────────────────────────────────────────────────────────────
function buildProcessingContext(result, regFields) {
  const d = result.dimensions || {};

  // Data types — from register (most accurate) or fall back to empty
  let dataTypes = [];
  if (regFields?.DataProcessed) {
    try {
      const parsed = JSON.parse(regFields.DataProcessed);
      dataTypes = Array.isArray(parsed) ? parsed : [regFields.DataProcessed];
    } catch(e) {
      // DataProcessed stored as plain string
      dataTypes = regFields.DataProcessed
        ? regFields.DataProcessed.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    }
  }

  // Contact volume — from register
  const contactVolume = regFields?.ContactVolume
    ? parseInt(regFields.ContactVolume, 10) || null
    : null;

  // DPA status — register DPAStatus (structured select) takes priority
  // Maps register options → canonical values for processingContext
  const regDPA = regFields?.DPAStatus || '';
  const dpaMap = {
    'Signed':      'Confirmed',
    'Requested':   'On Request',
    'Not yet':     'Unknown',
    'N/A':         'Unknown',
  };
  const dpaStatus = dpaMap[regDPA] || d.dpaStatus || 'Unknown';

  // Breach history — from vendor dimensions (library data)
  const breachHistory = d.breachHistory || 'None identified';
  const breachKnown   = breachHistory &&
    !['none identified','none','no','unknown',''].includes(breachHistory.toLowerCase());

  // Documented assessment — true if register has notes or DPA link
  const hasDocumentedAssessment = !!(regFields?.Notes || regFields?.DPALink);

  return {
    vendorName:              result.name,
    dataTypes,
    contactVolume,
    vendorBreachHistory:     breachKnown ? breachHistory : 'None identified',
    dpaStatus,
    hasDocumentedAssessment,
  };
}

// ─────────────────────────────────────────────────────────────
// buildFixesForResult
// v4.27: passes processingContext to every generate-fix call.
// ─────────────────────────────────────────────────────────────
function buildFixesForResult(result, userId, sourceRecordId, regFields) {
  const fixes = [];
  const name  = result.name;
  const d     = result.dimensions || {};
  let   dpaBreach = false;

  const icoStatus      = (d.icoRegistered        || '').toLowerCase();
  const dpaStatus      = (d.dpaStatus            || '').toLowerCase();
  const transferOccurs = (d.intlTransferOccurs   || '').toLowerCase();
  const transferMech   = (d.internationalTransfer|| '').toLowerCase();
  const breach         = (d.breachHistory        || '').trim();

  const breachIsKnown = breach &&
    !['none identified','none','no','unknown',''].includes(breach.toLowerCase());

  // Build processing context once — shared across all fixes for this vendor
  const processingContext = buildProcessingContext(result, regFields);

  // ICO not registered — critical
  if (icoStatus === 'no' || icoStatus === 'not found') {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} does not appear to be registered with the ICO. UK processors handling personal data must register. Verify at ico.org.uk/ESDWebPages/Search before sharing any contact data.`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'critical',
      contactVolume: processingContext.contactVolume,
    });
    dpaBreach = true;
  }

  // DPA refused — critical
  if (dpaStatus === 'refused') {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} has refused to sign a Data Processing Agreement. Transferring personal data to them is a UK GDPR Article 28 breach. Stop sharing personal data with this vendor immediately.`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'critical',
      contactVolume: processingContext.contactVolume,
    });
    dpaBreach = true;
  }

  // No DPA confirmed — high
  if (!result.dpaConfirmed && !dpaBreach) {
    const hint = dpaStatus === 'on request'
      ? `Contact ${name} to obtain and sign their DPA.`
      : `Check their website for a DPA or contact their privacy team.`;
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Vendor Checker: No confirmed Data Processing Agreement for ${name}. UK GDPR Article 28 requires a written DPA before sharing personal data with any processor. ${hint}`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'high',
      contactVolume: processingContext.contactVolume,
    });
    dpaBreach = true;
  }

  // Score < 60 — high (only if no specific fix already generated)
  if (!dpaBreach && (result.score || 0) < 60) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} scored ${result.score}/100 — multiple compliance gaps identified. Review the vendor card for specific issues and contact ${name} to address them.`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'high',
      contactVolume: processingContext.contactVolume,
    });
  }

  // International transfer with no mechanism — medium
  if (transferOccurs === 'yes' && (transferMech === 'none' || transferMech === 'unknown' || transferMech === '')) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} transfers data internationally but no confirmed transfer mechanism (SCCs, Adequacy, UK-US Data Bridge) has been identified. UK GDPR Chapter V requires a lawful transfer mechanism. Contact ${name} to confirm their transfer basis.`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'medium',
      contactVolume: processingContext.contactVolume,
    });
  }

  // Breach history — medium (always its own fix)
  if (breachIsKnown) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'legitimate_interest_abuse',
      description: `Vendor Checker: ${name} has a known breach or enforcement history: ${breach.slice(0, 200)}. UK GDPR requires you to assess whether continued use of this vendor is proportionate. Document your assessment and consider whether a DPIA is required.`,
      tool:        `Vendor Checker — ${name}`,
      severity:    'medium',
      contactVolume: processingContext.contactVolume,
    });
  }

  return fixes;
}

// ─────────────────────────────────────────────────────────────
// calculateRiskRating
// ─────────────────────────────────────────────────────────────
function calculateRiskRating(d) {
  const ico    = (d.icoRegistered                  || '').toLowerCase();
  const dpa    = (d.dpaStatus                      || '').toLowerCase();
  const mech   = (d.internationalTransfer          || d.transferMechanismConfirmed || '').toLowerCase();
  const breach = (d.breachHistory                  || '').toLowerCase();
  const dest   = (d.transferDestination            || '').toLowerCase();
  const cert   = (d.relevantSecurityCertification  || '').toLowerCase();
  const dpo    = (d.dpoConfirmed                   || '').toLowerCase();
  const intl   = (d.intlTransferOccurs             || '').toLowerCase();

  if (ico === 'no' || ico === 'not found') return 'High';
  if (breach && !['none identified','none','no','unknown',''].includes(breach)) return 'High';
  const nonAdequate = dest && !['eu','eea','uk','n/a'].some(t => dest.includes(t));
  const noMech      = mech === 'none' || mech === 'unknown' || mech === '';
  if (intl === 'yes' && nonAdequate && noMech) return 'High';
  if (dpa === 'refused') return 'High';
  if (['on request','unknown','not available'].includes(dpa)) return 'Medium';
  if (intl === 'yes' && noMech) return 'Medium';
  if (!cert || ['no','none','unknown'].includes(cert)) return 'Medium';
  if (!dpo  || ['no','none','unknown'].includes(dpo))  return 'Medium';
  return 'Low';
}

// ─────────────────────────────────────────────────────────────
// handleKnownVendor
// ─────────────────────────────────────────────────────────────
function handleKnownVendor(name, fields) {
  if (!fields) {
    return {
      name, score: 50, riskRating: 'Medium', isAI: false, dpaConfirmed: false, vendorType: '',
      details: [{ status: 'warning', label: 'Not in vendor library',
        description: `${name} is not yet in the Sendwize vendor library. Check their website for a DPA and complete a manual review.` }],
      actionItems: [
        'Search for their Data Processing Agreement or Privacy Policy',
        'Check ICO register: https://ico.org.uk/ESDWebPages/Search',
        'Confirm data storage location and international transfer mechanism',
      ],
      dimensions: {}
    };
  }

  const details = [];
  let   score   = 100;

  // ICO Registration
  const icoStatus = fields.ICORegistered || 'Unknown';
  if      (icoStatus === 'Yes')    { details.push({ status: 'pass',    label: 'ICO Registration', description: `Registered with ICO${fields.ICORegNumber ? ` (${fields.ICORegNumber})` : ''}.` }); }
  else if (icoStatus === 'Exempt') { details.push({ status: 'info',    label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies to their UK processing activities.' }); }
  else if (icoStatus === 'No')     { details.push({ status: 'fail',    label: 'ICO Registration', description: 'Not found on ICO register. UK processors handling personal data are generally required to register.' }); score -= 20; }
  else                             { details.push({ status: 'info',    label: 'ICO Registration', description: 'ICO registration status not confirmed — verify at ico.org.uk/ESDWebPages/Search.' }); score -= 5; }

  // DPA
  const dpaStatus    = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Confirmed';
  const privacyUrl   = fields.PrivacyPolicyUrl || null;
  if      (dpaConfirmed)               { details.push({ status: 'pass',    label: 'Data Processing Agreement', description: `DPA confirmed${privacyUrl ? ` — ${privacyUrl}` : ''}.` }); }
  else if (dpaStatus === 'On Request') { details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA available on request — contact vendor to obtain and sign before sharing personal data.' }); score -= 15; }
  else if (dpaStatus === 'Refused')    { details.push({ status: 'fail',    label: 'Data Processing Agreement', description: 'Vendor has declined to sign a DPA. Transferring personal data to them is a UK GDPR Article 28 breach.' }); score -= 35; }
  else                                 { details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA status not confirmed — contact vendor before sharing personal data.' }); score -= 15; }

  // International Transfers
  const transferOccurs = fields.IntlTransferOccurs         || 'Unknown';
  const transferDest   = fields.TransferDestination        || '';
  const transferMech   = fields.TransferMechanismConfirmed || 'Unknown';
  if      (transferOccurs === 'No')                                                        { details.push({ status: 'pass', label: 'International Transfers', description: 'Processing confirmed as UK/EEA only — no international transfer mechanism required.' }); }
  else if (['Adequacy','SCCs','BCRs','UK-US Bridge'].includes(transferMech))               { details.push({ status: 'pass', label: 'International Transfers', description: `Transfer mechanism confirmed: ${transferMech}${transferDest ? ` (${transferDest})` : ''}.` }); }
  else if (transferOccurs === 'Yes' && (transferMech === 'None' || transferMech === 'Unknown')) { details.push({ status: 'fail', label: 'International Transfers', description: `International transfer to ${transferDest || 'unknown destination'} with no confirmed mechanism.` }); score -= 20; }
  else                                                                                     { details.push({ status: 'info', label: 'International Transfers', description: 'International transfer status not confirmed — verify if data leaves UK/EEA.' }); score -= 5; }

  // Breach History
  const breachHistory = fields.BreachHistory || '';
  const breachIsKnown = breachHistory && !['none identified','none','no','unknown',''].includes(breachHistory.toLowerCase());
  if (!breachIsKnown) { details.push({ status: 'pass',    label: 'Breach History', description: 'No publicly known significant breaches or enforcement actions identified.' }); }
  else                { details.push({ status: 'warning', label: 'Breach History', description: breachHistory }); score -= 15; }

  // DPO
  const dpoStatus = fields.DPOConfirmed || 'Unknown';
  if      (dpoStatus === 'Yes') { details.push({ status: 'pass', label: 'DPO', description: 'Named DPO or controller representative confirmed.' }); }
  else if (dpoStatus === 'No')  { details.push({ status: 'info', label: 'DPO', description: 'No named DPO identified — advisory only for most processors.' }); }
  else                          { details.push({ status: 'info', label: 'DPO', description: 'DPO status not confirmed.' }); }

  // Security Certification
  const certStatus = fields.RelevantSecurityCertification || 'Unknown';
  if      (certStatus === 'Yes') { details.push({ status: 'pass', label: 'Security Certification', description: 'Relevant security certification confirmed (ISO 27001, SOC 2 or equivalent).' }); }
  else if (certStatus === 'No')  { details.push({ status: 'info', label: 'Security Certification', description: 'No ISO 27001, SOC 2 or equivalent identified — advisory only.' }); score -= 5; }
  else                           { details.push({ status: 'info', label: 'Security Certification', description: 'Security certification not confirmed.' }); }

  // Privacy Policy URL
  if (privacyUrl) { details.push({ status: 'info', label: 'Privacy Policy / DPA', description: `Available at: ${privacyUrl}` }); }

  const riskRating = fields.RiskRating || calculateRiskRating({
    icoRegistered: icoStatus, dpaStatus, intlTransferOccurs: transferOccurs,
    internationalTransfer: transferMech, transferDestination: transferDest,
    breachHistory, dpoConfirmed: dpoStatus, relevantSecurityCertification: certStatus,
  });

  const actionItems = [];
  if (!dpaConfirmed && dpaStatus !== 'Refused') actionItems.push('Obtain and sign a Data Processing Agreement with this vendor');
  if (dpaStatus === 'Refused')    actionItems.push('Stop sharing personal data with this vendor — find a compliant alternative');
  if (transferOccurs === 'Yes' && transferMech === 'Unknown') actionItems.push('Confirm which international transfer mechanism applies');
  if (icoStatus === 'Unknown')    actionItems.push('Verify ICO registration at: https://ico.org.uk/ESDWebPages/Search');
  if (breachIsKnown)              actionItems.push('Document your assessment of continued use of this vendor given their breach history');
  if (fields.LastVerified)        actionItems.push(`Library data last verified: ${fields.LastVerified} — re-verify if older than 12 months`);
  if (privacyUrl)                 actionItems.push(`Review privacy policy / DPA at: ${privacyUrl}`);

  return {
    name,
    vendorType:   fields.VendorType || '',
    score:        Math.max(0, score),
    riskRating,
    isAI:         false,
    dpaConfirmed,
    details,
    actionItems,
    dimensions: {
      icoRegistered:                 icoStatus,
      icoRegNumber:                  fields.ICORegNumber || null,
      dpaStatus,
      dpaLink:                       privacyUrl,
      intlTransferOccurs:            transferOccurs,
      transferDestination:           transferDest,
      internationalTransfer:         transferMech,
      breachHistory:                 breachHistory || 'None identified',
      dpoConfirmed:                  dpoStatus,
      relevantSecurityCertification: certStatus,
      lastVerified:                  fields.LastVerified || null,
    }
  };
}

// ─────────────────────────────────────────────────────────────
// analyzeVendorWithAI
// ─────────────────────────────────────────────────────────────
async function analyzeVendorWithAI(vendorName) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a UK GDPR compliance researcher. A UK marketing team uses "${vendorName}" as a data processor.
Assess this vendor across seven compliance dimensions using only publicly verifiable information. If you cannot verify a dimension, use Unknown — never guess.
Respond ONLY with this exact JSON — no markdown, no preamble:
{
  "score": <integer 0-100>,
  "riskRating": "<Low|Medium|High>",
  "vendorType": "<Self-Serve ESP|Third-party agency|CRM|Analytics|CDP|Advertising|Marketing Agency|Other>",
  "dpaConfirmed": <true|false>,
  "dimensions": {
    "icoRegistered": "<Yes|No|Exempt|Unknown>",
    "icoRegNumber": "<number or null>",
    "dpaStatus": "<Confirmed|On Request|Refused|Unknown>",
    "dpaLink": "<URL or null>",
    "intlTransferOccurs": "<Yes|No|Unknown>",
    "transferDestination": "<EU/EEA|US|India|Other|N/A|Unknown>",
    "internationalTransfer": "<Adequacy|SCCs|BCRs|UK-US Bridge|None|Unknown>",
    "breachHistory": "<plain text of any known breaches or enforcement, or exactly: None identified>",
    "dpoConfirmed": "<Yes|No|Unknown>",
    "relevantSecurityCertification": "<Yes|No|Unknown>"
  },
  "details": [{"status":"<pass|warning|info|fail>","label":"<dimension>","description":"<one sentence>"}],
  "actionItems": ["<specific action>"],
  "confidenceCaveat": "This assessment is based on publicly available information only. Verify directly with the vendor before transferring customer data."
}
Risk: High if ICO not registered OR known breach OR intl transfer no mechanism to non-adequate country OR DPA refused. Medium if DPA On Request/Unknown OR transfer unconfirmed OR no cert OR no DPO. Low otherwise.`
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);
    const data     = await response.json();
    const text     = data.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);
    const d        = analysis.dimensions || {};

    return {
      name:             vendorName,
      vendorType:       analysis.vendorType   || 'Other',
      score:            analysis.score        || 50,
      riskRating:       analysis.riskRating   || calculateRiskRating(d),
      isAI:             true,
      dpaConfirmed:     analysis.dpaConfirmed || false,
      details:          analysis.details      || [],
      actionItems:      analysis.actionItems  || [],
      confidenceCaveat: analysis.confidenceCaveat || 'Assessment based on publicly available information. Verify directly with the vendor.',
      dimensions: {
        icoRegistered:                 d.icoRegistered                 || 'Unknown',
        icoRegNumber:                  d.icoRegNumber                  || null,
        dpaStatus:                     d.dpaStatus                     || 'Unknown',
        dpaLink:                       d.dpaLink                       || null,
        intlTransferOccurs:            d.intlTransferOccurs            || 'Unknown',
        transferDestination:           d.transferDestination           || 'Unknown',
        internationalTransfer:         d.internationalTransfer         || 'Unknown',
        breachHistory:                 d.breachHistory                 || 'Unknown',
        dpoConfirmed:                  d.dpoConfirmed                  || 'Unknown',
        relevantSecurityCertification: d.relevantSecurityCertification || 'Unknown',
        lastVerified:                  null,
      }
    };

  } catch (error) {
    console.error(`AI vendor analysis failed for ${vendorName}:`, error);
    return {
      name: vendorName, vendorType: 'Other', score: 50, riskRating: 'Medium',
      isAI: true, dpaConfirmed: false,
      confidenceCaveat: 'Automated analysis failed. Please verify this vendor manually.',
      details: [{ status: 'warning', label: 'Analysis incomplete', description: 'Unable to automatically analyse this vendor. Please verify compliance manually.' }],
      actionItems: ['Contact vendor for their Data Processing Agreement', 'Check ICO register: https://ico.org.uk/ESDWebPages/Search', 'Confirm data storage location and international transfer mechanism'],
      dimensions: {},
    };
  }
}
