// analyze-copy.js
// Unified marketing compliance checker.
// MODE A — Email scan:    POST { subject, html, userId, autoFix? }
// MODE B — Copy check:    POST { content, userId, autoFix? }
// MODE C — Combined:      POST { content, subject, html, userId, autoFix? }
//
// Runs deterministic PECR/deliverability checks (from email scanner) and
// deep AI analysis (CAP Code, CMA, GDPR) then generates Compliance_Fixes
// via generate-fix.js for any violations found.

import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — full Sendwize framework (Sections 1–11)
// This goes into the `system` field of every Anthropic API call.
// To update: edit the sections below and redeploy.
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
1. Identify every genuine compliance violation across PECR, UK GDPR, ASA CAP Code, and CMA rules.
2. For each violation: cite the exact rule, explain the issue in plain English, locate it precisely in the content, and give a specific actionable fix.
3. Assign a risk score (0–100) where 100 = no issues found.
4. Assign a verdict using the exact labels specified in Section 10.
5. Calibrate severity using the exact definitions specified in Section 10.
6. Generate a fully rewritten compliant version with every issue fixed.

Be thorough. Cite exact rule numbers. Do not flag issues that are not genuine violations. Do not miss issues that are.

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
Sent 79.8 million marketing emails and 1.1 million marketing texts over 6 months without valid consent. The opt-in statement bundled age confirmation with marketing consent ("By ticking this box I confirm I am over 18"), did not mention SMS as a channel, and failed to tell customers their data would be used for marketing for up to 24 months after cancelling. The ICO also found HelloFresh was slow or failed to act on opt-out requests.

[JOIN THE TRIBOO LTD (JTT) — £130,000 — 2023 — PECR Reg 22]
Sent over 107 million unsolicited marketing emails to 437,000 individuals over 12 months by "hosting" marketing for third-party companies — including claims management, insurance, and utility firms — using its own distribution list. Consent was invalid because it was not specific: individuals had consented to receive emails from JTT but not from the unnamed third-party brands whose messages were then sent. Emails appeared to come from the third party, with only a small JTT disclaimer in the footer.

[EXPERIAN LTD — Enforcement notice (no monetary fine) — 2020 — GDPR / DPA 2018]
Following a 2-year audit of the direct marketing data brokerage sector, the ICO found Experian was conducting "invisible processing" — repurposing credit reference data on ~51 million UK individuals to build marketing profiles and sell them to third-party advertisers, without those individuals' knowledge or meaningful transparency. Experian was ordered to issue GDPR Art. 14 privacy notices and stop processing consent-based data under legitimate interests. Experian appealed; a 2023 tribunal largely sided with Experian on the LI question but upheld parts of the notice.

[OUTSOURCE STRATEGIES LTD & DR TELEMARKETING LTD — £340,000 combined — 2024 — PECR Reg 21]
Made approximately 1.43 million unsolicited marketing calls to people registered on the TPS between February 2021 and March 2022. The ICO found both companies deliberately targeted elderly and vulnerable people with high-pressure sales tactics. Evidence emerged that people had repeatedly asked to be removed but continued to be contacted. Outsource Strategies attempted to relaunch under a different name to evade enforcement.

[POXELL LTD — £150,000 — 2024 — PECR Reg 21]
Made over 2.6 million unsolicited marketing calls between March and July 2022 to individuals registered with the TPS, generating 413 complaints. Callers were aggressive and persistent — some recipients were people with dementia or serious illness. Poxell purchased multiple telephone lines to rotate caller IDs and avoid detection, treated as an aggravating factor.

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
A listing showed 'FROM £279 / Was £399 [strikethrough] / Save up to 30%' with a countdown timer. Once the timer hit zero it simply reset for four more days at the same price — the product never reverted to £399. The ASA rejected Wowcher's argument that the timer only guaranteed the deal price, not that the price would change. The visual combination of a crossed-out 'was' price and a countdown clock created an unavoidable impression of a time-limited saving. Wowcher argued the countdown had been seen ~50 million times with a low complaint rate. The ASA does not accept complaint volume as evidence of compliance.
Key takeaway: Intent is irrelevant. If a countdown timer appears alongside a 'was/now' price comparison, consumers will read it as meaning the discount expires when the timer does.

