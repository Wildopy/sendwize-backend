// ─────────────────────────────────────────────────────────────
// SENDWIZE — _marketing-sweep.js v1.0 (Nov 2026)
// Site Sweep's always-on marketing checks. Deterministic, no AI: the
// same site gives the same findings every run.
//
// What it looks for, on every page the sweep reads:
//   1. Sign-up forms and pop-ups: a phone number collected with no
//      wording about texts, a form that never says it means marketing,
//      a discount handed out for signing up, and pop-ups whose "no
//      thanks" is missing, shaming or hard to see.
//   2. Cookie banners where "Reject" is less prominent than "Accept",
//      or only reachable a layer down (behind "Manage").
//   3. Persistent urgency: countdowns that restart for each visitor or
//      show the same time when the page is loaded twice, deadlines that
//      have already passed, and "ends tonight" / "only 2 left" claims
//      that are still there word for word at the next sweep.
//   4. Always-on claims in the header, footer and announcement bars
//      ("No.1", award-winning, eco-friendly, clinically proven), using
//      the Copy Checker's own issue list (_copy-issues.js).
//   5. Reviews (DMCCA 2024): only 5-star reviews shown, and no statement
//      on how reviews are collected and checked.
//   6. Influencer and affiliate pages with no ad or affiliate label.
//
// CHECK OWNERSHIP: Campaign Defence checks the offer and claims of each
// campaign's own pages. These checks are about what the site does all
// the time, for every visitor, whatever campaign is running.
//
// Findings use Site Sweep's finding() shape, categories 'marketing',
// 'reviews' and 'cookies'.
// ─────────────────────────────────────────────────────────────
import { htmlToText } from './_page-scan.js';
import { ISSUES } from './_copy-issues.js';

const DAY = 24 * 60 * 60 * 1000;
export const PERSIST_DAYS = 7;

// ── HTML helpers ──────────────────────────────────────────────
const txt = h => htmlToText(h).replace(/&middot;|&bull;/g, '·');
// The whole element that starts at `start`, nested tags of the same name included
function balancedFrom(html, start, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[1]) { depth--; if (depth <= 0) return html.slice(start, re.lastIndex); }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return html.slice(start, start + 4000);
}

// Elements whose attributes match attrRe (no g flag), outermost first
export function findBlocks(html, attrRe, max = 12) {
  const out = [];
  const re = /<(div|section|aside|dialog|form|header|footer|nav|p|span)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    if (!attrRe.test(m[2])) continue;
    const tag = m[1].toLowerCase();
    const block = balancedFrom(html, m.index, tag);
    out.push({ tag, attrs: m[2], html: block, text: txt(block) });
    re.lastIndex = m.index + block.length;
  }
  return out;
}
const tagBlocks = (html, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html)) && out.length < 4) {
    const block = balancedFrom(html, m.index, tag);
    out.push({ tag, attrs: '', html: block, text: txt(block) });
    re.lastIndex = m.index + block.length;
  }
  return out;
};
const inlineScripts = html => [...String(html || '').matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const clip = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trim() + '…' : t; };
// The sentence a match sits in
function sentence(text, rx) {
  const t = String(text || '');
  const m = t.match(rx);
  if (!m) return '';
  const before = t.slice(0, m.index);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf(' · '), before.lastIndexOf(' | '), m.index - 120, -1) + 1;
  const after = t.slice(m.index + m[0].length);
  const stop = after.search(/[.!?](\s|$)| · | \| /);
  const end = m.index + m[0].length + (stop < 0 ? Math.min(after.length, 100) : Math.min(stop + 1, 120));
  return clip(t.slice(start, end).replace(/^[\s·|]+/, ''), 180);
}
const pathOf = url => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return '/'; } };

