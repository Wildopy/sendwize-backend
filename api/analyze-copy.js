// api/analyze-copy.js  v6.0
// v6.0 (10 Nov 2026), from the 25-email test set (data/copy-test-set.json):
//   + Facts read by code first (_copy-review.js copyFacts): opt-out, named
//     sender, company recipient, dated/relative deadline, countdown,
//     swearing. Sent to the AI as settled and enforced after it answers.
//   + Every finding carries an issue_type (_copy-issues.js). House rules
//     (reviewFindings): relative deadlines are medium plus an evidence
//     check, stock and was/now claims are evidence checks, one finding per
//     single issue, swearing is a Hold, non-marketing text is never a Go.
//   + Score comes from the final findings (copyScore), not the AI.
//   + A case is shown only when it is about the same issue, never on low
//     notes or evidence checks (caseForIssue). No more HelloFresh on every
//     opt-out finding.
//   + The rewrite may not add facts: new figures and any claim the original
//     didn't make become [check: ...] placeholders (guardRewrite).
//   + Identical copy (and context, images, engine version) returns the
//     saved answer, so a re-run never changes the verdict.
// v5.6 (security): every request authenticated via _auth.js; the verified
//   member id replaces any userId from the browser. Calls to generate-fix
//   and profile carry the internal secret.
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

