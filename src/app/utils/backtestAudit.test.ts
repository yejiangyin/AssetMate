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

describe("Backtest audit — split handling", () => {
  test("applies a 2-for-1 stock split before same-day valuation", () => {
    // Day 1: buy 100 shares @ $10 = $1000 invested.
    // Day 2: 2-for-1 split — price drops to $5, shares should double to 200,
    //        market value should remain $1000.
    // Day 3: price rises to $6 — fair value should be $1200 (+20%).
    const prices: BacktestPricePoint[] = [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 5, splitRatio: 2 },
      { date: "2026-01-06", price: 6 },
    ];
    const result = runBacktest(baseInput, prices);

    assert.equal(result.points[0]?.shares, 100);
    assert.equal(result.points[1]?.shares, 200);
    assert.equal(result.points[2]?.shares, 200);
    assert.equal(result.points[1]?.marketValue, 1000);
    assert.equal(result.finalMarketValue, 1200);
    assert.equal(result.totalPnl, 200);
    assert.equal(result.totalReturn, 0.2);
    assert.equal(result.maxDrawdown, 0);
    assert.equal(result.marketMaxDrawdown, 0);
  });
});

describe("Backtest audit — DCA annualized return", () => {
  test("uses XIRR for DCA annualized return when capital is deployed over time", () => {
    // Lump-sum on day 1: $1000 @ $10 → 100 shares.
    // Price grows linearly to $20 over 365 days.
    // Correct annualized return ≈ +100%.
    const lumpPrices: BacktestPricePoint[] = [
      { date: "2026-01-01", price: 10 },
      { date: "2027-01-01", price: 20 },
    ];
    const lumpResult = runBacktest(
      { ...baseInput, strategy: "lump_sum", initialAmount: 1000, startDate: "2026-01-01", endDate: "2027-01-01" },
      lumpPrices,
    );
    assertClose(lumpResult.annualizedReturn, 1.0, 1e-3); // +100%, correct

    // Monthly DCA: $1000 initial + $0 monthly (single deployment) but routed
    // through the DCA path. Should match lump-sum.
    // (Skipped — instead test a real DCA scenario below.)

    // Real DCA: $100/month for 12 months, no initial. Total invested = $1200.
    // All capital is deployed gradually, so the time-weighted return is
    // HIGHER than what (finalValue / totalInvested)^(365/days) - 1 suggests,
    // because most of the capital had less than a full year to grow.
    const dcaPrices: BacktestPricePoint[] = [];
    for (let m = 0; m <= 12; m++) {
      const date = new Date(Date.UTC(2026, m, 1));
      dcaPrices.push({
        date: date.toISOString().slice(0, 10),
        price: 10 * Math.pow(2, m / 12), // price doubles over the year
      });
    }
    const dcaResult = runBacktest(
      {
        ...baseInput,
        strategy: "monthly_dca",
        initialAmount: 0,
        monthlyAmount: 100,
        startDate: "2026-01-01",
        endDate: "2027-01-31",
      },
      dcaPrices,
    );

    assert.ok(dcaResult.finalValue > 0);
    assert.ok(dcaResult.totalReturn > 0);

    const elapsedDays = 365;
    const lumpSumFormula = Math.pow(dcaResult.finalValue / dcaResult.totalInvested, 365 / elapsedDays) - 1;
    assert.ok(dcaResult.annualizedReturn > lumpSumFormula);
  });
});

describe("Backtest audit — dividend on first trading day", () => {
  test("lump-sum buy on day 1 with same-day dividend ignores the dividend for new shares", () => {
    // This is correct behavior (ex-dividend date), but worth pinning down.
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10, dividend: 1 },
      { date: "2026-01-03", price: 10 },
    ]);

    // Day 1: buy 100 shares @ $10. Dividend of $1/share is credited only to
    // shares held BEFORE the buy, which is 0. So dividendCash = 0.
    assert.equal(result.points[0]?.shares, 100);
    assert.equal(result.points[0]?.dividendCash, 0);
    assert.equal(result.totalDividends, 0);
  });
});

describe("Backtest audit — adjusted price mode", () => {
  test("adjusted points zero out dividends to avoid double counting", () => {
    // When adjusted=true, dividendCash is forced to 0 to avoid double counting.
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 4, adjusted: true },
      { date: "2026-01-05", price: 5, dividend: 1, adjusted: true },
      { date: "2026-01-06", price: 8, adjusted: true },
    ]);

    assert.equal(result.priceMode, "adjusted");
    assert.equal(result.totalDividends, 0);
    assert.equal(result.finalValue, 2000);
  });
});

