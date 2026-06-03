import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadInitialState } from "./AppContext";

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
});
