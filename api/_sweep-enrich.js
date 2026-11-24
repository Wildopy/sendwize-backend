// ─────────────────────────────────────────────────────────────
// SENDWIZE — _sweep-enrich.js v1.0 (Nov 2026)
// Turns each Site Sweep finding into something a marketer can act on
// straight away. Every finding gets, where one exists:
//   where   the exact element and page ("Pop-up sign-up on /")
//   case    a real published ICO, ASA or CMA case about the same issue,
//           from the case library (_case-library.js). None is shown
//           rather than a loose match.
//   cost    what it could cost, from the exposure engine (_exposure.js):
//           ICO a range from comparable published fines for the
//           member's size and sector; CMA the statutory maximum for
//           their size; ASA no fine, the referral risk instead.
//   fix     what to do, plus a ready-to-paste snippet or wording
// Nothing here changes a finding's severity, score or dashboard fix.
// ─────────────────────────────────────────────────────────────
import { CASES, caseOutcome } from './_case-library.js';
import { caseForIssue, buildExposureForFix, cmaStatutoryMax, BAND_LABELS, normaliseBand, ICO_ACTION_URL } from './_exposure.js';

// Site Sweep fix types that generate-fix.js folds into another range
const RANGE_OF = {
  cookie_trackers_before_consent: 'consent_missing', cookie_banner_missing: 'consent_missing', cookie_reject_missing: 'consent_missing',
  cookie_policy_missing: 'data_quality', privacy_notice_incomplete: 'data_quality', privacy_notice_at_capture: 'data_quality',
  no_privacy_policy: 'data_quality', missing_terms: 'data_quality', fake_scarcity: 'fake_urgency',
  unauthorised_health_claim: 'misleading_claim', misleading_testimonial: 'fake_reviews',
};

// Findings that never become a dashboard fix (low confidence) still show what they could cost
const COST_ONLY = { cookies_consent_tool_not_evidenced: 'consent_missing' };

