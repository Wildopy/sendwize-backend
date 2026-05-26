// api/audience-read.js — Sendwize Tool 6: Audience Read v6.0
// Seven deterministic algorithms. Zero AI. Zero external data.
// Airtable via fetch only — no npm airtable package.
// All async work AWAITED before res.json() — Vercel Hobby safe.
//
// v6.0 changes:
//   - generateFixRecords removed. Fix records now created via
//     generate-fix.js endpoint — correct table, correct fields,
//     correct fix types that pass through LEGACY_TYPE_MAP.
//   - Fix types updated to v6.0 taxonomy (consent_missing,
//     legitimate_interest_abuse, data_quality).
//   - send-alert (audience_damaged) wired up via data.js.
//   - Upload loop timeout risk reduced — segment saves batched.
//   - APP_URL constant added.
//   - Null stripping on all Airtable writes (atCreate already does this).

const BASE_ID    = process.env.BASE_ID;
const AT_TOKEN   = process.env.AIRTABLE_TOKEN;
const AT_BASE    = `https://api.airtable.com/v0/${BASE_ID}`;
const APP_URL    = 'https://sendwize-backend.vercel.app';
const APP_URL    = 'https://sendwize-backend.vercel.app';

const AT_HEADERS = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// ─────────────────────────────────────────────
// AIRTABLE HELPERS
// ─────────────────────────────────────────────

async function atGet(table, formula, sort = '', max = 100) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await fetch(url, { headers: AT_HEADERS() });
  if (!r.ok) throw new Error(`Airtable GET ${table} failed: ${r.status}`);
  return (await r.json()).records || [];
}

async function atCreate(table, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}`, {
    method:  'POST',
    headers: AT_HEADERS(),
    body:    JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Airtable POST ${table} failed: ${r.status} — ${body}`);
  }
  return (await r.json()).records?.[0];
}

async function atPatch(table, recordId, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method:  'PATCH',
    headers: AT_HEADERS(),
    body:    JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`Airtable PATCH ${table} failed: ${r.status}`);
  return await r.json();
}

// ─────────────────────────────────────────────
// FIELD MAPPING AUTO-DETECTION
// ─────────────────────────────────────────────

function detectColumnType(values) {
  const sample = values.filter(v => v !== null && v !== undefined && v !== '');
  if (!sample.length) return 'unknown';
  const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  if (sample.filter(v => dateRe.test(String(v).trim())).length / sample.length > 0.7) return 'date';
  const nums = sample.map(v => parseFloat(v)).filter(n => !isNaN(n));
  if (nums.length / sample.length > 0.8) {
    if (nums.every(n => n >= 0 && n <= 1))                                               return 'rate';
    if (nums.every(n => n >= 0 && n <= 100) && nums.some(n => n % 1 !== 0))             return 'rate_pct';
    return 'count';
  }
  return 'text';
}

function autoMapColumns(headers, rows) {
  const mapping    = {};
  const sampleSize = Math.min(rows.length, 20);
  for (const h of headers) {
    const values = rows.slice(0, sampleSize).map(r => r[h]);
    const type   = detectColumnType(values);
    const lc     = h.toLowerCase();
    if (type === 'date') {
      mapping[h] = 'date';
    } else if (type === 'rate' || type === 'rate_pct') {
      if (lc.includes('open'))        mapping[h] = 'open_rate';
      else if (lc.includes('click'))  mapping[h] = 'click_rate';
      else                            mapping[h] = 'rate_unknown';
    } else if (type === 'count') {
      if (lc.includes('unsub') || lc.includes('opt'))              mapping[h] = 'unsubscribe_count';
      else if (lc.includes('complaint') || lc.includes('spam'))    mapping[h] = 'complaint_count';
      else if (lc.includes('volume') || lc.includes('sent') || lc.includes('send')) mapping[h] = 'volume_sent';
      else                                                          mapping[h] = 'count_unknown';
    } else if (type === 'text') {
      if (lc.includes('segment') || lc.includes('list') || lc.includes('audience'))     mapping[h] = 'segment';
      else if (lc.includes('campaign') || lc.includes('name') || lc.includes('subject')) mapping[h] = 'campaign_name';
      else if (lc.includes('type') || lc.includes('kind'))         mapping[h] = 'campaign_type';
      else                                                          mapping[h] = 'text_unknown';
    }
  }
  return mapping;
}

