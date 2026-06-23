// ─────────────────────────────────────────────────────────────
// SENDWIZE — profile.js v6.1
// GET  /api/profile?action=get&userId=x
// POST /api/profile?action=save
// POST /api/profile?action=streak
//
// v6.1 changes:
//   - All Airtable calls now go through atFetch() (see _airtable.js)
//     which retries 429/5xx with backoff. Previously a single
//     Airtable 429 on the "create default profile" path in
//     handleGet (or on handleSave's PATCH/POST) surfaced as an
//     immediate 500 to the browser with no retry — this was the
//     direct cause of "Could not load compliance data" / 500s on
//     /api/profile seen during concurrent dashboard loads.
//   - fetchProfile's existing null-on-failure behaviour is kept
//     (still correct — a transient lookup failure should fall
//     through to "create default profile", not error out), but
//     the underlying fetch now retries first via atFetch so a
//     real 429 is far less likely to ever reach that fallback.
//
// v6.0 changes (carried forward):
//   - RevenueBand added throughout: fmt(), handleGet(), handleSave().
//   - handleSave: accepts revenueBand param. Validated against four
//     options matching Airtable single select exactly.
//   - handleGet: default profile creation does NOT set a default
//     RevenueBand — must be explicitly set via onboarding modal.
//     Null is the correct default: signals "not yet collected".
//   - handleSave: null stripping applied to all Airtable writes.
//   - sector / businessSize / emailVolume retained — legacy fields,
//     still used by older tool calls. Remove in Phase 3 cleanup.
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

// Returns { record, lookupFailed }. Never throws.
//   - record: the existing User_Profile record, or null if none exists
//   - lookupFailed: true only if the Airtable lookup itself failed (after
//     atFetch's internal retries) — NOT true when the lookup succeeded and
//     simply found zero records for this userId.
//
// This distinction matters: callers (handleGet in particular) must not
// treat "Airtable was temporarily unavailable" the same as "this is a new
// user." Previously both cases returned plain `null`, so a single transient
// lookup failure caused handleGet to create a brand-new default profile —
// silently duplicating the user's real profile row in Airtable and wiping
// out onboardingComplete, revenueBand, streaks, etc. on whichever read hit
// the duplicate next. That was the cause of the onboarding tour re-looping
// on every load: an intermittent lookup failure → a fresh profile row with
// OnboardingComplete unset → tour modal shown again, even though the user's
// original profile (with OnboardingComplete: true) still existed untouched.
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

// v6.0: revenueBand added. Null = not yet collected = show onboarding modal.
function fmt(record, userId) {
  const f = record.fields;
  return {
    profileId:        record.id,
    userId:           f.UserID           || userId,
    revenueBand:      f.RevenueBand      || null,   // v6.0 — null triggers onboarding modal
    sector:           f.Sector           || 'ecommerce',
    businessSize:     f.BusinessSize     || 'smb',
    emailVolume:      f.EmailVolume      || 'medium_send',
    email:            f.Email            || null,
    currentStreak:    f.CurrentStreak    || 0,
    longestStreak:    f.LongestStreak    || 0,
    lastCheckDate:    f.LastCheckDate    || null,
    lastAlertSent:    f.LastAlertSent    || null,
    lastBriefingSent:    f.LastBriefingSent    || null,
    onboardingComplete:  f.OnboardingComplete  || false,
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const { record: existing, lookupFailed } = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);
  if (existing) return res.json({ success: true, isDefault: false, ...fmt(existing, userId) });

  if (lookupFailed) {
    // Airtable lookup itself failed even after retries — we genuinely do
    // not know whether a profile already exists. Creating a new one here
    // would risk duplicating a real profile (and silently resetting
    // onboardingComplete, revenueBand, streaks, etc. on whichever record
    // gets read next). Degrade honestly instead: tell the dashboard we
    // couldn't confirm profile state, without writing anything.
    return res.status(200).json({
      success:      false,
      isDefault:    false,
      degraded:     true,
      reason:       'Could not confirm profile state — Airtable lookup failed',
      profileId:    null,
      userId,
      revenueBand:      null,
      sector:           'ecommerce',
      businessSize:     'smb',
      emailVolume:      'medium_send',
      email:            null,
      currentStreak:    0,
      longestStreak:    0,
      lastCheckDate:    null,
      lastAlertSent:    null,
      lastBriefingSent: null,
      // Deliberately NOT false here — false would re-trigger the onboarding
      // tour for a returning user just because of a transient read failure.
      // null signals "unknown" so the dashboard can choose to skip showing
      // the tour rather than assume the user is new.
      onboardingComplete: null,
    });
  }

  // Lookup succeeded and genuinely found no record — this really is a new user.
  // First login — create default profile.
  // RevenueBand deliberately omitted — null signals modal not yet shown.
  // Dashboard checks revenueBand === null on load and shows onboarding modal.
  const defaultFields = Object.fromEntries(Object.entries({
    UserID:       userId,
    Sector:       'ecommerce',
    BusinessSize: 'smb',
    EmailVolume:  'medium_send',
  }).filter(([, v]) => v !== null && v !== undefined));

  const createRes = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
    method:  'POST',
    headers: hdrs(AIRTABLE_TOKEN),
    body:    JSON.stringify({ records: [{ fields: defaultFields }] }),
  });

  if (!createRes.ok) {
    console.error('User_Profile create failed after retries:', createRes.status);
    // Airtable genuinely unavailable even after backoff — return a
    // usable fallback profile instead of a hard 500. The dashboard
    // already handles revenueBand:null by showing the onboarding modal,
    // so this degrades gracefully rather than blocking the whole load.
    return res.status(200).json({
      success:      false,
      isDefault:    true,
      degraded:     true,
      reason:       `Airtable temporarily unavailable (status ${createRes.status})`,
      profileId:    null,
      userId,
      revenueBand:      null,
      sector:           'ecommerce',
      businessSize:     'smb',
      emailVolume:      'medium_send',
      email:            null,
      currentStreak:    0,
      longestStreak:    0,
      lastCheckDate:    null,
      lastAlertSent:    null,
      lastBriefingSent: null,
      onboardingComplete: false,
    });
  }

  const created = await createRes.json();
  return res.json({
    success:   true,
    isDefault: true,
    // revenueBand: null — dashboard will show onboarding modal
    message:   'Profile created. Revenue band required to complete setup.',
    ...fmt(created.records[0], userId),
  });
}