// What to do, and something to paste. {brand} and {domain} are filled in.
const FIXES = {
  cookies_trackers_before_consent: {
    steps: 'Make every analytics and advertising tag wait for consent. If you use Google tags, set consent to "denied" by default, above every other tag in the head, and let your banner switch it on.',
    paste: `<script>\nwindow.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('consent', 'default', {\n  ad_storage: 'denied', analytics_storage: 'denied',\n  ad_user_data: 'denied', ad_personalization: 'denied'\n});\n</script>` },
  cookies_consent_tool_not_evidenced: {
    steps: 'Add a consent banner (a CMP such as Cookiebot, CookieYes or your platform\'s own) and load tracking tags only after someone accepts.' },
  cookies_no_consent_banner: {
    steps: 'Add a cookie banner with Accept and Reject on the first layer, styled the same.',
    paste: 'We use cookies to understand how our site is used and to show you relevant ads. You choose: [Accept all] [Reject all] [Manage choices]. See our cookie policy.' },
  cookies_no_reject_option: { steps: 'Put a "Reject all" button next to "Accept all", same size and style.', paste: '<button class="cookie-btn" data-consent="accept">Accept all</button>\n<button class="cookie-btn" data-consent="reject">Reject all</button>' },
  cookies_reject_layer_down: { steps: 'Move "Reject all" onto the first layer of the banner, next to "Accept all", same size and style. Keep "Manage choices" as a third option.', paste: '<button class="cookie-btn" data-consent="accept">Accept all</button>\n<button class="cookie-btn" data-consent="reject">Reject all</button>\n<button class="cookie-link" data-consent="manage">Manage choices</button>' },
  cookies_reject_less_prominent: { steps: 'Give "Reject all" the same element, size, colour and position weight as "Accept all". Both should be buttons with the same class.', paste: '<button class="cookie-btn" data-consent="accept">Accept all</button>\n<button class="cookie-btn" data-consent="reject">Reject all</button>' },
  cookies_no_policy: { steps: 'Add a cookie policy page (or a cookies section in your privacy notice) listing each cookie, who sets it, what it is for and how long it lasts. Link it from the footer and the banner.', paste: 'Cookies we use\n• Strictly necessary: [name], [purpose], [duration]\n• Analytics (only with your consent): [name], [provider], [purpose], [duration]\n• Advertising (only with your consent): [name], [provider], [purpose], [duration]\nYou can change your choice at any time: [Cookie settings]' },
  privacy_no_notice: { steps: 'Publish a privacy notice and link it in the footer of every page and next to every form.' },
  privacy_notice_unreachable: { steps: 'Fix the broken privacy link so the notice opens.' },
  privacy_notice_incomplete: { steps: 'Add the missing sections to your privacy notice.', paste: 'Who we are: {brand} [Ltd], [address], [contact email]\nWhat we use your data for, and our lawful basis for each\nWho we share it with\nInternational transfers\nHow long we keep it\nYour rights (access, correction, erasure, objection)\nYou can complain to the Information Commissioner\'s Office at ico.org.uk' },
  capture_pre_ticked: { steps: 'Untick every marketing box by default. Use a separate box for each channel (email, text) and drop any "partners" box.', paste: '<label><input type="checkbox" name="email_marketing"> Email me offers and news from {brand}. Unsubscribe any time.</label>' },
  capture_no_privacy_link: { steps: 'Add a privacy link directly under the form.', paste: 'See our <a href="/privacy">privacy notice</a> for how we use your details.' },
  identity_company_details: { steps: 'Add your registered company details to the footer of every page.', paste: '{brand} Ltd. Registered in England and Wales, company number [number]. Registered office: [address].' },
  identity_no_address: { steps: 'Add a geographic postal address to the footer or contact page.', paste: '{brand} Ltd, [street], [town] [postcode]' },
  terms_missing: { steps: 'Publish terms and conditions and link them in the footer and at checkout.' },
  terms_no_cancellation: { steps: 'Add the 14-day right to cancel to your terms or returns page.', paste: 'You can cancel your order for any reason within 14 days of receiving it. Tell us at [email] and return the item within 14 days of telling us. We\'ll refund you, including standard delivery, within 14 days of getting the item back.' },
  terms_no_returns: { steps: 'Add a returns and refunds section.', paste: 'If an item is faulty, you have the right to a refund within 30 days, and to a repair or replacement after that. This doesn\'t affect your statutory rights.' },
  terms_excludes_rights: { steps: 'Remove "no refunds" wording, or make clear it doesn\'t affect statutory rights.', paste: 'This doesn\'t affect your statutory rights, including your right to a refund for faulty goods and your right to cancel most online orders within 14 days.' },
  terms_subscription: { steps: 'Say when the subscription renews, what it costs, and how to cancel online in a few clicks.', paste: 'Your subscription renews automatically every [period] at £[price]. We\'ll remind you before each renewal. Cancel any time in your account under Subscriptions, or email [email].' },
  terms_mismatch_free_returns: { steps: 'Make the site promise and the terms say the same thing: either make returns free, or stop saying "free returns".' },
  terms_mismatch_return_days: { steps: 'Change the terms to match the returns period you advertise, or change the advert.' },
  terms_mismatch_guarantee: { steps: 'Write the guarantee\'s conditions into your terms.', paste: 'Our [name] guarantee: if you\'re not happy within [days] days, return the item for a full refund. Conditions: [any conditions].' },
  terms_prices_ex_vat: { steps: 'Show consumer prices including VAT and any unavoidable fees.' },
  reviews_displayed: { steps: 'Keep a written review policy: how reviews are collected, that all genuine reviews are published, and how fakes are removed.' },
  // Marketing checks (_marketing-sweep.js)
  signup_sms_wording: { steps: 'Add wording that names texts, with a separate tick box for SMS, and say how to stop.', paste: '<label><input type="checkbox" name="sms_marketing"> Text me offers and news from {brand}. Reply STOP to opt out any time.</label>' },
  signup_purpose_unclear: { steps: 'Say next to the button what people are signing up to, and that they can unsubscribe.', paste: 'Sign up for emails about new products and offers from {brand}. Unsubscribe any time. See our <a href="/privacy">privacy notice</a>.' },
  signup_discount_terms: { steps: 'Add the offer\'s conditions under the form.', paste: '10% off your first full-price order. Minimum spend £[x]. Code valid for 30 days, one use per customer. <a href="/terms">Terms apply</a>.' },
  popup_hidden_decline: { steps: 'Add a clear close button and a neutral "No thanks" link, as easy to see as the sign-up button.', paste: '<button class="popup-close" aria-label="Close">×</button>\n...\n<button class="popup-decline">No thanks</button>' },
  urgency_timer_resets: { steps: 'Only show a countdown when there is a real, fixed end date, the same for every visitor. Take the offer down when it ends, and don\'t re-run it straight away.', paste: '<p>Sale ends 23:59 on [day date month]. <a href="/terms">Offer terms</a></p>' },
  urgency_never_ends: { steps: 'Replace "ends tonight" style wording with a real end date, and take it down when that date passes.', paste: 'Offer ends 23:59 on [day date month].' },
  scarcity_never_changes: { steps: 'Connect stock and "people viewing" messages to live data, or remove them.' },
  claim_superlative_claim: { steps: 'Keep current, independent evidence that you are No.1 across the market (for example sales data), and say what it is based on. Or soften it.', paste: 'Loved by over [number] customers' },
  claim_credential_claim: { steps: 'Name the award, who gave it, and the year, and only while it\'s current.', paste: 'Winner, [award name] [year]' },
  claim_green_claim: { steps: 'Replace absolute green words with a specific, provable fact.', paste: 'Packaging made from 100% recycled cardboard' },
  claim_performance_claim: { steps: 'Only say "clinically proven" if you hold published trials on this product showing exactly that. Otherwise describe what the product is.', paste: 'Made with [material/ingredient], designed for [benefit you can show]' },
  claim_medicinal_claim: { steps: 'Remove claims to treat, cure or prevent any condition unless the product is a licensed medicine.' },
  reviews_only_top: { steps: 'Show all genuine reviews, low ratings included, in date order by default. If you filter, say so clearly next to the reviews.', paste: 'Showing all [number] reviews from verified buyers, newest first.' },
  reviews_no_check_statement: { steps: 'Publish a short review policy and link it next to your reviews.', paste: 'About our reviews: we invite every customer to review after delivery and publish all genuine reviews, good and bad. We never pay for reviews or remove them for being negative. We check reviews for fakes using [method] and remove any that don\'t meet our policy.' },
  ad_label_missing: { steps: 'Put "Ad" or "Paid partnership with {brand}" at the very top of the page, before any content. Add "affiliate link" next to any paid links.', paste: '<p class="ad-label"><strong>Ad</strong> · Paid partnership with {brand}</p>' },
};

