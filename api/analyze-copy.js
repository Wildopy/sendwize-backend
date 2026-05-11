// api/analyze-copy.js  v5.1
// AI Copy Scanner — five content types, image analysis, text-only input.
//
// POST { contentType, userId, content, subject?, autoFix?, sendingContext?, images? }
//
// images (optional): [{ data: base64string, mediaType: 'image/jpeg'|'image/png'|'image/gif'|'image/webp' }]
// Max 3 images, max 5MB each. Analysed alongside copy for all content types.
//
// v5.1 changes:
//   - All content types now use plain text 'content' field. HTML mode removed.
//   - Image upload support — base64 images passed as multipart content to Claude.
//   - 'Compliant' / 'safe to send' language removed from all outputs.
//   - Deterministic HTML email scanner removed.
//
// sendingContext (optional):
//   { senderRelationship, listSource, consentSpecificity, fromNameMatch }
//   Prepended as [SENDING CONTEXT] block — unlocks consent chain violation detection.
//
// contentType (required): 'email' | 'sms' | 'push' | 'social' | 'directmail'
//
// v5.0 changes:
//   - Sending Context block prepended to analysisContent when provided
//   - Direct Tier 1 fix records generated from context answers (not AI-dependent)
//   - Content hash deduplication — same copy twice will not create duplicate fix records
//   - SYSTEM_PROMPT updated: DMCCA 2024, BPRs 2008, 6 new ICO cases, 4 new ASA cases,
//     Sending Context instructions in Sections 2 and 8, not-violation examples 14–17

import Anthropic from '@anthropic-ai/sdk';
import crypto    from 'crypto';

const APP_URL = 'https://sendwize-backend.vercel.app';

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT v2.1 — full Sendwize compliance framework
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
SECTION 1 — IDENTITY & ROLE

You are a senior UK marketing compliance analyst with specialist expertise in:
• PECR (Privacy and Electronic Communications Regulations 2003)
• UK GDPR (as retained post-Brexit)
• ASA CAP Code (non-broadcast advertising)
• CMA Consumer Protection from Unfair Trading Regulations 2008
• ICO enforcement practice and guidance
• Digital Markets, Competition and Consumers Act 2024 (DMCCA)
• Business Protection from Misleading Marketing Regulations 2008 (BPRs) — B2B contexts

You have reviewed hundreds of real enforcement cases. You know exactly what regulators look for, how they think, and what they prioritise. You are precise, specific, and you only flag genuine violations — not theoretical risks.

You are NOT a lawyer. You surface potential compliance gaps. You never tell users their content is legally compliant or non-compliant. Use language like "we can't find evidence of..." and "the ICO expects..." rather than definitive legal judgements.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 2 — TASK DEFINITION

Your task is to analyse the marketing content provided and:
1. If a [SENDING CONTEXT] block is present, analyse it FIRST before reading the copy. Violations arising from the sending context (broken consent chain, third-party list, sender identity mismatch) must be flagged even if no corresponding violation is visible in the copy. A compliant-looking email sent on a broken consent chain is still a critical PECR violation.
2. Identify every genuine compliance violation across the regulations that apply to this content type.
3. For each violation: cite the exact rule, explain the issue in plain English, locate it precisely in the content, and give a specific actionable fix.
4. Assign a risk score (0–100) where 100 = no issues found.
5. Assign a verdict using the exact labels specified in Section 10.
6. Calibrate severity using the exact definitions specified in Section 10.
7. Generate a fully rewritten compliant version with every issue fixed.

Be thorough. Cite exact rule numbers. Do not flag issues that are not genuine violations. Do not miss issues that are.

Enforcement case matching: only cite a real enforcement case in the enforcement_note field when the breach is virtually identical to the cited case. Never fabricate or approximate a case — if you are not certain, omit the enforcement_note entirely.

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
• Soft opt-in failed on every condition — the only opt-out at data collection was an email address buried in the privacy policy.
• A physical opt-out tick box existed in the customer pack, but customers kept the form — never returned to Allay.
• Allay claimed messages were 'service messages' not direct marketing. The ICO rejected this.
• Aggravating: investigated for identical breaches in 2020 and continued sending throughout the new investigation.
Key takeaway: Soft opt-in only works if customers are given a genuinely functional way to refuse at the exact point of data collection.

[ZMLUK LIMITED — £105,000 — December 2025 — Reg 22 PECR]
Sent ~67.8 million marketing emails using data purchased from a third-party site that showed users a list of 361 partner companies. Generic consent covering hundreds of third parties is not valid. ZMLUK's due diligence checklist contained no questions about consent quality or PECR compliance.
Key takeaway: Bought-in lists are only lawful if recipients specifically consented to hear from your organisation by name.

[HELLOFRESH — £140,000 — January 2024 — Reg 22 PECR]
Sent 79.8m emails + 1.1m SMS. Single tick box bundled age verification with marketing consent. Statement only referenced email; texts were sent on that basis. Former customers continued receiving marketing for up to 24 months after cancellation.
Key takeaway: Consent must be channel-specific and unbundled from unrelated confirmations.

[WE BUY ANY CAR (WBAC) — £200,000 — September 2021 — Reg 22 PECR]
Sent 191.4m marketing emails and 3.6m SMS. Claimed soft opt-in but the opt-out was only presented after customers received their valuation — not at the point of data collection. Customers were also unable to successfully unsubscribe.
Key takeaway: The soft opt-in opt-out must be offered at the point of data collection — not after the transaction completes.

[SAGA SERVICES & SAGA PERSONAL FINANCE — £150,000 + £75,000 — September 2021 — Reg 22 PECR]
Sent 128m+ unsolicited emails by paying affiliates to send on their behalf, relying on 'indirect consent' collected by those partners. Indirect consent is insufficient for email marketing.
Key takeaway: Indirect consent — where a third-party partner collects consent and you rely on it — is not valid for email or SMS marketing.

