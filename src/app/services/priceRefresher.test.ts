import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { groupRefreshTargets, mapWithConcurrency } from "./priceRefresher";

describe("groupRefreshTargets", () => {
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
});

describe("mapWithConcurrency", () => {
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
});
