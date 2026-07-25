// /api/exposure-summary.js v1.2
// Financial Hero Block: Lost / At Risk / Cleared
// Read-only. Fetch to Airtable REST only. No writes.
//
// GET  /api/exposure-summary?userId=...&cpl=...&sector=...
// POST { userId, cpl, sector }
//
// cpl + sector passed by dashboard after loading profile.js.
// If cpl absent, sector default used and lostIsEstimate=true.
//
// Financial rules (never break):
// - Tile 1 (Already Lost): ExcessUnsubs from Audience_Read_Campaigns x CPL. Commercial only.
//   commercialAtRisk = pending CommercialHigh from Compliance_Fixes - shown as sub-line, never added to lost.
// - Tile 2 (Regulatory Exposure): pending ICO fixes only, deduped, summed as £ range.
//   ASA + CMA shown as consequence COUNTS only - never a £ figure.
// - Tile 3 (Risk Cleared): ICO completed (deduped ExposureHigh) + commercial completed (ExposureHigh, no dedupe).
//   Sub-lines: ASA count cleared, CMA count cleared. No £ for ASA/CMA ever.
//   ICO figures: comparable published cases. Commercial figures: user's own data at time of fix.
// - Commercial NEVER summed with regulatory. ASA/CMA NEVER get a £ figure.

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_KEY  = process.env.AIRTABLE_API_KEY;

const AT_URL = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/';

// Sector CPL defaults (£) — used only when user has no CPL on profile
// Sector keys aligned with audience-read.js benchmark set
const SECTOR_CPL = {
  ecommerce: 8,
  b2b:       25,
  saas:      40,
  media:     15,
  finance:   55,
  health:    40,
  charity:   6,
  general:   12,
};

