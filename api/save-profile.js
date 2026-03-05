// ─────────────────────────────────────────────────────────────
// SENDWIZE — save-profile.js
// Saves the user's business profile (sector, size, volume).
// After saving, recalculates ExposureLow + ExposureHigh on
// all pending fixes so they reflect the updated profile.
// ─────────────────────────────────────────────────────────────

// Must match generate-fix.js exactly
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

const SIZE_MULTIPLIERS = { micro: 0.4, smb: 1.0, midmarket: 2.2 };
const SECTOR_MODIFIERS = { ecommerce: 1.0, agency: 1.0, other: 1.0, finance: 1.4, healthcare: 1.8 };

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
    const { userId, sector, businessSize, emailVolume } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── Find existing profile record ─────────────────────────────
    const formula    = encodeURIComponent(`{UserID}="${userId}"`);
    const findRes    = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula=${formula}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const findData   = await findRes.json();
    const profileId  = findData.records && findData.records.length > 0
      ? findData.records[0].id
      : null;

    const newSector      = sector       || 'ecommerce';
    const newSize        = businessSize || 'smb';
    const newVolume      = emailVolume  || 'low';

    // ── Create or update profile ─────────────────────────────────
    if (profileId) {
      await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile/${profileId}`,
        {
          method:  'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            fields: { Sector: newSector, BusinessSize: newSize, EmailVolume: newVolume },
          }),
        }
      );
    } else {
      await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            records: [{ fields: { UserID: userId, Sector: newSector, BusinessSize: newSize, EmailVolume: newVolume } }],
          }),
        }
      );
    }

    console.log(`Profile saved for ${userId}: ${newSize} / ${newSector}`);

    // ── Recalculate exposure on all pending fixes ────────────────
    // Fetch all pending fixes for this user
    const fixFormula  = encodeURIComponent(`AND({UserID}="${userId}",{Status}="pending")`);
    const fixesRes    = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula=${fixFormula}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const fixesData   = await fixesRes.json();
    const pendingFixes = fixesData.records || [];

    // Batch update each fix with recalculated exposure
    // Airtable allows max 10 records per batch PATCH
    if (pendingFixes.length > 0) {
      const batches = [];
      for (let i = 0; i < pendingFixes.length; i += 10) {
        batches.push(pendingFixes.slice(i, i + 10));
      }

      for (const batch of batches) {
        const records = batch.map(fix => {
          const volume   = fix.fields.Volume || 0;
          const exposure = calculateExposure(fix.fields.FixType, volume, newSize, newSector);
          return {
            id:     fix.id,
            fields: { ExposureLow: exposure.low, ExposureHigh: exposure.high },
          };
        });

        await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes`,
          {
            method:  'PATCH',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify({ records }),
          }
        );
      }

      console.log(`Recalculated exposure for ${pendingFixes.length} pending fixes`);
    }

    return res.json({
      success:         true,
      sector:          newSector,
      businessSize:    newSize,
      emailVolume:     newVolume,
      fixesUpdated:    pendingFixes.length,
      message:         'Profile saved. All pending exposure estimates have been updated.',
    });

  } catch (error) {
    console.error('save-profile error:', error);
    return res.status(500).json({ error: 'Failed to save profile' });
  }
}
