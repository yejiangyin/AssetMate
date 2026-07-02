export type BacktestStrategy = "lump_sum" | "monthly_dca" | "weekly_dca" | "daily_dca";

export type BacktestInput = {
  symbol: string;
  market: string;
  assetType: string;
  startDate: string;
  endDate: string;
  initialAmount: number;
  strategy: BacktestStrategy;
  /** Recurring investment amount per period (month / week / day). */
  monthlyAmount: number;
  feeRate: number;
};

export type BacktestPricePoint = {
  date: string;
  price: number;
  /** Cash dividend per share/unit on the ex-dividend date. */
  dividend?: number;
  /** Price is already adjusted for dividends/splits, so dividends must not be added again. */
  adjusted?: boolean;
};

export type BacktestPoint = {
  date: string;
  price: number;
  dividend: number;
  adjusted: boolean;
  dividendCash: number;
  cashDividends: number;
  invested: number;
  shares: number;
  marketValue: number;
  value: number;
  pnl: number;
  returnRate: number;
};

export type BacktestResult = {
  totalInvested: number;
  finalMarketValue: number;
  finalValue: number;
  totalPnl: number;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  totalDividends: number;
  priceMode: "adjusted" | "cash_dividend";
  points: BacktestPoint[];
};

function dateKey(value: string) {
  return String(value ?? "").slice(0, 10);
}

function monthKey(value: string) {
  return dateKey(value).slice(0, 7);
}

/** ISO week key (YYYY-Www) so weekly DCA invests once per calendar week. */
function weekKey(value: string) {
  const date = new Date(dateKey(value) + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) return "";
  // ISO week: Thursday in the current week defines the year.
  const day = date.getUTCDate() + 6 - (date.getUTCDay() || 7);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day));
  const week = Math.ceil((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 / 7) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function normalizeAmount(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function buyShares(amount: number, price: number, feeRate: number) {
  const gross = normalizeAmount(amount);
  if (gross <= 0 || price <= 0) return 0;
  const fee = gross * Math.max(0, feeRate);
  return Math.max(0, gross - fee) / price;
}

/** Returns the period key for a recurring strategy, or "" for lump_sum. */
function periodKey(strategy: BacktestStrategy, date: string): string {
  if (strategy === "monthly_dca") return monthKey(date);
  if (strategy === "weekly_dca") return weekKey(date);
  if (strategy === "daily_dca") return dateKey(date);
  return "";
}

function isDcaStrategy(strategy: BacktestStrategy): strategy is "monthly_dca" | "weekly_dca" | "daily_dca" {
  return strategy === "monthly_dca" || strategy === "weekly_dca" || strategy === "daily_dca";
}

export function runBacktest(input: BacktestInput, rawPrices: BacktestPricePoint[]): BacktestResult {
  const startDate = dateKey(input.startDate);
  const endDate = dateKey(input.endDate);
  const prices = rawPrices
    .map((point) => ({
      date: dateKey(point.date),
      price: Number(point.price),
      dividend: Number.isFinite(point.dividend) ? Math.max(0, Number(point.dividend)) : 0,
      adjusted: point.adjusted === true,
    }))
    .filter((point) => point.date && Number.isFinite(point.price) && point.price > 0)
    .filter((point) => (!startDate || point.date >= startDate) && (!endDate || point.date <= endDate))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!prices.length) {
    throw new Error("NO_PRICE_DATA");
  }

  const feeRate = Number.isFinite(input.feeRate) ? Math.max(0, input.feeRate) : 0;
  const initialAmount = normalizeAmount(input.initialAmount);
  const recurringAmount = normalizeAmount(input.monthlyAmount);
  const priceMode = prices.some((point) => point.adjusted) ? "adjusted" : "cash_dividend";
  let shares = 0;
  let invested = 0;
  let cashDividends = 0;
  let lastInvestmentPeriod = "";
  let peakValue = 0;
  let maxDrawdown = 0;

  const points = prices.map((point, index) => {
    // Ex-dividend cash belongs only to shares already held before this date.
    // Buy orders for the same date are applied after the dividend credit.
    const dividendCash = priceMode === "adjusted" ? 0 : shares * point.dividend;
    cashDividends += dividendCash;

    if (input.strategy === "lump_sum" && index === 0 && initialAmount > 0) {
      shares += buyShares(initialAmount, point.price, feeRate);
      invested += initialAmount;
    }

    if (isDcaStrategy(input.strategy)) {
      const currentPeriod = periodKey(input.strategy, point.date);
      // Initial amount counts as this period's investment so the recurring
      // buy is skipped on the first trading day to avoid double-investing.
      if (index === 0 && initialAmount > 0) {
        shares += buyShares(initialAmount, point.price, feeRate);
        invested += initialAmount;
        lastInvestmentPeriod = currentPeriod;
      } else if (currentPeriod && currentPeriod !== lastInvestmentPeriod && recurringAmount > 0) {
        shares += buyShares(recurringAmount, point.price, feeRate);
        invested += recurringAmount;
        lastInvestmentPeriod = currentPeriod;
      }
    }

    const marketValue = shares * point.price;
    const value = marketValue + cashDividends;
    if (value > peakValue) peakValue = value;
    if (peakValue > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peakValue - value) / peakValue);
    }
    const pnl = value - invested;
    return {
      date: point.date,
      price: point.price,
      dividend: point.dividend,
      adjusted: point.adjusted,
      dividendCash,
      cashDividends,
      invested,
      shares,
      marketValue,
      value,
      pnl,
      returnRate: invested > 0 ? pnl / invested : 0,
    };
  });

  const finalPoint = points[points.length - 1];
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  if (!finalPoint || !firstPrice || !lastPrice) {
    throw new Error("NO_PRICE_DATA");
  }
  const totalInvested = finalPoint.invested;
  const finalMarketValue = finalPoint.marketValue;
  const finalValue = finalPoint.value;
  const totalPnl = finalValue - totalInvested;
  const firstTime = new Date(firstPrice.date).getTime();
  const lastTime = new Date(lastPrice.date).getTime();
  const elapsedDays = Math.max(1, (lastTime - firstTime) / 86_400_000);
  const totalReturn = totalInvested > 0 ? totalPnl / totalInvested : 0;
  const annualizedReturn = totalInvested > 0 && finalValue > 0
    ? (finalValue / totalInvested) ** (365 / elapsedDays) - 1
    : 0;

  return {
    totalInvested,
    finalMarketValue,
    finalValue,
    totalPnl,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    totalDividends: finalPoint.cashDividends,
    priceMode,
    points,
  };
}
