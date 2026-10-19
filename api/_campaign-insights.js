// ─────────────────────────────────────────────────────────────
// SENDWIZE — _campaign-insights.js v1.0
// The reveals Audience Read leads with, worked out only from the
// member's own campaign export (every platform's campaign report has
// date, recipients, unsubscribes; most have complaints and revenue).
//
//   forecast     How much of each list unsubscribes and complaints will
//                take over the next 12 months at the current pace, and
//                how much of that comes from the sends that spike.
//   frequency    Whether a third send in a week costs more people than
//                the first two, measured on their own history.
//   campaigns    Each send with the people it lost, what they were
//                worth, its net value and its spam-complaint rate
//                against the 0.3% Gmail and Yahoo bulk-sender limit.
//   bestCampaign When the top earner isn't the best send once the
//                subscribers it lost are counted.
//   nextSend     A plain call for the next send.
//   peak         A plan for the run-up to Black Friday.
//
// Deterministic: the same campaigns always give the same answer.
// ─────────────────────────────────────────────────────────────
import { nextBlackFriday } from './_list-insights.js';

const DAY = 86400000;
export const COMPLAINT_LIMIT = 0.003;   // Gmail / Yahoo bulk-sender requirement: stay below 0.3%
export const COMPLAINT_TARGET = 0.001;  // Google's guidance: keep it under 0.1%

const fmt = n => Math.round(n || 0).toLocaleString('en-GB');
const gbp = n => '£' + Math.round(n || 0).toLocaleString('en-GB');
const pctTxt = (x, dp = 0) => (x * 100).toFixed(dp) + '%';
const t = d => { const x = new Date(d).getTime(); return isNaN(x) ? null : x; };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function sendsOf(campaigns) {
  return campaigns
    .map(c => ({ ...c, _t: t(c.date), recipients: Number(c.volume_sent) || Number(c.delivered_count) || 0 }))
    .filter(c => c._t && c.recipients > 0)
    // Same send uploaded twice (re-exports overlap) counts once
    .filter((c, i, all) => all.findIndex(o => o._t === c._t && o.recipients === c.recipients && String(o.campaign_name || '').toLowerCase() === String(c.campaign_name || '').toLowerCase()) === i)
    .sort((a, b) => a._t - b._t)
    .map((c, i, all) => {
      const unsubs = Number(c.unsubscribe_count) || 0;
      const complaints = Number(c.complaint_count) || 0;
      // Many exports carry no complaints column: unknown, not zero
      const hasComplaints = c.complaint_count != null && c.complaint_count !== '';
      // Sends to the same list in the 7 days before this one
      const priorWeek = all.slice(0, i).filter(p => c._t - p._t < 7 * DAY && c._t - p._t >= 0).length;
      return { ...c, unsubs, complaints, lossRate: (unsubs + complaints) / c.recipients, complaintRate: hasComplaints ? complaints / c.recipients : null, priorWeek };
    });
}

function forecast(sends) {
  if (sends.length < 2) return null;
  const spanDays = (sends[sends.length - 1]._t - sends[0]._t) / DAY;
  if (spanDays < 7) return null;
  const latestSize = sends[sends.length - 1].recipients;
  const sendsPerMonth = (sends.length - 1) / (spanDays / 30.44);
  const pooled = sends.reduce((s, c) => s + c.unsubs + c.complaints, 0) / sends.reduce((s, c) => s + c.recipients, 0);
  const yearLoss = r => 1 - Math.pow(1 - r, sendsPerMonth * 12);
  const annualLoss = yearLoss(pooled);
  const monthlyLoss = 1 - Math.pow(1 - pooled, sendsPerMonth);

  // The sends that spike: more than double the list's usual rate
  const med = median(sends.map(c => c.lossRate));
  const spikes = sends.filter(c => c.lossRate > med * 2 && c.lossRate > 0.002);
  let fixedAnnualLoss = null;
  if (spikes.length && spikes.length < sends.length) {
    const totalRecipients = sends.reduce((s, c) => s + c.recipients, 0);
    const lossFixed = sends.reduce((s, c) => s + (spikes.includes(c) ? med * c.recipients : c.unsubs + c.complaints), 0) / totalRecipients;
    fixedAnnualLoss = yearLoss(lossFixed);
  }

  // Observed size trend (after new sign-ups) when there's enough history
  let netTrendPerYear = null;
  if (sends.length >= 4 && spanDays >= 60) {
    const xs = sends.map(c => (c._t - sends[0]._t) / DAY), ys = sends.map(c => c.recipients);
    const mx = mean(xs), my = mean(ys);
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (Number.isFinite(slope) && latestSize > 0) netTrendPerYear = slope * 365 / latestSize;
  }
  return {
    spanDays: Math.round(spanDays), sends: sends.length, latestSize, sendsPerMonth: Math.round(sendsPerMonth * 10) / 10,
    lossPerSend: pooled, monthlyLoss, annualLoss, peopleLost12: Math.round(latestSize * annualLoss),
    signupsNeededPerMonth: Math.round(latestSize * annualLoss / 12),
    spikeSends: spikes.length, fixedAnnualLoss, netTrendPerYear,
  };
}

