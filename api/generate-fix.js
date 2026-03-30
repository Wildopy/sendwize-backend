// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js v4.19
// Called by all tools when a violation is found.
// Creates a Compliance_Fixes record.
// Deduplicates: same fixType + sourceRecordId + Status=pending = skip.
//
// THREE-TIER MODEL:
//   Tier 1 — ICO direct fine (real cases): show £ range
//   Tier 2 — CMA/DMCCA trajectory (no settled cases yet): show £ range + disclaimer
//   Tier 3 — ASA/reputational only: low/high = 0, dashboard shows risk indicator
//
// PECR cap: £17.5M under Data (Use and Access) Act 2025.
// ─────────────────────────────────────────────────────────────

const EXPOSURE_RANGES = {

  // ── TIER 1 — ICO direct fine, real cases ─────────────────────────

  expired_consent:           { low: 5000,  high: 200000, exposureBasis: 'regulatory' },
  // FLOOR: Energy Suite Ltd (Jan 2022) £2k / 1,246 TPS calls → £5k SMB floor.
  // CEILING: It's OK Ltd (Feb 2023) £200k / 1.75m calls, sustained campaign.

  missing_unsubscribe:       { low: 30000, high: 140000, exposureBasis: 'regulatory' },
  // FLOOR: TBDL (Aug 2023) £30k mitigated from £150k.
  // CEILING: HelloFresh (Jan 2024) £140k / 80m emails + 1m texts.

  suppressed_contact:        { low: 30000, high: 50000,  exposureBasis: 'regulatory' },
  // FLOOR: Halfords (Sep 2022) £30k / 498,179 emails to opted-out customers.
  // CEILING: Virgin Media (Dec 2021) £50k / 451,217 emails.

  third_party_list:          { low: 50000, high: 130000, exposureBasis: 'regulatory' },
  // CEILING: Join the Triboo £130k. ZMLUK Ltd (Jan 2026) £105k / 67m emails.

  third_party_list_risk:     { low: 50000, high: 130000, exposureBasis: 'regulatory' },
  // Alias used by analyze-copy.js — same evidence base as third_party_list.

  invalid_consent_mechanism: { low: 30000, high: 140000, exposureBasis: 'regulatory' },
  // FLOOR: LADH Ltd (Jan 2024) £50k → £30k conservative SMB floor.
  // CEILING: HelloFresh (Jan 2024) £140k / bundled consent.

  no_soft_optin:             { low: 30000, high: 120000, exposureBasis: 'regulatory' },
  // FLOOR: TBDL (Aug 2023) £30k.
  // CEILING: Allay Claims Ltd (Jan 2026) £120k / 4m texts.

  no_consent:                { low: 30000, high: 140000, exposureBasis: 'regulatory' },
  // Same evidence base as invalid_consent_mechanism.

  concealed_sender:          { low: 5000,  high: 50000,  exposureBasis: 'regulatory' },
  // PECR Reg 23. Always cited alongside Reg 22 — conservative range.

  reconsent_sent:            { low: 0,     high: 0,      exposureBasis: 'regulatory' },
  // Zero exposure — positive compliance action, not a violation.

  // ── TIER 2 — CMA/DMCCA trajectory, no settled UK SMB cases yet ───

  misleading_claim:                  { low: 13000, high: 500000, exposureBasis: 'regulatory' },
  fake_urgency:                      { low: 3000,  high: 250000, exposureBasis: 'regulatory' },
  fake_scarcity:                     { low: 3000,  high: 250000, exposureBasis: 'regulatory' },
  misleading_pricing:                { low: 5000,  high: 75000,  exposureBasis: 'regulatory' },
  misleading_reference_price:        { low: 5000,  high: 75000,  exposureBasis: 'regulatory' },
  dark_pattern:                      { low: 5000,  high: 100000, exposureBasis: 'regulatory' },
  misleading_free_claim:             { low: 3000,  high: 50000,  exposureBasis: 'regulatory' },
  drip_pricing:                      { low: 5000,  high: 100000, exposureBasis: 'regulatory' },
  unsubstantiated_comparative_claim: { low: 3000,  high: 50000,  exposureBasis: 'regulatory' },
  unauthorised_health_claim:         { low: 5000,  high: 100000, exposureBasis: 'regulatory' },
  misleading_testimonial:            { low: 3000,  high: 50000,  exposureBasis: 'regulatory' },

  // ── TIER 3 — no direct regulatory fine ───────────────────────────

  no_privacy_policy:                 { low: 0, high: 0, exposureBasis: 'reputational' },
  no_dpa:                            { low: 0, high: 0, exposureBasis: 'reputational' },
  no_legitimate_interest:            { low: 0, high: 0, exposureBasis: 'reputational' },
  frequency_abuse:                   { low: 0, high: 0, exposureBasis: 'reputational' },
  missing_address:                   { low: 0, high: 0, exposureBasis: 'reputational' },
  no_sender_identification:          { low: 0, high: 0, exposureBasis: 'reputational' },
  unlawful_incentive:                { low: 0, high: 0, exposureBasis: 'reputational' },
  missing_terms:                     { low: 0, high: 0, exposureBasis: 'reputational' },
  undisclosed_ad:                    { low: 0, high: 0, exposureBasis: 'reputational' },
};

