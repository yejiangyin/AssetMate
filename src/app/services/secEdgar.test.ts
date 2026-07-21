import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calculateSecFreeCashFlow, fetchSecFinancialHistory, resetSecEdgarStateForTests } from "./secEdgar";

describe("SEC financial normalization", () => {
  test("subtracts positive capital expenditure cash outflows from operating cash flow", () => {
    assert.equal(calculateSecFreeCashFlow(110_543_000_000, 10_959_000_000), 99_584_000_000);
  });

  test("does not invent free cash flow when either component is unavailable", () => {
    assert.equal(calculateSecFreeCashFlow(undefined, 10), undefined);
    assert.equal(calculateSecFreeCashFlow(10, undefined), undefined);
  });
});

describe("SEC request coordination", () => {
  test("coalesces concurrent financial-history loads and reuses the result cache", async () => {
    resetSecEdgarStateForTests();
    const originalFetch = globalThis.fetch;
    let tickerMapCalls = 0;
    const conceptCalls = new Map<string, number>();
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("company_tickers.json")) {
        tickerMapCalls += 1;
        return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      conceptCalls.set(url, (conceptCalls.get(url) ?? 0) + 1);
      const point = { form: "10-K", fy: 2025, val: 100, filed: "2026-01-30" };
      return new Response(JSON.stringify({ units: { USD: [point], "USD/shares": [point] } }), {
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const [first, second] = await Promise.all([
        fetchSecFinancialHistory("AAPL"),
        fetchSecFinancialHistory("AAPL"),
      ]);
      assert.equal(first?.cik, "0000320193");
      assert.deepEqual(second, first);
      assert.equal(tickerMapCalls, 1);
      assert.ok(conceptCalls.size > 5);
      assert.equal([...conceptCalls.values()].every((count) => count === 1), true);

      const callsAfterFirstLoad = conceptCalls.size;
      assert.deepEqual(await fetchSecFinancialHistory("AAPL"), first);
      assert.equal(conceptCalls.size, callsAfterFirstLoad);
      assert.equal(tickerMapCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      resetSecEdgarStateForTests();
    }
  });

  test("retries a throttled SEC request using Retry-After", async () => {
    resetSecEdgarStateForTests();
    const originalFetch = globalThis.fetch;
    let tickerMapCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("company_tickers.json")) {
        tickerMapCalls += 1;
        if (tickerMapCalls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
        return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      assert.equal(await fetchSecFinancialHistory("UNKNOWN"), null);
      assert.equal(tickerMapCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      resetSecEdgarStateForTests();
    }
  });
});
