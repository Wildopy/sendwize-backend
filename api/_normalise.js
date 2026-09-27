// SENDWIZE — _normalise.js v1.0
// Shared normalisation layer for List Intelligence and Audience Read
// Deploy as: api/_normalise.js
//
// Both backends import this and run every row through normaliseRow()
// before any analysis. No downstream function should ever touch
// raw row data or reference source column names.

// ─── Date parsing ─────────────────────────────────────────────
// Handles: DD/MM/YYYY, MM/DD/YYYY (if unambiguous), YYYY-MM-DD,
// ISO 8601, "15 Mar 2023", "March 15, 2023", Unix timestamps (ms),
// Excel serial dates, and common separators (/, -, .)

const MONTH_MAP = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,
  may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,
  september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11,
};

export function parseFlexibleDate(val) {
  if (val == null) return null;

  // Already a Date
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

  const raw = String(val).trim();
  if (!raw || raw === '-' || /^(n\/?a|unknown|none|null|undefined)$/i.test(raw)) return null;

  // Unix timestamp in ms (13+ digits)
  if (/^\d{13,}$/.test(raw)) {
    const d = new Date(parseInt(raw));
    return isNaN(d.getTime()) ? null : d;
  }

  // Unix timestamp in seconds (10 digits)
  if (/^\d{10}$/.test(raw)) {
    const d = new Date(parseInt(raw) * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  // Excel serial date (number 1-100000, no separators)
  if (/^\d{1,5}$/.test(raw)) {
    const n = parseInt(raw);
    if (n >= 1 && n <= 100000) {
      // Excel epoch is 1 Jan 1900, but has the Lotus 1-2-3 bug (day 60 = 29 Feb 1900)
      const d = new Date(Date.UTC(1899, 11, 30 + n));
      if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2040) return d;
    }
  }

  // ISO 8601: 2023-03-15 or 2023-03-15T10:00:00Z
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  // Named month: "15 Mar 2023", "March 15, 2023", "Mar 15 2023"
  const namedMatch = raw.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i)
    || raw.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (namedMatch) {
    let day, monthStr, year;
    if (/^\d/.test(namedMatch[1])) {
      day = parseInt(namedMatch[1]); monthStr = namedMatch[2].toLowerCase(); year = parseInt(namedMatch[3]);
    } else {
      monthStr = namedMatch[1].toLowerCase(); day = parseInt(namedMatch[2]); year = parseInt(namedMatch[3]);
    }
    const month = MONTH_MAP[monthStr];
    if (month !== undefined && day >= 1 && day <= 31 && year >= 1990 && year <= 2040) {
      return new Date(Date.UTC(year, month, day));
    }
  }

  // Separated: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, MM/DD/YYYY
  const sepMatch = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (sepMatch) {
    let a = parseInt(sepMatch[1]);
    let b = parseInt(sepMatch[2]);
    let year = parseInt(sepMatch[3]);
    if (year < 100) year += 2000; // 23 → 2023

    // UK-first: DD/MM/YYYY (a=day, b=month)
    // But if a > 12, it must be day; if b > 12, b must be day (so a is month)
    let day, month;
    if (a > 12 && b <= 12) { day = a; month = b; }      // 25/03/2023 → day=25, month=3
    else if (b > 12 && a <= 12) { day = b; month = a; }  // 03/25/2023 → day=25, month=3
    else if (a <= 12 && b <= 12) { day = a; month = b; }  // Ambiguous: default UK (DD/MM)
    else return null; // Both > 12, invalid

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1990 && year <= 2040) {
      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  // YYYY/MM/DD
  const ymdMatch = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1]), m = parseInt(ymdMatch[2]), d = parseInt(ymdMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, m - 1, d));
  }

  // Last resort: try native parser
  const last = new Date(raw);
  if (!isNaN(last.getTime()) && last.getFullYear() >= 1990 && last.getFullYear() <= 2040) return last;

  return null;
}

// ─── Money/number parsing ─────────────────────────────────────
// Strips £, $, €, commas, spaces. Returns null for N/A, unknown, blanks.

