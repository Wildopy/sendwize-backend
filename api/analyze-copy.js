// api/analyze-copy.js  v5.3
// AI Copy Scanner -- five content types, image analysis, text-only input.
//
// POST { contentType, userId, content, subject?, autoFix?, sendingContext?, images? }
//
// v5.3 changes from v5.2:
//   - Substantiation violations (CAP 3.7, 12.1, 15.x, unsubstantiated comparatives etc.)
//     now carry requiresEvidence:true instead of being written to generate-fix.
//     Frontend renders these as self-certification cards — user ticks "I confirm we
//     hold evidence on file" to dismiss. No fix record created. Genuine violations
//     (consent, sender identity, fake urgency, pricing etc.) unchanged.
//   - SYSTEM_PROMPT rewrite section overhauled: per-channel voice preservation rules.
//     Email: subject line punch + CTA energy preserved. SMS: urgency + brevity kept.
//     Social: hook + scroll-stop energy kept. Direct mail: narrative flow kept.
//     Push: action verb preserved. Rule is fix what's broken, leave the rest alone.
//   - mapViolationToFixType now returns null for substantiation-only violations so
//     generateFixes skips them cleanly.

import crypto from 'crypto';

const APP_URL = 'https://sendwize-backend.vercel.app';

// ─── Violation categories that are substantiation prompts, not actionable fixes ──
// These get requiresEvidence:true and are never written to generate-fix.
const EVIDENCE_REGULATIONS = [
  /cap.*(3\.7|12\.1|15\.1|15\.2|15\.6|15\.7)/i,
  /substantiat/i,
  /nhc register/i,
  /evidence.*held/i,
  /hold.*evidence/i,
  /documentary.*evidence/i,
];
const EVIDENCE_FIX_TYPES = new Set([
  'unauthorised_health_claim',
  'unsubstantiated_comparative_claim',
  // misleading_claim is only evidence-only when regulation matches; handled in isEvidenceViolation()
]);

function isEvidenceViolation(violation) {
  const combined = `${violation.regulation || ''} ${violation.issue || ''} ${violation.recommendation || ''}`;
  // Explicit evidence fix types
  if (EVIDENCE_FIX_TYPES.has(violation._fixType)) return true;
  // Regulation pattern match
  if (EVIDENCE_REGULATIONS.some(re => re.test(combined))) return true;
  // Recommendation language signals "hold evidence on file" not "fix the copy"
  if (/hold.*on file|evidence.*before.*campaign|must hold documentary/i.test(combined)) return true;
  return false;
}

