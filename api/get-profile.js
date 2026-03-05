// ─────────────────────────────────────────────────────────────
// SENDWIZE — get-profile.js
// Returns the user's business profile from User_Profile table.
// If no profile exists yet, creates a default SMB/ecommerce
// record so exposure calculations always have a fallback.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── Look up existing profile ─────────────────────────────────
    const formula     = encodeURIComponent(`{UserID}="${userId}"`);
    const profileRes  = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile?filterByFormula=${formula}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
    );

    if (!profileRes.ok) {
      throw new Error(`Airtable fetch failed: ${profileRes.status}`);
    }

    const profileData = await profileRes.json();

    // ── Profile exists — return it ───────────────────────────────
    if (profileData.records && profileData.records.length > 0) {
      const fields = profileData.records[0].fields;
      return res.json({
        success:      true,
        profileId:    profileData.records[0].id,
        userId:       fields.UserID       || userId,
        sector:       fields.Sector       || 'ecommerce',
        businessSize: fields.BusinessSize || 'smb',
        emailVolume:  fields.EmailVolume  || 'low',
        isDefault:    false,
      });
    }

    // ── No profile yet — create default ─────────────────────────
    // This happens on first login. User prompted to update in Settings.
    console.log(`No profile found for ${userId}, creating default`);

    const createRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:       userId,
              Sector:       'ecommerce',
              BusinessSize: 'smb',
              EmailVolume:  'low',
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

    return res.json({
      success:      true,
      profileId:    createData.records[0].id,
      userId,
      sector:       'ecommerce',
      businessSize: 'smb',
      emailVolume:  'low',
      isDefault:    true,
      message:      'Default profile created. Update your business profile in Settings for more accurate exposure estimates.',
    });

  } catch (error) {
    console.error('get-profile error:', error);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
}
