// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.26
// POST { vendors: [{ name, isCustom }], userId }
//
// v4.26 changes from v4.25:
//   - Fix generation expanded: was no_dpa only. Now generates:
//       dpa_breach (critical) — ICO not registered
//       dpa_breach (high)     — no DPA confirmed
//       dpa_breach (critical) — DPA refused
//       dpa_breach (high)     — score < 60 (multiple medium issues)
//       dpa_breach (medium)   — intl transfer with no mechanism
//       legitimate_interest_abuse (medium) — breach history present
//   - All fix types use canonical names directly (no legacy 'no_dpa')
//   - Fix generation deduplicated — one fix per issue per vendor
//   - sourceRecordId passed to all fix records
//   - IntlTransferOccurs read as distinct field (was missing in v4.25)
//   - BreachHistory read as Long text (schema updated from Single select)
//   - ComplianceScore now written to Vendor_Register on every check
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

    // ── 1. Fetch known vendor library records ─────────────────
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

    // ── 2. Analyse each vendor ────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      const result = vendor.isCustom
        ? await analyzeVendorWithAI(vendor.name)
        : handleKnownVendor(vendor.name, vendorLibrary[vendor.name.toLowerCase()] || null);
      results.push(result);
    }

    // ── 3. Save to Vendor_Checks ──────────────────────────────
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

    // ── 4. Upsert Vendor_Register ─────────────────────────────
    // Only updates operational fields — never overwrites user-managed fields
    // (DPASigned, AgreementLink, Notes) set via the register tab.
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const existingRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register` +
          `?filterByFormula=AND({UserID}='${userId}',{VendorName}='${result.name}')&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const existing = (existingRes.ok ? await existingRes.json() : { records: [] }).records?.[0];
        const updateFields = Object.fromEntries(Object.entries({
          LastChecked:     today,
          VendorType:      result.vendorType || null,
          RiskRating:      result.riskRating || null,
          ComplianceScore: result.score ?? null,
        }).filter(([, v]) => v !== null && v !== undefined));

        if (existing) {
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fields: updateFields }),
          });
        } else {
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Register`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ records: [{ fields: { UserID: userId, VendorName: result.name, ...updateFields } }] }),
          });
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name} (non-fatal):`, e); }
    }

    // ── 5. Generate fix records ───────────────────────────────
    // v4.26: expanded. All canonical fix types. Deduplicated per vendor.
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
// buildFixesForResult
// Returns array of fix payloads for generate-fix.js.
// Canonical fix types only. Deduplication: only one top-level
// dpa_breach per vendor (most severe wins), breach history always
// gets its own separate fix.
// ─────────────────────────────────────────────────────────────
function buildFixesForResult(result, userId, sourceRecordId) {
  const fixes = [];
  const name  = result.name;
  const d     = result.dimensions || {};
  let   dpaBreach = false;

  const icoStatus  = (d.icoRegistered || '').toLowerCase();
  const dpaStatus  = (d.dpaStatus     || '').toLowerCase();
  const transferOccurs = (d.intlTransferOccurs       || '').toLowerCase();
  const transferMech   = (d.internationalTransfer    || '').toLowerCase();
  const breach         = (d.breachHistory            || '').trim();

  const breachIsKnown = breach &&
    !['none identified','none','no','unknown',''].includes(breach.toLowerCase());

  // ICO not registered — critical
  if (icoStatus === 'no' || icoStatus === 'not found') {
    fixes.push({
      userId, sourceRecordId,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} does not appear to be registered with the ICO. UK processors handling personal data must register. Verify at ico.org.uk/ESDWebPages/Search before sharing any contact data.`,
      tool:        'Vendor Checker',
      severity:    'critical',
      contactVolume: null,
    });
    dpaBreach = true;
  }

  // DPA refused — critical
  if (dpaStatus === 'refused') {
    fixes.push({
      userId, sourceRecordId,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} has refused to sign a Data Processing Agreement. Transferring personal data to them is a UK GDPR Article 28 breach. Stop sharing personal data with this vendor immediately.`,
      tool:        'Vendor Checker',
      severity:    'critical',
      contactVolume: null,
    });
    dpaBreach = true;
  }

  // No DPA confirmed — high
  if (!result.dpaConfirmed && !dpaBreach) {
    const hint = dpaStatus === 'on request'
      ? `Contact ${name} to obtain and sign their DPA.`
      : `Check their website for a DPA or contact their privacy team.`;
    fixes.push({
      userId, sourceRecordId,
      fixType:     'dpa_breach',
      description: `Vendor Checker: No confirmed Data Processing Agreement for ${name}. UK GDPR Article 28 requires a written DPA before sharing personal data with any processor. ${hint}`,
      tool:        'Vendor Checker',
      severity:    'high',
      contactVolume: null,
    });
    dpaBreach = true;
  }

  // Score < 60 — high (only if no specific fix already generated)
  if (!dpaBreach && (result.score || 0) < 60) {
    fixes.push({
      userId, sourceRecordId,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} scored ${result.score}/100 — multiple compliance gaps identified. Review the vendor card for specific issues and contact ${name} to address them.`,
      tool:        'Vendor Checker',
      severity:    'high',
      contactVolume: null,
    });
  }

  // International transfer with no mechanism — medium (independent fix)
  if (transferOccurs === 'yes' && (transferMech === 'none' || transferMech === 'unknown' || transferMech === '')) {
    fixes.push({
      userId, sourceRecordId,
      fixType:     'dpa_breach',
      description: `Vendor Checker: ${name} transfers data internationally but no confirmed transfer mechanism (SCCs, Adequacy, UK-US Data Bridge) has been identified. UK GDPR Chapter V requires a lawful transfer mechanism. Contact ${name} to confirm their transfer basis.`,
      tool:        'Vendor Checker',
      severity:    'medium',
      contactVolume: null,
    });
  }

  // Breach history — medium (always its own fix)
  if (breachIsKnown) {
    fixes.push({
      userId, sourceRecordId,
      fixType:     'legitimate_interest_abuse',
      description: `Vendor Checker: ${name} has a known breach or enforcement history: ${breach.slice(0, 200)}. UK GDPR requires you to assess whether continued use of this vendor is proportionate. Document your assessment and consider whether a DPIA is required.`,
      tool:        'Vendor Checker',
      severity:    'medium',
      contactVolume: null,
    });
  }

  return fixes;
}

// ─────────────────────────────────────────────────────────────
// calculateRiskRating
// ─────────────────────────────────────────────────────────────
function calculateRiskRating(d) {
  const ico    = (d.icoRegistered               || '').toLowerCase();
  const dpa    = (d.dpaStatus                   || '').toLowerCase();
  const mech   = (d.internationalTransfer       || d.transferMechanismConfirmed || '').toLowerCase();
  const breach = (d.breachHistory               || '').toLowerCase();
  const dest   = (d.transferDestination         || '').toLowerCase();
  const cert   = (d.relevantSecurityCertification || '').toLowerCase();
  const dpo    = (d.dpoConfirmed                || '').toLowerCase();
  const intl   = (d.intlTransferOccurs          || '').toLowerCase();

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

  // Dimension 1 — ICO Registration
  const icoStatus = fields.ICORegistered || 'Unknown';
  if      (icoStatus === 'Yes')    { details.push({ status: 'pass', label: 'ICO Registration', description: `Registered with ICO${fields.ICORegNumber ? ` (${fields.ICORegNumber})` : ''}.` }); }
  else if (icoStatus === 'Exempt') { details.push({ status: 'info', label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies to their UK processing activities.' }); }
  else if (icoStatus === 'No')     { details.push({ status: 'fail', label: 'ICO Registration', description: 'Not found on ICO register. UK processors handling personal data are generally required to register.' }); score -= 20; }
  else                             { details.push({ status: 'info', label: 'ICO Registration', description: 'ICO registration status not confirmed — verify at ico.org.uk/ESDWebPages/Search.' }); score -= 5; }

  // Dimension 2 — DPA
  const dpaStatus    = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Confirmed';
  const privacyUrl   = fields.PrivacyPolicyUrl || null;
  if      (dpaConfirmed)            { details.push({ status: 'pass',    label: 'Data Processing Agreement', description: `DPA confirmed${privacyUrl ? ` — ${privacyUrl}` : ''}.` }); }
  else if (dpaStatus === 'On Request') { details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA available on request — contact vendor to obtain and sign before sharing personal data.' }); score -= 15; }
  else if (dpaStatus === 'Refused') { details.push({ status: 'fail',    label: 'Data Processing Agreement', description: 'Vendor has declined to sign a DPA. Transferring personal data to them is a UK GDPR Article 28 breach.' }); score -= 35; }
  else                              { details.push({ status: 'warning', label: 'Data Processing Agreement', description: 'DPA status not confirmed — contact vendor before sharing personal data.' }); score -= 15; }

  // Dimension 3 — International Transfers
  const transferOccurs = fields.IntlTransferOccurs        || 'Unknown';
  const transferDest   = fields.TransferDestination       || '';
  const transferMech   = fields.TransferMechanismConfirmed || 'Unknown';
  if      (transferOccurs === 'No') { details.push({ status: 'pass', label: 'International Transfers', description: 'Processing confirmed as UK/EEA only — no international transfer mechanism required.' }); }
  else if (['Adequacy','SCCs','BCRs','UK-US Bridge'].includes(transferMech)) { details.push({ status: 'pass', label: 'International Transfers', description: `Transfer mechanism confirmed: ${transferMech}${transferDest ? ` (${transferDest})` : ''}.` }); }
  else if (transferOccurs === 'Yes' && (transferMech === 'None' || transferMech === 'Unknown')) { details.push({ status: 'fail', label: 'International Transfers', description: `International transfer to ${transferDest || 'unknown destination'} with no confirmed mechanism.` }); score -= 20; }
  else { details.push({ status: 'info', label: 'International Transfers', description: 'International transfer status not confirmed — verify if data leaves UK/EEA.' }); score -= 5; }

  // Dimension 4 — Breach History (Long text)
  const breachHistory = fields.BreachHistory || '';
  const breachIsKnown = breachHistory && !['none identified','none','no','unknown',''].includes(breachHistory.toLowerCase());
  if (!breachIsKnown) { details.push({ status: 'pass',    label: 'Breach History', description: 'No publicly known significant breaches or enforcement actions identified.' }); }
  else                { details.push({ status: 'warning', label: 'Breach History', description: breachHistory }); score -= 15; }

  // Dimension 5 — DPO
  const dpoStatus = fields.DPOConfirmed || 'Unknown';
  if      (dpoStatus === 'Yes') { details.push({ status: 'pass', label: 'DPO / Controller Representative', description: 'Named DPO or controller representative confirmed.' }); }
  else if (dpoStatus === 'No')  { details.push({ status: 'info', label: 'DPO / Controller Representative', description: 'No named DPO identified — advisory only for most processors.' }); }
  else                          { details.push({ status: 'info', label: 'DPO / Controller Representative', description: 'DPO status not confirmed.' }); }

  // Dimension 6 — Security Certification
  const certStatus = fields.RelevantSecurityCertification || 'Unknown';
  if      (certStatus === 'Yes') { details.push({ status: 'pass', label: 'Security Certification', description: 'Relevant security certification confirmed (ISO 27001, SOC 2 or equivalent).' }); }
  else if (certStatus === 'No')  { details.push({ status: 'info', label: 'Security Certification', description: 'No ISO 27001, SOC 2 or equivalent identified — advisory only.' }); score -= 5; }
  else                           { details.push({ status: 'info', label: 'Security Certification', description: 'Security certification not confirmed.' }); }

  // Dimension 7 — Privacy Policy URL
  if (privacyUrl) { details.push({ status: 'info', label: 'Privacy Policy / DPA', description: `Available at: ${privacyUrl}` }); }

  // Risk rating
  const riskRating = fields.RiskRating || calculateRiskRating({
    icoRegistered: icoStatus, dpaStatus, intlTransferOccurs: transferOccurs,
    internationalTransfer: transferMech, transferDestination: transferDest,
    breachHistory, dpoConfirmed: dpoStatus, relevantSecurityCertification: certStatus,
  });

  // Action items
  const actionItems = [];
  if (!dpaConfirmed && dpaStatus !== 'Refused') actionItems.push('Obtain and sign a Data Processing Agreement with this vendor');
  if (dpaStatus === 'Refused') actionItems.push('Stop sharing personal data with this vendor — find a compliant alternative');
  if (transferOccurs === 'Yes' && transferMech === 'Unknown') actionItems.push('Confirm which international transfer mechanism applies');
  if (icoStatus === 'Unknown') actionItems.push('Verify ICO registration at: https://ico.org.uk/ESDWebPages/Search');
  if (breachIsKnown) actionItems.push('Document your assessment of continued use of this vendor given their breach history');
  if (fields.LastVerified) actionItems.push(`Library data last verified: ${fields.LastVerified} — re-verify if older than 12 months`);
  if (privacyUrl) actionItems.push(`Review privacy policy / DPA at: ${privacyUrl}`);

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
      icoRegistered:               icoStatus,
      icoRegNumber:                fields.ICORegNumber || null,
      dpaStatus,
      dpaLink:                     privacyUrl,
      intlTransferOccurs:          transferOccurs,
      transferDestination:         transferDest,
      internationalTransfer:       transferMech,
      breachHistory:               breachHistory || 'None identified',
      dpoConfirmed:                dpoStatus,
      relevantSecurityCertification: certStatus,
      lastVerified:                fields.LastVerified || null,
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
        icoRegistered:               d.icoRegistered               || 'Unknown',
        icoRegNumber:                d.icoRegNumber                || null,
        dpaStatus:                   d.dpaStatus                   || 'Unknown',
        dpaLink:                     d.dpaLink                     || null,
        intlTransferOccurs:          d.intlTransferOccurs          || 'Unknown',
        transferDestination:         d.transferDestination         || 'Unknown',
        internationalTransfer:       d.internationalTransfer       || 'Unknown',
        breachHistory:               d.breachHistory               || 'Unknown',
        dpoConfirmed:                d.dpoConfirmed                || 'Unknown',
        relevantSecurityCertification: d.relevantSecurityCertification || 'Unknown',
        lastVerified:                null,
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
