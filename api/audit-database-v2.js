// audit-database-v2.js
// Audits a contact database for PECR consent compliance.
// Categorises contacts as safe / probably / risky / danger.
// Generates Compliance_Fixes via generate-fix.js for issues found.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contacts, customerType, productType, emailType, userId } = req.body;

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const VERCEL_URL     = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://sendwize-backend.vercel.app';

    const consumerDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'me.com', 'googlemail.com'];
    const today = new Date();

    const results = {
      total:          contacts.length,
      safe:           [],
      probably:       [],
      risky:          [],
      danger:         [],
      expiryTimeline: { labels: [], data: [] },
      sourceQuality:  []
    };

    // ── Track issue counts for fix generation ─────────────────────────
    // These accumulate as we scan contacts so we can pass accurate volumes
    const issueVolumes = {
      expiredConsent:    0,   // contacts in risky/danger due to age → expired_consent fix
      invalidConsent:    0,   // pre-ticked / invalid method → suppressed_contact fix
      purchasedList:     0,   // purchased/broker source → suppressed_contact fix
      noConsentDate:     0,   // no consent date at all → suppressed_contact fix
      differentProducts: 0,   // soft opt-in for different products → expired_consent fix
    };

    // ── Analyse each contact ──────────────────────────────────────────
    contacts.forEach(contact => {
      let score   = 100;
      let category = '';
      const reasons = [];

      const email  = (contact.email || '').toLowerCase();
      const domain = email.split('@')[1] || '';
      const isB2B  = emailType === 'b2b' || (emailType === 'mixed' && !consumerDomains.includes(domain));
      const isPersonalLooking = email.includes('.') && !consumerDomains.includes(domain);

      // Check 1: No consent date
      if (!contact.consentDate) {
        score    = 0;
        category = 'No consent date - CRITICAL';
        issueVolumes.noConsentDate++;
        results.danger.push({ ...contact, score, category });
        return;
      }

      // Check 2: Parse date
      let consentDate;
      try {
        consentDate = new Date(contact.consentDate);
        if (isNaN(consentDate.getTime())) throw new Error();
      } catch {
        score    = 0;
        category = 'Invalid date - CRITICAL';
        issueVolumes.noConsentDate++;
        results.danger.push({ ...contact, score, category });
        return;
      }

      const ageYears = (today - consentDate) / (365 * 24 * 60 * 60 * 1000);

      // Check 3: Invalid consent methods
      const methodLower = (contact.consentMethod || '').toLowerCase();
      if (['pre-ticked', 'preticked', 'pre-tick', 'assumed', 'implied'].some(m => methodLower.includes(m))) {
        score    = 0;
        category = 'Pre-ticked/Invalid method - PECR violation';
        issueVolumes.invalidConsent++;
        results.danger.push({ ...contact, score, category });
        return;
      }

      // Check 4: Purchased lists
      const sourceLower = (contact.source || '').toLowerCase();
      if (['purchased', 'bought', 'third party', 'third-party', 'broker'].some(s => sourceLower.includes(s))) {
        score    = 0;
        category = 'Purchased list - No valid consent';
        issueVolumes.purchasedList++;
        results.danger.push({ ...contact, score, category });
        return;
      }

      // Check 5: Age of consent
      if (ageYears > 3) {
        score -= 50;
        reasons.push('3+ years old');
        issueVolumes.expiredConsent++;
      } else if (ageYears > 2) {
        score -= 30;
        reasons.push('2–3 years old');
        issueVolumes.expiredConsent++;
      } else if (ageYears > 1) {
        score -= 10;
        reasons.push('1–2 years old');
      }

      // Check 6: Soft opt-in logic (PECR Reg 22(3))
      const isCustomer = customerType === 'all' || (customerType === 'some' && sourceLower.includes('purchase'));

      if (isCustomer) {
        if (productType === 'similar') {
          score    = Math.max(score, 85);
          category = 'Soft opt-in (similar products)';
        } else if (productType === 'different') {
          score    = 30;
          category = 'Soft opt-in INVALID (different products) — need express consent';
          reasons.push('Marketing different products');
          issueVolumes.differentProducts++;
        } else {
          score -= 20;
          category = 'Soft opt-in (verify product similarity)';
          reasons.push('Unclear if products similar');
        }
      }

      // Check 7: B2B emails
      if (isB2B) {
        if (isPersonalLooking) {
          score -= 15;
          reasons.push('Looks like personal email at work domain');
        } else {
          score    = Math.max(score, 75);
          category = category || 'B2B corporate email';
        }
      }

      // Check 8: No consent method documented
      if (!contact.consentMethod || contact.consentMethod.trim() === '' || methodLower === 'n/a') {
        score -= 25;
        reasons.push('No consent method documented');
      }

      // Check 9: No source documented
      if (!contact.source || contact.source.trim() === '') {
        score -= 15;
        reasons.push('Source not documented');
      }

      contact.score    = Math.max(0, Math.min(100, score));
      contact.category = category || reasons.join(', ') || 'Express consent';

      if      (contact.score >= 90) results.safe.push(contact);
      else if (contact.score >= 70) results.probably.push(contact);
      else if (contact.score >= 40) results.risky.push(contact);
      else                          results.danger.push(contact);
    });

    // ── Expiry timeline (next 12 months) ─────────────────────────────
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const expiryByMonth = {};

    for (let i = 0; i < 12; i++) {
      const d = new Date(today);
      d.setMonth(today.getMonth() + i);
      expiryByMonth[`${months[d.getMonth()]} ${d.getFullYear()}`] = 0;
    }

    [...results.risky, ...results.probably].forEach(c => {
      try {
        const cd     = new Date(c.consentDate);
        const expiry = new Date(cd);
        expiry.setFullYear(cd.getFullYear() + 2);
        if (expiry >= today) {
          const key = `${months[expiry.getMonth()]} ${expiry.getFullYear()}`;
          if (expiryByMonth[key] !== undefined) expiryByMonth[key]++;
        }
      } catch {}
    });

    results.expiryTimeline.labels = Object.keys(expiryByMonth);
    results.expiryTimeline.data   = Object.values(expiryByMonth);

    // ── Source quality summary ────────────────────────────────────────
    const sourceStats = {};
    contacts.forEach(c => {
      const source = c.source || 'Unknown';
      if (!sourceStats[source]) sourceStats[source] = { total: 0, scores: [] };
      sourceStats[source].total++;
      sourceStats[source].scores.push(c.score || 0);
    });

    results.sourceQuality = Object.keys(sourceStats).map(source => {
      const avg    = Math.round(sourceStats[source].scores.reduce((a, b) => a + b, 0) / sourceStats[source].total);
      let rating   = 'Critical';
      if (avg >= 85)      rating = 'Excellent';
      else if (avg >= 70) rating = 'Good';
      else if (avg >= 50) rating = 'Poor';
      return { source, total: sourceStats[source].total, avgScore: avg, rating };
    }).sort((a, b) => b.avgScore - a.avgScore);

    // ── Save to Airtable Database_Audits ──────────────────────────────
    let auditRecordId = null;

    if (userId) {
      try {
        const auditRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Database_Audits`, {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID:    userId,
                AuditDate: new Date().toISOString().split('T')[0],
                Total:     results.total,
                Safe:      results.safe.length,
                Probably:  results.probably.length,
                Risky:     results.risky.length,
                Danger:    results.danger.length,
                Results:   JSON.stringify(results)
              }
            }]
          })
        });

        if (auditRes.ok) {
          const saved    = await auditRes.json();
          auditRecordId  = saved.records?.[0]?.id || null;
        }
      } catch (e) {
        console.error('Database_Audits save failed:', e);
      }
    }

    // ── Generate Compliance_Fixes ─────────────────────────────────────
    // Only generate fixes when we have a userId to attach them to.
    // Each fix is non-fatal — audit result is returned regardless.

    if (userId) {
      const fixCalls = [];

      // 1. Expired / stale consent — contacts that scored down due to age
      //    or used soft opt-in for different products
      const expiredVolume = issueVolumes.expiredConsent + issueVolumes.differentProducts;
      if (expiredVolume > 0) {
        fixCalls.push({
          fixType:    'expired_consent',
          description: `Database Audit: ${expiredVolume} contact(s) have stale or expired consent (2+ years old or soft opt-in used for different products). Re-consent campaign required.`,
          severity:   'high',
          volume:     expiredVolume,
          sourceRecordId: auditRecordId
        });
      }

      // 2. Contacts with no consent date or invalid date — completely uncontactable
      //    Combined with purchased list volume into suppressed_contact
      const suppressedVolume = issueVolumes.noConsentDate + issueVolumes.purchasedList;
      if (suppressedVolume > 0) {
        fixCalls.push({
          fixType:    'suppressed_contact',
          description: `Database Audit: ${suppressedVolume} contact(s) have no valid consent record (no date, invalid date, or purchased/broker source). These contacts must be suppressed immediately.`,
          severity:   'critical',
          volume:     suppressedVolume,
          sourceRecordId: auditRecordId
        });
      }

      // 3. Contacts with invalid consent methods (pre-ticked etc.)
      if (issueVolumes.invalidConsent > 0) {
        fixCalls.push({
          fixType:    'suppressed_contact',
          description: `Database Audit: ${issueVolumes.invalidConsent} contact(s) have invalid consent methods (pre-ticked boxes or implied consent). PECR violation — suppress and re-consent.`,
          severity:   'critical',
          volume:     issueVolumes.invalidConsent,
          sourceRecordId: auditRecordId
        });
      }

      // Fire all fix calls (non-fatal, run in parallel)
      await Promise.allSettled(
        fixCalls.map(fix =>
          fetch(`${VERCEL_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ userId, ...fix, tool: 'Database Auditor' })
          })
          .then(r => r.json())
          .then(d => { if (d.skipped) console.log(`generate-fix duplicate skipped: ${fix.fixType}`); })
          .catch(err => console.error(`generate-fix failed for "${fix.fixType}":`, err))
        )
      );
    }

    return res.status(200).json(results);

  } catch (error) {
    console.error('audit-database-v2 error:', error);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}
