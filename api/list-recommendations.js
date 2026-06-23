// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-recommendations.js v1.1
// GET /api/list-recommendations?userId=x
//
// Returns decayed List_Opportunities for dashboard headline number 3.
// Called on login — CurrentValue decays since upload date.
// Patches Airtable CurrentValue in place so decay persists.
// All async work AWAITED before res.json() — Vercel Hobby safe.
//
// v1.1 changes:
//   - All Airtable calls now go through atFetch() (see _airtable.js)
//     which retries 429/5xx with backoff instead of throwing
//     immediately. Previously a single Airtable 429 surfaced as
//     an uncaught Error -> 500 to the browser with no retry.
//   - atGet/atPatch return a {ok, status, data} result instead of
//     throwing, so callers can decide what to do on persistent
//     failure rather than always 500ing.
//   - CurrentValue patch failures remain non-fatal (decay display
//     still works even if the persisted patch fails) — unchanged
//     behaviour, just routed through atFetch now.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

const BASE_ID = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;
const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// Returns { ok, status, records } — never throws on a retryable HTTP failure.
// Throws only on network-level failure after retries are exhausted (rare).
async function atGet(table, formula, sort = '', max = 50) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: atH() });
  if (!r.ok) {
    console.error(`AT GET ${table} failed after retries: ${r.status}`);
    return { ok: false, status: r.status, records: [] };
  }
  const data = await r.json();
  return { ok: true, status: r.status, records: data.records || [] };
}

// Returns { ok, status } — never throws on a retryable HTTP failure.
async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await atFetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method:  'PATCH',
    headers: atH(),
    body:    JSON.stringify({ fields: clean }),
  });
  if (!r.ok) {
    console.error(`AT PATCH ${table}/${id} failed after retries: ${r.status}`);
    return { ok: false, status: r.status };
  }
  return { ok: true, status: r.status };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const oppsResult = await atGet(
      'List_Opportunities',
      `AND({UserID}='${userId}',{Status}='Open')`,
      'sort[0][field]=EstimatedValue&sort[0][direction]=desc',
      50
    );

    // Airtable failed even after retries — degrade gracefully instead of
    // throwing a 500. The dashboard card shows the empty state, which is
    // honest (we genuinely don't know) and matches what hasData:false
    // already renders for "no opportunities yet".
    if (!oppsResult.ok) {
      return res.status(200).json({
        success:         false,
        unrealisedTotal: 0,
        opportunities:   [],
        hasData:         false,
        degraded:        true,
        reason:          `Airtable temporarily unavailable (status ${oppsResult.status})`,
      });
    }

    const opps = oppsResult.records;

    if (!opps.length) {
      return res.status(200).json({
        success:         true,
        unrealisedTotal: 0,
        opportunities:   [],
        hasData:         false,
      });
    }

    const now = new Date();
    const decayed = [];

    for (const o of opps) {
      const f             = o.fields;
      const created       = f.CreatedDate ? new Date(f.CreatedDate) : now;
      const monthsOld     = (now - created) / (30 * 86400000);
      const decayRate     = f.DecayRate || 2.5; // % per month
      const estimated     = f.EstimatedValue || 0;
      const currentValue  = parseFloat(
        Math.max(0, estimated * Math.pow(1 - decayRate / 100, monthsOld)).toFixed(2)
      );

      // Patch Airtable with decayed value — so dashboard always reads fresh.
      // Non-fatal: if this fails (even after retries), we still return the
      // computed value to the caller this time around.
      const patchResult = await atPatch('List_Opportunities', o.id, { CurrentValue: currentValue });
      if (!patchResult.ok) {
        console.error(`CurrentValue patch failed for ${o.id} (non-fatal): status ${patchResult.status}`);
      }

      decayed.push({
        id:                o.id,
        type:              f.OpportunityType  || '',
        description:       f.Description      || '',
        estimatedValue:    estimated,
        currentValue,
        decayRate,
        recommendedAction: f.RecommendedAction || '',
        status:            f.Status           || 'Open',
        createdDate:       f.CreatedDate      || null,
        monthsOld:         parseFloat(monthsOld.toFixed(1)),
      });
    }

    const unrealisedTotal = parseFloat(
      decayed.reduce((s, o) => s + o.currentValue, 0).toFixed(2)
    );

    return res.status(200).json({
      success:         true,
      hasData:         true,
      unrealisedTotal,
      opportunities:   decayed,
      count:           decayed.length,
    });

  } catch (err) {
    // Only reachable now on a genuine network-level failure (DNS, timeout
    // before any response), not on Airtable 429/5xx — those are handled
    // above via oppsResult.ok / patchResult.ok.
    console.error('list-recommendations error:', err);
    return res.status(500).json({ error: err.message });
  }
}
