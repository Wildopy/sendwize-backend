// ─────────────────────────────────────────────────────────────
// SENDWIZE: _rulebook.js  v1.0
// The rules a piece of marketing is checked against, written down once,
// grouped into packs, and picked for each check:
//
//   selectRules({ sector, channel, text, unread })
//       → { packs: [{ id, name }], block }
//   block is the [RULES THAT APPLY] text added to the copy checker's
//   message to the AI. The AI must check the copy against every rule in
//   it and cite the reference given.
//
// How packs are picked:
//   - core packs (CAP Code, CMA/DMCCA) on every check
//   - PECR / UK GDPR for email, SMS, push and direct mail
//   - sector packs from the member's business profile (finance,
//     healthcare, gambling, charity, b2b...)
//   - topic packs whenever the copy itself mentions the topic (an
//     ecommerce brand selling alcohol gets the alcohol rules)
//   - unread: nothing to match against (a PDF, or an image with no typed
//     text): every pack is included, because the topic can't be seen yet
//
// Writing a rule: say what to look for, what kind of finding it is
// (CRITICAL: no evidence fixes it; EVIDENCE: fine if proof is on file;
// HIGH/MEDIUM: a clear or probable gap) and the reference to cite. Cite
// to the section when the exact sub-rule number isn't certain: a wrong
// rule number undermines the whole check.
//
// v1.0 (24 Nov 2026): first version. Written from the published codes,
//   regulations and guidance as at Nov 2026. The sector packs (finance,
//   healthcare, gambling) should be read by a specialist in that sector
//   before Sendwize is sold to firms in it.
// ─────────────────────────────────────────────────────────────

export const RULEBOOK_VERSION = 'rules-1.0';

