// api/audience-read.js — Sendwize Audience Read v7.3
// Seven deterministic algorithms. Zero AI. Zero external data.
// v7.3 (C1.2): Fix emission overhaul.
//       - Damaged/Cooling/Fatigue building now emit new Commercial FixTypes:
//         segment_damaged, segment_cooling, segment_declining_engagement.
//       - Cooling now emits a fix (previously none).
//       - Complaint risk still emits consent_missing (ICO, unchanged).
//       - Each Commercial fix carries its own £ figure = segment excess unsubs × CPL.
//       - Removed the aggregate 'commercial_loss' fix at end of upload — per-segment
//         fixes now carry the £, and the aggregate double-counted.
//       - Added D3 ImprovedOnRerun hint: Bad → Good state transitions patch existing
//         pending fixes with a hint rather than closing them. Manual completion only.
//       - Lateral Bad → different-Bad transitions patch the existing fix in place to
//         the new FixType — one open concern per segment, no stale fixes.
//       NOTE: Fatigue building has a real ICO angle (PECR legitimate interest challenge)
//       but that needs the user's lawful basis, which lives in Campaign Dossier. Deferred.
// v7.2: normaliseRate fix — '0.8%' now correctly returns 0.008 not 0.8.
//       Campaign name detection uses lc.includes(w) — Subject Line, Email Subject etc now detected.
//       Segment name fallback: frontend prompts user to name list instead of silently using Default.
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

const BENCHMARKS = {
  ecommerce: {
    label: 'Ecommerce / Retail',
    unsubGood:      0.001,
    unsubNormal:    0.003,
    unsubConcern:   0.005,
    unsubDamaged:   0.010,
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
    unsubGood:      0.0005,
    unsubNormal:    0.0015,
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
    unsubNormal:    0.0022,
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
  finance: {
    label: 'Finance / Financial Services',
    unsubGood:      0.0005,
    unsubNormal:    0.0015,
    unsubConcern:   0.003,
    unsubDamaged:   0.007,
    openGood:       0.28,
    openNormal:     0.20,
    openPoor:       0.12,
    clickGood:      0.025,
    clickNormal:    0.015,
    clickPoor:      0.005,
    source: 'DMA UK 2025 + GDMA International Benchmark 2024',
  },
  health: {
    label: 'Health / Healthcare',
    unsubGood:      0.0006,
    unsubNormal:    0.0018,
    unsubConcern:   0.004,
    unsubDamaged:   0.008,
    openGood:       0.30,
    openNormal:     0.22,
    openPoor:       0.13,
    clickGood:      0.025,
    clickNormal:    0.015,
    clickPoor:      0.005,
    source: 'MailerLite 2025 + DMA UK 2025',
  },
  general: {
    label: 'General / Mixed',
    unsubGood:      0.001,
    unsubNormal:    0.0022,
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

function detectColumnType(header, values) {
  const lc = header.toLowerCase().trim();
  const sample = values.filter(v => v !== null && v !== undefined && v !== '');
  if (!sample.length) return 'unknown';
  if (lc.includes('date') || lc.includes('sent on') || lc.includes('send date')) return 'date';
  const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  if (sample.filter(v => dateRe.test(String(v).trim())).length / sample.length > 0.7) return 'date';
  const segWords = ['segment', 'list', 'audience', 'group', 'tag', 'list name', 'list / segment', 'audience name'];
  if (segWords.some(w => lc.includes(w))) return 'segment';
  // v7.2: use lc.includes(w) not hardcoded 'campaign name' so Subject Line, Email Subject etc match
  const campWords = ['campaign name', 'campaign', 'subject line', 'subject', 'email name', 'email subject', 'name'];
  if (campWords.some(w => lc === w || lc.includes(w))) return 'campaign_name';
  if (lc.includes('type') || lc.includes('kind') || lc.includes('category')) return 'campaign_type';
  const nums = sample.map(v => parseFloat(String(v).replace('%', ''))).filter(n => !isNaN(n));
  const pctSample = sample.filter(v => String(v).includes('%'));
  const isPct = pctSample.length / sample.length > 0.5;
  if (nums.length / sample.length > 0.8) {
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
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// v7.2 fix: track % sign BEFORE stripping — '0.8%' stripped to 0.8 is < 1
// so the old n > 1 check returned 0.8 (= 80% unsub rate). Now always /100 if % present.
function normaliseRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const raw = String(v).trim();
  const hasPct = raw.includes('%');
  const n = parseFloat(raw.replace('%', ''));
  if (isNaN(n)) return null;
  if (hasPct) return n / 100;
  return n > 1 ? n / 100 : n;
}

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
        breakdown.push({ campaign: c.campaign_name || 'Campaign', date: c.date, excess, rate: r4(rate), benchRate });
      }
    }
  }
  return { totalExcessUnsubs: totalLost, damagingCampaigns: totalDamagingCampaigns, breakdown: breakdown.slice(-5) };
}

function algorithm1_fingerprint(campaigns, bench) {
  const n = campaigns.length;
  if (!n) return null;
  const unsubRates = campaigns.map(c => c.unsubscribe_count / Math.max(c.volume_sent || 1000, 1));
  const sorted = [...unsubRates].sort((a, b) => a - b);
  const lo = Math.floor(n * 0.2), hi = Math.ceil(n * 0.8);
  const trimmed = sorted.slice(lo, hi);
  const selfBaseline = trimmed.length ? mean_arr(trimmed) : bench.unsubNormal;
  const effectiveBaseline = Math.max(selfBaseline, bench.unsubGood);
  const openRates = campaigns.map(c => c.open_rate).filter(r => r !== null);
  const clickRates = campaigns.map(c => c.click_rate).filter(r => r !== null);
  const baselineOpen = openRates.length ? mean_arr(openRates) : null;
  const baselineClick = clickRates.length ? mean_arr(clickRates) : null;
  const mean_u = mean_arr(unsubRates);
  const variance = unsubRates.reduce((s, v) => s + Math.pow(v - mean_u, 2), 0) / n;
  const stddev = Math.sqrt(variance);
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
      const inWindow = campaigns.filter(c => { const d = new Date(c.date); return d >= windowStart && d <= windowEnd; });
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
  for (const [type, rates] of Object.entries(typeGroups)) { typeSensitivity[type] = r4(mean_arr(rates)); }
  return {
    selfBaseline: r4(selfBaseline), effectiveBaseline: r4(effectiveBaseline),
    benchmarkNormal: bench.unsubNormal, baselineOpenRate: baselineOpen !== null ? r4(baselineOpen) : null,
    baselineClickRate: baselineClick !== null ? r4(baselineClick) : null,
    unsubscribeStdDev: r4(stddev), trendDelta: r4(trendDelta),
    frequencyToleranceThreshold: Math.round(frequencyThreshold), campaignTypeSensitivity: typeSensitivity,
    recoveryHalfLife: 3, campaignCount: n, dataCompleteness: dataCompletenessScore(campaigns),
    vsBenchmark: benchmarkVerdict(mean_u, bench),
  };
}

