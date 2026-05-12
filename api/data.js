// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v5.1
// Router: ?action=report | vendors | violations | load | history
//         | register | summary | score-history | send-alert
//         | briefing | consent-expiry-check | simulation-run
//
// v5.1 changes:
//   - simulation-run: ASA and CMA/DMCCA simulators fully implemented
//   - Stage 1 checks are regulator-aware
//   - Escalation factors are regulator-aware
//   - Claude prompt is regulator-specific with correct penalty guidance
//   - ASA: no financial fine, reputational sanctions explained
//   - CMA: DMCCA turnover-linked fines, settlement discounts noted
//   - history: type=ai, type=brief, type=suppression added (were 400ing)
// ─────────────────────────────────────────────────────────────

const APP_URL     = 'https://sendwize-backend.vercel.app';
const RESEND_FROM = 'alerts@sendwize.co.uk';

// ── REPORT handler ────────────────────────────────────────────
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
    pecr:        'Suppression_Checks',
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
// v5.1: added ai, brief, suppression types (were returning 400)
async function handleHistory(req, res) {
  const { type, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const validTypes = ['audit', 'vendor', 'ai', 'brief', 'suppression'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(' | ')}` });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const tableMap = {
    audit:       { table: 'Database_Audits',       sort: 'AuditDate'   },
    vendor:      { table: 'Vendor_Register',        sort: 'LastChecked' },
    ai:          { table: 'AI_Compliance_Checks',   sort: 'CheckDate'   },
    brief:       { table: 'Brief_Checks',           sort: 'CreatedDate' },
    suppression: { table: 'Suppression_Checks',     sort: 'CheckDate'   },
  };

  const { table, sort } = tableMap[type];
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}` +
    `?filterByFormula={UserID}='${userId}'` +
    `&sort[0][field]=${sort}&sort[0][direction]=desc` +
    `&maxRecords=20`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!response.ok) {
    console.error(`Airtable history (${type}) fetch failed:`, response.status);
    return res.status(response.status).json({ error: `Failed to fetch ${type} history` });
  }

  return res.json({ records: (await response.json()).records || [] });
}

// ── REGISTER handler ──────────────────────────────────────────
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
    score:          fixesData?.score                    ?? 0,
    scoreBand:      fixesData?.scoreBand                ?? 'Not Started',
    pendingCount:   fixesData?.fixes?.pending?.length   ?? 0,
    completedCount: fixesData?.fixes?.completed?.length ?? 0,
    exposure: {
      medianLow:  fixesData?.exposure?.medianLow  ?? 0,
      medianHigh: fixesData?.exposure?.medianHigh ?? 0,
      savedLow:   fixesData?.exposure?.savedLow   ?? 0,
      savedHigh:  fixesData?.exposure?.savedHigh  ?? 0,
    },
    streak:         profileData?.currentStreak  ?? 0,
    longestStreak:  profileData?.longestStreak  ?? 0,
    lastCheckDate:  profileData?.lastCheckDate  ?? null,
  });
}

// ── SCORE-HISTORY handler ─────────────────────────────────────
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
            ${exposureHigh ? `Your current pending regulatory exposure is approximately <strong>${fmtGBP(exposureHigh)}</strong>.` : ''}
          </p>
          <a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            View your dashboard →
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Illustrative regulatory risk ranges based on ICO/ASA/CMA enforcement data.
            Not legal advice.
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
          <a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            Review database audit →
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Information only — not legal advice. Sendwize
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
    return res.json({ briefing: profile?.fields?.LastBriefingText || null, cached: true });
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
    `Estimated pending exposure: ~£${(exposure.medianHigh || 0).toLocaleString('en-GB')} (average single-issue)`,
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
      body:    JSON.stringify({ fields: { LastBriefingSent: today, LastBriefingText: briefing } }),
    }).catch(e => console.error('LastBriefingSent update failed (non-fatal):', e));
  }

  return res.json({ briefing, cached: false });
}

