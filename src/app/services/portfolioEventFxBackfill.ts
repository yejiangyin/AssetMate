import { fetchBacktestDailyPrices, type DailyPricePoint } from "./quoteApi";
import type { PortfolioEvent } from "./portfolioEvents";

type PriceFetcher = typeof fetchBacktestDailyPrices;

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fxSymbol(currency: string) {
  const normalized = currency.toUpperCase();
  if (normalized === "USD" || normalized === "USDT" || normalized === "USDC") return "CNY=X";
  return `${normalized}CNY=X`;
}

function latestRate(points: DailyPricePoint[], date: string) {
  return points
    .filter((point) => point.date <= date && Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1)?.price;
}

/** Resolves legacy/past foreign-currency events with their event-date FX rate. */
export async function backfillPortfolioEventFxRates(
  events: PortfolioEvent[],
  fetchPrices: PriceFetcher = fetchBacktestDailyPrices,
) {
  const targets = events.filter((event) => event.fxRateEstimated && event.currency.toUpperCase() !== "CNY");
  if (!targets.length) return events;
  const keys = [...new Set(targets.map((event) => `${event.currency.toUpperCase()}:${event.date}`))];
  const rates = new Map<string, number>();
  await Promise.all(keys.map(async (key) => {
    const [currency, date] = key.split(":") as [string, string];
    try {
      const points = await fetchPrices(fxSymbol(currency), "FX", shiftDate(date, -10), date, { preferAdjusted: false });
      const rate = latestRate(points, date);
      if (rate && rate > 0) rates.set(key, rate);
    } catch {
      // Keep the event marked estimated so a later app session can retry.
    }
  }));
  if (!rates.size) return events;
  return events.map((event) => {
    const rate = rates.get(`${event.currency.toUpperCase()}:${event.date}`);
    if (!rate) return event;
    const proceeds = Number(event.proceeds) || 0;
    return {
      ...event,
      amountInBase: event.amount * rate,
      capitalFlowInBase: event.type === "buy"
        ? event.amount * rate
        : event.type === "sell" && proceeds > 0
          ? -proceeds * rate
          : event.capitalFlowInBase,
      fxRateToBase: rate,
      fxRateEstimated: undefined,
    };
  });
}
