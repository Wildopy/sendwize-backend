// ─────────────────────────────────────────────────────────────
// SENDWIZE — _auth.js v1.0
// Server-side identity for every API endpoint.
//
// Who is calling, in order:
//   1. Internal server-to-server call: header x-sendwize-internal
//      matches INTERNAL_API_SECRET. Trusted; userId in the request
//      is used as sent (e.g. submit-check → generate-fix).
//   2. Vercel cron: Authorization: Bearer CRON_SECRET. Trusted.
//   3. Signed-in member: Memberstack token in the Authorization
//      header (or the _ms-mid cookie), verified with the Memberstack
//      admin package. The verified member id REPLACES any userId the
//      browser sent, so nobody can act as another user.
//   4. Dev bypass (never in production): if
//      SENDWIZE_ALLOW_USERID_BYPASS=true and VERCEL_ENV is not
//      'production', ?userId= is accepted (Memberstack Test Mode).
//
// Rollout switch: SENDWIZE_AUTH_ENFORCE=false logs unauthenticated
// calls instead of rejecting them, so you can deploy the backend,
// update each frontend, watch the logs, then remove the switch.
// Enforcement is ON by default.
//
// Env vars:
//   MEMBERSTACK_SECRET_KEY   (required)  Memberstack dashboard → Dev tools
//   MEMBERSTACK_APP_ID       (optional)  checks the token was issued for your app
//   INTERNAL_API_SECRET      (required)  long random string, shared by your endpoints
//   CRON_SECRET              (optional)  Vercel sends it to cron jobs automatically
//   SENDWIZE_AUTH_ENFORCE    (optional)  'false' during rollout only
//   SENDWIZE_ALLOW_USERID_BYPASS (optional) 'true' on preview/dev only
//   SENDWIZE_REQUIRE_PLAN    (optional)  'true' = members need an active paid plan (402 otherwise)
//   SENDWIZE_PLAN_IDS        (optional)  only these Memberstack plan ids count, comma separated
//
// npm i @memberstack/admin
// ─────────────────────────────────────────────────────────────
import { timingSafeEqual } from 'node:crypto';
import memberstackAdmin from '@memberstack/admin';

export const INTERNAL_HEADER = 'x-sendwize-internal';
export const CORS_HEADERS = 'Content-Type, Authorization';

let msClient = null;
function memberstack() {
  if (!msClient) {
    if (!process.env.MEMBERSTACK_SECRET_KEY) throw new Error('MEMBERSTACK_SECRET_KEY not set');
    msClient = memberstackAdmin.init(process.env.MEMBERSTACK_SECRET_KEY);
  }
  return msClient;
}

// Headers for calls from one Sendwize endpoint to another
export function internalHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', [INTERNAL_HEADER]: process.env.INTERNAL_API_SECRET || '', ...extra };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function verifyMemberToken(token) {
  try {
    const data = await memberstack().verifyToken({ token, audience: process.env.MEMBERSTACK_APP_ID || undefined });
    const id = data?.id || data?.sub;
    return typeof id === 'string' && id.startsWith('mem_') ? id : null;
  } catch {
    return null;
  }
}

export async function authenticate(req) {
  const headers = req.headers || {};
  const internal = headers[INTERNAL_HEADER];
  if (internal && process.env.INTERNAL_API_SECRET && safeEqual(internal, process.env.INTERNAL_API_SECRET)) {
    return { kind: 'internal' };
  }
  const authz = headers.authorization || '';
  if (process.env.CRON_SECRET && safeEqual(authz, `Bearer ${process.env.CRON_SECRET}`)) {
    return { kind: 'internal' };
  }
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : readCookie(req, '_ms-mid');
  if (token) {
    const id = await verifyMemberToken(token);
    if (id) return { kind: 'member', userId: id };
  }
  if (process.env.SENDWIZE_ALLOW_USERID_BYPASS === 'true' && process.env.VERCEL_ENV !== 'production') {
    const id = req.query?.userId || (req.body && typeof req.body === 'object' ? req.body.userId : null);
    if (id) return { kind: 'member', userId: String(id), bypass: true };
  }
  return null;
}

// ── Paid plan check ──
// On when SENDWIZE_REQUIRE_PLAN=true. A member passes if they hold an
// ACTIVE or TRIALING plan connection in Memberstack (any plan, or only
// the ids in SENDWIZE_PLAN_IDS, comma separated). Results are cached for
// 5 minutes per warm function. If Memberstack can't be reached the
// member is let through (logged), so an outage never locks out payers.
const PLAN_OK_STATUS = ['ACTIVE', 'TRIALING'];
const PLAN_CACHE_MS = 5 * 60 * 1000;
const planCache = new Map();
export async function hasPaidPlan(memberId) {
  if (process.env.SENDWIZE_REQUIRE_PLAN !== 'true') return true;
  const hit = planCache.get(memberId);
  if (hit && Date.now() - hit.at < PLAN_CACHE_MS) return hit.ok;
  try {
    const { data } = await memberstack().members.retrieve({ id: memberId });
    const allowed = (process.env.SENDWIZE_PLAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ok = (data?.planConnections || []).some(pc =>
      PLAN_OK_STATUS.includes(String(pc.status || '').toUpperCase()) &&
      (!allowed.length || allowed.includes(pc.planId)));
    planCache.set(memberId, { ok, at: Date.now() });
    return ok;
  } catch (e) {
    console.warn('[auth] plan check failed, allowing member:', e.message);
    return true;
  }
}

// Pins the verified member id onto the request so existing handlers,
// which read userId from query/body, automatically use the real one.
function pinUserId(req, userId) {
  if (req.query && typeof req.query === 'object') req.query.userId = userId;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body.userId = userId;
  } else if (req.method !== 'GET') {
    try { Object.defineProperty(req, 'body', { value: { userId }, writable: true, configurable: true, enumerable: true }); } catch {}
  }
}

// Use at the top of each router, after the OPTIONS check:
//   const auth = await requireAuth(req, res, { publicActions: ['vendors'] });
//   if (!auth) return;
export async function requireAuth(req, res, { publicActions = [], allowUnpaid = false } = {}) {
  if (publicActions.includes(req.query?.action)) return { kind: 'public' };
  const auth = await authenticate(req);
  if (auth) {
    if (auth.kind === 'member') {
      pinUserId(req, auth.userId);
      if (!allowUnpaid && !auth.bypass && !(await hasPaidPlan(auth.userId))) {
        res.status(402).json({ error: 'Your Sendwize plan is not active. Choose a plan to keep using the tools.', code: 'plan_required' });
        return null;
      }
    }
    return auth;
  }
  if (process.env.SENDWIZE_AUTH_ENFORCE === 'false') {
    console.warn(`[auth] UNVERIFIED call allowed (rollout mode): ${req.method} ${req.url}`);
    return { kind: 'unverified' };
  }
  res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'auth_required' });
  return null;
}

// For endpoints and actions only other Sendwize endpoints or cron may call
// (e.g. digest, vendor-monitor, send-alert). Members are always rejected,
// and the rollout switch does not apply.
export async function requireInternal(req, res) {
  const auth = await authenticate(req);
  if (auth && auth.kind === 'internal') return auth;
  res.status(401).json({ error: 'Not allowed', code: 'internal_only' });
  return null;
}

// Airtable record ids look like rec + 14 characters. Validating them also
// stops formula injection where ids are placed inside filterByFormula.
export function isRecordId(id) {
  return typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id);
}
