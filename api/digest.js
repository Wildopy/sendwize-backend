// ─────────────────────────────────────────────────────────────
// SENDWIZE — digest.js v1.0
// GET/POST /api/digest                  → run digest for ALL users
// GET/POST /api/digest?userId=x         → run digest for one user (testing)
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

const RESEND_FROM = 'alerts@sendwize.co.uk';
const DASH_URL    = 'https://www.sendwize.co.uk/dashboard';
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

// Health ranking — higher = healthier (mirrors audience-read.js)
const STATE_RANK = {
  'Complaint risk': 0, 'Damaged': 1, 'Fatigue building': 2, 'Cooling': 3,
  'Recovering': 4, 'Neutral': 5, 'Healthy': 6,
  'Highly receptive post-gap': 7, 'Peak receptiveness': 8,
};

function daysSince(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}

function fmtGBP(n) { return '\u00a3' + Math.round(n || 0).toLocaleString('en-GB'); }
function fmtN(n)   { return (n || 0).toLocaleString('en-GB'); }

// ── Audience Read diff ────────────────────────────────────────
async function audienceDiff(userId) {
  let recs;
  try {
    recs = await atGet('Audience_Read_Snapshots', `{UserID}="${userId}"`,
      'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc', 200);
  } catch { return null; }
  if (!recs.length) return null;

  const bySeg = {};
  for (const r of recs) {
    const seg = r.fields.SegmentName;
    if (!seg) continue;
    if (!bySeg[seg]) bySeg[seg] = [];
    bySeg[seg].push({
      ts: r.fields.SnapshotTimestamp || r.fields.SnapshotDate,
      state: r.fields.State || 'Neutral',
      capital: r.fields.Capital != null ? r.fields.Capital : 0,
    });
  }

  let improved = 0, worsened = 0, latestTs = null;
  const moves = [];
  for (const seg of Object.keys(bySeg)) {
    const list = bySeg[seg];
    if (list[0] && (!latestTs || new Date(list[0].ts) > new Date(latestTs))) latestTs = list[0].ts;
    if (list.length < 2) continue;
    const cur = list[0], prev = list[1];
    if (cur.state !== prev.state) {
      const up = (STATE_RANK[cur.state] ?? 5) > (STATE_RANK[prev.state] ?? 5);
      if (up) improved++; else worsened++;
      moves.push({ seg, from: prev.state, to: cur.state, up });
    }
  }
  moves.sort((a, b) => (a.up === b.up) ? 0 : a.up ? 1 : -1); // worsened first
  return { improved, worsened, moves: moves.slice(0, 5), latestTs, segmentCount: Object.keys(bySeg).length };
}

