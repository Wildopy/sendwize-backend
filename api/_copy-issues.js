// ─────────────────────────────────────────────────────────────
// SENDWIZE: _copy-issues.js  v1.0
// One list of the specific issues a piece of copy can raise, used three
// ways so they always agree:
//   1. the AI must label every finding with one of these (ISSUE_IDS),
//   2. each published case is tagged with the issues its own summary is
//      about (caseIssues), and
//   3. a finding is only shown beside a case tagged with the same issue.
//
// v1.0 (10 Nov 2026): replaces matching on broad fix types ("misleading
//   claim" covered 874 of 937 ASA rulings), which put life-insurance
//   rulings beside green claims and HelloFresh beside every opt-out.
// ─────────────────────────────────────────────────────────────

// id: what the AI sends. fixType: the dashboard fix it creates (the
// exposure engine's types). caseable: a published case can genuinely be
// "about" this issue. single: one finding per check is enough. cite: the
// rule the finding is shown under, checked against the CAP Code, PECR and
// the DMCCA (Nov 2026); it replaces the AI's own citation, which was wrong
// about 1 time in 5. Issues without one keep the AI's citation.
export const ISSUES = {
  opt_out_missing:      { label: 'No way to opt out',                    fixType: 'missing_unsubscribe',            caseable: false, single: true, cite: 'PECR Reg 23 (valid opt-out address); Reg 22(3) for soft opt-in' },
  sender_hidden:        { label: 'Sender disguised or hidden',           fixType: 'concealed_sender',               caseable: true,  single: true, cite: 'PECR Reg 23' },
  sender_details:       { label: 'Sender name or address missing',       fixType: 'missing_address',                caseable: false, single: true },
  consent_basis:        { label: 'Consent or soft opt-in',               fixType: 'no_consent',                     caseable: true,  single: true, cite: 'PECR Reg 22' },
  third_party_consent:  { label: 'Consent given to someone else',        fixType: 'third_party_list',               caseable: true,  single: true, cite: 'PECR Reg 22 / UK GDPR Art 7' },
  fake_urgency:         { label: 'Time pressure that may not be real',   fixType: 'fake_urgency',                   caseable: true, cite: 'CAP Code 3.30 / DMCCA 2024 Sch 20' },
  deadline_unclear:     { label: 'Deadline with no date',                fixType: 'fake_urgency',                   caseable: false, single: true, cite: 'CAP Code 8.17.4' },
  scarcity:             { label: 'Low stock or demand claim',            fixType: 'fake_scarcity',                  caseable: true, cite: 'CAP Code 3.31 / DMCCA 2024 Sch 20' },
  reference_price:      { label: 'Was/now or saving claim',              fixType: 'misleading_reference_price',     caseable: true, cite: 'CAP Code 3.39 / DMCCA 2024 s.226' },
  drip_pricing:         { label: 'Fees left out of the price',           fixType: 'drip_pricing',                   caseable: true, cite: 'CAP Code 3.18 / DMCCA 2024 s.230' },
  hidden_conditions:    { label: 'Conditions or exclusions not clear',   fixType: 'missing_terms',                  caseable: true, cite: 'CAP Code 3.9 / 3.10' },
  free_claim:           { label: '"Free" with a cost attached',          fixType: 'missing_terms',                  caseable: true, cite: 'CAP Code 3.23' },
  superlative_claim:    { label: 'Best, biggest, No.1 or similar',       fixType: 'misleading_claim',               caseable: true, cite: 'CAP Code 3.7' },
  comparative_claim:    { label: 'Comparison with competitors',          fixType: 'misleading_claim',               caseable: true, cite: 'CAP Code 3.7 / 3.33' },
  performance_claim:    { label: 'What the product does or proves',      fixType: 'misleading_claim',               caseable: true, cite: 'CAP Code 3.7' },
  green_claim:          { label: 'Environmental claim',                  fixType: 'misleading_claim',               caseable: true, cite: 'CAP Code 11.1 / 11.3' },
  health_claim:         { label: 'Health or nutrition claim',            fixType: 'unauthorised_health_claim',      caseable: true },
  medicinal_claim:      { label: 'Claims to treat or cure',              fixType: 'unauthorised_health_claim',      caseable: true },
  review_claim:         { label: 'Ratings, reviews or testimonials',     fixType: 'misleading_testimonial',         caseable: true, cite: 'CAP Code 3.44-3.47 / DMCCA 2024 Sch 20' },
  incentivised_review:  { label: 'Rewarding or faking reviews',          fixType: 'misleading_testimonial',         caseable: true, cite: 'CAP Code 3.45 / DMCCA 2024 Sch 20' },
  hidden_ad:            { label: 'Ad not labelled as an ad',             fixType: 'undisclosed_ad',                 caseable: true, cite: 'CAP Code 2.1 / 2.3 / DMCCA 2024 Sch 20' },
  disguised_marketing:  { label: 'Marketing dressed up as something else', fixType: 'concealed_sender',             caseable: true },
  prize_promotion:      { label: 'Prize draw or competition',            fixType: 'missing_terms',                  caseable: true },
  subscription_terms:   { label: 'Subscription or renewal terms',        fixType: 'missing_terms',                  caseable: true },
  credential_claim:     { label: 'Awards, memberships or origin',        fixType: 'misleading_claim',               caseable: true },
  restricted_product:   { label: 'Alcohol, gambling, HFSS or medicines',  fixType: 'asa_liability',                  caseable: true },
  financial_promotion:  { label: 'Financial promotion rules',            fixType: 'misleading_claim',               caseable: true },
  harm_offence:         { label: 'Offensive or harmful content',         fixType: 'asa_liability',                  caseable: true, cite: 'CAP Code 4.1' },
  vulnerable_audience:  { label: 'Children or vulnerable people',        fixType: 'asa_liability',                  caseable: true },
  privacy_transparency: { label: 'Privacy information',                  fixType: 'no_privacy_policy',              caseable: false },
  tracking_consent:     { label: 'Tracking or browsing data',            fixType: 'invalid_consent_mechanism',      caseable: false },
  not_marketing:        { label: 'Not recognisable as marketing',        fixType: null,                             caseable: false, single: true },
  other:                { label: 'Other',                                fixType: null,                             caseable: false },
};
export const ISSUE_IDS = Object.keys(ISSUES);
export const issueOf = id => ISSUES[id] || ISSUES.other;

