// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-intelligence.js v1.2 (beta)
// POST /api/list-intelligence?action=upload  — CSV analysis
// GET  /api/list-intelligence?action=load    — load last results
// POST /api/list-intelligence?action=certificate — generate pre-send cert
//
// v1.2 (beta):
//   - All Airtable helpers (atGet, atCreate, atPatch) now use atFetch
//     from _airtable.js for retry/backoff consistency
//   - ASA + CMA compliance notes added to analyseList() output
//     when liabilityPct exceeds thresholds
//   - All other code identical to v1.1
// ─────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { atFetch } from './_airtable.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const BASE_ID = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

// ── Airtable helpers (now using atFetch for retry) ────────────
async function atGet(table, formula, sort = '', max = 100) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: atH() });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atCreate(table, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await atFetch(`${AT_BASE}/${encodeURIComponent(table)}`, {
    method:  'POST',
    headers: atH(),
    body:    JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) throw new Error(`AT POST ${table}: ${r.status} — ${await r.text()}`);
  return (await r.json()).records?.[0];
}

async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await atFetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method:  'PATCH',
    headers: atH(),
    body:    JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`AT PATCH ${table}: ${r.status}`);
  return await r.json();
}

// ── SHA-256 hash ──────────────────────────────────────────────
function hashEmail(email) {
  return crypto.createHash('sha256')
    .update((email || '').toLowerCase().trim())
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────
// COLUMN AUTO-DETECTION
// ─────────────────────────────────────────────────────────────

function detectListColumns(headers, rows) {
  const sample = rows.slice(0, 30);
  const mapping = {};
  const dateRe  = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (const h of headers) {
    const vals = sample.map(r => String(r[h] || '').trim()).filter(Boolean);
    const lc   = h.toLowerCase();

    if (vals.filter(v => emailRe.test(v)).length / Math.max(vals.length, 1) > 0.7) {
      mapping[h] = 'email'; continue;
    }
    if (vals.filter(v => dateRe.test(v)).length / Math.max(vals.length, 1) > 0.7) {
      if (lc.includes('join') || lc.includes('sign') || lc.includes('add') || lc.includes('creat') || lc.includes('subscri')) {
        mapping[h] = 'date_added';
      } else if (lc.includes('engag') || lc.includes('open') || lc.includes('click') || lc.includes('activ') || lc.includes('last')) {
        mapping[h] = 'last_engagement';
      } else if (lc.includes('purchas') || lc.includes('order') || lc.includes('buy')) {
        mapping[h] = 'last_purchase';
      } else {
        mapping[h] = 'date_added';
      }
      continue;
    }
    if (lc.includes('engag') || lc.includes('type') || lc.includes('action') || lc.includes('event')) {
      mapping[h] = 'engagement_type'; continue;
    }
    if (lc.includes('segment') || lc.includes('list') || lc.includes('group') || lc.includes('tag')) {
      mapping[h] = 'segment'; continue;
    }
    if (lc.includes('status') || lc.includes('state') || lc.includes('subscri')) {
      mapping[h] = 'status'; continue;
    }
    if (lc.includes('name') || lc.includes('first') || lc.includes('last')) {
      mapping[h] = 'ignore'; continue;
    }
    const nums = vals.map(v => parseFloat(v)).filter(n => !isNaN(n));
    if (nums.length / Math.max(vals.length, 1) > 0.8) {
      if (lc.includes('order') || lc.includes('purchas') || lc.includes('value') || lc.includes('spend') || lc.includes('ltv')) {
        mapping[h] = 'order_value'; continue;
      }
      if (lc.includes('count') || lc.includes('num') || lc.includes('open') || lc.includes('click')) {
        mapping[h] = 'engagement_count'; continue;
      }
    }
    mapping[h] = 'ignore';
  }
  return mapping;
}

function normaliseDate(raw) {
  if (!raw) return null;
  const s  = String(raw).trim();
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

// ─────────────────────────────────────────────────────────────
// KNOWN DISPOSABLE / SPAM TRAP / TYPO DOMAINS
// ─────────────────────────────────────────────────────────────

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','throwam.com',
  'yopmail.com','tempmail.com','fakeinbox.com','trashmail.com',
  'sharklasers.com','guerrillamailblock.com','grr.la','guerrillamail.info',
  'spam4.me','tempr.email','dispostable.com','mailnull.com',
]);

const ROLE_PREFIXES = new Set([
  'admin','info','support','help','contact','sales','marketing','noreply',
  'no-reply','postmaster','webmaster','abuse','hello','office','team',
  'billing','accounts','enquiries','enquiry','mail','email',
]);

const SPAM_TRAP_INDICATORS = ['spam','trap','test','fake','invalid','bounce'];

const TYPO_DOMAINS = {
  'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com',
  'livee.com': 'live.com', 'iclod.com': 'icloud.com',
};

