// ─────────────────────────────────────────────────────────────
// SENDWIZE — _smart-import.js v1.1
//
// Shared CSV column normalisation layer.
// Used by BOTH list-intelligence.js AND audience-read.js.
//
// Deploy to: api/_smart-import.js
//
// Exports:
//   smartDetect(headers, sampleRows, mode)
//     → { mapping, confidence, rateUnits, derivedRates,
//        recognized, ignored, ambiguous, summary }
//
//   mode: 'audience' | 'list'
//     audience = campaign performance CSV (dates, rates, counts)
//     list     = contact list CSV (emails, dates, engagement)
//
// Does NOT call Claude API. This is the deterministic layer that
// replaces the old scoreColumn/autoMapColumns/detectListColumns
// functions. The AI mapper remains as an optional enhancement
// called BEFORE this — if AI returns a result, pass it through
// smartValidate() to verify count/rate sanity.
// ─────────────────────────────────────────────────────────────

// ─── CANONICAL FIELD DEFINITIONS ────────────────────────────
// Each field has: aliases (header names that match), type, and
// for audience mode vs list mode which are valid.

const FIELD_DEFS = {
  // ── Audience Read fields ──────────────────────────────────
  date:              { type: 'date',   modes: ['audience'],       friendlyName: 'Send date' },
  segment:           { type: 'string', modes: ['audience','list'], friendlyName: 'Audience / list' },
  campaign_name:     { type: 'string', modes: ['audience'],       friendlyName: 'Campaign' },
  campaign_type:     { type: 'string', modes: ['audience'],       friendlyName: 'Campaign type' },
  channel:           { type: 'string', modes: ['audience'],       friendlyName: 'Channel' },
  consent_basis:     { type: 'string', modes: ['audience'],       friendlyName: 'Consent basis' },
  volume_sent:       { type: 'count',  modes: ['audience'],       friendlyName: 'Sends' },
  delivered_count:   { type: 'count',  modes: ['audience'],       friendlyName: 'Delivered' },
  open_count:        { type: 'count',  modes: ['audience'],       friendlyName: 'Opens' },
  open_rate:         { type: 'rate',   modes: ['audience'],       friendlyName: 'Open rate' },
  click_count:       { type: 'count',  modes: ['audience'],       friendlyName: 'Clicks' },
  click_rate:        { type: 'rate',   modes: ['audience'],       friendlyName: 'Click rate' },
  unsubscribe_count: { type: 'count',  modes: ['audience'],       friendlyName: 'Unsubscribes' },
  unsubscribe_rate:  { type: 'rate',   modes: ['audience'],       friendlyName: 'Unsub rate' },
  bounce_count:      { type: 'count',  modes: ['audience'],       friendlyName: 'Bounces' },
  complaint_count:   { type: 'count',  modes: ['audience'],       friendlyName: 'Complaints' },
  revenue:           { type: 'money',  modes: ['audience'],       friendlyName: 'Revenue' },

  // ── List Intelligence fields ──────────────────────────────
  email:             { type: 'email',  modes: ['list'],           friendlyName: 'Email' },
  date_added:        { type: 'date',   modes: ['list'],           friendlyName: 'Date added' },
  last_engagement:   { type: 'date',   modes: ['list'],           friendlyName: 'Last engagement' },
  last_purchase:     { type: 'date',   modes: ['list'],           friendlyName: 'Last purchase' },
  engagement_type:   { type: 'string', modes: ['list'],           friendlyName: 'Engagement type' },
  status:            { type: 'string', modes: ['list'],           friendlyName: 'Status' },
  order_value:       { type: 'money',  modes: ['list'],           friendlyName: 'Order value' },
  engagement_count:  { type: 'count',  modes: ['list'],           friendlyName: 'Engagement count' },
};

// ─── ALIAS TABLE ────────────────────────────────────────────
// Each alias maps to a canonical field. Aliases are matched after
// normalising the header: lowercase, strip punctuation, collapse
// whitespace/underscores/hyphens to single space.

