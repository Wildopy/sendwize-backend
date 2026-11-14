// ─────────────────────────────────────────────────────────────
// SENDWIZE — supplier.js v1.0 (Nov 2026)
// The human side of the Third-party register for marketing third parties
// (email and SMS platforms, agencies, affiliates, creators, lead
// generators, list providers): who owns each one, when it is next
// reviewed, when the contract renews, the signed contracts, and a dated
// log of the checks the team has done. Nothing here is AI.
//
// Member actions (signed in):
//   POST ?action=upkeep     { kind, recordId, owner, nextReview, renewal }
//   POST ?action=contract   { kind, recordId, filename, contentType, data (base64) }
//   POST ?action=log        { kind, recordId, what, note, by }   → adds a dated check to the log
//   GET  ?action=due                                           → reviews and renewals due
//   GET  ?action=export                                        → every register row for the auditor export
//
// kind: processors | partners | affiliates
//
// Airtable fields (add to Vendor_Register, Partner_Register and
// Affiliate_Register; each is skipped if missing, nothing breaks):
//   Owner (single line text), NextReviewDate (date), ContractRenewalDate
//   (date), Contracts (attachment), CheckLogJson (long text)
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';
import { requireAuth, CORS_HEADERS, isRecordId } from './_auth.js';
import { memberEmail } from './_email.js';
import { KINDS, dueItems } from './_suppliers.js';
export { KINDS, dueItems };

const MAX_FILE = 3 * 1024 * 1024; // Vercel caps a request at 4.5 MB, and base64 adds a third
const DAY = 86400000;

// What a check in the log can be about (marketing third parties only)
export const CHECK_TYPES = {
  agreement: 'Agreement checked',
  consent_wording: 'Consent wording checked',
  creative: 'Ads or creative reviewed',
  ad_label: 'Ad labels checked',
  sender: 'Sender name and details checked',
  landing_page: 'Landing page checked',
  list_source: 'List source checked',
  suppression: 'Opt-outs passed on',
  other: 'Other check',
};

const H = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });
const BASE = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const parse = (s, fb) => { try { return JSON.parse(s || ''); } catch { return fb; } };
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function getRecord(kind, id) {
  const k = KINDS[kind];
  if (!k || !isRecordId(id)) return null;
  const r = await atFetch(`${BASE()}/${k.table}/${id}`, { headers: H() });
  return r.ok ? r.json() : null;
}
async function owned(kind, id, userId) {
  const rec = await getRecord(kind, id);
  return rec && rec.fields?.UserID === userId ? rec : null;
}

