// api/analyze-copy.js  v5.4
// AI Copy Scanner
//
// v5.4 changes from v5.3:
//   ~ isEvidenceViolation() tightened:
//       - EVIDENCE_REGULATIONS regex list narrowed to genuine substantiation
//         contexts only (CAP 3.7 / 12.1 / 15.x + explicit "hold on file" language)
//       - Removed loose /evidence.*before.*campaign/i and generic /substantiat/i
//         which were catching content-omission violations
//       - Added CAP 3.9 / 3.10 (material information omission) as explicit
//         non-evidence: "no T&Cs", "missing offer terms", "missing disclosure"
//         are content fixes, not evidence-required
//   ~ generateFixes() dedup key changed:
//       Before: seenTypes.has(fixType) — one 'misleading_claim' survives,
//               the other 3 distinct claims get dropped
//       After:  seenTypes.has(`${fixType}:${location.slice(0,50)}`) —
//               distinct violations at different locations all write
//   ~ Nothing else changed. Prompt, channel rules, output format unchanged.

import crypto from 'crypto';

const APP_URL = 'https://sendwize-backend.vercel.app';

// ─── Evidence-only violation detection ───────────────────────────────────
// A violation is "evidence-required" only when the fix is: prove you have
// documentary evidence on file. NOT when the fix is: add missing content
// to the copy.

// Regulations that are inherently substantiation contexts.
// Tight list: CAP 3.7 (evidence), 12.1 (health), 15.1/15.2/15.6/15.7 (nutrition
// and food supplement claims). NOT CAP 3.9/3.10 (material omission), NOT CAP 3.1
// (misleading generally), NOT unrelated CAP rules that happen to mention 'evidence'.
const EVIDENCE_REGULATIONS = [
  /cap\s*(code)?\s*3\.7\b/i,
  /cap\s*(code)?\s*12\.1\b/i,
  /cap\s*(code)?\s*15\.(1|2|6|7)\b/i,
  /nhc register/i,
  /gb\s*nutrition\s*and\s*health\s*claims/i,
];

// Recommendation phrases that unambiguously mean "you must hold evidence".
// Tight list. Removed /evidence.*before.*campaign/i (matched "add offer terms
// before sending" false positives) and /substantiat/i (too broad).
const EVIDENCE_PHRASES = [
  /hold.*(documentary\s+)?evidence.*(on file|before)/i,
  /documentary\s+evidence\s+(must\s+)?(be\s+)?held/i,
  /confirm.*you\s+hold.*evidence/i,
  /evidence\s+must\s+(exist|be\s+held)\s+before\s+(the\s+)?(ad|campaign|send)/i,
];

// Explicit fixTypes that are always evidence-only (unchanged from v5.3).
const EVIDENCE_FIX_TYPES = new Set([
  'unauthorised_health_claim',
  'unsubstantiated_comparative_claim',
]);

// Explicit exclusions — even if the text looks like it matches an evidence
// pattern, these violation types are content fixes, not evidence certifications.
// CAP 3.9 / 3.10 = material information omission (add missing T&Cs, disclosures).
// The user cannot "certify they have this on file" because the fix is to add
// missing content to the email itself.
const NON_EVIDENCE_REGULATIONS = [
  /cap\s*(code)?\s*3\.(9|10)\b/i,
  /material\s+information\s+omission/i,
  /pecr\s*reg\s*(22|23)/i,       // consent / sender identity — content/process fixes
  /uk\s*gdpr\s*article\s*(6|7|13|14|17)/i, // consent / transparency / rights — content/process fixes
  /fsma|fca\s*(handbook|cobs|conc)/i,       // FCA financial promotion approval — process gateway, not evidence
];