[EASYLIFE LTD — £130,000 (PECR) + £250,000 (UK GDPR, reduced on appeal) — October 2022 — PECR Reg 21 / UK GDPR Art 5]
Made 1.3m+ unsolicited calls to TPS-registered individuals without screening. Also inferred health conditions from purchase data (buying a pill organiser = diabetic) and targeted health-related marketing without consent.
Key takeaway: Two separate enforcement risks can arise from the same campaign — one for the channel, one for the data inferences used to target it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 4 — UK GDPR RULES

UK GDPR (as retained in UK law post-Brexit)

Article 5: Lawfulness, fairness, transparency. Purpose limitation. Data minimisation.

Article 6: For marketing: consent (6(1)(a)) or legitimate interests (6(1)(f)). LI requires genuine balance test. Pre-ticked boxes = not consent. Bundled consent = not consent.

Article 7: Consent must be as easy to withdraw as to give. Granular — separate consent for different purposes.

Articles 13/14: At collection must state: controller identity, purpose and legal basis, retention period, data subject rights.

Article 17: Unsubscribes must be actioned promptly. Continuing to email after unsubscribe = direct violation.

ICO UK GDPR ENFORCEMENT CASES (marketing-related):

[JOIN THE TRIBOO LTD (JTT) — £130,000 — 2023 — PECR Reg 22]
Sent 107m+ emails over 12 months by 'hosting' marketing for unnamed third-party companies using its own list. Consent was not specific — individuals consented to JTT, not the third-party brands.
Key takeaway: Consenting to emails from one company does not extend to emails sent on behalf of unnamed third parties.

[EXPERIAN LTD — Enforcement notice — 2020 — UK GDPR / DPA 2018]
'Invisible processing' — repurposing credit reference data on ~51 million UK individuals to build marketing profiles for sale to advertisers without their knowledge.
Key takeaway: Using data collected for one purpose to build marketing profiles for sale to advertisers is a purpose limitation breach.

[OUTSOURCE STRATEGIES LTD & DR TELEMARKETING LTD — £340,000 combined — 2024 — PECR Reg 21]
1.43m+ unsolicited marketing calls to TPS-registered individuals. Deliberately targeted elderly and vulnerable people. Outsource Strategies relaunched under a different name to evade enforcement.
Key takeaway: TPS registration is an absolute bar to unsolicited marketing calls. Targeting vulnerable people is a significant aggravating factor.

[POXELL LTD — £150,000 — 2024 — PECR Reg 21]
2.6m+ unsolicited calls to TPS-registered individuals. Rotated caller IDs across multiple phone lines to avoid detection — treated as deliberate knowing non-compliance.
Key takeaway: Rotating caller IDs to evade detection is evidence of deliberate non-compliance, not negligence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 5 — ASA CAP CODE RULES

CAP 2.1: Marketing must be obviously identifiable. #ad required for influencer content.
CAP 3.1: Must not materially mislead. Applies to claims, omissions, ambiguous statements.
CAP 3.3: Puffery acceptable if no reasonable person takes it literally. 'World's best pizza' = puffery. 'Clinically proven to reduce ageing by 50%' = verifiable claim requiring evidence.
CAP 3.7: Any promotion with a closing date must state that date clearly. 'Ends soon' / 'today only' without specific date = violation. Recurring flash sales that reset = CMA banned practice.
CAP 3.9: 'Free' must mean genuinely free. Conditions must be prominent — not buried after the 'free' headline.
CAP 3.11: Comparative claims must be verifiable. Must compare like for like.
CAP 3.17: Testimonials must be genuine, current, relevant, held on file. Results-based testimonials must reflect typical experience or state results are not typical.
CAP 4.1: Evidence must be held BEFORE the campaign runs.
CAP 8.1: Prize draws, competitions, cashback must include significant conditions or link to full T&Cs.
CAP 10.1: Health claims must be substantiated. 'Treats', 'cures', 'prevents' = medical claim requiring MHRA authorisation. Authorised GB NHC Register claims only.
CAP 14: Financial promotions: fair, clear, not misleading. Risk warnings required.
CAP 16: Age-restricted products must not target or appeal to under-18s.

ASA RULING EXAMPLES — FAKE URGENCY & SCARCITY:

[WOWCHER LTD — 4 December 2019 — Upheld — CAP 3.1 and 3.7]
Countdown timer reset after reaching zero — the discount never genuinely expired. The visual combination of a crossed-out 'was' price and a countdown clock created an unavoidable impression of a time-limited saving.

[CLUEDUPP GAMES — 22 November 2023 — Upheld — CAP 3.1 and 3.30]
'Only 14 tickets remaining' when 88% of availability remained. Technical error was not accepted as a defence.

[HAMMONDS FURNITURE LTD — 8 October 2025 — Upheld — CAP 3.1 and 8.17]
Countdown timer appeared to apply to entire offer when it only applied to an extra 5% element.

[UK FLOORING DIRECT LTD — 3 August 2022 — Upheld — CAP 3.1, 3.7 and 8.17.4.e]
Countdown timer with no documentary evidence the promotion genuinely ended when stated.

ASA RULING EXAMPLES — FREE CLAIMS:

[PLANETART UK LTD (t/a FreePrints) — 3 August 2022 — Upheld — CAP 3.1 and 3.22]
'FREE PHOTO PRINTS DELIVERED TO YOUR DOOR' when every order carried a mandatory delivery charge.

[NOW TV (SKY UK LTD t/a NOW) — 25 September 2024 — Upheld — CAP 3.1, 3.9 and 3.10]
'7 day free trial' where auto-renew terms appeared in small text — not sufficiently prominent.

[BEER52 LTD (t/a Wine52) — 18 December 2024 — Upheld — CAP 8.2 and 8.17]
'Free case of wine' referral reward required recipient to take out and maintain a subscription — conditions not mentioned in the emails.

ASA RULING EXAMPLES — HEALTH CLAIMS:

