import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import { collectStaleSnapshotDates } from "./staleSnapshotDetector";

function fundHolding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "",
    symbol: "006479",
    name: "测试基金",
    market: "FUND",
    assetType: "fund",
    quantity: 10,
    costPrice: 1,
    currentPrice: 1.2,
    currency: "CNY",
    marketValue: 12,
    todayPnl: 0,
    todayPnlRate: 0,
    totalPnl: 2,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...patch,
  };
}

describe("collectStaleSnapshotDates", () => {
  test("returns existing snapshot dates inside the NAV advancement gap", () => {
    const before = [fundHolding({
      fundNavHistory: [{ date: "2026-07-29", nav: 1.1 }],
    })];
    const after = [fundHolding({
      fundNavHistory: [{ date: "2026-07-30", nav: 1.2 }, { date: "2026-07-29", nav: 1.1 }],
    })];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-29", "2026-07-30"], "2026-07-31");

    assert.deepEqual(stale, ["2026-07-30"]);
  });

  test("skips non-fund holdings", () => {
    const before = [{
      ...fundHolding({ market: "US", assetType: "stock" as const, fundNavHistory: undefined }),
    }];
    const after = [{
      ...fundHolding({ market: "US", assetType: "stock" as const, fundNavHistory: undefined }),
    }];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-30"], "2026-07-31");
    assert.deepEqual(stale, []);
  });

  test("returns empty when NAV has not advanced", () => {
    const before = [fundHolding({
      fundNavHistory: [{ date: "2026-07-30", nav: 1.2 }],
    })];
    const after = [fundHolding({
      fundNavHistory: [{ date: "2026-07-30", nav: 1.2 }],
    })];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-30"], "2026-07-31");
    assert.deepEqual(stale, []);
  });

  test("excludes dates on or after today", () => {
    const before = [fundHolding({
      fundNavHistory: [{ date: "2026-07-29", nav: 1.1 }],
    })];
    const after = [fundHolding({
      fundNavHistory: [{ date: "2026-07-31", nav: 1.3 }, { date: "2026-07-29", nav: 1.1 }],
    })];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-30", "2026-07-31"], "2026-07-31");
    assert.deepEqual(stale, ["2026-07-30"]);
  });

  test("returns empty when before holding has no fundNavHistory", () => {
    const before = [fundHolding({ fundNavHistory: undefined })];
    const after = [fundHolding({
      fundNavHistory: [{ date: "2026-07-30", nav: 1.2 }],
    })];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-30"], "2026-07-31");
    assert.deepEqual(stale, []);
  });

  test("uses the prior price date when legacy fund NAV history is missing", () => {
    const before = [fundHolding({ priceDate: "2026-07-29", fundNavHistory: undefined })];
    const after = [fundHolding({
      priceDate: "2026-07-30",
      fundNavHistory: [{ date: "2026-07-30", nav: 1.2 }],
    })];

    const stale = collectStaleSnapshotDates(before, after, ["2026-07-30"], "2026-07-31");
    assert.deepEqual(stale, ["2026-07-30"]);
  });
});
