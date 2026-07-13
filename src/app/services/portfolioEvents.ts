import type { ClosedHolding, Holding } from "../data/mockData";
import { toCNY } from "./priceRefresher";

export type PortfolioEventType =
  | "buy"
  | "sell"
  | "cash_dividend"
  | "dividend_reinvest"
  | "share_dividend"
  | "split"
  | "interest"
  | "bond_coupon"
  | "fee"
  | "tax";

export type PortfolioEventSource = "manual" | "auto" | "import" | "system" | "migration";

export interface PortfolioEvent {
  id: string;
  date: string;
  holdingId?: string;
  symbol?: string;
  name?: string;
  market?: string;
  assetType?: string;
  type: PortfolioEventType;
  quantity?: number;
  price?: number;
  amount: number;
  amountInBase: number;
  currency: string;
  source: PortfolioEventSource;
  corporateActionId?: string;
  relatedEventId?: string;
  costBasisAtEvent?: number;
  proceeds?: number;
  note?: string;
  rateUsed?: number;
  minimumFeeUsed?: number;
  estimatedAmount?: number;
  createdAt: string;
}

export interface ReturnBreakdown {
  realizedTradingPnl: number;
  dividendPnl: number;
  transactionFeePnl: number;
  taxPnl: number;
  /** Aggregate of transactionFeePnl and taxPnl for snapshot compatibility. */
  feePnl: number;
}

export interface PortfolioEventBaseline {
  daily: Record<string, ReturnBreakdown>;
  realizedCostBasis: number;
}

export interface PortfolioSnapshotInput {
  date: string;
  totalAsset: number;
  todayPnl: number;
  cumulativePnl: number;
  unrealizedPnl?: number;
  realizedTradingPnl?: number;
  dividendPnl?: number;
  feePnl?: number;
  totalPnl?: number;
  migratedBaseline?: boolean;
  holdingUnrealizedPnl?: Record<string, number>;
}

export interface DailyReturn {
  date: string;
  unrealizedPnlChange: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  totalAsset: number;
  currency: "CNY";
  incompleteBreakdown?: boolean;
}

export interface MonthlyReturn {
  month: string;
  unrealizedPnlChange: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  currency: "CNY";
  incompleteBreakdown?: boolean;
}

export interface YearlyReturn {
  year: string;
  unrealizedPnlChange: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  currency: "CNY";
  incompleteBreakdown?: boolean;
}

export interface HoldingReturnContribution extends ReturnBreakdown {
  id: string;
  unrealizedPnlChange: number;
  totalPnl: number;
  incompleteBreakdown?: boolean;
}

type CorporateActionLike = NonNullable<Holding["corporateActions"]>[number];

type DCAExecutionLike = {
  id?: string;
  holdingId?: string;
  actualDate?: string;
  confirmedDate?: string;
  scheduledDate?: string;
  amount?: number;
  quantity?: number;
  price?: number;
  status?: string;
};

const EVENT_TYPES = new Set<PortfolioEventType>([
  "buy",
  "sell",
  "cash_dividend",
  "dividend_reinvest",
  "share_dividend",
  "split",
  "interest",
  "bond_coupon",
  "fee",
  "tax",
]);
const DIVIDEND_EVENT_TYPES = new Set<PortfolioEventType>([
  "cash_dividend",
  "dividend_reinvest",
  "interest",
  "bond_coupon",
]);
export const MAX_PORTFOLIO_EVENTS = 5000;

export function emptyReturnBreakdown(): ReturnBreakdown {
  return { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0 };
}

export function normalizePortfolioEventBaseline(raw: unknown): PortfolioEventBaseline {
  const candidate = raw && typeof raw === "object" ? raw as Partial<PortfolioEventBaseline> : {};
  const daily: Record<string, ReturnBreakdown> = {};
  if (candidate.daily && typeof candidate.daily === "object") {
    for (const [date, value] of Object.entries(candidate.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !value || typeof value !== "object") continue;
      const row = value as Partial<ReturnBreakdown>;
      daily[date] = {
        realizedTradingPnl: finiteNumber(row.realizedTradingPnl),
        dividendPnl: finiteNumber(row.dividendPnl),
        transactionFeePnl: finiteNumber(row.transactionFeePnl),
        taxPnl: finiteNumber(row.taxPnl),
        feePnl: finiteNumber(row.feePnl),
      };
    }
  }
  return { daily, realizedCostBasis: Math.max(0, finiteNumber(candidate.realizedCostBasis)) };
}

