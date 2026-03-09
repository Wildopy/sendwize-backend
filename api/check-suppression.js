// check-suppression.js
// Checks a send list against a suppression list before a campaign send.
// PECR Regulation 22 — you must not send marketing to contacts who have
// previously unsubscribed or opted out. ICO guidance requires suppression
// lists to be maintained and checked before every send.
//
// Returns: matches, duplicates, invalid emails, role-based emails,
//          PECR risk score, financial exposure, warnings, clean list.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sendList, suppressionList, userId, suppressionListAge } = req.body;
    // suppressionListAge: 'current' | '6months' | '1year' | '2years+' | 'unknown'

    if (!sendList || !suppressionList || !Array.isArray(sendList) || !Array.isArray(suppressionList)) {
      return res.status(400).json({ error: 'sendList and suppressionList arrays are required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // ── Normalise ─────────────────────────────────────────────────────
    const normSend        = sendList.map(e => String(e).toLowerCase().trim()).filter(Boolean);
    const normSuppression = suppressionList.map(e => String(e).toLowerCase().trim()).filter(Boolean);
    const suppressionSet  = new Set(normSuppression);

    // ── Core checks ───────────────────────────────────────────────────

    // 1. Suppression matches — PECR Reg 22 violation if sent to
    const matches = normSend.filter(e => suppressionSet.has(e));

    // 2. Duplicates in send list
    const seenSend      = new Set();
    const duplicateSet  = new Set();
    normSend.forEach(e => { if (seenSend.has(e)) duplicateSet.add(e); else seenSend.add(e); });
    const duplicates    = [...duplicateSet];

    // 3. Invalid email syntax — will hard bounce; ICO expects these removed
    const invalidEmails = normSend.filter(e => !emailRegex.test(e));

    // 4. Role-based emails — corporate subscribers under PECR Reg 22
    //    Different rules apply: no individual consent needed for B2B
    //    corporate addresses, but still need opt-out mechanism
    const rolePattern = /^(info|sales|admin|support|contact|hello|help|service|team|marketing|hr|office|reception|accounts|enquiries|enquiry|noreply|no-reply|postmaster|webmaster|press|media|legal|compliance|finance|procurement)@/i;
    const roleEmails  = normSend.filter(e => rolePattern.test(e));

    // 5. Suppression list health checks
    const suppressionTooSmall = normSuppression.length < Math.max(1, normSend.length * 0.005);
    // ICO expects suppression lists to grow over time — a list smaller than
    // 0.5% of send volume is suspicious and suggests unsubscribes aren't being recorded

    const suppressionListStale = ['2years+', 'unknown'].includes(suppressionListAge);
    const suppressionListAged  = suppressionListAge === '1year';

    // ── Clean list ────────────────────────────────────────────────────
    const toRemove  = new Set([...matches, ...duplicates, ...invalidEmails]);
    const cleanList = normSend.filter((e, idx, arr) =>
      !toRemove.has(e) && arr.indexOf(e) === idx && emailRegex.test(e)
    );

    // ── PECR Risk Score (0–100, 100 = fully compliant) ────────────────
    let score = 100;

    // Suppression matches are the most serious — direct PECR Reg 22 breach
    if (matches.length > 0) {
      const matchPct = matches.length / normSend.length;
      if (matchPct >= 0.05)       score -= 40;  // 5%+ matches = critical
      else if (matchPct >= 0.01)  score -= 25;  // 1–5% = high
      else                        score -= 15;  // <1% = medium
    }

    // Stale suppression list — systemic risk
    if (suppressionListStale)  score -= 20;
    else if (suppressionListAged) score -= 10;

    // Suspiciously small suppression list
    if (suppressionTooSmall && normSuppression.length > 0) score -= 15;
    if (normSuppression.length === 0) score -= 25;  // No suppression list at all

    // Invalid emails — hard bounces damage sender rep and suggest poor list hygiene
    if (invalidEmails.length > 0) {
      score -= Math.min(10, Math.round(invalidEmails.length / normSend.length * 100));
    }

    // Duplicates
    if (duplicates.length > 0) score -= 5;

    score = Math.max(0, Math.min(100, score));

    // ── Financial Exposure ────────────────────────────────────────────
    // Based on suppressed_contact fix type: £200/contact low, £1,000/contact high
    // Only applies to suppression matches — those are the actionable PECR breach
    // ICO fines are per-campaign, not per-contact, but exposure scales with volume
    const exposureLow  = matches.length * 200;
    const exposureHigh = matches.length * 1000;

    // Additional exposure if suppression list is stale/missing —
    // unknown historical matches compound the risk
    const historicalRiskMultiplier = suppressionListStale ? 3 : suppressionListAged ? 1.5 : 1;
    const adjustedExposureLow  = Math.round(exposureLow  * historicalRiskMultiplier);
    const adjustedExposureHigh = Math.round(exposureHigh * historicalRiskMultiplier);

    // ── Warnings ──────────────────────────────────────────────────────
    const warnings = [];

    if (matches.length > 0) {
      warnings.push({
        severity: 'critical',
        regulation: 'PECR Regulation 22',
        message: `${matches.length} contact${matches.length !== 1 ? 's' : ''} on your send list ${matches.length !== 1 ? 'have' : 'has'} previously opted out. Sending to ${matches.length !== 1 ? 'these contacts' : 'this contact'} is a direct PECR violation. The ICO can issue fines up to £500,000 and enforcement notices for repeated breaches.`,
        action: 'Remove all suppressed contacts before sending. Do not send.'
      });
    }

    if (normSuppression.length === 0) {
      warnings.push({
        severity: 'critical',
        regulation: 'PECR Regulation 22 / ICO Guidance',
        message: 'You have not provided a suppression list. ICO guidance requires all organisations sending marketing emails to maintain and actively use a suppression list. The absence of a suppression list suggests unsubscribes may not be being recorded — a systemic compliance failure.',
        action: 'Build a suppression list immediately from all unsubscribe requests and hard bounces received to date.'
      });
    }

    if (suppressionTooSmall && normSuppression.length > 0) {
      warnings.push({
        severity: 'high',
        regulation: 'ICO Guidance — Suppression List Maintenance',
        message: `Your suppression list (${normSuppression.length} contacts) appears very small relative to your send volume (${normSend.length} contacts). A healthy suppression list typically represents at least 0.5–2% of your total audience. This may indicate unsubscribes and opt-outs are not being reliably recorded.`,
        action: 'Audit your unsubscribe process. Ensure all opt-outs, complaints and hard bounces are automatically added to your suppression list.'
      });
    }

    if (suppressionListStale) {
      warnings.push({
        severity: 'high',
        regulation: 'ICO Guidance — Data Accuracy (UK GDPR Article 5(1)(d))',
        message: `Your suppression list is ${suppressionListAge === 'unknown' ? 'of unknown age' : '2+ years old'}. ICO guidance requires suppression lists to be kept current. Stale suppression lists miss recent opt-outs, increasing your legal exposure significantly.`,
        action: 'Merge your suppression list with recent unsubscribes from your ESP, CRM and any manual opt-out requests.'
      });
    } else if (suppressionListAged) {
      warnings.push({
        severity: 'medium',
        regulation: 'ICO Guidance — Suppression List Maintenance',
        message: 'Your suppression list is approximately 1 year old. Ensure it has been updated with all unsubscribes and opt-outs received in the last 12 months.',
        action: 'Cross-reference with your ESP\'s unsubscribe report before sending.'
      });
    }

    if (invalidEmails.length > 0) {
      warnings.push({
        severity: 'medium',
        regulation: 'ICO Guidance — Data Accuracy (UK GDPR Article 5(1)(d))',
        message: `${invalidEmails.length} email${invalidEmails.length !== 1 ? 's' : ''} have invalid syntax. These will hard bounce. Under UK GDPR, you are required to keep personal data accurate. Hard bounces that are not removed and suppressed can also indicate purchased or poorly collected lists.`,
        action: 'Remove invalid emails and add them to your suppression list to prevent future sends.'
      });
    }

    if (duplicates.length > 0) {
      warnings.push({
        severity: 'low',
        regulation: 'Best Practice',
        message: `${duplicates.length} duplicate email${duplicates.length !== 1 ? 's' : ''} found. Sending duplicates means contacts receive the same email multiple times, which increases unsubscribe rates and spam complaints.`,
        action: 'Deduplicate your send list before importing to your ESP.'
      });
    }

    if (roleEmails.length > 0) {
      warnings.push({
        severity: 'info',
        regulation: 'PECR Regulation 22 — Corporate Subscribers',
        message: `${roleEmails.length} role-based email${roleEmails.length !== 1 ? 's' : ''} detected (e.g. info@, sales@, admin@). Under PECR, these are corporate subscriber addresses — individual consent is not required, but you must still provide a clear opt-out mechanism and honour opt-out requests promptly.`,
        action: 'Ensure your unsubscribe mechanism applies to role-based addresses and that opt-outs are recorded against the domain, not just the individual.'
      });
    }

    // ── Build analysis object ─────────────────────────────────────────
    const analysis = {
      sendListCount:       normSend.length,
      suppressionListCount: normSuppression.length,
      matchCount:          matches.length,
      matches:             matches,
      duplicateCount:      duplicates.length,
      duplicates:          duplicates.slice(0, 20),
      invalidCount:        invalidEmails.length,
      invalidEmails:       invalidEmails.slice(0, 10),
      roleEmailCount:      roleEmails.length,
      roleEmails:          roleEmails.slice(0, 10),
      cleanListCount:      cleanList.length,
      cleanList,
      removedCount:        normSend.length - cleanList.length,
      suppressionHealth: {
        tooSmall:  suppressionTooSmall,
        stale:     suppressionListStale,
        aged:      suppressionListAged,
        listAge:   suppressionListAge || 'not provided'
      }
    };

    // ── Verdict ────────────────────────────────────────────────────────
    const isClean = matches.length === 0 && duplicates.length === 0 && invalidEmails.length === 0;
    const recommendation = isClean && !suppressionTooSmall && !suppressionListStale
      ? 'Your send list is clean and your suppression list looks healthy. Safe to proceed.'
      : matches.length > 0
        ? `Do not send. Remove ${matches.length} suppressed contact${matches.length !== 1 ? 's' : ''} immediately — sending to ${matches.length !== 1 ? 'them' : 'this contact'} is a PECR violation.`
        : `Clean your list before sending. Remove ${analysis.removedCount} problematic email${analysis.removedCount !== 1 ? 's' : ''} and review suppression list health warnings above.`;

    // ── Save to Airtable ──────────────────────────────────────────────
    if (userId) {
      try {
        await fetch(`https://api.airtable.com/v0/${BASE_ID}/Suppression_Checks`, {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID:               userId,
                CheckDate:            new Date().toISOString().split('T')[0],
                SendListSize:         analysis.sendListCount,
                SuppressionListSize:  analysis.suppressionListCount,
                MatchesFound:         analysis.matchCount,
                DuplicatesFound:      analysis.duplicateCount,
                InvalidEmailsFound:   analysis.invalidCount,
                CleanListSize:        analysis.cleanListCount,
                RiskScore:            score,
                ExposureLow:          adjustedExposureLow,
                ExposureHigh:         adjustedExposureHigh,
                Results:              JSON.stringify(analysis)
              }
            }]
          })
        });
      } catch (e) {
        console.error('Suppression_Checks Airtable save failed:', e);
      }
    }

    // ── Fire generate-fix for suppressed contacts ─────────────────────
    const VERCEL_URL = process.env.APP_URL || 'https://sendwize-backend.vercel.app';

    if (userId && matches.length > 0) {
      try {
        await fetch(`${VERCEL_URL}/api/generate-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            fixType:     'suppressed_contact',
            description: `Suppression Check: ${matches.length} contact${matches.length !== 1 ? 's' : ''} found on send list who have previously opted out. Sending to ${matches.length !== 1 ? 'these contacts' : 'this contact'} violates PECR Regulation 22.`,
            tool:        'Suppression Checker',
            severity:    'critical',
            volume:      matches.length,
            sourceRecordId: null
          })
        });
      } catch (e) {
        console.error('generate-fix (suppressed_contact) failed:', e);
      }
    }

    // ── Response ──────────────────────────────────────────────────────
    return res.status(200).json({
      ...analysis,
      score,
      exposureLow:  adjustedExposureLow,
      exposureHigh: adjustedExposureHigh,
      warnings,
      recommendation,
      isClean
    });

  } catch (error) {
    console.error('check-suppression error:', error);
    return res.status(500).json({ error: 'Suppression check failed' });
  }
}
