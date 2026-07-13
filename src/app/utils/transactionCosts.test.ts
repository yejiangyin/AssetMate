import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { affordableBuyAmount, estimateTransactionCosts, mergeTransactionCostProfile, normalizeTransactionCostProfile } from "./transactionCosts";

describe("transaction cost profiles", () => {
  test("estimates directional fees, taxes, and minimum fees", () => {
    const profile = {
      buyFeeRate: 0.0003,
      sellFeeRate: 0.0005,
      minimumFee: 5,
      sellTaxRate: 0.001,
    };

    assert.deepEqual(estimateTransactionCosts(profile, "buy", 10_000), {
      fee: 5,
      tax: 0,
      feeRate: 0.0003,
      taxRate: undefined,
      minimumFee: 5,
    });
    assert.deepEqual(estimateTransactionCosts(profile, "sell", 20_000), {
      fee: 10,
      tax: 20,
      feeRate: 0.0005,
      taxRate: 0.001,
      minimumFee: 5,
    });
  });

  test("does not charge a minimum fee without a fee rate", () => {
    assert.equal(estimateTransactionCosts({ minimumFee: 5 }, "buy", 10_000).fee, 0);
  });

  test("keeps DCA notional and transaction costs within the configured budget", () => {
    const profile = { buyFeeRate: 0.001, buyTaxRate: 0.002, minimumFee: 5 };
    const notional = affordableBuyAmount(profile, 1000);
    const costs = estimateTransactionCosts(profile, "buy", notional);
    assert.ok(Math.abs(notional + costs.fee + costs.tax - 1000) < 1e-8);
    assert.equal(costs.fee, 5);
  });

  test("normalizes invalid values and merges only the changed side", () => {
    assert.deepEqual(normalizeTransactionCostProfile({ buyFeeRate: -1, sellFeeRate: 0.001, minimumFee: Number.NaN, dividendTaxRate: 0.1 }), {
      sellFeeRate: 0.001,
      dividendTaxRate: 0.1,
    });
    assert.deepEqual(mergeTransactionCostProfile(
      { buyFeeRate: 0.0003, sellFeeRate: 0.0005 },
      { sellFeeRate: 0.0004, sellTaxRate: 0.001 },
    ), {
      buyFeeRate: 0.0003,
      sellFeeRate: 0.0004,
      sellTaxRate: 0.001,
    });
  });
});