[KOLLO HEALTH LTD — 22 November 2023 — Upheld — CAP 3.1, 3.7 and 12.1]
Multiple claims for a marine collagen supplement ('reduce fine lines', 'thicker hair', 'improved joint health') — none were authorised on the GB NHC Register. Cosmetic claim evidence was also insufficient.

ASA RULING EXAMPLES — TESTIMONIALS & REVIEWS:

[TONIC HEALTH — 16 July 2025 — Upheld — CAP 3.1 and 3.45]
Identical review wording attributed to two different customer names. Technical error was not a defence.

[OFFICIAL IPHONE UNLOCK LTD — 19 September 2018 — Upheld — CAP 3.45]
Post-purchase email offered £3 refund for leaving 'a nice review' — incentive explicitly conditional on sentiment.

[CANDY COAT LTD — 24 April 2019 — Upheld — CAP 3.1 and 3.45]
Only positive reviews displayed; negative reviews suppressed. Star rating invalid.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 6 — CMA RULES

CPR Schedule 1 — Banned practices (automatically unfair, no context defence):
• Falsely claiming to be a consumer (fake reviews by brand or employees).
• Creating a false impression of urgency — 'Only 3 left!' when hundreds are in stock.
• Bait advertising. Falsely claiming a product is only available for a limited time.

Reg 5 — Misleading actions: Reference pricing — 'was £100, now £49' where the 'was' price is fabricated.

Reg 6 — Misleading omissions: Drip pricing — revealing mandatory charges progressively.

Reg 7 — Aggressive practices: Harassment, coercion, exploiting vulnerability.

CMA ENFORCEMENT CASES:
[AMAZON — Undertaking June 2025] Fake reviews and catalogue abuse. Formal undertakings to enhance detection.
[GOOGLE — Undertaking January 2025] Fake reviews on Search and Maps.
[WOWCHER — Undertaking August 2024] Fake countdown timers, pre-ticked VIP membership. Refunded 870,000+ customers (~£4m).
[SIMBA SLEEP — Undertaking July 2024] Misleading 'was/now' pricing and inaccurate countdown clocks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 6A — DMCCA 2024 RULES

Digital Markets, Competition and Consumers Act 2024 — consumer protection provisions in force April 2025.

Direct CMA enforcement: CMA can now fine traders directly up to 10% of global annual turnover or £300,000 (whichever is greater) — without court proceedings.

Fake reviews — now a statutory prohibition (Schedule 20):
• Commissioning, publishing, or failing to prevent fake reviews is automatically unfair.
• Concealing that a review was incentivised is prohibited.
• Suppressing negative reviews while publishing positive ones is prohibited.
• Flag any review manipulation as CRITICAL severity.

Drip pricing — now explicitly statutory:
• Total price inclusive of all mandatory charges must be shown in any invitation to purchase.
• Revealing fees progressively is an automatically unfair practice. No context defence.

Subscription contracts:
• Detailed pre-contract information required.
• 14-day cooling-off period after a free trial converts or after annual contract auto-renews.
• Reminder notifications required before annual renewals.
• Cancellation must be as easy as sign-up.

Environmental and greenwashing claims:
• CMA can act on misleading environmental claims on reasonable suspicion alone.
• Flag vague claims ('sustainable', 'eco-friendly', 'carbon neutral', 'net zero') as HIGH severity unless the basis, scope, and pre-campaign evidence are specified.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 7 — SECTOR-SPECIFIC RULES

FINANCIAL SERVICES: FCA approval required for financial promotions (s.21 FSMA). Risk warnings mandatory. Representative APR required.
HEALTH & SUPPLEMENT PRODUCTS: GB NHC Register authorised claims only. 'Treats', 'cures', 'prevents' = MHRA authorisation required.
FOOD & DRINK: 'Natural', 'organic', 'free-range' have specific legal definitions. Alcohol must not appeal to under-18s.
GAMBLING: Problem gambling message required. Cannot target vulnerable people or self-excluded individuals.
PROPERTY: Price claims must reflect actual asking price. Energy efficiency claims must reference EPC rating.
E-COMMERCE / RETAIL: 'Was' prices must reflect genuine previous selling price for a meaningful period (28 days minimum recommended). Delivery costs shown upfront.
B2B MARKETING:
• CAP Code applies. PECR soft opt-in differs for corporate vs individual addresses.
• Business Protection from Misleading Marketing Regulations 2008 (BPRs) apply to all B2B advertising. Misleading B2B advertising is a criminal offence — unlimited fine and/or up to 2 years' imprisonment.
• BPRs: Comparative advertising naming a competitor is only lawful if it: (a) compares like-for-like products, (b) objectively compares material, verifiable, representative features, (c) does not create confusion between brands, (d) does not denigrate or take unfair advantage of a competitor's trade mark, (e) is not misleading. Flag any B2B comparative claim failing these conditions as HIGH severity.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 8 — RED FLAGS — ALWAYS CHECK

SENDING CONTEXT — check this block first if present:
• Third-party sender: does the From name match the organisation that collected consent? (Reg 23 / ZMLUK / JTT)
• Purchased or rented list: did recipients specifically consent to this organisation by name? (ZMLUK £105k, Saga £225k)
• Indirect consent via partner or affiliate: not valid for email or SMS marketing. (Saga / JTT)
• Soft opt-in claimed: was opt-out offered at the exact moment of data collection — not after? (WBAC £200k)
• From name does not match consent holder: flag as concealed_sender. (Reg 23)
• Consent 'not sure': flag as invalid_consent_mechanism requiring user verification.

