// ─────────────────────────────────────────────────────────────
// SENDWIZE — api/regulatory-feed-update.js
// Weekly cron endpoint — fires from Airtable automation every Monday 07:00 UK.
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
//
// Trigger: POST from Airtable automation with { secret: CRON_SECRET }
// CRON_SECRET must match process.env.CRON_SECRET on Vercel.
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

async function atGet(table, formula, sort, max = 50) {
  const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  let url = `${base}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atCreate(table, fields) {
  const base  = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `POST ${table}: ${r.status}`); }
  return (await r.json()).records?.[0];
}

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

  const data    = await res.json();
  const text    = data.content?.find(b => b.type === 'text')?.text || '';
  const match   = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error(`JSON parse failed for ${regulator}:`, e.message, text.slice(0, 200));
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Verify cron secret
  const { secret } = req.body || {};
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const weekNumber = getWeekNumber();
  console.log(`Regulatory feed update starting — week ${weekNumber}`);

  const results = { written: 0, skipped: 0, errors: [], competitorAlerts: 0 };

  // Scan all three regulators in parallel
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

  // Load competitor watch records for cross-referencing
  let allCompetitors = [];
  try {
    allCompetitors = await atGet('Competitor_Watch', `{WatchStatus}=1`, '', 200);
  } catch (e) {
    console.error('Could not load competitor watch (non-fatal):', e.message);
  }

  // Process each item
  for (const item of allItems) {
    try {
      const companyLower = (item.companyName || '').toLowerCase();

      // Deduplicate by company + week
      if (existingNames.has(companyLower)) {
        results.skipped++;
        continue;
      }

      const sector = inferSector(`${item.companyName} ${item.rulingSummary}`);

      // Write to Sector_Intelligence_Feed
      await atCreate('Sector_Intelligence_Feed', {
        Sector:                 sector,
        Regulator:              item.regulator,
        PublishedDate:          item.publishedDate || new Date().toISOString().split('T')[0],
        CompanyName:            item.companyName || '',
        RulingSummary:          (item.rulingSummary || '').slice(0, 500),
        ClaimTypes:             Array.isArray(item.claimTypes) ? JSON.stringify(item.claimTypes) : '',
        FineAmount:             item.fineAmount || null,
        RulingUrl:              item.rulingUrl || '',
        RelevantToSendwize:     item.relevantToEmailMarketing !== false,
        ActionableForUsers:     (item.actionableNote || '').slice(0, 300),
        WeekNumber:             weekNumber,
        AddedBy:                'Auto',
      });

      // Also write to Violation_Database if not already there
      try {
        await atCreate('Violation_Database', {
          CompanyName:    item.companyName || '',
          Regulator:      item.regulator,
          DateOfAction:   item.publishedDate || new Date().toISOString().split('T')[0],
          Violation:      (item.rulingSummary || '').slice(0, 500),
          FineAmount:     item.fineAmount || null,
          ViolationType:  Array.isArray(item.claimTypes) ? item.claimTypes[0] : 'other',
          Sector:         sector,
          Source:         'Auto-feed',
        });
      } catch (ve) {
        // Violation_Database write failing is non-fatal — may be duplicate
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

  console.log(`Feed update complete — written: ${results.written}, skipped: ${results.skipped}, competitor alerts: ${results.competitorAlerts}, errors: ${results.errors.length}`);

  return res.status(200).json({
    success:           true,
    week:              weekNumber,
    itemsFound:        allItems.length,
    written:           results.written,
    skipped:           results.skipped,
    competitorAlerts:  results.competitorAlerts,
    errors:            results.errors,
    breakdown:         { ICO: icoItems.length, ASA: asaItems.length, CMA: cmaItems.length },
  });
}
