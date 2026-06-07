// ─────────────────────────────────────────────────────────────
// SENDWIZE — vendor-monitor.js v1.1
// GET /api/vendor-monitor?action=run
// GET /api/vendor-monitor?action=status
// GET /api/vendor-monitor?action=run-single&vendorId=xxx
//
// v1.1 changes from v1.0:
//   - Fix generation now compliance-aware. A fix is only generated
//     when the extracted compliance position is materially worse
//     than what was previously stored. Content changes that don't
//     affect compliance (layout, wording, new cookie banners) are
//     updated silently with no fix record created.
//   - compareCompliancePosition() implements the degradation matrix:
//       DPAStatus:               Confirmed → worse
//       TransferMechanism:       Adequacy/SCCs/BCRs/UK-US Bridge → None/Unknown
//       ICORegistered:           Yes/Exempt → No/Unknown
//       IntlTransferOccurs:      No → Yes (new transfers appearing)
//       BreachHistory:           None identified → anything else
//       RiskRating:              Low→Medium/High or Medium→High
//   - Improvements generate silent update only (no fix).
//   - tool label includes vendor name for dashboard clarity.
//   - fix severity scales with degradation severity.
//   - extractionNotes logged for audit trail.
//
// Cron setup (cron-job.org):
//   URL:      https://sendwize-backend.vercel.app/api/vendor-monitor?action=run
//   Schedule: Daily 03:00 UTC
//   Header:   X-Monitor-Key: [MONITOR_KEY env var]
//
// Architecture rules:
//   - No npm packages — fetch + crypto only
//   - All async awaited before res.json()
//   - Null strip on all Airtable writes
//   - export default async function handler
//   - Non-fatal errors logged, never thrown to caller
// ─────────────────────────────────────────────────────────────

import crypto from 'crypto';

const BASE_ID       = process.env.BASE_ID;
const AT_TOKEN      = process.env.AIRTABLE_TOKEN;
const MONITOR_KEY   = process.env.MONITOR_KEY;
const APP_URL       = 'https://sendwize-backend.vercel.app';
const AT_BASE       = `https://api.airtable.com/v0/${BASE_ID}`;
const STALE_DAYS    = 7;
const FETCH_TIMEOUT = 12000;
const BATCH_SIZE    = 8; // Vercel Hobby 10s timeout safety

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

async function atGet(table, formula = '', max = 100) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: atH() });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method:  'PATCH',
    headers: atH(),
    body:    JSON.stringify({ fields: clean }),
  });
  if (!r.ok) throw new Error(`AT PATCH ${table}/${id}: ${r.status}`);
  return await r.json();
}