// ── List Intelligence diff ────────────────────────────────────
async function listDiff(userId) {
  let recs;
  try {
    recs = await atGet('List_Intelligence_Snapshots', `{UserID}="${userId}"`,
      'sort[0][field]=SnapshotTimestamp&sort[0][direction]=desc', 12);
  } catch { return null; }
  if (!recs.length) return null;

  const map = r => ({
    ts: r.fields.SnapshotTimestamp || r.fields.SnapshotDate,
    assetValue: r.fields.AssetValue != null ? r.fields.AssetValue : 0,
    liabilityCount: r.fields.LiabilityCount || 0,
    activeCount: r.fields.ActiveCount || 0,
    expiring30: r.fields.Expiring30 || 0,
    expiring60: r.fields.Expiring60 || 0,
    expiring90: r.fields.Expiring90 || 0,
  });
  const cur = map(recs[0]);
  const prev = recs[1] ? map(recs[1]) : null;
  return {
    latestTs: cur.ts,
    cur,
    valueDelta: prev ? Math.round(cur.assetValue - prev.assetValue) : null,
    liabilityDelta: prev ? (cur.liabilityCount - prev.liabilityCount) : null,
    expiring30Delta: prev ? (cur.expiring30 - prev.expiring30) : null,
  };
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

function buildDigestEmail(ad, ld) {
  const rows = [];

  if (ad && (ad.improved || ad.worsened)) {
    const bits = [];
    if (ad.worsened) bits.push(`<strong>${ad.worsened}</strong> segment${ad.worsened !== 1 ? 's' : ''} slipped`);
    if (ad.improved) bits.push(`<strong>${ad.improved}</strong> improved`);
    rows.push(`<p style="margin:0 0 6px;font-size:14px;color:#333;">Audience Read: ${bits.join(', ')}.</p>`);
    for (const m of ad.moves) {
      rows.push(`<p style="margin:0 0 4px;font-size:13px;color:#555;">&bull; ${escH(m.seg)}: ${escH(m.from)} &rarr; <strong>${escH(m.to)}</strong></p>`);
    }
  }

  if (ld) {
    const liBits = [];
    if (ld.valueDelta != null && ld.valueDelta !== 0) liBits.push(`list value ${ld.valueDelta > 0 ? 'up' : 'down'} ${fmtGBP(Math.abs(ld.valueDelta))}`);
    if (ld.liabilityDelta != null && ld.liabilityDelta !== 0) liBits.push(`liability contacts ${ld.liabilityDelta > 0 ? 'up' : 'down'} ${fmtN(Math.abs(ld.liabilityDelta))}`);
    if (liBits.length) rows.push(`<p style="margin:12px 0 6px;font-size:14px;color:#333;">List Intelligence: ${liBits.join(', ')}.</p>`);
    if (ld.cur.expiring30 > 0) {
      rows.push(`<p style="margin:0 0 4px;font-size:13px;color:#555;">&bull; <strong>${fmtN(ld.cur.expiring30)}</strong> contacts lose usable consent within 30 days.</p>`);
    }
  }

  if (!rows.length) {
    rows.push(`<p style="margin:0 0 6px;font-size:14px;color:#333;">Things are holding steady since your last check &mdash; no segment state changes or material shifts in list value.</p>`);
  }

  const inner = `<h2 style="margin:0 0 8px;font-size:20px;">Your week on Sendwize</h2>
    <p style="color:#555;margin:0 0 18px;font-size:13px;">Here is what moved since your last upload.</p>
    ${rows.join('')}
    <div style="height:18px"></div>`;
  return shell(inner);
}

function buildNudgeEmail(days, ld) {
  let stale = '';
  if (ld && ld.cur && ld.cur.expiring30 > 0) {
    stale = `<p style="color:#555;margin:0 0 18px;font-size:14px;">Based on your last upload, around <strong>${fmtN(ld.cur.expiring30)}</strong> contacts were within 30 days of losing usable consent &mdash; some will have crossed that line by now. We cannot confirm your true position until you upload your latest list.</p>`;
  } else {
    stale = `<p style="color:#555;margin:0 0 18px;font-size:14px;">Email engagement and consent decay over time. Your diagnosis is now ${days} days old, so it no longer reflects where your audience actually stands.</p>`;
  }
  const inner = `<h2 style="margin:0 0 8px;font-size:20px;">It has been ${days} days since your last upload</h2>
    ${stale}`;
  return shell(inner);
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

  const [ad, ld] = await Promise.all([audienceDiff(userId), listDiff(userId)]);
  if (!ad && !ld) return { userId, status: 'no_data' };

  // Most recent activity across both tools.
  const tsList = [ad?.latestTs, ld?.latestTs].filter(Boolean);
  const newest = tsList.sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const days = daysSince(newest);

  let subject, html;
  if (days != null && days >= STALE_DAYS) {
    subject = `\u23F0 Your Sendwize data is ${days} days old`;
    html = buildNudgeEmail(days, ld);
  } else {
    subject = '\uD83D\uDCCA Your week on Sendwize \u2014 what changed';
    html = buildDigestEmail(ad, ld);
  }

  const result = await sendEmail(email, subject, html);
  if (result.sent && profile.id) {
    await atPatch('User_Profile', profile.id, { LastDigestSent: today }).catch(() => {});
  }
  return { userId, status: result.sent ? 'sent' : 'failed', reason: result.reason, days };
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.body?.userId || null;

  try {
    let profiles;
    if (userId) {
      profiles = await atGet('User_Profile', `{UserID}="${userId}"`, '', 1);
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
