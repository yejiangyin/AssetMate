import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BacktestInput, BacktestPricePoint, runBacktest } from "./backtestEngine";
import { assertClose } from "../testUtils";

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
    assertClose(result.points[2]?.shares ?? 0, 10 + 100 / 12);
    assertClose(result.points[3]?.shares ?? 0, 10 + 100 / 12 + 100 / 13);
  });

  test("daily DCA invests on every trading day", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "daily_dca", initialAmount: 0, monthlyAmount: 100, startDate: "2026-01-01", endDate: "2026-03-31" },
      prices,
    );

    assert.equal(result.totalInvested, 400); // 4 trading days × 100
    assert.equal(result.points[0]?.shares, 10);
    assertClose(result.points[3]?.shares ?? 0, 10 + 100 / 12 + 100 / 20 + 100 / 15);
  });

  test("deducts fee from purchased shares while tracking gross invested amount", () => {
    const result = runBacktest({ ...baseInput, feeRate: 0.01 }, prices);

    assert.equal(result.totalInvested, 1000);
    assert.equal(result.points[0]?.shares, 99);
    assert.equal(result.finalValue, 1485);
    assert.equal(result.totalPnl, 485);
  });

  test("treats negative fee rates as zero", () => {
    const result = runBacktest({ ...baseInput, feeRate: -0.01 }, prices);

    assert.equal(result.points[0]?.shares, 100);
    assert.equal(result.finalValue, 1500);
  });

  test("applies fees to recurring DCA purchases", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "monthly_dca", initialAmount: 0, monthlyAmount: 300, feeRate: 0.01 },
      prices,
    );

    assert.equal(result.totalInvested, 900);
    assertClose(result.points[0]?.shares ?? 0, 29.7);
    assertClose(result.points[2]?.shares ?? 0, 29.7 + 297 / 20);
    assertClose(result.points[3]?.shares ?? 0, 29.7 + 297 / 20 + 297 / 15);
  });

  test("applies minimum fees and reports transaction totals", () => {
    const result = runBacktest({ ...baseInput, feeRate: 0.001, minimumFee: 5 }, prices);

    assert.equal(result.points[0]?.shares, 99.5);
    assert.equal(result.totalFees, 5);
    assert.equal(result.totalTaxes, 0);
    assert.equal(result.tradeCount, 1);
    assert.equal(result.actualStartDate, "2026-01-02");
    assert.equal(result.actualEndDate, "2026-03-02");
  });

  test("deducts sell fees and taxes only when ending liquidation is enabled", () => {
    const result = runBacktest({
      ...baseInput,
      feeRate: 0.001,
      minimumFee: 5,
      sellTaxRate: 0.01,
      liquidateAtEnd: true,
    }, prices);

    assert.equal(result.liquidatedAtEnd, true);
    assert.equal(result.tradeCount, 2);
    assert.equal(result.totalFees, 10);
    assertClose(result.totalTaxes, 14.925);
    assertClose(result.finalValue, 1472.575);
    assertClose(result.points.at(-1)?.value ?? 0, result.finalValue);
  });

  test("uses independent buy and sell fee and tax rates", () => {
    const result = runBacktest({
      ...baseInput,
      feeRate: 0.001,
      sellFeeRate: 0.002,
      buyTaxRate: 0.003,
      sellTaxRate: 0.004,
      liquidateAtEnd: true,
    }, [{ date: "2026-01-02", price: 10 }, { date: "2026-01-03", price: 10 }]);

    assertClose(result.totalFees, 1 + 1.992);
    assertClose(result.totalTaxes, 3 + 3.984);
    assert.equal(result.tradeCount, 2);
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

  test("reinvests cash dividends without counting them as external capital", () => {
    const reinvested = runBacktest({ ...baseInput, dividendMode: "reinvest" }, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 10, dividend: 1 },
      { date: "2026-01-06", price: 11 },
    ]);
    const cash = runBacktest({ ...baseInput, dividendMode: "cash" }, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 10, dividend: 1 },
      { date: "2026-01-06", price: 11 },
    ]);

    assert.equal(reinvested.totalInvested, 1000);
    assert.equal(reinvested.totalDividends, 100);
    assert.equal(reinvested.points[1]?.shares, 110);
    assert.equal(reinvested.finalValue, 1210);
    assert.equal(cash.finalValue, 1200);
  });

  test("deducts dividend tax before paying or reinvesting income", () => {
    const result = runBacktest({ ...baseInput, dividendMode: "reinvest", dividendTaxRate: 0.2 }, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 10, dividend: 1 },
    ]);

    assert.equal(result.grossDividends, 100);
    assert.equal(result.totalDividends, 80);
    assert.equal(result.totalTaxes, 20);
    assert.equal(result.points[1]?.shares, 108);
    assert.equal(result.dividendDataStatus, "explicit");
  });

  test("rejects mixed adjusted and raw prices", () => {
    assert.throws(() => runBacktest(baseInput, [
      { date: "2026-01-02", price: 10, adjusted: true },
      { date: "2026-01-03", price: 11 },
    ]), /MIXED_PRICE_MODE/);
  });

  test("applies split ratios before valuation and later buys", () => {
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 5, splitRatio: 2 },
      { date: "2026-01-06", price: 6 },
    ]);

    assert.equal(result.points[0]?.shares, 100);
    assert.equal(result.points[1]?.shares, 200);
    assert.equal(result.points[1]?.marketValue, 1000);
    assert.equal(result.finalMarketValue, 1200);
    assert.equal(result.totalReturn, 0.2);
    assert.equal(result.maxDrawdown, 0);
    assert.equal(result.marketMaxDrawdown, 0);
  });

  test("calculates max drawdown from the equity curve", () => {
    const result = runBacktest(baseInput, prices);

    assert.equal(result.maxDrawdown, 0.25);
    assert.equal(result.marketMaxDrawdown, 0.25);
  });

  test("calculates DCA drawdown from a cash-flow-adjusted unit value", () => {
    const result = runBacktest(
      { ...baseInput, strategy: "daily_dca", initialAmount: 0, monthlyAmount: 100 },
      [
        { date: "2026-01-02", price: 10 },
        { date: "2026-01-05", price: 5 },
      ],
    );

    assert.equal(result.totalInvested, 200);
    assertClose(result.maxDrawdown, 0.5);
    assertClose(result.marketMaxDrawdown, 0.5);
  });

  test("reports the peak and trough dates for maximum drawdown", () => {
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 12 },
      { date: "2026-01-06", price: 6 },
      { date: "2026-01-07", price: 9 },
    ]);

    assert.equal(result.maxDrawdownStartDate, "2026-01-05");
    assert.equal(result.maxDrawdownEndDate, "2026-01-06");
    assertClose(result.maxDrawdown, 0.5);
  });

  test("aggregates cash-flow-adjusted monthly and yearly returns", () => {
    const result = runBacktest(baseInput, [
      { date: "2025-12-31", price: 10 },
      { date: "2026-01-30", price: 11 },
      { date: "2026-02-27", price: 12.1 },
    ]);

    assert.deepEqual(result.monthlyReturns.map((row) => row.key), ["2026-01", "2026-02"]);
    assertClose(result.monthlyReturns[0]?.returnRate ?? 0, 0);
    assertClose(result.monthlyReturns[1]?.returnRate ?? 0, 0.1);
    assert.deepEqual(result.yearlyReturns.map((row) => row.key), ["2026"]);
    assertClose(result.yearlyReturns[0]?.returnRate ?? 0, 0.1);
  });

  test("keeps market drawdown visible when cash dividends mask total drawdown", () => {
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 5, dividend: 6 },
      { date: "2026-01-06", price: 5 },
    ]);

    assert.equal(result.maxDrawdown, 0);
    assert.equal(result.marketMaxDrawdown, 0.5);
  });

  test("calculates annualized return from the selected date span", () => {
    const result = runBacktest({ ...baseInput, endDate: "2027-01-01" }, [
      { date: "2026-01-01", price: 10 },
      { date: "2027-01-01", price: 11 },
    ]);

    assertClose(result.totalReturn, 0.1);
    assertClose(result.annualizedReturn, 0.1, 1e-3);
  });

  test("throws a clear error when no usable price data exists", () => {
    assert.throws(
      () => runBacktest(baseInput, [{ date: "2025-01-01", price: 0 }]),
      /NO_PRICE_DATA/,
    );
    assert.throws(
      () => runBacktest(baseInput, []),
      /NO_PRICE_DATA/,
    );
    assert.throws(
      () => runBacktest({ ...baseInput, startDate: "2026-04-01", endDate: "2026-03-31" }, prices),
      /NO_PRICE_DATA/,
    );
  });

  test("handles zero investment amounts without producing returns", () => {
    const result = runBacktest({ ...baseInput, initialAmount: 0, monthlyAmount: 0 }, prices);

    assert.equal(result.totalInvested, 0);
    assert.equal(result.finalValue, 0);
    assert.equal(result.totalReturn, 0);
    assert.equal(result.annualizedReturn, 0);
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
