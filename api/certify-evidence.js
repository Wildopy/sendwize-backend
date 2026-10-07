// ─────────────────────────────────────────────────────────────
// SENDWIZE — certify-evidence.js v1.1
//
// POST { userId, checkRecordId, evidenceItems: [{ regulation, issue, location, certified: true }] }
// Writes to a new "Evidence_Certifications" table so the user's evidence
// confirmations persist across sessions and can be surfaced on the dashboard.
//
// v1.1 (security):
//   + Request authenticated via _auth.js — the verified member id
//     replaces any userId sent by the browser.
//   + checkRecordId must be a real AI check owned by the caller, so
//     nobody can attach certifications to another customer's check.
//
// v1.0: ticking "I confirm we hold evidence" was client-side only —
// closing the tab lost the certification. This persists it.
// ─────────────────────────────────────────────────────────────
import { requireAuth, isRecordId, CORS_HEADERS } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { userId, checkRecordId, evidenceItems } = req.body ?? {};
    if (!userId)                                    return res.status(400).json({ error: 'Missing userId' });
    if (!checkRecordId)                             return res.status(400).json({ error: 'Missing checkRecordId' });
    if (!isRecordId(checkRecordId))                 return res.status(400).json({ error: 'Invalid checkRecordId' });
    if (!Array.isArray(evidenceItems))              return res.status(400).json({ error: 'evidenceItems must be an array' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const base           = `https://api.airtable.com/v0/${BASE_ID}`;
    const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // v1.1: the check must belong to the caller
    const cr = await fetch(`${base}/AI_Compliance_Checks/${checkRecordId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!cr.ok) return res.status(404).json({ error: 'Check not found' });
    const check = await cr.json();
    if (check.fields?.UserID !== userId) return res.status(404).json({ error: 'Check not found' });

    const today = new Date().toISOString().split('T')[0];

    // Write one record per certified item.
    // Airtable POST can take up to 10 records at a time — batch.
    const records = evidenceItems
      .filter(item => item && item.certified)
      .slice(0, 50)
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
