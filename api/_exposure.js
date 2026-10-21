// ─────────────────────────────────────────────────────────────
// SENDWIZE — _exposure.js v1.0  (shared exposure engine)
// Underscore prefix: not an endpoint.
//
// ONE source of truth for every £ figure, the compliance score and the
// "Why this number?" explanation. Used by fixes.js, generate-fix.js,
// exposure-summary.js, exposure.js and dashboard.js, so every number on
// the dashboard agrees.
//
// How a figure is built (spec: deterministic first, AI interprets):
//   1. Range frame: published-case range for the fix type, by revenue
//      band, times the sector multiplier (unchanged from fixes.js v6.10).
//   2. Factors: aggravating / mitigating factors from a FIXED menu
//      (FACTORS below). Some are detected by rules from the evidence
//      (contact volume, data types, DPA status, documented assessment,
//      how long the issue has been open). Others can be picked by
//      Claude from the finding's own text, but only if Claude quotes
//      the evidence and the quote is found in it (validateAssessment).
//   3. Position: 0.5 + sum of factor weights, clamped to 0.05–0.95. The
//      figure shown is a band centred on that position, 16% / 26% / 40%
//      as wide as the frame at high / medium / low confidence (v1.1),
//      plus the centre as the most likely figure. It can never leave the
//      published-case frame, and the model never writes a number.
//   4. Aggregation: findings a regulator would investigate together
//      (same area, e.g. consent) are clustered. Cluster = the largest
//      finding + 25% of each other finding, capped at 2x the largest.
//      Total = sum of clusters. Replaces adding every range together.
//   5. ASA: count + referral risk, never £. CMA: statutory maximum for
//      the customer's revenue band, never a range. Commercial figures
//      are never added to regulatory ones.
//
// v1.1: the profile sharpens the figure. Exact turnover, list size,
//   opt-in records and complaint history become rule factors; the band
//   shown narrows as more of them are known (confidence high / medium /
//   low), with one most-likely figure in the middle and a list of the
//   inputs that would tighten it. ASA and CMA findings get a separate
//   commercial cost (ad withdrawn, customers refunded) worked out only
//   from the customer's own campaign budget and revenue. Never a fine.
//
// v1.2: the business profile is required. profileGaps() lists what is
//   missing; the dashboard holds back every figure until it is filled.
//   method() returns the constants below for the public "Sendwize
//   exposure algorithm" page, so the page always matches this file.
//
// LEGAL POSITION: comparable published cases, not a prediction, not
// legal advice. Weights and case anchors are for the founder to review.
// ─────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

// ── REVENUE BAND NORMALISATION ────────────────────────────────
// Keys are compared with spaces removed and hyphens as en dashes, so the
// profile's '£1M–£10M' and older '£1M – £10M' both resolve.
const REVENUE_BAND_MAP = {
  'Under\u00a31M':            'under_1m',
  '\u00a31M\u2013\u00a310M':  '1m_10m',
  '\u00a310M\u2013\u00a350M': '10m_50m',
  'Over\u00a350M':            'over_50m',
  under_1m: 'under_1m',
  '1m_10m': '1m_10m',
  '10m_50m':'10m_50m',
  over_50m: 'over_50m',
};
function normaliseBand(raw) {
  const k = String(raw || '').replace(/\s+/g, '').replace(/-/g, '\u2013');
  return REVENUE_BAND_MAP[k] || REVENUE_BAND_MAP[raw] || 'under_1m';
}

// ── SECTOR MULTIPLIERS ────────────────────────────────────────
const SECTOR_MULTIPLIERS = {
  finance:   1.5,
  health:    1.4,
  gambling:  1.3,
  ecommerce: 1.1,
  media:     1.0,
  general:   1.0,
  b2b:       0.8,
  charity:   0.7,
};

// Profile sector values that map onto a multiplier under another name
const SECTOR_ALIASES = { healthcare: 'health', agency: 'general', saas: 'general', other: 'general' };
function normaliseSector(raw) {
  let s = (raw || '').toLowerCase().trim();
  s = SECTOR_ALIASES[s] || s;
  return SECTOR_MULTIPLIERS[s] !== undefined ? s : 'general';
}

function applySectorMultiplier(low, high, sector) {
  const m = SECTOR_MULTIPLIERS[normaliseSector(sector)] || 1.0;
  return {
    low:  Math.round(low  * m),
    high: Math.round(high * m),
  };
}

