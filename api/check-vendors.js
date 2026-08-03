// ─────────────────────────────────────────────────────────────
// SENDWIZE — check-vendors.js v4.29
// POST { vendors: [{ name, isCustom, dpaStatus, dataTypes, contactVolume }], userId }
//
// v4.29 changes from v4.28:
//   - B1: Privacy policy scraping for every vendor.
//     Known vendors: scrape their PrivacyPolicyUrl from Airtable.
//     Unknown vendors: Claude guesses the URL, we scrape it.
//     Scraped excerpt attached to result.scrapedPolicy (source,
//     url, excerpt, scrapedAt). Scrape failures are non-fatal —
//     result.scrapedPolicy is null and analysis proceeds without.
//   - B2: AI now returns a `gaps` array for unknown vendors —
//     specific things missing from the scraped policy that should
//     be there for UK GDPR / marketing use (SCCs mention, DPO,
//     retention policy, security cert, sub-processor list, etc).
//     Each gap emits its own fix via generate-fix.js. Gaps carry
//     severity (high|medium|low) and one-line description.
//   - AI prompt now uses scraped policy text when available.
//     Falls back to Claude's general knowledge if scrape failed.
//   - Result shape adds: scrapedPolicy, gaps (unknown only).
//   - buildFixesForResult now emits gap fixes with sourceRecordId
//     scoped per-gap: `vendor-{name-slug}-gap-{gap-slug}` for dedupe.
//   - Fix descriptions include "based on public privacy policy at
//     {url}, last scraped {date}" for traceability (D2 principle).
// ─────────────────────────────────────────────────────────────
const APP_URL = 'https://sendwize-backend.vercel.app';
const SCRAPE_TIMEOUT_MS = 8000;
const SCRAPE_MAX_CHARS  = 12000;
const SCRAPE_UA = 'Mozilla/5.0 (compatible; SendwizeComplianceBot/1.0; +https://sendwize.com/bot)';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { vendors, userId } = req.body ?? {};
    if (!userId)                             return res.status(400).json({ error: 'Missing userId' });
    if (!vendors || !Array.isArray(vendors)) return res.status(400).json({ error: 'vendors array is required' });
    if (vendors.length === 0)                return res.status(400).json({ error: 'vendors array is empty' });

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID        = process.env.BASE_ID;
    const atBase         = `https://api.airtable.com/v0/${BASE_ID}`;
    const atH            = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // ── 1. Fetch known vendor library records ─────────────────
    const knownNames  = vendors.filter(v => !v.isCustom).map(v => v.name.toLowerCase());
    let vendorLibrary = {};
    if (knownNames.length > 0) {
      try {
        const formula = `OR(${knownNames.map(n => `LOWER({VendorName})='${n}'`).join(',')})`;
        const libRes  = await fetch(
          `${atBase}/Marketing_Vendors?filterByFormula=${encodeURIComponent(formula)}`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        if (libRes.ok) {
          for (const r of ((await libRes.json()).records || [])) {
            vendorLibrary[r.fields.VendorName?.toLowerCase()] = r.fields;
          }
        }
      } catch (e) { console.error('Marketing_Vendors fetch failed (non-fatal):', e); }
    }

    // ── 2. Analyse each vendor ────────────────────────────────
    const results = [];
    for (const vendor of vendors) {
      let result;
      if (vendor.isCustom) {
        // Unknown vendor: guess URL → scrape → AI analyze with scraped text
        const guessedUrl   = await guessPrivacyPolicyUrl(vendor.name);
        const scrapedPolicy = guessedUrl ? await scrapePrivacyPolicy(guessedUrl) : null;
        result = await analyzeVendorWithAI(vendor.name, scrapedPolicy);
        result.scrapedPolicy = scrapedPolicy;
      } else {
        // Known vendor: read library, scrape their published policy URL
        const libFields  = vendorLibrary[vendor.name.toLowerCase()] || null;
        result = handleKnownVendor(vendor.name, libFields);
        const policyUrl  = libFields?.PrivacyPolicyUrl || null;
        result.scrapedPolicy = policyUrl ? await scrapePrivacyPolicy(policyUrl) : null;
      }
      result.userInput = {
        dpaStatus:     vendor.dpaStatus     || 'unsure',
        dataTypes:     vendor.dataTypes     || [],
        contactVolume: vendor.contactVolume || null,
      };
      results.push(result);
    }

    // ── 3. Save to Vendor_Checks ──────────────────────────────
    let sourceRecordId = null;
    try {
      const avgScore = results.length > 0
        ? Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length)
        : 0;
      const saveRes = await fetch(`${atBase}/Vendor_Checks`, {
        method:  'POST',
        headers: atH,
        body: JSON.stringify({ records: [{ fields: {
          UserID:         userId,
          CheckDate:      new Date().toISOString().split('T')[0],
          VendorsChecked: vendors.map(v => v.name).join(', '),
          VendorCount:    vendors.length,
          AverageScore:   avgScore,
          Results:        JSON.stringify(results),
        }}]})
      });
      if (saveRes.ok) sourceRecordId = (await saveRes.json()).records?.[0]?.id ?? null;
    } catch (e) { console.error('Vendor_Checks save error:', e); }

    // ── 4. Upsert Vendor_Register ─────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    for (const result of results) {
      try {
        const ui = result.userInput || {};
        const existingRes = await fetch(
          `${atBase}/Vendor_Register?filterByFormula=AND({UserID}='${userId}',{VendorName}='${result.name}')&maxRecords=1`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const existing = (existingRes.ok ? await existingRes.json() : { records: [] }).records?.[0];

        const agreementStatusMap = { yes: 'In place', no: 'Not yet', unsure: 'Unknown' };
        const dataProcessed = ui.dataTypes?.length
          ? JSON.stringify(ui.dataTypes)
          : null;

        const updateFields = Object.fromEntries(Object.entries({
          LastChecked:     today,
          Category:        result.vendorType || null,
          ComplianceScore: result.score ?? null,
          AgreementStatus: agreementStatusMap[ui.dpaStatus] || null,
          DataProcessed:   dataProcessed,
          ContactVolume:   ui.contactVolume || null,
        }).filter(([, v]) => v !== null && v !== undefined));

        if (existing) {
          await fetch(`${atBase}/Vendor_Register/${existing.id}`, {
            method:  'PATCH',
            headers: atH,
            body:    JSON.stringify({ fields: updateFields }),
          });
        } else {
          await fetch(`${atBase}/Vendor_Register`, {
            method:  'POST',
            headers: atH,
            body:    JSON.stringify({ records: [{ fields: {
              UserID: userId, VendorName: result.name, ...updateFields
            }}]}),
          });
        }
      } catch (e) { console.error(`Vendor_Register upsert failed for ${result.name}:`, e); }
    }

    // ── 5. Generate fix records ───────────────────────────────
    for (const result of results) {
      const fixes = buildFixesForResult(result, userId, sourceRecordId);
      for (const fix of fixes) {
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(fix),
          });
        } catch (e) { console.error(`generate-fix failed for ${result.name}:`, e); }
      }
    }

    // ── 6. Streak ─────────────────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    return res.status(200).json({ results });

  } catch (error) {
    console.error('check-vendors error:', error);
    return res.status(500).json({ error: 'Vendor check failed' });
  }
}

