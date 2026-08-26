// ─────────────────────────────────────────────────────────────
// SENDWIZE — api/regulatory-feed-update.js
// Weekly cron endpoint — fires every Monday 07:00 UTC via Vercel Cron.
//
// What it does:
//   1. Calls Claude with web_search enabled
//   2. Asks Claude to find new ICO, ASA, CMA enforcement decisions
//      published in the last 7 days
//   3. Structures results and writes to:
//      - Sector_Intelligence_Feed (sector-tagged feed items)
//      - Violation_Database (permanent enforcement record)
//   4. Cross-references new rulings against Competitor_Watch records
//      and fires competitor_ruling alerts for any matches
//   5. Re-scans all active competitors' current marketing promotions
//      and updates RecentPromoClaims on each Competitor_Watch record
//
// Trigger: Vercel Cron (GET with Authorization header) or manual POST
// with { secret: CRON_SECRET }.
// ─────────────────────────────────────────────────────────────

import { atFetch } from './_airtable.js';

const APP_URL = 'https://sendwize-backend.vercel.app';

const SECTOR_KEYWORDS = {
  ecommerce:  ['ecommerce','retail','online shop','fashion','clothing','footwear','furniture','homewares','beauty','cosmetics'],
  b2b:        ['b2b','business to business','professional services','saas','software','technology','fintech','consultancy'],
  media:      ['media','publishing','newsletter','news','magazine','broadcasting','content','streaming'],
  finance:    ['finance','financial','insurance','mortgage','credit','loan','investment','bank','trading'],
  health:     ['health','healthcare','supplement','vitamin','wellbeing','wellness','medical','pharmacy','dental'],
  charity:    ['charity','nonprofit','non-profit','fundraising','donation','voluntary'],
  gambling:   ['gambling','betting','casino','lottery','gaming','bingo'],
  general:    [],
};

function inferSector(text) {
  const lower = text.toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (sector === 'general') continue;
    if (keywords.some(k => lower.includes(k))) return sector;
  }
  return 'general';
}

function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

// ── Airtable helpers (local to this file) ─────────────────────
function atHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
}

function airtableBase() {
  return `https://api.airtable.com/v0/${process.env.BASE_ID}`;
}

async function atGet(table, formula, sort, max = 50) {
  const base = airtableBase();
  let url = `${base}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: atHeaders() });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atCreate(table, fields) {
  const base  = airtableBase();
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: atHeaders(),
    body: JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `POST ${table}: ${r.status}`); }
  return (await r.json()).records?.[0];
}

async function atPatch(table, recordId, fields) {
  const base  = airtableBase();
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: atHeaders(),
    body: JSON.stringify({ fields: clean }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `PATCH ${table}: ${r.status}`); }
  return await r.json();
}

// ── Auth verification ─────────────────────────────────────────
// Accepts either:
//   - Vercel Cron: GET with x-vercel-cron-auth header matching CRON_SECRET
//   - Manual trigger: POST with { secret: CRON_SECRET } in body
//   - Fallback: Authorization: Bearer <CRON_SECRET> header
function verifyAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  // Vercel Cron sends this header automatically (Pro/Enterprise)
  if (req.headers?.['x-vercel-cron-auth'] === cronSecret) return true;

  // Authorization header (manual triggers, testing)
  const authHeader = req.headers?.['authorization'] || '';
  if (authHeader === `Bearer ${cronSecret}`) return true;

  // POST body secret (legacy / Airtable automation trigger)
  if (req.method === 'POST' && req.body?.secret === cronSecret) return true;

  return false;
}

// ── Enforcement scan (existing) ───────────────────────────────
async function scanRegulator(regulator, claudeKey) {
  const queries = {
    ICO: `Find ICO (Information Commissioner's Office) enforcement decisions, fines, and undertakings published in the last 7 days. Focus on direct marketing, email marketing, PECR, and UK GDPR enforcement cases. Include the company name, fine amount if any, and a brief description of the violation.`,
    ASA: `Find ASA (Advertising Standards Authority) upheld rulings published in the last 7 days. Focus on email marketing, digital advertising, misleading claims, fake urgency, reference pricing, health claims, and consumer protection rulings. Include the company name and the specific CAP Code rules cited.`,
    CMA: `Find CMA (Competition and Markets Authority) enforcement actions, cases opened, and undertakings published in the last 7 days under DMCCA 2024 or the Consumer Protection from Unfair Trading Regulations. Include company names and the specific practice being investigated or sanctioned.`,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `${queries[regulator]}

After searching, return ONLY a JSON array of enforcement items found. If nothing new was published this week, return an empty array [].

Format each item as:
{
  "companyName": "Company name",
  "publishedDate": "YYYY-MM-DD",
  "rulingSummary": "Brief plain-English description of what they did wrong (max 300 chars)",
  "actionableNote": "What this means for UK email marketers — what claim type or practice to check in your own campaigns (max 200 chars)",
  "fineAmount": 50000,
  "rulingUrl": "https://...",
  "claimTypes": ["fake_urgency", "reference_pricing"],
  "relevantToEmailMarketing": true
}

claimTypes must be from: fake_urgency, misleading_claim, reference_pricing, fake_reviews, drip_pricing, health_claim, consent_missing, suppression_breach, undisclosed_ad, data_breach, legitimate_interest_abuse, other

Return ONLY the JSON array. No other text.`,
      }],
    }),
  });

  if (!res.ok) {
    console.error(`Claude scan for ${regulator} failed:`, res.status);
    return [];
  }

  const data  = await res.json();
  const text  = data.content?.find(b => b.type === 'text')?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error(`JSON parse failed for ${regulator}:`, e.message, text.slice(0, 200));
    return [];
  }
}

