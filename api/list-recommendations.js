// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-recommendations.js v1.0
// GET /api/list-recommendations?userId=x
//
// Returns decayed List_Opportunities for dashboard headline number 3.
// Called on login — CurrentValue decays since upload date.
// Patches Airtable CurrentValue in place so decay persists.
// All async work AWAITED before res.json() — Vercel Hobby safe.
// ─────────────────────────────────────────────────────────────

const BASE_ID = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

async function atGet(table, formula, sort = '', max = 50) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await fetch(url, { headers: atH() });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method:  'PATCH',
    headers: atH(),
    body:    JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`AT PATCH ${table}: ${r.status}`);
  return await r.json();
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
    const opps = await atGet(
      'List_Opportunities',
      `AND({UserID}='${userId}',{Status}='Open')`,
      'sort[0][field]=EstimatedValue&sort[0][direction]=desc',
      50
    );

    if (!opps.length) {
      return res.status(200).json({
        success:         true,
        unrealisedTotal: 0,
        opportunities:   [],
        hasData:         false,
      });
    }

    const now = new Date();

    // Apply decay to each opportunity and patch Airtable
    const decayed = [];
    for (const o of opps) {
      const f           = o.fields;
      const created     = f.CreatedDate ? new Date(f.CreatedDate) : now;
      const monthsOld   = (now - created) / (30 * 86400000);
      const decayRate   = f.DecayRate || 2.5; // % per month
      const estimated   = f.EstimatedValue || 0;
      const currentValue = parseFloat(
        Math.max(0, estimated * Math.pow(1 - decayRate / 100, monthsOld)).toFixed(2)
      );

      // Patch Airtable with decayed value — so dashboard always reads fresh
      try {
        await atPatch('List_Opportunities', o.id, { CurrentValue: currentValue });
      } catch(e) {
        console.error(`CurrentValue patch failed for ${o.id} (non-fatal):`, e);
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
    console.error('list-recommendations error:', err);
    return res.status(500).json({ error: err.message });
  }
}
