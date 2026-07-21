import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LiveResult } from "../services/securitiesApi";
import { defaultCurrencyForMarket, researchTargetFieldsFromSearchResult } from "./targetSelection";

describe("research target selection", () => {
  test("uses the matched security metadata and normalizes the symbol", () => {
    const result: LiveResult = {
      symbol: "AAPL",
      name: "Apple Inc.",
      market: "US",
      assetType: "stock",
      currency: "USD",
      price: 210,
      priceReady: true,
      source: "live",
    };

    assert.deepEqual(researchTargetFieldsFromSearchResult(result), {
      symbol: "AAPL",
      name: "Apple Inc.",
      market: "US",
      assetType: "stock",
      currency: "USD",
    });
  });

  test("falls back to the market currency when a source omits it", () => {
    assert.equal(defaultCurrencyForMarket("HK"), "HKD");
    assert.equal(defaultCurrencyForMarket("A"), "CNY");
    assert.equal(defaultCurrencyForMarket("JP"), "JPY");
    assert.equal(defaultCurrencyForMarket("FX"), "");
  });
});
