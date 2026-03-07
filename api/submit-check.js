// submit-check.js
// Saves PECR questionnaire results to Airtable Submissions table
// and generates Compliance_Fixes for any critical issues found.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;

  if (!AIRTABLE_TOKEN || !BASE_ID) {
    return res.status(500).json({ error: 'Missing Airtable configuration' });
  }

  try {
    const {
      userId,
      campaignName,
      result,       // 'Send this Wizely' | 'STOP AND RE-THINK THIS CAMPAIGN' | 'Not Wize to send'
      score,        // 0–100
      channels,     // comma-separated string e.g. 'email, sms'
      audience,     // 'b2b' | 'b2c' | 'both'
      lawfulBasis,  // 'consent' | 'li' | 'public'
      issues        // semicolon-separated string of warning labels
    } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // ── 1. Save to Submissions table ──────────────────────────────────
    const submissionRecord = {
      fields: {
        UserID: userId,
        CampaignName: campaignName || 'Unnamed Campaign',
        SubmissionDate: new Date().toISOString().split('T')[0],
        Result: result || 'Unknown',
        Answers: JSON.stringify({
          audience,
          lawfulBasis,
          channels,
          score
        }),
        Recommendations: JSON.stringify(
          issues ? issues.split(';').map(i => i.trim()).filter(Boolean) : []
        )
      }
    };

    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/Submissions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(submissionRecord)
      }
    );

    if (!airtableRes.ok) {
      const err = await airtableRes.json();
      console.error('Airtable Submissions error:', err);
      throw new Error(`Airtable error: ${JSON.stringify(err)}`);
    }

    const saved = await airtableRes.json();
    const submissionId = saved.id;

    // ── 2. Generate fixes for critical issues ─────────────────────────
    // Map issue labels (from state.warnings in index.html) to fixType + description.
    // Only issues that map to a known fixType get a fix generated — warnings
    // that are advisory only (best-practice gaps) are skipped.

    const ISSUE_TO_FIX = {
      // Suppression / unsubscribe
      'No suppression list system':                    { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: No suppression list system in place. You must implement a suppression list and screen it before every campaign.' },
      'No suppression list screening (email)':         { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Suppression list not screened before email campaign.' },
      'No suppression list screening (calls)':         { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Suppression list not screened before telephone campaign.' },
      'No opt-out mechanism':                          { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: No opt-out mechanism included in marketing communications.' },
      'Opt-out is not free':                           { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Opt-out process is not free of charge — this is a PECR breach.' },
      'Opt-outs not processed within 30 days':         { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: Opt-out requests are not being actioned within 30 days.' },
      'Objectors not removed from mailing list':       { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: Previous objectors have not been removed from the mailing list.' },
      'No opt-out in every communication':             { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Opt-out not included in every marketing communication (soft opt-in condition).' },
      'No opt-out at point of collection':             { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: No opt-out was offered when contact details were first collected.' },

      // Missing address / sender ID
      'Caller ID withheld':                            { fixType: 'missing_address', severity: 'high', description: 'PECR Questionnaire: Telephone number withheld during marketing calls — must be displayed.' },
      'No identification info provided on call':       { fixType: 'missing_address', severity: 'high', description: 'PECR Questionnaire: Name and contact details not provided during marketing calls.' },
      'No ID info in automated call message':          { fixType: 'missing_address', severity: 'high', description: 'PECR Questionnaire: Automated call message does not include sender name and contact details.' },

      // No privacy policy / transparency
      'No privacy information provided':               { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: No privacy information provided to individuals — UK GDPR transparency requirement not met.' },
      'Privacy information incomplete':                { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Privacy information does not cover all required UK GDPR elements.' },
      'Privacy info not provided within one month':    { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Privacy information not provided within one month of indirect data collection.' },
      'Profiling not disclosed in privacy info':       { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Profiling activity not disclosed in privacy information.' },
      'Data enrichment not disclosed':                 { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Data enrichment from third parties not disclosed to individuals.' },

      // No DPA with processor
      'No Data Processing Agreement with processor':   { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: No written Data Processing Agreement with third-party sender — UK GDPR Article 28 breach.' },
      'No joint controller agreement':                 { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: No joint controller arrangement in place with social media platform or co-marketing partner.' },
      'No contracts for data cleansing services':      { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: No data processing contracts with data cleansing/suppression service providers.' },

      // Misleading / fake urgency / consent issues
      'Attempting to switch from consent to LI':       { fixType: 'misleading_claim', severity: 'high',   description: 'PECR Questionnaire: Attempting to switch lawful basis from consent to legitimate interests — this is not permitted.' },
      'Retrospective lawful basis attempted':          { fixType: 'misleading_claim', severity: 'high',   description: 'PECR Questionnaire: Attempting to retrospectively apply a lawful basis to previously unlawful processing.' },
      'Market research is actually marketing':         { fixType: 'misleading_claim', severity: 'high',   description: 'PECR Questionnaire: Market research contains promotional content — this constitutes direct marketing (sugging).' },
      'Promotional content in service message':        { fixType: 'misleading_claim', severity: 'medium', description: 'PECR Questionnaire: Service message contains promotional content — the entire message must be treated as direct marketing.' },

      // Consent not freely given
      'Consent not freely given':                      { fixType: 'misleading_claim', severity: 'high', description: 'PECR Questionnaire: Consent was not freely given — bundled, conditioned, or obtained via pre-ticked boxes.' },
      'Consent harder to withdraw than to give':       { fixType: 'missing_unsubscribe', severity: 'high', description: 'PECR Questionnaire: Withdrawing consent is harder than giving it — must be equalised.' },
      'PECR consent invalid':                          { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: PECR consent does not meet the required standard for electronic mail marketing.' },
      'No consent records maintained':                 { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: No records of consent maintained — accountability principle breach.' },

      // Third-party data
      'Third-party consent unusable for email':        { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Third-party consent cannot be used for email — does not specifically name your organisation.' },
      'Third-party consent over 6 months old':         { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: Third-party consent is over 6 months old and should not be used.' },
      'Third-party data due diligence incomplete':     { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: Due diligence on third-party data source not completed before use.' },
      'Third-party data provenance unverifiable':      { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: Cannot verify provenance of purchased/rented data — must not use.' },
      'Purchased email data lacks named consent':      { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Purchased email list lacks consent naming your organisation — cannot email individual subscribers.' },

      // Preference services
      'No TPS screening':                              { fixType: 'suppressed_contact', severity: 'high', description: 'PECR Questionnaire: TPS not screened before telephone marketing to individual subscribers.' },
      'No CTPS screening for B2B calls':               { fixType: 'suppressed_contact', severity: 'high', description: 'PECR Questionnaire: CTPS not screened before B2B telephone marketing.' },
      'No FPS screening':                              { fixType: 'suppressed_contact', severity: 'high', description: 'PECR Questionnaire: FPS not screened before fax marketing.' },
      'Preference service screening incomplete':       { fixType: 'suppressed_contact', severity: 'high', description: 'PECR Questionnaire: One or more required preference service screenings not completed.' },

      // Cookie / tracking
      'Cookie consent not obtained before placing':    { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Non-exempt cookies placed before PECR consent obtained.' },
      'Cookie consent mechanism non-compliant':        { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: Cookie consent mechanism does not meet PECR/ICO requirements.' },
      'No consent for tracking pixels':               { fixType: 'missing_unsubscribe', severity: 'high',     description: 'PECR Questionnaire: Tracking pixels in marketing emails used without PECR consent.' },

      // DPIA / documentation
      'DPIA screening not conducted':                  { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: No DPIA screening conducted — required for high-risk marketing processing.' },
      'Compliance decisions not documented':           { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Key compliance decisions not documented — UK GDPR accountability principle breach.' },
      'Staff not trained on PECR/GDPR':               { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Staff involved in direct marketing not trained on PECR and UK GDPR requirements.' },

      // International
      'International law compliance not verified':     { fixType: 'no_privacy_policy', severity: 'medium', description: 'PECR Questionnaire: Compliance with laws of recipient countries not verified for international marketing.' },
      'No international transfer mechanism':           { fixType: 'no_dpa', severity: 'high', description: 'PECR Questionnaire: No UK GDPR transfer mechanism for international data transfer — must be in place before sending.' },

      // Special category / children
      'Special category data without explicit consent': { fixType: 'misleading_claim', severity: 'high', description: 'PECR Questionnaire: Processing special category data for marketing without explicit consent.' },
      'Inferred special category data without consent': { fixType: 'misleading_claim', severity: 'high', description: 'PECR Questionnaire: Profiling may produce special category inferences — explicit consent required.' },
      'No right to object to profiling provided':      { fixType: 'missing_unsubscribe', severity: 'critical', description: 'PECR Questionnaire: Right to object to profiling for direct marketing not provided — this is an absolute right.' },

      // Viral / joint marketing
      'No recipient consent for viral/refer-a-friend': { fixType: 'missing_unsubscribe', severity: 'high', description: 'PECR Questionnaire: Acting as viral marketing instigator without consent from forwarded recipients.' },
    };

    // Parse the issues string and generate fixes
    const issueList = issues
      ? issues.split(';').map(i => i.trim()).filter(Boolean)
      : [];

    const fixResults = [];
    const VERCEL_URL = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://sendwize-backend.vercel.app';

    for (const issue of issueList) {
      const mapping = ISSUE_TO_FIX[issue];
      if (!mapping) continue; // advisory only — skip

      try {
        const fixRes = await fetch(`${VERCEL_URL}/api/generate-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            fixType: mapping.fixType,
            description: mapping.description,
            tool: 'PECR Questionnaire',
            severity: mapping.severity,
            volume: null,
            sourceRecordId: submissionId
          })
        });

        const fixData = await fixRes.json();
        if (fixData.skipped) {
          fixResults.push({ issue, status: 'duplicate_skipped' });
        } else {
          fixResults.push({ issue, status: 'created', fixId: fixData.id });
        }
      } catch (fixErr) {
        // Never let fix generation break the main save
        console.error(`generate-fix failed for issue "${issue}":`, fixErr);
        fixResults.push({ issue, status: 'error' });
      }
    }

    // ── 3. Return success ─────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      submissionId,
      campaignName: campaignName || 'Unnamed Campaign',
      result,
      score,
      issuesFound: issueList.length,
      fixesGenerated: fixResults.filter(f => f.status === 'created').length,
      fixResults
    });

  } catch (error) {
    console.error('submit-check error:', error);
    return res.status(500).json({ error: error.message });
  }
}