// ─────────────────────────────────────────────────────────────
// SECTOR BENCHMARKS
// ─────────────────────────────────────────────────────────────

const SECTOR_BENCHMARKS = {
  ecommerce:   { conversionRate: 0.025, avgOrderMultiplier: 1.0 },
  finance:     { conversionRate: 0.008, avgOrderMultiplier: 4.0 },
  healthcare:  { conversionRate: 0.012, avgOrderMultiplier: 2.5 },
  agency:      { conversionRate: 0.015, avgOrderMultiplier: 3.0 },
  other:       { conversionRate: 0.018, avgOrderMultiplier: 1.2 },
};

// ─────────────────────────────────────────────────────────────
// DIMENSION 1 — CONSENT TRAJECTORY
// ─────────────────────────────────────────────────────────────

const CONSENT_DECAY_HALF_LIFE_DAYS = 365;
const CONSENT_THRESHOLD = 20;

function dimension1_consent(contact) {
  const now       = new Date();
  const added     = contact.dateAdded ? new Date(contact.dateAdded) : now;
  const daysOld   = Math.max(0, (now - added) / 86400000);

  const baseDecay = Math.pow(0.5, daysOld / CONSENT_DECAY_HALF_LIFE_DAYS);

  let engagementReset = 0;
  if (contact.lastEngagement) {
    const lastEng     = new Date(contact.lastEngagement);
    const daysSinceEng = Math.max(0, (now - lastEng) / 86400000);
    const engType      = (contact.engagementType || '').toLowerCase();
    let resetStrength  = 0;
    if (engType.includes('purchas') || engType.includes('order') || engType.includes('buy')) {
      resetStrength = 0.6;
    } else if (engType.includes('click')) {
      resetStrength = 0.4;
    } else if (engType.includes('open')) {
      resetStrength = 0.2;
    } else {
      resetStrength = 0.15;
    }
    engagementReset = resetStrength * Math.pow(0.5, daysSinceEng / CONSENT_DECAY_HALF_LIFE_DAYS);
  }

  let disengagementPenalty = 0;
  if (contact.lastEngagement) {
    const daysSinceEng = (now - new Date(contact.lastEngagement)) / 86400000;
    if (daysSinceEng > 180) disengagementPenalty = 0.15;
    if (daysSinceEng > 365) disengagementPenalty = 0.30;
  } else if (daysOld > 180) {
    disengagementPenalty = 0.20;
  }

  const rawStrength    = Math.min(1, baseDecay + engagementReset - disengagementPenalty);
  const consentStrength = Math.round(Math.max(0, rawStrength) * 100);

  const decayPerMonth  = (1 - Math.pow(0.5, 30 / CONSENT_DECAY_HALF_LIFE_DAYS)) * 100;
  const consentDecayRate = parseFloat(decayPerMonth.toFixed(2));

  const currentFraction = rawStrength;
  const thresholdFraction = CONSENT_THRESHOLD / 100;
  let daysToThreshold = null;
  if (currentFraction > thresholdFraction) {
    daysToThreshold = Math.round(
      CONSENT_DECAY_HALF_LIFE_DAYS * Math.log(currentFraction / thresholdFraction) / Math.log(2)
    );
  }

  return { consentStrength, consentDecayRate, daysToThreshold };
}

// ─────────────────────────────────────────────────────────────
// DIMENSION 2 — DELIVERABILITY TRAJECTORY
// ─────────────────────────────────────────────────────────────

function dimension2_deliverability(contact, domainCounts, totalContacts) {
  const email  = (contact.email || '').toLowerCase().trim();
  const parts  = email.split('@');
  if (parts.length !== 2) return { deliverabilityScore: 0, primaryRisk: 'invalid_format' };

  const local  = parts[0];
  const domain = parts[1];
  let score    = 100;
  let primaryRisk = null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { deliverabilityScore: 0, primaryRisk: 'invalid_format' };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { deliverabilityScore: 10, primaryRisk: 'disposable_domain' };
  }
  if (SPAM_TRAP_INDICATORS.some(t => local.includes(t))) {
    score -= 50; primaryRisk = primaryRisk || 'spam_trap_indicator';
  }
  if (TYPO_DOMAINS[domain]) {
    score -= 40; primaryRisk = primaryRisk || 'typo_domain';
  }
  const localPrefix = local.split('+')[0].split('.')[0];
  if (ROLE_PREFIXES.has(localPrefix)) {
    score -= 25; primaryRisk = primaryRisk || 'role_based';
  }
  if (/\d{1,4}$/.test(local) && parseInt(local.match(/\d+$/)[0]) < 100) {
    score -= 10; primaryRisk = primaryRisk || 'sequential_pattern';
  }
  const domainPct = (domainCounts[domain] || 0) / Math.max(totalContacts, 1);
  if (domainPct > 0.4) {
    score -= 20; primaryRisk = primaryRisk || 'domain_concentration';
  } else if (domainPct > 0.25) {
    score -= 10;
  }
  if (contact.lastEngagement) {
    const daysOld = (new Date() - new Date(contact.dateAdded || new Date())) / 86400000;
    const daysSinceEng = (new Date() - new Date(contact.lastEngagement)) / 86400000;
    const engRatio = daysOld > 0 ? Math.min(1, 1 - daysSinceEng / daysOld) : 0.5;
    if (engRatio > 0.7)       score += 10;
    else if (engRatio < 0.2)  score -= 15;
  } else {
    score -= 10;
  }

  const deliverabilityScore = Math.max(0, Math.min(100, Math.round(score)));
  return { deliverabilityScore, primaryRisk: primaryRisk || 'none' };
}