// ── CONSENT-EXPIRY-CHECK handler ──────────────────────────────
async function handleConsentExpiryCheck(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
  const BASE_ID         = process.env.BASE_ID;
  const airtableBase    = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };
  const today           = new Date().toISOString().split('T')[0];

  const auditRes  = await fetch(
    `${airtableBase}/Database_Audits?filterByFormula={UserID}='${userId}'&sort[0][field]=AuditDate&sort[0][direction]=desc&maxRecords=1`,
    { headers: airtableHeaders }
  );
  const auditData = auditRes.ok ? await auditRes.json() : { records: [] };
  const audit     = auditData.records?.[0];

  if (!audit) {
    return res.json({ checked: true, alertFired: false, expiringIn30: 0, expiringIn60: 0, expiringIn90: 0, reason: 'No audit found for user' });
  }

  let expiryTimeline = [];
  try {
    const raw = audit.fields.ExpiryTimeline || audit.fields.expiryTimeline || '';
    if (raw) expiryTimeline = JSON.parse(raw);
  } catch {
    return res.json({ checked: true, alertFired: false, expiringIn30: 0, expiringIn60: 0, expiringIn90: 0, reason: 'Could not parse expiryTimeline' });
  }

  const d30 = new Date(); d30.setDate(d30.getDate() + 30);
  const d60 = new Date(); d60.setDate(d60.getDate() + 60);
  const d90 = new Date(); d90.setDate(d90.getDate() + 90);

  let expiringIn30 = 0, expiringIn60 = 0, expiringIn90 = 0;

  expiryTimeline.forEach(segment => {
    if (!segment.expiryDate) return;
    const expiry = new Date(segment.expiryDate);
    const count  = segment.count || segment.contacts || 1;
    if (expiry <= d30)      expiringIn30 += count;
    else if (expiry <= d60) expiringIn60 += count;
    else if (expiry <= d90) expiringIn90 += count;
  });

  if (expiringIn30 === 0 && expiringIn60 === 0 && expiringIn90 === 0) {
    return res.json({ checked: true, alertFired: false, expiringIn30: 0, expiringIn60: 0, expiringIn90: 0 });
  }

  if (expiringIn30 === 0) {
    return res.json({ checked: true, alertFired: false, expiringIn30, expiringIn60, expiringIn90 });
  }

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
      return res.json({ checked: true, alertFired: false, expiringIn30, expiringIn60, expiringIn90 });
    }
  }

  try {
    const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, alertType: 'consent_expiry' }),
    });

    if (profile?.id) {
      await fetch(`${airtableBase}/User_Profile/${profile.id}`, {
        method:  'PATCH',
        headers: { ...airtableHeaders, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields: { LastAlertSent: today } }),
      }).catch(e => console.error('LastAlertSent update failed (non-fatal):', e));
    }

    return res.json({ checked: true, alertFired: alertRes.ok, expiringIn30, expiringIn60, expiringIn90 });

  } catch (err) {
    console.error('consent-expiry-check alert error:', err);
    return res.json({ checked: true, alertFired: false, expiringIn30, expiringIn60, expiringIn90 });
  }
}