// ─────────────────────────────────────────────────────────────
// scrapePrivacyPolicy (B1)
// Fetches a public privacy policy page, strips HTML, returns
// { url, excerpt, scrapedAt } or null on failure.
// Non-fatal: any failure returns null. Timeout at SCRAPE_TIMEOUT_MS.
// Legal-OK: only fetches publicly served pages, sends identifying
// User-Agent, respects HTTP status codes (no bypass attempts).
// ─────────────────────────────────────────────────────────────
async function scrapePrivacyPolicy(url) {
  if (!url || typeof url !== 'string') return null;
  if (!/^https?:\/\//i.test(url))       return null;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': SCRAPE_UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal:  controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|xhtml/i.test(ct)) return null;

    const html = await res.text();
    // Strip scripts, styles, comments, tags → collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 200) return null;

    return {
      url,
      excerpt:   text.slice(0, SCRAPE_MAX_CHARS),
      scrapedAt: new Date().toISOString(),
    };
  } catch (e) {
    clearTimeout(timer);
    console.error(`scrapePrivacyPolicy failed for ${url}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// guessPrivacyPolicyUrl (B1)
// Small Claude call to guess an unknown vendor's privacy policy
// URL. Returns a URL string or null.
// ─────────────────────────────────────────────────────────────
async function guessPrivacyPolicyUrl(vendorName) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `The UK company or marketing vendor "${vendorName}" — what is the most likely URL of their published privacy policy or data processing addendum? Respond ONLY with the URL as plain text, or exactly "unknown" if you cannot make a confident guess. No preamble, no explanation, no markdown.`
        }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw  = (data.content?.[0]?.text || '').trim();
    if (!raw || /^unknown$/i.test(raw)) return null;
    // Extract first URL
    const m = raw.match(/https?:\/\/[^\s"'<>]+/);
    return m ? m[0] : null;
  } catch (e) {
    console.error(`guessPrivacyPolicyUrl failed for ${vendorName}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// buildProcessingContext (unchanged from v4.28)
// ─────────────────────────────────────────────────────────────
function buildProcessingContext(result) {
  const ui      = result.userInput || {};
  const d       = result.dimensions || {};

  const dataTypes    = Array.isArray(ui.dataTypes) ? ui.dataTypes : [];
  const contactVolume = ui.contactVolume || null;
  const dpaStatus    = ui.dpaStatus === 'yes' ? 'Confirmed'
                     : ui.dpaStatus === 'no'  ? 'Unknown'
                     : 'Unknown';
  const breach       = d.breachHistory || '';
  const breachKnown  = breach && !['none identified','none','no','unknown',''].includes(breach.toLowerCase());
  const hasDoc       = false;

  return {
    vendorName:              result.name,
    dataTypes,
    contactVolume,
    vendorBreachHistory:     breachKnown ? breach : 'None identified',
    dpaStatus,
    hasDocumentedAssessment: hasDoc,
  };
}

// ─────────────────────────────────────────────────────────────
// slugify — for stable sourceRecordId per gap
// ─────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────
// buildFixesForResult
// v4.29: now also emits one fix per AI-identified `gap` from the
// scraped policy analysis (unknown vendors only).
// ─────────────────────────────────────────────────────────────
function buildFixesForResult(result, userId, sourceRecordId) {
  const fixes = [];
  const name  = result.name;
  const d     = result.dimensions || {};
  const ui    = result.userInput || {};

  const userDPA        = ui.dpaStatus || 'unsure';
  const dataTypes      = Array.isArray(ui.dataTypes) ? ui.dataTypes : [];
  const volume         = ui.contactVolume || null;
  const transferOccurs = (d.intlTransferOccurs    || '').toLowerCase();
  const transferMech   = (d.internationalTransfer || '').toLowerCase();
  const icoStatus      = (d.icoRegistered         || '').toLowerCase();
  const breach         = (d.breachHistory         || '').trim();

  const breachIsKnown = breach &&
    !['none identified','none','no','unknown',''].includes(breach.toLowerCase());

  const hasSensitive = dataTypes.some(dt =>
    /special category|behavioural|behaviour|purchase|financial/i.test(dt));
  const highVolume   = volume && volume > 50000;

  const processingContext = buildProcessingContext(result);
  const nameSlug          = slugify(name);

  // ── DPA fix — driven by user's answer ─────────────────────
  if (userDPA === 'no' || userDPA === 'unsure') {
    const severity = (hasSensitive || highVolume) ? 'critical' : 'high';

    let description;
    if (userDPA === 'no') {
      const hint = d.dpaStatus === 'Confirmed' && d.dpaLink
        ? `${name}'s DPA is self-serve at ${d.dpaLink}`
        : d.dpaStatus === 'On Request'
        ? `Contact ${name} directly to obtain their DPA.`
        : `Contact ${name}'s privacy team to obtain a Data Processing Agreement.`;
      description = `Processor Risk Scanner: You confirmed you don't have a signed DPA with ${name}. UK GDPR Article 28 requires a written contract before sharing personal data with any processor. ${hint}`;
    } else {
      description = `Processor Risk Scanner: DPA status with ${name} is unconfirmed. UK GDPR Article 28 requires a written contract before sharing personal data. Check your files for a signed DPA — if you can't find one, treat it as not in place and request one now.`;
    }

    if (hasSensitive) {
      description += ` You're sharing sensitive data types (${dataTypes.filter(t => /behavioural|purchase|special/i.test(t)).join(', ')}) which increases the severity of this gap.`;
    }
    if (highVolume) {
      description += ` Volume of ${volume.toLocaleString()} contacts is a significant aggravating factor in ICO enforcement decisions.`;
    }

    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:       'dpa_breach',
      description,
      tool:          `Processor Risk Scanner \u2014 ${name}`,
      severity,
      contactVolume: volume,
    });
  }

  // ── ICO not registered ────────────────────────────────────
  if (icoStatus === 'no') {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Processor Risk Scanner: ${name} does not appear to be registered with the ICO. UK processors handling personal data must be registered. Verify at ico.org.uk/ESDWebPages/Search before sharing any contact data.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'critical',
      contactVolume: volume,
    });
  }

  // ── Breach history ────────────────────────────────────────
  if (breachIsKnown) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'legitimate_interest_abuse',
      description: `Processor Risk Scanner: ${name} has a confirmed breach or enforcement history: ${breach.slice(0, 200)}. UK GDPR requires you to document your assessment of continued use of a processor with a known history. Without this documented assessment you're missing a key piece of due diligence that would protect you if the ICO investigated.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'medium',
      contactVolume: volume,
    });
  }

  // ── International transfer with no mechanism ──────────────
  if (transferOccurs === 'yes' &&
      (transferMech === 'none' || transferMech === 'unknown' || transferMech === '')) {
    fixes.push({
      userId, sourceRecordId, processingContext,
      fixType:     'dpa_breach',
      description: `Processor Risk Scanner: ${name} transfers data internationally but no confirmed transfer mechanism (SCCs, Adequacy, UK-US Data Bridge) has been identified from their public pages. UK GDPR Chapter V requires a lawful transfer mechanism. Confirm this in your DPA or contact ${name} directly.`,
      tool:        `Processor Risk Scanner \u2014 ${name}`,
      severity:    'medium',
      contactVolume: volume,
    });
  }

  // ── B2: AI-identified gaps from scraped policy ────────────
  // Unknown vendors only. Each gap emits its own fix so it can be
  // resolved (or improved-on-rerun) independently.
  const gaps = Array.isArray(result.gaps) ? result.gaps : [];
  const scrapeUrl  = result.scrapedPolicy?.url  || null;
  const scrapeDate = result.scrapedPolicy?.scrapedAt?.split('T')[0] || null;
  for (const gap of gaps) {
    if (!gap || !gap.title) continue;
    const gapSlug = slugify(gap.title);
    const gapSev  = ['high','medium','low'].includes(gap.severity) ? gap.severity : 'medium';
    const trace   = scrapeUrl
      ? ` Based on public privacy policy at ${scrapeUrl} (scraped ${scrapeDate}).`
      : ` Based on Sendwize\u2019s AI review of ${name} \u2014 no public policy was located, so this gap could not be verified against source material. Confirm directly with ${name}.`;
    fixes.push({
      // Per-gap sourceRecordId so each gap dedupes independently on rerun.
      userId,
      sourceRecordId: `vendor-${nameSlug}-gap-${gapSlug}`,
      processingContext,
      fixType:  'dpa_breach',
      description: `Processor Risk Scanner: ${name} \u2014 ${gap.title}. ${gap.detail || ''}${trace}`,
      tool:     `Processor Risk Scanner \u2014 ${name}`,
      severity: gapSev,
      contactVolume: volume,
    });
  }

  return fixes;
}

// ─────────────────────────────────────────────────────────────
// calculateRiskRating (unchanged)
// ─────────────────────────────────────────────────────────────
function calculateRiskRating(d) {
  const ico    = (d.icoRegistered                  || '').toLowerCase();
  const dpa    = (d.dpaStatus                      || '').toLowerCase();
  const mech   = (d.internationalTransfer          || d.transferMechanismConfirmed || '').toLowerCase();
  const breach = (d.breachHistory                  || '').toLowerCase();
  const dest   = (d.transferDestination            || '').toLowerCase();
  const cert   = (d.relevantSecurityCertification  || '').toLowerCase();
  const dpo    = (d.dpoConfirmed                   || '').toLowerCase();
  const intl   = (d.intlTransferOccurs             || '').toLowerCase();

  if (ico === 'no' || ico === 'not found') return 'High';
  if (breach && !['none identified','none','no','unknown',''].includes(breach)) return 'High';
  const nonAdequate = dest && !['eu','eea','uk','n/a'].some(t => dest.includes(t));
  const noMech      = mech === 'none' || mech === 'unknown' || mech === '';
  if (intl === 'yes' && nonAdequate && noMech) return 'High';
  if (dpa === 'refused') return 'High';
  if (['on request','unknown','not available'].includes(dpa)) return 'Medium';
  if (intl === 'yes' && noMech) return 'Medium';
  if (!cert || ['no','none','unknown'].includes(cert)) return 'Medium';
  if (!dpo  || ['no','none','unknown'].includes(dpo))  return 'Medium';
  return 'Low';
}

// ─────────────────────────────────────────────────────────────
// handleKnownVendor (unchanged from v4.28 — returns dimensions
// from Airtable library, no AI call)
// ─────────────────────────────────────────────────────────────
function handleKnownVendor(name, fields) {
  if (!fields) {
    return {
      name, score: 50, riskRating: 'Medium', isAI: false, dpaConfirmed: false, vendorType: '',
      details: [{ status: 'warning', label: 'Not in library',
        description: `${name} is not in the Sendwize vendor library. Assessment based on what you've provided.` }],
      actionItems: [
        'Confirm their ICO registration at ico.org.uk/ESDWebPages/Search',
        'Request their Data Processing Agreement and confirm the transfer mechanism',
      ],
      dimensions: {}
    };
  }

  const details = [];
  let   score   = 100;

  const icoStatus = fields.ICORegistered || 'Unknown';
  if      (icoStatus === 'Yes')    { details.push({ status: 'pass', label: 'ICO Registration', description: `Registered with ICO${fields.ICORegNumber ? ` (${fields.ICORegNumber})` : ''}.` }); }
  else if (icoStatus === 'Exempt') { details.push({ status: 'info', label: 'ICO Registration', description: 'Exempt from ICO registration — verify exemption applies.' }); }
  else if (icoStatus === 'No')     { details.push({ status: 'fail', label: 'ICO Registration', description: 'Not found on ICO register. UK processors must register.' }); score -= 20; }
  else                             { details.push({ status: 'info', label: 'ICO Registration', description: 'ICO registration not confirmed — verify at ico.org.uk/ESDWebPages/Search.' }); score -= 5; }

  const dpaStatus    = fields.DPAStatus || 'Unknown';
  const dpaConfirmed = dpaStatus === 'Confirmed';
  const privacyUrl   = fields.PrivacyPolicyUrl || null;
  if      (dpaConfirmed)               { details.push({ status: 'pass',    label: 'DPA Available', description: `DPA publicly available${privacyUrl ? ` at ${privacyUrl}` : ''}.` }); }
  else if (dpaStatus === 'On Request') { details.push({ status: 'warning', label: 'DPA Available', description: 'DPA available on request — contact vendor directly.' }); score -= 15; }
  else if (dpaStatus === 'Refused')    { details.push({ status: 'fail',    label: 'DPA Available', description: 'Vendor has declined to sign a DPA.' }); score -= 35; }
  else                                 { details.push({ status: 'warning', label: 'DPA Available', description: 'DPA status not confirmed from public pages.' }); score -= 15; }

  const transferOccurs = fields.IntlTransferOccurs         || 'Unknown';
  const transferDest   = fields.TransferDestination        || '';
  const transferMech   = fields.TransferMechanismConfirmed || 'Unknown';
  if      (transferOccurs === 'No') { details.push({ status: 'pass', label: 'International Transfers', description: 'Processing confirmed as UK/EEA only.' }); }
  else if (['Adequacy','SCCs','BCRs','UK-US Bridge'].includes(transferMech)) { details.push({ status: 'pass', label: 'International Transfers', description: `Transfer mechanism: ${transferMech}${transferDest ? ` (${transferDest})` : ''}.` }); }
  else if (transferOccurs === 'Yes' && (transferMech === 'None' || transferMech === 'Unknown')) { details.push({ status: 'fail', label: 'International Transfers', description: `International transfer to ${transferDest || 'unknown destination'} — mechanism not confirmed from public pages.` }); score -= 20; }
  else { details.push({ status: 'info', label: 'International Transfers', description: 'Transfer status not confirmed from public pages.' }); score -= 5; }

  const breachHistory = fields.BreachHistory || '';
  const breachIsKnown = breachHistory && !['none identified','none','no','unknown',''].includes(breachHistory.toLowerCase());
  if (!breachIsKnown) { details.push({ status: 'pass',    label: 'Breach History', description: 'No publicly known breaches or enforcement actions identified.' }); }
  else                { details.push({ status: 'warning', label: 'Breach History', description: breachHistory }); score -= 15; }

  const dpoStatus = fields.DPOConfirmed || 'Unknown';
  if (dpoStatus === 'Yes') details.push({ status: 'pass', label: 'DPO', description: 'Named DPO confirmed.' });
  else details.push({ status: 'info', label: 'DPO', description: 'DPO status not confirmed.' });

  const certStatus = fields.RelevantSecurityCertification || 'Unknown';
  if      (certStatus === 'Yes') { details.push({ status: 'pass', label: 'Security Certification', description: 'ISO 27001, SOC 2 or equivalent confirmed.' }); }
  else if (certStatus === 'No')  { details.push({ status: 'info', label: 'Security Certification', description: 'No certification identified — advisory only.' }); score -= 5; }
  else                           { details.push({ status: 'info', label: 'Security Certification', description: 'Certification status not confirmed.' }); }

  if (privacyUrl) details.push({ status: 'info', label: 'Privacy Policy / DPA', description: `Available at: ${privacyUrl}` });

  const riskRating = fields.RiskRating || calculateRiskRating({
    icoRegistered: icoStatus, dpaStatus, intlTransferOccurs: transferOccurs,
    internationalTransfer: transferMech, transferDestination: transferDest,
    breachHistory, dpoConfirmed: dpoStatus, relevantSecurityCertification: certStatus,
  });

  const actionItems = [];
  if (dpaStatus === 'On Request') actionItems.push(`Contact ${name} to obtain and sign their DPA`);
  if (dpaStatus === 'Refused')    actionItems.push(`Stop sharing personal data — find a compliant alternative`);
  if (transferOccurs === 'Yes' && transferMech === 'Unknown') actionItems.push('Confirm transfer mechanism in your DPA');
  if (icoStatus === 'Unknown')    actionItems.push('Verify ICO registration at ico.org.uk/ESDWebPages/Search');
  if (breachIsKnown)              actionItems.push('Document your assessment of continued use given breach history');
  if (privacyUrl)                 actionItems.push(`DPA / privacy policy: ${privacyUrl}`);
  if (fields.LastVerified)        actionItems.push(`Library data last reviewed: ${fields.LastVerified}`);

  return {
    name,
    vendorType:   fields.VendorType || '',
    score:        Math.max(0, score),
    riskRating,
    isAI:         false,
    dpaConfirmed,
    details,
    actionItems,
    dimensions: {
      icoRegistered:                 icoStatus,
      icoRegNumber:                  fields.ICORegNumber || null,
      dpaStatus,
      dpaLink:                       privacyUrl,
      intlTransferOccurs:            transferOccurs,
      transferDestination:           transferDest,
      internationalTransfer:         transferMech,
      breachHistory:                 breachHistory || 'None identified',
      dpoConfirmed:                  dpoStatus,
      relevantSecurityCertification: certStatus,
      lastVerified:                  fields.LastVerified || null,
    }
  };
}