function algorithm2_trustVelocity(campaigns, fingerprint) {
  const n = campaigns.length;
  if (n < 2) return { velocity: 0, direction: 'Stable', magnitude: 0 };
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
  const velocity = (stream1 * 0.45 + stream2 * 0.30 + stream4 * 0.25);
  let direction;
  if (velocity > 0.5) direction = 'Rapid decline';
  else if (velocity > 0.1) direction = 'Declining';
  else if (velocity < -0.1) direction = 'Improving';
  else direction = 'Stable';
  return { velocity: r4(velocity), direction, magnitude: r4(Math.abs(velocity)) };
}

function algorithm3_campaignImpact(campaign, allCampaigns, fingerprint, bench) {
  if (!fingerprint) return null;
  const volumeSent = campaign.volume_sent || 1000;
  const unsubRate = campaign.unsubscribe_count / volumeSent;
  const benchNormal = bench.unsubNormal;
  const selfBaseline = fingerprint.selfBaseline;
  const zBench = (unsubRate - benchNormal) / (bench.unsubNormal * 0.5 + 0.0001);
  const zSelf = fingerprint.unsubscribeStdDev > 0 ? (unsubRate - selfBaseline) / (fingerprint.unsubscribeStdDev + 0.0001) : 0;
  const zScore = zBench * 0.6 + zSelf * 0.4;
  const impactScore = -zScore;
  const expectedVsBench = Math.round(volumeSent * benchNormal);
  const excessUnsubs = Math.max(0, campaign.unsubscribe_count - expectedVsBench);
  let category, plainVerdict;
  if (impactScore > 0.8) { category = 'Built trust'; plainVerdict = `Below UK benchmark — your audience responded well to this.`; }
  else if (impactScore > 0.2) { category = 'Built trust'; plainVerdict = `Slightly below benchmark — mild positive signal.`; }
  else if (impactScore > -0.3) { category = 'Neutral'; plainVerdict = `Normal unsubscribe rate — within UK benchmark range (${(benchNormal * 100).toFixed(2)}%).`; }
  else if (impactScore > -1.0) { category = 'Caused fatigue'; plainVerdict = `Above UK benchmark${excessUnsubs > 0 ? ` — about ${excessUnsubs} more unsubscribes than expected` : ''}. Audience is signalling too much email.`; }
  else { category = 'Damaged'; plainVerdict = `Significantly above UK benchmark${excessUnsubs > 0 ? ` — ${excessUnsubs} more unsubscribes than expected` : ''}. This send hurt the relationship.`; }
  return { impactScore: r4(impactScore), zScore: r4(zScore), category, plainVerdict, unsubRate: r4(unsubRate), benchmarkRate: benchNormal, excessUnsubs, campaign_name: campaign.campaign_name, date: campaign.date };
}

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
  let recommendedType = toleranceRemaining <= 1 ? 'Transactional' : toleranceRemaining <= 2 ? 'Newsletter' : 'Promotional';
  return { toleranceRemaining, optimalNextSend, recommendedType, recentSendCount: recentCampaigns.length, adjustedThreshold: threshold };
}

