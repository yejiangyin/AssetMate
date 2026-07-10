import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyAutomaticCorporateActions,
  buildClosedHolding,
  computeStats,
  loadInitialState,
  resolveFundDividendReinvestPrice,
} from "./AppContext";
import type { Holding } from "../data/mockData";
import type { PortfolioEvent } from "../services/portfolioEvents";
import { createDCAPlan, createLocalStorageMock, withMockWindow } from "../testUtils";

function holding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "g1",
    symbol: "AAPL",
    name: "Apple Inc.",
    market: "US",
    assetType: "stock",
    quantity: 10,
    costPrice: 100,
    currentPrice: 120,
    currency: "USD",
    marketValue: 1200,
    todayPnl: 5,
    todayPnlRate: 0.01,
    totalPnl: 200,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    cashDividendTotal: 10,
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

describe("automatic corporate actions", () => {
  const fundHolding = (patch: Partial<Holding> = {}) => holding({
    symbol: "006479",
    name: "测试基金",
    market: "FUND",
    assetType: "fund",
    currency: "CNY",
    quantity: 10,
    costPrice: 1,
    currentPrice: 3,
    marketValue: 30,
    cashDividendTotal: 0,
    dividendReinvest: true,
    autoCorporateActionSince: "2026-06-01",
    corporateActions: [],
    fundNavHistory: [{ date: "2026-06-05", nav: 2 }],
    ...patch,
  });

  const dividend = {
    id: "fund-dividend-1",
    source: "eastmoney-fund" as const,
    type: "cash_dividend" as const,
    date: "2026-06-05",
    exDate: "2026-06-05",
    payDate: "2026-06-08",
    amount: 0.4,
  };

  test("waits until pay date and reinvests with the ex-date official NAV", () => {
    const beforePayDate = applyAutomaticCorporateActions(
      [fundHolding()],
      new Map([["h1", [dividend]]]),
      false,
      "2026-06-07",
    );
    assert.equal(beforePayDate.holdings[0]?.quantity, 10);
    assert.equal(beforePayDate.portfolioEvents.length, 0);

    const posted = applyAutomaticCorporateActions(
      [fundHolding()],
      new Map([["h1", [dividend]]]),
      false,
      "2026-06-08",
    );
    assert.equal(posted.holdings[0]?.quantity, 12);
    assert.equal(posted.holdings[0]?.corporateActions?.[0]?.price, 2);
    assert.equal(posted.holdings[0]?.corporateActions?.[0]?.date, "2026-06-08");
    assert.equal(posted.portfolioEvents[0]?.type, "dividend_reinvest");
  });

  test("keeps reinvestment pending when no official ex-date NAV is available", () => {
    const result = applyAutomaticCorporateActions(
      [fundHolding({ fundNavHistory: [] })],
      new Map([["h1", [dividend]]]),
      true,
      "2026-06-08",
    );
    assert.equal(result.holdings[0]?.quantity, 10);
    assert.equal(result.holdings[0]?.cashDividendTotal, 0);
    assert.equal(result.portfolioEvents.length, 0);
  });

  test("does not apply the open-end fund reinvest preference to listed funds", () => {
    const listedFund = fundHolding({ market: "A", assetType: "fund", dividendReinvest: true });
    const result = applyAutomaticCorporateActions(
      [listedFund],
      new Map([["h1", [{ ...dividend, source: "eastmoney-stock" as const }]]]),
      true,
      "2026-06-08",
    );
    assert.equal(result.holdings[0]?.quantity, 10);
    assert.equal(result.holdings[0]?.cashDividendTotal, 4);
    assert.equal(result.portfolioEvents[0]?.type, "cash_dividend");
  });

  test("prefers the source reinvestment price over local short history", () => {
    assert.equal(resolveFundDividendReinvestPrice(fundHolding(), { ...dividend, reinvestPrice: 1.8 }), 1.8);
  });
});

