// ─────────────────────────────────────────────────────────────
// SENDWIZE — site-sweep.js v1.1
// v1.1: every request authenticated via _auth.js (verified member id
// replaces any userId from the browser); internal calls carry the secret.
//
// One-off, site-wide compliance sweep of a VERIFIED domain.
// Flags major gaps, scores the site, and feeds the dashboard
// through the existing fix pipeline (/api/generate-fix → £ exposure).
//
// Actions:
//   POST ?action=start   { userId, domain }  → record + verification instructions (idempotent)
//   POST ?action=verify  { userId, domain }  → checks meta tag, /.well-known file, DNS TXT
//   POST ?action=run     { userId, domain }  → runs the sweep (verified domains only)
//   GET  ?action=get     userId[, domain]    → latest result (for the page and dashboard)
//
// CHECK OWNERSHIP (no duplication with Campaign Defence):
//   Site Sweep owns site-wide checks: cookies and trackers, privacy
//   and cookie notices, sign-up consent (pre-ticked boxes, privacy
//   link at capture), business identity, reviews.
//   Campaign Defence's page scan owns offer/claim checks (pricing,
//   urgency, scarcity, claim conflicts, ad disclosure) and does not
//   raise any of the above.
//
// IDEMPOTENT RE-RUNS:
//   One record per user + domain. Every finding has a stable key
//   (check id, plus page path for per-page checks). Keys that have
//   already produced a fix are stored in FixKeysJson, so running the
//   sweep again — the same day or a month later — never adds a fix
//   twice. Re-runs report what is new and what has been resolved.
//   A run lock stops two sweeps on the same domain running at once.
//
// DETERMINISTIC BY DESIGN:
//   No AI judgement in the sweep itself. Same site in, same findings
//   out, so re-runs do not flip-flop and every finding is explainable.
//
// Optional headless browser (recommended) for the cookie test:
//   npm i @sparticuz/chromium puppeteer-core
//   Without it, cookie behaviour is assessed from page source only and
//   the result says so. Set SITE_SWEEP_BROWSER=off to disable.
//
// Airtable table: Site_Sweeps
//   UserID, Domain, VerificationToken, VerificationMethod, VerifiedAt,
//   Status, SweepJson (long text), FixKeysJson (long text), SiteScore
//   (number), LastSweptAt, RunStartedAt, RunCount (number), CreatedAt
// ─────────────────────────────────────────────────────────────
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';
import { atFetch } from './_airtable.js';
import { requireAuth, internalHeaders, CORS_HEADERS } from './_auth.js';
import { fetchPage, extractSignals, extractLinks, isSafePublicUrl } from './_page-scan.js';

const APP_URL       = 'https://sendwize-backend.vercel.app';
const TABLE         = 'Site_Sweeps';
const SWEEP_VERSION = '1.0';
const MAX_PAGES     = 8;
const RUN_LOCK_MS   = 3 * 60 * 1000;
const META_NAME     = 'sendwize-verification';
const DNS_PREFIX    = 'sendwize-verification=';
const FILE_PATH     = '/.well-known/sendwize-verification.txt';

// Fix types this tool emits. The six marked NEW need exposure ranges
// adding to EXPOSURE_CONSTANTS in fixes.js / generate-fix.js.
export const SITE_FIX_MAP = {
  cookies_trackers_before_consent: 'cookie_trackers_before_consent', // NEW
  cookies_no_consent_banner:       'cookie_banner_missing',          // NEW
  cookies_no_reject_option:        'cookie_reject_missing',          // NEW
  cookies_no_policy:               'cookie_policy_missing',          // NEW
  privacy_no_notice:               'no_privacy_policy',
  privacy_notice_unreachable:      'no_privacy_policy',
  privacy_notice_incomplete:       'privacy_notice_incomplete',      // NEW
  capture_pre_ticked:              'invalid_consent_mechanism',
  capture_no_privacy_link:         'privacy_notice_at_capture',      // NEW
};

const SCORE_CATEGORIES = [
  { id: 'cookies',  label: 'Cookies & tracking',  max: 35 },
  { id: 'privacy',  label: 'Privacy notice',      max: 25 },
  { id: 'capture',  label: 'Data capture',        max: 25 },
  { id: 'identity', label: 'Business identity',   max: 15 },
];

