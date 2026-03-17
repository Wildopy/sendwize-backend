// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js
// Called by all 5 tools when a violation is found.
// Creates a record in Compliance_Fixes table.
// Calculates exposure from ICO/ASA/CMA enforcement data
// multiplied by user's business profile (size, sector, volume).
// Deduplicates — same fixType + sourceRecordId = skip.
//
// Exposure ranges last reviewed: March 2026
// Sources: ICO PECR enforcement list (DQM GRC), Bird & Bird
// round-ups, ASA/CMA enforcement data.
// Maximum PECR fine updated to £17.5M under Data (Use and
// Access) Act 2025 — ranges capped accordingly.
// ─────────────────────────────────────────────────────────────

const EXPOSURE_RANGES = {
  // ── ICO PECR / UK GDPR violations ──────────────────────────
  // expired_consent: flat range. Energy Suite £2k (low end,
  // 1,246 calls, cooperative). It's OK Ltd £200k (high end).
  expired_consent:            { low: 5000,   high: 200000 },

  // missing_unsubscribe: flat. TBDL £30k (mitigated from £150k).
  // HelloFresh £140k. Not per-contact — ICO fines per incident.
  missing_unsubscribe:        { low: 30000,  high: 140000 },

  // misleading_claim: ASA/CMA basis not ICO fine. Honda £13k
  // (low). High = PECR statutory max pre-2025 Act.
  // Disclaimer must reference ASA/CMA reputational risk.
  misleading_claim:           { low: 13000,  high: 500000 },

  // no_dpa: UK GDPR Article 28. No isolated ICO cases —
  // based on legal guidance.
  no_dpa:                     { low: 3000,   high: 28000  },

  // fake_urgency: ASA/CMA basis. CMA can fine up to 10%
  // of turnover. Range reflects reputational + CMA risk.
  fake_urgency:               { low: 3000,   high: 250000 },

  // missing_address: secondary violation. ADS £65k, MCP £55k.
  missing_address:            { low: 5000,   high: 55000  },

  // no_privacy_policy: no direct ICO cases — deterrent figure.
  no_privacy_policy:          { low: 1000,   high: 17500  },

  // suppressed_contact: flat. Halfords £30k, Virgin Media £50k.
  suppressed_contact:         { low: 30000,  high: 50000  },

  // reconsent_sent: no exposure — closes the consent loop.
  reconsent_sent:             { low: 0,      high: 0      },

  // ── New PECR fix types (from PECR questionnaire) ────────────
  // no_soft_optin: same basis as expired_consent.
  // Reg 22 breach — no prior relationship with recipient.
  no_soft_optin:              { low: 5000,   high: 200000 },

  // invalid_consent_mechanism: bundled/pre-ticked consent.
  // HelloFresh precedent — £140k for bundled age confirmation.
  invalid_consent_mechanism:  { low: 30000,  high: 140000 },

  // third_party_list: Join the Triboo £130k, ZMLUK £105k.
  // Using bought data without named consent.
  third_party_list:           { low: 40000,  high: 130000 },

  // no_legitimate_interest: UK GDPR Article 6.
  // Same basis as no_dpa — legal guidance range.
  no_legitimate_interest:     { low: 3000,   high: 28000  },

  // no_sender_identification: PECR Reg 23 secondary violation.
  // ADS £65k, MCP £55k alongside main consent breach.
  no_sender_identification:   { low: 5000,   high: 55000  },

  // frequency_abuse: aggravating factor in multiple ICO cases.
  // Treated as escalating factor, not standalone fine.
  frequency_abuse:            { low: 5000,   high: 80000  },
};

// Business size multipliers
// Based on ICO's approach to scaling penalties to financial capacity.
const SIZE_MULTIPLIERS = {
  micro:     0.4,   // Sole trader / <10 employees
  smb:       1.0,   // Default — 10–250 employees
  midmarket: 2.2,   // 250+ employees
};

