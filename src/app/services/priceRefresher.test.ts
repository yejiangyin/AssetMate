import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FX, groupRefreshTargets, mapWithConcurrency } from "./priceRefresher";

describe("FX defaults", () => {
  test("keeps stablecoin rates aligned with USD at initialization", () => {
    assert.equal(FX.USDT, FX.USD);
    assert.equal(FX.USDC, FX.USD);
    assert.equal(FX.CNY, 1);
  });
});

describe("groupRefreshTargets", () => {
  test("returns an empty list for empty input", () => {
    assert.deepEqual(groupRefreshTargets([]), []);
  });

  test("dedupes identical market/symbol requests while preserving holding ids", () => {
    const targets = groupRefreshTargets([
      { id: "h1", symbol: "006479", market: "FUND" },
      { id: "h2", symbol: "006479", market: "FUND" },
      { id: "h3", symbol: "AAPL", market: "US" },
    ]);

    assert.equal(targets.length, 2);
    assert.deepEqual(targets.find((item) => item.key === "FUND:006479")?.ids, ["h1", "h2"]);
    assert.deepEqual(targets.find((item) => item.key === "US:AAPL")?.ids, ["h3"]);
  });

  test("filters incomplete holdings and uppercases grouping keys", () => {
    const targets = groupRefreshTargets([
      { id: "", symbol: "AAPL", market: "US" },
      { id: "missing-symbol", symbol: " ", market: "US" },
      { id: "missing-market", symbol: "AAPL", market: "" },
      { id: "h1", symbol: "aapl", market: "US" },
      { id: "h2", symbol: "AAPL", market: "US" },
    ]);

    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.key, "US:AAPL");
    assert.equal(targets[0]?.symbol, "aapl");
    assert.deepEqual(targets[0]?.ids, ["h1", "h2"]);
  });
});

describe("mapWithConcurrency", () => {
  test("returns an empty result for empty input", async () => {
    const results = await mapWithConcurrency([], 2, async (value: number) => value * 2);
    assert.deepEqual(results, []);
  });

  test("handles inputs smaller than the concurrency limit", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (value) => value + 1);
    assert.deepEqual(results.map((item) => item.status === "fulfilled" ? item.value : null), [2, 3]);
  });

  test("keeps concurrent work below the requested limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(results.map((item) => item.status === "fulfilled" ? item.value : null), [2, 4, 6, 8, 10]);
  });

  test("captures mapper rejections without aborting remaining work", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("boom");
      return value * 2;
    });

    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected");
    assert.equal(results[2]?.status, "fulfilled");
  });

  test("treats non-positive limits as a single worker", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3], 0, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return value;
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(results.map((item) => item.status === "fulfilled" ? item.value : null), [1, 2, 3]);
  });
});
