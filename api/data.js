// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v7.3
// Commercial Relationships & Risk Register
//
// v7.3 changes (from v7.2):
//   + Partner register: RelationshipActivity, MarketingChannels,
//     AdComplianceReviewed, PricingComplianceReviewed fields added.
//     New fix types: unreviewed_joint_ads, partner_pricing_claims.
//   + Affiliate register: RelationshipActivity, MarketingMaterialsReviewed,
//     AdDisclosureCompliant, LandingPageReviewed fields added.
//     New fix types: affiliate_misleading_claims, affiliate_ad_disclosure,
//     lead_gen_consent_gap.
//   + calculateThirdPartyScore: partner scoring rebalanced to include
//     ad compliance dimension (A26 40pts, consent 20pts, brand 15pts,
//     ad compliance 25pts). Affiliate scoring rebalanced to include
//     materials review (consent 35pts, materials 25pts, sender 20pts,
//     DPA 20pts).
//   + handleRelationshipWatch: new alert types for ad compliance,
//     pricing compliance, marketing materials, influencer disclosure,
//     and lead gen landing pages.
//
// v7.1 changes preserved: calculateThirdPartyScore rewritten,
// dpa_breach fix on processor register, backfill-processor-fixes,
// cron-status.
// ─────────────────────────────────────────────────────────────

import { atFetch } from './_airtable.js';

const APP_URL     = 'https://sendwize-backend.vercel.app';
const RESEND_FROM = 'alerts@sendwize.co.uk';

// ── Airtable helpers ──────────────────────────────────────────
function atHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function atGet(base, table, formula, sort, max = 50) {
  let url = `${base}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await atFetch(url, { headers: atHeaders(process.env.AIRTABLE_TOKEN) });
  if (!r.ok) throw new Error(`Airtable GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}
async function atCreate(base, table, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
    body: JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable POST ${table}: ${r.status}`); }
  return (await r.json()).records?.[0];
}
async function atPatch(base, table, recordId, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== undefined && v !== ''));
  const r = await atFetch(`${base}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
    body: JSON.stringify({ fields: clean }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable PATCH ${table}: ${r.status}`); }
  return await r.json();
}
async function atDelete(base, table, recordId) {
  const r = await atFetch(`${base}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'DELETE',
    headers: atHeaders(process.env.AIRTABLE_TOKEN),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `Airtable DELETE ${table}: ${r.status}`); }
  return await r.json();
}

function airtableBase() {
  return `https://api.airtable.com/v0/${process.env.BASE_ID}`;
}

// ── DPA status check helper ───────────────────────────────────
const DPA_CONFIRMED = ['Confirmed', 'Confirmed and signed', 'In place'];
function isDPAConfirmed(status) {
  return DPA_CONFIRMED.includes(status || '');
}


