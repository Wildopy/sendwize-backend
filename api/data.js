// ─────────────────────────────────────────────────────────────
// SENDWIZE — data.js v2.7
// Merged: get-report + get-vendors + get-violations + load-results
//         + history (audit/vendor) + register (add/update/delete)
// Router: ?action=report | vendors | violations | load | history | register
//
// GET    /api/data?action=report&recordId=x&type=pecr|ai|audit|email|vendor|suppression
// GET    /api/data?action=vendors
// GET    /api/data?action=violations&violationType=x&keyword=x
// POST   /api/data?action=load  { userId }
// GET    /api/data?action=history&type=audit|vendor&userId=x
// POST   /api/data?action=register  { userId, recordId?, vendor: { ... } }
// DELETE /api/data?action=register&recordId=x
// ─────────────────────────────────────────────────────────────

// ── REPORT handler ────────────────────────────────────────────
async function handleReport(req, res) {
  const { recordId, type } = req.query;

  if (!recordId || !type) {
    return res.status(400).json({ error: 'Missing recordId or type' });
  }

  const tables = {
    pecr:        'Submissions',
    ai:          'AI_Compliance_Checks',
    audit:       'Database_Audits',
    email:       'Email_Scans',
    vendor:      'Vendor_Checks',
    suppression: 'Suppression_Checks',
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
    subprocessors:  record.fields.Subprocessors     || '',
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

// ── HISTORY handler ───────────────────────────────────────────
// GET ?action=history&type=audit&userId=x  → last 10 Database_Audits
// GET ?action=history&type=vendor&userId=x → all Vendor_Register records
async function handleHistory(req, res) {
  const { type, userId } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!type || !['audit', 'vendor'].includes(type)) {
    return res.status(400).json({ error: 'type must be audit or vendor' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  if (type === 'audit') {
    const url = `https://api.airtable.com/v0/${BASE_ID}/Database_Audits` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=AuditDate&sort[0][direction]=desc` +
      `&maxRecords=10`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!response.ok) {
      console.error('Airtable history (audit) fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch audit history' });
    }

    const data = await response.json();
    return res.json({ records: data.records || [] });
  }

  if (type === 'vendor') {
    const url = `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register` +
      `?filterByFormula={UserID}='${userId}'` +
      `&sort[0][field]=AddedDate&sort[0][direction]=desc`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!response.ok) {
      console.error('Airtable history (vendor) fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch vendor register' });
    }

    const data = await response.json();
    return res.json({ records: data.records || [] });
  }
}

// ── REGISTER handler ──────────────────────────────────────────
// POST   ?action=register  { userId, recordId?, vendor: { ... } }  → add or update
// DELETE ?action=register&recordId=x                               → remove
async function handleRegister(req, res) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  // ── DELETE ────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { recordId } = req.query;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });

    const response = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${recordId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      }
    );

    if (!response.ok) {
      console.error('Airtable register delete failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to delete vendor' });
    }

    return res.json({ deleted: true });
  }

  // ── POST (add or update) ──────────────────────────────────────
  if (req.method === 'POST') {
    const { userId, recordId, vendor } = req.body;

    if (!userId)  return res.status(400).json({ error: 'userId required' });
    if (!vendor)  return res.status(400).json({ error: 'vendor data required' });

    const fields = {
      UserID:          userId,
      VendorName:      vendor.VendorName      || '',
      Category:        vendor.Category        || '',
      DataProcessed:   Array.isArray(vendor.DataProcessed)
                         ? JSON.stringify(vendor.DataProcessed)
                         : (vendor.DataProcessed || ''),
      AgreementType:   vendor.AgreementType   || '',
      AgreementStatus: vendor.AgreementStatus || '',
      AgreementLink:   vendor.AgreementLink   || '',
      AgreementDate:   vendor.AgreementDate   || '',
      DataLocation:    vendor.DataLocation    || '',
      ComplianceScore: vendor.ComplianceScore || null,
      LastChecked:     vendor.LastChecked     || '',
      CheckResults:    vendor.CheckResults
                         ? (typeof vendor.CheckResults === 'string'
                             ? vendor.CheckResults
                             : JSON.stringify(vendor.CheckResults))
                         : '',
      Notes:           vendor.Notes           || '',
    };

    // Strip empty optional fields so Airtable doesn't reject them
    Object.keys(fields).forEach(k => {
      if (fields[k] === '' || fields[k] === null) delete fields[k];
    });

    if (recordId) {
      // PATCH — update existing record
      const response = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register/${recordId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ fields })
        }
      );

      if (!response.ok) {
        console.error('Airtable register patch failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to update vendor' });
      }

      const data = await response.json();
      return res.json({ record: data });

    } else {
      // POST — create new record, set AddedDate to today
      fields.AddedDate = new Date().toISOString().split('T')[0];

      const response = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/Vendor_Register`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ records: [{ fields }] })
        }
      );

      if (!response.ok) {
        console.error('Airtable register post failed:', response.status);
        return res.status(response.status).json({ error: 'Failed to save vendor' });
      }

      const data = await response.json();
      return res.json({ record: data.records?.[0] || data });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET'    && action === 'report')     return await handleReport(req, res);
    if (req.method === 'GET'    && action === 'vendors')    return await handleVendors(req, res);
    if (req.method === 'GET'    && action === 'violations') return await handleViolations(req, res);
    if (req.method === 'POST'   && action === 'load')       return await handleLoad(req, res);
    if (req.method === 'GET'    && action === 'history')    return await handleHistory(req, res);
    if ((req.method === 'POST' || req.method === 'DELETE') && action === 'register') return await handleRegister(req, res);
    return res.status(400).json({ error: 'Unknown action. Use ?action=report|vendors|violations|load|history|register' });
  } catch (error) {
    console.error('data.js error:', error);
    return res.status(500).json({ error: error.message });
  }
}