const SYSTEM_PROMPT = `
SECTION 1 -- IDENTITY & ROLE
You are a senior UK marketing compliance analyst with specialist expertise in:
* PECR (Privacy and Electronic Communications Regulations 2003)
* UK GDPR (as retained post-Brexit)
* ASA CAP Code (non-broadcast advertising)
* CMA -- Digital Markets, Competition and Consumers Act 2024 (DMCCA)
* ICO enforcement practice and guidance
* Business Protection from Misleading Marketing Regulations 2008 (BPRs) -- B2B contexts

You have reviewed hundreds of real enforcement cases. You know exactly what regulators look for, how they think, and what they prioritise. You are precise, specific, and you only flag genuine violations -- not theoretical risks.

You are NOT a lawyer. You surface potential compliance gaps. You never tell users their content is legally compliant or non-compliant. Use language like "we can't find evidence of..." and "the ICO expects..." rather than definitive legal judgements.

------------------------------------------------------------

SECTION 2 -- TASK DEFINITION
Your task is to analyse the marketing content provided and:
1. If a [SENDING CONTEXT] block is present, analyse it FIRST before reading the copy.
2. Identify every genuine compliance violation across PECR, UK GDPR, ASA CAP Code, CMA/DMCCA rules, and BPRs (for B2B content).
3. For each violation: cite the exact rule, explain the issue in plain English, locate it precisely, and give a specific actionable fix.
4. Assign a risk score (0--100) where 100 = no issues found.
5. Assign a verdict using the exact labels in Section 10.
6. Calibrate severity using the exact definitions in Section 10.
7. Generate a compliant rewrite following the REWRITE RULES in Section 2A exactly.

Enforcement case matching: only cite a real enforcement case in enforcement_note when the breach is virtually identical. Never fabricate a case -- omit enforcement_note entirely if uncertain.

Substantiation scoping -- critical rule: When flagging unsubstantiated claims (CAP 3.7, 12.1, 15.1 etc.), focus only on what is absent from the marketing content itself. Do NOT judge whether underlying evidence exists. Frame as: "this claim requires substantiation to be held on file -- we cannot identify evidence of that basis in this content." Never say "no credible evidence could support this claim."

------------------------------------------------------------

SECTION 2A -- REWRITE RULES (read carefully before generating fixedVersion)

The fixedVersion must fix every compliance issue identified. It must NOT flatten the copy into generic compliance language. Marketing that sounds like a legal disclaimer has failed.

CORE PRINCIPLE: Fix only what is broken. Preserve everything that is not.

What "broken" means: false urgency without a date, unsubstantiated superlatives presented as fact, missing unsubscribe, concealed sender, fabricated pricing, prohibited health claims. Fix these specifically and surgically.

What is NOT broken and must be preserved:
* Energy, urgency, enthusiasm, exclamation marks (where not tied to a false claim)
* Punchy sentence structure, short paragraphs, fragmented sentences used for effect
* CTAs and their verb strength ("Grab yours now", "Shop the drop", "Don't miss out" are fine unless the urgency claim is false)
* Brand voice, tone, personality
* The commercial argument -- if the offer is real, the excitement about it is real

PER-CHANNEL REWRITE INSTRUCTIONS:

EMAIL:
* Subject line: keep the energy and hook. If the original subject was punchy ("Last chance -- offer ends TONIGHT"), keep the punch, fix only the false element ("Last chance -- offer ends [specific date]"). Do not replace with something flat like "Your summer offer".
* Body: keep paragraph length, rhythm, and sentence style of the original. If it was short and punchy, keep it short and punchy. If it was conversational, keep it conversational.
* CTA button text: preserve the verb and energy ("Get 50% off now →" not "Click here").
* Add missing compliance elements (unsubscribe, address) as a minimal footer -- do not work them into the body copy.

SMS:
* Character economy is the priority. Never make an SMS rewrite longer than the original unless adding a mandatory STOP instruction that was genuinely missing.
* Keep the urgency verb ("Save £X today -- reply STOP to opt out" not "You may be eligible for a saving if you wish to proceed").
* STOP instruction must appear but can go at the end in minimal form.

SOCIAL:
* Hook line is sacred. Never rewrite the first sentence into something generic. Fix the claim, keep the hook.
* Hashtags: keep them all unless one is specifically the problem.
* #ad: add it to the front if missing -- do not rewrite the rest to compensate.
* Length: social rewrites must be the same length as the original ±20%.

PUSH NOTIFICATION:
* These are 40-60 words maximum. Every word costs. Fix the violation in the fewest possible words.
* Keep the action verb in the CTA. "Tap to claim" not "Please visit our app".

DIRECT MAIL:
* Preserve the narrative structure. If the original had a story arc (problem → solution → offer), keep it.
* Headline punch is critical for direct mail -- never replace a strong headline with a weak one.
* Offer terms and legal copy go in a clearly marked section at the bottom -- not woven into the main copy.

UNIVERSAL RULES FOR ALL CHANNELS:
* Never add qualifications inline that break the reading flow. Put them in a clearly labelled "Offer terms:" block at the end.
* Never remove a real offer or real saving -- if it's genuine, it can stay, it just needs to be presented correctly.
* Never replace first-person brand voice ("We've got something special") with passive voice ("Something special has been made available").
* If the original had a specific statistic or claim that requires evidence, mark it with [EVIDENCE REQUIRED: confirm before sending] inline rather than deleting it -- the marketer may hold the evidence.

------------------------------------------------------------

SECTION 3 -- PECR RULES

PECR (Privacy and Electronic Communications Regulations 2003)

Reg 22 -- Consent for electronic marketing:
* Email and SMS to individuals requires prior consent or the soft opt-in exception.
* Soft opt-in: valid ONLY if (a) contact purchased or negotiated to purchase from you, (b) marketing is for similar products/services, (c) opt-out was offered at collection AND in every message.
* B2B email to corporate addresses has more flexibility but sole traders and partnerships still require consent.

Reg 22 -- Unsubscribe:
* Every marketing message MUST include a simple, free, working means to opt out.
* A broken link, an unanswered 'reply to unsubscribe', or a hidden opt-out in footer text are all violations.

Reg 23 -- Sender identity:
* The sender must not be disguised or concealed.
* The From field and subject line must identify the real organisation.
* noreply@ is not itself a violation, but providing no valid reply address when the opt-out relies on replying is.

Reg 6 -- Cookies and tracking:
* The Data (Use and Access) Act 2025 (DUAA) updates Regulation 6 of PECR, expanding cookie consent exemptions for analytics, security, and technical functionality, provided transparency and easy opt-out options are maintained.

ICO PECR ENFORCEMENT CASES:

[ALLAY CLAIMS LTD -- GBP120,000 -- January 2026 -- Reg 22 PECR]
Sent ~4 million unsolicited SMS messages. Soft opt-in failed on every condition. Claimed messages were 'service messages' -- ICO rejected this.
Key takeaway: Soft opt-in only works if customers are given a genuinely functional way to refuse at the exact point of data collection.

[ZMLUK LIMITED -- GBP105,000 -- December 2025 -- Reg 22 PECR]
Sent ~67.8 million marketing emails using data purchased from a third-party lead generation website. Sign-up covered 361 partner companies with no ability to select specific ones.
Key takeaway: Bought-in lists are only lawful if recipients specifically consented to hear from your organisation by name.

[HELLOFRESH -- GBP140,000 -- January 2024 -- Reg 22 PECR]
Single tick box bundled age verification, free sample consent, and marketing consent. Former customers continued receiving marketing for up to 24 months after cancellation.
Key takeaway: Consent must be channel-specific and unbundled from unrelated confirmations.

[WE BUY ANY CAR (WBAC) -- GBP200,000 -- September 2021 -- Reg 22 PECR]
Claimed soft opt-in but the opt-out was only presented after customers received their valuation -- not at the point of data collection.
Key takeaway: The soft opt-in opt-out must be offered at the point of data collection -- not after the transaction completes.

[SAGA SERVICES & SAGA PERSONAL FINANCE -- GBP150,000 + GBP75,000 -- September 2021 -- Reg 22 PECR]
Sent 128m+ unsolicited emails relying on 'indirect consent' collected by affiliate partners.
Key takeaway: Indirect consent is not valid for email or SMS marketing.

[EASYLIFE LTD -- GBP130,000 (PECR) + GBP250,000 (UK GDPR) -- October 2022]
1.3m+ unsolicited calls to TPS-registered individuals. Inferred health conditions from purchase data without consent.
Key takeaway: Two separate enforcement risks can arise from the same marketing operation.

------------------------------------------------------------

SECTION 4 -- UK GDPR RULES

Article 5: Lawfulness, fairness, transparency. Purpose limitation. Data minimisation.
Article 6: Consent (6(1)(a)) or legitimate interests (6(1)(f)). LI requires genuine balance test. Pre-ticked boxes = not consent. Bundled consent = not consent.
Article 7: Consent must be as easy to withdraw as to give. Granular -- separate consent for different purposes.
Articles 13/14: At collection must state: controller identity, purpose and legal basis, retention period, data subject rights.
Article 17: Unsubscribes must be actioned promptly.

ICO UK GDPR ENFORCEMENT CASES:
[JOIN THE TRIBOO LTD (JTT) -- GBP130,000 -- 2023] Consent not specific -- individuals consented to JTT, not the third-party brands whose emails were sent.
[EXPERIAN LTD -- Enforcement notice -- 2020] Repurposing credit reference data on ~51 million UK individuals to build marketing profiles without knowledge.
[OUTSOURCE STRATEGIES LTD -- GBP340,000 combined -- 2024] 1.43m+ unsolicited marketing calls to TPS-registered individuals. Deliberately targeted elderly and vulnerable people.
[POXELL LTD -- GBP150,000 -- 2024] 2.6m+ unsolicited calls. Rotated caller IDs to avoid detection -- treated as deliberate knowing non-compliance.

------------------------------------------------------------

SECTION 5 -- ASA CAP CODE RULES

CAP 2.1: Marketing must be obviously identifiable. #ad required for influencer/paid partnership content.
CAP 3.1: Must not materially mislead. Applies to claims, omissions, ambiguous statements, and overall impression.
CAP 3.2: Obvious exaggerations unlikely to be taken literally are allowed (puffery). "World's best pizza" = puffery. "Clinically proven to reduce ageing by 50%" = verifiable claim requiring evidence.
CAP 3.3: Must not mislead by omitting material information.
CAP 3.7: Evidence must be held before the campaign runs.
CAP 3.9: Significant limitations and qualifications must be stated.
CAP 3.10: Qualifications must be presented clearly -- covers small print effectively invisible to consumers.
CAP 3.12: Must not present legal rights as a distinctive feature (e.g. "you can unsubscribe any time!" as a selling point).
CAP 3.17: Price statements must not mislead by omission, undue emphasis or distortion.
CAP 3.22: "Up to" and "from" price claims must not exaggerate availability or amount of benefits.
CAP 3.23/3.24: "Free" must mean genuinely free. Marketers must make clear any commitment required.
CAP 3.26: Must not use "free trial" to describe offers requiring a non-refundable purchase.
CAP 3.30: Must not falsely state a product or offer is available only for a very limited time. Applies to fake countdown timers and fabricated stock claims.
CAP 3.33--3.35: Comparative claims must be like-for-like and objectively compare material, relevant, verifiable and representative features.
CAP 3.37: Comparisons with unidentifiable competitors must not give the marketer an unrepresentative advantage.
CAP 3.39: Price comparisons with RRPs are likely to mislead if the RRP differs significantly from the price at which the product is generally sold.
CAP 3.44: No fake consumer reviews.
CAP 3.45: Incentivised reviews must be disclosed.
CAP 3.46: Must not publish reviews in a misleading way -- includes selectively suppressing negative reviews.
CAP 3.47: Must hold documentary evidence and contact details for testimonials. Results-based testimonials must reflect typical experience or state clearly that results are not typical.
CAP 3.52: Must not display a trust mark or quality mark without authorisation. Must not claim approval or endorsement without it.
CAP 8.1: Promoters are responsible for all aspects and all stages of their promotions.
CAP 8.17/8.17.4: Significant conditions of a promotion must be clearly communicated. Promotions with a closing date must state that date clearly. "Ends soon" or "today only" without a specific date is a violation.
CAP 12.1: Health claims must be substantiated. "Treats", "cures" or "prevents" a medical condition = medicinal claim requiring MHRA authorisation.
CAP 15.1/15.1.1: Nutrition and health claims must be authorised on the GB NHC Register.
CAP 15.6.3: Health claims referring to the recommendation of an individual health professional are not acceptable for food supplements.
CAP 14.1: Financial promotions must be fair, clear and not misleading. Risk warnings required.
CAP 16.1: Gambling ads must not appeal particularly to under-18s.
CAP 18.1: Alcohol ads must not be directed at or strongly appeal to under-18s.

ASA RULING EXAMPLES -- FAKE URGENCY & SCARCITY:
[CLUEDUPP GAMES -- November 2023] "Only 14 tickets remaining" when 88% of inventory remained. Technical error is not a defence.
[HAMMONDS FURNITURE -- October 2025] Countdown timer applied in consumer's eyes to entire offer, not just the 5% it technically covered.
[UK FLOORING DIRECT -- August 2022] Countdown timer creates a legal obligation to retain evidence the promotion genuinely ended when stated.

ASA RULING EXAMPLES -- FREE CLAIMS:
[PLANETART UK -- August 2022] "FREE PHOTO PRINTS" with mandatory delivery charge. "FreePrints" trademark did not override the descriptive impression.
[NOW TV -- September 2024] "7 day free trial -- cancel anytime" without prominent disclosure of auto-renewal terms.
[BEER52 -- December 2024] "Free case of wine" referral reward required subscription purchase. Linking to T&Cs was insufficient -- emails have no space constraints.

ASA RULING EXAMPLES -- HEALTH CLAIMS:
[KOLLO HEALTH -- November 2023] Multiple claims for marine collagen supplement -- none authorised on GB NHC Register.
[NOVOMINS NUTRITION -- July 2024] "Less Stress", "Less Anxiety", "Deeper Sleep" -- softening language does not escape disease treatment prohibition.
[BETTERVITS -- September 2025] Exaggerating an authorised claim (removing "contributes to" or "normal") treated same as unauthorised claim. Using a health professional as influencer for food supplements triggers CAP 15.6.3 regardless of #ad disclosure.

ASA RULING EXAMPLES -- DISCOUNT & PRICE CLAIMS:
[SIMBA SLEEP -- CMA July 2024] Inflated "was" prices and inaccurate countdown clocks. CMA undertakings required.
[VYTALIVING -- March 2024] "HALF PRICE" against an RRP the product had never actually sold at.
[SECRET ESCAPES -- February 2025] Discount percentage inflated by including value of extras (dining credits) into the "was" price calculation.

ASA RULING EXAMPLES -- TESTIMONIALS & REVIEWS:
[TONIC HEALTH -- July 2025] Identical review wording attributed to two different customer names. Technical error still non-compliant.
[OFFICIAL IPHONE UNLOCK -- September 2018] GBP3 refund offered for "a nice review" -- incentive explicitly conditional on sentiment.
[CANDY COAT -- April 2019] Only positive reviews displayed; negative suppressed. Under DMCCA 2024 now explicitly prohibited by statute.

------------------------------------------------------------

SECTION 6 -- CMA RULES

CMA -- Digital Markets, Competition and Consumers Act 2024 (DMCCA) -- in force from 6 April 2025

DMCCA Schedule 20 -- Banned practices (automatically unfair, no context defence):
* Falsely claiming to be a consumer (fake reviews).
* Claiming a product can cure an illness if it cannot.
* Creating a false impression of urgency.
* Bait advertising.
* Falsely claiming a product is only available for a limited time.

Misleading actions (DMCCA s.226): False information about price, nature, composition, origin, availability. Reference pricing requires genuine previous price for meaningful period.

Misleading omissions (DMCCA s.227): Drip pricing -- all mandatory costs must be shown upfront.

Aggressive practices (DMCCA s.228): Harassment, coercion, exploiting vulnerability.

Fake reviews (now statutory under DMCCA Schedule 20): Commissioning, publishing, or failing to prevent fake reviews is automatically unfair.

Direct CMA enforcement: fines up to 10% of global annual turnover or GBP300,000 without court proceedings.

Subscription contracts: 14-day cooling-off after free trial converts. Reminder before annual renewals. Cancellation as easy as sign-up.

Environmental claims: Flag vague claims ("sustainable", "eco-friendly", "carbon neutral", "net zero") as HIGH severity unless content specifies the basis, scope, and pre-campaign evidence.

CMA ENFORCEMENT CASES:
[AMAZON -- June 2025] Fake reviews and catalogue abuse. Formal undertakings signed.
[GOOGLE -- January 2025] Insufficient fake review detection. Undertakings signed.
[WOWCHER -- August 2024] Fake countdown timers + pre-ticked paid membership box. ~GBP4m customer refunds.
[SIMBA SLEEP -- July 2024] Misleading was/now reference pricing and inaccurate countdown clocks.

------------------------------------------------------------

SECTION 6A -- DMCCA 2024 ADDITIONAL RULES

Fake reviews -- statutory prohibition (Schedule 20): Concealing an incentivised review is prohibited regardless of whether the incentive is money, discounts, free products, or invitations. Flag any review manipulation as CRITICAL.

Drip pricing -- now explicitly statutory: Total price including all mandatory charges must appear in any invitation to purchase.

CAP Code Section 11 -- Environmental claims:
CAP 11.1: Basis of all environmental claims must be clear.
CAP 11.3: Absolute claims ("zero carbon", "fully sustainable") require high substantiation.
CAP 11.4: Claims must be based on full product life cycle unless stated otherwise.
CAP 11.7: Must not mislead by highlighting absence of a damaging ingredient not typically found in competing products.

------------------------------------------------------------

SECTION 7 -- SECTOR-SPECIFIC RULES

FINANCIAL SERVICES: Financial promotions require FCA approval (s.21 FSMA 2000). Risk warnings mandatory. "Representative APR" required when quoting credit costs.

HEALTH & SUPPLEMENT PRODUCTS: Only authorised health claims permitted. "Treats", "cures", "prevents" = MHRA authorisation required. From 5 January 2026: ads for less healthy food/drink banned from paid-for online placements.

FOOD & DRINK: "Natural", "organic", "free-range" have specific legal definitions. Alcohol: must not glamourise excessive drinking or appeal to under-18s.

GAMBLING: Safer gambling messaging required. "Free bet" terms clearly disclosed upfront. Cannot target vulnerable people or those who have self-excluded.

E-COMMERCE / RETAIL: "Was" prices must reflect genuine previous selling price for meaningful period (28 days minimum recommended). Delivery costs shown upfront.

B2B MARKETING: BPRs apply. Comparative advertising naming a competitor must: (a) compare like-for-like, (b) objectively compare material verifiable features, (c) not create brand confusion, (d) not denigrate competitor trade marks, (e) not mislead. Flag any B2B comparative claim failing any condition as HIGH.

------------------------------------------------------------

SECTION 8 -- RED FLAGS -- ALWAYS CHECK

SENDING CONTEXT (check first if present):
* Purchased/rented list without specific consent by name
* Indirect/partner consent (not valid for email/SMS)
* Soft opt-in claimed but opt-out not at point of data collection
* From name does not match consent holder (Reg 23)
* Consent 'not sure' -- treat as invalid

URGENCY & SCARCITY: Countdown timers, "Only X left", "Ends tonight/today/soon" without specific date, "Limited edition".
PRICING: "Was/Now" without genuine previous price, drip pricing, "Free" with hidden conditions, buried subscription terms.
CLAIMS: Superlatives presented as fact, statistics without source, "Up to X% off", health claims, comparative claims.
CONSENT & DATA: Pre-ticked boxes, bundled consent, "our partners" without naming them, no privacy policy link.
IDENTITY & TRANSPARENCY: Influencer content without #ad, undisclosed reviews, concealed sender, unauthorised trust marks (CAP 3.52).
ENVIRONMENTAL: Vague "sustainable", "eco-friendly", "carbon neutral", "net zero" without basis, scope, pre-campaign evidence.
VULNERABLE AUDIENCES: Content reaching children, exploitation of financial difficulty or health anxiety, high-pressure language targeting elderly.

------------------------------------------------------------

SECTION 9 -- FEW-SHOT EXAMPLES

EXAMPLE 1 -- FAKE URGENCY (violation):
Content: "FLASH SALE -- 50% OFF EVERYTHING! Offer ends tonight."
{ "regulation": "CAP Code 3.7 / DMCCA Schedule 20", "severity": "high", "issue": "Urgency claim uses vague deadline 'ends tonight' without specific date or time. If this offer resets, it is a banned practice.", "location": "Subject line / headline", "recommendation": "State the exact end date and time ('Offer ends 23:59 15 March 2026'). Recurring 'ends tonight' flash sales are a CMA banned practice.", "enforcement_note": "ASA ruled against Hammonds Furniture (2025) for countdown timers not reflecting genuine expiry." }

EXAMPLE 2 -- FAKE URGENCY REWRITE (how to fix without losing energy):
Original: "FLASH SALE -- 50% OFF EVERYTHING! Offer ends tonight."
Fixed: "FLASH SALE -- 50% OFF EVERYTHING! Offer ends 23:59 Sunday 15 March."
Note: same energy, same structure, same caps -- only the vague "tonight" replaced with a real date.

EXAMPLE 3 -- FREE CLAIM WITH HIDDEN CONDITIONS (violation):
Content: "Get your FREE gift when you sign up -- no catch!" [gift requires GBP20 minimum purchase, in T&Cs only]
{ "regulation": "CAP Code 3.9", "severity": "critical", "issue": "'Free' claim without disclosure of GBP20 minimum purchase. Condition is only in T&Cs -- must be prominent upfront.", "location": "Headline and CTA", "recommendation": "State condition prominently: 'Free gift with orders over GBP20'. Conditions must precede or accompany the free claim in the same visual field.", "enforcement_note": "Beer52 (2024) and PlanetArt (2022) both ruled against by ASA for 'free' claims where mandatory conditions were not in the same communication." }

EXAMPLE 5 -- CONSENT LANGUAGE (violation):
Content: "By clicking Sign Up you agree to receive marketing from us and partners."
{ "regulation": "UK GDPR Article 7 / PECR Reg 22", "severity": "critical", "issue": "Consent bundled with account creation. Extended to unnamed 'partners'. Neither freely given nor specific -- two failures in one sentence.", "location": "Sign-up form copy / CTA", "recommendation": "Separate marketing consent from account creation entirely. Use an unticked checkbox. Consent to third-party marketing requires naming each partner separately.", "enforcement_note": "ZMLUK (2025, GBP105,000) was fined for relying on consent collected by a website covering 361 unnamed partner companies." }

EXAMPLE 7 -- HEALTH CLAIM (violation, requiresEvidence):
Content: "Our vitamins boost your immune system and help fight off illness."
{ "regulation": "CAP Code 12.1 / 3.7", "severity": "high", "issue": "'Help fight off illness' implies disease prevention -- an unauthorised medicinal claim. 'Boost immune system' requires a specific authorised claim from the GB NHC Register.", "location": "Product description", "recommendation": "Use only authorised health claims: 'Vitamin C contributes to the normal function of the immune system' is authorised. Check the GB Nutrition and Health Claims Register before sending." }
Note: this is a requiresEvidence violation. The marketer confirms they hold the authorised claim basis on file to dismiss it.

EXAMPLE 9 -- REFERENCE PRICING (violation):
Content: "WAS GBP200. NOW GBP49.99. Save 75%!" [product has only ever sold at GBP49.99]
{ "regulation": "DMCCA s.226 / CAP Code 3.1", "severity": "critical", "issue": "'Was' price of GBP200 appears fabricated. If product has not genuinely sold at GBP200 for a meaningful period, this is a misleading price indication.", "location": "Pricing headline", "recommendation": "'Was' price must reflect genuine previous selling price for a minimum of 28 days. If you cannot evidence the higher price, remove the reference pricing.", "enforcement_note": "Simba Sleep (CMA, 2024) gave formal undertakings for inflated 'was' prices. Vytaliving (ASA, 2024) upheld for 'HALF PRICE' against an RRP the product had never sold at." }

EXAMPLE 11 -- PUFFERY (NOT a violation):
Content: "The UK's most loved coffee brand."
Not a violation. Acceptable puffery under CAP 3.2. Do not flag.

EXAMPLE 12 -- AUTHORISED HEALTH CLAIM (NOT a violation):
Content: "Vitamin D contributes to the normal function of the immune system."
Not a violation. Authorised health claim on the GB NHC Register. No action required.

EXAMPLE 13 -- STANDARD URGENCY WITH SPECIFIC DATE (NOT a violation):
Content: "Sale ends midnight Sunday 16 March 2026."
Not a violation. Specific end date given. Acceptable under CAP 8.17.4 provided sale genuinely ends then.

EXAMPLE 14 -- B2B COMPARATIVE CLAIM WITH DISCLOSED BASIS (NOT a violation):
Content: "43% faster report generation than Excel -- based on our internal benchmark study of 50 finance teams, Q1 2026."
Not a violation provided the study exists and is held on file (CAP 3.7). Basis is disclosed. Do not flag.

EXAMPLE 15 -- PROPERLY DISCLOSED INFLUENCER CONTENT (NOT a violation):
Content: "#ad Obsessed with my new @BrandName moisturiser -- my skin has genuinely never looked better!"
Not a violation. #ad at start, personal opinion not a verifiable health claim. CAP 2.1 satisfied.

EXAMPLE 16 -- SOFT OPT-IN CORRECTLY APPLIED (NOT a violation):
Content: "[On checkout page, immediately after purchase, unticked checkbox:] We'd like to send you offers on similar products by email. Tick here if you'd prefer not to receive these."
Not a violation. Correctly applies PECR Reg 22(3) soft opt-in.

EXAMPLE 17 -- TESTIMONIAL CORRECTLY DISCLOSED (NOT a violation):
Content: "[Five stars] 'I've been using this for 6 months and my back pain has genuinely improved.' -- Sarah T, verified purchaser. Individual results may vary."
Not a violation provided review is genuine, evidence held on file, and "results may vary" is prominent.

------------------------------------------------------------

SECTION 10 -- SEVERITY CALIBRATION & VERDICT LABELS

SEVERITY:
critical: Enforcement action likely if discovered. Examples: sending without PECR consent, broken consent chain, fake urgency (banned practice), fabricated reference prices, pre-ticked consent, no unsubscribe, third-party list without specific consent, fake reviews.
high: Clear rule breach. Likely to result in ASA ruling or ICO investigation. Examples: "free" without disclosing conditions, vague deadline without date, undisclosed influencer content, bundled consent, greenwashing without evidence basis.
medium: Probable rule breach. Less immediately enforceable. Examples: missing privacy policy link, vague testimonials, "limited stock" without evidence, missing T&C link.
low: Best practice gap. Not a clear rule breach. Examples: small print legibility, complex opt-out process.

VERDICT LABELS (use exact strings):
Score 90--100, zero critical or high: "No issues found"
Score 75--89, zero critical: "Minor issues to address"
Score 50--74, zero critical: "Review required before sending"
Score 25--49, OR any critical issue: "Do not send -- address critical issues first"
Score 0--24: "Significant violations identified"

RISK SCORE: Start at 100. Critical: deduct 25--35. High: deduct 10--20. Medium: deduct 5--10. Low: deduct 1--5. Multiple of same type: deduct once. Minimum 0.

------------------------------------------------------------

SECTION 11 -- OUTPUT FORMAT

Respond ONLY in this exact JSON format. No preamble. No markdown fences. No commentary outside the JSON.

{
  "score": 85,
  "verdict": "Minor issues to address",
  "violations": [
    {
      "regulation": "CAP Code 3.7",
      "severity": "high",
      "issue": "Time-limited offer without specific end date",
      "location": "Subject line -- 'Flash sale ends soon'",
      "recommendation": "Replace 'ends soon' with exact date and time.",
      "enforcement_note": "Only include when you know a real, virtually identical case. Omit entirely if uncertain."
    }
  ],
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION HERE -- following Section 2A rewrite rules exactly. Fix what is broken. Preserve everything else. Keep the energy.",
  "summary": "One sentence plain English assessment."
}
`;