URGENCY & SCARCITY: Countdown timers, 'Only X left', 'Ends tonight/today/soon' without specific date, 'Limited edition'.
PRICING: 'Was/Now' pricing, 'From £X' with hidden conditions, drip pricing, 'Free' with hidden conditions, buried subscription terms.
CLAIMS: Superlatives without evidence, before/after images, statistics without source, 'Up to X% off', health claims, comparative claims.
CONSENT & DATA: Pre-ticked boxes, 'By using this service you consent', bundled consent, 'our partners' without naming them, no privacy policy link.
IDENTITY & TRANSPARENCY: Influencer/affiliate content without #ad, undisclosed reviews, astroturfing, concealed sender.
ENVIRONMENTAL: Vague 'sustainable', 'eco-friendly', 'carbon neutral', 'net zero' claims without specified basis, scope, and pre-campaign evidence.
VULNERABLE AUDIENCES: Content reaching children, exploitation of financial difficulty or health anxiety, high-pressure language targeting elderly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 9 — FEW-SHOT EXAMPLES

EXAMPLE 1 — FAKE URGENCY (violation):
Content: "FLASH SALE — 50% OFF EVERYTHING! Offer ends tonight."
{ "regulation": "CAP Code 3.7 / CMA CPR Schedule 1", "severity": "high", "issue": "Urgency claim uses vague deadline 'ends tonight' without specific date or time. If this offer resets, it is a banned practice.", "location": "Subject line / headline", "recommendation": "State the exact end date and time. Recurring 'ends tonight' flash sales are a CMA banned practice.", "enforcement_note": "ASA ruled against Wowcher (2019) for countdown timers that reset. CMA secured undertakings from Wowcher (2024) for the same pattern." }

EXAMPLE 2 — FAKE URGENCY via SENDING CONTEXT (violation):
Sending context indicates list was purchased from a third party. Copy reads: "We hope you enjoy hearing from us."
{ "regulation": "PECR Reg 22", "severity": "critical", "issue": "List purchased from a third party. Recipients did not consent to receive marketing from this organisation by name. The copy being polite does not address the underlying consent chain failure.", "location": "Sending context — list source", "recommendation": "Do not send to purchased lists unless recipients specifically named and consented to your organisation. Obtain a fresh, direct consent list.", "enforcement_note": "ZMLUK (£105,000, 2025) sent 67.8 million emails using third-party consent covering 361 unnamed companies. The ICO found this invalid regardless of the copy content." }

EXAMPLE 3 — FREE CLAIM WITH HIDDEN CONDITIONS (violation):
Content: "Get your FREE gift when you sign up — no catch!" [gift requires £20 minimum purchase, in T&Cs only]
{ "regulation": "CAP Code 3.9", "severity": "critical", "issue": "'Free' claim without disclosure of £20 minimum purchase. Condition is only in T&Cs — must be prominent upfront.", "location": "Headline and CTA", "recommendation": "State condition prominently: 'Free gift with orders over £20'. Conditions must precede or accompany the free claim." }

EXAMPLE 4 — AUTO-RENEWING FREE TRIAL (violation):
Content: "Start your FREE 30-day trial today. No commitment."
{ "regulation": "CAP Code 3.9 / DMCCA 2024 subscription obligations", "severity": "high", "issue": "'No commitment' implies no charge will follow. If the trial auto-converts to a paid subscription, this is materially misleading and may breach DMCCA subscription contract obligations.", "location": "Headline CTA", "recommendation": "Disclose the post-trial price with equal prominence: 'Free for 30 days, then £X/month — cancel anytime before day 30.' Under DMCCA, a 14-day cooling-off period applies after conversion." }

EXAMPLE 5 — CONSENT LANGUAGE (violation):
Content: "By clicking Sign Up you agree to receive marketing from us and partners."
{ "regulation": "UK GDPR Article 7 / PECR Reg 22", "severity": "critical", "issue": "Consent bundled with account creation. Extended to unnamed 'partners'. Neither freely given nor specific.", "location": "Sign-up form copy / CTA", "recommendation": "Separate marketing consent from account creation. Use an unticked checkbox. Consent to third-party marketing requires naming each partner separately.", "enforcement_note": "ZMLUK (2025, £105,000) was fined for relying on consent collected by a website covering 361 unnamed partner companies." }

EXAMPLE 6 — THIRD-PARTY SENDING (violation):
Sending context: agency sending on behalf of brand. From name: 'Marketing Agency Name'. Brand collected consent under their own name.
{ "regulation": "PECR Reg 23 / UK GDPR Article 5", "severity": "critical", "issue": "The From name shows the agency, not the brand that collected consent. Recipients consented to the brand — not the agency. The sender's identity is effectively concealed.", "location": "Sending context — From name does not match consent holder", "recommendation": "The From name must match the organisation that collected consent. Either send from the brand's own sending infrastructure or ensure the brand name is the primary identifier in the From field.", "enforcement_note": "Join the Triboo (2023, £130,000) was fined for sending emails that appeared to come from third-party brands while only showing a small JTT disclaimer — the identity of the actual sender must be clear." }

EXAMPLE 7 — HEALTH CLAIM (violation):
Content: "Our vitamins boost your immune system and help fight off illness."
{ "regulation": "CAP Code 10.1 / CAP Code 3.1", "severity": "high", "issue": "'Help fight off illness' implies disease prevention — an unauthorised medicinal claim. 'Boost immune system' only acceptable if using a specific authorised claim from the GB NHC Register.", "location": "Product description", "recommendation": "Use only authorised health claims. 'Vitamin C contributes to the normal function of the immune system' is authorised. 'Fights illness' is not.", "enforcement_note": "Kollo Health (2023) was ruled against by ASA for health claims for a collagen supplement none of which were authorised on the GB NHC Register." }

EXAMPLE 8 — GREENWASHING (violation):
Content: "Our packaging is 100% sustainable."
{ "regulation": "CAP Code 3.1 / DMCCA 2024", "severity": "high", "issue": "'100% sustainable' is an absolute environmental claim with no specified basis, scope, or evidence. The CMA can act on misleading environmental claims on reasonable suspicion alone — no court order required.", "location": "Product claim", "recommendation": "Specify precisely what is sustainable (material type, percentage recycled content, certification body) and hold evidence before the campaign runs. Replace '100% sustainable' with a specific, verifiable claim." }

