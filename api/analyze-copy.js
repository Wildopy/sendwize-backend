// api/analyze-copy.js  v5.5
// AI Copy Scanner
//
// v5.5 changes from v5.4:
//   ~ Prompt updated: evidence items now output as SEPARATE violations
//     with requiresEvidence:true, not as [EVIDENCE REQUIRED:] markers
//     embedded in fix text.
//     Rationale: a critical violation ("cannot use word Guaranteed") and
//     a substantiation gate ("hold audited fund data on file") are two
//     distinct decisions. Users must fix the copy AND certify the evidence.
//     Regulator-accurate; matches the Compliance_Fixes vs Evidence_Certifications
//     data model.
//   + Added explicit few-shot showing critical + evidence pair for same claim.
//   + isEvidenceViolation() now trusts AI's explicit requiresEvidence flag
//     as primary signal; regex is fallback only.
//   + Post-process: strip [EVIDENCE REQUIRED: ...] markers from any
//     recommendation or fixedVersion text (belt and braces).

import crypto from 'crypto';

const APP_URL = 'https://sendwize-backend.vercel.app';

// v5.5: primary signal is AI's own requiresEvidence flag. Regex is fallback.
const EVIDENCE_REGULATIONS = [
  /cap\s*(code)?\s*3\.7\b/i,
  /cap\s*(code)?\s*12\.1\b/i,
  /cap\s*(code)?\s*15\.(1|2|6|7)\b/i,
  /nhc register/i,
  /gb\s*nutrition\s*and\s*health\s*claims/i,
];

const EVIDENCE_PHRASES = [
  /hold.*(documentary\s+)?evidence.*(on file|before)/i,
  /documentary\s+evidence\s+(must\s+)?(be\s+)?held/i,
  /confirm.*you\s+hold.*evidence/i,
  /evidence\s+must\s+(exist|be\s+held)\s+before\s+(the\s+)?(ad|campaign|send)/i,
];

const EVIDENCE_FIX_TYPES = new Set([
  'unauthorised_health_claim',
  'unsubstantiated_comparative_claim',
  'unsubstantiated_performance_claim',
]);

const NON_EVIDENCE_REGULATIONS = [
  /cap\s*(code)?\s*3\.(9|10)\b/i,
  /material\s+information\s+omission/i,
  /pecr\s*reg\s*(22|23)/i,
  /uk\s*gdpr\s*article\s*(6|7|13|14|17)/i,
];

function isEvidenceViolation(violation) {
  if (violation.requiresEvidence === true)  return true;
  if (violation.requiresEvidence === false) return false;

  const combined = `${violation.regulation || ''} ${violation.issue || ''} ${violation.recommendation || ''}`;

  if (NON_EVIDENCE_REGULATIONS.some(re => re.test(combined))) return false;
  if (EVIDENCE_FIX_TYPES.has(violation._fixType)) return true;
  if (EVIDENCE_REGULATIONS.some(re => re.test(combined))) return true;
  if (EVIDENCE_PHRASES.some(re => re.test(combined))) return true;
  return false;
}

function stripEvidenceMarkers(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*\[EVIDENCE REQUIRED:[^\]]*\]\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
7. Generate a compliant rewrite following the REWRITE RULES in Section 2B exactly.

------------------------------------------------------------

SECTION 2A -- CRITICAL RULE: CRITICAL VIOLATIONS vs EVIDENCE CHECKS

Every claim in the copy falls into ONE of three categories. You must classify accurately.

CATEGORY 1 -- CRITICAL VIOLATION (no evidence fixes it)
Some statements are simply not allowed under any circumstances, regardless of what evidence the marketer holds. Examples:
* "Guaranteed 20% returns" -- cannot use "Guaranteed" for a market-linked product (FCA COBS 4.2)
* "Capital is guaranteed and investors cannot lose money" -- false statement of fact
* "We're confident it will continue to perform at this level" -- forward-looking projection as certainty
* "No risk of losing your investment" -- misleading statement of fact
* Fake urgency without genuine deadline
* Pre-ticked consent
* Missing unsubscribe

