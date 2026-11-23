// ─────────────────────────────────────────────────────────────
// SENDWIZE — claims-bank.js v1.0
// Claims Bank: every claim a member makes, watched against new ASA, ICO
// and CMA decisions. Logic that doesn't touch Airtable is in
// _claims-bank.js.
//
//   GET  ?action=list                 → the member's claims, open alerts
//                                       first, with the £ each open alert
//                                       adds to the dashboard
//   POST ?action=add      { copy | claims[], campaign, channel, source,
//                           sourceRecordId }
//                                     → claims added (duplicates skipped),
//                                       then checked straight away against
//                                       the last 90 days of decisions
//   POST ?action=respond  { claimId, alertId, action, note, newText, by }
//                                     → taken down / changed / kept, dated
//                                       and named; the alert's dashboard
//                                       fix closes once nothing is open
//   POST ?action=retire   { claimId, by }  → no longer running
//   POST ?action=restore  { claimId, by }  → running again, watched again
//   GET|POST ?action=match            → cron (07:30 daily, after the
//                                       regulator feed at 07:00): new
//                                       decisions matched to live claims
//
// Each new alert becomes a Compliance_Fixes row (tool "Claims Bank") via
// generate-fix, so it counts in the score and £ exposure like any other
// finding, and the dashboard shows it under "Sendwize noticed".
//
// Airtable table Claims_Bank (all text fields; long text where marked):
//   UserID, ClaimText (long), ClaimKey, ClaimType, Issues (long),
//   Campaign, Channel, Source, SourceRecordId, Status, AddedAt, UpdatedAt,
//   AlertsJson (long), HistoryJson (long), Evidence (long)
// ─────────────────────────────────────────────────────────────
import { requireAuth, internalHeaders, isRecordId, CORS_HEADERS } from './_auth.js';
import { atFetch, fq } from './_airtable.js';
import { checkLimit } from './_limits.js';
import { redis, redisConfigured } from './_redis.js';
import { sendEmail, emailLayout, escHtml, memberEmail } from './_email.js';
import { issueOf } from './_copy-issues.js';
import {
  extractClaims, cleanImages, newClaimFields, claimFromRecord, rulingFromFeed, rulingIssues, shortlist,
  matchClaims, alertFor, applyResponse, openAlerts, cleanText, MAX_CLAIMS_PER_ADD,
} from './_claims-bank.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const TABLE = 'Claims_Bank';
// Shown as the finding's tool on the dashboard; TOOL_PAGE in sw-dashboard.js
// sends 'campaign defence claims' to the Claims watched tab
const TOOL = 'Campaign Defence claims';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://sendwize.co.uk/dashboard';

const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const authH = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });

