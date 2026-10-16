// ─────────────────────────────────────────────────────────────
// SENDWIZE — fixes.js v7.0
// v7.0: exposure constants, ranges and the score moved to _exposure.js
//   (shared with generate-fix, exposure-summary and dashboard, so every
//   figure agrees). Each ICO range is now refined by the evidence held
//   for the fix (contact volume, data types, DPA status, how long it has
//   been open, and AI-picked factors with verified quotes when an
//   assessment exists). Score is severity-weighted; fixes verified by a
//   re-run get full credit, hand-marked ones SELF_ATTESTED_CREDIT.
//   Dismiss takes a reason: 'accepted_risk' keeps the item counting as
//   open. Response keeps every v6 field; adds exposure, riskAddressed.
// v6.10 (security): every request authenticated via _auth.js; the
//   verified member id replaces any userId from the browser. fixId
//   validated before use. CORS allows the Authorization header.
// GET  /api/fixes?action=get&userId=x[&revenueBand=...]
// POST /api/fixes?action=complete
// POST /api/fixes?action=dismiss
//

// v6.9 changes:
//   + DUAA_WARNING rewritten: notes no post-DUAA PECR fines issued yet,
//     adds specific commencement date (5 Feb 2026), frames ranges as
//     conservative floor. Previous wording was aspirational ("expected
//     to use these new powers") — new wording is factual.
//   + Case anchors added to consent_missing (HelloFresh £140k, Allay £120k),
//     invalid_consent_mechanism (HelloFresh £140k), and suppression_breach
//     (HelloFresh). All marked "Verify:" for owner confirmation.
//   + No range changes. No structural changes. Drop-in safe.
// v6.8 changes:
//   + Seven missing fix types added to EXPOSURE_CONSTANTS:
//       · unreviewed_joint_ads — ASA, joint advertising CAP Code
//       · partner_pricing_claims — CMA, DMCCA co-branded pricing
//       · affiliate_misleading_claims — ASA, brand liable for affiliate claims
//       · affiliate_ad_disclosure — ASA, influencer #ad labelling
//       · lead_gen_consent_gap — ICO, Saga-anchored lead gen consent
//       · third_party_list — ICO, purchased data, ZMLUK-anchored
//       · invalid_consent_mechanism — ICO, partner/affiliate consent gaps
//   These were already being created by data.js and audience-read.js
//   but had no exposure ranges — dashboard showed them as "unknown".
//
// v6.7 changes:
//   + Four new fix types for the Commercial Relationships Register:
//       · no_article26_agreement — ICO, joint controller breach
//       · affiliate_consent_unverified — ICO/PECR, Saga-anchored
//       · affiliate_sender_identity_breach — ICO/PECR, Reg 23
//       · partner_brand_risk — Commercial, reputational exposure
//   + Sector-proportionate exposure: all ICO fix types now apply a
//     sector multiplier derived from the user's profile Sector field.
//     Finance and health carry the highest multipliers (1.5x and 1.4x)
//     reflecting published enforcement concentration in those sectors.
//     Gambling (1.3x), b2b (0.8x), charity (0.7x), general (1.0x).
//   + SECTOR_MULTIPLIERS constant — applied in buildExposureForFix()
//     before returning ICO ranges. Revenue band applies first, sector
//     applies second, so the two are independent and composable.
//   + handleGet() now reads Sector from User_Profile and passes it
//     through to formatFix() → buildExposureForFix().
//   + revenueBand is returned alongside sector in the response root
//     so the dashboard can display both.
//
// v6.6 unchanged: improvedOnRerun, completionSource.
// v6.5 unchanged: profile piggyback in handleGet.
// v6.4 unchanged: revenueBand query-param shortcut, atFetch retry.
// v6.3 unchanged: Commercial exposure category.
// v6.2 unchanged: three-layer ICO exposure model.
//
// LEGAL POSITION:
//   Regulatory ranges = comparable published cases, not a prediction.
//   Commercial figures = estimated business cost from the user's own
//   inputs, explicitly not a regulatory fine. Nothing here is legal advice.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';
import { requireAuth, isRecordId, CORS_HEADERS } from './_auth.js';
import {
  normaliseBand, normaliseSector, getRealisticMidpoint, buildExposureForFix,
  refineExposure, evidenceHash, clusterExposure, riskAddressed, computeScore,
  attentionLikelihood, cmaStatutoryMax, DISMISS_REASONS, formatFixRecord,
  ICO_LEGAL_MAX, NOT_LEGAL_ADVICE, COMMERCIAL_DISCLAIMER, DUAA_WARNING,
} from './_exposure.js';

// ── FORMAT FIX ────────────────────────────────────────────────
// v7.0: lives in _exposure.js (formatFixRecord) so dashboard.js and
// exposure.js format fixes identically.
const formatFix = (r, revenueBand, sector) => formatFixRecord(r, revenueBand, sector);