// Patch, dropping any field Airtable doesn't know yet (422 UNKNOWN_FIELD_NAME), one at a time.
async function patchOptional(kind, id, fields) {
  let f = { ...fields };
  for (let i = 0; i < 8 && Object.keys(f).length; i++) {
    const r = await atFetch(`${BASE()}/${KINDS[kind].table}/${id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ fields: f, typecast: true }) });
    if (r.ok) return { ok: true, record: await r.json(), dropped: Object.keys(fields).filter(k => !(k in f)) };
    const body = await r.json().catch(() => ({}));
    const m = String(body?.error?.message || '').match(/Unknown field name: "([^"]+)"/);
    if (r.status !== 422 || !m || !(m[1] in f)) return { ok: false, status: r.status, error: body?.error?.message };
    delete f[m[1]];
  }
  return { ok: false, status: 422, error: 'None of the fields exist yet', dropped: Object.keys(fields) };
}

async function companyName(userId) {
  const m = await memberEmail(userId).catch(() => null);
  if (m?.name) return { name: m.name, email: m.email };
  const dom = m?.email ? m.email.split('@')[1] : '';
  return { name: dom && !/gmail|outlook|hotmail|yahoo|icloud/i.test(dom) ? dom : 'Your customer', email: m?.email || null };
}


async function listAll(userId) {
  const out = {};
  await Promise.all(Object.entries(KINDS).map(async ([kind, k]) => {
    const r = await atFetch(`${BASE()}/${k.table}?filterByFormula=${encodeURIComponent(`{UserID}='${esc(userId)}'`)}&maxRecords=200`, { headers: H() });
    out[kind] = r.ok ? (await r.json()).records || [] : [];
  }));
  return out;
}

// ── Member actions ───────────────────────────────────────────
async function handleUpkeep(req, res) {
  const { userId, kind, recordId, owner, nextReview, renewal } = req.body ?? {};
  const rec = await owned(kind, recordId, userId);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  if ((nextReview && !isDate(nextReview)) || (renewal && !isDate(renewal))) return res.status(400).json({ error: 'Dates should be YYYY-MM-DD' });
  const fields = { Owner: String(owner || '').slice(0, 100), NextReviewDate: nextReview || null, ContractRenewalDate: renewal || null };
  const r = await patchOptional(kind, recordId, fields);
  if (!r.ok) return res.status(500).json({ error: 'Not set up yet: add the Owner, NextReviewDate and ContractRenewalDate fields to the register tables in Airtable.' });
  return res.json({ success: true, fields: r.record.fields, missingFields: r.dropped });
}

async function handleContract(req, res) {
  const { userId, kind, recordId, filename, contentType, data } = req.body ?? {};
  const rec = await owned(kind, recordId, userId);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'Choose a file' });
  const bytes = Math.floor(data.length * 3 / 4);
  if (bytes > MAX_FILE) return res.status(413).json({ error: 'Files can be up to 3 MB. Save the PDF at a smaller size, or upload the signed pages only.' });
  const type = /^(application\/pdf|image\/(png|jpeg)|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/msword)$/.test(contentType || '') ? contentType : null;
  if (!type) return res.status(400).json({ error: 'Upload a PDF, Word document or image' });
  const name = String(filename || 'contract').replace(/[^\w .()-]/g, '_').slice(0, 120);
  // Airtable's direct upload: no separate file storage needed
  const r = await fetch(`https://content.airtable.com/v0/${process.env.BASE_ID}/${recordId}/Contracts/uploadAttachment`, {
    method: 'POST', headers: H(), body: JSON.stringify({ contentType: type, file: data, filename: name }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    console.error('Contract upload failed:', r.status, JSON.stringify(b).slice(0, 300));
    return res.status(r.status === 422 || r.status === 404 ? 500 : 502).json({ error: r.status === 422 || r.status === 404 ? 'Not set up yet: add an attachment field called Contracts to the register tables in Airtable.' : 'The upload failed. Please try again.' });
  }
  const after = await getRecord(kind, recordId);
  return res.json({ success: true, contracts: (after?.fields?.Contracts || []).map(a => ({ id: a.id, filename: a.filename, url: a.url, size: a.size })) });
}

async function handleLog(req, res) {
  const { userId, kind, recordId, what, note, by } = req.body ?? {};
  const rec = await owned(kind, recordId, userId);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  if (!CHECK_TYPES[what]) return res.status(400).json({ error: 'Choose what you checked' });
  const log = parse(rec.fields.CheckLogJson, []);
  const entry = { at: new Date().toISOString(), what, label: CHECK_TYPES[what], note: String(note || '').trim().slice(0, 1000), by: String(by || '').trim().slice(0, 80) };
  const next = [entry, ...(Array.isArray(log) ? log : [])].slice(0, 100);
  // A logged check also counts as the record being checked today
  const r = await patchOptional(kind, recordId, { CheckLogJson: JSON.stringify(next), LastChecked: entry.at.slice(0, 10) });
  if (!r.ok || r.dropped.includes('CheckLogJson')) return res.status(500).json({ error: 'Not set up yet: add the CheckLogJson field to the register tables in Airtable.' });
  return res.json({ success: true, log: next, fields: r.record.fields });
}

async function handleDue(req, res) {
  const userId = req.query.userId;
  const all = await listAll(userId);
  const items = Object.entries(all).flatMap(([kind, recs]) => recs.flatMap(r => dueItems(kind, r))).sort((a, b) => a.days - b.days);
  return res.json({ items });
}

async function handleExport(req, res) {
  const userId = req.query.userId;
  const all = await listAll(userId);
  const co = await companyName(userId);
  const row = (kind, r) => {
    const f = r.fields || {};
    return {
      kind, name: f[KINDS[kind].name] || '', type: f.VendorType || f.Category || f.PartnerType || f.AffiliateType || '',
      owner: f.Owner || '', nextReview: f.NextReviewDate || '', renewal: f.ContractRenewalDate || '',
      agreement: f.DPAStatus || f.AgreementStatus || f.Article26Status || f.DataAgreementStatus || 'Not recorded',
      consentChain: kind === 'processors' ? null : !!f.ConsentChainVerified,
      lastChecked: f.LastChecked || f.LastAutoChecked || '',
      contracts: (f.Contracts || []).map(a => a.filename),
      checks: (parse(f.CheckLogJson, []) || []).slice(0, 20),
      notes: f.Notes || '',
    };
  };
  return res.json({ company: co.name, generatedAt: new Date().toISOString(), rows: Object.entries(all).flatMap(([kind, recs]) => recs.map(r => row(kind, r))) });
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
    if (req.method === 'POST' && action === 'upkeep')     return await handleUpkeep(req, res);
    if (req.method === 'POST' && action === 'contract')   return await handleContract(req, res);
    if (req.method === 'POST' && action === 'log')        return await handleLog(req, res);
    if (req.method === 'GET'  && action === 'due')        return await handleDue(req, res);
    if (req.method === 'GET'  && action === 'export')     return await handleExport(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('supplier error:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
