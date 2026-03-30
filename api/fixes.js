// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v4.19
// GET  /api/fixes?action=get&userId=x      → list + score + exposure
// POST /api/fixes?action=complete          → mark fix done
// POST /api/fixes?action=dismiss           → exclude from score
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

function getScoreBand(s) {
  if (s === 0)  return { label: 'Not Started',     colour: '#9ca3af' };
  if (s <= 25)  return { label: 'At Risk',         colour: '#ef4444' };
  if (s <= 50)  return { label: 'Needs Attention', colour: '#f97316' };
  if (s <= 75)  return { label: 'In Progress',     colour: '#eab308' };
  if (s <= 90)  return { label: 'Good Standing',   colour: '#0d9488' };
  return         { label: 'Compliant',             colour: '#16a34a' };
}

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

  return res.json({
    success: true, score, scoreBand: band.label, scoreColour: band.colour,
    counts: { pending: pending.length, completed: completed.length, dismissed: dismissed.length, active },
    exposure: {
      pendingLow:  pending.reduce((s, x)   => s + (x.fields.ExposureLow   || 0), 0),
      pendingHigh: pending.reduce((s, x)   => s + (x.fields.ExposureHigh  || 0), 0),
      savedLow:    completed.reduce((s, x) => s + (x.fields.ExposureLow   || 0), 0),
      savedHigh:   completed.reduce((s, x) => s + (x.fields.ExposureHigh  || 0), 0),
      disclaimer:  'Based on historical ICO/ASA/CMA enforcement actions. Estimated regulatory risk only — not legal advice.',
    },
    fixes: { pending: pending.map(formatFix), completed: completed.map(formatFix), dismissed: dismissed.map(formatFix) },
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

  if (!ur.ok) { console.error('Fix complete failed:', ur.status); return res.status(ur.status).json({ error: 'Failed to complete fix' }); }

  return res.json({ success: true, fixId, exposureLow: fix.fields.ExposureLow || 0, exposureHigh: fix.fields.ExposureHigh || 0, message: 'Fix marked as complete. Compliance score updated.' });
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

  if (!ur.ok) { console.error('Fix dismiss failed:', ur.status); return res.status(ur.status).json({ error: 'Failed to dismiss fix' }); }

  return res.json({ success: true, fixId, message: 'Fix dismissed. It will no longer affect your compliance score.' });
}