// ── GET ───────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { userId, revenueBand: revenueBandParam } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;

  let revenueBand  = revenueBandParam ? normaliseBand(revenueBandParam) : null;
  let sector       = 'general';
  let profileFields = null;

  const fixesPromise = atFetch(
    `${base}/Compliance_Fixes?filterByFormula={UserID}='${userId}'&sort[0][field]=CreatedDate&sort[0][direction]=desc`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const profilePromise = atFetch(
    `${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );

  const [fixesRes, profileRes] = await Promise.all([fixesPromise, profilePromise]);

  if (!fixesRes.ok) {
    console.error('Compliance_Fixes fetch failed:', fixesRes.status);
    return res.status(fixesRes.status).json({ error: 'Failed to retrieve fixes' });
  }

  try {
    if (profileRes && profileRes.ok) {
      const pd  = await profileRes.json();
      const rec = pd.records?.[0] || null;
      if (rec) {
        profileFields = rec.fields;
        if (!revenueBand) revenueBand = normaliseBand(rec.fields?.RevenueBand || 'under_1m');
        sector = normaliseSector(rec.fields?.Sector || 'general');
      }
    }
  } catch(e) { console.error('Profile parse failed (non-fatal):', e); }

  if (!revenueBand) revenueBand = 'under_1m';

  const all       = (await fixesRes.json()).records || [];
  const pending   = all.filter(x => x.fields.Status === 'pending');
  const completed = all.filter(x => x.fields.Status === 'completed');
  const dismissed = all.filter(x => x.fields.Status === 'dismissed');

  const isCommercial = r => (r.fields.ExposureCategory === 'Commercial') || (['commercial_loss','segment_damaged','segment_cooling','segment_declining_engagement','partner_brand_risk','sector_risk_unreviewed'].includes((r.fields.FixType||'').toLowerCase()));
  const pendingReg   = pending.filter(r => !isCommercial(r));
  const completedReg = completed.filter(r => !isCommercial(r));
  const activeReg    = pendingReg.length + completedReg.length;

  const pendingFormatted   = pending.map(r   => formatFix(r, revenueBand, sector));
  const completedFormatted = completed.map(r => formatFix(r, revenueBand, sector));
  const dismissedFormatted = dismissed.map(r => formatFix(r, revenueBand, sector));

  // v7.0: severity-weighted score from the shared engine
  const scored = computeScore([...pendingFormatted, ...completedFormatted, ...dismissedFormatted]);
  const score  = scored.score;
  const band   = { label: scored.label, colour: scored.colour };

  // v7.0: clustered exposure and risk addressed from the shared engine
  const openExposure = clusterExposure(pendingFormatted);
  const addressed    = riskAddressed(pendingFormatted, completedFormatted);
  const actionedTotal = addressed.allTotal;

  const icoP = pendingFormatted.filter(f => f.exposure?.category === 'ICO').length;
  const asaP = pendingFormatted.filter(f => f.exposure?.category === 'ASA').length;
  const cmaP = pendingFormatted.filter(f => f.exposure?.category === 'CMA').length;
  const comP = pendingFormatted.filter(f => f.exposure?.category === 'Commercial').length;

  const pendingCommercial = pendingFormatted.filter(f => f.exposure?.category === 'Commercial');
  const commercialLow  = pendingCommercial.reduce((s, f) => s + (f.exposure?.realisticLow  || 0), 0);
  const commercialHigh = pendingCommercial.reduce((s, f) => s + (f.exposure?.realisticHigh || 0), 0);

  const now           = new Date();
  const assessedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const improvedPendingCount = pendingFormatted.filter(f => f.improvedOnRerun).length;

  const profile = {
    onboardingComplete: profileFields ? (profileFields.OnboardingComplete || false) : null,
    revenueBandRaw:     profileFields ? (profileFields.RevenueBand || null) : null,
    sector,
    currentStreak:      profileFields ? (profileFields.CurrentStreak || 0) : 0,
    profileUnavailable: profileFields === null,
  };

  return res.json({
    success:     true,
    score,
    scoreBand:   band.label,
    scoreColour: band.colour,
    revenueBand: normaliseBand(revenueBand),
    sector,
    profile,
    counts: {
      pending:   pending.length,
      completed: completed.length,
      dismissed: dismissed.length,
      active:    activeReg,
      improvedPending: improvedPendingCount,
    },
    exposure: {
      clusters:   openExposure.clusters,
      totalLow:   openExposure.totalLow,
      totalHigh:  openExposure.totalHigh,
      likelihood: attentionLikelihood(pendingFormatted, sector),
      cmaMax:     cmaStatutoryMax(revenueBand),
      basis:      'Comparable published cases, grouped the way a regulator would investigate them. Not a prediction. Not legal advice.',
    },
    riskAddressed: addressed,
    actioned: {
      total:         actionedTotal,
      monthTotal:    addressed.monthTotal,
      count:         completedReg.length,
      assessedMonth,
      disclaimer:    NOT_LEGAL_ADVICE,
      legalMax:      ICO_LEGAL_MAX,
      legalMaxLabel: 'ICO statutory maximum (DUAA 2025)',
      duaaWarning:   DUAA_WARNING,
    },
    commercial: {
      totalLow:   Math.round(commercialLow),
      totalHigh:  Math.round(commercialHigh),
      count:      pendingCommercial.length,
      basis:      'commercial',
      disclaimer: COMMERCIAL_DISCLAIMER,
    },
    categoryCounts: {
      pending:   { ico: icoP, asa: asaP, cma: cmaP, commercial: comP },
      completed: {
        ico: completedFormatted.filter(f => f.exposure?.category === 'ICO').length,
        asa: completedFormatted.filter(f => f.exposure?.category === 'ASA').length,
        cma: completedFormatted.filter(f => f.exposure?.category === 'CMA').length,
        commercial: completedFormatted.filter(f => f.exposure?.category === 'Commercial').length,
      },
    },
    fixes: {
      pending:   pendingFormatted,
      completed: completedFormatted,
      dismissed: dismissedFormatted,
    },
  });
}

// ── COMPLETE ──────────────────────────────────────────────────
async function handleComplete(req, res) {
  const { userId, fixId, completionSource } = req.body ?? {};
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });
  if (!isRecordId(fixId)) return res.status(400).json({ error: 'Invalid fixId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await atFetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });
  const fix = await gr.json();
  if (fix.fields.UserID === undefined || fix.fields.UserID !== userId) return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status === 'completed') return res.json({ success: true, message: 'Fix already marked complete' });

  const ALLOWED_SOURCES = new Set(['manual', 'improved_on_rerun']);
  const source = ALLOWED_SOURCES.has(completionSource) ? completionSource : 'manual';

  const ur = await atFetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({
      fields: {
        Status: 'completed',
        CompletedDate: new Date().toISOString().split('T')[0],
        CompletionSource: source,
      },
    }),
  });
  if (!ur.ok) return res.status(ur.status).json({ error: 'Failed to complete fix' });

  let revenueBand = 'under_1m', sector = 'general';
  try {
    const pr = await atFetch(`${base}/User_Profile?filterByFormula={UserID}='${userId}'&maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (pr.ok) {
      const pd = await pr.json();
      const rec = pd.records?.[0];
      if (rec) {
        revenueBand = normaliseBand(rec.fields?.RevenueBand || 'under_1m');
        sector      = normaliseSector(rec.fields?.Sector || 'general');
      }
    }
  } catch(e) {}

  const fixType = (fix.fields.FixType || '').toLowerCase();
  const midpoint = getRealisticMidpoint(fixType, revenueBand, sector);

  return res.json({
    success: true, fixId, fixType, completionSource: source, midpoint,
    disclaimer: NOT_LEGAL_ADVICE,
    message: 'Fix marked as complete.',
  });
}