// ── Competitor promo re-scan ──────────────────────────────────
// Runs the same promo scan as handleCompetitorWatch in data.js,
// but for all active competitors, updating their records weekly.
async function scanCompetitorPromos(competitors, claudeKey) {
  const results = { scanned: 0, updated: 0, errors: [] };
  const today = new Date().toISOString().split('T')[0];

  // Process in batches of 3 to avoid hammering the API
  for (let i = 0; i < competitors.length; i += 3) {
    const batch = competitors.slice(i, i + 3);

    const batchResults = await Promise.allSettled(
      batch.map(async (comp) => {
        const name = comp.fields.CompetitorName;
        if (!name) return null;

        results.scanned++;

        try {
          const promoRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': claudeKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 400,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{
                role: 'user',
                content: `Search for current marketing promotions, discount claims, urgency claims, or pricing tactics being used by ${name} in the UK right now. Return ONLY a JSON array of up to 5 objects: [{"claimType":"fake_urgency|reference_pricing|superlative|free_claim|other","description":"brief description","complianceNote":"brief compliance observation"}]. No other text.`,
              }],
            }),
          });

          if (!promoRes.ok) {
            console.error(`Promo scan failed for ${name}:`, promoRes.status);
            return null;
          }

          const promoData = await promoRes.json();
          const text  = promoData.content?.find(b => b.type === 'text')?.text || '';
          const match = text.match(/\[[\s\S]*\]/);

          const promoClaims = match ? match[0] : null;

          // Update the Competitor_Watch record with fresh promo data
          await atPatch('Competitor_Watch', comp.id, {
            RecentPromoClaims: promoClaims,
            RecentPromoDate:   today,
            LastAutoChecked:   today,
          });

          results.updated++;
          return { name, claimsFound: promoClaims ? true : false };

        } catch (e) {
          console.error(`Promo scan error for ${name}:`, e.message);
          results.errors.push({ competitor: name, error: e.message });
          return null;
        }
      })
    );

    // Brief pause between batches to be kind to rate limits
    if (i + 3 < competitors.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return results;
}

