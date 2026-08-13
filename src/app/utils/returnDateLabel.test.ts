import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import { latestPnlDateLabel } from "./returnDateLabel";

function fund(patch: Partial<Holding> = {}): Holding {
  return {
    id: "fund", groupId: "", symbol: "006479", name: "QDII", market: "FUND", assetType: "fund",
    quantity: 10, costPrice: 1, currentPrice: 1.2, currency: "CNY", marketValue: 12,
    todayPnl: 1, todayPnlRate: 0.1, totalPnl: 2, totalPnlRate: 0.2,
    tradeStatus: "normal", updatedAt: "2026-08-08T00:00:00.000Z",
    ...patch,
  };
}

describe("latestPnlDateLabel", () => {
  test("labels the previous calendar day as yesterday", () => {
    assert.equal(latestPnlDateLabel(fund({ priceDate: "2026-08-07" }), "2026-08-08", "zh"), "昨日");
    assert.equal(latestPnlDateLabel(fund({ priceDate: "2026-08-07" }), "2026-08-08", "en"), "Yesterday");
  });

  test("uses an explicit date across weekends and longer publication gaps", () => {
    assert.equal(latestPnlDateLabel(fund({ priceDate: "2026-08-07" }), "2026-08-10", "zh"), "8月7日");
    assert.equal(latestPnlDateLabel(fund({ priceDate: "2025-12-31" }), "2026-01-05", "zh"), "2025年12月31日");
  });

  test("marks a same-day estimated NAV but not a same-day official NAV", () => {
    assert.equal(latestPnlDateLabel(fund({
      priceDate: "2026-08-10", currentPrice: 1.25, estimatedNav: 1.25, estimatedNavAt: "2026-08-10 14:30",
    }), "2026-08-10", "zh"), "估值");
    assert.equal(latestPnlDateLabel(fund({ priceDate: "2026-08-10", currentPrice: 1.2, estimatedNav: 1.25 }), "2026-08-10", "zh"), null);
  });

  test("does not claim a date when provenance is unavailable", () => {
    assert.equal(latestPnlDateLabel(fund({ priceDate: undefined }), "2026-08-10", "zh"), null);
    assert.equal(latestPnlDateLabel(fund({ priceDate: "invalid" }), "2026-08-10", "zh"), null);
  });
});
