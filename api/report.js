// ─────────────────────────────────────────────────────────────
// SENDWIZE — report.js v1.0
// The audit log behind the monthly report (public/report.html): every
// finding raised, fixed or dismissed, every send-day verdict, copy check,
// site sweep, list check and campaign approval, newest first, read
// straight from the records each tool already keeps.
//
//   GET ?action=audit                 JSON { events: [...] }
//   GET ?action=audit&format=csv      the same as a CSV download
//   optional &from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Each source is best effort: a table that is missing or fails is left
// out and named in `skipped`, so one problem never empties the log.
// Works inside a client workspace like every other endpoint.
// ─────────────────────────────────────────────────────────────
import { atFetch, fq } from './_airtable.js';
import { requireAuth, CORS_HEADERS } from './_auth.js';

const MAX_PER_SOURCE = 500;

async function rows(table, userId) {
  const out = [];
  let offset = '';
  do {
    const url = `https://api.airtable.com/v0/${process.env.BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(`{UserID}=${fq(userId)}`)}&pageSize=100${offset ? `&offset=${offset}` : ''}`;
    const r = await atFetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (!r.ok) throw new Error(`${table}: Airtable ${r.status}`);
    const d = await r.json();
    out.push(...(d.records || []));
    offset = d.offset || '';
  } while (offset && out.length < MAX_PER_SOURCE);
  return out;
}

const day = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const nice = s => { s = String(s || '').replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const DISMISS = { not_applicable: 'not applicable to the business', false_positive: 'Sendwize got it wrong', accepted_risk: 'risk accepted (still counted as open)' };
const DONE_BY = { improved_on_rerun: 'confirmed by re-running the check', verified: 'confirmed by re-running the check', manual: 'marked fixed by hand' };

// One source = a table and how its rows become events
const SOURCES = {
  fixes: { table: 'Compliance_Fixes', events: r => {
    const f = r.fields, what = nice(f.FixType), sev = f.Severity ? ` (${f.Severity})` : '', ev = [];
    const detail = String(f.Description || '').slice(0, 300);
    ev.push({ date: day(f.CreatedDate) || day(r.createdTime), area: f.Tool || 'Finding', event: 'Finding raised', item: what + sev, detail });
    if (f.Status === 'completed') ev.push({ date: day(f.CompletedDate), area: f.Tool || 'Finding', event: 'Finding fixed', item: what + sev, detail: DONE_BY[f.CompletionSource] || 'marked fixed' });
    if (f.Status === 'dismissed') ev.push({ date: day(f.DismissedDate), area: f.Tool || 'Finding', event: 'Finding dismissed', item: what + sev, detail: DISMISS[f.DismissReason] || 'no reason given' });
    return ev;
  } },
  verdicts: { table: 'Send_Verdicts', events: r => [{ date: day(r.fields.CreatedAt), area: 'Send-day verdict', event: 'Verdict: ' + (r.fields.Verdict || 'recorded'),
    item: r.fields.CampaignName || 'Campaign', detail: [r.fields.Channel, r.fields.ListName, r.fields.Fingerprint ? 'fingerprint ' + String(r.fields.Fingerprint).slice(0, 12) : ''].filter(Boolean).join(' · ') }] },
  copy: { table: 'AI_Compliance_Checks', events: r => [{ date: day(r.fields.CheckDate), area: 'Copy checker', event: 'Copy checked',
    item: r.fields.FileName || 'Copy check', detail: [r.fields.Verdict, r.fields.CriticalIssues != null ? `${r.fields.CriticalIssues} critical, ${r.fields.Warnings || 0} warnings` : ''].filter(Boolean).join(' · ') }] },
  sweeps: { table: 'Site_Sweeps', events: r => r.fields.LastSweptAt ? [{ date: day(r.fields.LastSweptAt), area: 'Site sweep', event: 'Website swept',
    item: r.fields.Domain || 'Website', detail: r.fields.RunCount ? `${r.fields.RunCount} sweep${r.fields.RunCount === 1 ? '' : 's'} so far` : '' }] : [] },
  lists: { table: 'List_Intelligence_Checks', events: r => [{ date: day(r.fields.CheckDate), area: 'List health', event: 'Contact list checked',
    item: r.fields.ListName || 'Contact list', detail: [r.fields.TotalContacts ? `${Number(r.fields.TotalContacts).toLocaleString('en-GB')} contacts` : '', r.fields.LiabilityCount ? `${r.fields.LiabilityCount} below the consent threshold` : ''].filter(Boolean).join(' · ') }] },
  campaigns: { table: 'Campaign_Dossiers', events: r => {
    const f = r.fields, ev = [];
    if (f.CreatedDate) ev.push({ date: day(f.CreatedDate), area: 'Campaign defence', event: 'Campaign record opened', item: f.CampaignTitle || 'Campaign', detail: f.OwnerName ? 'owner ' + f.OwnerName : '' });
    if (f.ApprovedAt) ev.push({ date: day(f.ApprovedAt), area: 'Campaign defence', event: 'Campaign approved', item: f.CampaignTitle || 'Campaign', detail: f.ApprovedBy ? 'approved by ' + f.ApprovedBy : '' });
    return ev;
  } },
};

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

export async function auditLog(userId, { from = '', to = '' } = {}) {
  const keys = Object.keys(SOURCES), skipped = [];
  const results = await Promise.all(keys.map(k => rows(SOURCES[k].table, userId).catch(e => { skipped.push(SOURCES[k].table); console.warn('[report]', e.message); return []; })));
  const events = [];
  results.forEach((recs, i) => recs.forEach(r => { for (const e of SOURCES[keys[i]].events(r)) events.push(e); }));
  const inRange = e => (!from || (e.date && e.date >= from)) && (!to || (e.date && e.date <= to));
  return {
    events: events.filter(inRange).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    skipped,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (req.query.action !== 'audit') return res.status(400).json({ error: 'Use ?action=audit' });
    const okDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    const log = await auditLog(userId, { from: okDate(req.query.from), to: okDate(req.query.to) });
    if (req.query.format === 'csv') {
      const head = ['Date', 'Area', 'Event', 'Item', 'Detail'];
      const body = log.events.map(e => [e.date || 'not recorded', e.area, e.event, e.item, e.detail].map(csvCell).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sendwize-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send('﻿' + [head.join(','), ...body].join('\r\n'));
    }
    return res.json({ success: true, generatedAt: new Date().toISOString(), ...log });
  } catch (e) {
    console.error('report.js error:', e);
    return res.status(500).json({ error: 'Could not build the audit log' });
  }
}