import { claudeFetch, parseJson, LEGAL_RULES } from './_claude.js';
import crypto from 'crypto';
import { requireAuth, internalHeaders, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import { fq } from './_airtable.js';
import { sendCall } from './_send-call.js';
import { ISSUE_IDS, issueOf } from './_copy-issues.js';
import { copyFacts, factsBlock, reviewFindings, copyScore, guardRewrite, guessIssue } from './_copy-review.js';
import { caseForIssue } from './_exposure.js';

// Bump when the prompt or the house rules change, so saved answers for
// identical copy are not reused across versions.
export const COPY_ENGINE = 'copy-6.0';

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

export const SYSTEM_PROMPT = `
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
* A countdown in minutes or hours, or urgency with no end at all ("ends soon", "last chance")
* Pre-ticked consent
* Missing unsubscribe (email and SMS only)
* Swearing, abuse or content likely to cause serious offence (CAP 4.1)

For these: output as a violation. Set requiresEvidence: false. The fix is to REMOVE OR REWORD the offending statement.

CATEGORY 2 -- EVIDENCE CHECK (evidence on file makes it OK)
Some claims are lawful if the marketer holds documentary evidence on file. Examples:
* "20% returns for the past 5 years" -- lawful with audited performance data + past-performance disclaimer
* "UK's best-value service" -- lawful with a price-comparison study
* "Vitamin C contributes to the normal function of the immune system" -- lawful when the product meets the GB NHC Register conditions for that authorised claim
* "Only 50 places available" or "only 4 left" -- lawful when the number is true
* "Was £249, now £179" -- lawful with records showing £249 was the genuine selling price
* "Sale ends 23:59 Sunday 16 November" -- lawful when the deadline is genuine and enforced
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
* NEVER ADD FACTS. The rewrite must not state anything the original didn't: no new product facts, materials, benefits, endorsements, prices, what a price includes, dates, times, stock levels, terms, company details, lawful basis, or how the reader's details were collected. Where a fix needs information you don't have, write a [square-bracket placeholder], e.g. [end date], [registered office address], [why they're receiving this]. Removing or softening a claim is fine; inventing a replacement claim is not.
* Never add qualifications inline breaking flow. Put in "Offer terms:" block at end, using only conditions the original states, or [placeholders].
* Never remove a real offer.
* Never replace first-person brand voice with passive voice.
* Do NOT include "[EVIDENCE REQUIRED: ...]" or any bracketed evidence markers in the rewrite.

------------------------------------------------------------

SECTION 2C -- ISSUE TYPES, FACTS AND WHAT NOT TO FLAG

Every finding carries an issue_type from this fixed list: ${ISSUE_IDS.join(', ')}.
Use the most specific one. One finding per issue: never merge two issues (e.g. a missing unsubscribe and a missing sender) into one finding, and never raise the same issue twice.

A [FACTS CHECKED BY CODE] block comes with the copy. Those facts are settled: if it says an opt-out is present or the sender is named, do not raise a finding saying otherwise.

Set content_kind: "marketing" for promotional copy; "service" for a purely transactional message (order, delivery, account) with no promotion; "not_marketing" for anything with no product, offer or brand message (a test, a greeting, abuse).

Do NOT flag:
* A sender who is clearly named (in the From line, an SMS prefix like "Brand:", or the footer). Only flag the sender when it is missing or disguised.
* Consent on an email to a company address (corporate subscriber).
* A creator's or customer's honest opinion as something to substantiate.
* Puffery nobody would read as measurable ("the comfiest sofa you'll ever sink into").
* Missing unsubscribe or postal address on social posts or push notifications.
* Conditions that are already stated in the copy (e.g. a closing date that is given).

------------------------------------------------------------

SECTION 3 -- PECR RULES

Reg 22 -- Consent for electronic marketing (individuals need prior consent or soft opt-in; B2B corporate emails more flexible; sole traders and partnerships still need consent).
Reg 22 -- Unsubscribe (every marketing email or SMS must give a simple, free way to opt out). Say "a simple, free way to opt out". Do not say a one-click link is required: one-click is good practice and a Gmail/Yahoo bulk-sender requirement, not a PECR rule.
Corporate subscribers: emails to a company address need no prior consent (sole traders and partnerships do). Opt-out and sender identity still apply.
Service messages (order, delivery, account updates with no promotion) are not marketing: no opt-out or consent finding.
Push notifications: no unsubscribe or postal address finding (opt-out is in device settings). Treat consent as an evidence check only.
Company details: a company's marketing emails are expected to show its name, registered number and registered office (Companies Act trading disclosures). If missing, that is LOW severity, cite the Companies Act, not PECR. PECR Reg 23 only needs the sender not to be disguised and a valid address (an email address is enough) for opt-out requests.
Reg 23 -- Sender identity (must not be disguised or concealed).
Reg 6 -- Cookies and tracking (DUAA 2025 updates).

Do not name or cite enforcement cases. Sendwize attaches the closest published case to each issue itself, from its verified case library.

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
CAP 4.1: Must not cause serious or widespread offence (swearing, abuse, shock content). [CRITICAL]
CAP 8.17: Promotions state closing dates. A relative deadline in an email ("tonight", "midnight", "before Friday") is MEDIUM: ask for the date, because emails are opened later. A dated deadline is an EVIDENCE CHECK that it is genuine.
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

COUNTDOWN (CRITICAL, requiresEvidence: false, issue_type fake_urgency): "checkout in the next 10 minutes", or "ends soon" with no end. Fix: use a genuine, specific end date and time.
RELATIVE DEADLINE (MEDIUM, requiresEvidence: false, issue_type deadline_unclear): "ends at midnight tonight" in an email. Fix: give the date and time. Plus a separate EVIDENCE CHECK (issue_type fake_urgency) that the deadline is genuine.

FREE WITH HIDDEN CONDITIONS (CRITICAL, requiresEvidence: false): "FREE gift" requiring GBP20 min without disclosure. Fix: add disclosure.

CONSENT BUNDLING (CRITICAL, requiresEvidence: false): Bundled marketing consent. Fix: separate opt-in.

HEALTH CLAIM WORDING (HIGH, requiresEvidence: false, issue_type health_claim): "Boost your immune system" is not authorised wording; evidence can't fix it. Fix: use the authorised wording (e.g. "Vitamin C contributes to the normal function of the immune system") if the product qualifies.
AUTHORISED HEALTH CLAIM (EVIDENCE CHECK, requiresEvidence: true): "Vitamin D contributes to normal immune function". Recommendation: "Confirm the product meets the GB NHC Register conditions of use for this claim."

MATERIAL OMISSION (CRITICAL, requiresEvidence: false): "No T&Cs" or "no risk warning" -- CAP 3.9/3.10. Fix: add missing content.

FCA UNAPPROVED (CRITICAL, requiresEvidence: false): Financial promotion without s.21 approval. Fix: obtain approval before sending.

REFERENCE PRICING (EVIDENCE CHECK, requiresEvidence: true, issue_type reference_price): "WAS £200 NOW £49" or "RRP £129". Confirm the higher price was genuinely charged (or widely charged, for RRP). Only a finding (not evidence) if the copy itself shows the comparison is false.
STOCK CLAIM (EVIDENCE CHECK, requiresEvidence: true, issue_type scarcity): "Only 4 left". Confirm stock was that low when sent.
OPINION (not a finding, not evidence): an influencer's or customer's own opinion ("honestly the best lamp I've ever owned"). For influencer posts the issue is the ad label, not the opinion.
NOT MARKETING (content_kind not_marketing): text with no product, offer or brand message, e.g. "test", "hello", or abuse. Never treat it as clean copy.

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
critical: Enforcement likely. Countdown or open-ended false urgency, pricing the copy shows is false, pre-ticked consent, no unsubscribe (email/SMS), third-party list without consent, fake or rewarded reviews, FCA without approval, "guaranteed" for market-linked, forward-looking projections, serious offence, disguised marketing.
high: Clear rule breach. "Free" without disclosure, undisclosed influencer, bundled consent, absolute green claims, missing risk warnings, unauthorised health claim wording.
medium: Probable breach, or a relative deadline with no date.
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
      "regulation": "CAP Code 8.17",
      "severity": "medium",
      "issue": "'Ends at midnight tonight' gives no date, and emails are often opened later.",
      "location": "Subject line -- 'Ends midnight tonight'",
      "recommendation": "Give the date and time, e.g. 'Ends 23:59 on [date]'.",
      "requiresEvidence": false,
      "issue_type": "deadline_unclear",
      "enforcement_note": "Always leave empty. Sendwize adds the closest published case."
    },
    {
      "regulation": "CAP Code 12.1 / GB NHC Register",
      "severity": "high",
      "issue": "'Vitamin C contributes to the normal function of the immune system' is an authorised claim, but only for products that meet its conditions of use.",
      "location": "Body paragraph 2",
      "recommendation": "Confirm the product meets the GB NHC Register conditions of use for this claim.",
      "requiresEvidence": true,
      "issue_type": "health_claim"
    }
  ],
  "content_kind": "marketing",
  "fixedVersion": "FULL REWRITTEN COMPLIANT VERSION. Follow Section 2B rules. Fix critical violations by rewriting. Do NOT include [EVIDENCE REQUIRED:] markers. Clean sendable copy.",
  "summary": "One sentence plain English assessment."
}

EVERY violation MUST have a requiresEvidence boolean. Do not omit this field.

------------------------------------------------------------

SECTION 12 -- CUSTOMER-FACING WORDING
The "issue", "recommendation", "enforcement_note" and "summary" fields are shown to customers. Internal words in this prompt such as "violation" and "breach" describe your task; they must not appear in those fields.
${LEGAL_RULES}
`;

// The reply is forced into this shape, so a malformed answer can't reach customers.
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    verdict: { type: 'string', enum: ['No issues found', 'Minor issues to address', 'Review required before sending', 'Do not send -- address critical issues first', 'Significant violations identified'] },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          regulation: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          issue: { type: 'string' },
          location: { type: 'string' },
          recommendation: { type: 'string' },
          requiresEvidence: { type: 'boolean' },
          issue_type: { type: 'string', enum: ISSUE_IDS },
          enforcement_note: { type: 'string' },
        },
        required: ['regulation', 'severity', 'issue', 'location', 'recommendation', 'requiresEvidence', 'issue_type'],
        additionalProperties: false,
      },
    },
    content_kind: { type: 'string', enum: ['marketing', 'service', 'not_marketing'] },
    fixedVersion: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['score', 'verdict', 'violations', 'content_kind', 'summary'],
  additionalProperties: false,
};