// ─────────────────────────────────────────────────────────────
// DIMENSION 3 — COMMERCIAL TRAJECTORY
// ─────────────────────────────────────────────────────────────

function dimension3_commercial(contact, sector, aov) {
  const benchmark = SECTOR_BENCHMARKS[sector] || SECTOR_BENCHMARKS.other;
  const baseValue = benchmark.conversionRate * (aov || 50) * benchmark.avgOrderMultiplier;

  let engMultiplier = 0.5;
  if (contact.lastEngagement) {
    const daysSinceEng = (new Date() - new Date(contact.lastEngagement)) / 86400000;
    const engType      = (contact.engagementType || '').toLowerCase();
    if (engType.includes('purchas') || engType.includes('order')) {
      engMultiplier = daysSinceEng < 90  ? 2.5 : daysSinceEng < 180 ? 1.8 : 1.2;
    } else if (engType.includes('click')) {
      engMultiplier = daysSinceEng < 90  ? 1.5 : daysSinceEng < 180 ? 1.1 : 0.8;
    } else if (engType.includes('open')) {
      engMultiplier = daysSinceEng < 90  ? 1.1 : daysSinceEng < 180 ? 0.9 : 0.6;
    } else {
      engMultiplier = daysSinceEng < 90  ? 0.9 : daysSinceEng < 365 ? 0.7 : 0.4;
    }
  }

  const commercialValue    = parseFloat((baseValue * engMultiplier).toFixed(2));
  const decayedMultiplier  = engMultiplier * 0.85;
  const interventionValue  = parseFloat((baseValue * (engMultiplier - decayedMultiplier)).toFixed(2));
  const direction = engMultiplier > 1.0 ? 'growing' : engMultiplier > 0.7 ? 'stable' : 'declining';

  return { commercialValue, interventionValue, direction };
}

// ─────────────────────────────────────────────────────────────
// DIMENSION 4 — RISK TRAJECTORY
// ─────────────────────────────────────────────────────────────

function dimension4_risk(consentResult) {
  const { consentStrength, consentDecayRate, daysToThreshold } = consentResult;
  const thresholdProximity = Math.max(0, 1 - (consentStrength - CONSENT_THRESHOLD) / 80);
  const riskAcceleration   = parseFloat((consentDecayRate * (1 + thresholdProximity)).toFixed(3));
  return { riskAcceleration, daysToThreshold };
}

// ─────────────────────────────────────────────────────────────
// PRIORITISATION
// ─────────────────────────────────────────────────────────────

function prioritisationScore(consent, commercial, risk, deliverability, maxCommercial) {
  const cScore = consent.consentStrength / 100;
  const comScore = maxCommercial > 0 ? commercial.commercialValue / maxCommercial : 0;
  const rScore = risk.daysToThreshold !== null ? Math.min(1, risk.daysToThreshold / 365) : 1;
  const dScore = deliverability.deliverabilityScore / 100;
  return parseFloat((cScore * 0.35 + comScore * 0.30 + rScore * 0.25 + dScore * 0.10).toFixed(4));
}

// ─────────────────────────────────────────────────────────────
// LIST-LEVEL ANALYSIS
// ─────────────────────────────────────────────────────────────