const CHANNEL_RULES = {
  email: `CHANNEL: EMAIL
Apply: PECR Reg 22 (consent / soft opt-in), Reg 23 (sender identity), UK GDPR, ASA CAP Code, CMA/DMCCA rules.
Check: unsubscribe mechanism, postal address, sender identification, consent signals, all CAP Code and DMCCA red flags.
Rewrite: follow Section 2A EMAIL rules. Subject line energy is sacred. Add compliance elements as minimal footer.`,

  sms: `CHANNEL: SMS
Apply: PECR Reg 22 (consent -- stricter than email), ASA CAP Code for promotional content.
Additional SMS-specific checks:
* Is there a STOP opt-out keyword? (e.g. "Reply STOP to opt out") -- mandatory.
* Does the message exceed 160 characters? Flag if so -- note the character count.
* Is the sender identity clear from the opening words?
* No HTML -- plain text only.
UK GDPR applies to any data processing referenced.
Rewrite: follow Section 2A SMS rules. Never make it longer. STOP instruction appended minimally.`,

  push: `CHANNEL: PUSH NOTIFICATION
Apply: PECR Reg 22 (consent required for push notifications), ASA CAP Code for promotional claims.
Check: whether consent for push was likely obtained at app install, claim accuracy, urgency/scarcity language.
Rewrite: follow Section 2A PUSH rules. Fix in fewest possible words. Keep action verb.`,

  social: `CHANNEL: SOCIAL AD / SOCIAL POST
Apply: ASA CAP Code (primary), CMA/DMCCA rules.
DO NOT apply PECR Reg 22 consent rules -- these do not apply to social ads directed at audiences.
Check: #ad disclosure where required, misleading claims, fake urgency/scarcity, reference pricing, testimonials, greenwashing, age-restricted products.
Rewrite: follow Section 2A SOCIAL rules. Hook line is sacred. Same length ±20%.`,

  directmail: `CHANNEL: DIRECT MAIL (physical post)
Apply: UK GDPR (legitimate interests most common basis -- full LI balance test required), ASA CAP Code, CMA/DMCCA rules.
DO NOT apply PECR Reg 22 -- PECR applies to electronic communications only.
Check: LI basis validity, misleading claims, reference pricing, urgency/scarcity, opt-out mechanism (MPS reference is best practice), sender identification.
Rewrite: follow Section 2A DIRECT MAIL rules. Preserve narrative structure and headline punch.`
};