const caseOut = c => c && ({ id: c.id, name: c.name, regulator: c.regulator, date: c.date, penalty: c.penalty || null, outcome: caseOutcome(c), summary: c.summary, url: c.url || (c.imported ? null : ICO_ACTION_URL) });
const byId = id => caseOut(CASES.find(c => c.id === id));
const money = n => '£' + Math.round(n).toLocaleString('en-GB');

export function costFor(fixType, { revenueBand = null, sector = null } = {}) {
  if (!fixType) return null;
  const range = RANGE_OF[fixType] || fixType;
  const e = buildExposureForFix(range, revenueBand || 'under_1m', null, null, sector);
  const size = revenueBand ? BAND_LABELS[normaliseBand(revenueBand)] : null;
  if (e.category === 'ICO') {
    if (!revenueBand) return { regulator: 'ICO', label: 'Add your turnover in your business profile to see a £ figure for this.', needsProfile: true };
    return { regulator: 'ICO', low: e.realisticLow, high: e.realisticHigh, label: `${money(e.realisticLow)} to ${money(e.realisticHigh)}, from comparable published ICO fines for a business your size (${size})` };
  }
  if (e.category === 'CMA') {
    if (!revenueBand) return { regulator: 'CMA', label: 'The CMA can fine up to 10% of global turnover. Add your turnover in your business profile to see your figure.', needsProfile: true };
    const m = cmaStatutoryMax(revenueBand);
    return { regulator: 'CMA', max: m.amount, label: m.label };
  }
  if (e.category === 'ASA') return { regulator: 'ASA', label: `No fine, but an upheld ruling is published under your name. ${e.referralRiskLabel} to Trading Standards if it continues.` };
  return null;
}

// findings: Site Sweep findings. ctx: { fixMap, revenueBand, sector, brand, domain }
export function enrichFindings(findings, ctx = {}) {
  const fill = s => String(s || '').replace(/\{brand\}/g, ctx.brand || 'us').replace(/\{domain\}/g, ctx.domain || '');
  return findings.map(f => {
    const fx = FIXES[f.checkId];
    const fixType = ctx.fixMap?.[f.checkId] || COST_ONLY[f.checkId] || null;
    let c = null;
    if (f.caseId) c = byId(f.caseId);
    if (!c && !f.noCase && f.issue && f.issue !== 'other') c = caseForIssue(f.issue, { text: `${f.title} ${f.excerpt || ''}` });
    return {
      ...f,
      where: f.element || (f.page ? `Page ${f.page}` : ''),
      case: c || null,
      cost: costFor(fixType, ctx),
      fix: fx ? { steps: fill(fx.steps), paste: fx.paste ? fill(fx.paste) : '' } : null,
    };
  });
}

// "Brightside Home | Homeware..." -> "Brightside Home"
export function brandFrom(title, domain) {
  const parts = String(title || '').split(/\s[|–—-]\s/).map(s => s.trim()).filter(Boolean);
  const short = parts.find(p => p.length <= 30 && !/^(home|welcome)$/i.test(p));
  return short || String(domain || '').split('.')[0].replace(/^\w/, c => c.toUpperCase());
}