function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const uk = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (uk) return `${uk[3]}-${uk[2]}-${uk[1]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const yr = us[3].length === 2 ? '20' + us[3] : us[3];
    return `${yr}-${String(us[1]).padStart(2,'0')}-${String(us[2]).padStart(2,'0')}`;
  }
  return null;
}

function normaliseRate(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return n > 1 ? n / 100 : n;
}

// ─────────────────────────────────────────────
// DATA STRUCTURES
// ─────────────────────────────────────────────

function buildSegmentData(campaigns) {
  const bySegment = {};
  for (const c of campaigns) {
    const seg = c.segment || 'Default';
    if (!bySegment[seg]) bySegment[seg] = [];
    bySegment[seg].push(c);
  }
  for (const seg of Object.keys(bySegment)) {
    bySegment[seg].sort((a, b) => new Date(a.date) - new Date(b.date));
  }
  return bySegment;
}

// ─────────────────────────────────────────────
// ALGORITHM 1 — SEGMENT BEHAVIOURAL FINGERPRINT
// ─────────────────────────────────────────────

function algorithm1_fingerprint(campaigns) {
  const n = campaigns.length;
  if (!n) return null;

  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  const openRates  = campaigns.map(c => c.open_rate).filter(r => r !== null);
  const clickRates = campaigns.map(c => c.click_rate).filter(r => r !== null);

  const sorted  = [...unsubRates].sort((a, b) => a - b);
  const lo = Math.floor(n * 0.2), hi = Math.ceil(n * 0.8);
  const trimmed = sorted.slice(lo, hi);
  const baselineUnsub = trimmed.length ? mean_arr(trimmed) : 0.002;

  const mean_u   = mean_arr(unsubRates);
  const variance = unsubRates.reduce((s, v) => s + Math.pow(v - mean_u, 2), 0) / n;
  const stddev   = Math.sqrt(variance);

  const baselineOpen  = openRates.length  ? mean_arr(openRates)  : null;
  const baselineClick = clickRates.length ? mean_arr(clickRates) : null;

  let openDecayCoeff = null;
  if (openRates.length >= 3) {
    const pairs = openRates.map((r, i) => ({ t: i, y: r })).filter(p => p.y > 0);
    if (pairs.length >= 2) {
      const lnY   = pairs.map(p => Math.log(p.y));
      const tArr  = pairs.map(p => p.t);
      const tMean = mean_arr(tArr), yMean = mean_arr(lnY);
      const num   = tArr.reduce((s, t, i) => s + (t - tMean) * (lnY[i] - yMean), 0);
      const den   = tArr.reduce((s, t) => s + Math.pow(t - tMean, 2), 0);
      openDecayCoeff = den !== 0 ? -num / den : 0;
    }
  }

  let recoveryHalfLife = 3;
  if (n >= 4) {
    const spikes = [];
    for (let i = 1; i < n; i++) {
      if (unsubRates[i] > baselineUnsub * 1.5) {
        for (let j = i + 1; j < n; j++) {
          if (unsubRates[j] <= baselineUnsub * 1.1) { spikes.push(j - i); break; }
        }
      }
    }
    if (spikes.length) recoveryHalfLife = mean_arr(spikes);
  }

  const typeGroups = {};
  for (const c of campaigns) {
    const type = c.campaign_type || 'Unknown';
    if (!typeGroups[type]) typeGroups[type] = [];
    typeGroups[type].push(c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  }
  const typeSensitivity = {};
  for (const [type, rates] of Object.entries(typeGroups)) {
    typeSensitivity[type] = mean_arr(rates);
  }

  let frequencyThreshold = 4;
  if (n >= 5) {
    const dates = campaigns.map(c => new Date(c.date));
    let bestFreq = 4;
    for (let i = 0; i < n; i++) {
      const windowEnd   = dates[i];
      const windowStart = new Date(+windowEnd - 30 * 86400000);
      const inWindow    = campaigns.filter(c => {
        const d = new Date(c.date);
        return d >= windowStart && d <= windowEnd;
      });
      if (inWindow.length >= 3) {
        const avgUnsub = mean_arr(inWindow.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1)));
        if (avgUnsub < baselineUnsub * 1.2) bestFreq = inWindow.length;
      }
    }
    frequencyThreshold = bestFreq;
  }

  const volumeSensitivity  = campaigns.every(c => c.volume_sent)
    ? pearsonCorrelation(campaigns.map(c => c.volume_sent), unsubRates) : 0;
  const recencySensitivity = n >= 4
    ? (mean_arr(unsubRates.slice(-Math.ceil(n / 3))) - mean_arr(unsubRates.slice(0, Math.floor(n / 3)))) / (baselineUnsub + 0.001)
    : 0;

  return {
    baselineUnsubscribeRate:     r4(baselineUnsub),
    baselineOpenRate:            baselineOpen  !== null ? r4(baselineOpen)  : null,
    baselineClickRate:           baselineClick !== null ? r4(baselineClick) : null,
    unsubscribeStdDev:           r4(stddev),
    openRateDecayCoeff:          openDecayCoeff !== null ? r4(openDecayCoeff) : null,
    recoveryHalfLife:            r2(recoveryHalfLife),
    frequencyToleranceThreshold: Math.round(frequencyThreshold),
    campaignTypeSensitivity:     typeSensitivity,
    volumeSensitivity:           r4(volumeSensitivity),
    recencySensitivity:          r4(recencySensitivity),
    campaignCount:               n,
    dataCompleteness:            dataCompletenessScore(campaigns),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 2 — TRUST VELOCITY ENGINE
// ─────────────────────────────────────────────

function algorithm2_trustVelocity(campaigns, fingerprint) {
  const n = campaigns.length;
  if (n < 2) return { velocity: 0, direction: 'Stable', magnitude: 0 };
  const baseline   = fingerprint?.baselineUnsubscribeRate || 0.002;
  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  const stream1    = secondDerivative(unsubRates);
  const openRates  = campaigns.map(c => c.open_rate).filter(r => r !== null);
  let stream2 = 0;
  if (openRates.length >= 3) {
    const deltas = openRates.slice(1).map((r, i) => r - openRates[i]);
    stream2 = mean_arr(deltas);
  }
  const recoveryTimes = [];
  for (let i = 1; i < n; i++) {
    if (unsubRates[i] > baseline * 1.5) {
      for (let j = i + 1; j < n; j++) {
        if (unsubRates[j] <= baseline * 1.1) { recoveryTimes.push(j - i); break; }
      }
    }
  }
  let stream3 = 0;
  if (recoveryTimes.length >= 2) stream3 = -(recoveryTimes[recoveryTimes.length - 1] - recoveryTimes[0]) / recoveryTimes.length;
  const complaintTotal = campaigns.reduce((s, c) => s + (c.complaint_count || 0), 0);
  const unsubTotal     = campaigns.reduce((s, c) => s + (c.unsubscribe_count || 0), 0);
  const stream4 = complaintTotal > 0 ? -(complaintTotal * 50) / Math.max(unsubTotal, 1) : 0;
  const volatilityWeight = fingerprint ? Math.max(0.5, 1 - fingerprint.unsubscribeStdDev * 10) : 0.8;
  const sampleWeight     = n < 5 ? 0.6 : 1.0;
  const w1 = volatilityWeight * 0.35, w2 = 0.25, w3 = sampleWeight * 0.25, w4 = 0.15;
  const wSum = w1 + w2 + w3 + w4;
  const velocityRaw = (stream1 * w1 + stream2 * w2 + stream3 * w3 + stream4 * w4) / wSum;
  let estimate = 0, uncertainty = 1;
  const processNoise = 0.1, measurementNoise = 0.3;
  for (let i = 0; i < n - 1; i++) {
    const measurement = (unsubRates[i + 1] - unsubRates[i]) / (baseline + 0.001);
    uncertainty += processNoise;
    const gain = uncertainty / (uncertainty + measurementNoise);
    estimate   += gain * (measurement - estimate);
    uncertainty *= (1 - gain);
  }
  const velocity = (velocityRaw + estimate) / 2;
  let direction;
  if      (velocity >  0.5) direction = 'Rapid decline';
  else if (velocity >  0.1) direction = 'Declining';
  else if (velocity < -0.1) direction = 'Improving';
  else                      direction = 'Stable';
  return { velocity: r4(velocity), direction, magnitude: r4(Math.abs(velocity)) };
}

// ─────────────────────────────────────────────
// ALGORITHM 3 — CAMPAIGN IMPACT SCORER
// ─────────────────────────────────────────────

function algorithm3_campaignImpact(campaign, allCampaigns, fingerprint) {
  if (!fingerprint) return null;
  const baseline   = fingerprint.baselineUnsubscribeRate;
  const stddev     = fingerprint.unsubscribeStdDev || 0.001;
  const volumeSent = campaign.volume_sent || 1000;
  const unsubRate  = campaign.unsubscribe_count / volumeSent;
  const zScore     = (unsubRate - baseline) / (stddev + 0.0001);
  const idx        = allCampaigns.findIndex(c => c.date === campaign.date && c.campaign_name === campaign.campaign_name);
  const preCampaigns  = idx > 0 ? allCampaigns.slice(Math.max(0, idx - 3), idx) : [];
  const postCampaigns = idx >= 0 ? allCampaigns.slice(idx + 1, idx + 4) : [];
  const preAvg  = preCampaigns.length  ? mean_arr(preCampaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1)))  : baseline;
  const postAvg = postCampaigns.length ? mean_arr(postCampaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1))) : unsubRate;
  const residualImpact = (postAvg - preAvg) / (baseline + 0.0001);
  const halfLife       = fingerprint.recoveryHalfLife || 3;
  const recoveryDays   = zScore > 0 ? Math.round(zScore * halfLife * 7) : 0;
  const impactScore    = -(zScore * 0.7 + residualImpact * 0.3);
  let category, reason;
  if      (impactScore >  1.0) { category = 'Built trust';    reason = 'Unsubscribe rate significantly below this segment\'s normal — strong positive signal.'; }
  else if (impactScore >  0.2) { category = 'Built trust';    reason = 'Slightly below-average unsubscribes — mild positive effect on the relationship.'; }
  else if (impactScore > -0.3) { category = 'Neutral';        reason = 'Campaign performed within normal range for this segment — no significant relationship change.'; }
  else if (impactScore > -1.0) { category = 'Caused fatigue'; reason = `Unsubscribe rate ${r2(Math.abs(zScore))} standard deviations above this segment\'s baseline. Audience showing mild fatigue.`; }
  else                         { category = 'Damaged';        reason = `Unsubscribe rate ${r2(Math.abs(zScore))} standard deviations above baseline — significant relationship damage. Estimated ${recoveryDays} days to recover.`; }
  const typeMap = {
    'Promotional':   'Promotional campaigns typically cause more unsubscribes — this was higher than your normal promotional baseline.',
    'Newsletter':    'Unusual for a newsletter — this unsubscribe pattern suggests content or frequency mismatch.',
    'Re-engagement': 'Re-engagement campaigns often spike unsubscribes — this was above even that elevated baseline.',
    'Transactional': 'Unexpected unsubscribes from transactional sends — worth reviewing whether this was truly transactional.',
  };
  if ((category === 'Damaged' || category === 'Caused fatigue') && typeMap[campaign.campaign_type]) {
    reason += ' ' + typeMap[campaign.campaign_type];
  }
  return { impactScore: r4(impactScore), zScore: r4(zScore), residualImpact: r4(residualImpact), recoveryDaysEstimated: recoveryDays, category, reason };
}

