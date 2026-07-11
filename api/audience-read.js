// api/audience-read.js — Sendwize Audience Read v7.0
// Seven deterministic algorithms. Zero AI. Zero external data.
// v7.0: UK benchmark-anchored sentiment. Absolute thresholds.
//       Subscriber loss + £ cost calculation. Fixed column detection.
//       Sector-aware benchmarks. Plain-English output overhauled.

const BASE_ID = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE = `https://api.airtable.com/v0/${BASE_ID}`;
const APP_URL = 'https://sendwize-backend.vercel.app';

const AT_HEADERS = () => ({
  Authorization: `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// ─────────────────────────────────────────────
// UK EMAIL BENCHMARKS
// Sources: GDMA International Email Benchmark 2024, MailerLite 2025,
//          DMA UK Email Benchmarking Report 2025, Klaviyo ecommerce data
// ─────────────────────────────────────────────

const BENCHMARKS = {
  ecommerce: {
    label: 'Ecommerce / Retail',
    unsubGood:      0.001,   // <0.1%
    unsubNormal:    0.003,   // 0.1–0.3% (Klaviyo: 0.20–0.30% median)
    unsubConcern:   0.005,   // 0.3–0.5%
    unsubDamaged:   0.010,   // >1%
    openGood:       0.35,
    openNormal:     0.25,
    openPoor:       0.15,
    clickGood:      0.025,
    clickNormal:    0.015,
    clickPoor:      0.005,
    source: 'Klaviyo 400k campaign analysis + GDMA 2024',
  },
  b2b: {
    label: 'B2B / Professional Services',
    unsubGood:      0.0005,  // <0.05%
    unsubNormal:    0.0015,  // 0.05–0.15% (GDMA: global avg 0.14%)
    unsubConcern:   0.003,
    unsubDamaged:   0.008,
    openGood:       0.30,
    openNormal:     0.20,
    openPoor:       0.12,
    clickGood:      0.030,
    clickNormal:    0.020,
    clickPoor:      0.008,
    source: 'DMA UK 2025 + GDMA International Benchmark 2024',
  },
  saas: {
    label: 'SaaS / Technology',
    unsubGood:      0.0008,
    unsubNormal:    0.002,
    unsubConcern:   0.004,
    unsubDamaged:   0.008,
    openGood:       0.28,
    openNormal:     0.20,
    openPoor:       0.12,
    clickGood:      0.028,
    clickNormal:    0.018,
    clickPoor:      0.006,
    source: 'MailerLite 2025 industry breakdown',
  },
  media: {
    label: 'Media / Publishing / Newsletter',
    unsubGood:      0.001,
    unsubNormal:    0.0022,  // MailerLite 2025 overall median 0.22%
    unsubConcern:   0.005,
    unsubDamaged:   0.010,
    openGood:       0.40,
    openNormal:     0.28,
    openPoor:       0.18,
    clickGood:      0.035,
    clickNormal:    0.020,
    clickPoor:      0.008,
    source: 'MailerLite 2025 + DMA UK 2025',
  },
  charity: {
    label: 'Charity / Non-profit',
    unsubGood:      0.0008,
    unsubNormal:    0.002,
    unsubConcern:   0.004,
    unsubDamaged:   0.008,
    openGood:       0.35,
    openNormal:     0.25,
    openPoor:       0.15,
    clickGood:      0.025,
    clickNormal:    0.015,
    clickPoor:      0.005,
    source: 'DMA UK 2025',
  },
  general: {
    label: 'General / Mixed',
    unsubGood:      0.001,
    unsubNormal:    0.0022, // MailerLite 2025 all-industry median 0.22%
    unsubConcern:   0.005,
    unsubDamaged:   0.010,
    openGood:       0.35,
    openNormal:     0.25,
    openPoor:       0.15,
    clickGood:      0.025,
    clickNormal:    0.015,
    clickPoor:      0.005,
    source: 'MailerLite 2025 + GDMA 2024 + DMA UK 2025',
  },
};

// ─────────────────────────────────────────────
// AIRTABLE HELPERS
// ─────────────────────────────────────────────

async function atGet(table, formula, sort = '', max = 100) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort) url += `&${sort}`;
  const r = await fetch(url, { headers: AT_HEADERS() });
  if (!r.ok) throw new Error(`Airtable GET ${table} failed: ${r.status}`);
  return (await r.json()).records || [];
}

async function atCreate(table, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: AT_HEADERS(),
    body: JSON.stringify({ records: [{ fields: clean }] }),
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
    method: 'PATCH',
    headers: AT_HEADERS(),
    body: JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`Airtable PATCH ${table} failed: ${r.status}`);
  return await r.json();
}

// ─────────────────────────────────────────────
// FIELD MAPPING AUTO-DETECTION (v7.0 — improved)
// ─────────────────────────────────────────────

function detectColumnType(header, values) {
  const lc = header.toLowerCase().trim();
  const sample = values.filter(v => v !== null && v !== undefined && v !== '');
  if (!sample.length) return 'unknown';

  // DATE — check header name first, then values
  if (lc.includes('date') || lc.includes('sent on') || lc.includes('send date')) return 'date';
  const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  if (sample.filter(v => dateRe.test(String(v).trim())).length / sample.length > 0.7) return 'date';

  // SEGMENT — common platform names
  const segWords = ['segment', 'list', 'audience', 'group', 'tag', 'list name', 'list / segment', 'audience name'];
  if (segWords.some(w => lc.includes(w))) return 'segment';

  // CAMPAIGN NAME
  const campWords = ['campaign name', 'campaign', 'subject', 'email name', 'name'];
  if (campWords.some(w => lc === w || lc.includes('campaign name'))) return 'campaign_name';

  // CAMPAIGN TYPE
  if (lc.includes('type') || lc.includes('kind') || lc.includes('category')) return 'campaign_type';

  // Numeric detection
  const nums = sample.map(v => parseFloat(String(v).replace('%', ''))).filter(n => !isNaN(n));
  const pctSample = sample.filter(v => String(v).includes('%'));
  const isPct = pctSample.length / sample.length > 0.5;

  if (nums.length / sample.length > 0.8) {
    // Check if values look like percentages (either with % sign or 0-100 range)
    const isRateStyle = isPct || (nums.every(n => n >= 0 && n <= 1));
    const isPctStyle = isPct || (nums.some(n => n > 1) && nums.every(n => n <= 100));

    if (lc.includes('unsub') || lc.includes('opt out') || lc.includes('opt-out')) return 'unsubscribe_rate_or_count';
    if (lc.includes('open')) return 'open_rate';
    if (lc.includes('click') && !lc.includes('unique')) return 'click_rate';
    if (lc.includes('complaint') || lc.includes('spam') || lc.includes('abuse')) return 'complaint_count';
    if (lc.includes('sent') || lc.includes('volume') || lc.includes('delivered') || lc.includes('recipients')) return 'volume_sent';
    if (lc.includes('bounce')) return 'ignore';
    if (lc.includes('revenue') || lc.includes('£') || lc.includes('$')) return 'ignore';

    if (isRateStyle || isPct) return 'rate_unknown';
    return 'count_unknown';
  }

  return 'text';
}

function autoMapColumns(headers, rows) {
  const mapping = {};
  const sampleSize = Math.min(rows.length, 20);
  const used = new Set();

  for (const h of headers) {
    const values = rows.slice(0, sampleSize).map(r => r[h]);
    const type = detectColumnType(h, values);
    const lc = h.toLowerCase().trim();

    if (type === 'date' && !used.has('date')) {
      mapping[h] = 'date'; used.add('date');
    } else if (type === 'segment' && !used.has('segment')) {
      mapping[h] = 'segment'; used.add('segment');
    } else if (type === 'campaign_name' && !used.has('campaign_name')) {
      mapping[h] = 'campaign_name'; used.add('campaign_name');
    } else if (type === 'campaign_type' && !used.has('campaign_type')) {
      mapping[h] = 'campaign_type'; used.add('campaign_type');
    } else if (type === 'open_rate' && !used.has('open_rate')) {
      mapping[h] = 'open_rate'; used.add('open_rate');
    } else if (type === 'click_rate' && !used.has('click_rate')) {
      mapping[h] = 'click_rate'; used.add('click_rate');
    } else if (type === 'complaint_count' && !used.has('complaint_count')) {
      mapping[h] = 'complaint_count'; used.add('complaint_count');
    } else if (type === 'volume_sent' && !used.has('volume_sent')) {
      mapping[h] = 'volume_sent'; used.add('volume_sent');
    } else if (type === 'unsubscribe_rate_or_count' && !used.has('unsubscribe_count')) {
      // Figure out if it's a rate or a count from the values
      const nums = rows.slice(0, sampleSize).map(r => parseFloat(String(r[h] || '').replace('%', ''))).filter(n => !isNaN(n));
      const hasPct = rows.slice(0, sampleSize).some(r => String(r[h] || '').includes('%'));
      const isRate = hasPct || (nums.length > 0 && nums.every(n => n <= 1));
      mapping[h] = isRate ? 'unsubscribe_rate' : 'unsubscribe_count';
      used.add('unsubscribe_count');
    } else if (type === 'ignore') {
      mapping[h] = '';
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
    return `${yr}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  }
  // Try parsing natural dates like "17 Jun 2025"
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function normaliseRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace('%', '').trim();
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return n > 1 ? n / 100 : n;
}

