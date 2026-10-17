// ─────────────────────────────────────────────────────────────
// SENDWIZE — free-check.js
// Public, no-login copy check for the marketing site. Visitors give their
// email, paste an email, SMS or social post and get Go / Fix first / Hold
// and a glimpse of one issue. Everything else needs an account.
//
// Off unless SENDWIZE_FREE_CHECK=true. Needs Upstash (see _limits.js),
// because without it the caps below can't be enforced.
// Caps per UTC day: SENDWIZE_FREE_CHECK_PER_EMAIL (default 1),
// SENDWIZE_FREE_CHECK_PER_IP (default 1), SENDWIZE_FREE_CHECK_DAILY
// (default 30) in total.
// Each check is logged to the Airtable table Free_Checks (email and
// verdict; never the copy). Visitors are told the email is only used to
// limit checks, so it must not be used for marketing. GET ?action=report (cron, 07:15)
// emails SENDWIZE_ALERT_EMAIL yesterday's numbers and heaviest users, and
// an alert goes out the moment the daily total runs out.
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { claudeFetch, parseJson } from './_claude.js';
import { SYSTEM_PROMPT, ANALYSIS_SCHEMA, CHANNEL_RULES } from './analyze-copy.js';
import { requireAuth } from './_auth.js';
import { atFetch } from './_airtable.js';

const CHANNELS = ['email', 'sms', 'social'];
const MAX_COPY = 6000;
const GLIMPSE_WORDS = 7;
const KEEP = 60 * 60 * 24 * 3;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

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
  if (n === 1) await redis(['EXPIRE', key, KEEP]);
  return n;
}

// Per-day tallies by email and by connection, read by the morning report.
async function tally(key, field) {
  await redis(['HINCRBY', key, field, 1]);
  await redis(['EXPIRE', key, KEEP]);
}

function hash(v) {
  return crypto.createHash('sha256').update(`${process.env.SENDWIZE_FREE_CHECK_SALT || 'sendwize'}|${v}`).digest('hex').slice(0, 24);
}

async function sendEmail(subject, html) {
  const to = process.env.SENDWIZE_ALERT_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) { console.warn('[free-check] no alert email configured:', subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'alerts@sendwize.co.uk', to: [to], subject, html }),
    });
    return r.ok;
  } catch (e) { console.error('[free-check] email failed:', e.message); return false; }
}

const escHtml = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function logCheck(fields) {
  try {
    const r = await atFetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/Free_Checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    if (!r.ok) console.warn('[free-check] Airtable log skipped:', r.status);
  } catch (e) { console.warn('[free-check] Airtable log failed:', e.message); }
}

