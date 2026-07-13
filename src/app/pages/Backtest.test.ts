import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autoBenchmark, buildBenchmarkInput } from "./Backtest";

describe("backtest benchmark selection", () => {
  test("maps supported markets to a representative benchmark", () => {
    assert.equal(autoBenchmark("A"), "csi300");
    assert.equal(autoBenchmark("FUND"), "csi300");
    assert.equal(autoBenchmark("HK"), "hsi");
    assert.equal(autoBenchmark("US"), "sp500");
    assert.equal(autoBenchmark("JP"), "nikkei");
    assert.equal(autoBenchmark("CRYPTO"), "btc");
  });

  test("does not invent a benchmark for unsupported markets", () => {
    assert.equal(autoBenchmark("BOND"), "none");
    assert.equal(autoBenchmark("GOLD"), "none");
  });
});

describe("backtest benchmark cash-flow parity", () => {
  test("keeps strategy and contribution schedule while removing benchmark costs", () => {
    const input = buildBenchmarkInput({
      symbol: "AAPL", market: "US", assetType: "stock", startDate: "2025-01-01", endDate: "2026-01-01",
      initialAmount: 2000, strategy: "weekly_dca", monthlyAmount: 300, feeRate: 0.001, sellTaxRate: 0.002,
    }, "^GSPC", "INDEX");
    assert.equal(input.strategy, "weekly_dca");
    assert.equal(input.initialAmount, 2000);
    assert.equal(input.monthlyAmount, 300);
    assert.equal(input.feeRate, 0);
    assert.equal(input.sellTaxRate, 0);
  });
});