// ─────────────────────────────────────────────
// BENCHMARK COMPARISON HELPERS
// ─────────────────────────────────────────────

function getBenchmark(sector) {
  return BENCHMARKS[sector] || BENCHMARKS.general;
}

function benchmarkVerdict(unsubRate, bench) {
  if (unsubRate <= bench.unsubGood) return { label: 'Excellent', tier: 'good', pctVsBenchmark: null };
  if (unsubRate <= bench.unsubNormal) return { label: 'Normal', tier: 'normal', pctVsBenchmark: null };
  const pct = Math.round(((unsubRate - bench.unsubNormal) / bench.unsubNormal) * 100);
  if (unsubRate <= bench.unsubConcern) return { label: 'Above average', tier: 'concern', pctVsBenchmark: pct };
  if (unsubRate <= bench.unsubDamaged) return { label: 'High', tier: 'high', pctVsBenchmark: pct };
  return { label: 'Very high', tier: 'damaged', pctVsBenchmark: pct };
}

// Calculate unnecessary unsubscribes above benchmark
function calcSubscriberLoss(campaigns, bench) {
  let totalLost = 0;
  let totalDamagingCampaigns = 0;
  const breakdown = [];

  for (const c of campaigns) {
    if (!c.volume_sent) continue;
    const rate = c.unsubscribe_count / c.volume_sent;
    const benchRate = bench.unsubNormal;
    if (rate > benchRate) {
      const expectedUnsubs = Math.round(c.volume_sent * benchRate);
      const actualUnsubs = c.unsubscribe_count;
      const excess = actualUnsubs - expectedUnsubs;
      if (excess > 0) {
        totalLost += excess;
        totalDamagingCampaigns++;
        breakdown.push({
          campaign: c.campaign_name || 'Campaign',
          date: c.date,
          excess,
          rate: r4(rate),
          benchRate,
        });
      }
    }
  }

  return {
    totalExcessUnsubs: totalLost,
    damagingCampaigns: totalDamagingCampaigns,
    breakdown: breakdown.slice(-5),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 1 — SEGMENT BEHAVIOURAL FINGERPRINT
// v7.0: Uses absolute benchmark thresholds, not just self-comparison
// ─────────────────────────────────────────────

function algorithm1_fingerprint(campaigns, bench) {
  const n = campaigns.length;
  if (!n) return null;

  const unsubRates = campaigns.map(c =>
    c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1)
  );

  // Self-baseline (trimmed mean of own history)
  const sorted = [...unsubRates].sort((a, b) => a - b);
  const lo = Math.floor(n * 0.2), hi = Math.ceil(n * 0.8);
  const trimmed = sorted.slice(lo, hi);
  const selfBaseline = trimmed.length ? mean_arr(trimmed) : bench.unsubNormal;

  // Use the HIGHER of self-baseline and benchmark normal as the comparison point
  // This prevents segments that are consistently bad from looking "normal"
  const effectiveBaseline = Math.max(selfBaseline, bench.unsubGood);

  const openRates = campaigns.map(c => c.open_rate).filter(r => r !== null);
  const clickRates = campaigns.map(c => c.click_rate).filter(r => r !== null);
  const baselineOpen = openRates.length ? mean_arr(openRates) : null;
  const baselineClick = clickRates.length ? mean_arr(clickRates) : null;

  const mean_u = mean_arr(unsubRates);
  const variance = unsubRates.reduce((s, v) => s + Math.pow(v - mean_u, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  // Trend: compare last 3 to first 3
  const recentRates = unsubRates.slice(-3);
  const olderRates = unsubRates.slice(0, Math.max(3, Math.floor(n / 3)));
  const trendDelta = mean_arr(recentRates) - mean_arr(olderRates);

  let frequencyThreshold = 4;
  if (n >= 5) {
    const dates = campaigns.map(c => new Date(c.date));
    let bestFreq = 4;
    for (let i = 0; i < n; i++) {
      const windowEnd = dates[i];
      const windowStart = new Date(+windowEnd - 30 * 86400000);
      const inWindow = campaigns.filter(c => {
        const d = new Date(c.date);
        return d >= windowStart && d <= windowEnd;
      });
      if (inWindow.length >= 3) {
        const avgUnsub = mean_arr(inWindow.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1)));
        if (avgUnsub < effectiveBaseline * 1.2) bestFreq = inWindow.length;
      }
    }
    frequencyThreshold = bestFreq;
  }

  const typeGroups = {};
  for (const c of campaigns) {
    const type = c.campaign_type || 'Unknown';
    if (!typeGroups[type]) typeGroups[type] = [];
    typeGroups[type].push(c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  }
  const typeSensitivity = {};
  for (const [type, rates] of Object.entries(typeGroups)) {
    typeSensitivity[type] = r4(mean_arr(rates));
  }

  const recoveryHalfLife = 3;

  return {
    selfBaseline: r4(selfBaseline),
    effectiveBaseline: r4(effectiveBaseline),
    benchmarkNormal: bench.unsubNormal,
    baselineOpenRate: baselineOpen !== null ? r4(baselineOpen) : null,
    baselineClickRate: baselineClick !== null ? r4(baselineClick) : null,
    unsubscribeStdDev: r4(stddev),
    trendDelta: r4(trendDelta),
    frequencyToleranceThreshold: Math.round(frequencyThreshold),
    campaignTypeSensitivity: typeSensitivity,
    recoveryHalfLife,
    campaignCount: n,
    dataCompleteness: dataCompletenessScore(campaigns),
    // Benchmark context for display
    vsBenchmark: benchmarkVerdict(mean_u, bench),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 2 — TRUST VELOCITY ENGINE
// ─────────────────────────────────────────────

function algorithm2_trustVelocity(campaigns, fingerprint) {
  const n = campaigns.length;
  if (n < 2) return { velocity: 0, direction: 'Stable', magnitude: 0 };

  const baseline = fingerprint?.effectiveBaseline || 0.002;
  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));

  const stream1 = secondDerivative(unsubRates);

  const openRates = campaigns.map(c => c.open_rate).filter(r => r !== null);
  let stream2 = 0;
  if (openRates.length >= 3) {
    const deltas = openRates.slice(1).map((r, i) => r - openRates[i]);
    stream2 = mean_arr(deltas);
  }

  const complaintTotal = campaigns.reduce((s, c) => s + (c.complaint_count || 0), 0);
  const unsubTotal = campaigns.reduce((s, c) => s + (c.unsubscribe_count || 0), 0);
  const stream4 = complaintTotal > 0 ? -(complaintTotal * 50) / Math.max(unsubTotal, 1) : 0;

  const w1 = 0.45, w2 = 0.30, w4 = 0.25;
  const velocity = (stream1 * w1 + stream2 * w2 + stream4 * w4);

  let direction;
  if (velocity > 0.5) direction = 'Rapid decline';
  else if (velocity > 0.1) direction = 'Declining';
  else if (velocity < -0.1) direction = 'Improving';
  else direction = 'Stable';

  return { velocity: r4(velocity), direction, magnitude: r4(Math.abs(velocity)) };
}

// ─────────────────────────────────────────────
// ALGORITHM 3 — CAMPAIGN IMPACT SCORER (v7.0 benchmark-anchored)
// ─────────────────────────────────────────────

function algorithm3_campaignImpact(campaign, allCampaigns, fingerprint, bench) {
  if (!fingerprint) return null;

  const volumeSent = campaign.volume_sent || 1000;
  const unsubRate = campaign.unsubscribe_count / volumeSent;
  const benchNormal = bench.unsubNormal;
  const selfBaseline = fingerprint.selfBaseline;

  // Score against BOTH benchmark and self-baseline
  const zBench = (unsubRate - benchNormal) / (bench.unsubNormal * 0.5 + 0.0001);
  const zSelf = fingerprint.unsubscribeStdDev > 0
    ? (unsubRate - selfBaseline) / (fingerprint.unsubscribeStdDev + 0.0001)
    : 0;

  // Weight benchmark more heavily (60%) than self-comparison (40%)
  const zScore = zBench * 0.6 + zSelf * 0.4;
  const impactScore = -zScore;

  // Excess unsubs above benchmark
  const expectedVsBench = Math.round(volumeSent * benchNormal);
  const excessUnsubs = Math.max(0, campaign.unsubscribe_count - expectedVsBench);

  let category, plainVerdict;
  if (impactScore > 0.8) {
    category = 'Built trust';
    plainVerdict = `Below UK benchmark — your audience responded well to this.`;
  } else if (impactScore > 0.2) {
    category = 'Built trust';
    plainVerdict = `Slightly below benchmark — mild positive signal.`;
  } else if (impactScore > -0.3) {
    category = 'Neutral';
    plainVerdict = `Normal unsubscribe rate — within UK benchmark range (${(benchNormal * 100).toFixed(2)}%).`;
  } else if (impactScore > -1.0) {
    category = 'Caused fatigue';
    plainVerdict = `Above UK benchmark${excessUnsubs > 0 ? ` — about ${excessUnsubs} more unsubscribes than expected` : ''}. Audience is signalling too much email.`;
  } else {
    category = 'Damaged';
    plainVerdict = `Significantly above UK benchmark${excessUnsubs > 0 ? ` — ${excessUnsubs} more unsubscribes than expected` : ''}. This send hurt the relationship.`;
  }

  return {
    impactScore: r4(impactScore),
    zScore: r4(zScore),
    category,
    plainVerdict,
    unsubRate: r4(unsubRate),
    benchmarkRate: benchNormal,
    excessUnsubs,
    campaign_name: campaign.campaign_name,
    date: campaign.date,
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 4 — FREQUENCY TOLERANCE MODEL
// ─────────────────────────────────────────────

function algorithm4_frequencyTolerance(campaigns, fingerprint) {
  if (!fingerprint) return { toleranceRemaining: 3, optimalNextSend: null, recommendedType: 'Newsletter' };

  const now = new Date();
  const thirtyDaysAgo = new Date(+now - 30 * 86400000);
  const recentCampaigns = campaigns.filter(c => new Date(c.date) >= thirtyDaysAgo);
  const threshold = fingerprint.frequencyToleranceThreshold || 4;

  const typeWeights = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.2, 'Transactional': 0.3 };
  const effectiveSends = recentCampaigns.reduce((s, c) => s + (typeWeights[c.campaign_type] || 1.0), 0);
  const toleranceRemaining = Math.max(0, Math.round(threshold - effectiveSends));

  const lastSend = campaigns.length ? new Date(campaigns[campaigns.length - 1].date) : now;
  const minGap = toleranceRemaining > 2 ? 3 : 10;
  const optDate = new Date(+lastSend + minGap * 86400000);
  const optimalNextSend = optDate.toISOString().slice(0, 10);

  let recommendedType = 'Newsletter';
  if (toleranceRemaining <= 1) recommendedType = 'Transactional';
  else if (toleranceRemaining <= 2) recommendedType = 'Newsletter';
  else recommendedType = 'Promotional';

  return {
    toleranceRemaining,
    optimalNextSend,
    recommendedType,
    recentSendCount: recentCampaigns.length,
    adjustedThreshold: threshold,
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 5 — AUDIENCE SENTIMENT (v7.0 benchmark-anchored)
// Now uses absolute benchmark thresholds as primary signal.
// Self-comparison used as secondary signal only.
// ─────────────────────────────────────────────

function algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, recentImpacts, capital, bench, sector) {
  const cap = capital || 0;
  const benchSrc = bench.source;

  if (!fingerprint) {
    return {
      state: 'Neutral',
      verdict: 'Upload your send history to get a diagnosis',
      statement: 'We need at least 3 campaigns to generate a meaningful diagnosis for this segment.',
      action: 'Upload a CSV with date, segment name, and unsubscribe count to get started.',
      statementCommercial: null,
      statementRegulatory: null,
      regulatoryNote: null,
      confidence: 0.3,
    };
  }

  const n = fingerprint.campaignCount;
  const direction = trustVelocity.direction;
  const tolerance = freqTolerance.toleranceRemaining;
  const recentDamage = recentImpacts.filter(i => i.category === 'Damaged' || i.category === 'Caused fatigue').length;
  const recentBuilt = recentImpacts.filter(i => i.category === 'Built trust').length;
  const baseConf = Math.min(0.5 + n * 0.04, 0.95);

  // Get the average unsub rate for this segment
  const avgUnsubRate = fingerprint.selfBaseline;
  const benchNormal = bench.unsubNormal;
  const benchGood = bench.unsubGood;
  const benchConcern = bench.unsubConcern;
  const benchDamaged = bench.unsubDamaged;

  const avgPct = (avgUnsubRate * 100).toFixed(2) + '%';
  const benchPct = (benchNormal * 100).toFixed(2) + '%';
  const benchGoodPct = (benchGood * 100).toFixed(2) + '%';
  const vsBench = fingerprint.vsBenchmark;
  const aboveBenchBy = vsBench.pctVsBenchmark ? `${vsBench.pctVsBenchmark}% above the UK ${bench.label} benchmark` : null;

  const recoveryDays = Math.round((fingerprint.recoveryHalfLife || 3) * 7);
  const trendDelta = fingerprint.trendDelta || 0;

  // ── COMPLAINT RISK ──────────────────────────────────────────
  const hasComplaints = recentImpacts.some(i => i._hasComplaints);
  if (hasComplaints && avgUnsubRate > benchConcern) {
    return {
      state: 'Complaint risk',
      verdict: 'Stop sending to this segment now',
      statement: `This segment is generating complaint signals with an average unsubscribe rate of ${avgPct} — well above the UK ${bench.label} benchmark of ${benchPct}. The ICO monitors exactly this pattern.`,
      action: 'Stop all promotional sends immediately. Run a re-permission campaign — anyone who does not re-consent should be suppressed.',
      statementCommercial: 'Audiences in complaint territory stop converting before they formally complain. Revenue from this segment will be near zero until trust is rebuilt.',
      statementRegulatory: 'Complaint signals combined with above-benchmark unsubscribe rates is the pattern the ICO identifies before opening PECR Regulation 22 enforcement investigations.',
      regulatoryNote: 'This pattern is statistically associated with formal ICO complaints. The window to act without enforcement consequences is typically 30–60 days.',
      confidence: r2(Math.min(baseConf, 0.92)),
    };
  }

  // ── DAMAGED — significantly above benchmark ─────────────────
  if (avgUnsubRate > benchDamaged || (avgUnsubRate > benchConcern && direction === 'Rapid decline' && recentDamage >= 2)) {
    const capNote = cap < 0
      ? 'The negative relationship capital means this segment has little goodwill left to absorb further sends.'
      : 'Some positive relationship capital remains — recovery is possible if you act now.';
    return {
      state: 'Damaged',
      verdict: 'This segment needs a break from you',
      statement: `Average unsubscribe rate ${avgPct} — ${aboveBenchBy || `above the UK ${bench.label} benchmark of ${benchPct}`}. Recent sends are causing above-average audience exit.`,
      action: `Pause all promotional sends for at least ${recoveryDays} days. One low-key value newsletter only. Return to promotional sends only after unsubscribes drop back below ${benchPct}.`,
      statementCommercial: `You have approximately ${recoveryDays} days before this segment becomes effectively unreachable for promotional sends. ${capNote}`,
      statementRegulatory: null,
      regulatoryNote: null,
      confidence: r2(Math.min(baseConf, 0.88)),
    };
  }

  // ── FATIGUE BUILDING — above concern threshold + frequency exhausted ─
  if (avgUnsubRate > benchNormal && tolerance <= 1 && direction !== 'Improving') {
    return {
      state: 'Fatigue building',
      verdict: "You're sending too much to this segment",
      statement: `Average unsubscribe rate ${avgPct} vs UK ${bench.label} benchmark of ${benchPct}. You've sent ${freqTolerance.recentSendCount} campaigns in the last 30 days and frequency tolerance is almost gone. The next promotional send is likely to push this above ${(benchConcern * 100).toFixed(2)}%.`,
      action: `No promotional sends this month. Maximum one newsletter. Give this segment a ${recoveryDays}-day gap before any commercial content.`,
      statementCommercial: 'Fatigued audiences stop opening before they unsubscribe. Open rates will continue dropping even if you reduce frequency — the damage takes 3–4 weeks to reverse.',
      statementRegulatory: 'High frequency combined with above-benchmark unsubscribes is the pattern the ICO uses to challenge legitimate interest bases under PECR. Your audience is signalling the contact is no longer welcome.',
      regulatoryNote: cap < -20 ? 'With negative relationship capital and rising unsubscribes, your send history would struggle to pass an ICO legitimate interest balance test if reviewed.' : null,
      confidence: r2(Math.min(baseConf, 0.85)),
    };
  }

  // ── COOLING — above benchmark + declining ───────────────────
  if (avgUnsubRate > benchNormal && direction === 'Declining') {
    return {
      state: 'Cooling',
      verdict: 'This segment is losing interest',
      statement: `Unsubscribes trending up across your last ${Math.min(n, 6)} campaigns. Average ${avgPct} — ${aboveBenchBy || `above UK ${bench.label} benchmark of ${benchPct}`}. You still have ${tolerance} send${tolerance !== 1 ? 's' : ''} of tolerance, but the trend is against you.`,
      action: 'Try a preference-update email — ask them what they want to hear about. One re-engagement send before resuming your normal schedule.',
      statementCommercial: 'Cooling audiences convert at a fraction of their peak rate. Sending more will accelerate the decline — the opportunity is to reverse it now while they are still reachable.',
      statementRegulatory: null,
      regulatoryNote: null,
      confidence: r2(Math.min(baseConf, 0.78)),
    };
  }

  // ── PEAK RECEPTIVENESS — below good threshold + improving ───
  if (avgUnsubRate <= benchGood && direction === 'Improving' && tolerance >= 3 && recentBuilt >= 2) {
    return {
      state: 'Peak receptiveness',
      verdict: 'Best window to send — act this week',
      statement: `Average unsubscribe rate ${avgPct} — well below the UK ${bench.label} benchmark of ${benchPct}. ${recentBuilt} recent sends built trust. You have ${tolerance} sends of remaining tolerance. This is your best window.`,
      action: 'Send your highest-value promotional or product announcement now. This window typically lasts 2–3 weeks before tolerance starts narrowing.',
      statementCommercial: 'Peak-receptiveness audiences convert at measurably higher rates than normal. A promotional campaign sent now will outperform the same campaign sent in 2 weeks.',
      statementRegulatory: null,
      regulatoryNote: null,
      confidence: r2(Math.min(baseConf, 0.88)),
    };
  }

  // ── RECOVERING — mixed signals ──────────────────────────────
  if ((direction === 'Improving' || direction === 'Stable') && recentDamage >= 1 && recentBuilt >= 1) {
    const conf = r2(Math.min(baseConf, 0.78));
    if (cap >= 40) {
      return {
        state: 'Recovering',
        verdict: 'Recovering well — one more careful send',
        statement: `Recent damage is reversing. Average unsub rate ${avgPct} vs benchmark ${benchPct}. Strong relationship capital (+${cap.toFixed(0)}/100) is cushioning the recovery.`,
        action: `Send one value-first newsletter — no promotional content. If unsubscribes stay below ${benchPct}, resume normal sending in ${Math.round(recoveryDays * 0.6)} days.`,
        statementCommercial: 'High capital means this audience is more forgiving than their recent numbers suggest. A well-timed value send could accelerate recovery.',
        statementRegulatory: null,
        regulatoryNote: null,
        confidence: conf,
      };
    } else if (cap >= 10) {
      return {
        state: 'Recovering',
        verdict: 'Recovering — handle with care',
        statement: `Early signs of recovery after recent damage. Average unsub rate ${avgPct} vs benchmark ${benchPct}. Relationship capital (+${cap.toFixed(0)}/100) is moderate — another poor send would reverse progress.`,
        action: `High-value sends only for the next ${recoveryDays} days. No promotional campaigns. Monitor every send — if unsubscribes exceed ${(benchConcern * 100).toFixed(2)}% stop immediately.`,
        statementCommercial: 'Revenue will return, but slowly. One badly timed promotional send now could push this segment back into damaged territory.',
        statementRegulatory: null,
        regulatoryNote: null,
        confidence: conf,
      };
    } else {
      return {
        state: 'Recovering',
        verdict: 'Fragile recovery — do not send yet',
        statement: `Mathematical recovery signs present but relationship capital (${cap.toFixed(0)}/100) is too low to risk a send. Average unsub rate ${avgPct} vs benchmark ${benchPct}.`,
        action: `Do not send anything for at least ${recoveryDays} days. Rebuild capital with 3–4 positive sends before attempting any promotional campaign.`,
        statementCommercial: 'Low-capital recoveries are fragile. This segment needs more positive campaign history before it will convert at normal rates.',
        statementRegulatory: cap < 0 ? 'Negative relationship capital combined with recent damage is a pattern the ICO and ASA would note as evidence of repeated audience harm if reviewing your send history.' : null,
        regulatoryNote: null,
        confidence: r2(conf * 0.9),
      };
    }
  }

  // ── HEALTHY — at or below benchmark ────────────────────────
  if (avgUnsubRate <= benchNormal && direction !== 'Declining') {
    const capCtx = cap >= 30
      ? `Strong relationship capital (+${cap.toFixed(0)}/100).`
      : cap >= 10
      ? `Positive relationship capital (+${cap.toFixed(0)}/100).`
      : 'Relationship capital is neutral.';
    return {
      state: 'Healthy',
      verdict: 'Looking good — proceed as planned',
      statement: `Average unsubscribe rate ${avgPct} is at or below the UK ${bench.label} benchmark of ${benchPct}. ${capCtx} No concerning trends detected.`,
      action: 'Proceed with your planned campaign. Monitor unsubscribes on the next send — flag if they exceed the benchmark.',
      statementCommercial: 'A healthy segment converts at predictable rates. Maintain current frequency and content quality.',
      statementRegulatory: null,
      regulatoryNote: null,
      confidence: r2(Math.min(baseConf, 0.80)),
    };
  }

  // ── NEUTRAL DEFAULT ─────────────────────────────────────────
  const capNote = cap > 20
    ? `Relationship capital is positive (+${cap.toFixed(0)}/100).`
    : cap < -10
    ? `Relationship capital is negative (${cap.toFixed(0)}/100) — worth reviewing recent performance before sending.`
    : 'Relationship capital is neutral.';

  return {
    state: 'Neutral',
    verdict: 'No strong signals — proceed normally',
    statement: `Average unsubscribe rate ${avgPct} vs UK ${bench.label} benchmark of ${benchPct}. ${capNote} No strong trend in either direction after ${n} campaign${n !== 1 ? 's' : ''}.`,
    action: 'Proceed with your planned campaign. Monitor unsubscribes on the next send.',
    statementCommercial: 'Neutral state means sends will perform at your historical average rates.',
    statementRegulatory: null,
    regulatoryNote: null,
    confidence: r2(Math.min(baseConf, 0.65)),
  };
}

// ─────────────────────────────────────────────
// ALGORITHM 6 — PREDICTIVE SEND MODELLER
// ─────────────────────────────────────────────

function algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance, bench) {
  if (!fingerprint) return {
    verdict: 'Amber',
    confidence: 0.5,
    reason: 'Not enough historical data to predict impact. Proceed cautiously.',
    alternatives: [],
    predictedUnsubRange: null,
  };

  const baseline = fingerprint.effectiveBaseline;
  const stddev = fingerprint.unsubscribeStdDev || baseline * 0.3;
  const typeWeights = { 'Promotional': 1.5, 'Newsletter': 0.8, 'Re-engagement': 1.3, 'Transactional': 0.3 };
  const typeMultiplier = typeWeights[campaignType] || 1.0;
  const velAdjust = 1 + trustVelocity.velocity * 0.3;
  const expectedRate = baseline * typeMultiplier * Math.max(0.5, velAdjust);

  const results = [];
  for (let i = 0; i < 1000; i++) results.push(Math.max(0, expectedRate + gaussianRandom(0, stddev)));
  results.sort((a, b) => a - b);

  const p10 = results[100], p50 = results[500], p90 = results[900];
  const spikeProb = results.filter(r => r > bench.unsubConcern).length / 1000;
  const benchNormal = bench.unsubNormal;

  let verdict, reason, confidence;
  if (spikeProb < 0.15 && freqTolerance.toleranceRemaining > 1 && p50 <= benchNormal) {
    verdict = 'Green';
    reason = `Low risk. Predicted unsubscribe rate ${(p50 * 100).toFixed(2)}%–${(p90 * 100).toFixed(2)}% — within UK ${bench.label} benchmark range (${(benchNormal * 100).toFixed(2)}%).`;
    confidence = r2(0.85 - spikeProb);
  } else if (spikeProb < 0.4 || freqTolerance.toleranceRemaining === 1) {
    verdict = 'Amber';
    reason = `Moderate risk. ${Math.round(spikeProb * 100)}% chance of exceeding UK benchmark. Predicted rate ${(p50 * 100).toFixed(2)}% vs benchmark ${(benchNormal * 100).toFixed(2)}%.`;
    confidence = r2(0.7 - spikeProb * 0.3);
  } else {
    verdict = 'Red';
    reason = `High risk. ${Math.round(spikeProb * 100)}% chance of exceeding UK concern threshold. Current segment state is not ready for a ${campaignType} send.`;
    confidence = r2(0.9 - spikeProb * 0.2);
  }

  const alternatives = [];
  if (verdict !== 'Green') {
    const safestType = freqTolerance.recommendedType;
    if (safestType !== campaignType) alternatives.push({ change: `Switch to ${safestType}`, reason: `${safestType} sends have lower unsubscribe impact for this segment right now.` });
    alternatives.push({ change: `Send on ${freqTolerance.optimalNextSend} instead`, reason: 'Waiting for the tolerance window to recover would reduce spike probability.' });
    alternatives.push({ change: 'Test with 30% of the segment first', reason: 'A smaller test send lets you measure response before committing the full list.' });
  }

  return { verdict, confidence, reason, predictedUnsubRange: { low: r4(p10), mid: r4(p50), high: r4(p90) }, spikeProb: r2(spikeProb), benchmarkRate: benchNormal, alternatives };
}

// ─────────────────────────────────────────────
// ALGORITHM 7 — RELATIONSHIP CAPITAL ACCUMULATOR
// ─────────────────────────────────────────────

function algorithm7_relationshipCapital(campaigns, fingerprint, bench) {
  if (!fingerprint || !campaigns.length) return 0;
  const decayHalfLife = 60;
  const now = new Date();
  const benchNormal = bench.unsubNormal;
  const isNewSegment = campaigns.length < 3;
  let capital = isNewSegment ? 20 : 0;

  for (const c of campaigns) {
    const daysAgo = (+now - new Date(c.date)) / 86400000;
    const decayFactor = Math.pow(0.5, daysAgo / decayHalfLife);
    const rate = c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1);
    // Impact relative to benchmark (not just self)
    const impactRaw = (benchNormal - rate) / (benchNormal + 0.001) * 20;
    const recoveryBonus = capital < -20 && impactRaw > 0 ? impactRaw * 0.5 : 0;
    capital += (impactRaw + recoveryBonus) * decayFactor;
    capital = sigmoidBound(capital, 100);
  }

  return r2(Math.max(-100, Math.min(100, capital)));
}

// ─────────────────────────────────────────────
// RUN ALL ALGORITHMS FOR ONE SEGMENT
// ─────────────────────────────────────────────

function runAlgorithms(campaigns, sector = 'general') {
  const bench = getBenchmark(sector);
  const fingerprint = algorithm1_fingerprint(campaigns, bench);
  const trustVelocity = algorithm2_trustVelocity(campaigns, fingerprint);
  const freqTolerance = algorithm4_frequencyTolerance(campaigns, fingerprint);

  const impacts = campaigns.map(c => {
    const imp = algorithm3_campaignImpact(c, campaigns, fingerprint, bench);
    return imp || null;
  }).filter(Boolean);

  const capital = algorithm7_relationshipCapital(campaigns, fingerprint, bench);
  const sentiment = algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, impacts, capital, bench, sector);
  const subscriberLoss = calcSubscriberLoss(campaigns, bench);

  const hasOpenRates = campaigns.some(c => c.open_rate !== null);
  const hasClickRates = campaigns.some(c => c.click_rate !== null);
  const hasComplaints = campaigns.some(c => c.complaint_count !== null && c.complaint_count > 0);
  const hasSendHistory = campaigns.some(c => c.volume_sent !== null);

  let dataQuality = 'Minimal';
  if (hasSendHistory && hasOpenRates) dataQuality = 'Partial';
  if (hasSendHistory && hasOpenRates && hasClickRates && hasComplaints) dataQuality = 'Full';

  const missingData = [];
  if (!hasSendHistory) missingData.push({ field: 'Volume sent', message: 'Add volume sent per campaign and we can calculate exactly how many subscribers you\'re losing above the UK benchmark.' });
  if (!hasOpenRates) missingData.push({ field: 'Open rates', message: 'Add open rates to build a full engagement decay curve and compare against UK sector benchmarks.' });
  if (!hasComplaints) missingData.push({ field: 'Spam complaints', message: 'Complaints carry 50× the weight of an unsubscribe. Adding them makes the Trust Velocity score significantly more accurate.' });

  return {
    fingerprint,
    trustVelocity,
    freqTolerance,
    sentiment,
    capital,
    impacts: impacts.slice(-10),
    dataQuality,
    missingData,
    subscriberLoss,
    bench: { label: bench.label, unsubNormal: bench.unsubNormal, source: bench.source },
    sector,
  };
}

// ─────────────────────────────────────────────
// DATA HELPERS
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

function missingDataMessages(hasOpenRates, hasClickRates, hasComplaints, hasSendHistory) {
  const messages = [];
  if (!hasSendHistory) messages.push({ field: 'Volume sent', message: 'Add the number of emails sent per campaign — this unlocks subscriber loss calculations and frequency tolerance modelling.', algorithmsUnlocked: [1, 3, 4] });
  if (!hasOpenRates) messages.push({ field: 'Open rates', message: 'Add open rates to build an engagement decay curve showing whether your audience\'s interest is growing or shrinking.', algorithmsUnlocked: [1] });
  if (!hasComplaints) messages.push({ field: 'Spam complaints', message: 'Complaints carry 50× the weight of an unsubscribe in the Trust Velocity model. Adding them significantly improves accuracy.', algorithmsUnlocked: [2] });
  return messages;
}

// ─────────────────────────────────────────────
// FIX RECORD GENERATION
// ─────────────────────────────────────────────

async function generateFixes(userId, segmentName, sentiment, sourceRecordId) {
  const fixes = [];
  const { state, confidence, regulatoryNote } = sentiment;

  if (state === 'Complaint risk' && confidence >= 0.7) {
    fixes.push({ fixType: 'consent_missing', description: `Audience Read — ${segmentName}: Complaint risk detected. ${sentiment.statement}`.trim(), severity: 'critical' });
  }
  if (state === 'Fatigue building' && confidence >= 0.7) {
    fixes.push({ fixType: 'legitimate_interest_abuse', description: `Audience Read — ${segmentName}: Send frequency above UK benchmark is building fatigue. ${regulatoryNote || ''}`.trim(), severity: 'high' });
  }
  if (state === 'Damaged' && confidence >= 0.7) {
    fixes.push({ fixType: 'data_quality', description: `Audience Read — ${segmentName}: Campaign damage detected. Unsubscribe rate significantly above UK benchmark.`.trim(), severity: 'medium' });
  }

  for (const fix of fixes) {
    try {
      await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: fix.fixType, description: fix.description, tool: 'Audience Read', severity: fix.severity, sourceRecordId: sourceRecordId || null }),
      });
    } catch (err) {
      console.error(`generate-fix failed for ${fix.fixType} (${segmentName}):`, err);
    }
  }
}

