import type { QuoteInfo } from "./quoteApi";

/**
 * Robinhood extended-hours quote stub.
 *
 * The previous implementation called `https://api.robinhood.com` directly from
 * the browser, but Robinhood does not return CORS headers and vite.config.ts
 * has no proxy registered for that host. Every request therefore failed and
 * the function effectively always returned null. Yahoo Finance already covers
 * US pre/post/overnight pricing via the chart endpoint, so the Robinhood path
 * is dead weight.
 *
 * The signature is kept so callers in quoteApi.ts continue to type-check; they
 * already wrap the call in `.catch(() => null)` and merge the result with
 * Nasdaq's extended quote. Returning null here preserves that fallback chain
 * without shipping unreachable network code.
 */
export async function fetchRobinhoodExtendedQuote(_symbol: string): Promise<Partial<QuoteInfo> | null> {
  return null;
}
