// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v6.2
// Router: ?action=report | vendors | violations | load | history
//         | register | summary | score-history | send-alert
//         | briefing | consent-expiry-check | simulation-run
//
// v6.2 changes (C4 — Regulator Simulator reflects actual fix records):
//   - handleSimulationRun rewritten. Stages 4 and 5 are now DETERMINISTIC
//     and derived directly from the user's pending Compliance_Fixes,
//     not Claude-generated. D2 principle: no invented values.
//
//   Stage 4 (documents) — new computeStage4Documents():
//     Templated doc list per regulator. Each doc has a set of trigger
//     fix types. Pending fix hits a trigger → status becomes missing
//     (critical/high) or partial (medium), with the fix description
//     surfaced as the detail. No trigger → status 'available' with a
//     'no related issue flagged, verify before responding' note.
//
//   Stage 5 penalty — new computeStage5Penalty():
//     ICO: sums fix.exposure.realisticLow/High across pending ICO-
//     category fixes. Ranges are already banded per revenue in fixes.js
//     v6.4, so the sum is directly comparable to published enforcement.
//     ASA: always £0 (reputational). Context explains what actually
//     happens (ruling published, mandatory withdrawal, Trading Standards
//     referral risk).
//     CMA: severity-weighted count (critical × 15k/60k, high × 8k/30k,
//     medium × 3k/10k), capped by revenue band. CMA fixes don't carry
//     per-fix exposure figures in generate-fix.js — this is documented
//     inline as an estimate, not a legal prediction.
//
//   Stage 5 representations — new computeStage5Representations():
//     First 3 items derived from actual critical/high pending fixes in
//     the selected regulator's category. Each rep names the fix type
//     and quotes the short description. Then 2 universal reps
//     (acknowledge completed fixes if any; co-operation baseline).
//
//   Stage 3 letter — still Claude, but prompt now embeds every pending
//     regulator-category fix so questions are specific to actual issues.
//     Prompt trimmed (~500 tokens vs previous 2000), max_tokens 1000.
//     Cheaper per run and directly traceable to fix records.
//
//   Stages 1 & 2 — unchanged, already fix-derived in v6.1.
//
// v6.1 changes (carried forward):
//   - All Airtable calls via atFetch() for 429/5xx retry.
// ─────────────────────────────────────────────────────────────