async function maybeFireAudienceAlert(userId, segmentName, sentiment) {
  if (!['Complaint risk', 'Damaged'].includes(sentiment.state)) return;
  try {
    await fetch(`${APP_URL}/api/data?action=send-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, alertType: 'audience_damaged', segmentName, sentimentState: sentiment.state, regulatoryNote: sentiment.regulatoryNote || null }),
    });
  } catch (err) {
    console.error('audience_damaged alert failed (non-fatal):', err);
  }
}

// ─────────────────────────────────────────────
// AIRTABLE SEGMENT / CAMPAIGN OPS
// ─────────────────────────────────────────────

async function upsertSegment(userId, segmentName, data) {
  const records = await atGet('Audience_Read_Segments', `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`, '', 1);
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
    CampaignCount: data.fingerprint?.campaignCount || 0,
    DataQuality: data.dataQuality,
    Sector: data.sector || 'general',
  };
  if (records.length) await atPatch('Audience_Read_Segments', records[0].id, fields);
  else await atCreate('Audience_Read_Segments', fields);
}

async function saveCampaign(userId, segmentName, campaign, impact) {
  await atCreate('Audience_Read_Campaigns', {
    UserID: userId,
    SegmentName: segmentName,
    CampaignName: campaign.campaign_name || 'Campaign',
    CampaignType: campaign.campaign_type || null,
    SendDate: campaign.date,
    VolumeSent: campaign.volume_sent || null,
    UnsubscribeCount: campaign.unsubscribe_count || 0,
    OpenRate: campaign.open_rate || null,
    ClickRate: campaign.click_rate || null,
    ComplaintCount: campaign.complaint_count || null,
    ImpactScore: impact?.impactScore || null,
    ImpactCategory: impact?.category || null,
    ImpactReason: impact?.plainVerdict || null,
    RecoveryDaysEstimated: null,
    UnsubRate: impact?.unsubRate || null,
    ExcessUnsubs: impact?.excessUnsubs || null,
  });
}

async function loadCampaigns(userId) {
  const records = await atGet('Audience_Read_Campaigns', `{UserID}="${userId}"`, 'sort[0][field]=SendDate&sort[0][direction]=asc', 500);
  return records.map(r => ({
    segment: r.fields.SegmentName,
    campaign_name: r.fields.CampaignName,
    campaign_type: r.fields.CampaignType,
    date: r.fields.SendDate,
    volume_sent: r.fields.VolumeSent || null,
    unsubscribe_count: r.fields.UnsubscribeCount || 0,
    open_rate: r.fields.OpenRate || null,
    click_rate: r.fields.ClickRate || null,
    complaint_count: r.fields.ComplaintCount || null,
  }));
}

// ─────────────────────────────────────────────
// SNAPSHOT STORAGE (v7.1 — stickiness foundation)
// Every upload/log writes an immutable dated snapshot to
// Audience_Read_Snapshots. The live Audience_Read_Segments record
// stays current via atPatch; snapshots are append-only history.
// Comparing the newest snapshot to the prior one powers the
// "what changed since last upload" headline on the dashboard.
// ─────────────────────────────────────────────

// Health ranking — higher number = healthier state.
// Used to decide whether a state change is an improvement or a decline.
const STATE_RANK = {
  'Complaint risk': 0,
  'Damaged': 1,
  'Fatigue building': 2,
  'Cooling': 3,
  'Recovering': 4,
  'Neutral': 5,
  'Healthy': 6,
  'Highly receptive post-gap': 7,
  'Peak receptiveness': 8,
};

async function snapshotSegment(userId, segmentName, data) {
  // Immutable — always create, never patch.
  await atCreate('Audience_Read_Snapshots', {
    UserID: userId,
    SegmentName: segmentName,
    SnapshotDate: new Date().toISOString().slice(0, 10),
    SnapshotTimestamp: new Date().toISOString(),
    State: data.sentiment?.state || 'Neutral',
    Capital: data.capital != null ? data.capital : (data.relationshipCapital || 0),
    AvgUnsubRate: data.fingerprint?.selfBaseline || null,
    ExcessUnsubs: data.subscriberLoss?.totalExcessUnsubs || 0,
    CampaignCount: data.fingerprint?.campaignCount || 0,
    Sector: data.sector || 'general',
  });
}

// Returns all snapshots for a user grouped by segment, each list
// sorted newest-first. Capped to keep the request light.
async function getSnapshotsBySegment(userId) {
  const records = await atGet(
    'Audience_Read_Snapshots',
    `{UserID}="${userId}"`,
    'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc',
    200
  );
  const bySeg = {};
  for (const r of records) {
    const seg = r.fields.SegmentName;
    if (!seg) continue;
    if (!bySeg[seg]) bySeg[seg] = [];
    bySeg[seg].push({
      date: r.fields.SnapshotDate,
      timestamp: r.fields.SnapshotTimestamp || r.fields.SnapshotDate,
      state: r.fields.State || 'Neutral',
      capital: r.fields.Capital != null ? r.fields.Capital : 0,
      avgUnsubRate: r.fields.AvgUnsubRate != null ? r.fields.AvgUnsubRate : null,
      excessUnsubs: r.fields.ExcessUnsubs != null ? r.fields.ExcessUnsubs : 0,
      campaignCount: r.fields.CampaignCount || 0,
    });
  }
  return bySeg;
}

function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.abs(Math.round((a - b) / 86400000));
}

// Build the per-segment "what changed" comparison.
// `currentMap`  : { segment: { state, capital, avgUnsubRate, excessUnsubs } }  — the freshly computed current state
// `priorMap`    : { segment: priorSnapshot }  — the most recent snapshot taken BEFORE this run
// Returns { summary, segments } where summary tallies improved/worsened/unchanged/new.
function buildChangeComparison(currentMap, priorMap) {
  const segments = [];
  let improved = 0, worsened = 0, unchanged = 0, brandNew = 0;

  for (const seg of Object.keys(currentMap)) {
    const cur = currentMap[seg];
    const prev = priorMap[seg] || null;

    if (!prev) {
      brandNew++;
      segments.push({
        segment: seg,
        isNew: true,
        currentState: cur.state,
        previousState: null,
        stateChanged: false,
        direction: 'new',
        capitalDelta: null,
        avgUnsubRateDelta: null,
        excessUnsubsDelta: null,
        daysSincePrevious: null,
      });
      continue;
    }

    const curRank = STATE_RANK[cur.state] != null ? STATE_RANK[cur.state] : 5;
    const prevRank = STATE_RANK[prev.state] != null ? STATE_RANK[prev.state] : 5;
    const stateChanged = cur.state !== prev.state;
    let direction = 'same';
    if (stateChanged) direction = curRank > prevRank ? 'improved' : 'worsened';

    // Capital delta (positive = goodwill rising)
    const capitalDelta = (cur.capital != null && prev.capital != null)
      ? r2(cur.capital - prev.capital) : null;
    // Unsub rate delta (negative = improving — fewer unsubs)
    const avgUnsubRateDelta = (cur.avgUnsubRate != null && prev.avgUnsubRate != null)
      ? r4(cur.avgUnsubRate - prev.avgUnsubRate) : null;
    const excessUnsubsDelta = (cur.excessUnsubs != null && prev.excessUnsubs != null)
      ? (cur.excessUnsubs - prev.excessUnsubs) : null;

    // Count toward tallies: state change wins; otherwise use capital drift.
    if (stateChanged) {
      if (direction === 'improved') improved++; else worsened++;
    } else if (capitalDelta != null && capitalDelta >= 5) {
      improved++; direction = 'improved';
    } else if (capitalDelta != null && capitalDelta <= -5) {
      worsened++; direction = 'worsened';
    } else {
      unchanged++;
    }

    segments.push({
      segment: seg,
      isNew: false,
      currentState: cur.state,
      previousState: prev.state,
      stateChanged,
      direction,
      capitalDelta,
      avgUnsubRateDelta,
      excessUnsubsDelta,
      daysSincePrevious: daysBetween(new Date().toISOString(), prev.timestamp),
    });
  }

  // Order: worsened first (most urgent), then improved, then new, then unchanged
  const order = { worsened: 0, improved: 1, new: 2, same: 3 };
  segments.sort((a, b) => (order[a.direction] ?? 9) - (order[b.direction] ?? 9));

  // Days since last data overall (smallest gap across segments that have one)
  let daysSinceLast = null;
  for (const s of segments) {
    if (s.daysSincePrevious != null) {
      daysSinceLast = daysSinceLast == null ? s.daysSincePrevious : Math.min(daysSinceLast, s.daysSincePrevious);
    }
  }

  return {
    summary: { improved, worsened, unchanged, brandNew, daysSinceLast, total: segments.length },
    segments,
  };
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const action = req.query.action || req.body?.action || 'load';
  const sector = req.query.sector || req.body?.sector || 'general';

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
      const segmentData = buildSegmentData(allCampaigns);
      const results = {};
      for (const [seg, campaigns] of Object.entries(segmentData)) {
        results[seg] = runAlgorithms(campaigns, sector);
      }
      const recommendations = Object.entries(results)
        .sort((a, b) => {
          const p = { 'Complaint risk': 5, 'Damaged': 4, 'Fatigue building': 3, 'Cooling': 2, 'Recovering': 1 };
          return (p[b[1].sentiment.state] || 0) - (p[a[1].sentiment.state] || 0);
        })
        .slice(0, 3)
        .map(([seg, data]) => ({
          segment: seg,
          verdict: data.sentiment.verdict,
          action: data.sentiment.action,
          type: data.freqTolerance.recommendedType,
          date: data.freqTolerance.optimalNextSend,
          state: data.sentiment.state,
          capital: data.capital,
          unsubRate: data.fingerprint?.selfBaseline,
          benchRate: data.bench?.unsubNormal,
          excessUnsubs: data.subscriberLoss?.totalExcessUnsubs,
        }));

      // Change comparison: most recent snapshot vs the one before it.
      // (On load we don't write a new snapshot — we just surface history.)
      const snapsBySeg = await getSnapshotsBySegment(userId);
      const curMap = {}, prevMap = {};
      for (const seg of Object.keys(snapsBySeg)) {
        const list = snapsBySeg[seg];
        if (list[0]) curMap[seg] = { state: list[0].state, capital: list[0].capital, avgUnsubRate: list[0].avgUnsubRate, excessUnsubs: list[0].excessUnsubs };
        if (list[1]) prevMap[seg] = list[1];
      }
      const changes = Object.keys(curMap).length ? buildChangeComparison(curMap, prevMap) : null;

      return res.status(200).json({ success: true, segments: results, recommendations, sector, changes });
    }

    // ── upload ──────────────────────────────────────────────
    if (action === 'upload') {
      const { rows, fieldMapping, cpl } = req.body;
      if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
      const cplVal = (cpl != null && Number.isFinite(Number(cpl)) && Number(cpl) > 0) ? Number(cpl) : null;

      const rawRows = rows.map(row => {
        const c = {
          segment: null, date: null, unsubscribe_count: null,
          volume_sent: null, open_rate: null, click_rate: null,
          complaint_count: null, campaign_name: null, campaign_type: null,
        };
        for (const [header, targetField] of Object.entries(fieldMapping || {})) {
          const val = row[header];
          if (targetField === 'date') c.date = normaliseDate(val);
          else if (targetField === 'segment') c.segment = String(val || '').trim() || null;
          else if (targetField === 'unsubscribe_count') c.unsubscribe_count = val !== '' && val != null ? (parseInt(val) || 0) : null;
          else if (targetField === 'unsubscribe_rate') {
            // Convert rate to count if we have volume, otherwise store as rate for later
            c._unsubRate = normaliseRate(val);
          }
          else if (targetField === 'volume_sent') c.volume_sent = val !== '' && val != null ? (parseInt(String(val).replace(/,/g, '')) || null) : null;
          else if (targetField === 'open_rate') c.open_rate = normaliseRate(val);
          else if (targetField === 'click_rate') c.click_rate = normaliseRate(val);
          else if (targetField === 'complaint_count') c.complaint_count = val !== '' && val != null ? (parseInt(val) || null) : null;
          else if (targetField === 'campaign_name') c.campaign_name = String(val || '').trim() || null;
          else if (targetField === 'campaign_type') c.campaign_type = String(val || '').trim() || null;
        }
        // If we got a rate but no count, derive count from volume
        if (c._unsubRate !== undefined && c.unsubscribe_count === null && c.volume_sent) {
          c.unsubscribe_count = Math.round(c._unsubRate * c.volume_sent);
        } else if (c._unsubRate !== undefined && c.unsubscribe_count === null) {
          // Store as a proxy — assume 1000 volume for rate-only data
          c.unsubscribe_count = Math.round(c._unsubRate * 1000);
          c.volume_sent = 1000;
        }
        delete c._unsubRate;
        return c;
      }).filter(c => c.date);

      // Merge rows by date + segment
      const mergeMap = {};
      for (const row of rawRows) {
        const key = (row.date || '') + '|' + (row.segment || 'Default');
        if (!mergeMap[key]) {
          mergeMap[key] = { segment: row.segment || 'Default', date: row.date, unsubscribe_count: 0, volume_sent: null, open_rate: null, click_rate: null, complaint_count: null, campaign_name: null, campaign_type: null };
        }
        const m = mergeMap[key];
        if (row.segment) m.segment = row.segment;
        if (row.unsubscribe_count !== null) m.unsubscribe_count = row.unsubscribe_count;
        if (row.volume_sent !== null) m.volume_sent = row.volume_sent;
        if (row.open_rate !== null) m.open_rate = row.open_rate;
        if (row.click_rate !== null) m.click_rate = row.click_rate;
        if (row.complaint_count !== null) m.complaint_count = row.complaint_count;
        if (row.campaign_name) m.campaign_name = row.campaign_name;
        if (row.campaign_type) m.campaign_type = row.campaign_type;
      }

      const campaigns = Object.values(mergeMap);
      if (!campaigns.length) return res.status(400).json({ error: 'No valid rows found. Check that a date column is present and correctly mapped.' });

      // Fetch prior snapshots BEFORE writing new ones, so the comparison
      // reflects the state as it was on the user's previous visit.
      const priorSnapsBySeg = await getSnapshotsBySegment(userId);
      const priorMap = {};
      for (const seg of Object.keys(priorSnapsBySeg)) {
        priorMap[seg] = priorSnapsBySeg[seg][0]; // most recent existing snapshot
      }

      const segmentGroups = buildSegmentData(campaigns);
      const savedSegments = {};
      const currentMap = {};

      for (const [segmentName, segCampaigns] of Object.entries(segmentGroups)) {
        const data = runAlgorithms(segCampaigns, sector);

        for (const c of segCampaigns) {
          const impact = algorithm3_campaignImpact(c, segCampaigns, data.fingerprint, getBenchmark(sector));
          await saveCampaign(userId, segmentName, c, impact);
        }

        await upsertSegment(userId, segmentName, {
          fingerprint: data.fingerprint,
          trustVelocity: data.trustVelocity,
          freqTolerance: data.freqTolerance,
          sentiment: data.sentiment,
          relationshipCapital: data.capital,
          dataQuality: data.dataQuality,
          sector,
        });

        // Append an immutable snapshot of the new state.
        await snapshotSegment(userId, segmentName, { ...data, sector });

        // Collect current state for the change comparison.
        currentMap[segmentName] = {
          state: data.sentiment.state,
          capital: data.capital,
          avgUnsubRate: data.fingerprint?.selfBaseline || null,
          excessUnsubs: data.subscriberLoss?.totalExcessUnsubs || 0,
        };

        const segRecord = await atGet('Audience_Read_Segments', `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`, '', 1);
        const segRecordId = segRecord[0]?.id || null;
        await generateFixes(userId, segmentName, data.sentiment, segRecordId);
        await maybeFireAudienceAlert(userId, segmentName, data.sentiment);

        savedSegments[segmentName] = { ...data, impacts: data.impacts.slice(-5) };
      }

      // ── COMMERCIAL EXPOSURE (v7.1) ────────────────────────────
      // Only when the user supplied a cost-per-subscriber. £ = total
      // excess unsubscribes (above UK benchmark) × their own CPL. Never
      // invented — if no CPL, no commercial figure is produced. Stable
      // sourceRecordId so re-uploads dedupe against any pending item.
      if (cplVal) {
        let totalExcess = 0;
        for (const seg of Object.keys(currentMap)) {
          totalExcess += currentMap[seg].excessUnsubs || 0;
        }
        if (totalExcess > 0) {
          const lossValue = Math.round(totalExcess * cplVal);
          if (lossValue >= 50) {
            try {
              await fetch(`${APP_URL}/api/generate-fix`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                  userId,
                  fixType:        'commercial_loss',
                  description:    `Audience Read: ${totalExcess.toLocaleString()} unsubscribes above the UK benchmark across your segments. At your stated \u00a3${cplVal.toFixed(2)} cost-per-subscriber, that is approximately \u00a3${lossValue.toLocaleString('en-GB')} in acquisition cost lost to avoidable fatigue. Estimated business cost \u2014 not a regulatory fine.`,
                  tool:           'Audience Read',
                  severity:       'medium',
                  contactVolume:  totalExcess,
                  sourceRecordId: 'ar-commercial',
                  exposureLow:    lossValue,
                  exposureHigh:   lossValue,
                }),
              });
            } catch(e) { console.error('Commercial fix non-fatal:', e); }
          }
        }
      }

      const changes = buildChangeComparison(currentMap, priorMap);

      return res.status(200).json({ success: true, segments: savedSegments, campaignsSaved: campaigns.length, sector, changes });
    }

    // ── log ─────────────────────────────────────────────────
    if (action === 'log') {
      const { campaign } = req.body;
      if (!campaign?.date || !campaign?.segment) return res.status(400).json({ error: 'campaign with date and segment required' });

      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = [...allCampaigns.filter(c => c.segment === campaign.segment), campaign]
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const data = runAlgorithms(segCampaigns, sector);
      const bench = getBenchmark(sector);
      const impact = algorithm3_campaignImpact(campaign, segCampaigns, data.fingerprint, bench);

      await saveCampaign(userId, campaign.segment, campaign, impact);
      await upsertSegment(userId, campaign.segment, {
        fingerprint: data.fingerprint,
        trustVelocity: data.trustVelocity,
        freqTolerance: data.freqTolerance,
        sentiment: data.sentiment,
        relationshipCapital: data.capital,
        dataQuality: data.dataQuality,
        sector,
      });

      // Append an immutable snapshot so logged sends build history too.
      await snapshotSegment(userId, campaign.segment, { ...data, sector });

      await generateFixes(userId, campaign.segment, data.sentiment, null);
      await maybeFireAudienceAlert(userId, campaign.segment, data.sentiment);

      return res.status(200).json({ success: true, impact, sentiment: data.sentiment, trustVelocity: data.trustVelocity, capital: data.capital, freqTolerance: data.freqTolerance });
    }

    // ── presend ─────────────────────────────────────────────
    if (action === 'presend') {
      const { segment, campaignType, sendDate } = req.body;
      if (!segment || !campaignType) return res.status(400).json({ error: 'segment and campaignType required' });

      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = allCampaigns.filter(c => c.segment === segment);
      const bench = getBenchmark(sector);
      const fingerprint = algorithm1_fingerprint(segCampaigns, bench);
      const trustVelocity = algorithm2_trustVelocity(segCampaigns, fingerprint);
      const freqTolerance = algorithm4_frequencyTolerance(segCampaigns, fingerprint);
      const prediction = algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance, bench);

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
function gaussianRandom(mean, std) {
  const u1 = Math.random(), u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}
function sigmoidBound(x, cap) { return cap * (2 / (1 + Math.exp(-x / (cap * 0.3))) - 1); }
function dataCompletenessScore(campaigns) {
  const hasOpen = campaigns.some(c => c.open_rate !== null);
  const hasClick = campaigns.some(c => c.click_rate !== null);
  const hasCom = campaigns.some(c => c.complaint_count !== null);
  const hasVol = campaigns.some(c => c.volume_sent !== null);
  if (hasVol && hasOpen && hasClick && hasCom) return 'Full';
  if (hasVol && hasOpen) return 'Partial';
  return 'Minimal';
}