// ── DISMISS ───────────────────────────────────────────────────
async function handleDismiss(req, res) {
  const { userId, fixId, reason } = req.body ?? {};
  // v7.0: why it was dismissed. 'accepted_risk' keeps counting as open.
  const dismissReason = DISMISS_REASONS.includes(reason) ? reason : null;
  if (!userId || !fixId) return res.status(400).json({ error: 'userId and fixId are required' });
  if (!isRecordId(fixId)) return res.status(400).json({ error: 'Invalid fixId' });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID        = process.env.BASE_ID;
  const base           = `https://api.airtable.com/v0/${BASE_ID}`;
  const authH          = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  const gr = await atFetch(`${base}/Compliance_Fixes/${fixId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!gr.ok) return res.status(404).json({ error: 'Fix not found' });
  const fix = await gr.json();
  if (fix.fields.UserID !== userId)      return res.status(403).json({ error: 'Fix does not belong to this user' });
  if (fix.fields.Status === 'dismissed') return res.json({ success: true, message: 'Fix already dismissed' });

  const patch = fields => atFetch(`${base}/Compliance_Fixes/${fixId}`, {
    method: 'PATCH', headers: authH,
    body: JSON.stringify({ fields }),
  });
  let ur = await patch(dismissReason ? { Status: 'dismissed', DismissReason: dismissReason } : { Status: 'dismissed' });
  // DismissReason field not added in Airtable yet: dismiss without it
  if (!ur.ok && ur.status === 422 && dismissReason) ur = await patch({ Status: 'dismissed' });
  if (!ur.ok) return res.status(ur.status).json({ error: 'Failed to dismiss fix' });
  return res.json({ success: true, fixId, dismissReason, message: 'Fix dismissed.' });
}

// ── ROUTER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    // Identity: the verified member id replaces any userId sent by the browser
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (req.method === 'GET'  && action === 'get')      return await handleGet(req, res);
    if (req.method === 'POST' && action === 'complete')  return await handleComplete(req, res);
    if (req.method === 'POST' && action === 'dismiss')   return await handleDismiss(req, res);
    return res.status(400).json({ error: 'Unknown action. Use ?action=get|complete|dismiss' });
  } catch (error) {
    console.error('fixes.js error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
