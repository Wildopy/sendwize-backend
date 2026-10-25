// ─────────────────────────────────────────────────────────────
// SENDWIZE — _processor-rules.js v1.0
//
// One source of truth for the processor (vendor) rules used by the
// Commercial Relationships register: the Article 28 DPA checks, the
// UK international transfer rules and the vendor risk rating.
//
// Read by: dpa-scan.js, data.js (register + score breakdown),
//          vendor-dpa-reader.js, vendor-monitor.js
//
// Deterministic by design: no AI in here. Same inputs, same answer.
//
// LEGAL BASIS (UK GDPR as amended; checked October 2026)
// - Article 28(3)(a)-(h) and the final subparagraph of 28(3) list what
//   a processor contract must contain; 28(2) and 28(4) govern
//   sub-processors.
// - Chapter V transfers: the EEA and other countries in UK adequacy
//   regulations need no extra safeguard. Otherwise a UK exporter needs
//   the ICO's IDTA, or the EU SCCs plus the UK Addendum. The old EU
//   SCCs stopped being valid for UK transfers on 21 March 2024, and
//   EU SCCs without the UK Addendum never covered UK data. The UK-US
//   Data Bridge covers only US organisations certified to the UK
//   Extension of the EU-US Data Privacy Framework.
// - The ICO data protection fee is paid by controllers. A processor
//   acting only for its customers does not pay it, and a non-UK vendor
//   will not appear on the ICO register at all. Registration is
//   therefore information about a vendor, never a gap on its own.
// ─────────────────────────────────────────────────────────────

// ── Transfer mechanisms ───────────────────────────────────────
// Values stored in Marketing_Vendors.TransferMechanismConfirmed.
// 'SCCs' is the legacy value from before v1.0: it is treated like
// 'EU SCCs only' until someone confirms the UK Addendum or IDTA.
export const TRANSFER_MECHANISMS = ['Adequacy', 'IDTA', 'UK Addendum', 'UK-US Bridge', 'BCRs', 'EU SCCs only', 'None', 'Unknown'];
export const VALID_UK_MECHANISMS = ['Adequacy', 'IDTA', 'UK Addendum', 'UK-US Bridge', 'BCRs'];

// Destinations covered by UK adequacy regulations (DPA 2018 s.17A and
// the adequacy regulations made since). Canada and Japan are partial:
// Canada covers organisations subject to PIPEDA, Japan the private
// sector under APPI. The US is NOT here: it is adequate only for
// organisations certified to the UK Extension ('UK-US Bridge').
const EEA = ['austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech', 'denmark', 'estonia', 'finland', 'france',
  'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands',
  'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden', 'iceland', 'liechtenstein', 'norway'];
const OTHER_ADEQUATE = ['gibraltar', 'andorra', 'argentina', 'canada', 'faroe', 'guernsey', 'isle of man', 'israel',
  'japan', 'jersey', 'new zealand', 'switzerland', 'uruguay', 'korea'];

const UK_RE   = /\b(uk|united kingdom|great britain|england|scotland|wales|northern ireland)\b/;
const EEA_RE  = /\b(eu|eea|european union|european economic area|europe)\b/;
const NON_ADEQUATE_HINT = /\b(us|usa|united states|india|china|australia|singapore|philippines|brazil|south africa|global|worldwide|international|rest of world)\b/;

// Split a free-text destination ("US, EU", "Ireland and India") into
// what we can classify. Returns { uk, adequate, nonAdequate, unknown }.
export function classifyDestination(dest) {
  const d = String(dest || '').toLowerCase().trim();
  const out = { uk: false, adequate: [], nonAdequate: [], unknown: !d || d === 'unknown' };
  if (out.unknown) return out;
  if (d === 'n/a') { out.uk = true; return out; }
  if (UK_RE.test(d)) out.uk = true;
  if (EEA_RE.test(d)) out.adequate.push('EEA');
  for (const c of [...EEA, ...OTHER_ADEQUATE]) if (d.includes(c)) out.adequate.push(c);
  const m = d.match(new RegExp(NON_ADEQUATE_HINT.source, 'g'));
  if (m) out.nonAdequate.push(...new Set(m));
  if (!out.uk && !out.adequate.length && !out.nonAdequate.length) out.unknown = true;
  return out;
}

