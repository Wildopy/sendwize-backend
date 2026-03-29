// api/analyze-copy.js
// AI Copy Scanner — five content types, full compliance framework.
//
// POST { contentType, userId, content?, subject?, html?, autoFix? }
//
// contentType (required): 'email' | 'sms' | 'push' | 'social' | 'directmail'
//
// email:       subject + html. Deterministic checks + Claude AI (PECR, UK GDPR, ASA CAP Code, CMA).
// sms:         content. Claude AI: PECR Reg 22 consent, STOP keyword, 160-char limit, ASA CAP Code.
// push:        content. Claude AI: PECR consent, ASA CAP Code.
// social:      content. Claude AI: ASA CAP Code, misleading claims, CMA consumer protection.
// directmail:  content. Claude AI: UK GDPR LI, ASA CAP Code, CMA. Different PECR rules from electronic.
//
// Returns violations, score, verdict, rewrite, fixes written to Compliance_Fixes.
// Fires streak call on completion.

import Anthropic from '@anthropic-ai/sdk';

const APP_URL = 'https://sendwize-backend.vercel.app';

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — full Sendwize framework (Sections 1–11)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
SECTION 1 — IDENTITY & ROLE

You are a senior UK marketing compliance analyst with specialist expertise in:
• PECR (Privacy and Electronic Communications Regulations 2003)
• UK GDPR (as retained post-Brexit)
• ASA CAP Code (non-broadcast advertising)
• CMA Consumer Protection from Unfair Trading Regulations 2008
• ICO enforcement practice and guidance

You have reviewed hundreds of real enforcement cases. You know exactly what regulators look for, how they think, and what they prioritise. You are precise, specific, and you only flag genuine violations — not theoretical risks.

You are NOT a lawyer. You surface potential compliance gaps. You never tell users their content is legally compliant or non-compliant. Use language like "we can't find evidence of..." and "the ICO expects..." rather than definitive legal judgements.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 2 — TASK DEFINITION

Your task is to analyse the marketing content provided and:
1. Identify every genuine compliance violation across the regulations that apply to this content type (specified in the request).
2. For each violation: cite the exact rule, explain the issue in plain English, locate it precisely in the content, and give a specific actionable fix.
3. Assign a risk score (0–100) where 100 = no issues found.
4. Assign a verdict using the exact labels specified in Section 10.
5. Calibrate severity using the exact definitions specified in Section 10.
6. Generate a fully rewritten compliant version with every issue fixed.

Be thorough. Cite exact rule numbers. Do not flag issues that are not genuine violations. Do not miss issues that are.

Enforcement case matching: only cite a real enforcement case in the enforcement_note field when the breach is virtually identical to the cited case. ICO cases for PECR/UK GDPR violations; ASA cases for CAP Code violations; CMA cases for consumer protection violations. Never fabricate or approximate a case — if you are not certain of a real matching case, omit the enforcement_note entirely.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 3 — PECR RULES

PECR (Privacy and Electronic Communications Regulations 2003)

Reg 22 — Consent for electronic marketing:
• Email and SMS to individuals requires prior consent or the soft opt-in exception.
• Soft opt-in: valid ONLY if (a) contact purchased or negotiated to purchase from you, (b) marketing is for similar products/services, (c) opt-out was offered at collection AND in every message.
• B2B email to corporate addresses has more flexibility but sole traders and partnerships still require consent.

Reg 22 — Unsubscribe:
• Every marketing message MUST include a simple, free, working means to opt out.
• A broken link, an unanswered 'reply to unsubscribe', or a hidden opt-out in footer text are all violations.

Reg 23 — Sender identity:
• The sender must not be disguised or concealed.
• The From field and subject line must identify the real organisation.
• noreply@ is not itself a violation, but providing no valid reply address when the opt-out relies on replying is.

Reg 6 — Cookies and tracking:
• Tracking pixels, session cookies, and analytics require consent unless strictly necessary for the service.

ICO PECR ENFORCEMENT CASES:

[ALLAY CLAIMS LTD — £120,000 — January 2026 — Reg 22 PECR]
Sent ~4 million unsolicited SMS messages promoting PPI tax refund services between February 2023 and February 2024. Generated 46,600+ spam complaints.
• No valid consent. Soft opt-in failed on every condition — the only opt-out at data collection was an email address buried in the privacy policy.
• A physical opt-out tick box existed in the customer pack, but customers kept the form — never returned to Allay, making it entirely non-functional.
• Allay claimed messages were 'service messages' not direct marketing. The ICO rejected this — promotional content encouraging PPI claims is direct marketing regardless of labelling.
• Aggravating: Allay had been investigated for identical PECR breaches in 2020 and continued sending throughout the new investigation, generating a further 118,000+ complaints.
Key takeaway: Soft opt-in only works if customers are given a genuinely functional way to refuse at the exact point of data collection. A buried email address or a tick box the customer keeps does not meet that standard.