[CLUEDUPP GAMES (UPPHOLDINGS LTD) — ASA ruling, 22 November 2023 — Upheld — CAP Code 3.1 and 3.30]
A product page displayed 'Only 14 tickets remaining' alongside a partially advanced status bar. In reality only 6 tickets had been sold from an inventory of 50 — meaning 88% of availability remained. The event page had been incorrectly set to display a maximum inventory of 20 at launch, and the inventory tracker stopped working after a website migration. CluedUpp argued it was a technical error. The ASA did not accept this — the effect on consumers is what matters, not the intent.
Key takeaway: False scarcity is treated the same as false urgency. A technical error is not a defence.

[HAMMONDS FURNITURE LTD — ASA ruling, 8 October 2025 — Upheld — CAP Code 3.1 and 8.17]
'Up to 40% off selected finishes + an extra 5% offer ends in [countdown]' was presented in a single continuous sentence. The timer only applied to the extra 5%, which expired 26 May 2025 — the 40% off ran until 2 June 2025. Nothing in the ad signalled this distinction.
Key takeaway: A countdown timer applies — in the consumer's eyes — to everything presented alongside it. If only part of a promotion is genuinely time-limited, that must be made unmistakably clear through distinct visual separation.

[UK FLOORING DIRECT LTD — ASA ruling, 3 August 2022 — Upheld — CAP Code 3.1, 3.7 and 8.17.4.e]
'Up to 60% off, plus Extra 10% off' appeared alongside a countdown timer. A rival retailer challenged whether the promotion was genuinely time-limited. UK Flooring Direct asserted their promotions had clear start and end dates but provided no documentary evidence — no pricing history, no records showing the discount code was deactivated.
Key takeaway: A countdown timer creates a legal obligation to retain evidence that the promotion genuinely ended when stated.

ASA RULING EXAMPLES — FREE CLAIMS:

[PLANETART UK LTD (t/a FreePrints) — ASA ruling, 3 August 2022 — Upheld — CAP Code 3.1 and 3.22]
The FreePrints app stated 'FREE PHOTO PRINTS DELIVERED TO YOUR DOOR' and 'No Subscriptions. No Commitments. Just Free Prints!' Every order carried a mandatory delivery charge of £1.49–£3.99. PlanetArt could not demonstrate that delivery charges reflected only the unavoidable cost of postage. PlanetArt argued 'FreePrints' was a registered trademark, not a descriptive claim — the ASA rejected this. A disclaimer in a preceding ad did not qualify the misleading claim inside the destination.
Key takeaway: 'Free' means free. If any mandatory charge applies, the claim is misleading unless the charge represents only the genuine, unavoidable cost of postage.

[NOW TV (SKY UK LTD t/a NOW) — ASA ruling, 25 September 2024 — Upheld — CAP Code 3.1, 3.9 and 3.10]
A membership page offered '7 day free trial of Cinema and Boost — cancel anytime.' The Cinema and Boost free trials were automatically added to the basket and set to auto-renew at £9.99/month and £6/month after the trial unless actively cancelled. Auto-renew terms appeared in small text beneath the plan description — not sufficiently prominent relative to the headline 'free trial' claim. This ruling formed part of the ASA's wider work on Online Choice Architecture.
Key takeaway: A 'free trial' claim is misleading if the paid subscription that follows is not made equally clear and prominent.

[BEER52 LTD (t/a Wine52) — ASA ruling, 2024 — Upheld — CAP Code 8.2 and 8.17]
Two marketing emails promoted a 'free case of wine' for referring friends. The referred friend had to pay to take out a subscription — and in one case remain subscribed long enough to receive their second case — before the sender qualified. Neither condition was mentioned in the emails. The ASA rejected the argument that linking to T&Cs separately was sufficient — emails have no space constraints.
Key takeaway: 'Free' referral rewards with hidden subscription conditions are misleading if those conditions aren't in the email itself.

ASA RULING EXAMPLES — TESTIMONIALS & REVIEWS:

[TONIC HEALTH (TONIC NUTRITION LTD) — ASA ruling, 16 July 2025 — Upheld — CAP Code 3.1 and 3.45]
Identical review wording appeared twice on the product page attributed to two different customer names, creating a false impression of more independent positive feedback than existed. Tonic Health attributed it to a technical error, but duplicated reviews were still appearing in January 2025, two months after first notification.
Key takeaway: Reviews don't have to be invented to be non-compliant. Duplicated reviews — even caused by a technical glitch — misrepresent the volume and independence of feedback.