export function normaliseMechanism(mech) {
  const m = String(mech || '').trim().toLowerCase();
  if (!m || m === 'unknown') return 'Unknown';
  if (m === 'none') return 'None';
  if (/\bidta\b|international data transfer agreement/.test(m)) return 'IDTA';
  if (/addendum/.test(m)) return 'UK Addendum';
  if (/uk[\s-]?us|data bridge|uk extension/.test(m)) return 'UK-US Bridge';
  if (/\bbcrs?\b|binding corporate/.test(m)) return 'BCRs';
  if (/adequa/.test(m)) return 'Adequacy';
  if (/scc|standard contractual|eu[\s-]?us|dpf|privacy framework/.test(m)) return 'EU SCCs only';
  return 'Unknown';
}

// The UK transfer position for one vendor.
// status: 'none' (UK only) | 'adequate' | 'safeguarded' | 'needs_uk_tool'
//       | 'unsafeguarded' | 'unknown'
// ok:     true when no further action is needed for Chapter V
export function transferPosition({ destination, mechanism, intlTransferOccurs } = {}) {
  const dest = classifyDestination(destination);
  const mech = normaliseMechanism(mechanism);
  const intl = String(intlTransferOccurs || '').toLowerCase();

  if (intl === 'no' || (dest.uk && !dest.adequate.length && !dest.nonAdequate.length)) {
    return { status: 'none', ok: true, mechanism: mech, label: 'Held in the UK, no restricted transfer' };
  }
  if (!dest.unknown && !dest.nonAdequate.length) {
    return { status: 'adequate', ok: true, mechanism: mech,
      label: `${dest.adequate.includes('EEA') ? 'EEA' : 'Adequate country'}, covered by UK adequacy regulations` };
  }
  if (VALID_UK_MECHANISMS.includes(mech) && mech !== 'Adequacy') {
    return { status: 'safeguarded', ok: true, mechanism: mech, label: `Safeguarded by ${mech}` };
  }
  if (mech === 'EU SCCs only') {
    return { status: 'needs_uk_tool', ok: false, mechanism: mech,
      label: 'EU SCCs or EU-US DPF named, but no UK Addendum, IDTA or UK Extension',
      detail: 'For UK data, EU SCCs need the UK Addendum (or use the IDTA instead). EU-US DPF certification only covers UK data if the firm also signed up to the UK Extension. Ask the vendor which UK tool applies.' };
  }
  if (dest.unknown) {
    return { status: 'unknown', ok: false, mechanism: mech,
      label: intl === 'yes' ? 'Transfers outside the UK, but destination and safeguard not confirmed' : 'Where data is held not confirmed' };
  }
  return { status: 'unsafeguarded', ok: false, mechanism: mech,
    label: mech === 'Adequacy' ? 'Adequacy claimed for a country the UK has not found adequate' : 'Transfer outside the UK with no UK safeguard identified',
    detail: 'UK GDPR Chapter V needs a UK transfer tool (IDTA, UK Addendum to the EU SCCs, UK-US Data Bridge or BCRs) for data sent to a country without UK adequacy.' };
}

// ── ICO register (information only) ───────────────────────────
export const ICO_REGISTER_NOTE = 'The ICO fee is paid by controllers. A vendor acting only as your processor does not have to pay it, and non-UK vendors will not be listed.';

// ── Breach history helper ─────────────────────────────────────
const CLEAN_BREACH = ['none identified', 'none', 'no', 'unknown', '', 'none publicly disclosed.', 'no information found.'];
export function breachIsKnown(breach) {
  return !!breach && !CLEAN_BREACH.includes(String(breach).toLowerCase().trim());
}

