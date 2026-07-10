import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import type { HoldingInput } from "../context/AppContext";
import { applyCorporateAction, applyHoldingAdjustment, buildHolding, normalizeHolding } from "./holdingHelpers";

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
    marketValue: 0,
    todayPnl: 0,
    todayPnlRate: 0,
    totalPnl: 0,
    totalPnlRate: 0,
    tradeStatus: "normal",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

describe("normalizeHolding", () => {
  test("sorts fund NAV history by newest date before trimming", () => {
    const normalized = normalizeHolding(holding({
      fundNavHistory: [
        { date: "2026-05-27", nav: 8.1 },
        { date: "2026-05-29", nav: 8.3 },
        { date: "2026-05-28", nav: 8.2 },
        { date: "", nav: 9 },
        { date: "2026-05-26", nav: Number.NaN },
      ],
    }));

    assert.deepEqual(normalized.fundNavHistory, [
      { date: "2026-05-29", nav: 8.3 },
      { date: "2026-05-28", nav: 8.2 },
      { date: "2026-05-27", nav: 8.1 },
    ]);
    assert.equal(normalized.marketValue, 20);
    assert.equal(normalized.totalPnl, 10);
  });

  test("keeps dividend reinvest preference only for fund holdings", () => {
    assert.equal(normalizeHolding(holding({ dividendReinvest: true })).dividendReinvest, true);
    assert.equal(normalizeHolding(holding({
      symbol: "510300",
      name: "沪深300ETF",
      market: "A",
      assetType: "fund",
      dividendReinvest: true,
    })).dividendReinvest, null);
    assert.equal(normalizeHolding(holding({
      symbol: "AAPL",
      name: "Apple Inc.",
      market: "US",
      assetType: "stock",
      dividendReinvest: true,
    })).dividendReinvest, null);
  });

  test("preserves T+0 fund confirmation rules", () => {
    assert.equal(normalizeHolding(holding({ fundBuyConfirmDays: 0 })).fundBuyConfirmDays, 0);
  });

  test("removes announced A-share dividends that never received an ex-dividend date", () => {
    const normalized = normalizeHolding(holding({
      market: "A",
      symbol: "600900",
      name: "长江电力",
      assetType: "stock",
      cashDividendTotal: 790,
      corporateActions: [{
        id: "eastmoney-stock:cash_dividend:600900:2026-04-30:0.79",
        type: "cash_dividend",
        date: "2026-04-30",
        amount: 790,
        source: "eastmoney-stock",
        announcementDate: "2026-04-30",
      }],
    }));

    assert.equal(normalized.cashDividendTotal, 0);
    assert.deepEqual(normalized.corporateActions, []);
  });

  test("keeps implemented A-share dividends with an ex-dividend date", () => {
    const normalized = normalizeHolding(holding({
      market: "A",
      symbol: "600900",
      name: "长江电力",
      assetType: "stock",
      cashDividendTotal: 7.9,
      corporateActions: [{
        id: "eastmoney-stock:cash_dividend:600900:2026-06-04:0.79",
        type: "cash_dividend",
        date: "2026-06-04",
        amount: 7.9,
        source: "eastmoney-stock",
        announcementDate: "2026-04-30",
        recordDate: "2026-06-03",
        exDate: "2026-06-04",
      }],
    }));

    assert.equal(normalized.cashDividendTotal, 7.9);
    assert.equal(normalized.corporateActions?.length, 1);
    assert.equal(normalized.corporateActions?.[0]?.exDate, "2026-06-04");
  });

  test("keeps holding-level total return including cash dividends for compatibility", () => {
    // 10 shares, cost 1, current 2 → price gain 10; dividends 5 → total 15
    const normalized = normalizeHolding(holding({ cashDividendTotal: 5 }));
    assert.equal(normalized.totalPnl, 15);
    assert.equal(normalized.totalPnlRate, 1.5); // 15 / 10
  });

  test("normalizes a reusable transaction cost profile", () => {
    const normalized = normalizeHolding(holding({
      transactionCostProfile: {
        buyFeeRate: 0.0003,
        sellFeeRate: -1,
        minimumFee: 5,
      },
    }));

    assert.deepEqual(normalized.transactionCostProfile, { buyFeeRate: 0.0003, minimumFee: 5 });
  });

  test("recomputes market metrics while preserving daily P/L fields", () => {
    const normalized = normalizeHolding(holding({
      quantity: 3,
      costPrice: 4,
      currentPrice: 5,
      todayPnl: 1.5,
      todayPnlRate: 0.02,
    }));

    assert.equal(normalized.marketValue, 15);
    assert.equal(normalized.totalPnl, 3);
    assert.equal(normalized.totalPnlRate, 0.25);
    assert.equal(normalized.todayPnl, 1.5);
    assert.equal(normalized.todayPnlRate, 0.02);
  });
});

