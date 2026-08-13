import type { Holding } from "../data/mockData";
import type { PortfolioEvent } from "../services/portfolioEvents";

export interface HoldingDividendSummary {
  amount: number;
  count: number;
  countIncomplete: boolean;
}

const DIVIDEND_TYPES = new Set<PortfolioEvent["type"]>(["cash_dividend", "dividend_reinvest"]);

export function summarizeHoldingDividends(
  holding: Holding,
  events: PortfolioEvent[],
): HoldingDividendSummary | null {
  if (!(holding.market === "FUND" || holding.assetType === "fund" || holding.assetType === "stock" || holding.assetType === "etf")) {
    return null;
  }

  const dividendEvents = events.filter((event) => (
    event.holdingId === holding.id && DIVIDEND_TYPES.has(event.type)
  ));
  const knownEvents = dividendEvents.filter((event) => !/migrated cashdividendtotal summary/i.test(event.note ?? ""));
  const knownKeys = new Set(knownEvents.map((event) => event.corporateActionId || event.id));
  const eventAmount = dividendEvents.reduce((sum, event) => (
    event.currency === holding.currency && Number.isFinite(event.amount)
      ? sum + Math.max(0, event.amount)
      : sum
  ), 0);
  const storedAmount = Number.isFinite(holding.cashDividendTotal)
    ? Math.max(0, holding.cashDividendTotal ?? 0)
    : 0;
  const amount = Math.max(storedAmount, eventAmount);
  if (!(amount > 0)) return null;

  const tolerance = Math.max(0.01, amount * 1e-8);
  const knownAmount = knownEvents.reduce((sum, event) => (
    event.currency === holding.currency && Number.isFinite(event.amount)
      ? sum + Math.max(0, event.amount)
      : sum
  ), 0);
  return {
    amount,
    count: knownKeys.size,
    countIncomplete: dividendEvents.length !== knownEvents.length || knownAmount + tolerance < amount,
  };
}
