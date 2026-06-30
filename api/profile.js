// ─────────────────────────────────────────────────────────────
// SENDWIZE — profile.js v6.2 (beta)
// v6.2: Extended validSectors to match audience-read.js BENCHMARKS.
//       Added AverageOrderValue to accepted fields + fmt() output.
//       All other code identical to v6.1.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

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

async function fetchProfile(userId, token, baseId) {
  try {
    const r = await atFetch(
      `https://api.airtable.com/v0/${baseId}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) {
      console.error('User_Profile fetch failed after retries:', r.status);
      return { record: null, lookupFailed: true };
    }
    const d = await r.json();
    const record = d.records?.length > 0 ? d.records[0] : null;
    return { record, lookupFailed: false };
  } catch (e) {
    console.error('fetchProfile error:', e);
    return { record: null, lookupFailed: true };
  }
}

function fmt(record, userId) {
  const f = record.fields;
  return {
    profileId:          record.id,
    userId:             f.UserID           || userId,
    revenueBand:        f.RevenueBand      || null,
    sector:             f.Sector           || 'ecommerce',
    businessSize:       f.BusinessSize     || 'smb',
    emailVolume:        f.EmailVolume      || 'medium_send',
    email:              f.Email            || null,
    currentStreak:      f.CurrentStreak    || 0,
    longestStreak:      f.LongestStreak    || 0,
    lastCheckDate:      f.LastCheckDate    || null,
    lastAlertSent:      f.LastAlertSent    || null,
    lastBriefingSent:   f.LastBriefingSent || null,
    onboardingComplete: f.OnboardingComplete || false,
    averageOrderValue:  f.AverageOrderValue  || null,
  };
}

async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const { record: existing, lookupFailed } = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
  if (existing) return res.json({ success: true, isDefault: false, ...fmt(existing, userId) });

  if (lookupFailed) {
    return res.status(200).json({
      success: false, isDefault: false, degraded: true,
      reason: 'Could not confirm profile state — Airtable lookup failed',
      profileId: null, userId,
      revenueBand: null, sector: 'ecommerce', businessSize: 'smb',
      emailVolume: 'medium_send', email: null,
      currentStreak: 0, longestStreak: 0, lastCheckDate: null,
      lastAlertSent: null, lastBriefingSent: null,
      onboardingComplete: null, averageOrderValue: null,
    });
  }

  const defaultFields = Object.fromEntries(Object.entries({
    UserID: userId, Sector: 'ecommerce', BusinessSize: 'smb', EmailVolume: 'medium_send',
  }).filter(([, v]) => v !== null && v !== undefined));

  const createRes = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
    method: 'POST', headers: hdrs(AIRTABLE_TOKEN),
    body: JSON.stringify({ records: [{ fields: defaultFields }] }),
  });

  if (!createRes.ok) {
    console.error('User_Profile create failed after retries:', createRes.status);
    return res.status(200).json({
      success: false, isDefault: true, degraded: true,
      reason: `Airtable temporarily unavailable (status ${createRes.status})`,
      profileId: null, userId,
      revenueBand: null, sector: 'ecommerce', businessSize: 'smb',
      emailVolume: 'medium_send', email: null,
      currentStreak: 0, longestStreak: 0, lastCheckDate: null,
      lastAlertSent: null, lastBriefingSent: null,
      onboardingComplete: false, averageOrderValue: null,
    });
  }

  const created = await createRes.json();
  return res.json({ success: true, isDefault: true,
    message: 'Profile created. Revenue band required to complete setup.',
    ...fmt(created.records[0], userId),
  });
}

async function handleSave(req, res) {
  const { userId, revenueBand, sector, businessSize, emailVolume, email, onboardingComplete, averageOrderValue } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const validRevenueBands = ['Under £1M', '£1M–£10M', '£10M–£50M', 'Over £50M'];
  const validSectors      = ['ecommerce', 'agency', 'finance', 'healthcare', 'b2b', 'saas', 'media', 'charity', 'other'];
  const validSizes        = ['micro', 'smb', 'midmarket'];
  const validVolumes      = ['micro_send', 'small_send', 'medium_send', 'large_send', 'enterprise_send'];
  if (revenueBand  && !validRevenueBands.includes(revenueBand))  return res.status(400).json({ error: `Invalid revenueBand. Must be one of: ${validRevenueBands.join(', ')}` });
  if (sector       && !validSectors.includes(sector))            return res.status(400).json({ error: `Invalid sector. Must be one of: ${validSectors.join(', ')}` });
  if (businessSize && !validSizes.includes(businessSize))        return res.status(400).json({ error: `Invalid businessSize. Must be one of: ${validSizes.join(', ')}` });
  if (emailVolume  && !validVolumes.includes(emailVolume))       return res.status(400).json({ error: `Invalid emailVolume. Must be one of: ${validVolumes.join(', ')}` });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const { record: existing } = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);

  const rawFields = {
    UserID:             userId,
    RevenueBand:        revenueBand        || null,
    Sector:             sector             || null,
    BusinessSize:       businessSize       || null,
    EmailVolume:        emailVolume        || null,
    Email:              email              || null,
    AverageOrderValue:  (typeof averageOrderValue === 'number' && averageOrderValue > 0) ? averageOrderValue : null,
    ...(typeof onboardingComplete === 'boolean' ? { OnboardingComplete: onboardingComplete } : {}),
  };
  const fields = Object.fromEntries(
    Object.entries(rawFields).filter(([, v]) => v !== null && v !== undefined)
  );

  let record;
  if (existing) {
    const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
      method: 'PATCH', headers: hdrs(AIRTABLE_TOKEN),
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) {
      console.error('User_Profile patch failed after retries:', r.status);
      return res.status(r.status).json({ error: 'Failed to save profile — please try again' });
    }
    record = await r.json();
  } else {
    const createFields = Object.fromEntries(Object.entries({
      Sector: 'ecommerce', BusinessSize: 'smb', EmailVolume: 'medium_send',
      ...fields,
    }).filter(([, v]) => v !== null && v !== undefined));
    const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
      method: 'POST', headers: hdrs(AIRTABLE_TOKEN),
      body: JSON.stringify({ records: [{ fields: createFields }] }),
    });
    if (!r.ok) {
      console.error('User_Profile create failed after retries:', r.status);
      return res.status(r.status).json({ error: 'Failed to save profile — please try again' });
    }
    record = (await r.json()).records[0];
  }

  return res.json({ success: true, ...fmt(record, userId) });
}

async function handleStreak(req, res) {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const { record: existing } = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
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
  const fields = Object.fromEntries(Object.entries({
    CurrentStreak: newStreak, LongestStreak: newLongest, LastCheckDate: todayStr,
  }).filter(([, v]) => v !== null && v !== undefined));

  const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
    method: 'PATCH', headers: hdrs(AIRTABLE_TOKEN),
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    console.error('Streak update failed after retries:', r.status);
    return res.status(r.status).json({ error: 'Failed to update streak' });
  }

  return res.json({ success: true, currentStreak: newStreak, longestStreak: newLongest, lastCheckDate: todayStr, streakContinued: newStreak > 1 });
}
