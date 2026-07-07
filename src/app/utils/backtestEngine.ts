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
  /** Share multiplier applied before same-day buys, e.g. 2 for a 2-for-1 split. */
  splitRatio?: number;
  /** Price is already adjusted for dividends/splits, so dividends must not be added again. */
  adjusted?: boolean;
};

export type BacktestPoint = {
  date: string;
  price: number;
  dividend: number;
  splitRatio: number;
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
  /** Drawdown of market value only, excluding accumulated cash dividends. */
  marketMaxDrawdown: number;
  /** Drawdown of total value including accumulated cash dividends. */
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

function xnpv(rate: number, cashFlows: Array<{ date: string; amount: number }>) {
  if (!cashFlows.length) return 0;
  const first = new Date(`${cashFlows[0]!.date}T00:00:00Z`).getTime();
  return cashFlows.reduce((sum, flow) => {
    const time = new Date(`${flow.date}T00:00:00Z`).getTime();
    if (!Number.isFinite(time) || !Number.isFinite(first)) return sum;
    const years = (time - first) / 31_536_000_000;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(cashFlows: Array<{ date: string; amount: number }>) {
  const hasPositive = cashFlows.some((flow) => flow.amount > 0);
  const hasNegative = cashFlows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) return 0;
  const firstDate = dateKey(cashFlows[0]?.date ?? "");
  if (!firstDate || cashFlows.every((flow) => dateKey(flow.date) === firstDate)) return 0;

  let low = -0.9999;
  let high = 10;
  let lowValue = xnpv(low, cashFlows);
  let highValue = xnpv(high, cashFlows);
  while (lowValue * highValue > 0 && high < 1_000_000) {
    high *= 10;
    highValue = xnpv(high, cashFlows);
  }
  if (lowValue * highValue > 0) return 0;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const value = xnpv(mid, cashFlows);
    if (Math.abs(value) < 1e-7) return mid;
    if (lowValue * value <= 0) {
      high = mid;
      highValue = value;
    } else {
      low = mid;
      lowValue = value;
    }
  }
  return (low + high) / 2;
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
      splitRatio: Number.isFinite(point.splitRatio) && Number(point.splitRatio) > 0 ? Number(point.splitRatio) : 1,
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
  let peakMarketValue = 0;
  let maxDrawdown = 0;
  let marketMaxDrawdown = 0;
  const cashFlows: Array<{ date: string; amount: number }> = [];

  const points = prices.map((point, index) => {
    if (point.splitRatio > 0 && point.splitRatio !== 1) {
      shares *= point.splitRatio;
    }

    // Ex-dividend cash belongs only to shares already held before this date.
    // Buy orders for the same date are applied after the dividend credit.
    const dividendCash = priceMode === "adjusted" ? 0 : shares * point.dividend;
    cashDividends += dividendCash;

    if (input.strategy === "lump_sum" && index === 0 && initialAmount > 0) {
      shares += buyShares(initialAmount, point.price, feeRate);
      invested += initialAmount;
      cashFlows.push({ date: point.date, amount: -initialAmount });
    }

    if (isDcaStrategy(input.strategy)) {
      const currentPeriod = periodKey(input.strategy, point.date);
      // Initial amount counts as this period's investment so the recurring
      // buy is skipped on the first trading day to avoid double-investing.
      if (index === 0 && initialAmount > 0) {
        shares += buyShares(initialAmount, point.price, feeRate);
        invested += initialAmount;
        cashFlows.push({ date: point.date, amount: -initialAmount });
        lastInvestmentPeriod = currentPeriod;
      } else if (currentPeriod && currentPeriod !== lastInvestmentPeriod && recurringAmount > 0) {
        shares += buyShares(recurringAmount, point.price, feeRate);
        invested += recurringAmount;
        cashFlows.push({ date: point.date, amount: -recurringAmount });
        lastInvestmentPeriod = currentPeriod;
      }
    }

    const marketValue = shares * point.price;
    const value = marketValue + cashDividends;
    if (value > peakValue) peakValue = value;
    if (peakValue > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peakValue - value) / peakValue);
    }
    if (marketValue > peakMarketValue) peakMarketValue = marketValue;
    if (peakMarketValue > 0) {
      marketMaxDrawdown = Math.max(marketMaxDrawdown, (peakMarketValue - marketValue) / peakMarketValue);
    }
    const pnl = value - invested;
    return {
      date: point.date,
      price: point.price,
      dividend: point.dividend,
      splitRatio: point.splitRatio,
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
  if (!finalPoint) {
    throw new Error("NO_PRICE_DATA");
  }
  const totalInvested = finalPoint.invested;
  const finalMarketValue = finalPoint.marketValue;
  const finalValue = finalPoint.value;
  const totalPnl = finalValue - totalInvested;
  const totalReturn = totalInvested > 0 ? totalPnl / totalInvested : 0;
  const annualizedReturn = totalInvested > 0 && finalValue > 0
    ? calculateXirr([...cashFlows, { date: finalPoint.date, amount: finalValue }])
    : 0;

  return {
    totalInvested,
    finalMarketValue,
    finalValue,
    totalPnl,
    totalReturn,
    annualizedReturn,
    marketMaxDrawdown,
    maxDrawdown,
    totalDividends: finalPoint.cashDividends,
    priceMode,
    points,
  };
}
