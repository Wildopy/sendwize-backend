// ─────────────────────────────────────────────────────────────
// SENDWIZE — _benchmarks.js v1.0
// Sendwize's own benchmarks: anonymised per-send results pooled across
// members, so a member is compared with real UK senders in their sector
// and size band, not with published industry averages.
//
// Pooled rows (table Benchmark_Sends) carry no names, emails, campaign
// names or list names: a salted hash per member (to count distinct
// senders), sector, size band, month, and the send's counts.
//
// Off unless SENDWIZE_BENCHMARK_POOL=true (needs a line in the terms).
// No comparison is shown until a cohort has MIN_CONTRIBUTORS other
// members, so no one member's figures can be read back out.
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { atFetch, fq } from './_airtable.js';

export const MIN_CONTRIBUTORS = 10;
const MIN_SENDS = 3;
const TABLE = 'Benchmark_Sends';
const on = () => process.env.SENDWIZE_BENCHMARK_POOL === 'true';
const salt = () => process.env.SENDWIZE_POOL_SALT || 'sendwize-pool-v1';
const hash = s => crypto.createHash('sha256').update(salt() + '|' + s).digest('hex').slice(0, 16);
const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}/${TABLE}`;
const head = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });

export function sizeBand(n) {
  n = Number(n) || 0;
  return n < 1000 ? 'under 1k' : n < 5000 ? '1k-5k' : n < 20000 ? '5k-20k' : n < 100000 ? '20k-100k' : '100k+';
}
export const sectorKey = s => String(s || 'general').toLowerCase().trim() || 'general';

// Add newly stored sends to the pool. Never throws.
export async function contributeSends(userId, sector, segment, campaigns) {
  if (!on() || !campaigns?.length) return 0;
  const rows = campaigns.map(c => {
    const recipients = Number(c.volume_sent) || Number(c.delivered_count) || 0;
    const d = new Date(c.date);
    if (!recipients || isNaN(d)) return null;
    const known = c.complaint_count != null && c.complaint_count !== '';
    return { fields: Object.fromEntries(Object.entries({
      Contributor: hash(userId), SendKey: hash(`${userId}|${segment}|${c.date}|${c.campaign_name || ''}`),
      Sector: sectorKey(sector), SizeBand: sizeBand(recipients), SendMonth: `${d.toISOString().slice(0, 7)}-01`,
      Recipients: recipients, Unsubs: Number(c.unsubscribe_count) || 0, Complaints: known ? Number(c.complaint_count) || 0 : null,
    }).filter(([, v]) => v != null)) };
  }).filter(Boolean);
  let n = 0;
  try {
    for (let i = 0; i < rows.length; i += 10) {
      const r = await atFetch(base(), { method: 'POST', headers: head(), body: JSON.stringify({ records: rows.slice(i, i + 10) }) });
      if (!r.ok) break;
      n += Math.min(10, rows.length - i);
    }
  } catch (e) { /* the pool never blocks an upload */ }
  return n;
}

async function loadCohort(formula, pages = 10) {
  const out = [];
  let offset = null;
  for (let i = 0; i < pages; i++) {
    const url = `${base()}?pageSize=100&filterByFormula=${encodeURIComponent(formula)}&fields[]=Contributor&fields[]=Recipients&fields[]=Unsubs&fields[]=Complaints${offset ? `&offset=${offset}` : ''}`;
    const r = await atFetch(url, { headers: head() });
    if (!r.ok) return null;
    const j = await r.json();
    out.push(...(j.records || []).map(x => x.fields));
    if (!j.offset) break;
    offset = j.offset;
  }
  return out;
}

// Each contributor's pooled rates: one sender, one vote
function perSender(rows, exclude) {
  const by = {};
  for (const r of rows) {
    if (!r.Contributor || r.Contributor === exclude) continue;
    const g = by[r.Contributor] ||= { sends: 0, rec: 0, unsubs: 0, cRec: 0, comp: 0 };
    g.sends++; g.rec += r.Recipients || 0; g.unsubs += r.Unsubs || 0;
    if (r.Complaints != null) { g.cRec += r.Recipients || 0; g.comp += r.Complaints; }
  }
  return Object.values(by).filter(g => g.sends >= MIN_SENDS && g.rec > 0);
}

export function compare(memberRate, others) {
  const rates = others.slice().sort((a, b) => a - b);
  const better = rates.filter(x => x < memberRate).length; // senders who lose fewer people than this member
  const median = rates[Math.floor(rates.length / 2)];
  return { worseThanPct: Math.round(better / rates.length * 100), median, n: rates.length };
}

const pct = x => (x * 100).toFixed(2) + '%';

/**
 * The member's sends (last 12 months, all lists) against the closest cohort
 * with enough other senders: same sector and size, then same sector, then same size.
 */
export async function benchmarkMember(userId, sector, campaigns) {
  if (!on() || !campaigns?.length) return null;
  const since = Date.now() - 365 * 86400000;
  const mine = campaigns.filter(c => new Date(c.date).getTime() >= since && (Number(c.volume_sent) || Number(c.delivered_count)) > 0);
  if (mine.length < MIN_SENDS) return null;
  const rec = mine.reduce((s, c) => s + (Number(c.volume_sent) || Number(c.delivered_count)), 0);
  const unsubRate = mine.reduce((s, c) => s + (Number(c.unsubscribe_count) || 0), 0) / rec;
  const withC = mine.filter(c => c.complaint_count != null && c.complaint_count !== '');
  const cRec = withC.reduce((s, c) => s + (Number(c.volume_sent) || Number(c.delivered_count)), 0);
  const complaintRate = cRec ? withC.reduce((s, c) => s + (Number(c.complaint_count) || 0), 0) / cRec : null;
  const band = sizeBand(Math.max(...mine.map(c => Number(c.volume_sent) || Number(c.delivered_count))));
  const sec = sectorKey(sector), me = hash(userId);
  const sinceF = `IS_AFTER({SendMonth},DATEADD(TODAY(),-13,'months'))`;
  const cohorts = [
    { label: `UK ${sec} senders with lists of ${band}`, f: `AND(${sinceF},{Sector}=${fq(sec)},{SizeBand}=${fq(band)})` },
    { label: `UK ${sec} senders`, f: `AND(${sinceF},{Sector}=${fq(sec)})` },
    { label: `UK senders with lists of ${band}`, f: `AND(${sinceF},{SizeBand}=${fq(band)})` },
  ];
  for (const c of cohorts) {
    const rows = await loadCohort(c.f).catch(() => null);
    if (!rows) return null;
    const senders = perSender(rows, me);
    if (senders.length < MIN_CONTRIBUTORS) continue;
    const u = compare(unsubRate, senders.map(g => g.unsubs / g.rec));
    const cs = senders.filter(g => g.cRec > 0);
    const comp = complaintRate != null && cs.length >= MIN_CONTRIBUTORS ? compare(complaintRate, cs.map(g => g.comp / g.cRec)) : null;
    const worse = u.worseThanPct >= 50;
    let sentence = `Each send loses ${pct(unsubRate)} of recipients to unsubscribes. That's ${worse ? 'worse' : 'better'} than ${worse ? u.worseThanPct : 100 - u.worseThanPct}% of the ${u.n} ${c.label} on Sendwize (typical: ${pct(u.median)}).`;
    if (comp) sentence += ` Spam complaints: ${comp.worseThanPct >= 50 ? 'worse' : 'better'} than ${comp.worseThanPct >= 50 ? comp.worseThanPct : 100 - comp.worseThanPct}% of them.`;
    return { cohort: c.label, senders: u.n, unsubRate, unsub: u, complaintRate, complaint: comp, severity: u.worseThanPct >= 75 ? 'red' : u.worseThanPct >= 50 ? 'amber' : 'green', sentence };
  }
  return null;
}