// ── Small helpers ─────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nowIso = () => new Date().toISOString();

function airtableCtx() {
  const token = process.env.AIRTABLE_TOKEN;
  const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  return { token, base, authH: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

export function normaliseDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  let host;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return null;
  if (!isSafePublicUrl('https://' + host).ok) return null;
  return host;
}

function hostMatches(href, domain) {
  try {
    const h = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    return h === domain || h.endsWith('.' + domain);
  } catch { return false; }
}

function pathOf(url) {
  try { const u = new URL(url); return (u.pathname || '/').replace(/\/+$/, '') || '/'; } catch { return '/'; }
}

function safeJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

async function findRecord(ctx, userId, domain) {
  const formula = encodeURIComponent(`AND({UserID}='${esc(userId)}',{Domain}='${esc(domain)}')`);
  const r = await atFetch(`${ctx.base}/${TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text().catch(() => '')}`);
  return (await r.json()).records?.[0] || null;
}

async function patchRecord(ctx, id, fields) {
  const r = await atFetch(`${ctx.base}/${TABLE}/${id}`, { method: 'PATCH', headers: ctx.authH, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

function verificationInstructions(domain, token) {
  return {
    token,
    meta: { tag: `<meta name="${META_NAME}" content="${token}">`, where: `Add to the <head> of https://${domain}/` },
    dns:  { type: 'TXT', host: domain, value: `${DNS_PREFIX}${token}` },
    file: { url: `https://${domain}${FILE_PATH}`, contents: token },
  };
}

function publicView(record) {
  const f = record.fields || {};
  return {
    sweepId: record.id,
    domain: f.Domain,
    status: f.Status || 'unverified',
    verified: !!f.VerifiedAt,
    verifiedAt: f.VerifiedAt || null,
    verificationMethod: f.VerificationMethod || null,
    verification: f.VerifiedAt ? null : verificationInstructions(f.Domain, f.VerificationToken),
    lastSweptAt: f.LastSweptAt || null,
    runCount: f.RunCount || 0,
    siteScore: typeof f.SiteScore === 'number' ? f.SiteScore : null,
    sweep: safeJson(f.SweepJson, null),
  };
}

// ── Verification ──────────────────────────────────────────────
async function fetchSmallText(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const safe = isSafePublicUrl(current);
    if (!safe.ok) return { ok: false, error: safe.reason };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const r = await fetch(safe.url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sendwize-Verify/1.0)' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { current = new URL(r.headers.get('location'), safe.url).toString(); continue; }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return { ok: true, text: (await r.text()).slice(0, 2000) };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : e.message };
    } finally { clearTimeout(timer); }
  }
  return { ok: false, error: 'Too many redirects' };
}

async function checkMeta(domain, token) {
  let reached = false;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    const p = await fetchPage(u);
    if (!p.ok) continue;
    reached = true;
    const nameRe = new RegExp(`name=["']?${META_NAME}["']?`, 'i');
    if ((p.html.match(/<meta\b[^>]*>/gi) || []).some(m => nameRe.test(m) && m.includes(token))) return { ok: true };
  }
  return { ok: false, reason: reached ? 'Homepage reached but the verification tag was not found. If you just published it, wait a minute and try again.' : 'Homepage could not be reached.' };
}

async function checkFile(domain, token) {
  for (const u of [`https://${domain}${FILE_PATH}`, `https://www.${domain}${FILE_PATH}`]) {
    const r = await fetchSmallText(u);
    if (r.ok && r.text.trim().includes(token)) return { ok: true };
  }
  return { ok: false, reason: 'Verification file not found or does not contain the code.' };
}

async function checkDns(domain, token) {
  try {
    const recs = await dns.resolveTxt(domain);
    if (recs.map(r => r.join('').trim()).includes(DNS_PREFIX + token)) return { ok: true };
    return { ok: false, reason: 'TXT record not found yet. DNS changes can take up to an hour to appear.' };
  } catch (e) {
    return { ok: false, reason: ['ENODATA', 'ENOTFOUND'].includes(e.code) ? 'No TXT record found yet.' : 'DNS lookup failed.' };
  }
}

// ── Headless cookie test (optional) ───────────────────────────
const TRACKER_REQUESTS = [
  ['Google Analytics',  /google-analytics\.com\/(g\/)?collect|region\d+\.google-analytics\.com|analytics\.google\.com\/g\/collect/i],
  ['Google Ads',        /googleadservices\.com|doubleclick\.net|googlesyndication\.com/i],
  ['Meta Pixel',        /facebook\.com\/tr[/?]/i],
  ['TikTok Pixel',      /analytics\.tiktok\.com\/api/i],
  ['Microsoft Ads',     /bat\.bing\.com\/action/i],
  ['Microsoft Clarity', /\.clarity\.ms\/collect/i],
  ['Hotjar',            /hotjar\.(com|io)/i],
  ['LinkedIn Insight',  /px\.ads\.linkedin\.com/i],
  ['Pinterest Tag',     /ct\.pinterest\.com/i],
  ['Snap Pixel',        /tr\.snapchat\.com/i],
  ['Criteo',            /criteo\.(com|net)/i],
  ['X (Twitter) Ads',   /analytics\.twitter\.com|t\.co\/i\/adsct/i],
];
const TRACKING_COOKIE = /^(_ga|_gid|_gat|_gcl_|_fbp|_fbc|_ttp|_tt_|_uet|_hj|_clck|_clsk|_pin_|_scid|_rdt_|li_|bcookie|lidc|IDE$|test_cookie$|MUID$|personalization_id$)/;

async function browserCookieTest(url) {
  if (process.env.SITE_SWEEP_BROWSER === 'off') return { status: 'unavailable', reason: 'Browser check disabled' };
  let chromium, puppeteer;
  try {
    chromium = (await import('@sparticuz/chromium')).default;
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    return { status: 'unavailable', reason: 'Headless browser not installed' };
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args, defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(), headless: true,
    });
    const page = await browser.newPage();
    const hits = new Map();
    page.on('request', req => {
      const u = req.url();
      for (const [name, re] of TRACKER_REQUESTS) if (re.test(u) && !hits.has(name)) hits.set(name, u.slice(0, 140));
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500)); // let late tags fire — no clicks, so nothing is consented
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    const trackingCookies = [...new Set((cookies || []).map(c => c.name).filter(n => TRACKING_COOKIE.test(n)))];
    const banner = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const texts = els.filter(visible)
        .map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase())
        .filter(t => t && t.length < 40);
      return {
        accept: texts.filter(t => /\b(accept|allow|agree|got it)\b/.test(t)).slice(0, 3),
        reject: texts.filter(t => /\b(reject|decline|deny|refuse|necessary only|only necessary|essential only|only essential|strictly necessary|continue without)\b/.test(t)).slice(0, 3),
        manage: texts.filter(t => /\b(manage|preferences|settings|customi[sz]e|options)\b/.test(t)).slice(0, 3),
      };
    });
    return { status: 'ok', preConsentTrackers: [...hits].map(([name, sample]) => ({ name, sample })), trackingCookies, banner };
  } catch (e) {
    return { status: 'failed', reason: String(e.message || e).slice(0, 200) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Page discovery ────────────────────────────────────────────
const PAGE_ROLES = [
  ['privacy', /privacy/i],
  ['cookies', /cookie/i],
  ['terms',   /terms|conditions|t\s?&\s?c/i],
  ['signup',  /sign[\s-]?up|register|newsletter|subscribe|join|create[\s-]?account/i],
  ['contact', /contact|about/i],
];

function discoverPages(homeHtml, homeUrl, domain) {
  const links = extractLinks(homeHtml, homeUrl).filter(l => hostMatches(l.href, domain));
  const chosen = new Map(); // role -> url
  for (const [role, re] of PAGE_ROLES) {
    const hit = links.find(l => re.test(l.text) || re.test(pathOf(l.href)));
    if (hit) {
      const clean = hit.href.split('#')[0];
      if (clean !== homeUrl.split('#')[0]) chosen.set(role, clean);
    }
  }
  return chosen;
}

// ── Deterministic checks ──────────────────────────────────────
const PRIVACY_ELEMENTS = [
  ['controller', 'Who the controller is and how to contact them', /data controller|\bcontroller\b|who we are|contact us/i],
  ['purposes',   'What personal data is used for',               /purposes?|how we use|we use (your|the) (personal )?(data|information)/i],
  ['lawful',     'Lawful basis for each use',                    /lawful basis|legal basis|legitimate interests?/i],
  ['retention',  'How long data is kept',                        /retain|retention|how long we (keep|store|hold)/i],
  ['rights',     'Individual rights',                            /your rights|right (of|to) access|right to (erasure|be forgotten|object|rectification)|data subject rights/i],
  ['complaint',  'Right to complain to the ICO',                 /information commissioner|ico\.org\.uk|\bico\b/i],
  ['sharing',    'Who data is shared with',                      /third part(y|ies)|recipients|processors?|share (your|personal)/i],
  ['transfers',  'International transfers',                      /international (data )?transfers?|outside (the )?(uk|united kingdom|eea|european economic area)|adequacy|standard contractual clauses|\bidta\b/i],
];
const COMPANY_NO = /\b(company|registration|reg\.?|registered)\s*(no\.?|number|num)?\.?\s*:?\s*(SC|NI|OC|SO|NC|R0)?\d{6,8}\b|registered in (england|scotland|northern ireland|wales)/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;

function finding(key, checkId, category, severity, regulator, title, detail, ruleRef, opts = {}) {
  return {
    key, checkId, category, severity, regulator, title, detail, ruleRef,
    page: opts.page || '', excerpt: opts.excerpt || '',
    evidenceType: opts.evidenceType || 'page_observed',
    confidence: opts.confidence || 'medium',
  };
}

export function evaluateSite({ domain, pages, browser }) {
  const findings = [];
  const notes = [];
  const ok = pages.filter(p => p.ok);
  const byRole = role => ok.find(p => p.role === role);
  const union = key => [...new Set(ok.flatMap(p => p.signals[key] || []))];

  const staticTrackers = union('trackersInSource');
  const cmps = union('consentPlatformInSource');
  const reviews = union('reviewWidgets');
  const browserTrackers = browser?.status === 'ok' ? browser.preConsentTrackers.map(t => t.name) : [];
  const thirdParties = [...new Set([...staticTrackers, ...browserTrackers])];

  // ── Cookies & tracking ──
  const privacyPage = byRole('privacy');
  const cookiesPage = byRole('cookies');
  const cookieInfoInPrivacy = privacyPage ? (privacyPage.text.match(/cookie/gi) || []).length >= 3 : false;

  if (browser?.status === 'ok') {
    const pre = browser.preConsentTrackers;
    const cks = browser.trackingCookies;
    if (pre.length || cks.length) {
      findings.push(finding('cookies_trackers_before_consent', 'cookies_trackers_before_consent', 'cookies', 'high', 'ICO',
        'Tracking starts before a consent choice',
        `With no consent given, the homepage ${pre.length ? `sent data to ${pre.map(t => t.name).join(', ')}` : ''}${pre.length && cks.length ? ' and ' : ''}${cks.length ? `set tracking cookies (${cks.slice(0, 6).join(', ')})` : ''}. Non-essential cookies and similar technologies need consent before they are used.`,
        'PECR Reg 6', { page: '/', confidence: 'high' }));
    }
    const hasBanner = browser.banner.accept.length || browser.banner.reject.length;
    if (!hasBanner) {
      if (cmps.length) notes.push(`A consent tool (${cmps.join(', ')}) was detected, but its banner could not be read automatically. Check the reject option manually.`);
      else if (thirdParties.length || cks.length) {
        findings.push(finding('cookies_no_consent_banner', 'cookies_no_consent_banner', 'cookies', 'high', 'ICO',
          'No cookie consent banner identified',
          `Tracking technologies were found (${thirdParties.concat(cks).slice(0, 6).join(', ')}) but no consent banner with accept or reject options was identified on the homepage.`,
          'PECR Reg 6', { page: '/', confidence: 'medium' }));
      }
    } else if (browser.banner.accept.length && !browser.banner.reject.length) {
      findings.push(finding('cookies_no_reject_option', 'cookies_no_reject_option', 'cookies', 'medium', 'ICO',
        'No reject option alongside accept',
        `The consent banner offers "${browser.banner.accept[0]}" but no equally prominent way to reject was identified${browser.banner.manage.length ? ` (only "${browser.banner.manage[0]}")` : ''}. Refusing should be as easy as accepting.`,
        'PECR Reg 6; ICO guidance on cookies', { page: '/', confidence: 'medium' }));
    }
  } else {
    notes.push(browser?.status === 'failed'
      ? `The live cookie test could not complete (${browser.reason}). Cookie behaviour was assessed from page source only.`
      : 'The live cookie test is not enabled, so cookie behaviour was assessed from page source only.');
    if (staticTrackers.length && !cmps.length) {
      findings.push(finding('cookies_consent_tool_not_evidenced', 'cookies_consent_tool_not_evidenced', 'cookies', 'medium', 'ICO',
        'Tracking tags with no consent tool in page source',
        `Tracking tags were found (${staticTrackers.join(', ')}) but no consent management platform was detected in the page source. A consent tool loaded through a tag manager would not be visible to this check.`,
        'PECR Reg 6', { page: '/', confidence: 'low' }));
    }
  }

  if (!cookiesPage && !cookieInfoInPrivacy) {
    const anyTracking = thirdParties.length || (browser?.trackingCookies || []).length;
    findings.push(finding('cookies_no_policy', 'cookies_no_policy', 'cookies', anyTracking ? 'medium' : 'low', 'ICO',
      'No cookie information identified',
      'No cookie policy page was found and the privacy notice does not explain cookies. Users must be given clear information about the cookies a site uses.',
      'PECR Reg 6(2)'));
  }

  // ── Privacy notice ──
  const privacyLinked = ok.some(p => p.signals.privacyLink.found);
  const privacyAttempt = pages.find(p => p.role === 'privacy');
  if (!privacyLinked && !privacyAttempt) {
    findings.push(finding('privacy_no_notice', 'privacy_no_notice', 'privacy', 'high', 'ICO',
      'No privacy notice identified',
      'No link to a privacy notice was found on the pages reviewed. People must be told how their personal data is used when it is collected.',
      'UK GDPR Art 13-14'));
  } else if (privacyAttempt && !privacyAttempt.ok) {
    findings.push(finding('privacy_notice_unreachable', 'privacy_notice_unreachable', 'privacy', 'medium', 'ICO',
      'Privacy notice could not be opened',
      `A privacy link was found but the page could not be loaded (${privacyAttempt.error}).`,
      'UK GDPR Art 13-14', { page: pathOf(privacyAttempt.url) }));
  } else if (privacyPage) {
    const missing = PRIVACY_ELEMENTS.filter(([, , re]) => !re.test(privacyPage.text));
    if (missing.length) {
      const serious = missing.some(([id]) => ['lawful', 'rights', 'complaint'].includes(id)) || missing.length >= 3;
      findings.push(finding('privacy_notice_incomplete', 'privacy_notice_incomplete', 'privacy', serious ? 'medium' : 'low', 'ICO',
        'Privacy notice: required information not evidenced',
        `The notice text does not appear to cover: ${missing.map(([, label]) => label.toLowerCase()).join('; ')}. This is a keyword check, so review the notice to confirm.`,
        'UK GDPR Art 13-14', { page: pathOf(privacyPage.url) }));
    }
  }

  // ── Data capture ──
  const formPages = ok.filter(p => p.signals.emailSignupForms > 0);
  for (const p of formPages) {
    const path = pathOf(p.url);
    if (p.signals.preTickedMarketingBoxes.length) {
      findings.push(finding(`capture_pre_ticked|${path}`, 'capture_pre_ticked', 'capture', 'high', 'ICO',
        'Pre-ticked marketing consent box',
        'A checkbox that appears to relate to marketing is ticked by default. Consent needs a clear affirmative action, so a pre-ticked box does not provide valid consent.',
        'PECR Reg 22; UK GDPR Art 4(11)', { page: path, excerpt: p.signals.preTickedMarketingBoxes[0], confidence: 'high' }));
    }
    if (!p.signals.privacyLink.found) {
      findings.push(finding(`capture_no_privacy_link|${path}`, 'capture_no_privacy_link', 'capture', 'medium', 'ICO',
        'Sign-up form without a privacy link',
        'An email sign-up form was found but no link to the privacy notice was identified on the same page.',
        'UK GDPR Art 13', { page: path }));
    }
  }
  if (!formPages.length) notes.push('No email sign-up forms were found on the pages reviewed.');

  // ── Business identity ──
  const allText = ok.map(p => p.text).join(' ');
  if (!COMPANY_NO.test(allText)) {
    findings.push(finding('identity_company_details', 'identity_company_details', 'identity', 'low', 'Companies House',
      'Company registration details not identified',
      'No company number or place of registration was found. Limited companies must show their registered name, number, place of registration and registered office on their website.',
      'Companies (Trading Disclosures) Regs 2008'));
  }
  if (!UK_POSTCODE.test(allText)) {
    findings.push(finding('identity_no_address', 'identity_no_address', 'identity', 'low', 'Trading Standards',
      'No geographic address identified',
      'No UK postal address was found on the pages reviewed. Online traders must give a geographic address.',
      'E-Commerce Regs 2002 reg 6'));
  }

  // ── Reviews (informational) ──
  if (reviews.length) {
    findings.push(finding('reviews_displayed', 'reviews_displayed', 'reviews', 'low', 'CMA',
      'Customer reviews displayed',
      `Review content detected (${reviews.join(', ')}). Businesses must take reasonable steps to prevent and remove fake reviews and reviews with concealed incentives.`,
      'DMCCA 2024 Sch 20 (fake reviews)', { confidence: 'medium' }));
  }

  // ── Score ──
  const RANK = { high: 3, medium: 2, low: 1 };
  const breakdown = SCORE_CATEGORIES.map(cat => {
    const fs = findings.filter(x => x.category === cat.id && x.confidence !== 'low');
    const worst = fs.reduce((w, x) => Math.max(w, RANK[x.severity] || 0), 0);
    const factor = worst === 3 ? 0 : worst === 2 ? 0.5 : worst === 1 ? 0.8 : 1;
    let note = '';
    if (cat.id === 'cookies' && browser?.status !== 'ok') note = 'Assessed from page source only';
    if (cat.id === 'capture' && !formPages.length) note = 'No sign-up forms found';
    return {
      id: cat.id, label: cat.label, max: cat.max, score: Math.round(cat.max * factor),
      status: worst >= 2 ? 'Needs attention' : worst === 1 ? 'Minor gaps' : note && cat.id === 'cookies' ? 'Partly tested' : 'Passed',
      note,
    };
  });
  const score = breakdown.reduce((s, b) => s + b.score, 0);
  const totals = { findings: findings.length, high: 0, medium: 0, low: 0 };
  for (const x of findings) totals[x.severity]++;

  return { findings, notes, thirdParties, score, breakdown, totals };
}

// ── Sweep orchestration ───────────────────────────────────────
export async function runSweep(domain, opts = {}) {
  const startedAt = nowIso();
  let home = await fetchPage(`https://${domain}/`);
  if (!home.ok) home = await fetchPage(`https://www.${domain}/`);
  if (!home.ok) { const e = new Error(`The homepage could not be reached (${home.error}).`); e.userFacing = true; throw e; }

  const homeUrl = home.finalUrl;
  const roles = discoverPages(home.html, homeUrl, domain);
  const targets = [];
  const seen = new Set([homeUrl.split('#')[0]]);
  for (const [role, url] of roles) {
    if (seen.has(url) || targets.length >= MAX_PAGES - 1) continue;
    seen.add(url);
    targets.push({ role, url });
  }

  const [fetched, browser] = await Promise.all([
    Promise.all(targets.map(async t => {
      const p = await fetchPage(t.url);
      if (!p.ok) return { ...t, ok: false, error: p.error };
      const { signals, text } = extractSignals(p.html, p.finalUrl);
      return { ...t, url: p.finalUrl, ok: true, signals, text };
    })),
    (opts.browserTest || browserCookieTest)(homeUrl),
  ]);

  const homeSig = extractSignals(home.html, homeUrl);
  const pages = [{ role: 'home', url: homeUrl, ok: true, signals: homeSig.signals, text: homeSig.text }, ...fetched];
  // Roles that share a page (e.g. privacy + cookies on one URL) resolve to the same fetch
  const evaluation = evaluateSite({ domain, pages, browser });

  return {
    version: SWEEP_VERSION, domain, startedAt, completedAt: nowIso(), homepage: homeUrl,
    pages: pages.map(p => ({ role: p.role, url: p.url, ok: p.ok, error: p.error || null, title: p.signals?.title || '' })),
    browserCheck: { status: browser?.status || 'unavailable', reason: browser?.reason || null },
    ...evaluation,
  };
}

// ── Idempotent fix emission ───────────────────────────────────
async function emitNewFixes({ userId, domain, recordId, findings, fixKeys }) {
  const emitted = [];
  const eligible = findings.filter(f => SITE_FIX_MAP[f.checkId] && f.severity !== 'low' && f.confidence !== 'low' && !fixKeys[f.key]);
  await Promise.all(eligible.map(async f => {
    const fixType = SITE_FIX_MAP[f.checkId];
    try {
      const r = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST', headers: internalHeaders(),
        body: JSON.stringify({
          userId, fixType, tool: 'Site Sweep', severity: f.severity, sourceRecordId: recordId,
          description: `Site Sweep: ${f.title} — ${domain}${f.page && f.page !== '/' ? f.page : ''}`.slice(0, 250),
        }),
      });
      if (!r.ok) throw new Error(`generate-fix ${r.status}`);
      const d = await r.json().catch(() => ({}));
      fixKeys[f.key] = { fixType, fixId: d.fixId || null, status: d.skipped ? 'duplicate_skipped' : 'created', at: nowIso() };
      emitted.push({ key: f.key, fixType, status: fixKeys[f.key].status });
    } catch (e) {
      // Not recorded, so the next run retries it
      console.error('Site Sweep fix emission failed (non-fatal):', f.key, e.message);
    }
  }));
  return emitted;
}

