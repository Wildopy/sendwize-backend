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

    // Compute decay for every opportunity first (synchronous, instant) so the
    // response is never gated on Airtable round-trips.
    const decayed = opps.map(o => {
      const f            = o.fields;
      const created      = f.CreatedDate ? new Date(f.CreatedDate) : now;
      const monthsOld    = (now - created) / (30 * 86400000);
      const decayRate    = f.DecayRate || 2.5; // % per month
      const estimated    = f.EstimatedValue || 0;
      const currentValue = parseFloat(
        Math.max(0, estimated * Math.pow(1 - decayRate / 100, monthsOld)).toFixed(2)
      );
      return {
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
      };
    });

    // Persist the decayed CurrentValue back to Airtable — fired concurrently
    // via Promise.all, not sequentially in a for-loop. This is the actual
    // bug fix: previously each atPatch was awaited one at a time, and under
    // Airtable rate-limiting each call can take up to ~4s (full retry/backoff
    // budget) — so as few as 3 open opportunities could push total sequential
    // latency past Vercel Hobby's 10s function timeout, killing the function
    // mid-request with no clean error response (the "issue after issue" in
    // the browser network tab).
    //
    // Running them concurrently means N patches take ~1x the worst-case
    // latency instead of Nx. We still await the batch before responding,
    // per this file's own rule (all async work awaited before res.json() —
    // Vercel may freeze/tear down the function the instant a response is
    // sent, so an un-awaited write can silently never complete). Individual
    // patch failures remain non-fatal — only logged, never block the response.
    await Promise.all(
      decayed.map(d =>
        atPatch('List_Opportunities', d.id, { CurrentValue: d.currentValue })
          .then(patchResult => {
            if (!patchResult.ok) {
              console.error(`CurrentValue patch failed for ${d.id} (non-fatal): status ${patchResult.status}`);
            }
          })
      )
    ).catch(e => console.error('Unexpected error in decay patch batch (non-fatal):', e));

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
