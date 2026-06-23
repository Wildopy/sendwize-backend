// ─────────────────────────────────────────────────────────────
// SENDWIZE — _airtable.js v1.0
// Shared Airtable fetch wrapper with 429 backoff + retry.
// Used by data.js, profile.js, list-recommendations.js.
//
// Why this exists:
// Airtable enforces 5 req/sec per base. Vercel Hobby spins up
// concurrent serverless invocations with no coordination between
// them, so a dashboard load firing several functions in parallel
// — each making 1-3 sequential Airtable calls — can exceed that
// limit even when the frontend is staggered. Previously, every
// 429 from Airtable was either passed straight through to the
// browser (data.js) or thrown as an uncaught Error that surfaced
// as a 500 (list-recommendations.js, profile.js create-on-get path).
//
// atFetch() retries on 429 (and 500/502/503/504 transient errors)
// with exponential backoff + jitter, honouring Airtable's
// Retry-After header when present. Vercel Hobby has a 10s function
// timeout — backoff delays are kept short and capped so a retry
// sequence can never approach that ceiling.
// ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250; // doubles each retry: 250, 500, 1000
const MAX_TOTAL_BUDGET_MS = 4000; // hard ceiling — leaves headroom under the 10s Hobby limit

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Drop-in replacement for fetch() against the Airtable API.
 * Retries on 429/5xx with exponential backoff + jitter.
 * Returns the same Response object fetch() would — callers keep
 * using response.ok / response.status / response.json() as before.
 */
async function atFetch(url, options = {}) {
  let attempt = 0;
  let elapsed = 0;
  let lastResponse = null;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(url, options);

      if (response.ok || !isRetryable(response.status)) {
        return response; // success, or a non-retryable error (4xx other than 429) — return as-is
      }

      lastResponse = response;

      if (attempt === MAX_RETRIES || elapsed >= MAX_TOTAL_BUDGET_MS) {
        return response; // out of retries or budget — return the last (failed) response, let caller handle
      }

      // Honour Retry-After if Airtable sent one (seconds or HTTP date — we only handle seconds here)
      const retryAfterHeader = response.headers?.get?.('Retry-After');
      const retryAfterMs = retryAfterHeader && !isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : null;

      const backoff = retryAfterMs ?? (BASE_DELAY_MS * Math.pow(2, attempt));
      const jitter = Math.random() * 100;
      const delay = Math.min(backoff + jitter, MAX_TOTAL_BUDGET_MS - elapsed);

      if (delay > 0) {
        await sleep(delay);
        elapsed += delay;
      }
      attempt++;

    } catch (networkErr) {
      // Network-level failure (not an HTTP error response) — retry the same way
      lastError = networkErr;
      if (attempt === MAX_RETRIES || elapsed >= MAX_TOTAL_BUDGET_MS) {
        throw networkErr;
      }
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100, MAX_TOTAL_BUDGET_MS - elapsed);
      await sleep(delay);
      elapsed += delay;
      attempt++;
    }
  }

  if (lastResponse) return lastResponse;
  if (lastError) throw lastError;
  throw new Error('atFetch: exhausted retries with no response');
}

export { atFetch, isRetryable };
