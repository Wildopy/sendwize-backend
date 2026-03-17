// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v4.3
// Router: ?action=report | vendors | violations | load | history
//         | register | score-history | send-alert | briefing
//
// GET    /api/data?action=report&recordId=x&type=pecr|ai|audit|email|vendor|suppression
// GET    /api/data?action=vendors
// GET    /api/data?action=violations&violationType=x&keyword=x
// POST   /api/data?action=load  { userId }
// GET    /api/data?action=history&type=audit|vendor&userId=x
// POST   /api/data?action=register  { userId, recordId?, vendor: { ... } }
// DELETE /api/data?action=register&recordId=x
// GET    /api/data?action=score-history&userId=x&limit=30
// POST   /api/data?action=score-history  { userId, score, pending, completed, exposureLow, exposureHigh, triggerEvent }
// POST   /api/data?action=send-alert  { userId, alertType, score?, scoreChange?, exposureHigh? }
// GET    /api/data?action=briefing&userId=x
// ─────────────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || 'https://sendwize-backend.vercel.app';

// ── REPORT handler ────────────────────────────────────────────
async function handleReport(req, res) {
  const { recordId, type } = req.query;

  if (!recordId || !type) {
    return res.status(400).json({ error: 'Missing recordId or type' });
  }

  const tables = {
    pecr:        'Submissions',
    ai:          'AI_Compliance_Checks',
    audit:       'Database_Audits',
    email:       'Email_Scans',
    vendor:      'Vendor_Checks',
    suppression: 'Suppression_Checks',
  };

  const tableName = tables[type];
  if (!tableName) {
    return res.status(400).json({ error: 'Invalid report type' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${tableName}/${recordId}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable fetch failed:', response.status);
    return res.status(response.status).json({ error: 'Failed to fetch report' });
  }

  const data = await response.json();
  return res.json(data);
}

// ── VENDORS handler ───────────────────────────────────────────
async function handleVendors(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?sort[0][field]=VendorName&sort[0][direction]=asc`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable fetch failed:', response.status);
    return res.json({ vendors: [] });
  }

  const data = await response.json();

  const vendors = (data.records || []).map(record => ({
    name:           record.fields.VendorName        || '',
    category:       record.fields.Category          || 'Marketing Tool',
    score:          record.fields.ComplianceScore   || 0,
    dpaLink:        record.fields.DPALink           || '',
    dataLocation:   record.fields.DataLocation      || '',
    certifications: record.fields.Certifications    || '',
    recentBreaches: record.fields.RecentBreaches    || 'No',
    notes:          record.fields.Notes             || '',
    lastUpdated:    record.fields.LastUpdated        || '',
    subprocessors:  record.fields.Subprocessors     || '',
  }));

  return res.json({ vendors });
}

// ── VIOLATIONS handler ────────────────────────────────────────
async function handleViolations(req, res) {
  const { violationType, keyword } = req.query;

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  let filters = [];
  if (violationType) filters.push(`{ViolationType}='${violationType}'`);
  if (keyword) {
    const kw = keyword.toLowerCase();
    filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
  }

  const formula = filters.length > 0 ? `AND(${filters.join(',')})` : '';
  const url = `https://api.airtable.com/v0/${BASE_ID}/Violation_Database` +
    (formula ? `?filterByFormula=${encodeURIComponent(formula)}` : '') +
    `${formula ? '&' : '?'}sort[0][field]=DateOfAction&sort[0][direction]=desc&maxRecords=20`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
  });

  if (!response.ok) return res.status(response.status).json({ error: 'Failed' });

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
async function handleLoad(req, res) {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const TABLE_NAME     = process.env.TABLE_NAME;

  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}?filterByFormula={UserID}='${userId}'&sort[0][field]=SubmissionDate&sort[0][direction]=desc`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Airtable error:', errorData);
    throw new Error(`Airtable error: ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  return res.status(200).json(data);
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

  if (type === 'audit') {
    const url = `https://api.airtable.com/v0/${BASE_ID}/Database_Audits` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=AuditDate&sort[0][direction]=desc` +
      `&maxRecords=10`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!response.ok) {
      console.error('Airtable history (audit) fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch audit history' });
    }

    const data = await response.json();
    return res.json({ records: data.records || [] });
  }

  if (type === 'vendor') {
    const url = `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=AddedDate&sort[0][direction]=desc`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!response.ok) {
      console.error('Airtable history (vendor) fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch vendor register' });
    }

    const data = await response.json();
    return res.json({ records: data.records || [] });
  }
}

// ── REGISTER handler ──────────────────────────────────────────
async function handleRegister(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });

    const response = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${recordId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      }
    );

    if (!response.ok) {
      console.error('Airtable register delete failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to delete vendor' });
    }

    return res.json({ deleted: true });
  }

  if (req.method === 'POST') {
    const { userId, recordId, vendor } = req.body;

    if (!userId)  return res.status(400).json({ error: 'userId required' });
    if (!vendor)  return res.status(400).json({ error: 'vendor data required' });

    const fields = {
      UserID:          userId,
      VendorName:      vendor.VendorName      || '',
      Category:        vendor.Category        || '',
      DataProcessed:   Array.isArray(vendor.DataProcessed)
                         ? JSON.stringify(vendor.DataProcessed)
                         : (vendor.DataProcessed || ''),
      AgreementType:   vendor.AgreementType   || '',
      AgreementStatus: vendor.AgreementStatus || '',
      AgreementLink:   vendor.AgreementLink   || '',
      AgreementDate:   vendor.AgreementDate   || '',
      DataLocation:    vendor.DataLocation    || '',
      ComplianceScore: vendor.ComplianceScore || null,
      LastChecked:     vendor.LastChecked     || '',
      CheckResults:    vendor.CheckResults
                         ? (typeof vendor.CheckResults === 'string'
                             ? vendor.CheckResults
                             : JSON.stringify(vendor.CheckResults))
                         : '',
      Notes:           vendor.Notes           || '',
    };

    Object.keys(fields).forEach(k => {
      if (fields[k] === '' || fields[k] === null) delete fields[k];
    });

    if (recordId) {
      const response = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${recordId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ fields })
        }
      );

      if (!response.ok) {
        console.error('Airtable register patch failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to update vendor' });
      }

      const data = await response.json();
      return res.json({ record: data });

    } else {
      fields.AddedDate = new Date().toISOString().split('T')[0];

      const response = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ records: [{ fields }] })
        }
      );

      if (!response.ok) {
        console.error('Airtable register post failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to save vendor' });
      }

      const data = await response.json();
      return res.json({ record: data.records?.[0] || data });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SCORE-HISTORY handler ─────────────────────────────────────
//
// GET  ?action=score-history&userId=x&limit=30
//   Returns the user's score snapshots, newest first.
//   limit defaults to 30 (enough for a 30-day sparkline).
//
// POST ?action=score-history  { userId, score, pending, completed,
//                               exposureLow, exposureHigh, triggerEvent }
//   1. Reads the most recent snapshot for this user.
//   2. Calculates ScoreChange (delta from previous snapshot).
//   3. Writes a new Score_History record.
//   4. If ScoreChange <= -10 and the last alert was not sent today,
//      fires send-alert (score_drop) via internal APP_URL call.
//      Updates User_Profile.LastAlertSent to prevent duplicates.
//   Returns { snapshotId, scoreChange, alertFired }.
//
async function handleScoreHistory(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const airtableBase   = `https://api.airtable.com/v0/${BASE_ID}`;
  const headers        = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  // ── GET — return snapshots ────────────────────────────────────
  if (req.method === 'GET') {
    const { userId, limit = '30' } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const maxRecords = Math.min(parseInt(limit, 10) || 30, 90);
    const url = `${airtableBase}/Score_History` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=Date&sort[0][direction]=desc` +
      `&maxRecords=${maxRecords}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error('Score_History fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch score history' });
    }

    const data     = await response.json();
    const snapshots = (data.records || []).map(r => ({
      id:          r.id,
      date:        r.fields.Date         || '',
      score:       r.fields.Score        || 0,
      pending:     r.fields.Pending      || 0,
      completed:   r.fields.Completed    || 0,
      exposureLow: r.fields.ExposureLow  || 0,
      exposureHigh:r.fields.ExposureHigh || 0,
      scoreChange: r.fields.ScoreChange  || 0,
      triggerEvent:r.fields.TriggerEvent || '',
    }));

    return res.json({ snapshots });
  }

  // ── POST — write snapshot ─────────────────────────────────────
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

    if (!userId)          return res.status(400).json({ error: 'userId required' });
    if (score === undefined) return res.status(400).json({ error: 'score required' });

    // 1. Fetch most recent snapshot to compute delta
    const prevUrl = `${airtableBase}/Score_History` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=Date&sort[0][direction]=desc` +
      `&maxRecords=1`;

    const prevRes  = await fetch(prevUrl, { headers });
    const prevData = prevRes.ok ? await prevRes.json() : { records: [] };
    const prevSnap = prevData.records?.[0];
    const prevScore = prevSnap ? (prevSnap.fields.Score || 0) : score;
    const scoreChange = score - prevScore; // negative = drop

    // 2. Write new snapshot
    const today = new Date().toISOString().split('T')[0];
    const newRecord = {
      records: [{
        fields: {
          UserID:       userId,
          Date:         today,
          Score:        score,
          Pending:      pending,
          Completed:    completed,
          ExposureLow:  exposureLow,
          ExposureHigh: exposureHigh,
          ScoreChange:  scoreChange,
          TriggerEvent: triggerEvent,
          AlertSent:    false,
        }
      }]
    };

    const createRes  = await fetch(`${airtableBase}/Score_History`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(newRecord),
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      console.error('Score_History create failed:', err);
      return res.status(createRes.status).json({ error: 'Failed to save snapshot' });
    }

    const created    = await createRes.json();
    const snapshotId = created.records?.[0]?.id;

    // 3. Check whether a score-drop alert should fire
    let alertFired = false;
    const DROP_THRESHOLD = -10;

    if (scoreChange <= DROP_THRESHOLD) {
      // Fetch User_Profile to check LastAlertSent
      const profileUrl = `${airtableBase}/User_Profile` +
        `?filterByFormula={UserID}='${userId}'&maxRecords=1`;
      const profileRes  = await fetch(profileUrl, { headers });
      const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
      const profile     = profileData.records?.[0];
      const lastAlert   = profile?.fields?.LastAlertSent || '';

      // Only alert once per calendar day
      if (lastAlert !== today) {
        try {
          // Fire send-alert via internal call (non-blocking — we don't await failure)
          const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              userId,
              alertType:   'score_drop',
              score,
              scoreChange,
              exposureHigh,
            }),
          });

          if (alertRes.ok) {
            alertFired = true;

            // Mark AlertSent on the snapshot record
            if (snapshotId) {
              await fetch(`${airtableBase}/Score_History/${snapshotId}`, {
                method:  'PATCH',
                headers,
                body:    JSON.stringify({ fields: { AlertSent: true } }),
              });
            }

            // Update LastAlertSent on User_Profile to prevent duplicates today
            if (profile?.id) {
              await fetch(`${airtableBase}/User_Profile/${profile.id}`, {
                method:  'PATCH',
                headers,
                body:    JSON.stringify({ fields: { LastAlertSent: today } }),
              });
            }
          }
        } catch (alertErr) {
          // Alert failure is non-fatal — snapshot was still saved
          console.error('Score-drop alert failed (non-fatal):', alertErr);
        }
      }
    }

    return res.json({ snapshotId, scoreChange, alertFired });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SEND-ALERT handler ────────────────────────────────────────
//
// POST ?action=send-alert  { userId, alertType, score?, scoreChange?, exposureHigh? }
//
// alertType values:
//   'score_drop'     — score dropped >10pts since last snapshot
//   'consent_expiry' — contacts have consent expiring within 30 days
//
// Requires env vars:
//   RESEND_API_KEY   — Resend API key
//   RESEND_FROM      — verified sender address, e.g. alerts@sendwize.co.uk
//
// Reads the user's email from User_Profile.Email (added per spec 4.9).
// Returns { sent: true, messageId } or { sent: false, reason }.
//
async function handleSendAlert(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, alertType, score, scoreChange, exposureHigh } = req.body;
  if (!userId)    return res.status(400).json({ error: 'userId required' });
  if (!alertType) return res.status(400).json({ error: 'alertType required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'alerts@sendwize.co.uk';

  // ── Guard: Resend not yet configured ─────────────────────────
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — alert skipped');
    return res.json({ sent: false, reason: 'RESEND_API_KEY not configured' });
  }

  // ── Fetch user email from User_Profile ────────────────────────
  const airtableBase = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` };

  const profileRes  = await fetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
  const profile     = profileData.records?.[0];
  const toEmail     = profile?.fields?.Email;

  if (!toEmail) {
    console.warn(`No email on User_Profile for userId=${userId} — alert skipped`);
    return res.json({ sent: false, reason: 'No email address on profile' });
  }

  // ── Build email content per alertType ─────────────────────────
  let subject = '';
  let html    = '';

  const fmtGBP = n => `£${(n || 0).toLocaleString('en-GB')}`;
  const absChange = Math.abs(scoreChange || 0);

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
      </div>
    `;
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
            <strong>30 days</strong>. We'd suggest reviewing your database audit and considering
            a re-consent campaign before sending to these contacts.
          </p>
          <a href="https://sendwize.co.uk/dashboard"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            Review database audit →
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Information only — not legal advice. Sendwize · sendwize.co.uk
          </p>
        </div>
      </div>
    `;
  } else {
    return res.status(400).json({ error: `Unknown alertType: ${alertType}` });
  }

  // ── Send via Resend ───────────────────────────────────────────
  const resendRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    RESEND_FROM,
      to:      [toEmail],
      subject,
      html,
    }),
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
//
// GET ?action=briefing&userId=x
//
// Generates a ~200 word Monday compliance briefing for the user
// by fetching their fixes + profile and calling Claude.
// Respects LastBriefingSent — only generates once per day.
// Returns { briefing, cached } where cached=true means today's
// briefing was already sent (no Claude call made).
//
async function handleBriefing(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
  const BASE_ID         = process.env.BASE_ID;
  const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
  const airtableBase    = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` };
  const today           = new Date().toISOString().split('T')[0];

  // Check LastBriefingSent — avoid regenerating same day
  const profileRes  = await fetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const profileData = profileRes.ok ? await profileRes.json() : { records: [] };
  const profile     = profileData.records?.[0];

  if (profile?.fields?.LastBriefingSent === today) {
    // Return cached — briefing already generated today
    // (In production you could store the briefing text too; for now just signal cached)
    return res.json({ briefing: null, cached: true });
  }

  // Fetch pending fixes for context
  const fixesRes = await fetch(
    `${APP_URL}/api/fixes?action=get&userId=${userId}`
  );
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;

  const pending   = fixesData?.fixes?.pending  || [];
  const score     = fixesData?.score           || 0;
  const scoreBand = fixesData?.scoreBand       || '';
  const exposure  = fixesData?.exposure        || {};

  // Build a compact context string for Claude — keep prompt lean
  const fixSummary = pending.slice(0, 5).map(f =>
    `- ${f.fixType.replace(/_/g,' ')} (${f.severity}): ${f.description}`
  ).join('\n');

  const promptContext = [
    `Compliance score: ${score}/100 (${scoreBand})`,
    `Pending fixes: ${pending.length}`,
    `Estimated pending exposure: £${(exposure.pendingLow||0).toLocaleString('en-GB')} – £${(exposure.pendingHigh||0).toLocaleString('en-GB')}`,
    fixSummary ? `\nTop pending items:\n${fixSummary}` : '',
  ].filter(Boolean).join('\n');

  // Call Claude
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
      system: `You are a compliance advisor for UK email marketers. Write a concise, 
practical Monday briefing of around 150–200 words. Tone: professional but plain-English, 
never alarmist. Never say "compliant" or "in breach" — use hedged language. 
Never give legal advice. End with one specific suggested action for this week.`,
      messages: [{
        role:    'user',
        content: `Here is the user's current compliance status:\n\n${promptContext}\n\nWrite their weekly briefing.`,
      }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json();
    console.error('Claude briefing error:', err);
    return res.status(claudeRes.status).json({ error: 'Failed to generate briefing' });
  }

  const claudeData = await claudeRes.json();
  const briefing   = claudeData.content?.[0]?.text || '';

  // Update LastBriefingSent on profile
  if (profile?.id) {
    await fetch(`${airtableBase}/User_Profile/${profile.id}`, {
      method:  'PATCH',
      headers: { ...airtableHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: { LastBriefingSent: today } }),
    });
  }

  return res.json({ briefing, cached: false });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET'  && action === 'report')        return await handleReport(req, res);
    if (req.method === 'GET'  && action === 'vendors')       return await handleVendors(req, res);
    if (req.method === 'GET'  && action === 'violations')    return await handleViolations(req, res);
    if (req.method === 'POST' && action === 'load')          return await handleLoad(req, res);
    if (req.method === 'GET'  && action === 'history')       return await handleHistory(req, res);
    if ((req.method === 'POST' || req.method === 'DELETE') && action === 'register') return await handleRegister(req, res);

    // ── New in v4.3 ────────────────────────────────────────────
    if ((req.method === 'GET' || req.method === 'POST') && action === 'score-history') return await handleScoreHistory(req, res);
    if (req.method === 'POST' && action === 'send-alert')    return await handleSendAlert(req, res);
    if (req.method === 'GET'  && action === 'briefing')      return await handleBriefing(req, res);

    return res.status(400).json({ error: 'Unknown action. Use ?action=report|vendors|violations|load|history|register|score-history|send-alert|briefing' });
  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: error.message });
  }
}
