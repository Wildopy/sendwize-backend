// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-intelligence.js v1.8
//
// POST /api/list-intelligence?action=upload       — CSV analysis
// GET  /api/list-intelligence?action=load         — load latest or specific list
// GET  /api/list-intelligence?action=lists        — summary of every named list
// POST /api/list-intelligence?action=certificate  — pre-send clearance
// POST /api/list-intelligence?action=detect       — column detection (AI + fallback)
// POST /api/list-intelligence?action=draft-reconsent — AI re-consent email draft
// GET  /api/list-intelligence?action=list-exposure — per-list exposure for dashboard
//
// v1.8 changes from v1.7:
//   + Exposure calculation per regulator (ICO/ASA/CMA) on every upload
//   + Certificate lifecycle: ExpiresAt, Status (Current/Review Required/Expired)
//   + list-exposure action for dashboard aggregation
//   + Exposure comparison between uploads (£ delta + summary sentence)
//   + snapshotList stores exposure data
//   + buildListComparison includes exposure delta
//
// v1.7 preserved: draft-reconsent, AI column mapper, narrative, per-list fixes
// ─────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { atFetch } from './_airtable.js';
import { smartDetect, smartValidate } from './_smart-import.js';
import { validateListUpload, normaliseListRow } from './_normalise.js';


const APP_URL = 'https://sendwize-backend.vercel.app';
const BASE_ID = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;

const LEGACY_LIST_NAME = 'Main list';

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

function slugify(name) {
  return String(name || LEGACY_LIST_NAME)
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'main-list';
}

function normaliseListName(raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || LEGACY_LIST_NAME;
}

function listNameFormulaFragment(listName) {
  const target = String(listName).replace(/'/g, "\\'");
  if (listName === LEGACY_LIST_NAME) {
    return `OR({ListName}='${target}',{ListName}='')`;
  }
  return `{ListName}='${target}'`;
}

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
    method: 'POST', headers: atH(),
    body: JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) throw new Error(`AT POST ${table}: ${r.status} — ${await r.text()}`);
  return (await r.json()).records?.[0];
}

async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await atFetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH', headers: atH(),
    body: JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`AT PATCH ${table}: ${r.status}`);
  return await r.json();
}

function hashEmail(email) {
  return crypto.createHash('sha256').update((email || '').toLowerCase().trim()).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// EXPOSURE CONSTANTS — v1.8
// Anchored to published enforcement cases
// ─────────────────────────────────────────────────────────────

const EXPOSURE_ANCHORS = {
  ico: {
    perContactLiability: 0.28,   // HelloFresh £140k / ~500k contacts
    perContactAtRisk:    0.14,   // 50% — approaching but not yet below threshold
    label: 'ICO (PECR)',
    basis: 'Anchored to HelloFresh £140,000 (2024), scaled by contact volume',
  },
  asa: {
    roleBasedPerContact: 0.05,
    disposablePerContact: 0.02,
    label: 'ASA (CAP Code)',
    basis: 'Reputational exposure — ASA publishes rulings naming the brand',
  },
  cma: {
    dataQualityPerContact: 0.10,
    label: 'CMA (DMCCA 2024)',
    basis: 'Anchored to DMCCA 2024 enforcement range (£300k–10% turnover)',
  },
};

const DEFAULT_REVENUE_PER_CONTACT = 0.50;
const DEFAULT_RECONSENT_SUCCESS_RATE = 0.30;
const CERT_EXPIRY_DAYS = 90;

// ─────────────────────────────────────────────────────────────
// AI COLUMN MAPPER — v1.6 (unchanged)
// ─────────────────────────────────────────────────────────────

const AI_MAP_LIST_SYSTEM = `You are a CSV column classifier for a contact list analysis tool.

You will receive column headers and sample values from a contact list CSV export (typically from Klaviyo, Mailchimp, Dotdigital, HubSpot, or a CRM). Your job is to map each column to exactly one target field, or "ignore" if it doesn't fit any target.

TARGET FIELDS (use these exact strings):
- email              — email address
- date_added         — when the contact was added, joined, signed up, subscribed, or created
- last_engagement    — last activity date: last open, last click, last visit, last active
- last_purchase      — last purchase or order date
- engagement_type    — type of engagement: purchase, click, open, visit
- segment            — list name, segment, group, tag, audience
- status             — subscription status: subscribed, unsubscribed, active, bounced
- order_value        — order value, spend, LTV, revenue (monetary)
- engagement_count   — number of opens, clicks, sessions, orders (integer count)
- ignore             — names, IDs, phone numbers, addresses, or anything else

CRITICAL RULES:
1. Email columns contain @ signs. Map the first one found, ignore duplicates.
2. Date columns contain values like 2023-01-15, 15/01/2023, Jan 15 2023. Distinguish:
   - "created", "joined", "signed_up", "subscribed", "added" → date_added
   - "last_open", "last_click", "last_active", "last_engagement" → last_engagement
   - "last_purchase", "last_order", "last_buy" → last_purchase
   - If ambiguous and only one date column exists, prefer date_added.
3. Status columns have values like "subscribed", "active", "bounced", "unsubscribed".
4. Monetary columns (£, $, values like 65.00, 120.50) → order_value.
5. Integer count columns (opens: 12, clicks: 5) → engagement_count.
6. Each target can only be assigned once.
7. Names, phone numbers, addresses, company names → ignore.

Respond with ONLY a JSON object, no markdown, no explanation:
{
  "columns": [
    { "header": "email_address", "target": "email", "confidence": "high" },
    { "header": "created_at", "target": "date_added", "confidence": "high" }
  ]
}

confidence: "high" if obvious, "medium" if reasonable guess, "low" if uncertain.`;

async function aiMapListColumns(headers, sampleRows) {
  const sample = headers.map(h => {
    const vals = sampleRows.slice(0, 5).map(r => r[h]).filter(v => v !== null && v !== undefined && v !== '').slice(0, 3);
    return { header: h, samples: vals };
  });
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: AI_MAP_LIST_SYSTEM, messages: [{ role: 'user', content: `Map these CSV columns:\n${JSON.stringify(sample)}` }] }),
    });
    if (!res.ok) { console.error('AI list column mapper HTTP error:', res.status); return null; }
    const msg = await res.json();
    const raw = msg.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
  } catch (e) { console.error('AI list column mapper failed (falling back to deterministic):', e.message); return null; }
}

// ─────────────────────────────────────────────────────────────
// COLUMN AUTO-DETECTION (deterministic fallback) — unchanged
// ─────────────────────────────────────────────────────────────
function detectListColumns(headers, rows) {
  const sample = rows.slice(0, 30);
  const mapping = {};
  const dateRe  = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const h of headers) {
    const vals = sample.map(r => String(r[h] || '').trim()).filter(Boolean);
    const lc   = h.toLowerCase();
    if (vals.filter(v => emailRe.test(v)).length / Math.max(vals.length, 1) > 0.7) { mapping[h] = 'email'; continue; }
    if (vals.filter(v => dateRe.test(v)).length / Math.max(vals.length, 1) > 0.7) {
      if (lc.includes('join') || lc.includes('sign') || lc.includes('add') || lc.includes('creat') || lc.includes('subscri')) { mapping[h] = 'date_added'; }
      else if (lc.includes('engag') || lc.includes('open') || lc.includes('click') || lc.includes('activ') || lc.includes('last')) { mapping[h] = 'last_engagement'; }
      else if (lc.includes('purchas') || lc.includes('order') || lc.includes('buy')) { mapping[h] = 'last_purchase'; }
      else { mapping[h] = 'date_added'; }
      continue;
    }
    if (lc.includes('engag') || lc.includes('type') || lc.includes('action') || lc.includes('event')) { mapping[h] = 'engagement_type'; continue; }
    if (lc.includes('segment') || lc.includes('list') || lc.includes('group') || lc.includes('tag')) { mapping[h] = 'segment'; continue; }
    if (lc.includes('status') || lc.includes('state') || lc.includes('subscri')) { mapping[h] = 'status'; continue; }
    if (lc.includes('name') || lc.includes('first') || lc.includes('last')) { mapping[h] = 'ignore'; continue; }
    const nums = vals.map(v => parseFloat(v)).filter(n => !isNaN(n));
    if (nums.length / Math.max(vals.length, 1) > 0.8) {
      if (lc.includes('order') || lc.includes('purchas') || lc.includes('value') || lc.includes('spend') || lc.includes('ltv')) { mapping[h] = 'order_value'; continue; }
      if (lc.includes('count') || lc.includes('num') || lc.includes('open') || lc.includes('click')) { mapping[h] = 'engagement_count'; continue; }
    }
    mapping[h] = 'ignore';
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
  if (us) { const yr = us[3].length === 2 ? '20' + us[3] : us[3]; return `${yr}-${String(us[1]).padStart(2,'0')}-${String(us[2]).padStart(2,'0')}`; }
  return null;
}

