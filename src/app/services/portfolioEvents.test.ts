import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClosedHolding, Holding } from "../data/mockData";
import type { PortfolioEvent } from "./portfolioEvents";
import { compactPortfolioEventHistory, computeBaselineBreakdown, computeReturnBreakdown, getDailyReturns, getHoldingReturnContributions, getMonthlyReturns, getYearlyReturns, migratePortfolioEvents } from "./portfolioEvents";

function holding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "",
    symbol: "006479",
    name: "广发纳斯达克100ETF联接人民币(QDII)C",
    market: "FUND",
    assetType: "fund",
    quantity: 10,
    costPrice: 1,
    currentPrice: 2,
    currency: "CNY",
    marketValue: 20,
    todayPnl: 0,
    todayPnlRate: 0,
    totalPnl: 10,
    totalPnlRate: 1,
    cashDividendTotal: 0,
    corporateActions: [],
    tradeStatus: "normal",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

function closedHolding(patch: Partial<ClosedHolding> = {}): ClosedHolding {
  return {
    id: "c1",
    sourceHoldingId: "h1",
    groupId: "",
    symbol: "006479",
    name: "广发纳斯达克100ETF联接人民币(QDII)C",
    market: "FUND",
    assetType: "fund",
    quantity: 10,
    costPrice: 100,
    closePrice: 120,
    costBasis: 1000,
    proceeds: 1200,
    realizedPnl: 250,
    realizedReturn: 0.25,
    cashDividendTotal: 50,
    currency: "CNY",
    openedAt: "2026-01-01",
    closedAt: "2026-07-01",
    ...patch,
  };
}