export function parseMoneyValue(val) {
  if (val == null) return null;
  const raw = String(val).trim();
  if (!raw || /^(n\/?a|unknown|none|null|undefined|-|£?0\.?0*|£?0)$/i.test(raw)) return null;
  const cleaned = raw.replace(/[£$€\s,]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export function parseCount(val) {
  if (val == null) return null;
  const raw = String(val).trim();
  if (!raw || /^(n\/?a|unknown|none|null|undefined|-)$/i.test(raw)) return null;
  const cleaned = raw.replace(/[,\s]/g, '');
  const n = parseInt(cleaned);
  return isNaN(n) ? null : n;
}

export function parseRate(val) {
  if (val == null) return null;
  const raw = String(val).trim();
  if (!raw || /^(n\/?a|unknown|none|null|undefined|-)$/i.test(raw)) return null;
  const cleaned = raw.replace(/[%\s]/g, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  // If has % symbol or value > 1, treat as percentage and convert to decimal
  if (raw.includes('%') || n > 1) return n / 100;
  return n; // Already decimal fraction
}

// ─── Status normalisation ─────────────────────────────────────

const STATUS_MAP = {
  'active': 'active', 'subscribed': 'active', 'opted in': 'active', 'opt-in': 'active',
  'opted_in': 'active', 'confirmed': 'active', 'enabled': 'active', 'yes': 'active',
  'true': 'active', '1': 'active',
  'unsubscribed': 'unsubscribed', 'opted out': 'unsubscribed', 'opt-out': 'unsubscribed',
  'opted_out': 'unsubscribed', 'removed': 'unsubscribed', 'no': 'unsubscribed',
  'false': 'unsubscribed', '0': 'unsubscribed', 'inactive': 'unsubscribed',
  'bounced': 'bounced', 'hard bounce': 'bounced', 'soft bounce': 'bounced',
  'invalid': 'bounced', 'undeliverable': 'bounced',
  'cleaned': 'cleaned', 'suppressed': 'cleaned', 'blacklisted': 'cleaned',
  'complaint': 'complained', 'complained': 'complained', 'spam': 'complained',
  'marked as spam': 'complained', 'abuse': 'complained',
};

export function normaliseStatus(val) {
  if (val == null) return null;
  const raw = String(val).trim().toLowerCase();
  if (!raw || raw === '-' || /^(n\/?a|unknown|none|null|undefined)$/i.test(raw)) return null;
  return STATUS_MAP[raw] || null;
}

// ─── Email validation ─────────────────────────────────────────

export function normaliseEmail(val) {
  if (val == null) return null;
  const raw = String(val).trim().toLowerCase();
  if (!raw || raw.length < 5 || !raw.includes('@')) return null;
  // Basic structural check — not a full RFC 5322 validator
  const parts = raw.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes('.')) return null;
  return raw;
}

// ─── List Intelligence normalisation ──────────────────────────
// Takes a raw CSV row (original column names) and a fieldMapping
// dictionary, returns a clean internal contact object.

export function normaliseListRow(rawRow, fieldMapping) {
  const contact = { _raw: rawRow }; // preserve original for downloads

  for (const [sourceCol, internalField] of Object.entries(fieldMapping)) {
    if (!internalField || internalField === 'ignore' || internalField === '') continue;
    const rawVal = rawRow[sourceCol];

    switch (internalField) {
      case 'email':
        contact.email = normaliseEmail(rawVal);
        break;
      case 'date_added':
        contact.dateAdded = parseFlexibleDate(rawVal);
        break;
      case 'last_engagement':
        contact.lastEngagement = parseFlexibleDate(rawVal);
        break;
      case 'last_purchase':
        contact.lastPurchase = parseFlexibleDate(rawVal);
        break;
      case 'engagement_type':
        contact.engagementType = rawVal ? String(rawVal).trim().toLowerCase() : null;
        break;
      case 'order_value':
        contact.orderValue = parseMoneyValue(rawVal);
        break;
      case 'engagement_count':
        contact.engagementCount = parseCount(rawVal);
        break;
      case 'status':
        contact.status = normaliseStatus(rawVal);
        break;
      case 'segment':
        contact.segment = rawVal ? String(rawVal).trim() : null;
        break;
      // Anything else: silently ignore
    }
  }

  return contact;
}

// ─── Audience Read normalisation ──────────────────────────────

export function normaliseAudienceRow(rawRow, fieldMapping, rateUnits) {
  const campaign = { _raw: rawRow };
  const ru = rateUnits || {};

  for (const [sourceCol, internalField] of Object.entries(fieldMapping)) {
    if (!internalField || internalField === 'ignore' || internalField === '') continue;
    const rawVal = rawRow[sourceCol];

    switch (internalField) {
      case 'date':
        campaign.date = parseFlexibleDate(rawVal);
        if (campaign.date) campaign.date = campaign.date.toISOString().split('T')[0];
        break;
      case 'segment':
        campaign.segment = rawVal ? String(rawVal).trim() : null;
        break;
      case 'campaign_name':
        campaign.campaign_name = rawVal ? String(rawVal).trim() : null;
        break;
      case 'campaign_type':
        campaign.campaign_type = rawVal ? String(rawVal).trim() : null;
        break;
      case 'volume_sent':
        campaign.volume_sent = parseCount(rawVal);
        break;
      case 'delivered_count':
        campaign.delivered_count = parseCount(rawVal);
        break;
      case 'open_count':
        campaign.open_count = parseCount(rawVal);
        break;
      case 'click_count':
        campaign.click_count = parseCount(rawVal);
        break;
      case 'bounce_count':
        campaign.bounce_count = parseCount(rawVal);
        break;
      case 'complaint_count':
        campaign.complaint_count = parseCount(rawVal);
        break;
      case 'unsubscribe_count':
        campaign.unsubscribe_count = parseCount(rawVal);
        break;
      case 'conversions':
        campaign.conversions = parseCount(rawVal);
        break;
      case 'open_rate': {
        const unit = ru[sourceCol];
        const v = parseFloat(String(rawVal || '').replace(/[%\s]/g, ''));
        if (!isNaN(v)) {
          campaign.open_rate = (unit === 'decimal_fraction') ? v : (String(rawVal).includes('%') || v > 1) ? v / 100 : v;
        }
        break;
      }
      case 'click_rate': {
        const unit = ru[sourceCol];
        const v = parseFloat(String(rawVal || '').replace(/[%\s]/g, ''));
        if (!isNaN(v)) {
          campaign.click_rate = (unit === 'decimal_fraction') ? v : (String(rawVal).includes('%') || v > 1) ? v / 100 : v;
        }
        break;
      }
      case 'unsubscribe_rate': {
        const unit = ru[sourceCol];
        const v = parseFloat(String(rawVal || '').replace(/[%\s]/g, ''));
        if (!isNaN(v)) {
          campaign.unsubscribe_rate = (unit === 'decimal_fraction') ? v : (String(rawVal).includes('%') || v > 1) ? v / 100 : v;
        }
        break;
      }
      case 'revenue':
        campaign.revenue = parseMoneyValue(rawVal);
        break;
      case 'cost':
        campaign.cost = parseMoneyValue(rawVal);
        break;
      case 'consent_basis':
        campaign.consent_basis = rawVal ? String(rawVal).trim().toLowerCase().replace(/\s+/g, '_') : null;
        break;
      case 'channel':
        campaign.channel = rawVal ? String(rawVal).trim().toLowerCase() : null;
        break;
    }
  }

  // Derive rates from counts if we have volume
  if (campaign.volume_sent && campaign.volume_sent > 0) {
    if (campaign.open_rate == null && campaign.open_count != null) {
      campaign.open_rate = campaign.open_count / campaign.volume_sent;
    }
    if (campaign.click_rate == null && campaign.click_count != null) {
      campaign.click_rate = campaign.click_count / campaign.volume_sent;
    }
    if (campaign.unsubscribe_rate == null && campaign.unsubscribe_count != null) {
      campaign.unsubscribe_rate = campaign.unsubscribe_count / campaign.volume_sent;
    }
  }

  return campaign;
}

// ─── Batch normalisation + dedup (List Intelligence) ──────────

export function normaliseListUpload(rows, fieldMapping) {
  const contacts = [];
  const seen = new Set();
  let duplicatesRemoved = 0;
  let blankEmails = 0;
  let invalidEmails = 0;
  let dateParseFailures = 0;

  for (const rawRow of rows) {
    const contact = normaliseListRow(rawRow, fieldMapping);

    // Skip rows with no email at all
    if (!contact.email) {
      // Check if there was a value that failed validation
      const emailCol = Object.entries(fieldMapping).find(([, v]) => v === 'email');
      const rawEmail = emailCol ? rawRow[emailCol[0]] : null;
      if (rawEmail && String(rawEmail).trim()) { invalidEmails++; }
      else { blankEmails++; }
      continue;
    }

    // Deduplicate
    if (seen.has(contact.email)) { duplicatesRemoved++; continue; }
    seen.add(contact.email);

    // Track date parse issues (non-fatal)
    const dateCol = Object.entries(fieldMapping).find(([, v]) => v === 'date_added');
    if (dateCol && rawRow[dateCol[0]] && String(rawRow[dateCol[0]]).trim() && !contact.dateAdded) {
      dateParseFailures++;
    }

    contacts.push(contact);
  }

  return {
    contacts,
    stats: {
      totalRows: rows.length,
      usableContacts: contacts.length,
      duplicatesRemoved,
      blankEmails,
      invalidEmails,
      dateParseFailures,
    },
  };
}

// ─── Batch normalisation (Audience Read) ──────────────────────

export function normaliseAudienceUpload(rows, fieldMapping, rateUnits) {
  const campaigns = [];
  let skipped = 0;

  for (const rawRow of rows) {
    const campaign = normaliseAudienceRow(rawRow, fieldMapping, rateUnits);

    // Skip rows with no meaningful data at all
    const hasAnyData = campaign.date || campaign.volume_sent || campaign.open_rate != null
      || campaign.click_rate != null || campaign.unsubscribe_count != null || campaign.revenue != null;
    if (!hasAnyData) { skipped++; continue; }

    campaigns.push(campaign);
  }

  return {
    campaigns,
    stats: {
      totalRows: rows.length,
      usableCampaigns: campaigns.length,
      skipped,
    },
  };
}

// ─── Upload validation (400 gatekeeper) ───────────────────────
// Returns { valid: true } or { valid: false, status: 400, error: '...' }
// This is the ONLY place that should produce a 400.

export function validateListUpload(body) {
  if (!body) return { valid: false, status: 400, error: 'No request body' };
  const rows = body.rows || body.contacts;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return { valid: false, status: 400, error: 'No rows provided or empty file' };
  }
  const mapping = body.fieldMapping || body.columnMapping;
  if (!mapping || typeof mapping !== 'object') {
    return { valid: false, status: 400, error: 'No field mapping provided' };
  }
  const hasEmail = Object.values(mapping).includes('email');
  if (!hasEmail) {
    return { valid: false, status: 400, error: 'No email column mapped. Map at least one column to Email to run analysis.' };
  }
  return { valid: true, rows, mapping };
}

export function validateAudienceUpload(body) {
  if (!body) return { valid: false, status: 400, error: 'No request body' };
  const rows = body.rows || body.campaigns;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return { valid: false, status: 400, error: 'No rows provided or empty file' };
  }
  const mapping = body.fieldMapping || body.columnMapping;
  if (!mapping || typeof mapping !== 'object') {
    return { valid: false, status: 400, error: 'No field mapping provided' };
  }
  // For AR, we need at least SOME meaningful field mapped (not just ignores)
  const mappedFields = Object.values(mapping).filter(v => v && v !== 'ignore' && v !== '');
  if (mappedFields.length === 0) {
    return { valid: false, status: 400, error: 'No columns mapped to any field. Map at least one column.' };
  }
  return { valid: true, rows, mapping };
}