function algorithm5_sentimentInference(fingerprint, trustVelocity, freqTolerance, recentImpacts, capital, bench, sector) {
  const cap = capital || 0;
  if (!fingerprint) {
    return { state: 'Neutral', verdict: 'Upload your send history to get a diagnosis', statement: 'We need at least 3 campaigns to generate a meaningful diagnosis for this segment.', action: 'Upload a CSV with date, segment name, and unsubscribe count to get started.', statementCommercial: null, statementRegulatory: null, regulatoryNote: null, confidence: 0.3 };
  }
  const n = fingerprint.campaignCount;
  const direction = trustVelocity.direction;
  const tolerance = freqTolerance.toleranceRemaining;
  const recentDamage = recentImpacts.filter(i => i.category === 'Damaged' || i.category === 'Caused fatigue').length;
  const recentBuilt = recentImpacts.filter(i => i.category === 'Built trust').length;
  const baseConf = Math.min(0.5 + n * 0.04, 0.95);
  const avgUnsubRate = fingerprint.selfBaseline;
  const benchNormal = bench.unsubNormal;
  const benchGood = bench.unsubGood;
  const benchConcern = bench.unsubConcern;
  const benchDamaged = bench.unsubDamaged;
  const avgPct = (avgUnsubRate * 100).toFixed(2) + '%';
  const benchPct = (benchNormal * 100).toFixed(2) + '%';
  const vsBench = fingerprint.vsBenchmark;
  const aboveBenchBy = vsBench.pctVsBenchmark ? `${vsBench.pctVsBenchmark}% above the UK ${bench.label} benchmark` : null;
  const recoveryDays = Math.round((fingerprint.recoveryHalfLife || 3) * 7);

  const hasComplaints = recentImpacts.some(i => i._hasComplaints);
  if (hasComplaints && avgUnsubRate > benchConcern) {
    return { state: 'Complaint risk', verdict: 'Stop sending to this segment now', statement: `This segment is generating complaint signals with an average unsubscribe rate of ${avgPct} — well above the UK ${bench.label} benchmark of ${benchPct}. The ICO monitors exactly this pattern.`, action: 'Stop all promotional sends immediately. Run a re-permission campaign — anyone who does not re-consent should be suppressed.', statementCommercial: 'Audiences in complaint territory stop converting before they formally complain. Revenue from this segment will be near zero until trust is rebuilt.', statementRegulatory: 'Complaint signals combined with above-benchmark unsubscribe rates is the pattern the ICO identifies before opening PECR Regulation 22 enforcement investigations.', regulatoryNote: 'This pattern is statistically associated with formal ICO complaints. The window to act without enforcement consequences is typically 30–60 days.', confidence: r2(Math.min(baseConf, 0.92)) };
  }
  if (avgUnsubRate > benchDamaged || (avgUnsubRate > benchConcern && direction === 'Rapid decline' && recentDamage >= 2)) {
    const capNote = cap < 0 ? 'The negative relationship capital means this segment has little goodwill left to absorb further sends.' : 'Some positive relationship capital remains — recovery is possible if you act now.';
    return { state: 'Damaged', verdict: 'This segment needs a break from you', statement: `Average unsubscribe rate ${avgPct} — ${aboveBenchBy || `above the UK ${bench.label} benchmark of ${benchPct}`}. Recent sends are causing above-average audience exit.`, action: `Pause all promotional sends for at least ${recoveryDays} days. One low-key value newsletter only. Return to promotional sends only after unsubscribes drop back below ${benchPct}.`, statementCommercial: `You have approximately ${recoveryDays} days before this segment becomes effectively unreachable for promotional sends. ${capNote}`, statementRegulatory: null, regulatoryNote: null, confidence: r2(Math.min(baseConf, 0.88)) };
  }
  if (avgUnsubRate > benchNormal && tolerance <= 1 && direction !== 'Improving') {
    return { state: 'Fatigue building', verdict: "You're sending too much to this segment", statement: `Average unsubscribe rate ${avgPct} vs UK ${bench.label} benchmark of ${benchPct}. You've sent ${freqTolerance.recentSendCount} campaigns in the last 30 days and frequency tolerance is almost gone. The next promotional send is likely to push this above ${(benchConcern * 100).toFixed(2)}%.`, action: `No promotional sends this month. Maximum one newsletter. Give this segment a ${recoveryDays}-day gap before any commercial content.`, statementCommercial: 'Fatigued audiences stop opening before they unsubscribe. Open rates will continue dropping even if you reduce frequency — the damage takes 3–4 weeks to reverse.', statementRegulatory: 'High frequency combined with above-benchmark unsubscribes is the pattern the ICO uses to challenge legitimate interest bases under PECR. Your audience is signalling the contact is no longer welcome.', regulatoryNote: cap < -20 ? 'With negative relationship capital and rising unsubscribes, your send history would struggle to pass an ICO legitimate interest balance test if reviewed.' : null, confidence: r2(Math.min(baseConf, 0.85)) };
  }
  if (avgUnsubRate > benchNormal && direction === 'Declining') {
    return { state: 'Cooling', verdict: 'This segment is losing interest', statement: `Unsubscribes trending up across your last ${Math.min(n, 6)} campaigns. Average ${avgPct} — ${aboveBenchBy || `above UK ${bench.label} benchmark of ${benchPct}`}. You still have ${tolerance} send${tolerance !== 1 ? 's' : ''} of tolerance, but the trend is against you.`, action: 'Try a preference-update email — ask them what they want to hear about. One re-engagement send before resuming your normal schedule.', statementCommercial: 'Cooling audiences convert at a fraction of their peak rate. Sending more will accelerate the decline — the opportunity is to reverse it now while they are still reachable.', statementRegulatory: null, regulatoryNote: null, confidence: r2(Math.min(baseConf, 0.78)) };
  }
  if (avgUnsubRate <= benchGood && direction === 'Improving' && tolerance >= 3 && recentBuilt >= 2) {
    return { state: 'Peak receptiveness', verdict: 'Best window to send — act this week', statement: `Average unsubscribe rate ${avgPct} — well below the UK ${bench.label} benchmark of ${benchPct}. ${recentBuilt} recent sends built trust. You have ${tolerance} sends of remaining tolerance. This is your best window.`, action: 'Send your highest-value promotional or product announcement now. This window typically lasts 2–3 weeks before tolerance starts narrowing.', statementCommercial: 'Peak-receptiveness audiences convert at measurably higher rates than normal. A promotional campaign sent now will outperform the same campaign sent in 2 weeks.', statementRegulatory: null, regulatoryNote: null, confidence: r2(Math.min(baseConf, 0.88)) };
  }
  if ((direction === 'Improving' || direction === 'Stable') && recentDamage >= 1 && recentBuilt >= 1) {
    const conf = r2(Math.min(baseConf, 0.78));
    if (cap >= 40) return { state: 'Recovering', verdict: 'Recovering well — one more careful send', statement: `Recent damage is reversing. Average unsub rate ${avgPct} vs benchmark ${benchPct}. Strong relationship capital (+${cap.toFixed(0)}/100) is cushioning the recovery.`, action: `Send one value-first newsletter — no promotional content. If unsubscribes stay below ${benchPct}, resume normal sending in ${Math.round(recoveryDays * 0.6)} days.`, statementCommercial: 'High capital means this audience is more forgiving than their recent numbers suggest. A well-timed value send could accelerate recovery.', statementRegulatory: null, regulatoryNote: null, confidence: conf };
    if (cap >= 10) return { state: 'Recovering', verdict: 'Recovering — handle with care', statement: `Early signs of recovery after recent damage. Average unsub rate ${avgPct} vs benchmark ${benchPct}. Relationship capital (+${cap.toFixed(0)}/100) is moderate — another poor send would reverse progress.`, action: `High-value sends only for the next ${recoveryDays} days. No promotional campaigns. Monitor every send — if unsubscribes exceed ${(benchConcern * 100).toFixed(2)}% stop immediately.`, statementCommercial: 'Revenue will return, but slowly. One badly timed promotional send now could push this segment back into damaged territory.', statementRegulatory: null, regulatoryNote: null, confidence: conf };
    return { state: 'Recovering', verdict: 'Fragile recovery — do not send yet', statement: `Mathematical recovery signs present but relationship capital (${cap.toFixed(0)}/100) is too low to risk a send. Average unsub rate ${avgPct} vs benchmark ${benchPct}.`, action: `Do not send anything for at least ${recoveryDays} days. Rebuild capital with 3–4 positive sends before attempting any promotional campaign.`, statementCommercial: 'Low-capital recoveries are fragile. This segment needs more positive campaign history before it will convert at normal rates.', statementRegulatory: cap < 0 ? 'Negative relationship capital combined with recent damage is a pattern the ICO and ASA would note as evidence of repeated audience harm if reviewing your send history.' : null, regulatoryNote: null, confidence: r2(conf * 0.9) };
  }
  if (avgUnsubRate <= benchNormal && direction !== 'Declining') {
    const capCtx = cap >= 30 ? `Strong relationship capital (+${cap.toFixed(0)}/100).` : cap >= 10 ? `Positive relationship capital (+${cap.toFixed(0)}/100).` : 'Relationship capital is neutral.';
    return { state: 'Healthy', verdict: 'Looking good — proceed as planned', statement: `Average unsubscribe rate ${avgPct} is at or below the UK ${bench.label} benchmark of ${benchPct}. ${capCtx} No concerning trends detected.`, action: 'Proceed with your planned campaign. Monitor unsubscribes on the next send — flag if they exceed the benchmark.', statementCommercial: 'A healthy segment converts at predictable rates. Maintain current frequency and content quality.', statementRegulatory: null, regulatoryNote: null, confidence: r2(Math.min(baseConf, 0.80)) };
  }
  const capNote = cap > 20 ? `Relationship capital is positive (+${cap.toFixed(0)}/100).` : cap < -10 ? `Relationship capital is negative (${cap.toFixed(0)}/100) — worth reviewing recent performance before sending.` : 'Relationship capital is neutral.';
  return { state: 'Neutral', verdict: 'No strong signals — proceed normally', statement: `Average unsubscribe rate ${avgPct} vs UK ${bench.label} benchmark of ${benchPct}. ${capNote} No strong trend in either direction after ${n} campaign${n !== 1 ? 's' : ''}.`, action: 'Proceed with your planned campaign. Monitor unsubscribes on the next send.', statementCommercial: 'Neutral state means sends will perform at your historical average rates.', statementRegulatory: null, regulatoryNote: null, confidence: r2(Math.min(baseConf, 0.65)) };
}