export function mergeReturnBreakdowns(a: ReturnBreakdown, b: ReturnBreakdown): ReturnBreakdown {
  return {
    realizedTradingPnl: a.realizedTradingPnl + b.realizedTradingPnl,
    dividendPnl: a.dividendPnl + b.dividendPnl,
    transactionFeePnl: a.transactionFeePnl + b.transactionFeePnl,
    taxPnl: a.taxPnl + b.taxPnl,
    feePnl: a.feePnl + b.feePnl,
  };
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ymdFromEventValue(value: unknown, fallback = new Date()) {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0]!;
  const year = fallback.getFullYear();
  const month = String(fallback.getMonth() + 1).padStart(2, "0");
  const day = String(fallback.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function amountInBase(amount: number, currency: string) {
  return toCNY(amount, currency);
}

export function dedupePortfolioEvents(events: PortfolioEvent[]) {
  const map = new Map<string, PortfolioEvent>();
  for (const event of events) {
    if (!event.id) continue;
    map.set(event.id, event);
  }
  return [...map.values()].sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    return byDate || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export function prunePortfolioEvents(events: PortfolioEvent[], maxEvents = MAX_PORTFOLIO_EVENTS) {
  return dedupePortfolioEvents(events).slice(-maxEvents);
}

export function compactPortfolioEventHistory(
  events: PortfolioEvent[],
  existingBaseline: PortfolioEventBaseline,
  maxEvents = MAX_PORTFOLIO_EVENTS,
) {
  const sorted = dedupePortfolioEvents(events);
  const removed = sorted.slice(0, Math.max(0, sorted.length - maxEvents));
  const baseline = normalizePortfolioEventBaseline(existingBaseline);
  for (const event of removed) {
    baseline.daily[event.date] = mergeReturnBreakdowns(
      baseline.daily[event.date] ?? emptyReturnBreakdown(),
      computeReturnBreakdown([event]),
    );
    if (event.type === "sell") {
      baseline.realizedCostBasis += amountInBase(event.costBasisAtEvent ?? 0, event.currency);
    }
  }
  return { events: sorted.slice(-maxEvents), baseline };
}

export function computeBaselineBreakdown(baseline?: PortfolioEventBaseline) {
  return Object.values(baseline?.daily ?? {}).reduce(
    (sum, row) => mergeReturnBreakdowns(sum, row),
    emptyReturnBreakdown(),
  );
}

export function normalizePortfolioEvent(raw: Partial<PortfolioEvent> & Record<string, unknown>): PortfolioEvent | null {
  if (!raw || typeof raw.id !== "string" || !raw.id) return null;
  const type = raw.type as PortfolioEventType;
  if (!EVENT_TYPES.has(type)) return null;
  const amount = finiteNumber(raw.amount);
  const currency = typeof raw.currency === "string" && raw.currency ? raw.currency : "CNY";
  const date = ymdFromEventValue(raw.date);
  return {
    id: raw.id,
    date,
    holdingId: typeof raw.holdingId === "string" ? raw.holdingId : undefined,
    symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    market: typeof raw.market === "string" ? raw.market : undefined,
    assetType: typeof raw.assetType === "string" ? raw.assetType : undefined,
    type,
    quantity: Number.isFinite(raw.quantity) ? Number(raw.quantity) : undefined,
    price: Number.isFinite(raw.price) ? Number(raw.price) : undefined,
    amount,
    amountInBase: Number.isFinite(raw.amountInBase) ? Number(raw.amountInBase) : amountInBase(amount, currency),
    currency,
    source: ["manual", "auto", "import", "system", "migration"].includes(String(raw.source))
      ? raw.source as PortfolioEventSource
      : "manual",
    corporateActionId: typeof raw.corporateActionId === "string" ? raw.corporateActionId : undefined,
    relatedEventId: typeof raw.relatedEventId === "string" ? raw.relatedEventId : undefined,
    costBasisAtEvent: Number.isFinite(raw.costBasisAtEvent) ? Number(raw.costBasisAtEvent) : undefined,
    proceeds: Number.isFinite(raw.proceeds) ? Number(raw.proceeds) : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    rateUsed: Number.isFinite(raw.rateUsed) ? Number(raw.rateUsed) : undefined,
    minimumFeeUsed: Number.isFinite(raw.minimumFeeUsed) ? Number(raw.minimumFeeUsed) : undefined,
    estimatedAmount: Number.isFinite(raw.estimatedAmount) ? Number(raw.estimatedAmount) : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : `${date}T00:00:00.000Z`,
  };
}

export function normalizePortfolioEvents(raw: unknown): PortfolioEvent[] {
  if (!Array.isArray(raw)) return [];
  return dedupePortfolioEvents(
    raw
      .map((item) => normalizePortfolioEvent(item as Partial<PortfolioEvent> & Record<string, unknown>))
      .filter((item): item is PortfolioEvent => item != null),
  );
}

function eventIdentityForHolding(holding: Holding) {
  return {
    holdingId: holding.id,
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    assetType: holding.assetType,
    currency: holding.currency,
  };
}

function eventFromCorporateAction(holding: Holding, action: CorporateActionLike, source: PortfolioEventSource): PortfolioEvent | null {
  const date = ymdFromEventValue(action.payDate || action.exDate || action.date);
  const base = {
    ...eventIdentityForHolding(holding),
    date,
    source,
    corporateActionId: action.id,
    note: action.note,
    rateUsed: action.rateUsed,
    minimumFeeUsed: action.minimumFeeUsed,
    estimatedAmount: action.estimatedAmount,
    createdAt: `${date}T00:00:00.000Z`,
  };
  const reinvest = action.type === "share_dividend" &&
    /dividend\s*reinvest|红利再投/i.test(action.note ?? "") &&
    Number(action.amount) > 0;

  if (action.type === "cash_dividend") {
    const amount = Math.max(0, finiteNumber(action.amount));
    if (!(amount > 0)) return null;
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: "cash_dividend",
      amount,
      amountInBase: amountInBase(amount, holding.currency),
    };
  }

  if (action.type === "dividend_reinvest") {
    const amount = Math.max(0, finiteNumber(action.amount));
    if (!(amount > 0)) return null;
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: "dividend_reinvest",
      quantity: finiteNumber(action.shares),
      price: Number.isFinite(action.price) ? action.price : undefined,
      amount,
      amountInBase: amountInBase(amount, holding.currency),
    };
  }

  if (reinvest) {
    const amount = Math.max(0, finiteNumber(action.amount));
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: "dividend_reinvest",
      quantity: finiteNumber(action.shares),
      price: Number.isFinite(action.price) ? action.price : undefined,
      amount,
      amountInBase: amountInBase(amount, holding.currency),
    };
  }

  if (action.type === "share_dividend") {
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: "share_dividend",
      quantity: finiteNumber(action.shares),
      amount: 0,
      amountInBase: 0,
    };
  }

  if (action.type === "split") {
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: "split",
      quantity: finiteNumber(action.ratio),
      amount: 0,
      amountInBase: 0,
    };
  }

  if (action.type === "interest" || action.type === "bond_coupon") {
    const amount = Math.max(0, finiteNumber(action.amount));
    if (!(amount > 0)) return null;
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: action.type,
      amount,
      amountInBase: amountInBase(amount, holding.currency),
    };
  }

  if (action.type === "fee" || action.type === "tax") {
    const amount = -Math.abs(finiteNumber(action.amount));
    if (!(amount < 0)) return null;
    return {
      ...base,
      id: `${source}:corp:${action.id}`,
      type: action.type,
      amount,
      amountInBase: amountInBase(amount, holding.currency),
    };
  }

  return null;
}

