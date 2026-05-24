// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js v6.0
// Called by all tools when a violation is found.
// Creates a Compliance_Fixes record in Airtable.
// Deduplicates: same fixType + sourceRecordId + Status=pending = skip.
//
// v6.0 changes:
//   - calculateExposure() removed. No multipliers, no personalised
//     prediction. Exposure figures are flat realistic ranges from
//     published enforcement decisions — not calculations on user data.
//   - EXPOSURE_CONSTANTS replaces EXPOSURE_RANGES. Three categories:
//     ICO (realistic range from published cases), ASA (no £ figure),
//     CMA (legal max only — no realistic range yet).
//   - ExposureLow/High written as flat realistic range from constants.
//     fixes.js v6.0 ignores these stored values and derives exposure
//     from EXPOSURE_CONSTANTS at read time. Written here for audit trail.
//   - ContactVolume added to fix record write (todo item 11).
//   - LEGACY_TYPE_MAP: aliases old fix type names to v6.0 taxonomy.
//     Live tools still emit old names — map handles both until tools
//     are updated in Phase 3. Remove map entries as tools are updated.
//   - Profile fetch retained — reads RevenueBand for audit trail.
//     No longer used in exposure calculation.
//   - Null stripping on all Airtable writes.
//   - Fix type validation checks EXPOSURE_CONSTANTS, not old EXPOSURE_RANGES.
//
// LEGAL FRAMING:
//   ExposureLow/High = realistic range from comparable published cases.
//   Not a prediction. Not personalised. Label in UI: "comparable cases".
//   ICO legal max: £17.5M or 4% of global annual turnover — whichever
//   is higher (DUAA 2025). Stated as law, not as a user-specific figure.
//   ASA: no £ figure. CMA: legal max only (DMCCA 2024).
// ─────────────────────────────────────────────────────────────

// ── LEGACY TYPE MAP ───────────────────────────────────────────
// Aliases old fix type names → v6.0 taxonomy.
// Live tools still emit old names as of v6.0 deployment.
// Remove entries here as each tool is updated in Phase 3.
// Keys: old name. Values: v6.0 canonical name.
const LEGACY_TYPE_MAP = {
  expired_consent:           'consent_expired',
  no_consent:                'consent_missing',
  invalid_consent_mechanism: 'consent_missing',
  no_soft_optin:             'consent_missing',
  suppressed_contact:        'suppression_breach',
  third_party_list:          'suppression_breach',
  third_party_list_risk:     'suppression_breach',
  missing_unsubscribe:       'suppression_breach',
  concealed_sender:          'suppression_breach',
  no_legitimate_interest:    'legitimate_interest_abuse',
  no_dpa:                    'dpa_breach',
  misleading_pricing:        'misleading_reference_price',
  fake_scarcity:             'fake_urgency',
  dark_pattern:              'fake_urgency',
  misleading_free_claim:     'misleading_claim',
  unsubstantiated_comparative_claim: 'misleading_claim',
  unauthorised_health_claim: 'misleading_claim',
  misleading_testimonial:    'fake_reviews',
  no_sender_identification:  'data_quality',
  no_privacy_policy:         'data_quality',
  frequency_abuse:           'data_quality',
  missing_address:           'data_quality',
  unlawful_incentive:        'data_quality',
  missing_terms:             'data_quality',
  reconsent_sent:            null, // positive action — skip, do not create fix
};

// ── EXPOSURE CONSTANTS ────────────────────────────────────────
// Source: published ICO/ASA/CMA enforcement decisions.
// Review quarterly. One-line update per type. Deploy. Done.
//
// ICO types: realisticLow/High from published pre-DUAA decisions.
//   DUAA 2025 max: £17.5M or 4% global annual turnover — whichever
//   is higher. Stated as law on every ICO exposure display.
// ASA types: no £ figure. Reputational risk indicator only.
// CMA types: no realistic range (insufficient published DMCCA decisions).
//   Legal max only: higher of £300k or 10% global turnover (DMCCA 2024).