// ─────────────────────────────────────────────
// ALGORITHM 4 — FREQUENCY TOLERANCE MODEL
// ─────────────────────────────────────────────

function algorithm4_frequencyTolerance(campaigns, fingerprint) {
  if (!fingerprint) return { toleranceRemaining: 3, optimalNextSend: null, recommendedType: 'Newsletter' };
  const now             = new Date();
  const thirtyDaysAgo   = new Date(+now - 30 * 86400000);
  const recentCampaigns = campaigns.filter(c => new Date(c.date) >= thirtyDaysAgo);
  const threshold       = fingerprint.frequencyToleranceThreshold || 4;
  const recentOpenRates = recentCampaigns.map(c => c.open_rate).filter(r => r !== null);
  let engagementMultiplier = 1.0;
  if (recentOpenRates.length && fingerprint.baselineOpenRate) {
    const avgRecent = mean_arr(recentOpenRates);
    engagementMultiplier = Math.max(0.5, Math.min(1.5, avgRecent / fingerprint.baselineOpenRate));
  }
  const typeWeights    = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.2, 'Transactional': 0.3 };
  const effectiveSends = recentCampaigns.reduce((s, c) => s + (typeWeights[c.campaign_type] || 1.0), 0);
  const adjustedThresh = threshold * engagementMultiplier;
  const toleranceRemaining = Math.max(0, Math.round(adjustedThresh - effectiveSends));
  const lastSend     = campaigns.length ? new Date(campaigns[campaigns.length - 1].date) : now;
  const recoveryDays = fingerprint.recoveryHalfLife ? fingerprint.recoveryHalfLife * 3.5 : 7;
  const minGap       = toleranceRemaining > 2 ? 3 : Math.round(recoveryDays);
  const optDate      = new Date(+lastSend + minGap * 86400000);
  const optimalNextSend = optDate.toISOString().slice(0, 10);
  let recommendedType = 'Newsletter';
  if      (toleranceRemaining <= 1) recommendedType = 'Transactional';
  else if (toleranceRemaining <= 2) recommendedType = 'Newsletter';
  else if (engagementMultiplier > 1.1) recommendedType = 'Promotional';
  return { toleranceRemaining, optimalNextSend, recommendedType, recentSendCount: recentCampaigns.length, adjustedThreshold: r2(adjustedThresh) };
}

// ─────────────────────────────────────────────
// ALGORITHM 5 — AUDIENCE SENTIMENT INFERENCE ENGINE
// v6.1: Rewritten to use relationship capital as a hard differentiator.
// Capital score breaks tie-breaking between segments with similar
// velocity — high-capital Recovering ≠ low-capital Recovering.
// Statements now lead with implication, not label.
// Commercial and regulatory angle both surfaced per state.
// ─────────────────────────────────────────────

function algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, recentImpacts, capital) {
  // capital: relationship capital score -100 to +100 from algorithm 7
  const cap = capital || 0;

  if (!fingerprint) {
    return {
      state: 'Neutral',
      statement: 'Upload your send history to see how this audience is really responding.',
      statementCommercial: 'Without campaign history we cannot calculate frequency tolerance or predict unsubscribe risk for your next send.',
      statementRegulatory: null,
      confidence: 0.3,
      regulatoryNote: null,
      action: 'Start by uploading a CSV with date, segment name, and unsubscribe count.',
    };
  }

  const direction    = trustVelocity.direction;
  const tolerance    = freqTolerance.toleranceRemaining;
  const recentDamage = recentImpacts.filter(i => i.category === 'Damaged' || i.category === 'Caused fatigue').length;
  const recentBuilt  = recentImpacts.filter(i => i.category === 'Built trust').length;
  const hasComplaints  = recentImpacts.some(i => i._hasComplaints);
  const n              = fingerprint.campaignCount;
  const baseConf       = Math.min(0.5 + n * 0.04, 0.95);
  const urgencyPattern = recentImpacts.some(i => i._isUrgency);
  const pricingPattern = recentImpacts.some(i => i._isPricing);
  const recoveryDays   = Math.round((fingerprint.recoveryHalfLife || 3) * 7);
  const baseline       = fingerprint.baselineUnsubscribeRate || 0.002;
  const baselinePct    = (baseline * 100).toFixed(2);

  // ── COMPLAINT RISK — highest priority ──────────────────────
  if (hasComplaints && (direction === 'Rapid decline' || direction === 'Declining')) {
    const conf = r2(Math.min(baseConf, 0.92));
    return {
      state: 'Complaint risk',
      statement: 'This segment is generating complaint signals alongside a rising unsubscribe trend. If this continues, you are likely to receive a formal ICO complaint.',
      statementCommercial: 'Audiences in complaint territory stop converting first — expect revenue from this segment to drop significantly before any formal action.',
      statementRegulatory: 'Rapid unsubscribe acceleration combined with complaint signals is the pattern the ICO sees before opening enforcement investigations under PECR Regulation 22.',
      confidence: conf,
      regulatoryNote: 'This pattern is statistically associated with formal ICO complaints. The window to act without enforcement consequences is short — typically 30–60 days.',
      action: 'Stop all promotional sends to this segment immediately. Run a re-permission campaign — anyone who does not re-consent should be moved to your suppression list.',
    };
  }

  // ── DAMAGED — rapid decline, multiple bad sends ─────────────
  if (direction === 'Rapid decline' && recentDamage >= 2) {
    const conf = r2(Math.min(baseConf, 0.88));
    const capContext = cap < 0
      ? 'The negative relationship capital means this segment has little goodwill left to absorb further sends.'
      : 'Some positive relationship capital remains — recovery is possible if you act now.';
    return {
      state: 'Damaged',
      statement: `Recent sends have caused measurable damage to this segment. Unsubscribes are accelerating — your normal baseline is ${baselinePct}% but recent sends are significantly above that.`,
      statementCommercial: `You have approximately ${recoveryDays} days before this segment becomes effectively unreachable for promotional sends. ${capContext}`,
      statementRegulatory: urgencyPattern ? 'The unsubscribe spike following an urgency or scarcity campaign matches the pattern seen before ASA complaints about high-pressure tactics. Review any countdown timers or "limited time" claims before your next send.' : null,
      confidence: conf,
      regulatoryNote: urgencyPattern ? 'ASA upheld multiple complaints against Wowcher (2019, 2024) for countdown timers that reset. If your recent sends included urgency claims, review them against CAP Code 3.7.' : null,
      action: `Pause all promotional sends for at least ${recoveryDays} days. Send one low-key value-add newsletter only. Do not send promotional content until unsubscribes return to your ${baselinePct}% baseline.`,
    };
  }

  // ── FATIGUE BUILDING — declining + tolerance exhausted ──────
  if (direction === 'Declining' && tolerance <= 1) {
    const conf = r2(Math.min(baseConf, 0.85));
    return {
      state: 'Fatigue building',
      statement: `You have sent ${freqTolerance.recentSendCount} campaigns to this segment in the last 30 days and tolerance is nearly exhausted. The next promotional send is likely to spike unsubscribes.`,
      statementCommercial: 'Fatigued audiences stop opening first, then start unsubscribing. Open rates will continue to drop even if you reduce frequency — the damage takes 3–4 weeks to reverse.',
      statementRegulatory: 'High frequency combined with declining engagement is the pattern the ICO describes as the point where legitimate interest no longer passes the proportionality test. Your audience is signalling the contact is no longer welcome.',
      confidence: conf,
      regulatoryNote: cap < -20 ? 'With negative relationship capital and frequency-driven fatigue, this segment is approaching the ICO’s threshold for legitimate interest challenges. Documented send frequency and audience response rates would be requested in any investigation.' : null,
      action: `No promotional sends this month. Switch to one newsletter maximum. Give this segment a ${recoveryDays}-day gap before any commercial content.`,
    };
  }

  // ── COOLING — declining but tolerance not yet exhausted ──────
  if (direction === 'Declining' && tolerance > 1) {
    const conf = r2(Math.min(baseConf, 0.78));
    return {
      state: 'Cooling',
      statement: `Engagement from this segment has been declining steadily over your last ${Math.min(n, 6)} campaigns. Unsubscribes are trending up, though you still have ${tolerance} send${tolerance !== 1 ? 's' : ''} of tolerance remaining.`,
      statementCommercial: 'Cooling audiences convert at a fraction of their peak rate. Sending more will accelerate the decline — the opportunity is to reverse it now while they are still reachable.',
      statementRegulatory: pricingPattern ? 'Audiences that disengage after pricing or promotional emails frequently cite misleading expectations as the reason. This is the consumer sentiment the CMA monitors under DMCCA 2024.' : null,
      confidence: conf,
      regulatoryNote: null,
      action: 'Review the content and subject lines from your last three sends. Try a preference-update or feedback email — ask them what they want to hear about. One re-engagement send before resuming your normal schedule.',
    };
  }

  // ── PEAK RECEPTIVENESS — improving + tolerance + recent wins ─
  if (direction === 'Improving' && tolerance >= 3 && recentBuilt >= 2) {
    const conf = r2(Math.min(baseConf, 0.88));
    return {
      state: 'Peak receptiveness',
      statement: `This segment is in its best state in recent history — ${recentBuilt} consecutive positive campaigns, improving trust velocity, and ${tolerance} sends of remaining tolerance.`,
      statementCommercial: 'This is the highest-conversion window in your send cycle. Promotional campaigns sent now will perform measurably better than the same campaign sent after this window closes.',
      statementRegulatory: null,
      confidence: conf,
      regulatoryNote: null,
      action: 'Send your highest-value promotional or product announcement campaign now. Do not delay — this window typically lasts 2–3 weeks before tolerance starts recovering.',
    };
  }

  // ── RECOVERING — capital-differentiated ────────────────────
  // This is where the old version produced identical outputs.
  // We now split by capital score: strong / moderate / fragile recovery.
  if ((direction === 'Improving' || direction === 'Stable') && recentDamage >= 1 && recentBuilt >= 1) {
    const conf = r2(Math.min(baseConf, 0.78));

    if (cap >= 40) {
      // Strong capital — recovery is real and accelerating
      return {
        state: 'Recovering',
        statement: `This segment was damaged by recent sends but strong relationship capital (+${cap.toFixed(0)}/100) is cushioning the recovery. The goodwill built over time is working in your favour.`,
        statementCommercial: 'High capital means this audience is more forgiving than their recent behaviour suggests. A well-timed value send could accelerate recovery significantly.',
        statementRegulatory: null,
        confidence: conf,
        regulatoryNote: null,
        action: `Send one value-first newsletter — no promotional content. If unsubscribes stay below ${baselinePct}%, you can resume normal sending in ${Math.round(recoveryDays * 0.6)} days.`,
      };
    } else if (cap >= 10) {
      // Moderate capital — cautious recovery
      return {
        state: 'Recovering',
        statement: `This segment is showing early signs of recovery after recent damage, but relationship capital (+${cap.toFixed(0)}/100) is moderate — it will not absorb another poor send.`,
        statementCommercial: 'Revenue from this segment will return, but slowly. One badly timed promotional send now could push it back into damaged territory.',
        statementRegulatory: null,
        confidence: conf,
        regulatoryNote: null,
        action: `Continue low-frequency, high-value sends only for the next ${recoveryDays} days. No promotional campaigns. Monitor unsubscribes on every send — if they spike above ${(baseline * 150).toFixed(2)}% stop immediately.`,
      };
    } else {
      // Low or negative capital — fragile recovery
      const capStr = cap < 0 ? `${cap.toFixed(0)}` : `+${cap.toFixed(0)}`;
      return {
        state: 'Recovering',
        statement: `This segment is showing the early mathematical signs of recovery, but relationship capital (${capStr}/100) is low — the goodwill buffer is thin and another damaging send could cause lasting harm.`,
        statementCommercial: 'Low capital recoveries are fragile. This segment needs significantly more positive campaign history before it will convert at normal rates again.',
        statementRegulatory: cap < 0 ? 'Negative relationship capital combined with a recovery pattern is a signal the ICO and ASA would note as evidence of repeated audience harm if they reviewed your send history.' : null,
        confidence: r2(conf * 0.9),
        regulatoryNote: cap < -20 ? 'With negative capital, your send history would show a pattern of repeated audience damage. If the ICO reviewed your legitimate interest basis, this history would be relevant.' : null,
        action: `Do not send anything to this segment for at least ${recoveryDays} days. When you resume, start with a single newsletter only and monitor closely. Rebuild capital with 3–4 positive sends before attempting any promotional campaign.`,
      };
    }
  }

  // ── HIGHLY RECEPTIVE POST-GAP ───────────────────────────────
  if (direction === 'Stable' && tolerance >= 4 && recentDamage === 0) {
    const conf = r2(Math.min(baseConf, 0.72));
    const capContext = cap >= 30
      ? `Strong relationship capital (+${cap.toFixed(0)}/100) means this segment is well-disposed toward your brand.`
      : cap <= 0
      ? 'Relationship capital is low — consider a value-add send before going promotional.'
      : `Positive relationship capital (+${cap.toFixed(0)}/100) gives you a good foundation.`;
    return {
      state: 'Highly receptive post-gap',
      statement: `No damage signals detected and ${tolerance} sends of remaining tolerance. ${capContext}`,
      statementCommercial: 'Stable audiences with send capacity remaining are the safest window for promotional campaigns — low risk of unsubscribes, predictable conversion.',
      statementRegulatory: null,
      confidence: conf,
      regulatoryNote: null,
      action: cap >= 20
        ? 'Good window for newsletter or light promotional. Consider a product announcement or re-engagement offer.'
        : 'Start with a value-add newsletter. If response is positive, follow with a promotional send within 7–10 days.',
    };
  }

  // ── NEUTRAL DEFAULT ─────────────────────────────────────────
  const capNote = cap > 20
    ? `Relationship capital is positive (+${cap.toFixed(0)}/100) — your audience is broadly well-disposed.`
    : cap < -10
    ? `Relationship capital is negative (${cap.toFixed(0)}/100) — worth reviewing recent campaign performance before sending.`
    : 'Relationship capital is neutral.';

  return {
    state: 'Neutral',
    statement: `No strong trend signals in either direction after ${n} campaign${n !== 1 ? 's' : ''}. ${capNote}`,
    statementCommercial: 'Neutral state means your audience is neither primed nor fatigued — sends should perform at your historical average rates.',
    statementRegulatory: null,
    confidence: r2(Math.min(baseConf, 0.65)),
    regulatoryNote: null,
    action: 'Proceed with your planned campaign. Monitor unsubscribes on the next send — if they spike above 0.5% above your baseline, run the pre-send check before the following campaign.',
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 6 — PREDICTIVE SEND MODELLER (Monte Carlo)
// ─────────────────────────────────────────────

function algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance) {
  if (!fingerprint) return { verdict: 'Amber', confidence: 0.5, reason: 'Not enough historical data to predict impact. Proceed cautiously.', alternatives: [], predictedUnsubRange: null };
  const baseline       = fingerprint.baselineUnsubscribeRate;
  const stddev         = fingerprint.unsubscribeStdDev;
  const typeWeights    = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.3, 'Transactional': 0.3 };
  const typeMultiplier = typeWeights[campaignType] || 1.0;
  const gapFactor      = Math.max(0.7, 1 - (freqTolerance.recentSendCount > 0 ? 7 : 30) / 90);
  const velAdjust      = 1 + trustVelocity.velocity * 0.3;
  const expectedRate   = baseline * typeMultiplier * gapFactor * Math.max(0.5, velAdjust);
  const results = [];
  for (let i = 0; i < 1000; i++) results.push(Math.max(0, expectedRate + gaussianRandom(0, stddev)));
  results.sort((a, b) => a - b);
  const p10 = results[100], p50 = results[500], p90 = results[900];
  const spikeProb = results.filter(r => r > baseline * 1.5).length / 1000;
  let verdict, reason, confidence;
  if (spikeProb < 0.15 && freqTolerance.toleranceRemaining > 1) {
    verdict    = 'Green';
    reason     = `Low risk. Predicted unsubscribe rate ${(p50*100).toFixed(2)}%–${(p90*100).toFixed(2)}% — within normal range for this segment.`;
    confidence = r2(0.85 - spikeProb);
  } else if (spikeProb < 0.4 || freqTolerance.toleranceRemaining === 1) {
    verdict    = 'Amber';
    reason     = `Moderate risk. ${Math.round(spikeProb*100)}% chance of above-baseline unsubscribes. Tolerance window is low.`;
    confidence = r2(0.7 - spikeProb * 0.3);
  } else {
    verdict    = 'Red';
    reason     = `High risk. ${Math.round(spikeProb*100)}% chance of unsubscribe spike. Current segment state not ready for ${campaignType} send.`;
    confidence = r2(0.9 - spikeProb * 0.2);
  }
  const alternatives = [];
  if (verdict !== 'Green') {
    const safestType = freqTolerance.recommendedType;
    if (safestType !== campaignType) alternatives.push({ change: `Switch to ${safestType}`, reason: `${safestType} sends are less likely to cause unsubscribes for this segment right now.` });
    alternatives.push({ change: `Send on ${freqTolerance.optimalNextSend} instead`, reason: 'Waiting for the tolerance window to recover would significantly reduce spike probability.' });
    alternatives.push({ change: 'Test with 30% of the segment first', reason: 'A smaller send lets you measure response before committing the full list.' });
  }
  return { verdict, confidence, reason, predictedUnsubRange: { low: r4(p10), mid: r4(p50), high: r4(p90) }, spikeProb: r2(spikeProb), alternatives };
}