// ── LEGAL STRINGS ─────────────────────────────────────────────
const ICO_LEGAL_MAX    = '\u00a317.5M or 4% of global annual turnover \u2014 whichever is higher (DUAA 2025)';
const CMA_LEGAL_MAX    = 'Higher of \u00a3300,000 or 10% of global annual turnover (DMCCA 2024)';
const NOT_LEGAL_ADVICE = 'Illustrative ranges based on published enforcement data. Not a prediction. Not legal advice.';
const COMMERCIAL_DISCLAIMER = 'Estimated business cost based on your own inputs \u2014 not a regulatory fine, and not legal advice.';
const DUAA_WARNING = [
  'These ranges are based on ICO enforcement decisions issued before 5 February 2026, when the PECR maximum fine increased from \u00a3500,000 to \u00a317.5M or 4% of global turnover (Data Use and Access Act 2025, Commencement Order No. 6).',
  'No PECR fines for email marketing have been issued under the new cap as of September 2026.',
  'All Sendwize ranges reflect pre-DUAA enforcement outcomes and should be treated as a conservative floor, not a ceiling.',
  'When the ICO issues its first post-DUAA penalties, Sendwize will recalibrate. Until then, your actual exposure under the new regime could be substantially higher than these ranges suggest.',
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
    caseAnchor: 'Anchored to HelloFresh (Jan 2024, \u00a3140,000 \u2014 79M emails with bundled/unclear consent) and Allay Claims (Jan 2026, \u00a3120,000 \u2014 4M SMS classified as direct marketing). Verify: ico.org.uk/action-weve-taken.',
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
    caseAnchor: 'Anchored to HelloFresh (Jan 2024 \u2014 continued contact after opt-out, contributing factor to \u00a3140,000 penalty). Verify: ico.org.uk/action-weve-taken.',
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
  asa_liability: {
    category:     'ASA',
    referralRisk: 'medium',
    referralNote: 'Marketing that may not meet the CAP Code can lead to an upheld ASA ruling published under your brand name. Repeat or serious cases can be referred to Trading Standards under DMCCA 2024.',
  },
  drip_pricing:    { category: 'CMA' },
  fake_reviews:    { category: 'CMA' },
  commercial_loss: { category: 'Commercial' },
  segment_damaged:              { category: 'Commercial' },
  segment_cooling:              { category: 'Commercial' },
  segment_declining_engagement: { category: 'Commercial' },

  // ── v6.7 — relationship fix types ─────────────────────────

  no_article26_agreement: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 15000,  high: 80000  },
      '1m_10m':  { low: 40000,  high: 180000 },
      '10m_50m': { low: 80000,  high: 300000 },
      over_50m:  { low: 150000, high: 450000 },
    },
    lowDriver:  'Co-marketing arrangement newly established, limited data volume exchanged, arrangement partially documented, prompt remediation',
    highDriver: 'Long-running undocumented joint processing, sensitive data types shared, complaints from data subjects about unclear controller responsibilities',
    sectorNote: 'Finance and health organisations sharing customer data for joint marketing purposes face substantially higher ICO scrutiny — joint controller failures in those sectors have attracted the largest penalties in published decisions.',
  },

  affiliate_consent_unverified: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 12000,  high: 60000  },
      '1m_10m':  { low: 30000,  high: 130000 },
      '10m_50m': { low: 60000,  high: 225000 },
      over_50m:  { low: 100000, high: 225000 },
    },
    lowDriver:  'Small affiliate send volume, affiliate has some consent documentation, prompt investigation and suppression on discovery',
    highDriver: 'Large affiliate send volume, no consent documentation held, similar to the Saga case pattern (3.8M messages, \u00a3225k fine)',
    sectorNote: 'Finance and health sector affiliate sends are subject to stricter consent specificity requirements. The ICO has prioritised these sectors in PECR affiliate enforcement.',
    caseAnchor: 'Anchored to Saga Group Ltd (2021, \u00a3225,000) and JTT Marketing Ltd (2021, \u00a3130,000) \u2014 both PECR Reg 22 affiliate consent failures.',
  },

  affiliate_sender_identity_breach: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 8000,   high: 40000  },
      '1m_10m':  { low: 20000,  high: 80000  },
      '10m_50m': { low: 40000,  high: 120000 },
      over_50m:  { low: 70000,  high: 140000 },
    },
    lowDriver:  'Sender name ambiguous but not deliberately misleading, small volume, first offence, prompt correction',
    highDriver: 'Deliberately disguised sender identity, large volume, pattern of concealment, consumer complaints received',
    sectorNote: 'Finance and gambling sector sender identity breaches attract higher ICO attention \u2014 sectors where misleading sender identity is more likely to induce financial harm.',
  },

  partner_brand_risk: {
    category: 'Commercial',
    commercialNote: 'Co-marketing with a brand under active regulatory scrutiny creates brand association risk and potential joint controller liability if the partner\u2019s non-compliance affects shared data. This is an estimated business cost \u2014 not a regulatory fine.',
  },

  partner_no_data_sharing_agreement: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 10000,  high: 50000  },
      '1m_10m':  { low: 25000,  high: 100000 },
      '10m_50m': { low: 50000,  high: 180000 },
      over_50m:  { low: 90000,  high: 300000 },
    },
    lowDriver:  'Limited data exchanged, informal arrangement, prompt remediation',
    highDriver: 'Significant personal data exchanged without documented basis, sensitive data types, complaints received',
  },

  sector_risk_unreviewed: {
    category: 'Commercial',
    commercialNote: 'Failure to monitor sector enforcement intelligence increases the risk of running campaigns that mirror recently-sanctioned practices. This is a business risk estimate \u2014 not a regulatory fine.',
  },

  // ── v6.8 — missing relationship + audience fix types ──────

  unreviewed_joint_ads: {
    category:     'ASA',
    referralRisk: 'medium',
    referralNote: 'Under CAP Code sections 3 (misleading) and 8 (pricing), both parties in a joint advertising arrangement are responsible for claims. Unreviewed joint ads that contain misleading pricing or unsubstantiated claims can trigger ASA complaints. Repeat breaches are referred to Trading Standards under DMCCA 2024.',
  },

  partner_pricing_claims: {
    category:  'CMA',
    cmaNote:   'Pricing and promotional claims in co-branded campaigns are subject to CMA enforcement under DMCCA 2024. Reference pricing, drip pricing, and fake urgency are Schedule 1 banned practices \u2014 automatically unfair with no defence. Both parties in a co-branded campaign share liability.',
  },

  affiliate_misleading_claims: {
    category:     'ASA',
    referralRisk: 'medium',
    referralNote: 'Under the CAP Code, you are responsible for marketing claims made on your behalf by affiliates \u2014 including pricing claims, health claims, and comparative claims. The ASA has upheld complaints against brands for affiliate content the brand did not directly create. Repeat or widespread breaches increase referral risk to Trading Standards.',
  },

  affiliate_ad_disclosure: {
    category:     'ASA',
    referralRisk: 'high',
    referralNote: 'The ASA requires all paid-for influencer content to be clearly identified as advertising (#ad, #sponsored). The ASA has named and shamed both influencers and brands for non-disclosure. Since 2019 the ASA has referred persistent non-disclosers to Trading Standards. The brand is liable alongside the influencer.',
  },

  lead_gen_consent_gap: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 15000,  high: 80000  },
      '1m_10m':  { low: 35000,  high: 150000 },
      '10m_50m': { low: 70000,  high: 225000 },
      over_50m:  { low: 120000, high: 225000 },
    },
    lowDriver:  'Small volume of leads from this affiliate, landing page partially compliant, prompt investigation on discovery',
    highDriver: 'Large volume of leads, consent wording does not name your organisation, similar to Saga pattern (\u00a3225k), CMA pricing claims also present on landing page',
    sectorNote: 'Finance and insurance lead generation affiliates face the highest ICO scrutiny \u2014 the Saga and JTT cases both involved financial product affiliates.',
    caseAnchor: 'Anchored to Saga Group Ltd (2021, \u00a3225,000) and JTT Marketing Ltd (2021, \u00a3130,000).',
  },

  third_party_list: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 20000,  high: 105000 },
      '1m_10m':  { low: 50000,  high: 200000 },
      '10m_50m': { low: 100000, high: 350000 },
      over_50m:  { low: 180000, high: 500000 },
    },
    lowDriver:  'Small volume sent, single purchased list, prompt suppression on discovery, no prior enforcement history',
    highDriver: 'Large volume sent to purchased data, repeated use, complaints received, no consent documentation held',
    caseAnchor: 'Anchored to ZMLUK Ltd (Dec 2025, \u00a3105,000) \u2014 marketing sent using purchased contact data without valid PECR consent.',
  },

  invalid_consent_mechanism: {
    category: 'ICO',
    bands: {
      under_1m:  { low: 10000,  high: 50000  },
      '1m_10m':  { low: 25000,  high: 100000 },
      '10m_50m': { low: 50000,  high: 180000 },
      over_50m:  { low: 90000,  high: 250000 },
    },
    lowDriver:  'Consent mechanism partially compliant, small volume, prompt remediation, some documentation held',
    highDriver: 'Pre-ticked consent boxes, bundled consent with unrelated terms, large volume, complaints from data subjects',
    sectorNote: 'Finance sector consent mechanisms face higher ICO scrutiny following the 2024 ICO direct marketing guidance update.',
    caseAnchor: 'Anchored to HelloFresh (Jan 2024, \u00a3140,000 \u2014 consent bundled with age confirmation, no SMS mention, 24-month post-cancellation marketing). Verify: ico.org.uk/action-weve-taken.',
  },
};

