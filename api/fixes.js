// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v6.2
// GET  /api/fixes?action=get&userId=x      → list + score + exposure
// POST /api/fixes?action=complete          → mark fix done
// POST /api/fixes?action=dismiss           → exclude from score
//
// v6.2 changes from v6.1:
//   - Exposure model rebuilt around three honest layers:
//
//     LAYER 1 — Revenue-banded comparable case range
//     Unchanged from v6.1. Anchored on published pre-DUAA ICO
//     enforcement decisions. Labelled explicitly as historical.
//
//     LAYER 2 — Contextual factors
//     Two lists: what pushes a case toward the LOW end of the range,
//     what pushes it toward the HIGH end. Derived from the user's
//     specific processing context (data types, volume, breach history,
//     DPA status, documented assessment). Shown alongside the range
//     so users can self-assess where they sit. Not a prediction.
//
//     LAYER 3 — DUAA warning (unmissable)
//     The comparable case ranges are pre-DUAA. DUAA 2025 raised the
//     ICO maximum to £17.5M or 4% global turnover. No post-DUAA PECR
//     decisions published yet — when they are, ranges will be updated.
//     This warning is a first-class field on every ICO exposure object,
//     not a footnote. It renders prominently in dashboard and fix cards.
//
//   - buildExposureForFix() now accepts processingContext (optional).
//     If provided, derives contextual factors specific to that
//     processing relationship. If absent, returns generic factors
//     from lowDriver/highDriver — backwards compatible.
//
//   - ASA referral risk model unchanged from v6.1.
//   - CMA legal max only unchanged.
//   - getRealisticMidpoint() unchanged — still band-based for
//     actioned risk sum. No processing context applied to midpoint
//     to avoid liability from over-precise completed fix values.
//
// LEGAL POSITION:
//   Ranges = comparable published cases, not a prediction.
//   Contextual factors = educational framing, not a personalised
//   fine estimate. DUAA caveat is unmissable on every ICO display.
//   Nothing in this file constitutes legal advice.
// ─────────────────────────────────────────────────────────────

// ── REVENUE BAND NORMALISATION ────────────────────────────────
const REVENUE_BAND_MAP = {
  'Under \u00a31M':             'under_1m',
  '\u00a31M \u2013 \u00a310M':  '1m_10m',
  '\u00a310M \u2013 \u00a350M': '10m_50m',
  'Over \u00a350M':             'over_50m',
  under_1m: 'under_1m',
  '1m_10m': '1m_10m',
  '10m_50m':'10m_50m',
  over_50m: 'over_50m',
};

function normaliseBand(raw) {
  return REVENUE_BAND_MAP[raw] || 'under_1m';
}

// ── LEGAL STRINGS ─────────────────────────────────────────────
const ICO_LEGAL_MAX    = '\u00a317.5M or 4% of global annual turnover \u2014 whichever is higher (DUAA 2025)';
const CMA_LEGAL_MAX    = 'Higher of \u00a3300,000 or 10% of global annual turnover (DMCCA 2024)';
const NOT_LEGAL_ADVICE = 'Illustrative ranges based on published enforcement data. Not a prediction. Not legal advice.';

const DUAA_WARNING = [
  'These ranges are based on ICO enforcement decisions issued before the Data Use and Access Act 2025.',
  'DUAA has significantly increased the ICO\u2019s maximum PECR fine to \u00a317.5M or 4% of global turnover.',
  'The ICO is expected to use these new powers. Sendwize will update ranges as post-DUAA decisions are published.',
  'Your actual exposure under DUAA could be substantially higher than these historical ranges suggest.',
].join(' ');

// ── EXPOSURE CONSTANTS ────────────────────────────────────────
// Revenue-banded ranges anchored on published pre-DUAA ICO decisions.
// lowDriver / highDriver = generic contextual factors used when no
// processingContext is provided. buildExposureForFix() derives
// specific factors when processingContext is available.
//
// Band rationale:
//   under_1m  — ICO has never fined a <£1M business above ~£40k for
//               a first PECR offence in published pre-DUAA decisions.
//   1m_10m    — Mid-market. Most published £20k–£80k decisions here.
//   10m_50m   — Upper mid-market. Decisions trend £40k–£120k.
//   over_50m  — Largest published PECR fines approach legal max.
//
// Review quarterly: ico.org.uk/action-weve-taken/enforcement
// First post-DUAA PECR decision = update ALL ranges upward.