// ── Handlers ──────────────────────────────────────────────────
async function handleStart(req, res) {
  const { userId, domain: raw } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const domain = normaliseDomain(raw);
  if (!domain) return res.status(400).json({ error: 'Enter a valid website domain, e.g. yourbrand.co.uk' });

  const ctx = airtableCtx();
  const existing = await findRecord(ctx, userId, domain);
  if (existing) return res.json({ success: true, ...publicView(existing) });

  const r = await atFetch(`${ctx.base}/${TABLE}`, {
    method: 'POST', headers: ctx.authH,
    body: JSON.stringify({ records: [{ fields: {
      UserID: userId, Domain: domain, VerificationToken: randomBytes(12).toString('hex'),
      Status: 'unverified', RunCount: 0, CreatedAt: nowIso(),
    } }] }),
  });
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to create site sweep (check the Site_Sweeps table exists)', detail: await r.text().catch(() => '') });
  const record = (await r.json()).records?.[0];
  return res.json({ success: true, ...publicView(record) });
}

async function handleVerify(req, res) {
  const { userId, domain: raw } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const domain = normaliseDomain(raw);
  if (!domain) return res.status(400).json({ error: 'Invalid domain' });

  const ctx = airtableCtx();
  const record = await findRecord(ctx, userId, domain);
  if (!record) return res.status(404).json({ error: 'Start the sweep for this domain first' });
  if (record.fields.VerifiedAt) return res.json({ success: true, verified: true, ...publicView(record) });

  const token = record.fields.VerificationToken;
  const [meta, file, txt] = await Promise.all([checkMeta(domain, token), checkFile(domain, token), checkDns(domain, token)]);
  const method = meta.ok ? 'meta' : file.ok ? 'file' : txt.ok ? 'dns' : null;
  if (!method) {
    return res.json({ success: true, verified: false, checks: { meta: meta.reason, file: file.reason, dns: txt.reason }, ...publicView(record) });
  }
  const updated = await patchRecord(ctx, record.id, {
    VerificationMethod: method, VerifiedAt: nowIso(),
    Status: record.fields.SweepJson ? 'complete' : 'verified',
  });
  return res.json({ success: true, verified: true, method, ...publicView(updated) });
}

