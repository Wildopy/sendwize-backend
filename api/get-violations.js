export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { violationType, keyword } = req.query;
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    
    let filters = [];
    if (violationType) filters.push(`{ViolationType}='${violationType}'`);
    if (keyword) {
      const kw = keyword.toLowerCase();
      filters.push(`OR(FIND('${kw}',LOWER({Violation})),FIND('${kw}',LOWER({CompanyName})))`);
    }
    
    const formula = filters.length > 0 ? `AND(${filters.join(',')})` : '';
    const url = `https://api.airtable.com/v0/${BASE_ID}/Violation_Database` +
      (formula ? `?filterByFormula=${encodeURIComponent(formula)}` : '') +
      `&sort[0][field]=DateOfAction&sort[0][direction]=desc&maxRecords=20`;
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });
    
    if (!response.ok) return res.status(response.status).json({ error: 'Failed' });
    
    const data = await response.json();
    const violations = data.records || [];
    const totalFines = violations.reduce((sum, v) => sum + (v.fields.FineAmount || 0), 0);
    
    res.json({
      violations,
      stats: {
        total: violations.length,
        totalFines,
        avgFine: violations.length ? Math.round(totalFines / violations.length) : 0
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
