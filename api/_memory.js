// ─────────────────────────────────────────────────────────────
// SENDWIZE — _memory.js v1.0
// What Sendwize remembers between uploads, turned into alerts.
//
// Every List Intelligence upload stores the day each marketable
// contact's consent runs out (insights.memory.lapseByDay). Every
// Audience Read upload stores each send. From those alone, with no
// new file, Sendwize can say what has lapsed since the last upload,
// what lapses next, how complaints are trending, and which new ICO
// rulings touch a stored list. Used by the weekly digest and the
// dashboard. Deterministic: no AI.
// ─────────────────────────────────────────────────────────────
import { atFetch, fq } from './_airtable.js';
import { buildCampaignInsights, COMPLAINT_LIMIT, COMPLAINT_TARGET } from './_campaign-insights.js';

const DAY = 86400000;
const STALE_LIST_DAYS = 45;
const fmt = n => Math.round(n || 0).toLocaleString('en-GB');
const pct = (x, dp = 2) => (x * 100).toFixed(dp) + '%';
const iso = t => new Date(t).toISOString().slice(0, 10);
const SEV = { red: 0, amber: 1, info: 2, green: 3 };

// Contacts whose consent ran out on a day in [from, to)
export function lapsedBetween(memory, from, to) {
  if (!memory || !memory.lapseByDay) return 0;
  const a = iso(from), b = iso(to);
  let n = 0;
  for (const [d, c] of Object.entries(memory.lapseByDay)) if (d >= a && d < b) n += c;
  return n;
}

/**
 * checks: [{ listName, checkDate, insights }] newest first, any lists
 * Returns alerts for the latest check of each list, compared with the one before it.
 */
