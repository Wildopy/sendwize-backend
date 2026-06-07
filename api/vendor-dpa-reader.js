// ─────────────────────────────────────────────────────────────
// SENDWIZE — vendor-dpa-reader.js v1.0
// POST /api/vendor-dpa-reader
// Body: { vendorRecordId, vendorName, url }
//
// Level 3 AI DPA extraction.
// Fetches the PrivacyPolicyUrl page, strips HTML, sends to Claude,
// extracts all 7 compliance dimensions, patches Marketing_Vendors,
// recalculates RiskRating and BaseScore, updates LastAutoChecked.
//
// Called by:
//   - vendor-monitor.js when content hash changes
//   - check-vendors.js admin action (future)
//   - Manual trigger from vendor library admin (future)
//
// Architecture rules:
//   - No npm packages — fetch only
//   - All async work awaited before res.json()
//   - Null strip before every Airtable PATCH
//   - export default async function handler
// ─────────────────────────────────────────────────────────────

const BASE_ID      = process.env.BASE_ID;
const AT_TOKEN     = process.env.AIRTABLE_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const AT_BASE      = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// ── Risk rating — mirrors check-vendors.js exactly ───────────
function calculateRiskRating(d) {
  const ico    = (d.ICORegistered                  || '').toLowerCase();
  const dpa    = (d.DPAStatus                      || '').toLowerCase();
  const mech   = (d.TransferMechanismConfirmed     || '').toLowerCase();
  const breach = (d.BreachHistory                  || '').toLowerCase();
  const dest   = (d.TransferDestination            || '').toLowerCase();
  const cert   = (d.RelevantSecurityCertification  || '').toLowerCase();
  const dpo    = (d.DPOConfirmed                   || '').toLowerCase();
  const intl   = (d.IntlTransferOccurs             || '').toLowerCase();

  if (ico === 'no') return 'High';
  if (breach && !['none identified','none','no','unknown',''].includes(breach)) return 'High';
  const nonAdequate = dest && !['eu','eea','uk','n/a'].some(t => dest.includes(t));
  const noMech      = ['none','unknown',''].includes(mech);
  if (intl === 'yes' && nonAdequate && noMech) return 'High';
  if (dpa === 'refused') return 'High';

  if (['on request','unknown'].includes(dpa)) return 'Medium';
  if (intl === 'yes' && noMech) return 'Medium';
  if (!cert || ['no','none','unknown'].includes(cert)) return 'Medium';
  if (!dpo  || ['no','none','unknown'].includes(dpo))  return 'Medium';

  return 'Low';
}

// ── Base score from extracted dimensions ──────────────────────
function calculateBaseScore(d) {
  let score = 100;
  const ico   = d.ICORegistered                 || 'Unknown';
  const dpa   = d.DPAStatus                     || 'Unknown';
  const mech  = d.TransferMechanismConfirmed    || 'Unknown';
  const intl  = d.IntlTransferOccurs            || 'Unknown';
  const breach = d.BreachHistory                || '';
  const cert  = d.RelevantSecurityCertification || 'Unknown';

  if (ico === 'No')                                       score -= 20;
  if (dpa === 'Refused')                                  score -= 35;
  else if (dpa === 'On Request' || dpa === 'Unknown')     score -= 15;
  if (intl === 'Yes' && (mech === 'None' || mech === 'Unknown')) score -= 20;
  if (breach && !['none identified','none','no','unknown',''].includes(breach.toLowerCase())) score -= 15;
  if (cert === 'No')                                      score -= 5;

  return Math.max(0, score);
}