function dividendEventAmountForHolding(event: PortfolioEvent, identity: Pick<Holding, "id" | "symbol" | "market" | "currency">) {
  if (!DIVIDEND_EVENT_TYPES.has(event.type)) return 0;
  const matchesHoldingId = event.holdingId && event.holdingId === identity.id;
  const matchesSymbol = !event.holdingId && event.symbol === identity.symbol && event.market === identity.market;
  if (!matchesHoldingId && !matchesSymbol) return 0;
  return event.currency === identity.currency ? event.amount : event.amountInBase;
}

function dividendEventAmountForClosed(event: PortfolioEvent, closed: ClosedHolding) {
  if (!DIVIDEND_EVENT_TYPES.has(event.type)) return 0;
  const matchesHoldingId = event.holdingId && event.holdingId === closed.sourceHoldingId;
  const matchesSymbol = !event.holdingId && event.symbol === closed.symbol && event.market === closed.market;
  if (!matchesHoldingId && !matchesSymbol) return 0;
  return event.currency === closed.currency ? event.amount : event.amountInBase;
}

export function buildPortfolioEventFromCorporateAction(
  holding: Holding,
  action: CorporateActionLike,
  source: PortfolioEventSource = "manual",
) {
  return eventFromCorporateAction(holding, action, source);
}

