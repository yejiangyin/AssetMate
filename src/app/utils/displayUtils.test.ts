import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getMarketBadge, getMarketBadgeWithBg } from "./marketBadge";
import { currencySymbol, formatExactMoney, formatExactNumber, formatFixedNumber, formatPercent, formatSignedExactMoney } from "./numberFormat";
import { cleanTradeNote, cleanTradeSource, conciseDcaReason, mergeAutomaticTradeStatus, resolveHoldingTradeStatus, TRADE_STATUS_FRESHNESS_MS, tradeStatusLabel, tradeStatusSourceLabel } from "./tradeStatus";

test("hides refresh diagnostics without hiding purchase limits or rewriting records", () => {
  const stored = "基金限购，5元；基金交易规则刷新失败，未将净值更新视为正常可买证明；上次成功更新 2026-09-14 01:13";
  assert.equal(cleanTradeNote(stored, "基金限购"), "5元");
  assert.equal(conciseDcaReason(stored), "暂无法确认交易状态，本次未执行");
  assert.equal(conciseDcaReason("应用未运行，历史计划未自动补单"), "当日未运行，已跳过");
  assert.equal(conciseDcaReason("计划金额 6 元，限购 5 元，自动定投已跳过"), "计划金额 6 元，限购 5 元，自动定投已跳过");
});

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
    assert.equal(formatPercent(0, 2, "zh-CN"), "0.00%");
    assert.equal(formatPercent(0.0000001, 2, "zh-CN"), "0.00%");
    assert.equal(formatPercent(-0, 2, "zh-CN"), "0.00%");
  });
});

describe("tradeStatus", () => {
  test("labels known statuses and quote sources", () => {
    assert.equal(tradeStatusLabel("normal"), "正常可买");
    assert.equal(tradeStatusLabel("suspended"), "停牌/暂停交易");
    assert.equal(tradeStatusLabel("fund_limit"), "基金限购");
    assert.equal(tradeStatusLabel("buy_disabled"), "当前不可买入");
    assert.equal(tradeStatusLabel("unknown"), "交易状态未知");
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

  test("keeps a previous restriction on refresh failure and marks it stale", () => {
    const merged = mergeAutomaticTradeStatus({
      autoTradeStatus: "fund_limit",
      autoTradeStatusNote: "基金限购，5元",
      autoTradeStatusSource: "eastmoney",
      autoTradeStatusUpdatedAt: "2026-08-14T01:00:00.000Z",
    }, {
      autoTradeStatusRefreshState: "failed",
      autoTradeStatusRefreshNote: "基金交易规则刷新失败",
    });
    assert.equal(merged.autoTradeStatus, "fund_limit");
    assert.equal(merged.autoTradeStatusStale, true);
    assert.equal(merged.autoTradeStatusUpdatedAt, "2026-08-14T01:00:00.000Z");
    const resolved = resolveHoldingTradeStatus({ tradeStatus: "normal", ...merged });
    assert.equal(resolved.status, "fund_limit");
    assert.match(resolved.note, /沿用|刷新失败/);
  });

  test("does not present a stale normal result as normally buyable", () => {
    const merged = mergeAutomaticTradeStatus({
      autoTradeStatus: "normal",
      autoTradeStatusNote: "自动行情源显示可正常交易",
      autoTradeStatusSource: "tencent",
    }, {
      autoTradeStatusRefreshState: "failed",
      autoTradeStatusRefreshNote: "股票交易状态刷新失败",
    });
    const resolved = resolveHoldingTradeStatus({ tradeStatus: "normal", ...merged });
    assert.equal(merged.autoTradeStatus, "normal");
    assert.equal(merged.autoTradeStatusStale, true);
    assert.equal(resolved.status, "unknown");
    assert.equal(resolved.label, "交易状态未知");
  });

  test("successful refresh replaces stale state and clears the failure marker", () => {
    const merged = mergeAutomaticTradeStatus({
      autoTradeStatus: "suspended",
      autoTradeStatusStale: true,
      autoTradeStatusRefreshNote: "上次失败",
    }, {
      autoTradeStatus: "normal",
      autoTradeStatusNote: "自动行情源显示可正常交易",
      autoTradeStatusSource: "eastmoney",
      autoTradeStatusUpdatedAt: "2026-08-14T02:00:00.000Z",
      autoTradeStatusRefreshState: "success",
    });
    assert.equal(merged.autoTradeStatus, "normal");
    assert.equal(merged.autoTradeStatusStale, false);
    assert.equal(merged.autoTradeStatusRefreshNote, "");
  });

  test("expires an old successful normal status even without a new refresh result", () => {
    const resolved = resolveHoldingTradeStatus({
      tradeStatus: "normal",
      autoTradeStatus: "normal",
      autoTradeStatusSource: "eastmoney",
      autoTradeStatusUpdatedAt: new Date(Date.now() - TRADE_STATUS_FRESHNESS_MS - 1).toISOString(),
    });
    assert.equal(resolved.status, "unknown");
    assert.equal(resolved.stale, true);
    assert.match(resolved.note, /上次成功更新/);
  });
});
