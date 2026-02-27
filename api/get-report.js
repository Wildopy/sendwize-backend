export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { recordId, type } = req.query;
    
    if (!recordId || !type) {
      return res.status(400).json({ error: 'Missing recordId or type' });
    }
    
    // Map report types to Airtable tables
    const tables = {
      'pecr': 'Submissions',
      'ai': 'AI_Compliance_Checks',
      'audit': 'Database_Audits'
    };
    
    const tableName = tables[type];
    
    if (!tableName) {
      return res.status(400).json({ error: 'Invalid report type' });
    }
    
    // Fetch from Airtable using server-side token (secure!)
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    
    const response = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableName}/${recordId}`,
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      console.error('Airtable fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch report' });
    }
    
    const data = await response.json();
    
    // Return the data
    res.json(data);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