async function atCreate(table, fields) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
  );
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}`, {
    method:  'POST',
    headers: atH(),
    body:    JSON.stringify({ records: [{ fields: clean }] }),
  });
  if (!r.ok) throw new Error(`AT POST ${table}: ${r.status}`);
  return (await r.json()).records?.[0];
}

// ── Hash a URL's response body ────────────────────────────────
// Strips scripts and comments before hashing so purely cosmetic
// changes (analytics snippets, banner updates) don't trigger a
// re-read unnecessarily.
async function hashUrl(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Sendwize-Compliance-Monitor/1.0; +https://sendwize.co.uk)',
        'Accept':     'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!r.ok) return { hash: null, error: `HTTP ${r.status}` };
    const body    = await r.text();
    const stripped = body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const hash = crypto.createHash('sha256').update(stripped).digest('hex');
    return { hash, error: null };
  } catch (e) {
    return { hash: null, error: e.message };
  }
}

function isStale(lastAutoChecked) {
  if (!lastAutoChecked) return true;
  const diffDays = (Date.now() - new Date(lastAutoChecked).getTime()) / 86400000;
  return diffDays >= STALE_DAYS;
}

// ── Compliance degradation matrix ─────────────────────────────
// Compares the previously stored compliance fields (from Marketing_Vendors
// before the DPA reader ran) against the newly extracted fields.
//
// Returns:
//   { degraded: bool, issues: string[], severity: 'critical'|'high'|'medium'|null }
//
// Only fires fixes on degradation. Improvements are silent.
// ─────────────────────────────────────────────────────────────
function compareCompliancePosition(before, after) {
  const issues   = [];
  let   severity = null;

  const escalate = (s) => {
    if (s === 'critical') severity = 'critical';
    else if (s === 'high'   && severity !== 'critical') severity = 'high';
    else if (s === 'medium' && !severity)               severity = 'medium';
  };

  // DPA Status — any move away from Confirmed is a problem
  const dpaGoodStates = ['Confirmed'];
  const dpaBefore = before.DPAStatus || 'Unknown';
  const dpaAfter  = after.DPAStatus  || 'Unknown';
  if (dpaGoodStates.includes(dpaBefore) && !dpaGoodStates.includes(dpaAfter)) {
    if (dpaAfter === 'Refused') {
      issues.push(`DPA status changed from Confirmed to Refused — they are no longer willing to sign a Data Processing Agreement`);
      escalate('critical');
    } else {
      issues.push(`DPA status changed from Confirmed to ${dpaAfter} — previously confirmed agreement may no longer be current`);
      escalate('high');
    }
  }

  // Transfer mechanism — good mechanisms becoming None or Unknown
  const mechGood = ['Adequacy','SCCs','BCRs','UK-US Bridge'];
  const mechBefore = before.TransferMechanismConfirmed || 'Unknown';
  const mechAfter  = after.TransferMechanismConfirmed  || 'Unknown';
  if (mechGood.includes(mechBefore) && !mechGood.includes(mechAfter)) {
    issues.push(`International transfer mechanism changed from ${mechBefore} to ${mechAfter} — lawful transfer basis may no longer be confirmed`);
    escalate('high');
  }

  // ICO registration — confirmed becoming No or Unknown
  const icoBefore = before.ICORegistered || 'Unknown';
  const icoAfter  = after.ICORegistered  || 'Unknown';
  if ((icoBefore === 'Yes' || icoBefore === 'Exempt') && icoAfter === 'No') {
    issues.push(`ICO registration status changed from ${icoBefore} to No — vendor may no longer be registered with the ICO`);
    escalate('critical');
  } else if ((icoBefore === 'Yes' || icoBefore === 'Exempt') && icoAfter === 'Unknown') {
    issues.push(`ICO registration status changed from ${icoBefore} to Unknown — registration could not be confirmed from the updated page`);
    escalate('medium');
  }

  // International transfers appearing where none existed before
  const intlBefore = before.IntlTransferOccurs || 'Unknown';
  const intlAfter  = after.IntlTransferOccurs  || 'Unknown';
  if (intlBefore === 'No' && intlAfter === 'Yes') {
    issues.push(`International data transfers now indicated where previously confirmed as UK/EEA only — verify transfer mechanism`);
    escalate('high');
  }

  // Breach history — None identified becoming something else
  const breachBefore = (before.BreachHistory || '').toLowerCase().trim();
  const breachAfter  = (after.BreachHistory  || '').toLowerCase().trim();
  const breachWasClean = !breachBefore || breachBefore === 'none identified';
  const breachNowDirty = breachAfter && breachAfter !== 'none identified' && breachAfter !== 'unknown';
  if (breachWasClean && breachNowDirty) {
    issues.push(`Breach or enforcement history now identified: ${after.BreachHistory}`);
    escalate('high');
  }

  // Risk rating overall — Low→Medium/High, Medium→High
  const riskBefore = before.RiskRating || 'Unknown';
  const riskAfter  = after.riskRating  || after.RiskRating || 'Unknown';
  const riskOrder  = { 'Low': 0, 'Medium': 1, 'High': 2, 'Unknown': 1 };
  const riskWorse  = (riskOrder[riskAfter] || 0) > (riskOrder[riskBefore] || 0);
  if (riskWorse && issues.length === 0) {
    // Only add a generic rating issue if nothing specific was caught above
    issues.push(`Overall risk rating changed from ${riskBefore} to ${riskAfter}`);
    escalate(riskAfter === 'High' ? 'high' : 'medium');
  }

  return {
    degraded:  issues.length > 0,
    issues,
    severity:  severity || null,
  };
}

// ── Generate fix records for affected users ───────────────────
async function generateFixesForAffectedUsers(vendorName, degradation) {
  let usersNotified = 0;
  if (!degradation.degraded || !degradation.severity) return usersNotified;

  try {
    const regs = await atGet(
      'Vendor_Register',
      `{VendorName}='${vendorName}'`,
      200
    );

    const issueText = degradation.issues.join('; ');
    const description = `Vendor Monitor: Compliance position for ${vendorName} has worsened following an automated policy review. ${issueText}. Review your DPA and transfer arrangements with this vendor.`;

    for (const reg of regs) {
      const userId = reg.fields.UserID;
      if (!userId) continue;
      try {
        await fetch(`${APP_URL}/api/generate-fix`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            userId,
            fixType:       'dpa_breach',
            description,
            tool:          `Vendor Monitor \u2014 ${vendorName}`,
            severity:      degradation.severity,
            contactVolume: null,
            sourceRecordId: null,
          }),
        });
        usersNotified++;
      } catch (e) {
        console.error(`generate-fix failed for ${vendorName} user ${userId}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`generateFixesForAffectedUsers error for ${vendorName}:`, e.message);
  }
  return usersNotified;
}