// ── EXPOSURE HELPERS ──────────────────────────────────────────
function getExposureConstants(fixType) {
  return EXPOSURE_CONSTANTS[(fixType || '').toLowerCase()] || null;
}
function getICORange(def, revenueBand, sector) {
  const band     = normaliseBand(revenueBand || 'under_1m');
  const rawRange = def.bands[band] || def.bands['under_1m'];
  return applySectorMultiplier(rawRange.low, rawRange.high, sector);
}
function getRealisticMidpoint(fixType, revenueBand, sector) {
  const def = getExposureConstants(fixType);
  if (!def || def.category !== 'ICO') return 0;
  const range = getICORange(def, revenueBand, sector);
  return Math.round((range.low + range.high) / 2);
}

// ── CONTEXTUAL FACTORS ────────────────────────────────────────
function deriveContextualFactors(fixType, def, ctx, sector) {
  const baseLow  = [def.lowDriver].filter(Boolean);
  const baseHigh = [def.highDriver].filter(Boolean);
  if (!ctx) return { lowFactors: baseLow, highFactors: baseHigh };

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
    highFactors.push('Confirmed breach or enforcement history \u2014 an aggravating factor if ICO investigates');
  } else {
    lowFactors.push('No confirmed breach history \u2014 clean enforcement record is a mitigating factor');
  }
  if (dpaStatus === 'confirmed') {
    lowFactors.push('DPA in place \u2014 Article 28 compliance confirmed');
  } else if (dpaStatus === 'refused') {
    highFactors.push('Vendor has refused to sign a DPA \u2014 continuing to share data after refusal is a serious aggravating factor');
  }
  if (hasDoc) {
    lowFactors.push('Documented assessment on file \u2014 demonstrable due diligence is a mitigating factor');
  } else {
    highFactors.push('No documented assessment \u2014 removes a key mitigating argument');
  }

  const sectorNorm = normaliseSector(sector);
  if (def.sectorNote && ['finance','health','gambling'].includes(sectorNorm)) {
    highFactors.push(def.sectorNote);
  }
  if (def.caseAnchor) {
    highFactors.push(def.caseAnchor);
  }

  if (!lowFactors.length)  lowFactors.push(...baseLow);
  if (!highFactors.length) highFactors.push(...baseHigh);
  return { lowFactors, highFactors };
}