const EXPOSURE_CONSTANTS = {

  // ── ICO violations ──────────────────────────────────────────
  consent_expired: {
    category:     'ICO',
    realisticLow:  5000,
    realisticHigh: 80000,
    lowDriver:    'First offence, aging consent, good co-operation',
    highDriver:   'Deliberate inaction, large expired volume, complaints received',
  },
  consent_missing: {
    category:     'ICO',
    realisticLow:  8000,
    realisticHigh: 140000,
    lowDriver:    'First offence, small volume, prompt remediation',
    highDriver:   'Repeated, deliberate, large volume, prior ICO history',
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
    highDriver:   'Systemic failures, large volume affected',
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

// ── DUAA / legal max strings ──────────────────────────────────
const ICO_LEGAL_MAX    = '£17.5M or 4% of global annual turnover — whichever is higher (DUAA 2025)';
const CMA_LEGAL_MAX    = 'Higher of £300,000 or 10% of global annual turnover (DMCCA 2024)';
const NOT_LEGAL_ADVICE = 'Illustrative ranges based on published enforcement data. Not a prediction. Not legal advice.';

// ── RESOLVE FIX TYPE ──────────────────────────────────────────
// Applies LEGACY_TYPE_MAP then validates against EXPOSURE_CONSTANTS.
// Returns { canonical, def } or { skip: true } for positive actions
// or { error } for truly unknown types.
function resolveFixType(rawType) {
  const type = (rawType || '').toLowerCase().trim();

  // Check legacy map first
  if (Object.prototype.hasOwnProperty.call(LEGACY_TYPE_MAP, type)) {
    const mapped = LEGACY_TYPE_MAP[type];
    if (mapped === null) return { skip: true, reason: `${type} is a positive action — no fix record created` };
    const def = EXPOSURE_CONSTANTS[mapped];
    if (!def) return { error: `Legacy type ${type} mapped to ${mapped} but ${mapped} not in EXPOSURE_CONSTANTS` };
    return { canonical: mapped, original: type, def };
  }

  // Check v6.0 types directly
  const def = EXPOSURE_CONSTANTS[type];
  if (!def) return { error: `Unknown fixType: ${type}` };
  return { canonical: type, original: type, def };
}

// ── BUILD EXPOSURE FOR WRITE ──────────────────────────────────
// Returns the fields to write to Airtable.
// ExposureLow/High = flat realistic range (not multiplied).
// fixes.js v6.0 ignores these and derives from EXPOSURE_CONSTANTS
// at read time — written here for audit trail only.
function buildExposureFields(def) {
  if (def.category === 'ICO') {
    return {
      ExposureLow:   def.realisticLow,
      ExposureHigh:  def.realisticHigh,
      ExposureBasis: 'regulatory',
      ExposureCategory: 'ICO',
      LegalMax:      ICO_LEGAL_MAX,
    };
  }
  if (def.category === 'ASA') {
    return {
      ExposureLow:   0,
      ExposureHigh:  0,
      ExposureBasis: 'reputational',
      ExposureCategory: 'ASA',
      LegalMax:      null,
    };
  }
  if (def.category === 'CMA') {
    return {
      ExposureLow:   0,
      ExposureHigh:  0,
      ExposureBasis: 'regulatory',
      ExposureCategory: 'CMA',
      LegalMax:      CMA_LEGAL_MAX,
    };
  }
  return { ExposureLow: 0, ExposureHigh: 0, ExposureBasis: 'reputational', ExposureCategory: 'unknown', LegalMax: null };
}

// ── HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      userId,
      fixType,
      description,
      tool,
      severity,
      volume,
      contactVolume, // v6.0 — preferred over volume for List Intelligence
      sourceRecordId,
    } = req.body ?? {};

    if (!userId)   return res.status(400).json({ error: 'Missing userId' });
    if (!fixType)  return res.status(400).json({ error: 'Missing fixType' });
    if (!tool)     return res.status(400).json({ error: 'Missing tool' });
    if (!severity) return res.status(400).json({ error: 'Missing severity' });

    // ── Resolve fix type (handles legacy names + validation) ──
    const resolved = resolveFixType(fixType);

    if (resolved.skip) {
      console.log(`Skipped (positive action): ${fixType} — ${resolved.reason}`);
      return res.json({ skipped: true, reason: resolved.reason });
    }

    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }

    const { canonical, original, def } = resolved;
    const wasRemapped = canonical !== original;

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const base           = `https://api.airtable.com/v0/${BASE_ID}`;
    const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // ── 1. Fetch user profile (for RevenueBand audit trail) ───
    let revenueBand = null;
    try {
      const pr = await fetch(
        `${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (pr.ok) {
        const pd = await pr.json();
        if (pd.records?.length > 0) {
          revenueBand = pd.records[0].fields.RevenueBand || null;
        }
      }
    } catch (e) {
      console.error('Profile load failed (non-fatal):', e);
    }

    // ── 2. Deduplicate ────────────────────────────────────────
    // Check both canonical and original type to catch records written
    // before the legacy map was applied (old tools wrote old names).
    if (sourceRecordId) {
      try {
        const typesToCheck = wasRemapped
          ? [canonical, original]
          : [canonical];

        for (const t of typesToCheck) {
          const formula = `AND({UserID}='${userId}',{FixType}='${t}',{SourceRecordID}='${sourceRecordId}',{Status}='pending')`;
          const dr      = await fetch(
            `${base}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`,
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
          );
          if (dr.ok) {
            const dd = await dr.json();
            if (dd.records?.length > 0) {
              console.log(`Duplicate skipped: ${t} / ${sourceRecordId}`);
              return res.json({ skipped: true, reason: 'Fix already exists as pending', fixId: dd.records[0].id });
            }
          }
        }
      } catch (e) {
        console.error('Dupe check failed, continuing:', e);
      }
    }

    // ── 3. Build exposure fields ──────────────────────────────
    const exposureFields = buildExposureFields(def);

    // ── 4. Write fix record ───────────────────────────────────
    // ContactVolume: prefer contactVolume param (v6.0 List Intelligence),
    // fall back to volume (legacy tools). Both optional.
    const cvRaw = contactVolume ?? volume ?? null;
    const cv    = cvRaw !== null ? parseInt(cvRaw, 10) || null : null;

    const fields = Object.fromEntries(Object.entries({
      UserID:          userId,
      FixType:         canonical,           // always write canonical v6.0 name
      OriginalFixType: wasRemapped ? original : null, // audit trail for legacy
      Description:     description || `${canonical} identified by ${tool}`,
      Tool:            tool,
      Severity:        severity,
      Status:          'pending',
      ContactVolume:   cv,
      SourceRecordID:  sourceRecordId || null,
      CreatedDate:     new Date().toISOString().split('T')[0],
      RevenueBand:     revenueBand,         // audit trail — not used in calculation
      Disclaimer:      NOT_LEGAL_ADVICE,
      ...exposureFields,
    }).filter(([, v]) => v !== null && v !== undefined));

    const cr = await fetch(`${base}/Compliance_Fixes`, {
      method:  'POST',
      headers: authH,
      body:    JSON.stringify({ records: [{ fields }] }),
    });

    if (!cr.ok) {
      const errText = await cr.text();
      console.error('Compliance_Fixes create failed:', cr.status, errText);
      return res.status(500).json({ error: 'Failed to write fix record' });
    }

    const fixId = (await cr.json()).records[0].id;

    console.log([
      `Fix created: ${fixId}`,
      `type: ${canonical}${wasRemapped ? ` (remapped from ${original})` : ''}`,
      `category: ${def.category}`,
      `exposure: ${def.realisticLow ? `£${def.realisticLow}–£${def.realisticHigh}` : 'no £ figure'}`,
      `severity: ${severity}`,
    ].join(' | '));

    return res.json({
      success:         true,
      fixId,
      fixType:         canonical,
      originalFixType: wasRemapped ? original : canonical,
      wasRemapped,
      category:        def.category,
      exposureLow:     exposureFields.ExposureLow,
      exposureHigh:    exposureFields.ExposureHigh,
      legalMax:        exposureFields.LegalMax,
      disclaimer:      NOT_LEGAL_ADVICE,
    });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