export function buildBuyEvent(
  holding: Holding,
  input: { quantity: number; price: number; date?: string; source?: PortfolioEventSource; relatedEventId?: string },
): PortfolioEvent {
  const date = ymdFromEventValue(input.date);
  const amount = input.quantity * input.price;
  return {
    id: `${input.source ?? "manual"}:buy:${holding.id}:${date}:${input.quantity}:${input.price}:${input.relatedEventId ?? Date.now()}`,
    date,
    ...eventIdentityForHolding(holding),
    type: "buy",
    quantity: input.quantity,
    price: input.price,
    amount,
    amountInBase: amountInBase(amount, holding.currency),
    currency: holding.currency,
    source: input.source ?? "manual",
    relatedEventId: input.relatedEventId,
    createdAt: new Date().toISOString(),
  };
}

export function buildSellEvent(
  holding: Holding,
  input: { quantity: number; price: number; date?: string; source?: PortfolioEventSource; relatedEventId?: string },
): PortfolioEvent {
  const sellQuantity = Math.min(input.quantity, holding.quantity);
  const date = ymdFromEventValue(input.date);
  const costBasisAtEvent = sellQuantity * holding.costPrice;
  const proceeds = sellQuantity * input.price;
  const amount = proceeds - costBasisAtEvent;
  return {
    id: `${input.source ?? "manual"}:sell:${holding.id}:${date}:${sellQuantity}:${input.price}:${input.relatedEventId ?? Date.now()}`,
    date,
    ...eventIdentityForHolding(holding),
    type: "sell",
    quantity: sellQuantity,
    price: input.price,
    amount,
    amountInBase: amountInBase(amount, holding.currency),
    currency: holding.currency,
    source: input.source ?? "manual",
    relatedEventId: input.relatedEventId,
    costBasisAtEvent,
    proceeds,
    createdAt: new Date().toISOString(),
  };
}

