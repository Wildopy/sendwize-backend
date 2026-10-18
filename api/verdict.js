// ─────────────────────────────────────────────────────────────
// SENDWIZE — verdict.js v1.0
// Send-day verdict: one answer before a campaign goes out.
//
// POST /api/verdict   { userId, copy, subject?, channel?, urls?[], listName?, sendingContext? }
// GET  /api/verdict?action=list&userId=…   recent verdicts
//
// Combines three checks into Go / Fix first / Hold:
//   1. The copy (analyze-copy: deterministic rules first, AI reads the copy)
//   2. The landing pages (shared page scanner, rules first)
//   3. The list (latest List Intelligence check + open data findings)
// The verdict itself is pure rules over those results, so the same
// inputs always give the same answer. Each verdict gets a fingerprint
// (sha256 of the inputs and result) and is saved to Send_Verdicts as
// evidence of the pre-send check.
//
// Airtable: new table Send_Verdicts (see the review doc). If it is
// missing, the verdict is still returned with saved:false.
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { atFetch, fq } from './_airtable.js';
import { requireAuth, internalHeaders, isRecordId, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import { scanCampaignPages, isSafePublicUrl } from './_page-scan.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const VERSION = 'verdict-1.0';
const LIST_STALE_DAYS = 90;
const CHANNELS = ['email', 'sms', 'push', 'social', 'directmail'];
// Open findings that stop a send outright
const HOLD_FIX_TYPES = ['suppression_breach', 'third_party_list', 'consent_missing', 'invalid_consent_mechanism', 'lead_gen_consent_gap', 'concealed_sender'];
const NOTICE = 'A pre-send check based on rules and published guidance. Not legal advice.';

const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const atH  = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });
const sev  = s => String(s || '').toLowerCase();

async function atList(table, formula, extra = '', max = 10) {
  const r = await atFetch(`${base()}/${table}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${max}${extra ? '&' + extra : ''}`, { headers: atH() });
  if (!r.ok) return null;
  return (await r.json()).records || [];
}

