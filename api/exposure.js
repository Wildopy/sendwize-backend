// ─────────────────────────────────────────────────────────────
// SENDWIZE — exposure.js v1.2
// "Why this number?" and AI exposure assessments.
// v1.2: action=draft writes the ready-to-use fix for one finding (the
//   steps plus text to paste: rewritten copy, consent wording, an email
//   to a vendor). Cached on the fix in FixDraft (long text) when that
//   field exists; works without it.
// v1.1: the profile's turnover, list size, opt-in records and history
//   sharpen the figure (see _exposure.js). Claude may also quote the
//   audience size from the finding. New action=inputs saves a campaign's
//   budget and expected revenue for the ASA/CMA commercial cost.
//
// GET  /api/exposure?action=explain&fixId=rec…     member: full explanation of one figure
// POST /api/exposure?action=assess  { fixId }       member: Claude reads the evidence for one fix
// POST /api/exposure?action=inputs { fixId, campaignBudget, campaignRevenue }
//                                                   member: campaign figures for an ASA/CMA finding
// POST /api/exposure?action=draft { fixId, fresh } member: ready-to-use fix for one finding
// GET  /api/exposure?action=assess-pending          cron/internal: assess open ICO fixes in bulk
//
// Claude never writes a number. It may only pick factors from the fixed
// AI menu in _exposure.js, each with a quote from the finding's own
// evidence. validateAssessment() drops any factor whose quote isn't in
// the evidence. The result is cached on the fix (AssessmentJson +
// EvidenceHash) and reused until the evidence changes, so the same
// evidence always gives the same figure.
//
// Airtable (Compliance_Fixes): AssessmentJson (long text),
// EvidenceHash (single line text), CommercialInputs (long text).
// User_Profile: TypicalCampaignBudget, TypicalCampaignRevenue (number),
// set from the last campaign entered. See the review doc.
// ─────────────────────────────────────────────────────────────
import { claudeFetch, parseJson, MODEL, LEGAL_RULES } from './_claude.js';
import { atFetch, fq } from './_airtable.js';
import { requireAuth, isRecordId, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import {
  formatFixRecord, evidenceText, evidenceHash, validateAssessment, reductionTips,
  profileContext, COMMERCIAL_ASSUMPTIONS, FACTORS, AI_FACTOR_IDS, closestCases, ENGINE_VERSION,
  ICO_LEGAL_MAX, NOT_LEGAL_ADVICE, DUAA_WARNING,
} from './_exposure.js';

const BULK_MAX = 12;

const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const atH  = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });

async function loadProfile(userId) {
  const r = await atFetch(`${base()}/User_Profile?filterByFormula=${encodeURIComponent(`{UserID}=${fq(userId)}`)}&maxRecords=1`, { headers: atH() });
  const rec = r.ok ? ((await r.json()).records?.[0] || null) : null;
  return { ...profileContext(rec?.fields || {}), profileId: rec?.id || null };
}
// Band and sector only: what the AI evidence and its hash are built from
const bandSector = p => ({ revenueBand: p.revenueBand, sector: p.sector });

async function loadFix(fixId) {
  const r = await atFetch(`${base()}/Compliance_Fixes/${fixId}`, { headers: atH() });
  return r.ok ? r.json() : null;
}

// ── Claude: pick factors from the menu, quoting the evidence ──
async function askClaude(fix, profile) {
  const text = evidenceText(fix, bandSector(profile));
  const cases = closestCases(fix.fixType, fix.contactVolume);
  const menu = AI_FACTOR_IDS.map(id => `- ${id}: ${FACTORS[id].label}`).join('\n');
  const schema = {
    type: 'object',
    properties: {
      factors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: AI_FACTOR_IDS },
            quote: { type: 'string', description: 'Exact words copied from the evidence that show this factor applies.' },
          },
          required: ['id', 'quote'],
          additionalProperties: false,
        },
      },
      audience_count: { type: 'integer', description: 'Number of people or messages the evidence says were affected. 0 if the evidence does not state a number.' },
      audience_quote: { type: 'string', description: 'Exact words from the evidence that state that number, or an empty string.' },
      plain_english: { type: 'string', description: 'Two sentences for a marketing manager on why this matters. No legal conclusions.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['factors', 'audience_count', 'audience_quote', 'plain_english', 'confidence'],
    additionalProperties: false,
  };
  const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      max_tokens: 700,
      system: `You assess UK marketing compliance evidence for a regulatory exposure model. Only select a factor when the evidence text plainly shows it, and copy the exact words that show it into "quote". If the evidence states how many people or messages were affected, give that number in "audience_count" and the exact words in "audience_quote". Never infer facts that are not written. If nothing applies, return an empty factors list. "plain_english" is two sentences for a marketing manager on why this matters.\n\n${LEGAL_RULES}`,
      messages: [{ role: 'user', content: `Factor menu:\n${menu}\n\nComparable published cases (for context only):\n${cases.map(c => `- ${c.name} (${c.date}, £${c.penalty.toLocaleString('en-GB')}): ${c.summary}`).join('\n') || '- none on file for this finding type'}\n\nEvidence:\n<<<\n${text}\n>>>` }],
    }),
  }, { effort: 'low', schema });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const data = await r.json();
  const answer = parseJson(data.content?.[0]?.text, {});
  const validated = validateAssessment(answer || {}, text);
  return { ...validated, assessedAt: new Date().toISOString(), model: MODEL, engine: ENGINE_VERSION };
}

