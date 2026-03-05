const Anthropic = require('@anthropic-ai/sdk');

// ─── Fix generation config (from spec) ───────────────────────────────────────
const FIX_CONFIG = {
  misleading_claim: {
    fixType: 'misleading_claim',
    baseFine: 8000,
    scoreImpact: 12,
    severity: 'high',
    description: (issue, location) => `Fix misleading claim: "${issue}" (found in ${location})`,
    tool: 'AI'
  },
  fake_urgency: {
    fixType: 'fake_urgency',
    baseFine: 3000,
    scoreImpact: 10,
    severity: 'medium',
    description: (issue, location) => `Remove fake urgency: "${issue}" (found in ${location})`,
    tool: 'AI'
  },
  missing_unsubscribe: {
    fixType: 'missing_unsubscribe',
    baseFine: 12000,
    scoreImpact: 20,
    severity: 'critical',
    description: () => 'Add a clear unsubscribe/opt-out link to marketing content',
    tool: 'AI'
  },
  no_privacy_policy: {
    fixType: 'no_privacy_policy',
    baseFine: 1500,
    scoreImpact: 6,
    severity: 'medium',
    description: () => 'Add a link to your privacy policy in marketing content',
    tool: 'AI'
  },
  missing_address: {
    fixType: 'missing_address',
    baseFine: 2000,
    scoreImpact: 5,
    severity: 'low',
    description: () => 'Add a valid physical/registered address to marketing content',
    tool: 'AI'
  }
};

const SEVERITY_MULTIPLIERS = {
  critical: 1.5,
  high: 1.0,
  medium: 0.5,
  low: 0.25
};

// Map a violation from the AI response to a fix config key
function mapViolationToFixType(violation) {
  const issue = (violation.issue || '').toLowerCase();
  const regulation = (violation.regulation || '').toLowerCase();
  const recommendation = (violation.recommendation || '').toLowerCase();

  if (regulation.includes('pecr') && (issue.includes('unsubscribe') || issue.includes('opt-out') || recommendation.includes('unsubscribe'))) {
    return 'missing_unsubscribe';
  }
  if (issue.includes('urgency') || issue.includes('scarcity') || issue.includes('limited time') || issue.includes('hurry')) {
    return 'fake_urgency';
  }
  if (issue.includes('privacy policy') || recommendation.includes('privacy policy')) {
    return 'no_privacy_policy';
  }
  if (issue.includes('address') || recommendation.includes('address')) {
    return 'missing_address';
  }
  // Default: misleading claim for CAP/CMA/ASA violations
  if (regulation.includes('cap') || regulation.includes('asa') || regulation.includes('cma') || issue.includes('mislead') || issue.includes('false') || issue.includes('claim')) {
    return 'misleading_claim';
  }
  // Fallback for anything remaining
  return 'misleading_claim';
}

// Generate fix records to insert into Compliance_Fixes
function buildFixRecords(userId, violations) {
  const records = [];
  const seenTypes = new Set(); // avoid duplicate fix types in one scan

  for (const violation of violations) {
    const fixKey = mapViolationToFixType(violation);
    if (seenTypes.has(fixKey)) continue;
    seenTypes.add(fixKey);

    const config = FIX_CONFIG[fixKey];
    const severityMultiplier = SEVERITY_MULTIPLIERS[config.severity] || 1.0;
    const riskAmount = Math.round(config.baseFine * severityMultiplier);

    records.push({
      fields: {
        UserID: userId,
        FixType: config.fixType,
        Description: config.description(violation.issue || '', violation.location || 'content'),
        Tool: config.tool,
        Severity: config.severity,
        RiskAmount: riskAmount,
        ScoreImpact: config.scoreImpact,
        Status: 'pending',
        CreatedDate: new Date().toISOString().split('T')[0]
      }
    });
  }

  return records;
}

// Save fix records to Airtable Compliance_Fixes table
async function saveFixesToAirtable(userId, violations, airtableToken, baseId) {
  const records = buildFixRecords(userId, violations);
  if (records.length === 0) return;

  try {
    // Airtable allows max 10 records per request
    const chunks = [];
    for (let i = 0; i < records.length; i += 10) {
      chunks.push(records.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      const response = await fetch(`https://api.airtable.com/v0/${baseId}/Compliance_Fixes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${airtableToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ records: chunk })
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('Error saving fixes to Airtable:', err);
      }
    }
  } catch (err) {
    // Non-fatal — don't let fix saving break the main scan response
    console.error('Failed to save compliance fixes:', err);
  }
}

// ─── Main handler (original logic preserved) ─────────────────────────────────
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
        verdict: 'Analysis Error',
        violations: [],
        summary: responseText
      };
    }

    // FETCH RELEVANT VIOLATIONS FROM DATABASE (original logic)
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

    // SAVE TO AIRTABLE - AI_Compliance_Checks (original logic)
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

    // ── NEW: Generate compliance fixes from violations found ──────────────────
    if (violations.length > 0) {
      await saveFixesToAirtable(userId, violations, AIRTABLE_TOKEN, BASE_ID);
    }
    // ─────────────────────────────────────────────────────────────────────────

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