function frequency(sends) {
  const third = sends.filter(c => c.priorWeek >= 2), rest = sends.filter(c => c.priorWeek < 2);
  if (third.length < 3 || rest.length < 3) return { measured: false, thirdSends: third.length };
  const rate = list => list.reduce((s, c) => s + c.unsubs + c.complaints, 0) / list.reduce((s, c) => s + c.recipients, 0);
  const a = rate(third), b = rate(rest);
  const ratio = b > 0 ? a / b : null;
  const costsMore = ratio != null && ratio >= 1.3;
  const sentence = ratio == null ? null : costsMore
    ? `A third send in the same week loses ${pctTxt(ratio - 1)} more people than your other sends (${third.length} third sends measured).`
    : `Third sends in the same week haven't cost you more people than usual (${third.length} measured).`;
  return { measured: true, thirdSends: third.length, otherSends: rest.length, thirdRate: a, otherRate: b, ratio, costsMore, sentence };
}

// Value of one subscriber for a year: their revenue per subscriber, else the member's cost to replace one
function subscriberValue(sends, cpl) {
  const withRev = sends.filter(c => Number(c.revenue) > 0);
  if (withRev.length >= 2) {
    const spanDays = Math.max(30, (sends[sends.length - 1]._t - sends[0]._t) / DAY + 7);
    const avgSize = mean(sends.map(c => c.recipients));
    const revenue = withRev.reduce((s, c) => s + Number(c.revenue), 0);
    return { perYear: revenue / avgSize * (365 / spanDays), basis: 'revenue', label: 'what a subscriber earns you in a year' };
  }
  if (cpl > 0) return { perYear: cpl, basis: 'cpl', label: 'your cost to replace a subscriber' };
  return null;
}

function campaignRows(sends, value) {
  return sends.slice(-25).map(c => {
    const lostValue = value ? c.unsubs * value.perYear : null;
    const revenue = Number(c.revenue) > 0 ? Number(c.revenue) : null;
    return {
      date: new Date(c._t).toISOString().slice(0, 10), name: c.campaign_name || 'Campaign', type: c.campaign_type || null,
      recipients: c.recipients, unsubs: c.unsubs, unsubRate: c.unsubs / c.recipients, complaints: c.complaints, complaintRate: c.complaintRate,
      complaintFlag: c.complaintRate >= COMPLAINT_LIMIT ? 'red' : c.complaintRate >= COMPLAINT_TARGET ? 'amber' : null,
      thirdInWeek: c.priorWeek >= 2, revenue,
      lostValue: lostValue != null ? Math.round(lostValue) : null,
      net: revenue != null && lostValue != null ? Math.round(revenue - lostValue) : null,
    };
  });
}

function bestCampaign(rows) {
  const scored = rows.filter(r => r.net != null);
  if (scored.length < 3) return null;
  const topRev = [...scored].sort((a, b) => b.revenue - a.revenue)[0];
  const topNet = [...scored].sort((a, b) => b.net - a.net)[0];
  if (topRev === topNet) return { same: true, top: topRev.name };
  return {
    same: false, topRevenue: topRev, topNet,
    sentence: `"${topRev.name}" made the most (${gbp(topRev.revenue)}) but lost ${fmt(topRev.unsubs)} subscribers worth ${gbp(topRev.lostValue)} a year, so it netted ${gbp(topRev.net)}. "${topNet.name}" made ${gbp(topNet.revenue)} and lost ${fmt(topNet.unsubs)}: ${gbp(topNet.net)} net, the best of your last ${scored.length} sends.`,
  };
}

