// ─────────────────────────────────────────────────────────────
// SENDWIZE — generate-fix.js v6.2
// Called by all tools when a violation OR commercial loss is found.
// Creates a Compliance_Fixes record in Airtable.
//
// v6.2 changes from v6.1:
//   - NEW 'Commercial' exposure category (commercial_loss / commercial_risk).
//     Unlike ICO/ASA/CMA, the £ figure is NOT a comparable-case band —
//     it is computed by the calling tool from the USER'S OWN data
//     (e.g. Audience Read: cost-per-subscriber × excess unsubscribes;
//      List Intelligence: at-risk list value). The tool passes the
//      figure in via exposureLow / exposureHigh in the request body.
//     Stored with ExposureBasis: 'commercial'. NEVER summed with
//     regulatory (ICO/ASA/CMA) exposure anywhere downstream.
//   - buildExposureFields() now accepts explicit { exposureLow, exposureHigh }
//     used only for the Commercial category.
//   - COMMERCIAL_DISCLAIMER is distinct: an estimated business cost,
//     explicitly NOT a regulatory fine and NOT legal advice.
//
// v6.1 (unchanged):
//   - Accepts processingContext (optional). Stored as JSON.
//   - LEGACY_TYPE_MAP unchanged.
//   - ExposureLow/High written as flat band constants for audit trail.
// ─────────────────────────────────────────────────────────────

const LEGACY_TYPE_MAP = {
  expired_consent:                    'consent_expired',
  no_consent:                         'consent_missing',
  invalid_consent_mechanism:          'consent_missing',
  no_soft_optin:                      'consent_missing',
  suppressed_contact:                 'suppression_breach',
  third_party_list:                   'suppression_breach',
  third_party_list_risk:              'suppression_breach',
  missing_unsubscribe:                'suppression_breach',
  concealed_sender:                   'suppression_breach',
  no_legitimate_interest:             'legitimate_interest_abuse',
  frequency_abuse:                    'legitimate_interest_abuse',
  no_dpa:                             'dpa_breach',
  misleading_pricing:                 'misleading_reference_price',
  fake_scarcity:                      'fake_urgency',
  dark_pattern:                       'fake_urgency',
  misleading_free_claim:              'misleading_claim',
  unsubstantiated_comparative_claim:  'misleading_claim',
  unauthorised_health_claim:          'misleading_claim',
  misleading_testimonial:             'fake_reviews',
  no_sender_identification:           'data_quality',
  no_privacy_policy:                  'data_quality',
  missing_address:                    'data_quality',
  unlawful_incentive:                 'data_quality',
  missing_terms:                      'data_quality',
  reconsent_sent:                     null,
  // Commercial aliases
  commercial_risk:                    'commercial_loss',
};

const EXPOSURE_CONSTANTS = {
  consent_expired:           { category: 'ICO', realisticLow: 5000,   realisticHigh: 80000  },
  consent_missing:           { category: 'ICO', realisticLow: 8000,   realisticHigh: 140000 },
  suppression_breach:        { category: 'ICO', realisticLow: 12000,  realisticHigh: 200000 },
  dpa_breach:                { category: 'ICO', realisticLow: 20000,  realisticHigh: 500000 },
  legitimate_interest_abuse: { category: 'ICO', realisticLow: 5000,   realisticHigh: 100000 },
  data_quality:              { category: 'ICO', realisticLow: 2000,   realisticHigh: 30000  },
  fake_urgency:              { category: 'ASA' },
  misleading_claim:          { category: 'ASA' },
  misleading_reference_price:{ category: 'ASA' },
  undisclosed_ad:            { category: 'ASA' },
  drip_pricing:              { category: 'CMA' },
  fake_reviews:              { category: 'CMA' },
  // Commercial — £ figure supplied by the calling tool, not a band.
  commercial_loss:           { category: 'Commercial' },
};

const ICO_LEGAL_MAX    = '\u00a317.5M or 4% of global annual turnover \u2014 whichever is higher (DUAA 2025)';
const CMA_LEGAL_MAX    = 'Higher of \u00a3300,000 or 10% of global annual turnover (DMCCA 2024)';
const NOT_LEGAL_ADVICE = 'Illustrative ranges based on published enforcement data. Not a prediction. Not legal advice.';
const COMMERCIAL_DISCLAIMER = 'Estimated business cost based on your own inputs \u2014 not a regulatory fine, and not legal advice.';

function resolveFixType(rawType) {
  const type = (rawType || '').toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(LEGACY_TYPE_MAP, type)) {
    const mapped = LEGACY_TYPE_MAP[type];
    if (mapped === null) return { skip: true, reason: `${type} is a positive action` };
    const def = EXPOSURE_CONSTANTS[mapped];
    if (!def) return { error: `Legacy type ${type} mapped to ${mapped} but not in EXPOSURE_CONSTANTS` };
    return { canonical: mapped, original: type, def };
  }
  const def = EXPOSURE_CONSTANTS[type];
  if (!def) return { error: `Unknown fixType: ${type}` };
  return { canonical: type, original: type, def };
}

