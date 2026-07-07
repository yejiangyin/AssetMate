import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DetailTarget } from "../context/AppContext";
import { buildDetailActionHolding, isIndexDetailTarget } from "./StockDetail";

function target(patch: Partial<DetailTarget> = {}): DetailTarget {
  return {
    yahooSymbol: "600900",
    displaySymbol: "600900",
    name: "长江电力",
    market: "A",
    assetType: "stock",
    ...patch,
  };
}

describe("isIndexDetailTarget", () => {
  test("recognizes A-share index detail targets even when market is A", () => {
    for (const symbol of ["000001", "399001", "000300", "399006", "000688"]) {
      assert.equal(isIndexDetailTarget(target({
        yahooSymbol: symbol,
        displaySymbol: symbol,
        name: symbol === "000001" ? "上证指数" : "指数",
        market: "A",
        assetType: "index",
      })), true);
    }
  });

  test("recognizes Hong Kong and generic index detail targets", () => {
    for (const symbol of ["HSI", "HSTECH", "HSCEI"]) {
      assert.equal(isIndexDetailTarget(target({
        yahooSymbol: `^${symbol}`,
        displaySymbol: symbol,
        name: "指数",
        market: "HK",
        assetType: "index",
      })), true);
    }
    assert.equal(isIndexDetailTarget(target({ market: "INDEX", yahooSymbol: "^GSPC", displaySymbol: "SPX", name: "S&P 500" })), true);
  });

  test("recognizes index names without relying on market or asset type", () => {
    for (const name of ["中证红利指数", "深证成指", "创业板指", "科创50", "Global INDEX"]) {
      assert.equal(isIndexDetailTarget(target({ displaySymbol: "930903", name, assetType: "stock" })), true);
    }
  });

  test("does not classify ordinary stocks, ETFs, or funds as indexes", () => {
    assert.equal(isIndexDetailTarget(target()), false);
    assert.equal(isIndexDetailTarget(target({ displaySymbol: "510300", name: "沪深300ETF", assetType: "etf" })), false);
    assert.equal(isIndexDetailTarget(target({ market: "FUND", displaySymbol: "006479", name: "广发纳指基金", assetType: "fund" })), false);
  });
});

describe("buildDetailActionHolding", () => {
  test("skips corporate action holdings for indexes", () => {
    assert.equal(buildDetailActionHolding(target({
      yahooSymbol: "000001",
      displaySymbol: "000001",
      name: "上证指数",
      market: "A",
      assetType: "index",
    })), null);
    assert.equal(buildDetailActionHolding(target({
      yahooSymbol: "^HSI",
      displaySymbol: "HSI",
      name: "恒生指数",
      market: "HK",
      assetType: "index",
    })), null);
  });

  test("keeps corporate action holdings for ordinary A shares, ETFs, and funds", () => {
    assert.equal(buildDetailActionHolding(target())?.symbol, "600900");
    assert.equal(buildDetailActionHolding(target({
      displaySymbol: "510300",
      name: "沪深300ETF",
      market: "A",
      assetType: "etf",
    }))?.assetType, "etf");
    assert.equal(buildDetailActionHolding(target({
      displaySymbol: "006479",
      name: "广发纳指基金",
      market: "FUND",
      assetType: "fund",
    }))?.assetType, "fund");
    assert.equal(buildDetailActionHolding(target({
      displaySymbol: "7203",
      yahooSymbol: "7203.T",
      name: "Toyota Motor",
      market: "JP",
      assetType: "stock",
    }))?.market, "JP");
  });

  test("skips unsupported corporate action markets", () => {
    for (const market of ["CRYPTO", "GOLD", "FX"] as const) {
      assert.equal(buildDetailActionHolding(target({
        displaySymbol: market === "CRYPTO" ? "BTC" : "GC=F",
        yahooSymbol: market === "CRYPTO" ? "BTC-USD" : "GC=F",
        name: market,
        market,
      })), null);
    }
  });
});
