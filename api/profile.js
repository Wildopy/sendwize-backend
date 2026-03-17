// ─────────────────────────────────────────────────────────────
// SENDWIZE — profile.js
// Manages user business profile, streak tracking, and alert
// timestamps. All actions routed via ?action= parameter.
//
// GET  /api/profile?action=get&userId=x   → get profile
// POST /api/profile?action=save           → save/update profile
// POST /api/profile?action=streak         → increment streak
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  if (req.method === 'GET'  && action === 'get')    return handleGet(req, res);
  if (req.method === 'POST' && action === 'save')   return handleSave(req, res);
  if (req.method === 'POST' && action === 'streak') return handleStreak(req, res);

  return res.status(400).json({ error: 'Unknown action. Use ?action=get|save|streak' });
}

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

function getAirtableHeaders(token) {
  return {
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function fetchProfile(userId, token, baseId) {
  const formula    = encodeURIComponent(`{UserID}="${userId}"`);
  const profileRes = await fetch(
    `https://api.airtable.com/v0/${baseId}/User_Profile?filterByFormula=${formula}&maxRecords=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!profileRes.ok) throw new Error(`Airtable fetch failed: ${profileRes.status}`);
  const data = await profileRes.json();
  return data.records?.length > 0 ? data.records[0] : null;
}

function formatProfile(record, userId) {
  const f = record.fields;
  return {
    profileId:        record.id,
    userId:           f.UserID          || userId,
    sector:           f.Sector          || 'ecommerce',
    businessSize:     f.BusinessSize    || 'smb',
    emailVolume:      f.EmailVolume     || 'medium_send',
    email:            f.Email           || null,
    currentStreak:    f.CurrentStreak   || 0,
    longestStreak:    f.LongestStreak   || 0,
    lastCheckDate:    f.LastCheckDate   || null,
    lastAlertSent:    f.LastAlertSent   || null,
    lastBriefingSent: f.LastBriefingSent || null,
  };
}

// ─────────────────────────────────────────────────────────────
// GET /api/profile?action=get&userId=x
// Returns profile. Creates default SMB/ecommerce/medium_send
// profile on first login if none exists.
// ─────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);

    // Profile exists — return it
    if (existing) {
      return res.json({
        success:   true,
        isDefault: false,
        ...formatProfile(existing, userId),
      });
    }

    // No profile yet — create default on first login
    console.log(`No profile found for ${userId} — creating default`);
    const createRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile`,
      {
        method:  'POST',
        headers: getAirtableHeaders(AIRTABLE_TOKEN),
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:       userId,
              Sector:       'ecommerce',
              BusinessSize: 'smb',
              EmailVolume:  'medium_send',
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
      isDefault:    true,
      message:      'Default profile created. Update your business profile in Settings for accurate exposure estimates.',
      ...formatProfile(createData.records[0], userId),
    });

  } catch (error) {
    console.error('profile get error:', error);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/profile?action=save
// Body: { userId, sector, businessSize, emailVolume, email }
// Creates or updates the profile record.
// Only updates fields that are explicitly passed in the body —
// omitted fields are left unchanged.
// ─────────────────────────────────────────────────────────────

async function handleSave(req, res) {
  try {
    const {
      userId,
      sector,
      businessSize,
      emailVolume,
      email,
    } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    // Validate values against known options
    const validSectors      = ['ecommerce','agency','finance','healthcare','other'];
    const validSizes        = ['micro','smb','midmarket'];
    const validVolumes      = ['micro_send','small_send','medium_send','large_send','enterprise_send'];

    if (sector       && !validSectors.includes(sector))      return res.status(400).json({ error: `Invalid sector. Must be one of: ${validSectors.join(', ')}` });
    if (businessSize && !validSizes.includes(businessSize))  return res.status(400).json({ error: `Invalid businessSize. Must be one of: ${validSizes.join(', ')}` });
    if (emailVolume  && !validVolumes.includes(emailVolume)) return res.status(400).json({ error: `Invalid emailVolume. Must be one of: ${validVolumes.join(', ')}` });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);

    // Build fields object — only include what was passed
    const fields = { UserID: userId };
    if (sector)       fields.Sector       = sector;
    if (businessSize) fields.BusinessSize = businessSize;
    if (emailVolume)  fields.EmailVolume  = emailVolume;
    if (email)        fields.Email        = email;

    let record;

    if (existing) {
      // Update existing record
      const updateRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`,
        {
          method:  'PATCH',
          headers: getAirtableHeaders(AIRTABLE_TOKEN),
          body:    JSON.stringify({ fields }),
        }
      );
      if (!updateRes.ok) throw new Error(`Airtable update failed: ${await updateRes.text()}`);
      record = await updateRes.json();
    } else {
      // Create new record with defaults for any missing fields
      fields.Sector       = fields.Sector       || 'ecommerce';
      fields.BusinessSize = fields.BusinessSize || 'smb';
      fields.EmailVolume  = fields.EmailVolume  || 'medium_send';

      const createRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/User_Profile`,
        {
          method:  'POST',
          headers: getAirtableHeaders(AIRTABLE_TOKEN),
          body:    JSON.stringify({ records: [{ fields }] }),
        }
      );
      if (!createRes.ok) throw new Error(`Airtable create failed: ${await createRes.text()}`);
      const createData = await createRes.json();
      record = createData.records[0];
    }

    console.log(`Profile saved for ${userId}`);
    return res.json({
      success: true,
      ...formatProfile(record, userId),
    });

  } catch (error) {
    console.error('profile save error:', error);
    return res.status(500).json({ error: 'Failed to save profile' });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/profile?action=streak
// Body: { userId }
// Called after every successful AI checker or PECR check.
// If LastCheckDate was today or yesterday → increment streak.
// Otherwise → reset to 1.
// Updates LongestStreak if current exceeds it.
// ─────────────────────────────────────────────────────────────

async function handleStreak(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
    if (!existing) return res.status(404).json({ error: 'Profile not found. Call ?action=get first to create default.' });

    const f               = existing.fields;
    const today           = new Date();
    const todayStr        = today.toISOString().split('T')[0];
    const lastCheckDate   = f.LastCheckDate || null;
    const currentStreak   = f.CurrentStreak || 0;
    const longestStreak   = f.LongestStreak || 0;

    // Work out if streak continues or resets
    let newStreak = 1;
    if (lastCheckDate) {
      const last      = new Date(lastCheckDate);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const lastStr      = last.toISOString().split('T')[0];
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (lastStr === todayStr) {
        // Already checked today — don't increment, just return current
        return res.json({
          success:        true,
          currentStreak,
          longestStreak,
          lastCheckDate,
          message:        'Streak already updated today',
        });
      } else if (lastStr === yesterdayStr) {
        // Checked yesterday — continue streak
        newStreak = currentStreak + 1;
      }
      // else: gap of 2+ days — reset to 1
    }

    const newLongest = Math.max(newStreak, longestStreak);

    const updateRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`,
      {
        method:  'PATCH',
        headers: getAirtableHeaders(AIRTABLE_TOKEN),
        body:    JSON.stringify({
          fields: {
            CurrentStreak: newStreak,
            LongestStreak: newLongest,
            LastCheckDate: todayStr,
          },
        }),
      }
    );

    if (!updateRes.ok) throw new Error(`Airtable update failed: ${await updateRes.text()}`);

    console.log(`Streak updated for ${userId}: ${newStreak} (longest: ${newLongest})`);
    return res.json({
      success:        true,
      currentStreak:  newStreak,
      longestStreak:  newLongest,
      lastCheckDate:  todayStr,
      streakContinued: newStreak > 1,
    });

  } catch (error) {
    console.error('profile streak error:', error);
    return res.status(500).json({ error: 'Failed to update streak' });
  }
}