async function assessAndStore(rec, profile) {
  const fix = formatFixRecord(rec, profile.revenueBand, profile.sector, profile.inputs);
  if (fix.exposure?.category !== 'ICO') return { fixId: rec.id, skipped: 'not an ICO finding' };
  const assessment = await askClaude(fix, profile);
  const hash = evidenceHash(fix, bandSector(profile));
  const r = await atFetch(`${base()}/Compliance_Fixes/${rec.id}`, {
    method: 'PATCH', headers: atH(),
    body: JSON.stringify({ fields: { AssessmentJson: JSON.stringify(assessment), EvidenceHash: hash } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(r.status === 422 ? 'Add the AssessmentJson and EvidenceHash fields to Compliance_Fixes in Airtable' : `Airtable ${r.status} ${t.slice(0, 120)}`);
  }
  return { fixId: rec.id, factors: assessment.factors.length };
}

// ── Claude: the ready-to-use fix for one finding ──
async function draftFix(fix, profile) {
  const schema = {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One sentence: what to change.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Two to five short steps, in order, each one sentence.' },
      paste_label: { type: 'string', description: 'What the paste text is, e.g. "Replacement subject line", "Sign-up form wording", "Email to your vendor".' },
      paste_text: { type: 'string', description: 'Ready-to-use text the member can copy straight into their email, form, page or message. Plain text, no markdown.' },
    },
    required: ['headline', 'steps', 'paste_label', 'paste_text'],
    additionalProperties: false,
  };
  const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(40000),
    body: JSON.stringify({
      max_tokens: 900,
      system: `You help a UK SME marketing team close one finding from a compliance check. Write the practical fix: a one-line headline, two to five short steps, and one piece of ready-to-use text they can paste (rewritten copy, consent wording for a sign-up form, a suppression note, or an email asking a vendor for a data processing agreement, whichever fits). Base it only on the finding below. Where you need a detail you don't have (a brand name, a date, a price), leave a clear placeholder in [square brackets]. Plain British English, no jargon.\n\n${LEGAL_RULES}`,
      messages: [{ role: 'user', content: `Finding type: ${fix.fixType}\nRegulator area: ${fix.exposure?.category || 'unknown'}\nFound by: ${fix.tool || 'a Sendwize check'}\nSeverity: ${fix.severity || 'unknown'}\nSector: ${profile.sector || 'not given'}\n\nFinding:\n<<<\n${String(fix.description || '').slice(0, 3000)}\n>>>` }],
    }),
  }, { effort: 'low', schema });
  if (!r.ok) throw new Error(r.status === 422 ? 'Could not draft a fix for this finding' : `Claude ${r.status}`);
  const a = parseJson((await r.json()).content?.[0]?.text, null);
  if (!a || !a.paste_text) throw new Error('Could not draft a fix for this finding');
  return {
    headline: String(a.headline || '').slice(0, 300),
    steps: (Array.isArray(a.steps) ? a.steps : []).slice(0, 5).map(x => String(x).slice(0, 300)),
    pasteLabel: String(a.paste_label || 'Ready to paste').slice(0, 80),
    pasteText: String(a.paste_text).slice(0, 4000),
    draftedAt: new Date().toISOString(),
  };
}

