// ─────────────────────────────────────────────────────────────
// SENDWIZE — dashboard.js v1.0
// GET /api/dashboard   (signed-in member)
//
// Every figure on the dashboard in one response, all from the shared
// exposure engine, so the numbers on screen always agree:
//   score + band + trend, open regulatory exposure (clustered) with
//   attention likelihood, ASA/CMA counts and the CMA statutory maximum,
//   risk addressed (verified vs self-attested, month / all time),
//   already lost (list damage), consent expiry, unrealised list value,
//   action items with per-fix "Why this number?" data.
//
// Replaces about ten browser calls with deliberate pauses between them.
// Briefing, campaigns and recent checks still load separately (slower,
// not needed for first paint).
// ─────────────────────────────────────────────────────────────
import { requireAuth, internalHeaders, CORS_HEADERS } from './_auth.js';

const APP_URL = 'https://sendwize-backend.vercel.app';

async function call(path, opts = {}) {
  try {
    const r = await fetch(`${APP_URL}${path}`, { ...opts, headers: internalHeaders() });
    if (!r.ok) return { _error: r.status };
    return await r.json();
  } catch (e) {
    return { _error: e.message };
  }
}

const slimFix = f => ({
  id: f.id, fixType: f.fixType, description: f.description, tool: f.tool, severity: f.severity,
  status: f.status, createdDate: f.createdDate, completedDate: f.completedDate,
  completionSource: f.completionSource, improvedOnRerun: f.improvedOnRerun,
  exposure: f.exposure ? {
    category: f.exposure.category, realisticLow: f.exposure.realisticLow, realisticHigh: f.exposure.realisticHigh,
    basis: f.exposure.basis || null, referralRisk: f.exposure.referralRisk || null,
    referralRiskLabel: f.exposure.referralRiskLabel || null,
    factorCount: (f.exposure.factors || []).length,
  } : null,
  assessed: !!f.assessment,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const u = encodeURIComponent(userId);

    // Wave 1: profile + fixes (everything else depends on them)
    const [profile, fx] = await Promise.all([
      call(`/api/profile?action=get&userId=${u}`),
      call(`/api/fixes?action=get&userId=${u}`),
    ]);
    if (fx._error) return res.status(502).json({ error: 'Could not load compliance data' });

    // Wave 2: today's score snapshot, list damage, consent expiry
    const cpl = profile?.cpl || '';
    const sector = profile?.sector || fx.sector || '';
    const [snap, hero, expiry] = await Promise.all([
      call(`/api/data?action=score-history`, { method: 'POST', body: JSON.stringify({ userId, triggerEvent: 'Dashboard Load' }) }),
      call(`/api/exposure-summary?userId=${u}&cpl=${encodeURIComponent(cpl)}&sector=${encodeURIComponent(sector)}`),
      call(`/api/data?action=consent-expiry-check`, { method: 'POST', body: JSON.stringify({ userId }) }),
    ]);

    // Wave 3: trend + list value
    const [history, listValue] = await Promise.all([
      call(`/api/data?action=score-history&userId=${u}&limit=30`),
      call(`/api/list-recommendations?userId=${u}`),
    ]);

    const pending = fx.fixes?.pending || [];
    const completed = fx.fixes?.completed || [];
    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      profile: {
        onboardingComplete: profile?.onboardingComplete ?? fx.profile?.onboardingComplete ?? null,
        revenueBand: profile?.revenueBand || null,
        revenueBandSet: !!profile?.revenueBand,
        sector: fx.sector,
      },
      score: {
        value: fx.score, band: fx.scoreBand, colour: fx.scoreColour,
        change: snap?.scoreChange ?? 0,
        trend: (history?.snapshots || []).map(s => ({ date: s.date, score: s.score })).reverse(),
        note: 'Severity-weighted share of findings fixed. Fixes verified by a re-run count in full; fixes marked by hand count 75%.',
      },
      counts: fx.counts,
      exposure: {
        totalLow: fx.exposure?.totalLow || 0,
        totalHigh: fx.exposure?.totalHigh || 0,
        clusters: fx.exposure?.clusters || [],
        likelihood: fx.exposure?.likelihood || null,
        asaPending: fx.categoryCounts?.pending?.asa || 0,
        cmaPending: fx.categoryCounts?.pending?.cma || 0,
        cmaMax: fx.exposure?.cmaMax || null,
        basis: fx.exposure?.basis || '',
        legalMax: fx.actioned?.legalMax || '',
        duaaWarning: fx.actioned?.duaaWarning || '',
      },
      riskAddressed: fx.riskAddressed || null,
      commercial: fx.commercial || null,
      alreadyLost: hero && !hero._error ? { amount: hero.lost || 0, isEstimate: !!hero.lostIsEstimate, excessUnsubs12mo: hero.excessUnsubs12mo || 0, cplUsed: hero.cplUsed || null, commercialAtRisk: hero.commercialAtRisk || 0 } : null,
      consentExpiry: expiry && !expiry._error ? { in30: expiry.expiringIn30 || 0, in60: expiry.expiringIn60 || 0, in90: expiry.expiringIn90 || 0, source: expiry.source || null } : null,
      listValue: listValue && !listValue._error ? { hasData: !!listValue.hasData, total: listValue.unrealisedTotal || 0, top: (listValue.opportunities || []).slice(0, 3), basis: listValue.basis || '' } : null,
      fixes: {
        pending: pending.map(slimFix),
        completed: completed.slice(0, 50).map(slimFix),
      },
      disclaimer: 'Illustrative risk indicators based on published ICO, ASA and CMA enforcement. Not a prediction. Not legal advice.',
    });
  } catch (e) {
    console.error('dashboard.js error:', e);
    return res.status(500).json({ error: 'Could not load dashboard' });
  }
}