describe("migratePortfolioEvents", () => {
  test("migrates closed holdings as pure trading gains so dividends are not double counted", () => {
    const events = migratePortfolioEvents([
      holding({
        cashDividendTotal: 50,
        corporateActions: [{
          id: "div1",
          type: "cash_dividend",
          date: "2026-06-01",
          amount: 50,
        }],
      }),
    ], [closedHolding({ cashDividendTotal: 0, realizedPnl: 200, realizedReturn: 0.2 })], []);

    const breakdown = computeReturnBreakdown(events);
    assert.equal(events.find((event) => event.type === "sell")?.amount, 200);
    assert.equal(breakdown.realizedTradingPnl, 200);
    assert.equal(breakdown.dividendPnl, 50);
  });

  test("recognizes legacy auto dividend reinvest actions stored as share dividends", () => {
    const events = migratePortfolioEvents([
      holding({
        cashDividendTotal: 20,
        corporateActions: [{
          id: "reinvest1",
          type: "share_dividend",
          date: "2026-06-01",
          amount: 20,
          shares: 5,
          price: 4,
          note: "auto dividend reinvest",
        }],
      }),
    ], [], []);

    const reinvest = events.find((event) => event.type === "dividend_reinvest");
    assert.ok(reinvest);
    assert.equal(reinvest.amount, 20);
    assert.equal(reinvest.quantity, 5);
    assert.equal(computeReturnBreakdown(events).dividendPnl, 20);
  });

  test("does not duplicate a manually recorded corporate-action fee during migration", () => {
    const existingFee = {
      id: "manual:corp:fee1",
      date: "2026-06-01",
      holdingId: "h1",
      symbol: "006479",
      name: "广发纳斯达克100ETF联接人民币(QDII)C",
      market: "FUND",
      assetType: "fund",
      type: "fee" as const,
      amount: -2,
      amountInBase: -2,
      currency: "CNY",
      source: "manual" as const,
      corporateActionId: "fee1",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const events = migratePortfolioEvents([
      holding({
        corporateActions: [{ id: "fee1", type: "fee", date: "2026-06-01", amount: -2 }],
      }),
    ], [], [], [existingFee]);

    assert.equal(events.filter((event) => event.type === "fee").length, 1);
    assert.equal(computeReturnBreakdown(events).feePnl, -2);
  });

  test("migrates recorded sale fees and taxes as separate return events", () => {
    const events = migratePortfolioEvents([], [closedHolding({
      cashDividendTotal: 0,
      realizedPnl: 192,
      transactionFee: 3,
      transactionTax: 5,
    })], []);
    const breakdown = computeReturnBreakdown(events);

    assert.equal(breakdown.realizedTradingPnl, 200);
    assert.equal(breakdown.transactionFeePnl, -3);
    assert.equal(breakdown.taxPnl, -5);
    assert.equal(breakdown.feePnl, -8);
    assert.equal(events.filter((event) => event.type === "fee").length, 1);
    assert.equal(events.filter((event) => event.type === "tax").length, 1);
  });

  test("reuses an existing manual sell event instead of duplicating it on reload", () => {
    const existingSell: PortfolioEvent = {
      id: "manual:sell:h1:2026-07-01:10:120:1",
      date: "2026-07-01",
      holdingId: "h1",
      symbol: "006479",
      name: "测试基金",
      market: "FUND",
      assetType: "fund",
      type: "sell",
      quantity: 10,
      price: 120,
      amount: 200,
      amountInBase: 200,
      currency: "CNY",
      source: "manual",
      costBasisAtEvent: 1000,
      proceeds: 1200,
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const events = migratePortfolioEvents([], [closedHolding()], [], [existingSell]);

    assert.equal(events.filter((event) => event.type === "sell").length, 1);
    assert.equal(events.find((event) => event.type === "sell")?.id, existingSell.id);
    assert.equal(events.find((event) => event.type === "sell")?.relatedEventId, "c1");
  });

  test("does not add summary dividends for migrated dividend reinvest, interest, or bond coupon actions", () => {
    const events = migratePortfolioEvents([
      holding({
        cashDividendTotal: 60,
        corporateActions: [{
          id: "reinvest1",
          type: "dividend_reinvest",
          date: "2026-06-01",
          amount: 20,
          shares: 5,
          price: 4,
        }, {
          id: "interest1",
          type: "interest",
          date: "2026-06-02",
          amount: 15,
        }, {
          id: "coupon1",
          type: "bond_coupon",
          date: "2026-06-03",
          amount: 25,
        }],
      }),
    ], [], []);

    assert.equal(computeReturnBreakdown(events).dividendPnl, 60);
    assert.equal(events.some((event) => event.id.includes("cash-dividend-summary")), false);
  });

  test("backfills only the missing dividend delta when existing events are present", () => {
    const events = migratePortfolioEvents([
      holding({ cashDividendTotal: 15 }),
    ], [], [], [{
      id: "manual-dividend-old",
      date: "2026-05-01",
      holdingId: "h1",
      symbol: "006479",
      name: "广发纳斯达克100ETF联接人民币(QDII)C",
      market: "FUND",
      assetType: "fund",
      type: "cash_dividend",
      amount: 10,
      amountInBase: 10,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);

    assert.equal(computeReturnBreakdown(events).dividendPnl, 15);
    assert.equal(events.find((event) => event.id.includes("cash-dividend-summary"))?.amount, 5);
  });

  test("keeps later dividend delta summaries even when the delta amount repeats", () => {
    const events = migratePortfolioEvents([
      holding({ cashDividendTotal: 20 }),
    ], [], [], [{
      id: "manual-dividend-old",
      date: "2026-05-01",
      holdingId: "h1",
      symbol: "006479",
      name: "广发纳斯达克100ETF联接人民币(QDII)C",
      market: "FUND",
      assetType: "fund",
      type: "cash_dividend",
      amount: 10,
      amountInBase: 10,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-05-01T00:00:00.000Z",
    }, {
      id: "migration:cash-dividend-summary:h1:2026-06-01:15:5",
      date: "2026-06-01",
      holdingId: "h1",
      symbol: "006479",
      name: "广发纳斯达克100ETF联接人民币(QDII)C",
      market: "FUND",
      assetType: "fund",
      type: "cash_dividend",
      amount: 5,
      amountInBase: 5,
      currency: "CNY",
      source: "migration",
      createdAt: "2026-06-01T00:00:00.000Z",
    }]);

    assert.equal(computeReturnBreakdown(events).dividendPnl, 20);
    assert.equal(events.filter((event) => event.id.includes("cash-dividend-summary")).length, 2);
  });

  test("migrates closed holding dividend metadata as realized dividend events", () => {
    const events = migratePortfolioEvents([], [closedHolding({ cashDividendTotal: 50 })], []);
    const breakdown = computeReturnBreakdown(events);

    assert.equal(breakdown.realizedTradingPnl, 200);
    assert.equal(breakdown.dividendPnl, 50);
    assert.ok(events.some((event) => event.id.includes("closed-dividend-summary") && event.amount === 50));
  });
});

describe("return aggregations", () => {
  test("aggregates daily, monthly, and yearly returns from snapshots and events", () => {
    const daily = getDailyReturns([{
      id: "sell1",
      date: "2026-07-02",
      type: "sell",
      amount: 30,
      amountInBase: 30,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-07-02T00:00:00.000Z",
    }, {
      id: "div1",
      date: "2026-07-02",
      type: "cash_dividend",
      amount: 10,
      amountInBase: 10,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-07-02T00:00:00.000Z",
    }, {
      id: "fee1",
      date: "2026-08-01",
      type: "fee",
      amount: -2,
      amountInBase: -2,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-08-01T00:00:00.000Z",
    }], [{
      date: "2026-07-01",
      totalAsset: 1000,
      todayPnl: 0,
      cumulativePnl: 100,
      unrealizedPnl: 100,
      realizedTradingPnl: 0,
      dividendPnl: 0,
      feePnl: 0,
      totalPnl: 100,
    }, {
      date: "2026-07-02",
      totalAsset: 1080,
      todayPnl: 0,
      cumulativePnl: 180,
      unrealizedPnl: 140,
      realizedTradingPnl: 30,
      dividendPnl: 10,
      feePnl: 0,
      totalPnl: 180,
    }, {
      date: "2026-08-01",
      totalAsset: 1078,
      todayPnl: 0,
      cumulativePnl: 178,
      unrealizedPnl: 140,
      realizedTradingPnl: 30,
      dividendPnl: 10,
      feePnl: -2,
      totalPnl: 178,
    }]);

    assert.equal(daily[0]?.totalPnl, 0);
    assert.equal(daily[1]?.unrealizedPnlChange, 40);
    assert.equal(daily[1]?.totalPnl, 80);
    assert.equal(daily[2]?.feePnl, -2);
    assert.equal(daily[2]?.totalPnl, -2);

    const monthly = getMonthlyReturns(daily);
    assert.equal(monthly[0]?.month, "2026-07");
    assert.equal(monthly[0]?.totalPnl, 80);
    assert.equal(monthly[1]?.month, "2026-08");
    assert.equal(monthly[1]?.totalPnl, -2);

    const yearly = getYearlyReturns(daily);
    assert.equal(yearly[0]?.year, "2026");
    assert.equal(yearly[0]?.totalPnl, 78);
  });

  test("keeps event-only dates in period totals when no snapshot exists", () => {
    const daily = getDailyReturns([{
      id: "div-only",
      date: "2026-07-03",
      type: "cash_dividend",
      amount: 12,
      amountInBase: 12,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-07-03T00:00:00.000Z",
    }], [{
      date: "2026-07-01",
      totalAsset: 1000,
      todayPnl: 0,
      cumulativePnl: 100,
      unrealizedPnl: 100,
    }]);

    const eventOnly = daily.find((row) => row.date === "2026-07-03");
    assert.ok(eventOnly);
    assert.equal(eventOnly.dividendPnl, 12);
    assert.equal(eventOnly.totalPnl, 12);
    assert.equal(eventOnly.totalAsset, 1000);
    assert.equal(eventOnly.incompleteBreakdown, true);
    assert.equal(getMonthlyReturns(daily)[0]?.totalPnl, 12);
  });

  test("treats the first imported snapshot as a baseline instead of same-day profit", () => {
    const daily = getDailyReturns([], [{
      date: "2026-07-01",
      totalAsset: 1200,
      todayPnl: 0,
      cumulativePnl: 200,
      unrealizedPnl: 200,
      migratedBaseline: true,
    }]);

    assert.equal(daily[0]?.unrealizedPnlChange, 0);
    assert.equal(daily[0]?.totalPnl, 0);
    assert.equal(daily[0]?.incompleteBreakdown, true);
  });

  test("preserves pruned returns in a dated baseline", () => {
    const events: PortfolioEvent[] = [
      { id: "old-sell", date: "2026-01-01", type: "sell", amount: 20, amountInBase: 20, currency: "CNY", source: "manual", costBasisAtEvent: 100, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "old-tax", date: "2026-01-01", type: "tax", amount: -2, amountInBase: -2, currency: "CNY", source: "manual", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "new-div", date: "2026-02-01", type: "cash_dividend", amount: 5, amountInBase: 5, currency: "CNY", source: "auto", createdAt: "2026-02-01T00:00:00.000Z" },
    ];
    const compacted = compactPortfolioEventHistory(events, { daily: {}, realizedCostBasis: 0 }, 1);
    assert.deepEqual(compacted.events.map((event) => event.id), ["new-div"]);
    assert.equal(computeBaselineBreakdown(compacted.baseline).realizedTradingPnl, 20);
    assert.equal(computeBaselineBreakdown(compacted.baseline).taxPnl, -2);
    assert.equal(compacted.baseline.realizedCostBasis, 100);
    const daily = getDailyReturns(compacted.events, [], compacted.baseline);
    assert.equal(daily.find((row) => row.date === "2026-01-01")?.totalPnl, 18);
  });

  test("calculates period holding ranking from holding snapshots and realized events", () => {
    const contributions = getHoldingReturnContributions([{
      id: "sell-h1",
      date: "2026-07-02",
      holdingId: "h1",
      type: "sell",
      amount: 30,
      amountInBase: 30,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-07-02T00:00:00.000Z",
    }, {
      id: "div-h2",
      date: "2026-07-02",
      holdingId: "h2",
      type: "cash_dividend",
      amount: 10,
      amountInBase: 10,
      currency: "CNY",
      source: "auto",
      createdAt: "2026-07-02T00:00:00.000Z",
    }], [{
      date: "2026-06-30",
      totalAsset: 1000,
      todayPnl: 0,
      cumulativePnl: 0,
      holdingUnrealizedPnl: { h1: 100, h2: 40 },
    }, {
      date: "2026-07-02",
      totalAsset: 1100,
      todayPnl: 0,
      cumulativePnl: 100,
      holdingUnrealizedPnl: { h1: 120, h2: 35 },
    }], "2026-07-01", "2026-07-31");

    assert.equal(contributions[0]?.id, "h1");
    assert.equal(contributions[0]?.unrealizedPnlChange, 20);
    assert.equal(contributions[0]?.realizedTradingPnl, 30);
    assert.equal(contributions[0]?.totalPnl, 50);
    assert.equal(contributions[1]?.id, "h2");
    assert.equal(contributions[1]?.totalPnl, 5);
    assert.equal(contributions[0]?.incompleteBreakdown, undefined);
  });
});