// ── Third-party risk score (v7.3 — ad compliance dimensions added) ──
async function calculateThirdPartyScore(userId, base) {
  const [processors, partners, affiliates, profile] = await Promise.all([
    atGet(base, 'Vendor_Register',   `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Partner_Register',  `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Affiliate_Register',`{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'User_Profile',      `{UserID}='${userId}'`, '', 1).catch(() => []),
  ]);
 
  function processorCategoryScore(records) {
    if (!records.length) return null;
    const noDPA  = records.filter(r => !isDPAConfirmed(r.fields.DPAStatus || r.fields.AgreementStatus)).length;
    const hiRisk = records.filter(r => r.fields.ICORiskLevel === 'High').length;
    const stale  = records.filter(r => {
      const d = r.fields.LastChecked || r.fields.LastAutoChecked;
      return d && Math.floor((Date.now() - new Date(d)) / 86400000) > 90;
    }).length;
    const dpaGap   = (noDPA / records.length)  * 50;
    const riskGap  = (hiRisk / records.length) * 30;
    const staleGap = (stale / records.length)  * 20;
    return Math.max(0, Math.round(100 - dpaGap - riskGap - staleGap));
  }
 
  // v7.3: rebalanced to include ad compliance dimension
  function partnerCategoryScore(records) {
    if (!records.length) return null;
    const noA26   = records.filter(r => !isDPAConfirmed(r.fields.Article26Status)).length;
    const noChain = records.filter(r => !r.fields.ConsentChainVerified).length;
    const flagged = records.filter(r => r.fields.BrandSafetyFlag).length;
    const noAdReview = records.filter(r => {
      const activity = r.fields.RelationshipActivity || '';
      const needsReview = ['joint_ads', 'co_branded_content', 'influencer'].includes(activity);
      return needsReview && !r.fields.AdComplianceReviewed;
    }).length;
    const a26Gap    = (noA26 / records.length)       * 40;
    const chainGap  = (noChain / records.length)     * 20;
    const brandGap  = (flagged / records.length)     * 15;
    const adGap     = (noAdReview / records.length)  * 25;
    return Math.max(0, Math.round(100 - a26Gap - chainGap - brandGap - adGap));
  }
 
  // v7.3: rebalanced to include marketing materials dimension
  function affiliateCategoryScore(records) {
    if (!records.length) return null;
    const noDPA        = records.filter(r => !isDPAConfirmed(r.fields.DPAStatus)).length;
    const noConsent    = records.filter(r => !r.fields.ConsentChainVerified).length;
    const noSenderID   = records.filter(r => r.fields.SenderIdentityCompliant === 'Unverified').length;
    const noMaterials  = records.filter(r => !r.fields.MarketingMaterialsReviewed).length;
    const consentGap   = (noConsent / records.length)    * 35;
    const materialsGap = (noMaterials / records.length)  * 25;
    const senderGap    = (noSenderID / records.length)   * 20;
    const dpaGap       = (noDPA / records.length)        * 20;
    return Math.max(0, Math.round(100 - consentGap - materialsGap - senderGap - dpaGap));
  }
 
  const proc = processorCategoryScore(processors);
  const part = partnerCategoryScore(partners);
  const aff  = affiliateCategoryScore(affiliates);
 
  const applicable = [proc, part, aff].filter(s => s !== null);
  const total = applicable.length
    ? Math.round(applicable.reduce((a,b) => a+b, 0) / applicable.length)
    : null;
 
  const lastReview = profile[0]?.fields?.LastIntelligenceFeedReview || null;
  const daysSinceReview = lastReview
    ? Math.floor((Date.now() - new Date(lastReview)) / 86400000)
    : null;
 
  return {
    total,
    applicableCount: applicable.length,
    breakdown: {
      processors: { score: proc, count: processors.length, applicable: proc !== null },
      partners:   { score: part, count: partners.length,   applicable: part !== null },
      affiliates: { score: aff,  count: affiliates.length, applicable: aff !== null },
    },
    intelligence: {
      lastReviewDate: lastReview,
      daysSinceReview,
      reviewedThisWeek: daysSinceReview !== null && daysSinceReview <= 7,
    },
  };
}
 
// ── Cross-reference violations for a named entity ─────────────
async function getViolationsForName(base, name) {
  if (!name) return [];
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return [];
  const formula = `OR(${words.map(w => `FIND('${w}',LOWER({CompanyName}))`).join(',')})`;
  return atGet(base, 'Violation_Database', formula, 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 10).catch(() => []);
}

// ── Fix generation helper (fire-and-forget) ──────────────────
function generateFix(payload) {
  return fetch(`${APP_URL}/api/generate-fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(e => console.error('generate-fix non-fatal:', e));
}

async function fixExistsFor(base, userId, sourceRecordId, fixType) {
  if (!sourceRecordId) return false;
  const formula = `AND({UserID}='${userId}',{SourceRecordId}='${sourceRecordId}',{FixType}='${fixType}',{Status}!='completed',{Status}!='dismissed')`;
  const existing = await atGet(base, 'Compliance_Fixes', formula, '', 1).catch(() => []);
  return existing.length > 0;
}

// ── REPORT handler ────────────────────────────────────────────
async function handleReport(req, res) {
  const { recordId, type } = req.query;
  if (!recordId || !type) return res.status(400).json({ error: 'Missing recordId or type' });
  const tables = {
    ai: 'AI_Compliance_Checks', email: 'Email_Scans', audit: 'Database_Audits',
    vendor: 'Vendor_Register', suppression: 'Suppression_Checks',
    dossier: 'Campaign_Dossiers', pecr: 'Suppression_Checks',
    audience: 'Audience_Read_Campaigns', partner: 'Partner_Register',
    affiliate: 'Affiliate_Register', competitor: 'Competitor_Watch',
  };
  const tableName = tables[type];
  if (!tableName) return res.status(400).json({ error: 'Invalid report type' });
  const base = airtableBase();
  try {
    const records = await atGet(base, tableName, `RECORD_ID()='${recordId}'`, '', 1);
    return res.json(records[0] || null);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── VENDORS handler ───────────────────────────────────────────
async function handleVendors(req, res) {
  try {
    const records = await atGet(airtableBase(), 'Marketing_Vendors', '', 'sort[0][field]=VendorName', 200);
    const vendors = records.map(r => ({
      name:                  r.fields.VendorName || '',
      vendorType:            r.fields.VendorType || '',
      icoRegistrationStatus: r.fields.ICORegistered || 'Unknown',
      dpaStatus:             r.fields.DPAStatus || 'Unknown',
      dpaLink:               r.fields.PrivacyPolicyUrl || '',
      internationalTransfer: r.fields.TransferMechanismConfirmed || 'Unknown',
      knownBreachHistory:    r.fields.BreachHistory || '',
      lastVerified:          r.fields.LastVerified || '',
    }));
    return res.json({ vendors });
  } catch (e) {
    return res.json({ vendors: [] });
  }
}

// ── VIOLATIONS handler ────────────────────────────────────────
async function handleViolations(req, res) {
  const { violationType, keyword, sector } = req.query;
  const filters = [];
  if (violationType) filters.push(`{ViolationType}='${violationType}'`);
  if (sector)        filters.push(`{Sector}='${sector}'`);
  if (keyword) {
    const kw = keyword.toLowerCase();
    filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
  }
  const formula = filters.length ? `AND(${filters.join(',')})` : '';
  try {
    const records  = await atGet(airtableBase(), 'Violation_Database', formula, 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 20);
    const totalFines = records.reduce((s, v) => s + (v.fields.FineAmount || 0), 0);
    return res.json({ violations: records, stats: { total: records.length, totalFines, avgFine: records.length ? Math.round(totalFines / records.length) : 0 } });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── LOAD handler ──────────────────────────────────────────────
async function handleLoad(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const fixesRes = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  if (!fixesRes.ok) return res.status(fixesRes.status).json({ error: 'Failed to load compliance data' });
  return res.status(200).json(await fixesRes.json());
}

// ── HISTORY handler ───────────────────────────────────────────
async function handleHistory(req, res) {
  const { type, userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const tableMap = {
    audit:       { table: 'Database_Audits',        sort: 'AuditDate'   },
    vendor:      { table: 'Vendor_Register',         sort: 'LastChecked' },
    ai:          { table: 'AI_Compliance_Checks',    sort: 'CheckDate'   },
    suppression: { table: 'Suppression_Checks',      sort: 'CheckDate'   },
    audience:    { table: 'Audience_Read_Campaigns', sort: 'SendDate'    },
    partner:     { table: 'Partner_Register',         sort: 'LastChecked' },
    affiliate:   { table: 'Affiliate_Register',       sort: 'LastChecked' },
    competitor:  { table: 'Competitor_Watch',          sort: 'LastAutoChecked' },
  };
  if (!type || !tableMap[type]) return res.status(400).json({ error: `type must be one of: ${Object.keys(tableMap).join(' | ')}` });
  const { table, sort } = tableMap[type];
  try {
    const records = await atGet(airtableBase(), table, `{UserID}='${userId}'`, `sort[0][field]=${sort}&sort[0][direction]=desc`, 50);
    return res.json({ records });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── REGISTER handler (Vendor_Register — processors) ──────────
async function handleRegister(req, res) {
  const base = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try {
      await atDelete(base, 'Vendor_Register', recordId);
      return res.json({ deleted: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { recordId, vendor } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!vendor) return res.status(400).json({ error: 'vendor data required' });
    const fields = {
      UserID: userId, VendorName: vendor.VendorName, VendorType: vendor.VendorType,
      Category: vendor.Category, VendorUseCase: vendor.VendorUseCase,
      DPAStatus: vendor.DPAStatus, AgreementStatus: vendor.AgreementStatus,
      AgreementType: vendor.AgreementType, AgreementDate: vendor.AgreementDate,
      PrivacyPolicyUrl: vendor.PrivacyPolicyUrl || vendor.DPALink,
      DataProcessed: Array.isArray(vendor.DataProcessed) ? JSON.stringify(vendor.DataProcessed) : vendor.DataProcessed,
      TransferDestination: vendor.TransferDestination,
      ContactVolume: vendor.ContactVolume || null,
      ComplianceScore: vendor.ComplianceScore ?? null,
      ICORiskLevel: vendor.ICORiskLevel, ASARiskLevel: vendor.ASARiskLevel, CMARiskLevel: vendor.CMARiskLevel,
      DPAClauseResults: vendor.DPAClauseResults,
      PrivacyReviewResults: vendor.PrivacyReviewResults,
      Notes: vendor.Notes,
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      LastAutoChecked: vendor.LastAutoChecked,
    };
    try {
      const record = recordId
        ? await atPatch(base, 'Vendor_Register', recordId, fields)
        : await atCreate(base, 'Vendor_Register', fields);

      const dpaStatus = vendor.DPAStatus || vendor.AgreementStatus;
      let fixGenerated = false;
      if (!isDPAConfirmed(dpaStatus)) {
        const sourceId = record?.id || recordId;
        const already  = await fixExistsFor(base, userId, sourceId, 'dpa_breach');
        if (!already) {
          generateFix({
            userId, fixType: 'dpa_breach', tool: 'Relationships Register',
            description: `Processor '${vendor.VendorName}' registered without a confirmed Article 28 Data Processing Agreement (current status: ${dpaStatus || 'Unknown'}). UK GDPR Article 28 requires a written DPA before personal data is shared with a processor.`,
            severity: 'high', sourceRecordId: sourceId,
          });
          fixGenerated = true;
        }
      }

      return res.json({ record, fixGenerated, dpaConfirmed: isDPAConfirmed(dpaStatus) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── BACKFILL-PROCESSOR-FIXES handler ─────────────────────────
async function handleBackfillProcessorFixes(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const base = airtableBase();
  const processors = await atGet(base, 'Vendor_Register', `{UserID}='${userId}'`, '', 100).catch(() => []);

  const results = { checked: processors.length, fixesGenerated: 0, skipped: 0, confirmed: 0 };

  for (const r of processors) {
    const dpaStatus = r.fields.DPAStatus || r.fields.AgreementStatus;
    if (isDPAConfirmed(dpaStatus)) { results.confirmed++; continue; }

    const already = await fixExistsFor(base, userId, r.id, 'dpa_breach');
    if (already) { results.skipped++; continue; }

    generateFix({
      userId, fixType: 'dpa_breach', tool: 'Relationships Register (backfill)',
      description: `Processor '${r.fields.VendorName}' has no confirmed Article 28 Data Processing Agreement on file (status: ${dpaStatus || 'Unknown'}). UK GDPR Article 28 requires a written DPA before personal data is shared with a processor.`,
      severity: 'high', sourceRecordId: r.id,
    });
    results.fixesGenerated++;
  }

  return res.json(results);
}

// ── CRON-STATUS handler ───────────────────────────────────────
async function handleCronStatus(req, res) {
  const base = airtableBase();

  const [recent, all] = await Promise.all([
    atGet(base, 'Sector_Intelligence_Feed', '', 'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10).catch(() => []),
    atGet(base, 'Sector_Intelligence_Feed', '', 'sort[0][field]=WeekNumber&sort[0][direction]=desc', 100).catch(() => []),
  ]);

  const now = new Date();
  const sevenDaysAgo  = new Date(now.getTime() - 7  * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

  const inLast7  = recent.filter(r => r.fields.PublishedDate && new Date(r.fields.PublishedDate) >= sevenDaysAgo).length;
  const inLast14 = recent.filter(r => r.fields.PublishedDate && new Date(r.fields.PublishedDate) >= fourteenDaysAgo).length;

  const mostRecent = recent[0];
  const mostRecentDate = mostRecent?.fields?.PublishedDate || null;
  const daysSinceMostRecent = mostRecentDate
    ? Math.floor((now - new Date(mostRecentDate)) / 86400000)
    : null;

  const weekCounts = {};
  all.forEach(r => {
    const w = r.fields.WeekNumber;
    if (w != null) weekCounts[w] = (weekCounts[w] || 0) + 1;
  });
  const recentWeeks = Object.entries(weekCounts)
    .sort((a,b) => Number(b[0]) - Number(a[0]))
    .slice(0, 6)
    .map(([week, count]) => ({ weekNumber: Number(week), recordCount: count }));

  return res.json({
    totalRecords: all.length,
    inLast7Days: inLast7,
    inLast14Days: inLast14,
    mostRecent: mostRecent ? {
      companyName: mostRecent.fields.CompanyName || null,
      regulator: mostRecent.fields.Regulator || null,
      publishedDate: mostRecentDate,
      addedBy: mostRecent.fields.AddedBy || null,
      daysAgo: daysSinceMostRecent,
    } : null,
    recentWeeks,
    healthCheck: {
      cronLikelyRunning: inLast14 > 0,
      warning: inLast14 === 0
        ? 'No records in last 14 days — cron may not be running. Check Airtable automation history and CRON_SECRET env var.'
        : daysSinceMostRecent > 14
          ? 'Most recent record is stale — cron may have stopped.'
          : null,
    },
  });
}

// ── PARTNER-REGISTER handler (v7.3 — ASA/CAP/CMA dimensions) ──
async function handlePartnerRegister(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;
 
  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Partner_Register', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
 
  if (req.method === 'POST') {
    const { recordId, partner } = req.body;
    if (!userId)  return res.status(400).json({ error: 'userId required' });
    if (!partner) return res.status(400).json({ error: 'partner data required' });
 
    let violationCount = 0, lastViolationDate = null, lastViolationSummary = null;
    let reputationScore = 100, brandSafetyFlag = false, brandSafetyReason = null;
    if (!recordId && partner.PartnerName) {
      const viols = await getViolationsForName(base, partner.PartnerName);
      violationCount = viols.length;
      if (viols[0]) {
        lastViolationDate    = viols[0].fields.DateOfAction || null;
        lastViolationSummary = viols[0].fields.Violation    || null;
      }
      for (const v of viols) {
        const daysAgo = v.fields.DateOfAction
          ? Math.floor((Date.now() - new Date(v.fields.DateOfAction)) / 86400000)
          : 365;
        reputationScore -= daysAgo < 180 ? 20 : daysAgo < 365 ? 12 : 6;
      }
      reputationScore = Math.max(0, reputationScore);
      if (reputationScore < 60 || violationCount >= 2) {
        brandSafetyFlag   = true;
        brandSafetyReason = `${violationCount} regulatory action${violationCount !== 1 ? 's' : ''} found in Sendwize enforcement database.`;
      }
    }
 
    const fields = {
      UserID: userId, PartnerName: partner.PartnerName, PartnerType: partner.PartnerType,
      RelationshipDescription: partner.RelationshipDescription,
      Article26Status: partner.Article26Status || 'Not yet',
      Article26Date: partner.Article26Date,
      ConsentChainOwner: partner.ConsentChainOwner || 'Unknown',
      ConsentChainVerified: partner.ConsentChainVerified || false,
      PrivacyPolicyUrl: partner.PrivacyPolicyUrl,
      ReputationScore: partner.ReputationScore ?? reputationScore,
      BrandSafetyFlag: partner.BrandSafetyFlag ?? brandSafetyFlag,
      BrandSafetyReason: partner.BrandSafetyReason || brandSafetyReason,
      ViolationCount: partner.ViolationCount ?? violationCount,
      LastViolationDate: partner.LastViolationDate || lastViolationDate,
      LastViolationSummary: partner.LastViolationSummary || lastViolationSummary,
      CampaignLog: partner.CampaignLog,
      CommercialTermsNotes: partner.CommercialTermsNotes,
      DataSharedDescription: partner.DataSharedDescription,
      ICORiskLevel: partner.ICORiskLevel,
      A26ClauseResults: partner.A26ClauseResults,
      PrivacyReviewResults: partner.PrivacyReviewResults,
      Notes: partner.Notes,
      // v7.3 — ASA/CAP/CMA fields
      RelationshipActivity: partner.RelationshipActivity,
      MarketingChannels: Array.isArray(partner.MarketingChannels) ? JSON.stringify(partner.MarketingChannels) : partner.MarketingChannels,
      AdComplianceReviewed: partner.AdComplianceReviewed || false,
      PricingComplianceReviewed: partner.PricingComplianceReviewed || false,
      AddedDate: recordId ? undefined : new Date().toISOString().split('T')[0],
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      // v7.3 — ASA/CAP/CMA fields
      RelationshipActivity: partner.RelationshipActivity,
      MarketingChannels: Array.isArray(partner.MarketingChannels) ? JSON.stringify(partner.MarketingChannels) : partner.MarketingChannels,
      AdComplianceReviewed: partner.AdComplianceReviewed || false,
      PricingComplianceReviewed: partner.PricingComplianceReviewed || false,
    };
 
    try {
      const record = recordId
        ? await atPatch(base, 'Partner_Register', recordId, fields)
        : await atCreate(base, 'Partner_Register', fields);
 
      const fixesGenerated = [];
 
      if (!recordId && !isDPAConfirmed(partner.Article26Status)) {
        generateFix({
          userId, fixType: 'no_article26_agreement', tool: 'Relationships Register',
          description: `Partner '${partner.PartnerName}' added without a confirmed Article 26 joint controller agreement. Under UK GDPR Article 26, joint controllers must determine their respective responsibilities in a transparent arrangement.`,
          severity: 'high', sourceRecordId: record?.id || null,
        });
        fixesGenerated.push('no_article26_agreement');
      }
 
      if (!recordId && brandSafetyFlag) {
        generateFix({
          userId, fixType: 'partner_brand_risk', tool: 'Relationships Register',
          description: `Partner '${partner.PartnerName}' has ${violationCount} regulatory action${violationCount !== 1 ? 's' : ''} in the Sendwize enforcement database. Co-marketing with a brand under regulatory scrutiny creates reputational and potential joint-liability risk.`,
          severity: violationCount >= 3 ? 'critical' : 'high', sourceRecordId: record?.id || null,
        });
        fixesGenerated.push('partner_brand_risk');
      }
 
      // v7.3 — ASA/CAP: joint advertising compliance
      const activity = partner.RelationshipActivity || '';
      const adActivities = ['joint_ads', 'co_branded_content', 'influencer'];
      if (!recordId && adActivities.includes(activity) && !partner.AdComplianceReviewed) {
        generateFix({
          userId, fixType: 'unreviewed_joint_ads', tool: 'Relationships Register',
          description: `Partner '${partner.PartnerName}' is involved in ${activity.replace(/_/g, ' ')} but joint advertising content has not been reviewed against the CAP Code. Under CAP Code sections 3 (misleading) and 8 (pricing), both parties are responsible for claims in joint advertising.`,
          severity: 'high', sourceRecordId: record?.id || null,
        });
        fixesGenerated.push('unreviewed_joint_ads');
      }
 
      // v7.3 — CMA/DMCCA: pricing claims in co-branded campaigns
      const pricingActivities = ['joint_ads', 'co_branded_content', 'lead_generation'];
      if (!recordId && pricingActivities.includes(activity) && !partner.PricingComplianceReviewed) {
        generateFix({
          userId, fixType: 'partner_pricing_claims', tool: 'Relationships Register',
          description: `Partner '${partner.PartnerName}' runs ${activity.replace(/_/g, ' ')} but pricing and promotional claims have not been verified against CMA/DMCCA 2024 requirements. Reference pricing, drip pricing, and fake urgency in co-branded campaigns create joint liability under Schedule 1 banned practices.`,
          severity: 'medium', sourceRecordId: record?.id || null,
        });
        fixesGenerated.push('partner_pricing_claims');
      }
 
      return res.json({ record, reputationScore, brandSafetyFlag, violationCount, fixesGenerated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
 
  return res.status(405).json({ error: 'Method not allowed' });
}
 

// ── AFFILIATE-REGISTER handler (v7.3 — ASA/CAP/CMA dimensions) ──
async function handleAffiliateRegister(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;
 
  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Affiliate_Register', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
 
  if (req.method === 'POST') {
    const { recordId, affiliate } = req.body;
    if (!userId)    return res.status(400).json({ error: 'userId required' });
    if (!affiliate) return res.status(400).json({ error: 'affiliate data required' });
 
    const volume = affiliate.TotalVolumeSent || 0;
    let exposureLow = 0, exposureHigh = 0;
    if (!affiliate.ConsentChainVerified) {
      exposureLow  = Math.min(Math.round(volume * 0.02), 50000);
      exposureHigh = Math.min(Math.round(volume * 0.08), 225000);
    }
    if (affiliate.SenderIdentityCompliant === 'Unverified') {
      exposureLow  += 5000;
      exposureHigh += 30000;
    }
 
    const fields = {
      UserID: userId, AffiliateName: affiliate.AffiliateName, AffiliateType: affiliate.AffiliateType,
      DPAStatus: affiliate.DPAStatus || 'Not yet',
      AgreementDate: affiliate.AgreementDate,
      ConsentChainVerified: affiliate.ConsentChainVerified || false,
      ConsentChainNotes: affiliate.ConsentChainNotes,
      SenderIdentityCompliant: affiliate.SenderIdentityCompliant || 'Unverified',
      SenderIdentityNotes: affiliate.SenderIdentityNotes,
      FromNameUsed: affiliate.FromNameUsed,
      PrivacyPolicyUrl: affiliate.PrivacyPolicyUrl,
      CampaignLog: affiliate.CampaignLog,
      TotalVolumeSent: affiliate.TotalVolumeSent || null,
      LastCampaignDate: affiliate.LastCampaignDate,
      ICORiskLevel: affiliate.ICORiskLevel,
      DPAClauseResults: affiliate.DPAClauseResults,
      PrivacyReviewResults: affiliate.PrivacyReviewResults,
      ExposureEstimateLow: exposureLow || null,
      ExposureEstimateHigh: exposureHigh || null,
      Notes: affiliate.Notes,
      LastChecked: recordId ? undefined : new Date().toISOString().split('T')[0],
      // v7.3 — ASA/CAP/CMA fields
      RelationshipActivity: affiliate.RelationshipActivity,
      MarketingMaterialsReviewed: affiliate.MarketingMaterialsReviewed || false,
      AdDisclosureCompliant: affiliate.AdDisclosureCompliant || 'Unverified',
      LandingPageReviewed: affiliate.LandingPageReviewed || false,
      // v7.3 — ASA/CAP/CMA fields
      RelationshipActivity: affiliate.RelationshipActivity,
      MarketingMaterialsReviewed: affiliate.MarketingMaterialsReviewed || false,
      AdDisclosureCompliant: affiliate.AdDisclosureCompliant || 'Unverified',
      LandingPageReviewed: affiliate.LandingPageReviewed || false,
    };
 
    try {
      const record = recordId
        ? await atPatch(base, 'Affiliate_Register', recordId, fields)
        : await atCreate(base, 'Affiliate_Register', fields);
 
      const fixesGenerated = [];
 
      if (!recordId) {
        // Existing PECR fixes
        if (!affiliate.ConsentChainVerified) {
          generateFix({
            userId, fixType: 'affiliate_consent_unverified', tool: 'Relationships Register',
            description: `Affiliate '${affiliate.AffiliateName}' added with unverified consent chain. PECR Reg 22 requires valid consent for each marketing message — you cannot rely on consent collected by an affiliate without verifying it specifically covers your organisation's marketing.`,
            severity: 'critical', exposureLow, exposureHigh, sourceRecordId: record?.id || null,
          });
          fixesGenerated.push('affiliate_consent_unverified');
        }
        if (affiliate.SenderIdentityCompliant === 'Unverified') {
          generateFix({
            userId, fixType: 'affiliate_sender_identity_breach', tool: 'Relationships Register',
            description: `Affiliate '${affiliate.AffiliateName}' sender identity not verified. PECR Reg 23 requires the sender not be disguised or concealed — the From name must identify the organisation responsible for the marketing.`,
            severity: 'high', sourceRecordId: record?.id || null,
          });
          fixesGenerated.push('affiliate_sender_identity_breach');
        }
 
        // v7.3 — ASA/CAP: affiliate marketing materials review
        if (!affiliate.MarketingMaterialsReviewed) {
          generateFix({
            userId, fixType: 'affiliate_misleading_claims', tool: 'Relationships Register',
            description: `Affiliate '${affiliate.AffiliateName}' marketing materials have not been reviewed against the CAP Code. Under CAP, you are responsible for claims made on your behalf by affiliates — including pricing claims, health claims, and comparative claims.`,
            severity: 'high', sourceRecordId: record?.id || null,
          });
          fixesGenerated.push('affiliate_misleading_claims');
        }
 
        // v7.3 — ASA: influencer ad disclosure
        const affActivity = (affiliate.RelationshipActivity || affiliate.AffiliateType || '').toLowerCase();
        if (affActivity.includes('influencer') && affiliate.AdDisclosureCompliant !== 'Verified') {
          generateFix({
            userId, fixType: 'affiliate_ad_disclosure', tool: 'Relationships Register',
            description: `Influencer affiliate '${affiliate.AffiliateName}' ad disclosure not verified. The ASA requires all paid-for content to be clearly identified as advertising (#ad, #sponsored). The ASA has upheld complaints against brands for influencer posts not clearly labelled — the brand, not just the influencer, is liable.`,
            severity: 'high', sourceRecordId: record?.id || null,
          });
          fixesGenerated.push('affiliate_ad_disclosure');
        }
 
        // v7.3 — CMA/PECR: lead gen landing page review
        const isLeadGen = affActivity.includes('lead') || affActivity.includes('comparison') || affActivity.includes('cashback');
        if (isLeadGen && !affiliate.LandingPageReviewed) {
          generateFix({
            userId, fixType: 'lead_gen_consent_gap', tool: 'Relationships Register',
            description: `Lead generation affiliate '${affiliate.AffiliateName}' landing pages have not been reviewed. CMA/DMCCA 2024 requires transparent pricing and claims on lead gen pages, and PECR requires consent to specifically name your organisation. Saga Group was fined £225k for consent collected by affiliates that did not name Saga.`,
            severity: 'critical', sourceRecordId: record?.id || null,
          });
          fixesGenerated.push('lead_gen_consent_gap');
        }
      }
 
      return res.json({ record, exposureLow, exposureHigh, fixesGenerated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
 
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── COMPETITOR-WATCH handler ──────────────────────────────────
async function handleCompetitorWatch(req, res) {
  const base   = airtableBase();
  const userId = req.body?.userId || req.query?.userId;

  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    try { await atDelete(base, 'Competitor_Watch', recordId); return res.json({ deleted: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    const { recordId, competitor } = req.body;
    if (!userId)     return res.status(400).json({ error: 'userId required' });
    if (!competitor) return res.status(400).json({ error: 'competitor data required' });

    let rulingCount = 0, lastRulingDate = null, lastRulingSummary = null, lastRulingRegulator = null;
    let allRulingsJson = null, recentPromoClaims = null;

    if (!recordId && competitor.CompetitorName) {
      const viols = await getViolationsForName(base, competitor.CompetitorName);
      rulingCount = viols.length;
      if (viols[0]) {
        lastRulingDate      = viols[0].fields.DateOfAction || null;
        lastRulingSummary   = viols[0].fields.Violation    || null;
        lastRulingRegulator = viols[0].fields.Regulator    || null;
      }
      allRulingsJson = JSON.stringify(viols.slice(0, 5).map(v => ({
        date:      v.fields.DateOfAction || '',
        regulator: v.fields.Regulator    || '',
        summary:   (v.fields.Violation   || '').slice(0, 200),
        fine:      v.fields.FineAmount   || null,
      })));

      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const promoRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6', max_tokens: 400,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{ role: 'user', content: `Search for current marketing promotions, discount claims, urgency claims, or pricing tactics being used by ${competitor.CompetitorName} in the UK right now. Return ONLY a JSON array of up to 5 objects: [{"claimType":"fake_urgency|reference_pricing|superlative|free_claim|other","description":"brief description","complianceNote":"brief compliance observation"}]. No other text.` }],
            }),
          });
          if (promoRes.ok) {
            const promoData = await promoRes.json();
            const text = promoData.content?.find(b => b.type === 'text')?.text || '';
            const match = text.match(/\[[\s\S]*\]/);
            if (match) recentPromoClaims = match[0];
          }
        } catch (e) { console.error('Promo scan non-fatal:', e); }
      }
    }

    const fields = {
      UserID: userId, CompetitorName: competitor.CompetitorName,
      Sector: competitor.Sector, WatchStatus: competitor.WatchStatus !== false,
      WebsiteUrl: competitor.WebsiteUrl,
      RecentPromoClaims: competitor.RecentPromoClaims || recentPromoClaims,
      RecentPromoDate: !recordId ? new Date().toISOString().split('T')[0] : undefined,
      RulingCount: competitor.RulingCount ?? rulingCount,
      LastRulingDate: competitor.LastRulingDate || lastRulingDate,
      LastRulingSummary: competitor.LastRulingSummary || lastRulingSummary,
      LastRulingRegulator: competitor.LastRulingRegulator || lastRulingRegulator,
      AllRulingsJson: competitor.AllRulingsJson || allRulingsJson,
      SectorRiskFlag: (rulingCount >= 2) || false,
      SectorRiskReason: rulingCount >= 2 ? `${rulingCount} regulatory actions found for this competitor.` : null,
      Notes: competitor.Notes,
      LastAutoChecked: new Date().toISOString().split('T')[0],
    };

    try {
      const record = recordId
        ? await atPatch(base, 'Competitor_Watch', recordId, fields)
        : await atCreate(base, 'Competitor_Watch', fields);
      return res.json({ record, rulingCount, lastRulingSummary, recentPromoClaims });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SECTOR-INTELLIGENCE handler ──────────────────────────────
async function handleSectorIntelligence(req, res) {
  const { userId, sector, limit = '20' } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const base = airtableBase();

  let userSector = sector;
  if (!userSector) {
    const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
    userSector = profiles[0]?.fields?.Sector || 'general';
  }

  const [sectorFeed, generalFeed] = await Promise.all([
    atGet(base, 'Sector_Intelligence_Feed', `{Sector}='${userSector}'`, 'sort[0][field]=PublishedDate&sort[0][direction]=desc', parseInt(limit)).catch(() => []),
    atGet(base, 'Sector_Intelligence_Feed', `{Sector}='general'`, 'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10).catch(() => []),
  ]);

  const seen = new Set();
  const feed = [...sectorFeed, ...generalFeed].filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id); return true;
  }).sort((a, b) => new Date(b.fields.PublishedDate) - new Date(a.fields.PublishedDate));

  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile  = profiles[0];
  if (profile?.id) {
    atPatch(base, 'User_Profile', profile.id, {
      LastIntelligenceFeedReview: new Date().toISOString().split('T')[0],
    }).catch(e => console.error('feed review update non-fatal:', e));
  }

  return res.json({ feed, sector: userSector, count: feed.length });
}

