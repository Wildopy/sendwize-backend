// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js
// Called by all 5 tools when a violation is found.
// Creates a record in Compliance_Fixes table.
// Calculates exposure range from ICO/ASA reference data
// multiplied by the user's business profile.
// Deduplicates — same fixType + sourceRecordId = skip.
// ─────────────────────────────────────────────────────────────

// Hardcoded exposure ranges based on real ICO/ASA/CMA enforcement.
// Update these as new enforcement actions are published.
const EXPOSURE_RANGES = {
  expired_consent:     { low: 150,   high: 500,    scaled: true  },
  missing_unsubscribe: { low: 8000,  high: 80000,  scaled: true  },
  misleading_claim:    { low: 5000,  high: 500000, scaled: false },
  no_dpa:              { low: 3000,  high: 28000,  scaled: false },
  fake_urgency:        { low: 2000,  high: 30000,  scaled: false },
  missing_address:     { low: 1000,  high: 12000,  scaled: false },
  no_privacy_policy:   { low: 1000,  high: 17500,  scaled: false },
  suppressed_contact:  { low: 200,   high: 1000,   scaled: true  },
  reconsent_sent:      { low: 0,     high: 0,      scaled: false },
};

// Business size multipliers (based on ICO's approach to scaling penalties)
const SIZE_MULTIPLIERS = {
  micro:     0.4,
  smb:       1.0,
  midmarket: 2.2,
};

// Sector risk modifiers (healthcare/finance face higher regulatory scrutiny)
const SECTOR_MODIFIERS = {
  ecommerce:  1.0,
  agency:     1.0,
  other:      1.0,
  finance:    1.4,
  healthcare: 1.8,
};

function calculateExposure(fixType, volume, businessSize, sector) {
  const range = EXPOSURE_RANGES[fixType];
  if (!range) return { low: 0, high: 0 };

  const sizeMultiplier = SIZE_MULTIPLIERS[businessSize] || 1.0;
  const sectorModifier = SECTOR_MODIFIERS[sector]       || 1.0;
  const volumeFactor   = (range.scaled && volume > 0) ? volume : 1;

  return {
    low:  Math.round(range.low  * volumeFactor * sizeMultiplier * sectorModifier),
    high: Math.round(range.high * volumeFactor * sizeMultiplier * sectorModifier),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, fixType, description, tool, severity, volume, sourceRecordId } = req.body;

    if (!userId || !fixType || !tool || !severity) {
      return res.status(400).json({ error: 'Missing required fields: userId, fixType, tool, severity' });
    }

    if (!EXPOSURE_RANGES[fixType]) {
      return res.status(400).json({ error: `Unknown fixType: ${fixType}` });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── 1. Get user business profile (defaults to SMB/ecommerce if not set) ──
    let businessSize = 'smb';
    let sector       = 'ecommerce';

    try {
      const profileRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula={UserID}="${userId}"&maxRecords=1`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
      );
      const profileData = await profileRes.json();
      if (profileData.records && profileData.records.length > 0) {
        businessSize = profileData.records[0].fields.BusinessSize || 'smb';
        sector       = profileData.records[0].fields.Sector       || 'ecommerce';
      }
    } catch (e) {
      console.error('Profile load failed, using defaults:', e);
    }

    // ── 2. Deduplicate — skip if same fix already pending ────────
    if (sourceRecordId) {
      try {
        const formula  = `AND({UserID}="${userId}",{FixType}="${fixType}",{SourceRecordID}="${sourceRecordId}",{Status}="pending")`;
        const dupeRes  = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`,
          { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const dupeData = await dupeRes.json();
        if (dupeData.records && dupeData.records.length > 0) {
          console.log(`Duplicate fix skipped: ${fixType} / ${sourceRecordId}`);
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

    // ── 3. Calculate exposure range ──────────────────────────────
    const safeVolume = parseInt(volume) || 0;
    const exposure   = calculateExposure(fixType, safeVolume, businessSize, sector);

    // ── 4. Create fix record ─────────────────────────────────────
    const createRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:         userId,
              FixType:        fixType,
              Description:    description || `${fixType} violation detected by ${tool}`,
              Tool:           tool,
              Severity:       severity,
              ExposureLow:    exposure.low,
              ExposureHigh:   exposure.high,
              Status:         'pending',
              Volume:         safeVolume || null,
              SourceRecordID: sourceRecordId || null,
              CreatedDate:    new Date().toISOString().split('T')[0],
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

    console.log(`Fix created: ${fixId} | ${fixType} | £${exposure.low}–£${exposure.high}`);

    return res.json({
      success:     true,
      fixId,
      fixType,
      exposureLow:  exposure.low,
      exposureHigh: exposure.high,
      description:  description || `${fixType} violation detected by ${tool}`,
    });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
