import type { ChartPoint, QuoteInfo, TimeRange } from "./quoteApi";

export type QuoteSyncSource = "market" | "detail";

export interface QuoteSyncPayload {
  symbol: string;
  market: string;
  range: TimeRange;
  source: QuoteSyncSource;
  quote: QuoteInfo;
  points?: ChartPoint[];
  refreshedAt: number;
}

const QUOTE_SYNC_EVENT = "asset-helper:quote-sync";
const latestQuotePayloads = new Map<string, QuoteSyncPayload>();

function payloadKey(payload: Pick<QuoteSyncPayload, "symbol" | "market" | "range">) {
  return `${payload.market}::${payload.symbol}::${payload.range}`;
}

export function emitQuoteSync(payload: QuoteSyncPayload) {
  if (typeof window === "undefined") return;
  latestQuotePayloads.set(payloadKey(payload), payload);
  window.dispatchEvent(new CustomEvent<QuoteSyncPayload>(QUOTE_SYNC_EVENT, { detail: payload }));
}

export function subscribeQuoteSync(handler: (payload: QuoteSyncPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<QuoteSyncPayload>;
    if (customEvent.detail) handler(customEvent.detail);
  };
  window.addEventListener(QUOTE_SYNC_EVENT, listener as EventListener);
  return () => window.removeEventListener(QUOTE_SYNC_EVENT, listener as EventListener);
}

export function isSameQuoteTarget(
  left: { symbol: string; market: string },
  right: { symbol: string; market: string },
) {
  return left.market === right.market && left.symbol === right.symbol;
}

export function getLatestSyncedQuote(
  target: Pick<QuoteSyncPayload, "symbol" | "market" | "range">,
) {
  return latestQuotePayloads.get(payloadKey(target)) ?? null;
}