const DISPOSABLE_DOMAINS = new Set(['mailinator.com','guerrillamail.com','10minutemail.com','throwam.com','yopmail.com','tempmail.com','fakeinbox.com','trashmail.com','sharklasers.com','guerrillamailblock.com','grr.la','guerrillamail.info','spam4.me','tempr.email','dispostable.com','mailnull.com']);
const ROLE_PREFIXES = new Set(['admin','info','support','help','contact','sales','marketing','noreply','no-reply','postmaster','webmaster','abuse','hello','office','team','billing','accounts','enquiries','enquiry','mail','email']);
const SPAM_TRAP_INDICATORS = ['spam','trap','test','fake','invalid','bounce'];
const TYPO_DOMAINS = {'gmai.com':'gmail.com','gmial.com':'gmail.com','gamil.com':'gmail.com','hotmial.com':'hotmail.com','hotmai.com':'hotmail.com','yahooo.com':'yahoo.com','yaho.com':'yahoo.com','outlok.com':'outlook.com','outloo.com':'outlook.com','livee.com':'live.com','iclod.com':'icloud.com'};
const SECTOR_BENCHMARKS = { ecommerce:{conversionRate:0.025,avgOrderMultiplier:1.0}, finance:{conversionRate:0.008,avgOrderMultiplier:4.0}, healthcare:{conversionRate:0.012,avgOrderMultiplier:2.5}, agency:{conversionRate:0.015,avgOrderMultiplier:3.0}, other:{conversionRate:0.018,avgOrderMultiplier:1.2} };

// ─────────────────────────────────────────────────────────────
// DIMENSIONS 1–4 + LIST ANALYSIS — unchanged from v1.6
// ─────────────────────────────────────────────────────────────
const CONSENT_DECAY_HALF_LIFE_DAYS = 365;
const CONSENT_THRESHOLD = 20;

function dimension1_consent(contact) {
  const now = new Date(); const added = contact.dateAdded ? new Date(contact.dateAdded) : now;
  const daysOld = Math.max(0, (now - added) / 86400000);
  const baseDecay = Math.pow(0.5, daysOld / CONSENT_DECAY_HALF_LIFE_DAYS);
  let engagementReset = 0;
  if (contact.lastEngagement) {
    const lastEng = new Date(contact.lastEngagement); const daysSinceEng = Math.max(0, (now - lastEng) / 86400000);
    const engType = (contact.engagementType || '').toLowerCase();
    let resetStrength = 0;
    if (engType.includes('purchas') || engType.includes('order') || engType.includes('buy')) resetStrength = 0.6;
    else if (engType.includes('click')) resetStrength = 0.4;
    else if (engType.includes('open')) resetStrength = 0.2;
    else resetStrength = 0.15;
    engagementReset = resetStrength * Math.pow(0.5, daysSinceEng / CONSENT_DECAY_HALF_LIFE_DAYS);
  }
  let disengagementPenalty = 0;
  if (contact.lastEngagement) { const dse = (new Date() - new Date(contact.lastEngagement)) / 86400000; if (dse > 180) disengagementPenalty = 0.15; if (dse > 365) disengagementPenalty = 0.30; }
  else if (daysOld > 180) { disengagementPenalty = 0.20; }
  const rawStrength = Math.min(1, baseDecay + engagementReset - disengagementPenalty);
  const consentStrength = Math.round(Math.max(0, rawStrength) * 100);
  const decayPerMonth = (1 - Math.pow(0.5, 30 / CONSENT_DECAY_HALF_LIFE_DAYS)) * 100;
  const consentDecayRate = parseFloat(decayPerMonth.toFixed(2));
  const currentFraction = rawStrength; const thresholdFraction = CONSENT_THRESHOLD / 100;
  let daysToThreshold = null;
  if (currentFraction > thresholdFraction) { daysToThreshold = Math.round(CONSENT_DECAY_HALF_LIFE_DAYS * Math.log(currentFraction / thresholdFraction) / Math.log(2)); }
  return { consentStrength, consentDecayRate, daysToThreshold };
}

function dimension2_deliverability(contact, domainCounts, totalContacts) {
  const email = (contact.email || '').toLowerCase().trim(); const parts = email.split('@');
  if (parts.length !== 2) return { deliverabilityScore: 0, primaryRisk: 'invalid_format' };
  const local = parts[0]; const domain = parts[1]; let score = 100; let primaryRisk = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { deliverabilityScore: 0, primaryRisk: 'invalid_format' };
  if (DISPOSABLE_DOMAINS.has(domain)) return { deliverabilityScore: 10, primaryRisk: 'disposable_domain' };
  if (SPAM_TRAP_INDICATORS.some(t => local.includes(t))) { score -= 50; primaryRisk = primaryRisk || 'spam_trap_indicator'; }
  if (TYPO_DOMAINS[domain]) { score -= 40; primaryRisk = primaryRisk || 'typo_domain'; }
  const localPrefix = local.split('+')[0].split('.')[0];
  if (ROLE_PREFIXES.has(localPrefix)) { score -= 25; primaryRisk = primaryRisk || 'role_based'; }
  if (/\d{1,4}$/.test(local) && parseInt(local.match(/\d+$/)[0]) < 100) { score -= 10; primaryRisk = primaryRisk || 'sequential_pattern'; }
  const domainPct = (domainCounts[domain] || 0) / Math.max(totalContacts, 1);
  if (domainPct > 0.4) { score -= 20; primaryRisk = primaryRisk || 'domain_concentration'; } else if (domainPct > 0.25) score -= 10;
  if (contact.lastEngagement) { const daysOld = (new Date() - new Date(contact.dateAdded || new Date())) / 86400000; const daysSinceEng = (new Date() - new Date(contact.lastEngagement)) / 86400000; const engRatio = daysOld > 0 ? Math.min(1, 1 - daysSinceEng / daysOld) : 0.5; if (engRatio > 0.7) score += 10; else if (engRatio < 0.2) score -= 15; } else score -= 10;
  return { deliverabilityScore: Math.max(0, Math.min(100, Math.round(score))), primaryRisk: primaryRisk || 'none' };
}

function dimension3_commercial(contact, sector, aov) {
  const benchmark = SECTOR_BENCHMARKS[sector] || SECTOR_BENCHMARKS.other;
  const baseValue = benchmark.conversionRate * (aov || 50) * benchmark.avgOrderMultiplier;
  let engMultiplier = 0.5;
  if (contact.lastEngagement) {
    const daysSinceEng = (new Date() - new Date(contact.lastEngagement)) / 86400000;
    const engType = (contact.engagementType || '').toLowerCase();
    if (engType.includes('purchas') || engType.includes('order')) engMultiplier = daysSinceEng < 90 ? 2.5 : daysSinceEng < 180 ? 1.8 : 1.2;
    else if (engType.includes('click')) engMultiplier = daysSinceEng < 90 ? 1.5 : daysSinceEng < 180 ? 1.1 : 0.8;
    else if (engType.includes('open')) engMultiplier = daysSinceEng < 90 ? 1.1 : daysSinceEng < 180 ? 0.9 : 0.6;
    else engMultiplier = daysSinceEng < 90 ? 0.9 : daysSinceEng < 365 ? 0.7 : 0.4;
  }
  const commercialValue = parseFloat((baseValue * engMultiplier).toFixed(2));
  const decayedMultiplier = engMultiplier * 0.85;
  const interventionValue = parseFloat((baseValue * (engMultiplier - decayedMultiplier)).toFixed(2));
  const direction = engMultiplier > 1.0 ? 'growing' : engMultiplier > 0.7 ? 'stable' : 'declining';
  return { commercialValue, interventionValue, direction };
}

function dimension4_risk(consentResult) {
  const { consentStrength, consentDecayRate, daysToThreshold } = consentResult;
  const thresholdProximity = Math.max(0, 1 - (consentStrength - CONSENT_THRESHOLD) / 80);
  const riskAcceleration = parseFloat((consentDecayRate * (1 + thresholdProximity)).toFixed(3));
  return { riskAcceleration, daysToThreshold };
}

function prioritisationScore(consent, commercial, risk, deliverability, maxCommercial) {
  const cScore = consent.consentStrength / 100;
  const comScore = maxCommercial > 0 ? commercial.commercialValue / maxCommercial : 0;
  const rScore = risk.daysToThreshold !== null ? Math.min(1, risk.daysToThreshold / 365) : 1;
  const dScore = deliverability.deliverabilityScore / 100;
  return parseFloat((cScore * 0.35 + comScore * 0.30 + rScore * 0.25 + dScore * 0.10).toFixed(4));
}

