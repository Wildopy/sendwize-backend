// ─────────────────────────────────────────────────────────────
// SENDWIZE — connections.js v1.0 (Nov 2026)
// Connect Klaviyo or Mailchimp with a read-only API key (HubSpot with a
// private app token), then pull
// contacts (List health), campaign results (Audience read) and how
// people responded to recent sends (Campaign defence) without exporting
// CSVs. Pulled data comes back shaped like the platform's own export and
// goes through the same analysis as an upload. Nothing is stored except
// the encrypted key.
//
//   GET  ?action=status                          → connected platforms
//   POST ?action=connect    { provider, apiKey } → checks the key, saves it encrypted
//   POST ?action=disconnect { provider }         → deletes the saved key
//   GET  ?action=lists      provider             → lists / audiences
//   POST ?action=pull-contacts  { provider, listId } → { headers, rows, truncated }
//   POST ?action=pull-campaigns { provider }         → { headers, rows }
//   GET  ?action=responses  [provider]           → recent sends with rates and flags
//
// Airtable table: Connections
//   UserID, Provider, KeyEnc (long text), KeyMask, Account, ConnectedAt,
//   LastUsedAt
// Env: CONNECTIONS_SECRET (recommended; falls back to INTERNAL_API_SECRET)
// ─────────────────────────────────────────────────────────────