function buildSendingContextBlock(ctx) {
  if (!ctx) return '';
  const lines = ['[SENDING CONTEXT]'];
  const senderMap  = { direct: 'We are sending directly', thirdParty: 'A third-party agency or platform is sending on our behalf' };
  const listMap    = { direct: 'We collected it directly from our own customers', purchased: 'Purchased or rented from a third party', partner: 'Provided by a partner or affiliate', mixed: 'Mixed sources' };
  const consentMap = { specific: 'Recipients specifically consented to our organisation by name', thirdParty: 'They consented to a third party or "our partners" -- not this organisation by name', softOptIn: 'Soft opt-in -- existing customers, similar products', notSure: 'Not sure' };
  const fromMap    = { yes: 'Yes -- From name matches the organisation that collected consent', no: 'No -- different sender', notSure: 'Not sure' };
  if (ctx.senderRelationship) lines.push(`Sender: ${senderMap[ctx.senderRelationship] || ctx.senderRelationship}`);
  if (ctx.listSource)         lines.push(`List source: ${listMap[ctx.listSource] || ctx.listSource}`);
  if (ctx.consentSpecificity) lines.push(`Consent: ${consentMap[ctx.consentSpecificity] || ctx.consentSpecificity}`);
  if (ctx.fromNameMatch)      lines.push(`From name match: ${fromMap[ctx.fromNameMatch] || ctx.fromNameMatch}`);
  lines.push('[END CONTEXT]');
  return lines.join('\n');
}