const EXPOSURE_CONSTANTS = {

  consent_missing: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 8000,   high: 40000  },
      '1m_10m':  { low: 20000,  high: 80000  },
      '10m_50m': { low: 40000,  high: 120000 },
      over_50m:  { low: 70000,  high: 140000 },
    },
    lowDriver:  'First offence, small contact volume, prompt remediation on discovery, full ICO cooperation',
    highDriver: 'Repeated or deliberate breach, large contact volume, prior ICO enforcement history, complaints received',
  },
  consent_expired: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 5000,   high: 25000  },
      '1m_10m':  { low: 12000,  high: 50000  },
      '10m_50m': { low: 25000,  high: 70000  },
      over_50m:  { low: 45000,  high: 80000  },
    },
    lowDriver:  'First offence, prompt action on discovery, aging consent identified and suppressed quickly',
    highDriver: 'Deliberate inaction, large expired consent volume, complaints received from contacts',
  },
  suppression_breach: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 12000,  high: 50000  },
      '1m_10m':  { low: 30000,  high: 100000 },
      '10m_50m': { low: 60000,  high: 160000 },
      over_50m:  { low: 100000, high: 200000 },
    },
    lowDriver:  'Small post opt-out contact volume, isolated incident, no prior suppression failures',
    highDriver: 'Systematic suppression failure, large volume, deliberate disregard for opt-out requests',
  },
  dpa_breach: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 20000,  high: 100000 },
      '1m_10m':  { low: 50000,  high: 250000 },
      '10m_50m': { low: 100000, high: 400000 },
      over_50m:  { low: 200000, high: 500000 },
    },
    lowDriver:  'Minor technical breach, no data exposed, prompt remediation, DPA obtained quickly on discovery',
    highDriver: 'Sensitive or special category data involved, large scale exposure, negligent security, vendor has prior enforcement history',
  },
  legitimate_interest_abuse: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 5000,   high: 30000  },
      '1m_10m':  { low: 15000,  high: 60000  },
      '10m_50m': { low: 30000,  high: 85000  },
      over_50m:  { low: 55000,  high: 100000 },
    },
    lowDriver:  'Proportionality marginally failed, low contact volume, LI assessment documented',
    highDriver: 'Clearly disproportionate processing, high frequency, multiple complaints, no LI assessment documented',
  },
  data_quality: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 2000,   high: 10000  },
      '1m_10m':  { low: 5000,   high: 18000  },
      '10m_50m': { low: 10000,  high: 25000  },
      over_50m:  { low: 15000,  high: 30000  },
    },
    lowDriver:  'Minor data quality issues, isolated, prompt remediation',
    highDriver: 'Systemic data quality failures, large volume affected, no remediation plan',
  },

  // ── ASA — referral risk model, no £ figure ──────────────────
  fake_urgency: {
    category:     'ASA',
    referralRisk: 'medium',
    referralNote: 'Countdown timers and urgency claims without genuine scarcity are a common ASA complaint trigger. Repeat or widespread breaches can be referred to Trading Standards under DMCCA 2024.',
  },
  misleading_claim: {
    category:     'ASA',
    referralRisk: 'medium',
    referralNote: 'Substantiated product or service claims that cannot be proven are among the most frequently upheld ASA rulings. Deliberate or systemic misrepresentation increases referral risk.',
  },
  misleading_reference_price: {
    category:     'ASA',
    referralRisk: 'high',
    referralNote: 'Reference pricing is a specific DMCCA 2024 target. The CMA has signalled active enforcement of fake \u2018was/now\u2019 pricing. High likelihood of Trading Standards referral for repeat offences.',
  },
  undisclosed_ad: {
    category:     'ASA',
    referralRisk: 'low',
    referralNote: 'Failure to label marketing as advertising is a common first-time finding. Prompt remediation typically results in a compliance request without Trading Standards referral.',
  },

  // ── CMA — legal max only ─────────────────────────────────────
  drip_pricing: { category: 'CMA' },
  fake_reviews:  { category: 'CMA' },
};

// ── EXPOSURE HELPERS ──────────────────────────────────────────
function getExposureConstants(fixType) {
  return EXPOSURE_CONSTANTS[(fixType || '').toLowerCase()] || null;
}

function getICORange(def, revenueBand) {
  const band = normaliseBand(revenueBand || 'under_1m');
  return def.bands[band] || def.bands['under_1m'];
}