describe("applyCorporateAction", () => {
  test("records cash dividends and includes them in total P/L", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "cash_dividend",
      date: "2026-06-04",
      amount: 3,
    });

    assert.equal(adjusted.quantity, 10);
    assert.equal(adjusted.costPrice, 1);
    assert.equal(adjusted.cashDividendTotal, 3);
    // totalPnl = (marketValue - costBasis) + cashDividendTotal = 10 + 3 = 13
    assert.equal(adjusted.totalPnl, 13);
    assert.equal(adjusted.corporateActions?.length, 1);
  });

  test("dilutes average cost for bonus shares while preserving invested cost", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "share_dividend",
      date: "2026-06-04",
      shares: 2,
    });

    assert.equal(adjusted.quantity, 12);
    assert.equal(adjusted.costPrice, 10 / 12);
    assert.equal(adjusted.quantity * adjusted.costPrice, 10);
  });

  test("records dividend reinvestment as dividend income plus new cost basis", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "dividend_reinvest",
      date: "2026-06-04",
      amount: 4,
      shares: 2,
      price: 2,
    });

    assert.equal(adjusted.quantity, 12);
    assert.equal(adjusted.cashDividendTotal, 4);
    assert.equal(adjusted.quantity * adjusted.costPrice, 14);
    assert.equal(adjusted.totalPnl, 14);
    assert.equal(adjusted.corporateActions?.[0]?.type, "dividend_reinvest");
  });

  test("records fees and taxes as negative events without increasing dividends", () => {
    const withFee = applyCorporateAction(holding({ cashDividendTotal: 3 }), {
      type: "fee",
      date: "2026-06-04",
      amount: 1.2,
    });
    const withTax = applyCorporateAction(withFee, {
      type: "tax",
      date: "2026-06-05",
      amount: 0.8,
    });

    assert.equal(withTax.cashDividendTotal, 3);
    assert.equal(withTax.corporateActions?.[0]?.amount, -1.2);
    assert.equal(withTax.corporateActions?.[1]?.amount, -0.8);
    // Price gain 10 + dividends 3 - fee/tax 2 = total return 11.
    assert.equal(withTax.totalPnl, 11);
    assert.equal(withTax.totalPnlRate, 1.1);
  });

  test("snapshots the rule used for an actual transaction fee", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "fee",
      date: "2026-07-10",
      amount: 6,
      rateUsed: 0.0003,
      minimumFeeUsed: 5,
      estimatedAmount: 5,
    });

    assert.deepEqual(adjusted.corporateActions?.[0], {
      id: adjusted.corporateActions?.[0]?.id,
      type: "fee",
      date: "2026-07-10",
      recordDate: undefined,
      exDate: undefined,
      payDate: undefined,
      announcementDate: undefined,
      source: undefined,
      note: "",
      description: undefined,
      rateUsed: 0.0003,
      minimumFeeUsed: 5,
      estimatedAmount: 5,
      amount: -6,
    });
  });

  test("applies split ratios while preserving invested cost", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "split",
      date: "2026-06-04",
      ratio: 2,
    });

    assert.equal(adjusted.quantity, 20);
    assert.equal(adjusted.costPrice, 0.5);
    assert.equal(adjusted.quantity * adjusted.costPrice, 10);
    assert.equal(adjusted.corporateActions?.[0]?.ratio, 2);
  });
});

describe("buildHolding", () => {
  test("builds normalized holdings with computed metrics", () => {
    const input: HoldingInput = {
      groupId: "g1",
      symbol: "700.HK",
      name: "Tencent",
      market: "HK",
      assetType: "stock",
      quantity: 2,
      costPrice: 300,
      currentPrice: 350,
      currency: "HKD",
      tradeStatus: "normal",
      dividendReinvest: true,
      transactionCostProfile: { buyFeeRate: 0.0003, minimumFee: 5 },
    };

    const built = buildHolding(input, "new-id");

    assert.equal(built.id, "new-id");
    assert.equal(built.symbol, "00700");
    assert.equal(built.marketValue, 700);
    assert.equal(built.totalPnl, 100);
    assert.equal(built.totalPnlRate, 100 / 600);
    assert.equal(built.dividendReinvest, null);
    assert.deepEqual(built.transactionCostProfile, { buyFeeRate: 0.0003, minimumFee: 5 });
  });
});

describe("applyHoldingAdjustment", () => {
  test("buys shares by recalculating weighted average cost", () => {
    const adjusted = applyHoldingAdjustment(holding(), { type: "buy", quantity: 10, price: 3 });

    assert.equal(adjusted?.quantity, 20);
    assert.equal(adjusted?.costPrice, 2);
    assert.equal(adjusted?.marketValue, 40);
  });

  test("sells shares without changing remaining average cost", () => {
    const adjusted = applyHoldingAdjustment(holding(), { type: "sell", quantity: 4, price: 3 });

    assert.equal(adjusted?.quantity, 6);
    assert.equal(adjusted?.costPrice, 1);
    assert.equal(adjusted?.marketValue, 12);
  });

  test("returns null when a sale closes the whole position", () => {
    assert.equal(applyHoldingAdjustment(holding(), { type: "sell", quantity: 10, price: 3 }), null);
    assert.equal(applyHoldingAdjustment(holding(), { type: "sell", quantity: 99, price: 3 }), null);
  });

  test("ignores invalid adjustment quantities or prices", () => {
    const base = holding();
    assert.equal(applyHoldingAdjustment(base, { type: "buy", quantity: 0, price: 3 }), base);
    assert.equal(applyHoldingAdjustment(base, { type: "buy", quantity: 1, price: 0 }), base);
  });
});
