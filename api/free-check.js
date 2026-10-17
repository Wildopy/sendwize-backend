// ─────────────────────────────────────────────────────────────
// SENDWIZE — free-check.js
// Public, no-login copy check for the marketing site. Visitors paste an
// email, SMS or social post and get Go / Fix first / Hold with the top
// two items. The full list and the rewrite need an account.
//
// Off unless SENDWIZE_FREE_CHECK=true. Needs Upstash (see _limits.js),
// because without it the caps below can't be enforced.
// Caps per UTC day: SENDWIZE_FREE_CHECK_PER_IP (default 3) per visitor,
// SENDWIZE_FREE_CHECK_DAILY (default 200) in total.
// The copy is never stored. When the daily total is used up, an email
// goes to SENDWIZE_ALERT_EMAIL (sent with Resend, like the digest).
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { claudeFetch, parseJson } from './_claude.js';
import { SYSTEM_PROMPT, ANALYSIS_SCHEMA, CHANNEL_RULES } from './analyze-copy.js';

const CHANNELS = ['email', 'sms', 'social'];
const MAX_COPY = 6000;
const PREVIEW = 2;

function cap(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

async function bump(key) {
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, 60 * 60 * 26]);
  return n;
}

function visitor(req) {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update(`${process.env.SENDWIZE_FREE_CHECK_SALT || 'sendwize'}|${ip}`).digest('hex').slice(0, 24);
}

// One email per day, the first time the daily total runs out.
async function alertOwner(daily) {
  const to = process.env.SENDWIZE_ALERT_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) return console.warn('[free-check] daily cap reached; no alert email configured');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'alerts@sendwize.co.uk', to: [to],
        subject: `Free check: all ${daily} checks used today`,
        html: `<p>All ${daily} free checks for today have been used. Visitors now see "busy today" and a sign-up link until midnight UTC.</p><p>If that looks like real demand, raise SENDWIZE_FREE_CHECK_DAILY in Vercel. If it looks like one person, it stops itself at the cap, and the cap is the most it can cost you in a day.</p>`,
      }),
    });
  } catch (e) { console.error('[free-check] alert email failed:', e.message); }
}

const sev = s => String(s || '').toLowerCase();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.SENDWIZE_FREE_CHECK !== 'true' || !process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'The free check is not available right now.', code: 'free_check_off' });
  }

  const { copy, subject, channel } = req.body ?? {};
  const ch = CHANNELS.includes(channel) ? channel : 'email';
  const text = typeof copy === 'string' ? copy.trim() : '';
  if (text.length < 20) return res.status(400).json({ error: 'Paste the full message, at least a sentence or two.' });
  if (text.length > MAX_COPY) return res.status(400).json({ error: `Keep it under ${MAX_COPY.toLocaleString('en-GB')} characters for the free check.` });

  const day = new Date().toISOString().slice(0, 10);
  try {
    if (await bump(`sw:free:ip:${visitor(req)}:${day}`) > cap('SENDWIZE_FREE_CHECK_PER_IP', 3)) {
      return res.status(429).json({ error: "You've used today's free checks. Create an account to keep checking.", code: 'visitor_limit' });
    }
    const total = await bump(`sw:free:all:${day}`);
    const daily = cap('SENDWIZE_FREE_CHECK_DAILY', 200);
    if (total === daily + 1) await alertOwner(daily);
    if (total > daily) {
      return res.status(429).json({ error: 'The free check is busy today. Create an account to check now, or try again tomorrow.', code: 'daily_limit' });
    }
  } catch (e) {
    console.error('[free-check] limiter unavailable:', e.message);
    return res.status(503).json({ error: 'The free check is not available right now.', code: 'limiter_down' });
  }

  const sub = ch === 'email' && typeof subject === 'string' ? subject.trim().slice(0, 300) : '';
  const copyText = sub ? `Subject: ${sub}\n\nEmail body:\n${text}` : text;

  try {
    const r = await claudeFetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(50000),
      body: JSON.stringify({
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${CHANNEL_RULES[ch]}\n\nCONTENT TO ANALYSE:\n${copyText}\n\nDo not include a fixedVersion.` }],
      }),
    }, { effort: 'medium', schema: ANALYSIS_SCHEMA, cacheSystem: true });
    if (!r.ok) return res.status(502).json({ error: 'The check could not run. Please try again.' });

    const a = parseJson((await r.json()).content?.[0]?.text);
    if (!a || !Array.isArray(a.violations)) return res.status(502).json({ error: 'The check could not run. Please try again.' });

    const items = a.violations.map(v => ({ severity: sev(v.severity), regulation: v.regulation || '', issue: v.issue || '' }));
    const hold = items.filter(i => i.severity === 'critical');
    const fix = items.filter(i => i.severity === 'high' || i.severity === 'medium');
    const verdict = hold.length ? 'hold' : fix.length ? 'fix_first' : 'go';
    const shown = [...hold, ...fix].slice(0, PREVIEW);

    return res.status(200).json({
      verdict,
      label: { hold: 'Hold', fix_first: 'Fix first', go: 'Go' }[verdict],
      headline: verdict === 'hold'
        ? `Hold this send. We found ${hold.length} potential area${hold.length === 1 ? '' : 's'} requiring review that could put it at risk.`
        : verdict === 'fix_first'
          ? `Fix first. We found ${fix.length} potential area${fix.length === 1 ? '' : 's'} requiring review.`
          : 'Go. The copy check found no potential areas requiring review.',
      summary: a.summary || '',
      items: shown,
      hiddenCount: hold.length + fix.length - shown.length,
      lowCount: items.length - hold.length - fix.length,
      notice: 'This checks the copy only, not your list or landing pages. It is not legal advice. We do not keep the text you paste.',
    });
  } catch (e) {
    console.error('[free-check]', e.message);
    return res.status(502).json({ error: 'The check could not run. Please try again.' });
  }
}