const ALIASES = {
  // Volume sent
  'sent': 'volume_sent', 'sends': 'volume_sent', 'emails sent': 'volume_sent',
  'recipients': 'volume_sent', 'recipients sent': 'volume_sent',
  'volume': 'volume_sent', 'volume sent': 'volume_sent', 'total sent': 'volume_sent',
  'emails': 'volume_sent', 'total emails': 'volume_sent', 'contacts sent': 'volume_sent',
  'messages sent': 'volume_sent', 'total recipients': 'volume_sent',
  'send count': 'volume_sent', 'send volume': 'volume_sent',

  // Delivered
  'delivered': 'delivered_count', 'deliveries': 'delivered_count',
  'successful deliveries': 'delivered_count', 'delivered count': 'delivered_count',
  'successful': 'delivered_count', 'emails delivered': 'delivered_count',
  'messages delivered': 'delivered_count',

  // Opens
  'opens': 'open_count', 'open': 'open_count', 'unique opens': 'open_count',
  'unique open': 'open_count', 'open count': 'open_count', 'opens count': 'open_count',
  'total opens': 'open_count', 'email opens': 'open_count',

  // Open rate
  'open rate': 'open_rate', 'open pct': 'open_rate', 'open percent': 'open_rate',
  'open percentage': 'open_rate', 'openrate': 'open_rate',

  // Clicks
  'clicks': 'click_count', 'click': 'click_count', 'unique clicks': 'click_count',
  'unique click': 'click_count', 'click count': 'click_count', 'clicks count': 'click_count',
  'total clicks': 'click_count', 'email clicks': 'click_count',

  // Click rate
  'click rate': 'click_rate', 'ctr': 'click_rate', 'click through rate': 'click_rate',
  'clickthrough rate': 'click_rate', 'click pct': 'click_rate',
  'click percentage': 'click_rate', 'clickrate': 'click_rate',

  // Unsubscribes
  'unsubscribes': 'unsubscribe_count', 'unsubscribe': 'unsubscribe_count',
  'unsub': 'unsubscribe_count', 'unsubs': 'unsubscribe_count',
  'opt outs': 'unsubscribe_count', 'opt-outs': 'unsubscribe_count',
  'optouts': 'unsubscribe_count', 'unsubscribed': 'unsubscribe_count',
  'total unsubscribes': 'unsubscribe_count', 'unsubscribe count': 'unsubscribe_count',

  // Unsubscribe rate
  'unsubscribe rate': 'unsubscribe_rate', 'unsub rate': 'unsubscribe_rate',
  'unsubscriberate': 'unsubscribe_rate', 'opt out rate': 'unsubscribe_rate',
  'unsubscribe pct': 'unsubscribe_rate',

  // Bounces
  'bounces': 'bounce_count', 'bounce': 'bounce_count', 'bounced': 'bounce_count',
  'bounce count': 'bounce_count', 'hard bounces': 'bounce_count',
  'soft bounces': 'bounce_count', 'total bounces': 'bounce_count',

  // Complaints
  'complaints': 'complaint_count', 'spam complaints': 'complaint_count',
  'spam': 'complaint_count', 'complaint count': 'complaint_count',
  'abuse complaints': 'complaint_count', 'abuse': 'complaint_count',
  'spam reports': 'complaint_count', 'reported spam': 'complaint_count',

  // Revenue
  'revenue': 'revenue', 'sales': 'revenue', 'sales value': 'revenue',
  'total sales': 'revenue', 'conversion value': 'revenue',
  'revenue generated': 'revenue', 'order value': 'order_value',
  'total revenue': 'revenue', 'campaign revenue': 'revenue',

  // Audience / segment
  'audience': 'segment', 'audience name': 'segment', 'list': 'segment',
  'list name': 'segment', 'segment': 'segment', 'segment name': 'segment',
  'group': 'segment', 'tag': 'segment', 'cohort': 'segment',
  'audience segment': 'segment',

  // Campaign
  'campaign': 'campaign_name', 'campaign name': 'campaign_name',
  'campaign title': 'campaign_name', 'email name': 'campaign_name',
  'message name': 'campaign_name', 'subject': 'campaign_name',
  'subject line': 'campaign_name', 'email subject': 'campaign_name',

  // Campaign type
  'type': 'campaign_type', 'campaign type': 'campaign_type',
  'kind': 'campaign_type', 'category': 'campaign_type',
  'template': 'campaign_type', 'email type': 'campaign_type',
  'message type': 'campaign_type',

  // Channel
  'channel': 'channel', 'send channel': 'channel', 'medium': 'channel',

  // Consent basis
  'consent basis': 'consent_basis', 'consent': 'consent_basis',
  'legal basis': 'consent_basis', 'consent type': 'consent_basis',
  'opt in method': 'consent_basis',

  // Date (audience mode)
  'date': 'date', 'send date': 'date', 'sent date': 'date',
  'sent on': 'date', 'send on': 'date', 'delivered at': 'date',
  'timestamp': 'date', 'campaign date': 'date', 'date sent': 'date',

  // ── List Intelligence specific ────────────────────────────
  'email': 'email', 'email address': 'email', 'e mail': 'email',
  'subscriber email': 'email', 'contact email': 'email',
  'email addr': 'email',

  'date added': 'date_added', 'created': 'date_added', 'joined': 'date_added',
  'sign up date': 'date_added', 'signup date': 'date_added',
  'subscribed': 'date_added', 'subscribe date': 'date_added',
  'created at': 'date_added', 'created date': 'date_added',
  'added': 'date_added', 'registration date': 'date_added',
  'opted in': 'date_added', 'opt in date': 'date_added',
  'join date': 'date_added',

  'last engagement': 'last_engagement', 'last active': 'last_engagement',
  'last activity': 'last_engagement', 'last open': 'last_engagement',
  'last click': 'last_engagement', 'last seen': 'last_engagement',
  'last engaged': 'last_engagement', 'last interaction': 'last_engagement',
  'last visit': 'last_engagement', 'last email open': 'last_engagement',
  'last email click': 'last_engagement',

  'last purchase': 'last_purchase', 'last order': 'last_purchase',
  'last buy': 'last_purchase', 'last order date': 'last_purchase',
  'last purchase date': 'last_purchase', 'most recent order': 'last_purchase',

  'engagement type': 'engagement_type', 'activity type': 'engagement_type',
  'action type': 'engagement_type', 'event type': 'engagement_type',

  'status': 'status', 'subscription status': 'status',
  'subscriber status': 'status', 'state': 'status',
  'email status': 'status',

  'spend': 'order_value', 'ltv': 'order_value', 'lifetime value': 'order_value',
  'total spend': 'order_value', 'customer value': 'order_value',

  'engagement count': 'engagement_count', 'activity count': 'engagement_count',
  'total opens': 'engagement_count', 'total clicks': 'engagement_count',
  'sessions': 'engagement_count',
};

