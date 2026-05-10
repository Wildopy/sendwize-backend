// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v5.0
// GET  /api/fixes?action=get&userId=x      → list + score + exposure
// POST /api/fixes?action=complete          → mark fix done
// POST /api/fixes?action=dismiss           → exclude from score
//
// v5.0 changes:
//   - Exposure calculation switched from sum to MEDIAN of ExposureHigh/Low
//     across all pending fixes. Sum wildly overstates risk when multiple
//     fixes exist — median gives a realistic single-issue exposure figure.
//   - peakHigh added — the single highest pending fix exposure (for context)
//   - assessedMonth added — YYYY-MM string for monthly refresh gate
//   - tierCounts added — breakdown of pending fixes by tier for dashboard display
//   - Score band 'Compliant' replaced with 'Strong Posture' (legal disclaimer policy)
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  if (req.method === 'GET'  && action === 'get')     return handleGet(req, res);
  if (req.method === 'POST' && action === 'complete') return handleComplete(req, res);
  if (req.method === 'POST' && action === 'dismiss')  return handleDismiss(req, res);
  return res.status(400).json({ error: 'Unknown action. Use ?action=get|complete|dismiss' });
}

// ── SCORE BAND ────────────────────────────────────────────────
// Note: 'Compliant' removed per legal disclaimer policy.
// No binary verdict — use language reflecting posture, not legal status.
function getScoreBand(s) {
  if (s === 0)  return { label: 'Not Started',     colour: '#9ca3af' };
  if (s <= 25)  return { label: 'At Risk',         colour: '#ef4444' };
  if (s <= 50)  return { label: 'Needs Attention', colour: '#f97316' };
  if (s <= 75)  return { label: 'In Progress',     colour: '#eab308' };
  if (s <= 90)  return { label: 'Good Standing',   colour: '#0d9488' };
  return         { label: 'Strong Posture',        colour: '#16a34a' };
}

// ── MEDIAN HELPER ─────────────────────────────────────────────
// Returns the median of a numeric array.
// Empty array → 0. Single item → that item.
// Even-length array → average of two middle values.
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── TIER CLASSIFIER ───────────────────────────────────────────
// Maps a fix's exposureBasis and fixType to a display tier.
// Tier 1 = ICO direct fine (regulatory)
// Tier 2 = CMA/DMCCA trajectory (regulatory, with disclaimer)
// Tier 3 = ASA/reputational (no £ figure)
const TIER2_TYPES = new Set([
  'misleading_claim','fake_urgency','misleading_pricing','dark_pattern',
  'misleading_reference_price','unauthorised_health_claim','misleading_free_claim',
  'drip_pricing','fake_scarcity','misleading_testimonial','undisclosed_ad',
  'unsubstantiated_comparative_claim',
]);
const TIER3_TYPES = new Set([
  'no_privacy_policy','no_dpa','frequency_abuse','missing_address',
  'unlawful_incentive','missing_terms',
]);

function getTier(fix) {
  const basis   = (fix.fields.ExposureBasis || '').toLowerCase();
  const fixType = (fix.fields.FixType       || '').toLowerCase();
  if (basis === 'reputational' || TIER3_TYPES.has(fixType)) return 3;
  if (TIER2_TYPES.has(fixType)) return 2;
  return 1;
}

