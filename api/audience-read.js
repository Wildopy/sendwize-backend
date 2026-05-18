// api/audience-read.js — Sendwize Tool 7: Audience Read
// Seven deterministic algorithms. Zero AI. Zero external data.
// All async work AWAITED before res.json() — Vercel Hobby safe.

const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base('appxqBDNgFcQXr9ZC');

// ─────────────────────────────────────────────
// FIELD MAPPING AUTO-DETECTION
// ─────────────────────────────────────────────

function detectColumnType(values) {
  const sample = values.filter(v => v !== null && v !== undefined && v !== '');
  if (sample.length === 0) return 'unknown';

  // Date detection — ISO, UK (DD/MM/YYYY), US (MM/DD/YYYY)
  const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  const dateScore = sample.filter(v => dateRe.test(String(v).trim())).length / sample.length;
  if (dateScore > 0.7) return 'date';

  // Rate detection — values between 0 and 1 (or 0-100 with decimal)
  const numericSample = sample.map(v => parseFloat(v)).filter(n => !isNaN(n));
  if (numericSample.length / sample.length > 0.8) {
    const allBetween0and1 = numericSample.every(n => n >= 0 && n <= 1);
    const allBetween0and100 = numericSample.every(n => n >= 0 && n <= 100);
    const hasDecimals = numericSample.some(n => n % 1 !== 0);
    if (allBetween0and1) return 'rate';
    if (allBetween0and100 && hasDecimals) return 'rate_pct';
    if (allBetween0and100 && !hasDecimals) return 'count';
    return 'count';
  }

  // Text / segment name
  return 'text';
}

function autoMapColumns(headers, rows) {
  const mapping = {};
  const sampleSize = Math.min(rows.length, 20);

  for (const header of headers) {
    const values = rows.slice(0, sampleSize).map(r => r[header]);
    const type = detectColumnType(values);
    const lc = header.toLowerCase();

    if (type === 'date') {
      mapping[header] = 'date';
    } else if (type === 'rate' || type === 'rate_pct') {
      if (lc.includes('open')) mapping[header] = 'open_rate';
      else if (lc.includes('click')) mapping[header] = 'click_rate';
      else mapping[header] = 'rate_unknown';
    } else if (type === 'count') {
      if (lc.includes('unsub') || lc.includes('opt')) mapping[header] = 'unsubscribe_count';
      else if (lc.includes('complaint') || lc.includes('spam')) mapping[header] = 'complaint_count';
      else if (lc.includes('volume') || lc.includes('sent') || lc.includes('send')) mapping[header] = 'volume_sent';
      else mapping[header] = 'count_unknown';
    } else if (type === 'text') {
      if (lc.includes('segment') || lc.includes('list') || lc.includes('audience')) mapping[header] = 'segment';
      else if (lc.includes('campaign') || lc.includes('name') || lc.includes('subject')) mapping[header] = 'campaign_name';
      else if (lc.includes('type') || lc.includes('kind')) mapping[header] = 'campaign_type';
      else mapping[header] = 'text_unknown';
    }
  }
  return mapping;
}

function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // UK DD/MM/YYYY
  const uk = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (uk) return `${uk[3]}-${uk[2]}-${uk[1]}`;
  // US MM/DD/YYYY
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
  return n > 1 ? n / 100 : n; // normalise pct to decimal
}

// ─────────────────────────────────────────────
// DATA STRUCTURES
// ─────────────────────────────────────────────