function analyseList(contacts, sector, aov) {
  const domainCounts = {};
  const emails       = new Set();
  let   duplicates   = 0;

  for (const c of contacts) {
    const email = (c.email || '').toLowerCase().trim();
    if (emails.has(email)) { duplicates++; continue; }
    emails.add(email);
    const domain = email.split('@')[1] || '';
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  }

  const unique = contacts.filter((c, i, arr) =>
    arr.findIndex(x => (x.email||'').toLowerCase().trim() === (c.email||'').toLowerCase().trim()) === i
  );

  const analysed = unique.map(c => {
    const d1 = dimension1_consent(c);
    const d2 = dimension2_deliverability(c, domainCounts, unique.length);
    const d3 = dimension3_commercial(c, sector, aov);
    const d4 = dimension4_risk(d1);
    return { ...c, ...d1, ...d2, ...d3, ...d4 };
  });

  const maxCommercial = Math.max(...analysed.map(c => c.commercialValue), 1);

  const scored = analysed.map(c => ({
    ...c,
    priorityScore: prioritisationScore(
      { consentStrength: c.consentStrength },
      { commercialValue: c.commercialValue },
      { daysToThreshold: c.daysToThreshold },
      { deliverabilityScore: c.deliverabilityScore },
      maxCommercial
    ),
  }));

  const active      = scored.filter(c => c.consentStrength >= 60 && c.deliverabilityScore >= 60);
  const recoverable = scored.filter(c => c.consentStrength >= CONSENT_THRESHOLD && c.consentStrength < 60 && c.deliverabilityScore >= 40);
  const atRisk      = scored.filter(c => c.consentStrength >= CONSENT_THRESHOLD && c.deliverabilityScore < 40);
  const liability   = scored.filter(c => c.consentStrength < CONSENT_THRESHOLD);

  const assetValue = parseFloat(
    [...active, ...recoverable].reduce((s, c) => s + c.commercialValue, 0).toFixed(2)
  );

  const aboveThreshold = scored.filter(c => c.daysToThreshold !== null);
  const expiring30 = aboveThreshold.filter(c => c.daysToThreshold <= 30).length;
  const expiring60 = aboveThreshold.filter(c => c.daysToThreshold > 30 && c.daysToThreshold <= 60).length;
  const expiring90 = aboveThreshold.filter(c => c.daysToThreshold > 60 && c.daysToThreshold <= 90).length;

  const valueExpiring90 = parseFloat(
    aboveThreshold.filter(c => c.daysToThreshold <= 90).reduce((s, c) => s + c.commercialValue, 0).toFixed(2)
  );

  const liabilityPct = unique.length > 0 ? liability.length / unique.length : 0;
  let icoStatus = 'Good standing';
  if (liabilityPct > 0.3)      icoStatus = 'High risk \u2014 significant portion below consent threshold';
  else if (liabilityPct > 0.1) icoStatus = 'Review recommended \u2014 contacts approaching threshold';

  // v1.2 — ASA + CMA compliance notes
  let asaNote = null;
  if (liabilityPct > 0.1) {
    asaNote = 'ASA position: promotional emails sent to contacts with ambiguous consent may also breach CAP Code Section 2, which requires marketing to be obviously identifiable and sent with the recipient\u2019s agreement.';
  }
  let cmaNote = null;
  if (liabilityPct > 0.15) {
    cmaNote = 'CMA position: under DMCCA 2024, sending promotional content to contacts who have not clearly consented could constitute an aggressive or misleading commercial practice.';
  }

  const invalidFormat  = scored.filter(c => c.primaryRisk === 'invalid_format').length;
  const disposable     = scored.filter(c => c.primaryRisk === 'disposable_domain').length;
  const roleBased      = scored.filter(c => c.primaryRisk === 'role_based').length;
  const typos          = scored.filter(c => c.primaryRisk === 'typo_domain').length;
  const spamTraps      = scored.filter(c => c.primaryRisk === 'spam_trap_indicator').length;
  const concentrated   = Object.values(domainCounts).filter(n => n / unique.length > 0.4).length > 0;

  const dataQualityFlags = [];
  if (invalidFormat > 0) dataQualityFlags.push(`${invalidFormat} invalid email format${invalidFormat!==1?'s':''}`);
  if (disposable > 0)    dataQualityFlags.push(`${disposable} disposable domain${disposable!==1?'s':''}`);
  if (roleBased > 0)     dataQualityFlags.push(`${roleBased} role-based address${roleBased!==1?'s':''}`);
  if (typos > 0)         dataQualityFlags.push(`${typos} likely typo domain${typos!==1?'s':''}`);
  if (spamTraps > 0)     dataQualityFlags.push(`${spamTraps} spam trap indicator${spamTraps!==1?'s':''}`);
  if (duplicates > 0)    dataQualityFlags.push(`${duplicates} duplicate${duplicates!==1?'s':''} removed`);
  if (concentrated)      dataQualityFlags.push('Domain concentration risk \u2014 over 40% from one domain');

  return {
    totalContacts:    unique.length,
    asaNote,
    cmaNote,
    duplicatesRemoved: duplicates,
    activeCount:      active.length,
    recoverableCount: recoverable.length,
    atRiskCount:      atRisk.length,
    liabilityCount:   liability.length,
    liabilityPct:     parseFloat(liabilityPct.toFixed(4)),
    assetValue,
    icoStatus,
    dataQualityFlags,
    expiring30,
    expiring60,
    expiring90,
    valueExpiring90,
    scored,
    active,
    recoverable,
    atRisk,
    liability,
  };
}

