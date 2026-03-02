const Anthropic = require('@anthropic-ai/sdk');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { content, userId, autoFix } = req.body;
    
    if (!content || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const prompt = `You are a UK marketing compliance expert checking for PECR, GDPR, ASA CAP Code, and CMA violations.

Analyze this marketing content and:
1. Identify ALL compliance violations
2. Assign a risk score (0-100, where 100 = fully compliant)
3. Categorize each violation by regulation
${autoFix ? '4. Generate a compliant rewrite that fixes ALL violations' : ''}

REGULATIONS TO CHECK:

PECR (Privacy and Electronic Communications Regulations):
- Unsolicited marketing requires prior consent
- Must include easy opt-out/unsubscribe
- Must include sender identity and contact details
- Must include valid physical address

ASA CAP Code:
- Rule 3.1: Marketing must not mislead
- Rule 3.7: Time-limited offers must specify end date
- Rule 3.9: "Free" requires no payment/unreasonable cost
- Rule 3.11: Comparisons must be verifiable
- Rule 3.17: Price claims must be clear and accurate

CMA (Consumer Protection):
- No false scarcity ("only 2 left" without proof)
- No fake urgency without basis
- No hidden costs/fees
- No bait-and-switch pricing

GDPR:
- Must explain data usage if collecting information
- Must link to privacy policy
- Must state lawful basis for processing

CONTENT TO ANALYZE:
${content}

Respond in this JSON format:
{
  "score": 85,
  "verdict": "Good - Minor Issues",
  "violations": [
    {
      "regulation": "CAP Code 3.7",
      "severity": "high",
      "issue": "Time-limited offer without end date",
      "location": "Subject line",
      "recommendation": "Add specific end date"
    }
  ],
  ${autoFix ? `"fixedVersion": "REWRITTEN COMPLIANT VERSION HERE",` : ''}
  "summary": "Brief assessment"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const responseText = message.content[0].text;
    let analysis;
    
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      analysis = {
        score: 50,
        verdict: "Analysis Error",
        violations: [],
        summary: responseText
      };
    }
    
    // FETCH RELEVANT VIOLATIONS FROM DATABASE
    const violations = analysis.violations || [];
    const relatedCases = [];
    
    if (violations.length > 0) {
      try {
        const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
        const BASE_ID = process.env.BASE_ID;
        
        const firstViolation = violations[0];
        let violationType = '';
        
        if (firstViolation.regulation.includes('PECR')) {
          violationType = 'Unsolicited Marketing';
        } else if (firstViolation.issue.toLowerCase().includes('price') || firstViolation.issue.toLowerCase().includes('cost')) {
          violationType = 'Misleading Pricing';
        } else if (firstViolation.issue.toLowerCase().includes('urgency') || firstViolation.issue.toLowerCase().includes('scarcity')) {
          violationType = 'Misleading Urgency';
        } else if (firstViolation.regulation.includes('CAP') || firstViolation.regulation.includes('ASA')) {
          violationType = 'Misleading Advertising';
        }
        
        if (violationType) {
          const url = `https://api.airtable.com/v0/${BASE_ID}/Violation_Database?filterByFormula={ViolationType}='${violationType}'&maxRecords=5&sort[0][field]=FineAmount&sort[0][direction]=desc`;
          
          const dbResponse = await fetch(url, {
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
          });
          
          if (dbResponse.ok) {
            const dbData = await dbResponse.json();
            relatedCases.push(...(dbData.records || []));
          }
        }
      } catch (dbError) {
        console.error('Error fetching violation cases:', dbError);
      }
    }
    
    // SAVE TO AIRTABLE
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    
    await fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [{
          fields: {
            UserID: userId,
            CheckDate: new Date().toISOString().split('T')[0],
            FileName: 'Marketing Content',
            RiskScore: analysis.score || 0,
            Verdict: analysis.verdict || 'Unknown',
            Violations: JSON.stringify(violations),
            FixedVersion: analysis.fixedVersion || '',
            RelatedCases: JSON.stringify(relatedCases.map(c => ({
              company: c.fields.CompanyName,
              fine: c.fields.FineAmount,
              violation: c.fields.Violation
            }))),
            Results: JSON.stringify(analysis)
          }
        }]
      })
    });
    
    res.json({
      ...analysis,
      relatedCases: relatedCases.map(c => ({
        company: c.fields.CompanyName,
        violation: c.fields.Violation,
        fine: c.fields.FineAmount,
        regulator: c.fields.Regulator,
        date: c.fields.DateOfAction,
        description: c.fields.Description
      }))
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}
