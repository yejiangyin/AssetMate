import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import type { FundOrder } from "../utils/fundOrders";
import { settleManualFundOrders } from "./AppContext";

function holding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "g1",
    symbol: "019305",
    name: "测试基金",
    market: "FUND",
    assetType: "fund",
    quantity: 100,
    costPrice: 1,
    currentPrice: 1.2,
    currency: "CNY",
    marketValue: 120,
    todayPnl: 0,
    todayPnlRate: 0,
    totalPnl: 20,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    priceDate: "2026-06-12",
    fundNavHistory: [{ date: "2026-06-12", nav: 1.2 }],
    updatedAt: "2026-06-12T18:00:00+08:00",
    ...patch,
  };
}

function order(patch: Partial<FundOrder> = {}): FundOrder {
  return {
    id: "o1",
    holdingId: "h1",
    symbol: "019305",
    source: "manual",
    entryMode: "submitted",
    side: "buy",
    status: "pending",
    requestedAt: "2026-06-12T06:00:00.000Z",
    requestedDate: "2026-06-12",
    effectiveDate: "2026-06-12",
    requestedAmount: 120,
    estimatedPrice: 1.2,
    expectedConfirmDate: "2026-06-15",
    channelConfirmedAt: "2026-06-15T01:00:00.000Z",
    rule: { tradeStatus: "normal", confirmDays: 1, cutoffMinutes: 900, capturedAt: "2026-06-12T06:00:00.000Z" },
    createdAt: "2026-06-12T06:00:00.000Z",
    updatedAt: "2026-06-12T06:00:00.000Z",
    ...patch,
  };
}

describe("manual fund order settlement", () => {
  test("automatically confirms after T+N when the official effective-date NAV exists", () => {
    const pending = order({ channelConfirmedAt: undefined });
    const settled = settleManualFundOrders([holding()], [], [pending], [], "2026-06-15");
    assert.equal(settled.changed, true);
    assert.equal(settled.orders[0]?.status, "confirmed");
    assert.ok(Math.abs((settled.holdings[0]?.quantity ?? 0) - 200) < 1e-8);
  });

  test("confirms a purchase exactly once and creates its ledger event", () => {
    const first = settleManualFundOrders([holding()], [], [order()], [], "2026-06-15");
    assert.equal(first.changed, true);
    assert.ok(Math.abs((first.holdings[0]?.quantity ?? 0) - 200) < 1e-8);
    assert.equal(first.orders[0]?.status, "confirmed");
    assert.ok(Math.abs((first.orders[0]?.confirmedQuantity ?? 0) - 100) < 1e-8);
    assert.equal(first.portfolioEvents.filter((event) => event.type === "buy").length, 1);

    const second = settleManualFundOrders(first.holdings, first.closedHoldings, first.orders, first.portfolioEvents, "2026-06-16");
    assert.equal(second.changed, false);
    assert.ok(Math.abs((second.holdings[0]?.quantity ?? 0) - 200) < 1e-8);
    assert.equal(second.portfolioEvents.length, first.portfolioEvents.length);
  });

  test("confirms a redemption, archives realized P/L, and removes sold units", () => {
    const redemption = order({
      side: "sell",
      requestedAmount: undefined,
      requestedQuantity: 40,
      expectedConfirmDate: "2026-06-15",
    });
    const settled = settleManualFundOrders([holding()], [], [redemption], [], "2026-06-15");
    assert.equal(settled.holdings[0]?.quantity, 60);
    assert.equal(settled.closedHoldings.length, 1);
    assert.equal(settled.closedHoldings[0]?.quantity, 40);
    assert.equal(settled.portfolioEvents.filter((event) => event.type === "sell").length, 1);
    assert.equal(settled.orders[0]?.confirmedAmount, 48);
  });

  test("keeps orders pending until the effective-date NAV exists", () => {
    const settled = settleManualFundOrders([
      holding({ priceDate: "2026-06-13", fundNavHistory: [] }),
    ], [], [order()], [], "2026-06-15");
    assert.equal(settled.changed, false);
    assert.equal(settled.orders[0]?.status, "pending");
    assert.equal(settled.holdings[0]?.quantity, 100);
  });

  test("uses the transaction-cost snapshot captured when the order was submitted", () => {
    const submitted = order({
      requestedAmount: 121,
      rule: {
        tradeStatus: "normal",
        confirmDays: 1,
        cutoffMinutes: 900,
        transactionCostProfile: { buyFeeRate: 0.01 },
        capturedAt: "2026-06-12T06:00:00.000Z",
      },
    });
    const settled = settleManualFundOrders([
      holding({ transactionCostProfile: { buyFeeRate: 0.5 } }),
    ], [], [submitted], [], "2026-06-15");
    const expectedTradeAmount = 121 / 1.01;
    assert.ok(Math.abs((settled.orders[0]?.confirmedAmount ?? 0) - expectedTradeAmount) < 1e-8);
    assert.ok(Math.abs((settled.orders[0]?.fee ?? 0) - expectedTradeAmount * 0.01) < 1e-8);
    assert.ok(Math.abs((settled.holdings[0]?.quantity ?? 0) - (100 + expectedTradeAmount / 1.2)) < 1e-8);
  });

  test("keeps a later accepted purchase alive when a redemption closes the old units", () => {
    const redemption = order({
      id: "sell-all",
      side: "sell",
      requestedAmount: undefined,
      requestedQuantity: 100,
    });
    const laterPurchase = order({
      id: "later-buy",
      requestedAt: "2026-06-12T07:00:00.000Z",
      effectiveDate: "2026-06-16",
      expectedConfirmDate: "2026-06-17",
    });
    const first = settleManualFundOrders([
      holding({ fundNavHistory: [
        { date: "2026-06-16", nav: 1.25 },
        { date: "2026-06-12", nav: 1.2 },
      ] }),
    ], [], [redemption, laterPurchase], [], "2026-06-15");
    assert.equal(first.holdings.length, 1);
    assert.equal(first.holdings[0]?.quantity, 0);
    assert.equal(first.orders.find((item) => item.id === "sell-all")?.status, "confirmed");
    assert.equal(first.orders.find((item) => item.id === "later-buy")?.status, "pending");

    const second = settleManualFundOrders(first.holdings, first.closedHoldings, first.orders, first.portfolioEvents, "2026-06-17");
    assert.equal(second.orders.find((item) => item.id === "later-buy")?.status, "confirmed");
    assert.ok(Math.abs((second.holdings[0]?.quantity ?? 0) - 96) < 1e-8);
  });

  test("rejects orphan pending orders even when none are ready to confirm", () => {
    const settled = settleManualFundOrders([], [], [order({ expectedConfirmDate: "2026-06-30" })], [], "2026-06-15");
    assert.equal(settled.changed, true);
    assert.equal(settled.orders[0]?.status, "rejected");
    assert.match(settled.orders[0]?.reason ?? "", /持仓不存在/);
  });

  test("rejects an inconsistent redemption instead of silently shrinking its confirmed quantity", () => {
    const redemption = order({ side: "sell", requestedAmount: undefined, requestedQuantity: 120 });
    const settled = settleManualFundOrders([holding()], [], [redemption], [], "2026-06-15");
    assert.equal(settled.orders[0]?.status, "rejected");
    assert.equal(settled.holdings[0]?.quantity, 100);
    assert.equal(settled.closedHoldings.length, 0);
  });
});