// Sector risk modifiers
// Healthcare and finance face higher regulatory scrutiny.
const SECTOR_MODIFIERS = {
  ecommerce:  1.0,
  agency:     1.0,
  other:      1.0,
  finance:    1.4,
  healthcare: 1.8,
};

// Email volume multipliers
// Higher send volumes = higher fine risk (more complaints,
// more evidence of systemic breach).
// Based on existing EmailVolume field in User_Profile table.
const EMAIL_VOLUME_MULTIPLIERS = {
  micro_send:      0.5,  // 0–1,000/month
  small_send:      0.8,  // 1,001–10,000/month
  medium_send:     1.0,  // 10,001–100,000/month (default)
  large_send:      1.4,  // 100,001–500,000/month
  enterprise_send: 1.8,  // 500,001+/month
};

// Severity position — picks a single point estimate within
// the low–high range rather than showing the full band.
// Allows the dashboard to surface one specific £ figure.
const SEVERITY_POSITION = {
  low:      0.1,
  medium:   0.3,
  high:     0.6,
  critical: 0.9,
};

// Regulatory cap under Data (Use and Access) Act 2025.
// Higher of £17.5M or 4% of global annual turnover.
// No enforcement cases yet under new regime — cap as ceiling.
const PECR_CAP = 17500000;

function calculateExposure(fixType, severity, businessSize, sector, emailVolume) {
  const range = EXPOSURE_RANGES[fixType];
  if (!range) return { low: 0, high: 0, estimate: 0 };

  const sizeMultiplier   = SIZE_MULTIPLIERS[businessSize]           || 1.0;
  const sectorModifier   = SECTOR_MODIFIERS[sector]                 || 1.0;
  const volumeMultiplier = EMAIL_VOLUME_MULTIPLIERS[emailVolume]    || 1.0;
  const position         = SEVERITY_POSITION[severity]              || 0.3;

  const rawLow  = range.low  * sizeMultiplier * sectorModifier * volumeMultiplier;
  const rawHigh = range.high * sizeMultiplier * sectorModifier * volumeMultiplier;

  const low      = Math.round(Math.min(rawLow,  PECR_CAP));
  const high     = Math.round(Math.min(rawHigh, PECR_CAP));

  // Single point estimate for dashboard display
  const estimate = Math.round(Math.min(low + (high - low) * position, PECR_CAP));

  return { low, high, estimate };
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

    // ── 1. Get user profile ──────────────────────────────────
    // Fetch businessSize, sector, and emailVolume from User_Profile.
    // Defaults to smb / ecommerce / medium_send if not set.
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
        businessSize = f.BusinessSize  || 'smb';
        sector       = f.Sector        || 'ecommerce';
        emailVolume  = f.EmailVolume   || 'medium_send';
      }
    } catch (e) {
      console.error('Profile load failed, using defaults:', e);
    }

    // ── 2. Deduplicate ───────────────────────────────────────
    // Skip if same fix already exists as pending for this source record.
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

    // ── 3. Calculate exposure ────────────────────────────────
    const exposure = calculateExposure(
      fixType,
      severity,
      businessSize,
      sector,
      emailVolume
    );

    // ── 4. Write fix record ──────────────────────────────────
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
              UserID:          userId,
              FixType:         fixType,
              Description:     description || `${fixType} violation detected by ${tool}`,
              Tool:            tool,
              Severity:        severity,
              ExposureLow:     exposure.low,
              ExposureHigh:    exposure.high,
              ExposureEstimate: exposure.estimate,
              Status:          'pending',
              Volume:          parseInt(volume) || null,
              SourceRecordID:  sourceRecordId || null,
              CreatedDate:     new Date().toISOString().split('T')[0],
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

    console.log(`Fix created: ${fixId} | ${fixType} | estimate £${exposure.estimate} | range £${exposure.low}–£${exposure.high}`);

    return res.json({
      success:         true,
      fixId,
      fixType,
      exposureLow:     exposure.low,
      exposureHigh:    exposure.high,
      exposureEstimate: exposure.estimate,
      description:     description || `${fixType} violation detected by ${tool}`,
    });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
