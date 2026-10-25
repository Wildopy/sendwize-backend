// ─────────────────────────────────────────────────────────────
// SENDWIZE — vendor-dpa-reader.js v1.2
// v1.2: risk rating and transfer rules from _processor-rules.js. Asks for
//   the UK transfer tool (IDTA / UK Addendum / UK Extension), not plain
//   SCCs. ICO registration no longer lowers the score (processors do not
//   pay the ICO fee).
// v1.1 (security): internal callers only (vendor-monitor). This endpoint
//   rewrites the shared Marketing_Vendors library every customer sees, so
//   it must never be callable from a browser. The policy page is fetched
//   through _page-scan.js fetchPage() (SSRF-safe, size-capped).
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
//   - Manual trigger from vendor library admin (future)
//
// Architecture rules:
//   - No npm packages — fetch only
//   - All async work awaited before res.json()
//   - Null strip before every Airtable PATCH
//   - export default async function handler
// ─────────────────────────────────────────────────────────────

import { claudeFetch, LEGAL_RULES } from './_claude.js';
import { requireInternal, isRecordId } from './_auth.js';
import { fetchPage } from './_page-scan.js';
import { calculateRiskRating, transferPosition, breachIsKnown, normaliseMechanism, TRANSFER_MECHANISMS } from './_processor-rules.js';

const BASE_ID      = process.env.BASE_ID;
const AT_TOKEN     = process.env.AIRTABLE_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const AT_BASE      = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// Risk rating and transfer rules come from _processor-rules.js (v1.2).

// ── Base score from extracted dimensions ──────────────────────
function calculateBaseScore(d) {
  let score = 100;
  const dpa   = d.DPAStatus                     || 'Unknown';
  const cert  = d.RelevantSecurityCertification || 'Unknown';
  const transfer = transferPosition({
    destination: d.TransferDestination, mechanism: d.TransferMechanismConfirmed, intlTransferOccurs: d.IntlTransferOccurs,
  });

  // ICO registration is not scored: the fee is paid by controllers, not processors
  if (dpa === 'Refused')                                  score -= 35;
  else if (dpa === 'On Request' || dpa === 'Unknown')     score -= 15;
  if (transfer.status === 'unsafeguarded')                score -= 20;
  else if (!transfer.ok)                                  score -= 10;
  if (breachIsKnown(d.BreachHistory))                     score -= 15;
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
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });
  const auth = await requireInternal(req, res);
  if (!auth) return;

  const { vendorRecordId, vendorName, url } = req.body ?? {};
  if (!vendorRecordId || !vendorName || !url) {
    return res.status(400).json({ error: 'vendorRecordId, vendorName and url are required' });
  }
  if (!isRecordId(vendorRecordId)) return res.status(400).json({ error: 'Invalid vendorRecordId' });

  const today = new Date().toISOString().split('T')[0];

  // ── 1. Fetch the policy page ──────────────────────────────
  let pageText = '';
  try {
    const page = await fetchPage(url, { allowText: true });
    if (!page.ok) throw new Error(page.error || 'fetch failed');
    const html = page.html;
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
    const claudeRes = await claudeFetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        max_tokens: 1000, system: LEGAL_RULES,
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
  "TransferMechanismConfirmed": "<Adequacy|IDTA|UK Addendum|UK-US Bridge|BCRs|EU SCCs only|None|Unknown> (UK tools only: use IDTA for the ICO International Data Transfer Agreement, UK Addendum for EU SCCs with the UK Addendum, UK-US Bridge only if the UK Extension to the Data Privacy Framework is named; EU SCCs or EU-US DPF without a UK tool = EU SCCs only)",
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
  const validMech   = TRANSFER_MECHANISMS;
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
    TransferMechanismConfirmed:   guard(normaliseMechanism(extracted.TransferMechanismConfirmed), validMech),
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
      // typecast: creates the new TransferMechanismConfirmed options (IDTA, UK Addendum, EU SCCs only) on first use
      body:    JSON.stringify({ fields: patchFields, typecast: true }),
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