For these: output as a violation. Set requiresEvidence: false. The fix is to REMOVE OR REWORD the offending statement.

CATEGORY 2 -- EVIDENCE CHECK (evidence on file makes it OK)
Some claims are lawful if the marketer holds documentary evidence on file. Examples:
* "20% returns for the past 5 years" -- lawful with audited performance data + past-performance disclaimer
* "UK's best-value service" -- lawful with a price-comparison study
* "Boost your immune system" -- lawful with an authorised health claim from the GB NHC Register
* "Only 50 places available" -- lawful with a documented, enforceable cap
* "Clinically proven to reduce wrinkles" -- lawful with a clinical trial

For these: output as a violation with requiresEvidence: true. The fix is to CONFIRM YOU HOLD THE EVIDENCE. The user will tick a certification box.

CATEGORY 3 -- BOTH (same underlying claim triggers both)
Sometimes ONE part of the copy triggers BOTH a critical violation AND a separate evidence check. Example:
* "Our fund has delivered 20% returns every year for 5 years, and we're confident it will continue to perform at this level."
  - Critical violation: forward-looking confidence statement ("we're confident it will continue") -- must be removed. No evidence fixes this.
  - Evidence check: 5-year past performance claim ("20% returns every year for 5 years") -- lawful with audited data + mandatory past-performance disclaimer.

For these: output TWO SEPARATE violations. One critical, one with requiresEvidence: true. Distinct decisions the marketer must make.

CRITICAL FORMATTING RULE 1: Never embed "[EVIDENCE REQUIRED: ...]" markers inside a violation's recommendation. If evidence is required, output it as a separate violation with requiresEvidence: true.

CRITICAL FORMATTING RULE 2: Never embed "[EVIDENCE REQUIRED: ...]" markers inside the fixedVersion rewrite. The rewrite should be clean copy the marketer could send. Any evidence checks belong in the violations array only.

CRITICAL FORMATTING RULE 3: Every violation MUST have an explicit requiresEvidence boolean field. Do not omit this.

------------------------------------------------------------

SECTION 2B -- REWRITE RULES

The fixedVersion must fix every critical violation. It must NOT flatten the copy into generic compliance language.

CORE PRINCIPLE: Fix only what is broken. Preserve everything that is not.

What "broken" means: false urgency without a date, unsubstantiated superlatives presented as fact, missing unsubscribe, concealed sender, fabricated pricing, prohibited health claims, forward-looking projections presented as certainty, "guaranteed" claims for market-linked products.

What is NOT broken and must be preserved:
* Energy, urgency, enthusiasm (where not tied to a false claim)
* Punchy sentence structure, short paragraphs
* CTAs and their verb strength
* Brand voice, tone, personality
* The commercial argument

PER-CHANNEL REWRITE INSTRUCTIONS:

EMAIL: Subject line: keep energy, fix only the false element. Body: keep paragraph length and rhythm. CTAs: preserve verbs. Compliance elements as minimal footer.

SMS: Never longer than original unless STOP was missing. Keep urgency verb.

SOCIAL: Hook line sacred. Hashtags preserved. Same length ±20%.

PUSH: 40-60 words. Fewest words. Keep action verb.

DIRECT MAIL: Preserve narrative. Headline punch critical.

UNIVERSAL:
* Never add qualifications inline breaking flow. Put in "Offer terms:" block at end.
* Never remove a real offer.
* Never replace first-person brand voice with passive voice.
* Do NOT include "[EVIDENCE REQUIRED: ...]" or any bracketed evidence markers in the rewrite.

------------------------------------------------------------

SECTION 3 -- PECR RULES

Reg 22 -- Consent for electronic marketing (individuals need prior consent or soft opt-in; B2B corporate emails more flexible; sole traders and partnerships still need consent).
Reg 22 -- Unsubscribe (every marketing message must have simple, free, working opt-out).
Reg 23 -- Sender identity (must not be disguised or concealed).
Reg 6 -- Cookies and tracking (DUAA 2025 updates).

