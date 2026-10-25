// ─────────────────────────────────────────────────────────────
// SENDWIZE — dpa-scan.js v1.4
//
// v1.4: checks moved to _processor-rules.js and corrected against Article
//   28: (e) and (f) checked separately, plus 28(4) sub-processor flow-down
//   and the duty to flag infringing instructions. A UK transfer tool (IDTA,
//   UK Addendum, UK-US Data Bridge, BCRs) is now needed for a pass; EU
//   SCCs or EU-US DPF alone count as partial. Each result carries `a28`,
//   the register clause card it feeds.
//
// v1.3 (security): request authenticated via _auth.js; the verified member
//   id replaces any userId from the browser. vendorRegisterId must belong
//   to the caller. Calls to generate-fix carry the internal secret.
//
// v1.2 fix: anthropic-version reverted to 2023-06-01 (only valid version),
//   added anthropic-beta: pdfs-2024-09-25 header for PDF document support.
//
// v1.1 changes from v1.0:
//   + PDF support: sourceType 'pdf' with base64 PDF in sourceContent.
//     Claude extracts text from PDF, then same deterministic checks
//     run on the extracted text. AI extracts, regex detects — D2 preserved.
//   ~ Everything else unchanged from v1.0.
//
// POST { userId, vendorName, vendorRegisterId?, sourceType, sourceContent }
//   sourceType:    'url' | 'text' | 'pdf'
//   sourceContent: URL to scrape, pasted text, or base64-encoded PDF
// ─────────────────────────────────────────────────────────────

import { claudeFetch } from './_claude.js';
import { requireAuth, internalHeaders, isRecordId, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import { fetchPage } from './_page-scan.js';
import { runArticle28Checks } from './_processor-rules.js';

const APP_URL = 'https://sendwize-backend.vercel.app';
const SCRAPE_TIMEOUT_MS = 10000;
const SCRAPE_MAX_CHARS  = 40000;
const SCRAPE_UA = 'Mozilla/5.0 (compatible; SendwizeComplianceBot/1.0; +https://sendwize.com/bot)';
const PDF_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// v1.4: the Article 28 checks live in _processor-rules.js (shared with
// the register and vendor monitor).

// ── scrapePolicy ──────────────────────────────────────────────
async function scrapePolicy(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    // SSRF-safe fetch (blocks internal hosts on every redirect hop)
    const page = await fetchPage(url, { allowText: true });
    if (!page.ok) return null;
    const raw = page.html;
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ').trim();
    if (text.length < 500) return null;
    return text.slice(0, SCRAPE_MAX_CHARS);
  } catch (e) {
    console.error('scrapePolicy failed:', e.message);
    return null;
  }
}

// ── v1.2: extractTextFromPdf ──────────────────────────────────
// Sends PDF to Claude asking ONLY for text extraction.
// AI extracts, regex detects — D2 preserved.
async function extractTextFromPdf(pdfBase64) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await claudeFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: 'Extract and return the full text content of this document. Return ONLY the plain text — no commentary, no analysis, no markdown formatting, no headers you add. Just the document text exactly as written.',
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('PDF text extraction failed:', response.status, errText.slice(0, 300));
    return null;
  }

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  if (text.length < 500) return null;
  return text.slice(0, SCRAPE_MAX_CHARS);
}

// ── extractQuotesWithAI ───────────────────────────────────────
async function extractQuotesWithAI(text, results) {
  const evidenceable = results.filter(r => r.status !== 'missing');
  if (!evidenceable.length) return {};

  const fallbackSnippet = (matchIndex) => {
    if (matchIndex < 0) return null;
    const start = Math.max(0, matchIndex - 60);
    const end = Math.min(text.length, matchIndex + 260);
    return '\u2026' + text.slice(start, end).trim() + '\u2026';
  };

  try {
    const clauseList = evidenceable
      .map(r => '- id: ' + r.id + ' | ' + r.label + ' (' + r.articleRef + ')')
      .join('\n');

    const response = await claudeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        max_tokens: 2000,
        messages: [{ role: 'user', content:
          'You are looking at a Data Processing Agreement or Privacy Policy. For each of the clauses listed, find and quote the exact sentence or short passage from the document that addresses it. Do NOT paraphrase. Do NOT interpret. Quote verbatim from the document. If a clause is not clearly addressed, return null for that item.\n\nDOCUMENT:\n"""\n' + text.slice(0, 15000) + '\n"""\n\nCLAUSES TO FIND QUOTES FOR:\n' + clauseList + '\n\nRespond ONLY with JSON, no markdown fences:\n{\n  "quotes": [\n    { "id": "<clause id from list above>", "quote": "<exact quoted sentence(s) from document, or null>" }\n  ]\n}'
        }],
      }),
    });

    if (!response.ok) throw new Error('Claude ' + response.status);
    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const map = {};
    for (const q of parsed.quotes || []) {
      if (q && q.id) map[q.id] = q.quote || null;
    }
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