// ── Packs ─────────────────────────────────────────────────────
// always: on every check. channels: only for these channels.
// sectors: on when the profile sector matches. topic: on when the copy
// matches. Rules are plain strings the AI reads.
const PACKS = [
  {
    id: 'cap_core', name: 'ASA CAP Code: general rules', always: true,
    rules: [
      'CAP Code section 2 (recognition): marketing must be obviously identifiable as marketing. Ads in editorial, social or creator content need a clear "Ad" label up front. A paid or gifted post with no ad label is CRITICAL.',
      'CAP Code 3.1 / 3.3: nothing that materially misleads, by what it says or by leaving out material information. Significant limitations and conditions (3.9, 3.10) must be stated clearly, not hidden in small print or behind a link where the claim is made. HIGH, or CRITICAL when the omission changes the offer.',
      'CAP Code 3.7: objective claims (numbers, "proven", "tested", "#1", "best-selling", "fastest", "lasts 10 years") need documentary evidence held before the ad runs. EVIDENCE.',
      'CAP Code 3.11: no exaggeration of what a product can do. Claims the evidence could never support are HIGH.',
      'CAP Code section 3 (prices): the quoted price must include VAT and every non-optional fee for consumers. "From" prices need a fair number of items at that price. Was/now and RRP savings need the higher price to be genuine (EVIDENCE). Unit pricing where the Price Marking Order 2004 requires it.',
      'CAP Code section 3 ("free"): only call something free if the consumer pays nothing beyond the unavoidable cost of responding and collecting. Free trials must make the cost after the trial and how to cancel clear. HIGH.',
      'CAP Code section 3 (availability and urgency): stock, demand and time-limited claims must be true (EVIDENCE). A countdown in minutes or hours, or urgency with no real end, is CRITICAL.',
      'CAP Code section 3 (comparisons): comparisons with competitors or identifiable products must compare like with like, be verifiable and not denigrate. EVIDENCE for the comparison data, HIGH if the comparison is unfair on its face.',
      'CAP Code section 3 (endorsements and testimonials): testimonials must be genuine, current and held on file (EVIDENCE). Reviews must not be selected to mislead. Fake, paid-for or incentivised reviews without disclosure are CRITICAL (also a DMCCA banned practice).',
      'CAP Code section 3 (trust marks and awards): do not show a trust mark, award, accreditation or "as seen in" that has not been granted or is out of date. EVIDENCE.',
      'CAP Code section 4 (harm and offence): nothing likely to cause serious or widespread offence, nothing that condones harmful or dangerous behaviour, no harmful gender stereotypes, no sexualisation or objectification. CRITICAL for serious offence, HIGH otherwise.',
      'Images, filters and AI-generated content: a filter, retouching or an AI-generated image that exaggerates what the product does (especially beauty and cosmetics results) is misleading under CAP Code 3.1 and 3.11. HIGH. Undisclosed AI is not itself a breach unless it misleads.',
    ],
  },
  {
    id: 'cma_dmcca', name: 'CMA: consumer protection (DMCCA 2024)', always: true,
    rules: [
      'DMCCA 2024 s.226 misleading actions and s.227 misleading omissions: the overall impression must not mislead the average consumer into a decision they would not otherwise take. Cite "DMCCA 2024 s.226" or "s.227".',
      'DMCCA 2024 s.230 (invitation to purchase): when the ad gives the product and a price, it must also give the total price including all mandatory fees (drip pricing), the trader\'s identity, and material conditions. Mandatory fees left out of the headline price are CRITICAL.',
      'DMCCA 2024 Schedule 20 banned practices (unfair in all circumstances), each CRITICAL: fake or falsely presented reviews, and commissioning or hiding reviews; false claims that a product is available only for a very limited time; bait advertising; claiming to be bound by a code of conduct or to hold a trust mark or approval the trader does not have; describing something as "free" when it is not; presenting a paid placement or advertorial without making clear it is paid for; claiming a product can cure illness when it cannot; creating the false impression a prize has been won.',
      'DMCCA 2024 s.228 aggressive practices: pressure selling, exploiting a known vulnerability or misfortune, or obstacles to cancelling. HIGH.',
      'CMA online choice architecture: pre-ticked add-ons or extras opted in by default, confirm-shaming ("No thanks, I don\'t want to save money"), fake countdown timers and fake "X people are viewing" messages. HIGH, CRITICAL for fake timers or opt-in by default for paid extras.',
      'CMA Green Claims Code and fake reviews guidance apply where the copy makes those claims (see the environmental and review rules).',
    ],
  },
  {
    id: 'consumer_terms', name: 'Consumer contracts and rights', always: false,
    sectors: ['ecommerce', 'saas', 'media', 'general'],
    topic: /\b(buy now|shop|order|checkout|basket|delivery|returns?|refunds?|subscri\w+|membership|free trial|cancel|renew\w*|guarantee|warranty)\b/i,
    rules: [
      'Consumer Rights Act 2015: do not say or imply that consumers lose their statutory rights. "No refunds" or "sale items cannot be returned" without "this does not affect your statutory rights" is HIGH.',
      'Consumer Contracts Regulations 2013: online and distance sales carry a 14-day right to cancel for most goods and services. Copy that denies or shortens it is HIGH.',
      'Guarantees and warranties: say who gives it, how long it lasts and what it covers. A guarantee the terms do not back up is HIGH.',
      'Subscriptions and free trials: state the price after any trial or introductory period, how often it is charged, that it renews automatically, and how to cancel, before the consumer commits. HIGH when left out. (The DMCCA subscription contract rules are due to start in 2027; until then this comes from CAP Code section 3 and DMCCA s.227.)',
      'Delivery claims ("next-day delivery", "guaranteed Christmas delivery") must state significant limits such as order cut-off times and excluded areas. HIGH when left out.',
    ],
  },
  {
    id: 'pecr_gdpr', name: 'PECR and UK GDPR (direct marketing)', always: false,
    channels: ['email', 'sms', 'push', 'directmail'],
    rules: [
      'PECR Reg 22: marketing emails and texts to individuals (including sole traders and partnerships) need prior consent, or the soft opt-in (details collected during a sale or negotiation, similar products, opt-out offered at collection and in every message). Consent to unnamed "partners" is not valid consent for this sender. The Data (Use and Access) Act 2025 extends the soft opt-in to charities.',
      'PECR Reg 22 / 23: every marketing email and text must give a simple, free way to opt out and must not disguise or conceal who sent it.',
      'UK GDPR Articles 6 and 7: consent must be freely given, specific, informed, unambiguous and as easy to withdraw as to give. Pre-ticked boxes and consent bundled with terms are CRITICAL.',
      'UK GDPR Articles 13 and 14: where the copy collects personal data (a sign-up form, a "reply with your details"), it must say who is collecting it and link to the privacy information. MEDIUM.',
      'Direct mail: legitimate interests is usually the basis, so people must be able to object. Screen against the Mailing Preference Service as good practice. LOW.',
      'Marketing calls (if the copy is a call script or invites a call): screen against the TPS and CTPS. Automated (recorded) marketing calls need specific prior consent. HIGH.',
    ],
  },
  {
    id: 'children', name: 'Children and young people', always: false,
    topic: /\b(kids?|child(ren)?|toddlers?|bab(y|ies)|toys?|school|pupils?|teens?|teenagers?|under[- ]?1[0-8]s?|young people|parents?|pocket money|playground|cartoon)\b/i,
    rules: [
      'CAP Code section 5: marketing to or featuring children must not cause them physical, mental or moral harm, exploit their credulity or inexperience, or make them feel inferior or unpopular for not having the product. HIGH.',
      'CAP Code section 5: no direct exhortation to children to buy or to ask their parents to buy ("Ask your mum for one", "Get yours now" aimed at children). HIGH.',
      'CAP Code section 5: prices must not be minimised ("only", "just") in ads aimed at children, and promotions must make clear if adult permission is needed. MEDIUM.',
      'Age-restricted products (alcohol, gambling, HFSS food, e-cigarettes, medicines) must not be directed at or strongly appeal to under-18s. CRITICAL.',
    ],
  },
  {
    id: 'promotions', name: 'Sales promotions, prize draws and competitions', always: false,
    topic: /\b(win|winners?|prizes?|competitions?|giveaways?|prize draw|sweepstakes?|instant win|enter (now|today|to win)|chance to win|raffle|free entry)\b/i,
    rules: [
      'CAP Code section 8: promotions must state all significant conditions or make them clear where the promotion is seen: how to take part, any purchase or cost, the closing date (8.17), eligibility (age, location), the number and nature of prizes, and the promoter\'s name and address if not obvious. HIGH for each one missing.',
      'CAP Code section 8: promoters must run promotions fairly, award the prizes described and avoid unnecessary disappointment. Prize draws need independent supervision or a verifiable random process. EVIDENCE.',
      'Gambling Act 2005: a prize draw that requires payment to enter is an illegal lottery unless there is a free entry route that is genuinely as easy, or the competition needs real skill. CRITICAL when payment is required with no free route and no skill.',
      'Social media giveaways: "like, share and tag" mechanics must follow the platform\'s rules and the CAP Code; winners must be picked fairly and announced. MEDIUM.',
    ],
  },
  {
    id: 'environmental', name: 'Environmental claims', always: false,
    topic: /\b(eco[- ]?friendly|sustainab\w+|green(er)?|carbon[- ]?(neutral|negative|zero|footprint|offset\w*)|net[- ]?zero|climate|planet|recycl\w+|biodegradab\w+|compostab\w+|plastic[- ]free|natural|organic|renewable|emissions?|environment\w*|ethical\w*|vegan)\b/i,
    rules: [
      'CAP Code section 11 and the CMA Green Claims Code: environmental claims must be truthful, clear, specific, based on the full life cycle where relevant, and backed by robust evidence. EVIDENCE for every specific claim.',
      'Absolute claims ("eco-friendly", "sustainable", "green", "carbon neutral", "kind to the planet") need a very high level of evidence. "100%" absolute claims are CRITICAL; other absolute claims with no basis given are HIGH.',
      'Carbon neutral or net zero claims must say whether they rely on offsetting, and what is offset. HIGH when left out.',
      'Comparative green claims ("greener", "50% less plastic") must say what they are compared with. HIGH when the comparison is missing.',
      'Do not present a legal requirement as a special benefit, or hide a product\'s more harmful aspects. MEDIUM.',
    ],
  },
  {
    id: 'finance', name: 'Financial services (FCA)', always: false,
    sectors: ['finance'],
    topic: /\b(invest\w*|isa|isas|pensions?|crypto\w*|bitcoin|apr|loans?|borrow\w*|mortgages?|insurance|fca|financial advi\w+|wealth management|savings accounts?|interest rates?|trading (app|platform|account)|shares?|stocks|bnpl|buy now,? pay later|pay ?day loans?|credit (cards?|score|checks?|broker\w*))\b/i,
    rules: [
      'FSMA 2000 s.21: only an FCA-authorised firm may communicate a financial promotion, or an authorised firm with the s.21 approver permission must approve it first. Copy promoting a regulated financial product with no sign it was made or approved by an authorised firm is CRITICAL (a process check: confirm approval).',
      'FCA COBS 4.2 (and CONC 3.3, ICOBS 2.2, MCOB 3A for credit, insurance and mortgages): every financial promotion must be fair, clear and not misleading. Benefits must not be shown without a fair and prominent indication of the relevant risks. HIGH.',
      'FCA Consumer Duty (PRIN 2A, consumer understanding outcome): communications to retail customers must be likely to be understood by the average customer of the product, with key information not buried. MEDIUM.',
      'Finfluencers and affiliates: a creator promoting a financial product is communicating a financial promotion. Without s.21 approval it is CRITICAL (FCA FG24/1).',
      'Tax wording: tax-free or tax-efficient claims (ISAs, pensions) must say that tax treatment depends on individual circumstances and may change. MEDIUM.',
    ],
  },
  {
    id: 'finance_invest', name: 'Investments, pensions and cryptoassets', always: false,
    topic: /\b(invest\w*|(annual|investment|guaranteed|average|\d+\s?%) returns?|yields?|dividends?|isa|isas|pensions?|portfolio|shares|stocks|trading (app|platform|account)|forex|cfds?|crypto\w*|bitcoin|ethereum|nfts?|peer[- ]to[- ]peer lending|p2p|bonds|capital at risk)\b/i,
    rules: [
      'FCA COBS 4.2: "guaranteed", "safe", "no risk" or "can\'t lose" for any investment whose value can fall is CRITICAL. Future returns presented as certain or likely are CRITICAL.',
      'FCA COBS 4.5 / 4.5A: retail investment promotions need a prominent risk warning that the value can fall as well as rise and investors may get back less than they put in ("Capital at risk"). HIGH when missing.',
      'FCA COBS 4.6 past performance: it must not be the most prominent feature, should cover the last 5 complete years (or since launch if shorter) in 12-month periods, state the source and currency, and carry "Past performance is not a reliable indicator of future results". The disclaimer missing is HIGH; the performance data itself is EVIDENCE.',
      'FCA COBS 4.12A high-risk investments (restricted mass market investments, including cryptoassets, peer-to-peer loans and non-readily realisable securities): the prescribed risk warning must be shown prominently, there must be no incentive to invest (bonuses, refer-a-friend, "free shares" for investing), and first-time investors get a cooling-off period and appropriateness checks. Missing warning or an incentive is CRITICAL.',
      'Cryptoasset promotions (in the FCA regime since 8 Oct 2023): the warning must say "Don\'t invest unless you\'re prepared to lose all the money you invest. This is a high-risk investment and you should not expect to be protected if something goes wrong." with a "Take 2 mins to learn more" link. CRITICAL when missing.',
      'Pensions: pension transfer or "unlock your pension" promotions are a scam warning sign and a high FCA priority. CRITICAL when they promise early access or guaranteed returns.',
    ],
  },
  {
    id: 'finance_credit', name: 'Consumer credit, BNPL and mortgages', always: false,
    topic: /\b(apr|loans?|credit|borrow\w*|lend\w*|finance (available|options?|deal)|0% finance|interest[- ]free|pay (later|monthly|in \d)|klarna|clearpay|paypal credit|bnpl|buy now,? pay later|mortgages?|remortgage|overdraft|credit cards?|pay ?day|debt|consolidat\w*)\b/i,
    rules: [
      'FCA CONC 3.5: a credit promotion that states an interest rate or any amount relating to the cost of credit must include a representative example (representative APR, rate, amount of credit, total amount payable and so on), more prominent than the cost figure that triggered it. HIGH when missing.',
      'FCA CONC 3.3: credit promotions must not say or imply credit is available regardless of financial circumstances ("no credit checks", "guaranteed approval", "bad credit no problem") and must not describe credit as "free" when it is not. CRITICAL.',
      'FCA CONC 3.4.1: high-cost short-term credit promotions must carry the warning "Late repayment can cause you serious money problems. For help, go to moneyhelper.org.uk." CRITICAL when missing.',
      'Buy now, pay later (deferred payment credit) is regulated by the FCA from 2026: treat BNPL offers in checkout copy as credit promotions, including who provides the credit and that missed payments can affect credit files. HIGH when the lender or the risks are missing.',
      'Mortgages (FCA MCOB 3A): promotions must be fair, clear and not misleading, show an APRC representative example where cost figures appear, and carry the "your home may be repossessed" warning where required. HIGH.',
      'Debt solutions and consolidation: must not imply debts will be written off, that it is a government scheme, or that it is free when fees apply. CRITICAL.',
    ],
  },
  {
    id: 'insurance', name: 'Insurance', always: false,
    topic: /\b(insurance|insurers?|insured|underwrit\w+|premiums?|breakdown cover|pet cover|life cover|home cover|car cover|travel cover|warranty plan)\b/i,
    rules: [
      'FCA ICOBS 2.2: insurance promotions must be fair, clear and not misleading. Significant exclusions, excesses and limits must be made clear where the cover is promoted. HIGH.',
      'Price claims ("from £X a month", "save up to X%") must say what the figure is based on and how many customers got it. EVIDENCE.',
      'FCA pricing practices (ICOBS 6B): renewal prices for home and motor insurance must not exceed the equivalent new-customer price. Copy promising new-customer-only discounts on those products is HIGH.',
    ],
  },
  {
    id: 'health_medicines', name: 'Medicines, treatments and healthcare', always: false,
    sectors: ['healthcare', 'health'],
    topic: /\b(medicines?|medication|prescription|pharmac(y|ist)|doctors?|gp|clinic\w*|treatments?|treats? (acne|eczema|psoriasis|pain|anxiety|depression|insomnia|hair loss|arthritis)|cures?|cured|therap(y|ies|ist)|symptoms?|pain relief|diseases?|diagnos\w+|weight[- ]loss (injection|jab)s?|wegovy|mounjaro|ozempic|semaglutide|tirzepatide|botox|botulinum|anti[- ]wrinkle injections?|dermal fillers?|lip fillers?|aesthetics? clinic|cosmetic (surgery|procedure)s?|medical devices?|private health\w*|dentist\w*|ivf|fertility|hrt)\b/i,
    rules: [
      'Human Medicines Regulations 2012, Part 14 (reg 284): prescription-only medicines must not be advertised to the public. This includes naming or showing weight-loss injections (semaglutide, tirzepatide, Wegovy, Mounjaro), botulinum toxin (Botox) and other POMs, or promoting "weight-loss injection" or "anti-wrinkle injection" services in a way that promotes the medicine. CRITICAL. (An ASA and MHRA enforcement priority.)',
      'Human Medicines Regulations 2012, Part 14: only licensed medicines may be advertised. Ads for over-the-counter medicines must encourage rational use, present the product objectively, include the product name and common name, the indications, and a clear invitation to read the label or leaflet. HIGH when missing.',
      'CAP Code section 12: medicinal claims (to treat, cure or prevent a disease, or relieve symptoms) may be made only for a licensed medicine or a properly marked medical device used for its intended purpose. Medicinal claims for cosmetics, food, supplements or services are CRITICAL.',
      'CAP Code section 12: do not discourage people from seeking essential treatment, and do not offer to diagnose or treat conditions for which medical supervision should be sought, unless through suitably qualified professionals. CRITICAL.',
      'CAP Code section 12: health claims need robust evidence, usually trials on people (EVIDENCE). Testimonials alone do not substantiate efficacy claims.',
      'CAP Code section 12: health professionals and celebrities must not be shown endorsing medicines. Practitioners must not claim qualifications they don\'t hold. HIGH.',
      'Cosmetic interventions: ads must not be aimed at under-18s, must not trivialise surgery or use time-limited deals and pressure ("book now, 20% off this week") for surgery or injectables, and must not exploit insecurities about appearance. HIGH.',
      'ABPI Code of Practice (for pharmaceutical companies): promotion of prescription medicines is only to health professionals; material for the public must be non-promotional, balanced and factual. CRITICAL if a pharma company\'s piece aimed at the public promotes a POM.',
      'Medical devices (UK MDR 2002): claims must stay within the device\'s intended purpose as stated in its conformity marking. HIGH.',
    ],
  },
  {
    id: 'food_health_claims', name: 'Food, supplements and nutrition claims', always: false,
    topic: /\b(vitamins?|minerals?|supplements?|protein|probiotic\w*|collagen|superfoods?|immun\w*|metabolism|detox\w*|gut health|fibre|low (fat|sugar|salt|calorie)|sugar[- ]free|high in|source of|nutri\w+|calories?|keto|diet\w*|wellness|wellbeing)\b/i,
    rules: [
      'GB nutrition and health claims rules (retained Regulation 1924/2006) and CAP Code section 15: only health claims on the GB NHC Register may be made, in wording that keeps the authorised meaning, and only for products that meet the conditions of use. Unauthorised health claim wording ("boosts immunity", "detoxes your body", "burns fat") is HIGH; authorised claims are EVIDENCE that the product qualifies.',
      'Nutrition claims ("low fat", "high in protein", "source of fibre", "sugar free") must meet the conditions in the Regulation\'s annex. EVIDENCE.',
      'General health statements ("good for you", "supports wellbeing") must be accompanied by a specific authorised health claim. MEDIUM.',
      'Food and supplements must not claim to prevent, treat or cure disease. CRITICAL.',
      'Food supplements must not claim or imply that a balanced diet cannot provide enough nutrients. MEDIUM.',
      'Infant formula must not be advertised. Follow-on formula ads must not be confused with infant formula. CRITICAL.',
    ],
  },
  {
    id: 'hfss', name: 'Less healthy food and drink (HFSS)', always: false,
    topic: /\b(chocolate|sweets?|candy|crisps?|biscuits?|cakes?|pastr(y|ies)|doughnuts?|ice cream|pizza|burgers?|chips|fries|fried chicken|fizzy|soft drinks?|cola|energy drinks?|milkshakes?|breakfast cereals?|desserts?|takeaway|fast food|snacks?)\b/i,
    rules: [
      'Less healthy food and drink advertising restrictions (in force from 5 January 2026, under the Health and Care Act 2022 amendments): paid online advertising of identifiable less healthy (HFSS) products is banned, and TV ads for them are restricted to after 9pm. Brands with fewer than 250 staff are exempt. Paid social or display ads showing an HFSS product are HIGH; confirm the product\'s nutrient profiling score or the exemption (EVIDENCE).',
      'CAP Code section 15: HFSS products must not be advertised in media aimed at or strongly appealing to under-16s, and promotions must not use licensed characters or celebrities popular with children. HIGH.',
    ],
  },
  {
    id: 'beauty', name: 'Beauty and cosmetics', always: false,
    topic: /\b(skin ?care|skin|serums?|moisturi[sz]\w*|anti[- ]?(ageing|aging|wrinkle)|wrinkles?|fine lines|collagen|lashes|mascara|hair (growth|loss)|cosmetics?|beauty|clinically (proven|tested)|dermatologist\w*|beauty filters?|face filters?|before and after|self[- ]tan\w*|teeth whitening|tooth whitening)\b/i,
    rules: [
      'CAP Code 3.1 and the ASA\'s filters guidance: social media filters and retouching that exaggerate the effect of a beauty product are misleading. CRITICAL where the image shows the product\'s effect.',
      'Cosmetics Regulation (retained 1223/2009) common criteria: claims must be truthful, supported by evidence, honest and fair. "Clinically proven", "dermatologist tested", percentage results ("87% saw fewer wrinkles") are EVIDENCE.',
      'Cosmetics may not make medicinal claims (treat acne, cure eczema, regrow hair by treating a condition). CRITICAL.',
      'Before-and-after images must be genuine, unretouched in the relevant area and typical of the results. EVIDENCE.',
      'Tooth whitening with more than 0.1% hydrogen peroxide must be carried out by a dental professional. Promoting it otherwise is CRITICAL.',
    ],
  },
  {
    id: 'weight_control', name: 'Weight control and slimming', always: false,
    topic: /\b(weight[- ]?loss|lose weight|slim\w*|fat[- ]?(burn\w*|loss)|diet (pills?|plan|programme)|appetite|lose \d+\s?(lb|lbs|kg|pounds|stone)|drop a dress size|bikini body|meal replacement)\b/i,
    rules: [
      'CAP Code section 13: weight-loss claims must be backed by evidence and realistic. Claims of rapid loss, of losing weight from specific parts of the body, or that weight loss is effortless are HIGH.',
      'CAP Code section 13: weight-control products and services must not be aimed at under-18s or people for whom weight loss would be unsafe. CRITICAL.',
      'Weight-loss medicines are prescription-only and must not be advertised to the public (see the medicines rules). CRITICAL.',
      'Diet supplements must not claim that a balanced diet is insufficient, or that the product alone causes weight loss without diet and exercise. HIGH.',
    ],
  },
  {
    id: 'gambling', name: 'Gambling', always: false,
    sectors: ['gambling'],
    topic: /\b(bets?|betting|bookmakers?|bookies|odds on|casino|slots|free spins|jackpot|poker|bingo|wager\w*|sportsbook|accumulators?|acca|in[- ]play|free bets?|gambl\w*)\b/i,
    rules: [
      'CAP Code section 16: gambling ads must be socially responsible. They must not have strong appeal to under-18s (characters, celebrities, sports stars or influencers with strong youth appeal), nor feature anyone who is or seems under 25 gambling or playing a significant role. CRITICAL.',
      'CAP Code section 16: no suggestion that gambling can solve financial problems, is an alternative to work, can enhance personal qualities or social, sexual or financial success, or is linked to seduction. No exploiting susceptibilities. CRITICAL.',
      'CAP Code section 16: must not portray gambling as a way to recover losses, or encourage gambling that is socially irresponsible or could lead to financial, physical or emotional harm. CRITICAL.',
      'Free bets, bonuses and free spins: all significant terms (wagering requirements, minimum odds, deposit needed, expiry, game restrictions) must be stated where the offer is made. HIGH. UK Gambling Commission rules from January 2026 cap wagering requirements at 10 times the bonus and ban promotions that mix gambling products.',
      'UKGC LCCP: licensees must follow the CAP Code and the industry code for socially responsible advertising, including safer gambling messaging. Copy with no safer gambling message is MEDIUM.',
      'Direct marketing for gambling needs specific consent to gambling marketing (PECR) and must not go to self-excluded customers. CRITICAL.',
    ],
  },
  {
    id: 'lotteries', name: 'Lotteries and raffles', always: false,
    topic: /\b(lottery|lotteries|raffle|tickets? (for|to) win|win (a|the) (house|car)|charity draw|lotto)\b/i,
    rules: [
      'CAP Code section 17: lottery ads must not be aimed at or strongly appeal to under-18s and must not exaggerate the chance of winning or suggest participating is a way to solve financial problems. CRITICAL.',
      'Gambling Act 2005: only licensed society lotteries, local authority lotteries and the National Lottery may be promoted. A raffle with paid entry and no licence or exemption, or no free entry route, is CRITICAL.',
    ],
  },
  {
    id: 'alcohol', name: 'Alcohol', always: false,
    topic: /\b(alcohol\w*|beer|lager|ale|cider|wine|prosecco|champagne|spirits (and||wine|prosecco|champagne|spirits?|gin|) liqueurs|gin|vodka|whisk(e)?y|rum|tequila|cocktails?|booze|pints?|happy hour|brewery|distillery|abv|drinks? (deal|offer|promotion))\b/i,
    rules: [
      'CAP Code section 18: alcohol ads must not be directed at or appeal particularly to under-18s, and must not feature anyone who is or seems under 25 drinking or playing a significant role. CRITICAL.',
      'CAP Code section 18: must not link alcohol with social, sexual or professional success, popularity, daring or toughness; must not suggest it can enhance confidence, mood or performance, or has therapeutic qualities. HIGH.',
      'CAP Code section 18: must not encourage excessive or irresponsible drinking (including "bottomless" or "drink as much as you like" offers), or link alcohol with driving or dangerous activities. HIGH.',
      'CAP Code section 18: alcoholic strength may only be emphasised for lower-alcohol drinks. HIGH.',
      'Meta and other platforms require age-gating and an under-18s notice for alcohol ads; ads without one can be removed and accounts restricted. MEDIUM.',
    ],
  },
  {
    id: 'nicotine', name: 'E-cigarettes, vapes and tobacco', always: false,
    topic: /\b(vapes?|vaping|e-?cig\w*|e-?liquids?|nicotine|tobacco|cigarettes?|cigars?|rolling papers|shisha|snus)\b/i,
    rules: [
      'Tobacco and Related Products Regulations 2016: nicotine-containing e-cigarettes may not be advertised in most online media, including paid social, display and most social posts by the brand. Factual product information on the retailer\'s own website is allowed. Online promotion of nicotine vapes is CRITICAL.',
      'CAP Code section 22: e-cigarette ads must not appeal to under-18s, feature anyone who is or seems under 25, encourage non-smokers to start, or make medicinal claims unless the product is licensed. CRITICAL.',
      'Tobacco advertising and promotion is banned (Tobacco Advertising and Promotion Act 2002). CRITICAL.',
    ],
  },
  {
    id: 'income_claims', name: 'Earnings claims, courses and business opportunities', always: false,
    topic: /\b(earn|income|make (£|\$)?\d|£\d+k?\s*(a|per) (month|week|day|year)|side hustle|passive income|financial freedom|quit your job|work from home|be your own boss|business opportunit\w*|franchise|mentor\w*|coaching|course|academy|masterclass|dropshipping|affiliate marketing|trading course|six figures|7 figures|millionaire)\b/i,
    rules: [
      'CAP Code section 20: ads for business opportunities and home-working schemes must make clear the nature of the work, any upfront cost, and must not overstate earnings. Earnings claims must be typical and backed by evidence. Untypical income claims ("I make £20k a month") are HIGH, and EVIDENCE for any figure. (Recent ASA rulings against business coaches turned on exactly this.)',
      'CAP Code 3.1 and 3.11: lifestyle claims ("work 2 hours a day", "quit your job in 30 days") must be achievable for a typical customer. HIGH.',
      'Job ads must not be a disguised business opportunity or require payment to apply. CRITICAL.',
      '"Free" training or guides that lead to a paid course must make clear what is free and what costs money. HIGH.',
    ],
  },
  {
    id: 'motoring', name: 'Motoring', always: false,
    topic: /\b(cars?|vehicles?|suvs?|mpg|miles per gallon|electric range|electric vehicles?|evs?|hybrids?|0-60|bhp|horsepower|test drives?|dealership|pcp|hire purchase|car leas\w+|motorbikes?)\b/i,
    rules: [
      'CAP Code section 19: motoring ads must not condone or encourage dangerous, competitive, inconsiderate or irresponsible driving, or make speed or acceleration the main message. HIGH.',
      'Fuel economy and CO2 figures must use the official (WLTP) test figures. Electric range claims must be the official figure and make clear real-world range varies. EVIDENCE.',
      'Car finance (PCP, HP, leasing) is consumer credit: a representative example is needed when cost figures appear (see the credit rules). HIGH.',
    ],
  },
  {
    id: 'telecoms', name: 'Broadband and mobile', always: false,
    topic: /\b(broadband|fibre|full fibre|mbps|gbps|wi-?fi|router|mobile (contract|plan|deal|tariff)|sim[- ]only|5g|4g|data allowance|unlimited data|landline|price rise)\b/i,
    rules: [
      'Broadband descriptions: Ofcom expects providers to describe the technology clearly, and "full fibre" may only be used where fibre runs all the way to the premises. Speed claims follow CAP guidance: base them on the speed available to at least 50% of customers at peak time. HIGH.',
      'Ofcom rules (since January 2025): any price rise during a contract must be set out in pounds and pence at the point of sale, not as an inflation-linked percentage. HIGH.',
      '"Unlimited" may only be used if there is no fair use limit that would surprise a typical user. HIGH.',
    ],
  },
  {
    id: 'property', name: 'Property sales and lettings', always: false,
    topic: /\b(for sale|to let|to rent|letting agents?|lettings|estate agents?|landlords?|tenan\w+|freehold|leasehold|ground rent|service charges?|council tax|epc|asking price|guide price|offers over|\d+[- ]bed(room)?s?)\b/i,
    rules: [
      'Consumer protection law and National Trading Standards material information guidance: property listings must include material information such as price or rent, council tax band, tenure (and for leaseholds the lease length, ground rent and service charge), and other material facts. HIGH when missing.',
      'Tenant Fees Act 2019: letting ads must not mention or charge prohibited fees, and must show permitted payments (such as the deposit) clearly. HIGH.',
      'Photos and descriptions must not mislead about size, condition or location. MEDIUM.',
    ],
  },
  {
    id: 'travel', name: 'Travel and holidays', always: false,
    topic: /\b(holidays?|package holidays?|flights?|hotels?|resorts?|cruises?|all[- ]inclusive|atol|abta|city breaks?|getaways?|per person)\b/i,
    rules: [
      'Prices must include all unavoidable taxes and charges (airport taxes, resort fees). Per-person prices must say so and state the basis (for example two sharing). HIGH.',
      '"From" prices need reasonable availability at that price. EVIDENCE.',
      'ATOL or ABTA claims must be genuine and current (EVIDENCE). Package Travel Regulations 2018: package holidays need the pre-contract information before booking. MEDIUM.',
    ],
  },
  {
    id: 'charity', name: 'Charities and fundraising', always: false,
    sectors: ['charity'],
    topic: /\b(donat\w+|charity|charitable|fundrais\w*|gift aid|sponsor (a|an)|legacy|legacies|volunteer\w*)\b/i,
    rules: [
      'Code of Fundraising Practice (Fundraising Regulator): fundraising must be legal, open, honest and respectful, must not put undue pressure on donors, and must take care with people who may be in vulnerable circumstances. HIGH.',
      'Claims about how donations are used ("£5 feeds a family for a week") must be accurate and supported. EVIDENCE.',
      'Gift Aid wording must be accurate and the declaration must follow HMRC requirements. MEDIUM.',
      'Shocking or distressing imagery must be justified and not likely to cause serious or widespread offence (CAP Code section 4). MEDIUM.',
    ],
  },
  {
    id: 'b2b', name: 'Business-to-business marketing', always: false,
    sectors: ['b2b', 'saas', 'agency'],
    rules: [
      'Business Protection from Misleading Marketing Regulations 2008: B2B marketing must not mislead other businesses, and comparative advertising must be fair and verifiable. Cite "BPRs 2008". HIGH.',
      'CAP Code still applies to B2B ads (except the consumer-only price rules). Claims need evidence (EVIDENCE).',
      'Emails to corporate addresses need no prior consent under PECR, but must identify the sender and give an opt-out. Emails to sole traders and partnerships need consent like consumers.',
    ],
  },
];

