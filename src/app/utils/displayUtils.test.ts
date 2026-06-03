import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getMarketBadge, getMarketBadgeWithBg } from "./marketBadge";
import { formatExactMoney, formatPercent } from "./numberFormat";
import { cleanTradeNote, cleanTradeSource, resolveHoldingTradeStatus } from "./tradeStatus";

describe("marketBadge", () => {
  test("falls back for unknown markets and computes alpha backgrounds", () => {
    assert.equal(getMarketBadge("MARS").label, "其他");
    assert.equal(getMarketBadgeWithBg("US", 0.2).bg, "rgba(96,165,250,0.2)");
  });
});

describe("numberFormat", () => {
  test("guards non-finite values", () => {
    assert.equal(formatExactMoney(Number.NaN, "CNY"), "—");
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), "—");
  });
});

describe("tradeStatus", () => {
  test("cleans duplicated status text and prefers automatic blocks", () => {
    assert.equal(cleanTradeSource("自动 · 东方财富"), "东方财富");
    assert.equal(cleanTradeNote("基金限购，10元", "基金限购"), "10元");
    const status = resolveHoldingTradeStatus({
      tradeStatus: "normal",
      autoTradeStatus: "buy_disabled",
      autoTradeStatusNote: "暂停申购",
      autoTradeStatusSource: "eastmoney",
    });
    assert.equal(status.status, "buy_disabled");
    assert.equal(status.automatic, true);
  });
});