[OFFICIAL IPHONE UNLOCK LTD (t/a cellunlocker.co.uk) — ASA ruling, 19 September 2018 — Upheld — CAP Code 3.45]
A post-purchase email stated: 'Please click here to Review our Service! As a thankyou we will refund £3 back to your card if you leave a nice review!' — the word 'nice' made the incentive explicitly conditional on the sentiment. No indication was given on the website that the testimonials had been paid for or incentivised.
Key takeaway: Incentivising positive reviews is always a violation. Reviews displayed without disclosure of the incentive are misleading.

[CANDY COAT LTD — ASA ruling, 24 April 2019 — Upheld — CAP Code 3.1 and 3.45]
A product page showed '21 reviews' alongside a five-star rating, with only positive four and five-star reviews displayed. Negative reviews submitted by customers were not appearing. Candy Coat could not explain how the star rating had been calculated, or why negative reviews had not been published.
Key takeaway: Selectively publishing positive reviews while suppressing negative ones is misleading. A star rating is only valid if it reflects all submitted reviews. Under DMCCA 2024 (in force April 2025), this practice is now explicitly prohibited by law.

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
• Reference pricing — 'was £100, now £49' where the 'was' price is fabricated. The item must have genuinely sold at the higher price for a meaningful period.

Reg 6 — Misleading omissions:
• Omitting material information a consumer needs to make an informed decision.
• Drip pricing — revealing mandatory charges progressively is a violation. All mandatory costs must be shown upfront.

Reg 7 — Aggressive practices:
• Harassment, coercion, or undue influence in sales.
• Exploiting a specific misfortune or vulnerability.

Subscription traps:
• Free trial terms that auto-convert must be clearly disclosed upfront.
• Cancellation must be as easy as sign-up.

Fake reviews (CMA priority from 2024):
• Commissioning fake reviews is illegal.
• Suppressing genuine negative reviews is illegal.
• Incentivising reviews without disclosure is misleading.

CMA ENFORCEMENT CASES:

[AMAZON — Undertaking, June 2025]
Failed to adequately detect, remove, or sanction fake reviews on its marketplace. Also investigated for 'catalogue abuse' — sellers hijacking reviews from high-performing products to falsely boost unrelated listings. Signed formal undertakings to enhance fake review detection systems, introduce sanctions for offending sellers (including bans), and address catalogue abuse. Investigation opened June 2021.

[GOOGLE — Undertaking, January 2025]
Insufficient processes to detect and tackle fake reviews written about UK businesses and services on Google Search and Maps. Concerns about failure to sanction repeat offenders. Signed undertakings to implement enhanced fake review processes and sanction businesses/reviewers who manipulate star ratings.

[WOWCHER — Undertaking, August 2024]
Fake countdown timers and urgency claims ('Running out!', 'In high demand!') pressuring consumers into quick purchases. Also enrolled customers in a paid VIP membership via a pre-ticked box without their clear understanding. Signed undertakings to fix timers and claims. Refunded over 870,000 customers (~£4m in credits, with cash-out option).

[SIMBA SLEEP — Undertaking, July 2024]
Misleading 'was/now' reference pricing — using inflated original prices and inaccurate countdown clocks to create a false sense of urgency and discount. ASA had separately upheld complaints on the same issue. Committed to genuine 'was' prices (must have sold sufficient volume at that price), clear countdown clocks, and a 6-month compliance report to the CMA.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 7 — SECTOR-SPECIFIC RULES

Apply these additional rules based on the sector context identified in the content:

FINANCIAL SERVICES:
• FCA-regulated. Financial promotions require FCA approval or approval by an authorised firm (s.21 FSMA 2000).
• Risk warnings mandatory: 'Capital at risk', 'Your home may be repossessed'.
• Past performance warnings required for investment products.
• 'Representative APR' must be shown when quoting credit costs.
• Claims about returns must be balanced — cannot only show best-case scenarios.

HEALTH & SUPPLEMENT PRODUCTS:
• Only authorised health claims permitted (UK retained version of EU register).
• 'Treats', 'cures', 'prevents' = medical claim = MHRA authorisation required.
• Before/after images must be representative and accurately labelled.
• Weight loss claims: must not imply an unsafe rate of weight loss.