describe("loadInitialState", () => {
  test("loads persisted holdings from localStorage", () => {
    const previousWindow = globalThis.window;
    const saved = {
      version: 1,
      holdings: [{
        id: "h_old",
        groupId: "",
        symbol: "006479",
        name: "广发纳斯达克100ETF联接人民币(QDII)C",
        market: "FUND",
        assetType: "fund",
        quantity: 10,
        costPrice: 8,
        currentPrice: 9,
        currency: "CNY",
        marketValue: 90,
        todayPnl: 0,
        todayPnlRate: 0,
        totalPnl: 10,
        totalPnlRate: 0.125,
        tradeStatus: "normal",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }],
      dcaPlans: [],
      dcaExecutions: [],
      assetSnapshots: [],
    };

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => key === "asset-helper:v2" ? JSON.stringify(saved) : null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    } as any;

    try {
      const state = loadInitialState();
      assert.equal(state.holdings.length, 1);
      assert.equal(state.holdings[0]?.id, "h_old");
      assert.equal(state.holdings[0]?.marketValue, 90);
      assert.deepEqual(state.closedHoldings, []);
    } finally {
      globalThis.window = previousWindow;
    }
  });

  test("sanitizes corrupted persisted enum settings", () => {
    const previousWindow = globalThis.window;
    const saved = {
      holdings: [],
      dcaPlans: [],
      dcaExecutions: [],
      assetSnapshots: [],
      colorScheme: "blue-up",
      theme: "neon",
      currency: "BTC",
      refreshInterval: 999,
      tradeTimeOnly: "yes",
    };

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => key === "asset-helper:v2" ? JSON.stringify(saved) : null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    } as any;

    try {
      const state = loadInitialState();
      assert.equal(state.colorScheme, "red-up");
      assert.equal(state.theme, "light");
      assert.equal(state.currency, "CNY");
      assert.equal(state.refreshInterval, 1);
      assert.equal(state.tradeTimeOnly, false);
    } finally {
      globalThis.window = previousWindow;
    }
  });

  test("preserves empty holdings after clear (does not restore demo data)", () => {
    // After clearLocalData writes {holdings: [], groups: [], ...} to storage,
    // reopening the extension must NOT fall back to the bundled demo portfolio.
    const previousWindow = globalThis.window;
    const cleared = {
      version: 2,
      groups: [],
      holdings: [],
      closedHoldings: [],
      dcaPlans: [],
      dcaExecutions: [],
      assetSnapshots: [],
    };

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => key === "asset-helper:v2" ? JSON.stringify(cleared) : null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    } as any;

    try {
      const state = loadInitialState();
      assert.equal(state.holdings.length, 0, "holdings should stay empty after clear");
      assert.equal(state.groups.length, 0, "groups should stay empty after clear");
      assert.equal(state.closedHoldings.length, 0, "closedHoldings should stay empty after clear");
      assert.equal(state.dcaPlans.length, 0, "dcaPlans should stay empty after clear");
    } finally {
      globalThis.window = previousWindow;
    }
  });

  test("falls back to default state when persisted JSON is corrupt", async () => {
    await withMockWindow({
      localStorage: createLocalStorageMock({
        "asset-helper:v2": "{bad json",
      }).localStorage as unknown as Storage,
    }, async () => {
      const state = loadInitialState();
      assert.ok(state.holdings.length > 0);
      assert.ok(state.groups.length > 0);
      assert.ok(state.closedHoldings.length > 0);
    });
  });

  test("loads persisted groups, repairs DCA plans, and filters asset snapshots", async () => {
    const snapshots = Array.from({ length: 181 }, (_, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      totalAsset: index + 1,
      todayPnl: index,
      cumulativePnl: index * 2,
    }));
    const saved = {
      groups: [{ id: "g_custom", name: "自选", color: "#123456", sort: 1, visible: true }],
      holdings: [holding({
        id: "h_dca",
        groupId: "g_custom",
        symbol: "600900",
        name: "长江电力",
        market: "A",
        currency: "CNY",
      })],
      dcaPlans: [createDCAPlan({
        id: "p_dca",
        holdingId: "h_dca",
        name: "旧名称",
        symbol: "OLD",
        market: "US",
        currency: "USD",
        nextExecDate: "",
      })],
      dcaExecutions: [],
      assetSnapshots: [
        { date: "", totalAsset: 999, todayPnl: 0, cumulativePnl: 0 },
        { date: "2026-01-01", totalAsset: Number.NaN, todayPnl: 0, cumulativePnl: 0 },
        ...snapshots,
      ],
    };

    await withMockWindow({
      localStorage: createLocalStorageMock({
        "asset-helper:v2": JSON.stringify(saved),
      }).localStorage as unknown as Storage,
    }, async () => {
      const state = loadInitialState();

      assert.deepEqual(state.groups.map((group) => group.id), ["g_custom"]);
      assert.equal(state.holdings[0]?.groupId, "g_custom");
      assert.equal(state.dcaPlans[0]?.name, "长江电力");
      assert.equal(state.dcaPlans[0]?.symbol, "600900");
      assert.equal(state.dcaPlans[0]?.market, "A");
      assert.ok(state.dcaPlans[0]?.nextExecDate);
      assert.equal(state.assetSnapshots.length, 181);
      assert.equal(state.assetSnapshots[0]?.totalAsset, 1);
      assert.equal(state.assetSnapshots.at(-1)?.totalAsset, 181);
    });
  });
});