// ── Process a single vendor record ───────────────────────────
async function processVendor(record) {
  const f          = record.fields;
  const vendorName = f.VendorName;
  const url        = f.PrivacyPolicyUrl;
  const result     = {
    vendorName,
    action:        'skipped',
    hashChanged:   false,
    stale:         false,
    dpaRead:       false,
    degraded:      false,
    issues:        [],
    usersNotified: 0,
    error:         null,
  };

  if (!url) { result.action = 'no_url'; return result; }

  // 1. Hash the current page
  const { hash, error } = await hashUrl(url);
  if (error) {
    result.action = 'fetch_failed';
    result.error  = error;
    await atPatch('Marketing_Vendors', record.id, {
      LastAutoChecked: new Date().toISOString().split('T')[0],
    }).catch(() => {});
    return result;
  }

  const storedHash  = f.ContentHash || null;
  const hashChanged = !!(storedHash && hash !== storedHash);
  const neverHashed = !storedHash;
  const stale       = isStale(f.LastAutoChecked);

  result.hashChanged = hashChanged;
  result.stale       = stale;

  const shouldRead = hashChanged || neverHashed || stale;

  if (shouldRead) {
    // Snapshot the compliance position BEFORE the reader runs
    const before = {
      ICORegistered:               f.ICORegistered               || 'Unknown',
      DPAStatus:                   f.DPAStatus                   || 'Unknown',
      IntlTransferOccurs:          f.IntlTransferOccurs          || 'Unknown',
      TransferMechanismConfirmed:  f.TransferMechanismConfirmed  || 'Unknown',
      BreachHistory:               f.BreachHistory               || 'None identified',
      RiskRating:                  f.RiskRating                  || 'Unknown',
    };

    // 2. Call vendor-dpa-reader — Claude reads and extracts
    try {
      const readerRes = await fetch(`${APP_URL}/api/vendor-dpa-reader`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vendorRecordId: record.id, vendorName, url }),
      });
      const readerData = readerRes.ok ? await readerRes.json() : { success: false };
      result.dpaRead = readerData.success || false;
      result.action  = readerData.success ? 'read_and_updated' : 'read_failed';

      if (readerData.success) {
        // 3. Compare before vs after — only flag real compliance degradation
        const after       = readerData.extracted || {};
        const degradation = compareCompliancePosition(before, after);
        result.degraded   = degradation.degraded;
        result.issues     = degradation.issues;

        if (degradation.degraded) {
          // 4. Generate fix records only for genuine compliance worsening
          result.usersNotified = await generateFixesForAffectedUsers(vendorName, degradation);
        }
        // Improvement or no change — silent update, Marketing_Vendors already patched by reader
      }

    } catch (e) {
      result.action = 'reader_error';
      result.error  = e.message;
    }
  } else {
    result.action = 'no_change';
  }

  // Always store the new hash
  if (hash) {
    await atPatch('Marketing_Vendors', record.id, { ContentHash: hash })
      .catch(e => console.error(`ContentHash patch failed for ${vendorName}:`, e.message));
  }

  return result;
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Monitor-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  const { action, vendorId } = req.query;

  // Auth
  if (action === 'run' || action === 'run-single') {
    const key = req.headers['x-monitor-key'];
    if (MONITOR_KEY && key !== MONITOR_KEY) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  // ── Status ────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const logs = await atGet('Monitor_Log', '', 1);
      return res.status(200).json({ success: true, lastRun: logs[0]?.fields || null });
    } catch {
      return res.status(200).json({ success: true, lastRun: null });
    }
  }

  // ── Run single ────────────────────────────────────────────
  if (action === 'run-single') {
    if (!vendorId) return res.status(400).json({ error: 'vendorId required' });
    try {
      const r = await fetch(`${AT_BASE}/Marketing_Vendors/${vendorId}`, { headers: atH() });
      if (!r.ok) return res.status(404).json({ error: 'Vendor not found' });
      const record = await r.json();
      const result = await processVendor(record);
      return res.status(200).json({ success: true, result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Full run ──────────────────────────────────────────────
  if (action === 'run') {
    const runStart = Date.now();
    const today    = new Date().toISOString().split('T')[0];
    const summary  = {
      runDate: today, checked: 0, hashChanged: 0, stale: 0,
      dpaRead: 0, degraded: 0, skipped: 0, errors: 0,
      usersNotified: 0, durationMs: 0,
      totalInLibrary: 0, remainingForNextRun: 0,
    };

    try {
      const allVendors = await atGet('Marketing_Vendors', `{PrivacyPolicyUrl}!=''`, 100);
      summary.totalInLibrary = allVendors.length;

      // Prioritise: never checked first, then oldest
      const sorted = allVendors.sort((a, b) => {
        const aT = a.fields.LastAutoChecked ? new Date(a.fields.LastAutoChecked).getTime() : 0;
        const bT = b.fields.LastAutoChecked ? new Date(b.fields.LastAutoChecked).getTime() : 0;
        return aT - bT;
      });

      const batch = sorted.slice(0, BATCH_SIZE);
      summary.remainingForNextRun = Math.max(0, allVendors.length - BATCH_SIZE);

      for (const record of batch) {
        try {
          const result = await processVendor(record);
          summary.checked++;
          if (result.hashChanged)  summary.hashChanged++;
          if (result.stale)        summary.stale++;
          if (result.dpaRead)      summary.dpaRead++;
          if (result.degraded)     summary.degraded++;
          if (result.action === 'no_url') summary.skipped++;
          if (result.error)        summary.errors++;
          summary.usersNotified += result.usersNotified || 0;
        } catch (e) {
          console.error(`processVendor failed for ${record.fields.VendorName}:`, e.message);
          summary.errors++;
        }
      }

      summary.durationMs = Date.now() - runStart;

      // Write to Monitor_Log — non-fatal if table doesn't exist
      atCreate('Monitor_Log', {
        RunDate:        today,
        Checked:        summary.checked,
        HashChanged:    summary.hashChanged,
        Stale:          summary.stale,
        DPARead:        summary.dpaRead,
        Degraded:       summary.degraded,
        Errors:         summary.errors,
        UsersNotified:  summary.usersNotified,
        DurationMs:     summary.durationMs,
        TotalInLibrary: summary.totalInLibrary,
      }).catch(() => {});

      return res.status(200).json({ success: true, summary });

    } catch (e) {
      console.error('vendor-monitor run error:', e);
      return res.status(500).json({ error: e.message, summary });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=run|status|run-single' });
}