export function migratePortfolioEvents(
  holdings: Holding[],
  closedHoldings: ClosedHolding[],
  dcaExecutions: DCAExecutionLike[],
  existingEvents: PortfolioEvent[] = [],
) {
  const eventMap = new Map(existingEvents.map((event) => [event.id, event]));
  const holdingById = new Map(holdings.map((holding) => [holding.id, holding]));
  const migratedCorporateActions = new Set(
    existingEvents
      .filter((event) => event.holdingId && event.corporateActionId)
      .map((event) => `${event.holdingId}:${event.corporateActionId}`),
  );
  const claimedSellEventIds = new Set<string>();

  for (const holding of holdings) {
    for (const action of holding.corporateActions ?? []) {
      const actionKey = `${holding.id}:${action.id}`;
      if (migratedCorporateActions.has(actionKey)) continue;
      const event = eventFromCorporateAction(holding, action, "migration");
      if (event) {
        eventMap.set(event.id, event);
        migratedCorporateActions.add(actionKey);
      }
    }
    const dividendEventTotal = [...eventMap.values()]
      .reduce((sum, event) => sum + Math.max(0, dividendEventAmountForHolding(event, holding)), 0);
    const missingDividend = Math.max(0, (holding.cashDividendTotal ?? 0) - dividendEventTotal);
    if (missingDividend > 0) {
      const date = ymdFromEventValue(holding.updatedAt);
      const event: PortfolioEvent = {
        id: `migration:cash-dividend-summary:${holding.id}:${date}:${holding.cashDividendTotal ?? 0}:${missingDividend}`,
        date,
        ...eventIdentityForHolding(holding),
        type: "cash_dividend",
        amount: missingDividend,
        amountInBase: amountInBase(missingDividend, holding.currency),
        currency: holding.currency,
        source: "migration",
        note: "migrated cashDividendTotal summary",
        createdAt: `${date}T00:00:00.000Z`,
      };
      eventMap.set(event.id, event);
    }
  }

  for (const closed of closedHoldings) {
    const date = ymdFromEventValue(closed.closedAt);
    for (const event of eventMap.values()) {
      if (event.id.startsWith("migration:closed") && event.id.includes(`:${closed.id}`)) {
        eventMap.set(event.id, { ...event, relatedEventId: closed.id });
      }
    }
    const sellAmount = finiteNumber(closed.proceeds) - finiteNumber(closed.costBasis);
    const matchingSell = [...eventMap.values()].find((event) => (
      event.type === "sell"
      && !claimedSellEventIds.has(event.id)
      && event.holdingId === closed.sourceHoldingId
      && event.date === date
      && Math.abs(finiteNumber(event.quantity) - finiteNumber(closed.quantity)) < 1e-8
      && Math.abs(finiteNumber(event.price) - finiteNumber(closed.closePrice)) < 1e-8
      && (!event.relatedEventId || event.relatedEventId === closed.id)
    ));
    const sellEvent: PortfolioEvent = matchingSell
      ? { ...matchingSell, relatedEventId: closed.id }
      : {
        id: `migration:closed:${closed.id}`,
        date,
        holdingId: closed.sourceHoldingId,
        symbol: closed.symbol,
        name: closed.name,
        market: closed.market,
        assetType: closed.assetType,
        type: "sell",
        quantity: closed.quantity,
        price: closed.closePrice,
        amount: sellAmount,
        amountInBase: amountInBase(sellAmount, closed.currency),
        currency: closed.currency,
        source: "migration",
        relatedEventId: closed.id,
        costBasisAtEvent: closed.costBasis,
        proceeds: closed.proceeds,
        createdAt: `${date}T00:00:00.000Z`,
      };
    eventMap.set(sellEvent.id, sellEvent);
    claimedSellEventIds.add(sellEvent.id);
    const dividendEventTotal = [...eventMap.values()]
      .reduce((sum, event) => sum + Math.max(0, dividendEventAmountForClosed(event, closed)), 0);
    const missingDividend = Math.max(0, finiteNumber(closed.cashDividendTotal) - dividendEventTotal);
    if (missingDividend > 0) {
      const event: PortfolioEvent = {
        id: `migration:closed-dividend-summary:${closed.id}:${date}:${closed.cashDividendTotal ?? 0}:${missingDividend}`,
        date,
        holdingId: closed.sourceHoldingId,
        symbol: closed.symbol,
        name: closed.name,
        market: closed.market,
        assetType: closed.assetType,
        type: "cash_dividend",
        amount: missingDividend,
        amountInBase: amountInBase(missingDividend, closed.currency),
        currency: closed.currency,
        source: "migration",
        relatedEventId: closed.id,
        note: "migrated closed holding cashDividendTotal summary",
        createdAt: `${date}T00:00:00.000Z`,
      };
      eventMap.set(event.id, event);
    }
    const hasExistingFees = [...eventMap.values()].some(
      (event) => (event.type === "fee" || event.type === "tax")
        && event.holdingId === closed.sourceHoldingId
        && event.date === date,
    );
    if (!hasExistingFees) {
      const explicitCosts = [
        { type: "fee" as const, amount: Math.max(0, finiteNumber(closed.transactionFee)), note: "migrated recorded transaction fee" },
        { type: "tax" as const, amount: Math.max(0, finiteNumber(closed.transactionTax)), note: "migrated recorded transaction tax" },
      ];
      for (const cost of explicitCosts) {
        if (!(cost.amount > 0)) continue;
        const event: PortfolioEvent = {
          id: `migration:closed-${cost.type}:${closed.id}:${date}`,
          date,
          holdingId: closed.sourceHoldingId,
          symbol: closed.symbol,
          name: closed.name,
          market: closed.market,
          assetType: closed.assetType,
          type: cost.type,
          amount: -cost.amount,
          amountInBase: amountInBase(-cost.amount, closed.currency),
          currency: closed.currency,
          source: "migration",
          relatedEventId: closed.id,
          note: cost.note,
          createdAt: `${date}T00:00:00.000Z`,
        };
        eventMap.set(event.id, event);
      }
      const hasExplicitCosts = explicitCosts.some((cost) => cost.amount > 0);
      if (!hasExplicitCosts && finiteNumber(closed.realizedPnl) < sellAmount) {
        const inferredFee = Math.max(0, sellAmount + missingDividend - finiteNumber(closed.realizedPnl));
        if (inferredFee > 0) {
          const event: PortfolioEvent = {
            id: `migration:closed-fee:${closed.id}:${date}`,
            date,
            holdingId: closed.sourceHoldingId,
            symbol: closed.symbol,
            name: closed.name,
            market: closed.market,
            assetType: closed.assetType,
            type: "fee",
            amount: -inferredFee,
            amountInBase: amountInBase(-inferredFee, closed.currency),
            currency: closed.currency,
            source: "migration",
            relatedEventId: closed.id,
            note: "inferred aggregate transaction cost from legacy closed holding",
            createdAt: `${date}T00:00:00.000Z`,
          };
          eventMap.set(event.id, event);
        }
      }
    }
  }

  for (const execution of dcaExecutions) {
    if (execution.status !== "executed") continue;
    const holding = execution.holdingId ? holdingById.get(execution.holdingId) : undefined;
    const quantity = finiteNumber(execution.quantity);
    const price = finiteNumber(execution.price);
    const amount = finiteNumber(execution.amount, quantity * price);
    if (!(amount > 0 || (quantity > 0 && price > 0))) continue;
    const date = ymdFromEventValue(execution.actualDate || execution.confirmedDate || execution.scheduledDate);
    const event: PortfolioEvent = {
      id: `migration:dca:${execution.id ?? `${execution.holdingId}:${date}`}`,
      date,
      holdingId: execution.holdingId,
      symbol: holding?.symbol,
      name: holding?.name,
      market: holding?.market,
      assetType: holding?.assetType,
      type: "buy",
      quantity: quantity || undefined,
      price: price || undefined,
      amount: amount > 0 ? amount : quantity * price,
      amountInBase: amountInBase(amount > 0 ? amount : quantity * price, holding?.currency ?? "CNY"),
      currency: holding?.currency ?? "CNY",
      source: "migration",
      relatedEventId: execution.id,
      createdAt: `${date}T00:00:00.000Z`,
    };
    eventMap.set(event.id, event);
  }

  return dedupePortfolioEvents([...eventMap.values()]);
}