export const CHANNEL_RULES = {
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
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List purchased or rented from a third party. Recipients must have specifically consented to receive marketing from your organisation by name.', location: 'Sending context -- list source', recommendation: 'Do not send to this list until you can verify valid consent.', requiresEvidence: false, _fixType: 'third_party_list', issue_type: 'third_party_consent', _fromContext: true });
  }
  if (ctx.listSource === 'partner') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'critical', issue: 'List provided by a partner or affiliate -- indirect consent is insufficient for email or SMS marketing.', location: 'Sending context -- list source', recommendation: 'Each organisation sending marketing must have consent obtained specifically for their own communications.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', issue_type: 'third_party_consent', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 22 / UK GDPR Article 7', severity: 'critical', issue: 'Recipients consented to a third party or "our partners" -- not to your organisation by name.', location: 'Sending context -- consent specificity', recommendation: 'Stop sending to this list. Consent must specifically name your organisation.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', issue_type: 'third_party_consent', _fromContext: true });
  }
  if (ctx.consentSpecificity === 'notSure') {
    violations.push({ regulation: 'PECR Reg 22', severity: 'high', issue: 'Consent basis is unclear. Do not send unless you can confirm valid consent.', location: 'Sending context -- consent specificity', recommendation: 'Verify your consent records before sending.', requiresEvidence: false, _fixType: 'invalid_consent_mechanism', issue_type: 'third_party_consent', _fromContext: true });
  }
  if (ctx.senderRelationship === 'thirdParty' && ctx.fromNameMatch === 'no') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'critical', issue: 'A third-party agency is sending on your behalf and the From name does not match the organisation that collected consent.', location: 'Sending context -- sender relationship and From name mismatch', recommendation: 'The From name must clearly identify the brand that collected consent.', requiresEvidence: false, _fixType: 'concealed_sender', issue_type: 'sender_hidden', _fromContext: true });
  }
  if (ctx.fromNameMatch === 'no' && ctx.senderRelationship !== 'thirdParty') {
    violations.push({ regulation: 'PECR Reg 23', severity: 'high', issue: 'The From name does not match the organisation that collected consent.', location: 'Sending context -- From name mismatch', recommendation: 'Ensure the From name clearly identifies the organisation that collected consent.', requiresEvidence: false, _fixType: 'concealed_sender', issue_type: 'sender_hidden', _fromContext: true });
  }
  return violations;
}