async function handleRun(req, res) {
  const { userId, domain: raw } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const domain = normaliseDomain(raw);
  if (!domain) return res.status(400).json({ error: 'Invalid domain' });

  const ctx = airtableCtx();
  const record = await findRecord(ctx, userId, domain);
  if (!record) return res.status(404).json({ error: 'Start the sweep for this domain first' });
  const f = record.fields;
  if (!f.VerifiedAt) return res.status(403).json({ error: 'Verify you own this domain before running the sweep' });

  const started = f.RunStartedAt ? Date.parse(f.RunStartedAt) : 0;
  if (f.Status === 'running' && Date.now() - started < RUN_LOCK_MS) {
    return res.status(409).json({ error: 'A sweep of this site is already running. It will finish in a minute or two.' });
  }
  const previousStatus = f.SweepJson ? 'complete' : 'verified';
  await patchRecord(ctx, record.id, { Status: 'running', RunStartedAt: nowIso() });

  let sweep;
  try {
    sweep = await runSweep(domain);
  } catch (e) {
    await patchRecord(ctx, record.id, { Status: previousStatus }).catch(() => {});
    return res.status(e.userFacing ? 422 : 500).json({ error: e.userFacing ? e.message : 'Site sweep failed', detail: e.userFacing ? undefined : e.message });
  }

  // What changed since the last run
  const previous = safeJson(f.SweepJson, null);
  const prevKeys = new Map((previous?.findings || []).map(x => [x.key, x]));
  const curKeys = new Set(sweep.findings.map(x => x.key));
  sweep.changes = {
    isFirstRun: !previous,
    previousSweptAt: previous?.completedAt || null,
    newKeys: previous ? sweep.findings.filter(x => !prevKeys.has(x.key)).map(x => x.key) : [],
    resolved: previous ? [...prevKeys.values()].filter(x => !curKeys.has(x.key)).map(x => ({ key: x.key, title: x.title, page: x.page })) : [],
  };

  // Only findings that have never produced a fix are emitted
  const fixKeys = safeJson(f.FixKeysJson, {});
  const emitted = await emitNewFixes({ userId, domain, recordId: record.id, findings: sweep.findings, fixKeys });
  sweep.fixesAdded = emitted.filter(e => e.status === 'created').length;

  let sweepJson = JSON.stringify(sweep);
  if (sweepJson.length > 95000) sweepJson = JSON.stringify({ ...sweep, pages: sweep.pages.slice(0, MAX_PAGES), truncated: true });

  const updated = await patchRecord(ctx, record.id, {
    Status: 'complete', SweepJson: sweepJson, SiteScore: sweep.score,
    FixKeysJson: JSON.stringify(fixKeys), LastSweptAt: sweep.completedAt,
    RunCount: (f.RunCount || 0) + 1,
  });
  return res.json({ success: true, ...publicView(updated) });
}

