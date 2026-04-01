// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v4.19
// Router: ?action=report | vendors | violations | load | history
//         | register | summary | score-history | send-alert
//         | briefing | consent-expiry-check | simulation-run
//
// GET    /api/data?action=report&recordId=x&type=ai|email|audit|vendor|suppression|brief|dossier
// GET    /api/data?action=vendors
// GET    /api/data?action=violations&violationType=x&keyword=x
// POST   /api/data?action=load  { userId }
// GET    /api/data?action=history&type=audit|vendor&userId=x
// POST   /api/data?action=register  { userId, recordId?, vendor: { ... } }
// DELETE /api/data?action=register&recordId=x
// GET    /api/data?action=summary&userId=x
// GET    /api/data?action=score-history&userId=x&limit=30
// POST   /api/data?action=score-history  { userId, score, pending, completed, exposureLow, exposureHigh, triggerEvent }
// POST   /api/data?action=send-alert  { userId, alertType, score?, scoreChange?, exposureHigh? }
// GET    /api/data?action=briefing&userId=x
// POST   /api/data?action=consent-expiry-check  { userId }
// POST   /api/data?action=simulation-run  { userId, regulator }
// ─────────────────────────────────────────────────────────────

const APP_URL     = 'https://sendwize-backend.vercel.app';
const RESEND_FROM = 'alerts@sendwize.co.uk';

// ── REPORT handler ────────────────────────────────────────────
// Fetches a single record by ID from a named table.
// Submissions removed — PECR questionnaire tool no longer exists.
async function handleReport(req, res) {
  const { recordId, type } = req.query;
  if (!recordId || !type) return res.status(400).json({ error: 'Missing recordId or type' });

  const tables = {
    ai:          'AI_Compliance_Checks',
    email:       'Email_Scans',
    audit:       'Database_Audits',
    vendor:      'Vendor_Register',
    suppression: 'Suppression_Checks',
    brief:       'Brief_Checks',
    dossier:     'Campaign_Dossiers',
  };

  const tableName = tables[type];
  if (!tableName) return res.status(400).json({ error: 'Invalid report type' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${tableName}/${recordId}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable report fetch failed:', response.status);
    return res.status(response.status).json({ error: 'Failed to fetch report' });
  }

  return res.json(await response.json());
}

// ── VENDORS handler ───────────────────────────────────────────
// Reads from Marketing_Vendors (actual Airtable table name).
// Field names below match the 7-dimension spec (8.8).
// ⚠ ACTION REQUIRED: Marketing_Vendors fields need migrating from
// old schema (Category, ComplianceScore, etc) to 7-dimension schema
// (ICORegistrationStatus, DPAStatus, etc) in Airtable before this
// handler returns useful data.
async function handleVendors(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?sort[0][field]=VendorName&sort[0][direction]=asc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Marketing_Vendors fetch failed:', response.status);
    return res.json({ vendors: [] });
  }

  const data    = await response.json();
  const vendors = (data.records || []).map(r => ({
    name:                  r.fields.VendorName                     || '',
    vendorType:            r.fields.VendorType                     || '',
    icoRegistrationStatus: r.fields.ICORegistrationStatus          || 'Unknown',
    icoRegistrationNumber: r.fields.ICORegistrationNumber          || '',
    dpaStatus:             r.fields.DPAStatus                      || 'Unknown',
    dpaLink:               r.fields.DPALink                        || '',
    internationalTransfer: r.fields.InternationalTransferMechanism || 'Unknown',
    knownBreachHistory:    r.fields.KnownBreachHistory             || '',
    dpoPresence:           r.fields.DPOPresence                    || 'Unknown',
    isoAccreditation:      r.fields.ISOAccreditation               || 'Unknown',
    privacyPolicyNotes:    r.fields.PrivacyPolicyNotes             || '',
    lastVerified:          r.fields.LastVerified                   || '',
  }));

  return res.json({ vendors });
}