FOOD & DRINK:
• Nutrition and health claims: EU/UK Nutrition and Health Claims Regulation.
• 'Natural', 'organic', 'free-range' have specific legal definitions.
• Country of origin labelling requirements.
• Alcohol: must not glamourise excessive drinking, not appeal to under-18s.

GAMBLING:
• Must include problem gambling message and Gamble Aware branding.
• 'Free bet' terms must be clearly disclosed upfront.
• Cannot target vulnerable people or those who have self-excluded.
• Celebrities popular with under-18s cannot appear in gambling ads.

PROPERTY:
• Price claims must reflect actual asking price.
• 'Sold subject to contract' properties cannot be marketed as sold.
• Energy efficiency claims must reference EPC rating.

E-COMMERCE / RETAIL:
• Reference pricing — 'was' prices must reflect genuine previous selling price for a meaningful period (minimum 28 days recommended).
• Delivery costs must be shown upfront.
• Returns policy must be clear and meet Consumer Rights Act 2015.

B2B MARKETING:
• CAP Code applies to B2B marketing.
• PECR soft opt-in rules differ for corporate vs individual subscriber addresses (sole traders, partnerships still protected).
• B2B claims about ROI, efficiency savings, etc. still require substantiation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 8 — RED FLAGS — ALWAYS CHECK

Regardless of content type, always check for these patterns:

URGENCY & SCARCITY:
• Countdown timers — are they genuine deadlines or do they reset?
• 'Only X left' — can this be verified? Banned practice if fabricated.
• 'Ends tonight/today/soon' without a specific date — CAP 3.7 violation.
• 'Limited edition' — must actually be limited.

PRICING:
• 'Was/Now' pricing — was price must be genuine, held for meaningful period.
• 'From £X' — lowest price must be the lead price, conditions clear.
• Hidden fees revealed later in purchase journey — drip pricing violation.
• 'Free' with hidden conditions — CAP 3.9 violation.
• Subscription terms buried or unclear — CMA subscription trap risk.

CLAIMS:
• Superlatives without evidence — 'best', 'leading', 'most effective' (unless obviously puffery).
• Before/after images — must be representative, not cherry-picked.
• Statistics without source — '9 out of 10 dentists' needs a cited study.
• 'Up to X% off' — majority of items must be at maximum discount.
• Health claims without substantiation — even vague ones need evidence.
• Comparative claims without verifiable evidence.

CONSENT & DATA:
• Pre-ticked boxes or assumed consent — UK GDPR Article 7 violation.
• 'By using this service you consent to marketing' — not valid consent.
• Bundled consent — marketing consent mixed with T&Cs.
• Consent for 'our partners' without naming them — not specific enough.
• No privacy policy link when collecting data.

IDENTITY & TRANSPARENCY:
• Influencer/affiliate content without #ad disclosure.
• 'Advertorial' or 'native ad' not clearly labelled.
• Fake or undisclosed reviews — CMA banned practice.
• Astroturfing — brand employees posting as consumers.
• Sender name that obscures who is actually sending.

VULNERABLE AUDIENCES:
• Content that could reach children — apply higher standard.
• Exploitation of financial difficulty, grief, or health anxiety.
• High-pressure sales language targeting elderly or vulnerable people.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 9 — FEW-SHOT EXAMPLES

Learn from these examples when analysing content:

EXAMPLE 1 — FAKE URGENCY (violation):
Content: "FLASH SALE — 50% OFF EVERYTHING! Offer ends tonight."
Correct output:
{
  "regulation": "CAP Code 3.7 / CMA CPR Schedule 1",
  "severity": "high",
  "issue": "Urgency claim uses vague deadline 'ends tonight' without specific date or time. If this offer resets, it is a banned practice.",
  "location": "Subject line / headline",
  "recommendation": "State the exact end date and time ('Offer ends 23:59 15 March 2026'). Recurring 'ends tonight' flash sales are a CMA banned practice."
}

EXAMPLE 3 — FREE CLAIM WITH HIDDEN CONDITIONS (violation):
Content: "Get your FREE gift when you sign up — no catch!" [Context: gift requires £20 minimum purchase, stated in T&Cs only]
Correct output:
{
  "regulation": "CAP Code 3.9",
  "severity": "critical",
  "issue": "'Free' claim without disclosure of £20 minimum purchase. Condition is only in T&Cs — must be prominent upfront.",
  "location": "Headline and CTA",
  "recommendation": "State condition prominently: 'Free gift with orders over £20'. Conditions must precede or accompany the free claim in the same visual field."
}