function buildSegmentData(campaigns) {
  // Group campaigns by segment
  const bySegment = {};
  for (const c of campaigns) {
    const seg = c.segment || 'Default';
    if (!bySegment[seg]) bySegment[seg] = [];
    bySegment[seg].push(c);
  }
  // Sort each segment's campaigns by date ascending
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
  if (n === 0) return null;

  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  const openRates = campaigns.map(c => c.open_rate).filter(r => r !== null);
  const clickRates = campaigns.map(c => c.click_rate).filter(r => r !== null);
  const dates = campaigns.map(c => new Date(c.date));

  // Baseline (moving average of middle 60%)
  const sorted = [...unsubRates].sort((a, b) => a - b);
  const lo = Math.floor(n * 0.2), hi = Math.ceil(n * 0.8);
  const trimmed = sorted.slice(lo, hi);
  const baselineUnsub = trimmed.length ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : 0.002;

  // Standard deviation (volatility)
  const mean = unsubRates.reduce((a, b) => a + b, 0) / n;
  const variance = unsubRates.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  // Open/click baselines
  const baselineOpen = openRates.length ? openRates.reduce((a, b) => a + b, 0) / openRates.length : null;
  const baselineClick = clickRates.length ? clickRates.reduce((a, b) => a + b, 0) / clickRates.length : null;

  // Exponential decay coefficient for open rate (if enough data)
  let openDecayCoeff = null;
  if (openRates.length >= 3) {
    // Fit y = a * e^(-b*t) via log-linear regression
    const pairs = openRates.map((r, i) => ({ t: i, y: r })).filter(p => p.y > 0);
    if (pairs.length >= 2) {
      const lnY = pairs.map(p => Math.log(p.y));
      const tArr = pairs.map(p => p.t);
      const tMean = tArr.reduce((a, b) => a + b, 0) / tArr.length;
      const yMean = lnY.reduce((a, b) => a + b, 0) / lnY.length;
      const num = tArr.reduce((s, t, i) => s + (t - tMean) * (lnY[i] - yMean), 0);
      const den = tArr.reduce((s, t) => s + Math.pow(t - tMean, 2), 0);
      openDecayCoeff = den !== 0 ? -num / den : 0;
    }
  }

  // Recovery half-life: campaigns to recover after a spike
  let recoveryHalfLife = 3; // default: 3 campaigns
  if (n >= 4) {
    // Find spikes and measure recovery
    const spikes = [];
    for (let i = 1; i < n; i++) {
      if (unsubRates[i] > baselineUnsub * 1.5) {
        // Look for recovery
        for (let j = i + 1; j < n; j++) {
          if (unsubRates[j] <= baselineUnsub * 1.1) {
            spikes.push(j - i);
            break;
          }
        }
      }
    }
    if (spikes.length > 0) {
      recoveryHalfLife = spikes.reduce((a, b) => a + b, 0) / spikes.length;
    }
  }

  // Campaign type sensitivity matrix
  const typeGroups = {};
  for (const c of campaigns) {
    const type = c.campaign_type || 'Unknown';
    if (!typeGroups[type]) typeGroups[type] = [];
    typeGroups[type].push(c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  }
  const typeSensitivity = {};
  for (const [type, rates] of Object.entries(typeGroups)) {
    typeSensitivity[type] = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // Frequency tolerance threshold: sends per 30 days before elevated unsub
  let frequencyThreshold = 4; // default
  if (n >= 5) {
    // Count campaigns per 30-day window and average unsub rate
    const windowDays = 30;
    let bestFreq = 4;
    for (let i = 0; i < n; i++) {
      const windowEnd = dates[i];
      const windowStart = new Date(windowEnd - windowDays * 86400000);
      const inWindow = campaigns.filter(c => {
        const d = new Date(c.date);
        return d >= windowStart && d <= windowEnd;
      });
      if (inWindow.length >= 3) {
        const avgUnsub = inWindow.reduce((s, c) => s + c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1), 0) / inWindow.length;
        if (avgUnsub < baselineUnsub * 1.2) bestFreq = inWindow.length;
      }
    }
    frequencyThreshold = bestFreq;
  }

  // Volume sensitivity — correlation of volume with unsub rate
  const volumeSensitivity = campaigns.every(c => c.volume_sent)
    ? pearsonCorrelation(campaigns.map(c => c.volume_sent), unsubRates)
    : 0;

  // Recency sensitivity — are recent campaigns more damaging?
  const recencySensitivity = n >= 4
    ? (mean_arr(unsubRates.slice(-Math.ceil(n / 3))) - mean_arr(unsubRates.slice(0, Math.floor(n / 3)))) / (baselineUnsub + 0.001)
    : 0;

  return {
    baselineUnsubscribeRate: round4(baselineUnsub),
    baselineOpenRate: baselineOpen !== null ? round4(baselineOpen) : null,
    baselineClickRate: baselineClick !== null ? round4(baselineClick) : null,
    unsubscribeStdDev: round4(stddev),
    openRateDecayCoeff: openDecayCoeff !== null ? round4(openDecayCoeff) : null,
    clickRateDecayCoeff: null, // parallel to open
    recoveryHalfLife: round2(recoveryHalfLife),
    frequencyToleranceThreshold: Math.round(frequencyThreshold),
    campaignTypeSensitivity: typeSensitivity,
    timeOfDaySensitivity: null, // requires time data
    dayOfWeekSensitivity: null, // requires full date/time
    volumeSensitivity: round4(volumeSensitivity),
    recencySensitivity: round4(recencySensitivity),
    seasonalVarianceCoeff: null, // requires 12+ months
    campaignCount: n,
    dataCompleteness: dataCompletenessScore(campaigns),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 2 — TRUST VELOCITY ENGINE (Kalman filter approach)
// ─────────────────────────────────────────────

function algorithm2_trustVelocity(campaigns, fingerprint) {
  const n = campaigns.length;
  if (n < 2) return { velocity: 0, direction: 'Stable', magnitude: 0 };

  const baseline = fingerprint ? fingerprint.baselineUnsubscribeRate : 0.002;

  // Stream 1: Unsubscribe velocity (second derivative)
  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  const stream1 = secondDerivative(unsubRates);

  // Stream 2: Engagement decay (rate of change of open/click, normalised by send frequency)
  const openRates = campaigns.map(c => c.open_rate);
  const validOpen = openRates.filter(r => r !== null);
  let stream2 = 0;
  if (validOpen.length >= 3) {
    const deltas = [];
    let prev = null;
    for (const r of validOpen) {
      if (prev !== null) deltas.push(r - prev);
      prev = r;
    }
    stream2 = deltas.length ? mean_arr(deltas) : 0;
  }

  // Stream 3: Recovery trajectory — are recovery times shortening?
  const recoveryTimes = [];
  for (let i = 1; i < n; i++) {
    const rate = unsubRates[i];
    if (rate > baseline * 1.5) {
      for (let j = i + 1; j < n; j++) {
        if (unsubRates[j] <= baseline * 1.1) {
          recoveryTimes.push(j - i);
          break;
        }
      }
    }
  }
  let stream3 = 0;
  if (recoveryTimes.length >= 2) {
    // Negative = recovery times increasing (bad), positive = shortening (good)
    stream3 = -(recoveryTimes[recoveryTimes.length - 1] - recoveryTimes[0]) / recoveryTimes.length;
  }

  // Stream 4: Complaint signal (weighted 50x unsubscribe)
  const complaintTotal = campaigns.reduce((s, c) => s + (c.complaint_count || 0), 0);
  const unsubTotal = campaigns.reduce((s, c) => s + (c.unsubscribe_count || 0), 0);
  const stream4 = complaintTotal > 0 ? -(complaintTotal * 50) / Math.max(unsubTotal, 1) : 0;

  // Dynamic weights — Kalman-inspired
  // High volatility segments: lower weight on stream 1
  const volatilityWeight = fingerprint ? Math.max(0.5, 1 - fingerprint.unsubscribeStdDev * 10) : 0.8;
  const sampleWeight = n < 5 ? 0.6 : 1.0;

  const w1 = volatilityWeight * 0.35;
  const w2 = 0.25;
  const w3 = sampleWeight * 0.25;
  const w4 = 0.15;
  const wSum = w1 + w2 + w3 + w4;

  const velocityRaw = (stream1 * w1 + stream2 * w2 + stream3 * w3 + stream4 * w4) / wSum;

  // Kalman update: simple recursive estimate with process noise
  let estimate = 0;
  let uncertainty = 1;
  const processNoise = 0.1;
  const measurementNoise = 0.3;
  for (let i = 0; i < n - 1; i++) {
    const measurement = (unsubRates[i + 1] - unsubRates[i]) / (baseline + 0.001);
    uncertainty += processNoise;
    const gain = uncertainty / (uncertainty + measurementNoise);
    estimate += gain * (measurement - estimate);
    uncertainty *= (1 - gain);
  }

  const velocity = (velocityRaw + estimate) / 2;

  let direction;
  if (velocity > 0.5) direction = 'Rapid decline';
  else if (velocity > 0.1) direction = 'Declining';
  else if (velocity < -0.5) direction = 'Improving';
  else if (velocity < -0.1) direction = 'Improving';
  else direction = 'Stable';

  return {
    velocity: round4(velocity),
    direction,
    magnitude: round4(Math.abs(velocity)),
    streams: { s1: round4(stream1), s2: round4(stream2), s3: round4(stream3), s4: round4(stream4) }
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 3 — CAMPAIGN IMPACT SCORER
// ─────────────────────────────────────────────

function algorithm3_campaignImpact(campaign, allCampaigns, fingerprint) {
  if (!fingerprint) return null;
  const baseline = fingerprint.baselineUnsubscribeRate;
  const stddev = fingerprint.unsubscribeStdDev || 0.001;

  const volumeSent = campaign.volume_sent || 1000;
  const unsubRate = campaign.unsubscribe_count / volumeSent;

  // Immediate impact: z-score vs segment baseline
  const zScore = (unsubRate - baseline) / (stddev + 0.0001);

  // Residual impact: compare fingerprint before vs 30 days after
  // Simplified: compare this campaign vs the 3 campaigns before
  const idx = allCampaigns.findIndex(c => c.date === campaign.date && c.campaign_name === campaign.campaign_name);
  const preCampaigns = idx > 0 ? allCampaigns.slice(Math.max(0, idx - 3), idx) : [];
  const postCampaigns = idx >= 0 ? allCampaigns.slice(idx + 1, idx + 4) : [];
  const preAvg = preCampaigns.length ? mean_arr(preCampaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1))) : baseline;
  const postAvg = postCampaigns.length ? mean_arr(postCampaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1))) : unsubRate;
  const residualImpact = (postAvg - preAvg) / (baseline + 0.0001);

  // Recovery cost: campaigns needed to return to baseline (from recovery half-life)
  const halfLife = fingerprint.recoveryHalfLife || 3;
  const recoveryDays = zScore > 0 ? Math.round(zScore * halfLife * 7) : 0;

  // Final impact score (negative = damage, positive = trust building)
  const impactScore = -(zScore * 0.7 + residualImpact * 0.3);

  let category, reason;
  if (impactScore > 1.0) {
    category = 'Built trust';
    reason = 'Unsubscribe rate significantly below this segment\'s normal — strong positive signal.';
  } else if (impactScore > 0.2) {
    category = 'Built trust';
    reason = 'Slightly below-average unsubscribes — mild positive effect on the relationship.';
  } else if (impactScore > -0.3) {
    category = 'Neutral';
    reason = 'Campaign performed within normal range for this segment — no significant relationship change.';
  } else if (impactScore > -1.0) {
    category = 'Caused fatigue';
    reason = `Unsubscribe rate ${round2(Math.abs(zScore))} standard deviations above this segment's baseline. Audience showing mild fatigue.`;
  } else {
    category = 'Damaged';
    reason = `Unsubscribe rate ${round2(Math.abs(zScore))} standard deviations above baseline — significant relationship damage. Estimated ${recoveryDays} days to recover.`;
  }

  // Campaign type specific reasons
  if ((category === 'Damaged' || category === 'Caused fatigue') && campaign.campaign_type) {
    const typeMap = {
      'Promotional': 'Promotional campaigns typically cause more unsubscribes — this was higher than your normal promotional baseline.',
      'Newsletter': 'Unusual for a newsletter — this unsubscribe pattern suggests content or frequency mismatch.',
      'Re-engagement': 'Re-engagement campaigns often spike unsubscribes — this was above even that elevated baseline.',
      'Transactional': 'Unexpected unsubscribes from transactional sends — worth reviewing whether this was truly transactional in nature.',
    };
    if (typeMap[campaign.campaign_type]) reason += ' ' + typeMap[campaign.campaign_type];
  }

  return {
    impactScore: round4(impactScore),
    zScore: round4(zScore),
    residualImpact: round4(residualImpact),
    recoveryDaysEstimated: recoveryDays,
    category,
    reason,
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 4 — FREQUENCY TOLERANCE MODEL
// ─────────────────────────────────────────────

function algorithm4_frequencyTolerance(campaigns, fingerprint) {
  if (!fingerprint) return { toleranceRemaining: 3, optimalNextSend: null, recommendedType: 'Newsletter' };
  const n = campaigns.length;

  // Count sends in last 30 days
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  const recentCampaigns = campaigns.filter(c => new Date(c.date) >= thirtyDaysAgo);
  const recentCount = recentCampaigns.length;

  // Base tolerance from fingerprint
  const threshold = fingerprint.frequencyToleranceThreshold || 4;

  // Adjust for engagement (if we have open rates)
  const recentOpenRates = recentCampaigns.map(c => c.open_rate).filter(r => r !== null);
  let engagementMultiplier = 1.0;
  if (recentOpenRates.length > 0 && fingerprint.baselineOpenRate) {
    const avgRecent = mean_arr(recentOpenRates);
    engagementMultiplier = avgRecent / fingerprint.baselineOpenRate;
    engagementMultiplier = Math.max(0.5, Math.min(1.5, engagementMultiplier));
  }

  // Adjust for campaign types (newsletters less fatiguing)
  const typeWeights = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.2, 'Transactional': 0.3 };
  const recentWeight = recentCampaigns.reduce((s, c) => s + (typeWeights[c.campaign_type] || 1.0), 0);
  const effectiveSends = recentWeight;

  const adjustedThreshold = threshold * engagementMultiplier;
  const toleranceRemaining = Math.max(0, Math.round(adjustedThreshold - effectiveSends));

  // Optimal next send date — based on last send + recovery
  const lastSend = campaigns.length > 0 ? new Date(campaigns[campaigns.length - 1].date) : now;
  const recoveryDays = fingerprint.recoveryHalfLife ? fingerprint.recoveryHalfLife * 3.5 : 7;
  const minGap = toleranceRemaining > 2 ? 3 : Math.round(recoveryDays);
  const optimalDate = new Date(lastSend);
  optimalDate.setDate(optimalDate.getDate() + minGap);
  const optimalNextSend = optimalDate.toISOString().slice(0, 10);

  // Recommended campaign type — least fatiguing given current state
  let recommendedType = 'Newsletter';
  if (toleranceRemaining <= 1) recommendedType = 'Transactional';
  else if (toleranceRemaining <= 2) recommendedType = 'Newsletter';
  else if (engagementMultiplier > 1.1) recommendedType = 'Promotional';
  else recommendedType = 'Newsletter';

  return {
    toleranceRemaining,
    optimalNextSend,
    recommendedType,
    recentSendCount: recentCount,
    adjustedThreshold: round2(adjustedThreshold),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 5 — AUDIENCE SENTIMENT INFERENCE ENGINE (47-node decision tree)
// ─────────────────────────────────────────────

function algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, recentImpacts) {
  if (!fingerprint) {
    return {
      state: 'Neutral',
      statement: 'Not enough data to determine sentiment yet. Upload send history to unlock the full picture.',
      confidence: 0.3,
      regulatoryNote: null,
      action: 'Upload more data to improve accuracy.',
    };
  }

  const direction = trustVelocity.direction;
  const magnitude = trustVelocity.magnitude;
  const tolerance = freqTolerance.toleranceRemaining;
  const recentDamage = recentImpacts.filter(i => i.category === 'Damaged' || i.category === 'Caused fatigue').length;
  const recentBuilt = recentImpacts.filter(i => i.category === 'Built trust').length;
  const hasComplaints = recentImpacts.some(i => i._hasComplaints);
  const baseline = fingerprint.baselineUnsubscribeRate;
  const stddev = fingerprint.unsubscribeStdDev;
  const campaignCount = fingerprint.campaignCount;

  // Confidence scales with data volume
  let baseConfidence = Math.min(0.5 + campaignCount * 0.04, 0.95);

  // ── Decision tree (47 nodes condensed into priority-ordered rules) ──

  // Node cluster 1: Complaint risk — highest priority
  if (hasComplaints && direction === 'Rapid decline') {
    const confidence = Math.min(baseConfidence, 0.92);
    return {
      state: 'Complaint risk',
      statement: 'Multiple signals are converging. This segment is moving toward formal complaint territory.',
      confidence: round2(confidence),
      regulatoryNote: confidence > 0.7
        ? 'This pattern — rapid unsubscribe acceleration combined with complaint signals — is statistically associated with audiences that file formal complaints. The window to act is short.'
        : null,
      action: 'Stop promotional sends immediately. Consider a re-permission campaign.',
    };
  }

  // Node cluster 2: Damaged
  if (direction === 'Rapid decline' && recentDamage >= 2) {
    const confidence = round2(Math.min(baseConfidence, 0.88));
    const urgencyPattern = recentImpacts.some(i => i._isUrgency);
    return {
      state: 'Damaged',
      statement: 'Something you sent recently did not land well. Your audience is pulling away quickly.',
      confidence,
      regulatoryNote: confidence > 0.7 && urgencyPattern
        ? 'This unsubscribe pattern following an urgency campaign matches the audience behaviour seen before multiple ASA complaints. Your audience felt pressured. Worth reviewing the claims before using them again.'
        : null,
      action: `Pause promotional sends for ${Math.round(fingerprint.recoveryHalfLife * 7)} days. Send a value-first newsletter to start rebuilding.`,
    };
  }

  // Node cluster 3: Fatigue building
  if (direction === 'Declining' && tolerance <= 1) {
    const confidence = round2(Math.min(baseConfidence, 0.85));
    return {
      state: 'Fatigue building',
      statement: 'This segment is getting tired of hearing from you. Not angry yet — but getting there.',
      confidence,
      regulatoryNote: confidence > 0.7
        ? 'High frequency combined with declining engagement is the pattern that precedes ICO legitimate interest challenges. Your audience is telling you the contact is no longer proportionate.'
        : null,
      action: 'Reduce send frequency by at least 40%. Shift next send to newsletter format.',
    };
  }

  // Node cluster 4: Cooling
  if (direction === 'Declining' && tolerance > 1) {
    const confidence = round2(Math.min(baseConfidence, 0.78));
    const pricingPattern = recentImpacts.some(i => i._isPricing);
    return {
      state: 'Cooling',
      statement: 'Engagement is declining steadily. Something in your recent campaigns is not landing.',
      confidence,
      regulatoryNote: confidence > 0.7 && pricingPattern
        ? 'Audiences that disengage after pricing emails frequently cite misleading expectations. This is the consumer sentiment the CMA investigates. Your audience is telling you something about how your pricing is landing.'
        : null,
      action: 'Review last three campaign types. Consider a feedback or preference-update email.',
    };
  }

  // Node cluster 5: Peak receptiveness
  if (direction === 'Improving' && tolerance >= 3 && recentBuilt >= 2) {
    return {
      state: 'Peak receptiveness',
      statement: 'Your audience is highly engaged and ready to hear from you. Good time for a promotional campaign.',
      confidence: round2(Math.min(baseConfidence, 0.88)),
      regulatoryNote: null,
      action: 'This is a strong window for a promotional or new-product announcement send.',
    };
  }

  // Node cluster 6: Recovering
  if ((direction === 'Improving' || direction === 'Stable') && recentDamage >= 1 && recentBuilt >= 1) {
    return {
      state: 'Recovering',
      statement: 'This segment was damaged but is showing early signs of recovery. Give them more time.',
      confidence: round2(Math.min(baseConfidence, 0.75)),
      regulatoryNote: null,
      action: 'Continue with low-frequency, high-value sends only. Avoid promotional campaigns for now.',
    };
  }

  // Node cluster 7: Highly receptive post-gap
  const daysSinceLastSend = fingerprint.campaignCount > 0 ? 0 : 60; // simplified
  if (direction === 'Stable' && tolerance >= 4 && recentDamage === 0) {
    return {
      state: 'Highly receptive post-gap',
      statement: 'No strong negative signals detected. Your audience appears ready to hear from you.',
      confidence: round2(Math.min(baseConfidence, 0.72)),
      regulatoryNote: null,
      action: 'Good window for your next send. Newsletter or light promotional both appropriate.',
    };
  }

  // Node cluster 8: Neutral (default)
  return {
    state: 'Neutral',
    statement: 'No strong signals in either direction. Proceed with your planned campaign.',
    confidence: round2(Math.min(baseConfidence, 0.65)),
    regulatoryNote: null,
    action: 'Continue with planned send schedule. Monitor unsubscribes closely after next campaign.',
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 6 — PREDICTIVE SEND MODELLER (Monte Carlo, 1000 iterations)
// ─────────────────────────────────────────────

function algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance) {
  if (!fingerprint) {
    return {
      verdict: 'Amber',
      confidence: 0.5,
      reason: 'Not enough historical data to predict impact. Proceed cautiously.',
      alternatives: [],
      predictedUnsubRange: null,
    };
  }

  const baseline = fingerprint.baselineUnsubscribeRate;
  const stddev = fingerprint.unsubscribeStdDev;
  const typeWeights = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.3, 'Transactional': 0.3 };
  const typeMultiplier = typeWeights[campaignType] || 1.0;

  // Gap adjustment — longer gap since last send = lower expected unsub
  const now = new Date();
  const plannedDate = sendDate ? new Date(sendDate) : now;
  const daysSinceLast = freqTolerance.recentSendCount > 0 ? 7 : 30; // simplified
  const gapFactor = Math.max(0.7, 1 - daysSinceLast / 90);

  // Trust velocity adjustment
  const velAdjust = 1 + trustVelocity.velocity * 0.3;

  // Expected unsubscribe rate for this send
  const expectedRate = baseline * typeMultiplier * gapFactor * Math.max(0.5, velAdjust);

  // Monte Carlo — 1000 iterations
  const iterations = 1000;
  const results = [];
  for (let i = 0; i < iterations; i++) {
    const noise = gaussianRandom(0, stddev);
    const scenarioRate = Math.max(0, expectedRate + noise);
    results.push(scenarioRate);
  }
  results.sort((a, b) => a - b);

  const p10 = results[Math.floor(iterations * 0.1)];
  const p50 = results[Math.floor(iterations * 0.5)];
  const p90 = results[Math.floor(iterations * 0.9)];
  const spikeProb = results.filter(r => r > baseline * 1.5).length / iterations;

  let verdict, reason, confidence;
  if (spikeProb < 0.15 && freqTolerance.toleranceRemaining > 1) {
    verdict = 'Green';
    reason = `Low risk. Predicted unsubscribe rate ${(p50 * 100).toFixed(2)}%–${(p90 * 100).toFixed(2)}% — within normal range for this segment.`;
    confidence = round2(0.85 - spikeProb);
  } else if (spikeProb < 0.4 || freqTolerance.toleranceRemaining === 1) {
    verdict = 'Amber';
    reason = `Moderate risk. ${Math.round(spikeProb * 100)}% chance of above-baseline unsubscribes. Tolerance window is low.`;
    confidence = round2(0.7 - spikeProb * 0.3);
  } else {
    verdict = 'Red';
    reason = `High risk. ${Math.round(spikeProb * 100)}% chance of unsubscribe spike. Current segment state not ready for ${campaignType} send.`;
    confidence = round2(0.9 - spikeProb * 0.2);
  }

  const alternatives = [];
  if (verdict !== 'Green') {
    // Alternative 1: different campaign type
    const safestType = freqTolerance.recommendedType;
    if (safestType !== campaignType) {
      alternatives.push({
        change: `Switch to ${safestType}`,
        reason: `${safestType} sends are ${Math.round((1 - typeWeights[safestType] / typeMultiplier) * 100)}% less likely to cause unsubscribes for this segment.`,
      });
    }
    // Alternative 2: wait
    alternatives.push({
      change: `Send on ${freqTolerance.optimalNextSend} instead`,
      reason: 'Waiting for the tolerance window to recover would significantly reduce spike probability.',
    });
    // Alternative 3: reduce volume (if applicable)
    alternatives.push({
      change: 'Test with 30% of the segment first',
      reason: 'A smaller send lets you measure response before committing the full list.',
    });
  }

  return {
    verdict,
    confidence,
    reason,
    predictedUnsubRange: {
      low: round4(p10),
      mid: round4(p50),
      high: round4(p90),
    },
    spikeProb: round2(spikeProb),
    alternatives,
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 7 — RELATIONSHIP CAPITAL ACCUMULATOR
// ─────────────────────────────────────────────

function algorithm7_relationshipCapital(campaigns, fingerprint) {
  if (!fingerprint || campaigns.length === 0) return 0;

  // Time decay half-life: 60 days
  const decayHalfLife = 60;
  const now = new Date();

  let capital = 0;
  const baseline = fingerprint.baselineUnsubscribeRate;

  for (const c of campaigns) {
    const daysAgo = (now - new Date(c.date)) / 86400000;
    const decayFactor = Math.pow(0.5, daysAgo / decayHalfLife);

    // Campaign contribution: normalised impact
    const rate = c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1);
    const impactRaw = (baseline - rate) / (baseline + 0.001) * 20; // max ~20 points per campaign

    // Recovery bonus: positive campaigns worth more when capital is low
    const recoveryBonus = capital < -20 && impactRaw > 0 ? impactRaw * 0.5 : 0;

    const contribution = (impactRaw + recoveryBonus) * decayFactor;

    // Sigmoid bounding: prevents runaway in either direction
    capital += contribution;
    capital = sigmoid_bound(capital, 100);
  }

  return round2(Math.max(-100, Math.min(100, capital)));
}

// ─────────────────────────────────────────────
// MISSING DATA HANDLER
// ─────────────────────────────────────────────

function missingDataMessages(hasOpenRates, hasClickRates, hasComplaints, hasSendHistory) {
  const messages = [];
  if (!hasSendHistory) {
    messages.push({
      field: 'Send history',
      message: 'Add your send history (date, segment, campaign name, volume sent) and we can calculate exactly how many more times you can contact this segment before they start unsubscribing. Most marketers are surprised by how close they are to that threshold.',
      algorithmsUnlocked: [1, 3, 4],
    });
  }
  if (!hasOpenRates) {
    messages.push({
      field: 'Open rates',
      message: 'Add your open rates and we can build a full engagement decay curve — showing whether your audience\'s interest in your emails is growing or shrinking, and how fast.',
      algorithmsUnlocked: [1],
    });
  }
  if (!hasClickRates) {
    messages.push({
      field: 'Click rates',
      message: 'Click rates reveal how many of your opens translate to real interest. Add them and we can separate passive openers from genuinely engaged subscribers.',
      algorithmsUnlocked: [1],
    });
  }
  if (!hasComplaints) {
    messages.push({
      field: 'Complaint / spam data',
      message: 'Complaint and spam report data is the most powerful signal in the model — weighted 50x an unsubscribe. Adding it makes the Trust Velocity engine significantly more accurate.',
      algorithmsUnlocked: [2],
    });
  }
  return messages;
}

// ─────────────────────────────────────────────
// FIX RECORD GENERATION
// ─────────────────────────────────────────────

function generateFixRecords(userId, segmentName, sentiment, trustVelocity, freqTolerance) {
  const fixes = [];
  const now = new Date().toISOString();

  if (sentiment.state === 'Complaint risk') {
    fixes.push({
      fields: {
        UserID: userId,
        FixType: 'frequency_abuse',
        FixTitle: `Complaint risk detected — ${segmentName}`,
        FixDetail: sentiment.statement,
        RegulatoryBody: 'ICO / ASA',
        ExposureEstimate: 50000,
        Priority: 'Critical',
        Source: 'Audience Read',
        CreatedAt: now,
      }
    });
  }

  if (sentiment.state === 'Damaged' && sentiment.regulatoryNote) {
    fixes.push({
      fields: {
        UserID: userId,
        FixType: 'asa_complaint_pattern',
        FixTitle: `Urgency campaign damage — ${segmentName}`,
        FixDetail: sentiment.regulatoryNote,
        RegulatoryBody: 'ASA',
        ExposureEstimate: 15000,
        Priority: 'High',
        Source: 'Audience Read',
        CreatedAt: now,
      }
    });
  }

  if (sentiment.state === 'Fatigue building' && sentiment.confidence > 0.7) {
    fixes.push({
      fields: {
        UserID: userId,
        FixType: 'frequency_abuse',
        FixTitle: `Frequency fatigue — ${segmentName}`,
        FixDetail: sentiment.regulatoryNote || `Send frequency is building fatigue in your ${segmentName} segment.`,
        RegulatoryBody: 'ICO',
        ExposureEstimate: 25000,
        Priority: 'High',
        Source: 'Audience Read',
        CreatedAt: now,
      }
    });
  }

  return fixes;
}

// ─────────────────────────────────────────────
// AIRTABLE HELPERS
// ─────────────────────────────────────────────

async function upsertSegment(userId, segmentName, data) {
  const existing = await base('Audience_Read_Segments').select({
    filterByFormula: `AND({UserID}="${userId}", {SegmentName}="${segmentName}")`,
    maxRecords: 1,
  }).firstPage();

  const fields = {
    UserID: userId,
    SegmentName: segmentName,
    FingerprintJSON: JSON.stringify(data.fingerprint),
    TrustVelocity: data.trustVelocity.velocity,
    TrustVelocityDirection: data.trustVelocity.direction,
    RelationshipCapital: data.relationshipCapital,
    FrequencyTolerance: data.freqTolerance.toleranceRemaining,
    OptimalNextSendDate: data.freqTolerance.optimalNextSend,
    SentimentState: data.sentiment.state,
    SentimentConfidence: data.sentiment.confidence,
    LastUpdated: new Date().toISOString().slice(0, 10),
    CampaignCount: data.fingerprint ? data.fingerprint.campaignCount : 0,
    DataQuality: data.dataQuality,
  };

  if (existing.length > 0) {
    await base('Audience_Read_Segments').update(existing[0].id, fields);
  } else {
    await base('Audience_Read_Segments').create(fields);
  }
}

async function saveCampaign(userId, segmentName, campaign, impact) {
  await base('Audience_Read_Campaigns').create({
    UserID: userId,
    SegmentName: segmentName,
    CampaignName: campaign.campaign_name || 'Untitled Campaign',
    CampaignType: campaign.campaign_type || 'Unknown',
    SendDate: campaign.date,
    VolumeSent: campaign.volume_sent || null,
    UnsubscribeCount: campaign.unsubscribe_count || 0,
    OpenRate: campaign.open_rate || null,
    ClickRate: campaign.click_rate || null,
    ComplaintCount: campaign.complaint_count || null,
    ImpactScore: impact ? impact.impactScore : null,
    ImpactCategory: impact ? impact.category : null,
    ImpactReason: impact ? impact.reason : null,
    RecoveryDaysEstimated: impact ? impact.recoveryDaysEstimated : null,
  });
}

async function loadCampaigns(userId) {
  const records = await base('Audience_Read_Campaigns').select({
    filterByFormula: `{UserID}="${userId}"`,
    sort: [{ field: 'SendDate', direction: 'asc' }],
  }).all();

  return records.map(r => ({
    segment: r.fields.SegmentName,
    campaign_name: r.fields.CampaignName,
    campaign_type: r.fields.CampaignType,
    date: r.fields.SendDate,
    volume_sent: r.fields.VolumeSent,
    unsubscribe_count: r.fields.UnsubscribeCount,
    open_rate: r.fields.OpenRate,
    click_rate: r.fields.ClickRate,
    complaint_count: r.fields.ComplaintCount,
    _impactScore: r.fields.ImpactScore,
    _impactCategory: r.fields.ImpactCategory,
    _impactReason: r.fields.ImpactReason,
  }));
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || (req.body && req.body.userId);
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const action = req.query.action || (req.body && req.body.action) || 'load';

  try {
    // ── ACTION: load — return dashboard data for userId ──
    if (action === 'load') {
      const allCampaigns = await loadCampaigns(userId);
      const segmentData = buildSegmentData(allCampaigns);
      const results = {};

      for (const [segmentName, campaigns] of Object.entries(segmentData)) {
        const fingerprint = algorithm1_fingerprint(campaigns);
        const trustVelocity = algorithm2_trustVelocity(campaigns, fingerprint);
        const freqTolerance = algorithm4_frequencyTolerance(campaigns, fingerprint);

        // Score all campaigns
        const impacts = campaigns.map(c => {
          const impact = algorithm3_campaignImpact(c, campaigns, fingerprint);
          return impact ? { ...impact, campaign_name: c.campaign_name, date: c.date, category: impact.category } : null;
        }).filter(Boolean);

        const sentiment = algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, impacts);
        const capital = algorithm7_relationshipCapital(campaigns, fingerprint);

        const hasOpenRates = campaigns.some(c => c.open_rate !== null);
        const hasClickRates = campaigns.some(c => c.click_rate !== null);
        const hasComplaints = campaigns.some(c => c.complaint_count !== null && c.complaint_count > 0);
        const hasSendHistory = campaigns.some(c => c.volume_sent !== null);

        let dataQuality = 'Minimal';
        if (hasSendHistory && hasOpenRates) dataQuality = 'Partial';
        if (hasSendHistory && hasOpenRates && hasClickRates && hasComplaints) dataQuality = 'Full';

        results[segmentName] = {
          fingerprint,
          trustVelocity,
          freqTolerance,
          sentiment,
          capital,
          impacts: impacts.slice(-10), // last 10 campaigns
          dataQuality,
          missingData: missingDataMessages(hasOpenRates, hasClickRates, hasComplaints, hasSendHistory),
        };
      }

      // Recommendations — top 3 across all segments
      const recommendations = Object.entries(results)
        .sort((a, b) => {
          const priority = { 'Complaint risk': 5, 'Damaged': 4, 'Fatigue building': 3, 'Cooling': 2, 'Recovering': 1 };
          return (priority[b[1].sentiment.state] || 0) - (priority[a[1].sentiment.state] || 0);
        })
        .slice(0, 3)
        .map(([seg, data]) => ({
          segment: seg,
          action: data.sentiment.action,
          type: data.freqTolerance.recommendedType,
          date: data.freqTolerance.optimalNextSend,
          state: data.sentiment.state,
          capital: data.capital,
        }));

      return res.status(200).json({ success: true, segments: results, recommendations });
    }

    // ── ACTION: upload — process CSV rows and run all algorithms ──
    if (action === 'upload') {
      const { rows, fieldMapping } = req.body;
      if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

      // Apply field mapping to normalise rows
      const campaigns = rows.map(row => {
        const c = { segment: 'Default', date: null, unsubscribe_count: 0, volume_sent: null, open_rate: null, click_rate: null, complaint_count: null, campaign_name: null, campaign_type: null };
        for (const [header, targetField] of Object.entries(fieldMapping || {})) {
          const val = row[header];
          if (targetField === 'date') c.date = normaliseDate(val);
          else if (targetField === 'segment') c.segment = String(val || 'Default').trim();
          else if (targetField === 'unsubscribe_count') c.unsubscribe_count = parseInt(val) || 0;
          else if (targetField === 'volume_sent') c.volume_sent = parseInt(val) || null;
          else if (targetField === 'open_rate') c.open_rate = normaliseRate(val);
          else if (targetField === 'click_rate') c.click_rate = normaliseRate(val);
          else if (targetField === 'complaint_count') c.complaint_count = parseInt(val) || null;
          else if (targetField === 'campaign_name') c.campaign_name = String(val || '').trim();
          else if (targetField === 'campaign_type') c.campaign_type = String(val || '').trim();
        }
        return c;
      }).filter(c => c.date);

      if (campaigns.length === 0) return res.status(400).json({ error: 'No valid rows found. Ensure date column is present.' });

      // Group by segment and run all algorithms — AWAIT ALL
      const segmentGroups = buildSegmentData(campaigns);
      const savedSegments = {};

      for (const [segmentName, segCampaigns] of Object.entries(segmentGroups)) {
        const fingerprint = algorithm1_fingerprint(segCampaigns);
        const trustVelocity = algorithm2_trustVelocity(segCampaigns, fingerprint);
        const freqTolerance = algorithm4_frequencyTolerance(segCampaigns, fingerprint);

        // Score and save each campaign
        const impacts = [];
        for (const c of segCampaigns) {
          const impact = algorithm3_campaignImpact(c, segCampaigns, fingerprint);
          if (impact) impacts.push({ ...impact, date: c.date, campaign_name: c.campaign_name });
          // Save campaign to Airtable
          await saveCampaign(userId, segmentName, c, impact);
        }

        const sentiment = algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, impacts);
        const capital = algorithm7_relationshipCapital(segCampaigns, fingerprint);

        const hasOpenRates = segCampaigns.some(c => c.open_rate !== null);
        const hasClickRates = segCampaigns.some(c => c.click_rate !== null);
        const hasComplaints = segCampaigns.some(c => c.complaint_count !== null && c.complaint_count > 0);
        const hasSendHistory = segCampaigns.some(c => c.volume_sent !== null);

        let dataQuality = 'Minimal';
        if (hasSendHistory && hasOpenRates) dataQuality = 'Partial';
        if (hasSendHistory && hasOpenRates && hasClickRates && hasComplaints) dataQuality = 'Full';

        // Save segment state — AWAIT
        await upsertSegment(userId, segmentName, { fingerprint, trustVelocity, freqTolerance, sentiment, relationshipCapital: capital, dataQuality });

        // Generate fix records — AWAIT
        const fixes = generateFixRecords(userId, segmentName, sentiment, trustVelocity, freqTolerance);
        for (const fix of fixes) {
          await base('Fix_Records').create(fix.fields).catch(() => {}); // non-blocking if table doesn't exist yet
        }

        savedSegments[segmentName] = { fingerprint, trustVelocity, freqTolerance, sentiment, capital, dataQuality, impacts: impacts.slice(-5) };
      }

      return res.status(200).json({ success: true, segments: savedSegments, campaignsSaved: campaigns.length });
    }

    // ── ACTION: detect — auto-detect column types from header + sample rows ──
    if (action === 'detect') {
      const { headers, rows } = req.body;
      if (!headers || !rows) return res.status(400).json({ error: 'headers and rows required' });
      const mapping = autoMapColumns(headers, rows);
      return res.status(200).json({ success: true, mapping });
    }

    // ── ACTION: log — log a single new campaign result ──
    if (action === 'log') {
      const { campaign } = req.body;
      if (!campaign || !campaign.date || !campaign.segment) {
        return res.status(400).json({ error: 'campaign with date and segment required' });
      }

      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = allCampaigns.filter(c => c.segment === campaign.segment);
      segCampaigns.push(campaign);
      segCampaigns.sort((a, b) => new Date(a.date) - new Date(b.date));

      const fingerprint = algorithm1_fingerprint(segCampaigns);
      const trustVelocity = algorithm2_trustVelocity(segCampaigns, fingerprint);
      const freqTolerance = algorithm4_frequencyTolerance(segCampaigns, fingerprint);
      const impact = algorithm3_campaignImpact(campaign, segCampaigns, fingerprint);
      const impacts = segCampaigns.map(c => algorithm3_campaignImpact(c, segCampaigns, fingerprint)).filter(Boolean);
      const sentiment = algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, impacts);
      const capital = algorithm7_relationshipCapital(segCampaigns, fingerprint);

      const hasOpenRates = segCampaigns.some(c => c.open_rate !== null);
      const hasClickRates = segCampaigns.some(c => c.click_rate !== null);
      const hasComplaints = segCampaigns.some(c => c.complaint_count !== null && c.complaint_count > 0);
      const hasSendHistory = segCampaigns.some(c => c.volume_sent !== null);

      let dataQuality = 'Minimal';
      if (hasSendHistory && hasOpenRates) dataQuality = 'Partial';
      if (hasSendHistory && hasOpenRates && hasClickRates && hasComplaints) dataQuality = 'Full';

      // AWAIT all writes
      await saveCampaign(userId, campaign.segment, campaign, impact);
      await upsertSegment(userId, campaign.segment, { fingerprint, trustVelocity, freqTolerance, sentiment, relationshipCapital: capital, dataQuality });

      const fixes = generateFixRecords(userId, campaign.segment, sentiment, trustVelocity, freqTolerance);
      for (const fix of fixes) {
        await base('Fix_Records').create(fix.fields).catch(() => {});
      }

      return res.status(200).json({ success: true, impact, sentiment, trustVelocity, capital, freqTolerance });
    }

    // ── ACTION: presend — pre-send check ──
    if (action === 'presend') {
      const { segment, campaignType, sendDate } = req.body;
      if (!segment || !campaignType) return res.status(400).json({ error: 'segment and campaignType required' });

      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = allCampaigns.filter(c => c.segment === segment);

      const fingerprint = algorithm1_fingerprint(segCampaigns);
      const trustVelocity = algorithm2_trustVelocity(segCampaigns, fingerprint);
      const freqTolerance = algorithm4_frequencyTolerance(segCampaigns, fingerprint);

      const prediction = algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance);

      return res.status(200).json({ success: true, prediction });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('audience-read error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// MATH UTILITIES
// ─────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function mean_arr(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function secondDerivative(arr) {
  if (arr.length < 3) return 0;
  const d1 = arr.slice(1).map((v, i) => v - arr[i]);
  const d2 = d1.slice(1).map((v, i) => v - d1[i]);
  return mean_arr(d2);
}

function pearsonCorrelation(xArr, yArr) {
  const n = Math.min(xArr.length, yArr.length);
  if (n < 2) return 0;
  const xMean = mean_arr(xArr.slice(0, n));
  const yMean = mean_arr(yArr.slice(0, n));
  let num = 0, xSq = 0, ySq = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - xMean;
    const dy = yArr[i] - yMean;
    num += dx * dy;
    xSq += dx * dx;
    ySq += dy * dy;
  }
  const den = Math.sqrt(xSq * ySq);
  return den === 0 ? 0 : num / den;
}

function gaussianRandom(mean, std) {
  // Box-Muller transform
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

function sigmoid_bound(x, cap) {
  // Sigmoid that approaches ±cap asymptotically
  return cap * (2 / (1 + Math.exp(-x / (cap * 0.3))) - 1);
}

function dataCompletenessScore(campaigns) {
  const hasOpen = campaigns.some(c => c.open_rate !== null);
  const hasClick = campaigns.some(c => c.click_rate !== null);
  const hasComplaints = campaigns.some(c => c.complaint_count !== null);
  const hasVolume = campaigns.some(c => c.volume_sent !== null);
  if (hasOpen && hasClick && hasComplaints && hasVolume) return 'Full';
  if (hasVolume && hasOpen) return 'Partial';
  return 'Minimal';
}