function algorithm6_predictiveSend(segment, campaignType, sendDate, fingerprint, trustVelocity, freqTolerance, bench) {
  if (!fingerprint) return { verdict: 'Amber', confidence: 0.5, reason: 'Not enough historical data to predict impact. Proceed cautiously.', alternatives: [], predictedUnsubRange: null };
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
  if (spikeProb < 0.15 && freqTolerance.toleranceRemaining > 1 && p50 <= benchNormal) { verdict = 'Green'; reason = `Low risk. Predicted unsubscribe rate ${(p50 * 100).toFixed(2)}%–${(p90 * 100).toFixed(2)}% — within UK ${bench.label} benchmark range (${(benchNormal * 100).toFixed(2)}%).`; confidence = r2(0.85 - spikeProb); }
  else if (spikeProb < 0.4 || freqTolerance.toleranceRemaining === 1) { verdict = 'Amber'; reason = `Moderate risk. ${Math.round(spikeProb * 100)}% chance of exceeding UK benchmark. Predicted rate ${(p50 * 100).toFixed(2)}% vs benchmark ${(benchNormal * 100).toFixed(2)}%.`; confidence = r2(0.7 - spikeProb * 0.3); }
  else { verdict = 'Red'; reason = `High risk. ${Math.round(spikeProb * 100)}% chance of exceeding UK concern threshold. Current segment state is not ready for a ${campaignType} send.`; confidence = r2(0.9 - spikeProb * 0.2); }
  const alternatives = [];
  if (verdict !== 'Green') {
    const safestType = freqTolerance.recommendedType;
    if (safestType !== campaignType) alternatives.push({ change: `Switch to ${safestType}`, reason: `${safestType} sends have lower unsubscribe impact for this segment right now.` });
    alternatives.push({ change: `Send on ${freqTolerance.optimalNextSend} instead`, reason: 'Waiting for the tolerance window to recover would reduce spike probability.' });
    alternatives.push({ change: 'Test with 30% of the segment first', reason: 'A smaller test send lets you measure response before committing the full list.' });
  }
  return { verdict, confidence, reason, predictedUnsubRange: { low: r4(p10), mid: r4(p50), high: r4(p90) }, spikeProb: r2(spikeProb), benchmarkRate: benchNormal, alternatives };
}

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
    const impactRaw = (benchNormal - rate) / (benchNormal + 0.001) * 20;
    const recoveryBonus = capital < -20 && impactRaw > 0 ? impactRaw * 0.5 : 0;
    capital += (impactRaw + recoveryBonus) * decayFactor;
    capital = sigmoidBound(capital, 100);
  }
  return r2(Math.max(-100, Math.min(100, capital)));
}

function runAlgorithms(campaigns, sector = 'general') {
  const bench = getBenchmark(sector);
  const fingerprint = algorithm1_fingerprint(campaigns, bench);
  const trustVelocity = algorithm2_trustVelocity(campaigns, fingerprint);
  const freqTolerance = algorithm4_frequencyTolerance(campaigns, fingerprint);
  const impacts = campaigns.map(c => algorithm3_campaignImpact(c, campaigns, fingerprint, bench) || null).filter(Boolean);
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
  return { fingerprint, trustVelocity, freqTolerance, sentiment, capital, impacts: impacts.slice(-10), dataQuality, missingData, subscriberLoss, bench: { label: bench.label, unsubNormal: bench.unsubNormal, source: bench.source }, sector };
}