function getContextViolations(ctx) {
  if (!ctx) return [];
  const violations = [];
  if (ctx.listSource === 'purchased') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List purchased or rented from a third party. Recipients must have specifically consented to receive marketing from your organisation by name.', location: 'Sending context -- list source', recommendation: 'Do not send to this list until you can verify valid consent.', enforcement_note: 'ZMLUK (GBP105,000, December 2025) sent 67.8 million emails using purchased data.', _fixType: 'third_party_list', _fromContext: true });
  }
  if (ctx.listSource === 'partner') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List provided by a partner or affiliate -- indirect consent is insufficient for email or SMS marketing.', location: 'Sending context -- list source', recommendation: 'Each organisation sending marketing must have consent obtained specifically for their own communications.', enforcement_note: 'Saga Services (GBP225,000 combined, 2021) were fined for relying on indirect consent.', _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 22 / UK GDPR Article 7', severity: 'critical', issue: 'Recipients consented to a third party or "our partners" -- not to your organisation by name.', location: 'Sending context -- consent specificity', recommendation: 'Stop sending to this list. Consent must specifically name your organisation.', enforcement_note: 'ZMLUK (GBP105,000, 2025): consent covering 361 unnamed companies was invalid.', _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'notSure') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'high', issue: 'Consent basis is unclear. Do not send unless you can confirm valid consent.', location: 'Sending context -- consent specificity', recommendation: 'Verify your consent records before sending.', _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.senderRelationship === 'thirdParty' && ctx.fromNameMatch === 'no') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'critical', issue: 'A third-party agency is sending on your behalf and the From name does not match the organisation that collected consent.', location: 'Sending context -- sender relationship and From name mismatch', recommendation: 'The From name must clearly identify the brand that collected consent.', enforcement_note: 'Join the Triboo (GBP130,000, 2023) sent emails appearing to come from third-party brands.', _fixType: 'concealed_sender', _fromContext: true });
  }
  if (ctx.fromNameMatch === 'no' && ctx.senderRelationship !== 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'high', issue: 'The From name does not match the organisation that collected consent.', location: 'Sending context -- From name mismatch', recommendation: 'Ensure the From name clearly identifies the organisation that collected consent.', _fixType: 'concealed_sender', _fromContext: true });
  }
  return violations;
}

