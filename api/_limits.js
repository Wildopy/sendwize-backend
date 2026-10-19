// ─────────────────────────────────────────────────────────────
// SENDWIZE — _limits.js v1.0
// Per-member daily caps on the tools that call Claude, so one account
// (or a stolen token) can't run up the Anthropic bill.
//
// Storage: Upstash Redis over its REST API (Vercel → Storage →
// Upstash for Redis). Env vars, added automatically by the integration:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Without them the limiter is OFF and logs once per cold start, so
// deploying this file never breaks a tool.
//
// Internal and cron callers are never limited. Limits reset at
// midnight UTC.
//
// Override any cap with an env var, e.g. SENDWIZE_LIMIT_COPY_SCAN=100.
// ─────────────────────────────────────────────────────────────

const DEFAULT_LIMITS = {
  copy_scan:      60,  // AI Scanner, Campaign Defence copy checks
  vendor_check:   30,  // check-vendors, vendor intelligence
  dpa_scan:       20,  // DPA reader (URL or PDF)
  site_sweep:     10,  // full site sweeps
  campaign_build: 30,  // Campaign Defence assemble / page scans
  list_upload:    20,  // List Intelligence / Audience Read uploads
  reconsent:      30,  // re-consent drafts
  verdict:        40,  // Send-day verdict
  exposure:       20,  // AI exposure assessments requested by a member
  fix_draft:      40,  // ready-to-use fixes on the dashboard
};

let warned = false;

function limitFor(bucket) {
  const env = process.env[`SENDWIZE_LIMIT_${bucket.toUpperCase()}`];
  const n = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : (DEFAULT_LIMITS[bucket] || 50);
}

async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  return (await r.json()).result;
}

// Returns true if the call may go ahead. Otherwise sends a 429 and
// returns false. Fails open if Redis is unreachable (logged).
export async function checkLimit(req, res, auth, bucket) {
  if (!auth || auth.kind !== 'member') return true;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (!warned) { console.warn('[limits] Upstash not configured — usage limits are OFF'); warned = true; }
    return true;
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `sw:limit:${bucket}:${auth.userId}:${day}`;
  try {
    const count = await redis(['INCR', key]);
    if (count === 1) await redis(['EXPIRE', key, 60 * 60 * 26]);
    const max = limitFor(bucket);
    if (count > max) {
      res.status(429).json({
        error: `You've reached today's limit for this tool (${max}). It resets at midnight UTC. Contact support if you need more.`,
        code: 'daily_limit', bucket, limit: max,
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[limits] check failed, allowing call:', e.message);
    return true;
  }
}
