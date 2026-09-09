// ─────────────────────────────────────────────────────────────
// SENDWIZE — list-intelligence.js v1.7
//
// POST /api/list-intelligence?action=upload       — CSV analysis
// GET  /api/list-intelligence?action=load         — load latest or specific list
// GET  /api/list-intelligence?action=lists        — summary of every named list
// POST /api/list-intelligence?action=certificate  — pre-send clearance
// POST /api/list-intelligence?action=detect       — column detection (AI + fallback)
// POST /api/list-intelligence?action=draft-reconsent — AI re-consent email draft
//
// v1.7 changes from v1.6:
//   + draft-reconsent action: dedicated Claude endpoint for generating
//     PECR-compliant re-permission emails. Sector-matched tone.
//     Replaces the Copy Checker hack from the frontend.
//
// v1.6 changes preserved: AI column mapper, deterministic fallback,
//   narrative generation.
// v1.5 changes preserved: listName persistence, per-list snapshots,
//   per-list fix sourceRecordId, lists action, legacy tolerance.
// ─────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { atFetch } from './_airtable.js';

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
// FIX EMISSION + SNAPSHOTS + COMPARISON + LISTS SUMMARY
// All unchanged from v1.6
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

async function snapshotList(userId, listName, analysis) {
  await atCreate('List_Intelligence_Snapshots', { UserID: userId, ListName: listName, SnapshotDate: new Date().toISOString().slice(0, 10), SnapshotTimestamp: new Date().toISOString(), TotalContacts: analysis.totalContacts, ActiveCount: analysis.activeCount, RecoverableCount: analysis.recoverableCount, AtRiskCount: analysis.atRiskCount, LiabilityCount: analysis.liabilityCount, LiabilityPct: analysis.liabilityPct, AssetValue: analysis.assetValue, Expiring30: analysis.expiring30, Expiring60: analysis.expiring60, Expiring90: analysis.expiring90 });
}

async function getListSnapshots(userId, listName, max = 12) {
  const formula = `AND({UserID}='${userId}',${listNameFormulaFragment(listName)})`;
  const records = await atGet('List_Intelligence_Snapshots', formula, 'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc', max);
  return records.map(r => ({ date: r.fields.SnapshotDate, timestamp: r.fields.SnapshotTimestamp || r.fields.SnapshotDate, totalContacts: r.fields.TotalContacts || 0, activeCount: r.fields.ActiveCount || 0, recoverableCount: r.fields.RecoverableCount || 0, atRiskCount: r.fields.AtRiskCount || 0, liabilityCount: r.fields.LiabilityCount || 0, liabilityPct: r.fields.LiabilityPct != null ? r.fields.LiabilityPct : 0, assetValue: r.fields.AssetValue != null ? r.fields.AssetValue : 0, expiring30: r.fields.Expiring30 || 0, expiring60: r.fields.Expiring60 || 0, expiring90: r.fields.Expiring90 || 0 }));
}

function daysBetween(aIso, bIso) { if (!aIso || !bIso) return null; const a = new Date(aIso), b = new Date(bIso); if (isNaN(a) || isNaN(b)) return null; return Math.abs(Math.round((a - b) / 86400000)); }

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
  return { direction, daysSincePrevious: daysBetween(new Date().toISOString(), prev.timestamp), valueDelta, liabilityDelta, activeDelta, totalDelta, expiring30Delta, previous: { assetValue: prev.assetValue, liabilityCount: prev.liabilityCount, activeCount: prev.activeCount, totalContacts: prev.totalContacts, expiring30: prev.expiring30, date: prev.date } };
}

