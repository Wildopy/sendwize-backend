// fixes.js
// Merged handler for all Compliance_Fixes operations.
//
// GET  /api/fixes?action=get&userId=xxx       → get-fixes (list + score + exposure)
// POST /api/fixes?action=complete             → complete-fix (mark fix done)
// POST /api/fixes?action=dismiss              → dismiss-fix (exclude from score)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  if (req.method === 'GET'  && action === 'get')      return handleGet(req, res);
  if (req.method === 'POST' && action === 'complete')  return handleComplete(req, res);
  if (req.method === 'POST' && action === 'dismiss')   return handleDismiss(req, res);

  return res.status(400).json({ error: 'Unknown action. Use ?action=get|complete|dismiss' });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fixes?action=get&userId=xxx
// Returns all fixes, live compliance score, and exposure totals.
// ─────────────────────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const formula  = encodeURIComponent(`{UserID}="${userId}"`);
    const fixesRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula=${formula}&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );

    if (!fixesRes.ok) throw new Error(`Airtable fetch failed: ${fixesRes.status}`);

    const allFixes  = (await fixesRes.json()).records || [];
    const pending   = allFixes.filter(r => r.fields.Status === 'pending');
    const completed = allFixes.filter(r => r.fields.Status === 'completed');
    const dismissed = allFixes.filter(r => r.fields.Status === 'dismissed');

    // Score = completed / (pending + completed) × 100 — dismissed excluded
    const activeFixes = pending.length + completed.length;
    const score       = activeFixes > 0 ? Math.round((completed.length / activeFixes) * 100) : 0;

    const totalExposureLow  = pending.reduce((sum, r) => sum + (r.fields.ExposureLow  || 0), 0);
    const totalExposureHigh = pending.reduce((sum, r) => sum + (r.fields.ExposureHigh || 0), 0);
    const savedExposureLow  = completed.reduce((sum, r) => sum + (r.fields.ExposureLow  || 0), 0);
    const savedExposureHigh = completed.reduce((sum, r) => sum + (r.fields.ExposureHigh || 0), 0);

    function getScoreBand(s) {
      if (s === 0) return { label: 'Not Started',     colour: '#9ca3af' };
      if (s <= 25) return { label: 'At Risk',         colour: '#ef4444' };
      if (s <= 50) return { label: 'Needs Attention', colour: '#f97316' };
      if (s <= 75) return { label: 'In Progress',     colour: '#eab308' };
      if (s <= 90) return { label: 'Good Standing',   colour: '#0d9488' };
      return        { label: 'Compliant',             colour: '#16a34a' };
    }

    function formatFix(record) {
      return {
        id:             record.id,
        fixType:        record.fields.FixType        || '',
        description:    record.fields.Description    || '',
        tool:           record.fields.Tool           || '',
        severity:       record.fields.Severity       || '',
        exposureLow:    record.fields.ExposureLow    || 0,
        exposureHigh:   record.fields.ExposureHigh   || 0,
        status:         record.fields.Status         || 'pending',
        volume:         record.fields.Volume         || null,
        sourceRecordId: record.fields.SourceRecordID || null,
        completedDate:  record.fields.CompletedDate  || null,
        createdDate:    record.fields.CreatedDate    || null,
      };
    }

    const band = getScoreBand(score);

    return res.json({
      success:     true,
      score,
      scoreBand:   band.label,
      scoreColour: band.colour,
      counts: {
        pending:   pending.length,
        completed: completed.length,
        dismissed: dismissed.length,
        active:    activeFixes,
      },
      exposure: {
        pendingLow:  totalExposureLow,
        pendingHigh: totalExposureHigh,
        savedLow:    savedExposureLow,
        savedHigh:   savedExposureHigh,
        disclaimer:  'Based on historical ICO/ASA/CMA enforcement actions against similar organisations. Estimated regulatory risk only — not legal advice. Actual outcomes vary.',
      },
      fixes: {
        pending:   pending.map(formatFix),
        completed: completed.map(formatFix),
        dismissed: dismissed.map(formatFix),
      },
    });

  } catch (error) {
    console.error('fixes get error:', error);
    return res.status(500).json({ error: 'Failed to retrieve fixes' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fixes?action=complete
// Body: { userId, fixId }
// Marks a fix as completed. Score recalculates on next get call.
// ─────────────────────────────────────────────────────────────────────────────

async function handleComplete(req, res) {
  try {
    const { userId, fixId } = req.body;
    if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const getRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (!getRes.ok) return res.status(404).json({ error: 'Fix not found' });

    const fixData = await getRes.json();
    if (fixData.fields.UserID !== userId) return res.status(403).json({ error: 'Fix does not belong to this user' });
    if (fixData.fields.Status === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

    const updateRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields: { Status: 'completed', CompletedDate: new Date().toISOString().split('T')[0] } }),
      }
    );

    if (!updateRes.ok) throw new Error(`Airtable update failed: ${await updateRes.text()}`);

    console.log(`Fix completed: ${fixId} by user ${userId}`);
    return res.json({
      success:      true,
      fixId,
      exposureLow:  fixData.fields.ExposureLow  || 0,
      exposureHigh: fixData.fields.ExposureHigh || 0,
      message:      'Fix marked as complete. Compliance score updated.',
    });

  } catch (error) {
    console.error('fixes complete error:', error);
    return res.status(500).json({ error: 'Failed to complete fix' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fixes?action=dismiss
// Body: { userId, fixId }
// Marks a fix as dismissed. Dismissed fixes are excluded from score entirely.
// ─────────────────────────────────────────────────────────────────────────────

async function handleDismiss(req, res) {
  try {
    const { userId, fixId } = req.body;
    if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const getRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (!getRes.ok) return res.status(404).json({ error: 'Fix not found' });

    const fixData = await getRes.json();
    if (fixData.fields.UserID !== userId) return res.status(403).json({ error: 'Fix does not belong to this user' });
    if (fixData.fields.Status === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });

    const updateRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields: { Status: 'dismissed' } }),
      }
    );

    if (!updateRes.ok) throw new Error(`Airtable update failed: ${await updateRes.text()}`);

    console.log(`Fix dismissed: ${fixId} by user ${userId}`);
    return res.json({
      success: true,
      fixId,
      message: 'Fix dismissed. It will no longer affect your compliance score.',
    });

  } catch (error) {
    console.error('fixes dismiss error:', error);
    return res.status(500).json({ error: 'Failed to dismiss fix' });
  }
}
