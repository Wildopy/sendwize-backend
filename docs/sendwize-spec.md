# Sendwize: product spec and tools reference (v12)

Updated 21 Oct 2026 against `Wildopy/sendwize-backend` `main` at `8648f0c`, plus open PRs #4, #8 and #9 (marked **[PR #n]** where behaviour depends on them). Replaces spec v11 and tools reference v11.

**How to use this file:** paste it at the start of a new Claude conversation about Sendwize. Section 2 holds the rules every change must keep. Section 13 lists what is still open.

---

## 1. What Sendwize is

Sendwize is a UK marketing-compliance and marketing-performance toolkit for in-house marketers, agencies and SMEs. It checks campaigns, copy, landing pages, contact lists, vendors/partners and the website against **PECR, UK GDPR, ASA/CAP and CMA (DMCCA 2024)** rules. Each problem becomes a **fix** on one dashboard, with an evidence trail and a case-anchored **£ exposure** figure, and the dashboard tracks the score as fixes are closed.

- **Positioning:** "built by a lawyer", deterministic and explainable. Every figure links to the published cases behind it. Not legal advice and not a law firm.
- **Who it's for:** UK marketers and SMEs who send email/SMS, run paid social and ads, use affiliates or lead-gen partners, and don't have in-house counsel.
- **Pricing (planned):** one plan at £299/month or £2,990/year, plus a hidden founding plan at £199/£1,990. Billing is through Memberstack plans with Stripe checkout and is enforced by `SENDWIZE_REQUIRE_PLAN`.
- **Free top of funnel:** a no-login free copy check embedded on the landing page (one per person per day).
- **Brand:** orange `#EA7317` (light `#ff9a4d`, dark `#c85f0f`, tint `#fff4ec`), ink `#0C0B09`, background `#FAFAF8`, borders `#ECEAE6`. Fonts are DM Sans (UI) and DM Mono (labels and figures). Tone is plain, confident and concrete, with no hype.

## 2. Ground rules (keep these in every change)

**Legal wording** (enforced in every Claude prompt via `LEGAL_RULES` in `api/_claude.js`):
- Say "potential area requiring review", "we can't find evidence of" or "the regulator expects". Never write "illegal", "unlawful", "in breach of", "violation" or "compliant"/"non-compliant" about the customer.
- Attribute regulator decisions ("the ICO found…"). Never state or imply legal advice.
- Never invent a fine, case, date or statistic.

**Figures:**
- **ICO:** a range anchored to published ICO cases, by revenue band and sector. Shown as a likely figure with a narrower band and a confidence label.
- **ASA:** never a £ figure, because the ASA does not fine. Show a count of findings and the referral risk.
- **CMA:** the statutory maximum only (higher of £300k or 10% of global turnover), never a range.
- **Commercial cost** (ad pulled, refunds, rework) comes only from the customer's own campaign figures, is labelled as business cost, and is **never added to regulatory figures**.
- Always show the DUAA caveat. PECR max rose to £17.5M / 4% on 5 Feb 2026, and no post-DUAA PECR email fines exist yet, so the ranges are a conservative floor.

**AI:**
- Deterministic first, AI on top. Rules detect findings. Claude interprets the evidence but never produces a finding or a number from nothing.
- Claude may only pick factors from a fixed menu, each with a quote that is verified against the evidence (`validateAssessment`). A deterministic formula turns those picks into £.
- The same evidence gives the same number: results are cached under `EvidenceHash` + `ENGINE_VERSION`.
- All Claude calls go through `claudeFetch()` in `api/_claude.js`. The model is pinned to `claude-sonnet-5-5` (override with `SENDWIZE_CLAUDE_MODEL`), with a JSON schema where structured output is needed.

