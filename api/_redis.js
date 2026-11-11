// ─────────────────────────────────────────────────────────────
// SENDWIZE — _redis.js v1.0
// Small Upstash Redis REST helper (same store as _limits.js).
// Env vars, added by the Vercel → Upstash integration:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// ─────────────────────────────────────────────────────────────

export function redisConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function headers() {
  return { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' };
}

// One command, e.g. ['GET', 'key']. Returns the result.
export async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, { method: 'POST', headers: headers(), body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Upstash: ${j.error}`);
  return j.result;
}

// Many commands in one round trip. Returns an array of results (null
// where a command failed).
export async function redisPipeline(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '')}/pipeline`, { method: 'POST', headers: headers(), body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error(`Upstash pipeline ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map(x => (x && !x.error ? x.result : null));
}

// HGETALL comes back as a flat [k, v, k, v] list over REST
export function hashFromList(list) {
  const out = {};
  if (Array.isArray(list)) for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = Number(list[i + 1]) || 0;
  else if (list && typeof list === 'object') for (const [k, v] of Object.entries(list)) out[k] = Number(v) || 0;
  return out;
}
