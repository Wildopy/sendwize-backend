// ─────────────────────────────────────────────────────────────
// SENDWIZE — _email.js v1.0
// Sends Sendwize emails through Resend (RESEND_API_KEY) and Slack
// messages through an incoming webhook. Both are best-effort: they
// return { sent: false, reason } instead of throwing.
// ─────────────────────────────────────────────────────────────
const FROM = 'Sendwize <alerts@sendwize.co.uk>';

export const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The house layout used by data.js send-alert
export function emailLayout({ heading, bodyHtml, ctaText, ctaUrl, footnote = 'Not legal advice.' }) {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><div style="background:#EA7317;padding:24px 32px;border-radius:8px 8px 0 0"><p style="color:white;font-size:20px;font-weight:700;margin:0">sendwize</p></div><div style="background:#fff;padding:32px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px"><h2 style="margin:0 0 12px">${escHtml(heading)}</h2>${bodyHtml}${ctaUrl ? `<p style="margin:24px 0 0"><a href="${escHtml(ctaUrl)}" style="background:#EA7317;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">${escHtml(ctaText || 'Open Sendwize')}</a></p>` : ''}<p style="margin:32px 0 0;font-size:11px;color:#999">${escHtml(footnote)}</p></div></div>`;
}

export const isEmail = s => typeof s === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(s.trim());

export async function sendEmail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not configured' };
  if (!isEmail(to)) return { sent: false, reason: 'No valid recipient' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to.trim()], subject, html, ...(isEmail(replyTo) ? { reply_to: replyTo.trim() } : {}) }),
    });
    if (!r.ok) return { sent: false, reason: `Resend ${r.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

export const isSlackWebhook = s => typeof s === 'string' && /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/.test(s.trim());

export async function sendSlack(webhook, text) {
  if (!isSlackWebhook(webhook)) return { sent: false, reason: 'No Slack webhook' };
  try {
    const r = await fetch(webhook.trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    return r.ok ? { sent: true } : { sent: false, reason: `Slack ${r.status}` };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// The member's email from their profile
export async function memberEmail(userId) {
  try {
    const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
    const f = encodeURIComponent(`{UserID}='${String(userId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const r = await fetch(`${base}/User_Profile?filterByFormula=${f}&maxRecords=1`, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (!r.ok) return null;
    const rec = (await r.json()).records?.[0];
    return rec ? { email: rec.fields?.Email || null, sector: rec.fields?.Sector || null, name: rec.fields?.Name || rec.fields?.CompanyName || null } : null;
  } catch { return null; }
}