// ── Vendor risk rating ────────────────────────────────────────
// Accepts camelCase (register) or PascalCase (Marketing_Vendors) keys.
export function calculateRiskRating(d = {}) {
  const pick = (...keys) => { for (const k of keys) if (d[k] != null && d[k] !== '') return String(d[k]); return ''; };
  const dpa    = pick('dpaStatus', 'DPAStatus').toLowerCase();
  const breach = pick('breachHistory', 'BreachHistory');
  const cert   = pick('relevantSecurityCertification', 'RelevantSecurityCertification').toLowerCase();
  const transfer = transferPosition({
    destination:        pick('transferDestination', 'TransferDestination'),
    mechanism:          pick('internationalTransfer', 'transferMechanismConfirmed', 'TransferMechanismConfirmed', 'transferMechanism', 'TransferMechanism'),
    intlTransferOccurs: pick('intlTransferOccurs', 'IntlTransferOccurs'),
  });

  if (dpa === 'refused') return 'High';
  if (breachIsKnown(breach)) return 'High';
  if (transfer.status === 'unsafeguarded') return 'High';
  if (['on request', 'unknown', 'not available', ''].includes(dpa)) return 'Medium';
  if (!transfer.ok) return 'Medium';
  if (!cert || ['no', 'none', 'unknown'].includes(cert)) return 'Medium';
  return 'Low';
}