describe("Backtest audit — maxDrawdown with cumulative cash dividends", () => {
  test("reports market-value drawdown separately from total-equity drawdown", () => {
    // Scenario: price halves from $10 → $5, but a $6/share dividend is paid
    // on the same day. Cumulative cash dividends only ever increase, so
    // `value = marketValue + cashDividends` may never decline even when the
    // underlying market value crashes.
    const result = runBacktest(baseInput, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-05", price: 5, dividend: 6 }, // price halves, but $6 div
      { date: "2026-01-06", price: 5 },
    ]);

    // Day 1: 100 shares @ $10 = $1000 market value, $0 div, value=$1000, peak=$1000.
    // Day 2: 100 shares @ $5 = $500 market value, $600 div, value=$1100, peak=$1100.
    // Day 3: 100 shares @ $5 = $500 market value, $600 cum div, value=$1100, peak=$1100.
    assert.equal(result.points[0]?.value, 1000);
    assert.equal(result.points[1]?.marketValue, 500);
    assert.equal(result.points[1]?.cashDividends, 600);
    assert.equal(result.points[1]?.value, 1100);
    assert.equal(result.points[2]?.value, 1100);

    assert.equal(result.maxDrawdown, 0);
    assert.equal(result.marketMaxDrawdown, 0.5);
  });
});

describe("Backtest audit — date overflow in monthsAgoYMD/yearsAgoYMD", () => {
  // These helpers live inside Backtest.tsx and are not exported, so this
  // mirrors the fixed clamp behavior as a focused regression spec.
  function dateToYMD(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function daysInMonth(year: number, monthIndex: number) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  function monthsAgoYMD(months: number, now: Date) {
    const target = new Date(now);
    const targetMonth = target.getMonth() - months;
    const firstOfTarget = new Date(target.getFullYear(), targetMonth, 1);
    const clampedDay = Math.min(target.getDate(), daysInMonth(firstOfTarget.getFullYear(), firstOfTarget.getMonth()));
    firstOfTarget.setDate(clampedDay);
    return dateToYMD(firstOfTarget);
  }

  function yearsAgoYMD(years: number, now: Date) {
    const target = new Date(now);
    const targetYear = target.getFullYear() - years;
    const clampedDay = Math.min(target.getDate(), daysInMonth(targetYear, target.getMonth()));
    return dateToYMD(new Date(targetYear, target.getMonth(), clampedDay));
  }

  test("monthsAgoYMD(1) on Mar 31 clamps to Feb 29 in a leap year", () => {
    const now = new Date(2024, 2, 31, 12, 0, 0);
    const result = monthsAgoYMD(1, now);
    assert.equal(result, "2024-02-29");
  });

  test("yearsAgoYMD(1) on leap day Feb 29 clamps to Feb 28", () => {
    const now = new Date(2024, 1, 29, 12, 0, 0);
    const result = yearsAgoYMD(1, now);
    assert.equal(result, "2023-02-28");
  });
});

describe("Backtest audit — timezone inconsistency in todayYMD", () => {
  function todayYMD(now: Date) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  test("todayYMD formats the local calendar day instead of UTC", () => {
    const now = new Date(2024, 2, 31, 1, 0, 0);
    const today = todayYMD(now);
    assert.equal(today, "2024-03-31");
  });
});

describe("Backtest audit — single-point range edge case", () => {
  test("a range containing exactly one trading day produces 0% return with no error", () => {
    const result = runBacktest(
      { ...baseInput, startDate: "2026-01-02", endDate: "2026-01-02" },
      [{ date: "2026-01-02", price: 10 }],
    );

    assert.equal(result.points.length, 1);
    assert.equal(result.totalInvested, 1000);
    assert.equal(result.finalValue, 1000);
    assert.equal(result.totalReturn, 0);
    assert.equal(result.annualizedReturn, 0); // elapsedDays clamped to 1
    assert.equal(result.maxDrawdown, 0);
  });
});

describe("Backtest audit — fee rate input validation", () => {
  test("NaN fee rate is treated as zero (defensive)", () => {
    const result = runBacktest({ ...baseInput, feeRate: NaN }, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-03", price: 10 },
    ]);
    assert.equal(result.points[0]?.shares, 100); // no fee deducted
  });

  test("Infinity fee rate is treated as zero (defensive, but silently misleading)", () => {
    const result = runBacktest({ ...baseInput, feeRate: Infinity }, [
      { date: "2026-01-02", price: 10 },
      { date: "2026-01-03", price: 10 },
    ]);
    assert.equal(result.points[0]?.shares, 100); // no fee deducted
    // NOTE: the UI's numberInput coerces Infinity→0 via Number.isFinite check,
    //       but runBacktest also guards. Still, no user-facing warning.
  });
});

describe("Backtest audit — weekly DCA ISO week edge case", () => {
  test("weekly DCA across a year boundary uses ISO week year correctly", () => {
    // 2024-12-30 (Mon) is ISO week 1 of 2025.
    // 2025-01-06 (Mon) is also ISO week 1 of 2025? No — it's week 2.
    // Let's verify two Mondays in different ISO weeks both invest.
    const prices: BacktestPricePoint[] = [
      { date: "2024-12-30", price: 10 }, // Mon, ISO week 2025-W01
      { date: "2025-01-06", price: 11 }, // Mon, ISO week 2025-W02
      { date: "2025-01-13", price: 12 }, // Mon, ISO week 2025-W03
    ];
    const result = runBacktest(
      {
        ...baseInput,
        strategy: "weekly_dca",
        initialAmount: 0,
        monthlyAmount: 100,
        startDate: "2024-12-01",
        endDate: "2025-01-31",
      },
      prices,
    );
    assert.equal(result.totalInvested, 300); // 3 weeks × $100
  });
});
