// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js v4.8
// Called by all 5 tools when a violation is found.
// Creates a record in Compliance_Fixes table.
// Calculates exposure from ICO/ASA/CMA enforcement data
// multiplied by user's business profile (size, sector, volume).
// Deduplicates — same fixType + sourceRecordId = skip.
//
// Exposure model last reviewed: March 2026
// Sources: ICO PECR enforcement list (DQM GRC), Bird & Bird
// round-ups, ASA/CMA enforcement data. Full case citations
// in spec §5.1 and sendwize-exposure-evidence.docx.
//
// THREE-TIER MODEL (v4.8):
//   Tier 1 — ICO direct fine: real cases, show £ range
//   Tier 2 — CMA/DMCCA trajectory: no settled cases yet,
//             show £ range with disclaimer
//   Tier 3 — ASA/reputational only: no regulatory fine,
//             low/high = 0, dashboard shows risk indicator
//
// Maximum PECR fine updated to £17.5M under Data (Use and
// Access) Act 2025 — all Tier 1/2 ranges capped accordingly.
// ─────────────────────────────────────────────────────────────

// exposureBasis values:
//   'regulatory'    — Tier 1/2: show £ range on dashboard
//   'reputational'  — Tier 3: show risk indicator, no £ figure

const EXPOSURE_RANGES = {

  // ── TIER 1 — ICO direct fine, real cases ─────────────────────────
  // expired_consent
  //   FLOOR: Energy Suite Ltd (Jan 2022) — £2,000 for 1,246 TPS calls.
  //          Rounded to £5k as realistic email SMB floor.
  //   CEILING: It's OK Ltd (Feb 2023) — £200,000 for 1.75m calls,
  //            'sustained and exploitative campaign'.
  expired_consent: {
    low: 5000, high: 200000,
    exposureBasis: 'regulatory',
  },

  // missing_unsubscribe
  //   FLOOR: TBDL (Aug 2023) — £30,000 for 40m emails/1.5m texts.
  //          Original proposed £150,000; mitigated.
  //   CEILING: HelloFresh (Jan 2024) — £140,000 for 80m emails/1m texts.
  //            Full cooperation — no fine reduction granted.
  missing_unsubscribe: {
    low: 30000, high: 140000,
    exposureBasis: 'regulatory',
  },

  // suppressed_contact
  //   FLOOR: Halfords (Sep 2022) — £30,000 for 498,179 emails to
  //          opted-out customers. Triggered by one ICO complaint.
  //   CEILING: Virgin Media (Dec 2021) — £50,000 for 451,217 emails.
  //            Also triggered by a single customer complaint.
  suppressed_contact: {
    low: 30000, high: 50000,
    exposureBasis: 'regulatory',
  },

  // third_party_list
  //   FLOOR: Conservative SMB estimate (neither case = small sender).
  //   CEILING: Join the Triboo — £130,000.
  //            ZMLUK Ltd (Jan 2026) — £105,000 for 67m emails
  //            sourced from third-party with 361 partners, no choice.
  third_party_list: {
    low: 50000, high: 130000,
    exposureBasis: 'regulatory',
  },

  // invalid_consent_mechanism
  //   FLOOR: LADH Ltd (Jan 2024) — £50,000 for 31,329 texts,
  //          no opt-out. Low set to £30k as conservative SMB floor.
  //   CEILING: HelloFresh (Jan 2024) — £140,000 for bundled consent
  //            (age confirmation + marketing in single tick box).
  invalid_consent_mechanism: {
    low: 30000, high: 140000,
    exposureBasis: 'regulatory',
  },

  // no_soft_optin
  //   FLOOR: TBDL (Aug 2023) — £30,000 (mitigated from £150,000).
  //          Previous floor of £5,000 removed — unsupported by any case.
  //   MIDPOINT: Tempcover (2022) — £85,000 for bundled consent at
  //             point of collection without opt-out option.
  //   CEILING: Allay Claims Ltd (Jan 2026) — £120,000 for 4m texts;
  //            soft opt-in misapplied, no simple refusal mechanism.
  no_soft_optin: {
    low: 30000, high: 120000,
    exposureBasis: 'regulatory',
  },

  // reconsent_sent — zero exposure by definition
  reconsent_sent: {
    low: 0, high: 0,
    exposureBasis: 'regulatory',
  },

  // ── TIER 2 — CMA/DMCCA trajectory, no settled cases ─────────────
  // misleading_claim
  //   FLOOR REFERENCE: Honda Motor Europe (ICO) — £13,000.
  //   CEILING: DMCCA 2024 statutory ceiling (higher of £300k or 10%
  //            global turnover). No settled cases as of March 2026.
  //   NOTE: ASA has no direct fining power. Route to exposure is
  //         CMA referral after pattern of ASA upheld rulings.
  //   DISCLAIMER REQUIRED on dashboard.
  misleading_claim: {
    low: 13000, high: 500000,
    exposureBasis: 'regulatory',
  },

  // fake_urgency
  //   REFERENCE: Wowcher (Jul 2024) — £4m consumer redress (not a fine)
  //              for countdown timer manipulation, pre-DMCCA powers.
  //   Under DMCCA direct fines now available — no settled cases.
  //   DISCLAIMER REQUIRED on dashboard.
  fake_urgency: {
    low: 3000, high: 250000,
    exposureBasis: 'regulatory',
  },

  // misleading_pricing (NEW — v4.5)
  //   ACTIVE INVESTIGATIONS (Nov 2025): Wayfair, Appliances Direct,
  //   Marks Electrical. No fines issued yet.
  //   DMCCA ceiling: higher of £300k or 10% global turnover.
  //   Conservative SMB range pending first settled cases (2026-2027).
  //   DISCLAIMER REQUIRED on dashboard.
  misleading_pricing: {
    low: 5000, high: 75000,
    exposureBasis: 'regulatory',
  },

  // dark_pattern (NEW — v4.5)
  //   REFERENCE: Wowcher (Jul 2024) — £4m consumer redress pre-DMCCA.
  //              Emma Sleep — High Court Oct 2024.
  //   Under DMCCA direct fines now available — no settled cases.
  //   DISCLAIMER REQUIRED on dashboard.
  dark_pattern: {
    low: 5000, high: 100000,
    exposureBasis: 'regulatory',
  },

  // ── TIER 3 — no direct regulatory fine ───────────────────────────
  // All Tier 3 fix types: low/high = 0.
  // Dashboard MUST show risk indicator text, not a £ figure.
  // exposureBasis = 'reputational' signals this to the UI.

  // no_privacy_policy
  //   UK GDPR Art 13/14. No UK SMB has been fined solely for a
  //   missing privacy policy. ICO approach: enforcement notice first.
  //   Primary risks: aggravating factor in PECR investigation;
  //   ESP account suspension (Mailchimp/Klaviyo/Dotdigital require it).
  no_privacy_policy: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // no_dpa
  //   UK GDPR Art 28. No UK SMB fined solely for missing DPA.
  //   Primary risk: absence of DPA with ESP may invalidate lawful
  //   basis for every campaign sent; compounds any ICO investigation.
  no_dpa: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // no_legitimate_interest
  //   UK GDPR Art 6 (B2B context). No UK SMB fined solely for
  //   missing LIA documentation. Primary risk: removes primary
  //   legal defence in any ICO investigation.
  no_legitimate_interest: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // frequency_abuse
  //   Aggravating factor only — never standalone ICO charge.
  //   Reviewed: CAL £200k, F12M £200k, It's OK Ltd £200k —
  //   all primary charges were TPS breach or no consent.
  //   Primary risk: high complaint volumes trigger ICO investigations
  //   into underlying consent/suppression failures.
  frequency_abuse: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // missing_address
  //   PECR Reg 23(a). Never sole basis for an ICO fine.
  //   Reviewed: ADS £65k, MCP £55k, LADH £50k — all Reg 23
  //   cited alongside primary Reg 22 consent breach.
  //   Primary risk: deliverability failure and ESP suspension
  //   precede any ICO risk.
  missing_address: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // no_sender_identification
  //   PECR Reg 23(a). Same evidence base as missing_address.
  //   Deliberate identity concealment is an aggravating factor
  //   in larger fines — distinct from a missing footer address.
  no_sender_identification: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // unlawful_incentive (NEW — v4.5)
  //   ASA CAP Code Section 8 / Gambling Act 2005.
  //   ASA rulings = ad withdrawal only, no financial penalty.
  //   No CMA action against UK SMB for email-based promotion.
  //   Primary risks: ad withdrawal; consumer redress if prize
  //   not awarded as described.
  unlawful_incentive: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },

  // missing_terms (NEW — v4.5)
  //   ASA CAP Code Rule 8.17 / CMA Consumer Protection.
  //   ASA breach = ad withdrawal only. No CMA action for
  //   missing T&Cs in isolation.
  //   Primary risk: ad withdrawal; weak position in consumer disputes.
  missing_terms: {
    low: 0, high: 0,
    exposureBasis: 'reputational',
  },
};

