import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getMarketBadge, getMarketBadgeWithBg } from "./marketBadge";
import { currencySymbol, formatExactMoney, formatExactNumber, formatFixedNumber, formatPercent, formatSignedExactMoney } from "./numberFormat";
import { cleanTradeNote, cleanTradeSource, resolveHoldingTradeStatus, tradeStatusLabel, tradeStatusSourceLabel } from "./tradeStatus";

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

  test("formats currency symbols, fixed numbers, and signed money", () => {
    assert.equal(currencySymbol("HKD"), "HK$");
    assert.equal(currencySymbol("EUR"), "€");
    assert.equal(currencySymbol("ABC"), "ABC ");
    assert.equal(formatFixedNumber(12.3, 2, "en-US"), "12.30");
    assert.equal(formatExactNumber(1234.5678, 2, 1, "en-US"), "1,234.57");
    assert.equal(formatSignedExactMoney(12.3, "USD", 2), "+$12.30");
    assert.equal(formatSignedExactMoney(-12.3, "CNY", 1), "-¥12.3");
  });
});

describe("tradeStatus", () => {
  test("labels known statuses and quote sources", () => {
    assert.equal(tradeStatusLabel("normal"), "正常可买");
    assert.equal(tradeStatusLabel("suspended"), "停牌/暂停交易");
    assert.equal(tradeStatusLabel("fund_limit"), "基金限购");
    assert.equal(tradeStatusLabel("buy_disabled"), "当前不可买入");
    assert.equal(tradeStatusSourceLabel("eastmoney"), "东方财富");
    assert.equal(tradeStatusSourceLabel("tencent"), "腾讯行情");
    assert.equal(tradeStatusSourceLabel("yahoo"), "Yahoo Finance");
    assert.equal(tradeStatusSourceLabel("nasdaq"), "Nasdaq");
    assert.equal(tradeStatusSourceLabel("binance"), "Binance");
    assert.equal(tradeStatusSourceLabel("unknown-source"), "unknown-source");
  });

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
    assert.equal(status.note, "暂停申购");
    assert.equal(status.source, "自动 · 东方财富");
    assert.equal(cleanTradeSource(status.source), "东方财富");
  });
});
