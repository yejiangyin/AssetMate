import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPortfolioContext, buildPrivateHoldingContext, buildPublicResearchContext, researchTargetFromHolding } from "./contextBuilder";
import type { Holding } from "../data/mockData";
import { toCNY } from "../services/priceRefresher";

const holding = {
  id: "holding-private-id",
  symbol: "AAPL",
  name: "Apple",
  market: "US",
  assetType: "stock",
  currency: "USD",
  quantity: 10,
  costPrice: 100,
  currentPrice: 150,
  marketValue: 1500,
  totalPnlRate: 0.5,
  todayPnlRate: 0.01,
  cashDividendTotal: 12,
} as Holding;

describe("research context privacy", () => {
  test("public context strips the local holding identifier", () => {
    const target = researchTargetFromHolding(holding);
    const context = buildPublicResearchContext(target);
    assert.equal("holdingId" in context.target, false);
    assert.equal(context.target.symbol, "AAPL");
    assert.equal(JSON.stringify(context).includes("holding-private-id"), false);
  });

  test("private portfolio fields are only built in the explicit private context", () => {
    const context = buildPrivateHoldingContext(holding, { totalAsset: toCNY(3000, "USD") } as never, []);
    assert.equal(context.quantity, 10);
    assert.equal(context.costPrice, 100);
    assert.equal(context.portfolioWeight, 0.5);
    assert.equal(context.currency, "USD");
    assert.equal(context.marketValueInBase, toCNY(1500, "USD"));
    assert.equal(context.cashDividendTotal, holding.cashDividendTotal);
  });

  test("builds a public multi-target context without leaking holding ids", () => {
    const apple = researchTargetFromHolding(holding);
    const microsoft = {
      symbol: "MSFT",
      name: "Microsoft",
      market: "US",
      assetType: "stock",
      currency: "USD",
      holdingId: "another-private-id",
    };
    const context = buildPublicResearchContext(apple, { targets: [apple, microsoft] });
    assert.deepEqual(context.targets?.map((target) => target.symbol), ["AAPL", "MSFT"]);
    assert.equal(JSON.stringify(context).includes("private-id"), false);
  });

  test("normalizes mixed-currency portfolio values to CNY and keeps weights summing to one", () => {
    const context = buildPortfolioContext([
      holding,
      { ...holding, id: "h2", symbol: "00700", name: "Tencent", market: "HK", currency: "HKD" },
    ] as Holding[], {
      totalAsset: 1,
      costBasis: 1,
      unrealizedPnl: 0,
      unrealizedRate: 0,
      realizedPnl: 300,
      realizedTradingPnl: 200,
      dividendPnl: 120,
      feePnl: -20,
    } as never);
    assert.equal(context.currency, "CNY");
    assert.equal(context.baseCurrency, "CNY");
    assert.deepEqual(context.currencies, ["HKD", "USD"]);
    assert.equal(Math.abs((context.weightTotal ?? 0) - 1) < 1e-10, true);
    assert.equal(context.holdings[0]?.currency, "USD");
    assert.equal(context.holdings[1]?.currency, "HKD");
    assert.equal(context.holdings[0]?.marketValueInBase, toCNY(1500, "USD"));
    assert.equal(context.totalAsset, toCNY(1500, "USD") + toCNY(1500, "HKD"));
    assert.equal(context.realizedPnl, 300);
    assert.equal(context.dividendPnl, 120);
  });
});