// ── SIMULATION-RUN handler v5.1 ───────────────────────────────
// POST ?action=simulation-run { userId, regulator }
// regulator: 'ICO' | 'ASA' | 'CMA'
// All three now fully implemented.
async function handleSimulationRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, regulator } = req.body;
  if (!userId)    return res.status(400).json({ error: 'userId required' });
  if (!regulator) return res.status(400).json({ error: 'regulator required' });
  if (!['ICO', 'CMA', 'ASA'].includes(regulator)) {
    return res.status(400).json({ error: 'regulator must be ICO | CMA | ASA' });
  }

  const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
  const BASE_ID         = process.env.BASE_ID;
  const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
  const airtableBase    = `https://api.airtable.com/v0/${BASE_ID}`;
  const airtableHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const today           = new Date().toISOString().split('T')[0];

  const fixesRes  = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;

  const pendingFixes   = fixesData?.fixes?.pending   || [];
  const completedFixes = fixesData?.fixes?.completed || [];
  const score          = fixesData?.score            || 0;
  const exposure       = fixesData?.exposure         || {};

  const criticalFixes = pendingFixes.filter(f => f.severity === 'critical');
  const highFixes     = pendingFixes.filter(f => f.severity === 'high');

  // ── Stage 1: regulator-aware background checks ─────────────
  const regulatorChecks = {
    ICO: [
      {
        label:  'ICO Registration',
        detail: score > 0 ? 'Organisation appears to be processing data and should be registered with the ICO.' : 'No compliance data found — ICO registration status unknown.',
        status: score > 0 ? 'amber' : 'red',
      },
      {
        label:  'Previous Complaint History',
        detail: completedFixes.length > 0 ? `${completedFixes.length} previous fix items resolved — shows some compliance activity.` : 'No resolved compliance items on record.',
        status: completedFixes.length > 0 ? 'green' : 'amber',
      },
      {
        label:  'Compliance Score',
        detail: `Current score: ${score}/100. ${score < 50 ? 'Below 50 — investigators would identify a pattern of non-compliance.' : score < 75 ? 'Score indicates partially addressed gaps.' : 'Score indicates active compliance management.'}`,
        status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red',
      },
      {
        label:  'Pending Fix Items',
        detail: pendingFixes.length > 0 ? `${pendingFixes.length} outstanding action item${pendingFixes.length !== 1 ? 's' : ''}, including ${criticalFixes.length} critical and ${highFixes.length} high severity.` : 'No outstanding fix items — good standing.',
        status: criticalFixes.length > 0 ? 'red' : pendingFixes.length > 3 ? 'amber' : 'green',
      },
      {
        label:  'Sector Risk Profile',
        detail: 'Email marketing is a priority enforcement sector for the ICO under PECR.',
        status: 'amber',
      },
    ],
    ASA: [
      {
        label:  'Advertiser Record',
        detail: completedFixes.length > 0 ? 'No prior upheld rulings identified. Resolved fix items suggest some compliance effort.' : 'No prior ASA engagement on record.',
        status: 'green',
      },
      {
        label:  'Content Compliance Score',
        detail: `Sendwize compliance score: ${score}/100. ${score < 50 ? 'Multiple potential CAP Code issues identified.' : score < 75 ? 'Some CAP Code gaps identified.' : 'Generally good compliance posture.'}`,
        status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red',
      },
      {
        label:  'CAP Code Issues',
        detail: (() => {
          const asaTypes = ['fake_urgency','fake_scarcity','misleading_claim','misleading_reference_price','misleading_free_claim','unauthorised_health_claim','misleading_testimonial','undisclosed_ad'];
          const asaIssues = pendingFixes.filter(f => asaTypes.includes(f.fixType)).length;
          return asaIssues > 0 ? `${asaIssues} ASA-relevant issue(s) identified — these would be the primary focus of investigation.` : 'No ASA-specific issues currently flagged.';
        })(),
        status: criticalFixes.length > 0 ? 'red' : pendingFixes.length > 2 ? 'amber' : 'green',
      },
      {
        label:  'Pre-Campaign Evidence (CAP 4.1)',
        detail: 'CAP Code 4.1 requires evidence to be held before the campaign runs. Absence of a pre-campaign evidence file is one of the most common reasons for upheld rulings.',
        status: 'amber',
      },
      {
        label:  'Ad Status',
        detail: 'If the challenged ad is still running, the ASA can request it be paused pending investigation for serious breaches. Voluntarily withdrawing the ad before investigation begins is a significant mitigating factor.',
        status: 'amber',
      },
    ],
    CMA: [
      {
        label:  'DMCCA Compliance Sweep',
        detail: 'The CMA has conducted sweeps of over 400 businesses since April 2025. Drip pricing, fake urgency, and fake reviews are current priority enforcement areas.',
        status: 'amber',
      },
      {
        label:  'Pricing Practice Risk',
        detail: (() => {
          const cmaTypes = ['misleading_reference_price','misleading_pricing','drip_pricing','fake_urgency','dark_pattern'];
          const cmaIssues = pendingFixes.filter(f => cmaTypes.includes(f.fixType)).length;
          return cmaIssues > 0 ? `${cmaIssues} pricing or urgency issue(s) flagged — these are the CMA's primary enforcement focus under DMCCA.` : 'No pricing-specific issues currently flagged.';
        })(),
        status: pendingFixes.filter(f => ['misleading_reference_price','misleading_pricing','drip_pricing','fake_urgency'].includes(f.fixType)).length > 0 ? 'red' : 'green',
      },
      {
        label:  'Review Practices',
        detail: pendingFixes.filter(f => f.fixType === 'misleading_testimonial').length > 0 ? 'Potential fake review or testimonial issue identified — Schedule 20 DMCCA banned practice. No context defence available.' : 'No review manipulation issues identified.',
        status: pendingFixes.filter(f => f.fixType === 'misleading_testimonial').length > 0 ? 'red' : 'green',
      },
      {
        label:  'Compliance Score',
        detail: `Current score: ${score}/100. ${score < 50 ? 'Multiple consumer law concerns identified.' : score < 75 ? 'Partially addressed compliance gaps.' : 'Generally good compliance posture.'}`,
        status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red',
      },
      {
        label:  'Prior CMA Engagement',
        detail: 'No prior CMA investigation or undertaking identified. First-time cases with genuine co-operation typically attract lower penalties under DMCCA.',
        status: 'green',
      },
    ],
  };

  const stage1Checks = regulatorChecks[regulator] || regulatorChecks.ICO;

  // ── Stage 2: regulator-aware escalation probability ─────────
  const probBase = { ICO: 20, ASA: 15, CMA: 25 }[regulator] || 20;
  const complaintProbability = Math.min(
    95,
    probBase + (criticalFixes.length * 20) + (highFixes.length * 5) + (score < 50 ? 20 : 0)
  );

  const escalationFactors = [];

  if (regulator === 'ASA') {
    const asaTypes  = ['fake_urgency','fake_scarcity','misleading_claim','misleading_reference_price','misleading_free_claim','unauthorised_health_claim','misleading_testimonial','undisclosed_ad'];
    const asaIssues = pendingFixes.filter(f => asaTypes.includes(f.fixType));
    if (asaIssues.length > 0) escalationFactors.push({ icon: '⛔', text: `${asaIssues.length} CAP Code violation(s) identified. Competitors as well as consumers can file ASA complaints — this is common in retail and ecommerce.` });
    if (score < 60)           escalationFactors.push({ icon: '📊', text: 'Multiple compliance gaps increase the likelihood the ASA would find the ad broke the rules rather than treating it as a borderline case.' });
    escalationFactors.push({ icon: '📋', text: 'The ASA resolves around 80% of complaints without formal investigation — but formal investigation is more likely where evidence was not held before the campaign ran (CAP 4.1).' });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '✅', text: `${completedFixes.length} resolved issues demonstrates some compliance activity — this supports an informal resolution outcome.` });
  } else if (regulator === 'CMA') {
    const cmaTypes  = ['misleading_reference_price','misleading_pricing','drip_pricing','fake_urgency','dark_pattern','misleading_testimonial'];
    const cmaIssues = pendingFixes.filter(f => cmaTypes.includes(f.fixType));
    if (cmaIssues.length > 0) escalationFactors.push({ icon: '⛔', text: `${cmaIssues.length} DMCCA-relevant issue(s) identified. The CMA launched its first DMCCA enforcement cases in November 2025 and has signalled further enforcement will follow across all sectors.` });
    escalationFactors.push({ icon: '🔍', text: 'The CMA conducted proactive sweeps of over 400 businesses in 2025. Businesses do not need to receive a complaint to be investigated — the CMA identifies non-compliance through its own monitoring.' });
    if (score < 50) escalationFactors.push({ icon: '📊', text: `Compliance score of ${score}/100 indicates a pattern of consumer law concerns — the CMA prioritises systemic non-compliance over isolated incidents.` });
    escalationFactors.push({ icon: '⚖️', text: 'Under DMCCA, the CMA can fine up to 10% of global turnover without court proceedings. First-time cases with genuine co-operation attract lower penalties and settlement discounts are available.' });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '✅', text: `${completedFixes.length} resolved issues can be cited as evidence of good-faith compliance effort — a mitigating factor in CMA penalty decisions.` });
  } else {
    // ICO
    if (criticalFixes.length > 0)  escalationFactors.push({ icon: '⛔', text: 'One or more critical unresolved violations — these would be the primary basis for ICO enforcement action.' });
    if (score < 50)                escalationFactors.push({ icon: '📊', text: `Compliance score of ${score}/100 indicates a systemic pattern rather than an isolated incident.` });
    if (pendingFixes.length > 5)   escalationFactors.push({ icon: '⚠️', text: `${pendingFixes.length} unresolved fix items suggests ongoing non-compliance rather than a one-off issue.` });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '✅', text: `${completedFixes.length} resolved fix items demonstrates some compliance effort — this is a mitigating factor.` });
  }

  if (escalationFactors.length === 0) {
    escalationFactors.push({ icon: '✅', text: 'No significant escalation factors identified based on current compliance data.' });
  }

  // ── Stages 3-5: regulator-specific Claude prompt ────────────
  const regulatorConfig = {
    ICO: {
      orgName:    "Information Commissioner's Office",
      dept:       "Enforcement & Investigations",
      refPrefix:  "ICO-ENF",
      signatory:  "Senior Enforcement Officer, Direct Marketing Team",
      tone:       "formal ICO enforcement tone. References PECR Regulation 22 and UK GDPR specifically by article and regulation number.",
      letterType: "preliminary enquiry letter",
      questions:  "5 questions about: (1) consent records and the exact consent wording shown at collection, (2) suppression processes and evidence they were applied, (3) data retention policy and how long marketing data is held, (4) whether every marketing message contained a clear and free opt-out mechanism, (5) the lawful basis under which recipients' data was processed for direct marketing",
      docs:       "7 documents: consent records, legitimate interest assessment, privacy notice, suppression log, data retention schedule, opt-out mechanism evidence, staff training records",
      penaltyNote:"ICO PECR max £500,000. UK GDPR max £17,500,000 or 4% global turnover. Base penalty estimates on the severity and volume of violations identified in the compliance data above.",
      penaltyCtx: "The ICO has broad discretion in setting penalties. For first-time PECR breaches with prompt remedial action and genuine co-operation, penalties are typically at the lower end of the range. Repeated or deliberate breaches, or failure to co-operate, can lead to maximum fines.",
      disclaimerNote: "Penalty estimates are illustrative ranges based on published ICO enforcement decisions.",
    },
    ASA: {
      orgName:    "Advertising Standards Authority",
      dept:       "Investigations Executive",
      refPrefix:  "ASA-ENQ",
      signatory:  "Investigations Executive, Advertising Standards Authority",
      tone:       "formal but collaborative ASA tone. References specific CAP Code rules by number (e.g. CAP 3.7, CAP 4.1, CAP 3.17). The ASA prefers working by persuasion and agreement.",
      letterType: "formal investigation notification — noting that the ASA prefers informal resolution where possible",
      questions:  "5 questions about: (1) what pre-campaign evidence was held before the campaign ran (CAP 4.1 — evidence must exist before, not after), (2) substantiation for any specific claims made, (3) promotion end dates and evidence the promotion genuinely expired as stated, (4) testimonial authenticity records and whether results claimed are typical, (5) whether the ad has been amended or withdrawn since the complaint",
      docs:       "7 items: pre-campaign evidence file, promotional end date records, testimonial evidence file, claim substantiation documents, all versions of the campaign creative, advertiser's response to the complaint, confirmation of whether the ad is still running",
      penaltyNote:"The ASA does not impose financial fines directly. Set penalty.low and penalty.high both to 0. The sanctions are: mandatory ad withdrawal, public ruling published on asa.org.uk every Wednesday (permanently searchable), mandatory pre-vetting of future ads for serious repeat offenders, referral to Trading Standards under DMCCA 2024 for persistent non-compliance.",
      penaltyCtx: "The ASA does not impose direct financial penalties. However, an upheld ruling is published publicly on asa.org.uk and remains permanently searchable — this is significant reputational and commercial risk. Serious or repeat breaches can result in referral to Trading Standards under DMCCA 2024, who can impose fines up to 10% of global turnover. Voluntarily withdrawing or amending the ad before investigation concludes is a significant mitigating factor.",
      disclaimerNote: "The ASA does not impose financial fines — sanctions are reputational and operational. Referral to Trading Standards is possible for persistent non-compliance.",
    },
    CMA: {
      orgName:    "Competition and Markets Authority",
      dept:       "Consumer Protection Directorate",
      refPrefix:  "CMA-CP",
      signatory:  "Senior Director, Consumer Protection",
      tone:       "formal CMA enforcement tone under DMCCA 2024. References specific CPR regulations and DMCCA Schedule 1 banned practices by name. The CMA can act without court proceedings.",
      letterType: "preliminary enquiry — noting the CMA may proceed to a Provisional Infringement Notice (PIN) if concerns are confirmed",
      questions:  "5 questions about: (1) pricing history records — evidence that any reference 'was' prices are genuine (held for at least 28 days at sufficient volume), (2) countdown timer systems — technical evidence that timers are linked to actual price changes and end when stated, (3) subscription cancellation processes — evidence that cancellation is as easy as sign-up, (4) consumer review collection and moderation — what steps are taken to prevent fake or misleading reviews (DMCCA Schedule 20), (5) drip pricing — how mandatory charges are disclosed and at what stage of the purchase journey",
      docs:       "7 items: pricing history records for any reference price claims, countdown timer system technical documentation, subscription cancellation process evidence, consumer review policy and moderation records, full purchase journey screenshots showing price disclosure at each stage, consumer complaint log for the past 12 months, evidence of any compliance officer or compliance framework",
      penaltyNote:"CMA DMCCA max: the higher of £300,000 or 10% of global annual turnover. No court needed — direct administrative fine. Settlement discounts available for co-operation. Consumer redress orders possible in addition to fines. Base estimates on violation severity.",
      penaltyCtx: "The CMA can impose direct administrative fines without court proceedings under DMCCA 2024. Businesses that co-operate promptly, acknowledge the issue, and demonstrate genuine remediation can negotiate settlement discounts. The CMA can also order consumer redress payments to affected customers in addition to any fine.",
      disclaimerNote: "Penalty estimates are based on DMCCA 2024 — the higher of £300,000 or 10% of global annual turnover. First enforcement cases were opened November 2025.",
    },
  };

  const cfg = regulatorConfig[regulator] || regulatorConfig.ICO;

  const fixSummary = pendingFixes.slice(0, 5).map(f =>
    `- ${f.fixType.replace(/_/g, ' ')} (${f.severity}): ${f.description}`
  ).join('\n');

  const claudePrompt = `You are simulating a ${regulator} (${cfg.orgName}) direct marketing enforcement investigation.

USER COMPLIANCE DATA:
- Compliance score: ${score}/100
- Critical violations: ${criticalFixes.length}
- High violations: ${highFixes.length}
- Total pending fixes: ${pendingFixes.length}
- Estimated exposure: £${(exposure.medianHigh || 0).toLocaleString('en-GB')}
- Top issues:
${fixSummary || 'None identified'}

Writing instructions:
- Tone: ${cfg.tone}
- Document type: ${cfg.letterType}
- Questions to ask: ${cfg.questions}
- Documentation to request: ${cfg.docs}
- Penalty guidance: ${cfg.penaltyNote}

Respond ONLY with this exact JSON (no preamble, no markdown fences):
{
  "letter": {
    "reference": "${cfg.refPrefix}-XXXXX",
    "subject": "subject line referencing the specific concern identified in the compliance data above",
    "opening": "opening paragraph (2-3 sentences, appropriate tone)",
    "context": "context paragraph (1-2 sentences explaining what happens next in this regulator's process)",
    "closing": "closing paragraph about response deadline and consequences of non-response",
    "signatory": "${cfg.signatory}",
    "questions": [
      { "question": "Question text", "yesNote": "What yes means — how this helps the investigation outcome", "noNote": "What no means — how this affects the investigation outcome" },
      { "question": "Question text", "yesNote": "...", "noNote": "..." },
      { "question": "Question text", "yesNote": "...", "noNote": "..." },
      { "question": "Question text", "yesNote": "...", "noNote": "..." },
      { "question": "Question text", "yesNote": "...", "noNote": "..." }
    ]
  },
  "documents": [
    { "name": "document name", "status": "available|partial|missing", "detail": "brief explanation based on user compliance data — be specific about what gaps exist" }
  ],
  "penalty": {
    "low": 0,
    "high": 0,
    "context": "${cfg.penaltyCtx}"
  },
  "representations": [
    "Specific actionable representation strategy item tailored to this regulator's process",
    "Specific actionable representation strategy item",
    "Specific actionable representation strategy item",
    "Specific actionable representation strategy item",
    "Specific actionable representation strategy item"
  ]
}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
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

  // Write to Simulation_Reports
  let reportId = null;
  try {
    const reportRes = await fetch(`${airtableBase}/Simulation_Reports`, {
      method:  'POST',
      headers: airtableHeaders,
      body: JSON.stringify({
        records: [{
          fields: {
            UserID:                userId,
            SimulationDate:        today,
            Regulator:             regulator,
            ComplaintProbability:  complaintProbability,
            PenaltyEstimateLow:    claudeOutput.penalty?.low    || 0,
            PenaltyEstimateHigh:   claudeOutput.penalty?.high   || 0,
            SimulationVersion:     `${regulator}-2026-v1`,
            SimulationJson:        JSON.stringify(claudeOutput),
          }
        }]
      })
    });
    if (reportRes.ok) {
      reportId = (await reportRes.json()).records?.[0]?.id ?? null;
    }
  } catch (err) {
    console.error('Simulation_Reports write error (non-fatal):', err);
  }

  return res.status(200).json({
    reportId,
    regulator,
    stage1: { checks: stage1Checks },
    stage2: { probability: complaintProbability, factors: escalationFactors },
    stage3: { letter: claudeOutput.letter || {} },
    stage4: { documents: claudeOutput.documents || [] },
    stage5: {
      penalty: claudeOutput.penalty || { low: 0, high: 0, context: '' },
      representations: claudeOutput.representations || [],
    },
    disclaimer: cfg.disclaimerNote,
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
    if (req.method === 'GET'    && action === 'report')               return await handleReport(req, res);
    if (req.method === 'GET'    && action === 'vendors')              return await handleVendors(req, res);
    if (req.method === 'GET'    && action === 'violations')           return await handleViolations(req, res);
    if (req.method === 'POST'   && action === 'load')                 return await handleLoad(req, res);
    if (req.method === 'GET'    && action === 'history')              return await handleHistory(req, res);
    if (req.method === 'GET'    && action === 'summary')              return await handleSummary(req, res);
    if ((req.method === 'POST' || req.method === 'DELETE') && action === 'register') return await handleRegister(req, res);
    if ((req.method === 'GET'  || req.method === 'POST')  && action === 'score-history') return await handleScoreHistory(req, res);
    if (req.method === 'POST'   && action === 'send-alert')           return await handleSendAlert(req, res);
    if (req.method === 'GET'    && action === 'briefing')             return await handleBriefing(req, res);
    if (req.method === 'POST'   && action === 'consent-expiry-check') return await handleConsentExpiryCheck(req, res);
    if (req.method === 'POST'   && action === 'simulation-run')       return await handleSimulationRun(req, res);

    return res.status(400).json({
      error: 'Unknown action',
      valid: 'report | vendors | violations | load | history | register | summary | score-history | send-alert | briefing | consent-expiry-check | simulation-run'
    });

  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
