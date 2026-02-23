// api/analyze-competitor.js
// Analyze competitor marketing for ASA/PECR violations

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
      competitorContent, 
      competitorName,
      contentSource,
      userId 
    } = req.body;
    
    if (!competitorContent) {
      return res.status(400).json({ error: 'Competitor content required' });
    }
    
    // Specialized prompt for competitor analysis
    const competitorPrompt = `You are a UK advertising compliance analyst reviewing publicly available marketing materials.

DISCLAIMER: This analysis is for informational purposes only. Users should verify findings and consult legal counsel before taking action.

Analyze this publicly available marketing content${competitorName ? ` from ${competitorName}` : ''} for potential ASA/PECR violations:

SOURCE: ${contentSource || 'Not specified'}
CONTENT:
"""
${competitorContent}
"""

Provide analysis in JSON format:
{
  "complianceScore": <number 0-100>,
  "overallAssessment": "<COMPLIANT|POTENTIAL ISSUES|LIKELY VIOLATIONS>",
  "potentialViolations": [
    {
      "type": "<ASA CAP Code|PECR|GDPR|Other>",
      "regulation": "<specific regulation number>",
      "issue": "<what appears to violate>",
      "evidence": "<quote from content>",
      "reasoning": "<why this may be a violation>",
      "severity": "<HIGH|MEDIUM|LOW>",
      "recentPrecedent": "<any recent ASA rulings on similar issues>"
    }
  ],
  "complianceStrengths": [
    "<what they did right>"
  ],
  "recommendations": {
    "shouldReport": <true|false>,
    "reasoning": "<why or why not to report>",
    "reportingBody": "<ASA|ICO|Other or null>"
  },
  "disclaimer": "This analysis is based on publicly available content and does not constitute legal advice. Consult a solicitor before taking action."
}

Be objective, cite specific regulations, and note any uncertainty. Focus on clear violations, not minor style issues.`;

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
          content: competitorPrompt
        }]
      })
    });
    
    if (!claudeResponse.ok) {
      const error = await claudeResponse.json();
      throw new Error(`Claude API error: ${JSON.stringify(error)}`);
    }
    
    const claudeData = await claudeResponse.json();
    const analysisText = claudeData.content[0].text;
    
    // Parse JSON response
    let analysis;
    try {
      const cleanText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanText);
    } catch (parseError) {
      analysis = {
        complianceScore: 50,
        overallAssessment: 'REVIEW NEEDED',
        rawAnalysis: analysisText
      };
    }
    
    // Save to Airtable
    if (userId) {
      try {
        const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
        const BASE_ID = process.env.BASE_ID;
        const COMPETITOR_TABLE = process.env.COMPETITOR_CHECKS_TABLE || 'Competitor_Analysis';
        
        await fetch(`https://api.airtable.com/v0/${BASE_ID}/${COMPETITOR_TABLE}`, {
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
                CompetitorName: competitorName || 'Unknown',
                ContentSource: contentSource || 'Not specified',
                ComplianceScore: analysis.complianceScore,
                Assessment: analysis.overallAssessment,
                ViolationsFound: analysis.potentialViolations?.length || 0,
                ShouldReport: analysis.recommendations?.shouldReport || false,
                Content: competitorContent.substring(0, 5000),
                Analysis: JSON.stringify(analysis)
              }
            }]
          })
        });
      } catch (airtableError) {
        console.error('Airtable save failed:', airtableError);
      }
    }
    
    return res.status(200).json({
      success: true,
      analysis: analysis,
      timestamp: new Date().toISOString(),
      disclaimer: 'This analysis is for informational purposes only and does not constitute legal advice.'
    });
    
  } catch (error) {
    console.error('Competitor analysis error:', error);
    return res.status(500).json({ 
      error: error.message,
      details: 'Failed to analyze competitor content'
    });
  }
}
