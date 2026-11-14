// ─────────────────────────────────────────────────────────────
// SENDWIZE — _terms-check.js v1.0 (Nov 2026)
// Site Sweep's terms checks. Deterministic, no AI: the same site gives
// the same findings every run.
//
// Two kinds of check:
//  1. What UK consumer rules expect a selling website's terms to cover:
//     the 14-day right to cancel, returns and refunds, who the trader is,
//     how subscriptions renew and how to cancel them, and no wording that
//     takes away statutory rights.
//  2. Where the rest of the site promises something the terms contradict:
//     "free returns" against a returns charge, a 30-day returns promise
//     against 14 days in the terms, a money-back guarantee the terms
//     don't mention, prices shown without VAT to consumers.
//
// Market: a B2B-only business (profile sector 'b2b') is not selling to
// consumers, so the consumer-contract checks are skipped and a note says
// so. Other sectors get the same consumer checks.
//
// Findings use Site Sweep's finding() shape with category 'terms'.
// ─────────────────────────────────────────────────────────────

const SELLS = /\b(add to (cart|basket|bag)|checkout|basket|buy now|shop now|order now|subscribe now|£\s?\d)/i;
const SUBSCRIPTION = /\b(subscription|subscribe and save|auto[- ]?renew|renews? (automatically|each|every)|membership|monthly plan|annual plan|free trial)\b/i;

const RX = {
  cancel14:      /\b(14|fourteen)[- ]?(calendar )?days?\b[^.]{0,160}\b(cancel|cancellation|withdraw|change your mind|return)|\b(cancel|cancellation|withdraw|change your mind)\b[^.]{0,160}\b(14|fourteen)[- ]?(calendar )?days?\b/i,
  cancelRight:   /\b(right to cancel|cancellation rights?|cooling[- ]off|consumer contracts? regulations|right of withdrawal)\b/i,
  returns:       /\b(returns?|refunds?)\b/i,
  statutory:     /\b(statutory rights|consumer rights act|your legal rights)\b/i,
  noRefunds:     /\b(no refunds?|non[- ]refundable|all sales (are )?final|we do not (offer|give|provide) refunds|refunds will not be (given|issued))\b/i,
  excludeRights: /\b(does not affect|do(es)? not affect|without prejudice to) your statutory rights\b/i,
  renewal:       /\b(renew(s|al)?|automatically (continue|renew)|rolling (monthly|contract))\b/i,
  howToCancelSub:/\b(cancel (your|the|a) (subscription|membership|plan)|to cancel,? (simply|just)?|you (can|may) cancel (at any time|anytime|online|by))\b/i,
  freeReturns:   /\bfree returns?\b/i,
  returnCharge:  /\b(return (postage|shipping|delivery) (costs? )?(is|are|will be) (paid|covered|borne) by (you|the customer|the buyer)|(you|customer|buyer) (must|will|is responsible to) pay (for )?(the )?(cost of )?return(s| postage| shipping)|return(s)? (fee|charge)|restocking fee|deduct(ed)? (the )?(cost of )?return)\b/i,
  dayReturns:    /\b(\d{1,3})[- ]?days?\s+(free\s+)?(returns?|money[- ]back|refunds?|to return)\b/gi,
  returnWithin:  /\breturn[^.]{0,60}\bwithin (\d{1,3}) days?\b/gi,
  moneyBack:     /\b(money[- ]back guarantee|no[- ]quibble (refund|guarantee)|100% (money[- ]back|satisfaction)( guarantee)?|lifetime guarantee)\b/i,
  exVat:         /\b(ex(cl(uding|\.)?)?\.?\s*vat|\+\s*vat|plus vat|vat not included)\b/i,
  company:       /\b(company (number|no\.?|registration)|registered in (england|scotland|northern ireland|wales)|registered office)\b/i,
};