// ── Phase 3: Dossier compliance monitoring ────────────────────
// Cross-references new enforcement rulings against submitted
// dossiers' monitored claim types. When a ruling's claim types
// overlap with a campaign's claim types, annotates the dossier
// and fires a dossier_compliance_change alert.
async function crossReferenceDossiers(allItems) {
  const results = { checked: 0, alertsFired: 0, errors: [] };
  if (!allItems.length) return results;

  let dossiers = [];
  try {
    dossiers = await atGet('Campaign_Dossiers',
      "AND({Status}='Submitted',{MonitoredClaimTypes}!='')",
      'sort[0][field]=SubmittedAt&sort[0][direction]=desc', 200
    );
  } catch (e) {
    console.error('Could not load submitted dossiers (non-fatal):', e.message);
    return results;
  }

  if (!dossiers.length) return results;
  results.checked = dossiers.length;

  const newClaimTypes = new Set();
  const claimToItems = {};
  for (const item of allItems) {
    const claims = Array.isArray(item.claimTypes) ? item.claimTypes : [];
    for (const ct of claims) {
      newClaimTypes.add(ct);
      if (!claimToItems[ct]) claimToItems[ct] = [];
      claimToItems[ct].push({
        companyName: item.companyName || '',
        regulator: item.regulator || '',
        rulingSummary: (item.rulingSummary || '').slice(0, 200),
        publishedDate: item.publishedDate || '',
      });
    }
  }

  if (!newClaimTypes.size) return results;

  const today = new Date().toISOString().split('T')[0];

  for (const dossier of dossiers) {
    try {
      let monitored = [];
      try { monitored = JSON.parse(dossier.fields.MonitoredClaimTypes || '[]'); } catch {}
      if (!monitored.length) continue;

      const overlapping = monitored.filter(ct => newClaimTypes.has(ct));
      if (!overlapping.length) continue;

      const matchingRulings = [];
      for (const ct of overlapping) {
        for (const item of (claimToItems[ct] || [])) {
          matchingRulings.push({ ...item, matchedClaimType: ct });
        }
      }

      const seen = new Set();
      const uniqueRulings = matchingRulings.filter(r => {
        const key = r.companyName + r.regulator;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });

      const alert = {
        detectedAt: new Date().toISOString(),
        claimTypes: overlapping,
        rulingCount: uniqueRulings.length,
        rulings: uniqueRulings.slice(0, 5),
        summary: overlapping.length + ' claim type' + (overlapping.length !== 1 ? 's' : '') +
          ' in your campaign match new enforcement activity this week: ' +
          overlapping.map(ct => ct.replace(/_/g, ' ')).join(', ') + '.',
      };

      let existingAlerts = [];
      try { existingAlerts = JSON.parse(dossier.fields.ComplianceAlertsJson || '[]'); } catch {}
      existingAlerts.push(alert);

      await atPatch('Campaign_Dossiers', dossier.id, {
        ComplianceAlertsJson: JSON.stringify(existingAlerts),
        LastComplianceCheck: today,
      });

      const dossierUserId = dossier.fields.UserID;
      if (dossierUserId) {
        try {
          await fetch(APP_URL + '/api/data?action=send-alert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: dossierUserId,
              alertType: 'dossier_compliance_change',
              campaignTitle: dossier.fields.CampaignTitle || 'a campaign',
              claimTypes: overlapping.join(', ').replace(/_/g, ' '),
              rulingCount: uniqueRulings.length,
            }),
          });
          results.alertsFired++;
        } catch (ae) {
          console.error('Dossier alert failed (non-fatal):', ae.message);
        }
      }
    } catch (e) {
      console.error('Dossier cross-ref error:', e.message);
      results.errors.push({ dossierId: dossier.id, error: e.message });
    }
  }

  return results;
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Accept GET (Vercel Cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  // Verify auth
  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const weekNumber = getWeekNumber();
  console.log(`Regulatory feed update starting — week ${weekNumber}`);

  const results = { written: 0, skipped: 0, errors: [], competitorAlerts: 0, promoScan: null, dossierMonitoring: null };

  // ── Phase 1: Enforcement scan (ICO, ASA, CMA) ──────────────
  const [icoItems, asaItems, cmaItems] = await Promise.all([
    scanRegulator('ICO', ANTHROPIC_KEY),
    scanRegulator('ASA', ANTHROPIC_KEY),
    scanRegulator('CMA', ANTHROPIC_KEY),
  ]);

  const allItems = [
    ...icoItems.map(i => ({ ...i, regulator: 'ICO' })),
    ...asaItems.map(i => ({ ...i, regulator: 'ASA' })),
    ...cmaItems.map(i => ({ ...i, regulator: 'CMA' })),
  ];

  console.log(`Found ${allItems.length} items (ICO: ${icoItems.length}, ASA: ${asaItems.length}, CMA: ${cmaItems.length})`);

  // Load existing this week to deduplicate
  let existingThisWeek = [];
  try {
    existingThisWeek = await atGet('Sector_Intelligence_Feed', `{WeekNumber}='${weekNumber}'`, '', 200);
  } catch (e) {
    console.error('Could not load existing feed items (non-fatal):', e.message);
  }
  const existingNames = new Set(existingThisWeek.map(r => (r.fields.CompanyName || '').toLowerCase()));

  // Load ALL active competitor watch records (used for both phases)
  let allCompetitors = [];
  try {
    allCompetitors = await atGet('Competitor_Watch', `{WatchStatus}=1`, '', 200);
  } catch (e) {
    console.error('Could not load competitor watch (non-fatal):', e.message);
  }

  // Process each enforcement item
  for (const item of allItems) {
    try {
      const companyLower = (item.companyName || '').toLowerCase();

      if (existingNames.has(companyLower)) {
        results.skipped++;
        continue;
      }

      const sector = inferSector(`${item.companyName} ${item.rulingSummary}`);

      // Write to Sector_Intelligence_Feed
      await atCreate('Sector_Intelligence_Feed', {
        Sector:             sector,
        Regulator:          item.regulator,
        PublishedDate:      item.publishedDate || new Date().toISOString().split('T')[0],
        CompanyName:        item.companyName || '',
        RulingSummary:      (item.rulingSummary || '').slice(0, 500),
        ClaimTypes:         Array.isArray(item.claimTypes) ? JSON.stringify(item.claimTypes) : '',
        FineAmount:         item.fineAmount || null,
        RulingUrl:          item.rulingUrl || '',
        RelevantToSendwize: item.relevantToEmailMarketing !== false,
        ActionableForUsers: (item.actionableNote || '').slice(0, 300),
        WeekNumber:         weekNumber,
        AddedBy:            'Auto',
      });

      // Also write to Violation_Database
      try {
        await atCreate('Violation_Database', {
          CompanyName:   item.companyName || '',
          Regulator:     item.regulator,
          DateOfAction:  item.publishedDate || new Date().toISOString().split('T')[0],
          Violation:     (item.rulingSummary || '').slice(0, 500),
          FineAmount:    item.fineAmount || null,
          ViolationType: Array.isArray(item.claimTypes) ? item.claimTypes[0] : 'other',
          Sector:        sector,
          Source:        'Auto-feed',
        });
      } catch (ve) {
        console.warn('Violation_Database write skipped (may be duplicate):', ve.message);
      }

      existingNames.add(companyLower);
      results.written++;

      // Cross-reference against Competitor_Watch
      const nameWords = companyLower.split(/\s+/).filter(w => w.length > 3);
      const matchedCompetitors = allCompetitors.filter(r => {
        const compName = (r.fields.CompetitorName || '').toLowerCase();
        return nameWords.some(w => compName.includes(w));
      });

      for (const comp of matchedCompetitors) {
        const compUserId = comp.fields.UserID;
        if (!compUserId) continue;
        try {
          await fetch(`${APP_URL}/api/data?action=send-alert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId:         compUserId,
              alertType:      'competitor_ruling',
              competitorName: item.companyName,
              rulingSummary:  (item.rulingSummary || '').slice(0, 200),
            }),
          });
          results.competitorAlerts++;
          console.log(`Competitor alert fired: ${item.companyName} → userId=${compUserId}`);
        } catch (ae) {
          console.error('Competitor alert failed (non-fatal):', ae.message);
        }
      }

    } catch (e) {
      console.error(`Error processing item (${item.companyName}):`, e.message);
      results.errors.push({ company: item.companyName, error: e.message });
    }
  }

  // ── Phase 2: Competitor promo re-scan ───────────────────────
  // Re-scan what each watched competitor is currently promoting.
  // This catches risky marketing activity, not just enforcement.
  if (allCompetitors.length > 0) {
    console.log(`Starting promo re-scan for ${allCompetitors.length} active competitors`);
    results.promoScan = await scanCompetitorPromos(allCompetitors, ANTHROPIC_KEY);
    console.log(`Promo re-scan complete — scanned: ${results.promoScan.scanned}, updated: ${results.promoScan.updated}`);
  } else {
    results.promoScan = { scanned: 0, updated: 0, errors: [] };
  }

  // ── Phase 3: Dossier compliance monitoring ──────────────────
  if (allItems.length > 0) {
    console.log('Starting dossier compliance cross-reference');
    results.dossierMonitoring = await crossReferenceDossiers(allItems);
    console.log(`Dossier monitoring complete — alerts fired: ${results.dossierMonitoring.alertsFired}`);
  } else {
    results.dossierMonitoring = { checked: 0, alertsFired: 0, errors: [] };
  }

  console.log(`Feed update complete — enforcement written: ${results.written}, skipped: ${results.skipped}, competitor alerts: ${results.competitorAlerts}, promo re-scans: ${results.promoScan.updated}, errors: ${results.errors.length}`);

  return res.status(200).json({
    success:          true,
    week:             weekNumber,
    enforcement: {
      itemsFound:       allItems.length,
      written:          results.written,
      skipped:          results.skipped,
      competitorAlerts: results.competitorAlerts,
      breakdown:        { ICO: icoItems.length, ASA: asaItems.length, CMA: cmaItems.length },
    },
    promoScan: {
      competitorsScanned: results.promoScan.scanned,
      updated:            results.promoScan.updated,
      errors:             results.promoScan.errors.length,
    },
    dossierMonitoring: {
      dossiersChecked: results.dossierMonitoring.checked,
      alertsFired:     results.dossierMonitoring.alertsFired,
      errors:          results.dossierMonitoring.errors.length,
    },
    errors: results.errors,
  });
}