// ── COMPETITOR-INTELLIGENCE handler ──────────────────────────
async function handleCompetitorIntelligence(req, res) {
  const { userId, competitorName } = req.query;
  if (!userId || !competitorName) return res.status(400).json({ error: 'userId and competitorName required' });

  const base = airtableBase();
  const viols = await getViolationsForName(base, competitorName);

  const feedRecords = await atGet(base, 'Sector_Intelligence_Feed',
    `FIND('${competitorName.toLowerCase()}',LOWER({CompanyName}))`,
    'sort[0][field]=PublishedDate&sort[0][direction]=desc', 10
  ).catch(() => []);

  return res.json({
    competitorName,
    violations: viols.slice(0, 10).map(v => ({
      date:      v.fields.DateOfAction || '',
      regulator: v.fields.Regulator    || '',
      summary:   v.fields.Violation    || '',
      fine:      v.fields.FineAmount   || null,
    })),
    feedMentions: feedRecords.length,
    totalRulings: viols.length,
  });
}

// ── RELATIONSHIP-WATCH handler ────────────────────────────────
async function handleRelationshipWatch(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const base  = airtableBase();
  const today = new Date();

  const [vendors, partners, affiliates, competitors, violations] = await Promise.all([
    atGet(base, 'Vendor_Register',    `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Partner_Register',   `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Affiliate_Register', `{UserID}='${userId}'`, '', 50).catch(() => []),
    atGet(base, 'Competitor_Watch',   `AND({UserID}='${userId}',{WatchStatus}=1)`, '', 50).catch(() => []),
    atGet(base, 'Violation_Database', '', 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 200).catch(() => []),
  ]);

  function staleDays(record) {
    const d = record.fields.LastChecked || record.fields.LastAutoChecked;
    return d ? Math.floor((today - new Date(d)) / 86400000) : null;
  }

  function anniversaryDays(dateStr) {
    if (!dateStr) return null;
    const ag = new Date(dateStr);
    const next = new Date(ag); next.setFullYear(today.getFullYear());
    if (next < today) next.setFullYear(today.getFullYear() + 1);
    return Math.floor((next - today) / 86400000);
  }

  function crossRefViolations(name) {
    if (!name) return [];
    const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return violations.filter(v => {
      const co = (v.fields.CompanyName || '').toLowerCase();
      return words.some(w => co.includes(w));
    }).slice(0, 3).map(v => ({
      source: v.fields.Regulator || '', date: v.fields.DateOfAction || '',
      summary: (v.fields.Violation || '').slice(0, 150), fine: v.fields.FineAmount || null,
    }));
  }

 // v7.3 — replace the buildAlerts function inside handleRelationshipWatch
  function buildAlerts(type, name, record) {
    const alerts = [];
    const f = record.fields;
    const sd = staleDays(record);
    const viols = crossRefViolations(name);
 
    if (viols.length > 0) alerts.push({ type: 'enforcement', severity: 'amber',
      text: `${viols.length} regulatory action${viols.length !== 1 ? 's' : ''} found in enforcement database for ${name}.`, detail: viols });
 
    if (type === 'processor') {
      const dpa = f.DPAStatus || f.AgreementStatus || '';
      if (!isDPAConfirmed(dpa)) alerts.push({ type: 'dpa', severity: 'red', text: 'No confirmed DPA — Article 28 UK GDPR breach until signed.' });
      if (sd !== null && sd > 90) alerts.push({ type: 'stale', severity: 'amber', text: `Last scanned ${sd} days ago. Quarterly re-scan recommended.` });
      const ann = anniversaryDays(f.AgreementDate);
      if (ann !== null && ann <= 60) alerts.push({ type: 'anniversary', severity: ann <= 14 ? 'red' : 'amber', text: ann <= 0 ? 'Agreement anniversary was recent — confirm renewed.' : `Agreement anniversary in ${ann} days — review terms.` });
    }
 
    if (type === 'partner') {
      if (!isDPAConfirmed(f.Article26Status)) alerts.push({ type: 'a26', severity: 'high', text: 'No confirmed Article 26 joint controller agreement.' });
      if (!f.ConsentChainVerified) alerts.push({ type: 'consent', severity: 'amber', text: 'Consent chain ownership not verified.' });
      if (f.BrandSafetyFlag) alerts.push({ type: 'brand', severity: 'amber', text: f.BrandSafetyReason || 'Brand safety flag raised.' });
      // v7.3 — ASA/CAP/CMA alerts for partners
      const partActivity = f.RelationshipActivity || '';
      const needsAdReview = ['joint_ads', 'co_branded_content', 'influencer'].includes(partActivity);
      if (needsAdReview && !f.AdComplianceReviewed) {
        alerts.push({ type: 'ad_compliance', severity: 'amber', text: `Joint advertising content with ${name} not reviewed against CAP Code.` });
      }
      if (['joint_ads', 'co_branded_content', 'lead_generation'].includes(partActivity) && !f.PricingComplianceReviewed) {
        alerts.push({ type: 'pricing', severity: 'amber', text: `Pricing claims in campaigns with ${name} not verified against CMA/DMCCA 2024.` });
      }
      const ann = anniversaryDays(f.Article26Date);
      if (ann !== null && ann <= 60) alerts.push({ type: 'anniversary', severity: ann <= 14 ? 'red' : 'amber', text: `Article 26 agreement review due in ${ann} days.` });
    }
 
    if (type === 'affiliate') {
      if (!f.ConsentChainVerified) alerts.push({ type: 'consent', severity: 'red', text: 'Consent chain unverified — same legal exposure as sending without consent.' });
      if (f.SenderIdentityCompliant === 'Unverified') alerts.push({ type: 'sender', severity: 'amber', text: 'Sender identity not verified — PECR Reg 23 risk.' });
      if (!isDPAConfirmed(f.DPAStatus)) alerts.push({ type: 'dpa', severity: 'amber', text: 'No confirmed DPA for this affiliate.' });
 
      // v7.3 — ASA/CAP/CMA alerts for affiliates
      if (!f.MarketingMaterialsReviewed) {
        alerts.push({ type: 'materials', severity: 'amber', text: `Marketing materials for ${name} not reviewed against CAP Code — you are responsible for claims made on your behalf.` });
      }
      const affActivity = (f.RelationshipActivity || f.AffiliateType || '').toLowerCase();
      if (affActivity.includes('influencer') && f.AdDisclosureCompliant !== 'Verified') {
        alerts.push({ type: 'disclosure', severity: 'red', text: `Influencer ${name} ad disclosure not verified — ASA requires clear #ad labelling on all paid content.` });
      }
      if ((affActivity.includes('lead') || affActivity.includes('comparison') || affActivity.includes('cashback')) && !f.LandingPageReviewed) {
        alerts.push({ type: 'landing_page', severity: 'amber', text: `Landing pages for ${name} not reviewed for consent capture compliance and CMA pricing rules.` });
      }
    }
 
    if (type === 'competitor') {
      if (f.RulingCount > 0) alerts.push({ type: 'ruling', severity: 'amber', text: `${f.RulingCount} regulatory action${f.RulingCount !== 1 ? 's' : ''} on record. Check if any claim types match your own campaigns.` });
      if (sd !== null && sd > 30) alerts.push({ type: 'stale', severity: 'amber', text: `Intelligence last updated ${sd} days ago. Competitor is checked automatically each week.` });
    }
 
    return alerts;
  }
// ── SUMMARY handler ──────────────────────────────────────────
async function handleSummary(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const [fixesRes, profileRes] = await Promise.all([
    fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`),
    fetch(`${APP_URL}/api/profile?action=get&userId=${userId}`),
  ]);
  const fixesData   = fixesRes.ok   ? await fixesRes.json()   : null;
  const profileData = profileRes.ok ? await profileRes.json() : null;
  const thirdPartyScore = await calculateThirdPartyScore(userId, airtableBase()).catch(() => null);
  return res.json({
    score:          fixesData?.score ?? 0,
    scoreBand:      fixesData?.scoreBand ?? 'Not Started',
    pendingCount:   fixesData?.fixes?.pending?.length ?? 0,
    completedCount: fixesData?.fixes?.completed?.length ?? 0,
    actioned:       fixesData?.actioned ?? { total: 0, count: 0 },
    categoryCounts: fixesData?.categoryCounts ?? { pending: { ico: 0, asa: 0, cma: 0 }, completed: { ico: 0, asa: 0, cma: 0 } },
    streak:         profileData?.currentStreak ?? 0,
    longestStreak:  profileData?.longestStreak ?? 0,
    lastCheckDate:  profileData?.lastCheckDate ?? null,
    thirdPartyScore,
  });
}

// ── SCORE-HISTORY handler ────────────────────────────────────
async function handleScoreHistory(req, res) {
  const base = airtableBase();

  if (req.method === 'GET') {
    const { userId, limit = '30' } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const records = await atGet(base, 'Score_History', `{UserID}='${userId}'`, 'sort[0][field]=Date&sort[0][direction]=desc', Math.min(parseInt(limit) || 30, 90));
    return res.json({ snapshots: records.map(r => ({
      id: r.id, date: r.fields.Date || '', score: r.fields.Score || 0,
      pending: r.fields.Pending || 0, completed: r.fields.Completed || 0,
      scoreChange: r.fields.ScoreChange || 0, triggerEvent: r.fields.TriggerEvent || '',
      thirdPartyRiskScore: r.fields.ThirdPartyRiskScore ?? null,
      processorScore: r.fields.ProcessorScore ?? null, partnerScore: r.fields.PartnerScore ?? null,
      affiliateScore: r.fields.AffiliateScore ?? null,
    })) });
  }

  if (req.method === 'POST') {
    const { userId, score, pending = 0, completed = 0, triggerEvent = 'Dashboard Load' } = req.body;
    if (!userId)             return res.status(400).json({ error: 'userId required' });
    if (score === undefined) return res.status(400).json({ error: 'score required' });

    const prevRecords  = await atGet(base, 'Score_History', `{UserID}='${userId}'`, 'sort[0][field]=Date&sort[0][direction]=desc', 1);
    const prevScore    = prevRecords[0]?.fields?.Score ?? score;
    const scoreChange  = score - prevScore;
    const thirdParty   = await calculateThirdPartyScore(userId, base).catch(() => null);
    const today        = new Date().toISOString().split('T')[0];

    const fields = {
      UserID: userId, Date: today, Score: score, Pending: pending, Completed: completed,
      ScoreChange: scoreChange, TriggerEvent: triggerEvent, AlertSent: false,
      ThirdPartyRiskScore: thirdParty?.total ?? null,
      ProcessorScore:      thirdParty?.breakdown?.processors?.score ?? null,
      PartnerScore:        thirdParty?.breakdown?.partners?.score   ?? null,
      AffiliateScore:      thirdParty?.breakdown?.affiliates?.score ?? null,
    };

    const snap = await atCreate(base, 'Score_History', fields);
    let alertFired = false;

    if (scoreChange <= -10) {
      const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1);
      const profile  = profiles[0];
      if (profile?.fields?.LastAlertSent !== today) {
        try {
          const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, alertType: 'score_drop', score, scoreChange }),
          });
          if (alertRes.ok) {
            alertFired = true;
            const patches = [];
            if (snap?.id) patches.push(atPatch(base, 'Score_History', snap.id, { AlertSent: true }));
            if (profile?.id) patches.push(atPatch(base, 'User_Profile', profile.id, { LastAlertSent: today }));
            await Promise.all(patches).catch(e => console.error('alert patch non-fatal:', e));
          }
        } catch (e) { console.error('score-drop alert non-fatal:', e); }
      }
    }

    return res.json({ snapshotId: snap?.id, scoreChange, alertFired, thirdPartyScore: thirdParty });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── SEND-ALERT handler ───────────────────────────────────────
// v7.2: adds segment_state_change template, enhances audience_damaged
// to show previousState when Audience Read passes it.
async function handleSendAlert(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId, alertType } = req.body;
  if (!userId || !alertType) return res.status(400).json({ error: 'userId and alertType required' });

  const RESEND_API_KEY  = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.json({ sent: false, reason: 'RESEND_API_KEY not configured' });

  const base     = airtableBase();
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const toEmail  = profiles[0]?.fields?.Email;
  if (!toEmail) return res.json({ sent: false, reason: 'No email on profile' });

  const alertTemplates = {
    score_drop: {
      subject: `⚠️ Your Sendwize compliance score dropped by ${Math.abs(req.body.scoreChange||0)} points`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Compliance score alert</h2><p style="color:#555;margin:0 0 24px;font-size:14px">Your score dropped by <strong>${Math.abs(req.body.scoreChange||0)} points</strong>, now at <strong>${req.body.score}/100</strong>.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View dashboard →</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>`,
    },
    consent_expiry: {
      subject: `⏰ Sendwize: consent expiry approaching`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Consent expiry notice</h2><p style="color:#555;margin:0 0 24px;font-size:14px">One or more segments have consent expiring within 30 days.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View dashboard →</a></div></div>`,
    },
    dpa_anniversary: {
      subject: `📋 Sendwize: agreement anniversary approaching — ${req.body.entityName || 'a vendor'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Agreement anniversary alert</h2><p style="color:#555;font-size:14px">Your agreement with <strong>${req.body.entityName || 'a third party'}</strong> is due for review in <strong>${req.body.daysUntil || '30'} days</strong>. Review the terms before it rolls over.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open relationships register →</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>`,
    },
    competitor_ruling: {
      subject: `🔍 Sendwize: new ruling involving ${req.body.competitorName || 'a watched competitor'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Competitor intelligence alert</h2><p style="color:#555;font-size:14px"><strong>${req.body.competitorName || 'A competitor you watch'}</strong> appears in a new regulatory ruling: ${req.body.rulingSummary || ''}. Review if any similar claim types appear in your own campaigns.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open sector intelligence →</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>`,
    },
    audience_damaged: {
      subject: `📊 Sendwize: audience alert — ${req.body.segmentName || 'a segment'} needs attention`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2>Audience Read alert</h2><p style="color:#555;font-size:14px">Your <strong>${req.body.segmentName || 'audience'}</strong> segment has moved${req.body.previousState ? ` from <strong>${req.body.previousState}</strong>` : ''} to <strong>${req.body.sentimentState || 'a negative state'}</strong>.</p>${req.body.regulatoryNote ? `<p style="background:#fdf4ff;border-left:4px solid #7e22ce;padding:12px 16px;font-size:13px;color:#555">${req.body.regulatoryNote}</p>` : ''}<a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">View Audience Read →</a></div></div>`,
    },
    // v7.2 — new template for mild AR state transitions (Healthy → Cooling etc)
    dossier_compliance_change: {
      subject: `⚠️ Sendwize: compliance change affecting ${req.body.campaignTitle || 'a campaign'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Campaign compliance alert</h2><p style="color:#555;margin:0 0 16px;font-size:14px">A new regulatory ruling this week affects claim types used in your campaign <strong>${req.body.campaignTitle || 'Untitled'}</strong>.</p><p style="background:#fdf4ff;border-left:4px solid #7e22ce;padding:12px 16px;font-size:13px;color:#555;margin:0 0 16px"><strong>Matching claim types:</strong> ${req.body.claimTypes || 'unknown'}<br><strong>New rulings this week:</strong> ${req.body.rulingCount || 0}</p><p style="color:#555;font-size:14px;margin:0 0 24px">Open your campaign dossier to review the ruling and check whether your evidence still holds.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open campaign dossier →</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>`,
    },
    segment_state_change: {
      subject: `📉 Sendwize: ${req.body.segmentName || 'a segment'} moved to ${req.body.sentimentState || 'a new state'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 8px">Audience state change</h2><p style="color:#555;margin:0 0 20px;font-size:14px">Your <strong>${req.body.segmentName || 'audience'}</strong> segment has moved from <strong>${req.body.previousState || 'a healthier state'}</strong> to <strong>${req.body.sentimentState || 'a warning state'}</strong>.</p><p style="color:#555;margin:0 0 24px;font-size:14px">This is an early signal, not damage — but the trend is going the wrong way. Open Audience Read to see what changed and the recommended action.</p><a href="https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Open Audience Read →</a><p style="margin:32px 0 0;font-size:11px;color:#999">Not legal advice.</p></div></div>`,
    },
  };

  const tmpl = alertTemplates[alertType];
  if (!tmpl) return res.status(400).json({ error: `Unknown alertType: ${alertType}` });

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [toEmail], subject: tmpl.subject, html: tmpl.html }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({}));
    return res.status(resendRes.status).json({ sent: false, reason: err.message || 'Resend error' });
  }

  const data = await resendRes.json();
  return res.json({ sent: true, messageId: data.id });
}

// ── BRIEFING handler ─────────────────────────────────────────
async function handleBriefing(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const base    = airtableBase();
  const today   = new Date().toISOString().split('T')[0];
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile  = profiles[0];
  if (profile?.fields?.LastBriefingSent === today) {
    return res.json({ briefing: profile?.fields?.LastBriefingText || null, cached: true });
  }

  const [fixesRes, vendors, partners, affiliates, competitors, violations] = await Promise.all([
    fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`),
    atGet(base, 'Vendor_Register',    `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Partner_Register',   `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Affiliate_Register', `{UserID}='${userId}'`, '', 20).catch(() => []),
    atGet(base, 'Competitor_Watch',   `AND({UserID}='${userId}',{WatchStatus}=1)`, '', 20).catch(() => []),
    atGet(base, 'Violation_Database', '', 'sort[0][field]=DateOfAction&sort[0][direction]=desc', 100).catch(() => []),
  ]);

  const fixesData    = fixesRes.ok ? await fixesRes.json() : null;
  const pending      = fixesData?.fixes?.pending   || [];
  const score        = fixesData?.score            || 0;
  const thirdParty   = await calculateThirdPartyScore(userId, base).catch(() => null);

  function crossRef(name) {
    if (!name) return [];
    const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return violations.filter(v => words.some(w => (v.fields.CompanyName||'').toLowerCase().includes(w))).slice(0,2);
  }

  const intelLines = [];

  for (const r of vendors.slice(0,5)) {
    const viols = crossRef(r.fields.VendorName);
    if (viols.length) intelLines.push(`- Processor ${r.fields.VendorName}: ${viols.length} enforcement action(s) in database.`);
    const d = r.fields.LastChecked || r.fields.LastAutoChecked;
    if (d && Math.floor((Date.now()-new Date(d))/86400000) > 90) intelLines.push(`- Processor ${r.fields.VendorName}: DPA not re-checked in 90+ days.`);
  }
  for (const r of partners.slice(0,5)) {
    if (!isDPAConfirmed(r.fields.Article26Status)) intelLines.push(`- Partner ${r.fields.PartnerName}: no Article 26 agreement confirmed.`);
    if (r.fields.BrandSafetyFlag) intelLines.push(`- Partner ${r.fields.PartnerName}: brand safety flag — ${r.fields.BrandSafetyReason||'regulatory history'}.`);
  }
  for (const r of affiliates.slice(0,5)) {
    if (!r.fields.ConsentChainVerified) intelLines.push(`- Affiliate ${r.fields.AffiliateName}: consent chain unverified.`);
  }
  for (const r of competitors.slice(0,5)) {
    const viols = crossRef(r.fields.CompetitorName);
    if (viols.length) intelLines.push(`- Competitor ${r.fields.CompetitorName} appears in enforcement database — check if any claim types match your own campaigns.`);
  }

  const promptContext = [
    `Compliance score: ${score}/100`,
    `Third-party risk score: ${thirdParty?.total ?? 'not calculated'}/100`,
    `Processors: ${vendors.length}, Partners: ${partners.length}, Affiliates: ${affiliates.length}, Competitors watched: ${competitors.length}`,
    `Pending fixes: ${pending.length}`,
    intelLines.length ? `\nRelationship intelligence:\n${intelLines.join('\n')}` : '\nNo relationship alerts this week.',
  ].join('\n');

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 600,
      system: `You are a compliance advisor for UK email marketers. Write a concise weekly briefing of 180-220 words covering: (1) overall score direction, (2) top 1-2 compliance actions, (3) any relationship alerts (processor DPAs, partner agreements, affiliate consent, competitor rulings), (4) one specific action for this week. Never say "compliant" or "in breach". Never give legal advice. Plain English, professional but not alarmist.`,
      messages: [{ role: 'user', content: `Status:\n${promptContext}\n\nWrite the weekly briefing.` }],
    }),
  });

  if (!claudeRes.ok) return res.status(claudeRes.status).json({ error: 'Failed to generate briefing' });
  const briefing = (await claudeRes.json()).content?.[0]?.text || '';

  if (profile?.id) {
    atPatch(base, 'User_Profile', profile.id, { LastBriefingSent: today, LastBriefingText: briefing })
      .catch(e => console.error('briefing save non-fatal:', e));
  }

  return res.json({ briefing, cached: false });
}

