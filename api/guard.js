// ─────────────────────────────────────────────────────────────
// SENDWIZE — guard.js v1.0
// Site guard: always-on monitoring of a verified site through one line
// of script (public/g.js). Builds on Site Sweep: the same Site_Sweeps
// record, the same domain verification, the same dashboard fixes.
//
// Actions:
//   POST ?action=collect   (public)  beacon from g.js, counters only
//   POST ?action=enable    { domain }                   → key + snippet
//   POST ?action=disable   { domain }
//   GET  ?action=get       domain                       → status, alerts, consent
//   GET/POST ?action=rollup (cron, internal)            → yesterday's alerts
//
// Alerts are delivered inside Sendwize only: the Site guard section of
// the Site sweep page, and dashboard fixes for the ones with a fix type.
// Turning Site guard off stops counting at once (the key is unlinked);
// removing the script line from the site stops it running at all.
//
// Needs Upstash Redis (UPSTASH_REDIS_REST_URL / _TOKEN), the same store
// as the usage limits. Without it, collect answers 503 and the page says
// monitoring is unavailable.
//
// Airtable, table Site_Sweeps (new fields):
//   GuardKey (single line text), GuardEnabledAt (date with time),
//   GuardJson (long text), GuardLastRollup (single line text)
// Fixes reuse FixKeysJson, with keys starting "guard:".
// ─────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { atFetch } from './_airtable.js';
import { requireAuth, internalHeaders, CORS_HEADERS } from './_auth.js';
import { redis, redisPipeline, redisConfigured, hashFromList } from './_redis.js';
import {
  cleanBeacon, beaconCommands, dayKey, siteDayKey, sitePagesKey, siteLastKey, siteMapKey,
  summariseDay, evaluateGuard, guardView, buildBenchmarks, consentStats, MAX_DAILY_VISITS,
} from './_guard.js';
import { memberEmail } from './_email.js';
import { normaliseDomain } from './site-sweep.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const TABLE = 'Site_Sweeps';
const BENCH_KEY = 'sw:g:bench';

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const nowIso = () => new Date().toISOString();

