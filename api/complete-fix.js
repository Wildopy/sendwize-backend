// ─────────────────────────────────────────────────────────────
// SENDWIZE — complete-fix.js
// Called when user clicks 'Mark Complete' on the fix list.
// Updates fix Status to 'completed' in Airtable.
// Score recalculates automatically on next get-fixes call.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, fixId } = req.body;

    if (!userId || !fixId) {
      return res.status(400).json({ error: 'userId and fixId are required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    // ── Verify fix belongs to this user ──────────────────────────
    const getRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
    );

    if (!getRes.ok) {
      return res.status(404).json({ error: 'Fix not found' });
    }

    const fixData = await getRes.json();

    if (fixData.fields.UserID !== userId) {
      return res.status(403).json({ error: 'Fix does not belong to this user' });
    }

    if (fixData.fields.Status === 'completed') {
      return res.json({ success: true, message: 'Fix already marked complete' });
    }

    // ── Update status to completed ───────────────────────────────
    const updateRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          fields: {
            Status:        'completed',
            CompletedDate: new Date().toISOString().split('T')[0],
          },
        }),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      throw new Error(`Airtable update failed: ${errText}`);
    }

    console.log(`Fix completed: ${fixId} by user ${userId}`);

    // ── Return the exposure values that were just resolved ───────
    return res.json({
      success:      true,
      fixId,
      exposureLow:  fixData.fields.ExposureLow  || 0,
      exposureHigh: fixData.fields.ExposureHigh || 0,
      message:      'Fix marked as complete. Compliance score updated.',
    });

  } catch (error) {
    console.error('complete-fix error:', error);
    return res.status(500).json({ error: 'Failed to complete fix' });
  }
}