import { atFetch } from './_airtable.js';
import { requireAuth, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import { PROVIDERS, sealKey, openKey, maskKey, responseSummary } from './_esp.js';

const TABLE = 'Connections';
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nowIso = () => new Date().toISOString();
// Campaign defence asks for recent sends each time a live case file opens:
// keep them for 10 minutes per warm function so that doesn't use up pulls
const RESP_CACHE = new Map();
const RESP_TTL_MS = 10 * 60 * 1000;

function ctx() {
  const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  const token = process.env.AIRTABLE_TOKEN;
  return { base, h: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}
const setupError = () => Object.assign(new Error('Connections need a "Connections" table in Airtable with the fields UserID, Provider, KeyEnc, KeyMask, Account, ConnectedAt, LastUsedAt.'), { setup: true });

async function findAll(userId) {
  const c = ctx();
  const r = await atFetch(`${c.base}/${TABLE}?filterByFormula=${encodeURIComponent(`{UserID}='${esc(userId)}'`)}&maxRecords=20`, { headers: c.h });
  if (r.status === 404 || r.status === 403 || r.status === 422) throw setupError();
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return (await r.json()).records || [];
}
async function findOne(userId, provider) {
  return (await findAll(userId)).find(x => x.fields.Provider === provider) || null;
}
const view = rec => ({ provider: rec.fields.Provider, name: PROVIDERS[rec.fields.Provider]?.name || rec.fields.Provider, account: rec.fields.Account || '', keyMask: rec.fields.KeyMask || '', connectedAt: rec.fields.ConnectedAt || null, lastUsedAt: rec.fields.LastUsedAt || null });

function providerOf(raw) {
  const p = String(raw || '').toLowerCase();
  if (!PROVIDERS[p]) throw Object.assign(new Error('Choose Klaviyo, Mailchimp or HubSpot.'), { userFacing: true, status: 400 });
  return p;
}

// Opens the saved key for a member's platform and records the use
async function keyFor(userId, provider) {
  const rec = await findOne(userId, provider);
  if (!rec) throw Object.assign(new Error(`Connect ${PROVIDERS[provider].name} first.`), { userFacing: true, status: 404 });
  let key;
  try { key = openKey(rec.fields.KeyEnc); } catch { throw Object.assign(new Error(`Your ${PROVIDERS[provider].name} connection needs reconnecting.`), { userFacing: true, status: 409 }); }
  const c = ctx();
  atFetch(`${c.base}/${TABLE}/${rec.id}`, { method: 'PATCH', headers: c.h, body: JSON.stringify({ fields: { LastUsedAt: nowIso() } }) }).catch(() => {});
  return key;
}

async function handleConnect(req, res, userId) {
  const provider = providerOf(req.body?.provider);
  const P = PROVIDERS[provider];
  const key = String(req.body?.apiKey || '').trim();
  if (!key) return res.status(400).json({ error: `Paste your ${P.name} API key.` });
  if (!P.checkFormat(key)) return res.status(400).json({ error: `That doesn't look like a ${P.name} API key. ${P.keyHint}` });
  const { account } = await P.verify(key);

  const c = ctx();
  const fields = { UserID: userId, Provider: provider, KeyEnc: sealKey(key), KeyMask: maskKey(key), Account: String(account).slice(0, 120), ConnectedAt: nowIso() };
  const existing = await findOne(userId, provider);
  const r = existing
    ? await atFetch(`${c.base}/${TABLE}/${existing.id}`, { method: 'PATCH', headers: c.h, body: JSON.stringify({ fields }) })
    : await atFetch(`${c.base}/${TABLE}`, { method: 'POST', headers: c.h, body: JSON.stringify({ fields }) });
  if (r.status === 422) throw setupError();
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return res.json({ success: true, connection: view(await r.json()) });
}

async function handleDisconnect(req, res, userId) {
  const provider = providerOf(req.body?.provider);
  const rec = await findOne(userId, provider);
  if (rec) {
    const c = ctx();
    const r = await atFetch(`${c.base}/${TABLE}/${rec.id}`, { method: 'DELETE', headers: c.h });
    if (!r.ok) throw new Error(`Airtable ${r.status}`);
    RESP_CACHE.delete(`${userId}:${provider}`);
  }
  return res.json({ success: true });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    if (req.method === 'GET' && action === 'status') {
      try { return res.json({ success: true, connections: (await findAll(userId)).map(view) }); }
      catch (e) { if (e.setup) return res.json({ success: true, connections: [], setupRequired: true }); throw e; }
    }
    if (req.method === 'POST' && action === 'connect') return await handleConnect(req, res, userId);
    if (req.method === 'POST' && action === 'disconnect') return await handleDisconnect(req, res, userId);

    if (req.method === 'GET' && action === 'lists') {
      const provider = providerOf(req.query.provider);
      return res.json({ success: true, lists: await PROVIDERS[provider].lists(await keyFor(userId, provider)) });
    }
    if (req.method === 'POST' && (action === 'pull-contacts' || action === 'pull-campaigns')) {
      if (!(await checkLimit(req, res, auth, 'esp_pull'))) return;
      const provider = providerOf(req.body?.provider);
      const key = await keyFor(userId, provider);
      if (action === 'pull-campaigns') {
        const out = await PROVIDERS[provider].campaigns(key);
        return res.json({ success: true, provider, ...out });
      }
      const listId = String(req.body?.listId || '');
      if (!/^[A-Za-z0-9_-]{2,40}$/.test(listId)) return res.status(400).json({ error: 'Choose a list' });
      const out = await PROVIDERS[provider].contacts(key, listId);
      return res.json({ success: true, provider, ...out });
    }
    if (req.method === 'GET' && action === 'responses') {
      let conns = [];
      try { conns = await findAll(userId); } catch (e) { if (!e.setup) throw e; }
      const rec = req.query.provider ? conns.find(x => x.fields.Provider === req.query.provider) : conns[0];
      if (!rec || !PROVIDERS[rec.fields.Provider]) return res.json({ success: true, connected: false, sends: [] });
      const provider = rec.fields.Provider;
      const ck = `${userId}:${provider}`, hit = RESP_CACHE.get(ck);
      if (hit && Date.now() - hit.at < RESP_TTL_MS) return res.json(hit.body);
      if (!(await checkLimit(req, res, auth, 'esp_pull'))) return;
      const campaigns = await PROVIDERS[provider].campaigns(await keyFor(userId, provider));
      const body = { success: true, connected: true, provider, name: PROVIDERS[provider].name, sends: responseSummary(campaigns, 30) };
      RESP_CACHE.set(ck, { at: Date.now(), body });
      return res.json(body);
    }
    return res.status(400).json({ error: 'Unknown action. Use status, connect, disconnect, lists, pull-contacts, pull-campaigns or responses.' });
  } catch (e) {
    if (e.setup) return res.status(503).json({ error: e.message, code: 'setup_required' });
    if (e.userFacing) return res.status(e.status || 400).json({ error: e.message });
    console.error('connections.js error:', e);
    return res.status(500).json({ error: `Connection error: ${String(e.message || e).slice(0, 200)}` });
  }
}
