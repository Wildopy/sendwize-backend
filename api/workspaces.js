// ─────────────────────────────────────────────────────────────
// SENDWIZE — workspaces.js v1.0
// Client workspaces for agencies and freelancers. Each workspace is a
// separate Sendwize account for one client: its own business profile,
// fixes, lists, checks and score. The browser picks the active one with
// the X-Sendwize-Workspace header (see _auth.js and sw-auth.js).
//
//   GET  ?action=list     the member's workspaces + whether they can add more
//   GET  ?action=current  branding for the workspace in the header (or null)
//   POST ?action=create   { name, logoUrl?, brandColour? }
//   POST ?action=update   { id, name?, logoUrl?, brandColour? }
//   POST ?action=archive  { id }   hides it; its records are kept
//
// Airtable table Workspaces (fields are text unless noted):
//   WorkspaceID, OwnerID, ClientName, LogoUrl, BrandColour,
//   CreatedAt, Archived (checkbox)
//
// Env vars (both optional):
//   SENDWIZE_AGENCY_PLAN_IDS  Memberstack plan ids that may add clients,
//                             comma separated. Unset = any paid member.
//   SENDWIZE_MAX_WORKSPACES   clients per member (default 10)
// ─────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { atFetch, fq } from './_airtable.js';
import { requireAuth, CORS_HEADERS, isWorkspaceId, activePlanIds, forgetWorkspace } from './_auth.js';

const TABLE = 'Workspaces';
const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}/${TABLE}`;
const hdrs = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });
const maxWorkspaces = () => { const n = parseInt(process.env.SENDWIZE_MAX_WORKSPACES || '', 10); return n > 0 ? n : 10; };

const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const cleanLogo = v => { const s = String(v || '').trim(); return /^https:\/\/[^\s"'<>]{4,490}$/i.test(s) ? s : ''; };
const cleanColour = v => (/^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : '');
const newId = () => 'ws' + Array.from(randomBytes(10), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

const fmt = r => ({
  id: r.fields.WorkspaceID, name: r.fields.ClientName || 'Client',
  logoUrl: r.fields.LogoUrl || null, brandColour: r.fields.BrandColour || null,
  createdAt: r.fields.CreatedAt || null, recordId: r.id,
});

async function listFor(memberId) {
  const formula = encodeURIComponent(`AND({OwnerID}=${fq(memberId)},NOT({Archived}))`);
  const r = await atFetch(`${base()}?filterByFormula=${formula}&pageSize=100`, { headers: hdrs() });
  if (r.status === 404 || r.status === 403) return { missingTable: true, records: [] };
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return { records: ((await r.json()).records || []).sort((a, b) => String(a.fields.ClientName || '').localeCompare(String(b.fields.ClientName || ''))) };
}

async function mayAddClients(memberId) {
  const allowed = (process.env.SENDWIZE_AGENCY_PLAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const ids = await activePlanIds(memberId);
  return !!ids && ids.some(id => allowed.includes(id));
}

async function findOwned(memberId, id) {
  if (!isWorkspaceId(id)) return null;
  const { records } = await listFor(memberId);
  return records.find(r => r.fields.WorkspaceID === id) || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    // Workspaces belong to the member, whichever client is open
    const auth = await requireAuth(req, res, { ignoreWorkspace: action !== 'current' });
    if (!auth) return;
    if (auth.kind !== 'member') return res.status(403).json({ error: 'Members only' });
    const memberId = auth.memberId || auth.userId;

    if (req.method === 'GET' && action === 'current') {
      if (!auth.workspace) return res.json({ workspace: null });
      const rec = await findOwned(memberId, auth.workspace);
      return res.json({ workspace: rec ? fmt(rec) : null });
    }

    if (req.method === 'GET' && action === 'list') {
      const { records, missingTable } = await listFor(memberId);
      const canAdd = !missingTable && await mayAddClients(memberId);
      return res.json({
        workspaces: records.map(fmt), max: maxWorkspaces(),
        canAdd: canAdd && records.length < maxWorkspaces(), agency: canAdd || records.length > 0,
        setupNeeded: !!missingTable,
      });
    }

    if (req.method !== 'POST') return res.status(400).json({ error: 'Use ?action=list|current|create|update|archive' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (action === 'create') {
      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: 'Give the client a name.' });
      if (!(await mayAddClients(memberId))) return res.status(402).json({ error: 'Client workspaces come with the agency plan.', code: 'agency_plan_required' });
      const { records, missingTable } = await listFor(memberId);
      if (missingTable) return res.status(503).json({ error: 'Client workspaces are not set up yet.', code: 'setup_needed' });
      if (records.length >= maxWorkspaces()) return res.status(409).json({ error: `Your plan includes ${maxWorkspaces()} clients. Archive one or ask us for more.`, code: 'workspace_limit' });
      const fields = { WorkspaceID: newId(), OwnerID: memberId, ClientName: name, CreatedAt: new Date().toISOString() };
      const logo = cleanLogo(body.logoUrl), colour = cleanColour(body.brandColour);
      if (logo) fields.LogoUrl = logo;
      if (colour) fields.BrandColour = colour;
      const r = await atFetch(base(), { method: 'POST', headers: hdrs(), body: JSON.stringify({ records: [{ fields }] }) });
      if (!r.ok) return res.status(502).json({ error: 'Could not save the client. Try again.' });
      const rec = (await r.json()).records[0];
      return res.json({ success: true, workspace: fmt(rec) });
    }

    if (action === 'update' || action === 'archive') {
      const rec = await findOwned(memberId, body.id);
      if (!rec) return res.status(404).json({ error: 'Client not found' });
      let fields;
      if (action === 'archive') fields = { Archived: true };
      else {
        fields = {};
        if (body.name !== undefined) { const n = cleanName(body.name); if (!n) return res.status(400).json({ error: 'Give the client a name.' }); fields.ClientName = n; }
        if (body.logoUrl !== undefined) fields.LogoUrl = cleanLogo(body.logoUrl);
        if (body.brandColour !== undefined) fields.BrandColour = cleanColour(body.brandColour);
      }
      const r = await atFetch(`${base()}/${rec.id}`, { method: 'PATCH', headers: hdrs(), body: JSON.stringify({ fields }) });
      if (!r.ok) return res.status(502).json({ error: 'Could not save the change. Try again.' });
      if (action === 'archive') forgetWorkspace(memberId, body.id);
      return res.json({ success: true, workspace: fmt(await r.json()) });
    }

    return res.status(400).json({ error: 'Use ?action=list|current|create|update|archive' });
  } catch (e) {
    console.error('workspaces.js error:', e);
    return res.status(500).json({ error: 'Could not load your clients' });
  }
}