function complaints(rows) {
  const red = rows.filter(r => r.complaintFlag === 'red'), amber = rows.filter(r => r.complaintFlag === 'amber');
  const known = rows.filter(r => r.complaintRate != null);
  const worst = [...known].sort((a, b) => b.complaintRate - a.complaintRate)[0];
  let sentence = null;
  if (red.length) sentence = `${red.length} of your last ${rows.length} sends went over the 0.3% spam-complaint limit Gmail and Yahoo enforce for bulk senders (worst: "${worst.name}" at ${pctTxt(worst.complaintRate, 2)}). Above it, more of your email lands in spam.`;
  else if (amber.length) sentence = `${amber.length} of your last ${rows.length} sends had spam complaints above 0.1%, Google's recommended ceiling. The hard limit is 0.3%.`;
  return { measured: known.length > 0, over: red.length, near: amber.length, worst: worst ? { name: worst.name, rate: worst.complaintRate } : null, sentence };
}

function nextSend(sends, freq, comp, now) {
  if (!sends.length) return null;
  const last = sends[sends.length - 1];
  const daysSinceLast = Math.floor((now - last._t) / DAY);
  if (daysSinceLast > 45) return { call: 'refresh', text: `Your latest send here is ${daysSinceLast} days old. Upload your latest campaign export so the advice reflects how you send now.` };
  const lastWeek = sends.filter(c => now - c._t < 7 * DAY).length;
  if (last.complaintRate >= COMPLAINT_LIMIT) return { call: 'hold', text: `Hold the next promotional send. Your last send ("${last.campaign_name || 'Campaign'}") hit ${pctTxt(last.complaintRate, 2)} spam complaints, over the 0.3% limit. Send to engaged contacts only until it drops.` };
  if (lastWeek >= 2 && freq.costsMore) return { call: 'skip', text: `Skip a third send this week. You've sent ${lastWeek} in the last 7 days, and on your history a third send in a week loses ${pctTxt(freq.ratio - 1)} more people than usual.` };
  if (lastWeek >= 2) return { call: 'caution', text: `You've already sent ${lastWeek} emails to this list in the last 7 days. Make the next one value-first (content, not a promotion).` };
  return { call: 'go', text: `Good to send. ${lastWeek ? `One send in the last 7 days` : 'Nothing sent in the last 7 days'}${last.complaintRate == null ? '' : `, and complaints on your last send were ${pctTxt(last.complaintRate, 2)}`}.` };
}

function peakPlan(fc, freq, now, listIntel) {
  const bf = nextBlackFriday(new Date(now));
  if (!bf || !fc) return null;
  const days = Math.round((bf.getTime() - now) / DAY);
  if (days > 120) return null;
  const weeks = Math.max(1, Math.round(days / 7));
  const currentWeekly = fc.sendsPerMonth / 4.33;
  const safeWeekly = freq.costsMore ? Math.min(2, Math.max(1, Math.round(currentWeekly))) : Math.max(1, Math.round(currentWeekly));
  const lapse = listIntel?.lapseBeforePeak || 0;
  const reachable = Math.max(0, Math.round(fc.latestSize * Math.pow(1 - fc.monthlyLoss, days / 30.44)) - lapse);
  return {
    date: bf.toISOString().slice(0, 10), days, weeks, safeWeekly, plannedSends: safeWeekly * weeks, reachable, lapseBeforePeak: lapse,
    sentence: `Black Friday is ${days} days away. Plan up to ${safeWeekly} send${safeWeekly === 1 ? '' : 's'} a week (${safeWeekly * weeks} in total) and you'll reach about ${fmt(reachable)} people on the day${lapse ? `, after ${fmt(lapse)} contacts lose consent` : ''}.${freq.costsMore ? ' Going to three a week costs more subscribers than it earns on your history.' : ''}`,
  };
}

