// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js
// Checks vendor DPA compliance. For each vendor missing a DPA,
// fires a generate-fix call (no_dpa) to create a compliance fix.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { vendors, userId } = req.body;

    if (!vendors || !Array.isArray(vendors)) {
      return res.status(400).json({ error: 'Invalid vendors provided' });
    }

    console.log(`Checking ${vendors.length} vendors for user ${userId}`);

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const APP_URL = process.env.APP_URL || 'https://sendwize-backend.vercel.app';

    // Process each vendor
    const results = [];

    for (const vendor of vendors) {
      let result;
      if (vendor.isCustom) {
        result = await analyzeVendorWithAI(vendor.name);
      } else {
        result = await getKnownVendor(vendor);
      }
      results.push(result);
    }

    // Save to Airtable
    let sourceRecordId = null;
    if (userId) {
      try {
        const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Vendor_Checks`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID:        userId,
                CheckDate:     new Date().toISOString().split('T')[0],
                VendorsChecked: vendors.map(v => v.name).join(', '),
                VendorCount:   vendors.length,
                AverageScore:  Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length),
                Results:       JSON.stringify(results),
              },
            }],
          }),
        });
        const saveData = await saveRes.json();
        sourceRecordId = saveData.records?.[0]?.id || null;
        console.log('Saved vendor check to Airtable');
      } catch (e) {
        console.error('Airtable save failed:', e);
      }
    }

    // Fire generate-fix for each vendor missing a DPA
    if (userId) {
      for (const result of results) {
        const hasDpa = result.links?.dpa || result.details?.some(d => d.label === 'DPA Available' && d.status === 'pass');
        if (!hasDpa) {
          try {
            await fetch(`${APP_URL}/api/generate-fix`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId,
                fixType:        'no_dpa',
                description:    `No Data Processing Agreement found for ${result.name}. A DPA is required under UK GDPR Article 28 before sharing personal data with this processor.`,
                tool:           'Vendor Checker',
                severity:       'high',
                volume:         null,
                sourceRecordId,
              }),
            });
            console.log(`generate-fix (no_dpa) fired for vendor: ${result.name}`);
          } catch (e) {
            console.error(`generate-fix failed for ${result.name}:`, e);
          }
        }
      }
    }

    res.json({ results });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Vendor check failed' });
  }
}

async function getKnownVendor(vendor) {
  const details = [];

  // DPA
  if (vendor.dpaLink) {
    details.push({
      status: 'pass',
      label: 'DPA Available',
      description: 'Data Processing Agreement is publicly available',
    });
  } else {
    details.push({
      status: 'warning',
      label: 'DPA Not Found',
      description: 'Could not locate publicly available DPA',
    });
  }

  // Data Location
  const hasEU = /EU|UK|Europe/i.test(vendor.dataLocation);
  const hasUS = /US|USA|United States/i.test(vendor.dataLocation);

  if (hasEU && !hasUS) {
    details.push({
      status: 'pass',
      label: 'Data Location',
      description: `Data stored in: ${vendor.dataLocation}`,
    });
  } else if (hasUS) {
    details.push({
      status: 'warning',
      label: 'Data Location',
      description: `Data stored in: ${vendor.dataLocation}. Standard Contractual Clauses required.`,
    });
  } else {
    details.push({
      status: 'info',
      label: 'Data Location',
      description: vendor.dataLocation || 'Not specified',
    });
  }

  // Certifications
  if (vendor.certifications) {
    details.push({
      status: 'pass',
      label: 'Certifications',
      description: vendor.certifications,
    });
  }

  // Recent Breaches
  if (vendor.recentBreaches === 'No') {
    details.push({
      status: 'pass',
      label: 'Recent Breaches',
      description: 'No data breaches in last 24 months',
    });
  } else if (vendor.recentBreaches && vendor.recentBreaches !== 'No') {
    details.push({
      status: 'warning',
      label: 'Recent Breaches',
      description: vendor.recentBreaches,
    });
  }

  // Action items
  const actionItems = [];
  if (vendor.dpaLink) actionItems.push('Download and review Data Processing Agreement');
  if (hasUS)          actionItems.push('Ensure Standard Contractual Clauses are in place');
  if (vendor.notes)   actionItems.push(vendor.notes);

  return {
    name:        vendor.name,
    category:    vendor.category,
    score:       vendor.score || 75,
    isAI:        false,
    details,
    actionItems,
    links: {
      dpa:     vendor.dpaLink || null,
      privacy: null,
    },
  };
}

async function analyzeVendorWithAI(vendorName) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role:    'user',
          content: `Analyze the GDPR and PECR compliance of "${vendorName}" as a marketing vendor.

Respond ONLY with JSON (no markdown, no preamble):
{
  "score": <number 0-100>,
  "category": "<vendor type: Email Service Provider, CRM, Analytics, etc>",
  "details": [
    {"status": "pass|warning|info", "label": "Detail name", "description": "Description"},
    ...
  ],
  "actionItems": ["Action 1", "Action 2", ...],
  "dpaLink": "<URL if found, or null>",
  "dataLocation": "<where data is stored>"
}

Check their website for:
- DPA availability
- Data storage location
- GDPR compliance claims
- Certifications (ISO 27001, SOC 2, etc)

Be factual and conservative. If uncertain, say so.`,
        }],
      }),
    });

    if (!response.ok) throw new Error('Claude API call failed');

    const data      = await response.json();
    const text      = data.content[0].text;
    const cleanText = text.replace(/```json|```/g, '').trim();
    const analysis  = JSON.parse(cleanText);

    return {
      name:        vendorName,
      category:    analysis.category    || 'Marketing Tool',
      score:       analysis.score       || 70,
      isAI:        true,
      details:     analysis.details     || [],
      actionItems: analysis.actionItems || [],
      links: {
        dpa:     analysis.dpaLink || null,
        privacy: null,
      },
    };

  } catch (error) {
    console.error('AI analysis failed:', error);
    return {
      name:     vendorName,
      category: 'Marketing Tool',
      score:    50,
      isAI:     true,
      details: [{
        status:      'warning',
        label:       'Analysis Incomplete',
        description: 'Unable to fully analyze this vendor automatically. Please verify compliance manually with the vendor.',
      }],
      actionItems: [
        'Contact vendor for Data Processing Agreement',
        'Verify GDPR compliance claims',
        'Confirm data storage location',
      ],
      links: { dpa: null, privacy: null },
    };
  }
}