// ── 1. Sign-up forms and pop-ups ──────────────────────────────
const PHONE_INPUT   = /<input\b[^>]*(type=["']?tel\b|(name|id|placeholder|autocomplete)=["'][^"']*(phone|mobile|sms|tel\b|cell))[^>]*>/i;
const EMAIL_INPUT   = /<input\b[^>]*(type=["']?email\b|name=["'][^"']*email)[^>]*>/i;
const SMS_WORDING   = /\b(sms|texts?|text messages?|txt|whatsapp|by phone|mobile marketing)\b/i;
const PURPOSE       = /\b(newsletter|marketing|promotional|offers?,? (and|&) (news|updates)|news,? (and|&) offers?|(news|offers|updates|deals) by email|e-?mails? (from|about) us|we'?ll (e-?mail|send) you|we will (e-?mail|send) you|send (you|me) (offers|news|emails|updates|our)|subscribe to (our )?(emails|updates)|unsubscribe)\b/i;
const DISCOUNT      = /(\b\d{1,2}\s?% off\b|£\s?\d+ off\b|\bdiscount\b|\bfree (gift|delivery|shipping)\b|\bspin to win\b|\bunlock\b[^.]{0,30}\b(offer|discount|code))/i;
const OFFER_TERMS   = /\b(min(imum)? (spend|order)|expires?|valid (for|until|on)|one (use|per customer)|t\s?&\s?cs?( apply)?|terms (and conditions )?apply|excludes?|exclusions)\b/i;
const POPUP_ATTR    = /(class|id)=["'][^"']*(popup|pop-up|modal|lightbox|klaviyo-form|newsletter-overlay|signup-overlay|exit-intent|spin-to-win|email-capture)[^"']*["']|role=["']dialog["']|aria-modal=["']true["']/i;
const CLOSE_CONTROL = /aria-label=["'][^"']*(close|dismiss)|class=["'][^"']*\b(close|dismiss)\b|>\s*(×|✕|✖|x|&times;|close)\s*<|\b(no,? thanks?|no thank you|not now|maybe later|continue (shopping|without)|skip|close)\b/i;
const DECLINE_EL    = /<(a|button|span|p|div)\b([^>]*)>\s*([^<]{0,90}\b(no,? thanks?|no thank you|not now|maybe later|continue (shopping|without)|close|skip)\b[^<]{0,90})<\/\1>/i;
const CONFIRMSHAME  = /\b(no,? thanks?,? i('?m| am)? (don'?t|do not|prefer|would rather|'?d rather|hate|like paying|enjoy paying|love paying)|i('?ll| will) pay full price|i don'?t (like|want|need) (saving|discounts|deals|money|a bargain)|i('?d| would) rather pay (more|full))/i;
const isLight = hex => { const h = hex.replace('#', ''); const v = h.length === 3 ? h.split('').map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); return v.every(c => c >= 0xb8); };
function faint(attrs) {
  const s = String(attrs || '');
  const fs = s.match(/font-size:\s*(\d+(\.\d+)?)px/i);
  const op = s.match(/opacity:\s*(0?\.\d+)/i);
  const col = s.match(/(?:^|[^-])color:\s*(#[0-9a-f]{3,6})\b/i);
  const why = [];
  if (fs && Number(fs[1]) <= 10) why.push(`${fs[1]}px text`);
  if (op && Number(op[1]) < 0.5) why.push('faded out');
  if (col && isLight(col[1])) why.push('pale grey text');
  if (/class=["'][^"']*\b(tiny|faint|x-?small)\b/i.test(s)) why.push('styled as small print');
  return why;
}

function formsOn(page) {
  const html = page.html || '';
  const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map(m => ({ html: m[0], index: m.index }));
  const popups = findBlocks(html, POPUP_ATTR, 6);
  const out = [];
  for (const f of forms) {
    if (!EMAIL_INPUT.test(f.html) && !PHONE_INPUT.test(f.html)) continue;
    const popup = popups.find(p => p.html.includes(f.html));
    // The words around the form count too: headings above it, small print below
    const ctxHtml = popup ? popup.html : html.slice(Math.max(0, f.index - 200), f.index + f.html.length + 250);
    out.push({ html: f.html, ctxHtml, text: htmlToText(ctxHtml), popup });
  }
  return { forms: out, popups };
}

function signupFindings(pages, finding) {
  const findings = [];
  const seen = new Set();
  for (const p of pages) {
    const path = pathOf(p.url);
    const { forms, popups } = formsOn(p);
    for (const f of forms) {
      const where = f.popup ? `Pop-up sign-up on ${path}` : `Sign-up form on ${path}`;
      const at = f.popup ? `${path}#popup` : path; // a pop-up and an inline form on one page are separate findings
      const h = (f.ctxHtml.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i) || [])[1];
      const heading = clip(h ? htmlToText(h) : f.text, 90);
      const phone = PHONE_INPUT.test(f.html);
      if (phone && !SMS_WORDING.test(f.text) && !seen.has('sms' + at)) {
        seen.add('sms' + at);
        findings.push(finding(`signup_sms_wording|${at}`, 'signup_sms_wording', 'marketing', 'high', 'ICO',
          'Phone number collected, but the wording never mentions texts',
          'This form asks for a mobile number, but nothing near it says you will send marketing texts. Consent for texts has to be specific: people need to know they are agreeing to SMS, not just email. This is the exact gap in the HelloFresh fine.',
          'PECR Reg 22; UK GDPR Art 4(11)', { page: path, element: where, excerpt: heading, confidence: 'high', issue: 'consent_basis', caseId: 'hellofresh_2024' }));
      }
      const purpose = PURPOSE.test(f.text) || /newsletter/i.test(p.signals?.title || '');
      const discount = f.text.match(/\b\d{1,2}\s?% off\b|£\s?\d+ off\b/i) || f.text.match(DISCOUNT);
      if (!purpose && !seen.has('purpose' + at)) {
        seen.add('purpose' + at);
        findings.push(finding(`signup_purpose_unclear|${at}`, 'signup_purpose_unclear', 'marketing', discount ? 'high' : 'medium', 'ICO',
          discount ? `"${clip(discount[0], 40)}" for signing up, but the form never says it means marketing emails` : 'Sign-up form doesn\'t say people are signing up to marketing',
          discount
            ? 'The discount is only given in return for an email address, but the form doesn\'t tell people they are agreeing to receive marketing. Offering a reward for signing up is allowed, but the consent behind it has to be informed: say plainly what they will get, how often, and that they can unsubscribe.'
            : 'The form collects an email address but doesn\'t say what it will be used for. Consent to marketing only counts if people know what they are agreeing to.',
          'PECR Reg 22; UK GDPR Art 4(11) and 7', { page: path, element: where, excerpt: heading, confidence: 'medium', issue: 'consent_basis' }));
      } else if (discount && !OFFER_TERMS.test(f.text) && !seen.has('terms' + at)) {
        seen.add('terms' + at);
        findings.push(finding(`signup_discount_terms|${at}`, 'signup_discount_terms', 'marketing', 'low', 'ASA',
          'Sign-up discount with no conditions shown',
          `The form offers "${clip(discount[0], 40)}" but gives no conditions (minimum spend, expiry, exclusions). Significant conditions of a promotion need to be clear before people sign up.`,
          'CAP Code 8.17', { page: path, element: where, excerpt: heading, confidence: 'medium' }));
      }
    }
    for (const pop of popups) {
      if (!EMAIL_INPUT.test(pop.html) && !DISCOUNT.test(pop.text)) continue;
      if (seen.has('popup' + path)) continue;
      const why = [];
      const shame = pop.text.match(CONFIRMSHAME);
      const declineEl = pop.html.match(DECLINE_EL);
      if (!CLOSE_CONTROL.test(pop.html)) why.push('there is no close button or "no thanks" option, so the only way past it is to sign up');
      if (shame) why.push(`the way out reads "${clip(sentence(pop.text, CONFIRMSHAME), 90)}", which shames people for saying no`);
      if (declineEl) { const f = faint(declineEl[2]); if (f.length) why.push(`the "${clip(declineEl[3], 40)}" option is ${f.join(', ')}, much harder to see than the sign-up button`); }
      if (!why.length) continue;
      seen.add('popup' + path);
      findings.push(finding(`popup_hidden_decline|${path}`, 'popup_hidden_decline', 'marketing', 'medium', 'CMA',
        'Sign-up pop-up makes saying no hard',
        `On this pop-up ${why.join('; and ')}. Saying no to marketing should be as easy as saying yes. The CMA treats pressure like this as harmful online choice architecture, and consent given under it may not be freely given.`,
        'DMCCA 2024 Part 4 Ch 1 (unfair practices); UK GDPR Art 7(4); CMA online choice architecture guidance',
        { page: path, element: `Pop-up on ${path}`, excerpt: clip(pop.text, 140), evidence: why, confidence: shame || why.length > 1 ? 'high' : 'medium', issue: 'other' }));
    }
  }
  return findings;
}

// ── 2. Cookie banner dark patterns (page source) ──────────────
const BANNER_ATTR = /(class|id)=["'][^"']*(cookie|consent|gdpr|cc-banner|cc-window)[^"']*["']/i;
const ACCEPT = /\b(accept|allow|agree|got it|i understand|^ok$|okay)\b/i;
const REJECT = /\b(reject|decline|deny|refuse|necessary only|only necessary|essential only|only essential|strictly necessary|continue without)\b/i;
const MANAGE = /\b(manage|preferences|settings|customi[sz]e|options|more choices|cookie choices)\b/i;
function controls(html) {
  const out = [];
  for (const m of String(html).matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) out.push({ tag: m[1].toLowerCase(), attrs: m[2], text: htmlToText(m[3]).slice(0, 60) });
  for (const m of String(html).matchAll(/<input\b([^>]*type=["']?(button|submit)[^>]*)>/gi)) { const v = (m[1].match(/value=["']([^"']+)/i) || [])[1]; if (v) out.push({ tag: 'button', attrs: m[1], text: v }); }
  return out.filter(c => c.text);
}
function prominence(c) {
  let s = c.tag === 'button' || /role=["']button/i.test(c.attrs) ? 2 : 1;
  if (/class=["'][^"']*\b(primary|btn-primary|solid|cta|filled|accept)/i.test(c.attrs)) s++;
  if (/class=["'][^"']*\b(link|text|secondary|ghost|plain|muted|tertiary|small|tiny)\b/i.test(c.attrs)) s--;
  if (/background(-color)?:\s*(#|rgb|[a-z]+)/i.test(c.attrs) && !/background(-color)?:\s*(transparent|none)/i.test(c.attrs)) s++;
  if (/text-decoration:\s*underline/i.test(c.attrs)) s--;
  s -= faint(c.attrs).length;
  return s;
}
const describe = c => `${c.tag === 'a' ? 'a text link' : 'a button'}${faint(c.attrs).length ? ` (${faint(c.attrs).join(', ')})` : ''}`;

export function cookieBannerFindings(home, finding, { browserBanner = null } = {}) {
  const findings = [];
  if (!home?.html) return findings;
  const banners = findBlocks(home.html, BANNER_ATTR, 6).filter(b => controls(b.html).some(c => ACCEPT.test(c.text)));
  const b = banners[0];
  if (b) {
    const cs = controls(b.html);
    const accept = cs.find(c => ACCEPT.test(c.text));
    const reject = cs.find(c => REJECT.test(c.text));
    const manage = cs.find(c => MANAGE.test(c.text));
    if (!reject && manage) {
      findings.push(finding('cookies_reject_layer_down', 'cookies_reject_layer_down', 'cookies', 'medium', 'ICO',
        '"Reject" is hidden a layer down in the cookie banner',
        `The first layer of the banner offers "${accept.text}" in one click, but to refuse people have to open "${manage.text}" first. The ICO expects reject to be on the first layer and as easy as accept.`,
        'PECR Reg 6; ICO guidance on cookies', { page: '/', element: 'Cookie banner on /', excerpt: clip(b.text, 140), confidence: 'high', evidence: [`First layer: ${cs.map(c => `"${c.text}"`).join(', ')}`] }));
    } else if (reject && accept && (prominence(reject) < prominence(accept))) {
      findings.push(finding('cookies_reject_less_prominent', 'cookies_reject_less_prominent', 'cookies', 'medium', 'ICO',
        '"Reject" is less prominent than "Accept" in the cookie banner',
        `"${accept.text}" is ${describe(accept)}, while "${reject.text}" is ${describe(reject)}. When accept stands out and reject doesn't, people are nudged into tracking. The ICO expects both choices to be equally easy to see and use.`,
        'PECR Reg 6; ICO guidance on cookies', { page: '/', element: 'Cookie banner on /', excerpt: clip(b.text, 140), confidence: 'medium', evidence: [`"${accept.text}": ${describe(accept)}`, `"${reject.text}": ${describe(reject)}`] }));
    }
  }
  // Live browser reading, when available: reject much smaller on screen than accept
  if (!findings.length && browserBanner?.sizes?.accept && browserBanner.sizes.reject && browserBanner.sizes.reject < browserBanner.sizes.accept * 0.5) {
    findings.push(finding('cookies_reject_less_prominent', 'cookies_reject_less_prominent', 'cookies', 'medium', 'ICO',
      '"Reject" is less prominent than "Accept" in the cookie banner',
      `In a real browser the reject option took up less than half the space of the accept button. The ICO expects both choices to be equally easy to see and use.`,
      'PECR Reg 6; ICO guidance on cookies', { page: '/', element: 'Cookie banner on /', confidence: 'medium' }));
  }
  return findings;
}

// ── 3. Persistent urgency ─────────────────────────────────────
const COUNTDOWN_ATTR = /(class|id)=["'][^"']*(countdown|count-down|count_down|timer)[^"']*["']|data-(countdown|deadline|end-?date|end-?time|expires?)=/i;
const DEADLINE_ATTR  = /data-(deadline|end-?date|end-?time|expires?|countdown)=["']([^"']+)["']/gi;
const ROLLING        = /setHours\(\s*(23\s*,\s*59|24)\b|(Date\.now\(\)|new Date\(\)\.getTime\(\)|\+new Date\(\)|new Date\(\)\.valueOf\(\))\s*\+\s*[\d(]/;
export const TIME_PHRASE  = /\b(ends? (tonight|today|soon|at midnight( tonight)?|midnight)|final hours|last chance|today only|24 hours only|hurry|limited time( only)?|once it'?s gone,? it'?s gone)\b/gi;
export const STOCK_PHRASE = /\b(only \d+ left( in stock)?|\d+ left in stock|low (in )?stock|selling fast|almost gone|nearly sold out|\d+ (people|others|shoppers) (are )?(viewing|looking at)( this)?( right now)?|in \d+ (baskets|carts|bags))\b/gi;
const hms = s => { const m = String(s || '').match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/) || String(s || '').match(/\b(\d{1,3})\s*h(?:ours?|rs?)?\s*(\d{1,2})\s*m(?:ins?)?\s*(\d{1,2})\s*s/i); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };
const fmt = secs => `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

export function readCountdown(html) {
  const blocks = findBlocks(html || '', COUNTDOWN_ATTR, 4);
  if (!blocks.length) return null;
  const deadlines = [];
  for (const b of blocks) for (const m of b.attrs.matchAll(DEADLINE_ATTR)) deadlines.push(m[2]);
  const shown = blocks.map(b => hms(b.text)).find(v => v != null) ?? null;
  const ids = blocks.map(b => (b.attrs.match(/id=["']([^"']+)/i) || [])[1]).filter(Boolean);
  const rolling = inlineScripts(html).some(s => ROLLING.test(s) && (/countdown|timer|deadline|ends?|midnight/i.test(s) || ids.some(id => s.includes(id))));
  return { text: clip(blocks[0].text, 120), deadlines, shown, rolling };
}
const phrases = (text, rx) => [...new Set([...String(text || '').matchAll(rx)].map(m => m[0].toLowerCase().replace(/\s+/g, ' ')))].slice(0, 6);

// Stored with each sweep so the next one can tell if the claims never change
export function urgencySnapshot(pages, at = new Date().toISOString()) {
  const out = {};
  for (const p of pages.filter(x => x.ok)) {
    const time = phrases(p.text, TIME_PHRASE), stock = phrases(p.text, STOCK_PHRASE);
    if (time.length || stock.length) out[pathOf(p.url)] = { at, time, stock };
  }
  return out;
}

function urgencyFindings(pages, finding, { reloads = {}, previous = null, now = Date.now() } = {}) {
  const findings = [], notes = [];
  for (const p of pages) {
    const path = pathOf(p.url);
    const cd = readCountdown(p.html);
    if (!cd) continue;
    const evidence = [];
    if (cd.rolling) evidence.push('The page\'s own script sets the deadline from the visitor\'s clock (for example "midnight tonight" or "now plus a few hours"), so the sale never actually ends: every visitor, every day, sees a fresh countdown.');
    const again = reloads[p.url];
    if (again?.html) {
      const cd2 = readCountdown(again.html);
      const gap = Math.max(1, Math.round((again.at - (p.fetchedAt || again.at)) / 1000));
      if (cd2 && cd.deadlines.length && cd2.deadlines.length && cd.deadlines.join() !== cd2.deadlines.join()) evidence.push(`We loaded the page twice, ${gap} seconds apart. The deadline moved from ${cd.deadlines[0]} to ${cd2.deadlines[0]}.`);
      else if (cd2 && cd.shown != null && cd.shown > 60 && cd2.shown === cd.shown && gap >= 2) evidence.push(`We loaded the page twice, ${gap} seconds apart. Both times the timer showed ${fmt(cd.shown)} left, so it isn't counting down to a real deadline.`);
    }
    const past = cd.deadlines.map(d => Date.parse(d)).filter(t => Number.isFinite(t) && t < now - 60000);
    if (past.length) evidence.push(`The timer's own deadline (${new Date(Math.max(...past)).toUTCString().slice(5, 22)}) has already passed, but the urgency is still showing.`);
    if (!evidence.length) continue;
    findings.push(finding(`urgency_timer_resets|${path}`, 'urgency_timer_resets', 'marketing', 'high', 'CMA',
      'Countdown timer that doesn\'t count down to a real deadline',
      'A countdown that restarts, or carries on after its deadline, tells shoppers an offer is ending when it isn\'t. Falsely saying a product or price is only available for a very limited time is banned outright under the DMCCA 2024, and the CMA has taken action against Emma Sleep and Wowcher for exactly this.',
      'DMCCA 2024 Sch 20 (false urgency); CAP Code 3.30', { page: path, element: `Countdown timer on ${path}`, excerpt: cd.text, evidence, confidence: 'high', issue: 'fake_urgency', caseId: 'emma_cma_2026' }));
  }

  // Same claims, word for word, at least a week after the last sweep
  const prev = previous?.urgencySnapshot || null;
  if (prev) {
    for (const p of pages.filter(x => x.ok)) {
      const path = pathOf(p.url);
      const before = prev[path];
      if (!before?.at) continue;
      const days = Math.floor((now - Date.parse(before.at)) / DAY);
      if (!(days >= PERSIST_DAYS)) continue;
      const stock = phrases(p.text, STOCK_PHRASE).filter(x => before.stock?.includes(x));
      const time = phrases(p.text, TIME_PHRASE).filter(x => before.time?.includes(x));
      if (time.length) findings.push(finding(`urgency_never_ends|${path}`, 'urgency_never_ends', 'marketing', 'high', 'CMA',
        `"${time[0]}" is still showing ${days} days later`,
        `On ${new Date(before.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} this page said ${time.map(x => `"${x}"`).join(', ')}. It still does today. A deadline that never arrives is false urgency, which the DMCCA 2024 bans outright.`,
        'DMCCA 2024 Sch 20 (false urgency); CAP Code 3.30', { page: path, element: `Urgency message on ${path}`, excerpt: sentence(p.text, new RegExp(time[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')), confidence: 'high', issue: 'fake_urgency', caseId: 'wowcher_cma_2024',
          evidence: [`${new Date(before.at).toLocaleDateString('en-GB')}: ${before.time.map(x => `"${x}"`).join(', ')}`, `Today: ${time.map(x => `"${x}"`).join(', ')}`] }));
      if (stock.length) findings.push(finding(`scarcity_never_changes|${path}`, 'scarcity_never_changes', 'marketing', 'medium', 'CMA',
        `"${stock[0]}" hasn't changed in ${days} days`,
        `On ${new Date(before.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} this page said ${stock.map(x => `"${x}"`).join(', ')}, and it says exactly the same today. Stock and demand claims must reflect real, current numbers. If these are fixed text, they are likely to mislead.`,
        'DMCCA 2024 Sch 20 (false urgency); CAP Code 3.31', { page: path, element: `Stock or demand message on ${path}`, excerpt: sentence(p.text, new RegExp(stock[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')), confidence: 'medium', issue: 'scarcity',
          evidence: [`${new Date(before.at).toLocaleDateString('en-GB')}: ${before.stock.map(x => `"${x}"`).join(', ')}`, `Today: ${stock.map(x => `"${x}"`).join(', ')}`] }));
    }
  }
  const watched = Object.keys(urgencySnapshot(pages));
  if (watched.length && !prev) notes.push(`We saved the urgency and stock messages on ${watched.join(', ')}. When you run the sweep again (or the monthly re-check runs) a week or more from now, we'll tell you if they still say exactly the same thing.`);
  return { findings, notes };
}

// ── 4. Always-on claims in the header, footer and banners ─────
const CHROME_ATTR = /(class|id)=["'][^"']*(announce|promo-?bar|promo_bar|top-?bar|topbar|usp|marquee|ticker|site-banner|hello-?bar|trust-?bar|strapline)[^"']*["']/i;
export const CLAIM_CHECKS = [
  ['superlative_claim', /\b((the )?(uk|britain|world|country)['’]?s (no\.? ?1|number one|#1|best|favourite|favorite|leading|biggest|top)\b|(no\.? ?1|number one|#1) (\w+ ){0,3}(brand|shop|store|retailer|choice|in the uk)|best[- ]selling|top[- ]rated|market[- ]leading)/i],
  ['credential_claim',  /\b(award[- ]winning|multi[- ]award|as seen (in|on)|approved by|endorsed by|recommended by (doctors|dermatologists|experts)|dermatologist[- ](approved|recommended|tested))\b/i],
  ['green_claim',       /\b(eco[- ]?friendly|100% sustainable|sustainably (made|sourced)|carbon[- ](neutral|negative|zero)|net[- ]zero|planet[- ]friendly|better for the planet|100% recyclable|biodegradable|plastic[- ]free)\b/i],
  ['performance_claim', /\b(clinically (proven|tested)|scientifically proven|proven to \w+|guaranteed results)\b/i],
  ['medicinal_claim',   /\b(boosts? (your )?immun\w*|cures? \w+|heals? \w+|treats? (anxiety|insomnia|pain|eczema|acne))\b/i],
];
const CLAIM_WORDS = {
  superlative_claim: 'a "best" or "No.1" claim needs evidence that compares you with the whole market, kept up to date',
  credential_claim:  'an award or endorsement needs to be real, current and named (who gave it, and when)',
  green_claim:       'an environmental claim needs evidence across the product\'s whole life, and absolute words like "eco-friendly" need the strongest proof',
  performance_claim: '"clinically proven" needs published trials on the product itself, showing what is claimed',
  medicinal_claim:   'only licensed medicines can claim to treat or cure',
};
function claimFindings(pages, finding) {
  const hits = new Map(); // issue -> { excerpt, where, pages:Set }
  for (const p of pages) {
    const path = pathOf(p.url);
    const regions = [
      ...tagBlocks(p.html || '', 'header').map(b => ({ ...b, label: 'header' })),
      ...tagBlocks(p.html || '', 'footer').map(b => ({ ...b, label: 'footer' })),
      ...findBlocks(p.html || '', CHROME_ATTR, 4).map(b => ({ ...b, label: 'announcement bar' })),
    ];
    for (const r of regions) for (const [issue, rx] of CLAIM_CHECKS) {
      if (!rx.test(r.text)) continue;
      const h = hits.get(issue) || { excerpt: sentence(r.text, rx), where: r.label, pages: new Set(), label: r.label };
      h.pages.add(path);
      hits.set(issue, h);
    }
  }
  const findings = [];
  for (const [issue, h] of hits) {
    const meta = ISSUES[issue] || {};
    const pagesList = [...h.pages];
    findings.push(finding(`claim_${issue}`, `claim_${issue}`, 'marketing', issue === 'medicinal_claim' ? 'high' : 'medium', 'ASA',
      `Always-on claim in your ${h.where}: ${meta.label ? meta.label.toLowerCase() : 'claim'}`,
      `"${clip(h.excerpt, 120)}" sits in the ${h.where}, so every visitor sees it on ${pagesList.length > 1 ? `${pagesList.length} pages` : 'this page'} whatever campaign is running. Under the CAP Code ${CLAIM_WORDS[issue]}. Hold that evidence before the claim goes live, or soften the wording.`,
      meta.cite || 'CAP Code 3.7', { page: pagesList[0], element: `Site ${h.where}${pagesList.length > 1 ? ` (on ${pagesList.join(', ')})` : ` on ${pagesList[0]}`}`, excerpt: h.excerpt, confidence: 'medium', issue,
        // the library's credential cases are about origin and memberships, not awards: show none
        ...(issue === 'credential_claim' ? { noCase: true } : {}) }));
  }
  return findings;
}

// ── 5. Reviews ────────────────────────────────────────────────
const REVIEW_SHOWN   = /\b\d(\.\d)?\s*(out of|\/)\s*5\b|★{3,}|\b\d(\.\d)?\s*stars?\b|\brated (excellent|\d)|\b(customer )?reviews?\b|\btestimonials?\b/i;
const TOP_ONLY_ATTR  = /data-(stars|min-?rating|rating-?filter|filter-?rating|review-?stars)=["']\s*(5|4\s*,\s*5|5\s*,\s*4|4-5)\s*["']|[?&](stars|min_rating|rating)=(5|4%2C5|4,5)\b/i;
const FIVE           = /★★★★★|aria-label=["']5 (out of 5|stars?)|data-(rating|score|stars)=["']5(\.0)?["']|\b5 out of 5\b|\b5\/5\b/gi;
const LOWER          = /★{1,4}☆|aria-label=["'][1-4] (out of 5|stars?)|data-(rating|score|stars)=["'][1-4](\.0)?["']|\b[1-4] out of 5\b|\b[1-4]\/5\b/i;
const REVIEW_POLICY  = /\b(how (we|our) (collect|check|verify|moderate|handle|display) (customer )?(reviews|ratings)|reviews? (are|is) (collected|verified|checked|moderated|independently)|verified (buyers?|purchases?|customers?|reviews?)|reviews? polic(y|ies)|about our reviews|we (publish|show) all reviews)\b/i;
function reviewFindings(pages, finding, widgetNames = []) {
  const findings = [];
  const withReviews = pages.filter(p => (p.signals?.reviewWidgets || []).length || (REVIEW_SHOWN.test(p.text || '') && /review|testimonial|★|out of 5|stars?/i.test(p.html || '')));
  if (!withReviews.length) return { findings, shown: false };
  const allText = pages.map(p => p.text || '').join(' ');
  for (const p of withReviews) {
    const path = pathOf(p.url);
    const filter = (p.html || '').match(TOP_ONLY_ATTR);
    const fives = ((p.html || '').match(FIVE) || []).length;
    const lower = LOWER.test(p.html || '');
    if (filter || (fives >= 3 && !lower)) {
      findings.push(finding(`reviews_only_top|${path}`, 'reviews_only_top', 'reviews', 'high', 'CMA',
        'Only 5-star reviews are shown',
        filter
          ? `The review widget on this page is set to show only top-rated reviews (${clip(filter[0], 40)}). Showing only the best reviews without saying so gives a false picture of what customers think, which the DMCCA 2024 bans outright.`
          : `Every one of the ${fives} reviews shown on this page is 5 stars, and none are lower. If lower ratings exist and are left out, that gives a false picture of what customers think, which the DMCCA 2024 bans outright.`,
        'DMCCA 2024 Sch 20 (fake reviews); CMA fake reviews guidance', { page: path, element: filter ? `Review widget on ${path}` : `Reviews section on ${path}`, excerpt: filter ? clip(filter[0], 60) : '', confidence: filter ? 'high' : 'medium', issue: 'incentivised_review', caseId: 'google_cma_2025',
          evidence: filter ? [`Widget setting: ${clip(filter[0], 60)}`] : [`${fives} five-star ratings, no lower ones`] }));
      break;
    }
  }
  if (!REVIEW_POLICY.test(allText)) {
    const p = withReviews[0];
    findings.push(finding('reviews_no_check_statement', 'reviews_no_check_statement', 'reviews', 'medium', 'CMA',
      'No statement on how reviews are collected and checked',
      `Reviews are shown${widgetNames.length ? ` (${widgetNames.join(', ')})` : ''}, but nowhere on the site says how they are collected, whether they come from verified buyers, or whether any are filtered out. Since April 2025 businesses must take reasonable steps to keep fake and misleading reviews off their site, and the CMA expects a clear, published policy.`,
      'DMCCA 2024 Sch 20 (fake reviews); CMA fake reviews guidance', { page: pathOf(p.url), element: `Reviews on ${pathOf(p.url)}`, confidence: 'medium', issue: 'review_claim', caseId: 'google_cma_2025' }));
  }
  return { findings, shown: true };
}

// ── 6. Influencer and affiliate pages ─────────────────────────
const PROMO_CODE    = /\b[Uu]se (my )?code:? [A-Z][A-Z0-9]{3,}\b/;
const INFLUENCER    = /\b(my (favourite|fave|top) picks|i can'?t stop (styling|using|wearing)|hi (lovelies|guys|babes|everyone)|(link|code) in (my )?bio|my edit\b|i'?ve partnered)/i;
const COLLAB_TITLE  = /\s(x|×)\s/i;
const AFFILIATE_URL = /href=["'][^"']*(amzn\.to|amazon\.[a-z.]+\/[^"']*[?&]tag=|awin1\.com|rstyle\.me|shopstyle\.|skimresources|go\.redirectingat|shareasale|linksynergy|prf\.hn|anrdoezrs|tkqlhce|dpbolvw|liketoknow\.it|shopltk|howl\.me)/i;
const DISCLOSED     = /(#ad\b|#advert|#sponsored|#affiliate|\badvert(isement|isement feature)?\b|\bsponsored\b|paid partnership|\bgifted\b|affiliate (link|links|partner)|\bwe (may )?(earn|receive|get) (a )?(small )?commission|\bin partnership with\b|(^|[\s>(])ad[.:|)](\s|$))/i;
function adLabelFindings(pages, finding) {
  const findings = [];
  for (const p of pages) {
    const html = p.html || '', text = p.text || '';
    const why = [];
    const inf = text.match(INFLUENCER);
    const code = text.match(PROMO_CODE);
    if (inf) why.push(`influencer-style wording ("${clip(inf[0], 40)}")`);
    if (code && (inf || p.role === 'partner')) why.push(`a personal discount code ("${clip(code[0], 40)}")`);
    if (p.role === 'partner' && COLLAB_TITLE.test(p.signals?.title || '')) why.push(`a collaboration page ("${clip(p.signals.title, 60)}")`);
    if (AFFILIATE_URL.test(html)) why.push('affiliate tracking links');
    if (!why.length || DISCLOSED.test(text)) continue;
    const path = pathOf(p.url);
    findings.push(finding(`ad_label_missing|${path}`, 'ad_label_missing', 'marketing', 'high', 'ASA',
      'Influencer or affiliate page with no "Ad" label',
      `This page has ${why.join(' and ')}, but no "Ad", "Paid partnership" or affiliate label. Paid-for content must be obviously identifiable as advertising before people start reading. The brand is responsible alongside the influencer.`,
      ISSUES.hidden_ad?.cite || 'CAP Code 2.1 / 2.3', { page: path, element: `Page ${path}`, excerpt: inf ? clip(text.slice(text.search(INFLUENCER)), 110) : clip(p.signals?.title || '', 80), confidence: inf || AFFILIATE_URL.test(html) ? 'high' : 'medium', issue: 'hidden_ad', caseId: 'sancarlo_asa_2026', evidence: why }));
  }
  return findings;
}

// ── Entry point ───────────────────────────────────────────────
// pages: Site Sweep pages ({ role, url, ok, html, text, signals, fetchedAt }).
// reloads: { [url]: { html, at } } second loads of pages with a countdown.
// previous: the last sweep, for claims that never change.
export function evaluateMarketing({ pages, finding, reloads = {}, previous = null, browser = null, now = Date.now() }) {
  const ok = pages.filter(p => p.ok && p.html);
  const notes = [];
  const findings = [];
  findings.push(...signupFindings(ok, finding));
  findings.push(...cookieBannerFindings(ok.find(p => p.role === 'home'), finding, { browserBanner: browser?.status === 'ok' ? browser.banner : null }));
  const u = urgencyFindings(ok, finding, { reloads, previous, now });
  findings.push(...u.findings); notes.push(...u.notes);
  findings.push(...claimFindings(ok, finding));
  const widgets = [...new Set(ok.flatMap(p => p.signals?.reviewWidgets || []))];
  const r = reviewFindings(ok, finding, widgets);
  findings.push(...r.findings);
  findings.push(...adLabelFindings(ok, finding));
  // Keep the date each message was first seen, so frequent re-runs still
  // build up to the week needed to say it never changes
  const snapshot = urgencySnapshot(ok, new Date(now).toISOString());
  const prev = previous?.urgencySnapshot || {};
  for (const [path, cur] of Object.entries(snapshot)) {
    const old = prev[path];
    if (old?.at && [...cur.time, ...cur.stock].some(x => (old.time || []).includes(x) || (old.stock || []).includes(x))) cur.at = old.at;
  }
  return { findings, notes, reviewsShown: r.shown, snapshot };
}
