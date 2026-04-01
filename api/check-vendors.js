// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.19
// Seven-dimension processor audit per spec 9.11 / 8.8.
// POST { vendors: [{ name, isCustom }], userId }
//
// For known vendors (isCustom=false): reads from Marketing_Vendors
//   using 7-dimension fields (after Airtable migration).
// For unknown vendors (isCustom=true): calls Claude to analyse.
//
// Writes summary to Vendor_Checks.
// Fires generate-fix for no_dpa violations.
// Fires streak call on completion.
//
// ⚠ ACTION REQUIRED: Marketing_Vendors fields must be migrated
//   from old schema (Category, ComplianceScore, etc) to 7-dimension
//   schema (ICORegistrationStatus, DPAStatus, etc) before the
//   handleKnownVendor function returns correct data.
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

    if (!userId)                                   return res.status(400).json({ error: 'Missing userId' });
    if (!vendors || !Array.isArray(vendors))        return res.status(400).json({ error: 'vendors array is required' });
    if (vendors.length === 0)                       return res.status(400).json({ error: 'vendors array is empty' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── 1. Fetch known vendor library records in one call ─────────────
    // Reads Marketing_Vendors for any non-custom vendors by name.
    const customNames  = vendors.filter(v => !v.isCustom).map(v => v.name.toLowerCase());
    let vendorLibrary  = {};

    if (customNames.length > 0) {
      try {
        const formula    = `OR(${customNames.map(n => `LOWER({VendorName})='${n}'`).join(',')})`;
        const libRes     = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?filterByFormula=${encodeURIComponent(formula)}`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        if (libRes.ok) {
          const libData  = await libRes.json();
          for (const r of (libData.records || [])) {
            vendorLibrary[r.fields.VendorName?.toLowerCase()] = r.fields;
          }
        }
      } catch (e) { console.error('Marketing_Vendors fetch failed (non-fatal):', e); }
    }

    // ── 2. Analyse each vendor ────────────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      if (vendor.isCustom) {
        results.push(await analyzeVendorWithAI(vendor.name));
      } else {
        const libraryFields = vendorLibrary[vendor.name.toLowerCase()] || null;
        results.push(handleKnownVendor(vendor.name, libraryFields));
      }
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
        body: JSON.stringify({
          records: [{ fields: {
            UserID:         userId,
            CheckDate:      new Date().toISOString().split('T')[0],
            VendorsChecked: vendors.map(v => v.name).join(', '),
            VendorCount:    vendors.length,
            AverageScore:   avgScore,
            Results:        JSON.stringify(results),
          }}]
        })
      });

      if (saveRes.ok) {
        sourceRecordId = (await saveRes.json()).records?.[0]?.id ?? null;
      } else {
        console.error('Vendor_Checks save failed:', saveRes.status);
      }
    } catch (e) { console.error('Vendor_Checks save error:', e); }

    // ── 4. Upsert Vendor_Register — user-managed fields only ─────────
    // Vendor_Register stores what the USER manages: VendorName, VendorType,
    // DPASigned, DPALink, LastChecked, Notes.
    // The 7-dimension research data lives in Marketing_Vendors only
    // and is read at query time — not duplicated per user.
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const existingRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register?filterByFormula=AND({UserID}='${userId}',{VendorName}='${result.name}')&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const existingData = existingRes.ok ? await existingRes.json() : { records: [] };
        const existing     = existingData.records?.[0];

        if (existing) {
          // Only update LastChecked and VendorType — never overwrite user's DPASigned/DPALink/Notes
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fields: { LastChecked: today, VendorType: result.vendorType || '' } })
          });
        } else {
          // First time this vendor has been checked — create a minimal record
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ records: [{ fields: {
              UserID:      userId,
              VendorName:  result.name,
              VendorType:  result.vendorType || '',
              LastChecked: today,
            }}]})
          });
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name} (non-fatal):`, e); }
    }

    // ── 5. Generate fix records ───────────────────────────────────────
    // no_dpa: fired when Marketing_Vendors library shows DPA not available
    // or vendor not in library. User can resolve by adding DPASigned to
    // their Vendor_Register via the vendor-checker UI.
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

    // ── 5. Streak call ────────────────────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    return res.status(200).json({ results });

  } catch (error) {
    console.error('check-vendors error:', error);
    return res.status(500).json({ error: 'Vendor check failed' });
  }
}