/**
 * campaigns: Audience Read campaign objects (all lists)
 * ctx: { now, cpl, listIntel: { lapseBeforePeak } }
 */
export function buildCampaignInsights(campaigns, ctx = {}) {
  const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
  const bySeg = {};
  for (const c of campaigns || []) (bySeg[c.segment || 'Default'] ||= []).push(c);

  const segments = {};
  for (const [name, list] of Object.entries(bySeg)) {
    const sends = sendsOf(list);
    if (!sends.length) continue;
    const fc = forecast(sends);
    const freq = frequency(sends);
    const value = subscriberValue(sends, Number(ctx.cpl) || 0);
    const rows = campaignRows(sends, value);
    const comp = complaints(rows);
    segments[name] = {
      forecast: fc, frequency: freq, subscriberValue: value ? { perYear: Math.round(value.perYear * 100) / 100, basis: value.basis, label: value.label } : null,
      campaigns: rows, bestCampaign: bestCampaign(rows), complaints: comp,
      nextSend: nextSend(sends, freq, comp, now), peak: peakPlan(fc, freq, now, ctx.listIntel),
    };
  }

  // Headline on the biggest list with a forecast
  const ranked = Object.entries(segments).filter(([, s]) => s.forecast).sort((a, b) => b[1].forecast.latestSize - a[1].forecast.latestSize);
  const [headName, head] = ranked[0] || [];
  const reveals = [];
  let headline = null;
  if (head) {
    const fc = head.forecast, v = head.subscriberValue;
    headline = `At your current pace, unsubscribes and complaints will take ${pctTxt(fc.annualLoss)} of "${headName}" (${fmt(fc.peopleLost12)} people) over the next 12 months.`;
    let more = `That's ${fmt(fc.signupsNeededPerMonth)} new sign-ups a month just to stand still`;
    if (v) more += v.basis === 'revenue'
      ? `. At your average of ${gbp(v.perYear)} a year per subscriber, that's about ${gbp(fc.peopleLost12 * v.perYear)} a year in revenue walking out`
      : `, costing about ${gbp(fc.peopleLost12 * v.perYear)} to replace at your cost per subscriber`;
    reveals.push({ kind: 'forecast', severity: fc.annualLoss >= 0.2 ? 'red' : fc.annualLoss >= 0.1 ? 'amber' : 'info', text: more + '.' });
    if (fc.fixedAnnualLoss != null && fc.annualLoss - fc.fixedAnnualLoss >= 0.02) {
      reveals.push({ kind: 'spikes', severity: 'amber', text: `${fc.spikeSends} send${fc.spikeSends === 1 ? '' : 's'} lost more than twice your usual number of people. If they had performed like the rest, you'd lose ${pctTxt(fc.fixedAnnualLoss)} a year instead of ${pctTxt(fc.annualLoss)}.` });
    }
    if (fc.netTrendPerYear != null && Math.abs(fc.netTrendPerYear) >= 0.03) {
      reveals.push({ kind: 'trend', severity: fc.netTrendPerYear < 0 ? 'amber' : 'info', text: `After new sign-ups, "${headName}" has been ${fc.netTrendPerYear < 0 ? 'shrinking' : 'growing'} by about ${pctTxt(Math.abs(fc.netTrendPerYear))} a year (sends went from ${fmt(head.campaigns[0]?.recipients)} to ${fmt(fc.latestSize)} recipients).` });
    }
    if (head.frequency.costsMore) reveals.push({ kind: 'frequency', severity: 'amber', text: `When you send a third email to "${headName}" within a week, ${pctTxt(head.frequency.ratio - 1)} more people leave than on your other sends (${head.frequency.thirdSends} sends measured).` });
    if (head.bestCampaign && !head.bestCampaign.same) reveals.push({ kind: 'best_campaign', severity: 'info', text: head.bestCampaign.sentence });
    if (head.complaints.sentence) reveals.push({ kind: 'complaints', severity: head.complaints.over ? 'red' : 'amber', text: head.complaints.sentence });
    if (head.peak) reveals.push({ kind: 'peak', severity: 'info', text: head.peak.sentence });
  }
  return { version: 'campaign-insights-1.0', headlineList: headName || null, headline, reveals, segments };
}
