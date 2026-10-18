// api/_claude.js
// One place for every Claude API call.
//
// Every route calls claudeFetch() exactly where it used to call fetch() on
// the Messages API. This helper:
//   - pins one model for the whole product (change MODEL to switch)
//   - drops sampling settings the current model rejects (temperature etc.)
//   - sets thinking effort and leaves room in max_tokens for it
//   - optionally caches a long system prompt, and enforces a JSON schema
//   - turns a refusal into a failed response, so callers' error paths run
//   - returns the reply as a single text block, so content[0].text keeps working

export const MODEL = process.env.SENDWIZE_CLAUDE_MODEL || 'claude-sonnet-5-5';

const API_URL = 'https://api.anthropic.com/v1/messages';
const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k'];
const THINKING_ROOM = { low: 1500, medium: 4000, high: 8000 };

// Wording rules every prompt that writes customer-facing text must follow.
export const LEGAL_RULES = `WORDING RULES (apply to all text a customer will read):
- Say "potential area requiring review", "we can't find evidence of" or "the regulator expects". Never write "illegal", "unlawful", "in breach of", "violation" or "compliant"/"non-compliant" about the customer or their marketing. ("Data breach" as a factual security event is fine.)
- When reporting a regulator's published decision about another company, attribute it: "the ICO found...".
- Never state or imply legal advice. Sendwize is not a law firm.
- Never invent a fine, figure, case, date or statistic. Use only figures given to you.
- Never give an ASA £ figure (the ASA does not fine). For the CMA, quote only the statutory maximum.
- Keep commercial cost estimates separate from regulatory penalties.`;

// claudeFetch(url, init, opts) mirrors fetch(url, init) for the Messages API.
// opts.effort        'low' (default) | 'medium' | 'high'
// opts.schema        JSON schema; the reply is guaranteed to be JSON matching it
// opts.cacheSystem   true to cache the system prompt (worth it above ~1k tokens)
export async function claudeFetch(url, init = {}, opts = {}) {
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) };
  const effort = opts.effort || 'low';

  body.model = MODEL;
  for (const k of SAMPLING_KEYS) delete body[k];
  delete body.tool_choice;
  body.max_tokens = (body.max_tokens || 1024) + (THINKING_ROOM[effort] || THINKING_ROOM.low);
  body.output_config = { ...(body.output_config || {}), effort };
  if (opts.schema) body.output_config.format = { type: 'json_schema', schema: opts.schema };
  if (opts.cacheSystem && typeof body.system === 'string') {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
  }

  const r = await fetch(url || API_URL, {
    ...init,
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...(init.headers || {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let data;
  try { data = await r.json(); } catch { data = { error: { message: 'Unreadable response from Claude' } }; }

  let ok = r.ok;
  let status = r.status;
  if (ok && data.stop_reason === 'refusal') {
    ok = false; status = 422;
    data = { error: { type: 'refusal', message: 'Claude declined to answer this request', details: data.stop_details || null } };
  } else if (ok) {
    data = normalise(data);
  }
  if (!ok) console.error('Claude API', status, JSON.stringify(data).slice(0, 500));

  return {
    ok, status, headers: r.headers,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

// Thinking blocks can come first; callers only want the answer text.
function normalise(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const rest = blocks.filter(b => b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking');
  return { ...msg, content: [{ type: 'text', text }, ...rest] };
}

// Pull a JSON object or array out of a model reply, tolerating fences or preamble.
export function parseJson(text, fallback = null) {
  if (!text) return fallback;
  const s = String(text).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return fallback;
}