Recent ICO PECR cases (illustrative):
[ALLAY CLAIMS LTD -- GBP120,000 -- January 2026 -- Reg 22 PECR] ~4m unsolicited SMS
[ZMLUK LIMITED -- GBP105,000 -- December 2025 -- Reg 22 PECR] ~67.8m emails using purchased data
[HELLOFRESH -- GBP140,000 -- January 2024 -- Reg 22 PECR] Bundled consent
[WE BUY ANY CAR -- GBP200,000 -- September 2021 -- Reg 22 PECR] Soft opt-in failure
[SAGA -- GBP150,000 + GBP75,000 -- September 2021 -- Reg 22 PECR] Indirect consent via affiliates
[EASYLIFE -- GBP130,000 (PECR) + GBP250,000 (UK GDPR) -- October 2022] TPS breach

------------------------------------------------------------

SECTION 4 -- UK GDPR RULES

Article 5: Lawfulness, fairness, transparency. Article 6: Consent or LI. Pre-ticked = not consent. Article 7: Consent as easy to withdraw as give. Articles 13/14: Controller identity, purpose, retention, rights at collection. Article 17: Unsubscribes actioned.

------------------------------------------------------------

SECTION 5 -- ASA CAP CODE RULES

CAP 2.1: Marketing obviously identifiable. #ad required.
CAP 3.1: Must not materially mislead.
CAP 3.2: Puffery allowed.
CAP 3.3: Must not mislead by omission.
CAP 3.7: Evidence must be held before campaign runs. [EVIDENCE CHECK]
CAP 3.9: Significant limitations must be stated. [CRITICAL -- content omission]
CAP 3.10: Qualifications clear. [CRITICAL -- content omission]
CAP 3.17: Price statements not misleading.
CAP 3.22-3.30: Pricing, free claims, urgency, scarcity.
CAP 3.33-3.35: Comparative claims like-for-like.
CAP 3.44-3.47: Reviews and testimonials.
CAP 8.17: Promotions state closing dates.
CAP 12.1: Health claims substantiated. [EVIDENCE CHECK]
CAP 14.1: Financial promotions fair, clear, not misleading. [CRITICAL for forward-looking or guaranteed]
CAP 15.1: Nutrition/health claims authorised on GB NHC Register. [EVIDENCE CHECK]

------------------------------------------------------------

SECTION 6 -- CMA RULES

DMCCA 2024 in force from 6 April 2025. Schedule 20 banned practices (fake reviews, false urgency, bait ads). s.226 misleading actions. s.227 misleading omissions. s.228 aggressive practices. Direct CMA fines up to 10% global turnover or GBP300,000.

------------------------------------------------------------

SECTION 7 -- SECTOR-SPECIFIC RULES

FINANCIAL SERVICES: FCA approval (s.21 FSMA 2000) required for financial promotions. Risk warnings mandatory. This is a PROCESS GATEWAY, not evidence.

FCA COBS 4.2: Financial promotions fair, clear, not misleading. "Guaranteed" cannot be used for market-linked products. Forward-looking statements as certainty prohibited. [CRITICAL -- cannot be fixed by evidence]

FCA COBS 4.6: Past performance shown only with:
* 5+ years of data (or full life if shorter)
* Mandatory: "Past performance is not a reliable indicator of future returns"
* Prominent capital-at-risk warning
Past performance data itself is [EVIDENCE CHECK] -- user certifies audited data on file.
Presenting past performance as an indicator of future returns is [CRITICAL].

HEALTH & SUPPLEMENTS: Only authorised health claims. MHRA for medicinal claims.
FOOD & DRINK, GAMBLING, E-COMMERCE, B2B: as per detailed rules.

------------------------------------------------------------

SECTION 8 -- RED FLAGS