EXAMPLE 9 — REFERENCE PRICING (violation):
Content: "WAS £200. NOW £49.99. Save 75%!" [product has only ever sold at £49.99]
{ "regulation": "CMA CPRs Reg 5 / CAP Code 3.1", "severity": "critical", "issue": "'Was' price of £200 appears fabricated. If product has not genuinely sold at £200 for a meaningful period, this is a misleading price indication.", "location": "Pricing headline", "recommendation": "'Was' price must reflect genuine previous selling price for a minimum of 28 days. If you cannot evidence the higher price, remove the reference pricing.", "enforcement_note": "Simba Sleep (CMA, 2024) gave formal undertakings for using inflated 'was' prices and inaccurate countdown timers." }

EXAMPLE 10 — B2B COMPARATIVE CLAIM (violation):
Content: "Our platform is 3x cheaper than Salesforce."
{ "regulation": "BPRs 2008 / CAP Code 3.11", "severity": "high", "issue": "Comparative claim names a competitor ('Salesforce') without specifying which product tier, which features are being compared, or the date of the comparison. Under the BPRs, B2B comparative advertising must compare material, verifiable, representative features on a like-for-like basis.", "location": "Headline claim", "recommendation": "Specify the comparison precisely: 'Our Starter plan is 3x cheaper than Salesforce Essentials for solo users — based on published list prices, May 2026.' Hold evidence on file before the campaign runs." }

EXAMPLE 11 — PUFFERY (NOT a violation):
Content: "The UK's most loved coffee brand."
Not a violation. Acceptable puffery under CAP 3.3. No reasonable person interprets "most loved" as a verifiable factual claim.

EXAMPLE 12 — AUTHORISED HEALTH CLAIM (NOT a violation):
Content: "Vitamin D contributes to the normal function of the immune system."
Not a violation. Authorised health claim for Vitamin D on the GB Nutrition and Health Claims Register.

EXAMPLE 13 — STANDARD URGENCY WITH SPECIFIC DATE (NOT a violation):
Content: "Sale ends midnight Sunday 16 March 2026."
Not a violation. Specific end date given. Acceptable under CAP 3.7 provided the sale genuinely ends at the stated time.

EXAMPLE 14 — B2B COMPARATIVE CLAIM WITH DISCLOSED BASIS (NOT a violation):
Content: "43% faster report generation than Excel — based on our internal benchmark study of 50 finance teams, Q1 2026."
Not a violation provided the study exists and is held on file before the campaign runs (CAP 4.1). The claim is specific, the basis is disclosed. Do not flag — flag only if the evidence basis is entirely absent.

EXAMPLE 15 — PROPERLY DISCLOSED INFLUENCER CONTENT (NOT a violation):
Content: "#ad Obsessed with my new @BrandName moisturiser — my skin has genuinely never looked better!" [#ad is the first word]
Not a violation. #ad disclosed clearly at the start of the post. Personal opinion, not a verifiable health claim. CAP 2.1 satisfied.

EXAMPLE 16 — SOFT OPT-IN CORRECTLY APPLIED (NOT a violation):
Content: "[On checkout page, immediately after purchase, unticked checkbox:] We'd like to send you offers on similar products by email. Tick here if you'd prefer not to receive these." [Identical opt-out in every subsequent email]
Not a violation. Correctly applies PECR Reg 22(3) soft opt-in: contact details collected during purchase, similar products, genuine opt-out at point of collection and in every message.

EXAMPLE 17 — TESTIMONIAL CORRECTLY DISCLOSED (NOT a violation):
Content: "[Five stars] 'I've been using this for 6 months and my back pain has genuinely improved.' — Sarah T, verified purchaser. Individual results may vary."
Not a violation provided: the review is genuine and documentary evidence is held on file; 'results may vary' is present and prominent; the claim is personal experience not a medical claim.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 10 — SEVERITY CALIBRATION & VERDICT LABELS

SEVERITY:
critical: Enforcement action likely if discovered. Examples: sending without PECR consent, broken consent chain, fake urgency (banned practice), false health claims, fabricated reference prices, pre-ticked consent, no unsubscribe, third-party list without specific consent, fake reviews.
high: Clear rule breach. Likely to result in ASA ruling or ICO investigation. Examples: 'free' without disclosing conditions, unsubstantiated comparative claims, vague deadline without date, undisclosed influencer content, bundled consent, greenwashing without evidence basis.
medium: Probable rule breach. Less immediately enforceable. Examples: missing privacy policy link, vague testimonials, 'limited stock' without evidence, missing T&C link.
low: Best practice gap. Not a clear rule breach. Examples: small print legibility, complex opt-out process.

VERDICT LABELS (use exact strings):
Score 90–100, zero critical or high: "No issues found"
Score 75–89, zero critical: "Minor issues to address"
Score 50–74, zero critical: "Review required before sending"
Score 25–49, OR any critical issue: "Do not send — address critical issues first"
Score 0–24: "Significant violations identified"

RISK SCORE: Start at 100. Critical: deduct 25–35. High: deduct 10–20. Medium: deduct 5–10. Low: deduct 1–5. Multiple of same type: deduct once. Minimum 0.

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
      "enforcement_note": "Only include when you know a real, virtually identical case. Omit entirely if uncertain."
    }
  ],
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION HERE",
  "summary": "One sentence plain English assessment."
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL CONTEXT — injected per request
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_RULES = {
  email: `CHANNEL: EMAIL
Apply: PECR Reg 22 (consent / soft opt-in), Reg 23 (sender identity), UK GDPR, ASA CAP Code, CMA/DMCCA CPRs.
Check: unsubscribe mechanism, postal address, sender identification, consent signals, all CAP Code and DMCCA red flags.`,

  sms: `CHANNEL: SMS
Apply: PECR Reg 22 (consent — stricter than email), ASA CAP Code for promotional content.
Additional SMS-specific checks:
• Is there a STOP opt-out keyword? (e.g. "Reply STOP to opt out") — mandatory.
• Does the message exceed 160 characters? Flag if so — note the character count.
• Is the sender identity clear from the opening words?
• No HTML — plain text only.
UK GDPR applies to any data processing referenced.`,

  push: `CHANNEL: PUSH NOTIFICATION
Apply: PECR Reg 22 (consent required for push notifications), ASA CAP Code for promotional claims.
Check: whether consent for push was likely obtained at app install, claim accuracy, urgency/scarcity language.`,

  social: `CHANNEL: SOCIAL AD / SOCIAL POST
Apply: ASA CAP Code (primary), CMA/DMCCA CPRs.
DO NOT apply PECR Reg 22 consent rules — these do not apply to social ads directed at audiences.
Check: #ad disclosure where required, misleading claims, fake urgency/scarcity, reference pricing, testimonials, greenwashing, age-restricted products.`,

  directmail: `CHANNEL: DIRECT MAIL (physical post)
Apply: UK GDPR (legitimate interests most common basis — full LI balance test required), ASA CAP Code, CMA/DMCCA CPRs.
DO NOT apply PECR Reg 22 — PECR applies to electronic communications only.
Check: LI basis validity, misleading claims, reference pricing, urgency/scarcity, opt-out mechanism (MPS reference is best practice), sender identification.`
};