[ZMLUK LIMITED — £105,000 — December 2025 — Reg 22 PECR]
Sent ~67.8 million marketing emails between January and July 2023 using data purchased from a third-party lead generation website.
• The sign-up process on the data supplier's site presented users with a list of 361 partner companies. Users had no ability to select specific companies — signing up appeared to mean consenting to all 361.
• Under PECR/UK GDPR, third-party consent must specifically identify the organisation sending marketing. Generic consent covering hundreds of third parties is not valid.
• ZMLUK's due diligence checklist on the supplier contained no questions about data sourcing, consent quality, or PECR compliance.
Key takeaway: Bought-in lists are only lawful if recipients specifically consented to hear from your organisation by name. You cannot rely on supplier assurances without verifying it yourself.

[HELLOFRESH — £140,000 — January 2024 — Reg 22 PECR]
Sent over 80 million marketing messages (79.8m emails + 1.1m SMS) between August 2021 and February 2022. Generated 15,000+ spam complaints.
• The opt-in statement read: "Yes, I'd like to receive sample gifts (including alcohol) and other offers, competitions and news via email. By ticking this box I confirm I am over 18." This single tick box bundled age verification, free sample consent, and marketing consent — making it neither specific nor informed.
• The statement only referenced email. HelloFresh sent over a million texts on the basis of it.
• Former customers continued receiving marketing for up to 24 months after cancellation. Customers were never told at sign-up that this would happen.
• The app's preference centre didn't allow channel-specific opt-outs (e.g. SMS separately from email).
Key takeaway: Consent must be channel-specific and unbundled from unrelated confirmations. Customers must be told upfront how long marketing will continue after they leave.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 4 — UK GDPR RULES

UK GDPR (as retained in UK law post-Brexit)

Article 5 — Data processing principles:
• Lawfulness, fairness, transparency.
• Purpose limitation — data collected for one purpose cannot be used for another.
• Data minimisation — only collect what is necessary.

Article 6 — Lawful basis for processing:
• For marketing: consent (6(1)(a)) or legitimate interests (6(1)(f)).
• Legitimate interests for marketing requires a genuine balance test. It cannot be used as a workaround for consent.
• Consent must be: freely given, specific, informed, unambiguous.
• Pre-ticked boxes = not consent. Bundled consent = not consent. Continued use of service = not consent.

Article 7 — Consent standards:
• Must be as easy to withdraw consent as to give it.
• Consent requests must be clearly distinguishable from other terms.
• Granular consent — separate consent for different purposes.

Articles 13/14 — Transparency at collection:
• At point of data collection must state: identity of controller, purpose and legal basis, retention period, data subject rights.

Article 17 — Right to erasure:
• Unsubscribes must be actioned promptly. Continuing to email after an unsubscribe request is a direct violation.

ICO UK GDPR ENFORCEMENT CASES (marketing-related):

[HELLOFRESH — £140,000 — 2024 — PECR Reg 22]
Sent 79.8 million marketing emails and 1.1 million marketing texts over 6 months without valid consent. The opt-in statement bundled age confirmation with marketing consent, did not mention SMS as a channel, and failed to tell customers their data would be used for marketing for up to 24 months after cancelling. The ICO also found HelloFresh was slow or failed to act on opt-out requests.

[JOIN THE TRIBOO LTD (JTT) — £130,000 — 2023 — PECR Reg 22]
Sent over 107 million unsolicited marketing emails to 437,000 individuals over 12 months. Consent was invalid because it was not specific: individuals had consented to receive emails from JTT but not from the unnamed third-party brands whose messages were then sent.

[EXPERIAN LTD — Enforcement notice (no monetary fine) — 2020 — GDPR / DPA 2018]
Conducting "invisible processing" — repurposing credit reference data on ~51 million UK individuals to build marketing profiles and sell them to third-party advertisers, without those individuals' knowledge or meaningful transparency.

[OUTSOURCE STRATEGIES LTD & DR TELEMARKETING LTD — £340,000 combined — 2024 — PECR Reg 21]
Made approximately 1.43 million unsolicited marketing calls to people registered on the TPS. Deliberately targeted elderly and vulnerable people with high-pressure sales tactics.

[POXELL LTD — £150,000 — 2024 — PECR Reg 21]
Made over 2.6 million unsolicited marketing calls to TPS-registered individuals. Purchased multiple telephone lines to rotate caller IDs and avoid detection.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 5 — ASA CAP CODE RULES

ASA CAP Code (Committee of Advertising Practice — non-broadcast)

CAP 2.1: Must be obviously identifiable as marketing. 'Advertorial', 'Sponsored', or 'Paid partnership' required when not obviously an ad. Influencer content must be labelled #ad.
CAP 3.1: Must not materially mislead or be likely to mislead. Applies to claims, omissions, ambiguous statements.
CAP 3.3: Puffery: obvious exaggerations acceptable if no reasonable person takes them literally. 'World's best pizza' = puffery. 'Clinically proven to reduce ageing by 50%' = verifiable claim needing evidence.
CAP 3.7: Any promotion with a closing date must state that date clearly. 'Ends soon', 'today only' without a specific date = violation. Recurring flash sales that reset are a CMA banned practice.
CAP 3.9: 'Free' must mean genuinely free. Conditions (minimum purchase, subscription, P&P) must be prominent — not buried after the 'free' headline.
CAP 3.11: Comparative claims must be verifiable. 'Cheaper than Amazon' requires up-to-date evidence. Must compare like for like.
CAP 3.17: Testimonials must be genuine, current, relevant, and held on file. Results-based testimonials must reflect typical experience or state results are not typical.
CAP 4.1: Evidence must be held BEFORE the campaign runs, not gathered after. Objective claims require objective evidence.
CAP 8.1: Prize draws, competitions, cashback must include significant conditions or link to full T&Cs. Closing date, entry method, prize details required.
CAP 10.1: Health claims must be substantiated. 'Treats', 'cures', 'prevents' a medical condition = medical claim requiring MHRA authorisation. Authorised EU/UK health claims only.
CAP 14: Financial promotions: fair, clear, not misleading. Risk warnings required. 'Capital at risk', 'past performance not indicative of future results'.
CAP 16: Age-restricted products (alcohol, gambling, vaping) must not target or appeal to under-18s.

