// ─────────────────────────────────────────────────────────────
// SENDWIZE — _case-library.js v1.0  (published case library)
// Underscore prefix: not an endpoint.
//
// Every real ICO, ASA and CMA case Sendwize sets beside a finding.
// Read by _exposure.js (closest published cases in "Why this number?")
// and _cases.js (Case Twin). The daily regulator feed adds more rulings
// on top of these in Sector_Intelligence_Feed.
//
// RULES FOR THIS FILE
//   · Only cases published by the regulator itself: ico.org.uk,
//     asa.org.uk, gov.uk (CMA). Every case has the URL it came from.
//   · Amounts are the figure the regulator published. Where a fine was
//     later cut on appeal or by settlement, penalty is the final figure
//     and the summary says so.
//   · ASA rulings carry no fine, so penalty is null. CMA undertakings
//     without a fine have penalty null and say what was agreed.
//   · volume is the number of messages, contacts or customers the
//     regulator counted. null where it didn't publish one.
//   · date is the date the regulator published or issued the decision,
//     as precise as the record allows (YYYY, YYYY-MM or YYYY-MM-DD).
//   · Never add a case from memory or from a press report alone.
//
// types: the Sendwize finding types (fixType) the case is comparable to.
// sector: same vocabulary as the profile (ecommerce, finance, health,
//   media, b2b, charity, gambling), null where the record doesn't say.
// match: optional words the source page must contain (default: the first
//   word of name). scripts/check-case-links.mjs fetches every url and
//   checks the page names the party and, where there is one, the amount.
// Last checked: October 2026.
// ─────────────────────────────────────────────────────────────

import { IMPORTED } from './_case-imports.js';

const ICO = 'https://ico.org.uk';
const ASA = 'https://www.asa.org.uk/rulings/';
const CMA = 'https://www.gov.uk';

