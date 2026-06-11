// ─────────────────────────────────────────────────────────────
// SENDWIZE — campaign-check.js v1.0
// GET  /api/campaign-check?action=list&userId=x
// POST /api/campaign-check?action=check   { userId, campaignId, vendorNames[] }
// POST /api/campaign-check?action=clear   { userId, campaignId }
// POST /api/campaign-check?action=create  { userId, campaignName, campaignType, sendDate, vendorNames[] }
//
// Campaign-level compliance check. Cross-references all vendors
// involved in a campaign against their stored risk profiles.
// Generates a campaign verdict and updates the Campaigns table.
//
// Stickiness mechanism: every campaign is a compliance check trigger.
// Users run campaigns constantly — this tool runs every time.
// ─────────────────────────────────────────────────────────────

const APP_URL  = 'https://sendwize-backend.vercel.app';
const BASE_ID  = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({
  Authorization:  `Bearer ${AT_TOKEN}`,
  'Content-Type': 'application/json',
});

function nullStrip(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  );
}

// ── CAMPAIGN VERDICT LOGIC ────────────────────────────────────
// Reads stored risk levels from Vendor_Register for each vendor.
// No AI — pure logic from stored data.
function buildCampaignVerdict(vendorRecords, campaignName) {
  const issues     = [];
  const cleared    = [];
  const notChecked = [];

  vendorRecords.forEach(function(rec) {
    const f    = rec.fields;
    const name = f.VendorName || 'Unknown vendor';

    // Not yet scanned
    if (!f.LastChecked) {
      notChecked.push({ name, reason: 'Never scanned — run the Processor Risk Scanner for this vendor first.' });
      return;
    }

    // ICO check
    if (f.ICORiskLevel === 'High') {
      issues.push({ vendor:name, regulator:'ICO', severity:'critical',
        issue: f.DPAStatus === 'Not yet' || f.DPAStatus === 'N/A'
          ? 'No signed DPA in place'
          : 'High ICO risk — review vendor profile',
        action:'Fix ICO issues before using this vendor in this campaign.' });
    } else if (f.ICORiskLevel === 'Medium') {
      issues.push({ vendor:name, regulator:'ICO', severity:'medium',
        issue:'ICO compliance gaps identified',
        action:'Review ICO issues for this vendor before campaign goes out.' });
    } else if (f.ICORiskLevel === 'Low') {
      cleared.push({ vendor:name, regulator:'ICO' });
    }

    // ASA check (only if relevant)
    if (f.ASARiskLevel && f.ASARiskLevel !== 'N/A') {
      if (f.ASARiskLevel === 'High') {
        issues.push({ vendor:name, regulator:'ASA', severity:'high',
          issue:'No written sign-off process for claims this vendor makes on your behalf',
          action:'Establish a written approval process before using their content in this campaign.' });
      } else if (f.ASARiskLevel === 'Medium') {
        issues.push({ vendor:name, regulator:'ASA', severity:'medium',
          issue:'ASA compliance gaps identified',
          action:'Review ASA issues before this campaign goes live.' });
      } else {
        cleared.push({ vendor:name, regulator:'ASA' });
      }
    }

    // CMA check (only if relevant)
    if (f.CMARiskLevel && f.CMARiskLevel !== 'N/A') {
      if (f.CMARiskLevel === 'High') {
        issues.push({ vendor:name, regulator:'CMA', severity:'critical',
          issue:'CMA compliance gaps — pricing, promotions or reviews risk',
          action:'Resolve CMA issues before campaign uses this vendor\'s output.' });
      } else if (f.CMARiskLevel === 'Medium') {
        issues.push({ vendor:name, regulator:'CMA', severity:'medium',
          issue:'CMA compliance gaps identified',
          action:'Review CMA issues for this campaign.' });
      } else {
        cleared.push({ vendor:name, regulator:'CMA' });
      }
    }

    // Stale check
    if (f.LastChecked) {
      const diffDays = (Date.now() - new Date(f.LastChecked).getTime()) / 86400000;
      if (diffDays > 90) {
        issues.push({ vendor:name, regulator:'ICO', severity:'low',
          issue:`Last scanned ${Math.round(diffDays)} days ago — compliance position may have changed`,
          action:'Re-run the Processor Risk Scanner for this vendor.' });
      }
    }
  });

  // Sort issues by severity
  const sevOrder = { critical:0, high:1, medium:2, low:3 };
  issues.sort((a,b) => (sevOrder[a.severity]||4) - (sevOrder[b.severity]||4));

  const verdict = !issues.length && !notChecked.length ? 'Cleared'
                : issues.some(i => i.severity === 'critical')  ? 'Critical issues'
                : issues.length ? 'Issues found'
                : 'Partially checked';

  const verdictColour = verdict === 'Cleared'          ? 'green'
                      : verdict === 'Critical issues'   ? 'red'
                      : 'amber';

  return { verdict, verdictColour, issues, cleared, notChecked,
    summary: `${issues.length} issue${issues.length!==1?'s':''} found across ${vendorRecords.length} vendor${vendorRecords.length!==1?'s':''}` };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    // ── LIST campaigns ────────────────────────────────────────
    if (req.method === 'GET' && action === 'list') {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const r = await fetch(
        `${AT_BASE}/Campaigns?filterByFormula={UserID}='${userId}'&sort[0][field]=SendDate&sort[0][direction]=desc&maxRecords=50`,
        { headers: atH() }
      );
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch campaigns' });
      const data = await r.json();
      return res.status(200).json({ success:true, campaigns: data.records || [] });
    }

    // ── CREATE campaign ───────────────────────────────────────
    if (req.method === 'POST' && action === 'create') {
      const { userId, campaignName, campaignType, sendDate, vendorNames } = req.body ?? {};
      if (!userId || !campaignName) return res.status(400).json({ error: 'userId and campaignName required' });

      const fields = nullStrip({
        UserID:         userId,
        CampaignName:   campaignName,
        CampaignType:   campaignType || null,
        SendDate:       sendDate     || null,
        Status:         'Planned',
        CreatedDate:    new Date().toISOString().split('T')[0],
        VendorsInvolved: vendorNames?.length ? JSON.stringify(vendorNames) : null,
        VendorCheckDone: false,
        ComplianceVerdict: 'Not Checked',
      });

      const r = await fetch(`${AT_BASE}/Campaigns`, {
        method:  'POST',
        headers: atH(),
        body:    JSON.stringify({ records: [{ fields }] }),
      });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to create campaign' });
      const data = await r.json();
      return res.status(200).json({ success:true, campaign: data.records?.[0] });
    }

    // ── CHECK campaign compliance ─────────────────────────────
    if (req.method === 'POST' && action === 'check') {
      const { userId, campaignId, vendorNames } = req.body ?? {};
      if (!userId || !campaignId) return res.status(400).json({ error: 'userId and campaignId required' });

      // Fetch campaign record
      const cr = await fetch(`${AT_BASE}/Campaigns/${campaignId}`, { headers: atH() });
      if (!cr.ok) return res.status(404).json({ error: 'Campaign not found' });
      const campaign = await cr.json();

      // Get vendor names from request or campaign record
      let names = vendorNames || [];
      if (!names.length && campaign.fields.VendorsInvolved) {
        try { names = JSON.parse(campaign.fields.VendorsInvolved); } catch(e) {}
      }
      if (!names.length) return res.status(400).json({ error: 'No vendors specified for this campaign' });

      // Fetch vendor register entries for each vendor
      const formula = `AND({UserID}='${userId}',OR(${names.map(n=>`{VendorName}='${n}'`).join(',')}))`;
      const vr = await fetch(
        `${AT_BASE}/Vendor_Register?filterByFormula=${encodeURIComponent(formula)}&maxRecords=50`,
        { headers: atH() }
      );
      if (!vr.ok) return res.status(vr.status).json({ error: 'Failed to fetch vendor register' });
      const vendorData = await vr.json();
      const vendorRecords = vendorData.records || [];

      // Build verdict
      const result = buildCampaignVerdict(vendorRecords, campaign.fields.CampaignName);

      // Update campaign record
      const today = new Date().toISOString().split('T')[0];
      await fetch(`${AT_BASE}/Campaigns/${campaignId}`, {
        method:  'PATCH',
        headers: atH(),
        body:    JSON.stringify({ fields: nullStrip({
          VendorsInvolved:   JSON.stringify(names),
          VendorCheckDone:   true,
          VendorCheckDate:   today,
          ComplianceVerdict: result.verdict,
          ComplianceNotes:   result.issues.length
            ? result.issues.map(i=>`[${i.regulator}] ${i.vendor}: ${i.issue}`).join('\n')
            : 'All vendors cleared.',
          Status: result.verdict === 'Cleared' ? 'Checks Complete' : campaign.fields.Status,
        })}),
      });

      // Generate fix records for critical/high issues
      for (const issue of result.issues.filter(i => ['critical','high'].includes(i.severity))) {
        try {
          await fetch(`${APP_URL}/api/generate-fix`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              userId,
              fixType:       'dpa_breach',
              description:   `Campaign Check (${campaign.fields.CampaignName}): ${issue.vendor} — ${issue.issue}. ${issue.action}`,
              tool:          `Campaign Check \u2014 ${campaign.fields.CampaignName}`,
              severity:      issue.severity,
              contactVolume: null,
              sourceRecordId: campaignId,
            }),
          });
        } catch(e) { console.error('generate-fix failed:', e.message); }
      }

      return res.status(200).json({ success:true, campaignId, result });
    }

    // ── CLEAR campaign ────────────────────────────────────────
    if (req.method === 'POST' && action === 'clear') {
      const { userId, campaignId } = req.body ?? {};
      if (!userId || !campaignId) return res.status(400).json({ error: 'userId and campaignId required' });

      await fetch(`${AT_BASE}/Campaigns/${campaignId}`, {
        method:  'PATCH',
        headers: atH(),
        body:    JSON.stringify({ fields: {
          ComplianceVerdict: 'Cleared',
          VendorCheckDone:   true,
          VendorCheckDate:   new Date().toISOString().split('T')[0],
          Status:            'Checks Complete',
        }}),
      });
      return res.status(200).json({ success:true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('campaign-check error:', e);
    return res.status(500).json({ error: e.message });
  }
}