function getRealisticMidpoint(fixType, revenueBand) {
  const def = getExposureConstants(fixType);
  if (!def || def.category !== 'ICO') return 0;
  const range = getICORange(def, revenueBand);
  return Math.round((range.low + range.high) / 2);
}

// ── CONTEXTUAL FACTORS ────────────────────────────────────────
// Derives specific low/high drivers from processing context.
// Returns { lowFactors: string[], highFactors: string[] }
// Used to show users what puts their case toward low vs high end.
// This is educational framing — NOT a personalised fine estimate.
//
// processingContext shape (all optional):
// {
//   dataTypes:               string[]  — e.g. ['Email addresses','Purchase history']
//   contactVolume:           number    — contacts affected
//   vendorBreachHistory:     string    — breach text or 'None identified'
//   dpaStatus:               string    — 'Confirmed','On Request','Refused','Unknown'
//   hasDocumentedAssessment: boolean
//   vendorName:              string
// }
function deriveContextualFactors(fixType, def, ctx) {
  if (!ctx) {
    return {
      lowFactors:  [def.lowDriver].filter(Boolean),
      highFactors: [def.highDriver].filter(Boolean),
    };
  }

  const lowFactors  = [];
  const highFactors = [];

  const dataTypes    = Array.isArray(ctx.dataTypes) ? ctx.dataTypes : [];
  const volume       = typeof ctx.contactVolume === 'number' ? ctx.contactVolume : null;
  const breach       = (ctx.vendorBreachHistory || '').toLowerCase();
  const dpaStatus    = (ctx.dpaStatus || '').toLowerCase();
  const hasDoc       = !!ctx.hasDocumentedAssessment;
  const breachKnown  = breach && !['none identified','none','no','unknown',''].includes(breach);

  const hasSensitive   = dataTypes.some(d => /special category|health|biometric|political|religion|sexual/i.test(d));
  const hasBehavioural = dataTypes.some(d => /behavioural|behaviour|purchase|financial/i.test(d));
  const emailOnly      = dataTypes.length > 0 && dataTypes.every(d => /email/i.test(d));

  // Data type factors
  if (emailOnly) {
    lowFactors.push('Email addresses only — lower sensitivity data type in published ICO decisions');
  } else if (hasSensitive) {
    highFactors.push('Special category or sensitive data involved — ICO applies significantly higher scrutiny');
  } else if (hasBehavioural) {
    highFactors.push('Behavioural or purchase data included — higher value personal data increases severity');
  }

  // Volume factors
  if (volume !== null) {
    if (volume < 10000) {
      lowFactors.push(`Small contact volume (${volume.toLocaleString()} contacts) — published decisions show volume is a significant mitigating factor`);
    } else if (volume > 100000) {
      highFactors.push(`Large contact volume (${volume.toLocaleString()} contacts) — scale is a consistent aggravating factor in ICO decisions`);
    }
  }

  // Breach history
  if (breachKnown) {
    highFactors.push('Confirmed breach or enforcement history at this vendor — using a processor with known enforcement history is an aggravating factor if ICO investigates');
  } else {
    lowFactors.push('No confirmed breach history at this vendor — clean enforcement record is a mitigating factor');
  }

  // DPA status
  if (dpaStatus === 'confirmed') {
    lowFactors.push('DPA in place — Article 28 compliance confirmed, significantly reduces exposure for this specific breach type');
  } else if (dpaStatus === 'refused') {
    highFactors.push('Vendor has refused to sign a DPA — continuing to share data after refusal is a serious aggravating factor');
  } else if (dpaStatus === 'on request') {
    lowFactors.push('DPA in progress — actively seeking a DPA demonstrates good faith, mitigates somewhat');
  }

  // Documented assessment
  if (hasDoc) {
    lowFactors.push('Documented assessment on file — demonstrable due diligence is consistently cited as a mitigating factor by the ICO');
  } else {
    highFactors.push('No documented assessment — absence of due diligence records removes a key mitigating argument');
  }

  // Fall back to generic drivers if nothing derived
  if (!lowFactors.length)  lowFactors.push(def.lowDriver);
  if (!highFactors.length) highFactors.push(def.highDriver);

  return { lowFactors, highFactors };
}