function buildSegmentData(campaigns) {
  const bySegment = {};
  for (const c of campaigns) {
    const seg = c.segment || 'Default';
    if (!bySegment[seg]) bySegment[seg] = [];
    bySegment[seg].push(c);
  }
  for (const seg of Object.keys(bySegment)) { bySegment[seg].sort((a, b) => new Date(a.date) - new Date(b.date)); }
  return bySegment;
}

// ─────────────────────────────────────────────────────────────
// v7.3 (C1.2): Fix emission overhaul.
//
// State → FixType mapping:
//   Complaint risk      → consent_missing            (ICO, critical) — unchanged
//   Damaged             → segment_damaged            (Commercial, high)  — NEW
//   Fatigue building    → segment_declining_engagement (Commercial, medium) — NEW
//   Cooling             → segment_cooling            (Commercial, medium) — NEW (previously no fix)
//   Recovering/Healthy/Neutral/Peak/Highly receptive → no fix
//
// £ figure for the three Commercial types = segment's excess unsubs × CPL.
// Zero if CPL not set on profile. SourceRecordID = Audience_Read_Segments record ID.
//
// On re-run:
//   • Bad → Good  : mark existing pending fix with ImprovedOnRerun hint (per D3).
//                   Fix stays open — user must manually mark complete.
//   • Bad → same-bad : dedup no-op (existing pending fix stays as-is; exposure refreshed).
//   • Bad → different-bad (e.g. Damaged → Cooling) : patch existing pending fix
//                   in place to the new FixType/description/exposure. One open fix per segment.
//   • Good → Bad  : create new fix.
//
// Note: Fatigue building has a real ICO angle (PECR legitimate interest challenge)
// but that requires knowing the user's lawful basis. Deferred until lawful basis is
// wired in from Campaign Dossier — for now only the Commercial fix is emitted.
// ─────────────────────────────────────────────────────────────

const FIX_GOOD_STATES = new Set(['Healthy', 'Neutral', 'Recovering', 'Peak receptiveness', 'Highly receptive post-gap']);
const FIX_BAD_STATES  = new Set(['Damaged', 'Cooling', 'Fatigue building', 'Complaint risk']);

function buildFixSpecForState(state, confidence, segmentName, excessUnsubs, commercialImpact) {
  if (confidence < 0.7) return null;
  const excessNote = excessUnsubs > 0 ? ` ${excessUnsubs.toLocaleString()} excess unsubscribes above UK benchmark.` : '';
  if (state === 'Complaint risk') {
    return {
      fixType: 'consent_missing',
      description: `Audience Read \u2014 ${segmentName}: Complaint risk detected.${excessNote}`.trim(),
      severity: 'critical',
      exposureLow: null,   // ICO — realistic range applied inside generate-fix
      exposureHigh: null,
    };
  }
  if (state === 'Damaged') {
    return {
      fixType: 'segment_damaged',
      description: `Audience Read \u2014 ${segmentName}: Segment damaged by above-benchmark unsubscribes.${excessNote}`.trim(),
      severity: 'high',
      exposureLow: commercialImpact,
      exposureHigh: commercialImpact,
    };
  }
  if (state === 'Fatigue building') {
    return {
      fixType: 'segment_declining_engagement',
      description: `Audience Read \u2014 ${segmentName}: Send frequency building fatigue \u2014 unsubs above UK benchmark.${excessNote}`.trim(),
      severity: 'medium',
      exposureLow: commercialImpact,
      exposureHigh: commercialImpact,
    };
  }
  if (state === 'Cooling') {
    return {
      fixType: 'segment_cooling',
      description: `Audience Read \u2014 ${segmentName}: Segment cooling \u2014 interest declining, unsubs trending up.${excessNote}`.trim(),
      severity: 'medium',
      exposureLow: commercialImpact,
      exposureHigh: commercialImpact,
    };
  }
  return null;
}

async function getPendingAudienceFixesForSegment(userId, sourceRecordId) {
  if (!sourceRecordId) return [];
  try {
    const formula = `AND({UserID}="${userId}",{SourceRecordID}="${sourceRecordId}",{Status}="pending",{Tool}="Audience Read")`;
    return await atGet('Compliance_Fixes', formula, '', 5);
  } catch (err) {
    console.error(`Pending fix lookup failed for ${sourceRecordId} (non-fatal):`, err);
    return [];
  }
}

async function markFixesImproved(existingFixes, previousState, currentState) {
  const payload = JSON.stringify({
    previousState,
    newState: currentState,
    detectedAt: new Date().toISOString().slice(0, 10),
  });
  for (const rec of existingFixes) {
    try {
      await atPatch('Compliance_Fixes', rec.id, { ImprovedOnRerun: payload });
    } catch (err) {
      console.error(`markFixesImproved patch failed for ${rec.id}:`, err);
    }
  }
}