// ── VIOLATIONS handler ────────────────────────────────────────
// ⚠ Violation_Database still contains hallucinated cases per spec
// warning. Do not rely on enforcement_note data until the table
// has been manually audited and verified.
async function handleViolations(req, res) {
  const { violationType, keyword } = req.query;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const filters = [];
  if (violationType) filters.push(`{ViolationType}='${violationType}'`);
  if (keyword) {
    const kw = keyword.toLowerCase();
    filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
  }

  const formula = filters.length > 0 ? `AND(${filters.join(',')})` : '';
  const url = `https://api.airtable.com/v0/${BASE_ID}/Violation_Database` +
    (formula ? `?filterByFormula=${encodeURIComponent(formula)}&` : '?') +
    `sort[0][field]=DateOfAction&sort[0][direction]=desc&maxRecords=20`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to fetch violations' });

  const data       = await response.json();
  const violations = data.records || [];
  const totalFines = violations.reduce((sum, v) => sum + (v.fields.FineAmount || 0), 0);

  return res.json({
    violations,
    stats: {
      total:     violations.length,
      totalFines,
      avgFine:   violations.length ? Math.round(totalFines / violations.length) : 0,
    },
  });
}

// ── LOAD handler ──────────────────────────────────────────────
// Returns aggregated compliance data for a userId via fixes.js.
async function handleLoad(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const fixesRes = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  if (!fixesRes.ok) {
    console.error('fixes.js load failed:', fixesRes.status);
    return res.status(fixesRes.status).json({ error: 'Failed to load compliance data' });
  }

  return res.status(200).json(await fixesRes.json());
}

// ── HISTORY handler ───────────────────────────────────────────
async function handleHistory(req, res) {
  const { type, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!type || !['audit', 'vendor'].includes(type)) {
    return res.status(400).json({ error: 'type must be audit or vendor' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const tableMap = {
    audit:  { table: 'Database_Audits', sort: 'AuditDate'   },
    vendor: { table: 'Vendor_Register', sort: 'LastChecked'  },
  };

  const { table, sort } = tableMap[type];
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}` +
    `?filterByFormula={UserID}='${userId}'` +
    `&sort[0][field]=${sort}&sort[0][direction]=desc` +
    `&maxRecords=10`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!response.ok) {
    console.error(`Airtable history (${type}) fetch failed:`, response.status);
    return res.status(response.status).json({ error: `Failed to fetch ${type} history` });
  }

  return res.json({ records: (await response.json()).records || [] });
}

// ── REGISTER handler ──────────────────────────────────────────
// Manages per-user Vendor_Register records.
// Vendor_Register stores only what the USER manages:
//   VendorName, VendorType, DPASigned, DPALink, LastChecked, Notes.
// The 7-dimension research data (ICO status, breach history etc.)
// lives in Marketing_Vendors (Sendwize-maintained) and is read at
// query time — it is NOT duplicated into Vendor_Register per user.
async function handleRegister(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const airtableBase   = `https://api.airtable.com/v0/${BASE_ID}`;
  const authHeader     = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });

    const response = await fetch(`${airtableBase}/Vendor_Register/${recordId}`, {
      method: 'DELETE', headers: authHeader
    });
    if (!response.ok) {
      console.error('Vendor_Register delete failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to delete vendor' });
    }
    return res.json({ deleted: true });
  }

  if (req.method === 'POST') {
    const { userId, recordId, vendor } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!vendor) return res.status(400).json({ error: 'vendor data required' });

    // Only user-managed fields written here.
    // Research dimensions (ICO status, breach history etc.) are read
    // from Marketing_Vendors at query time, not stored per user.
    const fields = {
      UserID:     userId,
      VendorName: vendor.VendorName  || '',
      VendorType: vendor.VendorType  || '',
      DPASigned:  vendor.DPASigned   || '',
      DPALink:    vendor.DPALink     || '',
      Notes:      vendor.Notes       || '',
    };

    Object.keys(fields).forEach(k => { if (!fields[k]) delete fields[k]; });

    if (recordId) {
      const response = await fetch(`${airtableBase}/Vendor_Register/${recordId}`, {
        method: 'PATCH',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      if (!response.ok) {
        console.error('Vendor_Register patch failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to update vendor' });
      }
      return res.json({ record: await response.json() });

    } else {
      fields.LastChecked = new Date().toISOString().split('T')[0];
      const response = await fetch(`${airtableBase}/Vendor_Register`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields }] })
      });
      if (!response.ok) {
        console.error('Vendor_Register post failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to save vendor' });
      }
      const data = await response.json();
      return res.json({ record: data.records?.[0] || data });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SUMMARY handler ───────────────────────────────────────────