// ── Strip HTML to plain text ──────────────────────────────────
// Removes tags, collapses whitespace, truncates to ~8000 chars
// so we don't blow Claude's context on huge legal pages.
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 8000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const { vendorRecordId, vendorName, url } = req.body ?? {};
  if (!vendorRecordId || !vendorName || !url) {
    return res.status(400).json({ error: 'vendorRecordId, vendorName and url are required' });
  }

  const today = new Date().toISOString().split('T')[0];

  // ── 1. Fetch the policy page ──────────────────────────────
  let pageText = '';
  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Sendwize-Compliance-Bot/1.0; +https://sendwize.co.uk)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    pageText   = stripHtml(html);
  } catch (e) {
    console.error(`vendor-dpa-reader: fetch failed for ${vendorName} (${url}):`, e.message);
    // Patch LastAutoChecked even on fetch failure so monitor doesn't retry immediately
    await fetch(`${AT_BASE}/Marketing_Vendors/${vendorRecordId}`, {
      method:  'PATCH',
      headers: atH(),
      body:    JSON.stringify({ fields: { LastAutoChecked: today } }),
    }).catch(() => {});
    return res.status(200).json({
      success: false,
      vendorName,
      reason: `Could not fetch policy page: ${e.message}`,
    });
  }

  if (pageText.length < 100) {
    return res.status(200).json({ success: false, vendorName, reason: 'Page content too short to analyse' });
  }

  // ── 2. Claude extraction ──────────────────────────────────
  let extracted = null;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role:    'user',
          content: `You are a UK GDPR compliance analyst. Extract compliance information about "${vendorName}" from the page text below.

Only extract information that is explicitly stated in the text. If something is not mentioned, use exactly: Unknown.
Do not guess, infer, or use prior knowledge about this vendor.

Page text:
${pageText}

Respond ONLY with this JSON — no markdown, no explanation:
{
  "ICORegistered": "<Yes|No|Exempt|Unknown>",
  "ICORegNumber": "<registration number or null>",
  "DPAStatus": "<Confirmed|On Request|Refused|Unknown>",
  "IntlTransferOccurs": "<Yes|No|Unknown>",
  "TransferDestination": "<country or region, or Unknown>",
  "TransferMechanismConfirmed": "<Adequacy|SCCs|BCRs|UK-US Bridge|None|Unknown>",
  "BreachHistory": "<factual description of any breach or enforcement action mentioned, or exactly: None identified>",
  "DPOConfirmed": "<Yes|No|Unknown>",
  "RelevantSecurityCertification": "<Yes|No|Unknown>",
  "extractionNotes": "<one sentence: what this page appears to be and confidence level>"
}`
        }]
      }),
    });

    if (!claudeRes.ok) throw new Error(`Claude API ${claudeRes.status}`);
    const claudeData = await claudeRes.json();
    const rawText    = claudeData.content[0].text.replace(/```json|```/g, '').trim();
    extracted        = JSON.parse(rawText);

  } catch (e) {
    console.error(`vendor-dpa-reader: Claude extraction failed for ${vendorName}:`, e.message);
    return res.status(200).json({ success: false, vendorName, reason: `Claude extraction failed: ${e.message}` });
  }

  // ── 3. Calculate derived fields ───────────────────────────
  const riskRating  = calculateRiskRating(extracted);
  const baseScore   = calculateBaseScore(extracted);

  // ── 4. Build Airtable patch — null strip + type guard ─────
  // Single select fields must match exact option values.
  // If Claude returns something outside the option set, use Unknown.
  const validICO    = ['Yes','No','Exempt','Unknown'];
  const validDPA    = ['Confirmed','On Request','Refused','Unknown'];
  const validIntl   = ['Yes','No','Unknown'];
  const validMech   = ['Adequacy','SCCs','BCRs','UK-US Bridge','None','Unknown'];
  const validCert   = ['Yes','No','Unknown'];
  const validDPO    = ['Yes','No','Unknown'];
  const validRisk   = ['Low','Medium','High'];

  function guard(val, validSet, fallback = 'Unknown') {
    return validSet.includes(val) ? val : fallback;
  }

  const patchFields = Object.fromEntries(Object.entries({
    ICORegistered:                guard(extracted.ICORegistered, validICO),
    ICORegNumber:                 extracted.ICORegNumber || null,
    DPAStatus:                    guard(extracted.DPAStatus, validDPA),
    IntlTransferOccurs:           guard(extracted.IntlTransferOccurs, validIntl),
    TransferDestination:          extracted.TransferDestination || null,
    TransferMechanismConfirmed:   guard(extracted.TransferMechanismConfirmed, validMech),
    BreachHistory:                extracted.BreachHistory || 'None identified',
    DPOConfirmed:                 guard(extracted.DPOConfirmed, validDPO),
    RelevantSecurityCertification: guard(extracted.RelevantSecurityCertification, validCert),
    RiskRating:                   guard(riskRating, validRisk, 'Medium'),
    BaseScore:                    baseScore,
    LastAutoChecked:              today,
  }).filter(([, v]) => v !== null && v !== undefined));

  // ── 5. Patch Marketing_Vendors ────────────────────────────
  try {
    const patchRes = await fetch(`${AT_BASE}/Marketing_Vendors/${vendorRecordId}`, {
      method:  'PATCH',
      headers: atH(),
      body:    JSON.stringify({ fields: patchFields }),
    });
    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      console.error(`vendor-dpa-reader: Airtable patch failed for ${vendorName}:`, errBody);
      return res.status(200).json({ success: false, vendorName, reason: `Airtable patch failed: ${patchRes.status}` });
    }
  } catch (e) {
    console.error(`vendor-dpa-reader: Airtable patch error for ${vendorName}:`, e.message);
    return res.status(200).json({ success: false, vendorName, reason: e.message });
  }

  return res.status(200).json({
    success:          true,
    vendorName,
    vendorRecordId,
    riskRating,
    baseScore,
    extracted:        patchFields,
    extractionNotes:  extracted.extractionNotes || '',
    lastAutoChecked:  today,
  });
}