// opts.exposureLow / opts.exposureHigh are used ONLY for the Commercial
// category, where the £ figure is computed by the calling tool.
function buildExposureFields(def, opts) {
  opts = opts || {};
  if (def.category === 'ICO') return { ExposureLow: def.realisticLow, ExposureHigh: def.realisticHigh, ExposureBasis: 'regulatory', ExposureCategory: 'ICO', LegalMax: ICO_LEGAL_MAX };
  if (def.category === 'ASA') return { ExposureLow: 0, ExposureHigh: 0, ExposureBasis: 'reputational', ExposureCategory: 'ASA', LegalMax: null };
  if (def.category === 'CMA') return { ExposureLow: 0, ExposureHigh: 0, ExposureBasis: 'regulatory', ExposureCategory: 'CMA', LegalMax: CMA_LEGAL_MAX };
  if (def.category === 'Commercial') {
    const low  = Number.isFinite(opts.exposureLow)  ? Math.max(0, Math.round(opts.exposureLow))  : 0;
    const highRaw = Number.isFinite(opts.exposureHigh) ? Math.max(0, Math.round(opts.exposureHigh)) : low;
    const high = Math.max(low, highRaw);
    return { ExposureLow: low, ExposureHigh: high, ExposureBasis: 'commercial', ExposureCategory: 'Commercial', LegalMax: null };
  }
  return { ExposureLow: 0, ExposureHigh: 0, ExposureBasis: 'reputational', ExposureCategory: 'unknown', LegalMax: null };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      userId, fixType, description, tool, severity,
      volume, contactVolume, sourceRecordId,
      processingContext,           // v6.1 — optional, object
      exposureLow, exposureHigh,   // v6.2 — Commercial only, numbers
    } = req.body ?? {};

    if (!userId)   return res.status(400).json({ error: 'Missing userId' });
    if (!fixType)  return res.status(400).json({ error: 'Missing fixType' });
    if (!tool)     return res.status(400).json({ error: 'Missing tool' });
    if (!severity) return res.status(400).json({ error: 'Missing severity' });

    const resolved = resolveFixType(fixType);
    if (resolved.skip)  { console.log(`Skipped: ${fixType}`); return res.json({ skipped: true, reason: resolved.reason }); }
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const { canonical, original, def } = resolved;
    const wasRemapped = canonical !== original;
    const isCommercial = def.category === 'Commercial';

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const base           = `https://api.airtable.com/v0/${BASE_ID}`;
    const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // Revenue band for audit trail
    let revenueBand = null;
    try {
      const pr = await fetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
      if (pr.ok) { const pd = await pr.json(); revenueBand = pd.records?.[0]?.fields?.RevenueBand || null; }
    } catch(e) { console.error('Profile load failed (non-fatal):', e); }

    // Deduplicate
    if (sourceRecordId) {
      try {
        const typesToCheck = wasRemapped ? [canonical, original] : [canonical];
        for (const t of typesToCheck) {
          const formula = `AND({UserID}='${userId}',{FixType}='${t}',{SourceRecordID}='${sourceRecordId}',{Status}='pending')`;
          const dr = await fetch(`${base}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
          if (dr.ok) { const dd = await dr.json(); if (dd.records?.length > 0) { console.log(`Duplicate skipped: ${t}`); return res.json({ skipped: true, reason: 'Fix already exists as pending', fixId: dd.records[0].id }); } }
        }
      } catch(e) { console.error('Dupe check failed, continuing:', e); }
    }

    const exposureFields = buildExposureFields(def, { exposureLow, exposureHigh });
    const cvRaw = contactVolume ?? volume ?? null;
    const cv = cvRaw !== null ? parseInt(cvRaw, 10) || null : null;
    const disclaimer = isCommercial ? COMMERCIAL_DISCLAIMER : NOT_LEGAL_ADVICE;

    // Validate and serialise processingContext
    let processingContextStr = null;
    if (processingContext && typeof processingContext === 'object') {
      try { processingContextStr = JSON.stringify(processingContext); } catch(e) {}
    }

    const fields = Object.fromEntries(Object.entries({
      UserID:            userId,
      FixType:           canonical,
      OriginalFixType:   wasRemapped ? original : null,
      Description:       description || `${canonical} identified by ${tool}`,
      Tool:              tool,
      Severity:          severity,
      Status:            'pending',
      ContactVolume:     cv,
      SourceRecordID:    sourceRecordId || null,
      CreatedDate:       new Date().toISOString().split('T')[0],
      RevenueBand:       revenueBand,
      ProcessingContext: processingContextStr,
      Disclaimer:        disclaimer,
      ...exposureFields,
    }).filter(([, v]) => v !== null && v !== undefined));

    const cr = await fetch(`${base}/Compliance_Fixes`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ records: [{ fields }] }),
    });

    if (!cr.ok) {
      const errText = await cr.text();
      console.error('Compliance_Fixes create failed:', cr.status, errText);
      return res.status(500).json({ error: 'Failed to write fix record' });
    }

    const fixId = (await cr.json()).records[0].id;
    console.log(`Fix created: ${fixId} | type: ${canonical} | category: ${def.category} | severity: ${severity}`);

    return res.json({
      success: true, fixId, fixType: canonical,
      originalFixType: wasRemapped ? original : canonical,
      wasRemapped, category: def.category,
      exposureLow: exposureFields.ExposureLow,
      exposureHigh: exposureFields.ExposureHigh,
      exposureBasis: exposureFields.ExposureBasis,
      legalMax: exposureFields.LegalMax,
      disclaimer,
    });

  } catch (error) {
    console.error('generate-fix error:', error);
    return res.status(500).json({ error: 'Failed to generate fix' });
  }
}
