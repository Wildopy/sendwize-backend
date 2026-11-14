// ─────────────────────────────────────────────────────────────
// SENDWIZE — _owned-domains.js v1.0
// One place to answer "has this member proven they own this site?"
//
// Proof comes from Site Sweep's ownership step (Site_Sweeps.VerifiedAt):
// a confirmed sign-up email at the domain, a link emailed to an address
// at the domain, or a meta tag / file / DNS record.
//
// Rule for every tool that WATCHES a website over time (Site guard,
// Campaign Defence drift checks, scheduled re-sweeps): only pages on a
// verified domain (or its subdomains) are watched. A one-off check of a
// public page, as any visitor could do, does not need proof.
// ─────────────────────────────────────────────────────────────
import { atFetch } from './_airtable.js';

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return ''; }
}

// True when the URL's host is one of the domains or a subdomain of one.
export function urlOnDomains(url, domains = []) {
  const h = hostOf(url);
  if (!h) return false;
  return domains.some(d => h === d || h.endsWith('.' + d));
}

// Verified domains for one member. Returns [] if the table or fields
// are missing, so callers simply watch nothing rather than crash.
export async function verifiedDomains(userId) {
  if (!userId) return [];
  const base = `https://api.airtable.com/v0/${process.env.BASE_ID}`;
  const formula = encodeURIComponent(`AND({UserID}='${esc(userId)}',NOT({VerifiedAt}=BLANK()))`);
  try {
    const r = await atFetch(`${base}/Site_Sweeps?filterByFormula=${formula}&fields[]=Domain&maxRecords=50`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
    });
    if (!r.ok) return [];
    const recs = (await r.json()).records || [];
    return [...new Set(recs.map(x => String(x.fields?.Domain || '').toLowerCase().replace(/^www\./, '')).filter(Boolean))];
  } catch (e) {
    console.warn('[owned-domains] lookup failed:', e.message);
    return [];
  }
}

// Splits a list of URLs into the ones we may watch and the ones we may not.
export function splitWatchable(urls = [], domains = []) {
  const watched = [], notWatched = [];
  for (const u of urls) (urlOnDomains(u, domains) ? watched : notWatched).push(u);
  return { watched, notWatched };
}