function analyseList(contacts, sector, aov) {
  const domainCounts = {}; const emails = new Set(); let duplicates = 0;
  for (const c of contacts) { const email = (c.email || '').toLowerCase().trim(); if (emails.has(email)) { duplicates++; continue; } emails.add(email); const domain = email.split('@')[1] || ''; domainCounts[domain] = (domainCounts[domain] || 0) + 1; }
  const seen = new Set(); const unique = contacts.filter(c => { const email = (c.email || '').toLowerCase().trim(); if (seen.has(email)) return false; seen.add(email); return true; });
  const analysed = unique.map(c => { const d1 = dimension1_consent(c); const d2 = dimension2_deliverability(c, domainCounts, unique.length); const d3 = dimension3_commercial(c, sector, aov); const d4 = dimension4_risk(d1); return { ...c, ...d1, ...d2, ...d3, ...d4 }; });
  const maxCommercial = Math.max(...analysed.map(c => c.commercialValue), 1);
  const scored = analysed.map(c => ({ ...c, priorityScore: prioritisationScore({ consentStrength: c.consentStrength }, { commercialValue: c.commercialValue }, { daysToThreshold: c.daysToThreshold }, { deliverabilityScore: c.deliverabilityScore }, maxCommercial) }));
  const active = scored.filter(c => c.consentStrength >= 60 && c.deliverabilityScore >= 60);
  const recoverable = scored.filter(c => c.consentStrength >= CONSENT_THRESHOLD && c.consentStrength < 60 && c.deliverabilityScore >= 40);
  const atRisk = scored.filter(c => c.consentStrength >= CONSENT_THRESHOLD && c.deliverabilityScore < 40);
  const liability = scored.filter(c => c.consentStrength < CONSENT_THRESHOLD);
  const assetValue = parseFloat([...active, ...recoverable].reduce((s, c) => s + c.commercialValue, 0).toFixed(2));
  const aboveThreshold = scored.filter(c => c.daysToThreshold !== null);
  const expiring30 = aboveThreshold.filter(c => c.daysToThreshold <= 30).length;
  const expiring60 = aboveThreshold.filter(c => c.daysToThreshold > 30 && c.daysToThreshold <= 60).length;
  const expiring90 = aboveThreshold.filter(c => c.daysToThreshold > 60 && c.daysToThreshold <= 90).length;
  const valueExpiring90 = parseFloat(aboveThreshold.filter(c => c.daysToThreshold <= 90).reduce((s, c) => s + c.commercialValue, 0).toFixed(2));
  const liabilityPct = unique.length > 0 ? liability.length / unique.length : 0;
  let icoStatus = 'Good standing';
  if (liabilityPct > 0.3) icoStatus = 'High risk \u2014 significant portion below consent threshold';
  else if (liabilityPct > 0.1) icoStatus = 'Review recommended \u2014 contacts approaching threshold';
  const roleBasedCount = scored.filter(c => c.primaryRisk === 'role_based').length;
  const disposableCount = scored.filter(c => c.primaryRisk === 'disposable_domain').length;
  const domainConc = Object.values(domainCounts).some(n => n / unique.length > 0.4);
  const asaSignals = [];
  if (roleBasedCount > 0) asaSignals.push(`${roleBasedCount} role-based address${roleBasedCount !== 1 ? 'es' : ''} (e.g. info@, admin@) — promotional email to these may not reach a named individual.`);
  if (disposableCount > 0) asaSignals.push(`${disposableCount} disposable domain${disposableCount !== 1 ? 's' : ''} — unlikely to reach a real individual.`);
  if (liabilityPct > 0.1) asaSignals.push(`${liability.length} contacts (${Math.round(liabilityPct * 100)}%) below consent threshold.`);
  const asaNote = asaSignals.length ? 'ASA signals: ' + asaSignals.join(' ') : null;
  const cmaSignals = [];
  if (liabilityPct > 0.15) cmaSignals.push(`${liability.length} contacts below consent threshold.`);
  if (domainConc) cmaSignals.push('Domain concentration detected — over 40% from one domain.');
  const spamCount = scored.filter(c => c.primaryRisk === 'spam_trap_indicator').length;
  if (spamCount > 0) cmaSignals.push(`${spamCount} spam trap indicator${spamCount !== 1 ? 's' : ''}.`);
  const cmaNote = cmaSignals.length ? 'CMA signals: ' + cmaSignals.join(' ') : null;
  const invalidFormat = scored.filter(c => c.primaryRisk === 'invalid_format').length;
  const roleBased = scored.filter(c => c.primaryRisk === 'role_based').length;
  const typos = scored.filter(c => c.primaryRisk === 'typo_domain').length;
  const spamTraps = scored.filter(c => c.primaryRisk === 'spam_trap_indicator').length;
  const concentrated = Object.values(domainCounts).filter(n => n / unique.length > 0.4).length > 0;
  const dataQualityFlags = [];
  if (invalidFormat > 0) dataQualityFlags.push(`${invalidFormat} invalid email format${invalidFormat !== 1 ? 's' : ''}`);
  if (disposableCount > 0) dataQualityFlags.push(`${disposableCount} disposable domain${disposableCount !== 1 ? 's' : ''}`);
  if (roleBased > 0) dataQualityFlags.push(`${roleBased} role-based address${roleBased !== 1 ? 'es' : ''}`);
  if (typos > 0) dataQualityFlags.push(`${typos} likely typo domain${typos !== 1 ? 's' : ''}`);
  if (spamTraps > 0) dataQualityFlags.push(`${spamTraps} spam trap indicator${spamTraps !== 1 ? 's' : ''}`);
  if (duplicates > 0) dataQualityFlags.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''} removed`);
  if (concentrated) dataQualityFlags.push('Domain concentration risk \u2014 over 40% from one domain');
  return { totalContacts: unique.length, duplicatesRemoved: duplicates, activeCount: active.length, recoverableCount: recoverable.length, atRiskCount: atRisk.length, liabilityCount: liability.length, liabilityPct: parseFloat(liabilityPct.toFixed(4)), assetValue, icoStatus, asaNote, cmaNote, dataQualityFlags, expiring30, expiring60, expiring90, valueExpiring90, scored, active, recoverable, atRisk, liability, activeIndices: active.map(c => c.originalIndex), recoverableIndices: recoverable.map(c => c.originalIndex), atRiskIndices: atRisk.map(c => c.originalIndex), liabilityIndices: liability.map(c => c.originalIndex) };
}

function generateOpportunities(analysis) {
  const opps = []; const { recoverable, active, scored } = analysis;
  if (recoverable.length > 0) { const totalValue = recoverable.reduce((s, c) => s + c.interventionValue, 0); opps.push({ type: 'Re-engagement campaign', description: `${recoverable.length.toLocaleString()} contacts have declining consent but are still above the ICO threshold.`, estimatedValue: parseFloat(totalValue.toFixed(2)), currentValue: parseFloat(totalValue.toFixed(2)), decayRate: 2.5, recommendedAction: 'Send a preference-update or re-consent email to this segment within the next 30 days.', templateAvailable: false }); }
  if (analysis.liabilityCount > 0) { opps.push({ type: 'Suppression \u2014 liability contacts', description: `${analysis.liabilityCount.toLocaleString()} contacts below consent threshold. Suppress immediately.`, estimatedValue: 0, currentValue: 0, decayRate: 0, recommendedAction: 'Add these contacts to your suppression registry. Do not send marketing until re-consent is obtained.', templateAvailable: false }); }
  const approachingRisk = active.filter(c => c.daysToThreshold !== null && c.daysToThreshold < 90);
  if (approachingRisk.length > 0) { const totalValue = approachingRisk.reduce((s, c) => s + c.commercialValue, 0); opps.push({ type: 'Priority send window', description: `${approachingRisk.length.toLocaleString()} high-value contacts with < 90 days before consent drops.`, estimatedValue: parseFloat(totalValue.toFixed(2)), currentValue: parseFloat(totalValue.toFixed(2)), decayRate: 3.0, recommendedAction: 'Run a promotional campaign to this segment within 30 days.', templateAvailable: false }); }
  const poorDeliverability = scored.filter(c => c.deliverabilityScore < 40 && c.consentStrength >= CONSENT_THRESHOLD);
  if (poorDeliverability.length > 10) { opps.push({ type: 'Deliverability clean', description: `${poorDeliverability.length.toLocaleString()} contacts with poor deliverability signals.`, estimatedValue: 0, currentValue: 0, decayRate: 0, recommendedAction: 'Remove or quarantine these addresses before your next send.', templateAvailable: false }); }
  return opps;
}

// ─────────────────────────────────────────────────────────────
// EXPOSURE CALCULATION — v1.8
// ─────────────────────────────────────────────────────────────

function calculateListExposure(analysis) {
  const { totalContacts, activeCount, recoverableCount, atRiskCount, liabilityCount, asaNote, cmaNote, scored } = analysis;

  // ICO
  const icoExposure = {
    liabilityContacts: liabilityCount,
    atRiskContacts: atRiskCount,
    expiring30: analysis.expiring30, expiring60: analysis.expiring60, expiring90: analysis.expiring90,
    estimatedExposure: parseFloat((liabilityCount * EXPOSURE_ANCHORS.ico.perContactLiability + atRiskCount * EXPOSURE_ANCHORS.ico.perContactAtRisk).toFixed(2)),
    label: EXPOSURE_ANCHORS.ico.label, basis: EXPOSURE_ANCHORS.ico.basis,
  };

  // ASA
  const roleBasedCount = (scored || []).filter(c => c.primaryRisk === 'role_based').length;
  const disposableCount = (scored || []).filter(c => c.primaryRisk === 'disposable_domain').length;
  const asaExposure = {
    roleBasedContacts: roleBasedCount, disposableContacts: disposableCount,
    estimatedExposure: parseFloat((roleBasedCount * EXPOSURE_ANCHORS.asa.roleBasedPerContact + disposableCount * EXPOSURE_ANCHORS.asa.disposablePerContact).toFixed(2)),
    label: EXPOSURE_ANCHORS.asa.label, basis: EXPOSURE_ANCHORS.asa.basis, signals: asaNote || null,
  };

  // CMA
  const spamTrapCount = (scored || []).filter(c => c.primaryRisk === 'spam_trap_indicator').length;
  const typoCount = (scored || []).filter(c => c.primaryRisk === 'typo_domain').length;
  const cmaContactCount = spamTrapCount + typoCount;
  const cmaExposure = {
    affectedContacts: cmaContactCount,
    estimatedExposure: parseFloat((cmaContactCount * EXPOSURE_ANCHORS.cma.dataQualityPerContact).toFixed(2)),
    label: EXPOSURE_ANCHORS.cma.label, basis: EXPOSURE_ANCHORS.cma.basis, signals: cmaNote || null,
  };

  const estimatedValue = parseFloat(((activeCount + recoverableCount) * DEFAULT_REVENUE_PER_CONTACT).toFixed(2));
  const recoverableValue = parseFloat((recoverableCount * DEFAULT_REVENUE_PER_CONTACT * DEFAULT_RECONSENT_SUCCESS_RATE).toFixed(2));
  const totalExposure = parseFloat((icoExposure.estimatedExposure + asaExposure.estimatedExposure + cmaExposure.estimatedExposure).toFixed(2));

  return { totalExposure, estimatedValue, recoverableValue, ico: icoExposure, asa: asaExposure, cma: cmaExposure, methodology: 'Indicative estimates based on published UK enforcement benchmarks. Not a prediction of regulatory outcome.' };
}

function buildExposureComparison(currentExposure, previousExposure) {
  if (!previousExposure) return null;
  const totalDelta = parseFloat((currentExposure.totalExposure - (previousExposure.totalExposure || 0)).toFixed(2));
  const valueDelta = parseFloat((currentExposure.estimatedValue - (previousExposure.estimatedValue || 0)).toFixed(2));
  const direction = totalDelta > 5 ? 'increased' : totalDelta < -5 ? 'decreased' : 'stable';
  const parts = [];
  if (direction === 'increased') {
    parts.push(`Estimated exposure increased £${Math.abs(totalDelta).toFixed(0)}`);
    const newLiability = currentExposure.ico.liabilityContacts - (previousExposure.ico?.liabilityContacts || 0);
    if (newLiability > 0) parts.push(`${newLiability} additional contact${newLiability !== 1 ? 's' : ''} crossed the consent threshold`);
  } else if (direction === 'decreased') {
    parts.push(`Estimated exposure decreased £${Math.abs(totalDelta).toFixed(0)}`);
  } else {
    parts.push('Exposure broadly unchanged');
  }
  if (valueDelta < -10) parts.push(`Estimated commercial value decreased £${Math.abs(valueDelta).toFixed(0)}`);
  else if (valueDelta > 10) parts.push(`Estimated commercial value increased £${valueDelta.toFixed(0)}`);
  return { direction, totalDelta, valueDelta, summary: parts.join('. ') + '.' };
}

// ─────────────────────────────────────────────────────────────
// FIX EMISSION + SNAPSHOTS + COMPARISON + LISTS SUMMARY
// v1.8: snapshotList and buildListComparison updated
// ─────────────────────────────────────────────────────────────
function liabilitySourceId(listName) { return `li-liability:${slugify(listName)}`; }
function commercialLossSourceId(listName) { return `li-commercial:${slugify(listName)}`; }

async function findPendingLIFix(userId, fixType, sourceRecordId) {
  const formula = `AND({UserID}="${userId}",{FixType}="${fixType}",{Tool}="List Intelligence",{SourceRecordID}="${sourceRecordId}",{Status}="Pending")`;
  try { const records = await atGet('Compliance_Fixes', formula, '', 1); return records[0] || null; } catch (e) { console.error('findPendingLIFix error (non-fatal):', e); return null; }
}

async function markLIFixImproved(fixId, previousDescription, newStateSummary) {
  try { const hint = { previousState: previousDescription || '', newState: newStateSummary, detectedAt: new Date().toISOString(), source: 'list-intelligence' }; await atPatch('Compliance_Fixes', fixId, { ImprovedOnRerun: JSON.stringify(hint) }); } catch (e) { console.error('markLIFixImproved error (non-fatal):', e); }
}

async function refreshLIFix(fixId, description, exposureLow, exposureHigh) {
  try { const fields = { Description: description, ImprovedOnRerun: '' }; if (exposureLow != null) fields.ExposureLow = exposureLow; if (exposureHigh != null) fields.ExposureHigh = exposureHigh; await atPatch('Compliance_Fixes', fixId, fields); } catch (e) { console.error('refreshLIFix error (non-fatal):', e); }
}

async function emitLIFix(userId, listName, spec) {
  const existing = await findPendingLIFix(userId, spec.fixType, spec.sourceRecordId);
  if (!spec.presentNow) { if (existing) { await markLIFixImproved(existing.id, existing.fields?.Description || '', spec.resolvedSummary || `Finding resolved on rerun for "${listName}" (${new Date().toISOString().split('T')[0]}).`); } return; }
  if (existing) { await refreshLIFix(existing.id, spec.description, spec.exposureLow ?? null, spec.exposureHigh ?? null); return; }
  try { const broadFormula = `AND({UserID}="${userId}",{FixType}="${spec.fixType}",{Tool}="List Intelligence",{Status}="Pending",FIND("${slugify(listName)}",{SourceRecordID}))`; const others = await atGet('Compliance_Fixes', broadFormula, '', 3); if (others.length > 0) { console.warn(`[list-intelligence] SUSPECTED DEDUPE MISS for ${spec.fixType} list="${listName}"`); } } catch (e) { console.error('emitLIFix dedupe-miss check failed (non-fatal):', e); }
  try { const body = { userId, fixType: spec.fixType, description: spec.description, tool: 'List Intelligence', severity: spec.severity, sourceRecordId: spec.sourceRecordId }; if (spec.contactVolume != null) body.contactVolume = spec.contactVolume; if (spec.exposureLow != null) body.exposureLow = spec.exposureLow; if (spec.exposureHigh != null) body.exposureHigh = spec.exposureHigh; await fetch(`${APP_URL}/api/generate-fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { console.error(`emitLIFix create ${spec.fixType} non-fatal:`, e); }
}