// ─────────────────────────────────────────────────────────────
// OPPORTUNITY GENERATION
// ─────────────────────────────────────────────────────────────

function generateOpportunities(analysis, sector, aov) {
  const opps = [];
  const { recoverable, atRisk, active, scored } = analysis;

  if (recoverable.length > 0) {
    const totalValue = recoverable.reduce((s, c) => s + c.interventionValue, 0);
    opps.push({
      type:              'Re-engagement campaign',
      description:       `${recoverable.length.toLocaleString()} contacts have declining consent but are still above the ICO threshold. A targeted re-engagement campaign now could recover this segment before consent expires.`,
      estimatedValue:    parseFloat(totalValue.toFixed(2)),
      currentValue:      parseFloat(totalValue.toFixed(2)),
      decayRate:         2.5,
      recommendedAction: 'Send a preference-update or re-consent email to this segment within the next 30 days.',
      templateAvailable: false,
    });
  }

  if (analysis.liabilityCount > 0) {
    opps.push({
      type:              'Suppression \u2014 liability contacts',
      description:       `${analysis.liabilityCount.toLocaleString()} contacts are below the consent strength threshold and represent ICO enforcement risk. Suppressing them removes liability while preserving the rest of your list deliverability.`,
      estimatedValue:    0,
      currentValue:      0,
      decayRate:         0,
      recommendedAction: 'Add these contacts to your suppression registry immediately. Do not send marketing until re-consent is obtained.',
      templateAvailable: false,
    });
  }

  const approachingRisk = active.filter(c => c.daysToThreshold !== null && c.daysToThreshold < 90);
  if (approachingRisk.length > 0) {
    const totalValue = approachingRisk.reduce((s, c) => s + c.commercialValue, 0);
    opps.push({
      type:              'Priority send window',
      description:       `${approachingRisk.length.toLocaleString()} high-value active contacts have less than 90 days before their consent strength drops significantly. This is your best send window for a promotional campaign.`,
      estimatedValue:    parseFloat(totalValue.toFixed(2)),
      currentValue:      parseFloat(totalValue.toFixed(2)),
      decayRate:         3.0,
      recommendedAction: 'Run a promotional or new-product campaign to this segment within the next 30 days while engagement is still strong.',
      templateAvailable: false,
    });
  }

  const poorDeliverability = scored.filter(c => c.deliverabilityScore < 40 && c.consentStrength >= CONSENT_THRESHOLD);
  if (poorDeliverability.length > 10) {
    opps.push({
      type:              'Deliverability clean',
      description:       `${poorDeliverability.length.toLocaleString()} contacts have poor deliverability signals \u2014 role-based addresses, typo domains, or sequential patterns. Removing them will improve inbox placement for the rest of your list.`,
      estimatedValue:    0,
      currentValue:      0,
      decayRate:         0,
      recommendedAction: 'Remove or quarantine these addresses before your next send. They are likely to bounce or be filtered as spam.',
      templateAvailable: false,
    });
  }

  return opps;
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOT STORAGE
// ─────────────────────────────────────────────────────────────

async function snapshotList(userId, analysis, assetValue) {
  await atCreate('List_Intelligence_Snapshots', {
    UserID:            userId,
    SnapshotDate:      new Date().toISOString().slice(0, 10),
    SnapshotTimestamp: new Date().toISOString(),
    TotalContacts:     analysis.totalContacts,
    ActiveCount:       analysis.activeCount,
    RecoverableCount:  analysis.recoverableCount,
    AtRiskCount:       analysis.atRiskCount,
    LiabilityCount:    analysis.liabilityCount,
    LiabilityPct:      analysis.liabilityPct,
    AssetValue:        assetValue,
    Expiring30:        analysis.expiring30,
    Expiring60:        analysis.expiring60,
    Expiring90:        analysis.expiring90,
  });
}

async function getListSnapshots(userId, max = 12) {
  const records = await atGet(
    'List_Intelligence_Snapshots',
    `{UserID}='${userId}'`,
    'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc',
    max
  );
  return records.map(r => ({
    date:             r.fields.SnapshotDate,
    timestamp:        r.fields.SnapshotTimestamp || r.fields.SnapshotDate,
    totalContacts:    r.fields.TotalContacts || 0,
    activeCount:      r.fields.ActiveCount || 0,
    recoverableCount: r.fields.RecoverableCount || 0,
    atRiskCount:      r.fields.AtRiskCount || 0,
    liabilityCount:   r.fields.LiabilityCount || 0,
    liabilityPct:     r.fields.LiabilityPct != null ? r.fields.LiabilityPct : 0,
    assetValue:       r.fields.AssetValue != null ? r.fields.AssetValue : 0,
    expiring30:       r.fields.Expiring30 || 0,
    expiring60:       r.fields.Expiring60 || 0,
    expiring90:       r.fields.Expiring90 || 0,
  }));
}

function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.abs(Math.round((a - b) / 86400000));
}