// ── Multipliers ───────────────────────────────────────────────────────────
// Business size — based on ICO's approach to scaling penalties.
const SIZE_MULTIPLIERS = {
  micro:     0.4,   // Sole trader / <10 employees
  smb:       1.0,   // Default — 10–250 employees
  midmarket: 2.2,   // 250+ employees
};

// Sector risk modifiers — healthcare and finance face higher scrutiny.
const SECTOR_MODIFIERS = {
  ecommerce:  1.0,
  agency:     1.0,
  other:      1.0,
  finance:    1.4,
  healthcare: 1.8,
};

// Email volume — higher send = higher fine risk (more complaints,
// more evidence of systemic breach).
const EMAIL_VOLUME_MULTIPLIERS = {
  micro_send:      0.5,  // 0–1,000/month
  small_send:      0.8,  // 1,001–10,000/month
  medium_send:     1.0,  // 10,001–100,000/month (default)
  large_send:      1.4,  // 100,001–500,000/month
  enterprise_send: 1.8,  // 500,001+/month
};

// Severity position — picks a single point estimate within
// the low–high range for the ExposureEstimate field.
const SEVERITY_POSITION = {
  low:      0.1,
  medium:   0.3,
  high:     0.6,
  critical: 0.9,
};

// Regulatory cap under Data (Use and Access) Act 2025.
const PECR_CAP = 17500000;

