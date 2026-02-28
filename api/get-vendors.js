export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    
    const response = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Marketing_Vendors?sort[0][field]=VendorName&sort[0][direction]=asc`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      console.error('Airtable fetch failed:', response.status);
      return res.json({ vendors: [] });
    }
    
    const data = await response.json();
    
    const vendors = (data.records || []).map(record => ({
      name: record.fields.VendorName || '',
      category: record.fields.Category || 'Marketing Tool',
      score: record.fields.ComplianceScore || 0,
      dpaLink: record.fields.DPALink || '',
      dataLocation: record.fields.DataLocation || '',
      certifications: record.fields.Certifications || '',
      recentBreaches: record.fields.RecentBreaches || 'No',
      notes: record.fields.Notes || '',
      lastUpdated: record.fields.LastUpdated || ''
    }));
    
    res.json({ vendors });
    
  } catch (error) {
    console.error('Error:', error);
    res.json({ vendors: [] });
  }
}
