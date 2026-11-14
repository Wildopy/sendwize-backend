// ─────────────────────────────────────────────────────────────
// SENDWIZE — _esp-cost.js v1.0 (Nov 2026)
// What contacts who never engage cost to keep on an email platform.
// Klaviyo and Mailchimp both price by list size. At 5,000 to 50,000
// contacts their published plans work out at roughly £10 to £13 per
// 1,000 contacts a month, so £10 is used as a deliberately low default.
// The member can enter their own figure on the page for an exact number.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_COST_PER_1K = 10; // £ per 1,000 contacts per month
export const COST_BASIS = 'Estimate at £10 per 1,000 contacts a month, at the low end of Klaviyo and Mailchimp pricing for lists of 5,000 to 50,000. Platforms charge in tiers, so the saving lands when you drop below a tier.';

// Contacts that are kept but never engage: no open, click or purchase in
// 12 months, or nothing at all inside the consent period
export const NEVER_ENGAGE_REASONS = ['dormant', 'consent_expired'];

export function contactSavings(count, per1k = DEFAULT_COST_PER_1K) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  const rate = Number(per1k) > 0 ? Number(per1k) : DEFAULT_COST_PER_1K;
  const monthly = Math.round(n * rate / 1000);
  return { contacts: n, per1k: rate, monthly, yearly: monthly * 12, basis: COST_BASIS };
}