async function generateFixes(userId, segmentName, sentiment, sourceRecordId, excessUnsubs, cpl, previousState) {
  const { state, confidence } = sentiment;
  const commercialImpact = (Number.isFinite(excessUnsubs) && Number.isFinite(cpl) && cpl > 0)
    ? Math.max(0, Math.round(excessUnsubs * cpl))
    : 0;
  const fixSpec = buildFixSpecForState(state, confidence, segmentName, excessUnsubs || 0, commercialImpact);
  const existing = await getPendingAudienceFixesForSegment(userId, sourceRecordId);

  // Case A: current state is good — if a pending fix exists and previous was bad, mark improved.
  if (FIX_GOOD_STATES.has(state)) {
    if (existing.length && previousState && FIX_BAD_STATES.has(previousState)) {
      await markFixesImproved(existing, previousState, state);
    }
    return;
  }

  // Case B: no fix applicable for current state (e.g. confidence too low, unmapped state).
  if (!fixSpec) return;

  // Case C: pending fix with the same FixType already exists — refresh exposure/description,
  // clear any stale improvement hint (state has re-worsened).
  const sameType = existing.find(r => r.fields.FixType === fixSpec.fixType);
  if (sameType) {
    try {
      const patch = { Description: fixSpec.description, ImprovedOnRerun: null };
      if (fixSpec.exposureLow != null) patch.ExposureLow = fixSpec.exposureLow;
      if (fixSpec.exposureHigh != null) patch.ExposureHigh = fixSpec.exposureHigh;
      await atPatch('Compliance_Fixes', sameType.id, patch);
    } catch (err) {
      console.error(`Same-type refresh failed for ${sameType.id} (non-fatal):`, err);
    }
    return;
  }

  // Case D: pending fix exists but for a different FixType (lateral bad-to-bad transition)
  // — patch existing fix in place to the new state. One open concern per segment.
  const otherType = existing.find(r => r.fields.FixType !== fixSpec.fixType);
  if (otherType) {
    try {
      const patch = {
        FixType: fixSpec.fixType,
        Description: fixSpec.description,
        Severity: fixSpec.severity,
        ImprovedOnRerun: null,
      };
      if (fixSpec.exposureLow != null) patch.ExposureLow = fixSpec.exposureLow;
      if (fixSpec.exposureHigh != null) patch.ExposureHigh = fixSpec.exposureHigh;
      await atPatch('Compliance_Fixes', otherType.id, patch);
    } catch (err) {
      console.error(`Lateral-state patch failed for ${otherType.id} (non-fatal):`, err);
    }
    return;
  }

  // Case E: no existing pending fix — create new via generate-fix.
  try {
    const body = {
      userId,
      fixType: fixSpec.fixType,
      description: fixSpec.description,
      tool: 'Audience Read',
      severity: fixSpec.severity,
      sourceRecordId: sourceRecordId || null,
    };
    if (fixSpec.exposureLow != null) body.exposureLow = fixSpec.exposureLow;
    if (fixSpec.exposureHigh != null) body.exposureHigh = fixSpec.exposureHigh;
    await fetch(`${APP_URL}/api/generate-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`generate-fix failed for ${fixSpec.fixType} (${segmentName}):`, err);
  }
}

async function maybeFireAudienceAlert(userId, segmentName, sentiment) {
  if (!['Complaint risk', 'Damaged'].includes(sentiment.state)) return;
  try {
    await fetch(`${APP_URL}/api/data?action=send-alert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, alertType: 'audience_damaged', segmentName, sentimentState: sentiment.state, regulatoryNote: sentiment.regulatoryNote || null }) });
  } catch (err) { console.error('audience_damaged alert failed (non-fatal):', err); }
}

async function upsertSegment(userId, segmentName, data) {
  const records = await atGet('Audience_Read_Segments', `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`, '', 1);
  const fields = { UserID: userId, SegmentName: segmentName, FingerprintJSON: JSON.stringify(data.fingerprint), TrustVelocity: data.trustVelocity.velocity, TrustVelocityDirection: data.trustVelocity.direction, RelationshipCapital: data.relationshipCapital, FrequencyTolerance: data.freqTolerance.toleranceRemaining, OptimalNextSendDate: data.freqTolerance.optimalNextSend, SentimentState: data.sentiment.state, SentimentConfidence: data.sentiment.confidence, LastUpdated: new Date().toISOString().slice(0, 10), CampaignCount: data.fingerprint?.campaignCount || 0, DataQuality: data.dataQuality, Sector: data.sector || 'general' };
  if (records.length) await atPatch('Audience_Read_Segments', records[0].id, fields);
  else await atCreate('Audience_Read_Segments', fields);
}

async function saveCampaign(userId, segmentName, campaign, impact) {
  await atCreate('Audience_Read_Campaigns', { UserID: userId, SegmentName: segmentName, CampaignName: campaign.campaign_name || 'Campaign', CampaignType: campaign.campaign_type || null, SendDate: campaign.date, VolumeSent: campaign.volume_sent || null, UnsubscribeCount: campaign.unsubscribe_count || 0, OpenRate: campaign.open_rate || null, ClickRate: campaign.click_rate || null, ComplaintCount: campaign.complaint_count || null, ImpactScore: impact?.impactScore || null, ImpactCategory: impact?.category || null, ImpactReason: impact?.plainVerdict || null, RecoveryDaysEstimated: null, UnsubRate: impact?.unsubRate || null, ExcessUnsubs: impact?.excessUnsubs || null });
}

async function loadCampaigns(userId) {
  const records = await atGet('Audience_Read_Campaigns', `{UserID}="${userId}"`, 'sort[0][field]=SendDate&sort[0][direction]=asc', 500);
  return records.map(r => ({ segment: r.fields.SegmentName, campaign_name: r.fields.CampaignName, campaign_type: r.fields.CampaignType, date: r.fields.SendDate, volume_sent: r.fields.VolumeSent || null, unsubscribe_count: r.fields.UnsubscribeCount || 0, open_rate: r.fields.OpenRate || null, click_rate: r.fields.ClickRate || null, complaint_count: r.fields.ComplaintCount || null }));
}

const STATE_RANK = { 'Complaint risk': 0, 'Damaged': 1, 'Fatigue building': 2, 'Cooling': 3, 'Recovering': 4, 'Neutral': 5, 'Healthy': 6, 'Highly receptive post-gap': 7, 'Peak receptiveness': 8 };

async function snapshotSegment(userId, segmentName, data) {
  await atCreate('Audience_Read_Snapshots', { UserID: userId, SegmentName: segmentName, SnapshotDate: new Date().toISOString().slice(0, 10), SnapshotTimestamp: new Date().toISOString(), State: data.sentiment?.state || 'Neutral', Capital: data.capital != null ? data.capital : (data.relationshipCapital || 0), AvgUnsubRate: data.fingerprint?.selfBaseline || null, ExcessUnsubs: data.subscriberLoss?.totalExcessUnsubs || 0, CampaignCount: data.fingerprint?.campaignCount || 0, Sector: data.sector || 'general' });
}