// The sentence the match sits in, so quotes start and end cleanly
const excerpt = (text, rx) => {
  const t = String(text || '');
  const m = t.match(rx);
  if (!m) return '';
  const start = Math.max(t.lastIndexOf('. ', m.index) + 2, t.lastIndexOf('! ', m.index) + 2, t.lastIndexOf('? ', m.index) + 2, m.index - 160, 0);
  const endDot = t.slice(m.index + m[0].length).search(/[.!?](\s|$)/);
  const end = endDot < 0 ? Math.min(t.length, m.index + m[0].length + 120) : Math.min(m.index + m[0].length + endDot + 1, m.index + m[0].length + 160);
  return t.slice(start, end).replace(/\s+/g, ' ').trim().replace(/[.!?]$/, '');
};
const daysIn = (text, rxs) => {
  const out = new Set();
  for (const rx of rxs) for (const m of String(text || '').matchAll(rx)) { const n = parseInt(m[1], 10); if (n >= 7 && n <= 365) out.add(n); }
  return [...out];
};

// pages: Site Sweep pages ({ role, url, ok, text }). finding: Site Sweep's finding().
export function evaluateTerms({ pages, sector, finding }) {
  const findings = [], notes = [];
  const ok = pages.filter(p => p.ok);
  const terms = ok.find(p => p.role === 'terms');
  const returnsPage = ok.find(p => p.role === 'returns');
  const termsText = [terms?.text, returnsPage?.text].filter(Boolean).join(' ');
  const siteText = ok.filter(p => p.role !== 'terms' && p.role !== 'returns' && p.role !== 'privacy' && p.role !== 'cookies').map(p => p.text).join(' ');
  const allText = ok.map(p => p.text).join(' ');
  const sells = SELLS.test(allText);
  const subs = SUBSCRIPTION.test(siteText);
  const path = p => { try { return new URL(p.url).pathname || '/'; } catch { return '/'; } };

  if (/^b2b$/i.test(String(sector || ''))) {
    notes.push('Your profile says you sell to businesses, so the consumer terms checks (cancellation, returns, statutory rights) were skipped.');
    return { findings, notes, checked: false };
  }
  if (!sells && !subs) {
    notes.push('No checkout, basket or prices were found on the pages reviewed, so the consumer terms checks were skipped.');
    return { findings, notes, checked: false };
  }

  if (!terms) {
    findings.push(finding('terms_missing', 'terms_missing', 'terms', 'medium', 'CMA',
      'No terms and conditions found',
      'The site appears to sell to consumers, but no terms and conditions page was linked from the homepage. Consumers must be given key information before they buy, including the right to cancel, and the terms should be easy to find.',
      'Consumer Contracts Regs 2013 reg 13'));
    return { findings, notes, checked: true };
  }
  const tp = path(terms);

  // ── What the terms should cover ──
  if (!RX.cancel14.test(termsText) && !RX.cancelRight.test(termsText)) {
    findings.push(finding(`terms_no_cancellation|${tp}`, 'terms_no_cancellation', 'terms', 'high', 'CMA',
      'Terms don\'t explain the 14-day right to cancel',
      'We can\'t find the 14-day right to cancel online orders in your terms or returns page. The regulator expects consumers to be told about it before they buy. If they aren\'t, the cancellation period can extend by up to 12 months.',
      'Consumer Contracts Regs 2013 regs 29–31', { page: tp, confidence: 'medium' }));
  }
  if (sells && !RX.returns.test(termsText)) {
    findings.push(finding(`terms_no_returns|${tp}`, 'terms_no_returns', 'terms', 'medium', 'CMA',
      'No returns or refunds section',
      'The terms don\'t say how returns and refunds work. Consumers have rights to a refund for faulty goods and to cancel most online orders, and the terms should explain how.',
      'Consumer Rights Act 2015 ss 19–24', { page: tp, confidence: 'medium' }));
  }
  if (RX.noRefunds.test(termsText) && !RX.excludeRights.test(termsText)) {
    findings.push(finding(`terms_excludes_rights|${tp}`, 'terms_excludes_rights', 'terms', 'high', 'CMA',
      'Terms say "no refunds" without protecting statutory rights',
      `The terms say "${excerpt(termsText, RX.noRefunds).slice(0, 160)}". A term that stops consumers relying on their statutory rights isn't binding, and the CMA treats such wording as a potential area requiring review.`,
      'Consumer Rights Act 2015 s 31', { page: tp, excerpt: excerpt(termsText, RX.noRefunds), confidence: 'medium' }));
  }
  if (!RX.company.test(termsText) && !RX.company.test(allText)) {
    findings.push(finding(`terms_no_trader|${tp}`, 'terms_no_trader', 'terms', 'low', 'CMA',
      'Terms don\'t say who the trader is',
      'The terms don\'t give the legal name and registration details of the business selling. Consumers must know who they are contracting with.',
      'Consumer Contracts Regs 2013 Sch 2', { page: tp, confidence: 'medium' }));
  }
  if (subs) {
    if (!RX.renewal.test(termsText) || !RX.howToCancelSub.test(termsText)) {
      findings.push(finding(`terms_subscription|${tp}`, 'terms_subscription', 'terms', 'high', 'CMA',
        'Subscription renewal or cancelling isn\'t clear in the terms',
        `The site offers a subscription or membership, but the terms don't clearly ${!RX.renewal.test(termsText) ? 'say when and how it renews' : 'explain how to cancel'}. The regulator expects both to be clear before someone signs up, and the DMCCA 2024 subscription rules add renewal reminders and an easy way to leave.`,
        'DMCCA 2024 Part 4 Ch 2', { page: tp, confidence: 'medium' }));
    }
  }

  // ── Where the site promises something the terms contradict ──
  if (RX.freeReturns.test(siteText) && RX.returnCharge.test(termsText)) {
    findings.push(finding(`terms_mismatch_free_returns|${tp}`, 'terms_mismatch_free_returns', 'terms', 'high', 'CMA',
      'Site says "free returns" but the terms charge for returns',
      `The site promises free returns, but the terms say "${excerpt(termsText, RX.returnCharge).slice(0, 160)}". A headline claim the small print contradicts is a misleading action.`,
      'CPRs / DMCCA 2024 s 226', { page: tp, excerpt: excerpt(termsText, RX.returnCharge), confidence: 'medium' }));
  }
  const siteDays = daysIn(siteText, [RX.dayReturns]);
  const termDays = daysIn(termsText, [RX.dayReturns, RX.returnWithin]);
  const longer = siteDays.filter(d => termDays.length && termDays.every(t => t < d));
  if (longer.length) {
    findings.push(finding(`terms_mismatch_return_days|${tp}`, 'terms_mismatch_return_days', 'terms', 'high', 'CMA',
      `Site promises ${Math.max(...longer)}-day returns, the terms give ${Math.max(...termDays)} days`,
      `The site advertises ${Math.max(...longer)} days to return, but the terms only allow ${termDays.join(' or ')} days. Customers rely on the headline promise, so the two need to match.`,
      'CPRs / DMCCA 2024 s 226', { page: tp, confidence: 'medium' }));
  }
  if (RX.moneyBack.test(siteText) && !RX.moneyBack.test(termsText) && !/guarantee/i.test(termsText)) {
    findings.push(finding(`terms_mismatch_guarantee|${tp}`, 'terms_mismatch_guarantee', 'terms', 'medium', 'CMA',
      'A guarantee on the site isn\'t in the terms',
      `The site offers "${excerpt(siteText, RX.moneyBack).match(RX.moneyBack)[0]}", but the terms don't mention it or its conditions. A guarantee is binding as advertised, so set out its conditions in the terms.`,
      'Consumer Rights Act 2015 s 30', { page: tp, confidence: 'medium' }));
  }
  if (sells && RX.exVat.test(siteText)) {
    findings.push(finding('terms_prices_ex_vat', 'terms_prices_ex_vat', 'terms', 'medium', 'CMA',
      'Prices shown without VAT',
      `The site shows prices "${excerpt(siteText, RX.exVat).slice(0, 120)}". Prices shown to consumers must include VAT and any unavoidable fees. This is fine only if you sell solely to businesses.`,
      'Price Marking Order 2004 / DMCCA 2024 Sch 20 (drip pricing)', { confidence: 'low' }));
  }
  return { findings, notes, checked: true };
}
