// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.28
// POST { vendors: [{ name, isCustom, dpaStatus, dataTypes, contactVolume }], userId }
//
// v4.28 changes from v4.27:
//   - Frontend now sends dpaStatus (yes/no/unsure), dataTypes[],
//     contactVolume per vendor directly in request body.
//   - buildProcessingContext() now reads from incoming vendor
//     object first — no longer depends on Vendor_Register read
//     for these fields. Falls back to register if not provided.
//   - buildFixesForResult() now driven by user-provided dpaStatus:
//       'no'    → dpa_breach fix (user confirmed no DPA)
//       'unsure'→ dpa_breach fix (unconfirmed = not confirmed)
//       'yes'   → no DPA fix; check breach history + transfer only
//     This is more accurate and defensible than library-derived
//     dpaConfirmed flag which reflected vendor's published position
//     not the user's actual signed agreement status.
//   - Fix severity now considers user's data types and volume:
//       sensitive data (behavioural/purchase/special) + no DPA = critical
//       high volume (>50k) + no DPA = critical
//       otherwise = high
//   - processingContext built from request body, not register read.
//     Vendor_Register upsert still happens for score/history.
//   - Tool label: "Processor Risk Scanner — {VendorName}"
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

    // ── 2. Analyse each vendor ────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      const result = vendor.isCustom
        ? await analyzeVendorWithAI(vendor.name)
        : handleKnownVendor(vendor.name, vendorLibrary[vendor.name.toLowerCase()] || null);
      // Attach user-provided context to result for fix generation
      result.userInput = {
        dpaStatus:     vendor.dpaStatus     || 'unsure',
        dataTypes:     vendor.dataTypes     || [],
        contactVolume: vendor.contactVolume || null,
      };
      results.push(result);
    }

    // ── 3. Save to Vendor_Checks ──────────────────────────────
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

    // ── 4. Upsert Vendor_Register ─────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const ui = result.userInput || {};
        const existingRes = await fetch(
          `${atBase}/Vendor_Register?filterByFormula=AND({UserID}='${userId}',{VendorName}='${result.name}')&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const existing = (existingRes.ok ? await existingRes.json() : { records: [] }).records?.[0];

        // Map user dpaStatus to register AgreementStatus
        const agreementStatusMap = { yes: 'In place', no: 'Not yet', unsure: 'Unknown' };
        const dataProcessed = ui.dataTypes?.length
          ? JSON.stringify(ui.dataTypes)
          : null;

        const updateFields = Object.fromEntries(Object.entries({
          LastChecked:     today,
          Category:        result.vendorType || null,
          ComplianceScore: result.score ?? null,
          AgreementStatus: agreementStatusMap[ui.dpaStatus] || null,
          DataProcessed:   dataProcessed,
          ContactVolume:   ui.contactVolume || null,
        }).filter(([, v]) => v !== null && v !== undefined));

        if (existing) {
          await fetch(`${atBase}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: atH,
            body:    JSON.stringify({ fields: updateFields }),
          });
        } else {
          await fetch(`${atBase}/Vendor_Register`, {
            method:  'POST',
            headers: atH,
            body:    JSON.stringify({ records: [{ fields: {
              UserID: userId, VendorName: result.name, ...updateFields
            }}]}),
          });
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name}:`, e); }
    }

    // ── 5. Generate fix records ───────────────────────────────
    for (const result of results) {
      const fixes = buildFixesForResult(result, userId, sourceRecordId);
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

    // ── 6. Streak ─────────────────────────────────────────────
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
// v4.28: reads from result.userInput first (sent by frontend).
// Falls back to empty arrays — no longer reads Vendor_Register.
// The frontend now owns this data; register is updated from it.
// ─────────────────────────────────────────────────────────────
function buildProcessingContext(result) {
  const ui      = result.userInput || {};
  const d       = result.dimensions || {};

  const dataTypes    = Array.isArray(ui.dataTypes) ? ui.dataTypes : [];
  const contactVolume = ui.contactVolume || null;
  const dpaStatus    = ui.dpaStatus === 'yes' ? 'Confirmed'
                     : ui.dpaStatus === 'no'  ? 'Unknown'
                     : 'Unknown';
  const breach       = d.breachHistory || '';
  const breachKnown  = breach && !['none identified','none','no','unknown',''].includes(breach.toLowerCase());
  const hasDoc       = false; // user hasn't documented yet — defaults false on new scan

  return {
    vendorName:              result.name,
    dataTypes,
    contactVolume,
    vendorBreachHistory:     breachKnown ? breach : 'None identified',
    dpaStatus,
    hasDocumentedAssessment: hasDoc,
  };
}

// ─────────────────────────────────────────────────────────────
// buildFixesForResult
// v4.28: fix generation now driven by user-provided dpaStatus.
// 'yes' → no DPA fix; check breach + transfer only.
// 'no'/'unsure' → dpa_breach fix with severity based on data.
// ─────────────────────────────────────────────────────────────
function buildFixesForResult(result, userId, sourceRecordId) {
  const fixes = [];
  const name  = result.name;
  const d     = result.dimensions || {};
  const ui    = result.userInput || {};

  const userDPA        = ui.dpaStatus || 'unsure'; // yes / no / unsure
  const dataTypes      = Array.isArray(ui.dataTypes) ? ui.dataTypes : [];
  const volume         = ui.contactVolume || null;
  const transferOccurs = (d.intlTransferOccurs    || '').toLowerCase();
  const transferMech   = (d.internationalTransfer || '').toLowerCase();
  const icoStatus      = (d.icoRegistered         || '').toLowerCase();
  const breach         = (d.breachHistory         || '').trim();

  const breachIsKnown = breach &&
    !['none identified','none','no','unknown',''].includes(breach.toLowerCase());

  const hasSensitive = dataTypes.some(d =>
    /special category|behavioural|behaviour|purchase|financial/i.test(d));
  const highVolume   = volume && volume > 50000;

  const processingContext = buildProcessingContext(result);

  // ── DPA fix — driven by user's answer ─────────────────────
  if (userDPA === 'no' || userDPA === 'unsure') {
    const severity = (hasSensitive || highVolume) ? 'critical' : 'high';

    let description;
    if (userDPA === 'no') {
      const hint = d.dpaStatus === 'Confirmed' && d.dpaLink
        ? `${name}'s DPA is self-serve at ${d.dpaLink}`
        : d.dpaStatus === 'On Request'
        ? `Contact ${name} directly to obtain their DPA.`
        : `Contact ${name}'s privacy team to obtain a Data Processing Agreement.`;
      description = `Processor Risk Scanner: You confirmed you don't have a signed DPA with ${name}. UK GDPR Article 28 requires a written contract before sharing personal data with any processor. ${hint}`;
    } else {
      description = `Processor Risk Scanner: DPA status with ${name} is unconfirmed. UK GDPR Article 28 requires a written contract before sharing personal data. Check your files for a signed DPA — if you can't find one, treat it as not in place and request one now.`;
    }

    if (hasSensitive) {
      description += ` You're sharing sensitive data types (${dataTypes.filter(t => /behavioural|purchase|special/i.test(t)).join(', ')}) which increases the severity of this gap.`;
    }
    if (highVolume) {
      description += ` Volume of ${volume.toLocaleString()} contacts is a significant aggravating factor in ICO enforcement decisions.`;
    }

    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:       'dpa_breach',
      description,
      tool:          `Processor Risk Scanner \u2014 ${name}`,
      severity,
      contactVolume: volume,
    });
  }

  // ── ICO not registered — always flag regardless of DPA status
  if (icoStatus === 'no') {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Processor Risk Scanner: ${name} does not appear to be registered with the ICO. UK processors handling personal data must be registered. Verify at ico.org.uk/ESDWebPages/Search before sharing any contact data.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'critical',
      contactVolume: volume,
    });
  }

  // ── Breach history — flag if user has DPA but vendor has breach
  if (breachIsKnown) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'legitimate_interest_abuse',
      description: `Processor Risk Scanner: ${name} has a confirmed breach or enforcement history: ${breach.slice(0, 200)}. UK GDPR requires you to document your assessment of continued use of a processor with a known history. Without this documented assessment you're missing a key piece of due diligence that would protect you if the ICO investigated.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'medium',
      contactVolume: volume,
    });
  }

  // ── International transfer with no mechanism
  if (transferOccurs === 'yes' &&
      (transferMech === 'none' || transferMech === 'unknown' || transferMech === '')) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Processor Risk Scanner: ${name} transfers data internationally but no confirmed transfer mechanism (SCCs, Adequacy, UK-US Data Bridge) has been identified from their public pages. UK GDPR Chapter V requires a lawful transfer mechanism. Confirm this in your DPA or contact ${name} directly.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'medium',
      contactVolume: volume,
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
      details: [{ status: 'warning', label: 'Not in library',
        description: `${name} is not in the Sendwize vendor library. Assessment based on what you've provided.` }],
      actionItems: [
        'Confirm their ICO registration at ico.org.uk/ESDWebPages/Search',
        'Request their Data Processing Agreement and confirm the transfer mechanism',
      ],
      dimensions: {}
    };
  }

  const details = [];
  let   score   = 100;

  // ICO Registration
  const icoStatus = fields.ICORegistered || 'Unknown';
  if      (icoStatus === 'Yes')    { details.push({ status: 'pass', label: 'ICO Registration', description: `Registered with ICO${fields.ICORegNumber ? ` (${fields.ICORegNumber})` : ''}.` }); }
  else if (icoStatus === 'Exempt') { details.push({ status: 'info', label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies.' }); }
  else if (icoStatus === 'No')     { details.push({ status: 'fail', label: 'ICO Registration', description: 'Not found on ICO register. UK processors must register.' }); score -= 20; }
  else                             { details.push({ status: 'info', label: 'ICO Registration', description: 'ICO registration not confirmed — verify at ico.org.uk/ESDWebPages/Search.' }); score -= 5; }

  // DPA (library position — not user's signed status)
  const dpaStatus    = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Confirmed';
  const privacyUrl   = fields.PrivacyPolicyUrl || null;
  if      (dpaConfirmed)               { details.push({ status: 'pass',    label: 'DPA Available', description: `DPA publicly available${privacyUrl ? ` at ${privacyUrl}` : ''}.` }); }
  else if (dpaStatus === 'On Request') { details.push({ status: 'warning', label: 'DPA Available', description: 'DPA available on request — contact vendor directly.' }); score -= 15; }
  else if (dpaStatus === 'Refused')    { details.push({ status: 'fail',    label: 'DPA Available', description: 'Vendor has declined to sign a DPA.' }); score -= 35; }
  else                                 { details.push({ status: 'warning', label: 'DPA Available', description: 'DPA status not confirmed from public pages.' }); score -= 15; }

  // International Transfers
  const transferOccurs = fields.IntlTransferOccurs         || 'Unknown';
  const transferDest   = fields.TransferDestination        || '';
  const transferMech   = fields.TransferMechanismConfirmed || 'Unknown';
  if      (transferOccurs === 'No') { details.push({ status: 'pass', label: 'International Transfers', description: 'Processing confirmed as UK/EEA only.' }); }
  else if (['Adequacy','SCCs','BCRs','UK-US Bridge'].includes(transferMech)) { details.push({ status: 'pass', label: 'International Transfers', description: `Transfer mechanism: ${transferMech}${transferDest ? ` (${transferDest})` : ''}.` }); }
  else if (transferOccurs === 'Yes' && (transferMech === 'None' || transferMech === 'Unknown')) { details.push({ status: 'fail', label: 'International Transfers', description: `International transfer to ${transferDest || 'unknown destination'} — mechanism not confirmed from public pages.` }); score -= 20; }
  else { details.push({ status: 'info', label: 'International Transfers', description: 'Transfer status not confirmed from public pages.' }); score -= 5; }

  // Breach History
  const breachHistory = fields.BreachHistory || '';
  const breachIsKnown = breachHistory && !['none identified','none','no','unknown',''].includes(breachHistory.toLowerCase());
  if (!breachIsKnown) { details.push({ status: 'pass',    label: 'Breach History', description: 'No publicly known breaches or enforcement actions identified.' }); }
  else                { details.push({ status: 'warning', label: 'Breach History', description: breachHistory }); score -= 15; }

  // DPO
  const dpoStatus = fields.DPOConfirmed || 'Unknown';
  if (dpoStatus === 'Yes') details.push({ status: 'pass', label: 'DPO', description: 'Named DPO confirmed.' });
  else details.push({ status: 'info', label: 'DPO', description: 'DPO status not confirmed.' });

  // Security Cert
  const certStatus = fields.RelevantSecurityCertification || 'Unknown';
  if      (certStatus === 'Yes') { details.push({ status: 'pass', label: 'Security Certification', description: 'ISO 27001, SOC 2 or equivalent confirmed.' }); }
  else if (certStatus === 'No')  { details.push({ status: 'info', label: 'Security Certification', description: 'No certification identified — advisory only.' }); score -= 5; }
  else                           { details.push({ status: 'info', label: 'Security Certification', description: 'Certification status not confirmed.' }); }

  if (privacyUrl) details.push({ status: 'info', label: 'Privacy Policy / DPA', description: `Available at: ${privacyUrl}` });

  const riskRating = fields.RiskRating || calculateRiskRating({
    icoRegistered: icoStatus, dpaStatus, intlTransferOccurs: transferOccurs,
    internationalTransfer: transferMech, transferDestination: transferDest,
    breachHistory, dpoConfirmed: dpoStatus, relevantSecurityCertification: certStatus,
  });

  const actionItems = [];
  if (dpaStatus === 'On Request') actionItems.push(`Contact ${name} to obtain and sign their DPA`);
  if (dpaStatus === 'Refused')    actionItems.push(`Stop sharing personal data — find a compliant alternative`);
  if (transferOccurs === 'Yes' && transferMech === 'Unknown') actionItems.push('Confirm transfer mechanism in your DPA');
  if (icoStatus === 'Unknown')    actionItems.push('Verify ICO registration at ico.org.uk/ESDWebPages/Search');
  if (breachIsKnown)              actionItems.push('Document your assessment of continued use given breach history');
  if (privacyUrl)                 actionItems.push(`DPA / privacy policy: ${privacyUrl}`);
  if (fields.LastVerified)        actionItems.push(`Library data last reviewed: ${fields.LastVerified}`);

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
      details: [{ status: 'warning', label: 'Analysis incomplete',
        description: 'Unable to automatically assess this vendor. Please verify compliance manually.' }],
      actionItems: [
        'Confirm their ICO registration at ico.org.uk/ESDWebPages/Search',
        'Request their Data Processing Agreement',
        'Confirm data storage location and international transfer mechanism',
      ],
      dimensions: {},
    };
  }
}