// ── slugify ───────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ── emitFixesForMissing ───────────────────────────────────────
async function emitFixesForMissing(userId, vendorName, results) {
  const vendorSlug = slugify(vendorName);
  for (const r of results) {
    if (r.status === 'found') continue;
    const severity = r.status === 'partial' ? 'medium' : r.severity;
    const statusWord = r.status === 'partial' ? 'partially covered' : 'not found';
    const description = 'DPA Scanner \u2014 ' + vendorName + ': ' + r.label + ' ' + statusWord + ' in the reviewed document. ' + r.missingDetail;
    try {
      await fetch(APP_URL + '/api/generate-fix', {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          userId, fixType: 'dpa_breach', description,
          tool: 'DPA Scanner \u2014 ' + vendorName,
          severity, sourceRecordId: 'dpa-scan-' + vendorSlug + '-' + r.id,
        }),
      });
    } catch (e) { console.error('generate-fix failed for ' + r.id + ':', e.message); }
  }
}

// ── markPreviouslyMissingAsImproved ───────────────────────────
async function markPreviouslyMissingAsImproved(userId, vendorName, results) {
  const foundResults = results.filter(r => r.status === 'found');
  if (!foundResults.length) return;

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const atBase = 'https://api.airtable.com/v0/' + BASE_ID;
  const atH = { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' };
  const vendorSlug = slugify(vendorName);
  const now = new Date().toISOString();

  for (const r of foundResults) {
    const sourceRecordId = 'dpa-scan-' + vendorSlug + '-' + r.id;
    try {
      const formula = "AND({UserID}='" + userId + "',{SourceRecordID}='" + sourceRecordId + "',{Status}='pending')";
      const findRes = await fetch(
        atBase + '/Compliance_Fixes?filterByFormula=' + encodeURIComponent(formula) + '&maxRecords=1',
        { headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN } }
      );
      if (!findRes.ok) continue;
      const fixRecord = (await findRes.json()).records?.[0];
      if (!fixRecord) continue;
      if (fixRecord.fields.ImprovedOnRerun) continue;

      const hint = {
        previousState: r.label + ' (' + r.articleRef + ') was not found in the previously reviewed document.',
        newState: r.quote
          ? 'Now covered: "' + String(r.quote).slice(0, 220) + '"'
          : r.label + ' is now covered in the latest scan.',
        detectedAt: now, source: 'dpa-scan',
      };
      await fetch(atBase + '/Compliance_Fixes/' + fixRecord.id, {
        method: 'PATCH', headers: atH,
        body: JSON.stringify({ fields: { ImprovedOnRerun: JSON.stringify(hint) } }),
      });
    } catch (e) { console.error('ImprovedOnRerun mark failed for ' + r.id + ':', e.message); }
  }
}