function buildListComparison(cur, prev) {
  if (!prev) return null;
  const valueDelta      = parseFloat((cur.assetValue - prev.assetValue).toFixed(2));
  const liabilityDelta  = cur.liabilityCount - prev.liabilityCount;
  const activeDelta     = cur.activeCount - prev.activeCount;
  const totalDelta      = cur.totalContacts - prev.totalContacts;
  const expiring30Delta = cur.expiring30 - prev.expiring30;

  let direction = 'same';
  if (valueDelta > 0 || liabilityDelta < 0 || activeDelta > 0) direction = 'improved';
  if (liabilityDelta > 0 || valueDelta < 0) direction = liabilityDelta > Math.abs(activeDelta) ? 'worsened' : direction;
  if (valueDelta < 0 && liabilityDelta > 0) direction = 'worsened';

  return {
    direction,
    daysSincePrevious: daysBetween(new Date().toISOString(), prev.timestamp),
    valueDelta,
    liabilityDelta,
    activeDelta,
    totalDelta,
    expiring30Delta,
    previous: {
      assetValue: prev.assetValue,
      liabilityCount: prev.liabilityCount,
      activeCount: prev.activeCount,
      totalContacts: prev.totalContacts,
      expiring30: prev.expiring30,
      date: prev.date,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────

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
      return res.status(200).json({ success: true, mapping: detectListColumns(headers, rows) });
    }

    // ── load ────────────────────────────────────────────────
    if (action === 'load') {
      const [checks, opps] = await Promise.all([
        atGet('List_Intelligence_Checks', `{UserID}='${userId}'`,
          'sort[0][field]=CheckDate&sort[0][direction]=desc', 1),
        atGet('List_Opportunities', `AND({UserID}='${userId}',{Status}='Open')`,
          'sort[0][field]=CurrentValue&sort[0][direction]=desc', 50),
      ]);

      if (!checks.length) return res.status(200).json({ success: true, hasData: false });

      const latest = checks[0].fields;

      const now = new Date();
      const decayedOpps = opps.map(o => {
        const created    = o.fields.CreatedDate ? new Date(o.fields.CreatedDate) : now;
        const monthsOld  = (now - created) / (30 * 86400000);
        const decayRate  = o.fields.DecayRate || 2.5;
        const decayed    = o.fields.EstimatedValue * Math.pow(1 - decayRate / 100, monthsOld);
        return {
          id:                o.id,
          type:              o.fields.OpportunityType,
          description:       o.fields.Description,
          estimatedValue:    o.fields.EstimatedValue,
          currentValue:      parseFloat(Math.max(0, decayed).toFixed(2)),
          decayRate:         decayRate,
          recommendedAction: o.fields.RecommendedAction,
          status:            o.fields.Status,
        };
      });

      const unrealisedTotal = decayedOpps.reduce((s, o) => s + o.currentValue, 0);

      const snaps = await getListSnapshots(userId, 12);
      const changes = snaps.length >= 2 ? buildListComparison(snaps[0], snaps[1]) : null;

      return res.status(200).json({
        success:        true,
        hasData:        true,
        checkDate:      latest.CheckDate,
        totalContacts:  latest.TotalContacts,
        activeCount:    latest.ActiveCount,
        recoverableCount: latest.RecoverableCount,
        atRiskCount:    latest.AtRiskCount,
        liabilityCount: latest.LiabilityCount,
        assetValue:     latest.AssetValue,
        icoStatus:      latest.ICOStatus,
        dataQuality:    latest.DataQuality,
        sector:         latest.Sector,
        aov:            latest.AverageOrderValue,
        opportunities:  decayedOpps,
        unrealisedTotal: parseFloat(unrealisedTotal.toFixed(2)),
        uploadVersion:  latest.UploadVersion,
        asaNote:        latest.ASANote || null,
        cmaNote:        latest.CMANote || null,
        consentExpiring: snaps[0] ? { in30: snaps[0].expiring30, in60: snaps[0].expiring60, in90: snaps[0].expiring90 } : null,
        changes,
        history: snaps.slice(0, 8).reverse().map(s => ({ date: s.date, assetValue: s.assetValue, liabilityCount: s.liabilityCount, activeCount: s.activeCount })),
      });
    }

    // ── upload ──────────────────────────────────────────────
    if (action === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

      const { rows, fieldMapping, sector, aov, uploadVersion } = req.body;
      if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

      const sectorVal = sector || 'ecommerce';
      const aovVal    = parseFloat(aov) || 50;
      const version   = uploadVersion || 1;

      const contacts = rows.map(row => {
        const c = {
          email: null, dateAdded: null, lastEngagement: null,
          lastPurchase: null, engagementType: null, segment: null,
          status: null, orderValue: null, engagementCount: null,
        };
        for (const [header, target] of Object.entries(fieldMapping || {})) {
          const val = row[header];
          if (!val || val === '') continue;
          if      (target === 'email')            c.email          = String(val).toLowerCase().trim();
          else if (target === 'date_added')       c.dateAdded      = normaliseDate(val);
          else if (target === 'last_engagement')  c.lastEngagement = normaliseDate(val);
          else if (target === 'last_purchase')    c.lastPurchase   = normaliseDate(val);
          else if (target === 'engagement_type')  c.engagementType = String(val).trim();
          else if (target === 'segment')          c.segment        = String(val).trim();
          else if (target === 'status')           c.status         = String(val).trim();
          else if (target === 'order_value')      c.orderValue     = parseFloat(val) || null;
          else if (target === 'engagement_count') c.engagementCount = parseInt(val) || null;
        }
        if (!c.lastEngagement && c.lastPurchase) {
          c.lastEngagement = c.lastPurchase;
          if (!c.engagementType) c.engagementType = 'purchase';
        }
        return c;
      }).filter(c => c.email && c.email.includes('@'));

      if (!contacts.length) return res.status(400).json({ error: 'No valid email addresses found. Ensure an email column is present and mapped.' });

      const priorSnaps = await getListSnapshots(userId, 1);
      const priorSnap = priorSnaps[0] || null;

      const analysis = analyseList(contacts, sectorVal, aovVal);
      const opportunities = generateOpportunities(analysis, sectorVal, aovVal);
      const today = new Date().toISOString().split('T')[0];

      try {
        const profileRecs = await atGet('User_Profile', `{UserID}='${userId}'`, '', 1);
        if (profileRecs.length) {
          const pf = profileRecs[0].fields;
          const profileUpdate = {};
          if (!pf.Sector && sectorVal)      profileUpdate.Sector = sectorVal;
          if (!pf.AverageOrderValue && aovVal) profileUpdate.AverageOrderValue = aovVal;
          if (Object.keys(profileUpdate).length) {
            await atPatch('User_Profile', profileRecs[0].id, profileUpdate);
          }
        }
      } catch(e) { console.error('Profile update non-fatal:', e); }

      await atCreate('List_Intelligence_Checks', {
        UserID:           userId,
        CheckDate:        today,
        TotalContacts:    analysis.totalContacts,
        ActiveCount:      analysis.activeCount,
        RecoverableCount: analysis.recoverableCount,
        AtRiskCount:      analysis.atRiskCount,
        LiabilityCount:   analysis.liabilityCount,
        AssetValue:       analysis.assetValue,
        ICOStatus:        analysis.icoStatus,
        DataQualityStatus: analysis.dataQualityFlags.length === 0 ? 'Clean' : 'Issues found',
        DataQuality:      analysis.dataQualityFlags.join('; ') || 'No issues detected',
        Sector:           sectorVal,
        AverageOrderValue: aovVal,
        UploadVersion:    version,
      });

      await snapshotList(userId, analysis, analysis.assetValue);

      for (const opp of opportunities) {
        await atCreate('List_Opportunities', {
          UserID:            userId,
          OpportunityType:   opp.type,
          Description:       opp.description,
          EstimatedValue:    opp.estimatedValue,
          CurrentValue:      opp.currentValue,
          DecayRate:         opp.decayRate,
          RecommendedAction: opp.recommendedAction,
          TemplateAvailable: opp.templateAvailable,
          Status:            'Open',
          CreatedDate:       today,
          UploadVersion:     version,
        });
      }

      const topContacts = [...analysis.scored]
        .sort((a, b) => b.priorityScore - a.priorityScore)
        .slice(0, 500);

      for (const c of topContacts) {
        await atCreate('List_Contacts', {
          UserID:              userId,
          EmailHash:           hashEmail(c.email),
          DateAdded:           c.dateAdded    || null,
          LastEngagement:      c.lastEngagement || null,
          ConsentStrength:     c.consentStrength,
          ConsentDecayRate:    c.consentDecayRate,
          DeliverabilityScore: c.deliverabilityScore,
          CommercialValue:     c.commercialValue,
          InterventionValue:   c.interventionValue,
          RiskAcceleration:    c.riskAcceleration,
          DaysToThreshold:     c.daysToThreshold,
          UploadVersion:       version,
        });
      }

      if (analysis.liabilityCount > 0) {
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              userId,
              fixType:       'consent_expired',
              description:   `List Intelligence: ${analysis.liabilityCount.toLocaleString()} contacts are below the consent strength threshold and represent ICO enforcement risk. Suppress or re-consent before sending.`,
              tool:          'List Intelligence',
              severity:      analysis.liabilityCount > analysis.totalContacts * 0.2 ? 'critical' : 'high',
              contactVolume: analysis.liabilityCount,
            }),
          });
        } catch(e) { console.error('Fix record non-fatal:', e); }
      }

      if (analysis.valueExpiring90 && analysis.valueExpiring90 >= 100) {
        const expiringContacts = (analysis.expiring30 || 0) + (analysis.expiring60 || 0) + (analysis.expiring90 || 0);
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              userId,
              fixType:        'commercial_loss',
              description:    `List Intelligence: approximately \u00a3${Math.round(analysis.valueExpiring90).toLocaleString('en-GB')} of estimated list value sits with ${expiringContacts.toLocaleString()} contacts whose consent is projected to expire within 90 days. A re-consent campaign now protects this value. Estimated business cost \u2014 not a regulatory fine.`,
              tool:           'List Intelligence',
              severity:       'medium',
              contactVolume:  expiringContacts,
              sourceRecordId: 'li-commercial',
              exposureLow:    Math.round(analysis.valueExpiring90 * 0.5),
              exposureHigh:   Math.round(analysis.valueExpiring90),
            }),
          });
        } catch(e) { console.error('Commercial fix non-fatal:', e); }
      }

      for (const c of analysis.liability.slice(0, 200)) {
        try {
          await atCreate('Suppression_Registry', {
            UserID:          userId,
            EmailHash:       hashEmail(c.email),
            SuppressionTier: 'Soft',
            DateAdded:       today,
            Source:          'List Intelligence \u2014 consent below threshold',
            Notes:           `ConsentStrength: ${c.consentStrength}. DaysToThreshold: ${c.daysToThreshold ?? 'already crossed'}.`,
          });
        } catch(e) { /* non-fatal */ }
      }

      const unrealisedTotal = opportunities.reduce((s, o) => s + o.currentValue, 0);
      const changes = buildListComparison(
        { assetValue: analysis.assetValue, liabilityCount: analysis.liabilityCount, activeCount: analysis.activeCount, totalContacts: analysis.totalContacts, expiring30: analysis.expiring30 },
        priorSnap
      );

      return res.status(200).json({
        success:          true,
        totalContacts:    analysis.totalContacts,
        duplicatesRemoved: analysis.duplicatesRemoved,
        activeCount:      analysis.activeCount,
        recoverableCount: analysis.recoverableCount,
        atRiskCount:      analysis.atRiskCount,
        liabilityCount:   analysis.liabilityCount,
        assetValue:       analysis.assetValue,
        icoStatus:        analysis.icoStatus,
        dataQualityFlags: analysis.dataQualityFlags,
        opportunities,
        unrealisedTotal:  parseFloat(unrealisedTotal.toFixed(2)),
        sector:           sectorVal,
        aov:              aovVal,
        asaNote:          analysis.asaNote || null,
        cmaNote:          analysis.cmaNote || null,
        consentExpiring:  { in30: analysis.expiring30, in60: analysis.expiring60, in90: analysis.expiring90, valueAtRisk: analysis.valueExpiring90 },
        changes,
      });
    }

    // ── certificate ─────────────────────────────────────────
    if (action === 'certificate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { segmentName, campaignType, linkedDossierId } = req.body;

      const checks = await atGet('List_Intelligence_Checks',
        `{UserID}='${userId}'`,
        'sort[0][field]=CheckDate&sort[0][direction]=desc', 1
      );
      if (!checks.length) return res.status(400).json({ error: 'No List Intelligence data found. Upload a list first.' });

      const latest = checks[0].fields;
      const today  = new Date().toISOString().split('T')[0];

      const liabilityPct = latest.TotalContacts > 0
        ? latest.LiabilityCount / latest.TotalContacts : 0;
      const result = liabilityPct < 0.05 && latest.ICOStatus === 'Good standing' ? 'Pass' : liabilityPct < 0.15 ? 'Review' : 'Fail';

      const cert = await atCreate('PreSend_Certificates', {
        UserID:              userId,
        CertificateDate:     today,
        SegmentName:         segmentName || 'Full list',
        CampaignType:        campaignType || null,
        ContactsChecked:     latest.TotalContacts,
        SuppressionMatches:  latest.LiabilityCount,
        ConsentFlags:        latest.LiabilityCount > 0
          ? `${latest.LiabilityCount} contacts below consent threshold`
          : 'None',
        DeliverabilityFlags: latest.DataQuality || 'None',
        Result:              result,
        LinkedDossierID:     linkedDossierId || null,
      });

      return res.status(200).json({
        success:         true,
        certificateId:   cert?.id,
        result,
        contactsChecked: latest.TotalContacts,
        consentFlags:    latest.LiabilityCount,
        date:            today,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('list-intelligence error:', err);
    return res.status(500).json({ error: err.message });
  }
}
