// ─────────────────────────────────────────────────────────────
// SENDWIZE — _suppliers.js v1.0 (Nov 2026)
// Shared by supplier.js (the Third-party register's upkeep) and
// _memory.js (dashboard "Sendwize noticed" and the weekly digest):
// which register tables exist, and what is coming up for each supplier.
// ─────────────────────────────────────────────────────────────
const DAY = 86400000;

export const KINDS = {
  processors: { table: 'Vendor_Register',    name: 'VendorName',    label: 'platform' },
  partners:   { table: 'Partner_Register',   name: 'PartnerName',   label: 'partner' },
  affiliates: { table: 'Affiliate_Register', name: 'AffiliateName', label: 'affiliate' },
};

// Reviews and renewals due within 30 days, or overdue.
export function dueItems(kind, rec, now = Date.now()) {
  const f = rec.fields || {}, out = [];
  const name = f[KINDS[kind].name] || 'Unnamed';
  const days = d => Math.ceil((new Date(d) - now) / DAY);
  if (f.NextReviewDate && days(f.NextReviewDate) <= 30) out.push({ kind, recordId: rec.id, name, type: 'review', date: f.NextReviewDate, days: days(f.NextReviewDate), owner: f.Owner || '' });
  if (f.ContractRenewalDate && days(f.ContractRenewalDate) <= 30) out.push({ kind, recordId: rec.id, name, type: 'renewal', date: f.ContractRenewalDate, days: days(f.ContractRenewalDate), owner: f.Owner || '' });
  return out;
}

// Every upcoming item for one member, read from the three register tables.
export async function loadSupplierDue(userId, atFetch, now = Date.now()) {
  const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const out = [];
  await Promise.all(Object.entries(KINDS).map(async ([kind, k]) => {
    const f = encodeURIComponent(`AND({UserID}='${esc(userId)}',OR(NOT({NextReviewDate}=BLANK()),NOT({ContractRenewalDate}=BLANK())))`);
    const r = await atFetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/${k.table}?filterByFormula=${f}&maxRecords=100`, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } }).catch(() => null);
    if (!r || !r.ok) return; // fields not added yet
    for (const rec of (await r.json()).records || []) out.push(...dueItems(kind, rec, now));
  }));
  return out.sort((a, b) => a.days - b.days);
}

export function supplierAlertText(i) {
  const by = i.owner ? ` (${i.owner})` : '';
  if (i.type === 'review') return i.days < 0 ? `The review of ${i.name} is ${-i.days} days overdue${by}. Check the agreement and what they send or collect for you, then log it.`
    : `The review of ${i.name} is due ${i.days === 0 ? 'today' : `in ${i.days} days`}${by}. Check the agreement and what they send or collect for you, then log it.`;
  return i.days < 0 ? `Your contract with ${i.name} renewed ${-i.days} days ago${by}. Check the data protection terms in the new version.`
    : `Your contract with ${i.name} renews ${i.days === 0 ? 'today' : `in ${i.days} days`}${by}. A good moment to check the data protection terms before it rolls over.`;
}