export function computeReturnBreakdown(events: PortfolioEvent[]): ReturnBreakdown {
  return events.reduce<ReturnBreakdown>((acc, event) => {
    if (event.type === "sell") acc.realizedTradingPnl += event.amountInBase;
    if (event.type === "cash_dividend" || event.type === "dividend_reinvest" || event.type === "interest" || event.type === "bond_coupon") {
      acc.dividendPnl += event.amountInBase;
    }
    if (event.type === "fee") {
      acc.transactionFeePnl += event.amountInBase;
      acc.feePnl += event.amountInBase;
    }
    if (event.type === "tax") {
      acc.taxPnl += event.amountInBase;
      acc.feePnl += event.amountInBase;
    }
    return acc;
  }, { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0 });
}

function aggregateEventsByDate(events: PortfolioEvent[], baseline?: PortfolioEventBaseline) {
  const map = new Map<string, ReturnBreakdown>();
  for (const [date, row] of Object.entries(baseline?.daily ?? {})) {
    map.set(date, { ...row });
  }
  for (const event of events) {
    const bucket = map.get(event.date) ?? { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0 };
    const single = computeReturnBreakdown([event]);
    bucket.realizedTradingPnl += single.realizedTradingPnl;
    bucket.dividendPnl += single.dividendPnl;
    bucket.transactionFeePnl += single.transactionFeePnl;
    bucket.taxPnl += single.taxPnl;
    bucket.feePnl += single.feePnl;
    map.set(event.date, bucket);
  }
  return map;
}

