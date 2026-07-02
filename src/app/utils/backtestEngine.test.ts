import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BacktestInput, BacktestPricePoint, runBacktest } from "./backtestEngine";

const baseInput: BacktestInput = {
  symbol: "AAPL",
  market: "US",
  assetType: "stock",
  startDate: "2026-01-01",
  endDate: "2026-03-31",
  initialAmount: 1000,
  strategy: "lump_sum",
  monthlyAmount: 100,
  feeRate: 0,
};

const prices: BacktestPricePoint[] = [
  { date: "2026-01-02", price: 10 },
  { date: "2026-01-05", price: 12 },
  { date: "2026-02-03", price: 20 },
  { date: "2026-03-02", price: 15 },
];

describe("runBacktest", () => {
  test("calculates lump sum returns from the first available price", () => {
    const result = runBacktest(baseInput, prices);

    assert.equal(result.totalInvested, 1000);
    assert.equal(result.finalValue, 1500);
    assert.equal(result.totalPnl, 500);
    assert.equal(result.totalReturn, 0.5);
    assert.equal(result.points[0]?.shares, 100);
  });

  test("invests monthly DCA on each month's first available trading day", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "monthly_dca", initialAmount: 0, monthlyAmount: 300 },
      prices,
    );

    assert.equal(result.totalInvested, 900);
    assert.equal(result.points[0]?.shares, 30);
    assert.equal(result.points[1]?.shares, 30);
    assert.equal(result.points[2]?.shares, 45);
    assert.equal(result.points[3]?.shares, 65);
  });

  test("monthly DCA with initial amount does not double-invest on the first day", () => {
    // Initial 1000 at price 10 → 100 shares. The first month's recurring
    // buy must be skipped so total invested is 1000, not 1300.
    const result = runBacktest(
      { ...baseInput, strategy: "monthly_dca", initialAmount: 1000, monthlyAmount: 300 },
      prices,
    );

    assert.equal(result.totalInvested, 1600); // 1000 initial + 300×2 months (Feb, Mar)
    assert.equal(result.points[0]?.shares, 100); // only initial, no recurring
    assert.equal(result.points[0]?.invested, 1000);
  });

  test("weekly DCA invests once per ISO calendar week", () => {
    const weeklyPrices: BacktestPricePoint[] = [
      { date: "2026-01-05", price: 10 }, // Mon week 1
      { date: "2026-01-07", price: 11 }, // Wed week 1 — same week, skip
      { date: "2026-01-12", price: 12 }, // Mon week 2
      { date: "2026-01-20", price: 13 }, // Tue week 3
    ];
    const result = runBacktest(
      { ...baseInput, strategy: "weekly_dca", initialAmount: 0, monthlyAmount: 100, startDate: "2026-01-01", endDate: "2026-01-31" },
      weeklyPrices,
    );

    assert.equal(result.totalInvested, 300); // 3 weeks, 100 each
    assert.equal(result.points[0]?.shares, 10);
    assert.equal(result.points[1]?.shares, 10); // no new buy same week
    assert.equal(result.points[2]?.shares, 10 + 100 / 12);
    assert.equal(result.points[3]?.shares, 10 + 100 / 12 + 100 / 13);
  });

  test("daily DCA invests on every trading day", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "daily_dca", initialAmount: 0, monthlyAmount: 100, startDate: "2026-01-01", endDate: "2026-03-31" },
      prices,
    );

    assert.equal(result.totalInvested, 400); // 4 trading days × 100
    assert.equal(result.points[0]?.shares, 10);
    assert.equal(result.points[3]?.shares, 10 + 100 / 12 + 100 / 20 + 100 / 15);
  });

  test("deducts fee from purchased shares while tracking gross invested amount", () => {
    const result = runBacktest({ ...baseInput, feeRate: 0.01 }, prices);

    assert.equal(result.totalInvested, 1000);
    assert.equal(result.points[0]?.shares, 99);
    assert.equal(result.finalValue, 1485);
    assert.equal(result.totalPnl, 485);
  });

  test("credits cash dividends to shares held before the ex-dividend date", () => {
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 9, dividend: 1 },
      { date: "2026-01-06", price: 12 },
    ]);

    assert.equal(result.points[0]?.shares, 100);
    assert.equal(result.points[1]?.dividendCash, 100);
    assert.equal(result.points[1]?.cashDividends, 100);
    assert.equal(result.points[1]?.marketValue, 900);
    assert.equal(result.points[1]?.value, 1000);
    assert.equal(result.totalDividends, 100);
    assert.equal(result.finalMarketValue, 1200);
    assert.equal(result.finalValue, 1300);
    assert.equal(result.totalPnl, 300);
    assert.equal(result.totalReturn, 0.3);
  });

  test("does not credit same-day dividends to newly purchased recurring shares", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "daily_dca", initialAmount: 0, monthlyAmount: 100 },
      [
        { date: "2026-01-02", price: 10, dividend: 1 },
        { date: "2026-01-05", price: 10, dividend: 1 },
      ],
    );

    assert.equal(result.points[0]?.dividendCash, 0);
    assert.equal(result.points[0]?.shares, 10);
    assert.equal(result.points[1]?.dividendCash, 10);
    assert.equal(result.totalDividends, 10);
  });

  test("does not add cash dividends again when prices are already adjusted", () => {
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 4, adjusted: true },
      { date: "2026-01-05", price: 5, dividend: 1, adjusted: true },
      { date: "2026-01-06", price: 8, adjusted: true },
    ]);

    assert.equal(result.priceMode, "adjusted");
    assert.equal(result.totalDividends, 0);
    assert.equal(result.finalValue, 2000);
    assert.equal(result.totalReturn, 1);
  });

  test("calculates max drawdown from the equity curve", () => {
    const result = runBacktest(baseInput, prices);

    assert.equal(result.maxDrawdown, 0.25);
  });

  test("throws a clear error when no usable price data exists", () => {
    assert.throws(
      () => runBacktest(baseInput, [{ date: "2025-01-01", price: 0 }]),
      /NO_PRICE_DATA/,
    );
  });

  test("keeps every daily point in the selected range", () => {
    const manyDailyPrices = Array.from({ length: 252 }, (_, index) => {
      const date = new Date("2026-01-01T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return { date: date.toISOString().slice(0, 10), price: 100 + index };
    });
    const result = runBacktest(
      { ...baseInput, startDate: manyDailyPrices[0]!.date, endDate: manyDailyPrices[manyDailyPrices.length - 1]!.date },
      manyDailyPrices,
    );

    assert.equal(result.points.length, 252);
  });
});
