// ─────────────────────────────────────────────────────────────
// SENDWIZE — third-parties.js v1.0
// The Third parties page (public/vendor-checker.html), risk first.
//
// GET  ?action=load           Everything the page shows. First adds the
//                             third parties Sendwize can see for itself
//                             (clear matches only, see _third-parties.js):
//                             Site Sweep trackers → Platforms, named List
//                             health sources → Lead & data partners or
//                             Affiliates. Then gives every one a verdict
//                             (Keep / Fix this / Stop using), its risks,
//                             a £ figure and the best next action.
// POST ?action=hide           { type, recordId } A found third party the
//                             member does not use. Kept, marked hidden,
//                             so it is never added again.
// POST ?action=answer         { recordId, key, value } Member's answer to
//                             a platform question (own use, where held).
// POST ?action=live-pages     { recordId, urls } Affiliate / influencer
//                             posts to watch. Checked now and monthly.
// POST ?action=live-text      { recordId, url, text } Paste a caption
//                             when a page can't be read automatically.
// GET  ?action=recheck        Cron, monthly: re-checks every watched
//                             affiliate post for an ad label and claims.
//
// Tables: Vendor_Register, Partner_Register, Affiliate_Register (no new
// fields: answers live in MarketingChecksJson.answers, watched posts in
// Affiliate_Register.VerificationUrls), Site_Sweeps,
// List_Intelligence_Checks, Marketing_Vendors, User_Profile.
// Not legal advice.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';
import { requireAuth, internalHeaders, isRecordId, CORS_HEADERS } from './_auth.js';
import { fetchPage, htmlToText } from './_page-scan.js';
import { profileContext, profileGaps } from './_exposure.js';
import { trackerMatchesVendor, sweepTrackers } from './_processor-rules.js';
import {
  FOUND_PREFIX, HIDDEN_PREFIX, isHidden, sourceParty, sourceMatchesName, sweepParties, performanceFor,
  assessPlatform, assessPartner, assessAffiliate, checkPostText,
} from './_third-parties.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const TABLES = { platform: 'Vendor_Register', partner: 'Partner_Register', affiliate: 'Affiliate_Register' };
const NAME   = { platform: 'VendorName', partner: 'PartnerName', affiliate: 'AffiliateName' };
const MAX_ADDS_PER_LOAD = 8;
const MIN_SOURCE_CONTACTS = 20;
const RECHECK_DAYS = 28;

// ── Airtable ──────────────────────────────────────────────────
const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const H = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const today = () => new Date().toISOString().split('T')[0];
const safeJSON = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