export function getDailyReturns(events: PortfolioEvent[], snapshots: PortfolioSnapshotInput[], baseline?: PortfolioEventBaseline): DailyReturn[] {
  const eventByDate = aggregateEventsByDate(events, baseline);
  const snapshotByDate = new Map<string, PortfolioSnapshotInput>();
  for (const snapshot of snapshots) {
    if (snapshot.date && Number.isFinite(snapshot.totalAsset)) {
      snapshotByDate.set(snapshot.date, snapshot);
    }
  }
  const dates = new Set<string>([
    ...snapshotByDate.keys(),
    ...eventByDate.keys(),
  ]);
  const sortedDates = [...dates]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort((a, b) => a.localeCompare(b));
  const sortedSnapshots = [...snapshotByDate.values()]
    .filter((snapshot) => snapshot.date && Number.isFinite(snapshot.totalAsset))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows: DailyReturn[] = [];
  let lastSnapshotIndex = 0;
  let lastTotalAsset = sortedSnapshots[0]?.totalAsset ?? 0;
  let lastUnrealizedPnl: number | undefined;

  for (const date of sortedDates) {
    const snapshot = snapshotByDate.get(date);
    while (lastSnapshotIndex < sortedSnapshots.length && sortedSnapshots[lastSnapshotIndex]!.date <= date) {
      lastTotalAsset = sortedSnapshots[lastSnapshotIndex]!.totalAsset;
      lastSnapshotIndex += 1;
    }
    const hasBreakdown = Number.isFinite(snapshot?.unrealizedPnl);
    const currentUnrealized = hasBreakdown ? snapshot!.unrealizedPnl! : undefined;
    const isInitialBaseline = hasBreakdown && lastUnrealizedPnl === undefined;
    const unrealizedPnlChange = hasBreakdown
      ? isInitialBaseline ? 0 : currentUnrealized! - lastUnrealizedPnl!
      : 0;
    if (hasBreakdown) {
      lastUnrealizedPnl = currentUnrealized;
    }
    const eventBreakdown = eventByDate.get(date) ?? { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0 };
    const totalPnl = unrealizedPnlChange + eventBreakdown.realizedTradingPnl + eventBreakdown.dividendPnl + eventBreakdown.feePnl;
    rows.push({
      date,
      unrealizedPnlChange,
      realizedTradingPnl: eventBreakdown.realizedTradingPnl,
      dividendPnl: eventBreakdown.dividendPnl,
      feePnl: eventBreakdown.feePnl,
      totalPnl,
      totalAsset: snapshot?.totalAsset ?? lastTotalAsset,
      currency: "CNY",
      incompleteBreakdown: !snapshot || !hasBreakdown || isInitialBaseline || snapshot.migratedBaseline || undefined,
    });
  }
  return rows;
}

