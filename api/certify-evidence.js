// ─────────────────────────────────────────────────────────────
// SENDWIZE — certify-evidence.js v1.0
//
// POST { userId, checkRecordId, evidenceItems: [{ regulation, issue, location, certified: true }] }
// Writes to a new "Evidence_Certifications" table so the user's evidence
// confirmations persist across sessions and can be surfaced on the dashboard.
//
// This solves the problem where ticking "I confirm we hold evidence" was
// client-side only — closing the tab lost the certification.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, checkRecordId, evidenceItems } = req.body ?? {};
    if (!userId)                                    return res.status(400).json({ error: 'Missing userId' });
    if (!checkRecordId)                             return res.status(400).json({ error: 'Missing checkRecordId' });
    if (!Array.isArray(evidenceItems))              return res.status(400).json({ error: 'evidenceItems must be an array' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const base           = `https://api.airtable.com/v0/${BASE_ID}`;
    const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    const today = new Date().toISOString().split('T')[0];

    // Write one record per certified item.
    // Airtable POST can take up to 10 records at a time — batch.
    const records = evidenceItems
      .filter(item => item && item.certified)
      .map(item => ({
        fields: {
          UserID:          userId,
          CheckRecordID:   checkRecordId,
          Regulation:      String(item.regulation || '').slice(0, 200),
          Issue:           String(item.issue || '').slice(0, 500),
          Location:        String(item.location || '').slice(0, 200),
          Recommendation:  String(item.recommendation || '').slice(0, 500),
          CertifiedDate:   today,
          Status:          'certified',
        },
      }));

    if (records.length === 0) {
      return res.json({ certified: 0, message: 'No items to certify' });
    }

    // Chunk into batches of 10 (Airtable API limit)
    const results = [];
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      const r = await fetch(`${base}/Evidence_Certifications`, {
        method: 'POST',
        headers: authH,
        body: JSON.stringify({ records: batch }),
      });
      if (!r.ok) {
        const errText = await r.text();
        console.error('Evidence_Certifications write failed:', r.status, errText);
        return res.status(500).json({ error: 'Failed to write certifications', detail: errText.slice(0, 300) });
      }
      const data = await r.json();
      results.push(...(data.records || []));
    }

    return res.json({ certified: results.length, records: results.map(r => r.id) });
  } catch (e) {
    console.error('certify-evidence error:', e);
    return res.status(500).json({ error: 'Failed to certify evidence' });
  }
}