async function atList(table, formula, { max = 1000, sort = '' } = {}) {
  const out = [];
  let offset = '';
  do {
    const url = `${base()}/${encodeURIComponent(table)}?pageSize=100${formula ? `&filterByFormula=${encodeURIComponent(formula)}` : ''}${sort}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const r = await atFetch(url, { headers: authH() });
    if (!r.ok) throw new Error(`GET ${table}: ${r.status}`);
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset || '';
  } while (offset && out.length < max);
  return out.slice(0, max);
}

async function atGetOne(table, id) {
  const r = await atFetch(`${base()}/${encodeURIComponent(table)}/${id}`, { headers: authH() });
  return r.ok ? r.json() : null;
}

// Create or update in batches of 10 (Airtable's limit)
async function atBatch(method, table, records) {
  const saved = [];
  for (let i = 0; i < records.length; i += 10) {
    const r = await atFetch(`${base()}/${encodeURIComponent(table)}`, {
      method, headers: authH(), body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error?.message || `${method} ${table}: ${r.status}`);
    }
    saved.push(...((await r.json()).records || []));
  }
  return saved;
}

function claimPatch(id, out) {
  const fields = { AlertsJson: JSON.stringify(out.alerts), HistoryJson: JSON.stringify(out.history), UpdatedAt: out.updatedAt };
  if (out.status) fields.Status = out.status;
  if (out.text) fields.ClaimText = out.text;
  if (out.issues) fields.Issues = JSON.stringify(out.issues);
  if (out.evidence != null) fields.Evidence = out.evidence;
  return { id, fields };
}

// What the page shows for one claim
function publicClaim(c, exposure) {
  return {
    id: c.id, text: c.text, claimType: c.claimType, issues: c.issues.map(i => ({ id: i, label: issueOf(i).label })),
    campaign: c.campaign, channel: c.channel, source: c.source, status: c.status,
    addedAt: c.addedAt, updatedAt: c.updatedAt, evidence: c.evidence,
    alerts: c.alerts, openAlerts: openAlerts(c).length, history: c.history,
    exposure: exposure || null,
  };
}

// ── Dashboard fixes: one per alerted claim, so it counts in the score and £ ──
function fixTypeFor(claim, ruling) {
  const want = new Set(rulingIssues(ruling));
  const shared = (claim.issues || []).find(i => want.has(i)) || claim.issues?.[0];
  return issueOf(shared).fixType || 'misleading_claim';
}

async function raiseFix(claim, ruling, alert) {
  try {
    await fetch(`${APP_URL}/api/generate-fix`, {
      method: 'POST', headers: internalHeaders(),
      body: JSON.stringify({
        userId: claim.userId,
        fixType: fixTypeFor(claim, ruling),
        description: `Claim watch: "${cleanText(claim.text, 120)}" is similar to wording in a new ${alert.regulator || 'regulator'} decision${alert.company ? ` about ${alert.company}` : ''}. Record what you did in Campaign Defence, Claims watched.`,
        tool: TOOL, severity: 'medium', sourceRecordId: claim.id,
      }),
    });
  } catch (e) { console.error('Claims Bank fix (non-fatal):', e.message); }
}

// Close the claim's pending dashboard fixes once it has no open alerts
async function closeFixes(userId, claimId) {
  try {
    const recs = await atList('Compliance_Fixes', `AND({UserID}=${fq(userId)},{SourceRecordID}=${fq(claimId)},{Tool}=${fq(TOOL)},{Status}='pending')`, { max: 50 });
    if (!recs.length) return 0;
    const today = new Date().toISOString().split('T')[0];
    await atBatch('PATCH', 'Compliance_Fixes', recs.map(r => ({ id: r.id, fields: { Status: 'completed', CompletedDate: today, CompletionSource: 'claims_bank' } })));
    return recs.length;
  } catch (e) {
    console.error('Claims Bank close fixes (non-fatal):', e.message);
    return 0;
  }
}

// The £ the dashboard shows for each claim's open fix, from the shared engine
async function exposureByClaim(userId) {
  try {
    const r = await fetch(`${APP_URL}/api/fixes?action=get&userId=${encodeURIComponent(userId)}`, { headers: internalHeaders() });
    if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    for (const f of j.fixes?.pending || []) {
      if (f.tool !== TOOL || !f.sourceRecordId) continue;
      const e = f.exposure || {};
      const m = e.marketingCost;
      out[f.sourceRecordId] = {
        category: e.category || null,
        low: e.low ?? null, high: e.high ?? null,
        mostLikely: m?.available ? m.mostLikely : null,
        label: m?.label || null,
        needs: m && !m.available ? (m.needs || []) : [],
        legalMax: e.legalMax ?? null,
      };
    }
    return out;
  } catch { return {}; }
}

// ── LIST ──────────────────────────────────────────────────────
async function handleList(req, res) {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  let recs;
  try { recs = await atList(TABLE, `{UserID}=${fq(userId)}`, { max: 500 }); }
  catch (e) { return res.status(502).json({ error: 'Could not load your claims', detail: e.message }); }
  const claims = recs.map(claimFromRecord);
  const exposure = claims.some(c => openAlerts(c).length) ? await exposureByClaim(userId) : {};
  const rank = c => (openAlerts(c).length ? 0 : c.status === 'live' ? 1 : 2);
  claims.sort((a, b) => rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const live = claims.filter(c => c.status === 'live');
  const open = claims.reduce((s, c) => s + openAlerts(c).length, 0);
  const atStake = Object.values(exposure).reduce((s, e) => s + (e.mostLikely || 0), 0);
  return res.json({
    success: true,
    claims: claims.map(c => publicClaim(c, exposure[c.id])),
    totals: {
      claims: claims.length, live: live.length, watched: live.filter(c => c.issues.length).length,
      openAlerts: open, atStake, answered: claims.reduce((s, c) => s + (c.alerts || []).filter(a => a.status === 'answered').length, 0),
    },
  });
}

// ── ADD ───────────────────────────────────────────────────────
async function handleAdd(req, res, auth) {
  const { userId, copy, images, claims: given, campaign = '', channel = '', source = 'Added by hand', sourceRecordId = '', replaces = [] } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!(await checkLimit(req, res, auth, 'claims_add'))) return;

  let raw = Array.isArray(given) ? given.filter(c => c && (c.claim || c.text)) : [];
  const pics = cleanImages(images);
  const hasCopy = (typeof copy === 'string' && copy.trim()) || pics.length;
  if (!raw.length && hasCopy) raw = await extractClaims(typeof copy === 'string' ? copy : '', pics);
  if (!raw.length) return res.json({ success: true, added: [], skipped: 0, message: hasCopy ? 'No claims found in that copy.' : 'Nothing to add.' });

  const now = new Date().toISOString();
  const src = auth.kind === 'internal' ? source : (['Copy checker', 'Added by hand'].includes(source) ? source : 'Added by hand');
  const fields = raw.slice(0, MAX_CLAIMS_PER_ADD).map(c => newClaimFields(userId, c, { source: src, campaign, channel, sourceRecordId, now })).filter(Boolean);

  let existing = [];
  try { existing = await atList(TABLE, `{UserID}=${fq(userId)}`, { max: 1000 }); }
  catch (e) { return res.status(502).json({ error: 'Could not load your claims', detail: e.message }); }
  const byKey = new Map(existing.map(r => [r.fields?.ClaimKey, r]));
  const fresh = [], seen = new Set();
  for (const f of fields) { if (!byKey.has(f.ClaimKey) && !seen.has(f.ClaimKey)) { seen.add(f.ClaimKey); fresh.push(f); } }

  let saved = [];
  try { saved = fresh.length ? await atBatch('POST', TABLE, fresh.map(f => ({ fields: f }))) : []; }
  catch (e) { return res.status(500).json({ error: 'Could not save the claims', detail: e.message }); }

  // A rechecked version replaces the one before: its claims that weren't
  // carried over stop being watched (unless an alert is waiting on them)
  const replacedIds = (Array.isArray(replaces) ? replaces : []).filter(isRecordId).slice(0, 5);
  let replaced = 0;
  if (replacedIds.length) {
    const keep = new Set(fields.map(f => f.ClaimKey));
    const old = existing.map(claimFromRecord).filter(c => replacedIds.includes(c.sourceRecordId) && c.status === 'live' && !openAlerts(c).length && !keep.has(c.key));
    if (old.length) {
      try {
        await atBatch('PATCH', TABLE, old.map(c => ({ id: c.id, fields: { Status: 'changed', UpdatedAt: now, HistoryJson: JSON.stringify([...c.history, { at: now, by: src, action: 'replaced', label: 'Replaced by a rechecked version' }]) } })));
        replaced = old.length;
      } catch (e) { console.error('Claims Bank replace (non-fatal):', e.message); }
    }
  }

  // Straight away: do any of the new claims look like a decision from the last 90 days?
  let matched = [];
  try { matched = await matchRecent(saved.map(claimFromRecord)); }
  catch (e) { console.error('Claims Bank recent match (non-fatal):', e.message); }

  return res.json({
    success: true,
    added: saved.map(r => publicClaim(claimFromRecord(r))),
    skipped: fields.length - fresh.length,
    replaced,
    matched: matched.length,
  });
}

// New claims against the most recent decisions that share an issue with them
async function matchRecent(claims) {
  if (!claims.length) return [];
  const feed = await atList('Sector_Intelligence_Feed', `IS_AFTER({PublishedDate}, DATEADD(TODAY(), -90, 'days'))`,
    { max: 200, sort: '&sort%5B0%5D%5Bfield%5D=PublishedDate&sort%5B0%5D%5Bdirection%5D=desc' }).catch(() => []);
  const rulings = feed.map(rulingFromFeed).filter(r => shortlist(r, claims).length).slice(0, 6);
  const results = await Promise.all(rulings.map(async r => ({ ruling: r, hits: await matchClaims(r, shortlist(r, claims)) })));
  return applyMatches(results);
}

// Store each match as an alert on its claim and raise its dashboard fix.
// Returns [{ claim, alert }] for the matches saved.
async function applyMatches(results) {
  const byClaim = new Map();
  const saved = [];
  const now = new Date().toISOString();
  for (const { ruling, hits } of results) {
    for (const { claim, why } of hits) {
      const c = byClaim.get(claim.id) || { ...claim, alerts: [...(claim.alerts || [])] };
      if (c.alerts.some(a => a.rulingId === ruling.id)) continue;
      const alert = alertFor(ruling, why, now);
      c.alerts.push(alert);
      byClaim.set(claim.id, c);
      saved.push({ claim: c, alert, ruling });
    }
  }
  if (!byClaim.size) return [];
  const history = c => [...(c.history || []), ...c.alerts.filter(a => a.foundAt === now).map(a => ({ at: now, by: 'Sendwize', action: 'alert', label: a.title }))];
  await atBatch('PATCH', TABLE, [...byClaim.values()].map(c => ({ id: c.id, fields: { AlertsJson: JSON.stringify(c.alerts), HistoryJson: JSON.stringify(history(c)), UpdatedAt: now } })));
  await Promise.all(saved.map(s => raiseFix(s.claim, s.ruling, s.alert)));
  return saved;
}

// ── RESPOND / RETIRE / RESTORE ────────────────────────────────
async function loadOwnClaim(req, res) {
  const { userId, claimId } = req.body ?? {};
  if (!userId || !isRecordId(claimId)) { res.status(400).json({ error: 'Missing userId or claimId' }); return null; }
  const rec = await atGetOne(TABLE, claimId);
  if (!rec) { res.status(404).json({ error: 'Claim not found' }); return null; }
  if (rec.fields?.UserID !== userId) { res.status(403).json({ error: 'Not authorised' }); return null; }
  return claimFromRecord(rec);
}

async function handleRespond(req, res) {
  const claim = await loadOwnClaim(req, res);
  if (!claim) return;
  const { alertId, action, note, newText, by } = req.body ?? {};
  const out = applyResponse(claim, { alertId, action, note, newText, by });
  if (out.error) return res.status(400).json({ error: out.error });
  try { await atBatch('PATCH', TABLE, [claimPatch(claim.id, out)]); }
  catch (e) { return res.status(500).json({ error: 'Could not save your answer', detail: e.message }); }
  const stillOpen = out.alerts.some(a => a.status === 'open');
  const closed = stillOpen ? 0 : await closeFixes(claim.userId, claim.id);
  return res.json({ success: true, claim: publicClaim({ ...claim, ...out }), fixesClosed: closed });
}

async function handleStatus(req, res, status) {
  const claim = await loadOwnClaim(req, res);
  if (!claim) return;
  const by = cleanText(req.body?.by, 80) || 'Member';
  const now = new Date().toISOString();
  if (status === 'retired' && openAlerts(claim).length) return res.status(400).json({ error: 'Answer the open alert first: taken down covers a claim that is no longer running.' });
  const history = [...claim.history, { at: now, by, action: status === 'retired' ? 'retired' : 'restored', label: status === 'retired' ? 'No longer running' : 'Running again' }];
  try { await atBatch('PATCH', TABLE, [{ id: claim.id, fields: { Status: status, HistoryJson: JSON.stringify(history), UpdatedAt: now } }]); }
  catch (e) { return res.status(500).json({ error: 'Could not update the claim', detail: e.message }); }
  return res.json({ success: true, claim: publicClaim({ ...claim, status, history, updatedAt: now }) });
}

// ── MATCH (cron) ──────────────────────────────────────────────
const doneKey = id => `cb:ruling:${id}`;
async function alreadyChecked(id) {
  if (!redisConfigured()) return false;
  try { return !!(await redis(['GET', doneKey(id)])); } catch { return false; }
}
async function markChecked(id) {
  if (!redisConfigured()) return;
  try { await redis(['SET', doneKey(id), '1', 'EX', String(14 * 86400)]); } catch {}
}

async function handleMatch(req, res) {
  const started = Date.now();
  const result = { rulings: 0, checked: 0, alerts: 0, emails: 0, errors: [] };
  let feed = [], claims = [];
  try {
    feed = await atList('Sector_Intelligence_Feed', `IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -3, 'days'))`, { max: 60 });
    claims = (await atList(TABLE, `{Status}='live'`, { max: 3000 })).map(claimFromRecord);
  } catch (e) {
    return res.status(502).json({ error: 'Could not load the feed or claims', detail: e.message });
  }
  result.rulings = feed.length;
  const all = [];
  for (const rec of feed) {
    if (Date.now() - started > 45000) { result.errors.push('Stopped early to stay inside the time limit; the rest run tomorrow.'); break; }
    const ruling = rulingFromFeed(rec);
    if (await alreadyChecked(ruling.id)) continue;
    const candidates = shortlist(ruling, claims);
    result.checked++;
    try {
      const hits = candidates.length ? await matchClaims(ruling, candidates) : [];
      const saved = await applyMatches([{ ruling, hits }]);
      // Keep the in-memory claims current so the next ruling sees these alerts
      for (const s of saved) { const i = claims.findIndex(c => c.id === s.claim.id); if (i >= 0) claims[i] = s.claim; }
      all.push(...saved);
      await markChecked(ruling.id);
    } catch (e) {
      result.errors.push(`${ruling.company || ruling.id}: ${e.message}`);
    }
  }
  result.alerts = all.length;

  // One email per member, listing their new alerts
  const byUser = new Map();
  for (const s of all) byUser.set(s.claim.userId, [...(byUser.get(s.claim.userId) || []), s]);
  for (const [userId, list] of byUser) {
    try {
      const who = (await memberEmail(userId)) || (userId.includes('__') ? await memberEmail(userId.split('__')[0]) : null);
      if (!who?.email) continue;
      const items = list.slice(0, 8).map(s => `<li style="margin:0 0 12px;color:#333;font-size:14px"><b>"${escHtml(cleanText(s.claim.text, 140))}"</b><br><span style="color:#555">${escHtml(s.alert.title)}. ${escHtml(s.alert.why)}</span></li>`).join('');
      const r = await sendEmail({
        to: who.email,
        subject: list.length === 1 ? 'A new decision looks similar to one of your claims' : `New decisions look similar to ${list.length} of your claims`,
        html: emailLayout({
          heading: 'New decisions that look like your claims',
          bodyHtml: `<p style="color:#555;font-size:14px">A regulator published a decision that looks similar to wording you are using. Open Campaign Defence, Claims watched, to record what you did: taken down, changed, or kept with your evidence.</p><ul style="padding-left:18px">${items}</ul>`,
          ctaText: 'Open Sendwize', ctaUrl: DASHBOARD_URL,
          footnote: 'Sendwize shows published decisions that look similar to your wording. It is information, not legal advice.',
        }),
      });
      if (r.sent) result.emails++;
    } catch (e) { result.errors.push(`email ${userId}: ${e.message}`); }
  }
  return res.json({ success: true, ...result, ms: Date.now() - started });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query || {};
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (action === 'match') {
      if (auth.kind !== 'internal') return res.status(401).json({ error: 'Not allowed' });
      return await handleMatch(req, res);
    }
    if (req.method === 'GET'  && action === 'list')    return await handleList(req, res);
    if (req.method === 'POST' && action === 'add')     return await handleAdd(req, res, auth);
    if (req.method === 'POST' && action === 'respond') return await handleRespond(req, res);
    if (req.method === 'POST' && action === 'retire')  return await handleStatus(req, res, 'retired');
    if (req.method === 'POST' && action === 'restore') return await handleStatus(req, res, 'live');
    return res.status(400).json({ error: 'Unknown action. Use list, add, respond, retire or restore.' });
  } catch (e) {
    console.error('claims-bank.js error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
