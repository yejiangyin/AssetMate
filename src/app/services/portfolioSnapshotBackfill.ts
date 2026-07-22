import type { Holding } from "../data/mockData";
import { FX } from "./priceRefresher";
import { fetchBacktestDailyPrices, type DailyPricePoint } from "./quoteApi";
import type { PortfolioEvent, PortfolioEventBaseline, ReturnBreakdown } from "./portfolioEvents";

export interface HistoricalPortfolioSnapshot {
  date: string;
  totalAsset: number;
  todayPnl: number;
  cumulativePnl: number;
  unrealizedPnl: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  estimated: true;
  estimateReason: "historical_backfill";
  fxFallback?: boolean;
  holdingUnrealizedPnl: Record<string, number>;
}

export interface SnapshotBackfillResult {
  snapshots: HistoricalPortfolioSnapshot[];
  completedDates: string[];
  failedDates: string[];
  errors: string[];
}

type PriceFetcher = typeof fetchBacktestDailyPrices;

type PositionIdentity = {
  key: string;
  holdingId?: string;
  symbol: string;
  market: string;
  assetType: string;
  currency: string;
  quantity: number;
  costBasis: number;
};

const DAY_MS = 86_400_000;
const POSITION_EPSILON = 1e-8;
const EMPTY_BREAKDOWN: ReturnBreakdown = {
  realizedTradingPnl: 0,
  dividendPnl: 0,
  transactionFeePnl: 0,
  taxPnl: 0,
  feePnl: 0,
};

function utcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function shiftDate(value: string, days: number) {
  return new Date(utcDate(value).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function isYmd(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = utcDate(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function collectMissingSnapshotDates(
  existingDates: string[],
  queuedDates: string[],
  today: string,
  maxDays = 1825,
) {
  const existing = new Set(existingDates.filter(isYmd));
  const candidates = new Set(queuedDates.filter((date) => isYmd(date) && date < today));
  const earliestExisting = [...existing].filter((date) => date < today).sort()[0];
  if (earliestExisting) {
    const earliestAllowed = shiftDate(today, -Math.max(1, maxDays));
    const start = earliestExisting < earliestAllowed ? earliestAllowed : shiftDate(earliestExisting, 1);
    for (let date = start; date < today; date = shiftDate(date, 1)) {
      if (date >= earliestAllowed) candidates.add(date);
    }
  }
  return [...candidates].filter((date) => !existing.has(date)).sort();
}

function identityKey(event: Pick<PortfolioEvent, "holdingId" | "market" | "symbol">, holdingKeyBySymbol: Map<string, string>) {
  if (event.holdingId) return event.holdingId;
  const symbolKey = `${event.market ?? ""}:${event.symbol ?? ""}`;
  return holdingKeyBySymbol.get(symbolKey) ?? symbolKey;
}

function buildIdentities(holdings: Holding[], events: PortfolioEvent[]) {
  const holdingKeyBySymbol = new Map(holdings.map((holding) => [`${holding.market}:${holding.symbol}`, holding.id]));
  const identities = new Map<string, PositionIdentity>();
  for (const holding of holdings) {
    identities.set(holding.id, {
      key: holding.id,
      holdingId: holding.id,
      symbol: holding.symbol,
      market: holding.market,
      assetType: holding.assetType,
      currency: holding.currency,
      quantity: holding.quantity,
      costBasis: holding.quantity * holding.costPrice,
    });
  }
  for (const event of events) {
    if (!event.symbol || !event.market) continue;
    const key = identityKey(event, holdingKeyBySymbol);
    if (identities.has(key)) continue;
    identities.set(key, {
      key,
      holdingId: event.holdingId,
      symbol: event.symbol,
      market: event.market,
      assetType: event.assetType ?? "stock",
      currency: event.currency || "CNY",
      quantity: 0,
      costBasis: 0,
    });
  }
  return { identities, holdingKeyBySymbol };
}

function positionOnDate(
  identity: PositionIdentity,
  events: PortfolioEvent[],
  holdingKeyBySymbol: Map<string, string>,
  date: string,
) {
  let quantity = identity.quantity;
  let costBasis = identity.costBasis;
  const laterEvents = events
    .filter((event) => event.date > date && identityKey(event, holdingKeyBySymbol) === identity.key)
    .sort((a, b) => `${b.date}:${b.createdAt}`.localeCompare(`${a.date}:${a.createdAt}`));

  for (const event of laterEvents) {
    const eventQuantity = Math.max(0, Number(event.quantity) || 0);
    if (event.type === "buy") {
      quantity -= eventQuantity;
      costBasis -= eventQuantity * Math.max(0, Number(event.price) || 0);
    } else if (event.type === "sell") {
      quantity += eventQuantity;
      costBasis += Math.max(0, Number(event.costBasisAtEvent) || 0);
    } else if (event.type === "dividend_reinvest") {
      quantity -= eventQuantity;
      costBasis -= Math.max(0, Number(event.amount) || eventQuantity * Math.max(0, Number(event.price) || 0));
    } else if (event.type === "share_dividend") {
      quantity -= eventQuantity;
    } else if (event.type === "split") {
      const ratio = Number(event.quantity);
      if (Number.isFinite(ratio) && ratio > 0) quantity /= ratio;
    }
  }

  if (quantity < POSITION_EPSILON) return { quantity: 0, costBasis: 0 };
  return { quantity, costBasis: Math.max(0, costBasis) };
}

function latestPrice(points: DailyPricePoint[], date: string) {
  let value: number | undefined;
  for (const point of points) {
    if (point.date > date) break;
    if (Number.isFinite(point.price) && point.price > 0) value = point.price;
  }
  return value;
}

function cumulativeBreakdown(events: PortfolioEvent[], baseline: PortfolioEventBaseline, date: string) {
  const total = { ...EMPTY_BREAKDOWN };
  const add = (row: Partial<ReturnBreakdown>) => {
    total.realizedTradingPnl += Number(row.realizedTradingPnl) || 0;
    total.dividendPnl += Number(row.dividendPnl) || 0;
    total.transactionFeePnl += Number(row.transactionFeePnl) || 0;
    total.taxPnl += Number(row.taxPnl) || 0;
    total.feePnl += Number(row.feePnl) || 0;
  };
  for (const [eventDate, row] of Object.entries(baseline.daily)) {
    if (eventDate <= date) add(row);
  }
  for (const event of events) {
    if (event.date > date) continue;
    if (event.type === "sell") total.realizedTradingPnl += event.amountInBase;
    if (["cash_dividend", "dividend_reinvest", "interest", "bond_coupon"].includes(event.type)) total.dividendPnl += event.amountInBase;
    if (event.type === "fee") {
      total.transactionFeePnl += event.amountInBase;
      total.feePnl += event.amountInBase;
    }
    if (event.type === "tax") {
      total.taxPnl += event.amountInBase;
      total.feePnl += event.amountInBase;
    }
  }
  return total;
}

function fxSymbol(currency: string) {
  const normalized = currency.toUpperCase();
  if (normalized === "USD" || normalized === "USDT" || normalized === "USDC") return "CNY=X";
  return `${normalized}CNY=X`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function backfillPortfolioSnapshots(input: {
  dates: string[];
  holdings: Holding[];
  events: PortfolioEvent[];
  baseline: PortfolioEventBaseline;
  fetchPrices?: PriceFetcher;
}): Promise<SnapshotBackfillResult> {
  const dates = [...new Set(input.dates.filter(isYmd))].sort();
  if (!dates.length) return { snapshots: [], completedDates: [], failedDates: [], errors: [] };
  const fetchPrices = input.fetchPrices ?? fetchBacktestDailyPrices;
  const { identities, holdingKeyBySymbol } = buildIdentities(input.holdings, input.events);
  const positionsByDate = new Map<string, Map<string, { quantity: number; costBasis: number }>>();
  const requiredKeys = new Set<string>();
  for (const date of dates) {
    const positions = new Map<string, { quantity: number; costBasis: number }>();
    for (const identity of identities.values()) {
      const position = positionOnDate(identity, input.events, holdingKeyBySymbol, date);
      positions.set(identity.key, position);
      if (position.quantity > POSITION_EPSILON && identity.assetType !== "cash") requiredKeys.add(identity.key);
    }
    positionsByDate.set(date, positions);
  }

  // Pull a long lookback so weekends, long market holidays and suspensions can
  // still carry the last genuine close instead of fabricating a current price.
  const startDate = shiftDate(dates[0]!, -370);
  const endDate = dates.at(-1)!;
  const priceSeries = new Map<string, DailyPricePoint[]>();
  const errors: string[] = [];
  await mapWithConcurrency([...requiredKeys], 4, async (key) => {
    const identity = identities.get(key)!;
    try {
      const points = await fetchPrices(identity.symbol, identity.market, startDate, endDate, { preferAdjusted: false });
      priceSeries.set(key, points);
    } catch (error) {
      errors.push(`${identity.symbol}: ${error instanceof Error ? error.message : "price_failed"}`);
      priceSeries.set(key, []);
    }
  });

  const currencies = [...new Set([...identities.values()].map((item) => item.currency.toUpperCase()))]
    .filter((currency) => currency !== "CNY");
  const fxSeries = new Map<string, DailyPricePoint[]>();
  await mapWithConcurrency(currencies, 3, async (currency) => {
    try {
      fxSeries.set(currency, await fetchPrices(fxSymbol(currency), "FX", startDate, endDate, { preferAdjusted: false }));
    } catch {
      fxSeries.set(currency, []);
    }
  });

  const snapshots: HistoricalPortfolioSnapshot[] = [];
  const completedDates: string[] = [];
  const failedDates: string[] = [];
  for (const date of dates) {
    let totalAsset = 0;
    let unrealizedPnl = 0;
    let failed = false;
    let fxFallback = false;
    const holdingUnrealizedPnl: Record<string, number> = {};
    for (const identity of identities.values()) {
      const position = positionsByDate.get(date)!.get(identity.key)!;
      if (!(position.quantity > POSITION_EPSILON)) continue;
      const price = identity.assetType === "cash" ? 1 : latestPrice(priceSeries.get(identity.key) ?? [], date);
      if (!(price && price > 0)) {
        failed = true;
        continue;
      }
      const currency = identity.currency.toUpperCase();
      let rate = 1;
      if (currency !== "CNY") {
        const historicalRate = latestPrice(fxSeries.get(currency) ?? [], date);
        const fallbackRate = FX[currency as keyof typeof FX];
        if (historicalRate) {
          rate = historicalRate;
        } else if (fallbackRate && fallbackRate > 0) {
          rate = fallbackRate;
          fxFallback = true;
        } else {
          failed = true;
          continue;
        }
      }
      const marketValue = position.quantity * price * rate;
      const holdingPnl = (position.quantity * price - position.costBasis) * rate;
      totalAsset += marketValue;
      unrealizedPnl += holdingPnl;
      holdingUnrealizedPnl[identity.holdingId ?? identity.key] = holdingPnl;
    }
    if (failed) {
      failedDates.push(date);
      continue;
    }
    const breakdown = cumulativeBreakdown(input.events, input.baseline, date);
    const cumulativeRealized = breakdown.realizedTradingPnl + breakdown.dividendPnl + breakdown.feePnl;
    const totalPnl = unrealizedPnl + cumulativeRealized;
    snapshots.push({
      date,
      totalAsset,
      todayPnl: 0,
      cumulativePnl: totalPnl,
      unrealizedPnl,
      realizedTradingPnl: breakdown.realizedTradingPnl,
      dividendPnl: breakdown.dividendPnl,
      feePnl: breakdown.feePnl,
      totalPnl,
      estimated: true,
      estimateReason: "historical_backfill",
      fxFallback: fxFallback || undefined,
      holdingUnrealizedPnl,
    });
    completedDates.push(date);
  }

  return { snapshots, completedDates, failedDates, errors };
}
