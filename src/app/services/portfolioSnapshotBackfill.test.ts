import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import type { PortfolioEvent } from "./portfolioEvents";
import { backfillPortfolioSnapshots, collectMissingSnapshotDates } from "./portfolioSnapshotBackfill";

const holding: Holding = {
  id: "holding-aapl",
  groupId: "g",
  symbol: "AAPL",
  name: "Apple",
  market: "US",
  assetType: "stock",
  quantity: 5,
  costPrice: 10,
  currentPrice: 15,
  currency: "CNY",
  marketValue: 75,
  todayPnl: 0,
  todayPnlRate: 0,
  totalPnl: 25,
  totalPnlRate: 0.5,
  tradeStatus: "normal",
  updatedAt: "2026-07-21T00:00:00.000Z",
};

const sellEvent: PortfolioEvent = {
  id: "sell-1",
  date: "2026-07-21",
  holdingId: holding.id,
  symbol: holding.symbol,
  name: holding.name,
  market: holding.market,
  assetType: holding.assetType,
  type: "sell",
  quantity: 5,
  price: 12,
  amount: 10,
  amountInBase: 10,
  currency: "CNY",
  source: "manual",
  costBasisAtEvent: 50,
  proceeds: 60,
  createdAt: "2026-07-21T10:00:00.000Z",
};

describe("portfolio snapshot backfill", () => {
  test("finds every interior and trailing calendar gap without duplicating snapshots", () => {
    assert.deepEqual(
      collectMissingSnapshotDates(
        ["2026-07-17", "2026-07-19"],
        ["2026-07-18", "2026-07-20"],
        "2026-07-22",
      ),
      ["2026-07-18", "2026-07-20", "2026-07-21"],
    );
  });

  test("reconstructs a pre-sale position and carries the latest close across non-trading days", async () => {
    const result = await backfillPortfolioSnapshots({
      dates: ["2026-07-18", "2026-07-19"],
      holdings: [holding],
      events: [sellEvent],
      baseline: { daily: {}, realizedCostBasis: 0 },
      fetchPrices: async () => [{ date: "2026-07-17", price: 12 }],
    });

    assert.deepEqual(result.completedDates, ["2026-07-18", "2026-07-19"]);
    assert.deepEqual(result.failedDates, []);
    assert.equal(result.snapshots[0]?.totalAsset, 120);
    assert.equal(result.snapshots[0]?.unrealizedPnl, 20);
    assert.equal(result.snapshots[1]?.totalAsset, 120);
    assert.equal(result.snapshots[0]?.estimated, true);
  });

  test("does not mark a date complete when an active position has no historical price", async () => {
    const result = await backfillPortfolioSnapshots({
      dates: ["2026-07-20"],
      holdings: [holding],
      events: [],
      baseline: { daily: {}, realizedCostBasis: 0 },
      fetchPrices: async () => [],
    });

    assert.deepEqual(result.completedDates, []);
    assert.deepEqual(result.failedDates, ["2026-07-20"]);
    assert.deepEqual(result.snapshots, []);
  });

  test("repeated runs are deterministic and do not mutate holdings", async () => {
    const before = structuredClone(holding);
    const input = {
      dates: ["2026-07-20"],
      holdings: [holding],
      events: [] as PortfolioEvent[],
      baseline: { daily: {}, realizedCostBasis: 0 },
      fetchPrices: async () => [{ date: "2026-07-20", price: 14 }],
    };
    const first = await backfillPortfolioSnapshots(input);
    const second = await backfillPortfolioSnapshots(input);
    assert.deepEqual(first.snapshots, second.snapshots);
    assert.deepEqual(holding, before);
  });
});
