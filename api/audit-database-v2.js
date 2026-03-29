// api/audit-database-v2.js
// Database Auditor — router with four actions.
//
// POST ?action=audit            { contacts[], customerType, productType, emailType, userId }
// POST ?action=reconsent-draft  { userId, senderName, segmentDescription, channel,
//                                 consentStatement, optInMechanism, contactCount? }
// POST ?action=mark-sent        { userId, channel, contactCount, segmentDescription, windowDays? }
// POST ?action=suppression-report { userId, campaignRecordId }
//
// All actions require userId. All errors return JSON — never throws.

const APP_URL = 'https://sendwize-backend.vercel.app';

const CONSUMER_DOMAINS = [
  'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
  'aol.com','live.com','me.com','googlemail.com'
];

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: audit
// Categorises contacts as safe / probably / risky / danger.
// Writes aggregated result to Database_Audits.
// Generates Compliance_Fixes via generate-fix.js.
// ─────────────────────────────────────────────────────────────────────────────

async function handleAudit(req, res) {
  const { contacts, customerType, productType, emailType, userId } = req.body;

  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts array is required' });
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const today          = new Date();

  const results = {
    total:          contacts.length,
    safe:           [],
    probably:       [],
    risky:          [],
    danger:         [],
    expiryTimeline: { labels: [], data: [] },
    sourceQuality:  []
  };

  const issueVolumes = {
    expiredConsent:    0,
    invalidConsent:    0,
    purchasedList:     0,
    noConsentDate:     0,
    differentProducts: 0,
  };

  // ── Analyse each contact ────────────────────────────────────────────
  contacts.forEach(contact => {
    let score    = 100;
    let category = '';
    const reasons = [];

    const email   = (contact.email || '').toLowerCase();
    const domain  = email.split('@')[1] || '';
    const isB2B   = emailType === 'b2b' || (emailType === 'mixed' && !CONSUMER_DOMAINS.includes(domain));
    const isPersonalLooking = email.includes('.') && !CONSUMER_DOMAINS.includes(domain);

    if (!contact.consentDate) {
      issueVolumes.noConsentDate++;
      results.danger.push({ ...contact, score: 0, category: 'No consent date - CRITICAL' });
      return;
    }

    let consentDate;
    try {
      consentDate = new Date(contact.consentDate);
      if (isNaN(consentDate.getTime())) throw new Error();
    } catch {
      issueVolumes.noConsentDate++;
      results.danger.push({ ...contact, score: 0, category: 'Invalid date - CRITICAL' });
      return;
    }

    const ageYears  = (today - consentDate) / (365 * 24 * 60 * 60 * 1000);
    const methodLower = (contact.consentMethod || '').toLowerCase();
    const sourceLower = (contact.source        || '').toLowerCase();

    if (['pre-ticked','preticked','pre-tick','assumed','implied'].some(m => methodLower.includes(m))) {
      issueVolumes.invalidConsent++;
      results.danger.push({ ...contact, score: 0, category: 'Pre-ticked/Invalid method - PECR violation' });
      return;
    }

    if (['purchased','bought','third party','third-party','broker'].some(s => sourceLower.includes(s))) {
      issueVolumes.purchasedList++;
      results.danger.push({ ...contact, score: 0, category: 'Purchased list - No valid consent' });
      return;
    }

    if (ageYears > 3) {
      score -= 50; reasons.push('3+ years old'); issueVolumes.expiredConsent++;
    } else if (ageYears > 2) {
      score -= 30; reasons.push('2–3 years old'); issueVolumes.expiredConsent++;
    } else if (ageYears > 1) {
      score -= 10; reasons.push('1–2 years old');
    }

    const isCustomer = customerType === 'all' ||
      (customerType === 'some' && sourceLower.includes('purchase'));

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

    if (isB2B) {
      if (isPersonalLooking) {
        score -= 15; reasons.push('Looks like personal email at work domain');
      } else {
        score    = Math.max(score, 75);
        category = category || 'B2B corporate email';
      }
    }

    if (!contact.consentMethod || methodLower === '' || methodLower === 'n/a') {
      score -= 25; reasons.push('No consent method documented');
    }

    if (!contact.source || contact.source.trim() === '') {
      score -= 15; reasons.push('Source not documented');
    }

    contact.score    = Math.max(0, Math.min(100, score));
    contact.category = category || reasons.join(', ') || 'Express consent';

    if      (contact.score >= 90) results.safe.push(contact);
    else if (contact.score >= 70) results.probably.push(contact);
    else if (contact.score >= 40) results.risky.push(contact);
    else                          results.danger.push(contact);
  });

  // ── Expiry timeline (next 12 months) ─────────────────────────────────
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const expiryByMonth = {};
  const expiryTimeline = []; // structured for consent-expiry-check

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
        expiryTimeline.push({ email: c.email, expiryDate: expiry.toISOString().split('T')[0] });
      }
    } catch {}
  });

  results.expiryTimeline.labels = Object.keys(expiryByMonth);
  results.expiryTimeline.data   = Object.values(expiryByMonth);

  // ── Source quality summary ────────────────────────────────────────────
  const sourceStats = {};
  contacts.forEach(c => {
    const source = c.source || 'Unknown';
    if (!sourceStats[source]) sourceStats[source] = { total: 0, scores: [] };
    sourceStats[source].total++;
    sourceStats[source].scores.push(c.score || 0);
  });

  results.sourceQuality = Object.keys(sourceStats).map(source => {
    const avg  = Math.round(sourceStats[source].scores.reduce((a, b) => a + b, 0) / sourceStats[source].total);
    let rating = 'Critical';
    if (avg >= 85) rating = 'Excellent';
    else if (avg >= 70) rating = 'Good';
    else if (avg >= 50) rating = 'Poor';
    return { source, total: sourceStats[source].total, avgScore: avg, rating };
  }).sort((a, b) => b.avgScore - a.avgScore);

  // ── Save aggregated result to Database_Audits ─────────────────────────
  // Does NOT store full contact array — only aggregates and timeline.
  // Full contact data stays client-side only.
  let auditRecordId = null;
  try {
    const auditRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Database_Audits`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{
          fields: {
            UserID:         userId,
            AuditDate:      today.toISOString().split('T')[0],
            Total:          results.total,
            Safe:           results.safe.length,
            Probably:       results.probably.length,
            Risky:          results.risky.length,
            Danger:         results.danger.length,
            ExpiryTimeline: JSON.stringify(expiryTimeline),
            SourceQuality:  JSON.stringify(results.sourceQuality),
          }
        }]
      })
    });

    if (auditRes.ok) {
      auditRecordId = (await auditRes.json()).records?.[0]?.id ?? null;
    } else {
      console.error('Database_Audits save failed:', auditRes.status);
    }
  } catch (e) {
    console.error('Database_Audits save error:', e);
  }

  // ── Generate Compliance_Fixes ─────────────────────────────────────────
  const fixCalls = [];

  const expiredVolume = issueVolumes.expiredConsent + issueVolumes.differentProducts;
  if (expiredVolume > 0) {
    fixCalls.push({
      fixType:       'expired_consent',
      description:   `Database Audit: ${expiredVolume} contact(s) have stale or expired consent (2+ years old or soft opt-in used for different products). Re-consent campaign required.`,
      severity:      'high',
      volume:        expiredVolume,
      sourceRecordId: auditRecordId
    });
  }

  const suppressedVolume = issueVolumes.noConsentDate + issueVolumes.purchasedList;
  if (suppressedVolume > 0) {
    fixCalls.push({
      fixType:       'suppressed_contact',
      description:   `Database Audit: ${suppressedVolume} contact(s) have no valid consent record (no date, invalid date, or purchased/broker source). Suppress immediately.`,
      severity:      'critical',
      volume:        suppressedVolume,
      sourceRecordId: auditRecordId
    });
  }

  if (issueVolumes.invalidConsent > 0) {
    fixCalls.push({
      fixType:       'suppressed_contact',
      description:   `Database Audit: ${issueVolumes.invalidConsent} contact(s) have invalid consent methods (pre-ticked or implied). PECR violation — suppress and re-consent.`,
      severity:      'critical',
      volume:        issueVolumes.invalidConsent,
      sourceRecordId: auditRecordId
    });
  }

  await Promise.allSettled(
    fixCalls.map(fix =>
      fetch(`${APP_URL}/api/generate-fix`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, ...fix, tool: 'Database Auditor' })
      })
      .then(r => r.json())
      .then(d => { if (d.skipped) console.log(`generate-fix duplicate skipped: ${fix.fixType}`); })
      .catch(err => console.error(`generate-fix failed for "${fix.fixType}":`, err))
    )
  );

  // Streak call — fire and forget
  fetch(`${APP_URL}/api/profile?action=streak`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId })
  }).catch(e => console.error('Streak update failed:', e));

  return res.status(200).json(results);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: reconsent-draft
// Calls generate-reconsent-email.js internally and returns the draft.
// No streak call — this is not a tool completion, it's a sub-action.
// ─────────────────────────────────────────────────────────────────────────────

async function handleReconsentDraft(req, res) {
  const {
    userId,
    senderName,
    segmentDescription,
    channel,
    consentStatement,
    optInMechanism,
    contactCount,
  } = req.body;

  if (!userId)             return res.status(400).json({ error: 'Missing userId' });
  if (!senderName)         return res.status(400).json({ error: 'Missing senderName' });
  if (!segmentDescription) return res.status(400).json({ error: 'Missing segmentDescription' });
  if (!channel)            return res.status(400).json({ error: 'Missing channel' });
  if (!consentStatement)   return res.status(400).json({ error: 'Missing consentStatement' });
  if (!optInMechanism)     return res.status(400).json({ error: 'Missing optInMechanism' });

  const reconsentRes = await fetch(`${APP_URL}/api/generate-reconsent-email`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      senderName,
      segmentDescription,
      channel,
      consentStatement,
      optInMechanism,
      contactCount: contactCount ?? null,
    })
  });

  if (!reconsentRes.ok) {
    const err = await reconsentRes.json().catch(() => ({}));
    console.error('generate-reconsent-email failed:', reconsentRes.status, err);
    return res.status(reconsentRes.status).json(err);
  }

  return res.status(200).json(await reconsentRes.json());
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: mark-sent
// Records that the user has sent a re-consent campaign.
// Writes to Reconsent_Campaigns. Calculates WindowCloses date.
// Also writes a reconsent_sent fix record via generate-fix.js.
// ─────────────────────────────────────────────────────────────────────────────

async function handleMarkSent(req, res) {
  const {
    userId,
    channel,
    contactCount,
    segmentDescription,
    windowDays = 30,
  } = req.body;

  if (!userId)             return res.status(400).json({ error: 'Missing userId' });
  if (!channel)            return res.status(400).json({ error: 'Missing channel' });
  if (!segmentDescription) return res.status(400).json({ error: 'Missing segmentDescription' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;

  const sentDate    = new Date().toISOString().split('T')[0];
  const windowClose = new Date();
  windowClose.setDate(windowClose.getDate() + windowDays);
  const windowClosesDate = windowClose.toISOString().split('T')[0];

  // Write to Reconsent_Campaigns
  let campaignRecordId = null;
  try {
    const campaignRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Reconsent_Campaigns`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{
          fields: {
            UserID:             userId,
            SentDate:           sentDate,
            Channel:            channel,
            ContactCount:       contactCount ?? 0,
            SegmentDescription: segmentDescription,
            WindowDays:         windowDays,
            WindowCloses:       windowClosesDate,
            Status:             'Sent - awaiting responses',
          }
        }]
      })
    });

    if (campaignRes.ok) {
      campaignRecordId = (await campaignRes.json()).records?.[0]?.id ?? null;
    } else {
      console.error('Reconsent_Campaigns write failed:', campaignRes.status);
    }
  } catch (e) {
    console.error('Reconsent_Campaigns write error:', e);
  }

  // Write reconsent_sent fix record
  try {
    await fetch(`${APP_URL}/api/generate-fix`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        fixType:       'reconsent_sent',
        description:   `Re-consent campaign marked as sent via ${channel} to ${segmentDescription}. Non-respondents should be suppressed after ${windowDays} days (by ${windowClosesDate}).`,
        tool:          'Database Auditor',
        severity:      'medium',
        volume:        contactCount ?? null,
        sourceRecordId: campaignRecordId,
      })
    });
  } catch (e) {
    console.error('reconsent_sent fix failed (non-fatal):', e);
  }

  return res.status(200).json({
    recorded:        true,
    campaignRecordId,
    sentDate,
    windowCloses:    windowClosesDate,
    windowDays,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: suppression-report
// Called when the re-consent window has closed.
// Fetches the Reconsent_Campaign record, updates its status,
// and returns a suppression report so the frontend can prompt
// the user to suppress non-respondents.
// ─────────────────────────────────────────────────────────────────────────────

async function handleSuppressionReport(req, res) {
  const { userId, campaignRecordId } = req.body;

  if (!userId)           return res.status(400).json({ error: 'Missing userId' });
  if (!campaignRecordId) return res.status(400).json({ error: 'Missing campaignRecordId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const airtableBase   = `https://api.airtable.com/v0/${BASE_ID}`;
  const authHeader     = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  // Fetch the campaign record
  const campaignRes  = await fetch(`${airtableBase}/Reconsent_Campaigns/${campaignRecordId}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
  });

  if (!campaignRes.ok) {
    console.error('Reconsent_Campaigns fetch failed:', campaignRes.status);
    return res.status(campaignRes.status).json({ error: 'Campaign record not found' });
  }

  const campaign = (await campaignRes.json()).fields;

  // Verify this campaign belongs to this user
  if (campaign.UserID !== userId) {
    return res.status(403).json({ error: 'Unauthorised' });
  }

  const today          = new Date().toISOString().split('T')[0];
  const contactCount   = campaign.ContactCount   || 0;
  const windowCloses   = campaign.WindowCloses   || '';
  const channel        = campaign.Channel        || '';
  const segmentDesc    = campaign.SegmentDescription || '';

  // Update campaign status to window closed
  try {
    await fetch(`${airtableBase}/Reconsent_Campaigns/${campaignRecordId}`, {
      method:  'PATCH',
      headers: authHeader,
      body: JSON.stringify({
        fields: {
          Status:              'Window closed - suppression report generated',
          ReportGeneratedAt:   today,
        }
      })
    });
  } catch (e) {
    console.error('Reconsent_Campaigns status update failed (non-fatal):', e);
  }

  return res.status(200).json({
    campaignRecordId,
    channel,
    segmentDescription:  segmentDesc,
    contactCount,
    windowCloses,
    suppressionRequired: true,
    message: `The ${windowCloses} re-consent window has closed. Any contacts who did not opt in should now be suppressed from your ${channel} send list. Add them to your suppression list before your next send.`,
    disclaimer: 'Information only — not legal advice.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action || req.body.action;

  try {
    if (action === 'audit')               return await handleAudit(req, res);
    if (action === 'reconsent-draft')     return await handleReconsentDraft(req, res);
    if (action === 'mark-sent')           return await handleMarkSent(req, res);
    if (action === 'suppression-report')  return await handleSuppressionReport(req, res);

    return res.status(400).json({
      error: 'Missing or unknown action',
      valid: 'audit | reconsent-draft | mark-sent | suppression-report'
    });

  } catch (error) {
    console.error('audit-database-v2 error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