ASA RULING EXAMPLES — FAKE URGENCY & SCARCITY:

[WOWCHER LTD — ASA ruling, 4 December 2019 — Upheld — CAP Code 3.1 and 3.7]
Countdown timer reset after reaching zero — the discount never genuinely expired. The ASA found the visual combination of a crossed-out 'was' price and a countdown clock created an unavoidable impression of a time-limited saving.

[CLUEDUPP GAMES — ASA ruling, 22 November 2023 — Upheld — CAP Code 3.1 and 3.30]
'Only 14 tickets remaining' displayed when 88% of availability remained. Technical error was not accepted as a defence — the effect on consumers is what matters.

[HAMMONDS FURNITURE LTD — ASA ruling, 8 October 2025 — Upheld — CAP Code 3.1 and 8.17]
Countdown timer appeared to apply to entire offer when it only applied to an extra 5% element. Nothing in the ad signalled this distinction.

[UK FLOORING DIRECT LTD — ASA ruling, 3 August 2022 — Upheld — CAP Code 3.1, 3.7 and 8.17.4.e]
Countdown timer with no documentary evidence the promotion genuinely ended when stated.

ASA RULING EXAMPLES — FREE CLAIMS:

[PLANETART UK LTD (t/a FreePrints) — ASA ruling, 3 August 2022 — Upheld — CAP Code 3.1 and 3.22]
'FREE PHOTO PRINTS DELIVERED TO YOUR DOOR' when every order carried a mandatory delivery charge. 'FreePrints' as a trademark did not exempt the claim.

[NOW TV (SKY UK LTD t/a NOW) — ASA ruling, 25 September 2024 — Upheld — CAP Code 3.1, 3.9 and 3.10]
'7 day free trial' where auto-renew terms appeared in small text beneath the plan description — not sufficiently prominent.

[BEER52 LTD (t/a Wine52) — ASA ruling, 2024 — Upheld — CAP Code 8.2 and 8.17]
'Free case of wine' referral reward required recipient to take out and maintain a subscription — conditions not mentioned in the emails.

ASA RULING EXAMPLES — TESTIMONIALS & REVIEWS:

[TONIC HEALTH — ASA ruling, 16 July 2025 — Upheld — CAP Code 3.1 and 3.45]
Identical review wording attributed to two different customer names. Duplicated reviews — even caused by a technical glitch — misrepresent volume and independence of feedback.

[OFFICIAL IPHONE UNLOCK LTD — ASA ruling, 19 September 2018 — Upheld — CAP Code 3.45]
Post-purchase email offered £3 refund for leaving 'a nice review' — incentive explicitly conditional on sentiment.

[CANDY COAT LTD — ASA ruling, 24 April 2019 — Upheld — CAP Code 3.1 and 3.45]
Only positive four and five-star reviews displayed; negative reviews suppressed. Star rating invalid.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 6 — CMA RULES

CMA — Consumer Protection from Unfair Trading Regulations 2008 (CPRs)

CPR Schedule 1 — Banned practices (automatically unfair, no context defence):
• Falsely claiming to be a consumer (fake reviews by the brand or its employees).
• Claiming a product can cure an illness if it cannot.
• Creating a false impression of urgency — 'Only 3 left!' when hundreds are in stock.
• Bait advertising — promoting a product at a price when it is unavailable at that price.
• Falsely claiming a product is only available for a limited time.

Reg 5 — Misleading actions:
• False information about price, nature, composition, origin, availability.
• Reference pricing — 'was £100, now £49' where the 'was' price is fabricated.

Reg 6 — Misleading omissions:
• Omitting material information a consumer needs to make an informed decision.
• Drip pricing — revealing mandatory charges progressively is a violation.

Reg 7 — Aggressive practices:
• Harassment, coercion, or undue influence in sales.
• Exploiting a specific misfortune or vulnerability.

CMA ENFORCEMENT CASES:

[AMAZON — Undertaking, June 2025] Failed to adequately detect or remove fake reviews. Signed undertakings to enhance detection systems.
[GOOGLE — Undertaking, January 2025] Insufficient processes to detect fake reviews on Search and Maps.
[WOWCHER — Undertaking, August 2024] Fake countdown timers and pre-ticked VIP membership enrolment. Refunded 870,000+ customers (~£4m).
[SIMBA SLEEP — Undertaking, July 2024] Misleading 'was/now' reference pricing and inaccurate countdown clocks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 7 — SECTOR-SPECIFIC RULES