Consent chain (purchased lists, indirect consent, sender/consent mismatch).
Urgency/scarcity (countdown without date, fake "only X left").
Pricing (fake was/now, drip pricing, hidden conditions).
Claims (superlatives as fact, no source, comparative claims).
Consent (pre-ticked, bundled, unnamed partners).
Identity (no #ad, undisclosed reviews, concealed sender, unauthorised trust marks).
Environmental (vague sustainability).
Vulnerable audiences (children, financial difficulty, health anxiety).
Financial ("guaranteed", forward-looking, missing risk warnings, past performance without disclaimer).

------------------------------------------------------------

SECTION 9 -- FEW-SHOT EXAMPLES

FAKE URGENCY (CRITICAL, requiresEvidence: false): "ends tonight" without date. Fix: use specific date.

FREE WITH HIDDEN CONDITIONS (CRITICAL, requiresEvidence: false): "FREE gift" requiring GBP20 min without disclosure. Fix: add disclosure.

CONSENT BUNDLING (CRITICAL, requiresEvidence: false): Bundled marketing consent. Fix: separate opt-in.

HEALTH CLAIM (EVIDENCE CHECK, requiresEvidence: true): "Boost your immune system" without authorised claim. Recommendation: "Confirm you hold the GB NHC Register authorised claim reference for this statement."

MATERIAL OMISSION (CRITICAL, requiresEvidence: false): "No T&Cs" or "no risk warning" -- CAP 3.9/3.10. Fix: add missing content.

FCA UNAPPROVED (CRITICAL, requiresEvidence: false): Financial promotion without s.21 approval. Fix: obtain approval before sending.

REFERENCE PRICING (CRITICAL, requiresEvidence: false): "WAS £200 NOW £49" without 28-day history. Fix: prove history or remove.

PUFFERY (not a violation): "UK's most loved".
AUTHORISED HEALTH CLAIM (not a violation): "Vitamin D contributes to normal immune function".
SPECIFIC DATE URGENCY (not a violation): "Sale ends 23:59 Sunday 16 March 2026".

------------------------------------------------------------

SECTION 9A -- WORKED EXAMPLE: CRITICAL + EVIDENCE ON SAME CLAIM

Input copy: "Our fund has delivered 20% returns every year for the past five years, and we're confident it will continue to perform at this level. Past performance is a reliable indicator of future returns."

Correct output -- THREE separate violations for this one paragraph:

Violation 1 (CRITICAL, requiresEvidence: false):
{
  "regulation": "FCA COBS 4.2",
  "severity": "critical",
  "issue": "'We're confident it will continue to perform at this level' is a forward-looking projection presented as near-certainty. FCA COBS 4.2 prohibits presenting future performance as reliable or guaranteed.",
  "location": "Email body, paragraph 1",
  "recommendation": "Remove the forward-looking confidence statement. Do not replace with any statement implying future returns are predictable.",
  "requiresEvidence": false
}

Violation 2 (CRITICAL, requiresEvidence: false):
{
  "regulation": "FCA COBS 4.6",
  "severity": "critical",
  "issue": "'Past performance is a reliable indicator of future returns' directly contradicts the mandatory FCA disclaimer. This statement is prohibited.",
  "location": "Email body, closing line",
  "recommendation": "Remove this sentence entirely. Replace with the mandatory FCA disclaimer: 'Past performance is not a reliable indicator of future returns. Capital at risk.'",
  "requiresEvidence": false
}

Violation 3 (EVIDENCE CHECK, requiresEvidence: true):
{
  "regulation": "FCA COBS 4.6",
  "severity": "high",
  "issue": "The claim of '20% returns every year for the past five years' requires audited historical performance data on file. We cannot verify whether you hold this data.",
  "location": "Email body, paragraph 1 -- past performance claim",
  "recommendation": "Confirm you hold audited five-year performance data for this fund on file, calculated in accordance with FCA COBS 4.6 methodology.",
  "requiresEvidence": true
}

Three violations from one paragraph. Two critical fixes (rewrite the copy). One evidence check (certify audited data exists). Do not combine. Do not embed [EVIDENCE REQUIRED:] markers.

------------------------------------------------------------

SECTION 10 -- SEVERITY & VERDICT

SEVERITY:
critical: Enforcement likely. PECR consent missing, fake urgency, fabricated pricing, pre-ticked consent, no unsubscribe, third-party list without consent, fake reviews, FCA without approval, "guaranteed" for market-linked, forward-looking projections.
high: Clear rule breach. "Free" without disclosure, vague deadline, undisclosed influencer, bundled consent, greenwashing, missing risk warnings, past performance requiring documented data (EVIDENCE CHECK).
medium: Probable breach.
low: Best practice gap.

VERDICTS (exact):
90-100, 0 critical/high: "No issues found"
75-89, 0 critical: "Minor issues to address"
50-74, 0 critical: "Review required before sending"
25-49 OR any critical: "Do not send -- address critical issues first"
0-24: "Significant violations identified"

SCORE: Start at 100. Critical: -25 to -35. High: -10 to -20. Medium: -5 to -10. Low: -1 to -5. Multiple same type: once. Min 0. Evidence-check counts as high for scoring.

------------------------------------------------------------

SECTION 11 -- OUTPUT FORMAT

Respond ONLY in this exact JSON. No preamble. No markdown fences.

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
      "requiresEvidence": false,
      "enforcement_note": "Only when case is virtually identical. Omit if uncertain."
    },
    {
      "regulation": "CAP Code 12.1 / GB NHC Register",
      "severity": "high",
      "issue": "Health claim 'boosts immunity' requires an authorised claim reference on file.",
      "location": "Body paragraph 2",
      "recommendation": "Confirm you hold the GB NHC Register authorised claim reference for this statement.",
      "requiresEvidence": true
    }
  ],
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION. Follow Section 2B rules. Fix critical violations by rewriting. Do NOT include [EVIDENCE REQUIRED:] markers. Clean sendable copy.",
  "summary": "One sentence plain English assessment."
}