// ── Tagging the published cases ──
// Read from the regulator's own summary and "what they had to change" text,
// never guessed. A case can be about several issues. Kept strict on purpose:
// a case left untagged is never shown, which beats one shown wrongly.
const CASE_RULES = {
  // ICO
  sender_hidden:       /\b(disguis\w*|conceal\w*|hid(e|ing)? (who|its|their) (identity|was)|tried to hide|identity of the (sender|person|caller)|posing as|spoof\w*|false (names?|identity)|without identifying|did not identify (itself|themselves|the sender)|withheld (its|their) (identity|number))/i,
  consent_basis:       /\b(without (valid |proper |adequate |the necessary |appropriate |prior )?consent|had not (given|provided) (valid )?consent|unsolicited (marketing|direct marketing|e-?mails?|texts?|text messages|calls)|soft opt-in|who had not opted in|not opted in|did not want to receive|told them they didn.t want|regulation 22|reg\.? 22|nuisance (marketing|messages|texts)|spam (texts?|text messages|e-?mails)|unwanted marketing (texts?|e-?mails|messages)|marketing preference reminder)\b/i,
  third_party_consent: /\b(third[- ]part(y|ies)|partner (companies|organisations|list)|bought|purchased|rented|data broker|lead[- ]generat\w*|affiliates?|indirect consent|from (a|another) (company|supplier|list)|"partners?")\b/i,
  // Urgency, scarcity, prices
  fake_urgency:        /\b(false (time-limited|urgency|deadline)|time-limited (offers?|deals?|promotions?)|countdown|limited[- ]time (offers?|deals?)|urgency|offers? (would|were going to|was going to|were due to) end|stayed at the same price|pressur\w+ (consumers|customers|people) into|deadline)\b/i,
  scarcity:            /\b(scarcity|only \d+ (\w+ )?(left|remaining|available)|availability|limited (stock|availability|numbers)|selling out|sell out|stock levels?|low in stock|high demand|people (are )?(viewing|looking))\b/i,
  reference_price:     /\b(was price|"was"|reference prices?|savings? claims?|claimed savings|genuine savings?|\bRRP\b|recommended retail|usual (selling )?prices?|higher prices?|price (comparisons?|reductions?)|\d+% off|per ?cent off|discounts? (were|was) (not genuine|misleading|exaggerated)|half price|£\d[\d,.]* saving|price match\w*|savings? (and|or) availability|price, savings)\b/i,
  drip_pricing:        /\b(drip pric\w*|(booking|service|delivery|handling|admin\w*|joining|processing|mandatory|compulsory|additional|hidden) (fees?|charges?)|fees? (were|was) (added|left out|not included)|left out of the (upfront )?price|(total|full|upfront) price|not (included|inclusive) (in|of) the (headline |advertised )?price|exclud\w+ (vat|fees?)|pre-?selected|opted in by default)\b/i,
  hidden_conditions:   /\b(significant (limitations?|conditions?|exclusions?|restrictions?|qualifications?)|exclusions? (applied|were not)|minimum (spend|order|purchase)|eligibility (criteria|conditions)|subject to (conditions|availability)|did not make (it )?clear (that )?(the )?(offer|promotion|discount)|failed to make clear|all product lines|["“‘']everything|every single thing|sitewide|unlimited|fair use|terms and conditions (were|was) not|minimum (order|commitment)|omitted significant conditions)\b/i,
  free_claim:          /(\b(described|advertised|referred to|presented) .{0,40}\bas (being )?["“'‘]?free\b|["“'‘]free["”'’]|\bfree (trial|gift|delivery|consultation|sample|offer|item|product|bet|spins?)s?\b|\bfor free\b|\bno cost to\b|\bfree of charge\b)/i,
  // Claims
  superlative_claim:   /\b(number one|no\.? ?1|#1|best[- ]selling|bestselling|(the )?(best|biggest|largest|leading|cheapest|fastest|most popular|favourite|top[- ]rated)\b.{0,30}\b(in|on) (the )?(uk|britain|market|world|country)|(uk|world|britain|country)['’]s (best|biggest|largest|leading|favourite|cheapest|no\.? ?1|number one)|award[- ]winning|(biggest|largest|best|leading|cheapest|number one|no\.? ?1|#1|best rated)\b.{0,20}\b(provider|brand|retailer|seller|supplier|company|website|site))\b/i,
  credential_claim:    /\b(based in the uk|uk[- ]based|british[- ]made|made in (the uk|britain)|members? of (the )?[A-Z]|accredit\w*|approved by|endorsed by|associated with the uk government|registered (with|charity)|qualified|represented by)\b/i,
  restricted_product:  /\b(less healthy food|hfss|prescription-only medicines?|alcohol\w*|gambl\w*|betting|tobacco|vap(e|es|ing)|loot box\w*)\b/i,
  comparative_claim:   /\b(comparative claims?|competitors?|comparisons? with (other|competing|rival)|compared (with|to) (other|competing|rival)|identifiable competitors?|rival (brands?|products?|companies))\b/i,
  performance_claim:   /\b(efficacy|exaggerat\w*|effectiveness|functionality|clinically (proven|tested)|proven to|guarantee[ds]?\b|lasts? (for|up to)|performance claims?|results claims?|could not be substantiated|not (been )?substantiated|without (adequate )?(documentary )?evidence|no (adequate )?evidence)\b/i,
  green_claim:         /\b(environmental (claims?|benefits?|impact)|green(wash\w*| claims?)?|eco[- ]?friendly|carbon[- ](neutral|negative|zero|offset\w*)|net[- ]zero|sustainab\w+|recycl\w+|biodegrad\w+|compostable|plastic[- ]free|climate|emissions?|planet)\b/i,
  health_claim:        /\b(health claims?|nutrition claims?|authori[sz]ed (health )?claims?|nhc register|immun\w*|vitamins?|supplements?|nutrients?|wellbeing claims?|weight[- ]loss|slimming)\b/i,
  medicinal_claim:     /\b(medicinal claims?|medical claims?|cure[sd]?\b|curing|treat(ing|ment of|s)? .{0,40}\b(conditions?|disease|illness|disorders?|insomnia|anxiety|depression|pain)|prevent(ing|s)? .{0,30}\b(disease|illness)|mhra|unlicensed (medicines?|products?)|medical devices?|prescription-only|diagnose|alleviate)\b/i,
  review_claim:        /\b(reviews?|testimonials?|star ratings?|ratings?|trustpilot|endorsements?)\b/i,
  incentivised_review: /\b(fake reviews?|incentivi[sz]\w* reviews?|reward\w* .{0,25}\breviews?|boost(ed|ing)? (star )?ratings?|conceal\w* (negative|bad) reviews?|suppress\w* (negative|bad) reviews?|paid for (positive )?reviews?)\b/i,
  hidden_ad:           /(#ad\b|\b(not (obviously|clearly) identifiable|obviously identifiable as (an )?(ad|marketing)|commercial intent|influencers?|paid[- ]for (partnership|post|content)|affiliate (marketing|links?|content)|(not )?label(led)? as (an )?(ads?|advertising|marketing)|ad label|sponsored|co-publishing)\b)/i,
  disguised_marketing: /\b(disguised as|resembl\w+ (a|an|official)|official[- ]looking|parking (ticket|charge notice|fine)|advertorial|independent review sites?|acting for purposes outside (its|their) (trade|business)|appeared to be (a|an) (independent|official|personal)|written by (personal|independent) individuals|delivery (notice|notification|card))\b/i,
  prize_promotion:     /\b(prize draws?|prizes?|competitions?|giveaways?|sweepstakes?|instant win|administered fairly|unnecessary disappointment|winners?)\b/i,
  subscription_terms:  /\b(subscriptions?|auto-?renew\w*|automatically renew\w*|recurring (payments?|charges?|fees?)|rolling (contract|membership)|membership fees?|free trials?)\b/i,
  financial_promotion: /\b(risk warnings?|apr\b|fca\b|financial promotions?|investments?|crypto\w*|capital at risk|loans?|credit (cards?|broker)|mortgages?|trading (platform|app))\b/i,
  harm_offence:        /\b(serious (or widespread )?offen[cs]e|offensive|irresponsibl\w*|socially responsible|unjustified distress|harmful|condon\w+|encourag\w+ (unsafe|dangerous|harmful)|shock tactics|sexuali[sz]\w*|objectif\w*|gender stereotypes?|racial)\b/i,
  vulnerable_audience: /\b(children|under[- ]18s?|under[- ]16s?|young people|teenagers?|vulnerable (people|consumers|customers|adults))\b/i,
};

// Hand-checked cases where the summary alone doesn't say enough
const CASE_OVERRIDES = {
  hellofresh_2024: ['consent_basis'],
  google_cma_2025: ['incentivised_review', 'review_claim'],
  zmluk_2025: ['third_party_consent', 'consent_basis'],
};

// ICO enforcement is about how people were contacted, not ad wording, and
// ASA/CMA rulings are never about consent. Keep each regulator to its lane.
const ICO_ONLY = new Set(['sender_hidden', 'consent_basis', 'third_party_consent']);
const ICO_ALLOWED = new Set([...ICO_ONLY, 'disguised_marketing']);

export function caseIssues(c) {
  if (CASE_OVERRIDES[c.id]) return CASE_OVERRIDES[c.id];
  const text = `${c.summary || ''} ${c.action || ''}`;
  const out = Object.keys(CASE_RULES).filter(k => CASE_RULES[k].test(text));
  return c.regulator === 'ICO' ? out.filter(k => ICO_ALLOWED.has(k)) : out.filter(k => !ICO_ONLY.has(k));
}