export function listAlerts(checks, now = Date.now()) {
  const byList = {};
  for (const c of checks || []) if (c.insights) (byList[c.listName] ||= []).push(c);
  const alerts = [];
  for (const [list, cs] of Object.entries(byList)) {
    const cur = cs[0], prev = cs[1], ins = cur.insights, mem = ins.memory;
    const since = new Date(cur.checkDate).getTime();
    const age = Math.floor((now - since) / DAY);
    const when = new Date(cur.checkDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    if (mem) {
      const gone = lapsedBetween(mem, since, now + DAY);
      const next30 = lapsedBetween(mem, now + DAY, now + 31 * DAY);
      if (gone > 0) alerts.push({ kind: 'lapsed', severity: 'red', list, count: gone,
        text: `${fmt(gone)} contacts on "${list}" have passed your consent period since you uploaded it on ${when}. You can now market to about ${fmt(Math.max(0, mem.marketable - gone))}, not ${fmt(mem.marketable)}. Suppress them before your next send.` });
      if (next30 > 0) alerts.push({ kind: 'lapsing', severity: 'amber', list, count: next30,
        text: `${fmt(next30)} more on "${list}" lose consent in the next 30 days. A re-permission email this week keeps them.` });
    }

    // What changed between the last two uploads of the same list
    if (prev && prev.insights && age <= 7) {
      const a = prev.insights, b = ins;
      const dGreen = (b.realList?.green || 0) - (a.realList?.green || 0);
      if (Math.abs(dGreen) >= 10) alerts.push({ kind: 'list_change', severity: dGreen > 0 ? 'green' : 'amber', list,
        text: `"${list}" has ${fmt(Math.abs(dGreen))} ${dGreen > 0 ? 'more' : 'fewer'} contacts you can safely market than at your previous upload.` });
      for (const [code, label] of [['leak', 'people who unsubscribed elsewhere'], ['third_party', 'bought or partner contacts'], ['soft_optin_no_purchase', 'soft opt-in contacts who never bought']]) {
        const was = a.reasonCounts?.[code] || 0, is = b.reasonCounts?.[code] || 0;
        if (is > was) alerts.push({ kind: 'new_' + code, severity: 'red', list, count: is - was,
          text: `${fmt(is - was)} new ${label} appeared on "${list}" since the previous upload. Check how they got in.` });
      }
    }
    if (age >= STALE_LIST_DAYS) alerts.push({ kind: 'stale_list', severity: 'info', list,
      text: `"${list}" was last uploaded ${age} days ago. Upload a fresh export so these figures stay true.` });
  }
  return alerts;
}

// Complaint and loss alerts from stored sends
export function audienceAlerts(campaigns, now = Date.now()) {
  if (!campaigns || !campaigns.length) return [];
  const ins = buildCampaignInsights(campaigns, { now });
  const alerts = [];
  for (const [list, s] of Object.entries(ins.segments || {})) {
    const rows = s.campaigns || [];
    const recent = rows.filter(r => now - new Date(r.date).getTime() <= 7 * DAY);
    for (const r of recent) {
      if (r.complaintRate >= COMPLAINT_LIMIT) alerts.push({ kind: 'complaints_over', severity: 'red', list,
        text: `"${r.name}" to "${list}" had ${pct(r.complaintRate)} spam complaints, over the 0.3% limit Gmail and Yahoo enforce. Send only to recent engagers until it drops.` });
      else if (r.complaintRate >= COMPLAINT_TARGET) alerts.push({ kind: 'complaints_near', severity: 'amber', list,
        text: `"${r.name}" to "${list}" had ${pct(r.complaintRate)} spam complaints, above Google's recommended 0.1%.` });
    }
    // Complaints up three sends running
    const known = rows.filter(r => r.complaintRate != null);
    const last3 = known.slice(-3);
    if (last3.length === 3 && last3[0].complaintRate < last3[1].complaintRate && last3[1].complaintRate < last3[2].complaintRate && last3[2].complaintRate >= COMPLAINT_TARGET / 2)
      alerts.push({ kind: 'complaints_rising', severity: 'amber', list,
        text: `Spam complaints on "${list}" have risen three sends running (${last3.map(r => pct(r.complaintRate)).join(', ')}).` });
    if (s.nextSend && (s.nextSend.call === 'skip' || s.nextSend.call === 'hold') && rows.length && now - new Date(rows[rows.length - 1].date).getTime() <= 7 * DAY)
      alerts.push({ kind: 'next_send', severity: 'amber', list, text: `"${list}": ${s.nextSend.text}` });
  }
  if (ins.headline && Object.values(ins.segments).some(s => s.forecast && s.forecast.annualLoss >= 0.2))
    alerts.push({ kind: 'forecast', severity: 'info', list: ins.headlineList, text: ins.headline });
  return alerts;
}

// New ICO rulings that touch a stored list (raised by regulatory-feed-update Phase 6)
export function rulingAlerts(fixes) {
  return (fixes || []).map(f => ({ kind: 'ruling', severity: 'red', list: null, text: f.Description || 'A new ICO ruling matches contacts on one of your lists.' }));
}

export function rankAlerts(alerts) {
  return alerts.slice().sort((a, b) => (SEV[a.severity] ?? 2) - (SEV[b.severity] ?? 2));
}

// ── Loaders (Airtable REST) ──
const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const head = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` });
async function atPages(table, params, pages = 1) {
  const out = [];
  let offset = null;
  for (let i = 0; i < pages; i++) {
    const r = await atFetch(`${base()}/${encodeURIComponent(table)}?${params}${offset ? `&offset=${offset}` : ''}`, { headers: head() });
    if (!r.ok) throw new Error(`${table} ${r.status}`);
    const j = await r.json();
    out.push(...(j.records || []));
    if (!j.offset) break;
    offset = j.offset;
  }
  return out;
}

export async function loadListChecks(userId) {
  const f = `AND({UserID}=${fq(userId)},IS_AFTER({CheckDate},DATEADD(TODAY(),-400,'days')))`;
  const recs = await atPages('List_Intelligence_Checks', `filterByFormula=${encodeURIComponent(f)}&fields[]=ListName&fields[]=CheckDate&fields[]=Results&sort[0][field]=CheckDate&sort[0][direction]=desc&pageSize=30`, 1);
  const seen = {};
  const out = [];
  for (const r of recs) {
    const name = r.fields.ListName || 'Default';
    if ((seen[name] = (seen[name] || 0) + 1) > 2) continue;
    let insights = null;
    try { insights = JSON.parse(r.fields.Results || '{}').insights || null; } catch (e) {}
    out.push({ listName: name, checkDate: r.fields.CheckDate, insights });
  }
  return out;
}

export async function loadRecentCampaigns(userId) {
  const f = `AND({UserID}=${fq(userId)},IS_AFTER({SendDate},DATEADD(TODAY(),-120,'days')))`;
  const recs = await atPages('Audience_Read_Campaigns', `filterByFormula=${encodeURIComponent(f)}&sort[0][field]=SendDate&sort[0][direction]=desc`, 3);
  return recs.reverse().map(r => ({
    segment: r.fields.SegmentName, campaign_name: r.fields.CampaignName, date: r.fields.SendDate,
    volume_sent: r.fields.VolumeSent || null, delivered_count: r.fields.DeliveredCount || null,
    unsubscribe_count: r.fields.UnsubscribeCount || 0, complaint_count: r.fields.ComplaintCount ?? null, revenue: r.fields.Revenue || null,
  }));
}

export async function loadRulingFixes(userId, days = 14) {
  const f = `AND({UserID}=${fq(userId)},{Status}='pending',FIND('li-ruling:',{SourceRecordID}),IS_AFTER({CreatedDate},DATEADD(TODAY(),-${days},'days')))`;
  const recs = await atPages('Compliance_Fixes', `filterByFormula=${encodeURIComponent(f)}&fields[]=Description&pageSize=10`, 1);
  return recs.map(r => r.fields);
}

// Everything for one member; each source fails on its own
export async function buildAlerts(userId, now = Date.now()) {
  const [checks, camps, rulings] = await Promise.all([
    loadListChecks(userId).catch(() => []),
    loadRecentCampaigns(userId).catch(() => []),
    loadRulingFixes(userId).catch(() => []),
  ]);
  const alerts = rankAlerts([...rulingAlerts(rulings), ...listAlerts(checks, now), ...audienceAlerts(camps, now)]);
  const latest = [...checks.map(c => c.checkDate), ...camps.map(c => c.date)].filter(Boolean).sort().pop() || null;
  return { alerts, latestUpload: latest, hasData: checks.length > 0 || camps.length > 0 };
}
