// ─────────────────────────────────────────────────────────────
// SENDWIZE — _esp.js v1.0 (Nov 2026)
// Email platform connections: Klaviyo and Mailchimp by API key, HubSpot
// by private app access token.
//
// Each provider turns its API into the same rows its own CSV export
// would give, with the column names Sendwize already recognises, so the
// pulled data runs through exactly the same List health and Audience
// read logic as an upload. Nothing here scores or judges anything.
//
//   verify(key)              → { account }          (throws a person-readable error)
//   lists(key)               → [{ id, name, count }]
//   contacts(key, listId, o) → { headers, rows, truncated, total }
//   campaigns(key, o)        → { headers, rows }    one row per sent campaign
//
// Keys are stored encrypted (AES-256-GCM) with CONNECTIONS_SECRET, or the
// internal secret if that isn't set. Read-only keys are enough and are
// what the page asks for.
// ─────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// 10k keeps the upload that follows under Vercel's 4.5MB request limit
export const MAX_CONTACT_ROWS = 10000;
const PULL_BUDGET_MS = 42000;
const UA = 'Sendwize/1.0';

// ── Key storage ──
function secretKey() {
  const s = process.env.CONNECTIONS_SECRET || process.env.INTERNAL_API_SECRET;
  if (!s) throw Object.assign(new Error('Connections are not set up yet (CONNECTIONS_SECRET is missing).'), { setup: true });
  return createHash('sha256').update(`sendwize-connections:${s}`).digest();
}
export function sealKey(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function openKey(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Stored key unreadable');
  const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
export const maskKey = k => { const s = String(k || ''); return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '••••'; };

const userError = (msg, status = 400) => Object.assign(new Error(msg), { userFacing: true, status });
const isoDate = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));

async function getJson(url, init, provider, { forbidden } = {}) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await fetch(url, init); } catch (e) { throw userError(`Couldn't reach ${provider}. Try again in a minute.`, 502); }
    if (r.status !== 429 || attempt === 2) break;
    // Short burst limits (HubSpot: 100 calls per 10 seconds): wait and retry
    await new Promise(ok => setTimeout(ok, 1500 * (attempt + 1)));
  }
  if (r.status === 401) throw userError(`${provider} didn't accept that key. Check it's copied in full.`, 401);
  if (r.status === 403) throw userError(forbidden || `${provider} didn't accept that key. Check it's copied in full and has read access.`, 401);
  if (r.status === 429) throw userError(`${provider} is limiting requests right now. Try again in a minute.`, 429);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw userError(`${provider} returned an error (${r.status}). ${body.slice(0, 160)}`, 502);
  }
  return r.json();
}