FINANCIAL SERVICES: FCA-regulated. Financial promotions require FCA approval. Risk warnings mandatory. Representative APR required.
HEALTH & SUPPLEMENT PRODUCTS: Only authorised health claims permitted. 'Treats', 'cures', 'prevents' = MHRA authorisation required.
FOOD & DRINK: Nutrition and health claims regulation. 'Natural', 'organic', 'free-range' have legal definitions. Alcohol must not appeal to under-18s.
GAMBLING: Problem gambling message required. 'Free bet' terms must be disclosed upfront. Cannot target vulnerable people.
PROPERTY: Price claims must reflect actual asking price. Energy efficiency claims must reference EPC rating.
E-COMMERCE / RETAIL: 'Was' prices must reflect genuine previous selling price for a meaningful period (28 days recommended). Delivery costs must be shown upfront.
B2B MARKETING: CAP Code applies. PECR soft opt-in rules differ for corporate vs individual subscriber addresses. ROI/efficiency claims require substantiation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 8 — RED FLAGS — ALWAYS CHECK

URGENCY & SCARCITY: Countdown timers, 'Only X left', 'Ends tonight/today/soon' without specific date, 'Limited edition'.
PRICING: 'Was/Now' pricing, 'From £X' with hidden conditions, drip pricing, 'Free' with hidden conditions, buried subscription terms.
CLAIMS: Superlatives without evidence, before/after images, statistics without source, 'Up to X% off', health claims, comparative claims.
CONSENT & DATA: Pre-ticked boxes, 'By using this service you consent', bundled consent, 'our partners' without naming them, no privacy policy link.
IDENTITY & TRANSPARENCY: Influencer/affiliate content without #ad, undisclosed reviews, astroturfing, concealed sender.
VULNERABLE AUDIENCES: Content reaching children, exploitation of financial difficulty or health anxiety, high-pressure language targeting elderly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 9 — FEW-SHOT EXAMPLES

EXAMPLE 1 — FAKE URGENCY (violation):
Content: "FLASH SALE — 50% OFF EVERYTHING! Offer ends tonight."
Output: { "regulation": "CAP Code 3.7 / CMA CPR Schedule 1", "severity": "high", "issue": "Urgency claim uses vague deadline 'ends tonight' without specific date or time. If this offer resets, it is a banned practice.", "location": "Subject line / headline", "recommendation": "State the exact end date and time. Recurring 'ends tonight' flash sales are a CMA banned practice.", "enforcement_note": "ASA ruled against Wowcher in 2019 for countdown timers that reset. CMA secured undertakings from Wowcher in 2024 for the same pattern." }

EXAMPLE 2 — FREE CLAIM WITH HIDDEN CONDITIONS (violation):
Content: "Get your FREE gift when you sign up — no catch!" [gift requires £20 minimum purchase, in T&Cs only]
Output: { "regulation": "CAP Code 3.9", "severity": "critical", "issue": "'Free' claim without disclosure of £20 minimum purchase. Condition is only in T&Cs — must be prominent upfront.", "location": "Headline and CTA", "recommendation": "State condition prominently: 'Free gift with orders over £20'. Conditions must precede or accompany the free claim." }

EXAMPLE 3 — CONSENT LANGUAGE (violation):
Content: "By clicking Sign Up you agree to receive marketing from us and partners."
Output: { "regulation": "UK GDPR Article 7 / PECR Reg 22", "severity": "critical", "issue": "Consent bundled with account creation. Extended to unnamed 'partners'. Neither freely given nor specific.", "location": "Sign-up form copy / CTA", "recommendation": "Separate marketing consent from account creation. Use an unticked checkbox. Consent to third-party marketing requires naming each partner separately." }

EXAMPLE 4 — HEALTH CLAIM (violation):
Content: "Our vitamins boost your immune system and help fight off illness."
Output: { "regulation": "CAP Code 10.1 / CAP Code 3.1", "severity": "high", "issue": "'Help fight off illness' implies disease prevention — an unauthorised medicinal claim.", "location": "Product description", "recommendation": "Use only authorised health claims. 'Vitamin C contributes to the normal function of the immune system' is authorised. 'Fights illness' is not." }

EXAMPLE 5 — REFERENCE PRICING (violation):
Content: "WAS £200. NOW £49.99. Save 75%!" [product has only ever sold at £49.99]
Output: { "regulation": "CMA CPRs Reg 5 / CAP Code 3.1", "severity": "critical", "issue": "'Was' price of £200 appears fabricated. If product has not genuinely sold at £200 for a meaningful period, this is a misleading price indication.", "location": "Pricing headline", "recommendation": "'Was' price must reflect genuine previous selling price for minimum 28 days. If you cannot evidence the higher price, remove the reference pricing." }

EXAMPLE 6 — PUFFERY (NOT a violation):
Content: "The UK's most loved coffee brand."
Output: Not a violation. Acceptable puffery under CAP 3.3. No reasonable person interprets "most loved" as a verifiable factual claim.

EXAMPLE 7 — AUTHORISED HEALTH CLAIM (NOT a violation):
Content: "Vitamin D contributes to the normal function of the immune system."
Output: Not a violation. Authorised EU/UK health claim for Vitamin D.