function mapViolationToFixType(violation) {
  if (violation._fixType) return violation._fixType;
  if (isEvidenceViolation(violation)) return null;
  const known = violation.issue_type && issueOf(violation.issue_type);
  if (known && known.fixType) return known.fixType;

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

// The closest published case for an issue comes from the verified case
// library, never from the model, so every case shown has a source link.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const caseWhen = d => { const m = String(d || '').match(/^(\d{4})(?:-(\d{2}))?/); return m ? (m[2] ? MONTHS[Number(m[2]) - 1] + ' ' : '') + m[1] : ''; };
// v6.0: only a case tagged with the same specific issue (_copy-issues.js),
// never on low-severity notes or evidence checks. No case beats a wrong one.
function withClosestCase(v, channel) {
  const { enforcement_note, enforcement_url, case_id, ...rest } = v;
  const issue = rest.issue_type || guessIssue(rest);
  if (rest.requiresEvidence || rest.severity === 'low' || !issueOf(issue).caseable) return rest;
  const text = [rest.issue, rest.location, rest.text, rest.quote].filter(Boolean).join(' ');
  const c = caseForIssue(issue, { text, channel });
  if (!c) return rest;
  return { ...rest,
    enforcement_note: `Published case on the same issue: ${c.name} (${c.regulator}, ${caseWhen(c.date)}). ${c.outcome}. ${c.summary}${c.action ? ` What they had to change: ${c.action}` : ''}`,
    enforcement_url: c.url, case_id: c.id };
}

function mapViolationToSeverity(v) {
  const s = (v.severity || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high')     return 'high';
  if (s === 'medium')   return 'medium';
  return 'low';
}

// Everything that can change the answer: the same inputs on the same
// engine version give back the saved answer (see the handler).
function contentHash(userId, contentType, content, extra = '') {
  return crypto.createHash('sha256').update(`${COPY_ENGINE}|${userId}|${contentType}|${content}|${extra}`).digest('hex').slice(0, 16);
}

// The saved answer for identical copy, so a re-run never gives a different verdict
async function loadSameCheck(userId, hash) {
  const formula = `AND({UserID}=${fq(userId)},{ContentHash}=${fq(hash)})`;
  const r = await fetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/AI_Compliance_Checks?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort%5B0%5D%5Bfield%5D=CheckDate&sort%5B0%5D%5Bdirection%5D=desc`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  if (!r.ok) return null;
  const rec = (await r.json()).records?.[0];
  if (!rec) return null;
  let analysis = {};
  try { analysis = JSON.parse(rec.fields.Analysis || '{}'); } catch { return null; }
  if (!Array.isArray(analysis.violations)) return null;
  return { id: rec.id, fields: rec.fields, analysis };
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
        headers: internalHeaders(),
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

// ── Recheck: compare a new run with the check it re-runs ──
// A finding is matched by its fix type, or by its rule when it has none.
function findingKey(v) {
  return mapViolationToFixType(v) || `rule:${String(v.regulation || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

async function loadPreviousCheck(userId, recordId) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId || '')) return null;
  const r = await fetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/AI_Compliance_Checks/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  if (!r.ok) return null;
  const rec = await r.json();
  if (rec.fields?.UserID !== userId) return null;
  let analysis = {};
  try { analysis = JSON.parse(rec.fields.Analysis || '{}'); } catch {}
  return { id: rec.id, root: analysis.recheckRoot || rec.id, violations: analysis.violations || [] };
}

function compareChecks(before, after) {
  const afterKeys = new Set(after.map(findingKey));
  const beforeKeys = new Set(before.map(findingKey));
  const brief = v => ({ issue: v.issue || '', regulation: v.regulation || '', severity: v.severity || '' });
  return {
    resolved:   before.filter(v => !afterKeys.has(findingKey(v))).map(brief),
    stillOpen:  before.filter(v => afterKeys.has(findingKey(v))).map(brief),
    newFindings: after.filter(v => !beforeKeys.has(findingKey(v))).map(brief),
    resolvedTypes: [...new Set(before.filter(v => !afterKeys.has(findingKey(v))).map(mapViolationToFixType).filter(Boolean))],
  };
}

// Close the dashboard fixes from the earlier check whose finding no longer appears.
async function closeResolvedFixes(userId, sourceIds, fixTypes) {
  if (!fixTypes.length) return 0;
  const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  const auth = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const types = fixTypes.map(t => `{OriginalFixType}=${fq(t)}`).join(',');
  const sources = [...new Set(sourceIds)].map(id => `{SourceRecordID}=${fq(id)}`).join(',');
  const formula = `AND({UserID}=${fq(userId)},OR(${sources}),{Status}='pending',OR(${types}))`;
  const r = await fetch(`${base}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=50`, { headers: auth });
  if (!r.ok) return 0;
  const recs = (await r.json()).records || [];
  const today = new Date().toISOString().split('T')[0];
  let closed = 0;
  for (let i = 0; i < recs.length; i += 10) {
    const u = await fetch(`${base}/Compliance_Fixes`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ records: recs.slice(i, i + 10).map(x => ({ id: x.id, fields: { Status: 'completed', CompletedDate: today, CompletionSource: 'improved_on_rerun' } })) }),
    });
    if (u.ok) closed += Math.min(10, recs.length - i);
  }
  return closed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const startedAt = Date.now();
  try {
    // Identity: the verified member id replaces any userId sent by the browser
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!(await checkLimit(req, res, auth, 'copy_scan'))) return;
    const { contentType, content, subject, userId, autoFix, sendingContext, images, recheckOf } = req.body ?? {};
    if (!userId)      return res.status(400).json({ error: 'Missing userId' });
    if (!contentType) return res.status(400).json({ error: 'Missing contentType' });
    if (!['email','sms','push','social','directmail'].includes(contentType)) return res.status(400).json({ error: 'Invalid contentType' });
    if (!content)     return res.status(400).json({ error: 'Missing content' });

    const contextViolations = getContextViolations(sendingContext);
    const copyText          = contentType === 'email' && subject ? `Subject: ${subject}\n\nEmail body:\n${content}` : content;
    const contextBlock      = buildSendingContextBlock(sendingContext);
    const facts             = copyFacts(contentType, copyText);
    const imageKey          = Array.isArray(images) ? images.map(i => crypto.createHash('sha256').update(String(i?.data || '')).digest('hex').slice(0, 12)).join(',') : '';
    const checkHash         = contentHash(userId, contentType, content, `${subject || ''}|${contextBlock}|${imageKey}|${autoFix ? 'rw' : ''}`);
    const analysisContent   = `${factsBlock(facts)}\n\n${contextBlock ? `${contextBlock}\n\n` : ''}[COPY TO ANALYSE]\n${copyText}`;

    // Identical copy (and context, images, engine) gives the saved answer back
    if (!recheckOf) {
      const same = await loadSameCheck(userId, checkHash).catch(() => null);
      if (same) {
        const violations = same.analysis.violations;
        const call = sendCall(violations);
        return res.status(200).json({
          score: same.fields.RiskScore ?? copyScore(violations), verdict: call.label, violations,
          summary: same.analysis.summary || '', fixedVersion: same.fields.FixedVersion || '', content_kind: same.analysis.contentKind || 'marketing',
          sendCall: call, contentType, checkHash, sourceRecordId: same.id, comparison: null, reused: true,
        });
      }
    }

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

    const claudeHttpRes = await claudeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        max_tokens: 5000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: messageContent }]
      })
    }, { effort: 'medium', schema: ANALYSIS_SCHEMA, cacheSystem: true });

    console.log('Claude status:', claudeHttpRes.status);
    const message = await claudeHttpRes.json();

    if (!claudeHttpRes.ok) {
      console.error('Claude API error:', claudeHttpRes.status, JSON.stringify(message));
      return res.status(500).json({ error: 'Claude API error', details: message });
    }

    let aiAnalysis = null;
    aiAnalysis = parseJson(message.content?.[0]?.text);
    if (!aiAnalysis || typeof aiAnalysis !== 'object') {
      console.error('JSON parse failed. Full text:', message.content?.[0]?.text?.slice(0, 1000));
      aiAnalysis = { score: 50, verdict: 'Analysis Error', violations: [], summary: 'The analysis could not be read. Please run the check again.' };
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

    // v6.0: the house rules (_copy-review.js) decide what stays, how serious
    // it is and the score, so the same findings always give the same answer
    const analysisFailed = aiAnalysis?.verdict === 'Analysis Error';
    const contentKind = aiAnalysis?.content_kind || 'marketing';
    const reviewed = analysisFailed ? taggedAiViolations
      : reviewFindings(taggedAiViolations, facts, { contentKind, contextFindings: contextViolations });
    const allViolations = reviewed.map(v => withClosestCase(v, contentType));

    let finalScore = analysisFailed ? (aiAnalysis?.score ?? 50) : copyScore(allViolations);
    let finalVerdict = aiAnalysis?.verdict;

    // The rewrite may only say what the original said; anything new becomes a [check: ...] placeholder
    if (aiAnalysis.fixedVersion && !analysisFailed) aiAnalysis.fixedVersion = await guardRewrite(copyText, aiAnalysis.fixedVersion, { timeoutMs: 50000 - (Date.now() - startedAt) });

    // Go / Fix first / Hold for the copy only (see _send-call.js). No answer
    // when the check itself failed. Saved as the check's Verdict so past
    // checks and the dashboard show the same answer.
    const call = analysisFailed ? null : sendCall(allViolations);
    if (call) finalVerdict = call.label;

    // Recheck: compare with the earlier check before saving this one
    let comparison = null;
    const previous = recheckOf ? await loadPreviousCheck(userId, recheckOf).catch(() => null) : null;
    if (previous) comparison = compareChecks(previous.violations, allViolations);

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
          ContentHash:    analysisFailed ? '' : checkHash,
          RiskScore:      finalScore,
          Verdict:        finalVerdict ?? '',
          CriticalIssues: criticalCount,
          Warnings:       warningCount,
          MarketingCopy:  content?.slice(0, 10000) ?? '',
          FileName:       contentType === 'email' ? `Email: ${subject || '(no subject)'}` : `${contentType} scan`,
          Analysis:       JSON.stringify({ violations: allViolations, summary: aiAnalysis?.summary ?? '', contentKind, engine: COPY_ENGINE, ...(previous ? { recheckOf: previous.id, recheckRoot: previous.root, comparison } : {}) }),
          FixedVersion:   aiAnalysis?.fixedVersion ?? '',
          RelatedCases:   [...new Set(allViolations.map(v => v.case_id).filter(Boolean))].join(','),
          SendingContext: contextBlock || '',
        }}]})
      });
      if (saveRes.ok) savedRecordId = (await saveRes.json()).records?.[0]?.id ?? null;
      else console.error('AI_Compliance_Checks save failed:', saveRes.status);
    } catch (err) {
      console.error('AI_Compliance_Checks save error:', err);
    }

    // On a recheck, findings that were already open keep their existing fixes
    const prevKeys = previous ? new Set(previous.violations.map(findingKey)) : null;
    const fixable = prevKeys ? allViolations.filter(v => !prevKeys.has(findingKey(v))) : allViolations;
    if (fixable.length > 0) {
      try { await generateFixes(userId, fixable, [], savedRecordId); }
      catch (e) { console.error('generateFixes error:', e); }
    }

    if (comparison) {
      try { comparison.closedFixes = await closeResolvedFixes(userId, [previous.root, previous.id], comparison.resolvedTypes); }
      catch (e) { console.error('closeResolvedFixes error:', e); comparison.closedFixes = 0; }
      delete comparison.resolvedTypes;
    }

    fetch(`${APP_URL}/api/profile?action=streak`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ userId })
    }).catch(e => console.error('Streak update failed:', e));

    const cleanViolations = allViolations.map(({ _fromContext, _fixType, ...rest }) => rest);
    return res.status(200).json({ ...aiAnalysis, score: finalScore, verdict: finalVerdict, violations: cleanViolations, sendCall: call, contentType, checkHash, sourceRecordId: savedRecordId, comparison });

  } catch (error) {
    console.error('analyze-copy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
