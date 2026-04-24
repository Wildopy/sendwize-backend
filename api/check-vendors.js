// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.25
// Seven-dimension processor audit.
// POST { vendors: [{ name, isCustom }], userId }
//
// For known vendors (isCustom=false): reads from Marketing_Vendors.
// For unknown vendors (isCustom=true): calls Claude AI and returns
//   a structured 7-dimension card — NOT freeform prose.
//
// Returns Low / Medium / High risk rating per vendor in addition
// to the 0-100 numeric score.
//
// v4.25 changes from v4.19:
//   - Airtable field names corrected to match live schema:
//       ICORegistered (was ICORegistrationStatus)
//       ICORegNumber  (was ICORegistrationNumber)
//       TransferMechanismConfirmed (was InternationalTransferMechanism)
//       BreachHistory (was KnownBreachHistory)
//       DPOConfirmed  (was DPOPresence)
//       RelevantSecurityCertification (was ISOAccreditation)
//       PrivacyPolicyUrl (replaces DPALink + PrivacyPolicyNotes)
//       IntlTransferOccurs + TransferDestination added
//   - riskRating (Low|Medium|High) added to every result
//   - AI fallback tightened: returns structured 7-dimension JSON card
//     with confidence caveat and plain-English next action
//   - Vendor_Register upsert now stores RiskRating
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

    if (!userId)                            return res.status(400).json({ error: 'Missing userId' });
    if (!vendors || !Array.isArray(vendors)) return res.status(400).json({ error: 'vendors array is required' });
    if (vendors.length === 0)               return res.status(400).json({ error: 'vendors array is empty' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── 1. Fetch known vendor library records in one call ─────────────
    const knownNames  = vendors.filter(v => !v.isCustom).map(v => v.name.toLowerCase());
    let vendorLibrary = {};

    if (knownNames.length > 0) {
      try {
        const formula = `OR(${knownNames.map(n => `LOWER({VendorName})='${n}'`).join(',')})`;
        const libRes  = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?filterByFormula=${encodeURIComponent(formula)}`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        if (libRes.ok) {
          for (const r of ((await libRes.json()).records || [])) {
            vendorLibrary[r.fields.VendorName?.toLowerCase()] = r.fields;
          }
        }
      } catch (e) { console.error('Marketing_Vendors fetch failed (non-fatal):', e); }
    }

    // ── 2. Analyse each vendor ────────────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      const result = vendor.isCustom
        ? await analyzeVendorWithAI(vendor.name)
        : handleKnownVendor(vendor.name, vendorLibrary[vendor.name.toLowerCase()] || null);
      results.push(result);
    }

    // ── 3. Save to Vendor_Checks ──────────────────────────────────────
    let sourceRecordId = null;
    try {
      const avgScore = results.length > 0
        ? Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length)
        : 0;

      const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Checks`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
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

    // ── 4. Upsert Vendor_Register ─────────────────────────────────────
    // Only updates LastChecked, VendorType, RiskRating.
    // Never overwrites user-managed fields: DPASigned, DPALink, Notes.
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const existingRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register?filterByFormula=AND({UserID}='${userId}',{VendorName}='${result.name}')&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const existing = (existingRes.ok ? await existingRes.json() : { records: [] }).records?.[0];

        if (existing) {
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fields: { LastChecked: today, VendorType: result.vendorType || '', RiskRating: result.riskRating || '' } })
          });
        } else {
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ records: [{ fields: {
              UserID: userId, VendorName: result.name,
              VendorType: result.vendorType || '', LastChecked: today, RiskRating: result.riskRating || '',
            }}]})
          });
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name} (non-fatal):`, e); }
    }

    // ── 5. Generate fix records for no_dpa ───────────────────────────
    for (const result of results) {
      if (!result.dpaConfirmed) {
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId,
              fixType:        'no_dpa',
              description:    `Vendor Checker: No confirmed Data Processing Agreement for ${result.name}. UK GDPR Article 28 requires a written DPA before sharing personal data with any processor.`,
              tool:           'Vendor Checker',
              severity:       'high',
              volume:         null,
              sourceRecordId,
            })
          });
        } catch (e) { console.error(`generate-fix no_dpa failed for ${result.name}:`, e); }
      }
    }

    // ── 6. Streak call ────────────────────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    return res.status(200).json({ results });

  } catch (error) {
    console.error('check-vendors error:', error);
    return res.status(500).json({ error: 'Vendor check failed' });
  }
}

// ─────────────────────────────────────────────────────────────
// calculateRiskRating
// Applies the Low / Medium / High logic from the spec.
// HIGH — any single one of these:
//   - ICO not registered (and not exempt)
//   - Known breach or enforcement action
//   - International transfer with no mechanism and non-adequate destination
//   - DPA refused or vendor will not sign
// MEDIUM — none of the above, but one or more of:
//   - DPA status On Request / Unknown
//   - Transfer mechanism not publicly confirmed
//   - No ISO 27001 / SOC 2 / equivalent
//   - No named DPO
// LOW — all clear
// ─────────────────────────────────────────────────────────────
function calculateRiskRating(d) {
  const ico      = (d.icoRegistration  || '').toLowerCase();
  const dpa      = (d.dpaStatus        || '').toLowerCase();
  const transfer = (d.transferMechanism || d.internationalTransfer || '').toLowerCase();
  const breach   = (d.breachHistory    || '').toLowerCase();
  const dest     = (d.transferDestination || '').toLowerCase();
  const cert     = (d.relevantSecurityCertification || d.isoAccreditation || '').toLowerCase();
  const dpo      = (d.dpoConfirmed     || d.dpoPresence || '').toLowerCase();

  // HIGH triggers
  if (ico.includes('not found') || ico.includes('no'))                         return 'High';
  if (breach && breach !== 'none identified' && breach !== '' && breach !== 'unknown') return 'High';
  const nonAdequateDest = dest && !dest.includes('eu') && !dest.includes('eea') && !dest.includes('uk') && !dest.includes('n/a');
  const noMechanism     = transfer.includes('none') || transfer.includes('unknown');
  if (nonAdequateDest && noMechanism)                                           return 'High';
  if (dpa.includes('refused'))                                                  return 'High';

  // MEDIUM triggers
  if (dpa.includes('on request') || dpa.includes('unknown') || dpa.includes('not available')) return 'Medium';
  if (transfer.includes('unknown') || transfer.includes('none identified'))     return 'Medium';
  if (!cert || cert.includes('none') || cert.includes('unknown'))               return 'Medium';
  if (!dpo || dpo.includes('none') || dpo.includes('unknown'))                  return 'Medium';

  return 'Low';
}

// ─────────────────────────────────────────────────────────────
// handleKnownVendor
// Reads 7-dimension fields from Marketing_Vendors.
// Field names match live Airtable schema (v4.25):
//   VendorName, VendorType
//   ICORegistered, ICORegNumber
//   DPAStatus, PrivacyPolicyUrl
//   IntlTransferOccurs, TransferDestination, TransferMechanismConfirmed
//   BreachHistory
//   DPOConfirmed
//   RelevantSecurityCertification
//   RiskRating, LastVerified
// ─────────────────────────────────────────────────────────────
function handleKnownVendor(name, fields) {
  if (!fields) {
    return {
      name,
      score:        50,
      riskRating:   'Medium',
      isAI:         false,
      dpaConfirmed: false,
      vendorType:   '',
      details: [{
        status:      'warning',
        label:       'Not in vendor library',
        description: `${name} is not yet in the Sendwize vendor library. Check their website for a DPA and complete a manual review.`,
      }],
      actionItems: [
        'Search for their Data Processing Agreement or Privacy Policy',
        'Check ICO register: https://ico.org.uk/ESDWebPages/Search',
        'Confirm data storage location and international transfer mechanism',
      ],
      dimensions: {}
    };
  }

  const details    = [];
  let   score      = 100;

  // ── Dimension 1 — ICO Registration ───────────────────────────────
  const icoStatus = fields.ICORegistered || 'Unknown';
  if (icoStatus === 'Yes') {
    details.push({ status: 'pass',    label: 'ICO Registration', description: `Registered with ICO${fields.ICORegNumber ? ` (${fields.ICORegNumber})` : ''}.` });
  } else if (icoStatus === 'Exempt') {
    details.push({ status: 'info',    label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies to their UK processing activities.' });
  } else if (icoStatus === 'No') {
    details.push({ status: 'fail',    label: 'ICO Registration', description: 'Not found on ICO register. UK processors handling personal data are generally required to register.' });
    score -= 20;
  } else {
    details.push({ status: 'info',    label: 'ICO Registration', description: 'ICO registration status not confirmed — verify at ico.org.uk/ESDWebPages/Search.' });
  }

  // ── Dimension 2 — DPA ─────────────────────────────────────────────
  const dpaStatus    = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Confirmed';
  const privacyUrl   = fields.PrivacyPolicyUrl || null;

  if (dpaConfirmed) {
    details.push({ status: 'pass',    label: 'Data Processing Agreement', description: `DPA confirmed${privacyUrl ? ` — ${privacyUrl}` : ''}.` });
  } else if (dpaStatus === 'On Request') {
    details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA available on request — contact vendor to obtain and sign before sharing personal data.' });
    score -= 15;
  } else if (dpaStatus === 'Refused') {
    details.push({ status: 'fail',    label: 'Data Processing Agreement', description: 'Vendor has declined to sign a DPA. Transferring personal data to them is a UK GDPR Article 28 breach.' });
    score -= 35;
  } else {
    details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA status not confirmed — contact vendor before sharing personal data.' });
    score -= 15;
  }

  // ── Dimension 3 — International Transfers ────────────────────────
  const transferOccurs = fields.IntlTransferOccurs       || 'Unknown';
  const transferDest   = fields.TransferDestination      || '';
  const transferMech   = fields.TransferMechanismConfirmed || 'Unknown';

  if (transferOccurs === 'No') {
    details.push({ status: 'pass',    label: 'International Transfers', description: 'Processing confirmed as UK/EEA only — no international transfer mechanism required.' });
  } else if (transferMech === 'Adequacy' || transferMech === 'SCCs' || transferMech === 'BCRs' || transferMech === 'UK-US Bridge') {
    details.push({ status: 'pass',    label: 'International Transfers', description: `Transfer mechanism confirmed: ${transferMech}${transferDest ? ` (${transferDest})` : ''}.` });
  } else if (transferOccurs === 'Yes' && (transferMech === 'None' || transferMech === 'Unknown')) {
    details.push({ status: 'fail',    label: 'International Transfers', description: `International transfer to ${transferDest || 'unknown destination'} with no confirmed mechanism — requires SCCs or adequacy basis.` });
    score -= 20;
  } else {
    details.push({ status: 'info',    label: 'International Transfers', description: 'International transfer status not confirmed — verify if data leaves UK/EEA.' });
  }

  // ── Dimension 4 — Breach History ─────────────────────────────────
  const breachHistory = fields.BreachHistory || '';
  if (!breachHistory || breachHistory.toLowerCase() === 'none' || breachHistory.toLowerCase() === 'none identified') {
    details.push({ status: 'pass',    label: 'Breach History', description: 'No publicly known significant breaches or enforcement actions identified.' });
  } else {
    details.push({ status: 'warning', label: 'Breach History', description: breachHistory });
    score -= 15;
  }

  // ── Dimension 5 — DPO ────────────────────────────────────────────
  const dpoConfirmed = fields.DPOConfirmed || 'Unknown';
  if (dpoConfirmed === 'Yes') {
    details.push({ status: 'pass',    label: 'DPO / Controller Representative', description: 'Named DPO or controller representative confirmed.' });
  } else if (dpoConfirmed === 'No') {
    details.push({ status: 'info',    label: 'DPO / Controller Representative', description: 'No named DPO identified — advisory only for most processors.' });
  } else {
    details.push({ status: 'info',    label: 'DPO / Controller Representative', description: 'DPO status not confirmed.' });
  }

  // ── Dimension 6 — Security Certification ─────────────────────────
  const certStatus = fields.RelevantSecurityCertification || 'Unknown';
  if (certStatus && certStatus !== 'Unknown' && certStatus !== 'None identified') {
    details.push({ status: 'pass',    label: 'Security Certification', description: certStatus });
  } else if (certStatus === 'None identified') {
    details.push({ status: 'info',    label: 'Security Certification', description: 'No ISO 27001, SOC 2 or equivalent identified — advisory only.' });
    score -= 5;
  } else {
    details.push({ status: 'info',    label: 'Security Certification', description: 'Security certification not confirmed.' });
  }

  // ── Dimension 7 — Privacy Policy ─────────────────────────────────
  if (privacyUrl) {
    details.push({ status: 'info',    label: 'Privacy Policy', description: `Privacy policy / DPA available at: ${privacyUrl}` });
  }

  // ── Risk rating ───────────────────────────────────────────────────
  const dimensionsForRating = {
    icoRegistration:   icoStatus,
    dpaStatus,
    transferMechanism: transferMech,
    transferDestination: transferDest,
    breachHistory,
    dpoConfirmed,
    relevantSecurityCertification: certStatus,
  };
  const riskRating = fields.RiskRating || calculateRiskRating(dimensionsForRating);

  // ── Action items ──────────────────────────────────────────────────
  const actionItems = [];
  if (!dpaConfirmed)                                                     actionItems.push('Obtain and sign a Data Processing Agreement with this vendor');
  if (transferOccurs === 'Yes' && transferMech === 'Unknown')            actionItems.push('Confirm which international transfer mechanism applies');
  if (fields.LastVerified)                                               actionItems.push(`Library data last verified: ${fields.LastVerified} — re-verify if older than 12 months`);
  if (privacyUrl)                                                        actionItems.push(`Review privacy policy / DPA at: ${privacyUrl}`);
  if (icoStatus === 'Unknown')                                           actionItems.push('Verify ICO registration at: https://ico.org.uk/ESDWebPages/Search');

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
      icoRegistration:              icoStatus,
      icoRegNumber:                 fields.ICORegNumber || null,
      dpaStatus,
      dpaLink:                      privacyUrl,
      intlTransferOccurs:           transferOccurs,
      transferDestination:          transferDest,
      internationalTransfer:        transferMech,
      breachHistory:                breachHistory || 'None identified',
      dpoPresence:                  dpoConfirmed,
      isoAccreditation:             certStatus,
      lastVerified:                 fields.LastVerified || null,
    }
  };
}

// ─────────────────────────────────────────────────────────────
// analyzeVendorWithAI
// Called for vendors not in Marketing_Vendors.
// Returns a structured 7-dimension card — NOT freeform prose.
// The card is the value over asking ChatGPT directly:
// structured, opinionated, confidence-caveated, fix-record-linked.
// ─────────────────────────────────────────────────────────────
async function analyzeVendorWithAI(vendorName) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a UK GDPR compliance researcher. A UK marketing team is using "${vendorName}" as a data processor.

Assess this vendor across exactly seven compliance dimensions using only publicly verifiable information. Do not invent or assume facts.

Respond ONLY with this exact JSON structure — no markdown fences, no preamble, no explanation outside the JSON:

{
  "score": <integer 0-100>,
  "riskRating": "<Low|Medium|High>",
  "vendorType": "<Self-serve ESP|Third-party agency|CRM|Analytics|CDP|Advertising|Other>",
  "dpaConfirmed": <true|false>,
  "dimensions": {
    "icoRegistration": "<Yes|No|Exempt|Unknown>",
    "icoRegNumber": "<registration number or null>",
    "dpaStatus": "<Confirmed|On Request|Refused|Unknown>",
    "dpaLink": "<URL to DPA or privacy policy or null>",
    "intlTransferOccurs": "<Yes|No|Unknown>",
    "transferDestination": "<EU/EEA|US|India|Other|N/A|Unknown>",
    "internationalTransfer": "<Adequacy|SCCs|BCRs|UK-US Bridge|None|Unknown>",
    "breachHistory": "<factual note on any known breaches or enforcement, or 'None identified'>",
    "dpoPresence": "<Yes|No|Unknown>",
    "isoAccreditation": "<ISO 27001|SOC 2|Cyber Essentials Plus|Other|None identified|Unknown>",
    "privacyPolicyNotes": "<key observation about their privacy policy or empty string>"
  },
  "details": [
    {"status": "<pass|warning|info|fail>", "label": "<dimension name>", "description": "<plain English finding, one sentence>"}
  ],
  "actionItems": ["<specific action the user should take>"],
  "confidenceCaveat": "This assessment is based on publicly available information only. Verify directly with the vendor before transferring customer data."
}

Risk rating rules — apply these exactly:
- High: ICO not registered OR known breach/enforcement action OR international transfer with no mechanism to non-adequate country OR DPA refused
- Medium: DPA On Request or Unknown OR transfer mechanism not confirmed OR no security certification OR no named DPO
- Low: ICO registered, DPA confirmed, transfer mechanism confirmed or UK-only, no known breach

If you cannot verify a dimension, use Unknown — do not guess.`
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);

    const data     = await response.json();
    const text     = data.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);

    const d = analysis.dimensions || {};

    return {
      name:             vendorName,
      vendorType:       analysis.vendorType    || 'Marketing Tool',
      score:            analysis.score         || 50,
      riskRating:       analysis.riskRating    || calculateRiskRating(d),
      isAI:             true,
      dpaConfirmed:     analysis.dpaConfirmed  || false,
      details:          analysis.details       || [],
      actionItems:      analysis.actionItems   || [],
      confidenceCaveat: analysis.confidenceCaveat || 'This assessment is based on publicly available information. Verify directly with the vendor before transferring customer data.',
      dimensions: {
        icoRegistration:    d.icoRegistration   || 'Unknown',
        icoRegNumber:       d.icoRegNumber      || null,
        dpaStatus:          d.dpaStatus         || 'Unknown',
        dpaLink:            d.dpaLink           || null,
        intlTransferOccurs: d.intlTransferOccurs || 'Unknown',
        transferDestination:d.transferDestination || 'Unknown',
        internationalTransfer: d.internationalTransfer || 'Unknown',
        breachHistory:      d.breachHistory     || 'Unknown',
        dpoPresence:        d.dpoPresence       || 'Unknown',
        isoAccreditation:   d.isoAccreditation  || 'Unknown',
        lastVerified:       null,
      }
    };

  } catch (error) {
    console.error(`AI vendor analysis failed for ${vendorName}:`, error);
    return {
      name:         vendorName,
      vendorType:   'Unknown',
      score:        50,
      riskRating:   'Medium',
      isAI:         true,
      dpaConfirmed: false,
      confidenceCaveat: 'Automated analysis failed. Please verify this vendor manually.',
      details: [{ status: 'warning', label: 'Analysis incomplete', description: 'Unable to automatically analyse this vendor. Please verify compliance manually.' }],
      actionItems: [
        'Contact vendor for their Data Processing Agreement',
        'Check ICO register: https://ico.org.uk/ESDWebPages/Search',
        'Confirm data storage location and any international transfer mechanism',
      ],
      dimensions: {},
    };
  }
}