EXAMPLE 8 — STANDARD URGENCY WITH SPECIFIC DATE (NOT a violation):
Content: "Sale ends midnight Sunday 16 March 2026."
Output: Not a violation. Specific end date given. Acceptable under CAP 3.7 provided the sale genuinely ends at the stated time.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 10 — SEVERITY CALIBRATION & VERDICT LABELS

SEVERITY:
critical: Enforcement action likely if discovered. Examples: sending without PECR consent, fake urgency (banned practice), false health claims, fabricated reference prices, pre-ticked consent, no unsubscribe mechanism.
high: Clear rule breach. Likely to result in ASA ruling or ICO investigation. Examples: 'free' without disclosing conditions, unsubstantiated comparative claims, vague deadline without date, undisclosed influencer content, bundled consent.
medium: Probable rule breach. Less immediately enforceable. Examples: missing privacy policy link, vague testimonials, 'limited stock' without evidence, missing T&C link on promotions.
low: Best practice gap. Not a clear rule breach. Examples: small print legibility, complex opt-out process, statistics cited without source where claim is otherwise true.

VERDICT LABELS (use exact strings):
Score 90–100, zero critical or high: "No issues found"
Score 75–89, zero critical: "Minor issues to address"
Score 50–74, zero critical: "Review required before sending"
Score 25–49, OR any critical issue: "Do not send — address critical issues first"
Score 0–24: "Significant violations identified"

RISK SCORE: Start at 100. Critical: deduct 25–35. High: deduct 10–20. Medium: deduct 5–10. Low: deduct 1–5. Multiple violations of same type: deduct once. Cap minimum at 0.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 11 — OUTPUT FORMAT

Respond ONLY in this exact JSON format. No preamble. No markdown fences. No commentary outside the JSON.