EXAMPLE 5 — CONSENT LANGUAGE (violation):
Content: "By clicking Sign Up you agree to receive marketing from us and partners."
Correct output:
{
  "regulation": "UK GDPR Article 7 / PECR Reg 22",
  "severity": "critical",
  "issue": "Consent bundled with account creation. Extended to unnamed 'partners'. Neither freely given nor specific — two failures in one sentence.",
  "location": "Sign-up form copy / CTA",
  "recommendation": "Separate marketing consent from account creation entirely. Use an unticked checkbox. Consent to third-party marketing requires naming each partner separately."
}

EXAMPLE 7 — HEALTH CLAIM (violation):
Content: "Our vitamins boost your immune system and help fight off illness."
Correct output:
{
  "regulation": "CAP Code 10.1 / CAP Code 3.1",
  "severity": "high",
  "issue": "'Help fight off illness' implies disease prevention — an unauthorised medicinal claim. 'Boost immune system' only acceptable if using an authorised EU/UK health claim.",
  "location": "Product description",
  "recommendation": "Use only authorised health claims: 'Vitamin C contributes to the normal function of the immune system' is authorised. 'Fights illness' is not. Check the UK health claims register."
}

EXAMPLE 9 — REFERENCE PRICING (violation):
Content: "WAS £200. NOW £49.99. Save 75%!" [Context: product has only ever been sold at £49.99]
Correct output:
{
  "regulation": "CMA CPRs Reg 5 / CAP Code 3.1",
  "severity": "critical",
  "issue": "'Was' price of £200 appears fabricated. If product has not genuinely sold at £200 for a meaningful period, this is a misleading price indication.",
  "location": "Pricing headline",
  "recommendation": "'Was' price must reflect genuine previous selling price for a minimum of 28 days. If you cannot evidence the higher price, remove the reference pricing."
}

EXAMPLE 11 — PUFFERY (NOT a violation):
Content: "The UK's most loved coffee brand."
Correct output: Not a violation. Acceptable puffery under CAP 3.3. No reasonable person interprets "most loved" as a factual verifiable claim. Do not flag this.

EXAMPLE 12 — AUTHORISED HEALTH CLAIM (NOT a violation):
Content: "Vitamin D contributes to the normal function of the immune system."
Correct output: Not a violation. This is an authorised EU/UK health claim for Vitamin D. No action required.

EXAMPLE 13 — STANDARD URGENCY WITH SPECIFIC DATE (NOT a violation):
Content: "Sale ends midnight Sunday 16 March 2026."
Correct output: Not a violation. Specific end date given. Acceptable under CAP 3.7 provided the sale genuinely ends at the stated time.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 10 — SEVERITY CALIBRATION & VERDICT LABELS

SEVERITY — use these exact definitions:

critical: Enforcement action likely if discovered by ICO, CMA, or ASA.
Examples: sending without PECR consent, fake urgency (banned practice), false health claims, fabricated reference prices, pre-ticked consent, no unsubscribe mechanism.

high: Clear rule breach. Likely to result in ASA ruling or ICO investigation.
Examples: 'free' without disclosing conditions, unsubstantiated comparative claims, vague deadline without date, undisclosed influencer content, bundled consent.

medium: Probable rule breach. Less immediately enforceable but genuine gap.
Examples: missing privacy policy link, vague testimonials lacking substantiation, 'limited stock' without verifiable evidence, missing T&C link on promotions.

low: Best practice gap. Not a clear rule breach but worth addressing.
Examples: small print legibility, complex opt-out process, statistics cited without source (where claim is otherwise true).

VERDICT LABELS — use these exact strings:
Score 90–100, zero critical or high: "No issues found"
Score 75–89, zero critical: "Minor issues to address"
Score 50–74, zero critical: "Review required before sending"
Score 25–49, OR any critical issue: "Do not send — address critical issues first"
Score 0–24: "Significant violations identified"

RISK SCORE GUIDANCE:
• Start at 100. Deduct for each violation found.
• Critical violation: deduct 25–35 points.
• High violation: deduct 10–20 points.
• Medium violation: deduct 5–10 points.
• Low violation: deduct 1–5 points.
• Multiple violations of the same type: deduct once, not repeatedly.
• Cap minimum score at 0.

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
      "enforcement_note": "ASA ruled against Wowcher in 2019 for identical countdown timer practices (A19-560498). CMA secured undertakings from Wowcher in 2024 for the same pattern."
    }
  ],
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION HERE",
  "summary": "One sentence plain English assessment of the overall compliance position of this content."
}

