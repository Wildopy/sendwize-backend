// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v6.6
// GET  /api/fixes?action=get&userId=x[&revenueBand=...]
// POST /api/fixes?action=complete          → mark fix done
// POST /api/fixes?action=dismiss           → exclude from score
//
// v6.6 changes (C1.4):
//   - formatFix() now surfaces two new fields on every returned fix:
//       · improvedOnRerun — parsed JSON hint written by audience-read.js
//         (session 5) and list-intelligence.js (session 6). Shape:
//         { previousState, newState, detectedAt, source }. If the field
//         is empty or unparseable, this is null (never the raw string).
//       · completionSource — string tag written when a fix was closed.
//         'manual' for user-clicked "Mark fixed", 'improved_on_rerun'
//         for user-confirmed rerun improvements. Null on pending fixes
//         and on any completed fix that predates this deploy.
//   - handleComplete() accepts an optional { completionSource } in the
//     POST body. Writes it to Compliance_Fixes.CompletionSource. If the
//     caller doesn't pass one, defaults to 'manual' so we always have a
//     tag on newly-completed fixes for later analytics.
//
//   Airtable schema requirement for this deploy: add one field to
//   Compliance_Fixes named CompletionSource (Long text). ImprovedOnRerun
//   already exists from session 5.
//
// v6.5 unchanged: profile piggyback in handleGet.
// v6.4 unchanged: revenueBand query-param shortcut, atFetch retry.
// v6.3 unchanged: Commercial exposure category.
// v6.2 unchanged: three-layer ICO exposure model.
//
// LEGAL POSITION:
//   Regulatory ranges = comparable published cases, not a prediction.
//   Commercial figures = estimated business cost from the user's own
//   inputs, explicitly not a regulatory fine. Nothing here is legal advice.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

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
const COMMERCIAL_DISCLAIMER = 'Estimated business cost based on your own inputs \u2014 not a regulatory fine, and not legal advice.';
const DUAA_WARNING = [
  'These ranges are based on ICO enforcement decisions issued before the Data Use and Access Act 2025.',
  'DUAA has significantly increased the ICO\u2019s maximum PECR fine to \u00a317.5M or 4% of global turnover.',
  'The ICO is expected to use these new powers. Sendwize will update ranges as post-DUAA decisions are published.',
  'Your actual exposure under DUAA could be substantially higher than these historical ranges suggest.',
].join(' ');

// ── EXPOSURE CONSTANTS ────────────────────────────────────────
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
  drip_pricing:    { category: 'CMA' },
  fake_reviews:    { category: 'CMA' },
  commercial_loss: { category: 'Commercial' },
  // v7.3 (session 5) segment types — Commercial category, £ from stored fields
  segment_damaged:              { category: 'Commercial' },
  segment_cooling:              { category: 'Commercial' },
  segment_declining_engagement: { category: 'Commercial' },
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
  if (emailOnly) {
    lowFactors.push('Email addresses only \u2014 lower sensitivity data type in published ICO decisions');
  } else if (hasSensitive) {
    highFactors.push('Special category or sensitive data involved \u2014 ICO applies significantly higher scrutiny');
  } else if (hasBehavioural) {
    highFactors.push('Behavioural or purchase data included \u2014 higher value personal data increases severity');
  }
  if (volume !== null) {
    if (volume < 10000) {
      lowFactors.push(`Small contact volume (${volume.toLocaleString()} contacts) \u2014 published decisions show volume is a significant mitigating factor`);
    } else if (volume > 100000) {
      highFactors.push(`Large contact volume (${volume.toLocaleString()} contacts) \u2014 scale is a consistent aggravating factor in ICO decisions`);
    }
  }
  if (breachKnown) {
    highFactors.push('Confirmed breach or enforcement history at this vendor \u2014 using a processor with known enforcement history is an aggravating factor if ICO investigates');
  } else {
    lowFactors.push('No confirmed breach history at this vendor \u2014 clean enforcement record is a mitigating factor');
  }
  if (dpaStatus === 'confirmed') {
    lowFactors.push('DPA in place \u2014 Article 28 compliance confirmed, significantly reduces exposure for this specific breach type');
  } else if (dpaStatus === 'refused') {
    highFactors.push('Vendor has refused to sign a DPA \u2014 continuing to share data after refusal is a serious aggravating factor');
  } else if (dpaStatus === 'on request') {
    lowFactors.push('DPA in progress \u2014 actively seeking a DPA demonstrates good faith, mitigates somewhat');
  }
  if (hasDoc) {
    lowFactors.push('Documented assessment on file \u2014 demonstrable due diligence is consistently cited as a mitigating factor by the ICO');
  } else {
    highFactors.push('No documented assessment \u2014 absence of due diligence records removes a key mitigating argument');
  }
  if (!lowFactors.length)  lowFactors.push(def.lowDriver);
  if (!highFactors.length) highFactors.push(def.highDriver);
  return { lowFactors, highFactors };
}