function isEvidenceViolation(violation) {
  const combined = `${violation.regulation || ''} ${violation.issue || ''} ${violation.recommendation || ''}`;

  // Explicit non-evidence overrides win — check first.
  if (NON_EVIDENCE_REGULATIONS.some(re => re.test(combined))) return false;

  // Explicit evidence fix types.
  if (EVIDENCE_FIX_TYPES.has(violation._fixType)) return true;

  // Regulation pattern match.
  if (EVIDENCE_REGULATIONS.some(re => re.test(combined))) return true;

  // Recommendation phrase match.
  if (EVIDENCE_PHRASES.some(re => re.test(combined))) return true;

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

Material omission scoping -- do NOT confuse content omission (missing T&Cs, missing disclosures, missing offer terms, missing risk warnings) with substantiation. Content omission is CAP 3.9/3.10 and is a copy fix (add the missing content). Substantiation is CAP 3.7 and is an evidence gate (marketer must hold evidence on file). Never combine these in one violation.

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

[ZMLUK LIMITED -- GBP105,000 -- December 2025 -- Reg 22 PECR]
Sent ~67.8 million marketing emails using data purchased from a third-party lead generation website.

[HELLOFRESH -- GBP140,000 -- January 2024 -- Reg 22 PECR]
Single tick box bundled age verification, free sample consent, and marketing consent.

[WE BUY ANY CAR (WBAC) -- GBP200,000 -- September 2021 -- Reg 22 PECR]
Claimed soft opt-in but the opt-out was only presented after customers received their valuation.

[SAGA SERVICES & SAGA PERSONAL FINANCE -- GBP150,000 + GBP75,000 -- September 2021 -- Reg 22 PECR]
Sent 128m+ unsolicited emails relying on 'indirect consent' collected by affiliate partners.

[EASYLIFE LTD -- GBP130,000 (PECR) + GBP250,000 (UK GDPR) -- October 2022]
1.3m+ unsolicited calls to TPS-registered individuals.

------------------------------------------------------------

SECTION 4 -- UK GDPR RULES

Article 5: Lawfulness, fairness, transparency. Purpose limitation. Data minimisation.
Article 6: Consent (6(1)(a)) or legitimate interests (6(1)(f)). LI requires genuine balance test. Pre-ticked boxes = not consent. Bundled consent = not consent.
Article 7: Consent must be as easy to withdraw as to give. Granular -- separate consent for different purposes.
Articles 13/14: At collection must state: controller identity, purpose and legal basis, retention period, data subject rights.
Article 17: Unsubscribes must be actioned promptly.

------------------------------------------------------------

SECTION 5 -- ASA CAP CODE RULES

CAP 2.1: Marketing must be obviously identifiable. #ad required for influencer/paid partnership content.
CAP 3.1: Must not materially mislead.
CAP 3.2: Puffery allowed.
CAP 3.3: Must not mislead by omitting material information.
CAP 3.7: Evidence must be held before the campaign runs. [SUBSTANTIATION — evidence-required category]
CAP 3.9: Significant limitations and qualifications must be stated. [CONTENT OMISSION — copy fix, NOT evidence-required]
CAP 3.10: Qualifications must be presented clearly. [CONTENT OMISSION — copy fix, NOT evidence-required]
CAP 3.12: Must not present legal rights as a distinctive feature.
CAP 3.17: Price statements must not mislead.
CAP 3.22-3.30: Various pricing, free claims, urgency, scarcity rules.
CAP 3.33--3.35: Comparative claims must be like-for-like and objective.
CAP 3.44-3.47: Reviews and testimonials rules.
CAP 3.52: Trust marks require authorisation.
CAP 8.17: Promotions must state closing dates.
CAP 12.1: Health claims must be substantiated. [SUBSTANTIATION — evidence-required category]
CAP 15.1: Nutrition/health claims must be authorised on the GB NHC Register. [SUBSTANTIATION — evidence-required category]
CAP 15.6.3: Health claims from individual health professionals not acceptable for food supplements.
CAP 14.1: Financial promotions must be fair, clear and not misleading.
CAP 16.1: Gambling ads not to appeal to under-18s.
CAP 18.1: Alcohol ads not to appeal to under-18s.

------------------------------------------------------------

SECTION 6 -- CMA RULES

DMCCA 2024 in force from 6 April 2025.
Schedule 20 -- Banned practices (automatically unfair): fake reviews, false urgency, bait ads, false limited time.
s.226 -- Misleading actions.
s.227 -- Misleading omissions (drip pricing).
s.228 -- Aggressive practices.
Direct CMA fines up to 10% global turnover or GBP300,000.

------------------------------------------------------------

SECTION 7 -- SECTOR-SPECIFIC RULES

FINANCIAL SERVICES: FCA approval (s.21 FSMA 2000) required for financial promotions. Risk warnings mandatory. This is a process gateway — the promotion must be approved by an FCA-authorised firm BEFORE sending. It is NOT an evidence-on-file substantiation issue.
HEALTH & SUPPLEMENTS: Only authorised health claims. MHRA for medicinal claims.
FOOD & DRINK, GAMBLING, E-COMMERCE, B2B: as per detailed rules.

------------------------------------------------------------

SECTION 8 -- RED FLAGS

SENDING CONTEXT (first): purchased/rented lists, indirect consent, soft opt-in failures, sender/consent mismatch.
URGENCY & SCARCITY: countdown without date, fake "only X left".
PRICING: fake was/now, drip pricing, hidden conditions.
CLAIMS: superlatives as fact, no source, comparative claims.
CONSENT: pre-ticked, bundled, unnamed partners.
IDENTITY: no #ad, undisclosed reviews, concealed sender, unauthorised trust marks.
ENVIRONMENTAL: vague sustainability claims.
VULNERABLE AUDIENCES: children, financial difficulty, health anxiety.

------------------------------------------------------------

SECTION 9 -- FEW-SHOT EXAMPLES (illustrative only, not exhaustive)

FAKE URGENCY: "ends tonight" without a specific date and time — CAP 3.7 / DMCCA Schedule 20 critical/high.

FAKE URGENCY FIX: replace vague deadline with a real one, keep the energy.

FREE CLAIM WITH HIDDEN CONDITIONS: "FREE gift" that requires GBP20 minimum purchase without prominent disclosure — CAP 3.9 (material omission, NOT evidence).

CONSENT BUNDLING: "By clicking Sign Up you agree to receive marketing from us and partners" — UK GDPR Article 7 / PECR Reg 22 critical.

HEALTH CLAIM (evidence-required): "Boost your immune system" without a specific authorised claim — CAP 12.1 / 3.7. This IS evidence-required — marketer confirms they hold the GB NHC Register basis on file.

MATERIAL OMISSION (NOT evidence-required): "No terms and conditions" or "no risk warning" or "no offer terms" — CAP 3.9/3.10. This is a CONTENT fix — the marketer must ADD the missing content. Do NOT flag as requiresEvidence.

FCA FINANCIAL PROMOTION UNAPPROVED (NOT evidence-required): sending without FCA approval under s.21 FSMA — this is a PROCESS GATEWAY, not evidence. The fix is: get approval before sending. Do NOT flag as requiresEvidence.

REFERENCE PRICING: "WAS GBP200 NOW GBP49" without genuine sale history — DMCCA s.226 critical.

PUFFERY: "UK's most loved" — not a violation.

AUTHORISED HEALTH CLAIM: "Vitamin D contributes to normal immune function" — not a violation.

SPECIFIC DATE URGENCY: "Sale ends 23:59 Sunday 16 March 2026" — not a violation.

------------------------------------------------------------

SECTION 10 -- SEVERITY CALIBRATION & VERDICT LABELS

SEVERITY:
critical: Enforcement action likely. Examples: sending without PECR consent, fake urgency (banned practice), fabricated pricing, pre-ticked consent, no unsubscribe, third-party list without specific consent, fake reviews, FCA financial promotion sent without approval.
high: Clear rule breach. Examples: "free" without disclosing conditions, vague deadline, undisclosed influencer, bundled consent, greenwashing, missing material info (T&Cs, risk warnings).
medium: Probable rule breach. Less immediately enforceable. Examples: missing privacy policy link, vague testimonials, "limited stock" without evidence.
low: Best practice gap.

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
  if (isEvidenceViolation(violation)) return null;

  const combined = `${violation.issue || ''} ${violation.regulation || ''} ${violation.recommendation || ''}`.toLowerCase();

  // Order matters — more specific patterns first.
  if (combined.match(/unsubscribe|opt.out/))                                             return 'missing_unsubscribe';
  if (combined.match(/pre.tick|bundled consent/))                                        return 'invalid_consent_mechanism';
  if (combined.match(/no consent|without consent|unsolicited|pecr.*consent|reg\s*22/))   return 'no_consent';
  if (combined.match(/soft opt.in/))                                                     return 'no_soft_optin';
  if (combined.match(/sender.*conceal|sender.*identity|reg\s*23|identify.*organisation/)) return 'concealed_sender';
  if (combined.match(/fca.*(approval|authorised|firm reference|s\.?\s*21|fsma)/))        return 'misleading_claim'; // FCA process — writes as ASA-category misleading_claim for now
  if (combined.match(/risk warning|capital.at.risk|past performance/))                   return 'misleading_claim';
  if (combined.match(/fake urgency|false urgency|ends soon|ends tonight|flash sale/))    return 'fake_urgency';
  if (combined.match(/fake scarcity|only \d+ left/))                                     return 'fake_scarcity';
  if (combined.match(/reference pric|was.*now|fabricated.*price/))                       return 'misleading_reference_price';
  if (combined.match(/free.*condition|free.*hidden|cap.*3\.9/))                          return 'missing_terms';
  if (combined.match(/material omission|terms.*condition|offer terms|t&c|disclosure/))   return 'missing_terms';
  if (combined.match(/testimonial|fake review|incentivi.*review/))                       return 'misleading_testimonial';
  if (combined.match(/influencer|#ad/))                                                  return 'undisclosed_ad';
  if (combined.match(/drip pric|hidden fee/))                                            return 'drip_pricing';
  if (combined.match(/greenwash|sustainable|carbon neutral/))                            return 'misleading_claim';
  if (combined.match(/privacy policy/))                                                  return 'no_privacy_policy';
  if (combined.match(/postal address|registered address/))                               return 'missing_address';
  if (combined.match(/third.party.*list|purchased.*data/))                               return 'third_party_list';
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
  // v5.4: dedup by fixType + location, not by fixType alone.
  // Prevents distinct violations at different locations (e.g. two misleading_claim
  // violations — one in subject, one in body) from collapsing into a single fix.
  const seenKeys = new Set();
  const fixJobs   = [];

  for (const v of (allViolations || [])) {
    if (v.requiresEvidence) continue;
    const fixType = mapViolationToFixType(v);
    if (!fixType) continue;
    const loc = String(v.location || '').slice(0, 50);
    const dedupKey = `${fixType}|${loc}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    const source = v._fromContext ? 'Sending Context' : 'AI Checker';
    fixJobs.push({
      fixType,
      description: `${source}: ${v.issue || 'Compliance issue'} (${v.location || 'content'}) -- ${v.recommendation || 'Review required'}`,
      severity: mapViolationToSeverity(v),
    });
  }

  for (const c of (emailChecks || [])) {
    if (!c.fixType || c.status === 'pass') continue;
    const dedupKey = `${c.fixType}|${c.title || 'email-check'}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    fixJobs.push({
      fixType: c.fixType,
      description: `Email Scanner: ${c.title} -- ${c.description}`,
      severity: c.status === 'fail' ? 'high' : 'medium',
    });
  }

  for (const job of fixJobs) {
    try {
      const r = await fetch(`${APP_URL}/api/generate-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          fixType: job.fixType,
          description: job.description,
          tool: 'AI Checker',
          severity: job.severity,
          volume: null,
          sourceRecordId,
        }),
      });
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

    if (allViolations.length > 0) {
      try { await generateFixes(userId, allViolations, [], savedRecordId); }
      catch (e) { console.error('generateFixes error:', e); }
    }

    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    const cleanViolations = allViolations.map(({ _fromContext, _fixType, ...rest }) => rest);
    return res.status(200).json({ ...aiAnalysis, score: finalScore, verdict: finalVerdict, violations: cleanViolations, contentType, checkHash, sourceRecordId: savedRecordId });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