function ctx() {
  const token = process.env.AIRTABLE_TOKEN;
  return { token, base: `https://api.airtable.com/v0/${process.env.BASE_ID}`, authH: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}
async function findRecord(c, userId, domain) {
  const formula = encodeURIComponent(`AND({UserID}='${esc(userId)}',{Domain}='${esc(domain)}')`);
  const r = await atFetch(`${c.base}/${TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return (await r.json()).records?.[0] || null;
}
async function patchRecord(c, id, fields) {
  const r = await atFetch(`${c.base}/${TABLE}/${id}`, { method: 'PATCH', headers: c.authH, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

export function snippetFor(key) {
  return `<script src="${APP_URL}/g.js" data-site="${key}" async></script>`;
}

function hostOf(h) { try { return new URL(h).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } }

// ── collect ───────────────────────────────────────────────────
const keyCache = new Map(); // key → { domain, at }
async function domainForKey(key) {
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.domain;
  const domain = await redis(['GET', siteMapKey(key)]);
  keyCache.set(key, { domain: domain || null, at: Date.now() });
  return domain || null;
}

async function handleCollect(req, res) {
  if (!redisConfigured()) return res.status(503).end();
  let body = req.body;
  if (typeof body === 'string') body = safeJson(body, null);
  if (Buffer.isBuffer?.(body)) body = safeJson(body.toString('utf8'), null);
  const beacon = cleanBeacon(body);
  if (!beacon) return res.status(204).end();
  const domain = await domainForKey(beacon.key);
  if (!domain) return res.status(204).end();
  // Only count beacons sent from the site the key belongs to
  const from = hostOf(req.headers.origin) || hostOf(req.headers.referer);
  if (!from || !(from === domain || from.endsWith('.' + domain))) return res.status(204).end();
  const day = dayKey();
  const v = Number(await redis(['HGET', siteDayKey(beacon.key, day), 'v'])) || 0;
  if (v >= MAX_DAILY_VISITS) return res.status(204).end();
  await redisPipeline(beaconCommands(beacon, day));
  return res.status(204).end();
}

// ── member actions ────────────────────────────────────────────
async function loadOwned(req, res, { requireVerified = true } = {}) {
  const userId = req.body?.userId || req.query?.userId;
  const domain = normaliseDomain(req.body?.domain || req.query?.domain);
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return null; }
  if (!domain) { res.status(400).json({ error: 'Enter a valid website domain' }); return null; }
  const c = ctx();
  const record = await findRecord(c, userId, domain);
  if (!record) { res.status(404).json({ error: 'Add this site in Site sweep first' }); return null; }
  if (requireVerified && !record.fields.VerifiedAt) { res.status(403).json({ error: 'Verify you own this domain first' }); return null; }
  return { c, userId, domain, record };
}

async function handleEnable(req, res) {
  if (!redisConfigured()) return res.status(503).json({ error: 'Site guard needs the Upstash store, which is not set up yet.' });
  const o = await loadOwned(req, res); if (!o) return;
  const f = o.record.fields;
  const key = f.GuardKey && /^[a-f0-9]{20,40}$/.test(f.GuardKey) ? f.GuardKey : randomBytes(12).toString('hex');
  await redis(['SET', siteMapKey(key), o.domain]);
  keyCache.delete(key);
  const fields = { GuardKey: key, GuardEnabledAt: f.GuardEnabledAt || nowIso() };
  if (!f.GuardJson) fields.GuardJson = JSON.stringify({ daily: [], alerts: [], prices: {} });
  const updated = await patchRecord(o.c, o.record.id, fields);
  return res.json({ success: true, guard: await viewFor(updated) });
}

async function handleDisable(req, res) {
  const o = await loadOwned(req, res, { requireVerified: false }); if (!o) return;
  if (o.record.fields.GuardKey && redisConfigured()) await redis(['DEL', siteMapKey(o.record.fields.GuardKey)]).catch(() => {});
  const updated = await patchRecord(o.c, o.record.id, { GuardEnabledAt: null });
  return res.json({ success: true, guard: await viewFor(updated) });
}

async function viewFor(record, { live = true } = {}) {
  const f = record.fields || {};
  const enabled = !!(f.GuardEnabledAt && f.GuardKey);
  const state = safeJson(f.GuardJson, { daily: [], alerts: [], prices: {} });
  let benchmarks = null, lastSeen = null, today = null;
  if (redisConfigured()) {
    try {
      const day = dayKey();
      const [b, last, h, pg] = await redisPipeline([
        ['GET', BENCH_KEY],
        f.GuardKey ? ['GET', siteLastKey(f.GuardKey)] : ['GET', 'sw:none'],
        f.GuardKey && live ? ['HGETALL', siteDayKey(f.GuardKey, day)] : ['GET', 'sw:none'],
        f.GuardKey && live ? ['PFCOUNT', sitePagesKey(f.GuardKey, day)] : ['GET', 'sw:none'],
      ]);
      benchmarks = safeJson(b, null);
      lastSeen = last || null;
      if (h) {
        const sum = summariseDay(day, hashFromList(h), Number(pg) || 0);
        const cs = consentStats([sum]);
        today = { visits: sum.v, pages: sum.pages, consentRate: cs.rate, trackersFiringEarly: Object.entries(sum.trackers).filter(([, t]) => t.pre > 0).map(([n, t]) => ({ name: n, count: t.pre })) };
      }
    } catch (e) { console.warn('[guard] live read failed:', e.message); }
  }
  const profile = f.UserID ? await memberEmail(f.UserID) : null;
  return {
    available: redisConfigured(),
    enabled, domain: f.Domain, verified: !!f.VerifiedAt,
    snippet: f.GuardKey ? snippetFor(f.GuardKey) : null,
    enabledAt: f.GuardEnabledAt || null,
    lastSeen, connected: !!(lastSeen && Date.now() - Date.parse(lastSeen) < 3 * 86400000),
    lastRollup: f.GuardLastRollup || null,
    today,
    ...guardView(state, { benchmarks, sector: profile?.sector ? String(profile.sector).toLowerCase() : null }),
  };
}

async function handleGet(req, res) {
  const o = await loadOwned(req, res, { requireVerified: false }); if (!o) return;
  return res.json({ success: true, guard: await viewFor(o.record) });
}

// ── nightly rollup ────────────────────────────────────────────
async function raiseFix(userId, recordId, domain, alert) {
  const r = await fetch(`${APP_URL}/api/generate-fix`, {
    method: 'POST', headers: internalHeaders(),
    body: JSON.stringify({
      userId, fixType: alert.fixType, tool: 'Site guard', severity: alert.severity, sourceRecordId: recordId,
      description: `Site guard: ${alert.title} — ${domain}${alert.page && alert.page !== '/' ? alert.page : ''}`.slice(0, 250),
    }),
  });
  if (!r.ok) throw new Error(`generate-fix ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return d.fixId || null;
}

async function closeFix(userId, fixId) {
  if (!fixId) return;
  await fetch(`${APP_URL}/api/fixes?action=complete`, {
    method: 'POST', headers: internalHeaders(),
    body: JSON.stringify({ userId, fixId, completionSource: 'improved_on_rerun' }),
  }).catch(e => console.error('[guard] close fix failed:', e.message));
}

async function rollupSite(c, record, day, now) {
  const f = record.fields;
  const key = f.GuardKey;
  const [h, pg, last] = await redisPipeline([
    ['HGETALL', siteDayKey(key, day)],
    ['PFCOUNT', sitePagesKey(key, day)],
    ['GET', siteLastKey(key)],
  ]);
  const latest = summariseDay(day, hashFromList(h), Number(pg) || 0);
  const prevState = safeJson(f.GuardJson, { daily: [], alerts: [], prices: {} });
  const { state, opened, resolved } = evaluateGuard(prevState, latest, { now, lastSeenIso: last || null });

  // Dashboard fixes: one per alert that has a fix type; closed when it stops
  const fixKeys = safeJson(f.FixKeysJson, {});
  for (const a of opened.filter(x => x.fixType)) {
    const k = `guard:${a.key}`;
    if (fixKeys[k]?.fixId) continue;
    try { fixKeys[k] = { fixType: a.fixType, fixId: await raiseFix(f.UserID, record.id, f.Domain, a), status: 'created', at: nowIso() }; }
    catch (e) { console.error('[guard] fix failed (retried next run):', e.message); }
  }
  for (const a of resolved) {
    const k = `guard:${a.key}`;
    if (fixKeys[k]?.fixId) { await closeFix(f.UserID, fixKeys[k].fixId); a.events.push({ at: nowIso(), text: 'Dashboard fix closed automatically' }); }
    delete fixKeys[k];
  }

  // Alerts are shown in Sendwize only (Site sweep page, and as dashboard
  // fixes where they have a fix type). No email or Slack.
  for (const a of opened) a.events.push({ at: nowIso(), text: a.fixType ? 'Shown in Sendwize and added to your dashboard' : 'Shown in Sendwize' });
  const profile = await memberEmail(f.UserID);

  await patchRecord(c, record.id, { GuardJson: JSON.stringify(state).slice(0, 99000), FixKeysJson: JSON.stringify(fixKeys), GuardLastRollup: day });
  const cs = consentStats(state.daily.slice(-30));
  return { domain: f.Domain, opened: opened.length, resolved: resolved.length, rate: cs.rate, known: cs.known, sector: profile?.sector ? String(profile.sector).toLowerCase() : null };
}

async function handleRollup(req, res) {
  if (!redisConfigured()) return res.json({ success: false, reason: 'Upstash not configured' });
  const c = ctx();
  const now = new Date();
  const day = req.query?.day && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : dayKey(new Date(now.getTime() - 86400000));
  const formula = encodeURIComponent(`AND({GuardKey}!='',{GuardEnabledAt}!='')`);
  let records = [], offset = '';
  do {
    const r = await atFetch(`${c.base}/${TABLE}?filterByFormula=${formula}&pageSize=100${offset ? `&offset=${offset}` : ''}`, { headers: { Authorization: `Bearer ${c.token}` } });
    if (!r.ok) return res.status(500).json({ error: `Airtable ${r.status}` });
    const j = await r.json();
    records = records.concat(j.records || []);
    offset = j.offset || '';
  } while (offset && records.length < 1000);

  const started = Date.now();
  const results = [], errors = [];
  for (const record of records) {
    if (record.fields.GuardLastRollup === day && !req.query?.force) continue;
    if (Date.now() - started > 45000) { errors.push({ id: record.id, error: 'Out of time, picked up next run' }); continue; }
    try { results.push(await rollupSite(c, record, day, now)); }
    catch (e) { console.error('[guard] rollup failed', record.id, e.message); errors.push({ id: record.id, error: e.message }); }
  }

  // Benchmarks across every site with enough data (all sites, not just this run)
  const all = records.map(r => {
    const st = safeJson(r.fields.GuardJson, null);
    const done = results.find(x => x.domain === r.fields.Domain);
    if (done) return done;
    const cs = consentStats((st?.daily || []).slice(-30));
    return { rate: cs.rate, known: cs.known, sector: null };
  });
  const bench = buildBenchmarks(all);
  await redis(['SET', BENCH_KEY, JSON.stringify(bench)]).catch(() => {});

  return res.json({ success: true, day, sites: records.length, processed: results.length, results, errors, benchmarks: bench });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { action } = req.query;
  if (action === 'collect') {
    // Any site may post a beacon; nothing is returned to read
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).end();
    try { return await handleCollect(req, res); }
    catch (e) { console.error('[guard] collect error:', e.message); return res.status(204).end(); }
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (action === 'rollup') {
      if (auth.kind !== 'internal') return res.status(401).json({ error: 'Not allowed' });
      return await handleRollup(req, res);
    }
    if (req.method === 'POST' && action === 'enable')   return await handleEnable(req, res);
    if (req.method === 'POST' && action === 'disable')  return await handleDisable(req, res);
    if (req.method === 'GET'  && action === 'get')      return await handleGet(req, res);
    return res.status(400).json({ error: 'Unknown action. Use enable, disable or get.' });
  } catch (e) {
    console.error('guard.js error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