async function handleGet(req, res) {
  const { userId, domain: raw } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const ctx = airtableCtx();
  if (raw) {
    const domain = normaliseDomain(raw);
    if (!domain) return res.status(400).json({ error: 'Invalid domain' });
    const record = await findRecord(ctx, userId, domain);
    return res.json({ success: true, sweep: record ? publicView(record) : null });
  }
  const formula = encodeURIComponent(`{UserID}='${esc(userId)}'`);
  const r = await atFetch(`${ctx.base}/${TABLE}?filterByFormula=${formula}&sort[0][field]=CreatedAt&sort[0][direction]=desc&maxRecords=10`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  if (!r.ok) return res.status(r.status).json({ error: 'Failed to load site sweeps' });
  const records = (await r.json()).records || [];
  return res.json({ success: true, sweeps: records.map(publicView) });
}

// ── Router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    // Identity: the verified member id replaces any userId sent by the browser
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (req.method === 'POST' && action === 'start')  return await handleStart(req, res);
    if (req.method === 'POST' && action === 'verify') return await handleVerify(req, res);
    if (req.method === 'POST' && action === 'run')    return await handleRun(req, res);
    if (req.method === 'GET'  && action === 'get')    return await handleGet(req, res);
    return res.status(400).json({ error: 'Unknown action. Use start, verify, run or get.' });
  } catch (e) {
    console.error('site-sweep.js error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
