// ─────────────────────────────────────────────────────────────
// SENDWIZE — profile.js v4.19
// GET  /api/profile?action=get&userId=x
// POST /api/profile?action=save
// POST /api/profile?action=streak
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  if (req.method === 'GET'  && action === 'get')    return handleGet(req, res);
  if (req.method === 'POST' && action === 'save')   return handleSave(req, res);
  if (req.method === 'POST' && action === 'streak') return handleStreak(req, res);
  return res.status(400).json({ error: 'Unknown action. Use ?action=get|save|streak' });
}

function hdrs(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Returns record or null — never throws.
async function fetchProfile(userId, token, baseId) {
  try {
    const r = await fetch(
      `https://api.airtable.com/v0/${baseId}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) { console.error('User_Profile fetch failed:', r.status); return null; }
    const d = await r.json();
    return d.records?.length > 0 ? d.records[0] : null;
  } catch (e) { console.error('fetchProfile error:', e); return null; }
}

function fmt(record, userId) {
  const f = record.fields;
  return {
    profileId:        record.id,
    userId:           f.UserID           || userId,
    sector:           f.Sector           || 'ecommerce',
    businessSize:     f.BusinessSize     || 'smb',
    emailVolume:      f.EmailVolume      || 'medium_send',
    email:            f.Email            || null,
    currentStreak:    f.CurrentStreak    || 0,
    longestStreak:    f.LongestStreak    || 0,
    lastCheckDate:    f.LastCheckDate    || null,
    lastAlertSent:    f.LastAlertSent    || null,
    lastBriefingSent: f.LastBriefingSent || null,
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
  if (existing) return res.json({ success: true, isDefault: false, ...fmt(existing, userId) });

  // First login — create default
  const createRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
    method:  'POST',
    headers: hdrs(AIRTABLE_TOKEN),
    body: JSON.stringify({ records: [{ fields: { UserID: userId, Sector: 'ecommerce', BusinessSize: 'smb', EmailVolume: 'medium_send' } }] }),
  });

  if (!createRes.ok) {
    console.error('User_Profile create failed:', createRes.status);
    return res.status(500).json({ error: 'Failed to create profile' });
  }

  const created = await createRes.json();
  return res.json({
    success:   true,
    isDefault: true,
    message:   'Default profile created. Update your business profile in Settings for accurate exposure estimates.',
    ...fmt(created.records[0], userId),
  });
}

// ── SAVE ──────────────────────────────────────────────────────
async function handleSave(req, res) {
  const { userId, sector, businessSize, emailVolume, email } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const validSectors  = ['ecommerce','agency','finance','healthcare','other'];
  const validSizes    = ['micro','smb','midmarket'];
  const validVolumes  = ['micro_send','small_send','medium_send','large_send','enterprise_send'];

  if (sector       && !validSectors.includes(sector))      return res.status(400).json({ error: `Invalid sector. Must be one of: ${validSectors.join(', ')}` });
  if (businessSize && !validSizes.includes(businessSize))  return res.status(400).json({ error: `Invalid businessSize. Must be one of: ${validSizes.join(', ')}` });
  if (emailVolume  && !validVolumes.includes(emailVolume)) return res.status(400).json({ error: `Invalid emailVolume. Must be one of: ${validVolumes.join(', ')}` });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);

  const fields = { UserID: userId };
  if (sector)       fields.Sector       = sector;
  if (businessSize) fields.BusinessSize = businessSize;
  if (emailVolume)  fields.EmailVolume  = emailVolume;
  if (email)        fields.Email        = email;

  let record;
  if (existing) {
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
      method: 'PATCH', headers: hdrs(AIRTABLE_TOKEN), body: JSON.stringify({ fields }),
    });
    if (!r.ok) { console.error('User_Profile patch failed:', r.status); return res.status(r.status).json({ error: 'Failed to save profile' }); }
    record = await r.json();
  } else {
    fields.Sector       = fields.Sector       || 'ecommerce';
    fields.BusinessSize = fields.BusinessSize || 'smb';
    fields.EmailVolume  = fields.EmailVolume  || 'medium_send';
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
      method: 'POST', headers: hdrs(AIRTABLE_TOKEN), body: JSON.stringify({ records: [{ fields }] }),
    });
    if (!r.ok) { console.error('User_Profile create failed:', r.status); return res.status(r.status).json({ error: 'Failed to save profile' }); }
    record = (await r.json()).records[0];
  }

  return res.json({ success: true, ...fmt(record, userId) });
}

// ── STREAK ────────────────────────────────────────────────────
async function handleStreak(req, res) {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const existing = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
  if (!existing) return res.status(404).json({ error: 'Profile not found. Call ?action=get first.' });

  const f             = existing.fields;
  const today         = new Date();
  const todayStr      = today.toISOString().split('T')[0];
  const lastCheckDate = f.LastCheckDate || null;
  const currentStreak = f.CurrentStreak || 0;
  const longestStreak = f.LongestStreak || 0;

  let newStreak = 1;
  if (lastCheckDate) {
    const last      = new Date(lastCheckDate);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastStr      = last.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastStr === todayStr) {
      return res.json({ success: true, currentStreak, longestStreak, lastCheckDate, message: 'Streak already updated today' });
    } else if (lastStr === yesterdayStr) {
      newStreak = currentStreak + 1;
    }
  }

  const newLongest = Math.max(newStreak, longestStreak);

  const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
    method:  'PATCH',
    headers: hdrs(AIRTABLE_TOKEN),
    body:    JSON.stringify({ fields: { CurrentStreak: newStreak, LongestStreak: newLongest, LastCheckDate: todayStr } }),
  });

  if (!r.ok) {
    console.error('Streak update failed:', r.status);
    return res.status(r.status).json({ error: 'Failed to update streak' });
  }

  return res.json({ success: true, currentStreak: newStreak, longestStreak: newLongest, lastCheckDate: todayStr, streakContinued: newStreak > 1 });
}