// v1.8: accepts optional exposure parameter
async function snapshotList(userId, listName, analysis, exposure) {
  await atCreate('List_Intelligence_Snapshots', {
    UserID: userId, ListName: listName,
    SnapshotDate: new Date().toISOString().slice(0, 10),
    SnapshotTimestamp: new Date().toISOString(),
    TotalContacts: analysis.totalContacts, ActiveCount: analysis.activeCount,
    RecoverableCount: analysis.recoverableCount, AtRiskCount: analysis.atRiskCount,
    LiabilityCount: analysis.liabilityCount, LiabilityPct: analysis.liabilityPct,
    AssetValue: analysis.assetValue,
    Expiring30: analysis.expiring30, Expiring60: analysis.expiring60, Expiring90: analysis.expiring90,
    EstimatedExposure: exposure?.totalExposure || null,
    ExposureJson: exposure ? JSON.stringify(exposure) : null,
  });
}

async function getListSnapshots(userId, listName, max = 12) {
  const formula = `AND({UserID}='${userId}',${listNameFormulaFragment(listName)})`;
  const records = await atGet('List_Intelligence_Snapshots', formula, 'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc', max);
  return records.map(r => ({
    date: r.fields.SnapshotDate, timestamp: r.fields.SnapshotTimestamp || r.fields.SnapshotDate,
    totalContacts: r.fields.TotalContacts || 0, activeCount: r.fields.ActiveCount || 0,
    recoverableCount: r.fields.RecoverableCount || 0, atRiskCount: r.fields.AtRiskCount || 0,
    liabilityCount: r.fields.LiabilityCount || 0, liabilityPct: r.fields.LiabilityPct != null ? r.fields.LiabilityPct : 0,
    assetValue: r.fields.AssetValue != null ? r.fields.AssetValue : 0,
    expiring30: r.fields.Expiring30 || 0, expiring60: r.fields.Expiring60 || 0, expiring90: r.fields.Expiring90 || 0,
    estimatedExposure: r.fields.EstimatedExposure || null,
    _exposureJson: r.fields.ExposureJson || null,
  }));
}

