import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import { applyCorporateAction, normalizeHolding } from "./holdingHelpers";

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
});

describe("applyCorporateAction", () => {
  test("records cash dividends without changing holding P/L, quantity, or cost", () => {
    const adjusted = applyCorporateAction(holding(), {
      type: "cash_dividend",
      date: "2026-06-04",
      amount: 3,
    });

    assert.equal(adjusted.quantity, 10);
    assert.equal(adjusted.costPrice, 1);
    assert.equal(adjusted.cashDividendTotal, 3);
    assert.equal(adjusted.totalPnl, 10);
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
});