export function getMonthlyReturns(daily: DailyReturn[]): MonthlyReturn[] {
  const map = new Map<string, MonthlyReturn>();
  for (const row of daily) {
    const month = row.date.slice(0, 7);
    const current = map.get(month) ?? {
      month,
      unrealizedPnlChange: 0,
      realizedTradingPnl: 0,
      dividendPnl: 0,
      feePnl: 0,
      totalPnl: 0,
      currency: "CNY",
      incompleteBreakdown: undefined,
    };
    current.unrealizedPnlChange += row.unrealizedPnlChange;
    current.realizedTradingPnl += row.realizedTradingPnl;
    current.dividendPnl += row.dividendPnl;
    current.feePnl += row.feePnl;
    current.totalPnl += row.totalPnl;
    current.incompleteBreakdown = current.incompleteBreakdown || row.incompleteBreakdown || undefined;
    map.set(month, current);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function getYearlyReturns(daily: DailyReturn[]): YearlyReturn[] {
  const map = new Map<string, YearlyReturn>();
  for (const row of daily) {
    const year = row.date.slice(0, 4);
    const current = map.get(year) ?? {
      year,
      unrealizedPnlChange: 0,
      realizedTradingPnl: 0,
      dividendPnl: 0,
      feePnl: 0,
      totalPnl: 0,
      currency: "CNY",
      incompleteBreakdown: undefined,
    };
    current.unrealizedPnlChange += row.unrealizedPnlChange;
    current.realizedTradingPnl += row.realizedTradingPnl;
    current.dividendPnl += row.dividendPnl;
    current.feePnl += row.feePnl;
    current.totalPnl += row.totalPnl;
    current.incompleteBreakdown = current.incompleteBreakdown || row.incompleteBreakdown || undefined;
    map.set(year, current);
  }
  return [...map.values()].sort((a, b) => a.year.localeCompare(b.year));
}

export function getHoldingReturnContributions(
  events: PortfolioEvent[],
  snapshots: PortfolioSnapshotInput[],
  startDate: string,
  endDate: string,
): HoldingReturnContribution[] {
  const mappedSnapshots = snapshots
    .filter((snapshot) => (
      snapshot.date <= endDate &&
      snapshot.holdingUnrealizedPnl &&
      typeof snapshot.holdingUnrealizedPnl === "object"
    ))
    .sort((a, b) => a.date.localeCompare(b.date));
  const endCandidate = mappedSnapshots.filter((snapshot) => snapshot.date <= endDate).at(-1);
  const endSnapshot = endCandidate && endCandidate.date >= startDate ? endCandidate : undefined;
  const baselineSnapshot = mappedSnapshots.filter((snapshot) => snapshot.date < startDate).at(-1);
  const firstInRange = mappedSnapshots.find((snapshot) => snapshot.date >= startDate);
  const canUseZeroBaseline = !baselineSnapshot && firstInRange?.migratedBaseline === true;
  const fallbackBaseline = !baselineSnapshot && firstInRange && !canUseZeroBaseline ? firstInRange : undefined;
  const baselineMap = baselineSnapshot?.holdingUnrealizedPnl
    ?? (canUseZeroBaseline ? {} : fallbackBaseline?.holdingUnrealizedPnl);
  const endMap = endSnapshot?.holdingUnrealizedPnl;
  const incompleteBreakdown = !endMap || !baselineMap || Boolean(fallbackBaseline) || canUseZeroBaseline;

  const result = new Map<string, HoldingReturnContribution>();
  const ensure = (id: string) => {
    const current = result.get(id) ?? {
      id,
      unrealizedPnlChange: 0,
      realizedTradingPnl: 0,
      dividendPnl: 0,
      transactionFeePnl: 0,
      taxPnl: 0,
      feePnl: 0,
      totalPnl: 0,
      incompleteBreakdown: incompleteBreakdown || undefined,
    };
    result.set(id, current);
    return current;
  };

  if (endMap && baselineMap) {
    const ids = new Set([...Object.keys(baselineMap), ...Object.keys(endMap)]);
    for (const id of ids) {
      ensure(id).unrealizedPnlChange = finiteNumber(endMap[id]) - finiteNumber(baselineMap[id]);
    }
  }

  for (const event of events) {
    if (event.date < startDate || event.date > endDate) continue;
    const id = event.holdingId || `${event.market ?? ""}:${event.symbol ?? ""}`;
    if (!id || id === ":") continue;
    const current = ensure(id);
    const breakdown = computeReturnBreakdown([event]);
    current.realizedTradingPnl += breakdown.realizedTradingPnl;
    current.dividendPnl += breakdown.dividendPnl;
    current.transactionFeePnl += breakdown.transactionFeePnl;
    current.taxPnl += breakdown.taxPnl;
    current.feePnl += breakdown.feePnl;
  }

  return [...result.values()]
    .map((row) => ({
      ...row,
      totalPnl: row.unrealizedPnlChange + row.realizedTradingPnl + row.dividendPnl + row.feePnl,
    }))
    .filter((row) => Number.isFinite(row.totalPnl) && row.totalPnl !== 0)
    .sort((a, b) => b.totalPnl - a.totalPnl);
}