// ── 1. Copy ──
async function checkCopy({ userId, copy, subject, channel, sendingContext }) {
  const r = await fetch(`${APP_URL}/api/analyze-copy`, {
    method: 'POST', headers: internalHeaders(),
    body: JSON.stringify({ userId, contentType: channel, content: copy, subject: subject || undefined, sendingContext: sendingContext || undefined }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: d.error || `Copy check failed (${r.status})` };
  // analyze-copy returns a placeholder (score 50, no issues) when it can't read the AI's answer.
  // Treat that as a failed check, never as clean copy.
  if (d.verdict === 'Analysis Error') return { ok: false, error: 'the AI answer could not be read' };
  return {
    ok: true, score: d.score ?? null, checkId: d.sourceRecordId || null,
    issues: (d.violations || []).map(v => ({ severity: sev(v.severity) || 'medium', regulation: v.regulation || '', issue: v.issue || '', recommendation: v.recommendation || '' })),
  };
}

// ── 2. Pages ──
async function checkPages(urls, userId) {
  if (!urls.length) return { ok: true, skipped: true, findings: [], pages: [] };
  const scan = await scanCampaignPages(urls.map(url => ({ url, type: 'landing_page' })), { userId });
  const findings = [];
  for (const p of scan.pages || []) for (const f of (p.findings || [])) findings.push({ url: p.url, severity: sev(f.severity), regulator: f.regulator || '', title: f.title || '', detail: f.detail || '' });
  return { ok: true, findings, pages: (scan.pages || []).map(p => ({ url: p.url, verdict: p.verdict, error: p.error || null })) };
}

// ── 3. List + open findings ──
async function checkList(userId, listName) {
  // Older checks have no ListName and show as "Main list" in List health
  const nameF = listName === 'Main list' ? `OR({ListName}=${fq(listName)},{ListName}='')` : `{ListName}=${fq(listName)}`;
  const f = listName ? `AND({UserID}=${fq(userId)},${nameF})` : `{UserID}=${fq(userId)}`;
  const [checks, fixes] = await Promise.all([
    atList('List_Intelligence_Checks', f, 'sort[0][field]=CheckDate&sort[0][direction]=desc', 1),
    atList('Compliance_Fixes', `AND({UserID}=${fq(userId)},{Status}='pending',OR(${HOLD_FIX_TYPES.map(t => `LOWER({FixType})='${t}'`).join(',')}))`, '', 20),
  ]);
  const c = checks?.[0]?.fields || null;
  return {
    ok: checks !== null,
    found: !!c,
    listName: c?.ListName || listName || null,
    checkDate: c?.CheckDate || null,
    ageDays: c?.CheckDate ? Math.floor((Date.now() - new Date(c.CheckDate)) / 86400000) : null,
    totalContacts: c?.TotalContacts ?? null,
    liabilityCount: c?.LiabilityCount ?? 0,
    liabilityPct: Number(c?.LiabilityPct) || 0,
    expiring30: c?.Expiring30 ?? 0,
    blockingFixes: (fixes || []).map(r => ({ id: r.id, fixType: (r.fields.FixType || '').toLowerCase(), description: r.fields.Description || '' })),
  };
}

// ── Rules: the verdict ──
export function decide({ channel, copy, pages, list }) {
  const hold = [], fix = [], ok = [];
  const needsConsent = channel === 'email' || channel === 'sms';

  if (!copy.ok) fix.push({ area: 'copy', text: `The copy could not be checked: ${copy.error}. Run it again before sending.` });
  else {
    const crit = copy.issues.filter(i => i.severity === 'critical');
    const high = copy.issues.filter(i => i.severity === 'high' || i.severity === 'medium');
    crit.forEach(i => hold.push({ area: 'copy', text: i.issue, action: i.recommendation, ref: i.regulation }));
    high.forEach(i => fix.push({ area: 'copy', text: i.issue, action: i.recommendation, ref: i.regulation }));
    if (!crit.length && !high.length) ok.push({ area: 'copy', text: `Copy check found no potential areas requiring review${copy.score != null ? ` (score ${copy.score})` : ''}.` });
  }

  if (pages.skipped) ok.push({ area: 'pages', text: 'No landing pages given, so none were checked.' });
  else {
    const high = pages.findings.filter(f => f.severity === 'high');
    const med  = pages.findings.filter(f => f.severity === 'medium');
    high.filter(f => f.regulator === 'ICO').forEach(f => hold.push({ area: 'pages', text: f.title, action: f.detail, ref: f.url }));
    high.filter(f => f.regulator !== 'ICO').concat(med).forEach(f => fix.push({ area: 'pages', text: f.title, action: f.detail, ref: f.url }));
    const errs = pages.pages.filter(p => p.verdict === 'error');
    errs.forEach(p => fix.push({ area: 'pages', text: `Could not open ${p.url}${p.error ? ` (${p.error})` : ''}.`, action: 'Check the link works before sending.' }));
    if (!high.length && !med.length && !errs.length) ok.push({ area: 'pages', text: `${pages.pages.length} page${pages.pages.length === 1 ? '' : 's'} checked with nothing to review.` });
  }

  if (!list.ok) fix.push({ area: 'list', text: 'Your list check could not be loaded.', action: 'Try again in a minute.' });
  else {
    list.blockingFixes.forEach(f => hold.push({ area: 'list', text: f.description || f.fixType.replace(/_/g, ' '), action: 'Resolve this open finding, or suppress the affected contacts, before sending.' }));
    if (needsConsent && !list.found) fix.push({ area: 'list', text: list.listName ? `No list check on file for "${list.listName}".` : 'No list check on file.', action: 'Upload the send list to List health so consent and suppression are checked.' });
    if (list.found) {
      if (list.liabilityPct > 0.05) hold.push({ area: 'list', text: `${Number(list.liabilityCount).toLocaleString('en-GB')} contacts (${Math.round(list.liabilityPct * 100)}%) are below the consent threshold.`, action: 'Suppress these contacts before sending.' });
      else if (list.liabilityCount > 0) fix.push({ area: 'list', text: `${Number(list.liabilityCount).toLocaleString('en-GB')} contacts are below the consent threshold.`, action: 'Suppress these contacts before sending.' });
      if (list.ageDays != null && list.ageDays > LIST_STALE_DAYS) fix.push({ area: 'list', text: `The last list check is ${list.ageDays} days old.`, action: 'Re-upload the list so the check reflects who you are sending to.' });
      if (!list.liabilityCount && (list.ageDays == null || list.ageDays <= LIST_STALE_DAYS) && !list.blockingFixes.length) ok.push({ area: 'list', text: `List check from ${list.checkDate} shows no contacts below the consent threshold.` });
    }
  }

  const verdict = hold.length ? 'hold' : fix.length ? 'fix_first' : 'go';
  return { verdict, ...describe(verdict, hold, fix), hold, fix, ok };
}

const LABELS = { hold: 'Hold', fix_first: 'Fix first', go: 'Go' };
function describe(verdict, hold, fix) {
  const headline = verdict === 'hold'
    ? `Hold this send. ${hold.length} item${hold.length === 1 ? '' : 's'} could put the campaign at risk.`
    : verdict === 'fix_first'
      ? `Fix ${fix.length} item${fix.length === 1 ? '' : 's'} first, then send.`
      : 'Good to send. Nothing found that needs review.';
  return { label: LABELS[verdict], headline };
}

const fingerprint = obj => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    if (req.method === 'GET' && req.query.action === 'list') {
      const recs = await atList('Send_Verdicts', `{UserID}=${fq(userId)}`, 'sort[0][field]=CreatedAt&sort[0][direction]=desc', 20);
      return res.json({ success: true, verdicts: (recs || []).map(r => ({ id: r.id, createdAt: r.fields.CreatedAt, verdict: r.fields.Verdict, campaign: r.fields.CampaignName || '', channel: r.fields.Channel || '', fingerprint: r.fields.Fingerprint || '' })) });
    }
    // Reopen a saved verdict exactly as it was recorded
    if (req.method === 'GET' && req.query.action === 'get') {
      const id = String(req.query.id || '');
      if (!isRecordId(id)) return res.status(400).json({ error: 'Valid id required' });
      const r = await atFetch(`${base()}/Send_Verdicts/${id}`, { headers: atH() });
      if (!r.ok) return res.status(404).json({ error: 'Verdict not found' });
      const f = (await r.json()).fields || {};
      if (f.UserID !== userId) return res.status(404).json({ error: 'Verdict not found' });
      let reasons = {}; try { reasons = JSON.parse(f.ReasonsJson || '{}'); } catch {}
      const hold = reasons.hold || [], fix = reasons.fix || [], ok = reasons.ok || [];
      const verdict = Object.keys(LABELS).find(k => LABELS[k] === f.Verdict) || (hold.length ? 'hold' : fix.length ? 'fix_first' : 'go');
      return res.json({
        success: true, verdict, ...describe(verdict, hold, fix), hold, fix, ok,
        verdictId: id, saved: true, fingerprint: f.Fingerprint || '', createdAt: f.CreatedAt,
        campaign: f.CampaignName || '', channel: f.Channel || '', listName: f.ListName || '', urls: (f.Urls || '').split('\n').filter(Boolean),
        notice: NOTICE, reopened: true,
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST to run a verdict, or GET ?action=list|get' });
    if (!(await checkLimit(req, res, auth, 'verdict'))) return;

    const b = req.body || {};
    const copy = String(b.copy || '').trim();
    if (copy.length < 20) return res.status(400).json({ error: 'Paste the campaign copy (at least a sentence).' });
    if (copy.length > 20000) return res.status(400).json({ error: 'Copy is too long. Keep it under 20,000 characters.' });
    const channel = CHANNELS.includes(b.channel) ? b.channel : 'email';
    const urls = [...new Set((Array.isArray(b.urls) ? b.urls : []).map(u => String(u).trim()).filter(Boolean))].slice(0, 4);
    const badUrl = urls.find(u => !isSafePublicUrl(u));
    if (badUrl) return res.status(400).json({ error: `That page address can't be checked: ${badUrl}` });
    const listName = b.listName ? String(b.listName).slice(0, 120) : '';
    const subject = b.subject ? String(b.subject).slice(0, 300) : '';
    const campaign = b.campaignName ? String(b.campaignName).slice(0, 120) : subject || 'Untitled campaign';

    const [copyR, pagesR, listR] = await Promise.all([
      checkCopy({ userId, copy, subject, channel, sendingContext: b.sendingContext }).catch(e => ({ ok: false, error: e.message })),
      checkPages(urls, userId).catch(e => ({ ok: true, findings: [], pages: urls.map(url => ({ url, verdict: 'error', error: e.message })) })),
      checkList(userId, listName).catch(() => ({ ok: false, blockingFixes: [] })),
    ]);
    const result = decide({ channel, copy: copyR, pages: pagesR, list: listR });
    const createdAt = new Date().toISOString();
    const inputs = { copy, subject, channel, urls, listName };
    const fp = fingerprint({ v: VERSION, inputs, verdict: result.verdict, hold: result.hold, fix: result.fix, createdAt });

    let saved = false, verdictId = null;
    try {
      const r = await atFetch(`${base()}/Send_Verdicts`, {
        method: 'POST', headers: atH(),
        body: JSON.stringify({ fields: {
          UserID: userId, CreatedAt: createdAt, Verdict: result.label, CampaignName: campaign, Channel: channel,
          ListName: listR.listName || listName || '', Urls: urls.join('\n'), CopyCheckId: copyR.checkId || '',
          ReasonsJson: JSON.stringify({ hold: result.hold, fix: result.fix, ok: result.ok }).slice(0, 95000),
          InputHash: fingerprint({ v: VERSION, inputs }), Fingerprint: fp,
        } }),
      });
      if (r.ok) { saved = true; verdictId = (await r.json()).id; }
      else console.warn('Send_Verdicts save failed', r.status);
    } catch (e) { console.warn('Send_Verdicts save error', e.message); }

    return res.json({
      success: true, ...result, verdictId, saved, fingerprint: fp, createdAt, version: VERSION,
      checks: {
        copy: copyR.ok ? { score: copyR.score, issues: copyR.issues.length, checkId: copyR.checkId } : { error: copyR.error },
        pages: pagesR.skipped ? null : { scanned: pagesR.pages.length, findings: pagesR.findings.length },
        list: listR.found ? { listName: listR.listName, checkDate: listR.checkDate, totalContacts: listR.totalContacts } : null,
      },
      notice: NOTICE,
    });
  } catch (e) {
    console.error('verdict.js error:', e);
    return res.status(500).json({ error: 'Could not run the send-day verdict' });
  }
}
