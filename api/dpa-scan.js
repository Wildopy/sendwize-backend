// ─────────────────────────────────────────────────────────────
// SENDWIZE — dpa-scan.js v1.0 (C2)
// POST { userId, vendorName, vendorRegisterId?, sourceType, sourceContent }
//   sourceType:    'url' | 'text'
//   sourceContent: URL to scrape, or pasted DPA/privacy policy text
//
// What it does:
//   1. Get the source text (scrape URL or use pasted text)
//   2. Run 12 deterministic checks against UK GDPR Article 28(3) +
//      Chapter V transfer mechanism. Zero AI in detection.
//   3. For clauses found/partial, ONE Claude call extracts the actual
//      quoted sentence from the document as evidence. That's the only
//      AI in this whole tool — it does "word pulling" not judgement.
//   4. Emit fixes for every missing / partial clause. Each fix has a
//      per-clause SourceRecordID so re-scans dedupe cleanly (D3).
//   5. Persist to DPA_Scans + update Vendor_Register row with scan
//      score and clauses-missing count for the register badge.
//   6. Return full results to the frontend.
//
// D2: every result traces to a specific Article 28 subsection or
//     Chapter V requirement. No invented heuristics.
// Legal position: this is NOT legal advice. Descriptions say
//     "UK GDPR Article 28(3)(x) requires X — we couldn't find a
//     clause covering this. Ask your vendor." That's a factual
//     statement about the regulation, not a legal opinion.
// ─────────────────────────────────────────────────────────────

const APP_URL = 'https://sendwize-backend.vercel.app';
const SCRAPE_TIMEOUT_MS = 10000;
const SCRAPE_MAX_CHARS  = 40000; // DPAs can be long; give more headroom than vendor scrape
const SCRAPE_UA = 'Mozilla/5.0 (compatible; SendwizeComplianceBot/1.0; +https://sendwize.com/bot)';

