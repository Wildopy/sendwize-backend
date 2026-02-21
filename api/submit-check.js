// Submit compliance check results to Airtable
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    const TABLE_NAME = process.env.TABLE_NAME;
    
    const submissionData = req.body;
    
    const response = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(submissionData)
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Airtable error:', errorData);
      throw new Error(`Airtable error: ${JSON.stringify(errorData)}`);
    }
    
    const data = await response.json();
    return res.status(200).json(data);
    
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({ error: error.message });
  }
}