**Cases:** only cases published by the regulator itself (ico.org.uk, asa.org.uk, gov.uk/CMA), each with its source URL. Never add a case from memory or from a press report. **[PR #9]**

**Security:** every endpoint authenticates (section 4). The browser's `userId` is never trusted. Every user-supplied URL is fetched through `_page-scan.js fetchPage()` (SSRF-safe). Values are escaped before they go into Airtable formulas.

## 3. Architecture

| Layer | What |
|---|---|
| Marketing site + login | Webflow (staging: `new-mvp-v2.webflow.io`) with Memberstack for members and plans |
| Dashboard | Webflow Code Embed loading `sw-dashboard.js/.css` from Vercel, so it updates without re-pasting |
| Tool pages | Static HTML in `public/`, served at `https://sendwize-backend.vercel.app/<page>.html` |
| API | Vercel serverless functions in `api/` (ES modules, Node). Files starting with `_` are shared modules, not endpoints |
| Database | Airtable, one base (`BASE_ID`), REST through `api/_airtable.js` `atFetch()` (handles 429 retries; 5 req/s per base) |
| AI | Anthropic Messages API through `api/_claude.js` |
| Email | Resend (digest, alerts, free-check report) |
| Rate limits | Upstash Redis REST (`api/_limits.js`), off if not configured |
| Cron | Vercel cron in `vercel.json` |
| Deploy | Push or merge to `main` and Vercel auto-deploys. `api/package.json` holds the deps (`@anthropic-ai/sdk`, `@memberstack/admin`) |

**Login flow:** `public/sw-auth.js` sits in the Webflow site head and on every tool page. Links from Webflow to the tools carry the Memberstack token in the URL `#swt=` fragment, which is stored in sessionStorage and stripped from the address bar. Pages call `swFetch()`, which sends `Authorization: Bearer <token>`. **[PR #4]** makes `sw-auth.js` the one source of the dashboard URL (`SW.dashboard`, set via `window.SW_DASHBOARD_URL`) and has the digest read `DASHBOARD_URL`.

## 4. Auth model (`api/_auth.js`)

The server works out who is calling, checking in this order:
1. **Internal call:** the `x-sendwize-internal` header matches `INTERNAL_API_SECRET` (use `internalHeaders()`).
2. **Vercel cron:** `Authorization: Bearer CRON_SECRET`.
3. **Member:** a Memberstack token, verified with `@memberstack/admin`. The verified id **replaces** any `userId` the browser sent.
4. **Dev bypass:** `SENDWIZE_ALLOW_USERID_BYPASS=true`, only when not in production.

Helpers: `requireAuth(req,res)` for members, `requireInternal` for cron/internal-only routes, `isRecordId` for ownership checks. With `SENDWIZE_REQUIRE_PLAN=true`, members need an active paid plan (optionally limited by `SENDWIZE_PLAN_IDS`) and get a 402 otherwise. Profile and onboarding still work without a plan. `SENDWIZE_AUTH_ENFORCE=false` only logs instead of rejecting; it is for rollout only and should be removed. CORS is still `*` (tokens are still required).

## 5. Tools (what the member sees)

| Tool (page) | What it does | Endpoint(s) | Rate-limit bucket (per day) |
|---|---|---|---|
| **Dashboard** (Webflow embed) | Score ring, Already lost / Open regulatory exposure / Risk addressed tiles, exposure by area, Start here, consent expiring, This week, list value, action items with "Why this number?", Case Twin, What-if mode, campaigns, recent checks. **[PR #8]** shows a required business-profile form instead of any £ figure until the profile is complete | `dashboard`, `fixes`, `exposure`, `profile`, `data`, `verdict` | `fix_draft` 40, `exposure` 20 |
| **Send-day verdict** (`send-verdict.html`) | Go / Fix first / Hold before a send, combining copy + landing pages + list + audience. Pure rules over those results, fingerprinted and saved | `verdict` | `verdict` 40 |
| **AI Copy Checker** (`ai-checker.html`) | Rules first, then Claude reviews ad/email/SMS/social copy against CAP/PECR/CMA, gives compliant rewrites, separates "evidence required" items, re-checks an edited version and closes resolved fixes | `analyze-copy`, `certify-evidence` | `copy_scan` 60 |
| **Campaign Defence** (`campaign-defence.html`) | Builds a defensible campaign dossier: copy checks, landing-page scans (claims, reference/drip pricing, urgency), approvals, event log, page-drift monitoring | `submit-check` | `campaign_build` 30 |
| **Commercial Relationships** (`vendor-checker.html`) | Vendor, partner and affiliate registers, vendor risk scoring, DPA reader (URL or PDF), competitor/relationship watch | `data`, `dpa-scan`, `check-vendors`, `vendor-*`, `submit-check` | `vendor_check` 30, `dpa_scan` 20 |
| **List Intelligence** / List health (`list-intelligence.html`) | Upload an ESP contact CSV. Shows "your real list" (green/amber/red with reasons), the consent clock (default 24 months), sign-up source quality joined to Site Sweep, evidence coverage, unsubscribe leaks across lists, soft opt-in misuse, Case Twin, pre-send certificate and re-consent drafts | `list-intelligence` (logic in `_list-insights.js`) | `list_upload` 20, `reconsent` 30 |
| **Audience Read** (`audience-read.html`) | Upload a campaign export. Shows a 12-month list forecast, a per-send table (people lost, £ value, net, complaint rate against the 0.3% Gmail/Yahoo limit), best campaign by net, the third-send-in-a-week effect, the next-send call and a Black Friday plan. Zero AI in scoring (AI only maps columns) | `audience-read` (logic in `_campaign-insights.js`) | `list_upload` |
| **Site Sweep** (`site-sweep.html`) | Site-wide scan of a verified domain (meta tag, `/.well-known` file or DNS TXT): cookies before consent, banner and reject option, privacy notice, sign-up consent. Feeds fixes | `site-sweep` | `site_sweep` 10 |
| **Regulator Simulator** (`ico-simulator.html`) | Simulates a regulator investigation for the member's band. Saved to `Simulations` and can be reopened | `data?action=simulation-run` | |
| **Profile / Onboarding** (`profile.html`, `onboarding.html`) | Business profile: sector, revenue band, exact turnover, list size, opt-in records, complaints, regulator contact, campaign budget/revenue, CPL. **[PR #8]** makes five of these required before figures show | `profile` | |
| **Explainers** | `exposure-explain.html` (replaced by `exposure-algorithm.html` **[PR #8]**, a public page built live from engine constants via `GET /api/exposure?action=method`) and `list-value-explain.html` | | |
| **Free check** (landing-page embed, `free-check/sw-free-check.js`) | No login. The visitor gives a work email and pastes copy, then gets the verdict, an issue count and a glimpse of one item, with the rest blurred and pointing to sign-up. Plays an example check while idle | `free-check` | 1 per email, 1 per IP, 30 a day in total |

Every member tool can reopen past runs. Archived (in `archive/`, not served): PECR questionnaire (`index.html`), violation browser, re-consent builder, AI/audit/vendor reports.

Back-end-only flows: Database Auditor + re-consent (`audit-database-v2`, `generate-reconsent-email`), suppression check (`check-suppression`), campaign check (`campaign-check`), vendor monitor, weekly digest, daily regulator feed, nightly AI assessments.

## 6. Exposure engine (`api/_exposure.js`)

This is the one source for every £ figure and for the score. It is used by `fixes`, `generate-fix`, `exposure-summary`, `exposure` and `dashboard`.

1. **Frame:** the published-case range for the fix type (`EXPOSURE_CONSTANTS`) by revenue band (`under_1m`, `1m_10m`, `10m_50m`, `over_50m`), times a sector multiplier: finance 1.5, health 1.4, gambling 1.3, ecommerce 1.1, media/general 1.0, b2b 0.8, charity 0.7. An exact turnover overrides the band.
2. **Factors:** a fixed `FACTORS` menu with weights. *Rule factors* come from evidence: volume (>1M +0.25, >100k +0.15, <10k −0.15), sensitive data +0.20, DPA refused +0.20 / confirmed −0.10, documented assessment −0.10, open more than 90 days +0.10, and so on. *AI factors* need a verified quote: bundled consent +0.15, continued after opt-out +0.25, bought-in data +0.20, concealed sender +0.15, SMS/calls +0.08, complaints +0.15, isolated −0.10, partial −0.10. *Profile factors*: opt-in records all −0.12 / none +0.15, regulator contact +0.15, complaints +0.10, clean history −0.05, turnover lower/upper third of the band ∓0.08.
3. **Position** = 0.5 + Σ weights, clamped to 0.05–0.95. The shown band is centred there and is 16% / 26% / 40% of the frame wide at high / medium / low confidence (`HALF_WIDTH`). It never leaves the frame. The confidence label rises as more profile inputs are known (`TIGHTEN` lists what would sharpen it).
4. **Clustering:** findings in the same area (`AREAS`: consent, suppression, processors, transparency, lawful_basis) count as one investigation: the largest finding + 25% of each other, capped at 2× the largest. The total is the sum of the clusters.
5. **ASA:** count + referral risk. **CMA:** `cmaStatutoryMax(band)`.
6. **Commercial cost** (`marketingCost`, `COMMERCIAL_ASSUMPTIONS`): ASA rework is 10% of budget (min £500), and lost sales are 25/50/75% of expected sales if the ad is pulled. CMA refunds are 5/15/30% of revenue. **[PR #9]** replaces CMA refunds with per-customer refunds from real CMA cases (Wowcher, AA, StubHub, Marks Electrical), adds a payment-dispute assumption, an average order value input and a no-£ "public record" line.
7. **Score** (`computeScore`): severity-weighted (critical 8, high 5, medium 3, low 1). Verified fixes (re-run) get full credit and hand-marked ones 0.75 (`SELF_ATTESTED_CREDIT`). Dismiss reasons: `not_applicable` and `false_positive` leave the score, while `accepted_risk` stays counted as open. Bands: Not Started 0, At Risk ≤25, Needs Attention ≤50, In Progress ≤75, Good Standing ≤90, Strong Posture above 90.
8. **Attention likelihood** (Low/Medium/High): from critical findings, audience size, recently fined issue types, high-scrutiny sector and age.
9. **AI assessment** (`exposure?action=assess`, nightly `assess-pending` up to 12): Claude picks AI factors with quotes, the result is stored in `AssessmentJson` + `EvidenceHash`, and it is ignored if the evidence changes.

**[PR #8] Required profile:** `REQUIRED_PROFILE` = turnover, list size, opt-in records, complaints, regulator contact. `profileGaps()` drives `profileComplete` / `profileMissing` in `profile` and `dashboard`, and no £ figure shows until the list is empty.

**ICO fix types:** `consent_missing`, `consent_expired`, `suppression_breach`, `dpa_breach`, `legitimate_interest_abuse`, `data_quality`, `no_article26_agreement`, `affiliate_consent_unverified`, `affiliate_sender_identity_breach`, `partner_no_data_sharing_agreement`, `lead_gen_consent_gap`, `third_party_list`, `invalid_consent_mechanism`.
**ASA/CMA types:** `fake_urgency`, `misleading_claim`, `misleading_reference_price`, `undisclosed_ad`, `asa_liability`, `partner_pricing_claims`, `affiliate_misleading_claims`, `affiliate_ad_disclosure`, `unreviewed_joint_ads`.
**Commercial types:** `commercial_loss`, `segment_declining_engagement`, `partner_brand_risk`, `sector_risk_unreviewed`.
Site Sweep types are mapped onto these, for example cookie issues become `consent_missing` and a missing cookie policy becomes `data_quality`.

## 7. Case library and Case Twin

- **On main:** five hand-written ICO anchors in `CASE_ANCHORS` (HelloFresh 2024 £140k, Allay Claims 2026 £120k, ZMLUK 2025 £105k, …).
- **[PR #9]** adds `api/_case-library.js` with **43 verified cases (18 ICO, 13 ASA, 12 CMA)**, each with its own source URL. It corrects Saga (two companies, £150k and £75k, 157M messages) and removes JTT Marketing, which has no ICO record. ASA rulings have `penalty: null`.
- **Case Twin** (`api/_cases.js`): for each open finding, the closest published case by type, sector, audience size (within 100×) and recency. It is shown only when the match is close (`TWIN_MIN`, no low-severity findings), with the reasons and never as a prediction. Rulings from the daily feed (`Sector_Intelligence_Feed`) are added on top.

## 8. API reference

All routes are `https://sendwize-backend.vercel.app/api/<name>`. Member routes need the Memberstack bearer token.

| Endpoint | Actions / method | Auth |
|---|---|---|
| `dashboard` | GET: everything the dashboard's first paint needs | member |
| `fixes` | `get`, `complete`, `dismiss` (with reason) | member |
| `generate-fix` | POST: create or dedupe a fix with exposure | member (own) or internal |
| `exposure` | `explain`, `assess`, `inputs` (campaign figures), `draft` (ready-to-use fix), `assess-pending` (cron), `method` (public) **[PR #8]** | member / cron / public |
| `exposure-summary` | GET/POST: Lost / At risk / Cleared tiles | member |
| `profile` | `get`, `save`, `streak` (internal) | member |
| `verdict` | POST: run the verdict; `get`, `list` | member |
| `analyze-copy` | POST: copy check | member |
| `certify-evidence` | POST: persist evidence confirmations | member |
| `submit-check` | `check`, `brief-check`, `dossier-create/get/list/save/submit`, `defence-add-event/approve/assemble/scan-pages` | member |
| `site-sweep` | `start`, `verify`, `run`, `get` | member |
| `list-intelligence` | `upload`, `load`, `lists`, `certificate`, `detect`, `draft-reconsent`, `health-brief`, `list-exposure` | member |
| `audience-read` | `upload`, `load`, `detect`, `log`, `presend`, `strategy`, `audience-exposure`, `methodology` (public) | member |
| `list-recommendations` | GET: list opportunities | member |
| `data` | vendor/partner/affiliate registers, `vendors`, `vendor-watch`, `competitor-watch`/`-intelligence`, `relationship-watch`, `sector-intelligence`, `briefing`, `summary`, `history`, `score-history`, `consent-check`, `consent-expiry-check`, `marketing-check(s)`, `simulation-run`, `violations`, `report`, `dossier-toggle-monitoring`, `load`, `cron-status`; `send-alert` and `backfill-processor-fixes` are internal only | member / internal |
| `dpa-scan`, `check-vendors`, `vendor-profile` | vendor/DPA reads | member |
| `audit-database-v2` | `audit`, `suppression-report`, `reconsent-draft`, `mark-sent` | member |
| `campaign-check` | `check`, `create`, `list`, `clear` | member |
| `check-suppression`, `generate-reconsent-email` | POST | member |
| `vendor-dpa-reader` | internal (called by vendor-monitor) | internal |
| `vendor-monitor` | `run`, `run-single`, `status` | cron / internal / `X-Monitor-Key` |
| `digest` | weekly email | cron / internal |
| `regulatory-feed-update` | daily regulator feed (Claude + web search) | cron |
| `free-check` | POST: public check; `report` (cron) | public (capped) / cron |

Shared modules: `_auth`, `_airtable`, `_claude`, `_limits`, `_exposure`, `_cases`, `_case-library` **[PR #9]**, `_page-scan` (SSRF-safe fetch plus page checks), `_smart-import` and `_normalise` (CSV column mapping and row normalisation for both list tools), `_list-insights`, `_campaign-insights`.

## 9. Cron (`vercel.json`)

| Time (UTC) | Job |
|---|---|
| 02:30 daily | `exposure?action=assess-pending` (AI assessments, up to 12 a night) |
| 07:00 daily | `regulatory-feed-update` |
| 07:15 daily | `free-check?action=report` (emails yesterday's numbers) |
| 08:00 Mondays | `digest` |

`maxDuration` is 60s for the heavy routes and 30s for the dashboard. Site Sweep has 1769MB of memory. Cron frequency and 60s runs need the **Vercel Pro** plan, which is also needed for commercial use.

## 10. Airtable schema (base `BASE_ID`)

Field names are case-sensitive. The code looks them up by name, and a missing field usually means the feature is skipped, not that it crashes.

| Table | Key fields / notes |
|---|---|
| `User_Profile` | `UserID`, `Sector`, `RevenueBand`, `CPL`, `AnnualTurnover`, `ListSize`, `ConsentRecords` (all/some/none), `PriorRegulatorContact` (Yes/No), `ComplaintsReceived` (Yes/No), `TypicalCampaignBudget` (£), `TypicalCampaignRevenue` (£), streak fields |
| `Compliance_Fixes` | the fix list: type, severity, status, exposure low/high, `CommercialInputs`, `AssessmentJson`, `EvidenceHash`, `DismissReason`, `FixDraft` |
| `Score_History` | `UserID`, `Date`, `Score`, `ScoreChange`, `TriggerEvent` (one row per day) |
| `Send_Verdicts` | `UserID`, `CreatedAt` (ISO text), `Verdict`, `CampaignName`, `Channel`, `ListName`, `Urls`, `CopyCheckId`, `ReasonsJson`, `InputHash`, `Fingerprint` |
| `Simulations` | `UserID`, `CreatedAt`, `Regulator`, `Band`, `ResultJson` |
| `Free_Checks` | `Email`, `Channel`, `Verdict`, `VisitorHash`, `CheckedAt`, `Issues`. The copy is never stored and the emails must not be used for marketing |
| `List_Intelligence_Checks` | `ListName`, `CheckDate`, `Expiring30/60/90`, `LiabilityCount`, `LiabilityPct`, `TotalContacts`, `Results` (long text JSON, includes insights) |
| `List_Optouts` | `UserID`, `ListName`, `CheckDate`, `Count`, `Hashes` (truncated email hashes, no emails) |
| `List_Intelligence_Snapshots`, `List_Intelligence_Certificates`, `List_Opportunities` (legacy fallback) | list history and certificates |
| `Audience_Read_Campaigns` | per-send rows plus `BounceCount`, `DeliveredCount`, `OpenCount`, `ClickCount`, `Cost`, `Conversions` |
| `Audience_Read_Segments`, `Audience_Read_Snapshots` | audience history |
| `Campaign_Dossiers` | Campaign Defence records |
| `AI_Compliance_Checks`, `Evidence_Certifications`, `Email_Scans` | copy checks and evidence confirmations |
| `Vendor_Register`, `Partner_Register`, `Affiliate_Register`, `Marketing_Vendors`, `Competitor_Watch`, `Monitor_Log` | Commercial Relationships |
| `Site_Sweeps` | domain verification and sweep results |
| `Database_Audits`, `Suppression_Checks` | auditor and suppression |
| `Sector_Intelligence_Feed`, `Violation_Database` | regulator feed (Case Twin reads it, sorted by `PublishedDate`) |

## 11. Environment variables (Vercel)

| Variable | Need | Purpose |
|---|---|---|
| `AIRTABLE_TOKEN`, `BASE_ID` | required | Airtable (a few legacy spots read `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID`, so keep the names consistent) |
| `ANTHROPIC_API_KEY` | required | Claude. Set a monthly spend limit in the Anthropic Console as the hard ceiling |
| `MEMBERSTACK_SECRET_KEY` | required | token verification (`MEMBERSTACK_APP_ID` is optional) |
| `INTERNAL_API_SECRET` | required | endpoint-to-endpoint calls (40+ random characters) |
| `CRON_SECRET` | required | Vercel cron auth |
| `RESEND_API_KEY` | required for email | digest, alerts, free-check report |
| `DASHBOARD_URL`, `APP_URL` | set | links in emails |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | strongly advised | rate limits (needed for the free check). Override caps with `SENDWIZE_LIMIT_<BUCKET>` |
| `SENDWIZE_REQUIRE_PLAN`, `SENDWIZE_PLAN_IDS` | at launch | paid-plan gate |
| `SENDWIZE_FREE_CHECK` (`true`), `SENDWIZE_ALERT_EMAIL`, `SENDWIZE_FREE_CHECK_DAILY` / `_PER_EMAIL` / `_PER_IP`, `SENDWIZE_FREE_CHECK_SALT` | free check | caps and the report recipient |
| `SENDWIZE_CLAUDE_MODEL` | optional | overrides `claude-sonnet-5-5` |
| `SENDWIZE_AUTH_ENFORCE` | remove | `false` only during rollout |
| `SENDWIZE_ALLOW_USERID_BYPASS` | dev only | never in production |
| `MONITOR_KEY` | optional | external cron for vendor-monitor |
| `SITE_SWEEP_BROWSER` | optional | headless browser for Site Sweep |

## 12. Webflow embeds

All embeds load code from Vercel, so merging to `main` updates the live site with no re-pasting. The current copies are in the project files under `launch-review/`.

- **Site head (Site settings → Custom code → Head):** `<script src="https://sendwize-backend.vercel.app/sw-auth.js"></script>` (optionally set `window.SW_DASHBOARD_URL` before it).
- **Dashboard page:** DM fonts link, `dashboard/sw-dashboard.css`, `<div id="sw-dashboard"></div>`, `dashboard/sw-dashboard.js` (deferred).
- **Landing page free check:** `<div id="sw-free-check"></div>`, `window.SW_SIGNUP_URL = '<pricing page>'`, `free-check/sw-free-check.js` (it reuses the dashboard CSS).
- **About page:** one self-contained embed (`webflow-about-embed.txt`, styles scoped to `.swab`, runs full width). Placeholders still to replace: free-check URL, methodology URL (use the exposure algorithm page), founder story, team names/roles/photos, contact email. Set the Webflow `main-section` top padding to 0.
- Webflow's Code Embed limit is 50k characters, so put anything large on Vercel and load it.

## 13. Status and open launch items (21 Oct 2026)

**Merged to main:** auth on every endpoint, one exposure engine, the new dashboard + Send-day verdict, Claude routed through one helper on Sonnet 5.5, plan gate, rate limits, the free check (email required, 1/day, morning report, idle demo), recheck + history in every tool, sharper figures from the profile, ASA/CMA commercial cost, Case Twin, interactive action items, What-if mode, the List Intelligence/Audience Read upgrade, compact foldable action items, and broken pages archived.

**Open PRs (review and merge):**
- **#8** required business profile + "The Sendwize exposure algorithm" page.
- **#9** verified case library (43 cases) + CMA commercial cost from real refunds.
- **#4** one dashboard URL for every link and back button. It needs the live dashboard URL confirmed (staging `dashboard-1-copy` or `www.sendwize.co.uk/dashboard`).
- #8 and #9 both edit `_exposure.js`, `exposure.js` and `sw-dashboard.js`, so merge one and then rebase the other.

**Ian to do (setup):**
- Airtable: add the fields above, in particular `List_Optouts`, the six `Audience_Read_Campaigns` counts, `FixDraft`, the `User_Profile` sharpening fields, `CommercialInputs`, `Send_Verdicts`, `Simulations` and `Free_Checks`.
- Vercel: set `INTERNAL_API_SECRET`, `CRON_SECRET`, `DASHBOARD_URL`, Upstash and the free-check vars. Remove `SENDWIZE_AUTH_ENFORCE`. Move to Pro.
- Set a spend limit in the Anthropic Console.
- Memberstack/Stripe plans, then `SENDWIZE_REQUIRE_PLAN=true`.
- Run the signed-in end-to-end click-through of all eight tools.
- Replace the About page placeholders. Swap staging links (`new-mvp-v2.webflow.io`) once the live domain is set.

**Product/engineering still open:**
- CORS locked to the live domain.
- No tests, CI or error monitoring (Sentry suggested), and no `.env.example`.
- Airtable's 5 req/s limit will get tight under launch traffic, so plan a move to Postgres.
- Legal pages: "not legal advice" wording, privacy policy, and a customer DPA (uploads hold personal data).
- The default value per contact (£0.50) is a guess, and the HelloFresh "£0.28 per contact" figure needs replacing.
- The factor menu and weights need a lawyer's review.
- Decide whether the score should include coverage (tools not yet run).
- Decide whether ESP integrations (Klaviyo, Mailchimp, HubSpot) fit the "no platform data" rule. They are post-launch as agreed.
- Audience Read / List health rethink: lead with "Marketable audience" and the cash saving from suppressing dead weight (ESP tier savings) so the £299 pays for itself on screen (`audience-list-rethink.md`).

## 14. Working on the repo (for Claude)

- One feature per branch, then a PR to `main`. Vercel deploys `main` automatically, so a revert on GitHub rolls back.
- Match the existing style: a header comment block per file with a version line and dated change notes (`// v7.1: …`), plain ES modules, and `fetch` to the Airtable REST API through `atFetch`.
- New endpoint: call `requireAuth` first, set CORS with `CORS_HEADERS`, take the user id from `auth` and never from the body, put Claude calls through `claudeFetch` with `checkLimit(bucket)`, make internal calls with `internalHeaders()`, and add `maxDuration` in `vercel.json` if it may run long.
- New Airtable field: write it so the code skips gracefully when the field is missing, and list it in the PR's setup notes for Ian, including an "Airtable AI" instruction he can paste.
- Every £ figure goes through `_exposure.js`. Don't compute exposure anywhere else.
- Ian works through the GitHub web UI, Webflow and Airtable, not a local terminal. Give him click-by-click steps and paste-ready snippets.

## 15. Project files (shared folder)

`launch-review/`: `launch-readiness.md` (16 Oct review), `launch-plan.md` (security + intelligent figures plan), `review-guide.md` (setup and merge guide for the launch build), `sharper-figures-setup.md`, `airtable-changes-list-audience.md`, `audience-list-rethink.md`, `webflow-*.txt` (current embeds). Also previews in `dashboard-preview/`, `about-preview/`, `free-check-demo/` and `demo-video/`.