// ─── NORMALISE HEADER ───────────────────────────────────────
function normaliseHeader(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')       // underscores, hyphens, dots, slashes → space
    .replace(/[^a-z0-9 £$€%]/g, '')  // strip other punctuation
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();
}

// ─── DATA TYPE DETECTION ────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}|^\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function detectDataType(values) {
  const clean = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  if (!clean.length) return { type: 'unknown', numRatio: 0, dateRatio: 0, emailRatio: 0 };

  const n = clean.length;
  const strs = clean.map(v => String(v).trim());
  const dateHits = strs.filter(v => DATE_RE.test(v)).length;
  const emailHits = strs.filter(v => EMAIL_RE.test(v)).length;
  const hasPct = strs.some(v => v.includes('%'));
  const nums = strs.map(v => parseFloat(v.replace(/[%,£$€]/g, ''))).filter(v => !isNaN(v));
  const numRatio = nums.length / n;
  const dateRatio = dateHits / n;
  const emailRatio = emailHits / n;

  // All values ≤ 1 and ≥ 0 → likely decimal fraction rate
  const allSubOne = nums.length > 0 && nums.every(v => v >= 0 && v <= 1);
  // All values ≤ 100 → could be percentage
  const allSubHundred = nums.length > 0 && nums.every(v => v >= 0 && v <= 100);
  // Large integers → count
  const hasLargeNums = nums.some(v => v > 100 && Number.isInteger(v));
  const medianNum = nums.length ? nums.sort((a, b) => a - b)[Math.floor(nums.length / 2)] : null;

  return {
    type: emailRatio > 0.5 ? 'email' : dateRatio > 0.5 ? 'date' : numRatio > 0.7 ? 'numeric' : 'string',
    numRatio, dateRatio, emailRatio, hasPct,
    allSubOne, allSubHundred, hasLargeNums, medianNum,
    sampleCount: n,
  };
}