async function getListsSummary(userId) {
  const records = await atGet('List_Intelligence_Checks', `{UserID}='${userId}'`, 'sort[0][field]=CheckDate&sort[0][direction]=desc', 500);
  const byList = new Map();
  for (const r of records) { const rawName = r.fields.ListName; const listName = rawName && String(rawName).trim() ? String(rawName).trim() : LEGACY_LIST_NAME; if (byList.has(listName)) continue; byList.set(listName, r.fields); }
  const now = new Date().toISOString().slice(0, 10); const out = [];
  for (const [listName, f] of byList.entries()) { const days = daysBetween(now, f.CheckDate); const liability = f.LiabilityCount || 0; const stale = days != null && days >= 14; out.push({ listName, checkDate: f.CheckDate, daysSinceLastCheck: days, totalContacts: f.TotalContacts || 0, assetValue: f.AssetValue || 0, liabilityCount: liability, icoStatus: f.ICOStatus || 'Good standing', sector: f.Sector || null, needsAttention: liability > 0 || stale, needsAttentionReasons: [...(liability > 0 ? [`${liability} contact${liability !== 1 ? 's' : ''} below consent threshold`] : []), ...(stale ? [`No check in ${days} days`] : [])] }); }
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
// MAIN HANDLER — v1.7
// ─────────────────────────────────────────────────────────────
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
      const { headers, sampleRows } = req.body;
      if (!headers || !Array.isArray(headers)) return res.status(400).json({ error: 'headers required' });

      let mapping = null;
      let method  = 'deterministic';

      if (process.env.ANTHROPIC_API_KEY) {
        const aiResult = await aiMapListColumns(headers, sampleRows || []);
        if (aiResult && aiResult.columns && Array.isArray(aiResult.columns)) {
          mapping = {};
          for (const col of aiResult.columns) {
            if (col.header && col.target) mapping[col.header] = col.target;
          }
          method = 'ai';
        }
      }

      if (!mapping) {
        mapping = detectListColumns(headers, sampleRows || []);
        method  = 'deterministic';
      }

      return res.json({ success: true, mapping, method });
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
      const records  = await atGet(
        'List_Intelligence_Checks', formula,
        'sort[0][field]=CheckDate&sort[0][direction]=desc', 1
      );
      if (!records.length) return res.json({ success: true, found: false, listName });

      const r = records[0];
      let results = null;
      try { results = r.fields.Results ? JSON.parse(r.fields.Results) : null; } catch(e) {}

      const snapshots = await getListSnapshots(userId, listName, 12);
      const changes   = snapshots.length >= 2 ? buildListComparison(snapshots[0], snapshots[1]) : null;

      return res.json({
        success:  true,
        found:    true,
        listName,
        checkDate: r.fields.CheckDate,
        sector:    r.fields.Sector || null,
        results,
        snapshots,
        changes,
      });
    }

    // ── CERTIFICATE — pre-send compliance clearance ─────────
    if (action === 'certificate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { listName: rawListName, totalContacts, activeCount, liabilityCount, assetValue, icoStatus, sector } = req.body;
      const listName = normaliseListName(rawListName);
      const certId   = `CERT-${slugify(listName)}-${Date.now().toString(36).toUpperCase()}`;
      const now      = new Date().toISOString();

      await atCreate('List_Intelligence_Certificates', {
        UserID:        userId,
        CertificateID: certId,
        ListName:      listName,
        IssuedDate:    now,
        TotalContacts: totalContacts || 0,
        ActiveCount:   activeCount   || 0,
        LiabilityCount: liabilityCount || 0,
        AssetValue:    assetValue     || 0,
        ICOStatus:     icoStatus      || 'Good standing',
        Sector:        sector         || null,
      });

      return res.json({
        success:       true,
        certificateId: certId,
        issuedDate:    now,
        listName,
        message:       'Pre-send compliance clearance issued.',
      });
    }

    // ── UPLOAD — full CSV analysis ──────────────────────────
    if (action === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { contacts, sector, aov, columnMapping, listName: rawListName } = req.body;
      if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: 'contacts array is required' });
      }

      const listName = normaliseListName(rawListName);
      const mapping  = columnMapping || {};

      // Map raw rows to normalised contacts
      const mapped = contacts.map((row, idx) => {
        const contact = { originalIndex: idx };
        for (const [header, target] of Object.entries(mapping)) {
          const val = row[header];
          if (val === null || val === undefined || val === '') continue;
          switch (target) {
            case 'email':            contact.email           = String(val).trim(); break;
            case 'date_added':       contact.dateAdded       = normaliseDate(val); break;
            case 'last_engagement':  contact.lastEngagement  = normaliseDate(val); break;
            case 'last_purchase':    contact.lastPurchase    = normaliseDate(val); break;
            case 'engagement_type':  contact.engagementType  = String(val).trim(); break;
            case 'segment':          contact.segment         = String(val).trim(); break;
            case 'status':           contact.status          = String(val).trim(); break;
            case 'order_value':      contact.orderValue      = parseFloat(val) || 0; break;
            case 'engagement_count': contact.engagementCount = parseInt(val) || 0; break;
          }
        }
        return contact;
      }).filter(c => c.email);

      if (mapped.length === 0) {
        return res.status(400).json({ error: 'No valid email addresses found after column mapping.' });
      }

      const analysis = analyseList(mapped, sector || 'other', aov || 50);
      const opportunities = generateOpportunities(analysis);

      // Snapshots + comparison
      const snapshots = await getListSnapshots(userId, listName, 12);
      const changes   = snapshots.length > 0
        ? buildListComparison(analysis, snapshots[0])
        : null;

      await snapshotList(userId, listName, analysis);

      // Narrative
      const narrative = await generateListNarrative(listName, analysis, changes);

      // Persist check record
      const checkFields = {
        UserID:         userId,
        ListName:       listName,
        CheckDate:      new Date().toISOString().split('T')[0],
        TotalContacts:  analysis.totalContacts,
        ActiveCount:    analysis.activeCount,
        RecoverableCount: analysis.recoverableCount,
        AtRiskCount:    analysis.atRiskCount,
        LiabilityCount: analysis.liabilityCount,
        LiabilityPct:   analysis.liabilityPct,
        AssetValue:     analysis.assetValue,
        ICOStatus:      analysis.icoStatus,
        Sector:         sector || null,
        Expiring30:     analysis.expiring30,
        Expiring60:     analysis.expiring60,
        Expiring90:     analysis.expiring90,
        Results:        JSON.stringify({
          totalContacts:   analysis.totalContacts,
          activeCount:     analysis.activeCount,
          recoverableCount: analysis.recoverableCount,
          atRiskCount:     analysis.atRiskCount,
          liabilityCount:  analysis.liabilityCount,
          liabilityPct:    analysis.liabilityPct,
          assetValue:      analysis.assetValue,
          icoStatus:       analysis.icoStatus,
          asaNote:         analysis.asaNote,
          cmaNote:         analysis.cmaNote,
          dataQualityFlags: analysis.dataQualityFlags,
          expiring30:      analysis.expiring30,
          expiring60:      analysis.expiring60,
          expiring90:      analysis.expiring90,
          valueExpiring90: analysis.valueExpiring90,
          opportunities,
          narrative,
          sector:          sector || null,
          activeIndices:       analysis.activeIndices,
          recoverableIndices:  analysis.recoverableIndices,
          atRiskIndices:       analysis.atRiskIndices,
          liabilityIndices:    analysis.liabilityIndices,
        }),
      };
      await atCreate('List_Intelligence_Checks', checkFields);

      // Emit fixes
      const liabSrc = liabilitySourceId(listName);
      const comSrc  = commercialLossSourceId(listName);

      await emitLIFix(userId, listName, {
        fixType:        'consent_expired',
        sourceRecordId: liabSrc,
        presentNow:     analysis.liabilityCount > 0,
        description:    `${analysis.liabilityCount.toLocaleString()} contacts in "${listName}" are below the consent threshold. Suppress these before sending.`,
        severity:       analysis.liabilityPct > 0.2 ? 'High' : analysis.liabilityPct > 0.05 ? 'Medium' : 'Low',
        contactVolume:  analysis.liabilityCount,
        resolvedSummary: `Liability contacts resolved on rerun of "${listName}" (${new Date().toISOString().split('T')[0]}).`,
      });

      const commercialLoss = analysis.liabilityCount > 0
        ? parseFloat((analysis.liability.reduce((s, c) => s + c.commercialValue, 0)).toFixed(2))
        : 0;
      await emitLIFix(userId, listName, {
        fixType:        'commercial_loss',
        sourceRecordId: comSrc,
        presentNow:     commercialLoss > 50,
        description:    `Estimated £${commercialLoss.toLocaleString()} in commercial value at risk from liability contacts in "${listName}".`,
        severity:       commercialLoss > 500 ? 'High' : commercialLoss > 100 ? 'Medium' : 'Low',
        exposureLow:    Math.round(commercialLoss * 0.5),
        exposureHigh:   Math.round(commercialLoss * 1.5),
        resolvedSummary: `Commercial loss resolved on rerun of "${listName}" (${new Date().toISOString().split('T')[0]}).`,
      });

      return res.json({
        success: true,
        listName,
        totalContacts:    analysis.totalContacts,
        duplicatesRemoved: analysis.duplicatesRemoved,
        activeCount:      analysis.activeCount,
        recoverableCount: analysis.recoverableCount,
        atRiskCount:      analysis.atRiskCount,
        liabilityCount:   analysis.liabilityCount,
        liabilityPct:     analysis.liabilityPct,
        assetValue:       analysis.assetValue,
        icoStatus:        analysis.icoStatus,
        asaNote:          analysis.asaNote,
        cmaNote:          analysis.cmaNote,
        dataQualityFlags: analysis.dataQualityFlags,
        expiring30:       analysis.expiring30,
        expiring60:       analysis.expiring60,
        expiring90:       analysis.expiring90,
        valueExpiring90:  analysis.valueExpiring90,
        opportunities,
        narrative,
        sector:           sector || null,
        changes,
        snapshots:        await getListSnapshots(userId, listName, 12),
        activeIndices:       analysis.activeIndices,
        recoverableIndices:  analysis.recoverableIndices,
        atRiskIndices:       analysis.atRiskIndices,
        liabilityIndices:    analysis.liabilityIndices,
      });
    }

    // ── DRAFT RE-CONSENT EMAIL — v1.7 ───────────────────────
    if (action === 'draft-reconsent') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

      const { listName, sector, recoverableCount, totalContacts } = req.body;
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'AI not configured' });

      const sectorLabels = {
        ecommerce: 'an ecommerce / retail brand',
        finance: 'a financial services company',
        healthcare: 'a health and wellness brand',
        agency: 'a B2B services company',
        other: 'a UK business',
      };
      const sectorDesc = sectorLabels[sector] || sectorLabels.other;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          system: `You write re-consent / re-permission emails for UK email marketers. The email must:
- Be PECR compliant — the recipient must be able to clearly opt in or opt out
- Not use fake urgency, countdown timers, or misleading claims (DMCCA 2024)
- Not use guilt, pressure, or dark patterns
- Be honest about why they are receiving the email
- Include a clear "Yes, keep me subscribed" call to action
- Include a clear unsubscribe option
- Be under 120 words in the body
- Match the tone of ${sectorDesc}
- Not include HTML tags — plain text only

Return ONLY a JSON object with two fields, no markdown:
{"subject":"...","body":"..."}`,
          messages: [{
            role: 'user',
            content: `Write a re-consent email for "${listName || 'our list'}". ${recoverableCount || 0} contacts have declining consent and will cross the PECR threshold within 90 days. Total list size: ${totalContacts || 0}. Sector: ${sector || 'ecommerce'}.`,
          }],
        }),
      });

      if (!claudeRes.ok) {
        return res.status(500).json({ success: false, error: 'AI generation failed' });
      }

      const result = await claudeRes.json();
      const text = result.content?.[0]?.text || '';
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

      let parsed;
      try {
        const match = cleaned.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : cleaned);
      } catch (e) {
        const subMatch = text.match(/subject[:\s]*(.+?)[\n\r]/i);
        parsed = {
          subject: subMatch ? subMatch[1].trim() : 'Quick check \u2014 do you still want to hear from us?',
          body: text.replace(/^subject[:\s]*.+?[\n\r]/i, '').replace(/^\{[\s\S]*\}$/, '').trim() || 'We noticed it\u2019s been a while since you engaged with our emails. We want to make sure we\u2019re only sending to people who want to hear from us.\n\nIf you\u2019d like to keep receiving our emails, click the link below:\n\n[Yes, keep me subscribed]\n\nIf not, no problem \u2014 you can unsubscribe at any time using the link at the bottom of this email.',
        };
      }

      return res.status(200).json({
        success: true,
        subject: parsed.subject || 'Do you still want to hear from us?',
        body: parsed.body || '',
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (error) {
    console.error('list-intelligence error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
}