// GET ?action=summary&userId=x
// Aggregates score, exposure, fix counts, and streak for the
// dashboard summary card. Calls fixes.js and profile.js in parallel.
async function handleSummary(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const [fixesRes, profileRes] = await Promise.all([
    fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`),
    fetch(`${APP_URL}/api/profile?action=get&userId=${userId}`)
  ]);

  const fixesData   = fixesRes.ok   ? await fixesRes.json()   : null;
  const profileData = profileRes.ok ? await profileRes.json() : null;

  return res.json({
    score:          fixesData?.score                      ?? 0,
    scoreBand:      fixesData?.scoreBand                  ?? 'Not Started',
    pendingCount:   fixesData?.fixes?.pending?.length     ?? 0,
    completedCount: fixesData?.fixes?.completed?.length   ?? 0,
    exposure: {
      pendingLow:  fixesData?.exposure?.pendingLow        ?? 0,
      pendingHigh: fixesData?.exposure?.pendingHigh       ?? 0,
      savedLow:    fixesData?.exposure?.savedLow          ?? 0,
      savedHigh:   fixesData?.exposure?.savedHigh         ?? 0,
    },
    streak:         profileData?.currentStreak            ?? 0,
    longestStreak:  profileData?.longestStreak            ?? 0,
    lastCheckDate:  profileData?.lastCheckDate            ?? null,
  });
}

// ── SCORE-HISTORY handler ─────────────────────────────────────
// GET  ?action=score-history&userId=x&limit=30  → snapshots[]
// POST ?action=score-history  { userId, score, ... }
//   Writes snapshot, calculates delta, fires score-drop alert
//   if drop >= 10 points and alert not already sent today.
async function handleScoreHistory(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const airtableBase   = `https://api.airtable.com/v0/${BASE_ID}`;
  const headers        = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  if (req.method === 'GET') {
    const { userId, limit = '30' } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const maxRecords = Math.min(parseInt(limit, 10) || 30, 90);
    const response   = await fetch(
      `${airtableBase}/Score_History?filterByFormula={UserID}='${userId}'&sort[0][field]=Date&sort[0][direction]=desc&maxRecords=${maxRecords}`,
      { headers }
    );

    if (!response.ok) {
      console.error('Score_History fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch score history' });
    }

    const snapshots = ((await response.json()).records || []).map(r => ({
      id:           r.id,
      date:         r.fields.Date          || '',
      score:        r.fields.Score         || 0,
      pending:      r.fields.Pending       || 0,
      completed:    r.fields.Completed     || 0,
      exposureLow:  r.fields.ExposureLow   || 0,
      exposureHigh: r.fields.ExposureHigh  || 0,
      scoreChange:  r.fields.ScoreChange   || 0,
      triggerEvent: r.fields.TriggerEvent  || '',
    }));

    return res.json({ snapshots });
  }

  if (req.method === 'POST') {
    const {
      userId,
      score,
      pending      = 0,
      completed    = 0,
      exposureLow  = 0,
      exposureHigh = 0,
      triggerEvent = 'Dashboard Load',
    } = req.body;

    if (!userId)             return res.status(400).json({ error: 'userId required' });
    if (score === undefined) return res.status(400).json({ error: 'score required' });

    // Fetch most recent snapshot for delta calculation
    const prevRes   = await fetch(
      `${airtableBase}/Score_History?filterByFormula={UserID}='${userId}'&sort[0][field]=Date&sort[0][direction]=desc&maxRecords=1`,
      { headers }
    );
    const prevData  = prevRes.ok ? await prevRes.json() : { records: [] };
    const prevScore = prevData.records?.[0]?.fields?.Score ?? score;
    const scoreChange = score - prevScore;

    const today     = new Date().toISOString().split('T')[0];
    const createRes = await fetch(`${airtableBase}/Score_History`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [{
          fields: {
            UserID: userId, Date: today, Score: score,
            Pending: pending, Completed: completed,
            ExposureLow: exposureLow, ExposureHigh: exposureHigh,
            ScoreChange: scoreChange, TriggerEvent: triggerEvent,
            AlertSent: false,
          }
        }]
      })
    });

    if (!createRes.ok) {
      console.error('Score_History create failed:', createRes.status);
      return res.status(createRes.status).json({ error: 'Failed to save snapshot' });
    }

    const snapshotId = (await createRes.json()).records?.[0]?.id;
    let alertFired   = false;

    if (scoreChange <= -10) {
      const profileRes  = await fetch(
        `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
        { headers }
      );
      const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
      const profile     = profileData.records?.[0];

      if (profile?.fields?.LastAlertSent !== today) {
        try {
          const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ userId, alertType: 'score_drop', score, scoreChange, exposureHigh }),
          });

          if (alertRes.ok) {
            alertFired = true;
            const patches = [];
            if (snapshotId) {
              patches.push(fetch(`${airtableBase}/Score_History/${snapshotId}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({ fields: { AlertSent: true } })
              }));
            }
            if (profile?.id) {
              patches.push(fetch(`${airtableBase}/User_Profile/${profile.id}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({ fields: { LastAlertSent: today } })
              }));
            }
            await Promise.all(patches).catch(e => console.error('Alert patch failed (non-fatal):', e));
          }
        } catch (alertErr) {
          console.error('Score-drop alert failed (non-fatal):', alertErr);
        }
      }
    }

    return res.json({ snapshotId, scoreChange, alertFired });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SEND-ALERT handler ────────────────────────────────────────
// POST ?action=send-alert { userId, alertType, score?, scoreChange?, exposureHigh? }
// alertType: 'score_drop' | 'consent_expiry'
// Reads user email from User_Profile.Email. Sends via Resend.
// Never throws — always returns JSON.
async function handleSendAlert(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, alertType, score, scoreChange, exposureHigh } = req.body;
  if (!userId)    return res.status(400).json({ error: 'userId required' });
  if (!alertType) return res.status(400).json({ error: 'alertType required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — alert skipped');
    return res.json({ sent: false, reason: 'RESEND_API_KEY not configured' });
  }

  const airtableBase = `https://api.airtable.com/v0/${BASE_ID}`;
  const profileRes   = await fetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const profileData  = profileRes.ok ? await profileRes.json() : { records: [] };
  const toEmail      = profileData.records?.[0]?.fields?.Email;

  if (!toEmail) {
    console.warn(`No email on User_Profile for userId=${userId} — alert skipped`);
    return res.json({ sent: false, reason: 'No email address on profile' });
  }

  const fmtGBP    = n => `£${(n || 0).toLocaleString('en-GB')}`;
  const absChange = Math.abs(scoreChange || 0);
  let subject = '';
  let html    = '';

  if (alertType === 'score_drop') {
    subject = `⚠️ Your Sendwize compliance score dropped by ${absChange} points`;
    html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
          <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Compliance score alert</h2>
          <p style="color:#555;margin:0 0 24px;font-size:14px;">
            Your score dropped by <strong>${absChange} points</strong>, now at <strong>${score}/100</strong>.
            ${exposureHigh ? `Your current pending regulatory exposure is <strong>${fmtGBP(exposureHigh)}</strong>.` : ''}
          </p>
          <a href="https://sendwize.co.uk/dashboard"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            View your dashboard →
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Illustrative regulatory risk ranges based on ICO/ASA/CMA enforcement data.
            Not legal advice. Data (Use and Access) Act 2025 may affect maximum penalty levels.
          </p>
        </div>
      </div>`;

  } else if (alertType === 'consent_expiry') {
    subject = `⏰ Sendwize: consent expiry approaching — action recommended`;
    html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
          <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Consent expiry notice</h2>
          <p style="color:#555;margin:0 0 24px;font-size:14px;">
            One or more contact segments in your database may have consent expiring within
            <strong>30 days</strong>. Review your database audit and consider a re-consent
            campaign before sending to these contacts.
          </p>
          <a href="https://sendwize.co.uk/dashboard"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            Review database audit →
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Information only — not legal advice. Sendwize · sendwize.co.uk
          </p>
        </div>
      </div>`;

  } else {
    return res.status(400).json({ error: `Unknown alertType: ${alertType}` });
  }

  const resendRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: RESEND_FROM, to: [toEmail], subject, html }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.json();
    console.error('Resend error:', err);
    return res.status(resendRes.status).json({ sent: false, reason: err.message || 'Resend error' });
  }

  const resendData = await resendRes.json();
  console.log(`Alert sent: userId=${userId} alertType=${alertType} messageId=${resendData.id}`);
  return res.json({ sent: true, messageId: resendData.id });
}