function explain(rec, profile) {
  const fix = formatFixRecord(rec, profile.revenueBand, profile.sector, profile.inputs);
  const e = fix.exposure || {};
  return {
    success: true,
    fix: { id: fix.id, fixType: fix.fixType, description: fix.description, tool: fix.tool, severity: fix.severity, status: fix.status, createdDate: fix.createdDate },
    exposure: e,
    assessment: fix.assessment,
    assessmentStale: fix.assessmentStale,
    canAssess: e.category === 'ICO',
    tips: e.category === 'ICO' ? reductionTips(e) : [],
    campaignInputs: fix.campaignInputs || null,
    assumptions: e.marketingCost ? COMMERCIAL_ASSUMPTIONS : null,
    profile: { revenueBand: profile.revenueBand, sector: profile.sector, inputs: profile.inputs },
    legalMax: ICO_LEGAL_MAX,
    duaaWarning: DUAA_WARNING,
    disclaimer: NOT_LEGAL_ADVICE,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    if (action === 'assess-pending') {
      if (auth.kind !== 'internal') return res.status(403).json({ error: 'Not allowed' });
      const formula = `AND({Status}='pending',{ExposureCategory}='ICO',OR({EvidenceHash}='',{AssessmentJson}=''))`;
      const r = await atFetch(`${base()}/Compliance_Fixes?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${BULK_MAX}`, { headers: atH() });
      if (!r.ok) return res.status(r.status).json({ error: r.status === 422 ? 'Add the AssessmentJson and EvidenceHash fields to Compliance_Fixes in Airtable' : 'Airtable error' });
      const recs = (await r.json()).records || [];
      const profiles = {}; const results = [];
      const started = Date.now();
      // Four at a time, and no new batch after 30s, so the run fits the 60s limit.
      for (let i = 0; i < recs.length && Date.now() - started < 30000; i += 4) {
        results.push(...await Promise.all(recs.slice(i, i + 4).map(async rec => {
          try {
            const uid = rec.fields.UserID;
            profiles[uid] = profiles[uid] || loadProfile(uid);
            return await assessAndStore(rec, await profiles[uid]);
          } catch (e) { return { fixId: rec.id, error: e.message }; }
        })));
      }
      return res.json({ success: true, processed: results.length, results });
    }

    const userId = req.query.userId || req.body?.userId;
    const fixId  = req.query.fixId  || req.body?.fixId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!isRecordId(fixId)) return res.status(400).json({ error: 'Valid fixId required' });
    const rec = await loadFix(fixId);
    if (!rec || rec.fields?.UserID !== userId) return res.status(404).json({ error: 'Fix not found' });
    const profile = await loadProfile(userId);

    if (req.method === 'GET' && action === 'explain') return res.json(explain(rec, profile));

    if (req.method === 'POST' && action === 'inputs') {
      const money = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1e9 ? Math.round(n) : NaN; };
      const campaignBudget = money(req.body?.campaignBudget), campaignRevenue = money(req.body?.campaignRevenue);
      if (Number.isNaN(campaignBudget) || Number.isNaN(campaignRevenue)) return res.status(400).json({ error: 'Enter amounts in pounds, above zero' });
      if (!campaignBudget && !campaignRevenue) return res.status(400).json({ error: 'Enter a budget or expected revenue' });
      const fx = formatFixRecord(rec, profile.revenueBand, profile.sector, profile.inputs);
      if (!fx.exposure?.marketingCost) return res.status(400).json({ error: 'Campaign figures apply to ASA and CMA findings only' });
      const values = Object.fromEntries(Object.entries({ campaignBudget, campaignRevenue }).filter(([, v]) => v));
      const pr = await atFetch(`${base()}/Compliance_Fixes/${fixId}`, {
        method: 'PATCH', headers: atH(),
        body: JSON.stringify({ fields: { CommercialInputs: JSON.stringify({ ...(fx.campaignInputs || {}), ...values, savedAt: new Date().toISOString() }) } }),
      });
      if (!pr.ok) return res.status(pr.status === 422 ? 422 : 502).json({ error: pr.status === 422 ? 'Add the CommercialInputs field to Compliance_Fixes in Airtable' : 'Could not save' });
      // Pre-fill the next campaign. Best effort: the profile fields may not exist yet.
      if (profile.profileId) {
        await atFetch(`${base()}/User_Profile/${profile.profileId}`, {
          method: 'PATCH', headers: atH(),
          body: JSON.stringify({ fields: { ...(campaignBudget ? { TypicalCampaignBudget: campaignBudget } : {}), ...(campaignRevenue ? { TypicalCampaignRevenue: campaignRevenue } : {}) } }),
        }).catch(() => null);
      }
      const [fresh, freshProfile] = await Promise.all([loadFix(fixId), loadProfile(userId)]);
      return res.json(explain(fresh || rec, freshProfile));
    }

    if (req.method === 'POST' && action === 'assess') {
      if (!(await checkLimit(req, res, auth, 'exposure'))) return;
      const out = await assessAndStore(rec, profile);
      if (out.skipped) return res.json({ ...explain(rec, profile), note: 'AI assessment applies to ICO findings only.' });
      const fresh = await loadFix(fixId);
      return res.json(explain(fresh || rec, profile));
    }

    if (req.method === 'POST' && action === 'draft') {
      const cached = (() => { try { return JSON.parse(rec.fields.FixDraft || 'null'); } catch { return null; } })();
      if (cached && cached.pasteText && !req.body?.fresh) return res.json({ success: true, draft: cached, cached: true, disclaimer: NOT_LEGAL_ADVICE });
      if (!(await checkLimit(req, res, auth, 'fix_draft'))) return;
      const fix = formatFixRecord(rec, profile.revenueBand, profile.sector, profile.inputs);
      const draft = await draftFix(fix, profile);
      // Best effort: the FixDraft field may not exist yet
      await atFetch(`${base()}/Compliance_Fixes/${fixId}`, {
        method: 'PATCH', headers: atH(),
        body: JSON.stringify({ fields: { FixDraft: JSON.stringify(draft) } }),
      }).catch(() => null);
      return res.json({ success: true, draft, cached: false, disclaimer: NOT_LEGAL_ADVICE });
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=explain|assess|inputs|draft|assess-pending' });
  } catch (e) {
    console.error('exposure.js error:', e);
    return res.status(500).json({ error: e.message || 'Exposure error' });
  }
}
