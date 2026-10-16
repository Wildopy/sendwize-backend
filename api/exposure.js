// ─────────────────────────────────────────────────────────────
// SENDWIZE — exposure.js v1.0
// "Why this number?" and AI exposure assessments.
//
// GET  /api/exposure?action=explain&fixId=rec…     member: full explanation of one figure
// POST /api/exposure?action=assess  { fixId }       member: Claude reads the evidence for one fix
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
// EvidenceHash (single line text). See the review doc.
// ─────────────────────────────────────────────────────────────
import { atFetch, fq } from './_airtable.js';
import { requireAuth, isRecordId, CORS_HEADERS } from './_auth.js';
import { checkLimit } from './_limits.js';
import {
  formatFixRecord, evidenceText, evidenceHash, validateAssessment, reductionTips,
  normaliseBand, normaliseSector, FACTORS, AI_FACTOR_IDS, closestCases, ENGINE_VERSION,
  ICO_LEGAL_MAX, NOT_LEGAL_ADVICE, DUAA_WARNING,
} from './_exposure.js';

const MODEL = 'claude-sonnet-4-6';
const BULK_MAX = 12;

const base = () => `https://api.airtable.com/v0/${process.env.BASE_ID}`;
const atH  = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' });

async function loadProfile(userId) {
  const r = await atFetch(`${base()}/User_Profile?filterByFormula=${encodeURIComponent(`{UserID}=${fq(userId)}`)}&maxRecords=1`, { headers: atH() });
  const f = r.ok ? ((await r.json()).records?.[0]?.fields || {}) : {};
  return { revenueBand: normaliseBand(f.RevenueBand || 'under_1m'), sector: normaliseSector(f.Sector || 'general') };
}

async function loadFix(fixId) {
  const r = await atFetch(`${base()}/Compliance_Fixes/${fixId}`, { headers: atH() });
  return r.ok ? r.json() : null;
}

// ── Claude: pick factors from the menu, quoting the evidence ──
async function askClaude(fix, profile) {
  const text = evidenceText(fix, profile);
  const cases = closestCases(fix.fixType, fix.contactVolume);
  const menu = AI_FACTOR_IDS.map(id => `- ${id}: ${FACTORS[id].label}`).join('\n');
  const tool = {
    name: 'record_assessment',
    description: 'Record which factors from the menu the evidence supports.',
    input_schema: {
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
          },
        },
        plain_english: { type: 'string', description: 'Two sentences for a marketing manager on why this matters. No legal conclusions.' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['factors', 'plain_english', 'confidence'],
    },
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: MODEL, max_tokens: 700, temperature: 0,
      tools: [tool], tool_choice: { type: 'tool', name: 'record_assessment' },
      system: 'You assess UK marketing compliance evidence for a regulatory exposure model. Only select a factor when the evidence text plainly shows it, and copy the exact words that show it. Never infer facts that are not written. If nothing applies, return an empty factors list. Never say "illegal", "unlawful", "in breach" or "compliant"; use "potential area requiring review". Not legal advice.',
      messages: [{ role: 'user', content: `Factor menu:\n${menu}\n\nComparable published cases (for context only):\n${cases.map(c => `- ${c.name} (${c.date}, £${c.penalty.toLocaleString('en-GB')}): ${c.summary}`).join('\n') || '- none on file for this finding type'}\n\nEvidence:\n<<<\n${text}\n>>>` }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const data = await r.json();
  const call = (data.content || []).find(c => c.type === 'tool_use');
  const validated = validateAssessment(call?.input || {}, text);
  return { ...validated, assessedAt: new Date().toISOString(), model: MODEL, engine: ENGINE_VERSION };
}

async function assessAndStore(rec, profile) {
  const fix = formatFixRecord(rec, profile.revenueBand, profile.sector);
  if (fix.exposure?.category !== 'ICO') return { fixId: rec.id, skipped: 'not an ICO finding' };
  const assessment = await askClaude(fix, profile);
  const hash = evidenceHash(fix, profile);
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

function explain(rec, profile) {
  const fix = formatFixRecord(rec, profile.revenueBand, profile.sector);
  const e = fix.exposure || {};
  return {
    success: true,
    fix: { id: fix.id, fixType: fix.fixType, description: fix.description, tool: fix.tool, severity: fix.severity, status: fix.status, createdDate: fix.createdDate },
    exposure: e,
    assessment: fix.assessment,
    assessmentStale: fix.assessmentStale,
    canAssess: e.category === 'ICO',
    tips: e.category === 'ICO' ? reductionTips(e) : [],
    profile,
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
      for (const rec of recs) {
        try {
          const uid = rec.fields.UserID;
          profiles[uid] = profiles[uid] || await loadProfile(uid);
          results.push(await assessAndStore(rec, profiles[uid]));
        } catch (e) { results.push({ fixId: rec.id, error: e.message }); }
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

    if (req.method === 'POST' && action === 'assess') {
      if (!(await checkLimit(req, res, auth, 'exposure'))) return;
      const out = await assessAndStore(rec, profile);
      if (out.skipped) return res.json({ ...explain(rec, profile), note: 'AI assessment applies to ICO findings only.' });
      const fresh = await loadFix(fixId);
      return res.json(explain(fresh || rec, profile));
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=explain|assess|assess-pending' });
  } catch (e) {
    console.error('exposure.js error:', e);
    return res.status(500).json({ error: e.message || 'Exposure error' });
  }
}