// ── CONSENT-EXPIRY-CHECK ─────────────────────────────────────
async function handleConsentExpiryCheck(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const base  = airtableBase();
  const today = new Date().toISOString().split('T')[0];
  const audits = await atGet(base, 'Database_Audits', `{UserID}='${userId}'`, 'sort[0][field]=AuditDate&sort[0][direction]=desc', 1).catch(() => []);
  const audit  = audits[0];
  if (!audit) return res.json({ checked: true, alertFired: false, expiringIn30: 0, expiringIn60: 0, expiringIn90: 0 });
  let expiryTimeline = [];
  try { expiryTimeline = JSON.parse(audit.fields.ExpiryTimeline || '[]'); } catch {}
  const d30 = new Date(); d30.setDate(d30.getDate()+30);
  const d60 = new Date(); d60.setDate(d60.getDate()+60);
  const d90 = new Date(); d90.setDate(d90.getDate()+90);
  let e30=0, e60=0, e90=0;
  expiryTimeline.forEach(s => {
    if (!s.expiryDate) return;
    const exp = new Date(s.expiryDate); const count = s.count||1;
    if (exp<=d30) e30+=count; else if (exp<=d60) e60+=count; else if (exp<=d90) e90+=count;
  });
  if (!e30) return res.json({ checked: true, alertFired: false, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
  const profiles = await atGet(base, 'User_Profile', `{UserID}='${userId}'`, '', 1).catch(() => []);
  const profile  = profiles[0];
  const lastAlert = profile?.fields?.LastAlertSent || '';
  if (lastAlert && Math.floor((new Date(today)-new Date(lastAlert))/86400000) < 7) {
    return res.json({ checked: true, alertFired: false, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
  }
  const alertRes = await fetch(`${APP_URL}/api/data?action=send-alert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, alertType: 'consent_expiry' }),
  }).catch(() => ({ ok: false }));
  if (profile?.id) atPatch(base, 'User_Profile', profile.id, { LastAlertSent: today }).catch(() => {});
  return res.json({ checked: true, alertFired: alertRes.ok, expiringIn30: e30, expiringIn60: e60, expiringIn90: e90 });
}

// ── VENDOR-WATCH (legacy compat) ─────────────────────────────
async function handleVendorWatch(req, res) {
  return handleRelationshipWatch(req, res);
}

// ── SIMULATION-RUN ───────────────────────────────────────────
async function handleSimulationRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { userId, regulator } = req.body;
  if (!userId || !regulator) return res.status(400).json({ error: 'userId and regulator required' });
  if (!['ICO','CMA','ASA'].includes(regulator)) return res.status(400).json({ error: 'regulator must be ICO | CMA | ASA' });

  const base   = airtableBase();
  const fixesRes  = await fetch(`${APP_URL}/api/fixes?action=get&userId=${userId}`);
  const fixesData = fixesRes.ok ? await fixesRes.json() : null;
  const pendingFixes   = fixesData?.fixes?.pending   || [];
  const score          = fixesData?.score            || 0;
  const criticalFixes  = pendingFixes.filter(f => f.severity === 'critical');
  const highFixes      = pendingFixes.filter(f => f.severity === 'high');

  const escalationBand = criticalFixes.length > 0 ? 'serious' : (highFixes.length > 0 || score < 50) ? 'elevated' : 'standard';
  const bandConfig = {
    standard: { label:'Standard Risk', colour:'#16a34a', bgColour:'#f0fdf4', borderColour:'#bbf7d0' },
    elevated: { label:'Elevated Risk',  colour:'#ca8a04', bgColour:'#fefce8', borderColour:'#fef08a' },
    serious:  { label:'Serious Risk',   colour:'#dc2626', bgColour:'#fef2f2', borderColour:'#fecaca' },
  };
  const bandDescriptions = {
    ICO: { standard:'Your compliance data does not show the patterns the ICO most commonly investigates.', elevated:'Your data shows patterns the ICO actively investigates — high-severity consent or data handling issues.', serious:'Your data shows critical compliance gaps that have formed the basis of ICO enforcement action in published cases.' },
    ASA: { standard:'Your compliance data does not show the patterns the ASA most commonly receives upheld complaints about.', elevated:'Your data shows patterns associated with ASA complaints — misleading claims, urgency or pricing issues.', serious:'Your data shows critical CAP Code concerns that have resulted in upheld ASA rulings in published cases.' },
    CMA: { standard:'Your compliance data does not match the patterns the CMA has targeted in its DMCCA sweeps.', elevated:'Your data shows patterns the CMA has identified in proactive sweeps — pricing, urgency, or review practices.', serious:'Your data shows practices that may constitute Schedule 1 banned practices under DMCCA 2024 — automatically unfair with no defence.' },
  };

  const categoryFixes = pendingFixes.filter(f => f.exposure?.category === regulator);
  const fixList = (categoryFixes.length ? categoryFixes : pendingFixes).slice(0,8).map(f =>
    `- ${f.fixType.replace(/_/g,' ')} (${f.severity}): ${String(f.description||'').slice(0,250)}`).join('\n') || 'No pending fixes.';

  const regCfg = {
    ICO: { orgName:"Information Commissioner's Office", refPrefix:'ICO-ENF', signatory:'Senior Enforcement Officer, Direct Marketing Team', tone:'formal ICO enforcement tone, reference PECR Regulation 22 and UK GDPR articles by number' },
    ASA: { orgName:'Advertising Standards Authority',   refPrefix:'ASA-ENQ', signatory:'Investigations Executive, ASA', tone:'formal ASA tone, reference specific CAP Code rules by number' },
    CMA: { orgName:'Competition and Markets Authority',  refPrefix:'CMA-CP',  signatory:'Senior Director, Consumer Protection', tone:'formal CMA enforcement tone under DMCCA 2024, reference Schedule 1 banned practices' },
  }[regulator];

  let letter = {};
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:2000, messages:[{ role:'user', content:
        `Simulate a ${regulator} enforcement letter. USER PENDING FIXES:\n${fixList}\n\nTone: ${regCfg.tone}. Return ONLY JSON (no markdown):\n{"reference":"${regCfg.refPrefix}-XXXXX","subject":"...","opening":"...","context":"...","closing":"...","signatory":"${regCfg.signatory}","questions":[{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."},{"question":"...","yesNote":"...","noNote":"..."}]}`
      }] }),
    });
    if (r.ok) { const text = (await r.json()).content?.[0]?.text||''; const m = text.match(/\{[\s\S]*\}/); if (m) letter = JSON.parse(m[0]); }
  } catch (e) { console.error('Letter parse non-fatal:', e); }

  const thisBand = bandConfig[escalationBand];
  return res.status(200).json({
    regulator,
    stage1: { checks: [] },
    stage2: { band: escalationBand, bandLabel: thisBand.label, bandColour: thisBand.colour, bandBg: thisBand.bgColour, bandBorder: thisBand.borderColour, bandDescription: (bandDescriptions[regulator]||bandDescriptions.ICO)[escalationBand], factors: [] },
    stage3: { letter },
    stage4: { documents: [] },
    stage5: { penalty: { low:0, high:0, context:'' }, representations:[] },
  });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'report'                  && req.method === 'GET')                       return await handleReport(req, res);
    if (action === 'vendors'                 && req.method === 'GET')                       return await handleVendors(req, res);
    if (action === 'violations'              && req.method === 'GET')                       return await handleViolations(req, res);
    if (action === 'load'                    && req.method === 'POST')                      return await handleLoad(req, res);
    if (action === 'history'                 && req.method === 'GET')                       return await handleHistory(req, res);
    if (action === 'summary'                 && req.method === 'GET')                       return await handleSummary(req, res);
    if (action === 'register'                && ['POST','DELETE'].includes(req.method))     return await handleRegister(req, res);
    if (action === 'score-history'           && ['GET','POST'].includes(req.method))        return await handleScoreHistory(req, res);
    if (action === 'send-alert'              && req.method === 'POST')                      return await handleSendAlert(req, res);
    if (action === 'briefing'                && req.method === 'GET')                       return await handleBriefing(req, res);
    if (action === 'consent-expiry-check'    && req.method === 'POST')                      return await handleConsentExpiryCheck(req, res);
    if (action === 'simulation-run'          && req.method === 'POST')                      return await handleSimulationRun(req, res);
    if (action === 'vendor-watch'            && req.method === 'GET')                       return await handleVendorWatch(req, res);
    if (action === 'relationship-watch'      && req.method === 'GET')                       return await handleRelationshipWatch(req, res);
    if (action === 'sector-intelligence'     && req.method === 'GET')                       return await handleSectorIntelligence(req, res);
    if (action === 'competitor-intelligence' && req.method === 'GET')                       return await handleCompetitorIntelligence(req, res);
    if (action === 'partner-register'        && ['POST','DELETE'].includes(req.method))     return await handlePartnerRegister(req, res);
    if (action === 'affiliate-register'      && ['POST','DELETE'].includes(req.method))     return await handleAffiliateRegister(req, res);
    if (action === 'competitor-watch'        && ['POST','DELETE'].includes(req.method))     return await handleCompetitorWatch(req, res);
    if (action === 'backfill-processor-fixes' && req.method === 'POST')                     return await handleBackfillProcessorFixes(req, res);
    if (action === 'cron-status'              && req.method === 'GET')                      return await handleCronStatus(req, res);

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
}