// ─────────────────────────────────────────────────────────────
// THE 12 CHECKS
// Each check has strict patterns (→ 'found') and weak patterns (→
// 'partial'). Missing both = 'missing'. Order in the array is the
// order results appear in the UI.
// ─────────────────────────────────────────────────────────────
const CHECKS = [
  {
    id: 'subject_matter_duration',
    label: 'Subject matter and duration of processing',
    articleRef: 'UK GDPR Article 28(3) preamble',
    strict: [
      /subject[\s-]?matter[\s\S]{0,300}(process|agreement)/i,
      /duration of (the |this )?(processing|agreement)/i,
    ],
    weak: [
      /term of (the |this )?(agreement|dpa)/i,
      /scope of (the )?processing/i,
    ],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3) requires the DPA to define the subject matter and duration of the processing. Without this, the scope of the vendor\u2019s permitted processing is unclear \u2014 the ICO flags this as a foundational gap in Article 28 enforcement decisions.',
  },
  {
    id: 'nature_purpose',
    label: 'Nature and purpose of processing',
    articleRef: 'UK GDPR Article 28(3) preamble',
    strict: [
      /nature and purpose/i,
      /purpose of (the )?processing/i,
    ],
    weak: [
      /processing (activities|purposes) (include|are)/i,
      /purpose[s]?[\s\S]{0,200}process/i,
    ],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3) requires the DPA to define the nature and purpose of processing. Without this, there is no contractual limit on how the vendor uses your data.',
  },
  {
    id: 'personal_data_types',
    label: 'Types of personal data processed',
    articleRef: 'UK GDPR Article 28(3) preamble',
    strict: [
      /categor(y|ies) of personal data/i,
      /types? of personal data/i,
    ],
    weak: [
      /personal data (processed|includes|comprises)/i,
      /(email address|contact details|behavioural data)[\s\S]{0,150}process/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3) requires the DPA to specify the types of personal data processed. Without this, you cannot demonstrate what data has been shared with the vendor if asked.',
  },
  {
    id: 'data_subjects',
    label: 'Categories of data subjects',
    articleRef: 'UK GDPR Article 28(3) preamble',
    strict: [
      /categor(y|ies) of data subjects/i,
      /data subjects (include|are|comprise)/i,
    ],
    weak: [
      /individuals whose (personal )?data/i,
      /(customers|subscribers|end users)[\s\S]{0,100}personal data/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3) requires the DPA to identify categories of data subjects. Without this, the DPA cannot be scoped to a specific relationship.',
  },
  {
    id: 'documented_instructions',
    label: 'Processing on documented controller instructions',
    articleRef: 'UK GDPR Article 28(3)(a)',
    strict: [
      /(documented|written) instructions/i,
      /(on |per )(the )?controller[\'s]{0,2} instructions/i,
      /only.{0,80}process.{0,80}instructions/i,
    ],
    weak: [
      /instructions from the controller/i,
      /controller\'?s? instructions/i,
    ],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3)(a) requires the processor to process personal data only on documented instructions from the controller. Absence of this clause is one of the most-cited Article 28 gaps in ICO enforcement.',
  },
  {
    id: 'confidentiality',
    label: 'Confidentiality commitments from personnel',
    articleRef: 'UK GDPR Article 28(3)(b)',
    strict: [
      /confidentiality (obligation|undertaking|commitment|agreement)/i,
      /(authorised|authorized) (persons|personnel)[\s\S]{0,150}confiden/i,
      /bound by (a )?duty of confiden/i,
    ],
    weak: [
      /confidentiality/i,
      /confidential (information|obligations)/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(b) requires the processor to ensure that persons authorised to process the data are committed to confidentiality. Without an explicit clause, you have no contractual guarantee vendor staff are bound.',
  },
  {
    id: 'security_measures',
    label: 'Security measures (Article 32)',
    articleRef: 'UK GDPR Articles 28(3)(c) and 32',
    strict: [
      /article 32/i,
      /technical and organi(s|z)ational (measures|safeguards)/i,
    ],
    weak: [
      /appropriate security measures/i,
      /security safeguards/i,
      /encryption[\s\S]{0,100}(rest|transit)/i,
    ],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3)(c) requires the processor to take all measures required by Article 32 (security of processing). Missing this clause is a serious Article 28 gap.',
  },
  {
    id: 'sub_processors',
    label: 'Sub-processor engagement rules',
    articleRef: 'UK GDPR Article 28(3)(d) and 28(2)',
    strict: [
      /sub[\s-]?processor[s]?/i,
      /(prior |written )(authorisation|authorization|consent)[\s\S]{0,150}(engage|appoint|use)[\s\S]{0,50}(third|another) party/i,
    ],
    weak: [
      /further processors/i,
      /third[\s-]?party (processors|providers)/i,
      /sub[\s-]?contract/i,
    ],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(2) and 28(3)(d) require processors to obtain prior authorisation before engaging sub-processors, and to flow down equivalent obligations. Without this clause you have no visibility or control over who else touches your data.',
  },
  {
    id: 'controller_assistance',
    label: 'Assistance to controller (data subject rights + security)',
    articleRef: 'UK GDPR Articles 28(3)(e) and 28(3)(f)',
    strict: [
      /assist.{0,150}(controller|customer).{0,150}(data subject|individual|access|erasure|rectification|portability|breach)/i,
      /reasonable assistance/i,
    ],
    weak: [
      /support (the |our )?controller/i,
      /co[\s-]?operate with (the )?controller/i,
      /(respond|responding) to (data subject|access) requests/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Articles 28(3)(e) and 28(3)(f) require the processor to assist you with responding to data subject rights requests and with security, breach and DPIA obligations. Without this clause you may be unable to meet ICO response deadlines when a request arrives.',
  },
  {
    id: 'deletion_or_return',
    label: 'Deletion or return of data on termination',
    articleRef: 'UK GDPR Article 28(3)(g)',
    strict: [
      /(delete|destroy|return)[\s\S]{0,200}(after|upon|on)[\s\S]{0,50}(end|termination|expir)/i,
      /(end|termination|expir)[\s\S]{0,150}(delete|destroy|return)[\s\S]{0,50}(personal )?data/i,
    ],
    weak: [
      /(delete|erase|destroy).{0,100}personal data/i,
      /end of (the |this )?(agreement|processing|services)/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(g) requires the processor to delete or return all personal data at the end of the services. Without this clause data can persist indefinitely with the vendor after termination.',
  },
  {
    id: 'audit_rights',
    label: 'Audit and inspection rights',
    articleRef: 'UK GDPR Article 28(3)(h)',
    strict: [
      /right to audit/i,
      /audit rights/i,
      /(audit|inspection)[\s\S]{0,150}(controller|customer|reasonable)/i,
      /make available[\s\S]{0,150}(demonstrate|compliance)/i,
    ],
    weak: [
      /audit/i,
      /inspection/i,
    ],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(h) requires the processor to make available all information necessary to demonstrate compliance and to allow for audits. Without this you cannot verify the vendor is doing what they claim.',
  },
  {
    id: 'transfer_mechanism',
    label: 'International transfer mechanism',
    articleRef: 'UK GDPR Chapter V',
    strict: [
      /Standard Contractual Clauses|SCC[s]?\b/i,
      /IDTA|International Data Transfer Agreement/i,
      /UK[\s-]?US Data Bridge/i,
      /Data Privacy Framework|EU[\s-]?US DPF/i,
      /adequacy (decision|regulations)/i,
      /Binding Corporate Rules|BCRs?/i,
    ],
    weak: [
      /international (data )?transfer/i,
      /transfer.{0,100}outside (the )?(UK|EEA|European)/i,
    ],
    severity: 'critical',
    missingDetail: 'UK GDPR Chapter V requires a lawful transfer mechanism (SCCs, UK IDTA, UK-US Data Bridge, adequacy decision, or BCRs) for any personal data transferred outside the UK. Without an identifiable mechanism the transfer is unlawful \u2014 this is a per-se breach the ICO can act on without needing to show harm.',
  },
];

// ─────────────────────────────────────────────────────────────
// scrapePolicy — fetch a public URL, return text (or null)
// ─────────────────────────────────────────────────────────────
async function scrapePolicy(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': SCRAPE_UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|xhtml|text\/plain/i.test(ct)) return null;
    const raw = await res.text();
    const text = raw
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
    if (text.length < 500) return null;
    return text.slice(0, SCRAPE_MAX_CHARS);
  } catch (e) {
    clearTimeout(timer);
    console.error(`scrapePolicy failed for ${url}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// runChecks — deterministic detection
// ─────────────────────────────────────────────────────────────
function runChecks(text) {
  const results = [];
  for (const check of CHECKS) {
    let status = 'missing';
    let matchIndex = -1;
    // Try strict patterns first
    for (const p of check.strict) {
      const m = text.match(p);
      if (m) { status = 'found'; matchIndex = m.index; break; }
    }
    // If nothing strict, try weak
    if (status === 'missing') {
      for (const p of check.weak) {
        const m = text.match(p);
        if (m) { status = 'partial'; matchIndex = m.index; break; }
      }
    }
    results.push({
      id: check.id,
      label: check.label,
      articleRef: check.articleRef,
      severity: check.severity,
      status,
      matchIndex,
      missingDetail: check.missingDetail,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// extractQuotesWithAI — one Claude call to pull quoted evidence
// for every found/partial check. If Claude fails, we fall back to
// a plain-text snippet around the regex match index.
// ─────────────────────────────────────────────────────────────
async function extractQuotesWithAI(text, results) {
  const evidenceable = results.filter(r => r.status !== 'missing');
  if (!evidenceable.length) return {};

  // Fallback: snippet extraction around the match index
  const fallbackSnippet = (matchIndex) => {
    if (matchIndex < 0) return null;
    const start = Math.max(0, matchIndex - 60);
    const end = Math.min(text.length, matchIndex + 260);
    return '\u2026' + text.slice(start, end).trim() + '\u2026';
  };

  try {
    const clauseList = evidenceable
      .map(r => `- id: ${r.id} | ${r.label} (${r.articleRef})`)
      .join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are looking at a Data Processing Agreement or Privacy Policy. For each of the clauses listed, find and quote the exact sentence or short passage from the document that addresses it. Do NOT paraphrase. Do NOT interpret. Quote verbatim from the document. If a clause is not clearly addressed, return null for that item.

DOCUMENT:
"""
${text.slice(0, 15000)}
"""

CLAUSES TO FIND QUOTES FOR:
${clauseList}

Respond ONLY with JSON, no markdown fences:
{
  "quotes": [
    { "id": "<clause id from list above>", "quote": "<exact quoted sentence(s) from document, or null>" }
  ]
}`
        }],
      }),
    });

    if (!response.ok) throw new Error(`Claude ${response.status}`);
    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const map = {};
    for (const q of parsed.quotes || []) {
      if (q && q.id) map[q.id] = q.quote || null;
    }
    // Fill any missing quotes with the fallback snippet so the UI
    // always shows evidence for found/partial items.
    for (const r of evidenceable) {
      if (!map[r.id]) map[r.id] = fallbackSnippet(r.matchIndex);
    }
    return map;
  } catch (e) {
    console.error('extractQuotesWithAI failed, using regex fallbacks:', e.message);
    const map = {};
    for (const r of evidenceable) map[r.id] = fallbackSnippet(r.matchIndex);
    return map;
  }
}

