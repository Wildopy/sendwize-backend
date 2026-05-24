// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v6.0
// GET  /api/fixes?action=get&userId=x      → list + score + exposure
// POST /api/fixes?action=complete          → mark fix done
// POST /api/fixes?action=dismiss           → exclude from score
//
// v6.0 changes:
//   - Exposure model replaced. Three categories: ICO, ASA, CMA.
//   - EXPOSURE_CONSTANTS: hardcoded realistic ranges from published
//     enforcement decisions. One object per fix type. Trivially updatable.
//   - ICO: realistic range (comparable cases) + legal max (£17.5M or
//     4% of global annual turnover, whichever is higher — DUAA 2025).
//   - ASA: no £ figure. Reputational risk label only.
//   - CMA: legal max only (higher of £300k or 10% global turnover,
//     DMCCA 2024). No realistic range — insufficient published decisions.
//   - Framing: "comparable cases" not "your exposure". Never a prediction.
//   - Actioned fixes return completedDate + midpoint so dashboard can
//     sum any time window (monthly reset lives in dashboard, not here).
//   - ContactVolume added to formatFix (backwards compatible, null if absent).
//   - Null stripping on all Airtable writes.
//   - Score band labels updated for legal disclaimer policy.
// ─────────────────────────────────────────────────────────────

// ── EXPOSURE CONSTANTS ────────────────────────────────────────
// Source: published ICO/ASA/CMA enforcement decisions pre-DUAA 2025.
// Review quarterly against ico.org.uk/action-weve-taken/enforcement.
// First post-DUAA PECR decision = trigger to update ICO ranges upward.
// To update a range: change realisticLow / realisticHigh. Deploy. Done.
//
// ICO legal max: £17.5M or 4% of global annual turnover — whichever is
// higher. DUAA 2025. Same for all users — it is a statement of law,
// not a personalised assessment.
//
// CMA legal max: higher of £300,000 or 10% of global annual turnover.
// DMCCA 2024. No realistic range yet — first enforcement wave Nov 2025,
// insufficient decisions to anchor a range. Legal max only.
//
// ASA: no £ figure. Reputational sanctions only. Purple badge in UI.

const ICO_LEGAL_MAX  = '£17.5M or 4% of global annual turnover — whichever is higher (DUAA 2025)';
const CMA_LEGAL_MAX  = 'Higher of £300,000 or 10% of global annual turnover (DMCCA 2024)';
const DUAA_CAVEAT    = 'Comparable case ranges are based on ICO enforcement decisions issued before the Data Use and Access Act 2025 came into force. DUAA significantly increases the statutory maximum for PECR breaches. The ICO is expected to use these new powers in future enforcement actions. Sendwize will update these ranges as new decisions are published.';
const NOT_LEGAL_ADVICE = 'Illustrative ranges based on published enforcement data. Not a prediction. Not legal advice.';

const EXPOSURE_CONSTANTS = {

  // ── ICO violations ──────────────────────────────────────────
  consent_missing: {
    category:     'ICO',
    realisticLow:  8000,
    realisticHigh: 140000,
    lowDriver:    'First offence, small volume, prompt remediation',
    highDriver:   'Repeated, deliberate, large volume, prior ICO history',
  },
  consent_expired: {
    category:     'ICO',
    realisticLow:  5000,
    realisticHigh: 80000,
    lowDriver:    'First offence, aging consent, good co-operation',
    highDriver:   'Deliberate inaction, large expired volume, complaints received',
  },
  suppression_breach: {
    category:     'ICO',
    realisticLow:  12000,
    realisticHigh: 200000,
    lowDriver:    'Small post opt-out volume, isolated incident',
    highDriver:   'Systematic failure, large volume, deliberate disregard',
  },
  dpa_breach: {
    category:     'ICO',
    realisticLow:  20000,
    realisticHigh: 500000,
    lowDriver:    'Minor technical breach, prompt remediation',
    highDriver:   'Sensitive data, large scale, negligent security',
  },
  legitimate_interest_abuse: {
    category:     'ICO',
    realisticLow:  5000,
    realisticHigh: 100000,
    lowDriver:    'Proportionality marginally failed, low volume',
    highDriver:   'Clearly disproportionate, high frequency, complaints',
  },
  data_quality: {
    category:     'ICO',
    realisticLow:  2000,
    realisticHigh: 30000,
    lowDriver:    'Minor data quality issues, prompt remediation',
    highDriver:   'Systemic data quality failures, large volume affected',
  },

  // ── ASA violations — no £ figure ───────────────────────────
  fake_urgency: {
    category: 'ASA',
  },
  misleading_claim: {
    category: 'ASA',
  },
  misleading_reference_price: {
    category: 'ASA',
  },
  undisclosed_ad: {
    category: 'ASA',
  },

  // ── CMA violations — legal max only ────────────────────────
  drip_pricing: {
    category: 'CMA',
  },
  fake_reviews: {
    category: 'CMA',
  },
};