// ─────────────────────────────────────────────────────────────
// handleKnownVendor
// Reads 7-dimension fields from Marketing_Vendors library record.
// Fields expected after Airtable migration:
//   VendorName, VendorType, ICORegistrationStatus, ICORegistrationNumber,
//   DPAStatus, DPALink, InternationalTransferMechanism, KnownBreachHistory,
//   DPOPresence, ISOAccreditation, PrivacyPolicyNotes, LastVerified
// ─────────────────────────────────────────────────────────────
function handleKnownVendor(name, fields) {
  if (!fields) {
    // Vendor not in library — return advisory to check manually
    return {
      name,
      score:        50,
      isAI:         false,
      dpaConfirmed: false,
      details: [{
        status:      'warning',
        label:       'Not in vendor library',
        description: `${name} is not in the Sendwize vendor library. Check their website for a DPA and complete a manual review.`,
      }],
      actionItems: [
        'Search for their Data Processing Agreement or Privacy Policy',
        'Check ICO register: https://ico.org.uk/ESDWebPages/Search',
        'Confirm data storage location and international transfer mechanism',
      ],
      dimensions: {}
    };
  }

  const details     = [];
  let   score       = 100;
  const dpaStatus   = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Available';

  // Dimension 1 — ICO Registration
  const icoStatus = fields.ICORegistrationStatus || 'Unknown';
  if (icoStatus === 'Registered') {
    details.push({ status: 'pass',    label: 'ICO Registration', description: `Registered with ICO${fields.ICORegistrationNumber ? ` (${fields.ICORegistrationNumber})` : ''}.` });
  } else if (icoStatus === 'Exempt') {
    details.push({ status: 'info',    label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies.' });
  } else if (icoStatus === 'Not found') {
    details.push({ status: 'warning', label: 'ICO Registration', description: 'Not found on ICO register. Absence may not indicate breach — some processors are exempt.' });
    score -= 10;
  } else {
    details.push({ status: 'info',    label: 'ICO Registration', description: 'ICO registration status unknown — verify manually.' });
  }

  // Dimension 2 — DPA
  if (dpaConfirmed) {
    details.push({ status: 'pass',    label: 'Data Processing Agreement', description: `DPA available${fields.DPALink ? ` — ${fields.DPALink}` : ''}.` });
  } else if (dpaStatus === 'Not available') {
    details.push({ status: 'fail',    label: 'Data Processing Agreement', description: 'DPA not publicly available. Contact vendor to obtain one before sharing personal data.' });
    score -= 30;
  } else {
    details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA status unknown — contact vendor to confirm.' });
    score -= 15;
  }

  // Dimension 3 — International Transfer
  const transferMech = fields.InternationalTransferMechanism || 'Unknown';
  if (transferMech === 'SCCs' || transferMech === 'Adequacy decision') {
    details.push({ status: 'pass',    label: 'International Transfers', description: `Transfer mechanism: ${transferMech}.` });
  } else if (transferMech === 'None identified') {
    details.push({ status: 'warning', label: 'International Transfers', description: 'No transfer mechanism identified. If data is transferred outside UK/EEA, a mechanism is required.' });
    score -= 10;
  } else {
    details.push({ status: 'info',    label: 'International Transfers', description: 'International transfer mechanism not confirmed — verify if data leaves UK/EEA.' });
  }

  // Dimension 4 — Breach History
  const breachHistory = fields.KnownBreachHistory || '';
  if (breachHistory && breachHistory.toLowerCase() !== 'none') {
    details.push({ status: 'warning', label: 'Known Breach History', description: breachHistory });
    score -= 15;
  } else {
    details.push({ status: 'pass',    label: 'Known Breach History', description: 'No publicly known significant breaches identified.' });
  }

  // Dimension 5 — DPO / Controller Rep
  const dpoPresence = fields.DPOPresence || 'Unknown';
  if (dpoPresence === 'Named DPO' || dpoPresence === 'Controller rep') {
    details.push({ status: 'pass',    label: 'DPO / Controller Representative', description: dpoPresence });
  } else if (dpoPresence === 'None identified') {
    details.push({ status: 'info',    label: 'DPO / Controller Representative', description: 'No named DPO or controller rep identified — advisory only.' });
  } else {
    details.push({ status: 'info',    label: 'DPO / Controller Representative', description: 'DPO presence not confirmed.' });
  }

  // Dimension 6 — ISO / Accreditation
  const isoStatus = fields.ISOAccreditation || 'Unknown';
  if (isoStatus === 'ISO 27001' || isoStatus === 'SOC 2') {
    details.push({ status: 'pass',    label: 'Security Accreditation', description: isoStatus });
  } else if (isoStatus === 'Other') {
    details.push({ status: 'info',    label: 'Security Accreditation', description: 'Other accreditation held — verify details.' });
  } else if (isoStatus === 'None identified') {
    details.push({ status: 'info',    label: 'Security Accreditation', description: 'No ISO 27001 or SOC 2 identified — advisory only.' });
    score -= 5;
  }

  // Dimension 7 — Privacy Policy
  const privacyNotes = fields.PrivacyPolicyNotes || '';
  if (privacyNotes) {
    details.push({ status: 'info',    label: 'Privacy Policy Notes', description: privacyNotes });
  }

  const actionItems = [];
  if (!dpaConfirmed)                  actionItems.push('Obtain and sign a Data Processing Agreement with this vendor');
  if (transferMech === 'Unknown')     actionItems.push('Confirm whether data is transferred outside UK/EEA and if so, which mechanism applies');
  if (fields.DPALink)                 actionItems.push(`Review DPA at: ${fields.DPALink}`);
  if (fields.LastVerified)            actionItems.push(`Library data last verified: ${fields.LastVerified} — verify if significantly older than 12 months`);

  return {
    name,
    vendorType:   fields.VendorType  || '',
    score:        Math.max(0, score),
    isAI:         false,
    dpaConfirmed,
    details,
    actionItems,
    dimensions: {
      icoRegistration:    icoStatus,
      dpaStatus,
      dpaLink:            fields.DPALink || null,
      internationalTransfer: transferMech,
      breachHistory:      breachHistory || 'None identified',
      dpoPresence,
      isoAccreditation:   isoStatus,
      lastVerified:       fields.LastVerified || null,
    }
  };
}

// ─────────────────────────────────────────────────────────────
// analyzeVendorWithAI
// Called for vendors not in the Marketing_Vendors library.
// Asks Claude to assess all seven dimensions.
// ─────────────────────────────────────────────────────────────
async function analyzeVendorWithAI(vendorName) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `You are a UK GDPR compliance researcher. Assess "${vendorName}" across seven compliance dimensions for a UK marketing team using them as a data processor.

Respond ONLY with this exact JSON (no markdown, no preamble):
{
  "score": <0-100>,
  "vendorType": "<ESP|CRM|Analytics|CDP|Advertising|Other>",
  "dpaConfirmed": <true|false>,
  "dpaLink": "<URL or null>",
  "dimensions": {
    "icoRegistration": "<Registered|Not found|Exempt|Unknown>",
    "dpaStatus": "<Available|Not available|Unknown>",
    "internationalTransfer": "<SCCs|Adequacy decision|None identified|Unknown>",
    "breachHistory": "<brief factual note or 'None identified'>",
    "dpoPresence": "<Named DPO|Controller rep|None identified|Unknown>",
    "isoAccreditation": "<ISO 27001|SOC 2|Other|None identified|Unknown>",
    "privacyPolicyNotes": "<key observations or empty string>"
  },
  "details": [
    {"status": "pass|warning|info|fail", "label": "<dimension name>", "description": "<plain English finding>"}
  ],
  "actionItems": ["<specific action>"]
}

Be factual. Only state what you can verify from publicly available information. If uncertain on any dimension, use "Unknown". Do not fabricate findings.` }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);

    const data     = await response.json();
    const text     = data.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);

    return {
      name:         vendorName,
      vendorType:   analysis.vendorType   || 'Marketing Tool',
      score:        analysis.score        || 50,
      isAI:         true,
      dpaConfirmed: analysis.dpaConfirmed || false,
      details:      analysis.details      || [],
      actionItems:  analysis.actionItems  || [],
      dimensions:   analysis.dimensions   || {},
    };

  } catch (error) {
    console.error(`AI vendor analysis failed for ${vendorName}:`, error);
    return {
      name:         vendorName,
      vendorType:   'Unknown',
      score:        50,
      isAI:         true,
      dpaConfirmed: false,
      details: [{ status: 'warning', label: 'Analysis incomplete', description: 'Unable to automatically analyse this vendor. Please verify compliance manually.' }],
      actionItems: ['Contact vendor for Data Processing Agreement', 'Check ICO register: https://ico.org.uk/ESDWebPages/Search', 'Confirm data storage location'],
      dimensions: {},
    };
  }
}