function num(v) {
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Dedupe ICO fix records: group by SourceRecordID || (FixType|ContactVolume).
// Keep max ExposureHigh per group to avoid double-counting one contact pool.
function dedupeICO(recs) {
  var groups = {};
  recs.forEach(function(rec) {
    var f = rec.fields || {};
    var key = f.SourceRecordID
      ? 'src:' + f.SourceRecordID
      : 'ft:' + (f.FixType || '') + '|' + (f.ContactVolume || 0);
    var existing = groups[key];
    if (!existing || num(f.ExposureHigh) > num((existing.fields || {}).ExposureHigh)) {
      groups[key] = rec;
    }
  });
  return Object.values(groups);
}

async function atFetchAll(table, formula, fields) {
  var records = [];
  var offset = null;
  do {
    var params = new URLSearchParams();
    params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    if (fields) fields.forEach(function(f) { params.append('fields[]', f); });
    if (offset) params.set('offset', offset);
    var url = AT_URL + encodeURIComponent(table) + '?' + params.toString();
    var r = await fetch(url, { headers: { Authorization: 'Bearer ' + AIRTABLE_KEY } });
    if (!r.ok) throw new Error('Airtable ' + table + ' ' + r.status);
    var d = await r.json();
    records = records.concat(d.records || []);
    offset = d.offset || null;
  } while (offset);
  return records;
}

function fmtGBP(n) {
  return '\u00a3' + (n || 0).toLocaleString('en-GB');
}

function buildHeroHtml(data) {
  var hasData = data.hasData;
  var lost = data.lost || 0;
  var lostIsEstimate = data.lostIsEstimate;
  var commercialAtRisk = data.commercialAtRisk || 0;
  var regLow = data.regLow || 0;
  var regHigh = data.regHigh || 0;
  var aL = data.asaConsequenceCount || 0;
  var cL = data.cmaConsequenceCount || 0;
  var cleared          = data.cleared          || 0;
  var clearedIco       = data.clearedIco       || 0;
  var clearedCommercial= data.clearedCommercial|| 0;
  var clearedAsaCount  = data.clearedAsaCount  || 0;
  var clearedCmaCount  = data.clearedCmaCount  || 0;

  if (!hasData) {
    return '<div class="sw-card" style="padding:16px 20px;margin-bottom:14px;display:flex;gap:12px;align-items:center">'
      + '<div style="font-size:22px">&#x1F4CA;</div>'
      + '<div><div style="font-size:13px;font-weight:600;color:var(--t)">Run your first scan to see your financial exposure</div>'
      + '<div style="font-size:11px;color:var(--mu);margin-top:2px">Scan copy or upload a list to unlock your personalised figures</div>'
      + '</div></div>';
  }

  // Tile 1 — Already Lost (red)
  var t1 = '<div class="sw-ht" style="background:#fef2f2;border:1px solid #fecaca">'
    + '<div class="sw-hl" style="color:#991b1b">Already lost</div>'
    + '<div class="sw-hn">' + (lost ? fmtGBP(lost) : '\u00a30') + '</div>'
    + '<div style="font-size:11px;color:var(--tm);margin-top:4px">List damage \u00b7 last 12 months'
    + (lostIsEstimate ? ' \u00b7 <a href="/onboarding.html" style="color:var(--o)">add your CPL for exact figure</a>' : '')
    + '</div>'
    + (commercialAtRisk ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">+' + fmtGBP(commercialAtRisk) + ' campaign spend at risk</div>' : '')
    + '</div>';

  // Tile 2 — Regulatory Exposure (amber)
  var t2 = '<div class="sw-ht" style="background:var(--w);border:1px solid #fed7aa">'
    + '<div class="sw-hl" style="color:#92400e">Regulatory exposure</div>'
    + '<div class="sw-hn">' + (regHigh ? fmtGBP(regLow) + '\u2013' + fmtGBP(regHigh) : '\u00a30') + '</div>'
    + '<div style="font-size:11px;color:var(--tm);margin-top:4px">Open ICO issues \u00b7 comparable published cases</div>'
    + (aL ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">+' + aL + ' ASA issue' + (aL !== 1 ? 's' : '') + ' requiring mandatory ad withdrawal</div>' : '')
    + (cL ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">+' + cL + ' CMA undertakings risk</div>' : '')
    + '</div>';

  // Tile 3 — Risk Cleared (green)
  // Headline: ICO + commercial combined. Sub-lines break out the sources so the figure is traceable.
  var t3 = '<div class="sw-ht" style="background:var(--gb);border:1px solid #bbf7d0">'
    + '<div class="sw-hl" style="color:var(--g)">Risk cleared</div>'
    + '<div class="sw-hn" style="color:var(--g)">' + (cleared ? fmtGBP(cleared) : '\u00a30') + '</div>'
    + (clearedIco && clearedCommercial
        ? '<div style="font-size:11px;color:var(--tm);margin-top:4px">'
          + fmtGBP(clearedIco) + ' regulatory \u00b7 ' + fmtGBP(clearedCommercial) + ' commercial'
          + '</div>'
        : '<div style="font-size:11px;color:var(--tm);margin-top:4px">'
          + (clearedIco ? 'ICO \u00b7 comparable published cases' : clearedCommercial ? 'Commercial \u00b7 your own data' : 'Exposure addressed \u00b7 all time')
          + '</div>'
      )
    + (clearedAsaCount ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">+'
        + clearedAsaCount + ' ASA issue' + (clearedAsaCount !== 1 ? 's' : '') + ' resolved</div>' : '')
    + (clearedCmaCount ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">+'
        + clearedCmaCount + ' CMA issue' + (clearedCmaCount !== 1 ? 's' : '') + ' resolved</div>' : '')
    + '</div>';

  return '<div class="sw-hero">' + t1 + t2 + t3 + '</div>';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var input = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    var userId = input.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // CPL resolution: explicit > sector default > catch-all
    var cpl = parseFloat(input.cpl) || 0;
    var lostIsEstimate = false;
    if (!cpl) {
      var sector = ((input.sector || '') + '').toLowerCase().trim();
      cpl = SECTOR_CPL[sector] || SECTOR_CPL.general;
      lostIsEstimate = true;
    }

    var uid = (userId + '').replace(/'/g, "\\'");

    // ── Fetch 1: Audience_Read_Campaigns (last 12 months) for Tile 1 ─────────
    var campaignFilter = "AND({UserID}='" + uid + "',IS_AFTER({SendDate},DATEADD(TODAY(),-12,'months')))";
    var campaignFields = ['ExcessUnsubs'];

    // ── Fetch 2: Compliance_Fixes (all statuses) for Tiles 2 + 3 ────────────
    var fixFilter = "{UserID}='" + uid + "'";
    var fixFields = [
      'Status', 'FixType', 'ExposureCategory', 'ExposureLow', 'ExposureHigh',
      'SourceRecordID', 'ContactVolume', 'CommercialHigh',
    ];

    // Both awaited together before any res.json()
    var both = await Promise.all([
      atFetchAll('Audience_Read_Campaigns', campaignFilter, campaignFields),
      atFetchAll('Compliance_Fixes', fixFilter, fixFields),
    ]);
    var campaigns = both[0];
    var allFixes  = both[1];

    // ── Tile 1: Already Lost ─────────────────────────────────────────────────
    var excessUnsubs = campaigns.reduce(function(s, r) { return s + num((r.fields || {}).ExcessUnsubs); }, 0);
    var lost = Math.round(excessUnsubs * cpl);

    // CommercialAtRisk: pending commercial fixes, sub-line only, never added to lost
    var commercialAtRisk = 0;

    // ── Tile 2: Regulatory Exposure + consequence counts ─────────────────────
    var pendingICO   = [];
    var completedICO = [];
    var asaConsequenceCount = 0;
    var cmaConsequenceCount = 0;

    var completedCommercial = [];
    var clearedAsaCount     = 0;
    var clearedCmaCount     = 0;

    allFixes.forEach(function(rec) {
      var f   = rec.fields || {};
      var cat = (f.ExposureCategory || '').toUpperCase();
      var st  = (f.Status || '').toLowerCase();

      if (cat === 'COMMERCIAL') {
        if (st === 'pending')   commercialAtRisk += num(f.CommercialHigh || f.ExposureHigh);
        // Exclude ar-commercial: same figure as Tile 1 (ExcessUnsubs × CPL), would double-count
        if (st === 'completed' && f.SourceRecordID !== 'ar-commercial') completedCommercial.push(rec);
        return;
      }
      if (cat === 'ASA') {
        if (st === 'pending')   asaConsequenceCount++;
        if (st === 'completed') clearedAsaCount++;
        return;
      }
      if (cat === 'CMA') {
        if (st === 'pending')   cmaConsequenceCount++;
        if (st === 'completed') clearedCmaCount++;
        return;
      }
      if (cat === 'ICO') {
        if (st === 'pending')   pendingICO.push(rec);
        if (st === 'completed') completedICO.push(rec);
      }
    });

    var regLow = 0, regHigh = 0;
    dedupeICO(pendingICO).forEach(function(rec) {
      var f = rec.fields || {};
      regLow  += num(f.ExposureLow);
      regHigh += num(f.ExposureHigh);
    });

    // ── Tile 3: Risk Cleared ─────────────────────────────────────────────────
    // ICO: deduped completed fixes, ExposureHigh, traceable to published cases
    // Commercial: completed fixes, ExposureHigh, user's own data at time of fix (no dedupe needed)
    var clearedIco = dedupeICO(completedICO).reduce(function(s, rec) {
      return s + num((rec.fields || {}).ExposureHigh);
    }, 0);
    var clearedCommercial = completedCommercial.reduce(function(s, rec) {
      return s + num((rec.fields || {}).ExposureHigh);
    }, 0);
    var cleared = clearedIco + clearedCommercial;

    var hasData = campaigns.length > 0 || allFixes.length > 0;

    var payload = {
      hasData:              hasData,
      lost:                 Math.round(lost),
      lostIsEstimate:       lostIsEstimate,
      excessUnsubs12mo:     Math.round(excessUnsubs),
      cplUsed:              cpl,
      commercialAtRisk:     Math.round(commercialAtRisk),
      regLow:               Math.round(regLow),
      regHigh:              Math.round(regHigh),
      asaConsequenceCount:  asaConsequenceCount,
      cmaConsequenceCount:  cmaConsequenceCount,
      cleared:              Math.round(cleared),
      clearedIco:           Math.round(clearedIco),
      clearedCommercial:    Math.round(clearedCommercial),
      clearedAsaCount:      clearedAsaCount,
      clearedCmaCount:      clearedCmaCount,
    };

    return res.status(200).json(Object.assign({}, payload, { html: buildHeroHtml(payload) }));

  } catch (e) {
    console.error('exposure-summary:', e);
    return res.status(500).json({ error: e.message });
  }
}