function daysBetween(aIso, bIso) { if (!aIso || !bIso) return null; const a = new Date(aIso), b = new Date(bIso); if (isNaN(a) || isNaN(b)) return null; return Math.abs(Math.round((a - b) / 86400000)); }

// v1.8: includes exposureDelta and exposureSummary
function buildListComparison(cur, prev) {
  if (!prev) return null;
  const valueDelta = parseFloat((cur.assetValue - prev.assetValue).toFixed(2));
  const liabilityDelta = cur.liabilityCount - prev.liabilityCount;
  const activeDelta = cur.activeCount - prev.activeCount;
  const totalDelta = cur.totalContacts - prev.totalContacts;
  const expiring30Delta = cur.expiring30 - prev.expiring30;
  let direction = 'same';
  if (valueDelta > 0 || liabilityDelta < 0 || activeDelta > 0) direction = 'improved';
  if (liabilityDelta > 0 || valueDelta < 0) direction = liabilityDelta > Math.abs(activeDelta) ? 'worsened' : direction;
  if (valueDelta < 0 && liabilityDelta > 0) direction = 'worsened';

  const curExposure = cur.estimatedExposure || 0;
  const prevExposure = prev.estimatedExposure || 0;
  const exposureDelta = parseFloat((curExposure - prevExposure).toFixed(2));

  const parts = [];
  if (liabilityDelta > 0) parts.push(`${liabilityDelta} more contact${liabilityDelta !== 1 ? 's' : ''} crossed the consent threshold`);
  if (liabilityDelta < 0) parts.push(`${Math.abs(liabilityDelta)} contact${Math.abs(liabilityDelta) !== 1 ? 's' : ''} moved back above the consent threshold`);
  if (exposureDelta > 5) parts.push(`Estimated exposure increased £${Math.abs(exposureDelta).toFixed(0)}`);
  if (exposureDelta < -5) parts.push(`Estimated exposure decreased £${Math.abs(exposureDelta).toFixed(0)}`);
  const exposureSummary = parts.length ? parts.join('. ') + '.' : null;

  return {
    direction, daysSincePrevious: daysBetween(new Date().toISOString(), prev.timestamp),
    valueDelta, liabilityDelta, activeDelta, totalDelta, expiring30Delta,
    exposureDelta, exposureSummary,
    previous: { assetValue: prev.assetValue, liabilityCount: prev.liabilityCount, activeCount: prev.activeCount, totalContacts: prev.totalContacts, expiring30: prev.expiring30, date: prev.date, estimatedExposure: prevExposure }
  };
}

async function getListsSummary(userId) {
  const records = await atGet('List_Intelligence_Checks', `{UserID}='${userId}'`, 'sort[0][field]=CheckDate&sort[0][direction]=desc', 500);
  const byList = new Map();
  for (const r of records) { const rawName = r.fields.ListName; const listName = rawName && String(rawName).trim() ? String(rawName).trim() : LEGACY_LIST_NAME; if (byList.has(listName)) continue; byList.set(listName, r.fields); }
  const now = new Date().toISOString().slice(0, 10); const out = [];
  for (const [listName, f] of byList.entries()) { const days = daysBetween(now, f.CheckDate); const liability = f.LiabilityCount || 0; const stale = days != null && days >= 14; out.push({ listName, checkDate: f.CheckDate, daysSinceLastCheck: days, totalContacts: f.TotalContacts || 0, assetValue: f.AssetValue || 0, liabilityCount: liability, icoStatus: f.ICOStatus || 'Good standing', sector: f.Sector || null, estimatedExposure: f.EstimatedExposure || null, needsAttention: liability > 0 || stale, needsAttentionReasons: [...(liability > 0 ? [`${liability} contact${liability !== 1 ? 's' : ''} below consent threshold`] : []), ...(stale ? [`No check in ${days} days`] : [])] }); }
  out.sort((a, b) => { if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1; return (b.checkDate || '').localeCompare(a.checkDate || ''); });
  return out;
}

// ─────────────────────────────────────────────────────────────
// AI NARRATIVE — unchanged from v1.6
// ─────────────────────────────────────────────────────────────
const LIST_NARRATIVE_SYSTEM = `You are a UK email marketing analyst writing for marketing managers who don't think in compliance terms. You receive list valuation and compliance data and write ONE short paragraph (3-5 sentences) explaining what the numbers mean. Be specific, cite actual numbers, be actionable. Never say "compliant" or "in breach". Not legal advice.`;

async function generateListNarrative(listName, analysis, changes) {
  const context = { listName, totalContacts: analysis.totalContacts, activeCount: analysis.activeCount, recoverableCount: analysis.recoverableCount, atRiskCount: analysis.atRiskCount, liabilityCount: analysis.liabilityCount, assetValue: analysis.assetValue, icoStatus: analysis.icoStatus, expiring30: analysis.expiring30, expiring60: analysis.expiring60, expiring90: analysis.expiring90, valueExpiring90: analysis.valueExpiring90, dataQualityFlags: analysis.dataQualityFlags, changes: changes ? { direction: changes.direction, valueDelta: changes.valueDelta, liabilityDelta: changes.liabilityDelta, activeDelta: changes.activeDelta, daysSincePrevious: changes.daysSincePrevious } : null };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system: LIST_NARRATIVE_SYSTEM, messages: [{ role: 'user', content: `Explain this list's state:\n${JSON.stringify(context)}` }] }) });
    if (!res.ok) return null;
    const msg = await res.json(); return msg.content?.[0]?.text?.trim() || null;
  } catch (e) { console.error('List narrative failed (non-fatal):', e.message); return null; }
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER — v1.8
// ─────────────────────────────────────────────────────────────

