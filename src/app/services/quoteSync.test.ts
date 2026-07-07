import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { clearQuoteSyncCacheForTests, emitQuoteSync, getLatestSyncedQuote, isSameQuoteTarget, subscribeQuoteSync } from "./quoteSync";
import type { QuoteInfo } from "./quoteApi";
import { withMockWindow } from "../testUtils";

function quote(patch: Partial<QuoteInfo> = {}): QuoteInfo {
  return {
    symbol: "AAPL",
    name: "Apple Inc.",
    price: 100,
    change: 1,
    changePercent: 0.01,
    open: 99,
    high: 101,
    low: 98,
    prevClose: 99,
    volume: 1000,
    currency: "USD",
    exchange: "NASDAQ",
    isLive: true,
    ...patch,
  };
}

describe("quoteSync", () => {
  afterEach(() => {
    clearQuoteSyncCacheForTests();
  });

  test("emits, subscribes, caches, and expires quote sync payloads", async () => {
    const listeners = new Map<string, Set<EventListener>>();
    await withMockWindow({
      addEventListener: (type: string, listener: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
        return true;
      },
    } as Partial<Window>, async () => {
      const seen: string[] = [];
      const unsubscribe = subscribeQuoteSync((payload) => seen.push(payload.symbol));
      const payload = {
        symbol: "AAPL",
        market: "US",
        range: "1d" as const,
        source: "market" as const,
        quote: quote(),
        refreshedAt: Date.now(),
      };

      emitQuoteSync(payload);
      assert.deepEqual(seen, ["AAPL"]);
      assert.equal(getLatestSyncedQuote({ symbol: "AAPL", market: "US", range: "1d" })?.quote.price, 100);
      unsubscribe();
      emitQuoteSync({ ...payload, quote: quote({ price: 101 }) });
      assert.deepEqual(seen, ["AAPL"]);

      const stale = { ...payload, symbol: "MSFT", refreshedAt: Date.now() - 11 * 60 * 1000 };
      emitQuoteSync(stale);
      assert.equal(getLatestSyncedQuote({ symbol: "MSFT", market: "US", range: "1d" }), null);
    });
  });

  test("compares quote targets by symbol and market", () => {
    assert.equal(isSameQuoteTarget({ symbol: "AAPL", market: "US" }, { symbol: "AAPL", market: "US" }), true);
    assert.equal(isSameQuoteTarget({ symbol: "AAPL", market: "US" }, { symbol: "AAPL", market: "HK" }), false);
  });
});
