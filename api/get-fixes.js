// ─────────────────────────────────────────────────────────────
// SENDWIZE — get-fixes.js
// Returns all Compliance_Fixes for a user.
// Also calculates the live compliance score and
// total exposure range from pending fixes.
// Called by dashboard and fix list on page load.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── Fetch all fixes for this user ────────────────────────────
    const formula  = encodeURIComponent(`{UserID}="${userId}"`);
    const fixesRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes?filterByFormula=${formula}&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
    );

    if (!fixesRes.ok) {
      throw new Error(`Airtable fetch failed: ${fixesRes.status}`);
    }

    const fixesData = await fixesRes.json();
    const allFixes  = fixesData.records || [];

    // ── Separate by status ───────────────────────────────────────
    const pending   = allFixes.filter(r => r.fields.Status === 'pending');
    const completed = allFixes.filter(r => r.fields.Status === 'completed');
    const dismissed = allFixes.filter(r => r.fields.Status === 'dismissed');

    // ── Calculate compliance score ───────────────────────────────
    // Score = (completed / active_fixes) × 100
    // active_fixes = pending + completed (dismissed excluded)
    // Returns 0 if no tools have been run yet
    const activeFixes = pending.length + completed.length;
    const score       = activeFixes > 0
      ? Math.round((completed.length / activeFixes) * 100)
      : 0;

    // ── Calculate total exposure range from pending fixes ────────
    const totalExposureLow  = pending.reduce((sum, r) => sum + (r.fields.ExposureLow  || 0), 0);
    const totalExposureHigh = pending.reduce((sum, r) => sum + (r.fields.ExposureHigh || 0), 0);

    // ── Calculate exposure saved by completed fixes ──────────────
    const savedExposureLow  = completed.reduce((sum, r) => sum + (r.fields.ExposureLow  || 0), 0);
    const savedExposureHigh = completed.reduce((sum, r) => sum + (r.fields.ExposureHigh || 0), 0);

    // ── Score band label ─────────────────────────────────────────
    function getScoreBand(s) {
      if (s === 0)   return { label: 'Not Started',     colour: '#9ca3af' };
      if (s <= 25)   return { label: 'At Risk',         colour: '#ef4444' };
      if (s <= 50)   return { label: 'Needs Attention', colour: '#f97316' };
      if (s <= 75)   return { label: 'In Progress',     colour: '#eab308' };
      if (s <= 90)   return { label: 'Good Standing',   colour: '#0d9488' };
      return           { label: 'Compliant',            colour: '#16a34a' };
    }

    // ── Format fix records for frontend ─────────────────────────
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
      success: true,
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
        pendingLow:   totalExposureLow,
        pendingHigh:  totalExposureHigh,
        savedLow:     savedExposureLow,
        savedHigh:    savedExposureHigh,
        disclaimer:   'Based on historical ICO/ASA/CMA enforcement actions against similar organisations. Estimated regulatory risk only — not legal advice. Actual outcomes vary.',
      },
      fixes: {
        pending:   pending.map(formatFix),
        completed: completed.map(formatFix),
        dismissed: dismissed.map(formatFix),
      },
    });

  } catch (error) {
    console.error('get-fixes error:', error);
    return res.status(500).json({ error: 'Failed to retrieve fixes' });
  }
}