// ── BUILD EXPOSURE FOR FIX ────────────────────────────────────
function buildExposureForFix(fixType, revenueBand, processingContext, storedExposure) {
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
      lowFactors:    factors.lowFactors,
      highFactors:   factors.highFactors,
      hasContext:    !!ctx,
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
  if (def.category === 'Commercial') {
    const low  = storedExposure && Number.isFinite(storedExposure.low)  ? storedExposure.low  : 0;
    const high = storedExposure && Number.isFinite(storedExposure.high) ? storedExposure.high : low;
    return {
      category:       'Commercial',
      hasRange:       high > low,
      isCommercial:   true,
      realisticLow:   low,
      realisticHigh:  high,
      midpoint:       Math.round((low + high) / 2),
      legalMax:       null,
      rangeLabel:     'Estimated business cost \u00b7 from your own inputs \u00b7 not a regulatory fine',
      disclaimer:     COMMERCIAL_DISCLAIMER,
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
// v6.6 — surfaces improvedOnRerun (parsed) and completionSource.
function formatFix(r, revenueBand) {
  const fixType          = (r.fields.FixType || '').toLowerCase();
  const processingContext = (() => {
    try { return r.fields.ProcessingContext ? JSON.parse(r.fields.ProcessingContext) : null; }
    catch(e) { return null; }
  })();
  const storedExposure = {
    low:  r.fields.ExposureLow  != null ? Number(r.fields.ExposureLow)  : null,
    high: r.fields.ExposureHigh != null ? Number(r.fields.ExposureHigh) : null,
  };
  // v6.6 (C1.4) — parse the hint. Tolerate malformed JSON so a bad
  // Airtable value never breaks the whole /api/fixes response.
  const improvedOnRerun = (() => {
    const raw = r.fields.ImprovedOnRerun;
    if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      console.warn(`ImprovedOnRerun parse failed for fix ${r.id} — treating as null.`);
      return null;
    }
  })();
  const exposure = buildExposureForFix(fixType, revenueBand, processingContext, storedExposure);
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
    // v6.6 (C1.4)
    improvedOnRerun,
    completionSource: r.fields.CompletionSource || null,
    processingContext,
    exposure,
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId, revenueBand: revenueBandParam } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;

  let revenueBand = revenueBandParam ? normaliseBand(revenueBandParam) : null;
  let profileFields = null;

  const fixesPromise = atFetch(
    `${base}/Compliance_Fixes?filterByFormula={UserID}='${userId}'&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const profilePromise = revenueBand
    ? Promise.resolve(null)
    : atFetch(
        `${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
  const [fixesRes, profileRes] = await Promise.all([fixesPromise, profilePromise]);
  if (!fixesRes.ok) {
    console.error('Compliance_Fixes fetch failed after retries:', fixesRes.status);
    return res.status(fixesRes.status).json({ error: 'Failed to retrieve fixes' });
  }
  if (!revenueBand) {
    revenueBand = 'under_1m';
    try {
      if (profileRes && profileRes.ok) {
        const pd = await profileRes.json();
        const rec = pd.records?.[0] || null;
        if (rec) {
          profileFields = rec.fields;
          revenueBand = rec.fields?.RevenueBand || 'under_1m';
        }
      } else if (profileRes && !profileRes.ok) {
        console.error('User_Profile fetch failed after retries (non-fatal \u2014 fixes data still returned):', profileRes.status);
      }
    } catch(e) { console.error('Profile parse failed (non-fatal):', e); }
  }
  const all       = (await fixesRes.json()).records || [];
  const pending   = all.filter(x => x.fields.Status === 'pending');
  const completed = all.filter(x => x.fields.Status === 'completed');
  const dismissed = all.filter(x => x.fields.Status === 'dismissed');

  const isCommercial = r => (r.fields.ExposureCategory === 'Commercial') || ((r.fields.FixType || '').toLowerCase() === 'commercial_loss');
  const pendingReg   = pending.filter(r => !isCommercial(r));
  const completedReg = completed.filter(r => !isCommercial(r));
  const activeReg    = pendingReg.length + completedReg.length;
  const score        = activeReg > 0 ? Math.round((completedReg.length / activeReg) * 100) : 0;
  const band         = getScoreBand(score);
  const pendingFormatted   = pending.map(r => formatFix(r, revenueBand));
  const completedFormatted = completed.map(r => formatFix(r, revenueBand));
  const dismissedFormatted = dismissed.map(r => formatFix(r, revenueBand));

  const actionedTotal = completedFormatted.reduce((sum, f) => {
    return sum + getRealisticMidpoint(f.fixType, revenueBand);
  }, 0);
  const icoP = pendingFormatted.filter(f => f.exposure?.category === 'ICO').length;
  const asaP = pendingFormatted.filter(f => f.exposure?.category === 'ASA').length;
  const cmaP = pendingFormatted.filter(f => f.exposure?.category === 'CMA').length;
  const comP = pendingFormatted.filter(f => f.exposure?.category === 'Commercial').length;

  const pendingCommercial = pendingFormatted.filter(f => f.exposure?.category === 'Commercial');
  const commercialLow  = pendingCommercial.reduce((s, f) => s + (f.exposure?.realisticLow  || 0), 0);
  const commercialHigh = pendingCommercial.reduce((s, f) => s + (f.exposure?.realisticHigh || 0), 0);
  const now           = new Date();
  const assessedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // v6.6 — surface a top-level count of pending fixes that have an
  // ImprovedOnRerun hint. Cheap for the dashboard to consume (no need
  // to re-scan the fixes array) and useful for future header badges.
  const improvedPendingCount = pendingFormatted.filter(f => f.improvedOnRerun).length;

  const profile = {
    onboardingComplete: profileFields ? (profileFields.OnboardingComplete || false) : null,
    revenueBandRaw:      profileFields ? (profileFields.RevenueBand || null) : null,
    currentStreak:       profileFields ? (profileFields.CurrentStreak || 0) : 0,
    profileUnavailable:  profileFields === null,
  };
  return res.json({
    success:      true,
    score,
    scoreBand:    band.label,
    scoreColour:  band.colour,
    revenueBand:  normaliseBand(revenueBand),
    profile,
    counts: {
      pending:   pending.length,
      completed: completed.length,
      dismissed: dismissed.length,
      active:    activeReg,
      improvedPending: improvedPendingCount, // v6.6
    },
    actioned: {
      total:         actionedTotal,
      count:         completedReg.length,
      assessedMonth,
      disclaimer:    NOT_LEGAL_ADVICE,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',
      duaaWarning:   DUAA_WARNING,
    },
    commercial: {
      totalLow:    Math.round(commercialLow),
      totalHigh:   Math.round(commercialHigh),
      count:       pendingCommercial.length,
      basis:       'commercial',
      disclaimer:  COMMERCIAL_DISCLAIMER,
    },
    categoryCounts: {
      pending:   { ico: icoP, asa: asaP, cma: cmaP, commercial: comP },
      completed: {
        ico: completedFormatted.filter(f => f.exposure?.category === 'ICO').length,
        asa: completedFormatted.filter(f => f.exposure?.category === 'ASA').length,
        cma: completedFormatted.filter(f => f.exposure?.category === 'CMA').length,
        commercial: completedFormatted.filter(f => f.exposure?.category === 'Commercial').length,
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
// v6.6 — accepts optional `completionSource`. Defaults to 'manual'.
async function handleComplete(req, res) {
  const { userId, fixId, completionSource } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const gr = await atFetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });
  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

  // Validate completionSource against a known allow-list so we never
  // write random client-supplied strings into Airtable. Falls back
  // to 'manual' if the value is missing or unrecognised.
  const ALLOWED_SOURCES = new Set(['manual', 'improved_on_rerun']);
  const source = ALLOWED_SOURCES.has(completionSource) ? completionSource : 'manual';

  const ur = await atFetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({
      fields: {
        Status: 'completed',
        CompletedDate: new Date().toISOString().split('T')[0],
        CompletionSource: source,
      },
    }),
  });
  if (!ur.ok) return res.status(ur.status).json({ error: 'Failed to complete fix' });
  let revenueBand = 'under_1m';
  try {
    const pr = await atFetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) { const pd = await pr.json(); revenueBand = pd.records?.[0]?.fields?.RevenueBand || 'under_1m'; }
  } catch(e) {}
  const fixType = (fix.fields.FixType || '').toLowerCase();
  const midpoint = getRealisticMidpoint(fixType, revenueBand);
  return res.json({
    success: true,
    fixId,
    fixType,
    completionSource: source,
    midpoint,
    disclaimer: NOT_LEGAL_ADVICE,
    message: 'Fix marked as complete.',
  });
}

// ── DISMISS ───────────────────────────────────────────────────
async function handleDismiss(req, res) {
  const { userId, fixId } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const gr = await atFetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });
  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });
  const ur = await atFetch(`${base}/Compliance_Fixes/${fixId}`, {
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
