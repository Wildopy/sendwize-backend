// ─────────────────────────────────────────────────────────────
// SENDWIZE — dismiss-fix.js
// Called when user dismisses a fix (e.g. vendor not actually used).
// Updates fix Status to 'dismissed'.
// Dismissed fixes are excluded from score calculation entirely.
// No exposure penalty for dismissing.
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

    if (fixData.fields.Status === 'dismissed') {
      return res.json({ success: true, message: 'Fix already dismissed' });
    }

    // ── Update status to dismissed ───────────────────────────────
    const updateRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes/${fixId}`,
      {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          fields: { Status: 'dismissed' },
        }),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      throw new Error(`Airtable update failed: ${errText}`);
    }

    console.log(`Fix dismissed: ${fixId} by user ${userId}`);

    return res.json({
      success: true,
      fixId,
      message: 'Fix dismissed. It will no longer affect your compliance score.',
    });

  } catch (error) {
    console.error('dismiss-fix error:', error);
    return res.status(500).json({ error: 'Failed to dismiss fix' });
  }
}