// ─── COUNT VS RATE RESOLVER ─────────────────────────────────
// Given a candidate field and its data profile, determine whether
// it's a count or a rate. Returns the corrected canonical field.

function resolveCountVsRate(candidateField, dataProfile, headerNorm) {
  const def = FIELD_DEFS[candidateField];
  if (!def) return { field: candidateField, unit: null };

  // If the field is already explicitly a count or rate type, verify
  if (def.type === 'count') {
    // Header said count, but values look like rates?
    if (dataProfile.allSubOne && !dataProfile.hasLargeNums) {
      // e.g. "unsubscribes" with values 0.003 — probably a rate mislabelled
      const rateField = candidateField.replace('_count', '_rate');
      if (FIELD_DEFS[rateField]) {
        return { field: rateField, unit: 'decimal_fraction', corrected: true };
      }
    }
    return { field: candidateField, unit: null };
  }

  if (def.type === 'rate') {
    // Header said rate, but values are large integers?
    if (dataProfile.hasLargeNums && dataProfile.medianNum > 10) {
      // e.g. "open_rate" with values 4200 — probably a count
      const countField = candidateField.replace('_rate', '_count');
      if (FIELD_DEFS[countField]) {
        return { field: countField, unit: null, corrected: true };
      }
    }
    // Determine unit for actual rate values
    if (dataProfile.hasPct) return { field: candidateField, unit: 'percentage' };
    if (dataProfile.allSubOne) return { field: candidateField, unit: 'decimal_fraction' };
    if (dataProfile.allSubHundred && dataProfile.medianNum > 1) return { field: candidateField, unit: 'percentage' };
    // Default: if values > 1, percentage; if ≤ 1, decimal
    if (dataProfile.medianNum != null) {
      return { field: candidateField, unit: dataProfile.medianNum > 1 ? 'percentage' : 'decimal_fraction' };
    }
    return { field: candidateField, unit: 'percentage' };
  }

  return { field: candidateField, unit: null };
}

// ─── AMBIGUITY DETECTION ────────────────────────────────────
// Some headers are genuinely ambiguous. "delivered" in audience
// mode with large integers could be volume_sent OR delivered_count.
// We handle known ambiguities here.

function resolveAmbiguity(candidateField, headerNorm, dataProfile, mode, alreadyClaimed) {
  // "delivered" with large numbers — prefer delivered_count if volume_sent already claimed
  if (candidateField === 'delivered_count' && !alreadyClaimed.has('volume_sent') && dataProfile.hasLargeNums) {
    // Could be volume_sent — but only if nothing else claims it
    // Keep as delivered_count; the system will derive rates from it
  }

  // "name" alone is ambiguous in audience mode
  if (headerNorm === 'name' && mode === 'audience') {
    return { field: 'campaign_name', confidence: 'medium' };
  }

  // "engagement" alone — genuinely ambiguous
  if (headerNorm === 'engagement' && mode === 'audience') {
    return { field: null, ambiguous: true, options: ['open_count', 'click_count', 'engagement_count'], reason: 'Could be opens, clicks, or a combined metric' };
  }

  return null; // no special handling needed
}

// ─── MAIN DETECTION FUNCTION ────────────────────────────────

/**
 * smartDetect — deterministic column detection with confidence scoring.
 *
 * @param {string[]} headers - CSV column headers
 * @param {Object[]} sampleRows - first N rows of data
 * @param {'audience'|'list'} mode - which tool is calling
 * @returns {Object} detection result
 */
