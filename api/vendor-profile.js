// ─────────────────────────────────────────────────────────────
// SENDWIZE — vendor-profile.js v1.0 (beta field names fixed)
// POST /api/vendor-profile
// Body: { userId, vendorName, vendorRecordId }
//
// v1.0-beta: RiskRating (was ICORiskLevel), LastAutoChecked (was LastChecked)
// ─────────────────────────────────────────────────────────────

const APP_URL   = 'https://sendwize-backend.vercel.app';
const BASE_ID   = process.env.BASE_ID;
const AT_TOKEN  = process.env.AIRTABLE_TOKEN;
const AT_BASE   = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

const ICO_RSS = 'https://ico.org.uk/action-weve-taken/enforcement/rss/';
const ASA_RSS = 'https://www.asa.org.uk/rulings.rss';

const CONTRACT_CLAUSES = {
  data_processor: [
    { id:'dp1', label:'Subject matter, duration and nature of processing defined', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:30000 },
    { id:'dp2', label:'Sub-processor notification requirement included', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:50000 },
    { id:'dp3', label:'Data return or deletion on termination clause included', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:30000 },
    { id:'dp4', label:'Audit rights included', severity:'medium', regulatoryBody:'ICO', exposureLow:2000, exposureHigh:15000 },
    { id:'dp5', label:'Security measures specification included', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:50000 },
    { id:'dp6', label:'Controller instructions must be followed clause included', severity:'medium', regulatoryBody:'ICO', exposureLow:2000, exposureHigh:20000 },
    { id:'dp7', label:'Breach notification timeframe specified (72 hours)', severity:'high', regulatoryBody:'ICO', exposureLow:8000, exposureHigh:60000 },
    { id:'dp8', label:'Data subject rights assistance obligation included', severity:'medium', regulatoryBody:'ICO', exposureLow:2000, exposureHigh:15000 },
  ],
  agency: [
    { id:'ag1', label:'IP ownership of all creative assets assigned to you', severity:'high', regulatoryBody:'Commercial', commercialLow:5000, commercialHigh:100000 },
    { id:'ag2', label:'Data return on termination clause included', severity:'high', regulatoryBody:'Commercial', commercialLow:10000, commercialHigh:50000 },
    { id:'ag3', label:'ASA compliance obligation placed on agency', severity:'high', regulatoryBody:'ASA', exposureLow:0, exposureHigh:0 },
    { id:'ag4', label:'Written approval process for all marketing claims defined', severity:'high', regulatoryBody:'ASA', exposureLow:0, exposureHigh:0 },
    { id:'ag5', label:'Sub-contractor disclosure obligation included', severity:'medium', regulatoryBody:'Commercial', commercialLow:2000, commercialHigh:20000 },
    { id:'ag6', label:'Confidentiality covering customer data included', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:30000 },
    { id:'ag7', label:'GDPR processor obligations if agency accesses customer data', severity:'high', regulatoryBody:'ICO', exposureLow:20000, exposureHigh:500000 },
    { id:'ag8', label:'Indemnity for ASA or CMA rulings arising from agency work', severity:'medium', regulatoryBody:'ASA', exposureLow:0, exposureHigh:0 },
  ],
  reviews_ugc: [
    { id:'rv1', label:'CMA consumer reviews compliance confirmation included', severity:'critical', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
    { id:'rv2', label:'No incentivised reviews without clear disclosure', severity:'critical', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
    { id:'rv3', label:'Fake review removal process defined', severity:'high', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
    { id:'rv4', label:'Data processing terms for reviewer personal data included', severity:'high', regulatoryBody:'ICO', exposureLow:5000, exposureHigh:30000 },
  ],
  pricing_promotions: [
    { id:'pp1', label:'Reference pricing methodology compliant with DMCCA 2024', severity:'critical', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
    { id:'pp2', label:'Countdown timer accuracy and genuine scarcity requirement', severity:'high', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
    { id:'pp3', label:'Promotional terms and conditions accessible to consumers', severity:'high', regulatoryBody:'ASA', exposureLow:0, exposureHigh:0 },
    { id:'pp4', label:'Drip pricing prohibition — full price shown upfront', severity:'critical', regulatoryBody:'CMA', exposureLow:0, exposureHigh:0 },
  ],
};

const ASA_QUESTIONS = {
  creative_content: [
    { id:'asa1', label:'Do you have a written sign-off process for all claims the agency makes in your marketing?', severity:'high' },
    { id:'asa2', label:'Do they use testimonials or reviews in content they produce for you?', severity:'high' },
    { id:'asa3', label:'Do they make performance claims (e.g. "UK\'s best", "award-winning") on your behalf?', severity:'medium' },
    { id:'asa4', label:'Do they produce paid social or influencer content for you?', severity:'medium' },
  ],
  paid_media: [
    { id:'asa5', label:'Do you review and approve all ad creative before it goes live?', severity:'high' },
    { id:'asa6', label:'Do their ads use countdown timers or urgency claims?', severity:'high' },
    { id:'asa7', label:'Do their ads reference competitor products or prices?', severity:'medium' },
  ],
};

const CMA_QUESTIONS = {
  pricing_promotions: [
    { id:'cma1', label:'Do they manage or display reference pricing (was/now) for your products?', severity:'critical' },
    { id:'cma2', label:'Do they run countdown timers or scarcity claims in your campaigns?', severity:'high' },
    { id:'cma3', label:'Do they collect or display consumer reviews for your business?', severity:'high' },
    { id:'cma4', label:'Do they manage subscription pricing or auto-renewal terms?', severity:'high' },
  ],
  reviews_ugc: [
    { id:'cma5', label:'Do they collect reviews from your customers?', severity:'critical' },
    { id:'cma6', label:'Do they filter or moderate which reviews are displayed?', severity:'critical' },
    { id:'cma7', label:'Are any reviews incentivised (discount, gift, entry to prize draw)?', severity:'critical' },
  ],
};

function assessICORisk(regFields) {
  const dpaStatus = regFields.DPAStatus || 'Not yet';
  const volume = regFields.ContactVolume || 0;
  const clauses = parseClauses(regFields.ContractClauses);
  let score = 100;
  const issues = [];
  if (dpaStatus === 'Not yet' || dpaStatus === 'N/A' || dpaStatus === 'Unknown') {
    score -= 40;
    issues.push({ severity:'critical', regulator:'ICO', issue:'No signed DPA in place', action:'Obtain and sign a Data Processing Agreement before sharing any personal data.' });
  } else if (dpaStatus === 'Requested') {
    score -= 20;
    issues.push({ severity:'high', regulator:'ICO', issue:'DPA requested but not yet signed', action:'Chase vendor for signed DPA — do not share additional personal data until received.' });
  }
  if (volume > 100000) score -= 10;
  else if (volume > 50000) score -= 5;
  const dpClauses = CONTRACT_CLAUSES.data_processor;
  dpClauses.filter(c => clauses[c.id] === false).forEach(c => {
    score -= c.severity === 'critical' ? 15 : c.severity === 'high' ? 10 : 5;
    issues.push({ severity:c.severity, regulator:'ICO', issue:`Contract gap: ${c.label}`, action:`Add this clause to your DPA or processor agreement with ${regFields.VendorName}.`, exposureLow:c.exposureLow, exposureHigh:c.exposureHigh });
  });
  return { risk: score >= 80 ? 'Low' : score >= 50 ? 'Medium' : 'High', score, issues };
}

function assessASARisk(regFields) {
  const useCase = regFields.VendorUseCase || '';
  const producesContent = regFields.ProducesContent || false;
  const clauses = parseClauses(regFields.ContractClauses);
  if (!producesContent && !['Creative & content','Paid media'].includes(useCase)) return { risk:'N/A', score:100, issues:[] };
  let score = 100;
  const issues = [];
  CONTRACT_CLAUSES.agency.filter(c => c.regulatoryBody === 'ASA').forEach(c => {
    if (clauses[c.id] === false) {
      score -= 25;
      issues.push({ severity:c.severity, regulator:'ASA', issue:`Contract gap: ${c.label}`, action:'Add this to your agency contract to protect yourself from ASA liability.' });
    }
  });
  return { risk: score >= 80 ? 'Low' : score >= 50 ? 'Medium' : 'High', score, issues };
}

function assessCMARisk(regFields) {
  const useCase = regFields.VendorUseCase || '';
  const handlesPromotions = regFields.HandlesPromotions || false;
  const clauses = parseClauses(regFields.ContractClauses);
  if (!handlesPromotions && !['Reviews & UGC','Pricing & promotions'].includes(useCase)) return { risk:'N/A', score:100, issues:[] };
  let score = 100;
  const issues = [];
  const relevantClauses = useCase === 'Reviews & UGC' ? CONTRACT_CLAUSES.reviews_ugc : CONTRACT_CLAUSES.pricing_promotions;
  relevantClauses.forEach(c => {
    if (clauses[c.id] === false) {
      score -= c.severity === 'critical' ? 30 : 15;
      issues.push({ severity:c.severity, regulator:'CMA', issue:`${c.label} — not confirmed`, action:'Confirm compliance with this requirement with your vendor and document it.' });
    }
  });
  return { risk: score >= 80 ? 'Low' : score >= 50 ? 'Medium' : 'High', score, issues };
}

function assessCommercialRisk(regFields) {
  const useCase = regFields.VendorUseCase || '';
  const clauses = parseClauses(regFields.ContractClauses);
  const issues = [];
  if (['Creative & content','Paid media','Data enrichment'].includes(useCase) || regFields.ProducesContent) {
    CONTRACT_CLAUSES.agency.filter(c => c.regulatoryBody === 'Commercial').forEach(c => {
      if (clauses[c.id] === false) {
        issues.push({ severity:c.severity, regulator:'Commercial', issue:`Contract gap: ${c.label}`, action:'Add this clause to your contract to protect your commercial position.', commercialLow:c.commercialLow, commercialHigh:c.commercialHigh });
      }
    });
  }
  return { issues };
}

async function checkRSSFeeds(vendorName) {
  const findings = [];
  const name = vendorName.toLowerCase();
  async function fetchRSS(url, source) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Sendwize-Compliance/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const text = await r.text();
      const titles = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/gi)].map(m => (m[1] || m[2] || '').toLowerCase()).filter(t => t.length > 5);
      const links = [...text.matchAll(/<link>(.*?)<\/link>/gi)].map(m => m[1] || '');
      const dates = [...text.matchAll(/<pubDate>(.*?)<\/pubDate>/gi)].map(m => m[1] || '');
      titles.forEach((title, i) => {
        if (title.includes(name) || name.split(' ').some(word => word.length > 4 && title.includes(word))) {
          findings.push({ source, title: titles[i], link: links[i + 1] || '', date: dates[i] || '', relevance: 'matched_vendor_name' });
        }
      });
    } catch(e) { console.error(`RSS fetch failed for ${url}:`, e.message); }
  }
  await Promise.all([fetchRSS(ICO_RSS, 'ICO Enforcement'), fetchRSS(ASA_RSS, 'ASA Rulings')]);
  return findings;
}

function parseClauses(raw) { if (!raw) return {}; try { return JSON.parse(raw); } catch(e) { return {}; } }
function nullStrip(obj) { return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, vendorName, vendorRecordId } = req.body ?? {};
  if (!userId || !vendorName) return res.status(400).json({ error: 'userId and vendorName required' });

  try {
    let record = null;
    if (vendorRecordId) {
      const r = await fetch(`${AT_BASE}/Vendor_Register/${vendorRecordId}`, { headers: atH() });
      if (r.ok) record = await r.json();
    } else {
      const r = await fetch(`${AT_BASE}/Vendor_Register?filterByFormula=AND({UserID}='${userId}',{VendorName}='${vendorName}')&maxRecords=1`, { headers: atH() });
      if (r.ok) { const d = await r.json(); record = d.records?.[0] || null; }
    }
    if (!record) return res.status(404).json({ error: 'Vendor not found in register' });

    const f = record.fields;
    const rid = record.id;

    const ico = assessICORisk(f);
    const asa = assessASARisk(f);
    const cma = assessCMARisk(f);
    const commercial = assessCommercialRisk(f);
    const rssFindings = await checkRSSFeeds(vendorName);

    const useCase = f.VendorUseCase || '';
    let clauseSet = [];
    if (useCase === 'Reviews & UGC') clauseSet = [...CONTRACT_CLAUSES.data_processor, ...CONTRACT_CLAUSES.reviews_ugc];
    else if (useCase === 'Pricing & promotions') clauseSet = [...CONTRACT_CLAUSES.data_processor, ...CONTRACT_CLAUSES.pricing_promotions];
    else if (['Creative & content','Paid media'].includes(useCase) || f.ProducesContent) clauseSet = [...CONTRACT_CLAUSES.data_processor, ...CONTRACT_CLAUSES.agency];
    else clauseSet = CONTRACT_CLAUSES.data_processor;

    const asaQuestions = f.ProducesContent || useCase === 'Creative & content' ? ASA_QUESTIONS.creative_content : useCase === 'Paid media' ? ASA_QUESTIONS.paid_media : [];
    const cmaQuestions = useCase === 'Reviews & UGC' ? CMA_QUESTIONS.reviews_ugc : useCase === 'Pricing & promotions' || f.HandlesPromotions ? CMA_QUESTIONS.pricing_promotions : [];

    const today = new Date().toISOString().split('T')[0];
    const updateFields = nullStrip({
      RiskRating:       ico.risk,
      ASARiskLevel:     asa.risk,
      CMARiskLevel:     cma.risk,
      LastAutoChecked:  today,
      WebSearchFindings: rssFindings.length ? JSON.stringify(rssFindings) : null,
    });

    await fetch(`${AT_BASE}/Vendor_Register/${rid}`, { method: 'PATCH', headers: atH(), body: JSON.stringify({ fields: updateFields }) });

    const allIssues = [...ico.issues, ...asa.issues, ...cma.issues, ...commercial.issues];

    for (const issue of allIssues) {
      try {
        const fixTypeMap = { ICO:'dpa_breach', ASA:'asa_liability', CMA:'cma_reviews', Commercial:'commercial_risk' };
        await fetch(`${APP_URL}/api/generate-fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, fixType: fixTypeMap[issue.regulator] || 'dpa_breach', description: `Vendor Profile (${vendorName}): ${issue.issue}. ${issue.action}`, tool: `Vendor Profile \u2014 ${vendorName}`, severity: issue.severity, contactVolume: f.ContactVolume || null, sourceRecordId: rid }) });
      } catch(e) { console.error(`generate-fix failed:`, e.message); }
    }

    for (const finding of rssFindings.slice(0, 3)) {
      try {
        await fetch(`${APP_URL}/api/generate-fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, fixType: 'legitimate_interest_abuse', description: `Vendor Monitor (${vendorName}): ${finding.source} finding — "${finding.title}". Source: ${finding.link}`, tool: `Vendor Monitor \u2014 ${vendorName}`, severity: 'medium', contactVolume: f.ContactVolume || null, sourceRecordId: rid }) });
      } catch(e) { console.error('RSS fix failed:', e.message); }
    }

    return res.status(200).json({ success: true, vendorName, recordId: rid, profile: { ico: { risk: ico.risk, issues: ico.issues }, asa: { risk: asa.risk, issues: asa.issues }, cma: { risk: cma.risk, issues: cma.issues }, commercial: { issues: commercial.issues }, rssFindings, clauseSet, asaQuestions, cmaQuestions, totalIssues: allIssues.length + rssFindings.length } });
  } catch(e) {
    console.error('vendor-profile error:', e);
    return res.status(500).json({ error: e.message });
  }
}