const CURATED = [
  // ── ICO: PECR email and SMS marketing ──
  { id: 'hellofresh_2024', regulator: 'ICO', name: 'HelloFresh (Grocery Delivery E-Services UK Ltd)', date: '2024-01-12', penalty: 140000, volume: 80893013, sector: 'ecommerce',
    summary: 'About 79M marketing emails and 1M texts. Consent was bundled with an age confirmation, never mentioned texts, and did not say marketing would continue for 24 months after cancellation. Some people were contacted after asking it to stop.',
    types: ['consent_missing', 'invalid_consent_mechanism', 'suppression_breach'],
    url: ICO + '/action-weve-taken/enforcement/2024/01/grocery-delivery-e-services-uk-ltd-ta-hellofresh/' },
  { id: 'zmluk_2025', regulator: 'ICO', name: 'ZMLUK Ltd (formerly Zuru Media)', date: '2025-12-11', penalty: 105000, volume: 67000000, sector: null,
    summary: 'Over 67M marketing emails without valid consent. People signing up were shown a list of 361 "partner" companies with no way to choose which could contact them.',
    types: ['third_party_list', 'consent_missing', 'invalid_consent_mechanism'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2026/01/fines-of-225-000-for-nuisance-marketing-messages/' },
  { id: 'allay_2026', regulator: 'ICO', name: 'Allay Claims Ltd', date: '2026-01-15', penalty: 120000, volume: 4046947, sector: 'finance',
    summary: 'About 4M texts promoting PPI tax refund claims without valid consent. The ICO found it could not rely on the soft opt-in it claimed.',
    types: ['consent_missing', 'invalid_consent_mechanism'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2026/01/fines-of-225-000-for-nuisance-marketing-messages/' },
  { id: 'kra_2026', regulator: 'ICO', name: 'KRA Consultancy Ltd', date: '2026-06', penalty: 300000, volume: 5575715, sector: 'finance',
    summary: 'About 5.6M unsolicited debt-solution texts between April 2022 and May 2025, some posing as bailiff messages, aimed at people already in financial difficulty.',
    types: ['consent_missing'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2026/06/manchester-firm-fined-300-000-for-bombarding-people-in-debt-with-over-55-million-unlawful-texts/' },
  { id: 'chand_2025', regulator: 'ICO', name: 'Bharat Singh Chand (sole trader)', match: 'Chand', date: '2025-10', penalty: 200000, volume: 966449, sector: null,
    summary: 'Nearly 1M texts about debt solutions and energy grants sent without valid consent between December 2023 and July 2024, drawing 19,138 spam reports. Under appeal.',
    types: ['consent_missing'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2025/10/200-000-fine-for-sole-trader-who-sent-nearly-one-million-spam-texts/' },
  { id: 'esl_2025', regulator: 'ICO', name: 'ESL Consultancy Services Ltd', date: '2025-01', penalty: 200000, volume: null, sector: 'finance',
    summary: 'Instigated loan-promotion texts sent by an affiliate without valid consent, and tried to hide who the sender was. 37,977 complaints.',
    types: ['lead_gen_consent_gap', 'affiliate_consent_unverified', 'affiliate_sender_identity_breach', 'consent_missing'],
    url: ICO + '/action-weve-taken/enforcement/esl-consultancy-services-ltd-mpn/' },
  { id: 'tbdl_2023', regulator: 'ICO', name: 'This Is The Big Deal Ltd', match: 'Big Deal', date: '2023-08', penalty: 30000, volume: 41417889, sector: null,
    summary: 'About 41M emails and texts sent by its affiliates to people who had not consented. It supplied the content and paid per sale, so the ICO held it responsible as instigator. Fine reduced from £150,000 after its finances were considered.',
    types: ['affiliate_consent_unverified', 'lead_gen_consent_gap', 'consent_missing'],
    url: ICO + '/action-weve-taken/enforcement/2023/08/this-is-the-big-deal-limited/' },
  { id: 'monetise_2022', regulator: 'ICO', name: 'Monetise Media Ltd', date: '2022-12', penalty: 85000, volume: 3506157, sector: null,
    summary: 'About 3.5M emails and texts sent without valid consent using data three affiliates collected; its checks on the affiliates were not enough. The tribunal cut the fine from £125,000 to £85,000.',
    types: ['affiliate_consent_unverified', 'lead_gen_consent_gap', 'third_party_list'],
    url: ICO + '/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv' },
  { id: 'ladh_2024', regulator: 'ICO', name: 'LADH Ltd', date: '2024-01', penalty: 50000, volume: 31000, sector: 'finance',
    summary: 'More than 31,000 marketing texts sent without valid consent over six weeks in 2022.',
    types: ['consent_missing'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2024/01/ico-fines-financial-services-company-50k-for-spam-text-messages/' },
  { id: 'quicktax_2024', regulator: 'ICO', name: 'Quick Tax Claims Ltd', match: 'Quick Tax Claims', date: '2024-10', penalty: 120000, volume: null, sector: 'finance',
    summary: 'Unlawful marketing texts offering tax refund services, sent without valid consent.',
    types: ['consent_missing'],
    url: ICO + '/about-the-ico/media-centre/news-and-blogs/2024/10/two-companies-fined-a-total-of-150k-after-bombarding-people-with-spam-texts-offering-financial-debt-services/' },
  { id: 'nda_2024', regulator: 'ICO', name: 'National Debt Advice Ltd', match: 'National Debt Advice', date: '2024-10', penalty: 30000, volume: null, sector: 'finance',
    summary: 'Marketing texts sent to bought-in data, including people recently turned down for loans, without valid consent.',
    types: ['third_party_list', 'consent_missing'],
    url: ICO + '/action-weve-taken/enforcement/2024/10/national-debt-advice-limited-mpn/' },
  { id: 'halfords_2022', regulator: 'ICO', name: 'Halfords Ltd', date: '2022-09', penalty: 30000, volume: 498179, sector: 'ecommerce',
    summary: 'Nearly 500k emails about the "Fix Your Bike" voucher scheme to customers who had not opted in. Labelled a service message, but the ICO found it was marketing.',
    types: ['consent_missing', 'legitimate_interest_abuse'],
    url: ICO + '/media2/migrated/4021458/halfords-limited-monetary-penalty-notice.pdf' },
  { id: 'wbac_2021', regulator: 'ICO', name: 'We Buy Any Car Ltd', match: 'We Buy Any Car', date: '2021-09-15', penalty: 200000, volume: 195000000, sector: 'ecommerce',
    summary: 'About 191M emails and 3.6M texts following up valuation requests without fully meeting the soft opt-in rules.',
    types: ['consent_missing', 'invalid_consent_mechanism'],
    url: ICO + '/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv' },
  { id: 'saga_services_2021', regulator: 'ICO', name: 'Saga Services Ltd', match: 'Saga Services', date: '2021-09-15', penalty: 150000, volume: 128895718, sector: 'finance',
    summary: 'About 129M emails sent by partner companies and their affiliates to lists of people who had never agreed to hear from Saga. Indirect consent was not enough.',
    types: ['lead_gen_consent_gap', 'affiliate_consent_unverified', 'invalid_consent_mechanism', 'third_party_list'],
    url: ICO + '/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv' },
  { id: 'saga_pf_2021', regulator: 'ICO', name: 'Saga Personal Finance Ltd', match: 'Saga Personal Finance', date: '2021-09-15', penalty: 75000, volume: 28523745, sector: 'finance',
    summary: 'About 28.5M emails sent through partners and affiliates relying on indirect consent that did not name Saga.',
    types: ['lead_gen_consent_gap', 'affiliate_consent_unverified', 'invalid_consent_mechanism'],
    url: ICO + '/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv' },

  // ── ICO: UK GDPR and calls ──
  { id: 'easylife_gdpr_2022', regulator: 'ICO', name: 'Easylife Ltd (UK GDPR)', date: '2022-10', penalty: 250000, volume: 145400, sector: 'ecommerce',
    summary: 'Inferred health conditions from purchases to target 145,400 customers with marketing calls, without telling them. Fined £1.35M, later reduced to £250,000.',
    types: ['legitimate_interest_abuse', 'data_quality'],
    url: ICO + '/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv' },
  { id: 'easylife_pecr_2022', regulator: 'ICO', name: 'Easylife Ltd (PECR)', date: '2022-10', penalty: 130000, volume: 1345732, sector: 'ecommerce',
    summary: 'About 1.3M marketing calls to people registered with the Telephone Preference Service.',
    types: ['marketing_calls'],
    url: ICO + '/media2/migrated/4021802/easylife-limited-mpn-reg-21-20221004.pdf' },
  { id: 'capita_2025', regulator: 'ICO', name: 'Capita plc and Capita Pension Solutions Ltd', date: '2025-10-15', penalty: 14000000, volume: 6600000, sector: 'b2b',
    summary: 'A 2023 cyber attack exposed data on 6.6M people after security failings. A provisional £45M fine was settled at £14M.',
    types: ['dpa_breach'],
    url: ICO + '/action-weve-taken/enforcement/2025/10/capita-plc/' },

  // ── ASA rulings (upheld, no fine) ──
  { id: 'johnlewis_asa_2026', regulator: 'ASA', name: 'John Lewis plc', date: '2026-05-20', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A "Save £150" ad for a MacBook Air was misleading: the reference price had not been shown to be the usual selling price.',
    types: ['misleading_reference_price'], url: ASA + 'john-lewis-plc-a26-1326172-john-lewis-plc.html' },
  { id: 'very_asa_2026', regulator: 'ASA', name: 'Shop Direct Home Shopping Ltd (Very)', match: 'Shop Direct', date: '2026', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A "Save £150" claim was misleading because the higher price had applied for only six days.',
    types: ['misleading_reference_price'], url: ASA + 'shop-direct-home-shopping-ltd--a26-1329278-shop-direct-home-shopping-ltd.html' },
  { id: 'dusk_asa_2026', regulator: 'ASA', name: 'DUSK (Retail) Ltd', date: '2026-06-03', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'An "up to 50% off + an extra 20%" sale was misleading: discount codes ran most days, so the reference prices were not the usual prices.',
    types: ['misleading_reference_price', 'fake_urgency'], url: ASA + 'dusk--retail--ltd-a25-1321807-dusk--retail--ltd.html' },
  { id: 'otty_asa_2025', regulator: 'ASA', name: 'OTTY Sleep Ltd', date: '2025-12-17', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A £799.99 "was" price and £75 saving were misleading because most mattresses sold below that price.',
    types: ['misleading_reference_price'], url: ASA + 'otty-sleep-ltd-a25-1303563-otty-sleep-ltd.html' },
  { id: 'simba_asa_2022', regulator: 'ASA', name: 'Simba Sleep Ltd', date: '2022-09-21', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A "New Customers! 36% off" claim was misleading: no pricing history was provided and the reference price had changed.',
    types: ['misleading_reference_price'], url: ASA + 'simba-sleep-ltd-a22-1151799-simba-sleep-ltd.html' },
  { id: 'winedrops_asa_2025', regulator: 'ASA', name: 'Banquist Ltd (Winedrops)', date: '2025', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A marketing email claiming "80% off" was misleading: it was ambiguous and there was no evidence of genuine savings.',
    types: ['misleading_reference_price', 'misleading_claim'], url: ASA + 'banquist-ltd-g25-1297841-banquist-ltd.html' },
  { id: 'grain_asa_2026', regulator: 'ASA', name: 'Grain Connect Ltd', date: '2026', penalty: null, volume: null, sector: null,
    summary: 'A promotional email warning that a named competitor\'s customers faced price rises was misleading and unsubstantiated.',
    types: ['misleading_claim'], url: ASA + 'grain-connect-ltd-a26-1333462-grain-connect-ltd.html' },
  { id: 'cluedupp_asa_2023', regulator: 'ASA', name: 'Uppholdings Ltd (CluedUpp Games)', date: '2023-11-22', penalty: null, volume: null, sector: null,
    summary: '"Only 14 tickets remaining" was false (44 of 50 were left) and hurried people into buying.',
    types: ['fake_urgency'], url: ASA + 'uppholdings-ltd-a23-1200152-uppholdings-ltd.html' },
  { id: 'tala_asa_2024', regulator: 'ASA', name: 'We Are TALA Ltd', date: '2024-05-22', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'The founder\'s Instagram and TikTok posts promoting the brand were not labelled as ads. A co-publishing tag was not enough.',
    types: ['undisclosed_ad', 'affiliate_ad_disclosure'], url: ASA + 'we-are-tala-ltd-g23-1218988-we-are-tala-ltd.html' },
  { id: 'endrick_asa_2025', regulator: 'ASA', name: 'Endrick Clothing Ltd', date: '2025-01-08', penalty: null, volume: null, sector: 'ecommerce',
    summary: 'A post showing the brand\'s outfits needed a clear "#ad" label upfront and had none.',
    types: ['undisclosed_ad'], url: ASA + 'endrick-clothing-ltd-g24-1264925-endrick-clothing-ltd.html' },
  { id: 'sancarlo_asa_2026', regulator: 'ASA', name: 'Harnbury Holdings Ltd (San Carlo)', date: '2026-09-23', penalty: null, volume: null, sector: null,
    summary: 'An influencer post paid for with free food and drink was not labelled as an ad.',
    types: ['undisclosed_ad', 'affiliate_ad_disclosure'], url: ASA + 'harnbury-holdings-ltd.html' },
  { id: 'minerva_asa_2026', regulator: 'ASA', name: 'Minerva Wellness Ltd', date: '2026-03', penalty: null, volume: null, sector: 'health',
    summary: 'Ads implied a menopause supplement could treat symptoms and used health claims that are not on the authorised register.',
    types: ['misleading_claim', 'asa_liability'], url: ASA + 'minerva-wellness-ltd-a25-1313816-minerva-wellness-ltd.html' },
  { id: 'nova_asa_2026', regulator: 'ASA', name: 'Nova Relief (Nova Menopause Vitality)', match: 'Nova Relief', date: '2026-03', penalty: null, volume: null, sector: 'health',
    summary: 'Gut health and oestrogen claims for a supplement were unauthorised, and the ads made medicinal claims.',
    types: ['misleading_claim', 'asa_liability'], url: ASA + 'nova-relief-a25-1313821-nova-relief.html' },

  // ── CMA: consumer law ──
  { id: 'wayfair_cma_2026', regulator: 'CMA', name: 'Wayfair', date: '2026-10-14', penalty: 4800000, volume: null, sector: 'ecommerce',
    summary: 'False time-limited offers: many products stayed at the same price or lower after the deadline. Fine includes a 40% settlement reduction.',
    types: ['fake_urgency'], url: CMA + '/cma-cases/wayfair-consumer-protection-enforcement-case' },
  { id: 'appliancesdirect_cma_2026', regulator: 'CMA', name: 'Appliances Direct (Buy It Direct Ltd)', date: '2026-10-14', penalty: 1200000, refunds: 432000, volume: null, sector: 'ecommerce',
    summary: 'Countdown offers that repeated the same codes for days, and extras opted in by default. About £432,000 refunded.',
    types: ['fake_urgency', 'drip_pricing'], url: CMA + '/cma-cases/appliances-direct-consumer-protection-enforcement-case' },
  { id: 'goldsgym_cma_2026', regulator: 'CMA', name: 'Gold’s Gym (UK) Ltd', match: 'Gym', date: '2026-10-14', penalty: 45000, refunds: 9000, volume: null, sector: null,
    summary: 'Membership prices left out the joining fee, so the total price was not given clearly and up front.',
    types: ['drip_pricing'], url: CMA + '/cma-cases/golds-gym-uk-limited-consumer-protection-enforcement-case' },
  { id: 'stubhub_cma_2026', regulator: 'CMA', name: 'StubHub UK', date: '2026-06-23', penalty: 889200, refunds: 590000, volume: 50000, sector: null,
    summary: 'Mandatory delivery and service fees were added at checkout instead of being in the price from the start. Over 50,000 fans refunded.',
    types: ['drip_pricing'], url: CMA + '/cma-cases/stubhub-consumer-protection-enforcement-case' },
  { id: 'marks_cma_2026', regulator: 'CMA', name: 'Marks Electrical', date: '2026-06-15', penalty: 720000, refunds: 600000, volume: 40000, sector: 'ecommerce',
    summary: 'Paid recycling and packaging extras were pre-selected without customers\' express agreement. Nearly 40,000 customers refunded.',
    types: ['drip_pricing'], url: CMA + '/cma-cases/marks-electrical-consumer-protection-enforcement-case' },
  { id: 'aa_cma_2026', regulator: 'CMA', name: 'AA and BSM Driving Schools', match: 'BSM', date: '2026-04', penalty: 4200000, refunds: 760000, volume: 80000, sector: null,
    summary: 'A mandatory £3 booking fee was left out of the upfront price for over 80,000 learners. The first CMA fine under its new consumer powers.',
    types: ['drip_pricing'], url: CMA + '/cma-cases/automobile-association-developments-limited-consumer-protection-enforcement-case' },
  { id: 'emma_cma_2026', regulator: 'CMA', name: 'Emma Sleep', date: '2026-05-22', penalty: null, volume: null, sector: 'ecommerce',
    outcome: 'Court-backed undertakings',
    summary: 'Admitted misleading countdown timers and false "high demand" and discount claims, and gave court-enforceable undertakings to stop.',
    types: ['fake_urgency', 'misleading_reference_price'], url: CMA + '/cma-cases/emma-group-consumer-protection-case' },
  { id: 'wowcher_cma_2024', regulator: 'CMA', name: 'Wowcher', date: '2024-07-15', penalty: null, refunds: 4271000, volume: 870000, sector: 'ecommerce',
    outcome: 'Undertakings and about £4.3M in customer credit',
    summary: 'Countdown timers and "running out" claims when most deals stayed available at a similar price, plus a pre-ticked paid VIP box. About 870,000 customers credited.',
    types: ['fake_urgency'], url: CMA + '/cma-cases/wowcher-group-consumer-protection-case' },
  { id: 'simba_cma_2024', regulator: 'CMA', name: 'Simba Sleep', date: '2024-07-25', penalty: null, volume: null, sector: 'ecommerce',
    outcome: 'Undertakings',
    summary: 'Agreed to change its discount claims and countdown clocks after a CMA investigation.',
    types: ['fake_urgency', 'misleading_reference_price'], url: CMA + '/cma-cases/simba-sleep-limited-consumer-protection-case' },
  { id: 'ticketmaster_cma_2025', regulator: 'CMA', name: 'Ticketmaster', date: '2025-09-15', penalty: null, volume: null, sector: null,
    outcome: 'Undertakings',
    summary: 'After the Oasis sale, agreed to stop misleading "platinum" labels and to tell fans in advance about tiered pricing.',
    types: ['misleading_claim', 'misleading_reference_price'], url: CMA + '/cma-cases/ticketmaster-consumer-protection-case' },
  { id: 'google_cma_2025', regulator: 'CMA', name: 'Google', date: '2025-01', penalty: null, volume: null, sector: null,
    outcome: 'Undertakings',
    summary: 'Agreed to sanction businesses that boost star ratings with fake reviews and to warn consumers on their profiles.',
    types: ['fake_reviews', 'misleading_claim'], url: CMA + '/government/news/cma-secures-important-changes-from-google-to-tackle-fake-reviews' },
  { id: 'amazon_cma_2025', regulator: 'CMA', name: 'Amazon', date: '2025-06', penalty: null, volume: null, sector: 'ecommerce',
    outcome: 'Undertakings',
    summary: 'Agreed to strengthen how it tackles fake reviews and sellers moving good reviews onto other products.',
    types: ['fake_reviews', 'misleading_claim'], url: CMA + '/government/news/amazon-gives-undertakings-to-cma-to-curb-fake-reviews' },
];

// Hand-checked cases above, then the approved imports from the regulator
// records (scripts/import-cases.mjs → data/case-review.json → publish-cases).
// An imported case with no page of its own keeps its source (the ICO register) for the
// link check but shows no link: a spreadsheet is no use to someone reading the case.
// ── What a case or a finding is about, finer than its type ──
// Two "misleading claim" findings can be about entirely different things (a
// green claim and a health claim), so a case is only set beside a finding
// about the same subject. Read from the regulator's own summary, never guessed.
const SUBJECTS = {
  environmental: /\b(green|environment\w*|eco[- ]?friendly|carbon|sustainab\w*|recycl\w*|net[- ]zero|climate|biodegrad\w*|emissions?)\b/i,
  health:        /\b(health|healthcare|medic\w*|cures?|treat(s|ment)?|weight[- ]loss|slimming|supplements?|vitamins?|nutrition\w*|immun\w*|cosmetic|botox|aesthetic|clinics?|pharmac\w*|cbd|diet\w*|prescription)\b/i,
  finance:       /\b(loans?|credit|invest(ment|ments|or|ors|ing)|crypto\w*|mortgages?|insurance|pensions?|apr|returns|trading (platform|app)|day trading|forex|fca|cobs|ppi|debt|financial)\b/i,
  price:         /\b(prices?|pricing|savings?|discounts?|reference price|was\s*£|cheapest|fees?|charges?|£\s?\d)/i,
  urgency:       /\b(urgency|limited[- ]time|ends (soon|today|tonight|midnight)|countdown|scarcity|only \d+ left|last chance|hurry|time[- ]limited|deadline)\b/i,
  reviews:       /\b(reviews?|testimonials?|ratings?|trustpilot|endorse\w*)\b/i,
  disclosure:    /\b(influencers?|#ad|sponsored|affiliate|paid partnership|obviously identifiable|identifiable as)\b/i,
  comparative:   /\b(comparative|competitors?|comparisons?|number one|no\.? ?1|best[- ]selling|(uk|world|britain|country)['’]?s (best|biggest|leading|favourite|cheapest))\b/i,
  gambling:      /\b(gambl\w*|betting|bets?|casino|slots|bingo|lottery)\b/i,
  alcohol:       /\b(alcohol\w*|beer|wine|spirits|gin|vodka)\b/i,
  food:          /\b(less healthy food|hfss|food|snacks?)\b/i,
  data:          /\b(wealth screening|data matching|data sharing|profil\w*|tele-?matching|personal data|data broker|bought data|purchased data|lists?)\b/i,
};
export const subjectsOf = text => Object.keys(SUBJECTS).filter(k => SUBJECTS[k].test(String(text || '')));
const CHANNELS = {
  email: /\be-?mails?\b/i,
  sms:   /\b(sms|texts?|text messages?)\b/i,
  calls: /\b(calls?|telephone|tps)\b/i,
  social:/\b(facebook|instagram|tiktok|meta|linkedin|social media|influencers?|youtube|snapchat|pinterest|x \(twitter\)|twitter)\b/i,
  web:   /\b(websites?|web ?pages?|product (pages?|listings?)|online|app)\b/i,
  directmail: /\b(leaflets?|direct mail|mailings?|brochures?|catalogues?|posters?|press ad)\b/i,
};
export const channelsOf = text => Object.keys(CHANNELS).filter(k => CHANNELS[k].test(String(text || '')));
// Types too broad to match on alone ("misleading claim" covers green, health,
// finance...): for these a case must share the finding's subject. A broad
// finding with no readable subject gets no case rather than a loose one.
export const BROAD_TYPES = new Set(['misleading_claim', 'asa_liability', 'missing_terms', 'sector_risk_unreviewed', 'partner_brand_risk']);
export function subjectFit(c, findingSubjects, fixType) {
  if (!BROAD_TYPES.has(fixType)) return true;
  if (findingSubjects.length) return (c.subjects || []).some(s => findingSubjects.includes(s));
  return false;
}
export const sharedSubjects = (c, findingSubjects) => (c.subjects || []).filter(s => findingSubjects.includes(s)).length;

const withSubjects = c => ({ ...c, subjects: subjectsOf(c.summary), channels: channelsOf(`${c.media || ''} ${c.summary || ''}`) });
export const CASES = [...CURATED.map(c => ({ ...c, curated: true })), ...IMPORTED.map(c => ({ ...c, imported: true, ...(c.noPage ? { sourceUrl: c.url, url: null } : {}) }))].map(withSubjects);

// For the dashboard and the method page: how big the library is
export const LIBRARY_STATS = CASES.reduce((s, c) => {
  s.total++;
  s[c.regulator] = (s[c.regulator] || 0) + 1;
  return s;
}, { total: 0 });

// Plain outcome line, for cases without a fine
export function caseOutcome(c) {
  if (c.penalty) return 'Fined £' + c.penalty.toLocaleString('en-GB');
  if (c.outcome) return c.outcome;
  return c.regulator === 'ASA' ? 'Upheld ASA ruling' : c.regulator + ' action';
}

// The words a source page must contain for the case to count as verified
export function matchWords(c) {
  return c.match || String(c.name).split(/[\s(]/)[0].replace(/[^\w&-]/g, '');
}

// Finding types that are the same issue under another name (from the
// copy checker and older tools), and ones close enough to show as a
// related published case. Same-issue types also count for Case Twin.
const SAME_ISSUE = {
  no_consent: ['consent_missing'],
  consent_expired: ['consent_missing'],
  no_soft_optin: ['consent_missing', 'invalid_consent_mechanism'],
  concealed_sender: ['affiliate_sender_identity_breach'],
  fake_scarcity: ['fake_urgency'],
  misleading_testimonial: ['fake_reviews'],
  affiliate_misleading_claims: ['misleading_claim'],
  partner_pricing_claims: ['misleading_reference_price', 'drip_pricing'],
  partner_no_data_sharing_agreement: ['dpa_breach'],
  no_article26_agreement: ['dpa_breach'],
  ad_disclosure: ['undisclosed_ad'],
  bundled_consent: ['invalid_consent_mechanism'],
  form_consent_not_specific: ['invalid_consent_mechanism'],
  expired_consent: ['consent_missing'],
  stale_consent_data: ['consent_missing'],
  misleading_pricing: ['misleading_reference_price'],
  reference_pricing: ['misleading_reference_price'],
  urgency: ['fake_urgency'],
  stock_urgency: ['fake_urgency'],
  sender_identity_unclear: ['affiliate_sender_identity_breach'],
  suppression_not_synced: ['suppression_breach'],
  objection_not_synced: ['suppression_breach'],
  unauthorised_health_claim: ['asa_liability', 'misleading_claim'],
  purpose_creep: ['legitimate_interest_abuse'],
};
const RELATED = {
  suppressed_contact: ['marketing_calls'],
  missing_terms: ['misleading_claim', 'drip_pricing'],
  missing_unsubscribe: ['suppression_breach'],
  unreviewed_joint_ads: ['misleading_claim', 'undisclosed_ad'],
  sector_risk_unreviewed: ['misleading_claim'],
  partner_brand_risk: ['misleading_claim'],
  invalid_consent_mechanism: ['consent_missing'],
  consent_provenance_missing: ['consent_missing', 'third_party_list'],
  consent_record_missing: ['consent_missing'],
  soft_optin_no_optout: ['consent_missing', 'suppression_breach'],
  dark_pattern: ['fake_urgency', 'drip_pricing'],
  no_dpa: ['dpa_breach'],
  no_data_sharing_agreement: ['dpa_breach', 'third_party_list'],
  custom_audience_no_basis: ['legitimate_interest_abuse'],
  privacy_no_notice: ['legitimate_interest_abuse', 'data_quality'],
  privacy_notice_incomplete: ['data_quality'],
  identity_company_details: ['affiliate_sender_identity_breach'],
  identity_no_address: ['affiliate_sender_identity_breach'],
  missing_address: ['affiliate_sender_identity_breach'],
};
export function sameIssueTypes(fixType) {
  return [fixType, ...(SAME_ISSUE[fixType] || [])];
}
export function relatedTypes(fixType) {
  return RELATED[fixType] || [];
}