// ─────────────────────────────────────────────
// ALGORITHM 7 — RELATIONSHIP CAPITAL ACCUMULATOR
// ─────────────────────────────────────────────

function algorithm7_relationshipCapital(campaigns, fingerprint) {
  if (!fingerprint || !campaigns.length) return 0;
  const decayHalfLife = 60;
  const now           = new Date();
  const baseline      = fingerprint.baselineUnsubscribeRate;
  let capital = 0;
  for (const c of campaigns) {
    const daysAgo     = (+now - new Date(c.date)) / 86400000;
    const decayFactor = Math.pow(0.5, daysAgo / decayHalfLife);
    const rate        = c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1);
    const impactRaw   = (baseline - rate) / (baseline + 0.001) * 20;
    const recoveryBonus = capital < -20 && impactRaw > 0 ? impactRaw * 0.5 : 0;
    capital += (impactRaw + recoveryBonus) * decayFactor;
    capital  = sigmoidBound(capital, 100);
  }
  return r2(Math.max(-100, Math.min(100, capital)));
}

// ─────────────────────────────────────────────
// MISSING DATA MESSAGES
// ─────────────────────────────────────────────

function missingDataMessages(hasOpenRates, hasClickRates, hasComplaints, hasSendHistory) {
  const messages = [];
  if (!hasSendHistory) messages.push({ field: 'Send history', message: 'Add volume sent per campaign and we can calculate exactly how many more times you can contact this segment before they start unsubscribing.', algorithmsUnlocked: [1, 3, 4] });
  if (!hasOpenRates)   messages.push({ field: 'Open rates',   message: 'Add open rates and we can build a full engagement decay curve — showing whether your audience\'s interest is growing or shrinking, and how fast.', algorithmsUnlocked: [1] });
  if (!hasClickRates)  messages.push({ field: 'Click rates',  message: 'Click rates reveal how many opens translate to real interest. Add them and we can separate passive openers from genuinely engaged subscribers.', algorithmsUnlocked: [1] });
  if (!hasComplaints)  messages.push({ field: 'Complaint and spam data', message: 'Complaints carry 50× the weight of an unsubscribe in the Trust Velocity model. Adding them makes sentiment inference significantly more accurate.', algorithmsUnlocked: [2] });
  return messages;
}

