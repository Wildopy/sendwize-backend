// api/analyze-copy.js
// AI-powered marketing compliance checker using Claude API

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
    const { 
      marketingCopy, 
      contentType, 
      industry,
      userId,
      companyGuidelines 
    } = req.body;
    
    if (!marketingCopy) {
      return res.status(400).json({ error: 'Marketing copy required' });
    }
    
    // Build specialized compliance prompt
    const compliancePrompt = `You are a UK marketing compliance expert specializing in:
- ASA CAP Code (Advertising Standards Authority)
- PECR (Privacy and Electronic Communications Regulations 2003)
- UK GDPR
${industry ? `- ${industry} sector regulations` : ''}

IMPORTANT: Provide SPECIFIC regulation citations, EXACT penalty amounts, and ACTIONABLE fixes.

${companyGuidelines ? `COMPANY-SPECIFIC RULES:\n${companyGuidelines}\n` : ''}

Analyze this ${contentType || 'marketing material'} for compliance issues:

"""
${marketingCopy}
"""

Provide a detailed compliance analysis in the following JSON format:
{
  "riskScore": <number 0-100, where 0 is critical risk, 100 is fully compliant>,
  "overallVerdict": "<CRITICAL|HIGH RISK|MEDIUM RISK|LOW RISK|COMPLIANT>",
  "summary": "<brief 1-2 sentence summary>",
  "criticalIssues": [
    {
      "issue": "<description>",
      "regulation": "<specific regulation e.g., PECR Reg 22, ASA CAP Code 3.1>",
      "location": "<where in the copy>",
      "penalty": "<potential fine/consequence>",
      "fix": "<specific recommended fix>",
      "compliantAlternative": "<rewritten compliant version>"
    }
  ],
  "warnings": [
    {
      "issue": "<description>",
      "regulation": "<specific regulation>",
      "recommendation": "<what to do>"
    }
  ],
  "goodPractices": [
    "<what they did right>"
  ],
  ${industry ? `"industrySpecificNotes": ["<industry-specific compliance notes>"],` : ''}
  "nextSteps": "<clear action items>"
}

Be thorough, cite EXACT regulations with numbers, state SPECIFIC penalties, and provide COMPLIANT alternatives for any flagged text.`;

    // Call Claude API
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: compliancePrompt
        }]
      })
    });
    
    if (!claudeResponse.ok) {
      const error = await claudeResponse.json();
      throw new Error(`Claude API error: ${JSON.stringify(error)}`);
    }
    
    const claudeData = await claudeResponse.json();
    const analysisText = claudeData.content[0].text;
    
    // Parse JSON from Claude's response
    let analysis;
    try {
      // Remove markdown code blocks if present
      const cleanText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanText);
    } catch (parseError) {
      // If JSON parsing fails, return raw text
      analysis = {
        riskScore: 50,
        overallVerdict: 'NEEDS REVIEW',
        summary: 'Analysis completed but formatting issue occurred',
        rawAnalysis: analysisText
      };
    }
    
    // Save to Airtable if userId provided
    if (userId) {
      try {
        const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
        const BASE_ID = process.env.BASE_ID;
        const AI_CHECKS_TABLE = process.env.AI_CHECKS_TABLE || 'AI_Compliance_Checks';
        
        await fetch(`https://api.airtable.com/v0/${BASE_ID}/${AI_CHECKS_TABLE}`, {
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
                ContentType: contentType || 'Unknown',
                Industry: industry || 'Not specified',
                RiskScore: analysis.riskScore,
                Verdict: analysis.overallVerdict,
                CriticalIssues: analysis.criticalIssues?.length || 0,
                Warnings: analysis.warnings?.length || 0,
                MarketingCopy: marketingCopy.substring(0, 5000), // First 5000 chars
                Analysis: JSON.stringify(analysis)
              }
            }]
          })
        });
      } catch (airtableError) {
        console.error('Airtable save failed:', airtableError);
        // Don't fail the request if Airtable save fails
      }
    }
    
    return res.status(200).json({
      success: true,
      analysis: analysis,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ 
      error: error.message,
      details: 'Failed to analyze marketing copy'
    });
  }
}
