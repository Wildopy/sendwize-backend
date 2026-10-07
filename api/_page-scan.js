// ─────────────────────────────────────────────────────────────
// SENDWIZE — _page-scan.js v1.1  (used by submit-check.js v5.2 and site-sweep.js v1.0)
//
// Campaign-level page scanner for Campaign Defence.
// Underscore prefix: Vercel does not expose this file as an endpoint.
//
// v1.1 — CHECK OWNERSHIP (no duplication with Site Sweep):
//   Campaign scan owns OFFER and CLAIM checks on the pages a campaign
//   links to: claim conflicts, reference pricing, drip pricing,
//   urgency, scarcity, offer terms link, affiliate ad disclosure.
//   Site Sweep owns SITE-WIDE checks: cookies and trackers, privacy
//   and cookie notices, sign-up consent (pre-ticked boxes, privacy
//   link at capture), reviews, business identity. Those checks were
//   removed from this file's campaign findings. extractSignals() is
//   shared so both tools read pages the same way.
//
// Same principle as Vendor Register v7.4:
//   evidence → deterministic checks → AI interpretation → findings
//   1. Fetch the page HTML (static, as served)
//   2. Deterministic signal extraction: prices, reference pricing,
//      countdown timers, urgency/scarcity language, extra fees,
//      terms/privacy links, pre-ticked marketing boxes, review
//      widgets, tracking tags visible in source, ad disclosure
//   3. Claude (temperature 0) reviews detections for relevance and
//      checks the page against the campaign's extracted claims
//   4. AI interprets evidence, never manufactures it: every AI
//      excerpt is verified against the page text server-side and
//      dropped if it does not appear on the page
//
// Honest scope:
//   - Static HTML only. Content rendered by JavaScript after load
//     (some Shopify themes, SPAs, late-injected timers) may be missed.
//   - Tags injected via a tag manager are not visible. Proper cookie
//     and tracker compliance needs a headless browser (planned:
//     company-level site scan).
//
// Evidence types used: page_observed (new — detected in page source),
// ai_assessment (Claude interpretation backed by a verified excerpt).
// ─────────────────────────────────────────────────────────────

export const PAGE_SCAN_VERSION = '1.0';

const MODEL             = 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS  = 8000;
const CLAUDE_TIMEOUT_MS = 20000;
const MAX_PAGES         = 6;
const MAX_HTML_CHARS    = 1_500_000;
const PAGE_TEXT_FOR_AI  = 7000;
const MIN_TEXT_LENGTH   = 200;
const USER_AGENT        = 'Mozilla/5.0 (compatible; Sendwize-PageScan/1.0)';

export const VERDICT_LABELS = {
  passed:          'Passed',
  needs_attention: 'Needs attention',
  not_evidenced:   'Not evidenced',
  error:           'Could not scan',
};

// ── URL safety (prevents the scanner being pointed at internal hosts) ──
export function isSafePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'Invalid URL' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'Only http(s) pages can be scanned' };
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'Private hostname' };
  }
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'IP address URLs are not supported' };
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return { ok: false, reason: 'Private IP address' };
    }
  }
  return { ok: true, url: u.toString() };
}

// ── Fetch (manual redirects so every hop is safety-checked) ──
export async function fetchPage(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const safe = isSafePublicUrl(current);
    if (!safe.ok) return { ok: false, error: safe.reason, finalUrl: current };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(safe.url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: e.name === 'AbortError' ? 'Page took too long to respond' : e.message, finalUrl: current };
    }

    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(r.headers.get('location'), safe.url).toString();
      continue;
    }
    if (!r.ok) { clearTimeout(timer); return { ok: false, error: `HTTP ${r.status}`, httpStatus: r.status, finalUrl: current }; }

    const ct = r.headers.get('content-type') || '';
    if (ct && !ct.includes('html')) {
      clearTimeout(timer);
      return { ok: false, error: `Not an HTML page (${ct.split(';')[0]})`, httpStatus: r.status, finalUrl: current };
    }
    let html;
    try { html = await r.text(); }
    catch (e) { return { ok: false, error: 'Page body could not be read', finalUrl: current }; }
    finally { clearTimeout(timer); }
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS);
    return { ok: true, html, httpStatus: r.status, finalUrl: current };
  }
  return { ok: false, error: 'Too many redirects', finalUrl: current };
}