// ── Article 28 DPA checks ─────────────────────────────────────
// Deterministic: strict pattern = found, weak pattern = partial.
// `a28` is the clause card on the register page each check feeds.
export const ARTICLE_28_CHECKS = [
  {
    id: 'subject_matter_duration', a28: 'a28-9',
    label: 'Subject matter and duration of processing',
    articleRef: 'UK GDPR Article 28(3)',
    strict: [/subject[\s-]?matter[\s\S]{0,300}(process|agreement)/i, /duration of (the |this )?(processing|agreement)/i],
    weak: [/term of (the |this )?(agreement|dpa)/i, /scope of (the )?processing/i],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3) requires the contract to set out the subject matter and duration of the processing. Without this, the scope of what the vendor may do with your data is unclear.',
  },
  {
    id: 'nature_purpose', a28: 'a28-9',
    label: 'Nature and purpose of processing',
    articleRef: 'UK GDPR Article 28(3)',
    strict: [/nature and purpose/i, /purpose of (the )?processing/i],
    weak: [/processing (activities|purposes) (include|are)/i, /purpose[s]?[\s\S]{0,200}process/i],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3) requires the contract to set out the nature and purpose of processing. Without this, there is no contractual limit on how the vendor uses your data.',
  },
  {
    id: 'personal_data_types', a28: 'a28-9',
    label: 'Types of personal data processed',
    articleRef: 'UK GDPR Article 28(3)',
    strict: [/categor(y|ies) of personal data/i, /types? of personal data/i],
    weak: [/personal data (processed|includes|comprises)/i, /(email address|contact details|behavioural data)[\s\S]{0,150}process/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3) requires the contract to set out the type of personal data processed. Without this you cannot show what data the vendor holds if asked.',
  },
  {
    id: 'data_subjects', a28: 'a28-9',
    label: 'Categories of data subjects',
    articleRef: 'UK GDPR Article 28(3)',
    strict: [/categor(y|ies) of data subjects/i, /data subjects (include|are|comprise)/i],
    weak: [/individuals whose (personal )?data/i, /(customers|subscribers|end users)[\s\S]{0,100}personal data/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3) requires the contract to set out the categories of data subjects.',
  },
  {
    id: 'documented_instructions', a28: 'a28-1',
    label: 'Processing (including transfers) only on documented instructions',
    articleRef: 'UK GDPR Article 28(3)(a)',
    strict: [/(documented|written) instructions/i, /(on |per )(the )?controller['s]{0,2} instructions/i, /only.{0,80}process.{0,80}instructions/i],
    weak: [/instructions from the controller/i, /controller'?s? instructions/i],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3)(a) requires the processor to process personal data, including any transfer outside the UK, only on your documented instructions.',
  },
  {
    id: 'confidentiality', a28: 'a28-2',
    label: 'Confidentiality commitments from personnel',
    articleRef: 'UK GDPR Article 28(3)(b)',
    strict: [/confidentiality (obligation|undertaking|commitment|agreement)/i, /(authorised|authorized) (persons|personnel)[\s\S]{0,150}confiden/i, /bound by (a )?duty of confiden/i],
    weak: [/confidentiality/i, /confidential (information|obligations)/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(b) requires the processor to ensure people authorised to process the data are committed to confidentiality.',
  },
  {
    id: 'security_measures', a28: 'a28-3',
    label: 'Security measures (Article 32)',
    articleRef: 'UK GDPR Articles 28(3)(c) and 32',
    strict: [/article 32/i, /technical and organi(s|z)ational (measures|safeguards)/i],
    weak: [/appropriate security measures/i, /security safeguards/i, /encryption[\s\S]{0,100}(rest|transit)/i],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(3)(c) requires the processor to take the security measures required by Article 32.',
  },
  {
    id: 'sub_processors', a28: 'a28-4',
    label: 'Sub-processors only with your authorisation',
    articleRef: 'UK GDPR Articles 28(2) and 28(3)(d)',
    strict: [/sub[\s-]?processor[s]?/i, /(prior |written )(authorisation|authorization|consent)[\s\S]{0,150}(engage|appoint|use)[\s\S]{0,50}(third|another) party/i],
    weak: [/further processors/i, /third[\s-]?party (processors|providers)/i, /sub[\s-]?contract/i],
    severity: 'high',
    missingDetail: 'UK GDPR Article 28(2) requires your prior specific or general written authorisation before the processor engages a sub-processor. Under a general authorisation you must be told of changes and be able to object.',
  },
  {
    id: 'sub_processor_flowdown', a28: 'a28-13',
    label: 'Sub-processors bound by the same terms',
    articleRef: 'UK GDPR Article 28(4)',
    strict: [/same (data protection )?obligations[\s\S]{0,200}sub[\s-]?processor/i, /sub[\s-]?processor[\s\S]{0,300}(same|equivalent|no less (protective|onerous))[\s\S]{0,80}(obligations|terms|protection)/i, /(fully )?liable[\s\S]{0,150}sub[\s-]?processor/i],
    weak: [/flow[\s-]?down/i, /sub[\s-]?processor[\s\S]{0,200}written (agreement|contract)/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(4) requires the same data protection obligations to be imposed on any sub-processor by contract, with the processor remaining fully liable to you for their performance.',
  },
  {
    id: 'controller_assistance', a28: 'a28-5',
    label: 'Help with data subject rights requests',
    articleRef: 'UK GDPR Article 28(3)(e)',
    strict: [/assist.{0,150}(controller|customer).{0,150}(data subject|individual|access|erasure|rectification|portability)/i, /(respond|responding) to (data subject|access) requests/i],
    weak: [/reasonable assistance/i, /co[\s-]?operate with (the )?controller/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(e) requires the processor to help you respond to people exercising their rights (access, erasure, objection and so on).',
  },
  {
    id: 'compliance_assistance', a28: 'a28-6',
    label: 'Help with security, breaches and DPIAs',
    articleRef: 'UK GDPR Article 28(3)(f)',
    strict: [/assist.{0,200}(articles? 32|security of processing|personal data breach|data protection impact assessment|dpia)/i, /(notify|inform)[\s\S]{0,80}(controller|customer)[\s\S]{0,120}(without undue delay|personal data breach)/i],
    weak: [/breach notification/i, /impact assessment/i, /reasonable assistance/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(f) requires the processor to help you meet Articles 32 to 36: security, breach notification and DPIAs. A processor must tell you of a breach without undue delay (Article 33(2)).',
  },
  {
    id: 'deletion_or_return', a28: 'a28-7',
    label: 'Deletion or return of data at the end',
    articleRef: 'UK GDPR Article 28(3)(g)',
    strict: [/(delete|return)[\s\S]{0,100}(all )?personal data[\s\S]{0,150}(end|termination|expiry)/i, /(upon|on) (termination|expiry)[\s\S]{0,150}(delete|return|destroy)/i],
    weak: [/(delete|erase|destroy).{0,100}personal data/i, /end of (the |this )?(agreement|processing|services)/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(g) requires the processor to delete or return all personal data at the end of the services, at your choice.',
  },
  {
    id: 'audit_rights', a28: 'a28-8',
    label: 'Audit and information rights',
    articleRef: 'UK GDPR Article 28(3)(h)',
    strict: [/right to audit/i, /audit rights/i, /(audit|inspection)[\s\S]{0,150}(controller|customer|reasonable)/i, /make available[\s\S]{0,150}(demonstrate|compliance)/i],
    weak: [/audit/i, /inspection/i],
    severity: 'medium',
    missingDetail: 'UK GDPR Article 28(3)(h) requires the processor to make available the information needed to show compliance and to allow audits.',
  },
  {
    id: 'infringing_instructions', a28: 'a28-14',
    label: 'Tells you if an instruction would break the law',
    articleRef: 'UK GDPR Article 28(3), final subparagraph',
    strict: [/(immediately |promptly )?(inform|notify)[\s\S]{0,120}instruction[\s\S]{0,120}(infringe|violat|breach|contrary to|unlawful)/i, /instruction[\s\S]{0,80}(infringes|violates|breaches)[\s\S]{0,150}(inform|notify)/i],
    weak: [/unlawful instructions?/i, /instruction[\s\S]{0,60}(infringe|violat)/i],
    severity: 'medium',
    missingDetail: 'Article 28(3) requires the processor to tell you immediately if it thinks one of your instructions infringes data protection law.',
  },
  {
    id: 'transfer_mechanism', a28: 'a28-10',
    label: 'UK international transfer safeguard',
    articleRef: 'UK GDPR Chapter V (Articles 44-49)',
    strict: [/\bIDTA\b|International Data Transfer Agreement/i, /International Data Transfer Addendum|UK Addendum/i, /UK[\s-]?US Data Bridge|UK Extension to the (EU[\s-]?US )?(Data Privacy Framework|DPF)/i, /UK adequacy (regulations?|decisions?)/i, /Binding Corporate Rules|\bBCRs?\b/i],
    weak: [/Standard Contractual Clauses|\bSCCs?\b/i, /Data Privacy Framework|EU[\s-]?US DPF/i, /adequacy (decision|regulations)/i, /international (data )?transfer/i, /transfer.{0,100}outside (the )?(UK|EEA|European)/i],
    severity: 'high',
    missingDetail: 'If the vendor sends UK personal data outside the UK to a country without UK adequacy, UK GDPR Chapter V needs a UK transfer tool: the ICO’s IDTA, the UK Addendum to the EU SCCs, the UK-US Data Bridge, or BCRs. EU SCCs alone (without the UK Addendum) and EU-US DPF certification alone (without the UK Extension) do not cover UK data. Not needed if all processing stays in the UK, the EEA or another UK-adequate country.',
  },
];

// Run every Article 28 check against a document's text.
export function runArticle28Checks(text) {
  const results = [];
  for (const check of ARTICLE_28_CHECKS) {
    let status = 'missing';
    let matchIndex = -1;
    for (const p of check.strict) {
      const m = text.match(p);
      if (m) { status = 'found'; matchIndex = m.index; break; }
    }
    if (status === 'missing') {
      for (const p of check.weak) {
        const m = text.match(p);
        if (m) { status = 'partial'; matchIndex = m.index; break; }
      }
    }
    results.push({
      id: check.id, a28: check.a28, label: check.label, articleRef: check.articleRef,
      severity: check.severity, status, matchIndex, missingDetail: check.missingDetail,
    });
  }
  return results;
}

// ── Trackers found by Site Sweep → register vendors ───────────
// Keys are the tracker names Site Sweep reports (live request test and
// page-source patterns in _page-scan.js). `category` is the register's
// marketing-check category; `aliases` match a vendor already in the
// register (lower case, matched against the vendor name).
export const TRACKER_VENDORS = {
  'Google Analytics':               { vendor: 'Google Analytics',      category: 'analytics',   aliases: ['google analytics', 'ga4'] },
  'Google Analytics / Tag Manager': { vendor: 'Google Analytics',      category: 'analytics',   aliases: ['google analytics', 'ga4', 'tag manager'] },
  'Google Ads':                     { vendor: 'Google Ads',            category: 'advertising', aliases: ['google ads', 'adwords', 'doubleclick', 'google marketing platform'] },
  'Meta Pixel':                     { vendor: 'Meta Ads',              category: 'advertising', aliases: ['meta', 'facebook', 'instagram'] },
  'TikTok Pixel':                   { vendor: 'TikTok Ads',            category: 'advertising', aliases: ['tiktok'] },
  'Microsoft Ads':                  { vendor: 'Microsoft Advertising', category: 'advertising', aliases: ['microsoft ads', 'microsoft advertising', 'bing'] },
  'Microsoft Clarity':              { vendor: 'Microsoft Clarity',     category: 'analytics',   aliases: ['clarity'] },
  'Hotjar':                         { vendor: 'Hotjar',                category: 'analytics',   aliases: ['hotjar'] },
  'LinkedIn Insight':               { vendor: 'LinkedIn Ads',          category: 'advertising', aliases: ['linkedin'] },
  'Pinterest Tag':                  { vendor: 'Pinterest Ads',         category: 'advertising', aliases: ['pinterest'] },
  'Snap Pixel':                     { vendor: 'Snapchat Ads',          category: 'advertising', aliases: ['snapchat', 'snap pixel', 'snap ads'] },
  'Criteo':                         { vendor: 'Criteo',                category: 'advertising', aliases: ['criteo'] },
  'X (Twitter) Ads':                { vendor: 'X Ads',                 category: 'advertising', aliases: ['twitter', 'x ads', 'x (twitter)'] },
  'Klaviyo':                        { vendor: 'Klaviyo',               category: 'esp',         aliases: ['klaviyo'] },
};

// One entry per vendor from a sweep's tracker names.
// fired: names seen sending data before any consent choice (live test).
export function sweepTrackers({ seenInSource = [], firedBeforeConsent = [], browserTested = false } = {}) {
  const byVendor = new Map();
  const add = (name, fired) => {
    const def = TRACKER_VENDORS[name];
    if (!def) return;
    const t = byVendor.get(def.vendor) || { vendor: def.vendor, category: def.category, aliases: def.aliases, detectedAs: [], firedBeforeConsent: false, seenInSource: false, browserTested };
    if (!t.detectedAs.includes(name)) t.detectedAs.push(name);
    if (fired) t.firedBeforeConsent = true; else t.seenInSource = true;
    for (const a of def.aliases) if (!t.aliases.includes(a)) t.aliases = [...t.aliases, a];
    byVendor.set(def.vendor, t);
  };
  for (const n of seenInSource) add(n, false);
  for (const n of firedBeforeConsent) add(n, true);
  return [...byVendor.values()];
}

// Does a register vendor name match a sweep tracker?
export function trackerMatchesVendor(tracker, vendorName) {
  const n = String(vendorName || '').toLowerCase();
  const word = a => new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(n);
  return [...tracker.aliases, tracker.vendor.toLowerCase()].some(word);
}

// The marketing check a tracker gives evidence for, by register category
export const TRACKING_CHECK_BY_CATEGORY = { analytics: 'an_prior_consent', advertising: 'ad_pixel', agency: 'ag_tracking', other: 'oth_tracks' };

// Apply one sweep's evidence to a register record's marketing checks.
// A tracker that fired before consent is a verified gap, whatever was
// self-assessed. A tracker on the page that waited for consent in the
// live test marks the check passed only if it was unanswered, or if an
// earlier sweep had set it. Returns the new checks object, or null when
// nothing changes.
export function applySweepEvidence(mc, tracker, { domain, sweptAt }) {
  const checkId = TRACKING_CHECK_BY_CATEGORY[mc.category];
  if (!checkId) return null;
  const current = mc.checks?.[checkId] || null;
  const date = String(sweptAt || new Date().toISOString()).split('T')[0];
  let next = null;
  if (tracker.firedBeforeConsent) {
    next = { status: 'not_evidenced', source: 'site_sweep', updatedAt: date,
      note: `Site Sweep ${date}: ${tracker.detectedAs.join(', ')} sent data from ${domain} before any consent choice.` };
  } else if (tracker.browserTested && tracker.seenInSource && (!current?.status || current.source === 'site_sweep')) {
    next = { status: 'passed', source: 'site_sweep', updatedAt: date,
      note: `Site Sweep ${date}: ${tracker.detectedAs.join(', ')} found on ${domain} and did not fire before a consent choice.` };
  }
  if (!next) return null;
  if (current && current.status === next.status && current.source === next.source && current.note === next.note) return null;
  return { ...(mc.checks || {}), [checkId]: next };
}