// ── EXPOSURE HELPERS ──────────────────────────────────────────
// Returns the constants entry for a fixType, or null if unknown.
function getExposureConstants(fixType) {
  return EXPOSURE_CONSTANTS[(fixType || '').toLowerCase()] || null;
}

// Returns the realistic midpoint for a fix type.
// Used by dashboard to sum actioned risk by time window.
// ASA and CMA return 0 — no realistic range.
function getRealisticMidpoint(fixType) {
  const def = getExposureConstants(fixType);
  if (!def || def.category !== 'ICO') return 0;
  return Math.round((def.realisticLow + def.realisticHigh) / 2);
}

// Returns the full exposure object for a fix, ready for UI consumption.
function buildExposureForFix(fixType) {
  const def = getExposureConstants(fixType);

  if (!def) {
    return {
      category:      'unknown',
      hasRange:      false,
      legalMax:      null,
      legalMaxLabel: null,
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'ICO') {
    return {
      category:      'ICO',
      hasRange:      true,
      realisticLow:  def.realisticLow,
      realisticHigh: def.realisticHigh,
      midpoint:      Math.round((def.realisticLow + def.realisticHigh) / 2),
      lowDriver:     def.lowDriver,
      highDriver:    def.highDriver,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',
      duaaCaveat:    DUAA_CAVEAT,
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'ASA') {
    return {
      category:           'ASA',
      hasRange:           false,
      reputationalRisk:   true,
      legalMax:           null,
      legalMaxLabel:      null,
      reputationalNote:   'ASA does not impose direct financial fines. An upheld ruling is published permanently on asa.org.uk every Wednesday — searchable by customers, investors, and competitors. Serious or repeat breaches referred to Trading Standards under DMCCA 2024.',
      disclaimer:         NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'CMA') {
    return {
      category:      'CMA',
      hasRange:      false,
      legalMax:      CMA_LEGAL_MAX,
      legalMaxLabel: 'CMA statutory maximum (DMCCA 2024)',
      cmaNote:       'The CMA can impose fines directly without court proceedings. Businesses that co-operate promptly and demonstrate genuine remediation can negotiate settlement discounts. Consumer redress orders may be issued in addition to any fine.',
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  return { category: def.category, hasRange: false, disclaimer: NOT_LEGAL_ADVICE };
}

// ── SCORE BAND ────────────────────────────────────────────────
// 'Compliant' removed — no binary verdict per legal disclaimer policy.
function getScoreBand(s) {
  if (s === 0)  return { label: 'Not Started',     colour: '#9ca3af' };
  if (s <= 25)  return { label: 'At Risk',         colour: '#ef4444' };
  if (s <= 50)  return { label: 'Needs Attention', colour: '#f97316' };
  if (s <= 75)  return { label: 'In Progress',     colour: '#eab308' };
  if (s <= 90)  return { label: 'Good Standing',   colour: '#0d9488' };
  return         { label: 'Strong Posture',        colour: '#16a34a' };
}

// ── FORMAT FIX ────────────────────────────────────────────────
// Exposure fields (ExposureLow, ExposureHigh, ExposureBasis) retained
// in Airtable for backwards compat but exposure object is now derived
// from EXPOSURE_CONSTANTS, not from stored field values.
function formatFix(r) {
  const fixType  = (r.fields.FixType || '').toLowerCase();
  const exposure = buildExposureForFix(fixType);

  return {
    id:             r.id,
    fixType,
    description:    r.fields.Description   || '',
    tool:           r.fields.Tool          || '',
    severity:       r.fields.Severity      || '',
    status:         r.fields.Status        || 'pending',
    contactVolume:  r.fields.ContactVolume || null,   // v6.0 — null if absent, backwards compat
    sourceRecordId: r.fields.SourceRecordID || null,
    completedDate:  r.fields.CompletedDate  || null,
    createdDate:    r.fields.CreatedDate    || null,
    exposure,
  };
}

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Compliance_Fixes` +
    `?filterByFormula={UserID}='${userId}'` +
    `&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!r.ok) {
    console.error('Compliance_Fixes fetch failed:', r.status);
    return res.status(r.status).json({ error: 'Failed to retrieve fixes' });
  }

  const all       = (await r.json()).records || [];
  const pending   = all.filter(x => x.fields.Status === 'pending');
  const completed = all.filter(x => x.fields.Status === 'completed');
  const dismissed = all.filter(x => x.fields.Status === 'dismissed');
  const active    = pending.length + completed.length;
  const score     = active > 0 ? Math.round((completed.length / active) * 100) : 0;
  const band      = getScoreBand(score);

  // ── Format all fix lists ───────────────────────────────────
  const pendingFormatted   = pending.map(formatFix);
  const completedFormatted = completed.map(formatFix);
  const dismissedFormatted = dismissed.map(formatFix);

  // ── Actioned risk calculation ──────────────────────────────
  // Sum of realistic midpoints for completed ICO fixes.
  // ASA and CMA contribute 0 — no reliable realistic range.
  // Dashboard uses completedDate to window this by month.
  // This is "comparable case risk addressed" — the boss slide number.
  // It is a sum of what has happened in comparable published cases,
  // not a prediction of what would have happened to this user.

  const actionedTotal = completedFormatted.reduce((sum, f) => {
    return sum + (f.exposure.midpoint || 0);
  }, 0);

  // ── Pending risk summary ───────────────────────────────────
  // Returned as individual fix objects with their own exposure ranges.
  // Never summed into one headline figure — each fix is its own
  // comparable case reference, not a cumulative prediction.

  const icoCount = pendingFormatted.filter(f => f.exposure.category === 'ICO').length;
  const asaCount = pendingFormatted.filter(f => f.exposure.category === 'ASA').length;
  const cmaCount = pendingFormatted.filter(f => f.exposure.category === 'CMA').length;

  // ── Category counts for dashboard breakdown ────────────────
  const categoryCounts = {
    pending:   { ico: icoCount, asa: asaCount, cma: cmaCount },
    completed: {
      ico: completedFormatted.filter(f => f.exposure.category === 'ICO').length,
      asa: completedFormatted.filter(f => f.exposure.category === 'ASA').length,
      cma: completedFormatted.filter(f => f.exposure.category === 'CMA').length,
    },
  };

  // ── assessedMonth — for dashboard monthly refresh gate ─────
  const now           = new Date();
  const assessedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return res.json({
    success:      true,
    score,
    scoreBand:    band.label,
    scoreColour:  band.colour,
    counts: {
      pending:   pending.length,
      completed: completed.length,
      dismissed: dismissed.length,
      active,
    },
    // ── Actioned risk ────────────────────────────────────────
    // actionedTotal: sum of ICO realistic midpoints for completed fixes.
    // Dashboard windows this by completedDate for monthly reset display.
    // Label in UI: "comparable case risk addressed"
    actioned: {
      total:         actionedTotal,
      count:         completedFormatted.length,
      assessedMonth,
      disclaimer:    NOT_LEGAL_ADVICE,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',
    },
    categoryCounts,
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

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

  const fields = Object.fromEntries(Object.entries({
    Status:        'completed',
    CompletedDate: new Date().toISOString().split('T')[0],
  }).filter(([, v]) => v !== null && v !== undefined));

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH',
    headers: authH,
    body: JSON.stringify({ fields }),
  });

  if (!ur.ok) {
    console.error('Fix complete failed:', ur.status);
    return res.status(ur.status).json({ error: 'Failed to complete fix' });
  }

  // Return the exposure midpoint so dashboard can update actioned total
  // immediately without a full reload.
  const fixType = (fix.fields.FixType || '').toLowerCase();
  const midpoint = getRealisticMidpoint(fixType);

  return res.json({
    success:   true,
    fixId,
    fixType,
    midpoint,
    disclaimer: NOT_LEGAL_ADVICE,
    message:   'Fix marked as complete.',
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

  const gr = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });

  const fix = await gr.json();
  if (fix.fields.UserID  !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status  === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });

  const fields = Object.fromEntries(Object.entries({
    Status: 'dismissed',
  }).filter(([, v]) => v !== null && v !== undefined));

  const ur = await fetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH',
    headers: authH,
    body: JSON.stringify({ fields }),
  });

  if (!ur.ok) {
    console.error('Fix dismiss failed:', ur.status);
    return res.status(ur.status).json({ error: 'Failed to dismiss fix' });
  }

  return res.json({ success: true, fixId, message: 'Fix dismissed.' });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET'  && action === 'get')      return await handleGet(req, res);
    if (req.method === 'POST' && action === 'complete')  return await handleComplete(req, res);
    if (req.method === 'POST' && action === 'dismiss')   return await handleDismiss(req, res);

    return res.status(400).json({
      error: 'Unknown action. Use ?action=get|complete|dismiss',
    });

  } catch (error) {
    console.error('fixes.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
