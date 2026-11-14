// ─────────────────────────────────────────────────────────────
// SENDWIZE — digest.js v2.0
// v2.0: alerts come from _memory.js: contacts whose consent lapsed since
//   the last upload (from the stored consent timeline, no new file
//   needed), what lapses next, spam complaints over the Gmail / Yahoo
//   limits or rising, and new ICO rulings that touch a stored list.
//   Replaces the old segment-state and list-value diffs.
// GET/POST /api/digest                  → run digest for ALL users
// GET/POST /api/digest?userId=x         → run digest for one user (testing)
// v1.1 (security): cron/internal callers only (Authorization: Bearer
//   CRON_SECRET, or the internal header). Previously anyone could trigger
//   an email to every user.
//
// Designed as a cron target (cron-job.org). Once a week it reads each
// user's two most recent snapshots from Audience_Read_Snapshots and
// List_Intelligence_Snapshots, computes what changed, and emails it.
//
// The point is stickiness through RE-UPLOAD: if a user has uploaded
// recently we send them the real diff; if they have gone quiet we send
// a decay nudge tied to the specific thing going stale, so "you haven't
// uploaded" reads as a credible warning rather than a generic reminder.
//
// Architecture rules:
//   - No npm airtable package — fetch to REST only
//   - All async awaited before res.json() — Vercel Hobby safe
//   - Per-user error isolation: one user failing never blocks the rest
//   - Null-strip before any Airtable write
// ─────────────────────────────────────────────────────────────

import { requireInternal } from './_auth.js';
import { fq } from './_airtable.js';
import { buildAlerts } from './_memory.js';

const RESEND_FROM = 'alerts@sendwize.co.uk';
const DASH_URL    = process.env.DASHBOARD_URL || 'https://new-mvp-v2.webflow.io/flow-templates/dashboard-templates/dashboard-template/dashboard-1-copy';
const STALE_DAYS  = 10;   // no upload in this many days → nudge mode
const MAX_USERS   = 200;  // safety cap per run

const BASE_ID  = process.env.BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = `https://api.airtable.com/v0/${BASE_ID}`;

const atH = () => ({ Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' });

async function atGet(table, formula, sort = '', max = 100) {
  let url = `${AT_BASE}/${encodeURIComponent(table)}?maxRecords=${max}`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort)    url += `&${sort}`;
  const r = await fetch(url, { headers: atH() });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status}`);
  return (await r.json()).records || [];
}

async function atPatch(table, id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
  const r = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH', headers: atH(), body: JSON.stringify({ fields: clean }),
  });
  return r.ok;
}

function daysSince(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}

// ── Email builders ────────────────────────────────────────────
function shell(inner) {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0;">
      <p style="color:white;font-size:20px;font-weight:700;margin:0;">sendwize</p>
    </div>
    <div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px;">
      ${inner}
      <a href="${DASH_URL}" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;margin-top:8px;">View your dashboard &rarr;</a>
      <p style="margin:32px 0 0;font-size:11px;color:#999;line-height:1.5;">
        Deterministic analysis of your own data. Commercial figures are estimates from your inputs &mdash; not regulatory fines. Not legal advice.
      </p>
    </div>
  </div>`;
}

const DOT = { red: '#dc2626', amber: '#ca8a04', info: '#6b7280', green: '#16a34a' };
function buildAlertEmail(alerts, days) {
  const rows = alerts.slice(0, 6).map(a =>
    `<p style="margin:0 0 12px;font-size:14px;color:#333;line-height:1.55;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${DOT[a.severity] || DOT.info};margin-right:8px;"></span>${escH(a.text)}</p>`).join('');
  const more = alerts.length > 6 ? `<p style="margin:0 0 12px;font-size:13px;color:#777;">And ${alerts.length - 6} more on your dashboard.</p>` : '';
  const inner = `<h2 style="margin:0 0 8px;font-size:20px;">What Sendwize noticed this week</h2>
    <p style="color:#555;margin:0 0 18px;font-size:13px;">Worked out from the lists and sends you've uploaded${days != null ? ` (latest ${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'})` : ''}, against today's date.</p>
    ${rows}${more}<div style="height:8px"></div>`;
  return shell(inner);
}

function buildSteadyEmail() {
  return shell(`<h2 style="margin:0 0 8px;font-size:20px;">Your week on Sendwize</h2>
    <p style="color:#555;margin:0 0 18px;font-size:14px;">Nothing new needs you this week. No contacts passed their consent period, no send went over the spam-complaint limits, and no new ruling touches your lists.</p>`);
}

function buildNudgeEmail(days) {
  return shell(`<h2 style="margin:0 0 8px;font-size:20px;">It has been ${days} days since your last upload</h2>
    <p style="color:#555;margin:0 0 18px;font-size:14px;">Consent and engagement change every week. Upload your latest list and campaign export so Sendwize can tell you who you can still email.</p>`);
}

function escH(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendEmail(to, subject, html) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) { return { sent: false, reason: `Resend ${r.status}` }; }
  return { sent: true };
}

// ── Process one user ──────────────────────────────────────────
async function processUser(profile, force) {
  const f = profile.fields || {};
  const userId = f.UserID;
  const email  = f.Email;
  if (!userId || !email) return { userId, status: 'skipped_no_email' };

  // Don't double-send the same day unless forced (single-user test).
  const today = new Date().toISOString().slice(0, 10);
  if (!force && f.LastDigestSent === today) return { userId, status: 'already_sent_today' };

  const { alerts, latestUpload, hasData } = await buildAlerts(userId);
  if (!hasData) return { userId, status: 'no_data' };
  const days = daysSince(latestUpload);
  const top = alerts.filter(a => a.severity === 'red' || a.severity === 'amber');

  let subject, html;
  if (top.length) {
    subject = top.length > 1 ? `${top.length} things on your lists need you this week` : '1 thing on your lists needs you this week';
    html = buildAlertEmail(alerts, days);
  } else if (days != null && days >= STALE_DAYS) {
    subject = `\u23F0 Your Sendwize data is ${days} days old`;
    html = alerts.length ? buildAlertEmail(alerts, days) : buildNudgeEmail(days);
  } else {
    subject = 'Your week on Sendwize: all clear';
    html = alerts.length ? buildAlertEmail(alerts, days) : buildSteadyEmail();
  }

  const result = await sendEmail(email, subject, html);
  if (result.sent && profile.id) {
    await atPatch('User_Profile', profile.id, { LastDigestSent: today }).catch(() => {});
  }
  return { userId, status: result.sent ? 'sent' : 'failed', reason: result.reason, days, alerts: alerts.length };
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const auth = await requireInternal(req, res);
  if (!auth) return;

  const userId = req.query.userId || req.body?.userId || null;

  try {
    let profiles;
    if (userId) {
      profiles = await atGet('User_Profile', `{UserID}=${fq(userId)}`, '', 1);
      if (!profiles.length) return res.status(404).json({ error: 'User not found' });
    } else {
      // All users who have an email. Snapshot lookups filter out the
      // ones with no data, so this stays cheap for a small beta.
      profiles = await atGet('User_Profile', `NOT({Email}="")`, '', MAX_USERS);
    }

    const results = [];
    for (const p of profiles) {
      try {
        results.push(await processUser(p, !!userId));
      } catch (e) {
        results.push({ userId: p.fields?.UserID, status: 'error', reason: e.message });
      }
    }

    const sent = results.filter(r => r.status === 'sent').length;
    return res.status(200).json({ success: true, processed: results.length, sent, results });

  } catch (err) {
    console.error('digest error:', err);
    return res.status(500).json({ error: err.message });
  }
}