const SIZE_MULTIPLIERS         = { micro: 0.4, smb: 1.0, midmarket: 2.2 };
const SECTOR_MODIFIERS         = { ecommerce: 1.0, agency: 1.0, other: 1.0, finance: 1.4, healthcare: 1.8 };
const EMAIL_VOLUME_MULTIPLIERS = { micro_send: 0.5, small_send: 0.8, medium_send: 1.0, large_send: 1.4, enterprise_send: 1.8 };
const SEVERITY_POSITION        = { low: 0.1, medium: 0.3, high: 0.6, critical: 0.9 };
const PECR_CAP                 = 17500000;

function calculateExposure(fixType, severity, businessSize, sector, emailVolume) {
  const range = EXPOSURE_RANGES[fixType];
  if (!range || range.exposureBasis === 'reputational') {
    return { low: 0, high: 0, estimate: 0, exposureBasis: 'reputational' };
  }
  const low      = Math.round(Math.min(range.low  * (SIZE_MULTIPLIERS[businessSize] || 1) * (SECTOR_MODIFIERS[sector] || 1) * (EMAIL_VOLUME_MULTIPLIERS[emailVolume] || 1), PECR_CAP));
  const high     = Math.round(Math.min(range.high * (SIZE_MULTIPLIERS[businessSize] || 1) * (SECTOR_MODIFIERS[sector] || 1) * (EMAIL_VOLUME_MULTIPLIERS[emailVolume] || 1), PECR_CAP));
  const estimate = Math.round(Math.min(low + (high - low) * (SEVERITY_POSITION[severity] || 0.3), PECR_CAP));
  return { low, high, estimate, exposureBasis: 'regulatory' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, fixType, description, tool, severity, volume, sourceRecordId } = req.body ?? {};

    if (!userId)                        return res.status(400).json({ error: 'Missing userId' });
    if (!fixType)                       return res.status(400).json({ error: 'Missing fixType' });
    if (!tool)                          return res.status(400).json({ error: 'Missing tool' });
    if (!severity)                      return res.status(400).json({ error: 'Missing severity' });
    if (!EXPOSURE_RANGES[fixType])      return res.status(400).json({ error: `Unknown fixType: ${fixType}` });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const base           = `https://api.airtable.com/v0/${BASE_ID}`;
    const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // ── 1. Fetch user profile ─────────────────────────────────────────
    let businessSize = 'smb', sector = 'ecommerce', emailVolume = 'medium_send';
    try {
      const pr = await fetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
      if (pr.ok) {
        const pd = await pr.json();
        if (pd.records?.length > 0) {
          const f  = pd.records[0].fields;
          businessSize = f.BusinessSize || 'smb';
          sector       = f.Sector       || 'ecommerce';
          emailVolume  = f.EmailVolume  || 'medium_send';
        }
      }
    } catch (e) { console.error('Profile load failed, using defaults:', e); }

    // ── 2. Deduplicate ────────────────────────────────────────────────
    if (sourceRecordId) {
      try {
        const formula = `AND({UserID}='${userId}',{FixType}='${fixType}',{SourceRecordID}='${sourceRecordId}',{Status}='pending')`;
        const dr      = await fetch(`${base}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
        if (dr.ok) {
          const dd = await dr.json();
          if (dd.records?.length > 0) {
            console.log(`Duplicate skipped: ${fixType} / ${sourceRecordId}`);
            return res.json({ skipped: true, reason: 'Fix already exists as pending', fixId: dd.records[0].id });
          }
        }
      } catch (e) { console.error('Dupe check failed, continuing:', e); }
    }

    // ── 3. Calculate exposure ─────────────────────────────────────────
    const exposure = calculateExposure(fixType, severity, businessSize, sector, emailVolume);

    // ── 4. Write fix record ───────────────────────────────────────────
    const cr = await fetch(`${base}/Compliance_Fixes`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ records: [{ fields: {
        UserID: userId, FixType: fixType,
        Description:      description || `${fixType} violation detected by ${tool}`,
        Tool:             tool, Severity: severity,
        ExposureLow:      exposure.low,
        ExposureHigh:     exposure.high,
        ExposureEstimate: exposure.estimate,
        ExposureBasis:    exposure.exposureBasis,
        Status:           'pending',
        Volume:           parseInt(volume) || null,
        SourceRecordID:   sourceRecordId || null,
        CreatedDate:      new Date().toISOString().split('T')[0],
      }}]})
    });

    if (!cr.ok) {
      console.error('Compliance_Fixes create failed:', await cr.text());
      return res.status(500).json({ error: 'Failed to write fix record' });
    }

    const fixId = (await cr.json()).records[0].id;
    console.log(`Fix created: ${fixId} | ${fixType} | ${exposure.exposureBasis} | £${exposure.low}–£${exposure.high}`);

    return res.json({ success: true, fixId, fixType, exposureLow: exposure.low, exposureHigh: exposure.high, exposureEstimate: exposure.estimate, exposureBasis: exposure.exposureBasis });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