EVERY violation MUST have a requiresEvidence boolean. Do not omit this field.
`;

const CHANNEL_RULES = {
  email: `CHANNEL: EMAIL
Apply: PECR Reg 22 (consent / soft opt-in), Reg 23 (sender identity), UK GDPR, ASA CAP Code, CMA/DMCCA rules, plus sector rules (FCA for financial services).
Check: unsubscribe mechanism, postal address, sender identification, consent signals, all CAP Code and DMCCA red flags, plus any sector-specific rules that apply.
Rewrite: follow Section 2B EMAIL rules. Subject line energy is sacred. Add compliance elements as minimal footer. No [EVIDENCE REQUIRED:] markers.`,

  sms: `CHANNEL: SMS
Apply: PECR Reg 22 (stricter than email), ASA CAP Code.
Additional: STOP opt-out mandatory. Flag if over 160 chars. Sender identity clear from opening. Plain text only.
Rewrite: follow Section 2B SMS rules. Never longer. STOP minimal.`,

  push: `CHANNEL: PUSH
Apply: PECR Reg 22, ASA CAP Code.
Check: consent likely at install, claim accuracy, urgency/scarcity.
Rewrite: follow Section 2B PUSH rules. Fewest words. Keep action verb.`,

  social: `CHANNEL: SOCIAL AD / POST
Apply: ASA CAP Code (primary), CMA/DMCCA.
DO NOT apply PECR Reg 22.
Check: #ad disclosure, misleading claims, fake urgency/scarcity, reference pricing, testimonials, greenwashing.
Rewrite: follow Section 2B SOCIAL rules. Hook sacred. Same length ±20%.`,

  directmail: `CHANNEL: DIRECT MAIL