// ── Performance layer: list composition, freshness, engagement gaps ──
function analyseDomainComposition(emails) {
  const FREE_DOMAINS=new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','hotmail.com','hotmail.co.uk','outlook.com','live.com','live.co.uk','msn.com','aol.com','aol.co.uk','icloud.com','me.com','mac.com','protonmail.com','proton.me','zoho.com','mail.com','gmx.com','gmx.co.uk','ymail.com','rocketmail.com']);
  const ISP_DOMAINS=new Set(['btinternet.com','bt.com','sky.com','virginmedia.com','virgin.net','talktalk.net','plusnet.com','zen.co.uk','ee.co.uk','o2.co.uk']);
  const EDU_PATTERNS=['.ac.uk','.edu','.edu.uk','.sch.uk'], GOV_PATTERNS=['.gov.uk','.gov','.nhs.uk','.nhs.net','.police.uk'];
  const counts={free:0,corporate:0,isp:0,educational:0,government:0,other:0},domainCounts={},total=emails.length;
  for(const email of emails){const domain=(email.split('@')[1]||'').toLowerCase().trim();if(!domain)continue;domainCounts[domain]=(domainCounts[domain]||0)+1;if(FREE_DOMAINS.has(domain))counts.free++;else if(ISP_DOMAINS.has(domain))counts.isp++;else if(EDU_PATTERNS.some(p=>domain.endsWith(p)))counts.educational++;else if(GOV_PATTERNS.some(p=>domain.endsWith(p)))counts.government++;else counts.corporate++;}
  const topDomains=Object.entries(domainCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([domain,count])=>({domain,count,pct:Math.round(count/total*100)}));
  const composition={};for(const [cat,count] of Object.entries(counts))if(count>0)composition[cat]={count,pct:Math.round(count/total*100)};
  const corpPct=composition.corporate?.pct||0,freePct=composition.free?.pct||0;let insight='';if(corpPct>=60)insight='Strong corporate domain mix — suggests a B2B or professional audience with higher conversion potential.';else if(corpPct>=30)insight='Mixed audience — '+corpPct+'% corporate, '+freePct+'% free email. Typical for ecommerce with a B2B segment.';else if(freePct>=70)insight='Consumer-dominant list — '+freePct+'% free email providers. Typical for B2C ecommerce and newsletter audiences.';else insight='Varied domain mix across free, corporate, and ISP addresses.';
  return {composition,topDomains,insight,totalAnalysed:total};
}
function analyseListFreshness(contacts){
  const now=new Date(),buckets={under30:{label:'Last 30 days',count:0},under90:{label:'1-3 months',count:0},under180:{label:'3-6 months',count:0},under365:{label:'6-12 months',count:0},under730:{label:'1-2 years',count:0},over730:{label:'2+ years',count:0}};let total=0,totalDays=0,oldest=null,newest=null;
  for(const c of contacts){const d=c.dateAdded?new Date(c.dateAdded):null;if(!d||isNaN(d.getTime()))continue;const days=Math.floor((now-d)/86400000);total++;totalDays+=days;if(!oldest||d<oldest)oldest=d;if(!newest||d>newest)newest=d;if(days<=30)buckets.under30.count++;else if(days<=90)buckets.under90.count++;else if(days<=180)buckets.under180.count++;else if(days<=365)buckets.under365.count++;else if(days<=730)buckets.under730.count++;else buckets.over730.count++;}
  if(!total)return null;const avgAgeDays=Math.round(totalDays/total),distribution={};for(const [key,b] of Object.entries(buckets))if(b.count>0)distribution[key]={label:b.label,count:b.count,pct:Math.round(b.count/total*100)};const stale=(buckets.under730.count+buckets.over730.count)/total;let verdict,freshState;if(stale>=0.6){verdict='Your list is aging — '+Math.round(stale*100)+'% of contacts were added over a year ago. Consent strength decays with time.';freshState='stale';}else if(stale>=0.3){verdict='Mixed freshness — you have recent additions alongside older contacts. The older segment needs monitoring.';freshState='mixed';}else{verdict='Healthy list freshness — most contacts were added within the last year.';freshState='fresh';}
  return {distribution,avgAgeDays,oldest:oldest?.toISOString().slice(0,10),newest:newest?.toISOString().slice(0,10),verdict,freshState,totalAnalysed:total};
}
function analyseEngagementGaps(contacts){
  const now=new Date(),gaps=[];let neverEngaged=0,total=0;for(const c of contacts){const added=c.dateAdded?new Date(c.dateAdded):null,engaged=c.lastEngagement?new Date(c.lastEngagement):null;if(!added||isNaN(added.getTime()))continue;total++;if(!engaged||isNaN(engaged.getTime())){neverEngaged++;continue;}const gapDays=Math.floor((now-engaged)/86400000),ageDays=Math.floor((now-added)/86400000);gaps.push({gapDays,ageDays,ratio:ageDays>0?gapDays/ageDays:0});}
  if(!total)return null;const segments={gold:{label:'Gold — recent engagement',count:0,desc:'Added 6+ months ago, engaged in last 30 days'},active:{label:'Active — regular engagement',count:0,desc:'Engaged in last 90 days'},cooling:{label:'Cooling — engagement declining',count:0,desc:'Engaged 90-180 days ago'},dormant:{label:'Dormant — long gap',count:0,desc:'Last engagement over 180 days ago'},neverEngaged:{label:'Never engaged',count:neverEngaged,desc:'No engagement recorded since signup'}};
  for(const g of gaps){if(g.ageDays>=180&&g.gapDays<=30)segments.gold.count++;else if(g.gapDays<=90)segments.active.count++;else if(g.gapDays<=180)segments.cooling.count++;else segments.dormant.count++;}
  const result={};for(const [key,seg] of Object.entries(segments))if(seg.count>0)result[key]={label:seg.label,desc:seg.desc,count:seg.count,pct:Math.round(seg.count/total*100)};const goldPct=segments.gold.count/total,dormantPct=(segments.dormant.count+neverEngaged)/total;let insight;if(goldPct>=0.2)insight='Strong engagement — '+Math.round(goldPct*100)+'% of your list are long-term contacts who engaged recently. These are your most valuable contacts.';else if(dormantPct>=0.4)insight='Engagement gap risk — '+Math.round(dormantPct*100)+'% of your list is dormant or has never engaged. This segment dilutes your metrics and increases deliverability risk.';else insight='Mixed engagement patterns across your list. Focus re-engagement efforts on the cooling and dormant segments.';
  return {segments:result,neverEngagedPct:Math.round(neverEngaged/total*100),insight,totalAnalysed:total};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {

    // ── DETECT — AI + fallback column detection ─────────────
    if (action === 'detect') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { headers, rows } = req.body;
      if (!headers || !Array.isArray(headers)) return res.status(400).json({ error: 'headers required' });

      const sampleRows = (rows || []).slice(0, 30);
      let mapping = null;
      let method = 'deterministic';
      let detection = null;

      // Try AI first
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const aiResult = await aiMapListColumns(headers, sampleRows);
          if (aiResult?.columns && Array.isArray(aiResult.columns)) {
            mapping = {};
            for (const col of aiResult.columns) {
              if (col.header && col.target) mapping[col.header] = col.target;
            }
            method = 'ai';

            // Validate AI result — fix count/rate confusion
            const validated = smartValidate(mapping, headers, sampleRows, 'list');
            mapping = validated.mapping;

            // Build detection-like structure from AI result
            const recognized = [];
            const ignored = [];
            for (const h of headers) {
              if (mapping[h] && mapping[h] !== '' && mapping[h] !== 'ignore') {
                recognized.push({ header: h, field: mapping[h], friendlyName: mapping[h].replace(/_/g, ' '), confidence: 'high' });
              } else {
                ignored.push(h);
                if (!(h in mapping)) mapping[h] = 'ignore';
              }
            }
            detection = {
              recognized, ignored, ambiguous: [], corrections: validated.corrections || [],
              summary: {
                recognizedCount: recognized.length,
                ignoredCount: ignored.length,
                canAnalyse: Object.values(mapping).includes('email'),
                hasEmail: Object.values(mapping).includes('email'),
                hasDate: Object.values(mapping).includes('date_added') || Object.values(mapping).includes('last_engagement'),
              },
            };
          }
        } catch (e) { /* AI failed — fall through to deterministic */ }
      }

      // Fallback: smart deterministic detection
      if (!mapping) {
        detection = smartDetect(headers, sampleRows, 'list');
        mapping = detection.mapping;
        method = 'deterministic';
      }

      return res.json({
        success: true,
        mapping,
        method,
        recognized: detection.recognized,
        ignored: detection.ignored,
        ambiguous: detection.ambiguous || [],
        corrections: detection.corrections || [],
        summary: detection.summary,
      });
    }

    // ── LISTS — summary of all named lists ──────────────────
    if (action === 'lists') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
      const lists = await getListsSummary(userId);
      return res.json({ success: true, lists });
    }

    // ── LOAD — load latest (or specific) list check ─────────
    if (action === 'load') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
      const listName = normaliseListName(req.query.listName || LEGACY_LIST_NAME);
      const formula  = `AND({UserID}='${userId}',${listNameFormulaFragment(listName)})`;
      const records  = await atGet('List_Intelligence_Checks', formula, 'sort[0][field]=CheckDate&sort[0][direction]=desc', 1);
      if (!records.length) return res.json({ success: true, found: false, listName });
      const r = records[0];
      let results = null;
      try { results = r.fields.Results ? JSON.parse(r.fields.Results) : null; } catch(e) {}
      const snapshots = await getListSnapshots(userId, listName, 12);
      const changes   = snapshots.length >= 2 ? buildListComparison(snapshots[0], snapshots[1]) : null;

      let exposure = null;
      try { exposure = r.fields.ExposureJson ? JSON.parse(r.fields.ExposureJson) : null; } catch(e) {}

      let certificateStatus = null;
      try {
        const certRecords = await atGet('List_Intelligence_Certificates', `AND({UserID}='${userId}',{ListName}='${listName.replace(/'/g, "\\'")}')`, 'sort[0][field]=IssuedDate&sort[0][direction]=desc', 1);
        if (certRecords.length) {
          const cert = certRecords[0].fields;
          const daysSinceIssue = Math.round((new Date() - new Date(cert.IssuedDate)) / 86400000);
          if (daysSinceIssue >= CERT_EXPIRY_DAYS) {
            certificateStatus = { status: 'Expired', reason: `Certificate issued ${daysSinceIssue} days ago. Upload a current list to reassess.`, daysSinceIssue, daysUntilExpiry: 0 };
          } else if (exposure && cert.ExposureAtIssue != null && (exposure.totalExposure - cert.ExposureAtIssue) >= 50) {
            certificateStatus = { status: 'Review Required', reason: `Estimated exposure increased £${Math.round(exposure.totalExposure - cert.ExposureAtIssue)} since certificate was issued.`, daysSinceIssue, daysUntilExpiry: CERT_EXPIRY_DAYS - daysSinceIssue };
          } else {
            certificateStatus = { status: 'Current', reason: null, daysSinceIssue, daysUntilExpiry: CERT_EXPIRY_DAYS - daysSinceIssue };
          }
          certificateStatus.certificateId = cert.CertificateID;
          certificateStatus.issuedDate = cert.IssuedDate;
        }
      } catch (e) { console.error('Cert status check non-fatal:', e); }

      return res.json({ success: true, found: true, listName, checkDate: r.fields.CheckDate, sector: r.fields.Sector || null, results, snapshots, changes, exposure, certificateStatus });
    }

    // ── CERTIFICATE — pre-send compliance clearance ─────────
    if (action === 'certificate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { listName: rawListName, totalContacts, activeCount, liabilityCount, assetValue, icoStatus, sector, totalExposure } = req.body;
      const listName = normaliseListName(rawListName);
      const certId   = `CERT-${slugify(listName)}-${Date.now().toString(36).toUpperCase()}`;
      const now      = new Date().toISOString();

      await atCreate('List_Intelligence_Certificates', {
        UserID: userId, CertificateID: certId, ListName: listName, IssuedDate: now,
        TotalContacts: totalContacts || 0, ActiveCount: activeCount || 0,
        LiabilityCount: liabilityCount || 0, AssetValue: assetValue || 0,
        ICOStatus: icoStatus || 'Good standing', Sector: sector || null,
        ExpiresAt: new Date(Date.now() + CERT_EXPIRY_DAYS * 86400000).toISOString().slice(0, 10),
        Status: 'Current',
        ExposureAtIssue: totalExposure || 0,
      });

      return res.json({
        success: true, certificateId: certId, issuedDate: now, listName,
        message: 'Pre-send compliance clearance issued.',
        certificateStatus: { status: 'Current', daysUntilExpiry: CERT_EXPIRY_DAYS, daysSinceIssue: 0, reason: null },
      });
    }

    // ══════════════════════════════════════════════════════════
    // ── UPLOAD — v1.9: NORMALISATION LAYER ──────────────────
    // This is the ONLY section that changed from v1.8.
    // ══════════════════════════════════════════════════════════
    if (action === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

      // v1.9: Validate — accepts both rows/contacts AND fieldMapping/columnMapping
      const validation = validateListUpload(req.body);
      if (!validation.valid) return res.status(validation.status).json({ error: validation.error });
      const { rows: uploadRows, mapping } = validation;
      const listName = normaliseListName(req.body.listName);
      const sector   = req.body.sector || 'other';
      const aov      = parseFloat(req.body.aov) || 50;

      // v1.9: Normalise every row through the mapping
      // Handles: £1,250.00 → 1250, 15/03/2023 → Date, N/A → null, Opted In → active
      const mapped = [];
      const seenEmails = new Set();
      let normDuplicates = 0;
      for (let i = 0; i < uploadRows.length; i++) {
        const contact = normaliseListRow(uploadRows[i], mapping);
        contact.originalIndex = i;
        if (!contact.email) continue;
        if (seenEmails.has(contact.email)) { normDuplicates++; continue; }
        seenEmails.add(contact.email);
        mapped.push(contact);
      }
      if (mapped.length === 0) return res.status(400).json({ error: 'No valid email addresses found after processing. Check your column mapping.' });
      // ── Everything below is unchanged from v1.8 ───────────

      const analysis = analyseList(mapped, sector, aov);
      const opportunities = generateOpportunities(analysis);

      // ── Performance layer: domain composition, freshness, engagement gaps ──
      const allEmails = mapped.map(c=>c.email).filter(Boolean);
      const domainAnalysis = analyseDomainComposition(allEmails);
      const freshnessData = mapped.some(c=>c.dateAdded) ? analyseListFreshness(mapped) : null;
      const gapData = (mapped.some(c=>c.dateAdded) && mapped.some(c=>c.lastEngagement)) ? analyseEngagementGaps(mapped) : null;

      // v1.8: exposure calculation
      const exposure = calculateListExposure(analysis);

      // Snapshots + comparison
      const snapshots = await getListSnapshots(userId, listName, 12);
      const changes = snapshots.length > 0 ? buildListComparison({ ...analysis, estimatedExposure: exposure.totalExposure }, snapshots[0]) : null;

      let previousExposure = null;
      if (snapshots.length > 0 && snapshots[0]._exposureJson) {
        try { previousExposure = JSON.parse(snapshots[0]._exposureJson); } catch(e) {}
      }
      const exposureChanges = previousExposure ? buildExposureComparison(exposure, previousExposure) : null;

      await snapshotList(userId, listName, analysis, exposure);

      const narrative = await generateListNarrative(listName, analysis, changes);

      const checkFields = {
        UserID: userId, ListName: listName, CheckDate: new Date().toISOString().split('T')[0],
        TotalContacts: analysis.totalContacts, ActiveCount: analysis.activeCount,
        RecoverableCount: analysis.recoverableCount, AtRiskCount: analysis.atRiskCount,
        LiabilityCount: analysis.liabilityCount, LiabilityPct: analysis.liabilityPct,
        AssetValue: analysis.assetValue, ICOStatus: analysis.icoStatus, Sector: sector || null,
        Expiring30: analysis.expiring30, Expiring60: analysis.expiring60, Expiring90: analysis.expiring90,
        EstimatedExposure: exposure.totalExposure,
        EstimatedValue: exposure.estimatedValue,
        RecoverableValue: exposure.recoverableValue,
        ExposureJson: JSON.stringify(exposure),
        Results: JSON.stringify({
          totalContacts: analysis.totalContacts, activeCount: analysis.activeCount,
          recoverableCount: analysis.recoverableCount, atRiskCount: analysis.atRiskCount,
          liabilityCount: analysis.liabilityCount, liabilityPct: analysis.liabilityPct,
          assetValue: analysis.assetValue, icoStatus: analysis.icoStatus, asaNote: analysis.asaNote,
          cmaNote: analysis.cmaNote, dataQualityFlags: analysis.dataQualityFlags,
          expiring30: analysis.expiring30, expiring60: analysis.expiring60, expiring90: analysis.expiring90,
          valueExpiring90: analysis.valueExpiring90, opportunities, narrative, sector: sector || null, domainAnalysis, freshness: freshnessData, engagementGaps: gapData,
          activeIndices: analysis.activeIndices, recoverableIndices: analysis.recoverableIndices,
          atRiskIndices: analysis.atRiskIndices, liabilityIndices: analysis.liabilityIndices,
        }),
      };
      await atCreate('List_Intelligence_Checks', checkFields);

      // Emit fixes
      const liabSrc = liabilitySourceId(listName);
      const comSrc  = commercialLossSourceId(listName);
      await emitLIFix(userId, listName, { fixType: 'consent_expired', sourceRecordId: liabSrc, presentNow: analysis.liabilityCount > 0, description: `${analysis.liabilityCount.toLocaleString()} contacts in "${listName}" are below the consent threshold. Suppress these before sending.`, severity: analysis.liabilityPct > 0.2 ? 'High' : analysis.liabilityPct > 0.05 ? 'Medium' : 'Low', contactVolume: analysis.liabilityCount, resolvedSummary: `Liability contacts resolved on rerun of "${listName}" (${new Date().toISOString().split('T')[0]}).` });
      const commercialLoss = analysis.liabilityCount > 0 ? parseFloat((analysis.liability.reduce((s, c) => s + c.commercialValue, 0)).toFixed(2)) : 0;
      await emitLIFix(userId, listName, { fixType: 'commercial_loss', sourceRecordId: comSrc, presentNow: commercialLoss > 50, description: `Estimated £${commercialLoss.toLocaleString()} in commercial value at risk from liability contacts in "${listName}".`, severity: commercialLoss > 500 ? 'High' : commercialLoss > 100 ? 'Medium' : 'Low', exposureLow: Math.round(commercialLoss * 0.5), exposureHigh: Math.round(commercialLoss * 1.5), resolvedSummary: `Commercial loss resolved on rerun of "${listName}" (${new Date().toISOString().split('T')[0]}).` });

      return res.json({
        success: true, listName, totalContacts: analysis.totalContacts, duplicatesRemoved: analysis.duplicatesRemoved,
        activeCount: analysis.activeCount, recoverableCount: analysis.recoverableCount,
        atRiskCount: analysis.atRiskCount, liabilityCount: analysis.liabilityCount, liabilityPct: analysis.liabilityPct,
        assetValue: analysis.assetValue, icoStatus: analysis.icoStatus, asaNote: analysis.asaNote, cmaNote: analysis.cmaNote,
        dataQualityFlags: analysis.dataQualityFlags, expiring30: analysis.expiring30, expiring60: analysis.expiring60,
        expiring90: analysis.expiring90, valueExpiring90: analysis.valueExpiring90, opportunities, narrative, sector: sector || null, domainAnalysis, freshness: freshnessData, engagementGaps: gapData,
        changes, snapshots: await getListSnapshots(userId, listName, 12),
        activeIndices: analysis.activeIndices, recoverableIndices: analysis.recoverableIndices,
        atRiskIndices: analysis.atRiskIndices, liabilityIndices: analysis.liabilityIndices,
        // v1.8
        exposure, exposureChanges,
        downloadIndices: { active: analysis.activeIndices, recoverable: analysis.recoverableIndices, atRisk: analysis.atRiskIndices, liability: analysis.liabilityIndices },
      });
    }

    // ── LIST-EXPOSURE — v1.8: dashboard aggregation ─────────
    if (action === 'list-exposure') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

      const lists = await getListsSummary(userId);
      const exposureByList = [];
      let totalExposure = 0, totalValue = 0, totalRecoverable = 0;

      for (const list of lists) {
        const snaps = await getListSnapshots(userId, list.listName, 1);
        const snap = snaps[0];
        let listExposure = null;

        if (snap && snap._exposureJson) {
          try { listExposure = JSON.parse(snap._exposureJson); } catch (e) {}
        }

        if (!listExposure) {
          const liab = list.liabilityCount || 0;
          const total = list.totalContacts || 0;
          listExposure = {
            totalExposure: parseFloat((liab * EXPOSURE_ANCHORS.ico.perContactLiability).toFixed(2)),
            estimatedValue: parseFloat(((total - liab) * DEFAULT_REVENUE_PER_CONTACT).toFixed(2)),
            recoverableValue: 0,
            ico: { estimatedExposure: parseFloat((liab * EXPOSURE_ANCHORS.ico.perContactLiability).toFixed(2)), liabilityContacts: liab },
          };
        }

        exposureByList.push({
          listName: list.listName, lastCheckDate: list.checkDate, daysSinceLastCheck: list.daysSinceLastCheck,
          totalContacts: list.totalContacts, liabilityContacts: listExposure.ico?.liabilityContacts || list.liabilityCount || 0,
          totalExposure: listExposure.totalExposure || 0, estimatedValue: listExposure.estimatedValue || 0,
          recoverableValue: listExposure.recoverableValue || 0, state: list.icoStatus, needsAttention: list.needsAttention,
        });
        totalExposure += listExposure.totalExposure || 0;
        totalValue += listExposure.estimatedValue || 0;
        totalRecoverable += listExposure.recoverableValue || 0;
      }

      return res.json({
        success: true,
        totalExposure: parseFloat(totalExposure.toFixed(2)),
        estimatedValue: parseFloat(totalValue.toFixed(2)),
        recoverableValue: parseFloat(totalRecoverable.toFixed(2)),
        lists: exposureByList,
      });
    }

    // ── AI List Health Brief ──
    if (action === 'health-brief') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { listName, totalContacts, activeCount, recoverableCount, liabilityCount, atRiskCount, assetValue, exposure, domainAnalysis, freshness, engagementGaps, sector } = req.body;
      const parts=[];
      parts.push(`List: ${listName||'Unknown'}, ${totalContacts||0} contacts, sector: ${sector||'ecommerce'}`);
      parts.push(`Tiers: ${activeCount||0} active, ${recoverableCount||0} recoverable, ${atRiskCount||0} at-risk, ${liabilityCount||0} liability`);
      if(assetValue)parts.push(`Estimated value: £${Math.round(assetValue).toLocaleString()}`);
      if(exposure?.totalExposure)parts.push(`Regulatory exposure: £${Math.round(exposure.totalExposure).toLocaleString()} (ICO £${Math.round(exposure.ico?.estimatedExposure||0)}, ASA £${Math.round(exposure.asa?.estimatedExposure||0)}, CMA £${Math.round(exposure.cma?.estimatedExposure||0)})`);
      if(domainAnalysis?.insight)parts.push(`Domains: ${domainAnalysis.insight}`);if(freshness?.verdict)parts.push(`Freshness: ${freshness.verdict}`);if(engagementGaps?.insight)parts.push(`Engagement gaps: ${engagementGaps.insight}`);
      const prompt=`You are a UK email marketing data strategist. Based on this contact list analysis, write a health brief in three short paragraphs:\n\n1. LIST QUALITY — assess the overall quality based on tier distribution, domain composition, and freshness. Be specific with numbers.\n2. RISKS — flag consent decay, engagement gaps, domain issues, or exposure. If the list is clean, say so.\n3. ACTIONS — give 2-3 specific next steps. Be concrete and use £ figures where available.\n\n${parts.join('\n')}\n\nWrite for a marketing manager. Be direct. Three paragraphs, 150 words maximum. No headers or bullet points.`;
      try{const aiRes=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,messages:[{role:'user',content:prompt}]})});if(!aiRes.ok)return res.status(500).json({success:false,error:'Brief generation failed'});const msg=await aiRes.json();return res.json({success:true,brief:msg.content?.[0]?.text||''});}catch(e){return res.status(500).json({success:false,error:'Brief generation failed'});}
    }

    // ── DRAFT RE-CONSENT EMAIL — v1.7 ───────────────────────
    if (action === 'draft-reconsent') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { listName, sector, recoverableCount, totalContacts } = req.body;
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'AI not configured' });
      const sectorLabels = { ecommerce: 'an ecommerce / retail brand', finance: 'a financial services company', healthcare: 'a health and wellness brand', agency: 'a B2B services company', other: 'a UK business' };
      const sectorDesc = sectorLabels[sector] || sectorLabels.other;
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 600,
          system: `You write re-consent / re-permission emails for UK email marketers. The email must:\n- Be PECR compliant — the recipient must be able to clearly opt in or opt out\n- Not use fake urgency, countdown timers, or misleading claims (DMCCA 2024)\n- Not use guilt, pressure, or dark patterns\n- Be honest about why they are receiving the email\n- Include a clear "Yes, keep me subscribed" call to action\n- Include a clear unsubscribe option\n- Be under 120 words in the body\n- Match the tone of ${sectorDesc}\n- Not include HTML tags — plain text only\n\nReturn ONLY a JSON object with two fields, no markdown:\n{"subject":"...","body":"..."}`,
          messages: [{ role: 'user', content: `Write a re-consent email for "${listName || 'our list'}". ${recoverableCount || 0} contacts have declining consent and will cross the PECR threshold within 90 days. Total list size: ${totalContacts || 0}. Sector: ${sector || 'ecommerce'}.` }],
        }),
      });
      if (!claudeRes.ok) return res.status(500).json({ success: false, error: 'AI generation failed' });
      const result = await claudeRes.json();
      const text = result.content?.[0]?.text || '';
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let parsed;
      try {
        const match = cleaned.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : cleaned);
      } catch (e) {
        const subMatch = text.match(/subject[:\s]*(.+?)[\n\r]/i);
        parsed = { subject: subMatch ? subMatch[1].trim() : 'Quick check \u2014 do you still want to hear from us?', body: text.replace(/^subject[:\s]*.+?[\n\r]/i, '').replace(/^\{[\s\S]*\}$/, '').trim() || 'We noticed it\u2019s been a while since you engaged with our emails. We want to make sure we\u2019re only sending to people who want to hear from us.\n\nIf you\u2019d like to keep receiving our emails, click the link below:\n\n[Yes, keep me subscribed]\n\nIf not, no problem \u2014 you can unsubscribe at any time using the link at the bottom of this email.' };
      }
      return res.status(200).json({ success: true, subject: parsed.subject || 'Do you still want to hear from us?', body: parsed.body || '' });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (error) {
    console.error('list-intelligence error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
}