// ── Klaviyo ──────────────────────────────────────────────────
const KL = 'https://a.klaviyo.com/api';
const klH = key => ({ Authorization: `Klaviyo-API-Key ${key}`, revision: '2024-10-15', accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json', 'User-Agent': UA });

const klaviyo = {
  name: 'Klaviyo',
  keyHint: 'A private API key starting pk_ (Settings → API keys, read-only access is enough).',
  checkFormat: k => /^pk_[A-Za-z0-9]{20,}$/.test(k),

  async verify(key) {
    const j = await getJson(`${KL}/accounts/`, { headers: klH(key) }, 'Klaviyo');
    const a = j.data?.[0]?.attributes?.contact_information;
    return { account: a?.organization_name || a?.default_sender_name || 'Klaviyo account' };
  },

  async lists(key) {
    const out = [];
    let url = `${KL}/lists/?fields[list]=name`;
    for (let i = 0; url && i < 10; i++) {
      const j = await getJson(url, { headers: klH(key) }, 'Klaviyo');
      for (const l of j.data || []) out.push({ id: l.id, name: l.attributes?.name || l.id, count: null });
      url = j.links?.next || null;
    }
    return out;
  },

  async contacts(key, listId, { deadline = Date.now() + PULL_BUDGET_MS } = {}) {
    const headers = ['Email', 'First Active', 'Last Active', 'Email Marketing Consent', 'Consent Timestamp', 'Initial Source', 'Consent Basis', 'Unsubscribed', 'Historic Customer Lifetime Value', 'Historic Number of Orders'];
    const rows = [];
    let url = `${KL}/lists/${encodeURIComponent(listId)}/profiles/?page[size]=100&additional-fields[profile]=subscriptions,predictive_analytics`;
    let truncated = false;
    while (url) {
      if (rows.length >= MAX_CONTACT_ROWS || Date.now() > deadline) { truncated = true; break; }
      const j = await getJson(url, { headers: klH(key) }, 'Klaviyo');
      for (const p of j.data || []) {
        const a = p.attributes || {};
        if (!a.email) continue;
        const m = a.subscriptions?.email?.marketing || {};
        const suppressed = Array.isArray(m.suppression) && m.suppression.length > 0;
        const source = [m.method, m.method_detail].filter(Boolean).join(': ');
        rows.push([
          a.email, isoDate(a.created), isoDate(a.last_event_date), m.consent || '',
          isoDate(m.consent_timestamp), source,
          m.double_optin ? 'double opt-in' : (m.consent === 'SUBSCRIBED' ? 'consent' : ''),
          (m.consent === 'UNSUBSCRIBED' || suppressed) ? 'yes' : 'no',
          num(a.predictive_analytics?.historic_clv), num(a.predictive_analytics?.historic_number_of_orders),
        ]);
      }
      url = j.links?.next || null;
    }
    return { headers, rows, truncated, total: null };
  },

  async campaigns(key) {
    // Sent email campaigns from the last year, with names and send times
    const meta = new Map();
    let url = `${KL}/campaigns/?filter=${encodeURIComponent("and(equals(messages.channel,'email'),equals(status,'Sent'))")}&fields[campaign]=name,send_time,audiences&sort=-created_at`;
    for (let i = 0; url && i < 5; i++) {
      const j = await getJson(url, { headers: klH(key) }, 'Klaviyo');
      for (const c of j.data || []) meta.set(c.id, { name: c.attributes?.name || c.id, sent: c.attributes?.send_time || null, audiences: c.attributes?.audiences?.included || [] });
      url = j.links?.next || null;
    }
    if (!meta.size) return { headers: CAMPAIGN_HEADERS, rows: [] };

    // The report needs a conversion metric: Placed Order when there is one
    const metrics = await getJson(`${KL}/metrics/?fields[metric]=name`, { headers: klH(key) }, 'Klaviyo');
    const metric = (metrics.data || []).find(m => /placed order/i.test(m.attributes?.name || '')) || (metrics.data || [])[0];
    if (!metric) return { headers: CAMPAIGN_HEADERS, rows: [] };

    const report = await getJson(`${KL}/campaign-values-reports/`, {
      method: 'POST', headers: klH(key),
      body: JSON.stringify({ data: { type: 'campaign-values-report', attributes: {
        statistics: ['recipients', 'delivered', 'opens_unique', 'clicks_unique', 'unsubscribes', 'spam_complaints', 'bounced', 'conversion_value'],
        timeframe: { key: 'last_365_days' },
        conversion_metric_id: metric.id,
      } } }),
    }, 'Klaviyo');

    const isOrder = /placed order/i.test(metric.attributes?.name || '');
    const listNames = await klaviyo.lists(key).then(ls => new Map(ls.map(l => [l.id, l.name]))).catch(() => new Map());
    const rows = [];
    for (const r of report.data?.attributes?.results || []) {
      const id = r.groupings?.campaign_id;
      const c = meta.get(id);
      if (!c) continue;
      const s = r.statistics || {};
      rows.push([
        c.name, isoDate(c.sent), c.audiences.map(a => listNames.get(a) || a).join(', ') || 'All',
        num(s.recipients), num(s.delivered), num(s.opens_unique), num(s.clicks_unique),
        num(s.unsubscribes), num(s.spam_complaints), num(s.bounced), isOrder ? num(s.conversion_value) : '',
      ]);
    }
    rows.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    return { headers: CAMPAIGN_HEADERS, rows };
  },
};

// ── Mailchimp ────────────────────────────────────────────────
const mcBase = key => { const dc = String(key).split('-')[1]; if (!/^[a-z]{2}\d{1,3}$/.test(dc || '')) throw userError('That doesn\'t look like a Mailchimp API key. It ends with a dash and your data centre, like -us21.'); return `https://${dc}.api.mailchimp.com/3.0`; };
const mcH = key => ({ Authorization: `Basic ${Buffer.from(`sendwize:${key}`).toString('base64')}`, 'User-Agent': UA });

const mailchimp = {
  name: 'Mailchimp',
  keyHint: 'An API key ending in your data centre, like …-us21 (Profile → Extras → API keys).',
  checkFormat: k => /^[a-f0-9]{32}-[a-z]{2}\d{1,3}$/.test(k),

  async verify(key) {
    const j = await getJson(`${mcBase(key)}/?fields=account_name,account_id`, { headers: mcH(key) }, 'Mailchimp');
    return { account: j.account_name || 'Mailchimp account' };
  },

  async lists(key) {
    const j = await getJson(`${mcBase(key)}/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count,lists.stats.cleaned_count`, { headers: mcH(key) }, 'Mailchimp');
    return (j.lists || []).map(l => ({ id: l.id, name: l.name, count: (l.stats?.member_count || 0) + (l.stats?.unsubscribe_count || 0) + (l.stats?.cleaned_count || 0) }));
  },

  async contacts(key, listId, { deadline = Date.now() + PULL_BUDGET_MS } = {}) {
    const headers = ['Email Address', 'Status', 'Date Added', 'OPTIN_TIME', 'OPTIN_IP', 'CONFIRM_TIME', 'MEMBER_RATING', 'Source', 'Total Revenue', 'Number of Orders'];
    const rows = [];
    const fields = 'total_items,members.email_address,members.status,members.timestamp_signup,members.ip_signup,members.timestamp_opt,members.ip_opt,members.member_rating,members.source,members.stats';
    let offset = 0, total = null, truncated = false;
    for (;;) {
      if (rows.length >= MAX_CONTACT_ROWS || Date.now() > deadline) { truncated = total == null || offset < total; break; }
      const j = await getJson(`${mcBase(key)}/lists/${encodeURIComponent(listId)}/members?count=1000&offset=${offset}&fields=${fields}`, { headers: mcH(key) }, 'Mailchimp');
      total = j.total_items ?? total;
      const ms = j.members || [];
      for (const m of ms) {
        if (!m.email_address) continue;
        const signup = m.timestamp_signup || m.timestamp_opt;
        rows.push([
          m.email_address, m.status || '', isoDate(signup), isoDate(signup), m.ip_signup || m.ip_opt || '',
          m.timestamp_signup && m.timestamp_opt ? isoDate(m.timestamp_opt) : '',
          // No last-engagement date: Mailchimp's last_changed moves on any
          // profile edit, so it would make stale contacts look active.
          // MEMBER_RATING (1-5) is its engagement signal.
          num(m.member_rating), m.source || '',
          num(m.stats?.ecommerce_data?.total_revenue), num(m.stats?.ecommerce_data?.number_of_orders),
        ]);
      }
      offset += ms.length;
      if (!ms.length || (total != null && offset >= total)) break;
    }
    return { headers, rows: rows.slice(0, MAX_CONTACT_ROWS), truncated, total };
  },

  async campaigns(key) {
    const since = new Date(Date.now() - 365 * 864e5).toISOString();
    const fields = 'reports.campaign_title,reports.subject_line,reports.list_name,reports.send_time,reports.emails_sent,reports.abuse_reports,reports.unsubscribed,reports.bounces,reports.opens,reports.clicks,reports.ecommerce,reports.type';
    const j = await getJson(`${mcBase(key)}/reports?count=200&since_send_time=${encodeURIComponent(since)}&fields=${fields}`, { headers: mcH(key) }, 'Mailchimp');
    const rows = (j.reports || []).filter(r => !r.type || r.type === 'regular' || r.type === 'plaintext').map(r => {
      const bounced = (r.bounces?.hard_bounces || 0) + (r.bounces?.soft_bounces || 0) + (r.bounces?.syntax_errors || 0);
      return [
        r.campaign_title || r.subject_line || 'Campaign', isoDate(r.send_time), r.list_name || '',
        num(r.emails_sent), num(r.emails_sent != null ? r.emails_sent - bounced : ''),
        num(r.opens?.unique_opens), num(r.clicks?.unique_subscriber_clicks),
        num(r.unsubscribed), num(r.abuse_reports), num(bounced), num(r.ecommerce?.total_revenue),
      ];
    });
    rows.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    return { headers: CAMPAIGN_HEADERS, rows };
  },
};

// ── HubSpot (private app access token) ───────────────────────
const HS = 'https://api.hubapi.com';
const hsH = key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA });
const HS_PROPS = ['email', 'createdate', 'hs_email_last_open_date', 'hs_email_last_click_date', 'hs_email_optout', 'hs_legal_basis', 'hs_analytics_source', 'total_revenue', 'hs_email_hard_bounce_reason_enum'];
const hsScope = s => `HubSpot refused that request. In your private app, tick the "${s}" scope, then reconnect.`;
const hsRow = p => [
  p.email, isoDate(p.createdate),
  isoDate([p.hs_email_last_open_date, p.hs_email_last_click_date].filter(Boolean).sort().pop()),
  isoDate(p.hs_email_last_click_date), p.hs_email_optout === 'true' ? 'yes' : 'no',
  (p.hs_legal_basis || '').replace(/;/g, ', '), (p.hs_analytics_source || '').replace(/_/g, ' ').toLowerCase(),
  num(p.total_revenue), p.hs_email_hard_bounce_reason_enum ? 'bounced' : '',
];