const CHANNEL_DEFAULT = 'email';
const clean = s => String(s || '').toLowerCase();

// Pick the packs for one check. `unread`: the piece can't be read by code
// (a PDF, or images with no typed text), so every pack goes in.
export function selectRules({ sector = '', channel = CHANNEL_DEFAULT, text = '', unread = false } = {}) {
  const sec = clean(sector);
  const t = String(text || '');
  const picked = PACKS.filter(p => {
    if (p.always) return true;
    if (p.channels) return p.channels.includes(channel);
    if (unread) return true;
    if (p.sectors && p.sectors.includes(sec)) return true;
    return !!(p.topic && p.topic.test(t));
  });
  const block = [
    '[RULES THAT APPLY TO THIS PIECE]',
    unread
      ? 'Sendwize could not read this piece as text before sending it to you, so every rule set is listed. Apply the ones that fit what the piece is about and ignore the rest.'
      : `Chosen for this piece from the business's sector${sec ? ` (${sec})` : ''}, the channel and what the copy talks about.`,
    'Check the piece against EVERY rule below, as well as the general rules in your instructions. Raise a finding for each rule the piece falls short of, with the severity or kind the rule gives (CRITICAL, HIGH, MEDIUM, EVIDENCE = requiresEvidence true). Cite the reference the rule gives; never invent a rule number.',
    'Use the most specific issue_type: financial_promotion for FCA rules, restricted_product for alcohol, gambling, HFSS, tobacco, vapes and prescription medicines, medicinal_claim and health_claim for health, vulnerable_audience for children.',
    ...picked.flatMap(p => [`\n## ${p.name}`, ...p.rules.map(r => `- ${r}`)]),
    '[END RULES]',
  ].join('\n');
  return { packs: picked.map(p => ({ id: p.id, name: p.name })), block };
}

export const RULE_PACKS = PACKS.map(p => ({ id: p.id, name: p.name, rules: p.rules.length, sectors: p.sectors || [], always: !!p.always, channels: p.channels || null }));
