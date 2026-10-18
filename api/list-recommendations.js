// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-recommendations.js v1.3
// v1.3: reads opportunities from the latest List Intelligence check for
//   each list (List_Intelligence_Checks → Results.opportunities). The old
//   source table, List_Opportunities, is never written by the current
//   code, so the dashboard card was empty or stale. List_Opportunities is
//   still read as a fallback. Decay is calculated on read; nothing is
//   written back on page load any more (that cost one Airtable write per
//   opportunity on every dashboard view).
// v1.2 (security): request authenticated via _auth.js; the verified member
//   id replaces any userId from the browser.
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
import { requireAuth, CORS_HEADERS } from './_auth.js';

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
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  // Identity: the verified member id replaces any userId sent by the browser
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const now = new Date();
    const decay = (estimated, rate, created) => {
      const monthsOld = Math.max(0, (now - new Date(created || now)) / (30 * 86400000));
      return { currentValue: parseFloat(Math.max(0, estimated * Math.pow(1 - rate / 100, monthsOld)).toFixed(2)), monthsOld: parseFloat(monthsOld.toFixed(1)) };
    };

    // 1. Latest check per list
    const checks = await atGet(
      'List_Intelligence_Checks',
      `{UserID}='${userId}'`,
      'sort[0][field]=CheckDate&sort[0][direction]=desc',
      30
    );
    const latestPerList = {};
    for (const c of checks.records) {
      const name = c.fields.ListName || 'List';
      if (!latestPerList[name]) latestPerList[name] = c;
    }
    let opportunities = [];
    for (const [listName, c] of Object.entries(latestPerList)) {
      let results = null;
      try { results = c.fields.Results ? JSON.parse(c.fields.Results) : null; } catch { results = null; }
      for (const [i, o] of (results?.opportunities || []).entries()) {
        const estimated = Number(o.estimatedValue) || 0;
        if (estimated <= 0) continue;
        const rate = Number(o.decayRate) || 2.5;
        const d = decay(estimated, rate, c.fields.CheckDate);
        opportunities.push({
          id: `${c.id}:${i}`, listName, type: o.type || '', description: o.description || '',
          estimatedValue: estimated, currentValue: d.currentValue, decayRate: rate,
          recommendedAction: o.recommendedAction || '', status: 'Open',
          createdDate: c.fields.CheckDate || null, monthsOld: d.monthsOld,
        });
      }
    }

    // 2. Fallback: legacy List_Opportunities rows
    if (!opportunities.length) {
      const legacy = await atGet('List_Opportunities', `AND({UserID}='${userId}',{Status}='Open')`, 'sort[0][field]=EstimatedValue&sort[0][direction]=desc', 50);
      opportunities = legacy.records.map(o => {
        const f = o.fields; const rate = f.DecayRate || 2.5; const d = decay(f.EstimatedValue || 0, rate, f.CreatedDate);
        return { id: o.id, type: f.OpportunityType || '', description: f.Description || '', estimatedValue: f.EstimatedValue || 0, currentValue: d.currentValue, decayRate: rate, recommendedAction: f.RecommendedAction || '', status: f.Status || 'Open', createdDate: f.CreatedDate || null, monthsOld: d.monthsOld };
      });
      if (!checks.ok && !legacy.ok) {
        return res.status(200).json({ success: false, unrealisedTotal: 0, opportunities: [], hasData: false, degraded: true, reason: 'Airtable temporarily unavailable' });
      }
    }

    opportunities.sort((a, b) => b.currentValue - a.currentValue);
    const unrealisedTotal = parseFloat(opportunities.reduce((s, o) => s + o.currentValue, 0).toFixed(2));
    return res.status(200).json({
      success: true,
      hasData: opportunities.length > 0,
      unrealisedTotal,
      opportunities,
      count: opportunities.length,
      basis: 'Opportunities from your latest List Intelligence check per list, reduced each month they are not acted on.',
    });

  } catch (err) {
    // Only reachable now on a genuine network-level failure (DNS, timeout
    // before any response), not on Airtable 429/5xx — those are handled
    // above via oppsResult.ok / patchResult.ok.
    console.error('list-recommendations error:', err);
    return res.status(500).json({ error: err.message });
  }
}