// ── BRIEFING handler ──────────────────────────────────────────
// GET ?action=briefing&userId=x
// Generates a ~150-200 word compliance briefing via Claude.
// Respects LastBriefingSent — only generates once per calendar day.
// Returns { briefing, cached }.
async function handleBriefing(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
  const BASE_ID         = process.env.BASE_ID;
  const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
  const airtableBase    = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };
  const today           = new Date().toISOString().split('T')[0];

  const profileRes  = await fetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
  const profile     = profileData.records?.[0];

  if (profile?.fields?.LastBriefingSent === today) {
    return res.json({ briefing: null, cached: true });
  }

  const fixesRes  = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;

  const pending   = fixesData?.fixes?.pending || [];
  const score     = fixesData?.score          || 0;
  const scoreBand = fixesData?.scoreBand      || '';
  const exposure  = fixesData?.exposure       || {};

  const fixSummary = pending.slice(0, 5).map(f =>
    `- ${f.fixType.replace(/_/g, ' ')} (${f.severity}): ${f.description}`
  ).join('\n');

  const promptContext = [
    `Compliance score: ${score}/100 (${scoreBand})`,
    `Pending fixes: ${pending.length}`,
    `Estimated pending exposure: £${(exposure.pendingLow || 0).toLocaleString('en-GB')} – £${(exposure.pendingHigh || 0).toLocaleString('en-GB')}`,
    fixSummary ? `\nTop pending items:\n${fixSummary}` : '',
  ].filter(Boolean).join('\n');

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `You are a compliance advisor for UK email marketers. Write a concise, practical weekly briefing of around 150–200 words. Tone: professional but plain-English, never alarmist. Never say "compliant" or "in breach" — use hedged language. Never give legal advice. End with one specific suggested action for this week.`,
      messages: [{
        role:    'user',
        content: `Here is the user's current compliance status:\n\n${promptContext}\n\nWrite their weekly briefing.`,
      }],
    }),
  });

  if (!claudeRes.ok) {
    console.error('Claude briefing error:', claudeRes.status);
    return res.status(claudeRes.status).json({ error: 'Failed to generate briefing' });
  }

  const briefing = (await claudeRes.json()).content?.[0]?.text || '';

  if (profile?.id) {
    await fetch(`${airtableBase}/User_Profile/${profile.id}`, {
      method:  'PATCH',
      headers: { ...airtableHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: { LastBriefingSent: today } }),
    }).catch(e => console.error('LastBriefingSent update failed (non-fatal):', e));
  }

  return res.json({ briefing, cached: false });
}

