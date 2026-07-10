import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PortfolioEvent } from "../services/portfolioEvents";
import { breakdownBarWidth, formatCompactCny, hasMeaningfulReturnData, returnEventValue } from "./returnsPresentation";

function event(type: PortfolioEvent["type"], amountInBase: number): PortfolioEvent {
  return {
    id: `${type}-1`,
    date: "2026-07-10",
    type,
    amount: amountInBase,
    amountInBase,
    currency: "CNY",
    source: "manual",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("returns presentation", () => {
  test("uses one compact money scale for summaries and calendar cells", () => {
    assert.equal(formatCompactCny(999.5, false, "zh-CN"), "+¥999.50");
    assert.equal(formatCompactCny(5_000, false, "zh-CN"), "+¥5k");
    assert.equal(formatCompactCny(-15_500, false, "zh-CN"), "-¥1.6万");
    assert.equal(formatCompactCny(125_000_000, false, "zh-CN"), "+¥1.3亿");
  });

  test("keeps bars visible when every source is negative", () => {
    const rows = [{ value: -80 }, { value: -20 }, { value: 0 }];
    assert.equal(breakdownBarWidth(-80, rows), 80);
    assert.equal(breakdownBarWidth(-20, rows), 20);
    assert.equal(breakdownBarWidth(0, rows), 0);
  });

  test("reads return-producing event values without recomputing a breakdown", () => {
    assert.equal(returnEventValue(event("sell", 30)), 30);
    assert.equal(returnEventValue(event("cash_dividend", 10)), 10);
    assert.equal(returnEventValue(event("fee", -2)), -2);
    assert.equal(returnEventValue(event("buy", 100)), 0);
  });

  test("treats zero-only snapshots left after clearing as empty", () => {
    const zeroSnapshot = [{ date: "2026-07-10", totalAsset: 0, todayPnl: 0, cumulativePnl: 0 }];
    assert.equal(hasMeaningfulReturnData(0, 0, zeroSnapshot), false);
    assert.equal(hasMeaningfulReturnData(1, 0, zeroSnapshot), true);
    assert.equal(hasMeaningfulReturnData(0, 1, zeroSnapshot), true);
    assert.equal(hasMeaningfulReturnData(0, 0, [{ ...zeroSnapshot[0]!, totalPnl: 10 }]), true);
  });
});