// ─────────────────────────────────────────────────────────────
// analyzeVendorWithAI (B2)
// v4.29: accepts scrapedPolicy. If provided, prompt anchors the
// analysis to the scraped text and asks for a `gaps` array. If
// not provided, falls back to general-knowledge analysis (still
// returns gaps but flagged as unverified).
// ─────────────────────────────────────────────────────────────
async function analyzeVendorWithAI(vendorName, scrapedPolicy) {
  const scrapeBlock = scrapedPolicy?.excerpt
    ? `SCRAPED PRIVACY POLICY (from ${scrapedPolicy.url}, ${scrapedPolicy.scrapedAt}):
"""
${scrapedPolicy.excerpt}
"""

Use ONLY the scraped text above as evidence for dimensions and gaps. If a dimension is not addressed in the text, mark it Unknown. Do not invent facts.`
    : `NO PRIVACY POLICY SCRAPED. Use general knowledge only. Mark dimensions Unknown where you can\u2019t verify. Any gaps you list must be flagged as unverified in the detail.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are a UK GDPR compliance researcher. A UK marketing team uses "${vendorName}" as a data processor.

${scrapeBlock}

Assess this vendor across seven compliance dimensions AND identify specific gaps in the privacy policy that a UK marketing team should be concerned about.

Respond ONLY with this exact JSON \u2014 no markdown, no preamble:
{
  "score": <integer 0-100>,
  "riskRating": "<Low|Medium|High>",
  "vendorType": "<Self-Serve ESP|Third-party agency|CRM|Analytics|CDP|Advertising|Marketing Agency|Other>",
  "dpaConfirmed": <true|false>,
  "dimensions": {
    "icoRegistered": "<Yes|No|Exempt|Unknown>",
    "icoRegNumber": "<number or null>",
    "dpaStatus": "<Confirmed|On Request|Refused|Unknown>",
    "dpaLink": "<URL or null>",
    "intlTransferOccurs": "<Yes|No|Unknown>",
    "transferDestination": "<EU/EEA|US|India|Other|N/A|Unknown>",
    "internationalTransfer": "<Adequacy|SCCs|BCRs|UK-US Bridge|None|Unknown>",
    "breachHistory": "<plain text of any known breaches or enforcement, or exactly: None identified>",
    "dpoConfirmed": "<Yes|No|Unknown>",
    "relevantSecurityCertification": "<Yes|No|Unknown>"
  },
  "gaps": [
    {"title":"<short gap title, e.g. 'No sub-processor list published'>","detail":"<one sentence explaining what's missing and why it matters for UK GDPR>","severity":"<high|medium|low>"}
  ],
  "details": [{"status":"<pass|warning|info|fail>","label":"<dimension>","description":"<one sentence>"}],
  "actionItems": ["<specific action>"],
  "confidenceCaveat": "This assessment is based on publicly available information only. Verify directly with the vendor before transferring customer data."
}

Gap examples to look for (only include if actually missing from the policy):
- No sub-processor list published
- International transfer mechanism not stated (SCCs / Adequacy / UK-US Bridge)
- No data retention period specified
- No named DPO or contact for data protection queries
- No security certification mentioned (ISO 27001, SOC 2)
- No breach notification commitment or timeframe
- No data subject rights process described
- No lawful basis stated for the processing they perform

Only list gaps genuinely absent from the scraped policy. Do NOT list a gap as present just because it\u2019s common practice. Empty array is a valid answer.

Risk: High if ICO not registered OR known breach OR intl transfer no mechanism to non-adequate country OR DPA refused. Medium if DPA On Request/Unknown OR transfer unconfirmed OR no cert OR no DPO. Low otherwise.`
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);
    const data     = await response.json();
    const text     = data.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);
    const d        = analysis.dimensions || {};

    return {
      name:             vendorName,
      vendorType:       analysis.vendorType   || 'Other',
      score:            analysis.score        || 50,
      riskRating:       analysis.riskRating   || calculateRiskRating(d),
      isAI:             true,
      dpaConfirmed:     analysis.dpaConfirmed || false,
      details:          analysis.details      || [],
      actionItems:      analysis.actionItems  || [],
      gaps:             Array.isArray(analysis.gaps) ? analysis.gaps : [],
      confidenceCaveat: analysis.confidenceCaveat || 'Assessment based on publicly available information. Verify directly with the vendor.',
      dimensions: {
        icoRegistered:                 d.icoRegistered                 || 'Unknown',
        icoRegNumber:                  d.icoRegNumber                  || null,
        dpaStatus:                     d.dpaStatus                     || 'Unknown',
        dpaLink:                       d.dpaLink                       || null,
        intlTransferOccurs:            d.intlTransferOccurs            || 'Unknown',
        transferDestination:           d.transferDestination           || 'Unknown',
        internationalTransfer:         d.internationalTransfer         || 'Unknown',
        breachHistory:                 d.breachHistory                 || 'Unknown',
        dpoConfirmed:                  d.dpoConfirmed                  || 'Unknown',
        relevantSecurityCertification: d.relevantSecurityCertification || 'Unknown',
        lastVerified:                  null,
      }
    };

  } catch (error) {
    console.error(`AI vendor analysis failed for ${vendorName}:`, error);
    return {
      name: vendorName, vendorType: 'Other', score: 50, riskRating: 'Medium',
      isAI: true, dpaConfirmed: false,
      gaps: [],
      confidenceCaveat: 'Automated analysis failed. Please verify this vendor manually.',
      details: [{ status: 'warning', label: 'Analysis incomplete',
        description: 'Unable to automatically assess this vendor. Please verify compliance manually.' }],
      actionItems: [
        'Confirm their ICO registration at ico.org.uk/ESDWebPages/Search',
        'Request their Data Processing Agreement',
        'Confirm data storage location and international transfer mechanism',
      ],
      dimensions: {},
    };
  }
}