Apply: UK GDPR (LI most common basis), ASA CAP Code, CMA/DMCCA.
DO NOT apply PECR Reg 22.
Check: LI validity, misleading claims, reference pricing, urgency, opt-out (MPS), sender identification.
Rewrite: follow Section 2B DIRECT MAIL rules. Preserve narrative and headline punch.`
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
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List purchased or rented from a third party. Recipients must have specifically consented to receive marketing from your organisation by name.', location: 'Sending context -- list source', recommendation: 'Do not send to this list until you can verify valid consent.', enforcement_note: 'ZMLUK (GBP105,000, December 2025) sent 67.8 million emails using purchased data.', requiresEvidence: false, _fixType: 'third_party_list', _fromContext: true });
  }
  if (ctx.listSource === 'partner') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List provided by a partner or affiliate -- indirect consent is insufficient for email or SMS marketing.', location: 'Sending context -- list source', recommendation: 'Each organisation sending marketing must have consent obtained specifically for their own communications.', enforcement_note: 'Saga Services (GBP225,000 combined, 2021) were fined for relying on indirect consent.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 22 / UK GDPR Article 7', severity: 'critical', issue: 'Recipients consented to a third party or "our partners" -- not to your organisation by name.', location: 'Sending context -- consent specificity', recommendation: 'Stop sending to this list. Consent must specifically name your organisation.', enforcement_note: 'ZMLUK (GBP105,000, 2025): consent covering 361 unnamed companies was invalid.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'notSure') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'high', issue: 'Consent basis is unclear. Do not send unless you can confirm valid consent.', location: 'Sending context -- consent specificity', recommendation: 'Verify your consent records before sending.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', _fromContext: true });
  }
  if (ctx.senderRelationship === 'thirdParty' && ctx.fromNameMatch === 'no') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'critical', issue: 'A third-party agency is sending on your behalf and the From name does not match the organisation that collected consent.', location: 'Sending context -- sender relationship and From name mismatch', recommendation: 'The From name must clearly identify the brand that collected consent.', enforcement_note: 'Join the Triboo (GBP130,000, 2023) sent emails appearing to come from third-party brands.', requiresEvidence: false, _fixType: 'concealed_sender', _fromContext: true });
  }
  if (ctx.fromNameMatch === 'no' && ctx.senderRelationship !== 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'high', issue: 'The From name does not match the organisation that collected consent.', location: 'Sending context -- From name mismatch', recommendation: 'Ensure the From name clearly identifies the organisation that collected consent.', requiresEvidence: false, _fixType: 'concealed_sender', _fromContext: true });
  }
  return violations;
}

function mapViolationToFixType(violation) {
  if (violation._fixType) return violation._fixType;
  if (isEvidenceViolation(violation)) return null;

  const combined = `${violation.issue || ''} ${violation.regulation || ''} ${violation.recommendation || ''}`.toLowerCase();

  if (combined.match(/unsubscribe|opt.out/))                                             return 'missing_unsubscribe';
  if (combined.match(/pre.tick|bundled consent/))                                        return 'invalid_consent_mechanism';
  if (combined.match(/no consent|without consent|unsolicited|pecr.*consent|reg\s*22/))   return 'no_consent';
  if (combined.match(/soft opt.in/))                                                     return 'no_soft_optin';
  if (combined.match(/sender.*conceal|sender.*identity|reg\s*23|identify.*organisation/)) return 'concealed_sender';
  if (combined.match(/fca.*(approval|authorised|firm reference|s\.?\s*21|fsma)/))        return 'misleading_claim';
  if (combined.match(/guaranteed|guarantee.*return|forward.looking|cobs\s*4\.2/))        return 'misleading_claim';
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
  const seenKeys = new Set();
  const fixJobs  = [];

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

    const userMessage = `${CHANNEL_RULES[contentType]}\n\nCONTENT TO ANALYSE:\n${analysisContent}${autoFix ? '\nGenerate a fixedVersion field in the JSON following the Section 2B rewrite rules exactly. Fix compliance issues. Preserve brand voice, energy, and marketing punch. Do NOT include [EVIDENCE REQUIRED:] markers in the rewrite.' : ''}`;

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

    // v5.5: strip any leftover [EVIDENCE REQUIRED:] markers from AI output
    if (aiAnalysis.fixedVersion) aiAnalysis.fixedVersion = stripEvidenceMarkers(aiAnalysis.fixedVersion);

    // Tag AI violations, respecting AI's explicit requiresEvidence flag
    const taggedAiViolations = (aiAnalysis?.violations || []).map(v => {
      const cleaned = { ...v };
      if (cleaned.recommendation) cleaned.recommendation = stripEvidenceMarkers(cleaned.recommendation);
      cleaned.requiresEvidence = isEvidenceViolation(cleaned);
      return cleaned;
    });

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