// ── SAVE ──────────────────────────────────────────────────────
async function handleSave(req, res) {
  const { userId, revenueBand, sector, businessSize, emailVolume, email, onboardingComplete } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  // v6.0: RevenueBand — must match Airtable single select options exactly.
  const validRevenueBands = ['Under £1M', '£1M–£10M', '£10M–£50M', 'Over £50M'];
  const validSectors      = ['ecommerce', 'agency', 'finance', 'healthcare', 'other'];
  const validSizes        = ['micro', 'smb', 'midmarket'];
  const validVolumes      = ['micro_send', 'small_send', 'medium_send', 'large_send', 'enterprise_send'];
  if (revenueBand  && !validRevenueBands.includes(revenueBand))  return res.status(400).json({ error: `Invalid revenueBand. Must be one of: ${validRevenueBands.join(', ')}` });
  if (sector       && !validSectors.includes(sector))            return res.status(400).json({ error: `Invalid sector. Must be one of: ${validSectors.join(', ')}` });
  if (businessSize && !validSizes.includes(businessSize))        return res.status(400).json({ error: `Invalid businessSize. Must be one of: ${validSizes.join(', ')}` });
  if (emailVolume  && !validVolumes.includes(emailVolume))       return res.status(400).json({ error: `Invalid emailVolume. Must be one of: ${validVolumes.join(', ')}` });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const { record: existing } = await fetchProfile(userId, AIRTABLE_TOKEN, BASE_ID);

  // Build fields — null strip so we never overwrite existing values with null.
  const rawFields = {
    UserID:             userId,
    RevenueBand:        revenueBand        || null,
    Sector:             sector             || null,
    BusinessSize:       businessSize       || null,
    EmailVolume:        emailVolume        || null,
    Email:              email              || null,
    // OnboardingComplete is a checkbox — only set if explicitly passed
    ...(typeof onboardingComplete === 'boolean' ? { OnboardingComplete: onboardingComplete } : {}),
  };
  const fields = Object.fromEntries(
    Object.entries(rawFields).filter(([, v]) => v !== null && v !== undefined)
  );

  let record;
  if (existing) {
    const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
      method:  'PATCH',
      headers: hdrs(AIRTABLE_TOKEN),
      body:    JSON.stringify({ fields }),
    });
    if (!r.ok) {
      console.error('User_Profile patch failed after retries:', r.status);
      return res.status(r.status).json({ error: 'Failed to save profile — please try again' });
    }
    record = await r.json();
  } else {
    // No existing profile — create with sensible defaults for legacy fields.
    const createFields = Object.fromEntries(Object.entries({
      Sector:       'ecommerce',
      BusinessSize: 'smb',
      EmailVolume:  'medium_send',
      ...fields,   // passed values override defaults
    }).filter(([, v]) => v !== null && v !== undefined));
    const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile`, {
      method:  'POST',
      headers: hdrs(AIRTABLE_TOKEN),
      body:    JSON.stringify({ records: [{ fields: createFields }] }),
    });
    if (!r.ok) {
      console.error('User_Profile create failed after retries:', r.status);
      return res.status(r.status).json({ error: 'Failed to save profile — please try again' });
    }
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
      return res.json({
        success:      true,
        currentStreak,
        longestStreak,
        lastCheckDate,
        message:      'Streak already updated today',
      });
    } else if (lastStr === yesterdayStr) {
      newStreak = currentStreak + 1;
    }
  }

  const newLongest = Math.max(newStreak, longestStreak);
  const fields = Object.fromEntries(Object.entries({
    CurrentStreak: newStreak,
    LongestStreak: newLongest,
    LastCheckDate: todayStr,
  }).filter(([, v]) => v !== null && v !== undefined));

  const r = await atFetch(`https://api.airtable.com/v0/${BASE_ID}/User_Profile/${existing.id}`, {
    method:  'PATCH',
    headers: hdrs(AIRTABLE_TOKEN),
    body:    JSON.stringify({ fields }),
  });
  if (!r.ok) {
    console.error('Streak update failed after retries:', r.status);
    return res.status(r.status).json({ error: 'Failed to update streak' });
  }

  return res.json({
    success:         true,
    currentStreak:   newStreak,
    longestStreak:   newLongest,
    lastCheckDate:   todayStr,
    streakContinued: newStreak > 1,
  });
}