function mapViolationToFixType(violation) {
  if (violation._fixType) return violation._fixType;
  // Evidence-only violations: return null so generateFixes skips them
  if (isEvidenceViolation(violation)) return null;
  const combined = `${violation.issue || ''} ${violation.regulation || ''} ${violation.recommendation || ''}`.toLowerCase();
  if (combined.match(/unsubscribe|opt.out/))                                         return 'missing_unsubscribe';
  if (combined.match(/no consent|without consent|unsolicited|pecr.*consent|reg 22/)) return 'no_consent';
  if (combined.match(/pre.tick|bundled consent/))                                    return 'invalid_consent_mechanism';
  if (combined.match(/soft opt.in/))                                                 return 'no_soft_optin';
  if (combined.match(/sender.*conceal|sender.*identity|reg 23/))                    return 'concealed_sender';
  if (combined.match(/fake urgency|false urgency|ends soon|ends tonight|flash sale/)) return 'fake_urgency';
  if (combined.match(/fake scarcity|only \d+ left/))                                return 'fake_scarcity';
  if (combined.match(/reference pric|was.*now|fabricated.*price/))                  return 'misleading_reference_price';
  if (combined.match(/free.*condition|free.*hidden|cap.*3\.9/))                     return 'misleading_free_claim';
  if (combined.match(/testimonial|fake review|incentivi.*review/))                  return 'misleading_testimonial';
  if (combined.match(/influencer|#ad/))                                              return 'undisclosed_ad';
  if (combined.match(/drip pric|hidden fee/))                                        return 'drip_pricing';
  if (combined.match(/greenwash|sustainable|carbon neutral/))                        return 'misleading_claim';
  if (combined.match(/privacy policy/))                                              return 'no_privacy_policy';
  if (combined.match(/postal address|registered address/))                           return 'missing_address';
  if (combined.match(/third.party.*list|purchased.*data/))                           return 'third_party_list';
  return 'misleading_claim';
}

function mapViolationToSeverity(v) {
  const s = (v.severity || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high')     return 'high';
  if (s === 'medium')   return 'medium';
  return 'low';
}

function contentHash(userId, contentType, content) {
  return crypto.createHash('sha256').update(`${userId}|${contentType}|${content}`).digest('hex').slice(0, 16);
}

async function generateFixes(userId, allViolations, emailChecks, sourceRecordId) {
  const seenTypes = new Set();
  const fixJobs   = [];
  for (const v of (allViolations || [])) {
    // Skip evidence-only violations entirely -- they're self-certified in the UI
    if (v.requiresEvidence) continue;
    const fixType = mapViolationToFixType(v);
    if (!fixType) continue; // null = evidence-only, skip
    if (seenTypes.has(fixType)) continue;
    seenTypes.add(fixType);
    const source = v._fromContext ? 'Sending Context' : 'AI Checker';
    fixJobs.push({ fixType, description: `${source}: ${v.issue || 'Compliance issue'} (${v.location || 'content'}) -- ${v.recommendation || 'Review required'}`, severity: mapViolationToSeverity(v) });
  }
  for (const c of (emailChecks || [])) {
    if (!c.fixType || c.status === 'pass') continue;
    if (seenTypes.has(c.fixType)) continue;
    seenTypes.add(c.fixType);
    fixJobs.push({ fixType: c.fixType, description: `Email Scanner: ${c.title} -- ${c.description}`, severity: c.status === 'fail' ? 'high' : 'medium' });
  }
  for (const job of fixJobs) {
    try {
      const r = await fetch(`${APP_URL}/api/generate-fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, fixType: job.fixType, description: job.description, tool: 'AI Checker', severity: job.severity, volume: null, sourceRecordId }) });
      const d = await r.json();
      if (d.skipped) console.log(`generate-fix duplicate skipped: ${job.fixType}`);
    } catch (err) {
      console.error(`generate-fix failed for "${job.fixType}":`, err);
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contentType, content, subject, userId, autoFix, sendingContext, images } = req.body ?? {};
    if (!userId)      return res.status(400).json({ error: 'Missing userId' });
    if (!contentType) return res.status(400).json({ error: 'Missing contentType' });
    if (!['email','sms','push','social','directmail'].includes(contentType)) return res.status(400).json({ error: 'Invalid contentType' });
    if (!content)     return res.status(400).json({ error: 'Missing content' });

    const checkHash         = contentHash(userId, contentType, content);
    const contextViolations = getContextViolations(sendingContext);
    const copyText          = contentType === 'email' && subject ? `Subject: ${subject}\n\nEmail body:\n${content}` : content;
    const contextBlock      = buildSendingContextBlock(sendingContext);
    const analysisContent   = contextBlock ? `${contextBlock}\n\n[COPY TO ANALYSE]\n${copyText}` : copyText;

    const userMessage = `${CHANNEL_RULES[contentType]}\n\nCONTENT TO ANALYSE:\n${analysisContent}${autoFix ? '\nGenerate a fixedVersion field in the JSON following the Section 2A rewrite rules exactly. Fix compliance issues. Preserve brand voice, energy, and marketing punch.' : ''}`;

    const messageContent = [{ type: 'text', text: userMessage }];
    const validMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (Array.isArray(images) && images.length > 0) {
      const imageBlocks = images.slice(0, 3)
        .filter(img => img?.data && validMediaTypes.includes(img?.mediaType))
        .map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
      messageContent.push(...imageBlocks);
      if (imageBlocks.length > 0) messageContent.push({ type: 'text', text: `\nNote: ${imageBlocks.length} image(s) provided. Analyse for compliance issues alongside the copy.` });
    }

    const claudeHttpRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    console.log('Claude status:', claudeHttpRes.status);
    const message = await claudeHttpRes.json();
    console.log('Claude raw response:', JSON.stringify(message).slice(0, 500));

    if (!claudeHttpRes.ok) {
      console.error('Claude API error:', claudeHttpRes.status, JSON.stringify(message));
      return res.status(500).json({ error: 'Claude API error', details: message });
    }

    let aiAnalysis = null;
    try {
      const stripped  = message.content[0].text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      aiAnalysis = JSON.parse(jsonMatch ? jsonMatch[0] : stripped);
    } catch {
      console.error('JSON parse failed. Full text:', message.content[0]?.text?.slice(0, 1000));
      aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: message.content[0]?.text || 'Error' };
    }

    // Tag AI violations that are evidence-only
    const taggedAiViolations = (aiAnalysis?.violations || []).map(v => ({
      ...v,
      requiresEvidence: isEvidenceViolation(v),
    }));

    const contextFixTypes = new Set(contextViolations.map(v => v._fixType));
    const aiViolations    = taggedAiViolations.filter(v => !contextFixTypes.has(mapViolationToFixType(v)));
    const allViolations   = [...contextViolations, ...aiViolations];

    let finalScore = aiAnalysis?.score ?? 50;
    for (const v of contextViolations) {
      if (v.severity === 'critical')    finalScore -= 30;
      else if (v.severity === 'high')   finalScore -= 15;
      else if (v.severity === 'medium') finalScore -= 7;
    }
    finalScore = Math.max(0, finalScore);

    let finalVerdict = aiAnalysis?.verdict;
    if (contextViolations.length > 0) {
      const hasCritical = allViolations.some(v => v.severity === 'critical');
      if (hasCritical || finalScore <= 49)   finalVerdict = 'Do not send -- address critical issues first';
      else if (finalScore <= 74)             finalVerdict = 'Review required before sending';
      else if (finalScore <= 89)             finalVerdict = 'Minor issues to address';
      else                                   finalVerdict = 'No issues found';
    }

    // Save to Airtable
    let savedRecordId = null;
    try {
      const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
      const BASE_ID        = process.env.BASE_ID;
      const criticalCount  = allViolations.filter(v => v.severity === 'critical').length;
      const warningCount   = allViolations.filter(v => v.severity === 'high' || v.severity === 'medium').length;
      const saveRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: {
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
        }}]})
      });
      if (saveRes.ok) savedRecordId = (await saveRes.json()).records?.[0]?.id ?? null;
      else console.error('AI_Compliance_Checks save failed:', saveRes.status);
    } catch (err) {
      console.error('AI_Compliance_Checks save error:', err);
    }

    // Generate fixes -- evidence-only violations are skipped inside generateFixes
    if (allViolations.length > 0) {
      try { await generateFixes(userId, allViolations, [], savedRecordId); }
      catch (e) { console.error('generateFixes error:', e); }
    }

    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    // Clean internal props before sending to client
    // requiresEvidence IS sent to the client so the frontend can render certify cards
    const cleanViolations = allViolations.map(({ _fromContext, _fixType, ...rest }) => rest);
    return res.status(200).json({ ...aiAnalysis, score: finalScore, verdict: finalVerdict, violations: cleanViolations, contentType, checkHash });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
