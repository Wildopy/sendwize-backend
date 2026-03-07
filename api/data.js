// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js
// Merged: get-report + get-vendors + get-violations + load-results
// Router: ?action=report | vendors | violations | load
//
// GET  /api/data?action=report&recordId=x&type=pecr|ai|audit|email|vendor
// GET  /api/data?action=vendors
// GET  /api/data?action=violations&violationType=x&keyword=x
// POST /api/data?action=load  { userId }
// ─────────────────────────────────────────────────────────────

// ── REPORT handler ────────────────────────────────────────────
async function handleReport(req, res) {
  const { recordId, type } = req.query;

  if (!recordId || !type) {
    return res.status(400).json({ error: 'Missing recordId or type' });
  }

  const tables = {
    pecr:   'Submissions',
    ai:     'AI_Compliance_Checks',
    audit:  'Database_Audits',
    email:  'Email_Scans',
    vendor: 'Vendor_Checks',
  };

  const tableName = tables[type];
  if (!tableName) {
    return res.status(400).json({ error: 'Invalid report type' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${tableName}/${recordId}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable fetch failed:', response.status);
    return res.status(response.status).json({ error: 'Failed to fetch report' });
  }

  const data = await response.json();
  return res.json(data);
}

// ── VENDORS handler ───────────────────────────────────────────
async function handleVendors(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const response = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?sort[0][field]=VendorName&sort[0][direction]=asc`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
  );

  if (!response.ok) {
    console.error('Airtable fetch failed:', response.status);
    return res.json({ vendors: [] });
  }

  const data = await response.json();

  const vendors = (data.records || []).map(record => ({
    name:           record.fields.VendorName        || '',
    category:       record.fields.Category          || 'Marketing Tool',
    score:          record.fields.ComplianceScore   || 0,
    dpaLink:        record.fields.DPALink           || '',
    dataLocation:   record.fields.DataLocation      || '',
    certifications: record.fields.Certifications    || '',
    recentBreaches: record.fields.RecentBreaches    || 'No',
    notes:          record.fields.Notes             || '',
    lastUpdated:    record.fields.LastUpdated        || '',
  }));

  return res.json({ vendors });
}

// ── VIOLATIONS handler ────────────────────────────────────────
async function handleViolations(req, res) {
  const { violationType, keyword } = req.query;

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  let filters = [];
  if (violationType) filters.push(`{ViolationType}='${violationType}'`);
  if (keyword) {
    const kw = keyword.toLowerCase();
    filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
  }

  const formula = filters.length > 0 ? `AND(${filters.join(',')})` : '';
  const url = `https://api.airtable.com/v0/${BASE_ID}/Violation_Database` +
    (formula ? `?filterByFormula=${encodeURIComponent(formula)}` : '') +
    `${formula ? '&' : '?'}sort[0][field]=DateOfAction&sort[0][direction]=desc&maxRecords=20`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
  });

  if (!response.ok) return res.status(response.status).json({ error: 'Failed' });

  const data       = await response.json();
  const violations = data.records || [];
  const totalFines = violations.reduce((sum, v) => sum + (v.fields.FineAmount || 0), 0);

  return res.json({
    violations,
    stats: {
      total:     violations.length,
      totalFines,
      avgFine:   violations.length ? Math.round(totalFines / violations.length) : 0,
    },
  });
}

// ── LOAD handler ──────────────────────────────────────────────
async function handleLoad(req, res) {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const TABLE_NAME     = process.env.TABLE_NAME;

  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}?filterByFormula={UserID}='${userId}'&sort[0][field]=SubmissionDate&sort[0][direction]=desc`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Airtable error:', errorData);
    throw new Error(`Airtable error: ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  return res.status(200).json(data);
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET'  && action === 'report')     return await handleReport(req, res);
    if (req.method === 'GET'  && action === 'vendors')    return await handleVendors(req, res);
    if (req.method === 'GET'  && action === 'violations') return await handleViolations(req, res);
    if (req.method === 'POST' && action === 'load')       return await handleLoad(req, res);
    return res.status(400).json({ error: 'Unknown action. Use ?action=report|vendors|violations|load' });
  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: error.message });
  }
}
