import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildClosedHolding, loadInitialState } from "./AppContext";
import type { Holding } from "../data/mockData";

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

describe("loadInitialState", () => {
  test("keeps compatible local data when storage version changes", () => {
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
});

describe("buildClosedHolding", () => {
  test("archives a holding with realized return and dividends", () => {
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