async function list(table, formula, { sort = '', max = 100 } = {}) {
  let url = `${base()}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort) url += `&sort[0][field]=${sort}&sort[0][direction]=desc`;
  const r = await atFetch(url, { headers: H() });
  if (!r.ok) throw new Error(`Airtable ${table}: ${r.status}`);
  return (await r.json()).records || [];
}
async function getOne(table, id) {
  const r = await atFetch(`${base()}/${encodeURIComponent(table)}/${id}`, { headers: H() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Airtable ${table}: ${r.status}`);
  return r.json();
}
async function create(table, fields) {
  const r = await atFetch(`${base()}/${encodeURIComponent(table)}`, { method: 'POST', headers: H(), body: JSON.stringify({ records: [{ fields: clean(fields) }] }) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable create ${table}: ${r.status}`); }
  return (await r.json()).records?.[0];
}
async function patch(table, id, fields) {
  const r = await atFetch(`${base()}/${encodeURIComponent(table)}/${id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ fields: clean(fields) }) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable update ${table}: ${r.status}`); }
  return r.json();
}

// ── What Sendwize already knows ───────────────────────────────
async function latestSweep(userId) {
  const recs = await list('Site_Sweeps', `{UserID}='${esc(userId)}'`, { sort: 'LastSweptAt', max: 5 }).catch(() => []);
  for (const r of recs) {
    const sw = safeJSON(r.fields.SweepJson, null);
    if (!sw) continue;
    const trackers = Array.isArray(sw.trackers) ? sw.trackers : sweepTrackers({ seenInSource: sw.thirdParties || [] });
    return { domain: r.fields.Domain || sw.domain, sweptAt: String(sw.completedAt || r.fields.LastSweptAt || '').split('T')[0], trackers };
  }
  return null;
}

// Latest check of each list, with its sources (List health → provenance)
async function latestLists(userId) {
  const recs = await list('List_Intelligence_Checks', `{UserID}='${esc(userId)}'`, { sort: 'CheckDate', max: 30 }).catch(() => []);
  const seen = new Set(), out = [];
  for (const r of recs) {
    const name = r.fields.ListName || 'Your list';
    if (seen.has(name)) continue;
    seen.add(name);
    const res = safeJSON(r.fields.Results, {});
    const prov = res.insights?.provenance;
    out.push({ listName: name, checkDate: r.fields.CheckDate || null, sources: prov?.available ? (prov.sources || []) : [] });
  }
  return out;
}

async function knownVendor(name) {
  const recs = await list('Marketing_Vendors', `FIND('${esc(name.toLowerCase())}',LOWER({VendorName}))`, { max: 1 }).catch(() => []);
  return recs[0]?.fields || null;
}

const PLATFORM_TYPE = { analytics: 'Analytics', advertising: 'Advertising', esp: 'Email Service Provider' };

// Add the clear matches that are not in the register yet.
async function discover(userId, regs, sweep, lists) {
  const added = [];
  const allNames = type => regs[type].map(r => r.fields[NAME[type]] || '');

  // 1. Site Sweep trackers → Platforms
  for (const t of sweepParties(sweep)) {
    if (added.length >= MAX_ADDS_PER_LOAD) break;
    if (regs.platform.some(r => trackerMatchesVendor(t, r.fields.VendorName))) continue;
    const k = await knownVendor(t.vendor);
    const fields = {
      UserID: userId, VendorName: t.vendor, VendorType: PLATFORM_TYPE[t.category] || 'Analytics', Category: t.category,
      DPAStatus: 'Not yet', TransferDestination: k?.TransferDestination, PrivacyPolicyUrl: k?.PrivacyPolicyUrl,
      IntelligenceJson: k ? JSON.stringify({ source: 'sendwize_curated', transferMechanism: k.TransferMechanism || k.TransferMechanismConfirmed || null, transferDestination: k.TransferDestination || null, findings: [] }) : undefined,
      Notes: `${FOUND_PREFIX}: Site Sweep found ${t.detectedAs.join(', ')} on ${sweep.domain || 'your website'} (${sweep.sweptAt || today()}).`,
      LastChecked: today(),
    };
    try {
      const rec = await create(TABLES.platform, fields);
      regs.platform.push(rec);
      added.push({ type: 'platform', name: t.vendor, from: 'Site Sweep' });
    } catch (e) { console.error('third-parties: add platform failed', t.vendor, e.message); }
  }

  // 2. Named List health sources → Lead & data partners / Affiliates
  for (const l of lists) {
    for (const s of l.sources || []) {
      if (added.length >= MAX_ADDS_PER_LOAD) break;
      if ((s.count || 0) < MIN_SOURCE_CONTACTS) continue;
      const p = sourceParty(s.source);
      if (!p) continue;
      const exists = ['partner', 'affiliate'].some(ty => allNames(ty).some(n => sourceMatchesName(s.source, n) || sourceMatchesName(n, p.name) || n.toLowerCase() === p.name.toLowerCase()));
      if (exists) continue;
      const note = `${FOUND_PREFIX}: List health source "${s.source}" on ${l.listName} (${(s.count || 0).toLocaleString('en-GB')} contacts, ${p.reason}).`;
      try {
        if (p.kind === 'partner') {
          const rec = await create(TABLES.partner, { UserID: userId, PartnerName: p.name, PartnerType: p.type, RelationshipActivity: 'lead_generation', DataRelationship: 'unknown', Article26Status: 'Not yet', ConsentChainVerified: false, Notes: note, AddedDate: today(), LastChecked: today() });
          regs.partner.push(rec);
        } else {
          const act = { 'Cashback Site': 'cashback', 'Voucher Site': 'voucher', 'Comparison Site': 'comparison', 'Publisher Network': 'publisher', 'Influencer': 'influencer' }[p.type] || 'email_affiliate';
          // Their contacts are on the member's list, so they collected sign-ups for them.
          const rec = await create(TABLES.affiliate, { UserID: userId, AffiliateName: p.name, AffiliateType: p.type, RelationshipActivity: act, AffiliateDataRole: 'lead_capture', DPAStatus: 'Not yet', ConsentChainVerified: false, SenderIdentityCompliant: 'Unverified', MarketingMaterialsReviewed: false, LandingPageReviewed: false, AdDisclosureCompliant: 'Unverified', Notes: note, LastChecked: today() });
          regs.affiliate.push(rec);
        }
        added.push({ type: p.kind, name: p.name, from: `List health (${s.source})` });
      } catch (e) { console.error('third-parties: add source failed', p.name, e.message); }
    }
  }

  // Let the register put Site Sweep's consent evidence on new platforms
  if (added.some(a => a.type === 'platform') && sweep) {
    try {
      await fetch(`${APP_URL}/api/data?action=sweep-trackers`, { method: 'POST', headers: internalHeaders(),
        body: JSON.stringify({ userId, domain: sweep.domain, sweptAt: sweep.sweptAt, trackers: sweep.trackers }), signal: AbortSignal.timeout(9000) });
      regs.platform = await list(TABLES.platform, `{UserID}='${esc(userId)}'`).catch(() => regs.platform);
    } catch (e) { console.error('third-parties: sweep evidence non-fatal', e.message); }
  }
  return added;
}

// ── LOAD ──────────────────────────────────────────────────────
async function handleLoad(req, res, userId) {
  const u = `{UserID}='${esc(userId)}'`;
  const [platform, partner, affiliate, profiles, sweep, lists] = await Promise.all([
    list(TABLES.platform, u).catch(() => []),
    list(TABLES.partner, u).catch(() => []),
    list(TABLES.affiliate, u).catch(() => []),
    list('User_Profile', u, { max: 1 }).catch(() => []),
    latestSweep(userId),
    latestLists(userId),
  ]);
  const regs = { platform, partner, affiliate };
  const added = req.query.discover === '0' ? [] : await discover(userId, regs, sweep, lists);

  const pf = profiles[0]?.fields || {};
  const ctx = profileContext(pf);
  const gaps = profileGaps(pf);
  const profile = { revenueBand: ctx.revenueBand, sector: ctx.sector };
  const out = r => ({ id: r.id, fields: r.fields });

  const platforms  = regs.platform.filter(r => !isHidden(r.fields)).map(r => ({ ...out(r), a: assessPlatform(r.fields, { profile }) }));
  const partners   = regs.partner.filter(r => !isHidden(r.fields)).map(r => ({ ...out(r), a: assessPartner(r.fields, { profile, performance: performanceFor(r.fields.PartnerName, lists) }) }));
  const affiliates = regs.affiliate.filter(r => !isHidden(r.fields)).map(r => ({ ...out(r), a: assessAffiliate(r.fields, { profile, performance: performanceFor(r.fields.AffiliateName, lists) }) }));

  const all = [...platforms, ...partners, ...affiliates];
  const order = { stop: 0, fix: 1, keep: 2 };
  const byRisk = (a, b) => order[a.a.verdict] - order[b.a.verdict] || b.a.exposure.likely - a.a.exposure.likely || a.a.rank - b.a.rank;
  [platforms, partners, affiliates].forEach(x => x.sort(byRisk));

  return res.json({
    platforms, partners, affiliates, added,
    sources: {
      sweep: sweep ? { domain: sweep.domain, sweptAt: sweep.sweptAt, trackers: sweep.trackers.length } : null,
      lists: lists.map(l => ({ listName: l.listName, checkDate: l.checkDate, sources: (l.sources || []).length })),
    },
    totals: {
      likely: all.reduce((s, x) => s + x.a.exposure.likely, 0),
      low: all.reduce((s, x) => s + x.a.exposure.low, 0),
      high: all.reduce((s, x) => s + x.a.exposure.high, 0),
      paperwork: all.reduce((s, x) => s + (x.a.paperwork.exposure?.likely || 0), 0),
      stop: all.filter(x => x.a.verdict === 'stop').length,
      fix: all.filter(x => x.a.verdict === 'fix').length,
      keep: all.filter(x => x.a.verdict === 'keep').length,
    },
    profile: { complete: !gaps.length, gaps, revenueBand: ctx.revenueBand, sector: ctx.sector },
    tradingName: pf.TradingName || '',
  });
}

// ── Owned record helper ───────────────────────────────────────
async function owned(type, recordId, userId, res) {
  const table = TABLES[type];
  if (!table) { res.status(400).json({ error: 'Unknown type' }); return null; }
  if (!isRecordId(recordId)) { res.status(400).json({ error: 'Invalid recordId' }); return null; }
  const rec = await getOne(table, recordId);
  if (!rec || rec.fields.UserID !== userId) { res.status(404).json({ error: 'Record not found' }); return null; }
  return rec;
}

// ── HIDE ──────────────────────────────────────────────────────
async function handleHide(req, res, userId) {
  const { type, recordId } = req.body || {};
  const rec = await owned(type, recordId, userId, res);
  if (!rec) return;
  const notes = `${HIDDEN_PREFIX} on ${today()} (not used).\n${rec.fields.Notes || ''}`.trim();
  await patch(TABLES[type], recordId, { Notes: notes });
  return res.json({ hidden: true });
}

// ── ANSWER (platform questions) ───────────────────────────────
const TRANSFER_ANSWERS = { uk: 'UK only', eea: 'EEA', outside: 'International' };
const MECHANISMS = ['IDTA', 'UK Addendum', 'UK-US Bridge', 'BCRs', 'Unknown'];
async function handleAnswer(req, res, userId) {
  const { recordId, key, value, mechanism } = req.body || {};
  const rec = await owned('platform', recordId, userId, res);
  if (!rec) return;
  const mc = safeJSON(rec.fields.MarketingChecksJson, null) || { category: rec.fields.Category || 'other', checks: {} };
  mc.answers = mc.answers || {};
  const fields = {};
  if (key === 'ownUse') {
    if (!['yes', 'no'].includes(value)) return res.status(400).json({ error: 'Answer yes or no' });
    mc.answers.ownUse = value;
  } else if (key === 'transfer') {
    if (!TRANSFER_ANSWERS[value]) return res.status(400).json({ error: 'Unknown answer' });
    fields.TransferDestination = TRANSFER_ANSWERS[value];
    if (value === 'outside') mc.answers.mechanism = MECHANISMS.includes(mechanism) ? mechanism : 'Unknown';
    else delete mc.answers.mechanism;
  } else return res.status(400).json({ error: 'Unknown question' });
  mc.answers.updatedAt = today();
  fields.MarketingChecksJson = JSON.stringify(mc);
  const updated = await patch(TABLES.platform, recordId, fields);
  return res.json({ ok: true, a: assessPlatform(updated.fields, {}) });
}

// ── LIVE POSTS (affiliates and influencers) ───────────────────
async function checkUrl(url) {
  const page = await fetchPage(url).catch(e => ({ ok: false, error: e.message }));
  if (!page.ok) return { url, read: false, error: page.error || 'Could not read the page' };
  const text = htmlToText(page.html);
  // Social sites often answer with a log-in wall instead of the post
  if (text.length < 200 || /log ?in to (see|continue)|sign up to see|you must be logged in/i.test(text.slice(0, 2000))) {
    return { url, read: false, error: 'The site asked for a log-in, so the post could not be read. Paste the caption instead.' };
  }
  return { url, read: true, ...checkPostText(text) };
}

async function runLiveCheck(rec, urlsOverride, pasted) {
  const vu = safeJSON(rec.fields.VerificationUrls, {});
  if (urlsOverride) vu.livePages = urlsOverride;
  if (pasted?.url && !(vu.livePages || []).includes(pasted.url)) vu.livePages = [...(vu.livePages || []), pasted.url].slice(0, 6);
  const pages = [];
  for (const url of (vu.livePages || []).slice(0, 6)) {
    const prev = (vu.liveCheck?.pages || []).find(p => p.url === url);
    if (pasted && pasted.url === url) pages.push({ url, read: true, pasted: true, ...checkPostText(pasted.text) });
    else if (prev?.pasted && !urlsOverride) pages.push(prev); // keep a pasted caption until the next save
    else pages.push(await checkUrl(url));
  }
  if (pasted && !pasted.url) pages.push({ url: 'Pasted caption', read: true, pasted: true, ...checkPostText(pasted.text) });
  const anyUnlabelled = pages.some(p => p.read && !p.adLabel);
  const missesInRow = anyUnlabelled ? (vu.liveCheck?.missesInRow || 0) + 1 : 0;
  vu.liveCheck = { checkedAt: today(), pages, missesInRow };
  const read = pages.filter(p => p.read);
  const fields = {
    VerificationUrls: JSON.stringify(vu),
    AdDisclosureCompliant: read.length ? (anyUnlabelled ? 'Unverified' : 'Verified') : undefined,
    LastChecked: today(),
  };
  return patch(TABLES.affiliate, rec.id, fields);
}

async function handleLivePages(req, res, userId) {
  const { recordId, urls } = req.body || {};
  const rec = await owned('affiliate', recordId, userId, res);
  if (!rec) return;
  const pages = (Array.isArray(urls) ? urls : []).map(u => String(u || '').trim()).filter(u => /^https?:\/\//i.test(u)).slice(0, 6);
  const updated = await runLiveCheck(rec, pages, null);
  return res.json({ ok: true, a: assessAffiliate(updated.fields, {}) });
}

async function handleLiveText(req, res, userId) {
  const { recordId, url, text } = req.body || {};
  if (!String(text || '').trim()) return res.status(400).json({ error: 'Paste the caption or post text first' });
  const rec = await owned('affiliate', recordId, userId, res);
  if (!rec) return;
  const updated = await runLiveCheck(rec, null, { url: url || null, text: String(text).slice(0, 5000) });
  return res.json({ ok: true, a: assessAffiliate(updated.fields, {}) });
}

// Monthly cron: every watched post not checked in the last 28 days
async function handleRecheck(req, res) {
  const recs = await list(TABLES.affiliate, `FIND('livePages',{VerificationUrls})`, { max: 100 }).catch(() => []);
  const cutoff = Date.now() - RECHECK_DAYS * 86400000;
  const due = recs.filter(r => {
    const at = safeJSON(r.fields.VerificationUrls, {}).liveCheck?.checkedAt;
    return !isHidden(r.fields) && (!at || new Date(at).getTime() < cutoff);
  }).slice(0, 15);
  let checked = 0;
  for (const r of due) {
    try { await runLiveCheck(r, null, null); checked++; }
    catch (e) { console.error('third-parties recheck failed', r.id, e.message); }
  }
  return res.json({ due: due.length, checked });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query?.action;
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (action === 'recheck') {
      if (auth.kind !== 'internal') return res.status(403).json({ error: 'Not allowed', code: 'internal_only' });
      return await handleRecheck(req, res);
    }
    const userId = req.method === 'GET' ? req.query.userId : req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (action === 'load' && req.method === 'GET') return await handleLoad(req, res, userId);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (action === 'hide')       return await handleHide(req, res, userId);
    if (action === 'answer')     return await handleAnswer(req, res, userId);
    if (action === 'live-pages') return await handleLivePages(req, res, userId);
    if (action === 'live-text')  return await handleLiveText(req, res, userId);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('third-parties error:', e);
    return res.status(500).json({ error: 'Something went wrong', detail: e.message });
  }
}