function smartDetect(headers, sampleRows, mode = 'audience') {
  const rows = (sampleRows || []).slice(0, 30);
  const mapping = {};       // header → canonical field
  const confidence = {};    // header → 'high' | 'medium' | 'low' | 'none'
  const rateUnits = {};     // header → 'percentage' | 'decimal_fraction'
  const recognized = [];    // { header, field, friendlyName, confidence }
  const ignored = [];       // headers we're ignoring
  const ambiguous = [];     // { header, options[], reason }
  const corrections = [];   // { header, from, to, reason }

  // Step 1: Profile every column's data
  const profiles = {};
  for (const h of headers) {
    const vals = rows.map(r => r[h]);
    profiles[h] = detectDataType(vals);
  }

  // Step 2: Score each header against aliases
  const candidates = []; // { header, field, score, source }
  for (const h of headers) {
    const norm = normaliseHeader(h);
    const profile = profiles[h];

    // Direct alias match
    if (ALIASES[norm]) {
      const field = ALIASES[norm];
      const def = FIELD_DEFS[field];
      if (def && def.modes.includes(mode)) {
        candidates.push({ header: h, field, score: 100, source: 'alias' });
        continue;
      }
    }

    // Partial / fuzzy match — check if the normalised header contains an alias
    let bestMatch = null;
    let bestScore = 0;
    for (const [alias, field] of Object.entries(ALIASES)) {
      const def = FIELD_DEFS[field];
      if (!def || !def.modes.includes(mode)) continue;

      if (norm === alias) {
        if (100 > bestScore) { bestMatch = field; bestScore = 100; }
      } else if (norm.includes(alias) && alias.length >= 3) {
        // Contained match — lower confidence
        const score = 60 + Math.min(20, alias.length * 2);
        if (score > bestScore) { bestMatch = field; bestScore = score; }
      }
    }

    // Data-type heuristic fallback for list mode
    if (!bestMatch && mode === 'list') {
      if (profile.emailRatio > 0.5) { bestMatch = 'email'; bestScore = 90; }
      else if (profile.dateRatio > 0.5) {
        // Guess date type from header name
        const lc = norm;
        if (lc.includes('engag') || lc.includes('activ') || lc.includes('open') || lc.includes('click') || lc.includes('last')) {
          bestMatch = 'last_engagement'; bestScore = 55;
        } else if (lc.includes('purchas') || lc.includes('order') || lc.includes('buy')) {
          bestMatch = 'last_purchase'; bestScore = 55;
        } else {
          bestMatch = 'date_added'; bestScore = 50;
        }
      }
    }

    // Data-type heuristic fallback for audience mode
    if (!bestMatch && mode === 'audience') {
      if (profile.dateRatio > 0.5) { bestMatch = 'date'; bestScore = 70; }
    }

    if (bestMatch) {
      candidates.push({ header: h, field: bestMatch, score: bestScore, source: bestScore >= 80 ? 'alias' : 'heuristic' });
    }
  }

  // Step 3: Deduplicate — highest score wins per field
  candidates.sort((a, b) => b.score - a.score);
  const claimedFields = new Set();
  const claimedHeaders = new Set();

  for (const c of candidates) {
    if (claimedHeaders.has(c.header) || claimedFields.has(c.field)) continue;

    // Resolve count vs rate
    const resolved = resolveCountVsRate(c.field, profiles[c.header], normaliseHeader(c.header));

    // Check if resolved field is already claimed
    if (claimedFields.has(resolved.field)) continue;

    // Check ambiguity
    const ambiguityResult = resolveAmbiguity(resolved.field, normaliseHeader(c.header), profiles[c.header], mode, claimedFields);
    if (ambiguityResult?.ambiguous) {
      ambiguous.push({ header: c.header, options: ambiguityResult.options, reason: ambiguityResult.reason });
      claimedHeaders.add(c.header);
      continue;
    }

    // Apply correction if count/rate was swapped
    if (resolved.corrected) {
      corrections.push({
        header: c.header,
        from: c.field,
        to: resolved.field,
        reason: resolved.field.includes('_count') ? 'Values look like counts, not rates' : 'Values look like rates, not counts',
      });
    }

    // Determine confidence
    let conf = 'high';
    if (c.score >= 90) conf = 'high';
    else if (c.score >= 60) conf = 'medium';
    else conf = 'low';

    // Override confidence if ambiguity was resolved
    if (ambiguityResult?.confidence) conf = ambiguityResult.confidence;

    mapping[c.header] = resolved.field;
    confidence[c.header] = conf;
    if (resolved.unit) rateUnits[c.header] = resolved.unit;
    claimedFields.add(resolved.field);
    claimedHeaders.add(c.header);

    const def = FIELD_DEFS[resolved.field];
    recognized.push({
      header: c.header,
      field: resolved.field,
      friendlyName: def?.friendlyName || resolved.field,
      confidence: conf,
    });
  }

  // Step 4: Mark unclaimed headers as ignored
  for (const h of headers) {
    if (!claimedHeaders.has(h)) {
      mapping[h] = '';
      confidence[h] = 'none';
      ignored.push(h);
    }
  }

  // Step 5: Calculate derivable rates
  const derivedRates = [];
  if (mode === 'audience') {
    const hasVolume = claimedFields.has('volume_sent') || claimedFields.has('delivered_count');
    if (hasVolume) {
      if (claimedFields.has('open_count') && !claimedFields.has('open_rate')) {
        derivedRates.push({ rate: 'open_rate', from: 'open_count', divisor: claimedFields.has('delivered_count') ? 'delivered_count' : 'volume_sent' });
      }
      if (claimedFields.has('click_count') && !claimedFields.has('click_rate')) {
        derivedRates.push({ rate: 'click_rate', from: 'click_count', divisor: claimedFields.has('delivered_count') ? 'delivered_count' : 'volume_sent' });
      }
      if (claimedFields.has('unsubscribe_count') && !claimedFields.has('unsubscribe_rate')) {
        derivedRates.push({ rate: 'unsubscribe_rate', from: 'unsubscribe_count', divisor: claimedFields.has('delivered_count') ? 'delivered_count' : 'volume_sent' });
      }
      if (claimedFields.has('bounce_count')) {
        derivedRates.push({ rate: 'bounce_rate', from: 'bounce_count', divisor: 'volume_sent' });
      }
      if (claimedFields.has('complaint_count')) {
        derivedRates.push({ rate: 'complaint_rate', from: 'complaint_count', divisor: claimedFields.has('delivered_count') ? 'delivered_count' : 'volume_sent' });
      }
    }
  }

  // Step 6: Build capabilities and summary
  const hasDate = mode === 'audience' ? claimedFields.has('date') : (claimedFields.has('date_added') || claimedFields.has('last_engagement'));
  const hasVolumeClaimed = claimedFields.has('volume_sent') || claimedFields.has('delivered_count');
  const hasOpenData = claimedFields.has('open_rate') || claimedFields.has('open_count');
  const hasClickData = claimedFields.has('click_rate') || claimedFields.has('click_count');
  const hasUnsubData = claimedFields.has('unsubscribe_count') || claimedFields.has('unsubscribe_rate');
  const hasBounceData = claimedFields.has('bounce_count');
  const hasComplaintData = claimedFields.has('complaint_count');
  const hasRevenueData = claimedFields.has('revenue');
  const hasDeliveryData = claimedFields.has('delivered_count');

  // Capability-based analysis: what can Sendwize legitimately say?
  const capabilities = {
    timeline:      hasDate,
    volume:        hasVolumeClaimed,
    delivery:      hasDeliveryData,
    opens:         hasOpenData,
    clicks:        hasClickData,
    unsubscribes:  hasUnsubData,
    bounces:       hasBounceData,
    complaints:    hasComplaintData,
    revenue:       hasRevenueData,
    segments:      claimedFields.has('segment'),
  };

  // Available and unavailable labels for the frontend
  const available = [];
  const unavailable = [];
  if (mode === 'audience') {
    if (capabilities.timeline)     available.push('Campaign dates');     else unavailable.push('Campaign dates');
    if (capabilities.volume)       available.push('Send volume');        else unavailable.push('Send volume');
    if (capabilities.delivery)     available.push('Delivery data');      else unavailable.push('Delivery data');
    if (capabilities.opens)        available.push('Open data');          else unavailable.push('Open data');
    if (capabilities.clicks)       available.push('Click data');         else unavailable.push('Click data');
    if (capabilities.unsubscribes) available.push('Unsubscribe data');   else unavailable.push('Unsubscribe data');
    if (capabilities.bounces)      available.push('Bounce data');        else unavailable.push('Bounce data');
    if (capabilities.complaints)   available.push('Complaint data');     else unavailable.push('Complaint data');
    if (capabilities.revenue)      available.push('Revenue data');       else unavailable.push('Revenue data');
    if (capabilities.segments)     available.push('List/audience names');
  } else {
    if (claimedFields.has('email'))            available.push('Email addresses');     else unavailable.push('Email addresses');
    if (claimedFields.has('date_added'))       available.push('Date added');          else unavailable.push('Date added');
    if (claimedFields.has('last_engagement'))   available.push('Last engagement');    else unavailable.push('Last engagement');
    if (claimedFields.has('last_purchase'))     available.push('Last purchase');
    if (claimedFields.has('engagement_type'))   available.push('Engagement type');
    if (claimedFields.has('order_value'))       available.push('Order value');
    if (claimedFields.has('status'))           available.push('Subscription status');
  }

  // canAnalyse: do we have enough to say ANYTHING useful?
  // Audience: need at least one meaningful metric (date OR volume OR engagement)
  // List: need email at minimum
  let canAnalyse;
  if (mode === 'audience') {
    const hasAnyEngagement = hasOpenData || hasClickData || hasUnsubData || hasBounceData || hasComplaintData;
    const hasAnyMetric = hasDate || hasVolumeClaimed || hasAnyEngagement || hasRevenueData;
    // Need at least two meaningful signals, OR date + anything, OR volume + anything
    canAnalyse = (hasDate && (hasVolumeClaimed || hasAnyEngagement))
              || (hasVolumeClaimed && hasAnyEngagement)
              || (hasDate && hasRevenueData)
              || (available.length >= 3); // enough variety to say something
  } else {
    canAnalyse = claimedFields.has('email');
  }

  const summary = {
    totalColumns: headers.length,
    recognizedCount: recognized.length,
    ignoredCount: ignored.length,
    ambiguousCount: ambiguous.length,
    highConfidence: recognized.filter(r => r.confidence === 'high').length,
    mediumConfidence: recognized.filter(r => r.confidence === 'medium').length,
    lowConfidence: recognized.filter(r => r.confidence === 'low').length,
    derivableRates: derivedRates.length,
    corrections: corrections.length,
    // Data availability flags (kept for backward compat)
    hasDate,
    hasSegment: claimedFields.has('segment'),
    hasEmail: claimedFields.has('email'),
    hasUnsubData,
    hasVolumeData: hasVolumeClaimed,
    canAnalyse,
    noSegmentDetected: !claimedFields.has('segment'),
    // New capability-based fields
    capabilities,
    available,
    unavailable,
  };

  return {
    mapping,
    confidence,
    rateUnits,
    derivedRates,
    recognized,
    ignored,
    ambiguous,
    corrections,
    summary,
  };
}

// ─── AI RESULT VALIDATOR ────────────────────────────────────
// If the AI mapper ran first, validate its count/rate assignments
// against actual data values. Fixes the "opens=4200 → open_rate"
// problem even when the AI gets confused.

function smartValidate(aiMapping, headers, sampleRows, mode = 'audience') {
  const rows = (sampleRows || []).slice(0, 30);
  const corrected = { ...aiMapping };
  const corrections = [];

  for (const h of headers) {
    const field = corrected[h];
    if (!field || field === 'ignore' || field === '') continue;

    const def = FIELD_DEFS[field];
    if (!def) continue;

    const vals = rows.map(r => r[h]);
    const profile = detectDataType(vals);

    const resolved = resolveCountVsRate(field, profile, normaliseHeader(h));
    if (resolved.corrected) {
      corrected[h] = resolved.field;
      corrections.push({ header: h, from: field, to: resolved.field, reason: resolved.field.includes('_count') ? 'Values are counts, not rates' : 'Values are rates, not counts' });
    }
  }

  return { mapping: corrected, corrections };
}

// ─── EXPORTS ────────────────────────────────────────────────
export { smartDetect, smartValidate, FIELD_DEFS, normaliseHeader };