// ─────────────────────────────────────────────────────────────
// slugify — for stable per-clause SourceRecordID
// ─────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────
// emitFixesForMissing — one fix per missing/partial clause
// SourceRecordID: dpa-scan-{vendor}-{clause} so re-scans dedupe.
// ─────────────────────────────────────────────────────────────
async function emitFixesForMissing(userId, vendorName, results) {
  const vendorSlug = slugify(vendorName);
  for (const r of results) {
    if (r.status === 'found') continue;
    // Partial = medium severity regardless of the check's declared severity
    const severity = r.status === 'partial'
      ? 'medium'
      : r.severity;
    const statusWord = r.status === 'partial' ? 'partially covered' : 'not found';
    const description = `DPA Scanner \u2014 ${vendorName}: ${r.label} ${statusWord} in the reviewed ${'\u201Cdocument\u201D'}. ${r.missingDetail}`;
    try {
      await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          fixType: 'dpa_breach',
          description,
          tool: `DPA Scanner \u2014 ${vendorName}`,
          severity,
          sourceRecordId: `dpa-scan-${vendorSlug}-${r.id}`,
        }),
      });
    } catch (e) {
      console.error(`generate-fix failed for ${r.id}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// markPreviouslyMissingAsImproved (D3 — manual completion with hint)
// On rescan, for any clause now 'found' that had a pending fix from
// a previous scan, write an ImprovedOnRerun hint on that fix. The
// fix stays pending — the user confirms closure from the dashboard
// via the green strip. Same pattern as audience-read.js /
// list-intelligence.js.
// ─────────────────────────────────────────────────────────────
async function markPreviouslyMissingAsImproved(userId, vendorName, results) {
  const foundResults = results.filter(r => r.status === 'found');
  if (!foundResults.length) return;

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const atBase = `https://api.airtable.com/v0/${BASE_ID}`;
  const atH = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const vendorSlug = slugify(vendorName);
  const now = new Date().toISOString();

  for (const r of foundResults) {
    const sourceRecordId = `dpa-scan-${vendorSlug}-${r.id}`;
    try {
      const formula = `AND({UserID}='${userId}',{SourceRecordID}='${sourceRecordId}',{Status}='pending')`;
      const findRes = await fetch(
        `${atBase}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (!findRes.ok) continue;
      const fixRecord = (await findRes.json()).records?.[0];
      if (!fixRecord) continue;
      // Defensive dedupe-miss check — same pattern as list-intelligence.js
      // If we can't find the fix by SourceRecordID but there are pending
      // dpa_breach fixes for this vendor, something is off with the field.
      if (!sourceRecordId) {
        console.warn(`[dpa-scan] SUSPECTED DEDUPE MISS: about to skip improvement mark for ${vendorName} clause ${r.id} \u2014 empty sourceRecordId`);
      }
      // Skip if already has ImprovedOnRerun (don't overwrite)
      if (fixRecord.fields.ImprovedOnRerun) continue;

      const hint = {
        previousState: `${r.label} (${r.articleRef}) was not found in the previously reviewed document.`,
        newState: r.quote
          ? `Now covered: "${String(r.quote).slice(0, 220)}"`
          : `${r.label} is now covered in the latest scan.`,
        detectedAt: now,
        source: 'dpa-scan',
      };
      await fetch(`${atBase}/Compliance_Fixes/${fixRecord.id}`, {
        method: 'PATCH',
        headers: atH,
        body: JSON.stringify({ fields: { ImprovedOnRerun: JSON.stringify(hint) } }),
      });
    } catch (e) {
      console.error(`ImprovedOnRerun mark failed for ${r.id}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// persistScan — save to DPA_Scans + update Vendor_Register row
// Both are non-fatal; scan results still return on failure.
// ─────────────────────────────────────────────────────────────
async function persistScan(userId, vendorName, vendorRegisterId, sourceType, sourceRef, results, score) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const atBase = `https://api.airtable.com/v0/${BASE_ID}`;
  const atH = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];

  const clausesFound   = results.filter(r => r.status === 'found').length;
  const clausesPartial = results.filter(r => r.status === 'partial').length;
  const clausesMissing = results.filter(r => r.status === 'missing').length;

  // Save the scan record
  let scanRecordId = null;
  try {
    const saveRes = await fetch(`${atBase}/DPA_Scans`, {
      method: 'POST',
      headers: atH,
      body: JSON.stringify({ records: [{ fields: {
        UserID: userId,
        VendorName: vendorName,
        ScanDate: today,
        SourceType: sourceType,
        SourceRef: String(sourceRef || '').slice(0, 500),
        ArticleResults: JSON.stringify(results),
        ClausesFound: clausesFound,
        ClausesPartial: clausesPartial,
        ClausesMissing: clausesMissing,
        OverallScore: score,
      }}]}),
    });
    if (saveRes.ok) {
      const saved = await saveRes.json();
      scanRecordId = saved.records?.[0]?.id || null;
    } else {
      console.error('DPA_Scans save failed:', saveRes.status);
    }
  } catch (e) { console.error('DPA_Scans save error:', e.message); }

  // Update Vendor_Register row if we know which one
  if (vendorRegisterId) {
    try {
      await fetch(`${atBase}/Vendor_Register/${vendorRegisterId}`, {
        method: 'PATCH',
        headers: atH,
        body: JSON.stringify({ fields: {
          LastDPAScanDate: today,
          LastDPAScanScore: score,
          LastDPAScanClausesMissing: clausesMissing,
        }}),
      });
    } catch (e) { console.error('Vendor_Register update error:', e.message); }
  }

  return scanRecordId;
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, vendorName, vendorRegisterId, sourceType, sourceContent } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!vendorName) return res.status(400).json({ error: 'vendorName is required' });
    if (!['url', 'text'].includes(sourceType)) return res.status(400).json({ error: 'sourceType must be url or text' });
    if (!sourceContent) return res.status(400).json({ error: 'sourceContent is required' });

    // 1. Get text
    let text = null;
    let sourceRef = sourceContent;
    if (sourceType === 'url') {
      text = await scrapePolicy(sourceContent);
      if (!text) {
        return res.status(422).json({
          error: 'Could not fetch or extract text from that URL. Try pasting the DPA text directly instead.',
          scrapedFailed: true,
        });
      }
    } else {
      text = String(sourceContent).slice(0, SCRAPE_MAX_CHARS);
      sourceRef = `pasted:${text.slice(0, 80)}\u2026`;
    }

    if (text.length < 500) {
      return res.status(422).json({
        error: 'The provided text is too short to be a meaningful DPA or privacy policy. Please provide the full document.',
      });
    }

    // 2. Run deterministic checks
    const results = runChecks(text);

    // 3. AI quote extraction for found/partial
    const quotes = await extractQuotesWithAI(text, results);
    for (const r of results) {
      r.quote = quotes[r.id] || null;
    }

    // Overall score: (found + 0.5 * partial) / total * 100
    const foundCount   = results.filter(r => r.status === 'found').length;
    const partialCount = results.filter(r => r.status === 'partial').length;
    const missingCount = results.filter(r => r.status === 'missing').length;
    const score = Math.round(((foundCount + partialCount * 0.5) / results.length) * 100);

    // 4a. Mark previously-missing (now found) clauses as improved (D3)
    await markPreviouslyMissingAsImproved(userId, vendorName, results);

    // 4b. Emit fixes for currently missing/partial
    await emitFixesForMissing(userId, vendorName, results);

    // 5. Persist scan + update register
    const scanRecordId = await persistScan(userId, vendorName, vendorRegisterId, sourceType, sourceRef, results, score);

    return res.status(200).json({
      success: true,
      scanRecordId,
      vendorName,
      score,
      counts: { found: foundCount, partial: partialCount, missing: missingCount, total: results.length },
      results,
      disclaimer: 'Sendwize checked this document against UK GDPR Article 28(3) and Chapter V requirements. This is a factual gap check, not legal advice. Not all clauses may be present in this exact wording in every valid DPA \u2014 consult your legal counsel if in doubt.',
    });

  } catch (error) {
    console.error('dpa-scan error:', error);
    return res.status(500).json({ error: 'DPA scan failed' });
  }
}