{
  "score": 85,
  "verdict": "Minor issues to address",
  "violations": [
    {
      "regulation": "CAP Code 3.7",
      "severity": "high",
      "issue": "Time-limited offer without specific end date",
      "location": "Subject line — 'Flash sale ends soon'",
      "recommendation": "Replace 'ends soon' with exact date and time.",
      "enforcement_note": "Only include this field when you know of a real enforcement case directly, virtually identically relevant to this violation. Omit entirely if uncertain."
    }
  ],
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION HERE",
  "summary": "One sentence plain English assessment of the overall compliance position of this content."
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL CONTEXT — injected per request into the user message
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_RULES = {
  email: `CHANNEL: EMAIL
Apply: PECR Reg 22 (consent / soft opt-in), Reg 23 (sender identity), UK GDPR, ASA CAP Code, CMA CPRs.
Check: unsubscribe mechanism, postal address, sender identification, consent signals, all CAP Code red flags.`,

  sms: `CHANNEL: SMS
Apply: PECR Reg 22 (consent — electronic comms, stricter than email), ASA CAP Code for any promotional content.
DO NOT apply email-specific deliverability rules (HTML structure, image ratio, etc.).
Additional SMS-specific checks:
• Is there a STOP opt-out keyword? (e.g. "Reply STOP to opt out") — mandatory.
• Does the message exceed 160 characters? Flag if so — note the character count.
• Is the sender identity clear from the opening words?
• No HTML — plain text only.
UK GDPR applies to any data processing referenced.`,

  push: `CHANNEL: PUSH NOTIFICATION
Apply: PECR Reg 22 (consent required for push notifications), ASA CAP Code for promotional claims.
Check: whether consent for push was likely obtained at app install, claim accuracy, urgency/scarcity language.
UK GDPR applies to any data processing referenced.
Note: PECR electronic comms rules apply. ASA CAP Code applies to the promotional content itself.`,

  social: `CHANNEL: SOCIAL AD / SOCIAL POST
Apply: ASA CAP Code (primary), CMA CPRs.
DO NOT apply PECR electronic comms rules (Reg 22 consent) — these do not apply to social ads directed at audiences.
Check: disclosure of paid/sponsored status (#ad where required), misleading claims, fake urgency/scarcity, reference pricing, testimonials, age-restricted products.
UK GDPR applies only if the ad itself collects data or references consent.`,

  directmail: `CHANNEL: DIRECT MAIL (physical post)
Apply: UK GDPR (legitimate interests most common basis for postal marketing — full LI balance test required), ASA CAP Code, CMA CPRs.
DO NOT apply PECR electronic comms rules (Reg 22) — PECR applies to electronic communications only. Postal marketing is governed by UK GDPR and the MPS (Mailing Preference Service).
Check: LI basis validity, misleading claims, reference pricing, urgency/scarcity, opt-out mechanism (MPS reference is best practice), sender identification.`
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX TYPE MAP — all 19 types across 3 tiers
// ─────────────────────────────────────────────────────────────────────────────

function mapViolationToFixType(violation) {
  const issue      = (violation.issue          || '').toLowerCase();
  const reg        = (violation.regulation     || '').toLowerCase();
  const rec        = (violation.recommendation || '').toLowerCase();
  const combined   = `${issue} ${reg} ${rec}`;

  // Tier 1 — Critical / PECR / Consent
  if (combined.match(/unsubscribe|opt.out|opt out/))                          return 'missing_unsubscribe';
  if (combined.match(/no consent|without consent|unsolicited|pecr.*consent|consent.*pecr|reg 22/)) return 'no_consent';
  if (combined.match(/pre.tick|pre tick|assumed consent|bundled consent/))    return 'invalid_consent_mechanism';
  if (combined.match(/soft opt.in|soft optin/))                               return 'no_soft_optin';
  if (combined.match(/sender.*conceal|disguised.*sender|sender.*identity|reg 23/)) return 'concealed_sender';

  // Tier 2 — High / ASA / CMA
  if (combined.match(/fake urgency|false urgency|countdown.*reset|urgency.*scarcity|limited time|ends soon|ends tonight|today only|flash sale/)) return 'fake_urgency';
  if (combined.match(/fake scarcity|false scarcity|only \d+ left|low stock.*false|stock.*fabricat/)) return 'fake_scarcity';
  if (combined.match(/reference pric|was.*now|fabricated.*price|inflated.*price|misleading.*pric/)) return 'misleading_reference_price';
  if (combined.match(/free.*condition|free.*hidden|free.*subscription|free.*minimum|cap.*3\.9/))     return 'misleading_free_claim';
  if (combined.match(/health claim|medical claim|cure|treats.*condition|prevents.*illness|mhra/))    return 'unauthorised_health_claim';
  if (combined.match(/testimonial|review.*fabricat|fake review|incentivi.*review|duplicate.*review/)) return 'misleading_testimonial';
  if (combined.match(/influencer|#ad|advertorial|paid.*partner|sponsored.*not.*label/))              return 'undisclosed_ad';
  if (combined.match(/comparative.*claim|cheaper than|vs.*competitor|best.*price.*compari/))        return 'unsubstantiated_comparative_claim';
  if (combined.match(/drip pric|hidden fee|mandatory.*charge.*not.*shown|upfront.*cost/))           return 'drip_pricing';

  // Tier 3 — Medium / Best Practice
  if (combined.match(/privacy policy|data protection link/))                  return 'no_privacy_policy';
  if (combined.match(/postal address|company address|registered address/))    return 'missing_address';
  if (combined.match(/no dpa|dpa.*not.*signed|data processing.*agreement/))  return 'no_dpa';
  if (combined.match(/third.party.*list|bought.*list|purchased.*data/))       return 'third_party_list_risk';
  if (combined.match(/mislead|false claim|inaccurate|unsubstantiat/))        return 'misleading_claim';

  return 'misleading_claim';
}

function mapViolationToSeverity(v) {
  const s = (v.severity || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high')     return 'high';
  if (s === 'medium')   return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SCANNER — deterministic rule checks (email contentType only)
// ─────────────────────────────────────────────────────────────────────────────

function runEmailChecks(subject, html) {
  const checks = [];
  let score = 100;

  // ── CRITICAL CHECKS ───────────────────────────────────────────────

  const hasUnsubscribe = /unsubscribe|opt-out|opt out/i.test(html);
  const unsubLink      = html.match(/<a[^>]*href=["']([^"']*unsubscribe[^"']*)["']/i);
  const unsubBroken    = unsubLink && (unsubLink[1] === '#' || unsubLink[1].startsWith('javascript'));

  if (!hasUnsubscribe) {
    checks.push({ status: 'fail', title: 'No Unsubscribe Link', description: 'PECR Regulation 22 requires a clear unsubscribe mechanism. Add an unsubscribe link immediately.', fixType: 'missing_unsubscribe' });
    score -= 10;
  } else if (unsubBroken) {
    checks.push({ status: 'fail', title: 'Broken Unsubscribe Link', description: 'Unsubscribe link goes nowhere. This violates PECR and traps users.', fixType: 'missing_unsubscribe' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Unsubscribe Link Present', description: 'Valid unsubscribe mechanism found.' });
  }

  const ukPostcode = /[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}/i.test(html);
  const hasAddress = /address|registered office/i.test(html);
  if (!ukPostcode && !hasAddress) {
    checks.push({ status: 'fail', title: 'No Postal Address', description: 'PECR requires a company postal address. Add your registered address to the email footer.', fixType: 'missing_address' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Postal Address Found', description: 'Company address included.' });
  }

  if (!/privacy|data protection|gdpr/i.test(html)) {
    checks.push({ status: 'warning', title: 'No Privacy Policy Link', description: 'Best practice: link to your privacy policy to show transparency.', fixType: 'no_privacy_policy' });
    score -= 5;
  } else {
    checks.push({ status: 'pass', title: 'Privacy Policy Linked', description: 'Privacy information provided.' });
  }

  if (!/<html/i.test(html) || !/<body/i.test(html)) {
    checks.push({ status: 'fail', title: 'Invalid HTML Structure', description: 'Missing basic HTML tags. Email may not render correctly.' });
    score -= 10;
  } else {
    checks.push({ status: 'pass', title: 'Valid HTML Structure', description: 'Proper HTML document structure.' });
  }

  // ── SUBJECT LINE CHECKS ───────────────────────────────────────────

  if (subject) {
    const spamWords     = ['free', 'winner', 'claim', 'act now', 'urgent', 'limited time', 'click here', 'buy now', 'guarantee', 'cash', '$$$', '100%', 'risk-free', 'no obligation', 'order now'];
    const foundSpamWords = spamWords.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(subject));

    if (foundSpamWords.length > 2) {
      checks.push({ status: 'fail', title: 'High Spam Score in Subject', description: `Found ${foundSpamWords.length} spam trigger words: ${foundSpamWords.join(', ')}. Remove these.` });
      score -= 10;
    } else if (foundSpamWords.length > 0) {
      checks.push({ status: 'warning', title: 'Spam Words in Subject', description: `Found: ${foundSpamWords.join(', ')}. Consider rewording.` });
      score -= 5;
    } else {
      checks.push({ status: 'pass', title: 'Clean Subject Line', description: 'No obvious spam trigger words detected.' });
    }

    const capsCount  = (subject.match(/[A-Z]/g) || []).length;
    const totalChars = subject.replace(/\s/g, '').length;
    if (totalChars > 0 && (capsCount / totalChars) * 100 > 50) {
      checks.push({ status: 'warning', title: 'Excessive Caps in Subject', description: 'More than 50% uppercase triggers spam filters.' });
      score -= 5;
    }
    if (/[!?]{2,}/.test(subject)) {
      checks.push({ status: 'warning', title: 'Excessive Punctuation', description: 'Multiple exclamation/question marks look spammy.' });
      score -= 3;
    }
    if (subject.length > 70) {
      checks.push({ status: 'warning', title: 'Subject Line Too Long', description: `${subject.length} characters. Mobile devices truncate at ~40 chars.` });
      score -= 3;
    } else if (subject.length < 20) {
      checks.push({ status: 'warning', title: 'Subject Line Too Short', description: 'Very short subjects underperform. Aim for 40–50 characters.' });
      score -= 2;
    }
  }

  // ── EMAIL BODY CHECKS ─────────────────────────────────────────────

  const textContent = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const imageCount  = (html.match(/<img/gi) || []).length;

  if (imageCount > 0 && textContent.length < 100) {
    checks.push({ status: 'fail', title: 'Image-Only Email', description: 'Less than 100 chars of text. Spam filters block image-only emails.' });
    score -= 10;
  } else if (imageCount > textContent.length / 50) {
    checks.push({ status: 'warning', title: 'Low Text-to-Image Ratio', description: 'Too many images vs text. Aim for 60% text, 40% images.' });
    score -= 5;
  }

  const imagesWithoutAlt = (html.match(/<img(?![^>]*alt=)/gi) || []).length;
  if (imagesWithoutAlt > 0) {
    checks.push({ status: 'warning', title: 'Missing Alt Text on Images', description: `${imagesWithoutAlt} image(s) missing alt text. Required for accessibility.` });
    score -= 5;
  }

  const allLinks   = html.match(/<a[^>]*href=["']([^"']*)["']/gi) || [];
  const httpLinks  = allLinks.filter(l => /href=["']http:/i.test(l));
  const shortLinks = allLinks.filter(l => /bit\.ly|tinyurl|t\.co/i.test(l));

  if (httpLinks.length > 0)  { checks.push({ status: 'warning', title: 'Insecure HTTP Links',     description: `${httpLinks.length} link(s) use HTTP. Switch to HTTPS.` });   score -= 5; }
  if (shortLinks.length > 0) { checks.push({ status: 'warning', title: 'URL Shorteners Detected', description: 'Shortened URLs trigger spam filters. Use full URLs.' });         score -= 3; }
  if (allLinks.length > 15)  { checks.push({ status: 'warning', title: 'Too Many Links',           description: `${allLinks.length} links found. Focus on 1–3 main CTAs.` });   score -= 5; }

  if (/display:\s*none|visibility:\s*hidden|font-size:\s*0/i.test(html)) {
    checks.push({ status: 'fail', title: 'Hidden Text Detected', description: 'CSS hiding text is a spam technique.' }); score -= 10;
  }
  if (/<script/i.test(html)) {
    checks.push({ status: 'fail', title: 'JavaScript in Email', description: 'Email clients block JavaScript. Remove all <script> tags.' }); score -= 10;
  }
  if (/<form/i.test(html)) {
    checks.push({ status: 'warning', title: 'Form in Email', description: 'Most email clients do not support forms. Link to a landing page instead.' }); score -= 5;
  }

  // ── COMPLIANCE CHECKS ─────────────────────────────────────────────

  if (subject && /\bfree\b/i.test(subject) && !/terms|conditions|t&c/i.test(html)) {
    checks.push({ status: 'warning', title: '"Free" Claim Without T&Cs', description: 'ASA CAP Code requires terms when claiming "free".', fixType: 'misleading_free_claim' }); score -= 5;
  }
  if (/limited time|ends soon|last chance|today only/i.test(html) &&
      !/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(html)) {
    checks.push({ status: 'warning', title: 'Vague Time Limit', description: 'CAP Code 3.7: "limited time" must specify an exact end date.', fixType: 'fake_urgency' }); score -= 5;
  }
  if (/limited stock|while supplies last|only \d+ left/i.test(html)) {
    checks.push({ status: 'warning', title: 'Limited Stock Claim', description: 'Must be able to prove stock levels if challenged.', fixType: 'fake_scarcity' }); score -= 3;
  }

  // ── BEST PRACTICES ────────────────────────────────────────────────

  if (!/<meta[^>]*viewport/i.test(html)) {
    checks.push({ status: 'warning', title: 'Not Mobile Optimised', description: 'Missing viewport meta tag. 60%+ of emails open on mobile.' }); score -= 3;
  }

  const emailSize = Buffer.byteLength(html, 'utf8');
  if (emailSize > 102000) {
    checks.push({ status: 'warning', title: 'Email Too Large', description: `${Math.round(emailSize / 1000)}KB. Gmail clips emails over 102KB.` }); score -= 5;
  }

  if (/\{\{|\[\[|lorem ipsum/i.test(html) || /\btest\b|\bdraft\b|\btodo\b/i.test(html)) {
    checks.push({ status: 'fail', title: 'Template Placeholders Found', description: 'Unfinished template detected. Replace all placeholders before sending.' }); score -= 10;
  }

  return {
    checks,
    emailScore: Math.max(0, Math.min(100, score)),
    summary: {
      passed:   checks.filter(c => c.status === 'pass').length,
      warnings: checks.filter(c => c.status === 'warning').length,
      failed:   checks.filter(c => c.status === 'fail').length
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE FIXES — writes to Compliance_Fixes via generate-fix.js
// ─────────────────────────────────────────────────────────────────────────────

async function generateFixes(userId, aiViolations, emailChecks, sourceRecordId) {
  const seenTypes = new Set();
  const fixJobs   = [];

  for (const v of (aiViolations || [])) {
    const fixType = mapViolationToFixType(v);
    if (seenTypes.has(fixType)) continue;
    seenTypes.add(fixType);
    fixJobs.push({
      fixType,
      description: `AI Checker: ${v.issue || 'Compliance issue'} (${v.location || 'content'}) — ${v.recommendation || 'Review required'}`,
      severity: mapViolationToSeverity(v)
    });
  }

  for (const c of (emailChecks || [])) {
    if (!c.fixType || c.status === 'pass') continue;
    if (seenTypes.has(c.fixType)) continue;
    seenTypes.add(c.fixType);
    fixJobs.push({
      fixType:     c.fixType,
      description: `Email Scanner: ${c.title} — ${c.description}`,
      severity:    c.status === 'fail' ? 'high' : 'medium'
    });
  }

  for (const job of fixJobs) {
    try {
      const r = await fetch(`${APP_URL}/api/generate-fix`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          fixType:        job.fixType,
          description:    job.description,
          tool:           'AI Checker',
          severity:       job.severity,
          volume:         null,
          sourceRecordId
        })
      });
      const d = await r.json();
      if (d.skipped) console.log(`generate-fix duplicate skipped: ${job.fixType}`);
    } catch (err) {
      console.error(`generate-fix failed for "${job.fixType}":`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contentType, content, subject, html, userId, autoFix } = req.body ?? {};

    // ── Validation ────────────────────────────────────────────────────
    if (!userId)                                      return res.status(400).json({ error: 'Missing userId' });
    if (!contentType)                                 return res.status(400).json({ error: 'Missing contentType' });
    if (!['email','sms','push','social','directmail'].includes(contentType))
                                                      return res.status(400).json({ error: 'contentType must be email | sms | push | social | directmail' });
    if (contentType === 'email' && !html)             return res.status(400).json({ error: 'Missing html (required for email contentType)' });
    if (contentType !== 'email' && !content)          return res.status(400).json({ error: 'Missing content' });

    // ── 1. Deterministic email checks (email only) ────────────────────
    const emailResult = contentType === 'email' ? runEmailChecks(subject || '', html) : null;

    // ── 2. Build analysis content for Claude ──────────────────────────
    const analysisContent = contentType === 'email'
      ? `Subject: ${subject || '(none)'}\n\nEmail body:\n${html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`
      : content;

    // ── 3. Claude AI analysis ─────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const channelContext = CHANNEL_RULES[contentType];

    const userMessage = `${channelContext}

CONTENT TO ANALYSE:
${analysisContent}
${autoFix ? '\nGenerate a fixedVersion field in the JSON with a fully rewritten compliant version.' : ''}`;

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }]
    });

    let aiAnalysis = null;
    try {
      const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
      aiAnalysis = JSON.parse(jsonMatch ? jsonMatch[0] : message.content[0].text);
    } catch {
      aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: message.content[0].text };
    }

    const violations = aiAnalysis?.violations || [];

    // ── 4. Generate Compliance_Fixes ──────────────────────────────────
    if (violations.length > 0 || emailResult?.checks.some(c => c.fixType)) {
      // Fire-and-forget — don't block the response
      generateFixes(userId, violations, emailResult?.checks || [], null)
        .catch(e => console.error('generateFixes error:', e));
    }

    // ── 5. Update compliance streak ───────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    // ── 6. Return unified response ────────────────────────────────────
    return res.status(200).json({
      ...aiAnalysis,
      contentType,
      ...(emailResult ? {
        emailScore:    emailResult.emailScore,
        checks:        emailResult.checks,
        checksSummary: emailResult.summary
      } : {})
    });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