// ── persistScan ───────────────────────────────────────────────
async function persistScan(userId, vendorName, vendorRegisterId, sourceType, sourceRef, results, score) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.BASE_ID;
  const atBase = 'https://api.airtable.com/v0/' + BASE_ID;
  const atH = { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];

  const clausesFound   = results.filter(r => r.status === 'found').length;
  const clausesPartial = results.filter(r => r.status === 'partial').length;
  const clausesMissing = results.filter(r => r.status === 'missing').length;

  let scanRecordId = null;
  try {
    const saveRes = await fetch(atBase + '/DPA_Scans', {
      method: 'POST', headers: atH,
      body: JSON.stringify({ records: [{ fields: {
        UserID: userId, VendorName: vendorName, ScanDate: today,
        SourceType: sourceType, SourceRef: String(sourceRef || '').slice(0, 500),
        ArticleResults: JSON.stringify(results),
        ClausesFound: clausesFound, ClausesPartial: clausesPartial,
        ClausesMissing: clausesMissing, OverallScore: score,
      }}]}),
    });
    if (saveRes.ok) scanRecordId = (await saveRes.json()).records?.[0]?.id || null;
    else console.error('DPA_Scans save failed:', saveRes.status);
  } catch (e) { console.error('DPA_Scans save error:', e.message); }

  if (vendorRegisterId) {
    try {
      await fetch(atBase + '/Vendor_Register/' + vendorRegisterId, {
        method: 'PATCH', headers: atH,
        body: JSON.stringify({ fields: {
          LastDPAScanDate: today, LastDPAScanScore: score,
          LastDPAScanClausesMissing: clausesMissing,
        }}),
      });
    } catch (e) { console.error('Vendor_Register update error:', e.message); }
  }

  return scanRecordId;
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Identity: the verified member id replaces any userId sent by the browser
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!(await checkLimit(req, res, auth, 'dpa_scan'))) return;
    const { userId, vendorName, vendorRegisterId, sourceType, sourceContent } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!vendorName) return res.status(400).json({ error: 'vendorName is required' });
    if (!['url', 'text', 'pdf'].includes(sourceType)) return res.status(400).json({ error: 'sourceType must be url, text, or pdf' });
    if (!sourceContent) return res.status(400).json({ error: 'sourceContent is required' });

    // v1.3: a vendor record can only be updated by its owner
    if (vendorRegisterId) {
      if (!isRecordId(vendorRegisterId)) return res.status(400).json({ error: 'Invalid vendorRegisterId' });
      const vr = await fetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/Vendor_Register/${vendorRegisterId}`, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
      const v = vr.ok ? await vr.json() : null;
      if (!v || v.fields?.UserID !== userId) return res.status(404).json({ error: 'Vendor not found' });
    }

    // 1. Get text
    let text = null;
    let sourceRef = sourceContent;

    if (sourceType === 'url') {
      text = await scrapePolicy(sourceContent);
      if (!text) {
        return res.status(422).json({
          error: 'Could not fetch or extract text from that URL. Try uploading the PDF instead.',
          scrapedFailed: true,
        });
      }
    } else if (sourceType === 'pdf') {
      // v1.1: PDF support — Claude extracts text, regex detects clauses
      const approxBytes = Math.floor(sourceContent.length * 0.75);
      if (approxBytes > PDF_MAX_BYTES) {
        return res.status(413).json({ error: 'PDF too large \u2014 max 10MB' });
      }
      text = await extractTextFromPdf(sourceContent);
      if (!text) {
        return res.status(422).json({
          error: 'Could not extract text from this PDF. The file may be image-only or corrupted. Try pasting the DPA text directly.',
          extractionFailed: true,
        });
      }
      sourceRef = 'pdf-upload';
    } else {
      text = String(sourceContent).slice(0, SCRAPE_MAX_CHARS);
      sourceRef = 'pasted:' + text.slice(0, 80) + '\u2026';
    }

    if (text.length < 500) {
      return res.status(422).json({
        error: 'The provided text is too short to be a meaningful DPA or privacy policy. Please provide the full document.',
      });
    }

    // 2. Run deterministic checks
    const results = runArticle28Checks(text);

    // 3. AI quote extraction for found/partial
    const quotes = await extractQuotesWithAI(text, results);
    for (const r of results) {
      r.quote = quotes[r.id] || null;
    }

    // Overall score
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
      success: true, scanRecordId, vendorName, score,
      counts: { found: foundCount, partial: partialCount, missing: missingCount, total: results.length },
      results,
      disclaimer: 'Sendwize checked this document against UK GDPR Article 28(2)-(4) and Chapter V requirements. This is a factual gap check, not legal advice. Not all clauses may be present in this exact wording in every valid DPA \u2014 consult your legal counsel if in doubt.',
    });

  } catch (error) {
    console.error('dpa-scan error:', error);
    return res.status(500).json({ error: 'DPA scan failed' });
  }
}