// ── BUILD EXPOSURE FOR FIX ────────────────────────────────────
// Main function used by formatFix() and dashboard rendering.
// processingContext is optional — backwards compatible with v6.1.
//
// Returns full exposure object with three layers:
//   1. Revenue-banded range (historical comparable cases)
//   2. Contextual factors (low/high drivers)
//   3. DUAA warning (unmissable for all ICO items)
function buildExposureForFix(fixType, revenueBand, processingContext) {
  const def = getExposureConstants(fixType);

  if (!def) {
    return {
      category:      'unknown',
      hasRange:      false,
      legalMax:      null,
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'ICO') {
    const range   = getICORange(def, revenueBand);
    const ctx     = processingContext || null;
    const factors = deriveContextualFactors(fixType, def, ctx);

    return {
      category:      'ICO',
      hasRange:      true,
      realisticLow:  range.low,
      realisticHigh: range.high,
      midpoint:      Math.round((range.low + range.high) / 2),
      revenueBand:   normaliseBand(revenueBand || 'under_1m'),

      // Layer 2 — contextual factors
      lowFactors:    factors.lowFactors,
      highFactors:   factors.highFactors,
      hasContext:    !!ctx,

      // Layer 3 — DUAA warning (unmissable)
      duaaWarning:   DUAA_WARNING,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',

      disclaimer:    NOT_LEGAL_ADVICE,
      rangeLabel:    'Comparable published cases (pre-DUAA) \u00b7 not a prediction \u00b7 not legal advice',
    };
  }

  if (def.category === 'ASA') {
    const riskLabel = { low: 'Low referral risk', medium: 'Medium referral risk', high: 'High referral risk' };
    const riskColour = { low: 'green', medium: 'amber', high: 'red' };
    return {
      category:        'ASA',
      hasRange:        false,
      reputationalRisk: true,
      referralRisk:    def.referralRisk || 'medium',
      referralRiskLabel: riskLabel[def.referralRisk] || 'Medium referral risk',
      referralRiskColour: riskColour[def.referralRisk] || 'amber',
      referralNote:    def.referralNote || '',
      cmaIfReferred:   CMA_LEGAL_MAX,
      reputationalNote: 'ASA does not impose direct financial fines. An upheld ruling is published permanently on asa.org.uk \u2014 searchable by customers, investors, and competitors. Serious or repeat breaches can be referred to Trading Standards under DMCCA 2024, at which point CMA fines apply.',
      disclaimer:      NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'CMA') {
    return {
      category:      'CMA',
      hasRange:      false,
      legalMax:      CMA_LEGAL_MAX,
      legalMaxLabel: 'CMA statutory maximum (DMCCA 2024)',
      cmaNote:       'The CMA can impose fines directly without court proceedings under DMCCA 2024. Businesses that co-operate promptly and demonstrate genuine remediation can negotiate settlement discounts.',
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  return { category: def.category, hasRange: false, disclaimer: NOT_LEGAL_ADVICE };
}

// ── SCORE BAND ────────────────────────────────────────────────
function getScoreBand(s) {
  if (s === 0)  return { label: 'Not Started',     colour: '#9ca3af' };
  if (s <= 25)  return { label: 'At Risk',         colour: '#ef4444' };
  if (s <= 50)  return { label: 'Needs Attention', colour: '#f97316' };
  if (s <= 75)  return { label: 'In Progress',     colour: '#eab308' };
  if (s <= 90)  return { label: 'Good Standing',   colour: '#0d9488' };
  return         { label: 'Strong Posture',        colour: '#16a34a' };
}

// ── FORMAT FIX ────────────────────────────────────────────────
function formatFix(r, revenueBand) {
  const fixType          = (r.fields.FixType || '').toLowerCase();
  const processingContext = (() => {
    try { return r.fields.ProcessingContext ? JSON.parse(r.fields.ProcessingContext) : null; }
    catch(e) { return null; }
  })();
  const exposure = buildExposureForFix(fixType, revenueBand, processingContext);

  return {
    id:               r.id,
    fixType,
    description:      r.fields.Description    || '',
    tool:             r.fields.Tool           || '',
    severity:         r.fields.Severity       || '',
    status:           r.fields.Status         || 'pending',
    contactVolume:    r.fields.ContactVolume  || null,
    sourceRecordId:   r.fields.SourceRecordID || null,
    completedDate:    r.fields.CompletedDate  || null,
    createdDate:      r.fields.CreatedDate    || null,
    processingContext,
    exposure,
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;

  // Fetch User_Profile and Compliance_Fixes in parallel
  const [profileRes, fixesRes] = await Promise.all([
    fetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }),
    fetch(`${base}/Compliance_Fixes?filterByFormula={UserID}='${userId}'&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }),
  ]);

  if (!fixesRes.ok) {
    console.error('Compliance_Fixes fetch failed:', fixesRes.status);
    return res.status(fixesRes.status).json({ error: 'Failed to retrieve fixes' });
  }

  let revenueBand = 'under_1m';
  try {
    if (profileRes.ok) {
      const pd = await profileRes.json();
      revenueBand = pd.records?.[0]?.fields?.RevenueBand || 'under_1m';
    }
  } catch(e) { console.error('Profile parse failed (non-fatal):', e); }

  const all       = (await fixesRes.json()).records || [];
  const pending   = all.filter(x => x.fields.Status === 'pending');
  const completed = all.filter(x => x.fields.Status === 'completed');
  const dismissed = all.filter(x => x.fields.Status === 'dismissed');
  const active    = pending.length + completed.length;
  const score     = active > 0 ? Math.round((completed.length / active) * 100) : 0;
  const band      = getScoreBand(score);

  const pendingFormatted   = pending.map(r => formatFix(r, revenueBand));
  const completedFormatted = completed.map(r => formatFix(r, revenueBand));
  const dismissedFormatted = dismissed.map(r => formatFix(r, revenueBand));

  const actionedTotal = completedFormatted.reduce((sum, f) => {
    return sum + getRealisticMidpoint(f.fixType, revenueBand);
  }, 0);

  const icoP = pendingFormatted.filter(f => f.exposure?.category === 'ICO').length;
  const asaP = pendingFormatted.filter(f => f.exposure?.category === 'ASA').length;
  const cmaP = pendingFormatted.filter(f => f.exposure?.category === 'CMA').length;

  const now           = new Date();
  const assessedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return res.json({
    success:      true,
    score,
    scoreBand:    band.label,
    scoreColour:  band.colour,
    revenueBand:  normaliseBand(revenueBand),
    counts: {
      pending:   pending.length,
      completed: completed.length,
      dismissed: dismissed.length,
      active,
    },
    actioned: {
      total:         actionedTotal,
      count:         completedFormatted.length,
      assessedMonth,
      disclaimer:    NOT_LEGAL_ADVICE,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',
      duaaWarning:   DUAA_WARNING,
    },
    categoryCounts: {
      pending:   { ico: icoP, asa: asaP, cma: cmaP },
      completed: {
        ico: completedFormatted.filter(f => f.exposure?.category === 'ICO').length,
        asa: completedFormatted.filter(f => f.exposure?.category === 'ASA').length,
        cma: completedFormatted.filter(f => f.exposure?.category === 'CMA').length,
      },
    },
    fixes: {
      pending:   pendingFormatted,
      completed: completedFormatted,
      dismissed: dismissedFormatted,
    },
  });
}

// ── COMPLETE ──────────────────────────────────────────────────
async function handleComplete(req, res) {
  const { userId, fixId } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({ fields: { Status: 'completed', CompletedDate: new Date().toISOString().split('T')[0] } }),
  });
  if (!ur.ok) return res.status(ur.status).json({ error: 'Failed to complete fix' });

  // Fetch revenue band for accurate midpoint
  let revenueBand = 'under_1m';
  try {
    const pr = await fetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) { const pd = await pr.json(); revenueBand = pd.records?.[0]?.fields?.RevenueBand || 'under_1m'; }
  } catch(e) {}

  const fixType = (fix.fields.FixType || '').toLowerCase();
  const midpoint = getRealisticMidpoint(fixType, revenueBand);

  return res.json({ success: true, fixId, fixType, midpoint, disclaimer: NOT_LEGAL_ADVICE, message: 'Fix marked as complete.' });
}

// ── DISMISS ───────────────────────────────────────────────────
async function handleDismiss(req, res) {
  const { userId, fixId } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({ fields: { Status: 'dismissed' } }),
  });
  if (!ur.ok) return res.status(ur.status).json({ error: 'Failed to dismiss fix' });

  return res.json({ success: true, fixId, message: 'Fix dismissed.' });
}

// ── ROUTER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    if (req.method === 'GET'  && action === 'get')     return await handleGet(req, res);
    if (req.method === 'POST' && action === 'complete') return await handleComplete(req, res);
    if (req.method === 'POST' && action === 'dismiss')  return await handleDismiss(req, res);
    return res.status(400).json({ error: 'Unknown action. Use ?action=get|complete|dismiss' });
  } catch (error) {
    console.error('fixes.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