// ─────────────────────────────────────────────────────────────────────────────
// SENDING CONTEXT BUILDER
// Serialises the 4 UI questions into a structured [SENDING CONTEXT] block.
// ─────────────────────────────────────────────────────────────────────────────

function buildSendingContextBlock(ctx) {
  if (!ctx) return '';

  const lines = ['[SENDING CONTEXT]'];

  const senderMap = {
    direct:     'We are sending directly',
    thirdParty: 'A third-party agency or platform is sending on our behalf',
  };
  const listMap = {
    direct:    'We collected it directly from our own customers',
    purchased: 'Purchased or rented from a third party',
    partner:   'Provided by a partner or affiliate',
    mixed:     'Mixed sources',
  };
  const consentMap = {
    specific:    'Recipients specifically consented to our organisation by name',
    thirdParty:  'They consented to a third party or "our partners" — not this organisation by name',
    softOptIn:   'Soft opt-in — existing customers, similar products',
    notSure:     'Not sure',
  };
  const fromMap = {
    yes:     'Yes — From name matches the organisation that collected consent',
    no:      'No — different sender',
    notSure: 'Not sure',
  };

  if (ctx.senderRelationship) lines.push(`Sender: ${senderMap[ctx.senderRelationship] || ctx.senderRelationship}`);
  if (ctx.listSource)         lines.push(`List source: ${listMap[ctx.listSource] || ctx.listSource}`);
  if (ctx.consentSpecificity) lines.push(`Consent: ${consentMap[ctx.consentSpecificity] || ctx.consentSpecificity}`);
  if (ctx.fromNameMatch)      lines.push(`From name match: ${fromMap[ctx.fromNameMatch] || ctx.fromNameMatch}`);

  lines.push('[END CONTEXT]');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT FIX GENERATOR
// Generates Tier 1 fix records directly from Sending Context answers.
// These are deterministic — not AI-dependent. They run before the AI call
// and are merged with AI-generated violations before the response is returned.
// ─────────────────────────────────────────────────────────────────────────────

function getContextViolations(ctx) {
  if (!ctx) return [];
  const violations = [];

  // Purchased or rented list
  if (ctx.listSource === 'purchased') {
    violations.push({
      regulation: 'PECR Reg 22',
      severity:   'critical',
      issue:      'List purchased or rented from a third party. Recipients must have specifically consented to receive marketing from your organisation by name — not just a generic third-party consent or a list of unnamed "partners".',
      location:   'Sending context — list source',
      recommendation: 'Do not send to this list until you can verify that every recipient specifically and knowingly consented to hear from your organisation. Obtain consent directly.',
      enforcement_note: 'ZMLUK (£105,000, December 2025) sent 67.8 million emails using purchased data. The ICO found that generic consent covering hundreds of unnamed companies is not valid consent under PECR.',
      _fixType: 'third_party_list',
      _fromContext: true,
    });
  }

  // Partner or affiliate list
  if (ctx.listSource === 'partner') {
    violations.push({
      regulation: 'PECR Reg 22',
      severity:   'critical',
      issue:      'List provided by a partner or affiliate — indirect consent. The ICO\'s direct marketing guidance states that indirect consent is insufficient for email or SMS marketing.',
      location:   'Sending context — list source',
      recommendation: 'Each organisation sending marketing must have consent obtained specifically for their own communications. Relying on a partner\'s collected consent is not valid.',
      enforcement_note: 'Saga Services & Saga Personal Finance (£225,000 combined, 2021) were fined for relying on indirect consent collected by affiliates sending emails on their behalf.',
      _fixType: 'invalid_consent_mechanism',
      _fromContext: true,
    });
  }

  // Consent to third party / "our partners" — not this organisation by name
  if (ctx.consentSpecificity === 'thirdParty') {
    violations.push({
      regulation: 'PECR Reg 22 / UK GDPR Article 7',
      severity:   'critical',
      issue:      'Recipients consented to a third party or "our partners" — not to your organisation by name. Third-party consent must specifically identify the organisation sending the marketing.',
      location:   'Sending context — consent specificity',
      recommendation: 'Stop sending to this list. Consent must specifically name your organisation. "Our partners" covering multiple companies is not valid consent for any individual company in that list.',
      enforcement_note: 'ZMLUK (£105,000, 2025): consent collected on a site showing users a list of 361 partner companies was invalid. Join the Triboo (£130,000, 2023): consent to JTT did not cover unnamed third-party brands they sent marketing for.',
      _fixType: 'invalid_consent_mechanism',
      _fromContext: true,
    });
  }

  // Consent not sure
  if (ctx.consentSpecificity === 'notSure') {
    violations.push({
      regulation: 'PECR Reg 22',
      severity:   'high',
      issue:      'Consent basis is unclear. You should not send marketing unless you can confirm recipients specifically consented to your organisation. If you are unsure, assume consent is not valid.',
      location:   'Sending context — consent specificity',
      recommendation: 'Verify your consent records before sending. If you cannot confirm valid consent, do not send.',
      _fixType: 'invalid_consent_mechanism',
      _fromContext: true,
    });
  }

  // Third-party agency sending + From name does not match
  if (ctx.senderRelationship === 'thirdParty' && ctx.fromNameMatch === 'no') {
    violations.push({
      regulation: 'PECR Reg 23',
      severity:   'critical',
      issue:      'A third-party agency is sending on your behalf and the From name does not match the organisation that collected consent. The sender\'s identity is effectively concealed from recipients.',
      location:   'Sending context — sender relationship and From name mismatch',
      recommendation: 'The From name must clearly identify the brand that collected consent — not the sending agency. Ensure your brand name is the primary identifier in the From field.',
      enforcement_note: 'Join the Triboo (£130,000, 2023) sent emails appearing to come from third-party brands with only a small JTT disclaimer. The ICO requires the identity of the actual sending organisation to be clear.',
      _fixType: 'concealed_sender',
      _fromContext: true,
    });
  }

  // From name mismatch (even if not third-party agency)
  if (ctx.fromNameMatch === 'no' && ctx.senderRelationship !== 'thirdParty') {
    violations.push({
      regulation: 'PECR Reg 23',
      severity:   'high',
      issue:      'The From name does not match the organisation that collected consent. Recipients may not recognise who is contacting them.',
      location:   'Sending context — From name mismatch',
      recommendation: 'Ensure the From name clearly identifies the organisation that collected the recipient\'s consent.',
      _fixType: 'concealed_sender',
      _fromContext: true,
    });
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX TYPE MAP
// ─────────────────────────────────────────────────────────────────────────────

function mapViolationToFixType(violation) {
  // Context violations carry their fix type directly
  if (violation._fixType) return violation._fixType;

  const issue    = (violation.issue          || '').toLowerCase();
  const reg      = (violation.regulation     || '').toLowerCase();
  const rec      = (violation.recommendation || '').toLowerCase();
  const combined = `${issue} ${reg} ${rec}`;

  if (combined.match(/unsubscribe|opt.out|opt out/))                               return 'missing_unsubscribe';
  if (combined.match(/no consent|without consent|unsolicited|pecr.*consent|reg 22/)) return 'no_consent';
  if (combined.match(/pre.tick|pre tick|assumed consent|bundled consent/))          return 'invalid_consent_mechanism';
  if (combined.match(/soft opt.in|soft optin/))                                     return 'no_soft_optin';
  if (combined.match(/sender.*conceal|disguised.*sender|sender.*identity|reg 23/))  return 'concealed_sender';
  if (combined.match(/fake urgency|false urgency|countdown.*reset|ends soon|ends tonight|today only|flash sale/)) return 'fake_urgency';
  if (combined.match(/fake scarcity|false scarcity|only \d+ left|stock.*fabricat/)) return 'fake_scarcity';
  if (combined.match(/reference pric|was.*now|fabricated.*price|inflated.*price/))  return 'misleading_reference_price';
  if (combined.match(/free.*condition|free.*hidden|free.*subscription|cap.*3\.9/))  return 'misleading_free_claim';
  if (combined.match(/health claim|medical claim|cure|treats.*condition|mhra/))     return 'unauthorised_health_claim';
  if (combined.match(/testimonial|review.*fabricat|fake review|incentivi.*review|duplicate.*review/)) return 'misleading_testimonial';
  if (combined.match(/influencer|#ad|advertorial|paid.*partner|sponsored.*not.*label/)) return 'undisclosed_ad';
  if (combined.match(/comparative.*claim|cheaper than|vs.*competitor|bpr/))         return 'unsubstantiated_comparative_claim';
  if (combined.match(/drip pric|hidden fee|mandatory.*charge.*not.*shown/))         return 'drip_pricing';
  if (combined.match(/greenwash|sustainable|eco.friendly|carbon neutral|net zero/)) return 'misleading_claim';
  if (combined.match(/privacy policy|data protection link/))                        return 'no_privacy_policy';
  if (combined.match(/postal address|company address|registered address/))          return 'missing_address';
  if (combined.match(/third.party.*list|bought.*list|purchased.*data/))             return 'third_party_list';
  if (combined.match(/indirect consent|partner.*consent/))                          return 'invalid_consent_mechanism';

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
// CONTENT HASH — for deduplication
// ─────────────────────────────────────────────────────────────────────────────

function contentHash(userId, contentType, content) {
  return crypto
    .createHash('sha256')
    .update(`${userId}|${contentType}|${content}`)
    .digest('hex')
    .slice(0, 16);
}


// ─────────────────────────────────────────────────────────────────────────────
// GENERATE FIXES — writes to Compliance_Fixes via generate-fix.js
// ─────────────────────────────────────────────────────────────────────────────

async function generateFixes(userId, allViolations, emailChecks, sourceRecordId) {
  const seenTypes = new Set();
  const fixJobs   = [];

  // Context and AI violations
  for (const v of (allViolations || [])) {
    const fixType = mapViolationToFixType(v);
    if (seenTypes.has(fixType)) continue;
    seenTypes.add(fixType);
    const source = v._fromContext ? 'Sending Context' : 'AI Checker';
    fixJobs.push({
      fixType,
      description: `${source}: ${v.issue || 'Compliance issue'} (${v.location || 'content'}) — ${v.recommendation || 'Review required'}`,
      severity: mapViolationToSeverity(v)
    });
  }

  // Email scanner violations
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
    const { contentType, content, subject, userId, autoFix, sendingContext, images } = req.body ?? {};

    // ── Validation ────────────────────────────────────────────────────
    if (!userId)      return res.status(400).json({ error: 'Missing userId' });
    if (!contentType) return res.status(400).json({ error: 'Missing contentType' });
    if (!['email','sms','push','social','directmail'].includes(contentType))
      return res.status(400).json({ error: 'contentType must be email | sms | push | social | directmail' });
    if (!content) return res.status(400).json({ error: 'Missing content' });

    // ── 1. Content deduplication hash ─────────────────────────────────
    const checkHash = contentHash(userId, contentType, content);

    // ── 2. Deterministic context violations ───────────────────────────
    const contextViolations = getContextViolations(sendingContext);

    // ── 4. Build analysis content for Claude ──────────────────────────
    const copyText = contentType === 'email' && subject
      ? `Subject: ${subject}\n\nEmail body:\n${content}`
      : content;

    const contextBlock = buildSendingContextBlock(sendingContext);
    const analysisContent = contextBlock
      ? `${contextBlock}\n\n[COPY TO ANALYSE]\n${copyText}`
      : copyText;

    // ── 5. Claude AI analysis ─────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userMessage = `${CHANNEL_RULES[contentType]}

CONTENT TO ANALYSE:
${analysisContent}
${autoFix ? '\nGenerate a fixedVersion field in the JSON with a fully rewritten compliant version.' : ''}`;

    // Build content array — text first, then images if provided
    const messageContent = [{ type: 'text', text: userMessage }];
    const validMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (Array.isArray(images) && images.length > 0) {
      const imageBlocks = images
        .slice(0, 3) // max 3 images
        .filter(img => img?.data && validMediaTypes.includes(img?.mediaType))
        .map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data }
        }));
      messageContent.push(...imageBlocks);
      if (imageBlocks.length > 0) {
        messageContent.push({ type: 'text', text: `\nNote: ${imageBlocks.length} image(s) provided above. Analyse them for compliance issues alongside the copy — check for misleading visuals, fake urgency in graphics, undisclosed ads, health claims in imagery, or any visual element that contradicts or adds to the compliance picture.` });
      }
    }

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: messageContent }]
    });

    let aiAnalysis = null;
    try {
      const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
      aiAnalysis = JSON.parse(jsonMatch ? jsonMatch[0] : message.content[0].text);
    } catch {
      aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: message.content[0].text };
    }

    // ── 6. Merge context violations with AI violations ─────────────────
    // Context violations take priority (they're deterministic) — deduplicate
    // by fixType so AI doesn't double-flag what context already caught.
    const contextFixTypes = new Set(contextViolations.map(v => v._fixType));
    const aiViolations    = (aiAnalysis?.violations || []).filter(v => {
      const ft = mapViolationToFixType(v);
      return !contextFixTypes.has(ft);
    });
    const allViolations = [...contextViolations, ...aiViolations];

    // Recalculate score if context added violations
    let finalScore = aiAnalysis?.score ?? 50;
    for (const v of contextViolations) {
      const sev = v.severity;
      if (sev === 'critical') finalScore -= 30;
      else if (sev === 'high') finalScore -= 15;
      else if (sev === 'medium') finalScore -= 7;
    }
    finalScore = Math.max(0, finalScore);

    // Recalculate verdict if score changed
    let finalVerdict = aiAnalysis?.verdict;
    if (contextViolations.length > 0) {
      const hasCritical = allViolations.some(v => v.severity === 'critical');
      if (hasCritical || finalScore <= 49)       finalVerdict = 'Do not send — address critical issues first';
      else if (finalScore <= 74)                 finalVerdict = 'Review required before sending';
      else if (finalScore <= 89)                 finalVerdict = 'Minor issues to address';
      else                                       finalVerdict = 'No issues found';
    }

    // ── 7. Save to AI_Compliance_Checks ───────────────────────────────
    let savedRecordId = null;
    try {
      const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
      const BASE_ID        = process.env.BASE_ID;
      const criticalCount  = allViolations.filter(v => v.severity === 'critical').length;
      const warningCount   = allViolations.filter(v => v.severity === 'high' || v.severity === 'medium').length;

      const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:         userId,
              CheckDate:      new Date().toISOString().split('T')[0],
              ContentType:    contentType,
              ContentHash:    checkHash,
              RiskScore:      finalScore,
              Verdict:        finalVerdict ?? '',
              CriticalIssues: criticalCount,
              Warnings:       warningCount,
              MarketingCopy:  content?.slice(0, 10000) ?? '',
              FileName:       contentType === 'email' ? `Email: ${subject || '(no subject)'}` : `${contentType} scan`,
              Analysis:       JSON.stringify({ violations: allViolations, summary: aiAnalysis?.summary ?? '' }),
              FixedVersion:   aiAnalysis?.fixedVersion ?? '',
              RelatedCases:   '',
              SendingContext: contextBlock || '',
            }
          }]
        })
      });

      if (saveRes.ok) {
        const saved = await saveRes.json();
        savedRecordId = saved.records?.[0]?.id ?? null;
      } else {
        console.error('AI_Compliance_Checks save failed:', saveRes.status);
      }
    } catch (err) {
      console.error('AI_Compliance_Checks save error:', err);
    }

    // ── 8. Generate Compliance_Fixes — must complete BEFORE response ──
    // On Vercel Hobby, async work after res.json() is killed immediately.
    if (allViolations.length > 0) {
      try {
        await generateFixes(userId, allViolations, [], savedRecordId);
      } catch (e) {
        console.error('generateFixes error:', e);
      }
    }

    // ── 9. Update compliance streak (fire and forget — low priority) ──
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    // ── 10. Return unified response ────────────────────────────────────
    // Strip internal _fromContext / _fixType fields before returning
    const cleanViolations = allViolations.map(({ _fromContext, _fixType, ...rest }) => rest);

    return res.status(200).json({
      ...aiAnalysis,
      score:      finalScore,
      verdict:    finalVerdict,
      violations: cleanViolations,
      contentType,
      checkHash,

    });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
