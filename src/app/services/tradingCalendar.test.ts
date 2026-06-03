import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calcNextExecutions, isHalfTradingDay, isMarketOpenNow, isTradingDay, refreshTradingCalendar } from "./tradingCalendar";

describe("tradingCalendar", () => {
  test("uses algorithmic US holidays beyond the hard-coded table", () => {
    assert.equal(isTradingDay("US", new Date(2027, 6, 5)), false);
    assert.equal(isTradingDay("US", new Date(2027, 6, 6)), true);
  });

  test("guards schedule previews from unbounded scans", () => {
    const next = calcNextExecutions("US", {
      frequency: "monthly",
      dayOfMonth: 15,
      startDate: "2026-01-01",
    }, 5, new Date(2026, 5, 1), false);

    assert.equal(next.length, 5);
    assert.equal(next[0]?.scheduled, "2026-06-15");
  });

  test("uses remote half-day calendar for market-open checks", async () => {
    const storage = new Map<string, string>();
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    globalThis.window = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
      setTimeout,
      clearTimeout,
    } as any;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        result: {
          data: [{
            MKT: "港股",
            HOLIDAY: "圣诞前夕(13:00收市)",
            SDATE: "2026-12-24 00:00:00",
            EDATE: "2026-12-24 00:00:00",
            XS: "1",
          }],
        },
      }),
    })) as any;

    try {
      await refreshTradingCalendar(true);
      const halfDay = new Date("2026-12-24T03:00:00Z");
      const afternoon = new Date("2026-12-24T06:00:00Z");
      assert.equal(isHalfTradingDay("HK", halfDay), true);
      assert.equal(isMarketOpenNow("HK", halfDay), true);
      assert.equal(isMarketOpenNow("HK", afternoon), false);
    } finally {
      globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
    }
  });
});
