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
    const { companyName, industry, contactCount } = req.body;
    
    if (!companyName) {
      return res.status(400).json({ error: 'Company name required' });
    }
    
    const prompt = `You are a PECR compliance expert writing a re-consent email.

Generate a professional, PECR-compliant email asking contacts to re-confirm their consent.

CONTEXT:
- Company: ${companyName}
- Industry: ${industry || 'General business'}
- Number of contacts: ${contactCount || 'multiple'}
- Reason: Consent is older than 2 years (PECR best practice recommends refresh)

REQUIREMENTS:
1. Friendly, professional tone
2. Explain WHY they're getting this (consent refresh, not first time)
3. Clear opt-in mechanism (cannot be pre-ticked)
4. Easy opt-out option
5. Privacy policy link placeholder
6. PECR compliant
7. Subject line included
8. Keep it concise (under 200 words)

Generate ONLY the email text (subject + body). No preamble or explanations.`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });
    
    if (!claudeResponse.ok) {
      console.error('Claude API failed:', await claudeResponse.text());
      return res.status(500).json({ error: 'Failed to generate email' });
    }
    
    const data = await claudeResponse.json();
    const emailText = data.content[0].text;
    
    res.json({ email: emailText });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