// ─────────────────────────────────────────────
// FIX RECORD GENERATION — via generate-fix.js
// v6.0: writes to Compliance_Fixes via the endpoint.
// Uses v6.0 fix type taxonomy. Legacy map in generate-fix.js
// handles any types that need remapping.
// Only generates fixes for high-confidence negative states.
// ─────────────────────────────────────────────

async function generateFixes(userId, segmentName, sentiment, sourceRecordId) {
  const fixes = [];
  const { state, confidence, regulatoryNote } = sentiment;

  // Only generate fixes for states that represent genuine compliance risk
  // and only when confidence is sufficient to avoid noise.
  if (state === 'Complaint risk' && confidence >= 0.7) {
    fixes.push({
      fixType:    'consent_missing',
      description: `Audience Read — ${segmentName}: Complaint risk detected. ${sentiment.statement} ${regulatoryNote || ''}`.trim(),
      severity:   'critical',
    });
  }

  if (state === 'Fatigue building' && confidence >= 0.7) {
    fixes.push({
      fixType:    'legitimate_interest_abuse',
      description: `Audience Read — ${segmentName}: Send frequency is building fatigue. ${regulatoryNote || 'High frequency combined with declining engagement is the pattern that precedes ICO legitimate interest challenges.'}`.trim(),
      severity:   'high',
    });
  }

  if (state === 'Damaged' && regulatoryNote && confidence >= 0.7) {
    fixes.push({
      fixType:    'data_quality',
      description: `Audience Read — ${segmentName}: Campaign damage detected. ${regulatoryNote}`.trim(),
      severity:   'medium',
    });
  }

  // Call generate-fix.js for each fix — correct table, correct fields,
  // correct null stripping. All awaited before returning.
  for (const fix of fixes) {
    try {
      await fetch(`${APP_URL}/api/generate-fix`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId,
          fixType:        fix.fixType,
          description:    fix.description,
          tool:           'Audience Read',
          severity:       fix.severity,
          sourceRecordId: sourceRecordId || null,
        }),
      });
    } catch (err) {
      // Non-fatal — log and continue
      console.error(`generate-fix failed for ${fix.fixType} (${segmentName}):`, err);
    }
  }
}

// ─────────────────────────────────────────────
// SEND-ALERT for audience_damaged
// v6.0: wired up for states that warrant an email alert.
// Uses the existing audience_damaged alert type in data.js.
// ─────────────────────────────────────────────