const hubspot = {
  name: 'HubSpot',
  keyHint: 'A private app access token starting pat- (Settings → Integrations → Private apps, with the crm.objects.contacts.read, crm.lists.read and content scopes).',
  checkFormat: k => /^pat-[a-z0-9]{2,6}-[a-f0-9-]{30,}$/i.test(k),

  async verify(key) {
    const j = await getJson(`${HS}/account-info/v3/details`, { headers: hsH(key) }, 'HubSpot');
    // Make sure contacts can actually be read before saving
    await getJson(`${HS}/crm/v3/objects/contacts?limit=1&properties=email`, { headers: hsH(key) }, 'HubSpot', { forbidden: hsScope('crm.objects.contacts.read') });
    return { account: j.portalId ? `HubSpot account ${j.portalId}` : 'HubSpot account' };
  },

  async lists(key) {
    const out = [{ id: 'all', name: 'All contacts', count: null }];
    try {
      const j = await getJson(`${HS}/crm/v3/lists/search`, { method: 'POST', headers: hsH(key), body: JSON.stringify({ count: 100, offset: 0, processingTypes: ['MANUAL', 'DYNAMIC', 'SNAPSHOT'], additionalProperties: ['hs_list_size'] }) }, 'HubSpot', { forbidden: hsScope('crm.lists.read') });
      for (const l of j.lists || []) if (l.objectTypeId === '0-1' || !l.objectTypeId) out.push({ id: String(l.listId), name: l.name, count: l.additionalProperties?.hs_list_size != null ? Number(l.additionalProperties.hs_list_size) : null });
    } catch (e) { if (!e.userFacing) throw e; /* no list scope: "All contacts" still works */ }
    return out;
  },

  async contacts(key, listId, { deadline = Date.now() + PULL_BUDGET_MS } = {}) {
    const headers = ['Email', 'Create Date', 'Last Marketing Email Open Date', 'Last Marketing Email Click Date', 'Unsubscribed from all email', 'Legal basis', 'Original Source', 'Total Revenue', 'Status'];
    const rows = [];
    let truncated = false;
    const forbidden = hsScope('crm.objects.contacts.read');
    if (listId === 'all') {
      let after = null;
      do {
        if (rows.length >= MAX_CONTACT_ROWS || Date.now() > deadline) { truncated = true; break; }
        const j = await getJson(`${HS}/crm/v3/objects/contacts?limit=100&archived=false&properties=${HS_PROPS.join(',')}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers: hsH(key) }, 'HubSpot', { forbidden });
        for (const c of j.results || []) if (c.properties?.email) rows.push(hsRow(c.properties));
        after = j.paging?.next?.after || null;
      } while (after);
    } else {
      let after = null;
      do {
        if (rows.length >= MAX_CONTACT_ROWS || Date.now() > deadline) { truncated = true; break; }
        const m = await getJson(`${HS}/crm/v3/lists/${encodeURIComponent(listId)}/memberships?limit=250${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers: hsH(key) }, 'HubSpot', { forbidden: hsScope('crm.lists.read') });
        const ids = (m.results || []).map(x => String(x.recordId || x));
        for (let i = 0; i < ids.length; i += 100) {
          const b = await getJson(`${HS}/crm/v3/objects/contacts/batch/read`, { method: 'POST', headers: hsH(key), body: JSON.stringify({ properties: HS_PROPS, inputs: ids.slice(i, i + 100).map(id => ({ id })) }) }, 'HubSpot', { forbidden });
          for (const c of b.results || []) if (c.properties?.email) rows.push(hsRow(c.properties));
        }
        after = m.paging?.next?.after || null;
      } while (after);
    }
    return { headers, rows: rows.slice(0, MAX_CONTACT_ROWS), truncated, total: null };
  },

  async campaigns(key) {
    const since = Date.now() - 365 * 864e5;
    const rows = [];
    let after = null;
    for (let i = 0; i < 5; i++) {
      const j = await getJson(`${HS}/marketing/v3/emails?limit=100&includeStats=true&sort=-publishDate${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers: hsH(key) }, 'HubSpot', { forbidden: hsScope('content') });
      for (const e of j.results || []) {
        const c = e.stats?.counters || {};
        const sentAt = e.publishDate || e.publishedAt || e.updatedAt;
        if (!c.sent || (sentAt && Date.parse(sentAt) < since)) continue;
        rows.push([e.name || e.subject || 'Email', isoDate(sentAt), '', num(c.sent), num(c.delivered), num(c.open), num(c.click), num(c.unsubscribed), num(c.spamreport), num(c.bounce), '']);
      }
      after = j.paging?.next?.after || null;
      if (!after) break;
    }
    rows.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    return { headers: CAMPAIGN_HEADERS, rows };
  },
};

// Same names Audience read already maps without asking
export const CAMPAIGN_HEADERS = ['Campaign Name', 'Send Date', 'List', 'Recipients', 'Delivered', 'Unique Opens', 'Unique Clicks', 'Unsubscribes', 'Spam Complaints', 'Bounces', 'Revenue'];

export const PROVIDERS = { klaviyo, mailchimp, hubspot };

// How people responded to recent sends, for Campaign defence. Rates are
// against delivered (or sent). Flags use public mailbox-provider limits:
// Gmail and Yahoo ask senders to stay under 0.3% spam complaints.
export function responseSummary(campaigns, limit = 12) {
  const H = Object.fromEntries(CAMPAIGN_HEADERS.map((h, i) => [h, i]));
  const rate = (n, d) => (Number(d) > 0 && n !== '' && n != null ? Number(n) / Number(d) : null);
  return campaigns.rows.slice(0, limit).map(r => {
    const base = r[H.Delivered] || r[H.Recipients];
    const out = {
      name: r[H['Campaign Name']], sentAt: r[H['Send Date']] || null, list: r[H.List] || '',
      sent: r[H.Recipients] === '' ? null : r[H.Recipients],
      openRate: rate(r[H['Unique Opens']], base), clickRate: rate(r[H['Unique Clicks']], base),
      unsubRate: rate(r[H.Unsubscribes], base), complaintRate: rate(r[H['Spam Complaints']], base),
      bounceRate: rate(r[H.Bounces], r[H.Recipients]),
      revenue: r[H.Revenue] === '' ? null : r[H.Revenue],
    };
    const flags = [];
    if (out.complaintRate != null && out.complaintRate >= 0.003) flags.push({ level: 'high', text: 'Spam complaints at or above the 0.3% Gmail and Yahoo limit' });
    else if (out.complaintRate != null && out.complaintRate >= 0.001) flags.push({ level: 'medium', text: 'Spam complaints above 0.1%, the level mailbox providers ask senders to stay under' });
    if (out.unsubRate != null && out.unsubRate >= 0.005) flags.push({ level: 'medium', text: 'Unsubscribes above 0.5%, a sign people didn\'t expect this email' });
    if (out.bounceRate != null && out.bounceRate >= 0.02) flags.push({ level: 'medium', text: 'Bounces above 2%, which points to old or unconfirmed addresses' });
    out.flags = flags;
    return out;
  });
}
