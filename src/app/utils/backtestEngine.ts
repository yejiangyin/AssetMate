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
  sellFeeRate?: number;
  buyTaxRate?: number;
  sellTaxRate?: number;
  dividendTaxRate?: number;
  minimumFee?: number;
  liquidateAtEnd?: boolean;
  dividendMode?: "cash" | "reinvest";
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
  unitValue: number;
};

export type BacktestPeriodReturn = {
  key: string;
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
  grossDividends: number;
  dividendDataStatus: "explicit" | "embedded" | "unavailable" | "not_applicable";
  totalFees: number;
  totalTaxes: number;
  tradeCount: number;
  actualStartDate: string;
  actualEndDate: string;
  liquidatedAtEnd: boolean;
  dividendMode: "cash" | "reinvest";
  maxDrawdownStartDate: string;
  maxDrawdownEndDate: string;
  monthlyReturns: BacktestPeriodReturn[];
  yearlyReturns: BacktestPeriodReturn[];
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

function transactionCost(amount: number, feeRate: number, taxRate: number, minimumFee: number) {
  const safeAmount = normalizeAmount(amount);
  const fee = safeAmount > 0 && feeRate > 0 ? Math.max(safeAmount * feeRate, minimumFee) : 0;
  const tax = safeAmount > 0 && taxRate > 0 ? safeAmount * taxRate : 0;
  return { fee, tax };
}

function buyShares(amount: number, price: number, feeRate: number, taxRate: number, minimumFee: number) {
  const gross = normalizeAmount(amount);
  if (gross <= 0 || price <= 0) return 0;
  const { fee, tax } = transactionCost(gross, feeRate, taxRate, minimumFee);
  return Math.max(0, gross - fee - tax) / price;
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

function aggregatePeriodReturns(points: BacktestPoint[], keyForDate: (date: string) => string) {
  const result: BacktestPeriodReturn[] = [];
  let previousUnitValue = 1;
  let index = 0;
  while (index < points.length) {
    const key = keyForDate(points[index]!.date);
    let end = index;
    while (end + 1 < points.length && keyForDate(points[end + 1]!.date) === key) end += 1;
    const endingUnitValue = points[end]!.unitValue;
    result.push({ key, returnRate: previousUnitValue > 0 ? endingUnitValue / previousUnitValue - 1 : 0 });
    previousUnitValue = endingUnitValue;
    index = end + 1;
  }
  return result;
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
  const adjustedPointCount = prices.filter((point) => point.adjusted).length;
  if (adjustedPointCount > 0 && adjustedPointCount < prices.length) {
    throw new Error("MIXED_PRICE_MODE");
  }

  const feeRate = Number.isFinite(input.feeRate) ? Math.max(0, input.feeRate) : 0;
  const sellFeeRate = Number.isFinite(input.sellFeeRate) ? Math.max(0, input.sellFeeRate ?? 0) : feeRate;
  const buyTaxRate = Number.isFinite(input.buyTaxRate) ? Math.max(0, input.buyTaxRate ?? 0) : 0;
  const sellTaxRate = Number.isFinite(input.sellTaxRate) ? Math.max(0, input.sellTaxRate ?? 0) : 0;
  const dividendTaxRate = Number.isFinite(input.dividendTaxRate) ? Math.max(0, input.dividendTaxRate ?? 0) : 0;
  const minimumFee = Number.isFinite(input.minimumFee) ? Math.max(0, input.minimumFee ?? 0) : 0;
  const initialAmount = normalizeAmount(input.initialAmount);
  const recurringAmount = normalizeAmount(input.monthlyAmount);
  const priceMode = adjustedPointCount === prices.length ? "adjusted" : "cash_dividend";
  const dividendDataStatus: BacktestResult["dividendDataStatus"] = priceMode === "adjusted"
    ? "embedded"
    : input.market === "FUND"
      ? "unavailable"
      : ["CRYPTO", "GOLD", "INDEX", "FX", "COMMODITY"].includes(input.market)
        ? "not_applicable"
        : "explicit";
  let shares = 0;
  let invested = 0;
  let cashDividends = 0;
  let totalDividendIncome = 0;
  let grossDividendIncome = 0;
  let lastInvestmentPeriod = "";
  let maxDrawdown = 0;
  let marketMaxDrawdown = 0;
  let navUnits = 0;
  let peakNav = 0;
  let peakNavDate = "";
  let maxDrawdownStartDate = "";
  let maxDrawdownEndDate = "";
  let marketNavUnits = 0;
  let peakMarketNav = 0;
  let totalFees = 0;
  let totalTaxes = 0;
  let tradeCount = 0;
  const cashFlows: Array<{ date: string; amount: number }> = [];

  const points = prices.map((point, index) => {
    if (point.splitRatio > 0 && point.splitRatio !== 1) {
      shares *= point.splitRatio;
    }

    // Ex-dividend cash belongs only to shares already held before this date.
    // Buy orders for the same date are applied after the dividend credit.
    const grossDividendCash = priceMode === "adjusted" ? 0 : shares * point.dividend;
    const dividendTax = grossDividendCash * dividendTaxRate;
    const dividendCash = Math.max(0, grossDividendCash - dividendTax);
    grossDividendIncome += grossDividendCash;
    totalDividendIncome += dividendCash;
    totalTaxes += dividendTax;
    if (input.dividendMode === "reinvest" && dividendCash > 0) {
      shares += dividendCash / point.price;
    } else {
      cashDividends += dividendCash;
    }
    const valueBeforeFlow = shares * point.price + cashDividends;
    const marketValueBeforeFlow = shares * point.price;

    let externalFlow = 0;
    if (input.strategy === "lump_sum" && index === 0 && initialAmount > 0) {
      const { fee, tax } = transactionCost(initialAmount, feeRate, buyTaxRate, minimumFee);
      shares += buyShares(initialAmount, point.price, feeRate, buyTaxRate, minimumFee);
      invested += initialAmount;
      externalFlow += initialAmount;
      totalFees += fee;
      totalTaxes += tax;
      tradeCount += 1;
      cashFlows.push({ date: point.date, amount: -initialAmount });
    }

    if (isDcaStrategy(input.strategy)) {
      const currentPeriod = periodKey(input.strategy, point.date);
      // Initial amount counts as this period's investment so the recurring
      // buy is skipped on the first trading day to avoid double-investing.
      if (index === 0 && initialAmount > 0) {
        const { fee, tax } = transactionCost(initialAmount, feeRate, buyTaxRate, minimumFee);
        shares += buyShares(initialAmount, point.price, feeRate, buyTaxRate, minimumFee);
        invested += initialAmount;
        externalFlow += initialAmount;
        totalFees += fee;
        totalTaxes += tax;
        tradeCount += 1;
        cashFlows.push({ date: point.date, amount: -initialAmount });
        lastInvestmentPeriod = currentPeriod;
      } else if (currentPeriod && currentPeriod !== lastInvestmentPeriod && recurringAmount > 0) {
        const { fee, tax } = transactionCost(recurringAmount, feeRate, buyTaxRate, minimumFee);
        shares += buyShares(recurringAmount, point.price, feeRate, buyTaxRate, minimumFee);
        invested += recurringAmount;
        externalFlow += recurringAmount;
        totalFees += fee;
        totalTaxes += tax;
        tradeCount += 1;
        cashFlows.push({ date: point.date, amount: -recurringAmount });
        lastInvestmentPeriod = currentPeriod;
      }
    }

    const marketValue = shares * point.price;
    const value = marketValue + cashDividends;
    if (externalFlow > 0) {
      const unitPriceBeforeFlow = navUnits > 0 ? valueBeforeFlow / navUnits : 1;
      navUnits += unitPriceBeforeFlow > 0 ? externalFlow / unitPriceBeforeFlow : externalFlow;
    }
    const nav = navUnits > 0 ? value / navUnits : 0;
    if (nav > peakNav) {
      peakNav = nav;
      peakNavDate = point.date;
    }
    if (peakNav > 0) {
      const drawdown = (peakNav - nav) / peakNav;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownStartDate = peakNavDate;
        maxDrawdownEndDate = point.date;
      }
    }
    if (externalFlow > 0) {
      const marketUnitPriceBeforeFlow = marketNavUnits > 0 ? marketValueBeforeFlow / marketNavUnits : 1;
      marketNavUnits += marketUnitPriceBeforeFlow > 0 ? externalFlow / marketUnitPriceBeforeFlow : externalFlow;
    }
    const marketNav = marketNavUnits > 0 ? marketValue / marketNavUnits : 0;
    if (marketNav > peakMarketNav) peakMarketNav = marketNav;
    if (peakMarketNav > 0) {
      marketMaxDrawdown = Math.max(marketMaxDrawdown, (peakMarketNav - marketNav) / peakMarketNav);
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
      unitValue: nav,
    };
  });

  const finalPoint = points[points.length - 1];
  if (!finalPoint) {
    throw new Error("NO_PRICE_DATA");
  }
  const totalInvested = finalPoint.invested;
  const finalMarketValue = finalPoint.marketValue;
  let finalValue = finalPoint.value;
  if (input.liquidateAtEnd && finalMarketValue > 0) {
    const valueBeforeLiquidation = finalValue;
    const saleCosts = transactionCost(finalMarketValue, sellFeeRate, sellTaxRate, minimumFee);
    totalFees += saleCosts.fee;
    totalTaxes += saleCosts.tax;
    tradeCount += 1;
    finalValue -= saleCosts.fee + saleCosts.tax;
    finalPoint.value = finalValue;
    finalPoint.pnl = finalValue - totalInvested;
    finalPoint.returnRate = totalInvested > 0 ? finalPoint.pnl / totalInvested : 0;
    finalPoint.unitValue = valueBeforeLiquidation > 0
      ? finalPoint.unitValue * finalValue / valueBeforeLiquidation
      : finalPoint.unitValue;
    if (peakNav > 0) {
      const liquidationDrawdown = (peakNav - finalPoint.unitValue) / peakNav;
      if (liquidationDrawdown > maxDrawdown) {
        maxDrawdown = liquidationDrawdown;
        maxDrawdownStartDate = peakNavDate;
        maxDrawdownEndDate = finalPoint.date;
      }
    }
  }
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
    totalDividends: totalDividendIncome,
    grossDividends: grossDividendIncome,
    dividendDataStatus,
    totalFees,
    totalTaxes,
    tradeCount,
    actualStartDate: prices[0]!.date,
    actualEndDate: finalPoint.date,
    liquidatedAtEnd: input.liquidateAtEnd === true,
    dividendMode: input.dividendMode === "reinvest" ? "reinvest" : "cash",
    maxDrawdownStartDate,
    maxDrawdownEndDate,
    monthlyReturns: aggregatePeriodReturns(points, monthKey),
    yearlyReturns: aggregatePeriodReturns(points, (date) => dateKey(date).slice(0, 4)),
    priceMode,
    points,
  };
}