async function maybeFireAudienceAlert(userId, segmentName, sentiment) {
  const alertStates = ['Complaint risk', 'Damaged'];
  if (!alertStates.includes(sentiment.state)) return;
  try {
    await fetch(`${APP_URL}/api/data?action=send-alert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userId,
        alertType:      'audience_damaged',
        segmentName,
        sentimentState: sentiment.state,
        regulatoryNote: sentiment.regulatoryNote || null,
      }),
    });
  } catch (err) {
    // Non-fatal — alert failure should never break the upload response
    console.error('audience_damaged alert failed (non-fatal):', err);
  }
}

// ─────────────────────────────────────────────
// SEGMENT/CAMPAIGN AIRTABLE OPERATIONS
// ─────────────────────────────────────────────

async function upsertSegment(userId, segmentName, data) {
  const records = await atGet(
    'Audience_Read_Segments',
    `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`,
    '', 1
  );
  const fields = {
    UserID:                 userId,
    SegmentName:            segmentName,
    FingerprintJSON:        JSON.stringify(data.fingerprint),
    TrustVelocity:          data.trustVelocity.velocity,
    TrustVelocityDirection: data.trustVelocity.direction,
    RelationshipCapital:    data.relationshipCapital,
    FrequencyTolerance:     data.freqTolerance.toleranceRemaining,
    OptimalNextSendDate:    data.freqTolerance.optimalNextSend,
    SentimentState:         data.sentiment.state,
    SentimentConfidence:    data.sentiment.confidence,
    LastUpdated:            new Date().toISOString().slice(0, 10),
    CampaignCount:          data.fingerprint?.campaignCount || 0,
    DataQuality:            data.dataQuality,
  };
  if (records.length) await atPatch('Audience_Read_Segments', records[0].id, fields);
  else                await atCreate('Audience_Read_Segments', fields);
}

async function saveCampaign(userId, segmentName, campaign, impact) {
  await atCreate('Audience_Read_Campaigns', {
    UserID:                userId,
    SegmentName:           segmentName,
    CampaignName:          campaign.campaign_name || 'Untitled Campaign',
    CampaignType:          campaign.campaign_type || null,
    SendDate:              campaign.date,
    VolumeSent:            campaign.volume_sent   || null,
    UnsubscribeCount:      campaign.unsubscribe_count || 0,
    OpenRate:              campaign.open_rate     || null,
    ClickRate:             campaign.click_rate    || null,
    ComplaintCount:        campaign.complaint_count || null,
    ImpactScore:           impact?.impactScore    || null,
    ImpactCategory:        impact?.category       || null,
    ImpactReason:          impact?.reason         || null,
    RecoveryDaysEstimated: impact?.recoveryDaysEstimated || null,
  });
}

async function loadCampaigns(userId) {
  const records = await atGet(
    'Audience_Read_Campaigns',
    `{UserID}="${userId}"`,
    'sort[0][field]=SendDate&sort[0][direction]=asc',
    500
  );
  return records.map(r => ({
    segment:           r.fields.SegmentName,
    campaign_name:     r.fields.CampaignName,
    campaign_type:     r.fields.CampaignType,
    date:              r.fields.SendDate,
    volume_sent:       r.fields.VolumeSent      || null,
    unsubscribe_count: r.fields.UnsubscribeCount || 0,
    open_rate:         r.fields.OpenRate         || null,
    click_rate:        r.fields.ClickRate        || null,
    complaint_count:   r.fields.ComplaintCount   || null,
    _impactCategory:   r.fields.ImpactCategory,
    _impactReason:     r.fields.ImpactReason,
  }));
}

// ─────────────────────────────────────────────
// RUN ALL ALGORITHMS FOR ONE SEGMENT
// ─────────────────────────────────────────────

function runAlgorithms(campaigns) {
  const fingerprint   = algorithm1_fingerprint(campaigns);
  const trustVelocity = algorithm2_trustVelocity(campaigns, fingerprint);
  const freqTolerance = algorithm4_frequencyTolerance(campaigns, fingerprint);
  const impacts       = campaigns.map(c => {
    const imp = algorithm3_campaignImpact(c, campaigns, fingerprint);
    return imp ? { ...imp, campaign_name: c.campaign_name, date: c.date } : null;
  }).filter(Boolean);
  const capital   = algorithm7_relationshipCapital(campaigns, fingerprint);
  const sentiment = algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, impacts, capital);

  const hasOpenRates   = campaigns.some(c => c.open_rate !== null);
  const hasClickRates  = campaigns.some(c => c.click_rate !== null);
  const hasComplaints  = campaigns.some(c => c.complaint_count !== null && c.complaint_count > 0);
  const hasSendHistory = campaigns.some(c => c.volume_sent !== null);

  let dataQuality = 'Minimal';
  if (hasSendHistory && hasOpenRates)                              dataQuality = 'Partial';
  if (hasSendHistory && hasOpenRates && hasClickRates && hasComplaints) dataQuality = 'Full';

  return {
    fingerprint, trustVelocity, freqTolerance, sentiment,
    capital, impacts: impacts.slice(-10), dataQuality,
    missingData: missingDataMessages(hasOpenRates, hasClickRates, hasComplaints, hasSendHistory),
  };
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const action = req.query.action || req.body?.action || 'load';

  try {

    // ── detect ──────────────────────────────────────────────
    if (action === 'detect') {
      const { headers, rows } = req.body;
      if (!headers || !rows) return res.status(400).json({ error: 'headers and rows required' });
      return res.status(200).json({ success: true, mapping: autoMapColumns(headers, rows) });
    }

    // ── load ────────────────────────────────────────────────
    if (action === 'load') {
      const allCampaigns = await loadCampaigns(userId);
      const segmentData  = buildSegmentData(allCampaigns);
      const results      = {};
      for (const [seg, campaigns] of Object.entries(segmentData)) {
        results[seg] = runAlgorithms(campaigns);
      }
      const recommendations = Object.entries(results)
        .sort((a, b) => {
          const p = { 'Complaint risk': 5, 'Damaged': 4, 'Fatigue building': 3, 'Cooling': 2, 'Recovering': 1 };
          return (p[b[1].sentiment.state] || 0) - (p[a[1].sentiment.state] || 0);
        })
        .slice(0, 3)
        .map(([seg, data]) => ({
          segment: seg,
          action:  data.sentiment.action,
          type:    data.freqTolerance.recommendedType,
          date:    data.freqTolerance.optimalNextSend,
          state:   data.sentiment.state,
          capital: data.capital,
        }));
      return res.status(200).json({ success: true, segments: results, recommendations });
    }

    // ── upload ──────────────────────────────────────────────
    if (action === 'upload') {
      const { rows, fieldMapping } = req.body;
      if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

      const rawRows = rows.map(row => {
        const c = {
          segment: null, date: null, unsubscribe_count: null,
          volume_sent: null, open_rate: null, click_rate: null,
          complaint_count: null, campaign_name: null, campaign_type: null,
        };
        for (const [header, targetField] of Object.entries(fieldMapping || {})) {
          const val = row[header];
          if      (targetField === 'date')              c.date              = normaliseDate(val);
          else if (targetField === 'segment')           c.segment           = String(val || '').trim() || null;
          else if (targetField === 'unsubscribe_count') c.unsubscribe_count = val !== '' && val != null ? (parseInt(val) || 0) : null;
          else if (targetField === 'volume_sent')       c.volume_sent       = val !== '' && val != null ? (parseInt(val) || null) : null;
          else if (targetField === 'open_rate')         c.open_rate         = normaliseRate(val);
          else if (targetField === 'click_rate')        c.click_rate        = normaliseRate(val);
          else if (targetField === 'complaint_count')   c.complaint_count   = val !== '' && val != null ? (parseInt(val) || null) : null;
          else if (targetField === 'campaign_name')     c.campaign_name     = String(val || '').trim() || null;
          else if (targetField === 'campaign_type')     c.campaign_type     = String(val || '').trim() || null;
        }
        return c;
      }).filter(c => c.date);

      // Merge rows by date + segment — keep best data from each source
      const mergeMap = {};
      for (const row of rawRows) {
        const key = (row.date || '') + '|' + (row.segment || 'Default');
        if (!mergeMap[key]) {
          mergeMap[key] = {
            segment: row.segment || 'Default', date: row.date,
            unsubscribe_count: 0, volume_sent: null, open_rate: null,
            click_rate: null, complaint_count: null, campaign_name: null, campaign_type: null,
          };
        }
        const m = mergeMap[key];
        if (row.segment)                    m.segment           = row.segment;
        if (row.unsubscribe_count !== null) m.unsubscribe_count = row.unsubscribe_count;
        if (row.volume_sent !== null)       m.volume_sent       = row.volume_sent;
        if (row.open_rate !== null)         m.open_rate         = row.open_rate;
        if (row.click_rate !== null)        m.click_rate        = row.click_rate;
        if (row.complaint_count !== null)   m.complaint_count   = row.complaint_count;
        if (row.campaign_name)              m.campaign_name     = row.campaign_name;
        if (row.campaign_type)             m.campaign_type     = row.campaign_type;
      }
      const campaigns = Object.values(mergeMap);
      if (!campaigns.length) return res.status(400).json({ error: 'No valid rows found. Ensure a date column is present and mapped.' });

      const segmentGroups = buildSegmentData(campaigns);
      const savedSegments = {};

      // Process each segment — all awaited before response
      for (const [segmentName, segCampaigns] of Object.entries(segmentGroups)) {
        const data = runAlgorithms(segCampaigns);

        // Save campaigns sequentially — Vercel Hobby safe
        for (const c of segCampaigns) {
          const impact = algorithm3_campaignImpact(c, segCampaigns, data.fingerprint);
          await saveCampaign(userId, segmentName, c, impact);
        }

        // Save segment state
        await upsertSegment(userId, segmentName, {
          fingerprint:       data.fingerprint,
          trustVelocity:     data.trustVelocity,
          freqTolerance:     data.freqTolerance,
          sentiment:         data.sentiment,
          relationshipCapital: data.capital,
          dataQuality:       data.dataQuality,
        });

        // Generate fix records via generate-fix.js (correct table + fields)
        const segRecord = await atGet(
          'Audience_Read_Segments',
          `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`,
          '', 1
        );
        const segRecordId = segRecord[0]?.id || null;
        await generateFixes(userId, segmentName, data.sentiment, segRecordId);

        // Fire audience_damaged alert if warranted
        await maybeFireAudienceAlert(userId, segmentName, data.sentiment);

        savedSegments[segmentName] = { ...data, impacts: data.impacts.slice(-5) };
      }

      return res.status(200).json({ success: true, segments: savedSegments, campaignsSaved: campaigns.length });
    }

    // ── log ─────────────────────────────────────────────────
    if (action === 'log') {
      const { campaign } = req.body;
      if (!campaign?.date || !campaign?.segment) return res.status(400).json({ error: 'campaign with date and segment required' });

      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = [...allCampaigns.filter(c => c.segment === campaign.segment), campaign]
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const data   = runAlgorithms(segCampaigns);
      const impact = algorithm3_campaignImpact(campaign, segCampaigns, data.fingerprint);

      await saveCampaign(userId, campaign.segment, campaign, impact);
      await upsertSegment(userId, campaign.segment, {
        fingerprint:        data.fingerprint,
        trustVelocity:      data.trustVelocity,
        freqTolerance:      data.freqTolerance,
        sentiment:          data.sentiment,
        relationshipCapital: data.capital,
        dataQuality:        data.dataQuality,
      });

      // Generate fixes and alert on single log too
      await generateFixes(userId, campaign.segment, data.sentiment, null);
      await maybeFireAudienceAlert(userId, campaign.segment, data.sentiment);

      return res.status(200).json({
        success: true,
        impact,
        sentiment:    data.sentiment,
        trustVelocity: data.trustVelocity,
        capital:       data.capital,
        freqTolerance: data.freqTolerance,
      });
    }

    // ── presend ─────────────────────────────────────────────
    if (action === 'presend') {
      const { segment, campaignType, sendDate } = req.body;
      if (!segment || !campaignType) return res.status(400).json({ error: 'segment and campaignType required' });
      const allCampaigns  = await loadCampaigns(userId);
      const segCampaigns  = allCampaigns.filter(c => c.segment === segment);
      const fingerprint   = algorithm1_fingerprint(segCampaigns);
      const trustVelocity = algorithm2_trustVelocity(segCampaigns, fingerprint);
      const freqTolerance = algorithm4_frequencyTolerance(segCampaigns, fingerprint);
      const prediction    = algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance);
      return res.status(200).json({ success: true, prediction });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('audience-read error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// MATH UTILITIES
// ─────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function mean_arr(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function secondDerivative(arr) {
  if (arr.length < 3) return 0;
  const d1 = arr.slice(1).map((v, i) => v - arr[i]);
  const d2 = d1.slice(1).map((v, i) => v - d1[i]);
  return mean_arr(d2);
}
function pearsonCorrelation(xArr, yArr) {
  const n = Math.min(xArr.length, yArr.length);
  if (n < 2) return 0;
  const xMean = mean_arr(xArr.slice(0, n)), yMean = mean_arr(yArr.slice(0, n));
  let num = 0, xSq = 0, ySq = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - xMean, dy = yArr[i] - yMean;
    num += dx * dy; xSq += dx * dx; ySq += dy * dy;
  }
  const den = Math.sqrt(xSq * ySq);
  return den === 0 ? 0 : num / den;
}
function gaussianRandom(mean, std) {
  const u1 = Math.random(), u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}
function sigmoidBound(x, cap) { return cap * (2 / (1 + Math.exp(-x / (cap * 0.3))) - 1); }
function dataCompletenessScore(campaigns) {
  const hasOpen  = campaigns.some(c => c.open_rate !== null);
  const hasClick = campaigns.some(c => c.click_rate !== null);
  const hasCom   = campaigns.some(c => c.complaint_count !== null);
  const hasVol   = campaigns.some(c => c.volume_sent !== null);
  if (hasVol && hasOpen && hasClick && hasCom) return 'Full';
  if (hasVol && hasOpen)                       return 'Partial';
  return 'Minimal';
}