async function getSnapshotsBySegment(userId) {
  const records = await atGet('Audience_Read_Snapshots', `{UserID}="${userId}"`, 'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc', 200);
  const bySeg = {};
  for (const r of records) {
    const seg = r.fields.SegmentName;
    if (!seg) continue;
    if (!bySeg[seg]) bySeg[seg] = [];
    bySeg[seg].push({ date: r.fields.SnapshotDate, timestamp: r.fields.SnapshotTimestamp || r.fields.SnapshotDate, state: r.fields.State || 'Neutral', capital: r.fields.Capital != null ? r.fields.Capital : 0, avgUnsubRate: r.fields.AvgUnsubRate != null ? r.fields.AvgUnsubRate : null, excessUnsubs: r.fields.ExcessUnsubs != null ? r.fields.ExcessUnsubs : 0, campaignCount: r.fields.CampaignCount || 0 });
  }
  return bySeg;
}

function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.abs(Math.round((a - b) / 86400000));
}

function buildChangeComparison(currentMap, priorMap) {
  const segments = [];
  let improved = 0, worsened = 0, unchanged = 0, brandNew = 0;
  for (const seg of Object.keys(currentMap)) {
    const cur = currentMap[seg];
    const prev = priorMap[seg] || null;
    if (!prev) { brandNew++; segments.push({ segment: seg, isNew: true, currentState: cur.state, previousState: null, stateChanged: false, direction: 'new', capitalDelta: null, avgUnsubRateDelta: null, excessUnsubsDelta: null, daysSincePrevious: null }); continue; }
    const curRank = STATE_RANK[cur.state] != null ? STATE_RANK[cur.state] : 5;
    const prevRank = STATE_RANK[prev.state] != null ? STATE_RANK[prev.state] : 5;
    const stateChanged = cur.state !== prev.state;
    let direction = 'same';
    if (stateChanged) direction = curRank > prevRank ? 'improved' : 'worsened';
    const capitalDelta = (cur.capital != null && prev.capital != null) ? r2(cur.capital - prev.capital) : null;
    const avgUnsubRateDelta = (cur.avgUnsubRate != null && prev.avgUnsubRate != null) ? r4(cur.avgUnsubRate - prev.avgUnsubRate) : null;
    const excessUnsubsDelta = (cur.excessUnsubs != null && prev.excessUnsubs != null) ? (cur.excessUnsubs - prev.excessUnsubs) : null;
    if (stateChanged) { if (direction === 'improved') improved++; else worsened++; }
    else if (capitalDelta != null && capitalDelta >= 5) { improved++; direction = 'improved'; }
    else if (capitalDelta != null && capitalDelta <= -5) { worsened++; direction = 'worsened'; }
    else { unchanged++; }
    segments.push({ segment: seg, isNew: false, currentState: cur.state, previousState: prev.state, stateChanged, direction, capitalDelta, avgUnsubRateDelta, excessUnsubsDelta, daysSincePrevious: daysBetween(new Date().toISOString(), prev.timestamp) });
  }
  const order = { worsened: 0, improved: 1, new: 2, same: 3 };
  segments.sort((a, b) => (order[a.direction] ?? 9) - (order[b.direction] ?? 9));
  let daysSinceLast = null;
  for (const s of segments) { if (s.daysSincePrevious != null) { daysSinceLast = daysSinceLast == null ? s.daysSincePrevious : Math.min(daysSinceLast, s.daysSincePrevious); } }
  return { summary: { improved, worsened, unchanged, brandNew, daysSinceLast, total: segments.length }, segments };
}

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
    if (action === 'detect') {
      const { headers, rows } = req.body;
      if (!headers || !rows) return res.status(400).json({ error: 'headers and rows required' });
      return res.status(200).json({ success: true, mapping: autoMapColumns(headers, rows) });
    }
    if (action === 'load') {
      const allCampaigns = await loadCampaigns(userId);
      const segmentData = buildSegmentData(allCampaigns);
      const results = {};
      for (const [seg, campaigns] of Object.entries(segmentData)) { results[seg] = runAlgorithms(campaigns, sector); }
      const recommendations = Object.entries(results).sort((a, b) => { const p = { 'Complaint risk': 5, 'Damaged': 4, 'Fatigue building': 3, 'Cooling': 2, 'Recovering': 1 }; return (p[b[1].sentiment.state] || 0) - (p[a[1].sentiment.state] || 0); }).slice(0, 3).map(([seg, data]) => ({ segment: seg, verdict: data.sentiment.verdict, action: data.sentiment.action, type: data.freqTolerance.recommendedType, date: data.freqTolerance.optimalNextSend, state: data.sentiment.state, capital: data.capital, unsubRate: data.fingerprint?.selfBaseline, benchRate: data.bench?.unsubNormal, excessUnsubs: data.subscriberLoss?.totalExcessUnsubs }));
      const snapsBySeg = await getSnapshotsBySegment(userId);
      const curMap = {}, prevMap = {};
      for (const seg of Object.keys(snapsBySeg)) { const list = snapsBySeg[seg]; if (list[0]) curMap[seg] = { state: list[0].state, capital: list[0].capital, avgUnsubRate: list[0].avgUnsubRate, excessUnsubs: list[0].excessUnsubs }; if (list[1]) prevMap[seg] = list[1]; }
      const changes = Object.keys(curMap).length ? buildChangeComparison(curMap, prevMap) : null;
      return res.status(200).json({ success: true, segments: results, recommendations, sector, changes });
    }
    if (action === 'upload') {
      const { rows, fieldMapping, cpl } = req.body;
      if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
      const cplVal = (cpl != null && Number.isFinite(Number(cpl)) && Number(cpl) > 0) ? Number(cpl) : null;
      const rawRows = rows.map(row => {
        const c = { segment: null, date: null, unsubscribe_count: null, volume_sent: null, open_rate: null, click_rate: null, complaint_count: null, campaign_name: null, campaign_type: null };
        for (const [header, targetField] of Object.entries(fieldMapping || {})) {
          const val = row[header];
          if (targetField === 'date') c.date = normaliseDate(val);
          else if (targetField === 'segment') c.segment = String(val || '').trim() || null;
          else if (targetField === 'unsubscribe_count') c.unsubscribe_count = val !== '' && val != null ? (parseInt(val) || 0) : null;
          else if (targetField === 'unsubscribe_rate') { c._unsubRate = normaliseRate(val); }
          else if (targetField === 'volume_sent') c.volume_sent = val !== '' && val != null ? (parseInt(String(val).replace(/,/g, '')) || null) : null;
          else if (targetField === 'open_rate') c.open_rate = normaliseRate(val);
          else if (targetField === 'click_rate') c.click_rate = normaliseRate(val);
          else if (targetField === 'complaint_count') c.complaint_count = val !== '' && val != null ? (parseInt(val) || null) : null;
          else if (targetField === 'campaign_name') c.campaign_name = String(val || '').trim() || null;
          else if (targetField === 'campaign_type') c.campaign_type = String(val || '').trim() || null;
        }
        if (c._unsubRate !== undefined && c.unsubscribe_count === null && c.volume_sent) { c.unsubscribe_count = Math.round(c._unsubRate * c.volume_sent); }
        else if (c._unsubRate !== undefined && c.unsubscribe_count === null) { c.unsubscribe_count = Math.round(c._unsubRate * 1000); c.volume_sent = 1000; }
        delete c._unsubRate;
        return c;
      }).filter(c => c.date);
      const mergeMap = {};
      for (const row of rawRows) {
        const key = (row.date || '') + '|' + (row.segment || 'Default');
        if (!mergeMap[key]) { mergeMap[key] = { segment: row.segment || 'Default', date: row.date, unsubscribe_count: 0, volume_sent: null, open_rate: null, click_rate: null, complaint_count: null, campaign_name: null, campaign_type: null }; }
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
      const priorSnapsBySeg = await getSnapshotsBySegment(userId);
      const priorMap = {};
      for (const seg of Object.keys(priorSnapsBySeg)) { priorMap[seg] = priorSnapsBySeg[seg][0]; }
      const segmentGroups = buildSegmentData(campaigns);
      const savedSegments = {};
      const currentMap = {};
      for (const [segmentName, segCampaigns] of Object.entries(segmentGroups)) {
        const data = runAlgorithms(segCampaigns, sector);
        for (const c of segCampaigns) { const impact = algorithm3_campaignImpact(c, segCampaigns, data.fingerprint, getBenchmark(sector)); await saveCampaign(userId, segmentName, c, impact); }
        await upsertSegment(userId, segmentName, { fingerprint: data.fingerprint, trustVelocity: data.trustVelocity, freqTolerance: data.freqTolerance, sentiment: data.sentiment, relationshipCapital: data.capital, dataQuality: data.dataQuality, sector });
        await snapshotSegment(userId, segmentName, { ...data, sector });
        currentMap[segmentName] = { state: data.sentiment.state, capital: data.capital, avgUnsubRate: data.fingerprint?.selfBaseline || null, excessUnsubs: data.subscriberLoss?.totalExcessUnsubs || 0 };
        const segRecord = await atGet('Audience_Read_Segments', `AND({UserID}="${userId}",{SegmentName}="${segmentName}")`, '', 1);
        const segRecordId = segRecord[0]?.id || null;
        // v7.3 (C1.2): pass per-segment excess unsubs, CPL and previous state so fix
        // emission can (a) compute Commercial exposure per segment and (b) detect
        // Bad \u2192 Good improvements for the D3 ImprovedOnRerun hint.
        const segExcess = data.subscriberLoss?.totalExcessUnsubs || 0;
        const previousState = priorMap[segmentName]?.state || null;
        await generateFixes(userId, segmentName, data.sentiment, segRecordId, segExcess, cplVal, previousState);
        await maybeFireAudienceAlert(userId, segmentName, data.sentiment);
        savedSegments[segmentName] = { ...data, impacts: data.impacts.slice(-5) };
      }
      // v7.3 (C1.2): aggregate 'commercial_loss' fix removed. Per-segment
      // segment_damaged / segment_cooling / segment_declining_engagement fixes each
      // carry their own \u00a3 figure now, so an aggregate would double-count on Tile 1/2.
      const changes = buildChangeComparison(currentMap, priorMap);
      return res.status(200).json({ success: true, segments: savedSegments, campaignsSaved: campaigns.length, sector, changes });
    }
    if (action === 'log') {
      const { campaign } = req.body;
      if (!campaign?.date || !campaign?.segment) return res.status(400).json({ error: 'campaign with date and segment required' });
      const allCampaigns = await loadCampaigns(userId);
      const segCampaigns = [...allCampaigns.filter(c => c.segment === campaign.segment), campaign].sort((a, b) => new Date(a.date) - new Date(b.date));
      const data = runAlgorithms(segCampaigns, sector);
      const bench = getBenchmark(sector);
      const impact = algorithm3_campaignImpact(campaign, segCampaigns, data.fingerprint, bench);
      await saveCampaign(userId, campaign.segment, campaign, impact);
      await upsertSegment(userId, campaign.segment, { fingerprint: data.fingerprint, trustVelocity: data.trustVelocity, freqTolerance: data.freqTolerance, sentiment: data.sentiment, relationshipCapital: data.capital, dataQuality: data.dataQuality, sector });
      await snapshotSegment(userId, campaign.segment, { ...data, sector });
      // v7.3 (C1.2): log path doesn't carry CPL or previous state, so Commercial \u00a3 is 0
      // and ImprovedOnRerun won't fire from this route. Log is a single-campaign entry;
      // re-run improvement detection is the upload path's job.
      const segRecord = await atGet('Audience_Read_Segments', `AND({UserID}="${userId}",{SegmentName}="${campaign.segment}")`, '', 1);
      const segRecordId = segRecord[0]?.id || null;
      const segExcess = data.subscriberLoss?.totalExcessUnsubs || 0;
      await generateFixes(userId, campaign.segment, data.sentiment, segRecordId, segExcess, null, null);
      await maybeFireAudienceAlert(userId, campaign.segment, data.sentiment);
      return res.status(200).json({ success: true, impact, sentiment: data.sentiment, trustVelocity: data.trustVelocity, capital: data.capital, freqTolerance: data.freqTolerance });
    }
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
