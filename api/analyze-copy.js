// analyze-copy.js
// Unified marketing compliance checker.
// MODE A — Email scan:    POST { subject, html, userId, autoFix? }
// MODE B — Copy check:    POST { content, userId, autoFix? }
// MODE C — Combined:      POST { content, subject, html, userId, autoFix? }
//
// Runs deterministic PECR/deliverability checks (from email scanner) and
// deep AI analysis (CAP Code, CMA, GDPR) then generates Compliance_Fixes
// via generate-fix.js for any violations found.

import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SCANNER — deterministic rule checks
// Returns { checks[], emailScore, summary }
// ─────────────────────────────────────────────────────────────────────────────

function runEmailChecks(subject, html) {
  const checks = [];
  let score = 100;

  // ── CRITICAL CHECKS ───────────────────────────────────────────────

  const hasUnsubscribe = /unsubscribe|opt-out|opt out/i.test(html);
  const unsubLink = html.match(/<a[^>]*href=["']([^"']*unsubscribe[^"']*)["']/i);
  const unsubBroken = unsubLink && (unsubLink[1] === '#' || unsubLink[1].startsWith('javascript'));

  if (!hasUnsubscribe) {
    checks.push({ status: 'fail', title: 'No Unsubscribe Link', description: 'PECR Regulation 22 requires a clear unsubscribe mechanism. Add an unsubscribe link immediately.', fixType: 'missing_unsubscribe' });
    score -= 10;
  } else if (unsubBroken) {
    checks.push({ status: 'fail', title: 'Broken Unsubscribe Link', description: 'Unsubscribe link goes nowhere. This violates PECR and traps users.', fixType: 'missing_unsubscribe' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Unsubscribe Link Present', description: 'Valid unsubscribe mechanism found.' });
  }

  const ukPostcode = /[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}/i.test(html);
  const hasAddress = /address|registered office/i.test(html);
  if (!ukPostcode && !hasAddress) {
    checks.push({ status: 'fail', title: 'No Postal Address', description: 'PECR requires a company postal address. Add your registered address to the email footer.', fixType: 'missing_address' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Postal Address Found', description: 'Company address included.' });
  }

  if (!/privacy|data protection|gdpr/i.test(html)) {
    checks.push({ status: 'warning', title: 'No Privacy Policy Link', description: 'Best practice: link to your privacy policy to show transparency.', fixType: 'no_privacy_policy' });
    score -= 5;
  } else {
    checks.push({ status: 'pass', title: 'Privacy Policy Linked', description: 'Privacy information provided.' });
  }

  if (!/<html/i.test(html) || !/<body/i.test(html)) {
    checks.push({ status: 'fail', title: 'Invalid HTML Structure', description: 'Missing basic HTML tags. Email may not render correctly.' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Valid HTML Structure', description: 'Proper HTML document structure.' });
  }

  // ── SUBJECT LINE CHECKS ───────────────────────────────────────────

  if (subject) {
    const spamWords = ['free', 'winner', 'claim', 'act now', 'urgent', 'limited time', 'click here', 'buy now', 'guarantee', 'cash', '$$$', '100%', 'risk-free', 'no obligation', 'order now'];
    const foundSpamWords = spamWords.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(subject));

    if (foundSpamWords.length > 2) {
      checks.push({ status: 'fail', title: 'High Spam Score in Subject', description: `Found ${foundSpamWords.length} spam trigger words: ${foundSpamWords.join(', ')}. Remove these.` });
      score -= 10;
    } else if (foundSpamWords.length > 0) {
      checks.push({ status: 'warning', title: 'Spam Words in Subject', description: `Found: ${foundSpamWords.join(', ')}. Consider rewording.` });
      score -= 5;
    } else {
      checks.push({ status: 'pass', title: 'Clean Subject Line', description: 'No obvious spam trigger words detected.' });
    }

    const capsCount  = (subject.match(/[A-Z]/g) || []).length;
    const totalChars = subject.replace(/\s/g, '').length;
    if (totalChars > 0 && (capsCount / totalChars) * 100 > 50) {
      checks.push({ status: 'warning', title: 'Excessive Caps in Subject', description: 'More than 50% uppercase triggers spam filters.' });
      score -= 5;
    }
    if (/[!?]{2,}/.test(subject)) {
      checks.push({ status: 'warning', title: 'Excessive Punctuation', description: 'Multiple exclamation/question marks look spammy.' });
      score -= 3;
    }
    if (subject.length > 70) {
      checks.push({ status: 'warning', title: 'Subject Line Too Long', description: `${subject.length} characters. Mobile devices truncate at ~40 chars.` });
      score -= 3;
    } else if (subject.length < 20) {
      checks.push({ status: 'warning', title: 'Subject Line Too Short', description: 'Very short subjects underperform. Aim for 40–50 characters.' });
      score -= 2;
    }
  }

  // ── EMAIL BODY CHECKS ─────────────────────────────────────────────

  const textContent = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const imageCount  = (html.match(/<img/gi) || []).length;

  if (imageCount > 0 && textContent.length < 100) {
    checks.push({ status: 'fail', title: 'Image-Only Email', description: 'Less than 100 chars of text. Spam filters block image-only emails.' });
    score -= 10;
  } else if (imageCount > textContent.length / 50) {
    checks.push({ status: 'warning', title: 'Low Text-to-Image Ratio', description: 'Too many images vs text. Aim for 60% text, 40% images.' });
    score -= 5;
  }

  const imagesWithoutAlt = (html.match(/<img(?![^>]*alt=)/gi) || []).length;
  if (imagesWithoutAlt > 0) {
    checks.push({ status: 'warning', title: 'Missing Alt Text on Images', description: `${imagesWithoutAlt} image(s) missing alt text. Required for accessibility.` });
    score -= 5;
  }

  const allLinks   = html.match(/<a[^>]*href=["']([^"']*)["']/gi) || [];
  const httpLinks  = allLinks.filter(l => /href=["']http:/i.test(l));
  const shortLinks = allLinks.filter(l => /bit\.ly|tinyurl|t\.co/i.test(l));

  if (httpLinks.length > 0)  { checks.push({ status: 'warning', title: 'Insecure HTTP Links',     description: `${httpLinks.length} link(s) use HTTP. Switch to HTTPS.` });         score -= 5; }
  if (shortLinks.length > 0) { checks.push({ status: 'warning', title: 'URL Shorteners Detected', description: 'Shortened URLs trigger spam filters. Use full URLs.' });             score -= 3; }
  if (allLinks.length > 15)  { checks.push({ status: 'warning', title: 'Too Many Links',           description: `${allLinks.length} links found. Focus on 1–3 main CTAs.` });       score -= 5; }

  if (/display:\s*none|visibility:\s*hidden|font-size:\s*0/i.test(html)) {
    checks.push({ status: 'fail', title: 'Hidden Text Detected', description: 'CSS hiding text is a spam technique.' }); score -= 10;
  }
  if (/<script/i.test(html)) {
    checks.push({ status: 'fail', title: 'JavaScript in Email', description: 'Email clients block JavaScript. Remove all <script> tags.' }); score -= 10;
  }
  if (/<form/i.test(html)) {
    checks.push({ status: 'warning', title: 'Form in Email', description: 'Most email clients do not support forms. Link to a landing page instead.' }); score -= 5;
  }

  // ── COMPLIANCE CHECKS ─────────────────────────────────────────────

  if (subject && /\bfree\b/i.test(subject) && !/terms|conditions|t&c/i.test(html)) {
    checks.push({ status: 'warning', title: '"Free" Claim Without T&Cs', description: 'ASA CAP Code requires terms when claiming "free".', fixType: 'misleading_claim' }); score -= 5;
  }
  if (/limited time|ends soon|last chance|today only/i.test(html) &&
      !/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(html)) {
    checks.push({ status: 'warning', title: 'Vague Time Limit', description: 'CAP Code 3.7: "limited time" must specify an exact end date.', fixType: 'fake_urgency' }); score -= 5;
  }
  if (/limited stock|while supplies last|only \d+ left/i.test(html)) {
    checks.push({ status: 'warning', title: 'Limited Stock Claim', description: 'Must be able to prove stock levels if challenged.', fixType: 'misleading_claim' }); score -= 3;
  }

  // ── BEST PRACTICES ────────────────────────────────────────────────

  if (!/<meta[^>]*viewport/i.test(html)) {
    checks.push({ status: 'warning', title: 'Not Mobile Optimised', description: 'Missing viewport meta tag. 60%+ of emails open on mobile.' }); score -= 3;
  }

  const emailSize = Buffer.byteLength(html, 'utf8');
  if (emailSize > 102000) {
    checks.push({ status: 'warning', title: 'Email Too Large', description: `${Math.round(emailSize / 1000)}KB. Gmail clips emails over 102KB.` }); score -= 5;
  }

  if (/\{\{|\[\[|lorem ipsum/i.test(html) || /\btest\b|\bdraft\b|\btodo\b/i.test(html)) {
    checks.push({ status: 'fail', title: 'Template Placeholders Found', description: 'Unfinished template detected. Replace all placeholders before sending.' }); score -= 10;
  }

  return {
    checks,
    emailScore: Math.max(0, Math.min(100, score)),
    summary: {
      passed:   checks.filter(c => c.status === 'pass').length,
      warnings: checks.filter(c => c.status === 'warning').length,
      failed:   checks.filter(c => c.status === 'fail').length
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX TYPE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

function mapViolationToFixType(violation) {
  const issue          = (violation.issue          || '').toLowerCase();
  const regulation     = (violation.regulation     || '').toLowerCase();
  const recommendation = (violation.recommendation || '').toLowerCase();

  if ((regulation.includes('pecr') || regulation.includes('gdpr')) &&
      (issue.includes('unsubscribe') || issue.includes('opt-out') || recommendation.includes('unsubscribe')))
    return 'missing_unsubscribe';
  if (issue.includes('urgency') || issue.includes('scarcity') || issue.includes('limited time') || issue.includes('hurry'))
    return 'fake_urgency';
  if (issue.includes('privacy policy') || recommendation.includes('privacy policy'))
    return 'no_privacy_policy';
  if (issue.includes('address') || recommendation.includes('address'))
    return 'missing_address';
  if (regulation.includes('cap') || regulation.includes('asa') || regulation.includes('cma') ||
      issue.includes('mislead') || issue.includes('false') || issue.includes('claim'))
    return 'misleading_claim';
  return 'misleading_claim';
}

function mapViolationToSeverity(v) {
  const s = (v.severity || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high')     return 'high';
  if (s === 'medium')   return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE FIXES
// ─────────────────────────────────────────────────────────────────────────────

async function generateFixes(userId, aiViolations, emailChecks, sourceRecordId, vercelUrl) {
  const seenTypes = new Set();
  const fixJobs   = [];

  for (const v of (aiViolations || [])) {
    const fixType = mapViolationToFixType(v);
    if (seenTypes.has(fixType)) continue;
    seenTypes.add(fixType);
    fixJobs.push({
      fixType,
      description: `AI Checker: ${v.issue || 'Compliance issue'} (${v.location || 'content'}) — ${v.recommendation || 'Review required'}`,
      severity: mapViolationToSeverity(v)
    });
  }

  for (const c of (emailChecks || [])) {
    if (!c.fixType || c.status === 'pass') continue;
    if (seenTypes.has(c.fixType)) continue;
    seenTypes.add(c.fixType);
    fixJobs.push({
      fixType:     c.fixType,
      description: `Email Scanner: ${c.title} — ${c.description}`,
      severity:    c.status === 'fail' ? 'high' : 'medium'
    });
  }

  for (const job of fixJobs) {
    try {
      const r = await fetch(`${vercelUrl}/api/generate-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: job.fixType, description: job.description, tool: 'AI Checker', severity: job.severity, volume: null, sourceRecordId })
      });
      const d = await r.json();
      if (d.skipped) console.log(`generate-fix duplicate skipped: ${job.fixType}`);
    } catch (err) {
      console.error(`generate-fix failed for "${job.fixType}":`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const APP_URL = process.env.APP_URL || 'https://sendwize-backend.vercel.app';

  try {
    const { content, subject, html, userId, autoFix } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!content && !html) return res.status(400).json({ error: 'Provide content (copy check) or html (email scan)' });

    // ── 1. Deterministic email checks ─────────────────────────────────
    const emailResult = html ? runEmailChecks(subject || '', html) : null;

    // ── 2. AI analysis ────────────────────────────────────────────────
    const analysisContent = content || (html
      ? `Subject: ${subject || '(none)'}\n\nEmail body:\n${html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`
      : null);

    let aiAnalysis = null;

    if (analysisContent) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const prompt = `You are a UK marketing compliance expert checking for PECR, UK GDPR, ASA CAP Code, and CMA violations.

Analyse this marketing content and:
1. Identify ALL compliance violations
2. Assign a risk score (0–100, where 100 = fully compliant)
3. Categorise each violation by regulation
${autoFix ? '4. Generate a compliant rewrite that fixes ALL violations' : ''}

PECR: Consent required, must include opt-out, sender identity and address.
ASA CAP Code: No misleading claims (3.1), time limits need end date (3.7), "free" needs no hidden cost (3.9), comparisons must be verifiable (3.11).
CMA: No false scarcity or fake urgency without basis, no hidden costs.
UK GDPR: Explain data usage, link privacy policy, state lawful basis.

CONTENT TO ANALYSE:
${analysisContent}

Respond ONLY in this exact JSON format — no preamble, no markdown fences:
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
  ${autoFix ? '"fixedVersion": "REWRITTEN COMPLIANT VERSION HERE",' : ''}
  "summary": "Brief assessment"
}`;

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      try {
        const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
        aiAnalysis = JSON.parse(jsonMatch ? jsonMatch[0] : message.content[0].text);
      } catch {
        aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: message.content[0].text };
      }
    }

    const violations = aiAnalysis?.violations || [];

    // ── 3. Fetch related enforcement cases ────────────────────────────
    const relatedCases = [];
    if (violations.length > 0) {
      try {
        const v = violations[0];
        let violationType = '';
        if (v.regulation.includes('PECR'))                                                        violationType = 'Unsolicited Marketing';
        else if (v.issue.toLowerCase().includes('price') || v.issue.toLowerCase().includes('cost')) violationType = 'Misleading Pricing';
        else if (v.issue.toLowerCase().includes('urgency') || v.issue.toLowerCase().includes('scarcity')) violationType = 'Misleading Urgency';
        else if (v.regulation.includes('CAP') || v.regulation.includes('ASA'))                    violationType = 'Misleading Advertising';

        if (violationType) {
          const dbRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/Violation_Database?filterByFormula={ViolationType}='${encodeURIComponent(violationType)}'&maxRecords=5&sort[0][field]=FineAmount&sort[0][direction]=desc`,
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
          );
          if (dbRes.ok) relatedCases.push(...((await dbRes.json()).records || []));
        }
      } catch (err) { console.error('Violation_Database fetch error:', err); }
    }

    // ── 4. Save to AI_Compliance_Checks ───────────────────────────────
    let savedRecordId = null;
    try {
      const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:       userId,
              CheckDate:    new Date().toISOString().split('T')[0],
              FileName:     subject ? `Email: ${subject}` : 'Marketing Content',
              RiskScore:    aiAnalysis?.score ?? (emailResult?.emailScore ?? 0),
              Verdict:      aiAnalysis?.verdict ?? `Email scan: ${emailResult?.summary.failed ?? 0} failures`,
              Violations:   JSON.stringify(violations),
              FixedVersion: aiAnalysis?.fixedVersion || '',
              RelatedCases: JSON.stringify(relatedCases.map(c => ({ company: c.fields.CompanyName, fine: c.fields.FineAmount, violation: c.fields.Violation }))),
              Results:      JSON.stringify({ aiAnalysis, emailScan: emailResult })
            }
          }]
        })
      });
      if (saveRes.ok) {
        const saved = await saveRes.json();
        savedRecordId = saved.records?.[0]?.id || null;
      }
    } catch (err) { console.error('AI_Compliance_Checks save error:', err); }

    // ── 5. Generate Compliance_Fixes ──────────────────────────────────
    if (violations.length > 0 || emailResult?.checks.some(c => c.fixType)) {
      await generateFixes(userId, violations, emailResult?.checks || [], savedRecordId, APP_URL);
    }

    // ── 5a. Update compliance streak ──────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    // ── 6. Return unified response ────────────────────────────────────
    return res.status(200).json({
      ...(aiAnalysis || {}),
      ...(emailResult ? { emailScore: emailResult.emailScore, checks: emailResult.checks, checksSummary: emailResult.summary } : {}),
      relatedCases: relatedCases.map(c => ({
        company: c.fields.CompanyName, violation: c.fields.Violation,
        fine: c.fields.FineAmount, regulator: c.fields.Regulator,
        date: c.fields.DateOfAction, description: c.fields.Description
      }))
    });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: error.message });
  }
}