// ── FORMAT FIX ────────────────────────────────────────────────
function formatFix(r) {
  return {
    id:             r.id,
    fixType:        r.fields.FixType        || '',
    description:    r.fields.Description    || '',
    tool:           r.fields.Tool           || '',
    severity:       r.fields.Severity       || '',
    exposureLow:    r.fields.ExposureLow    || 0,
    exposureHigh:   r.fields.ExposureHigh   || 0,
    exposureBasis:  r.fields.ExposureBasis  || 'reputational',
    status:         r.fields.Status         || 'pending',
    volume:         r.fields.Volume         || null,
    sourceRecordId: r.fields.SourceRecordID || null,
    completedDate:  r.fields.CompletedDate  || null,
    createdDate:    r.fields.CreatedDate    || null,
    tier:           getTier(r),
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula={UserID}='${userId}'&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!r.ok) {
    console.error('Compliance_Fixes fetch failed:', r.status);
    return res.status(r.status).json({ error: 'Failed to retrieve fixes' });
  }

  const all       = (await r.json()).records || [];
  const pending   = all.filter(x => x.fields.Status === 'pending');
  const completed = all.filter(x => x.fields.Status === 'completed');
  const dismissed = all.filter(x => x.fields.Status === 'dismissed');
  const active    = pending.length + completed.length;
  const score     = active > 0 ? Math.round((completed.length / active) * 100) : 0;
  const band      = getScoreBand(score);

  // ── Exposure calculation ───────────────────────────────────
  // Tier 1 + Tier 2 pending fixes have £ exposure figures.
  // We use MEDIAN, not sum — sum wildly overstates when multiple
  // fixes exist (e.g. 8 fixes summing to £1.2m is not realistic;
  // a company would face one primary enforcement action).
  // Median gives the most representative single-issue exposure figure.

  const regPending = pending.filter(x => {
    const basis = (x.fields.ExposureBasis || '').toLowerCase();
    return basis !== 'reputational' && (x.fields.ExposureHigh || 0) > 0;
  });

  const pendingHighValues = regPending.map(x => x.fields.ExposureHigh || 0);
  const pendingLowValues  = regPending.map(x => x.fields.ExposureLow  || 0);

  const medianHigh = median(pendingHighValues);
  const medianLow  = median(pendingLowValues);
  const peakHigh   = pendingHighValues.length ? Math.max(...pendingHighValues) : 0;
  const peakLow    = pendingLowValues.length  ? Math.max(...pendingLowValues)  : 0;

  // Saved exposure — what completed fixes eliminated (also median)
  const regCompleted      = completed.filter(x => (x.fields.ExposureHigh || 0) > 0);
  const completedHighVals = regCompleted.map(x => x.fields.ExposureHigh || 0);
  const completedLowVals  = regCompleted.map(x => x.fields.ExposureLow  || 0);

  // Tier counts for dashboard breakdown
  const pendingFormatted = pending.map(formatFix);
  const tierCounts = {
    tier1: pendingFormatted.filter(f => f.tier === 1).length,
    tier2: pendingFormatted.filter(f => f.tier === 2).length,
    tier3: pendingFormatted.filter(f => f.tier === 3).length,
  };

  // assessedMonth — YYYY-MM of current month, used by dashboard monthly refresh gate
  const now          = new Date();
  const assessedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return res.json({
    success: true, score, scoreBand: band.label, scoreColour: band.colour,
    counts: { pending: pending.length, completed: completed.length, dismissed: dismissed.length, active },
    exposure: {
      // Median figures — primary display values
      medianLow,
      medianHigh,
      // Peak — highest single fix (shown as context, not hero)
      peakHigh,
      peakLow,
      // Saved — median of completed fixes (what was at risk and fixed)
      savedLow:    median(completedLowVals),
      savedHigh:   median(completedHighVals),
      // Count of pending fixes with £ exposure (for label: "across X open issues")
      regPendingCount: regPending.length,
      // Method label for transparency
      method:      'median',
      assessedMonth,
      disclaimer:  'Median single-issue exposure based on ICO/ASA/CMA enforcement data. Not a sum of all risks. Not legal advice.',
    },
    tierCounts,
    fixes: {
      pending:   pendingFormatted,
      completed: completed.map(formatFix),
      dismissed: dismissed.map(formatFix),
    },
  });
}

// ── COMPLETE ──────────────────────────────────────────────────
async function handleComplete(req, res) {
  const { userId, fixId } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({ fields: { Status: 'completed', CompletedDate: new Date().toISOString().split('T')[0] } }),
  });

  if (!ur.ok) {
    console.error('Fix complete failed:', ur.status);
    return res.status(ur.status).json({ error: 'Failed to complete fix' });
  }

  return res.json({
    success: true, fixId,
    exposureLow:  fix.fields.ExposureLow  || 0,
    exposureHigh: fix.fields.ExposureHigh || 0,
    message: 'Fix marked as complete.',
  });
}

// ── DISMISS ───────────────────────────────────────────────────
async function handleDismiss(req, res) {
  const { userId, fixId } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({ fields: { Status: 'dismissed' } }),
  });

  if (!ur.ok) {
    console.error('Fix dismiss failed:', ur.status);
    return res.status(ur.status).json({ error: 'Failed to dismiss fix' });
  }

  return res.json({ success: true, fixId, message: 'Fix dismissed.' });
}