function calculateExposure(fixType, severity, businessSize, sector, emailVolume) {
  const range = EXPOSURE_RANGES[fixType];
  if (!range) return { low: 0, high: 0, estimate: 0, exposureBasis: 'reputational' };

  // Tier 3 fixes — no monetary calculation needed
  if (range.exposureBasis === 'reputational') {
    return { low: 0, high: 0, estimate: 0, exposureBasis: 'reputational' };
  }

  const sizeMultiplier   = SIZE_MULTIPLIERS[businessSize]         || 1.0;
  const sectorModifier   = SECTOR_MODIFIERS[sector]               || 1.0;
  const volumeMultiplier = EMAIL_VOLUME_MULTIPLIERS[emailVolume]  || 1.0;
  const position         = SEVERITY_POSITION[severity]            || 0.3;

  const rawLow  = range.low  * sizeMultiplier * sectorModifier * volumeMultiplier;
  const rawHigh = range.high * sizeMultiplier * sectorModifier * volumeMultiplier;

  const low      = Math.round(Math.min(rawLow,  PECR_CAP));
  const high     = Math.round(Math.min(rawHigh, PECR_CAP));
  const estimate = Math.round(Math.min(low + (high - low) * position, PECR_CAP));

  return { low, high, estimate, exposureBasis: 'regulatory' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      userId,
      fixType,
      description,
      tool,
      severity,
      volume,
      sourceRecordId,
    } = req.body;

    if (!userId || !fixType || !tool || !severity) {
      return res.status(400).json({
        error: 'Missing required fields: userId, fixType, tool, severity',
      });
    }

    if (!EXPOSURE_RANGES[fixType]) {
      return res.status(400).json({ error: `Unknown fixType: ${fixType}` });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── 1. Get user profile ───────────────────────────────────────────
    let businessSize = 'smb';
    let sector       = 'ecommerce';
    let emailVolume  = 'medium_send';

    try {
      const profileRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}="${userId}"&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      const profileData = await profileRes.json();
      if (profileData.records?.length > 0) {
        const f    = profileData.records[0].fields;
        businessSize = f.BusinessSize || 'smb';
        sector       = f.Sector       || 'ecommerce';
        emailVolume  = f.EmailVolume  || 'medium_send';
      }
    } catch (e) {
      console.error('Profile load failed, using defaults:', e);
    }

    // ── 2. Deduplicate ────────────────────────────────────────────────
    if (sourceRecordId) {
      try {
        const formula = `AND({UserID}="${userId}",{FixType}="${fixType}",{SourceRecordID}="${sourceRecordId}",{Status}="pending")`;
        const dupeRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const dupeData = await dupeRes.json();
        if (dupeData.records?.length > 0) {
          console.log(`Duplicate skipped: ${fixType} / ${sourceRecordId}`);
          return res.json({
            skipped: true,
            reason:  'Fix already exists as pending',
            fixId:   dupeData.records[0].id,
          });
        }
      } catch (e) {
        console.error('Dupe check failed, continuing:', e);
      }
    }

    // ── 3. Calculate exposure ─────────────────────────────────────────
    const exposure = calculateExposure(
      fixType,
      severity,
      businessSize,
      sector,
      emailVolume
    );

    // ── 4. Write fix record ───────────────────────────────────────────
    const createRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:           userId,
              FixType:          fixType,
              Description:      description || `${fixType} violation detected by ${tool}`,
              Tool:             tool,
              Severity:         severity,
              ExposureLow:      exposure.low,
              ExposureHigh:     exposure.high,
              ExposureEstimate: exposure.estimate,
              ExposureBasis:    exposure.exposureBasis,
              Status:           'pending',
              Volume:           parseInt(volume) || null,
              SourceRecordID:   sourceRecordId || null,
              CreatedDate:      new Date().toISOString().split('T')[0],
            },
          }],
        }),
      }
    );

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Airtable create failed: ${errText}`);
    }

    const createData = await createRes.json();
    const fixId      = createData.records[0].id;

    console.log(`Fix created: ${fixId} | ${fixType} | basis: ${exposure.exposureBasis} | estimate £${exposure.estimate} | range £${exposure.low}–£${exposure.high}`);

    return res.json({
      success:          true,
      fixId,
      fixType,
      exposureLow:      exposure.low,
      exposureHigh:     exposure.high,
      exposureEstimate: exposure.estimate,
      exposureBasis:    exposure.exposureBasis,
      description:      description || `${fixType} violation detected by ${tool}`,
    });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