// ── BUILD EXPOSURE FOR FIX ────────────────────────────────────
function buildExposureForFix(fixType, revenueBand, processingContext, storedExposure, sector) {
  const def = getExposureConstants(fixType);
  if (!def) {
    return { category: 'unknown', hasRange: false, legalMax: null, disclaimer: NOT_LEGAL_ADVICE };
  }

  if (def.category === 'ICO') {
    const range   = getICORange(def, revenueBand, sector);
    const factors = deriveContextualFactors(fixType, def, processingContext || null, sector);
    const sectorNorm = normaliseSector(sector);
    const sectorMultiplier = SECTOR_MULTIPLIERS[sectorNorm] || 1.0;
    return {
      category:        'ICO',
      hasRange:        true,
      realisticLow:    range.low,
      realisticHigh:   range.high,
      midpoint:        Math.round((range.low + range.high) / 2),
      revenueBand:     normaliseBand(revenueBand || 'under_1m'),
      sector:          sectorNorm,
      sectorMultiplier,
      sectorAdjusted:  sectorMultiplier !== 1.0,
      lowFactors:      factors.lowFactors,
      highFactors:     factors.highFactors,
      hasContext:      !!processingContext,
      duaaWarning:     DUAA_WARNING,
      legalMax:        ICO_LEGAL_MAX,
      legalMaxLabel:   'ICO statutory maximum (DUAA 2025)',
      disclaimer:      NOT_LEGAL_ADVICE,
      rangeLabel:      'Comparable published cases \u00b7 sector-adjusted \u00b7 not a prediction \u00b7 not legal advice',
    };
  }

  if (def.category === 'ASA') {
    const riskLabel  = { low: 'Low referral risk', medium: 'Medium referral risk', high: 'High referral risk' };
    const riskColour = { low: 'green', medium: 'amber', high: 'red' };
    return {
      category:           'ASA',
      hasRange:           false,
      reputationalRisk:   true,
      referralRisk:       def.referralRisk || 'medium',
      referralRiskLabel:  riskLabel[def.referralRisk] || 'Medium referral risk',
      referralRiskColour: riskColour[def.referralRisk] || 'amber',
      referralNote:       def.referralNote || '',
      cmaIfReferred:      CMA_LEGAL_MAX,
      reputationalNote:   'ASA does not impose direct financial fines. An upheld ruling is published permanently on asa.org.uk. Serious or repeat breaches can be referred to Trading Standards under DMCCA 2024.',
      disclaimer:         NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'CMA') {
    return {
      category:      'CMA',
      hasRange:      false,
      legalMax:      CMA_LEGAL_MAX,
      legalMaxLabel: 'CMA statutory maximum (DMCCA 2024)',
      cmaNote:       def.cmaNote || 'The CMA can impose fines directly without court proceedings under DMCCA 2024. Prompt co-operation and remediation attract settlement discounts.',
      disclaimer:    NOT_LEGAL_ADVICE,
    };
  }

  if (def.category === 'Commercial') {
    const low  = storedExposure?.low  != null ? Number(storedExposure.low)  : 0;
    const high = storedExposure?.high != null ? Number(storedExposure.high) : low;
    return {
      category:      'Commercial',
      hasRange:      high > low,
      isCommercial:  true,
      realisticLow:  low,
      realisticHigh: high,
      midpoint:      Math.round((low + high) / 2),
      legalMax:      null,
      commercialNote: def.commercialNote || '',
      rangeLabel:    'Estimated business cost \u00b7 not a regulatory fine',
      disclaimer:    COMMERCIAL_DISCLAIMER,
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


// ═════════════════════════════════════════════════════════════
// v1.0 ENGINE
// ═════════════════════════════════════════════════════════════

// ── Areas: findings a regulator would look at in one investigation ──
export const AREAS = {
  consent:      { label: 'Marketing consent',         types: ['consent_missing', 'consent_expired', 'invalid_consent_mechanism', 'third_party_list', 'lead_gen_consent_gap', 'affiliate_consent_unverified'] },
  suppression:  { label: 'Opt-outs and suppression',  types: ['suppression_breach'] },
  processors:   { label: 'Processors and data sharing', types: ['dpa_breach', 'no_article26_agreement', 'partner_no_data_sharing_agreement'] },
  transparency: { label: 'Transparency and identity', types: ['data_quality', 'affiliate_sender_identity_breach'] },
  lawful_basis: { label: 'Legitimate interests',      types: ['legitimate_interest_abuse'] },
};
export function areaOf(fixType) {
  for (const [k, a] of Object.entries(AREAS)) if (a.types.includes(fixType)) return k;
  return 'other';
}

// ── Factor menu (fixed, lawyer-reviewed). Weights move the position
//    inside the published-case range: + aggravating, − mitigating. ──
export const FACTORS = {
  volume_very_large:     { label: 'Very large audience (over 1M contacts or messages)', weight: 0.25, source: 'rule' },
  volume_large:          { label: 'Large audience (over 100k contacts)', weight: 0.15, source: 'rule' },
  volume_small:          { label: 'Small audience (under 10k contacts)', weight: -0.15, source: 'rule' },
  sensitive_data:        { label: 'Special category or sensitive data involved', weight: 0.20, source: 'rule' },
  behavioural_data:      { label: 'Behavioural, purchase or financial data involved', weight: 0.08, source: 'rule' },
  email_only:            { label: 'Email addresses only', weight: -0.05, source: 'rule' },
  dpa_refused:           { label: 'Vendor refused to sign a DPA', weight: 0.20, source: 'rule' },
  dpa_confirmed:         { label: 'DPA confirmed in place', weight: -0.10, source: 'rule' },
  documented_assessment: { label: 'Documented assessment on file', weight: -0.10, source: 'rule' },
  breach_history:        { label: 'Known breach or enforcement history', weight: 0.15, source: 'rule' },
  open_long:             { label: 'Open for more than 90 days', weight: 0.10, source: 'rule' },
  consent_bundled:       { label: 'Consent bundled with other terms, or pre-ticked', weight: 0.15, source: 'ai' },
  continued_after_optout:{ label: 'Messages continued after people opted out', weight: 0.25, source: 'ai' },
  purchased_or_third_party_data: { label: 'Purchased, rented or partner-supplied data', weight: 0.20, source: 'ai' },
  concealed_sender:      { label: 'Sender identity unclear or concealed', weight: 0.15, source: 'ai' },
  sms_or_calls:          { label: 'SMS or calls involved (higher complaint rates)', weight: 0.08, source: 'ai' },
  complaints_mentioned:  { label: 'Complaints from recipients mentioned', weight: 0.15, source: 'ai' },
  isolated_issue:        { label: 'Isolated issue affecting one campaign or page', weight: -0.10, source: 'ai' },
  partial_compliance:    { label: 'Partly in place (e.g. notice exists but is incomplete)', weight: -0.10, source: 'ai' },
  // v1.1: from the customer's profile
  turnover_lower:        { label: 'Turnover in the lower part of your size band', weight: -0.08, source: 'profile' },
  turnover_upper:        { label: 'Turnover in the upper part of your size band', weight: 0.08, source: 'profile' },
  consent_records_all:   { label: 'A dated record is kept of every opt-in', weight: -0.12, source: 'profile' },
  consent_records_none:  { label: 'No record is kept of when people opted in', weight: 0.15, source: 'profile' },
  regulator_contact:     { label: 'A regulator has been in contact in the last two years', weight: 0.15, source: 'profile' },
  complaints_received:   { label: 'Complaints received from recipients in the last two years', weight: 0.10, source: 'profile' },
  clean_history:         { label: 'No complaints or regulator contact in the last two years', weight: -0.05, source: 'profile' },
};
export const AI_FACTOR_IDS = Object.keys(FACTORS).filter(k => FACTORS[k].source === 'ai');

// ── Published case anchors (from the existing Sendwize rule base).
//    Confirm each at ico.org.uk/action-weve-taken before relying on it. ──
export const CASE_ANCHORS = [
  { id: 'hellofresh_2024', name: 'HelloFresh (Grocery Delivery E-Services UK Ltd)', regulator: 'ICO', date: '2024-01', penalty: 140000, volume: 80000000, summary: 'About 79M marketing emails and 1M texts; consent bundled with an age confirmation, no mention of SMS, marketing continued after cancellation.', types: ['consent_missing', 'invalid_consent_mechanism', 'suppression_breach'] },
  { id: 'allay_2026',      name: 'Allay Claims Ltd', regulator: 'ICO', date: '2026-01', penalty: 120000, volume: 4000000, summary: 'About 4M SMS messages found to be direct marketing without valid consent.', types: ['consent_missing'] },
  { id: 'zmluk_2025',      name: 'ZMLUK Ltd', regulator: 'ICO', date: '2025-12', penalty: 105000, volume: 67800000, summary: 'About 67.8M emails sent using purchased contact data without valid PECR consent.', types: ['third_party_list', 'consent_missing'] },
  { id: 'saga_2021',       name: 'Saga Services / Saga Personal Finance', regulator: 'ICO', date: '2021', penalty: 225000, volume: 3800000, summary: 'Marketing sent by affiliates relying on indirect consent that did not name the brand.', types: ['lead_gen_consent_gap', 'affiliate_consent_unverified', 'invalid_consent_mechanism'] },
  { id: 'jtt_2021',        name: 'JTT Marketing Ltd', regulator: 'ICO', date: '2021', penalty: 130000, volume: null, summary: 'Lead generation marketing without consent that named the sending organisation.', types: ['lead_gen_consent_gap', 'affiliate_consent_unverified'] },
];
export const ICO_ACTION_URL = 'https://ico.org.uk/action-weve-taken/enforcement/';

export function closestCases(fixType, volume) {
  const matches = CASE_ANCHORS.filter(c => c.types.includes(fixType));
  const v = Number(volume) || null;
  return matches
    .map(c => ({ c, d: v && c.volume ? Math.abs(Math.log10(c.volume) - Math.log10(v)) : 5 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ c }) => ({ id: c.id, name: c.name, regulator: c.regulator, date: c.date, penalty: c.penalty, summary: c.summary, url: ICO_ACTION_URL }));
}

// ── Profile inputs that sharpen the figures (all optional) ──
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const yesNo = v => (v === 'Yes' || v === true) ? true : (v === 'No' || v === false) ? false : null;
export const CONSENT_RECORDS = ['all', 'some', 'none'];
export function profileInputs(f = {}) {
  return {
    turnover:          num(f.AnnualTurnover),
    listSize:          num(f.ListSize),
    averageOrderValue: num(f.AverageOrderValue),
    consentRecords:    CONSENT_RECORDS.includes(f.ConsentRecords) ? f.ConsentRecords : null,
    regulatorContact:  yesNo(f.PriorRegulatorContact),
    complaints:        yesNo(f.ComplaintsReceived),
    campaignBudget:    num(f.TypicalCampaignBudget),
    campaignRevenue:   num(f.TypicalCampaignRevenue),
  };
}
export function bandFromTurnover(t) {
  t = num(t);
  if (!t) return null;
  return t < 1e6 ? 'under_1m' : t < 1e7 ? '1m_10m' : t < 5e7 ? '10m_50m' : 'over_50m';
}
export const BAND_LABELS = { under_1m: 'Under \u00a31M', '1m_10m': '\u00a31M\u2013\u00a310M', '10m_50m': '\u00a310M\u2013\u00a350M', over_50m: 'Over \u00a350M' };
// ── The business profile every figure depends on (v1.2): required ──
export const REQUIRED_PROFILE = {
  turnover:         'Annual turnover',
  listSize:         'Marketing list size',
  consentRecords:   'Whether you keep a dated record of each opt-in',
  complaints:       'Complaints from recipients in the last two years',
  regulatorContact: 'Contact from the ICO, ASA or CMA in the last two years',
};
// Keys of REQUIRED_PROFILE still missing from a User_Profile record
export function profileGaps(f = {}) {
  const inputs = profileInputs(f);
  return Object.keys(REQUIRED_PROFILE).filter(k => inputs[k] == null);
}
// Band, sector and inputs from a User_Profile record. An exact turnover
// beats the band picked in the profile.
export function profileContext(f = {}) {
  const inputs = profileInputs(f);
  return {
    revenueBand: bandFromTurnover(inputs.turnover) || normaliseBand(f.RevenueBand || 'under_1m'),
    sector: normaliseSector(f.Sector || 'general'),
    inputs,
  };
}
// Where the turnover sits inside its band, 0 to 1 on a log scale
const BAND_LIMITS = { under_1m: [1e5, 1e6], '1m_10m': [1e6, 1e7], '10m_50m': [1e7, 5e7], over_50m: [5e7, 5e8] };
function turnoverPosition(t, band) {
  const [a, b] = BAND_LIMITS[band] || BAND_LIMITS.under_1m;
  const v = Math.min(Math.max(t, a), b);
  return (Math.log10(v) - Math.log10(a)) / (Math.log10(b) - Math.log10(a));
}
const CONSENT_AREAS = ['consent', 'suppression'];

// ── Rule-based factors from the evidence we already hold ──
const HIGH_SCRUTINY = ['finance', 'health', 'gambling'];
// Contacts affected: the finding's own figure, then a figure the AI
// quoted from the finding, then the list size on the profile.
export function volumeFor(fix, inputs = {}, assessment = null) {
  const own = Number(fix.contactVolume || fix.processingContext?.contactVolume) || null;
  if (own) return { count: own, source: 'finding' };
  if (assessment?.audience?.count) return { count: assessment.audience.count, source: 'ai', quote: assessment.audience.quote };
  if (inputs.listSize) return { count: inputs.listSize, source: 'profile' };
  return null;
}

export function ruleFactors(fix, sector, inputs = {}, assessment = null, revenueBand = null) {
  const out = [];
  const ctx = fix.processingContext || {};
  const v = volumeFor(fix, inputs, assessment);
  if (v) {
    const ev = v.source === 'profile' ? `${v.count.toLocaleString('en-GB')} on your list (from your profile)`
      : v.source === 'ai' ? v.quote : `${v.count.toLocaleString('en-GB')} contacts`;
    const vol = v.count;
    if (vol > 1000000) out.push({ id: 'volume_very_large', evidence: ev });
    else if (vol > 100000) out.push({ id: 'volume_large', evidence: ev });
    else if (vol < 10000) out.push({ id: 'volume_small', evidence: ev });
  }
  if (inputs.turnover && revenueBand) {
    const p = turnoverPosition(inputs.turnover, revenueBand);
    const ev = `Turnover about \u00a3${Math.round(inputs.turnover).toLocaleString('en-GB')} (from your profile)`;
    if (p < 0.33) out.push({ id: 'turnover_lower', evidence: ev });
    else if (p > 0.67) out.push({ id: 'turnover_upper', evidence: ev });
  }
  if (CONSENT_AREAS.includes(areaOf(fix.fixType))) {
    if (inputs.consentRecords === 'all') out.push({ id: 'consent_records_all', evidence: 'From your profile' });
    else if (inputs.consentRecords === 'none') out.push({ id: 'consent_records_none', evidence: 'From your profile' });
  }
  if (inputs.regulatorContact) out.push({ id: 'regulator_contact', evidence: 'From your profile' });
  if (inputs.complaints) out.push({ id: 'complaints_received', evidence: 'From your profile' });
  if (inputs.regulatorContact === false && inputs.complaints === false) out.push({ id: 'clean_history', evidence: 'From your profile' });
  const dataTypes = Array.isArray(ctx.dataTypes) ? ctx.dataTypes : [];
  if (dataTypes.some(d => /special category|health|biometric|political|religio|sexual|children/i.test(d))) out.push({ id: 'sensitive_data', evidence: dataTypes.join(', ') });
  else if (dataTypes.some(d => /behaviour|purchase|financial/i.test(d))) out.push({ id: 'behavioural_data', evidence: dataTypes.join(', ') });
  else if (dataTypes.length && dataTypes.every(d => /email/i.test(d))) out.push({ id: 'email_only', evidence: dataTypes.join(', ') });
  const dpa = String(ctx.dpaStatus || '').toLowerCase();
  if (dpa === 'refused') out.push({ id: 'dpa_refused', evidence: 'DPA status: refused' });
  else if (dpa === 'confirmed') out.push({ id: 'dpa_confirmed', evidence: 'DPA status: confirmed' });
  if (ctx.hasDocumentedAssessment) out.push({ id: 'documented_assessment', evidence: 'Documented assessment recorded' });
  const breach = String(ctx.vendorBreachHistory || '').toLowerCase();
  if (breach && !['none identified', 'none', 'no', 'unknown'].includes(breach)) out.push({ id: 'breach_history', evidence: ctx.vendorBreachHistory });
  if (fix.status === 'pending' && fix.createdDate) {
    const days = Math.floor((Date.now() - new Date(fix.createdDate).getTime()) / 86400000);
    if (days > 90) out.push({ id: 'open_long', evidence: `Open for ${days} days` });
  }
  // Sector is already applied as a multiplier on the frame, so it is not
  // also counted as a factor here (it does feed attention likelihood).
  return out;
}

// ── Evidence text Claude may quote from, and its hash (cache key) ──
export function evidenceText(fix, profile = {}) {
  const lines = [
    `Finding: ${fix.description || ''}`,
    `Tool: ${fix.tool || ''}`,
    `Severity: ${fix.severity || ''}`,
    fix.contactVolume ? `Contacts affected: ${fix.contactVolume}` : '',
    fix.processingContext ? `Context: ${JSON.stringify(fix.processingContext)}` : '',
    profile.sector ? `Sector: ${profile.sector}` : '',
    profile.revenueBand ? `Revenue band: ${profile.revenueBand}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
export function evidenceHash(fix, profile = {}) {
  return createHash('sha256').update(`${ENGINE_VERSION}|${fix.fixType}|${evidenceText(fix, profile)}`).digest('hex').slice(0, 32);
}
export const ENGINE_VERSION = 'exp-1.0'; // unchanged in v1.1 so stored AI readings stay valid

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Keep only factors from the AI menu whose quote really appears in the
// evidence. Anything else is dropped, never repaired.
export function validateAssessment(raw, text) {
  const ev = norm(text);
  const factors = [];
  const seen = new Set();
  for (const f of (raw?.factors || [])) {
    if (!f || !AI_FACTOR_IDS.includes(f.id) || seen.has(f.id)) continue;
    const q = norm(f.quote);
    // A real quote: at least three words and found verbatim in the evidence
    if (q.length < 12 || q.split(' ').length < 3 || !ev.includes(q)) continue;
    seen.add(f.id);
    factors.push({ id: f.id, quote: String(f.quote).slice(0, 300) });
  }
  const summary = typeof raw?.plain_english === 'string' ? raw.plain_english.slice(0, 600) : '';
  const confidence = ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : 'medium';
  // Audience size: only if the quote is in the evidence and contains the number
  let audience = null;
  const count = Math.round(Number(raw?.audience_count) || 0);
  const aq = norm(raw?.audience_quote);
  if (count > 0 && aq.length >= 6 && ev.includes(aq) && aq.replace(/[,\s]/g, '').includes(String(count))) {
    audience = { count, quote: String(raw.audience_quote).slice(0, 200) };
  }
  return { factors, summary, confidence, audience };
}

// Position inside the frame and the narrowed range
export const POSITION = { start: 0.5, min: 0.05, max: 0.95 };
function positionFrom(factorIds) {
  const sum = factorIds.reduce((s, id) => s + (FACTORS[id]?.weight || 0), 0);
  return Math.min(POSITION.max, Math.max(POSITION.min, POSITION.start + sum));
}
const roundNice = v => v >= 10000 ? Math.round(v / 1000) * 1000 : Math.round(v / 100) * 100;
// The more we know, the narrower the band: share of the frame either side
export const HALF_WIDTH = { high: 0.08, medium: 0.13, low: 0.2 };
function narrowed(low, high, pos, half) {
  const w = high - low;
  const centre = low + w * pos;
  const r = v => Math.round(v / 100) * 100;
  return { low: r(Math.max(low, centre - w * half)), high: r(Math.min(high, centre + w * half)), centre: roundNice(centre) };
}

// What we know about this finding, and what would tighten the figure
export const TIGHTEN = {
  listSize:       'How many people are on your marketing list',
  turnover:       'Your approximate annual turnover',
  history:        'Any complaints or regulator contact in the last two years',
  consentRecords: 'Whether you keep a dated record of each opt-in',
  assess:         'Let AI read the finding for facts that move the figure',
};
export const CONFIDENCE_AT = { high: 4, medium: 2 };
export function confidenceFor(fix, inputs = {}, assessment = null) {
  const known = {
    listSize: !!volumeFor(fix, inputs, assessment),
    turnover: !!inputs.turnover,
    history: inputs.regulatorContact != null && inputs.complaints != null,
    consentRecords: CONSENT_AREAS.includes(areaOf(fix.fixType)) ? inputs.consentRecords != null : true,
    assess: !!assessment,
  };
  const n = Object.values(known).filter(Boolean).length;
  // AI reading is a bonus: a complete profile alone reaches high
  const level = n >= CONFIDENCE_AT.high ? 'high' : n >= CONFIDENCE_AT.medium ? 'medium' : 'low';
  const tighten = Object.keys(known).filter(k => !known[k]).map(k => ({ key: k, label: TIGHTEN[k] }));
  return { level, known: n, of: 5, tighten };
}

// Adds factors, position, narrowed range, most-likely figure, confidence
// and closest cases to an ICO exposure object built by buildExposureForFix().
export function refineExposure(exposure, fix, sector, assessment, inputs = {}) {
  if (!exposure || exposure.category !== 'ICO' || !exposure.hasRange) return exposure;
  const rules = ruleFactors(fix, sector, inputs, assessment, exposure.revenueBand);
  let ai = (assessment?.factors || []).filter(f => FACTORS[f.id]);
  // Complaints confirmed on the profile replace the AI's reading of them
  if (rules.some(f => f.id === 'complaints_received')) ai = ai.filter(f => f.id !== 'complaints_mentioned');
  const all = [...rules.map(f => ({ ...f, source: FACTORS[f.id].source === 'profile' ? 'profile' : 'rule' })), ...ai.map(f => ({ id: f.id, evidence: f.quote, source: 'ai' }))];
  const ids = [...new Set(all.map(f => f.id))];
  const position = ids.length ? positionFrom(ids) : 0.5;
  const conf = confidenceFor(fix, inputs, assessment);
  const n = narrowed(exposure.realisticLow, exposure.realisticHigh, position, HALF_WIDTH[conf.level]);
  const vol = volumeFor(fix, inputs, assessment);
  return {
    ...exposure,
    frameLow: exposure.realisticLow,
    frameHigh: exposure.realisticHigh,
    realisticLow: n.low,
    realisticHigh: n.high,
    midpoint: Math.round((n.low + n.high) / 2),
    mostLikely: n.centre,
    confidence: conf.level,
    confidenceKnown: conf.known,
    confidenceOf: conf.of,
    tighten: conf.tighten,
    position: Math.round(position * 100) / 100,
    factors: all.map(f => ({ id: f.id, label: FACTORS[f.id].label, direction: FACTORS[f.id].weight > 0 ? 'up' : 'down', evidence: f.evidence, source: f.source })),
    closestCases: closestCases(fix.fixType, vol?.count),
    basis: ai.length ? 'assessed' : ids.length ? 'rules' : 'standard',
    aiSummary: assessment?.summary || '',
    rangeLabel: 'Comparable published cases · adjusted for your evidence and profile · not a prediction · not legal advice',
  };
}

// ── Commercial cost of ASA and CMA findings (v1.1) ──
// Worked out only from the customer's own campaign figures. Each
// assumption is shown with the figure. Never a fine, never added to
// regulatory exposure. Assumptions are for the founder to review.
export const COMMERCIAL_ASSUMPTIONS = {
  reworkShare: 0.10,     // redoing and re-approving the creative, share of campaign budget
  reworkMin: 500,
  salesLost: { low: 0.25, likely: 0.5, high: 0.75 },   // share of expected sales lost if the ad is pulled
  refunded:  { low: 0.05, likely: 0.15, high: 0.30 },  // share of campaign revenue refunded or compensated
};
export function marketingCost(category, inputs = {}, campaign = {}) {
  if (category !== 'ASA' && category !== 'CMA') return null;
  const A = COMMERCIAL_ASSUMPTIONS;
  const own = num(campaign?.campaignBudget) || num(campaign?.campaignRevenue);
  const budget = num(campaign?.campaignBudget) || inputs.campaignBudget || null;
  const revenue = num(campaign?.campaignRevenue) || inputs.campaignRevenue || null;
  const pct = x => `${Math.round(x * 100)}%`;
  const base = {
    category, budget, revenue,
    source: own ? 'campaign' : 'profile',
    label: category === 'ASA' ? 'If this ad had to be withdrawn' : 'If customers had to be refunded',
    disclaimer: COMMERCIAL_DISCLAIMER,
  };
  if (category === 'ASA') {
    const needs = [!budget && 'campaignBudget', !revenue && 'campaignRevenue'].filter(Boolean);
    if (!budget && !revenue) return { ...base, available: false, needs };
    const rework = budget ? Math.max(A.reworkMin, budget * A.reworkShare) : 0;
    const lost = k => revenue ? revenue * A.salesLost[k] : 0;
    const lines = [];
    if (budget) lines.push({ label: 'Redoing and re-approving the ad', amount: roundNice(rework), basis: `${pct(A.reworkShare)} of the campaign budget` });
    if (revenue) lines.push({ label: 'Sales lost if it is pulled partway through', amount: roundNice(lost('likely')), basis: `${pct(A.salesLost.likely)} of expected campaign sales (${pct(A.salesLost.low)} if pulled late, ${pct(A.salesLost.high)} if early)` });
    return { ...base, available: true, needs, lines,
      low: roundNice(rework + lost('low')), mostLikely: roundNice(rework + lost('likely')), high: roundNice(rework + lost('high')) };
  }
  if (!revenue) return { ...base, available: false, needs: ['campaignRevenue'] };
  const r = k => revenue * A.refunded[k];
  return { ...base, available: true, needs: [],
    lines: [{ label: 'Refunds or compensation to customers who bought', amount: roundNice(r('likely')), basis: `${pct(A.refunded.likely)} of campaign revenue (range ${pct(A.refunded.low)} to ${pct(A.refunded.high)})` }],
    low: roundNice(r('low')), mostLikely: roundNice(r('likely')), high: roundNice(r('high')) };
}
export function marketingCostTotals(fixes) {
  const list = fixes.map(f => f.exposure?.marketingCost).filter(Boolean);
  const ok = list.filter(m => m.available);
  return {
    count: list.length,
    priced: ok.length,
    needInputs: list.length - ok.length,
    low: ok.reduce((s, m) => s + m.low, 0),
    mostLikely: ok.reduce((s, m) => s + m.mostLikely, 0),
    high: ok.reduce((s, m) => s + m.high, 0),
    disclaimer: COMMERCIAL_DISCLAIMER,
  };
}

// ── Clustering and totals (ICO only) ──
// Cluster = largest finding + OTHER_SHARE of each other one, capped at CAP x the largest
export const CLUSTER = { otherShare: 0.25, cap: 2 };
export function clusterExposure(fixes) {
  const groups = {};
  for (const f of fixes) {
    const e = f.exposure;
    if (!e || e.category !== 'ICO' || !e.hasRange) continue;
    const area = areaOf(f.fixType);
    (groups[area] = groups[area] || []).push(f);
  }
  const clusters = Object.entries(groups).map(([area, list]) => {
    const sorted = [...list].sort((a, b) => b.exposure.realisticHigh - a.exposure.realisticHigh);
    const lead = sorted[0].exposure, rest = sorted.slice(1);
    const { otherShare: k, cap } = CLUSTER;
    const low  = Math.min(lead.realisticLow  * cap, lead.realisticLow  + k * rest.reduce((s, f) => s + f.exposure.realisticLow, 0));
    const high = Math.min(lead.realisticHigh * cap, lead.realisticHigh + k * rest.reduce((s, f) => s + f.exposure.realisticHigh, 0));
    const likely = Math.min(lead.mostLikely * cap, lead.mostLikely + k * rest.reduce((s, f) => s + (f.exposure.mostLikely || 0), 0));
    const confidence = worstConfidence(list.map(f => f.exposure.confidence));
    return { area, label: AREAS[area]?.label || 'Other data protection', low: Math.round(low), high: Math.round(high), mostLikely: roundNice(likely || (low + high) / 2), confidence, count: list.length, leadFixId: sorted[0].id, fixIds: list.map(f => f.id) };
  }).sort((a, b) => b.high - a.high);
  return {
    clusters,
    totalLow:  clusters.reduce((s, c) => s + c.low, 0),
    totalHigh: clusters.reduce((s, c) => s + c.high, 0),
    totalMostLikely: clusters.reduce((s, c) => s + c.mostLikely, 0),
    confidence: clusters.length ? worstConfidence(clusters.map(c => c.confidence)) : null,
  };
}
function worstConfidence(levels) {
  return ['low', 'medium', 'high'].find(l => levels.includes(l)) || 'low';
}
const mid = c => (c.totalLow + c.totalHigh) / 2;

// Exposure removed by completed fixes = exposure with them open minus
// exposure without them. Verified = closed by a re-run, not a click.
export function riskAddressed(pending, completed, now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isVerified = f => f.completionSource === 'improved_on_rerun' || f.completionSource === 'verified';
  const base = mid(clusterExposure(pending));
  const allTotal = Math.round(mid(clusterExposure([...pending, ...completed])) - base);
  const verified = Math.round(mid(clusterExposure([...pending, ...completed.filter(isVerified)])) - base);
  const before = completed.filter(f => !(f.completedDate || '').startsWith(month));
  const monthTotal = Math.round(mid(clusterExposure([...pending, ...completed])) - mid(clusterExposure([...pending, ...before])));
  return { allTotal, monthTotal, verified, selfAttested: Math.max(0, allTotal - verified), month };
}

// ── CMA statutory maximum for the customer's revenue band ──
const BAND_TURNOVER = { under_1m: 1000000, '1m_10m': 10000000, '10m_50m': 50000000, over_50m: null };
export function cmaStatutoryMax(revenueBand) {
  const t = BAND_TURNOVER[normaliseBand(revenueBand)];
  if (t === null) return { amount: null, label: 'Higher of £300,000 or 10% of global turnover' };
  return { amount: Math.max(300000, Math.round(t * 0.1)), label: `Up to £${Math.max(300000, Math.round(t * 0.1)).toLocaleString('en-GB')} for a business your size (higher of £300k or 10% of turnover, DMCCA 2024)` };
}

// ── Attention likelihood (shown beside the range, never multiplied in) ──
export function attentionLikelihood(pending, sector) {
  let pts = 0; const reasons = [];
  const crit = pending.filter(f => f.severity === 'critical').length;
  if (crit) { pts += 2; reasons.push(`${crit} critical finding${crit > 1 ? 's' : ''} open`); }
  const maxVol = Math.max(0, ...pending.map(f => Number(f.contactVolume) || 0));
  if (maxVol > 100000) { pts += 2; reasons.push('Large audience affected'); } else if (maxVol > 10000) { pts += 1; reasons.push('Mid-sized audience affected'); }
  if (pending.some(f => ['suppression_breach', 'third_party_list', 'lead_gen_consent_gap'].includes(f.fixType))) { pts += 2; reasons.push('Issue type the ICO has fined recently (opt-outs or bought-in data)'); }
  if (HIGH_SCRUTINY.includes(sector)) { pts += 1; reasons.push('Sector with higher regulator focus'); }
  if (pending.some(f => f.createdDate && (Date.now() - new Date(f.createdDate)) / 86400000 > 90)) { pts += 1; reasons.push('Findings open for more than 90 days'); }
  const level = pts >= 5 ? 'High' : pts >= 3 ? 'Medium' : 'Low';
  return { level, points: pts, reasons };
}

// ── Compliance score: about open findings, weighted by severity.
//    Fixed + verified by a re-run = full credit; marked fixed by hand =
//    SELF_ATTESTED_CREDIT. Dismissed as "accepted risk" stays open;
//    dismissed as not applicable / false positive leaves the score. ──
export const SEVERITY_WEIGHT = { critical: 8, high: 5, medium: 3, low: 1 };
export const SELF_ATTESTED_CREDIT = 0.75;
export const DISMISS_REASONS = ['not_applicable', 'false_positive', 'accepted_risk'];
export function computeScore(all) {
  const w = f => SEVERITY_WEIGHT[f.severity] || 3;
  let total = 0, earned = 0;
  for (const f of all) {
    if (f.exposure?.category === 'Commercial') continue;
    if (f.status === 'dismissed' && f.dismissReason !== 'accepted_risk') continue;
    total += w(f);
    if (f.status === 'completed') earned += w(f) * ((f.completionSource === 'improved_on_rerun' || f.completionSource === 'verified') ? 1 : SELF_ATTESTED_CREDIT);
  }
  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  return { score, ...getScoreBand(score), weightedTotal: total };
}

// ── What would lower the figure (for the "Why this number?" drawer) ──
export function reductionTips(exposure) {
  const tips = [];
  const ids = (exposure?.factors || []).map(f => f.id);
  if (ids.includes('open_long')) tips.push('Close it soon: findings open for months count against you.');
  if (!ids.includes('documented_assessment')) tips.push('Record a documented assessment (for example in Campaign Defence) to show due diligence.');
  if (ids.includes('dpa_refused')) tips.push('Stop sharing data with a vendor that refuses a DPA, or replace the vendor.');
  if (ids.includes('continued_after_optout')) tips.push('Suppress everyone who opted out before the next send, and re-run the suppression check.');
  if (ids.includes('purchased_or_third_party_data')) tips.push('Stop sending to bought-in or partner data until consent naming you is evidenced.');
  tips.push('Fix it, then re-run the tool so Sendwize can verify it, which gives full credit.');
  return tips.slice(0, 4);
}

// ── Format one Compliance_Fixes record for the API ──
const safeParse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
export function formatFixRecord(r, revenueBand, sector, inputs = {}) {
  const f = r.fields || {};
  const fixType = (f.FixType || '').toLowerCase();
  const processingContext = safeParse(f.ProcessingContext);
  const improvedOnRerun = (() => { const p = safeParse(f.ImprovedOnRerun); return p && typeof p === 'object' ? p : null; })();
  const fix = {
    id:               r.id,
    fixType,
    description:      f.Description    || '',
    tool:             f.Tool           || '',
    severity:         f.Severity       || '',
    status:           f.Status         || 'pending',
    contactVolume:    f.ContactVolume  || null,
    sourceRecordId:   f.SourceRecordID || null,
    completedDate:    f.CompletedDate  || null,
    createdDate:      f.CreatedDate    || null,
    improvedOnRerun,
    completionSource: f.CompletionSource || null,
    dismissReason:    f.DismissReason  || null,
    processingContext,
  };
  const stored = {
    low:  f.ExposureLow  != null ? Number(f.ExposureLow)  : null,
    high: f.ExposureHigh != null ? Number(f.ExposureHigh) : null,
  };
  const base = buildExposureForFix(fixType, revenueBand, processingContext, stored, sector);
  // An AI assessment only counts if it was made on today's evidence
  const assessment = safeParse(f.AssessmentJson);
  const hash = evidenceHash(fix, { sector, revenueBand: normaliseBand(revenueBand) });
  const current = assessment && f.EvidenceHash === hash ? assessment : null;
  fix.exposure = refineExposure(base, fix, sector, current, inputs || {});
  if (base.category === 'ASA' || base.category === 'CMA') {
    fix.campaignInputs = safeParse(f.CommercialInputs) || null;
    fix.exposure = { ...fix.exposure, marketingCost: marketingCost(base.category, inputs || {}, fix.campaignInputs || {}) };
  }
  fix.assessment = current ? { assessedAt: assessment.assessedAt || null, confidence: assessment.confidence || null } : null;
  fix.assessmentStale = !!(assessment && !current);
  return fix;
}

// ── Everything the public methodology page shows, straight from the
//    constants above so the page can't drift from the code ──
export function method() {
  const ico = Object.entries(EXPOSURE_CONSTANTS)
    .filter(([, d]) => d.category === 'ICO')
    .map(([type, d]) => ({ type, area: areaOf(type), bands: d.bands, caseAnchor: d.caseAnchor || null }));
  const asa = Object.entries(EXPOSURE_CONSTANTS)
    .filter(([, d]) => d.category === 'ASA')
    .map(([type, d]) => ({ type, referralRisk: d.referralRisk || 'medium' }));
  const cma = Object.fromEntries(Object.keys(BAND_LABELS).map(b => [b, cmaStatutoryMax(b)]));
  return {
    version: ENGINE_VERSION,
    bands: BAND_LABELS,
    bandLimits: BAND_LIMITS,
    sectors: SECTOR_MULTIPLIERS,
    ico, asa, cma,
    areas: Object.fromEntries(Object.entries(AREAS).map(([k, a]) => [k, a.label])),
    factors: Object.entries(FACTORS).map(([id, f]) => ({ id, ...f })),
    position: POSITION,
    halfWidth: HALF_WIDTH,
    confidenceAt: CONFIDENCE_AT,
    confidenceInputs: TIGHTEN,
    cluster: CLUSTER,
    commercial: COMMERCIAL_ASSUMPTIONS,
    severityWeight: SEVERITY_WEIGHT,
    selfAttestedCredit: SELF_ATTESTED_CREDIT,
    requiredProfile: REQUIRED_PROFILE,
    cases: CASE_ANCHORS.map(c => ({ ...c, url: c.url || ICO_ACTION_URL })),
    legal: { icoMax: ICO_LEGAL_MAX, cmaMax: CMA_LEGAL_MAX, duaaWarning: DUAA_WARNING, notLegalAdvice: NOT_LEGAL_ADVICE, commercialDisclaimer: COMMERCIAL_DISCLAIMER },
  };
}

export {
  normaliseBand, normaliseSector, getExposureConstants, getICORange, getRealisticMidpoint,
  buildExposureForFix, getScoreBand, EXPOSURE_CONSTANTS, SECTOR_MULTIPLIERS,
  ICO_LEGAL_MAX, CMA_LEGAL_MAX, NOT_LEGAL_ADVICE, COMMERCIAL_DISCLAIMER, DUAA_WARNING,
};