// ── Text helpers ──
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&pound;|&#163;|&#xa3;/gi, '£')
    .replace(/&euro;|&#8364;/gi, '€')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;|&rsquo;|&lsquo;|&#8217;|&#8216;/gi, "'")
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&amp;/gi, '&');
}

export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s) {
  return decodeEntities(String(s || '')).toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
}
function strip(s) { return s.replace(/[^a-z0-9£%]+/g, ' ').trim(); }

function excerptInText(excerpt, normText, strippedText) {
  const e = norm(excerpt).replace(/^…|…$/g, '').replace(/^["']|["']$/g, '').trim();
  if (e.length < 4) return false;
  if (normText.includes(e)) return true;
  const se = strip(e);
  return se.length >= 4 && strippedText.includes(se);
}

function excerptsFor(text, regex, max = 3, radius = 70) {
  const out = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const start = Math.max(0, m.index - radius);
    const end = Math.min(text.length, m.index + m[0].length + radius);
    out.push((start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : ''));
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Detection patterns ──
const RX = {
  price:        /£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g,
  refPriceText: /\b(was|rrp|previously|originally|compare at|regular price|usual price)\b\s*:?\s*£\s?\d/gi,
  refPriceHtml: /<(s|del|strike)\b|class=["'][^"']*(compare-at|compare_at|was-price|was_price|price--compare|old-price|price-old|line-through|strikethrough)[^"']*["']/i,
  countdown:    /(class|id)=["'][^"']*(countdown|count-down|count_down|timer)[^"']*["']|data-(countdown|deadline|end-?date|end-?time|expires?)=/i,
  timeUrgency:  /\b(ends (tonight|today|soon|at midnight|midnight|this weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last chance|final hours|hurry|limited time( only)?|today only|24 hours only|while stocks? last|once it'?s gone|don'?t miss out)\b/gi,
  stockUrgency: /\b(only \d+ left|\d+ left in stock|low (in )?stock|selling fast|almost gone|nearly sold out|\d+ (people|others|shoppers) (are )?(viewing|looking at|have this in)|in \d+ (baskets|carts|bags))\b/gi,
  fees:         /\b(booking fee|service (fee|charge)|admin(istration)? fee|handling fee|processing fee|card (payment )?fee|resort fee|platform fee|plus fees|fees apply|excl(\.|uding)? (vat|fees))\b/gi,
  free:         /\bfree\b/gi,
  adDisclosure: /(#ad\b|#advert|\badvertisement\b|\bsponsored\b|paid partnership|affiliate (link|links|partner)|\bwe (may )?(earn|receive) (a )?commission|in partnership with)/gi,
  termsText:    /terms|conditions|t\s?&\s?c|\btcs\b/i,
  termsHref:    /terms|conditions|\/tcs?\b|t-and-c|t-c\b/i,
  privacy:      /privacy/i,
  form:         /<form\b[\s\S]*?<\/form>/gi,
  title:        /<title[^>]*>([\s\S]*?)<\/title>/i,
};

const TRACKER_PATTERNS = [
  ['Google Analytics / Tag Manager', /googletagmanager\.com|google-analytics\.com/i],
  ['Meta Pixel',                     /connect\.facebook\.net|fbq\(/i],
  ['TikTok Pixel',                   /analytics\.tiktok\.com|ttq\.load/i],
  ['LinkedIn Insight',               /snap\.licdn\.com|_linkedin_partner_id/i],
  ['Hotjar',                         /hotjar\.com/i],
  ['Microsoft Clarity',              /clarity\.ms/i],
  ['Pinterest Tag',                  /s\.pinimg\.com\/ct|pintrk\(/i],
  ['Snap Pixel',                     /sc-static\.net\/scevent|snaptr\(/i],
  ['Klaviyo',                        /static\.klaviyo\.com/i],
  ['Criteo',                         /static\.criteo\.net/i],
];
const CMP_PATTERNS = [
  ['OneTrust',   /cdn\.cookielaw\.org|onetrust/i],
  ['Cookiebot',  /consent\.cookiebot\.com|cookiebot/i],
  ['CookieYes',  /cookieyes/i],
  ['Didomi',     /didomi/i],
  ['Termly',     /termly\.io/i],
  ['Iubenda',    /iubenda/i],
  ['Usercentrics', /usercentrics/i],
  ['Shopify customer privacy', /customerPrivacy|consent-tracking-api/i],
];
const REVIEW_PATTERNS = [
  ['Trustpilot',  /trustpilot/i],
  ['Reviews.io',  /reviews\.io|reviews\.co\.uk/i],
  ['Feefo',       /feefo/i],
  ['Yotpo',       /yotpo/i],
  ['Judge.me',    /judge\.me/i],
  ['Okendo',      /okendo/i],
  ['Bazaarvoice', /bazaarvoice/i],
];

function matchNames(html, patterns) { return patterns.filter(([, re]) => re.test(html)).map(([n]) => n); }

export function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 600) {
    const hrefM = m[1].match(/href=["']([^"']+)["']/i);
    if (!hrefM) continue;
    let href = decodeEntities(hrefM[1]).trim();
    try { href = new URL(href, baseUrl).toString(); } catch { continue; }
    links.push({ href, text: htmlToText(m[2]).slice(0, 80) });
  }
  return links;
}

function findPreTickedMarketingBoxes(html) {
  const out = [];
  const re = /<input\b[^>]*type=["']?checkbox["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const tag = m[0];
    if (!/\schecked(\s|=|>|\/)/i.test(tag)) continue;
    const around = htmlToText(html.slice(m.index, m.index + 500)).slice(0, 160);
    const ctx = (tag + ' ' + around).toLowerCase();
    if (/market|newsletter|offers|promot|subscribe|news and|updates|partner|third part|sms|text message/.test(ctx)) {
      out.push(around || tag.slice(0, 120));
    }
  }
  return out;
}

// ── Step 2: deterministic signals ──
export function extractSignals(html, finalUrl) {
  const text = htmlToText(html);
  const titleM = html.match(RX.title);
  const links = extractLinks(html, finalUrl);
  const termsLink = links.find(l => RX.termsText.test(l.text) || RX.termsHref.test(l.href));
  const privacyLink = links.find(l => RX.privacy.test(l.text) || RX.privacy.test(l.href));
  const forms = html.match(RX.form) || [];
  const emailForms = forms.filter(f => /type=["']?email/i.test(f) || /name=["'][^"']*email/i.test(f)).length;
  const prices = text.match(RX.price) || [];

  const signals = {
    title: titleM ? htmlToText(titleM[1]).slice(0, 200) : '',
    textLength: text.length,
    prices: { count: prices.length, samples: [...new Set(prices.map(p => p.replace(/\s/g, '')))].slice(0, 8) },
    referencePricing: {
      detected: (text.match(RX.refPriceText) || []).length > 0 || RX.refPriceHtml.test(html),
      excerpts: excerptsFor(text, RX.refPriceText, 3),
    },
    countdownTimer: RX.countdown.test(html),
    timeUrgency: excerptsFor(text, RX.timeUrgency, 3),
    stockUrgency: excerptsFor(text, RX.stockUrgency, 3),
    additionalFees: excerptsFor(text, RX.fees, 3),
    freeMentions: (text.match(RX.free) || []).length,
    termsLink: termsLink ? { found: true, href: termsLink.href, text: termsLink.text } : { found: false },
    privacyLink: privacyLink ? { found: true, href: privacyLink.href } : { found: false },
    adDisclosure: excerptsFor(text, RX.adDisclosure, 2),
    emailSignupForms: emailForms,
    preTickedMarketingBoxes: findPreTickedMarketingBoxes(html),
    reviewWidgets: matchNames(html, REVIEW_PATTERNS),
    trackersInSource: matchNames(html, TRACKER_PATTERNS),
    consentPlatformInSource: matchNames(html, CMP_PATTERNS),
  };
  return { signals, text };
}

function finding(id, category, severity, regulator, title, detail, ruleRef, opts = {}) {
  return {
    id, category, severity, regulator, title, detail, ruleRef,
    excerpt: opts.excerpt || '',
    evidenceType: opts.evidenceType || 'page_observed',
    confidence: opts.confidence || 'medium',
    source: opts.source || 'rule',
  };
}

export function deterministicFindings(signals, pageType) {
  const out = [];
  const promo = signals.prices.count > 0 || signals.freeMentions > 0 || signals.timeUrgency.length > 0;
  const isOfferPage = ['landing_page', 'offer_page', 'affiliate_page'].includes(pageType);

  // Site-wide checks (cookies, privacy notice, sign-up consent, reviews)
  // are owned by Site Sweep and intentionally not raised here.
  if (signals.additionalFees.length && signals.prices.count) {
    out.push(finding('drip_pricing', 'drip_pricing', 'high', 'CMA',
      'Additional fees mentioned alongside prices',
      'The page refers to fees on top of displayed prices. Mandatory fees left out of the headline price may amount to drip pricing.',
      'DMCCA 2024 Part 4 (drip pricing)', { excerpt: signals.additionalFees[0] }));
  }
  if (signals.countdownTimer || signals.timeUrgency.length) {
    out.push(finding('urgency', 'urgency', 'medium', 'CMA',
      'Time-limited offer claims on page',
      signals.countdownTimer
        ? 'A countdown timer element was detected in the page source. Evidence is needed that the deadline is genuine and the offer will not be extended or re-run.'
        : 'Time-pressure language appears on the page. Evidence is needed that the deadline is genuine.',
      'DMCCA 2024 Sch 20; CAP Code 3.1', { excerpt: signals.timeUrgency[0] || '' }));
  }
  if (signals.stockUrgency.length) {
    out.push(finding('stock_urgency', 'stock_urgency', 'medium', 'CMA',
      'Scarcity or demand claims on page',
      'Stock or demand indicators (such as "only X left" or "X people viewing") must reflect real, current data.',
      'DMCCA 2024 Sch 20; CAP Code 3.1', { excerpt: signals.stockUrgency[0] }));
  }
  if (signals.referencePricing.detected) {
    out.push(finding('reference_pricing', 'reference_pricing', 'medium', 'CMA',
      'Reference ("was") prices displayed',
      'Was/now or compare-at prices were detected. Records are needed showing each reference price was a genuine previous selling price.',
      'DMCCA 2024 Part 4; CAP Code s.3 (price comparisons)', { excerpt: signals.referencePricing.excerpts[0] || '' }));
  }
  if (isOfferPage && promo && !signals.termsLink.found) {
    out.push(finding('missing_terms', 'missing_terms', 'low', 'ASA',
      'No terms link identified',
      'The page makes promotional claims but no link to terms and conditions was identified. Significant conditions of an offer must be made clear.',
      'CAP Code 3.9-3.10; CAP Code s.8'));
  }
  if (pageType === 'affiliate_page' && !signals.adDisclosure.length) {
    out.push(finding('ad_disclosure', 'ad_disclosure', 'medium', 'ASA',
      'No ad or affiliate disclosure identified',
      'This is marked as an affiliate page but no "ad", "sponsored" or affiliate disclosure was identified. Marketing must be obviously identifiable as such.',
      'CAP Code 2.1'));
  }
  return out;
}

// ── Step 3: Claude interpretation ──
async function callClaudeJson(prompt, maxTokens = 1500) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in Claude response');
    return JSON.parse(m[0]);
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt({ url, pageType, text, signals, findings, campaignCopy, claims }) {
  const claimList = (claims || []).slice(0, 15)
    .map((c, i) => `${i}. [${c.claimType || 'other'}] ${String(c.claim || '').slice(0, 200)}`).join('\n') || '(no claims extracted)';
  const detectionList = findings
    .map(x => `- ${x.id}: ${x.title}${x.excerpt ? ` | page text: "${x.excerpt.slice(0, 160)}"` : ''}`).join('\n') || '(none)';

  return `You are the page-scan analyst for Sendwize, a UK marketing compliance tool. A marketing campaign links to the web page below. Compare the page with the approved campaign and review the automated detections.

RULES
- Use ONLY the page text provided. Never invent content, prices, fines or facts.
- Every excerpt you return must be copied exactly from PAGE TEXT (max 25 words). If you cannot quote it, do not claim it.
- Neutral language: "potential area requiring review". Never say "illegal", "unlawful" or "in breach".
- Framework: ICO (PECR, UK GDPR), ASA (CAP Code), CMA (DMCCA 2024).

PAGE
URL: ${url}
Page type (set by user): ${pageType}
Title: ${signals.title || '(none)'}

APPROVED CAMPAIGN COPY (truncated)
${String(campaignCopy || '').slice(0, 2500) || '(not provided)'}

CLAIMS EXTRACTED FROM THE CAMPAIGN
${claimList}

AUTOMATED DETECTIONS (may contain false positives)
${detectionList}

PAGE TEXT (truncated)
${text.slice(0, PAGE_TEXT_FOR_AI)}

TASKS
1. claimChecks: for each claim number, does this page support it? status is "consistent" (page matches the claim), "conflicts" (page contradicts or undermines it), "not_found" (claim not addressed here) or "not_applicable" (claim unrelated to this page). Give an exact excerpt for "consistent" and "conflicts".
2. detectionReview: for each automated detection id, "keep" or "dismiss" with a short reason. Dismiss false positives, e.g. a "timer" that is a delivery cut-off, fees that are optional extras, or a ticked box that is not about marketing.
3. additionalFindings: up to 3 further potential areas requiring review about this campaign's OFFER or CLAIMS that are clearly evidenced in PAGE TEXT and not already covered. Each needs an exact excerpt. Do NOT raise site-wide matters (cookies, trackers, privacy notices, sign-up consent boxes, reviews, company details): a separate site-wide review covers those.
4. summary: one or two plain-English sentences about this page.

Return ONLY JSON in this shape:
{"claimChecks":[{"claimIndex":0,"status":"consistent","note":"","excerpt":""}],"detectionReview":[{"id":"","decision":"keep","reason":""}],"additionalFindings":[{"title":"","detail":"","severity":"medium","regulator":"ASA","ruleRef":"","excerpt":""}],"summary":""}`;
}

// ── Analyse one page ──
async function analysePage(entry, ctx) {
  const url = entry.url;
  const pageType = entry.type || 'landing_page';
  const scannedAt = new Date().toISOString();
  const base = { url, type: pageType, label: entry.label || '', scannedAt };

  const page = await fetchPage(url);
  if (!page.ok) {
    return { ...base, status: 'error', verdict: 'error', error: page.error, httpStatus: page.httpStatus || null,
      finalUrl: page.finalUrl, findings: [], dismissed: [], claimChecks: [],
      summary: `Page could not be scanned: ${page.error}.` };
  }

  const { signals, text } = extractSignals(page.html, page.finalUrl);
  const contentHash = await sha256(text.slice(0, 50000));
  let findings = deterministicFindings(signals, pageType);
  const dismissed = [];
  const claimChecks = [];
  let summary = '';
  let aiStatus = 'skipped';

  if (text.length >= MIN_TEXT_LENGTH) {
    try {
      const ai = await callClaudeJson(buildPrompt({ url, pageType, text, signals, findings, campaignCopy: ctx.campaignCopy, claims: ctx.claims }));
      aiStatus = 'ok';
      const nt = norm(text);
      const st = strip(nt);

      // Relevance filter on deterministic detections
      const decisions = new Map((ai.detectionReview || []).map(d => [d.id, d]));
      const kept = [];
      for (const fd of findings) {
        const d = decisions.get(fd.id);
        if (d && d.decision === 'dismiss') dismissed.push({ id: fd.id, title: fd.title, category: fd.category, dismissReason: String(d.reason || '').slice(0, 200) });
        else kept.push(d?.reason ? { ...fd, aiNote: String(d.reason).slice(0, 200) } : fd);
      }
      findings = kept;

      // Claim consistency (verified excerpts only)
      for (const c of (ai.claimChecks || [])) {
        const idx = Number(c.claimIndex);
        const claim = ctx.claims?.[idx];
        if (!claim) continue;
        let status = ['consistent', 'conflicts', 'not_found', 'not_applicable'].includes(c.status) ? c.status : 'not_found';
        const ex = String(c.excerpt || '').slice(0, 300);
        const verified = !!ex && excerptInText(ex, nt, st);
        if ((status === 'consistent' || status === 'conflicts') && !verified) status = 'not_found';
        claimChecks.push({
          claimIndex: idx, claim: String(claim.claim || '').slice(0, 160), claimType: claim.claimType || 'other',
          status, note: String(c.note || '').slice(0, 240), excerpt: verified ? ex : '',
        });
        if (status === 'conflicts') {
          findings.push(finding(`claim_conflict_${idx}`, 'claim_conflict', 'high',
            ['ICO', 'ASA', 'CMA'].includes(claim.exposureCategory) ? claim.exposureCategory : 'ASA',
            'Page conflicts with campaign claim',
            `The campaign says "${String(claim.claim || '').slice(0, 120)}". ${String(c.note || '').slice(0, 240)}`.trim(),
            claim.ruleRef || 'CAP Code 3.1; DMCCA 2024 Part 4',
            { excerpt: ex, evidenceType: 'ai_assessment', source: 'ai' }));
        }
      }

      // Additional findings (verified excerpts only)
      for (const a of (ai.additionalFindings || []).slice(0, 3)) {
        const ex = String(a.excerpt || '').slice(0, 300);
        if (!ex || !excerptInText(ex, nt, st)) continue;
        findings.push(finding(`ai_${findings.length}`, 'ai_finding',
          ['high', 'medium', 'low'].includes(a.severity) ? a.severity : 'medium',
          ['ICO', 'ASA', 'CMA'].includes(a.regulator) ? a.regulator : 'ASA',
          String(a.title || 'Potential area requiring review').slice(0, 120),
          String(a.detail || '').slice(0, 300),
          String(a.ruleRef || '').slice(0, 120),
          { excerpt: ex, evidenceType: 'ai_assessment', source: 'ai' }));
      }
      summary = String(ai.summary || '').slice(0, 400);
    } catch (e) {
      aiStatus = 'failed';
      console.error(`Page scan AI step failed for ${url} (non-fatal):`, e.message);
    }
  }

  const active = findings.filter(x => x.severity === 'high' || x.severity === 'medium');
  const verdict = text.length < MIN_TEXT_LENGTH ? 'not_evidenced' : active.length ? 'needs_attention' : 'passed';
  if (!summary) {
    summary = verdict === 'not_evidenced'
      ? 'Very little text was found in the page source. The page may build its content with JavaScript, which this scan cannot see.'
      : active.length
        ? `${active.length} potential area${active.length > 1 ? 's' : ''} requiring review identified.`
        : 'No potential areas requiring review identified in the page source.';
  }

  return {
    ...base, status: 'ok', verdict, finalUrl: page.finalUrl, httpStatus: page.httpStatus,
    title: signals.title, contentHash, aiStatus, signals, findings, dismissed, claimChecks, summary,
  };
}

function summarise(pages) {
  const t = { pages: pages.length, passed: 0, needsAttention: 0, notEvidenced: 0, errors: 0, findings: 0, high: 0, medium: 0, low: 0, conflicts: 0 };
  for (const p of pages) {
    if (p.verdict === 'passed') t.passed++;
    else if (p.verdict === 'needs_attention') t.needsAttention++;
    else if (p.verdict === 'not_evidenced') t.notEvidenced++;
    else t.errors++;
    for (const x of (p.findings || [])) {
      t.findings++;
      t[x.severity] = (t[x.severity] || 0) + 1;
      if (x.category === 'claim_conflict') t.conflicts++;
    }
  }
  return t;
}

// ── Public API ──
export async function scanCampaignPages(urlEntries, ctx = {}) {
  const seen = new Set();
  const entries = [];
  for (const u of (urlEntries || [])) {
    const url = typeof u === 'string' ? u : u?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    entries.push(typeof u === 'string' ? { url, type: 'landing_page' } : u);
  }
  const limited = entries.slice(0, MAX_PAGES);
  const pages = await Promise.all(limited.map(e => analysePage(e, ctx).catch(err => ({
    url: e.url, type: e.type || 'landing_page', scannedAt: new Date().toISOString(),
    status: 'error', verdict: 'error', error: err.message,
    findings: [], dismissed: [], claimChecks: [], summary: 'Page could not be scanned.',
  }))));
  const totals = summarise(pages);
  return {
    version: PAGE_SCAN_VERSION,
    scannedAt: new Date().toISOString(),
    status: pages.length && totals.errors === pages.length ? 'error' : totals.errors ? 'partial' : 'complete',
    totals,
    pages,
    skipped: entries.slice(MAX_PAGES).map(e => e.url),
  };
}

export function describeScan(scan) {
  if (!scan?.pages?.length) return 'No pages scanned.';
  const t = scan.totals || {};
  const parts = [`${t.pages} page${t.pages !== 1 ? 's' : ''} scanned: ${t.passed} passed, ${t.needsAttention} need${t.needsAttention === 1 ? 's' : ''} attention`];
  if (t.notEvidenced) parts.push(`${t.notEvidenced} not evidenced`);
  if (t.errors) parts.push(`${t.errors} could not be scanned`);
  let s = parts.join(', ') + '.';
  s += ` ${t.findings} potential area${t.findings !== 1 ? 's' : ''} requiring review`;
  if (t.conflicts) s += `, including ${t.conflicts} conflict${t.conflicts !== 1 ? 's' : ''} with campaign claims`;
  return s + '.';
}

export function activePageFindings(scan) {
  const out = [];
  for (const p of (scan?.pages || [])) for (const x of (p.findings || [])) out.push({ ...x, url: p.url });
  return out;
}

// Airtable long text holds 100,000 characters — trim detail if needed
export function serialiseScan(scan) {
  let s = JSON.stringify(scan);
  if (s.length <= 95000) return s;
  const slim = { ...scan, pages: scan.pages.map(p => ({ ...p, signals: undefined })) };
  s = JSON.stringify(slim);
  if (s.length <= 95000) return s;
  return JSON.stringify({
    ...slim, truncated: true,
    pages: slim.pages.map(p => ({ ...p, dismissed: [], claimChecks: (p.claimChecks || []).filter(c => c.status === 'conflicts') })),
  });
}