// ── CONSENT-EXPIRY-CHECK handler ──────────────────────────────
// POST ?action=consent-expiry-check { userId }
// Reads the expiryTimeline from the user's most recent Database_Audit.
// If contacts are expiring within 30 days, fires a consent_expiry alert
// via send-alert. Guard: LastAlertSent within 7 days = skip.
// Returns { checked, alertFired, reason? }.
async function handleConsentExpiryCheck(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
  const BASE_ID         = process.env.BASE_ID;
  const airtableBase    = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };
  const today           = new Date().toISOString().split('T')[0];

  // Fetch most recent audit for this user
  const auditRes  = await fetch(
    `${airtableBase}/Database_Audits?filterByFormula={UserID}='${userId}'&sort[0][field]=AuditDate&sort[0][direction]=desc&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const auditData = auditRes.ok ? await auditRes.json() : { records: [] };
  const audit     = auditData.records?.[0];

  if (!audit) {
    return res.json({ checked: true, alertFired: false, reason: 'No audit found for user' });
  }

  // Parse expiryTimeline — stored as stringified JSON on the audit record
  let expiryTimeline = [];
  try {
    const raw = audit.fields.ExpiryTimeline || audit.fields.expiryTimeline || '';
    if (raw) expiryTimeline = JSON.parse(raw);
  } catch {
    return res.json({ checked: true, alertFired: false, reason: 'Could not parse expiryTimeline' });
  }

  // Check if any segment expires within 30 days
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  const expiringSegments = expiryTimeline.filter(segment => {
    if (!segment.expiryDate) return false;
    const expiry = new Date(segment.expiryDate);
    return expiry <= thirtyDaysFromNow;
  });

  if (expiringSegments.length === 0) {
    return res.json({ checked: true, alertFired: false, reason: 'No segments expiring within 30 days' });
  }

  // Guard: check LastAlertSent — skip if within last 7 days
  const profileRes  = await fetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
  const profile     = profileData.records?.[0];
  const lastAlert   = profile?.fields?.LastAlertSent || '';

  if (lastAlert) {
    const daysSinceAlert = Math.floor(
      (new Date(today) - new Date(lastAlert)) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceAlert < 7) {
      return res.json({ checked: true, alertFired: false, reason: `Alert already sent ${daysSinceAlert} days ago` });
    }
  }

  // Fire consent_expiry alert
  try {
    const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, alertType: 'consent_expiry' }),
    });

    if (!alertRes.ok) {
      console.error('consent_expiry alert failed:', alertRes.status);
      return res.json({ checked: true, alertFired: false, reason: 'Alert send failed' });
    }

    // Update LastAlertSent on User_Profile
    if (profile?.id) {
      await fetch(`${airtableBase}/User_Profile/${profile.id}`, {
        method:  'PATCH',
        headers: { ...airtableHeaders, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields: { LastAlertSent: today } }),
      }).catch(e => console.error('LastAlertSent update failed (non-fatal):', e));
    }

    return res.json({ checked: true, alertFired: true, expiringSegments: expiringSegments.length });

  } catch (err) {
    console.error('consent-expiry-check alert error:', err);
    return res.json({ checked: true, alertFired: false, reason: 'Alert error' });
  }
}

// ── SIMULATION-RUN handler ────────────────────────────────────
// POST ?action=simulation-run { userId, regulator }
// regulator: 'ICO' | 'CMA' | 'ASA'
// Five-stage ICO investigation simulation.
// Stages 1-2: deterministic (reads Compliance_Fixes).
// Stage 3: Claude generates first-contact enforcement email.
// Stage 4: documentation gap analysis.
// Stage 5: penalty estimate + representations strategy.
// Writes result to Simulation_Reports. Returns full simulation output.
// TODO v4.18 — full implementation pending. Stub returns 501.
async function handleSimulationRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, regulator } = req.body;
  if (!userId)    return res.status(400).json({ error: 'userId required' });
  if (!regulator) return res.status(400).json({ error: 'regulator required' });
  if (!['ICO', 'CMA', 'ASA'].includes(regulator)) {
    return res.status(400).json({ error: 'regulator must be ICO | CMA | ASA' });
  }

  // ── Stage 1: Background check — read pending Compliance_Fixes ────
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
  const airtableBase   = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const today          = new Date().toISOString().split('T')[0];

  const fixesRes  = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;

  const pendingFixes    = fixesData?.fixes?.pending    || [];
  const completedFixes  = fixesData?.fixes?.completed  || [];
  const score           = fixesData?.score             || 0;
  const exposure        = fixesData?.exposure          || {};

  const criticalFixes = pendingFixes.filter(f => f.severity === 'critical');
  const highFixes     = pendingFixes.filter(f => f.severity === 'high');

  const backgroundCheck = {
    score,
    pendingCount:   pendingFixes.length,
    completedCount: completedFixes.length,
    criticalCount:  criticalFixes.length,
    highCount:      highFixes.length,
    exposureHigh:   exposure.pendingHigh || 0,
    topIssues:      criticalFixes.slice(0, 3).map(f => ({ fixType: f.fixType, description: f.description })),
  };

  // ── Stage 2: Escalation factors — deterministic ───────────────────
  const escalationFactors = [];
  if (criticalFixes.length > 0)   escalationFactors.push('One or more critical unresolved violations');
  if (score < 50)                 escalationFactors.push('Compliance score below 50 — pattern of non-compliance');
  if (pendingFixes.length > 5)    escalationFactors.push(`${pendingFixes.length} unresolved fix items`);

  const complaintProbability = Math.min(
    95,
    20 + (criticalFixes.length * 20) + (highFixes.length * 5) + (score < 50 ? 20 : 0)
  );

  // ── Stage 3 & 4: Claude — first contact email + documentation gaps ─
  const fixSummary = pendingFixes.slice(0, 5).map(f =>
    `- ${f.fixType.replace(/_/g, ' ')} (${f.severity}): ${f.description}`
  ).join('\n');

  const claudePrompt = `You are simulating a ${regulator} direct marketing enforcement investigation.

USER COMPLIANCE DATA:
- Score: ${score}/100
- Critical violations: ${criticalFixes.length}
- Pending fixes: ${pendingFixes.length}
- Estimated exposure: £${(exposure.pendingHigh || 0).toLocaleString('en-GB')}
- Top issues:
${fixSummary || 'None identified'}

Respond ONLY with this exact JSON (no preamble, no markdown):
{
  "firstContactEmail": "A realistic formal first-contact email from ${regulator} to the organisation, referencing specific concerns based on the violation types above. 150-200 words. Formal regulatory tone.",
  "documentationChecklist": [
    { "item": "Description of documentation item", "status": "AVAILABLE | PARTIAL | MISSING" }
  ],
  "penaltyEstimateLow": 0,
  "penaltyEstimateHigh": 0,
  "aggravatingFactors": ["factor1", "factor2"],
  "mitigatingFactors": ["factor1", "factor2"],
  "representationsStrategy": "2-3 sentence summary of the strongest representations strategy available to the organisation based on their compliance position.",
  "enforcementContext": "1-2 real verified ${regulator} enforcement cases most relevant to these violation types. Only include cases you are certain are real. If uncertain, write: No directly comparable verified cases identified."
}

Penalty guidance for ${regulator}:
- ICO: PECR max £500,000. UK GDPR max £17,500,000 or 4% global turnover.
- CMA: Unlimited fines for CPR breaches.
- ASA: No direct fines — refer to Trading Standards or CAP sanctions.
Base penalty estimates on the severity and volume of violations above. Stay within confirmed regulatory maximums.`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: claudePrompt }],
    }),
  });

  if (!claudeRes.ok) {
    console.error('Claude simulation error:', claudeRes.status);
    return res.status(500).json({ error: 'Failed to generate simulation' });
  }

  let claudeOutput = {};
  try {
    const text      = (await claudeRes.json()).content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    claudeOutput    = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    console.error('Claude simulation JSON parse failed');
    return res.status(500).json({ error: 'Failed to parse simulation output' });
  }

  // ── Stage 5: Write Simulation_Reports ────────────────────────────
  let reportId = null;
  try {
    const reportRes = await fetch(`${airtableBase}/Simulation_Reports`, {
      method:  'POST',
      headers: airtableHeaders,
      body: JSON.stringify({
        records: [{
          fields: {
            UserID:                    userId,
            SimulationDate:            today,
            Regulator:                 regulator,
            ScopeNote:                 'Direct marketing compliance only',
            ComplaintProbability:      complaintProbability,
            BackgroundCheckJson:       JSON.stringify(backgroundCheck),
            EscalationFactorsJson:     JSON.stringify(escalationFactors),
            FirstContactEmailText:     claudeOutput.firstContactEmail     || '',
            UserDocumentationJson:     JSON.stringify(claudeOutput.documentationChecklist || []),
            DocumentationGapsJson:     JSON.stringify(
              (claudeOutput.documentationChecklist || []).filter(i => i.status !== 'AVAILABLE')
            ),
            PenaltyEstimateLow:        claudeOutput.penaltyEstimateLow    || 0,
            PenaltyEstimateHigh:       claudeOutput.penaltyEstimateHigh   || 0,
            AggravatingFactorsJson:    JSON.stringify(claudeOutput.aggravatingFactors    || []),
            MitigatingFactorsJson:     JSON.stringify(claudeOutput.mitigatingFactors     || []),
            RepresentationsStrategyJson: JSON.stringify(claudeOutput.representationsStrategy || ''),
            EnforcementContextText:    claudeOutput.enforcementContext    || '',
            SimulationVersion:         `${regulator}-2026-v1`,
          }
        }]
      })
    });

    if (reportRes.ok) {
      const reportData = await reportRes.json();
      reportId = reportData.records?.[0]?.id ?? null;
    } else {
      console.error('Simulation_Reports write failed:', reportRes.status);
    }
  } catch (err) {
    console.error('Simulation_Reports write error (non-fatal):', err);
  }

  return res.status(200).json({
    reportId,
    regulator,
    complaintProbability,
    backgroundCheck,
    escalationFactors,
    firstContactEmail:       claudeOutput.firstContactEmail        || '',
    documentationChecklist:  claudeOutput.documentationChecklist   || [],
    penaltyEstimateLow:      claudeOutput.penaltyEstimateLow       || 0,
    penaltyEstimateHigh:     claudeOutput.penaltyEstimateHigh      || 0,
    aggravatingFactors:      claudeOutput.aggravatingFactors       || [],
    mitigatingFactors:       claudeOutput.mitigatingFactors        || [],
    representationsStrategy: claudeOutput.representationsStrategy  || '',
    enforcementContext:       claudeOutput.enforcementContext       || '',
    disclaimer: 'Information only — not legal advice. Penalty estimates are illustrative ranges based on published ICO/CMA/ASA enforcement data.',
  });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET'    && action === 'report')                return await handleReport(req, res);
    if (req.method === 'GET'    && action === 'vendors')               return await handleVendors(req, res);
    if (req.method === 'GET'    && action === 'violations')            return await handleViolations(req, res);
    if (req.method === 'POST'   && action === 'load')                  return await handleLoad(req, res);
    if (req.method === 'GET'    && action === 'history')               return await handleHistory(req, res);
    if (req.method === 'GET'    && action === 'summary')               return await handleSummary(req, res);
    if ((req.method === 'POST' || req.method === 'DELETE') && action === 'register') return await handleRegister(req, res);
    if ((req.method === 'GET'  || req.method === 'POST')  && action === 'score-history') return await handleScoreHistory(req, res);
    if (req.method === 'POST'   && action === 'send-alert')            return await handleSendAlert(req, res);
    if (req.method === 'GET'    && action === 'briefing')              return await handleBriefing(req, res);
    if (req.method === 'POST'   && action === 'consent-expiry-check')  return await handleConsentExpiryCheck(req, res);
    if (req.method === 'POST'   && action === 'simulation-run')        return await handleSimulationRun(req, res);

    return res.status(400).json({
      error: 'Unknown action',
      valid: 'report | vendors | violations | load | history | register | summary | score-history | send-alert | briefing | consent-expiry-check | simulation-run'
    });

  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