function top(hashMap, n = 5) {
  const pairs = [];
  for (let i = 0; i + 1 < (hashMap || []).length; i += 2) pairs.push([hashMap[i], Number(hashMap[i + 1])]);
  return pairs.sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Morning email: yesterday's checks, people and heaviest users.
async function report(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'internal') return res.status(403).json({ error: 'Not allowed' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const [total, byEmail, byIp] = await Promise.all([
    redis(['GET', `sw:free:all:${day}`]),
    redis(['HGETALL', `sw:free:byemail:${day}`]),
    redis(['HGETALL', `sw:free:byip:${day}`]),
  ]);
  const checks = Number(total) || 0;
  const emails = top(byEmail, 10);
  const people = (byEmail || []).length / 2;
  const connections = (byIp || []).length / 2;
  const busiestConn = top(byIp, 1)[0];
  if (!checks) return res.json({ success: true, day, checks: 0, sent: false });
  const cap = parseInt(process.env.SENDWIZE_FREE_CHECK_DAILY || '', 10) || 30;
  const rows = emails.map(([e, n]) => `<tr><td style="padding:4px 12px 4px 0">${escHtml(e)}</td><td>${n}</td></tr>`).join('');
  const html = `<p><strong>${checks}</strong> free check${checks === 1 ? '' : 's'} on ${day} (cap ${cap}), from <strong>${people}</strong> email address${people === 1 ? '' : 'es'} on ${connections} connection${connections === 1 ? '' : 's'}.</p>` +
    (busiestConn && busiestConn[1] > 3 ? `<p>One connection ran ${busiestConn[1]} checks. That can be one person using several email addresses, or an office sharing a network.</p>` : '') +
    `<table style="font-family:sans-serif;font-size:14px"><tr><th align="left">Email</th><th align="left">Checks</th></tr>${rows}</table>` +
    `<p>Every check is listed in the Free_Checks table in Airtable, with their verdict.</p>`;
  const sent = await sendEmail(`Free check: ${checks} check${checks === 1 ? '' : 's'} from ${people} ${people === 1 ? 'person' : 'people'} yesterday`, html);
  return res.json({ success: true, day, checks, people, connections, sent });
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

const sev = s => String(s || '').toLowerCase();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.query?.action === 'report') {
    try { return await report(req, res); } catch (e) { console.error('[free-check] report', e.message); return res.status(500).json({ error: 'Report failed' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.SENDWIZE_FREE_CHECK !== 'true' || !process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'The free check is not available right now.', code: 'free_check_off' });
  }

  const { copy, subject, channel, email } = req.body ?? {};
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'Enter your work email to run the free check.' });
  const ch = CHANNELS.includes(channel) ? channel : 'email';
  const text = typeof copy === 'string' ? copy.trim() : '';
  if (text.length < 20) return res.status(400).json({ error: 'Paste the full message, at least a sentence or two.' });
  if (text.length > MAX_COPY) return res.status(400).json({ error: `Keep it under ${MAX_COPY.toLocaleString('en-GB')} characters for the free check.` });

  const day = new Date().toISOString().slice(0, 10);
  try {
    if (await bump(`sw:free:email:${hash(mail)}:${day}`) > cap('SENDWIZE_FREE_CHECK_PER_EMAIL', 1)
      || await bump(`sw:free:ip:${hash(clientIp(req))}:${day}`) > cap('SENDWIZE_FREE_CHECK_PER_IP', 1)) {
      return res.status(429).json({ error: "You've used today's free check. Create an account to see the full report and keep checking.", code: 'visitor_limit' });
    }
    const total = await bump(`sw:free:all:${day}`);
    const daily = cap('SENDWIZE_FREE_CHECK_DAILY', 30);
    if (total === daily + 1) {
      await sendEmail(`Free check: all ${daily} checks used today`,
        `<p>All ${daily} free checks for today have been used. Visitors now see "busy today" and a sign-up link until midnight UTC.</p><p>Tomorrow morning's report shows who used them. If it looks like real demand, raise SENDWIZE_FREE_CHECK_DAILY in Vercel. If it looks like one person, the cap has already stopped them, and it is the most the check can cost you in a day.</p>`);
    }
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
    // Only the first few words of the most serious issue; the rest is in the paid report.
    const first = [...hold, ...fix][0];
    const words = first ? first.issue.split(/\s+/) : [];
    const glimpse = first ? { severity: first.severity, text: words.slice(0, GLIMPSE_WORDS).join(' ') + (words.length > GLIMPSE_WORDS ? '…' : '') } : null;

    await Promise.all([
      tally(`sw:free:byemail:${day}`, mail),
      tally(`sw:free:byip:${day}`, hash(clientIp(req))),
      logCheck({
        Email: mail, Channel: ch, Verdict: verdict, Issues: hold.length + fix.length,
        VisitorHash: hash(clientIp(req)), CheckedAt: new Date().toISOString(),
      }),
    ]).catch(e => console.warn('[free-check] tally failed:', e.message));

    return res.status(200).json({
      verdict,
      label: { hold: 'Hold', fix_first: 'Fix first', go: 'Go' }[verdict],
      headline: verdict === 'go'
        ? 'Go. The copy check found no potential areas requiring review.'
        : `${verdict === 'hold' ? 'Hold this send.' : 'Fix first.'} We found ${hold.length + fix.length} potential area${hold.length + fix.length === 1 ? '' : 's'} requiring review.`,
      issueCount: hold.length + fix.length,
      glimpse,
      notice: 'This checks the copy only, not your list or landing pages. It is not legal advice. We do not keep the text you paste.',
    });
  } catch (e) {
    console.error('[free-check]', e.message);
    return res.status(502).json({ error: 'The check could not run. Please try again.' });
  }
}