describe("buildClosedHolding", () => {
  test("archives a holding with pure trading realized return and retained dividend metadata", () => {
    const closed = buildClosedHolding(holding(), 130, "2026-07-01");

    assert.equal(closed.sourceHoldingId, "h1");
    assert.equal(closed.quantity, 10);
    assert.equal(closed.costBasis, 1000);
    assert.equal(closed.proceeds, 1300);
    assert.equal(closed.realizedPnl, 310);
    assert.equal(closed.realizedReturn, 0.31);
    assert.equal(closed.cashDividendTotal, 10);
    assert.equal(closed.closedAt, "2026-07-01");
    assert.equal(closed.isPartial, undefined);
  });

  test("partial close records only the sold quantity and skips dividends", () => {
    // Sell 4 of 10 shares at 130; the closed entry should reflect only the
    // sold slice (4 shares) without attributing the lifetime dividend total
    // (which still belongs to the remaining 6 shares).
    const closed = buildClosedHolding(holding(), 130, "2026-07-01", 4);

    assert.equal(closed.quantity, 4);
    assert.equal(closed.costBasis, 400);
    assert.equal(closed.proceeds, 520);
    assert.equal(closed.realizedPnl, 120);
    assert.equal(closed.realizedReturn, 0.30);
    assert.equal(closed.cashDividendTotal, 0);
    assert.equal(closed.isPartial, true);
  });

  test("deducts transaction fees and taxes from realized sale return", () => {
    const closed = buildClosedHolding(holding(), 130, "2026-07-01", 4, 8);

    assert.equal(closed.proceeds, 520);
    assert.equal(closed.costBasis, 400);
    assert.equal(closed.realizedPnl, 112);
    assert.equal(closed.realizedReturn, 0.28);
  });

  test("explicit full-quantity close is not marked partial", () => {
    const closed = buildClosedHolding(holding(), 130, "2026-07-01", 10);
    assert.equal(closed.quantity, 10);
    assert.equal(closed.isPartial, undefined);
  });

  test("uses closed date as openedAt fallback when holding has no timestamp", () => {
    const closed = buildClosedHolding(holding({ updatedAt: "" }), 130, "2026-07-01");
    assert.equal(closed.openedAt, "2026-07-01");
  });
});

describe("computeStats", () => {
  test("keeps cost basis independent from cash dividends", () => {
    const stats = computeStats([
      holding({
        currency: "CNY",
        quantity: 100,
        costPrice: 40,
        currentPrice: 50,
        todayPnl: 0,
        cashDividendTotal: 500,
      }),
    ]);

    assert.equal(stats.totalAsset, 5000);
    assert.equal(stats.costBasis, 4000);
    assert.equal(stats.unrealizedPnl, 1000);
    assert.equal(stats.unrealizedRate, 0.25);
  });

  test("splits dividends and trading gains out of unrealized P/L", () => {
    const events: PortfolioEvent[] = [{
      id: "div1",
      date: "2026-07-01",
      holdingId: "h1",
      symbol: "AAPL",
      name: "Apple Inc.",
      market: "US",
      assetType: "stock",
      type: "cash_dividend",
      amount: 500,
      amountInBase: 500,
      currency: "CNY",
      source: "manual",
      createdAt: "2026-07-01T00:00:00.000Z",
    }, {
      id: "sell1",
      date: "2026-07-02",
      holdingId: "h1",
      symbol: "AAPL",
      name: "Apple Inc.",
      market: "US",
      assetType: "stock",
      type: "sell",
      amount: 200,
      amountInBase: 200,
      currency: "CNY",
      source: "manual",
      costBasisAtEvent: 1000,
      proceeds: 1200,
      createdAt: "2026-07-02T00:00:00.000Z",
    }];
    const stats = computeStats([
      holding({
        currency: "CNY",
        quantity: 100,
        costPrice: 40,
        currentPrice: 50,
        todayPnl: 0,
        cashDividendTotal: 500,
      }),
    ], [], events);

    assert.equal(stats.unrealizedPnl, 1000);
    assert.equal(stats.dividendPnl, 500);
    assert.equal(stats.realizedTradingPnl, 200);
    assert.equal(stats.realizedPnl, 700);
    assert.equal(stats.realizedRate, 0.7);
    assert.equal(stats.totalInvestmentPnl, 1700);
  });
});