import { atFetch } from './_airtable.js';

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
    dossier:     'Campaign_Dossiers',
    pecr:        'Suppression_Checks',
    audience:    'Audience_Read_Campaigns',
  };

  const tableName = tables[type];
  if (!tableName) return res.status(400).json({ error: 'Invalid report type' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await atFetch(
    `https://api.airtable.com/v0/${BASE_ID}/${tableName}/${recordId}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable report fetch failed after retries:', response.status);
    return res.status(response.status).json({ error: 'Failed to fetch report' });
  }

  return res.json(await response.json());
}

// ── VENDORS handler ───────────────────────────────────────────
async function handleVendors(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await atFetch(
    `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?sort[0][field]=VendorName&sort[0][direction]=asc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Marketing_Vendors fetch failed after retries:', response.status);
    return res.json({ vendors: [] });
  }

  const data    = await response.json();
  const vendors = (data.records || []).map(r => ({
    name:                  r.fields.VendorName                      || '',
    vendorType:            r.fields.VendorType                      || '',
    icoRegistrationStatus: r.fields.ICORegistered                   || 'Unknown',
    icoRegistrationNumber: r.fields.ICORegNumber                    || '',
    dpaStatus:             r.fields.DPAStatus                       || 'Unknown',
    dpaLink:               r.fields.PrivacyPolicyUrl                || '',
    internationalTransfer: r.fields.TransferMechanismConfirmed      || 'Unknown',
    knownBreachHistory:    r.fields.BreachHistory                   || '',
    dpoPresence:           r.fields.DPOConfirmed                    || 'Unknown',
    isoAccreditation:      r.fields.RelevantSecurityCertification   || 'Unknown',
    privacyPolicyNotes:    r.fields.PrivacyPolicyUrl                || '',
    lastVerified:          r.fields.LastVerified                    || '',
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

  const response = await atFetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!response.ok) {
    console.error('Violation_Database fetch failed after retries:', response.status);
    return res.status(response.status).json({ error: 'Failed to fetch violations' });
  }

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
async function handleHistory(req, res) {
  const { type, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const validTypes = ['audit', 'vendor', 'ai', 'suppression', 'audience'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(' | ')}` });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const tableMap = {
    audit:       { table: 'Database_Audits',        sort: 'AuditDate'   },
    vendor:      { table: 'Vendor_Register',         sort: 'LastChecked' },
    ai:          { table: 'AI_Compliance_Checks',    sort: 'CheckDate'   },
    suppression: { table: 'Suppression_Checks',      sort: 'CheckDate'   },
    audience:    { table: 'Audience_Read_Campaigns', sort: 'SendDate'    },
  };

  const { table, sort } = tableMap[type];
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}` +
    `?filterByFormula={UserID}='${userId}'` +
    `&sort[0][field]=${sort}&sort[0][direction]=desc` +
    `&maxRecords=20`;

  const response = await atFetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!response.ok) {
    console.error(`Airtable history (${type}) fetch failed after retries:`, response.status);
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

    const response = await atFetch(`${airtableBase}/Vendor_Register/${recordId}`, {
      method: 'DELETE', headers: authHeader,
    });
    if (!response.ok) {
      console.error('Vendor_Register delete failed after retries:', response.status);
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
      VendorName: vendor.VendorName || '',
      VendorType: vendor.VendorType || '',
      DPASigned:  vendor.DPASigned  || '',
      DPALink:    vendor.DPALink    || '',
      Notes:      vendor.Notes      || '',
    };

    Object.keys(fields).forEach(k => { if (!fields[k]) delete fields[k]; });

    if (recordId) {
      const response = await atFetch(`${airtableBase}/Vendor_Register/${recordId}`, {
        method: 'PATCH',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!response.ok) {
        console.error('Vendor_Register patch failed after retries:', response.status);
        return res.status(response.status).json({ error: 'Failed to update vendor' });
      }
      return res.json({ record: await response.json() });
    } else {
      fields.LastChecked = new Date().toISOString().split('T')[0];
      const response = await atFetch(`${airtableBase}/Vendor_Register`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!response.ok) {
        console.error('Vendor_Register post failed after retries:', response.status);
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
    fetch(`${APP_URL}/api/profile?action=get&userId=${userId}`),
  ]);

  const fixesData   = fixesRes.ok   ? await fixesRes.json()   : null;
  const profileData = profileRes.ok ? await profileRes.json() : null;

  return res.json({
    score:          fixesData?.score                    ?? 0,
    scoreBand:      fixesData?.scoreBand                ?? 'Not Started',
    pendingCount:   fixesData?.fixes?.pending?.length   ?? 0,
    completedCount: fixesData?.fixes?.completed?.length ?? 0,
    actioned: {
      total: fixesData?.actioned?.total ?? 0,
      count: fixesData?.actioned?.count ?? 0,
    },
    categoryCounts: fixesData?.categoryCounts ?? {
      pending:   { ico: 0, asa: 0, cma: 0 },
      completed: { ico: 0, asa: 0, cma: 0 },
    },
    streak:        profileData?.currentStreak ?? 0,
    longestStreak: profileData?.longestStreak ?? 0,
    lastCheckDate: profileData?.lastCheckDate ?? null,
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
    const response   = await atFetch(
      `${airtableBase}/Score_History?filterByFormula={UserID}='${userId}'&sort[0][field]=Date&sort[0][direction]=desc&maxRecords=${maxRecords}`,
      { headers }
    );

    if (!response.ok) {
      console.error('Score_History fetch failed after retries:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch score history' });
    }

    const snapshots = ((await response.json()).records || []).map(r => ({
      id:           r.id,
      date:         r.fields.Date         || '',
      score:        r.fields.Score        || 0,
      pending:      r.fields.Pending      || 0,
      completed:    r.fields.Completed    || 0,
      scoreChange:  r.fields.ScoreChange  || 0,
      triggerEvent: r.fields.TriggerEvent || '',
      exposureLow:  r.fields.ExposureLow  || 0,
      exposureHigh: r.fields.ExposureHigh || 0,
    }));

    return res.json({ snapshots });
  }

  if (req.method === 'POST') {
    const {
      userId,
      score,
      pending      = 0,
      completed    = 0,
      triggerEvent = 'Dashboard Load',
    } = req.body;

    if (!userId)             return res.status(400).json({ error: 'userId required' });
    if (score === undefined) return res.status(400).json({ error: 'score required' });

    const prevRes   = await atFetch(
      `${airtableBase}/Score_History?filterByFormula={UserID}='${userId}'&sort[0][field]=Date&sort[0][direction]=desc&maxRecords=1`,
      { headers }
    );
    const prevData  = prevRes.ok ? await prevRes.json() : { records: [] };
    const prevScore = prevData.records?.[0]?.fields?.Score ?? score;
    const scoreChange = score - prevScore;

    const today = new Date().toISOString().split('T')[0];

    const fields = Object.fromEntries(Object.entries({
      UserID:       userId,
      Date:         today,
      Score:        score,
      Pending:      pending,
      Completed:    completed,
      ExposureLow:  0,
      ExposureHigh: 0,
      ScoreChange:  scoreChange,
      TriggerEvent: triggerEvent,
      AlertSent:    false,
    }).filter(([, v]) => v !== null && v !== undefined));

    const createRes = await atFetch(`${airtableBase}/Score_History`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [{ fields }] }),
    });

    if (!createRes.ok) {
      console.error('Score_History create failed after retries:', createRes.status);
      return res.status(createRes.status).json({ error: 'Failed to save snapshot' });
    }

    const snapshotId = (await createRes.json()).records?.[0]?.id;
    let alertFired   = false;

    if (scoreChange <= -10) {
      const profileRes  = await atFetch(
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
            body:    JSON.stringify({ userId, alertType: 'score_drop', score, scoreChange }),
          });

          if (alertRes.ok) {
            alertFired = true;
            const patches = [];
            if (snapshotId) {
              patches.push(atFetch(`${airtableBase}/Score_History/${snapshotId}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({ fields: { AlertSent: true } }),
              }));
            }
            if (profile?.id) {
              patches.push(atFetch(`${airtableBase}/User_Profile/${profile.id}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({ fields: { LastAlertSent: today } }),
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

  const { userId, alertType, score, scoreChange } = req.body;
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
  const profileRes   = await atFetch(
    `${airtableBase}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const profileData  = profileRes.ok ? await profileRes.json() : { records: [] };
  const toEmail      = profileData.records?.[0]?.fields?.Email;

  if (!toEmail) {
    console.warn(`No email on User_Profile for userId=${userId} — alert skipped`);
    return res.json({ sent: false, reason: 'No email address on profile' });
  }

  const absChange = Math.abs(scoreChange || 0);
  let subject = '';
  let html    = '';

  if (alertType === 'score_drop') {
    subject = `\u26a0\ufe0f Your Sendwize compliance score dropped by ${absChange} points`;
    html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
          <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Compliance score alert</h2>
          <p style="color:#555;margin:0 0 24px;font-size:14px;">
            Your score dropped by <strong>${absChange} points</strong>, now at
            <strong>${score}/100</strong>. New issues have been identified that
            need your attention. Log in to review and action them.
          </p>
          <a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            View your dashboard \u2192
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Illustrative risk indicators based on ICO/ASA/CMA enforcement data.
            Not legal advice.
          </p>
        </div>
      </div>`;

  } else if (alertType === 'consent_expiry') {
    subject = `\u23f0 Sendwize: consent expiry approaching \u2014 action recommended`;
    html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
          <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Consent expiry notice</h2>
          <p style="color:#555;margin:0 0 24px;font-size:14px;">
            One or more contact segments in your database may have consent expiring within
            <strong>30 days</strong>. Review your List Intelligence and consider a
            re-consent campaign before sending to these contacts.
          </p>
          <a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            View your dashboard \u2192
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Information only \u2014 not legal advice. Sendwize
          </p>
        </div>
      </div>`;

  } else if (alertType === 'audience_damaged') {
    const { segmentName, sentimentState, regulatoryNote } = req.body;
    subject = `\ud83d\udcca Sendwize: audience alert \u2014 ${segmentName || 'a segment'} needs attention`;
    html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
          <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Audience Read alert</h2>
          <p style="color:#555;margin:0 0 8px;font-size:14px;">
            Your <strong>${segmentName || 'audience'}</strong> segment has moved to
            <strong>${sentimentState || 'a negative sentiment state'}</strong>.
          </p>
          ${regulatoryNote ? `<p style="color:#555;margin:0 0 24px;font-size:13px;background:#fdf4ff;border-left:4px solid #7e22ce;padding:12px 16px;border-radius:4px;">${regulatoryNote}</p>` : ''}
          <a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy"
             style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
            View Audience Read \u2192
          </a>
          <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
            Audience Read uses deterministic algorithms on your own data only \u2014 no AI.
            Regulatory notes are illustrative consequences, not legal advice.
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

  const profileRes  = await atFetch(
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

  const pending        = fixesData?.fixes?.pending   || [];
  const score          = fixesData?.score            || 0;
  const scoreBand      = fixesData?.scoreBand        || '';
  const actionedTotal  = fixesData?.actioned?.total  || 0;
  const actionedCount  = fixesData?.actioned?.count  || 0;
  const categoryCounts = fixesData?.categoryCounts   || {};

  const fmtGBP = n => `\u00a3${(n || 0).toLocaleString('en-GB')}`;

  const fixSummary = pending.slice(0, 5).map(f =>
    `- ${f.fixType.replace(/_/g, ' ')} (${f.severity}): ${f.description}`
  ).join('\n');

  const promptContext = [
    `Compliance score: ${score}/100 (${scoreBand})`,
    `Pending fixes: ${pending.length} (ICO: ${categoryCounts?.pending?.ico || 0}, ASA: ${categoryCounts?.pending?.asa || 0}, CMA: ${categoryCounts?.pending?.cma || 0})`,
    actionedCount > 0
      ? `Fixes actioned: ${actionedCount}. Comparable case risk addressed: ${fmtGBP(actionedTotal)} (based on published enforcement decisions \u2014 not a legal prediction).`
      : 'No fixes actioned yet.',
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
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You are a compliance advisor for UK email marketers. Write a concise, practical weekly briefing of around 150\u2013200 words. Tone: professional but plain-English, never alarmist. Never say "compliant" or "in breach" \u2014 use hedged language. Never give legal advice. If fixes have been actioned, acknowledge the progress made. End with one specific suggested action for this week.`,
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
    await atFetch(`${airtableBase}/User_Profile/${profile.id}`, {
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

  const auditRes  = await atFetch(
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

  const profileRes  = await atFetch(
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
      await atFetch(`${airtableBase}/User_Profile/${profile.id}`, {
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

// ─────────────────────────────────────────────────────────────
// SIMULATION HELPERS (v6.2 — C4)
// ─────────────────────────────────────────────────────────────

// Documents template per regulator. Each doc has a set of trigger fix
// types. A pending fix matching any trigger flips the doc's status.
// If no fix triggers a doc, it defaults to 'available' with a
// verify-before-response caveat (we don't actually know it's on file —
// but we haven't flagged it as an issue either).
const SIM_DOC_TEMPLATES = {
  ICO: [
    { name: 'Consent Records',                            triggers: ['consent_missing','consent_expired'] },
    { name: 'Data Processing Agreement (Email Platform)', triggers: ['dpa_breach'] },
    { name: 'Legitimate Interest Assessment',             triggers: ['legitimate_interest_abuse'] },
    { name: 'Suppression Log',                            triggers: ['suppression_breach'] },
    { name: 'Data Retention Policy',                      triggers: ['data_quality'] },
    { name: 'Privacy Notice',                             triggers: [] },
    { name: 'Opt-out Mechanism Evidence',                 triggers: [] },
  ],
  ASA: [
    { name: 'Reference Price Evidence',                   triggers: ['misleading_reference_price'] },
    { name: 'Countdown Timer Technical Documentation',    triggers: ['fake_urgency'] },
    { name: 'Claim Substantiation File',                  triggers: ['misleading_claim'] },
    { name: 'Ad Labelling Records',                       triggers: ['undisclosed_ad'] },
    { name: 'Pre-Campaign Evidence File (CAP 4.1)',       triggers: [] },
    { name: 'Campaign Creative Materials',                triggers: [] },
    { name: 'Written Response to Complaint',              triggers: [] },
  ],
  CMA: [
    { name: 'Pricing History Records',                    triggers: ['drip_pricing','misleading_reference_price'] },
    { name: 'Countdown Timer Technical Documentation',    triggers: ['fake_urgency'] },
    { name: 'Review Programme Records',                   triggers: ['fake_reviews'] },
    { name: 'DMCCA Compliance Framework',                 triggers: [] },
    { name: 'Purchase Journey Screenshots',               triggers: [] },
    { name: 'Consumer Complaint Log (12 months)',         triggers: [] },
    { name: 'Subscription and Returns Policy',            triggers: [] },
  ],
};

function computeStage4Documents(pendingFixes, regulator) {
  const templates = SIM_DOC_TEMPLATES[regulator] || SIM_DOC_TEMPLATES.ICO;
  return templates.map(t => {
    if (!t.triggers.length) {
      return {
        name:   t.name,
        status: 'available',
        detail: 'No related issue flagged by Sendwize. Assumed to be in place \u2014 verify before submitting a response.',
      };
    }
    const triggeringFix = pendingFixes.find(f => t.triggers.includes(f.fixType));
    if (!triggeringFix) {
      return {
        name:   t.name,
        status: 'available',
        detail: 'No related issue flagged by Sendwize. Assumed to be in place \u2014 verify before submitting a response.',
      };
    }
    const isSerious = ['critical','high'].includes(triggeringFix.severity);
    return {
      name:   t.name,
      status: isSerious ? 'missing' : 'partial',
      detail: `Flagged by Sendwize (${triggeringFix.severity}): ${String(triggeringFix.description || '').slice(0, 220)}`,
    };
  });
}

// Revenue-band caps for CMA (rough proxy for turnover). Used only when
// CMA fix count is non-zero; if no CMA-category fixes, we return 0
// rather than invent a figure.
const CMA_REVENUE_CAPS = {
  under_1m:  140000,
  '1m_10m':  300000,
  '10m_50m': 500000,
  over_50m:  1000000,
};

function computeStage5Penalty(pendingFixes, regulator, revenueBand) {
  if (regulator === 'ASA') {
    return {
      low:  0,
      high: 0,
      context: pendingFixes.length > 0
        ? `The ASA does not impose direct financial fines. Based on the ${pendingFixes.length} pending ASA-relevant issue${pendingFixes.length !== 1 ? 's' : ''} in your Sendwize data, likely sanctions are: mandatory ad withdrawal or amendment; an upheld ruling published permanently on asa.org.uk; and potential referral to Trading Standards under DMCCA 2024 for persistent or serious breach \u2014 at which point CMA fines apply.`
        : 'The ASA does not impose direct financial fines. Sanctions are reputational and operational.',
    };
  }

  const categoryFixes = pendingFixes.filter(f => f.exposure?.category === regulator);

  if (regulator === 'ICO') {
    // Sum per-fix banded exposures from fixes.js. Ranges already reflect
    // published enforcement decisions for the user's revenue band.
    let low = 0, high = 0;
    for (const f of categoryFixes) {
      low  += f.exposure?.realisticLow  || 0;
      high += f.exposure?.realisticHigh || 0;
    }
    const context = categoryFixes.length > 0
      ? `Realistic ICO penalty range built from ${categoryFixes.length} pending ICO-category fix${categoryFixes.length !== 1 ? 'es' : ''} in your Sendwize data. Ranges are anchored to comparable published ICO enforcement decisions for your revenue band. Statutory maximum under DUAA 2025: \u00a317.5M or 4% of global annual turnover \u2014 applies only in cases of deliberate or repeat breach. Full and prompt co-operation with the ICO is a significant mitigating factor in penalty decisions.`
      : `No ICO-category compliance fixes currently pending in your Sendwize data. Statutory maximum under DUAA 2025 remains \u00a317.5M or 4% of global annual turnover for deliberate or repeat breach.`;
    return { low, high, context };
  }

  if (regulator === 'CMA') {
    // CMA fixes don't carry per-fix £ figures from generate-fix.js
    // (they're 0/0 by design). We derive a severity-weighted estimate
    // from the count of pending CMA fixes, capped by revenue band.
    const critical = categoryFixes.filter(f => f.severity === 'critical').length;
    const highSev  = categoryFixes.filter(f => f.severity === 'high').length;
    const medium   = categoryFixes.filter(f => f.severity === 'medium').length;
    let low  = critical * 15000 + highSev * 8000 + medium * 3000;
    let high = critical * 60000 + highSev * 30000 + medium * 10000;
    const cap = CMA_REVENUE_CAPS[revenueBand] || 300000;
    low  = Math.min(low, cap);
    high = Math.min(high, cap);
    const context = categoryFixes.length > 0
      ? `Estimated CMA/DMCCA range based on ${categoryFixes.length} pending CMA-category fix${categoryFixes.length !== 1 ? 'es' : ''} (${critical} critical, ${highSev} high, ${medium} medium) in your Sendwize data, capped by your revenue band. DMCCA 2024 statutory maximum: the higher of \u00a3300,000 or 10% of global annual turnover, imposable without court proceedings. Businesses that co-operate fully and remediate promptly typically qualify for settlement discounts of 20\u201340% \u2014 the first DMCCA cases in November 2025 resulted in undertakings rather than maximum penalties for co-operative businesses.`
      : `No CMA-category compliance fixes currently pending in your Sendwize data. DMCCA 2024 statutory maximum remains the higher of \u00a3300,000 or 10% of global annual turnover.`;
    return { low, high, context };
  }

  return { low: 0, high: 0, context: '' };
}

function computeStage5Representations(pendingFixes, completedFixes, regulator) {
  const reps = [];
  const categoryFixes = pendingFixes.filter(f => f.exposure?.category === regulator);

  // Reps 1-3 — derived directly from actual critical/high fixes in the
  // selected regulator's category. Each rep names the fix and quotes
  // the description so the user can see exactly which record it maps to.
  const priorityFixes = categoryFixes
    .filter(f => ['critical','high'].includes(f.severity))
    .slice(0, 3);

  for (const f of priorityFixes) {
    const rawDesc = String(f.description || '');
    // Trim leading "Tool: " prefix if present
    const cleaned = rawDesc.replace(/^[^:]+:\s*/, '').trim() || rawDesc;
    const short   = cleaned.length > 200 ? cleaned.slice(0, 200) + '\u2026' : cleaned;
    const typeLabel = f.fixType.replace(/_/g,' ');
    reps.push(`Address the ${typeLabel} issue flagged in your Sendwize data before responding: ${short}`);
  }

  // If we didn't have enough priority fixes to fill 3 slots, add
  // sensible fallbacks so the user isn't left with an empty section.
  if (priorityFixes.length === 0) {
    reps.push(`No critical or high-severity ${regulator}-category fixes are currently pending in your Sendwize data. Any response should focus on documenting your existing compliance posture rather than remediating specific breaches.`);
  }

  // Rep 4 — completed fixes as mitigating evidence
  if (completedFixes.length > 0) {
    reps.push(`Cite the ${completedFixes.length} fix${completedFixes.length !== 1 ? 'es' : ''} you have already actioned in Sendwize as evidence of active compliance improvement. All three UK regulators explicitly weight prior remedial action as a mitigating factor in penalty decisions.`);
  } else {
    reps.push(`No completed fixes on record. Consider actioning your highest-severity pending items now \u2014 evidence of prompt remediation before the regulator response is due carries significant mitigating weight.`);
  }

  // Rep 5 — universal co-operation baseline
  const coopNote = {
    ICO: 'The ICO\u2019s published penalty guidance explicitly gives significant credit to businesses that engage openly and remediate quickly.',
    ASA: 'The ASA prefers informal resolution and rewards voluntary withdrawal of the ad before the ruling is issued.',
    CMA: 'The CMA\u2019s first DMCCA cases show that co-operative businesses received undertakings rather than maximum penalties. Settlement discounts of 20\u201340% are available for prompt and full co-operation.',
  }[regulator] || '';
  reps.push(`Co-operate fully and respond promptly. ${coopNote}`);

  return reps.slice(0, 5);
}

// ── SIMULATION-RUN handler v6.2 ───────────────────────────────
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
  const revenueBand    = fixesData?.revenueBand      || 'under_1m';

  const criticalFixes = pendingFixes.filter(f => f.severity === 'critical');
  const highFixes     = pendingFixes.filter(f => f.severity === 'high');

  // ── STAGE 1 — Background check (unchanged from v6.1) ────────
  const regulatorChecks = {
    ICO: [
      { label: 'ICO Registration', detail: score > 0 ? 'Organisation appears to be processing data and should be registered with the ICO.' : 'No compliance data found \u2014 ICO registration status unknown.', status: score > 0 ? 'amber' : 'red' },
      { label: 'Previous Complaint History', detail: completedFixes.length > 0 ? `${completedFixes.length} previous fix items resolved \u2014 shows some compliance activity.` : 'No resolved compliance items on record.', status: completedFixes.length > 0 ? 'green' : 'amber' },
      { label: 'Compliance Score', detail: `Current score: ${score}/100. ${score < 50 ? 'Below 50 \u2014 investigators would identify a pattern of non-compliance.' : score < 75 ? 'Score indicates partially addressed gaps.' : 'Score indicates active compliance management.'}`, status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red' },
      { label: 'Pending Fix Items', detail: pendingFixes.length > 0 ? `${pendingFixes.length} outstanding action item${pendingFixes.length !== 1 ? 's' : ''}, including ${criticalFixes.length} critical and ${highFixes.length} high severity.` : 'No outstanding fix items \u2014 good standing.', status: criticalFixes.length > 0 ? 'red' : pendingFixes.length > 3 ? 'amber' : 'green' },
      { label: 'Sector Risk Profile', detail: (() => { const pecrFixes = pendingFixes.filter(f => ['consent_missing','consent_expired','suppression_breach','legitimate_interest_abuse'].includes(f.fixType)).length; return pecrFixes > 0 ? `Email marketing is a priority enforcement sector for the ICO under PECR. You have ${pecrFixes} PECR-adjacent pending fix${pecrFixes !== 1 ? 'es' : ''} \u2014 exactly the pattern this sector focus targets.` : 'Email marketing is a priority enforcement sector for the ICO under PECR. No PECR-adjacent pending fixes in your Sendwize data \u2014 sector focus does not translate into a specific concern here.'; })(), status: (pendingFixes.filter(f => ['consent_missing','consent_expired','suppression_breach','legitimate_interest_abuse'].includes(f.fixType)).length > 0) ? 'amber' : 'green' },
    ],
    ASA: [
      { label: 'Advertiser Record', detail: completedFixes.length > 0 ? 'No prior upheld rulings identified. Resolved fix items suggest some compliance effort.' : 'No prior ASA engagement on record.', status: 'green' },
      { label: 'Content Compliance Score', detail: `Sendwize compliance score: ${score}/100. ${score < 50 ? 'Multiple potential CAP Code issues identified.' : score < 75 ? 'Some CAP Code gaps identified.' : 'Generally good compliance posture.'}`, status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red' },
      { label: 'CAP Code Issues', detail: (() => { const asaIssues = pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType)).length; return asaIssues > 0 ? `${asaIssues} ASA-relevant issue(s) identified \u2014 these would be the primary focus of investigation.` : 'No ASA-specific issues currently flagged.'; })(), status: criticalFixes.length > 0 ? 'red' : pendingFixes.length > 2 ? 'amber' : 'green' },
      { label: 'Pre-Campaign Evidence (CAP 4.1)', detail: (() => { const asaIssues = pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType)).length; return asaIssues > 0 ? `CAP Code 4.1 requires evidence to be held before the campaign runs. With ${asaIssues} pending ASA-relevant issue${asaIssues !== 1 ? 's' : ''}, absence of a pre-campaign evidence file is a likely upheld-ruling driver here.` : 'CAP Code 4.1 requires evidence to be held before the campaign runs. No ASA-adjacent issues currently pending in your Sendwize data \u2014 general good-practice reminder only.'; })(), status: (pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType)).length > 0) ? 'red' : 'green' },
      { label: 'Ad Status', detail: (() => { const asaIssues = pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType)).length; return asaIssues > 0 ? `If the flagged ad${asaIssues !== 1 ? 's are' : ' is'} still running, the ASA can request ${asaIssues !== 1 ? 'them' : 'it'} be paused. Voluntary withdrawal before investigation is a significant mitigating factor.` : 'No ASA-adjacent issues currently pending. Voluntary withdrawal of any challenged ad remains a significant mitigating factor if an issue arises.'; })(), status: (pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType)).length > 0) ? 'amber' : 'green' },
    ],
    CMA: [
      { label: 'DMCCA Compliance Sweep', detail: (() => { const cmaIssues = pendingFixes.filter(f => ['drip_pricing','fake_reviews','fake_urgency','misleading_reference_price'].includes(f.fixType)).length; return cmaIssues > 0 ? `The CMA has conducted sweeps of over 400 businesses since April 2025 targeting drip pricing, fake urgency, and fake reviews. You have ${cmaIssues} pending fix${cmaIssues !== 1 ? 'es' : ''} matching that sweep profile.` : 'The CMA has conducted sweeps of over 400 businesses since April 2025 targeting drip pricing, fake urgency, and fake reviews. No pending fixes in your Sendwize data match the sweep profile.'; })(), status: (pendingFixes.filter(f => ['drip_pricing','fake_reviews','fake_urgency','misleading_reference_price'].includes(f.fixType)).length > 0) ? 'red' : 'green' },
      { label: 'Pricing Practice Risk', detail: (() => { const cmaIssues = pendingFixes.filter(f => ['drip_pricing','fake_reviews'].includes(f.fixType)).length; return cmaIssues > 0 ? `${cmaIssues} CMA-relevant issue(s) flagged \u2014 these are the CMA's primary enforcement focus under DMCCA.` : 'No CMA-specific issues currently flagged.'; })(), status: pendingFixes.filter(f => ['drip_pricing','fake_reviews'].includes(f.fixType)).length > 0 ? 'red' : 'green' },
      { label: 'Review Practices', detail: pendingFixes.filter(f => f.fixType === 'fake_reviews').length > 0 ? 'Fake reviews identified \u2014 Schedule 20 DMCCA banned practice. No context defence available.' : 'No review manipulation issues identified.', status: pendingFixes.filter(f => f.fixType === 'fake_reviews').length > 0 ? 'red' : 'green' },
      { label: 'Compliance Score', detail: `Current score: ${score}/100. ${score < 50 ? 'Multiple consumer law concerns identified.' : score < 75 ? 'Partially addressed compliance gaps.' : 'Generally good compliance posture.'}`, status: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red' },
      { label: 'Prior CMA Engagement', detail: 'No prior CMA investigation or undertaking identified. First-time cases with genuine co-operation typically attract lower penalties under DMCCA.', status: 'green' },
    ],
  };
  const stage1Checks = regulatorChecks[regulator] || regulatorChecks.ICO;

  // ── STAGE 2 — Escalation probability (unchanged) ────────────
  const probBase = { ICO: 20, ASA: 15, CMA: 25 }[regulator] || 20;
  const complaintProbability = Math.min(95, probBase + (criticalFixes.length * 20) + (highFixes.length * 5) + (score < 50 ? 20 : 0));

  const escalationFactors = [];
  if (regulator === 'ASA') {
    const asaIssues = pendingFixes.filter(f => ['fake_urgency','misleading_claim','misleading_reference_price','undisclosed_ad'].includes(f.fixType));
    if (asaIssues.length > 0) escalationFactors.push({ icon: '\u26d4', text: `${asaIssues.length} CAP Code violation(s) identified. Competitors as well as consumers can file ASA complaints \u2014 this is common in retail and ecommerce.` });
    if (score < 60)           escalationFactors.push({ icon: '\ud83d\udcca', text: 'Multiple compliance gaps increase the likelihood the ASA would find the ad broke the rules rather than treating it as a borderline case.' });
    escalationFactors.push({ icon: '\ud83d\udccb', text: 'The ASA resolves around 80% of complaints without formal investigation \u2014 but formal investigation is more likely where evidence was not held before the campaign ran (CAP 4.1).' });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '\u2705', text: `${completedFixes.length} resolved issues demonstrates some compliance activity \u2014 this supports an informal resolution outcome.` });
  } else if (regulator === 'CMA') {
    const cmaIssues = pendingFixes.filter(f => ['drip_pricing','fake_reviews'].includes(f.fixType));
    if (cmaIssues.length > 0) escalationFactors.push({ icon: '\u26d4', text: `${cmaIssues.length} DMCCA-relevant issue(s) identified. The CMA launched its first DMCCA enforcement cases in November 2025 and has signalled further enforcement will follow across all sectors.` });
    escalationFactors.push({ icon: '\ud83d\udd0d', text: 'The CMA conducted proactive sweeps of over 400 businesses in 2025. Businesses do not need to receive a complaint to be investigated \u2014 the CMA identifies non-compliance through its own monitoring.' });
    if (score < 50) escalationFactors.push({ icon: '\ud83d\udcca', text: `Compliance score of ${score}/100 indicates a pattern of consumer law concerns \u2014 the CMA prioritises systemic non-compliance over isolated incidents.` });
    escalationFactors.push({ icon: '\u2696\ufe0f', text: 'Under DMCCA, the CMA can fine the higher of \u00a3300,000 or 10% of global turnover without court proceedings. First-time cases with genuine co-operation attract lower penalties and settlement discounts are available.' });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '\u2705', text: `${completedFixes.length} resolved issues can be cited as evidence of good-faith compliance effort \u2014 a mitigating factor in CMA penalty decisions.` });
  } else {
    if (criticalFixes.length > 0)  escalationFactors.push({ icon: '\u26d4', text: 'One or more critical unresolved violations \u2014 these would be the primary basis for ICO enforcement action.' });
    if (score < 50)                escalationFactors.push({ icon: '\ud83d\udcca', text: `Compliance score of ${score}/100 indicates a systemic pattern rather than an isolated incident.` });
    if (pendingFixes.length > 5)   escalationFactors.push({ icon: '\u26a0\ufe0f', text: `${pendingFixes.length} unresolved fix items suggests ongoing non-compliance rather than a one-off issue.` });
    if (completedFixes.length > 0) escalationFactors.push({ icon: '\u2705', text: `${completedFixes.length} resolved fix items demonstrates some compliance effort \u2014 this is a mitigating factor.` });
  }
  if (escalationFactors.length === 0) escalationFactors.push({ icon: '\u2705', text: 'No significant escalation factors identified based on current compliance data.' });

  // ── STAGE 4 — Documents (DETERMINISTIC — v6.2) ──────────────
  const stage4Documents = computeStage4Documents(pendingFixes, regulator);

  // ── STAGE 5 — Penalty + reps (DETERMINISTIC — v6.2) ─────────
  const stage5Penalty         = computeStage5Penalty(pendingFixes, regulator, revenueBand);
  const stage5Representations = computeStage5Representations(pendingFixes, completedFixes, regulator);

  // ── STAGE 3 — Letter (Claude, but prompt embeds real fixes) ─
  const regulatorConfig = {
    ICO: { orgName: "Information Commissioner's Office", refPrefix: "ICO-ENF", signatory: "Senior Enforcement Officer, Direct Marketing Team", letterType: "preliminary enquiry letter under PECR and UK GDPR", tone: "formal ICO enforcement tone. Reference PECR Regulation 22 and specific UK GDPR articles by number.", disclaimerNote: "Penalty estimates are derived from the user's pending fix records. The DUAA 2025 significantly increases the statutory maximum. Not legal advice." },
    ASA: { orgName: "Advertising Standards Authority",   refPrefix: "ASA-ENQ", signatory: "Investigations Executive, Advertising Standards Authority", letterType: "formal investigation notification (ASA prefers informal resolution but proceeds formally where evidence was not held pre-campaign)", tone: "formal but collaborative ASA tone. Reference specific CAP Code rules by number (CAP 3.7, 4.1, 3.17, 3.47).", disclaimerNote: "The ASA does not impose financial fines \u2014 sanctions are reputational and operational. Referral to Trading Standards is possible for persistent non-compliance." },
    CMA: { orgName: "Competition and Markets Authority",  refPrefix: "CMA-CP",  signatory: "Senior Director, Consumer Protection", letterType: "preliminary enquiry under DMCCA 2024 (may progress to a Provisional Infringement Notice)", tone: "formal CMA enforcement tone under DMCCA 2024. Reference specific Schedule 1 banned practices by name.", disclaimerNote: "Penalty estimates are derived from the user's pending fix records and revenue band, capped at the DMCCA 2024 maximum. Not legal advice." },
  };
  const cfg = regulatorConfig[regulator] || regulatorConfig.ICO;

  // Full list of category-relevant pending fixes for Claude to reference
  const categoryFixes = pendingFixes.filter(f => f.exposure?.category === regulator);
  const fixListForPrompt = (categoryFixes.length ? categoryFixes : pendingFixes).slice(0, 8).map(f =>
    `- ${f.fixType.replace(/_/g,' ')} (${f.severity}): ${String(f.description || '').slice(0, 250)}`
  ).join('\n') || 'No pending fixes in this regulator category.';

  const claudePrompt = `You are simulating a ${regulator} (${cfg.orgName}) marketing enforcement letter. Write ONLY the letter content \u2014 opening, context, five questions, and closing.

USER'S ACTUAL PENDING FIXES (from Sendwize \u2014 use these to make questions specific):
${fixListForPrompt}

Instructions:
- Tone: ${cfg.tone}
- Document type: ${cfg.letterType}
- Questions MUST reference the specific issues above (name vendor, segment, campaign, or fix type explicitly). Do NOT ask generic questions if a specific one is possible from the fix list.
- Each question needs a yesNote (what a Yes answer means for their position) and noNote (what a No answer means).

Respond ONLY with JSON, no markdown fences:
{
  "reference": "${cfg.refPrefix}-XXXXX",
  "subject": "specific subject line referencing the concern",
  "opening": "2-3 sentence opening paragraph",
  "context": "1-2 sentence context paragraph on next steps in this regulator's process",
  "closing": "closing paragraph with response deadline and consequences",
  "signatory": "${cfg.signatory}",
  "questions": [
    { "question": "specific question referencing an issue above", "yesNote": "what yes means", "noNote": "what no means" },
    { "question": "...", "yesNote": "...", "noNote": "..." },
    { "question": "...", "yesNote": "...", "noNote": "..." },
    { "question": "...", "yesNote": "...", "noNote": "..." },
    { "question": "...", "yesNote": "...", "noNote": "..." }
  ]
}`;

  let letter = {};
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: claudePrompt }] }),
    });
    if (claudeRes.ok) {
      const text      = (await claudeRes.json()).content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      letter = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } else {
      console.error('Claude letter generation failed:', claudeRes.status);
    }
  } catch (e) {
    console.error('Claude letter parse failed:', e);
  }

  // Persist simulation report (non-fatal)
  let reportId = null;
  try {
    const fields = Object.fromEntries(Object.entries({
      UserID:               userId,
      SimulationDate:       today,
      Regulator:            regulator,
      ComplaintProbability: complaintProbability,
      PenaltyEstimateLow:   stage5Penalty.low,
      PenaltyEstimateHigh:  stage5Penalty.high,
      SimulationVersion:    `${regulator}-2026-v6.2`,
      SimulationJson:       JSON.stringify({ stage1Checks, escalationFactors, letter, stage4Documents, stage5Penalty, stage5Representations }),
    }).filter(([, v]) => v !== null && v !== undefined));

    const reportRes = await atFetch(`${airtableBase}/Simulation_Reports`, {
      method: 'POST', headers: airtableHeaders,
      body:   JSON.stringify({ records: [{ fields }] }),
    });
    if (reportRes.ok) reportId = (await reportRes.json()).records?.[0]?.id ?? null;
  } catch (err) {
    console.error('Simulation_Reports write error (non-fatal):', err);
  }

  return res.status(200).json({
    reportId, regulator,
    stage1: { checks: stage1Checks },
    stage2: { probability: complaintProbability, factors: escalationFactors },
    stage3: { letter },
    stage4: { documents: stage4Documents },
    stage5: { penalty: stage5Penalty, representations: stage5Representations },
    disclaimer: cfg.disclaimerNote,
    // Traceability: how many actual pending fixes contributed to this sim
    derivedFrom: {
      pendingFixesTotal:    pendingFixes.length,
      pendingFixesCategory: categoryFixes.length,
      completedFixes:       completedFixes.length,
      revenueBand,
    },
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
      valid: 'report | vendors | violations | load | history | register | summary | score-history | send-alert | briefing | consent-expiry-check | simulation-run',
    });

  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