The enforcement_note field is optional but include it when you know of a real enforcement case directly relevant to the violation. It makes the output significantly more credible and persuasive.
`;

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SCANNER — deterministic rule checks
// Returns { checks[], emailScore, summary }
// ─────────────────────────────────────────────────────────────────────────────

function runEmailChecks(subject, html) {
  const checks = [];
  let score = 100;

  // ── CRITICAL CHECKS ───────────────────────────────────────────────

  const hasUnsubscribe = /unsubscribe|opt-out|opt out/i.test(html);
  const unsubLink = html.match(/<a[^>]*href=["']([^"']*unsubscribe[^"']*)["']/i);
  const unsubBroken = unsubLink && (unsubLink[1] === '#' || unsubLink[1].startsWith('javascript'));

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
    const spamWords = ['free', 'winner', 'claim', 'act now', 'urgent', 'limited time', 'click here', 'buy now', 'guarantee', 'cash', '$$$', '100%', 'risk-free', 'no obligation', 'order now'];
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

  if (httpLinks.length > 0)  { checks.push({ status: 'warning', title: 'Insecure HTTP Links',     description: `${httpLinks.length} link(s) use HTTP. Switch to HTTPS.` });         score -= 5; }
  if (shortLinks.length > 0) { checks.push({ status: 'warning', title: 'URL Shorteners Detected', description: 'Shortened URLs trigger spam filters. Use full URLs.' });             score -= 3; }
  if (allLinks.length > 15)  { checks.push({ status: 'warning', title: 'Too Many Links',           description: `${allLinks.length} links found. Focus on 1–3 main CTAs.` });       score -= 5; }

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
    checks.push({ status: 'warning', title: '"Free" Claim Without T&Cs', description: 'ASA CAP Code requires terms when claiming "free".', fixType: 'misleading_claim' }); score -= 5;
  }
  if (/limited time|ends soon|last chance|today only/i.test(html) &&
      !/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(html)) {
    checks.push({ status: 'warning', title: 'Vague Time Limit', description: 'CAP Code 3.7: "limited time" must specify an exact end date.', fixType: 'fake_urgency' }); score -= 5;
  }
  if (/limited stock|while supplies last|only \d+ left/i.test(html)) {
    checks.push({ status: 'warning', title: 'Limited Stock Claim', description: 'Must be able to prove stock levels if challenged.', fixType: 'misleading_claim' }); score -= 3;
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
// FIX TYPE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

function mapViolationToFixType(violation) {
  const issue          = (violation.issue          || '').toLowerCase();
  const regulation     = (violation.regulation     || '').toLowerCase();
  const recommendation = (violation.recommendation || '').toLowerCase();

  if ((regulation.includes('pecr') || regulation.includes('gdpr')) &&
      (issue.includes('unsubscribe') || issue.includes('opt-out') || recommendation.includes('unsubscribe')))
    return 'missing_unsubscribe';
  if (issue.includes('urgency') || issue.includes('scarcity') || issue.includes('limited time') || issue.includes('hurry'))
    return 'fake_urgency';
  if (issue.includes('privacy policy') || recommendation.includes('privacy policy'))
    return 'no_privacy_policy';
  if (issue.includes('address') || recommendation.includes('address'))
    return 'missing_address';
  if (regulation.includes('cap') || regulation.includes('asa') || regulation.includes('cma') ||
      issue.includes('mislead') || issue.includes('false') || issue.includes('claim'))
    return 'misleading_claim';
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
// GENERATE FIXES
// ─────────────────────────────────────────────────────────────────────────────

async function generateFixes(userId, aiViolations, emailChecks, sourceRecordId, vercelUrl) {
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
      const r = await fetch(`${vercelUrl}/api/generate-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fixType: job.fixType, description: job.description, tool: 'AI Checker', severity: job.severity, volume: null, sourceRecordId })
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const APP_URL = process.env.APP_URL || 'https://sendwize-backend.vercel.app';

  try {
    const { content, subject, html, userId, autoFix } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!content && !html) return res.status(400).json({ error: 'Provide content (copy check) or html (email scan)' });

    // ── 1. Deterministic email checks ─────────────────────────────────
    const emailResult = html ? runEmailChecks(subject || '', html) : null;

    // ── 2. AI analysis ────────────────────────────────────────────────
    const analysisContent = content || (html
      ? `Subject: ${subject || '(none)'}\n\nEmail body:\n${html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`
      : null);

    let aiAnalysis = null;

    if (analysisContent) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      // Build the user message — this is ONLY the content to analyse.
      // All rules, cases, examples, and output format live in SYSTEM_PROMPT above.
      const userMessage = `CONTENT TO ANALYSE:
${analysisContent}
${autoFix ? '\nGenerate a fixedVersion field in the JSON with a fully rewritten compliant version.' : ''}`;

      const message = await anthropic.messages.create({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     SYSTEM_PROMPT,              // ← full framework goes here
        messages:   [{ role: 'user', content: userMessage }]
      });

      try {
        const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
        aiAnalysis = JSON.parse(jsonMatch ? jsonMatch[0] : message.content[0].text);
      } catch {
        aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: message.content[0].text };
      }
    }

    const violations = aiAnalysis?.violations || [];

    // ── 3. Fetch related enforcement cases ────────────────────────────
    const relatedCases = [];
    if (violations.length > 0) {
      try {
        const v = violations[0];
        let violationType = '';
        if (v.regulation.includes('PECR'))                                                        violationType = 'Unsolicited Marketing';
        else if (v.issue.toLowerCase().includes('price') || v.issue.toLowerCase().includes('cost')) violationType = 'Misleading Pricing';
        else if (v.issue.toLowerCase().includes('urgency') || v.issue.toLowerCase().includes('scarcity')) violationType = 'Misleading Urgency';
        else if (v.regulation.includes('CAP') || v.regulation.includes('ASA'))                    violationType = 'Misleading Advertising';

        if (violationType) {
          const dbRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/Violation_Database?filterByFormula={ViolationType}='${encodeURIComponent(violationType)}'&maxRecords=5&sort[0][field]=FineAmount&sort[0][direction]=desc`,
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
          );
          if (dbRes.ok) relatedCases.push(...((await dbRes.json()).records || []));
        }
      } catch (err) { console.error('Violation_Database fetch error:', err); }
    }

    // ── 4. Save to AI_Compliance_Checks ───────────────────────────────
    let savedRecordId = null;
    try {
      const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: [{
            fields: {
              UserID:       userId,
              CheckDate:    new Date().toISOString().split('T')[0],
              FileName:     subject ? `Email: ${subject}` : 'Marketing Content',
              RiskScore:    aiAnalysis?.score ?? (emailResult?.emailScore ?? 0),
              Verdict:      aiAnalysis?.verdict ?? `Email scan: ${emailResult?.summary.failed ?? 0} failures`,
              Violations:   JSON.stringify(violations),
              FixedVersion: aiAnalysis?.fixedVersion || '',
              RelatedCases: JSON.stringify(relatedCases.map(c => ({ company: c.fields.CompanyName, fine: c.fields.FineAmount, violation: c.fields.Violation }))),
              Results:      JSON.stringify({ aiAnalysis, emailScan: emailResult })
            }
          }]
        })
      });
      if (saveRes.ok) {
        const saved = await saveRes.json();
        savedRecordId = saved.records?.[0]?.id || null;
      }
    } catch (err) { console.error('AI_Compliance_Checks save error:', err); }

    // ── 5. Generate Compliance_Fixes ──────────────────────────────────
    if (violations.length > 0 || emailResult?.checks.some(c => c.fixType)) {
      await generateFixes(userId, violations, emailResult?.checks || [], savedRecordId, APP_URL);
    }

    // ── 5a. Update compliance streak ──────────────────────────────────
    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    // ── 6. Return unified response ────────────────────────────────────
    return res.status(200).json({
      ...(aiAnalysis || {}),
      ...(emailResult ? { emailScore: emailResult.emailScore, checks: emailResult.checks, checksSummary: emailResult.summary } : {}),
      relatedCases: relatedCases.map(c => ({
        company: c.fields.CompanyName, violation: c.fields.Violation,
        fine: c.fields.FineAmount, regulator: c.fields.Regulator,
        date: c.fields.DateOfAction, description: c.fields.Description
      }))
    });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: error.message });
  }
}
