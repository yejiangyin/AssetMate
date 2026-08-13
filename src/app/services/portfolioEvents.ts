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
  /** Cash settlement date when it differs from the return recognition date. */
  settlementDate?: string;
  holdingId?: string;
  /** Snapshot of the group at event time so history remains filterable after close/delete. */
  groupId?: string;
  symbol?: string;
  name?: string;
  market?: string;
  assetType?: string;
  type: PortfolioEventType;
  quantity?: number;
  price?: number;
  amount: number;
  amountInBase: number;
  fxRateToBase?: number;
  fxRateEstimated?: boolean;
  /**
   * Change in capital represented by this event in the portfolio base
   * currency. Buys are positive contributions and sales are negative
   * withdrawals because the app currently tracks invested positions rather
   * than a brokerage cash balance.
   */
  capitalFlowInBase?: number;
  capitalFlowIncomplete?: boolean;
  currency: string;
  source: PortfolioEventSource;
  corporateActionId?: string;
  corporateActionKind?: "share_bonus_transfer";
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
  /** Position-account contribution (+) or withdrawal (-), not investment P/L. */
  capitalFlow?: number;
}

export interface PortfolioEventBaseline {
  daily: Record<string, ReturnBreakdown>;
  realizedCostBasis: number;
  /** Dates before this boundary cannot be position-reconstructed after compaction. */
  positionHistoryStart?: string;
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
  estimated?: boolean;
  estimateReason?: "historical_backfill";
  fxFallback?: boolean;
  holdingUnrealizedPnl?: Record<string, number>;
  /** Actual source valuation date for each holding, used for market-day attribution. */
  holdingValuationDates?: Record<string, string>;
}

export interface DailyReturn {
  date: string;
  unrealizedPnlChange: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  totalAsset: number;
  capitalFlow: number;
  currency: "CNY";
  incompleteBreakdown?: boolean;
  estimatedSnapshot?: boolean;
  fxFallback?: boolean;
  valuationSpanDays?: number;
}

export interface DailyReturnAttributionOptions {
  /**
   * Market captured for each holding id. When supplied, non-crypto valuation
   * changes first observed on a weekend are attributed to the preceding
   * weekday, while continuously traded crypto keeps its calendar-day return.
   */
  holdingMarkets?: Record<string, string>;
  attributeWeekendUnrealized?: boolean;
}

export interface MonthlyReturn {
  month: string;
  unrealizedPnlChange: number;
  realizedTradingPnl: number;
  dividendPnl: number;
  feePnl: number;
  totalPnl: number;
  capitalFlow: number;
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
  capitalFlow: number;
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
  return { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0, capitalFlow: 0 };
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
        feePnl: Number.isFinite(row.feePnl)
          ? finiteNumber(row.feePnl)
          : finiteNumber(row.transactionFeePnl) + finiteNumber(row.taxPnl),
        capitalFlow: finiteNumber(row.capitalFlow),
      };
    }
  }
  const positionHistoryStart = typeof candidate.positionHistoryStart === "string" && isValidYmd(candidate.positionHistoryStart)
    ? candidate.positionHistoryStart
    : undefined;
  return { daily, realizedCostBasis: Math.max(0, finiteNumber(candidate.realizedCostBasis)), positionHistoryStart };
}

export function mergeReturnBreakdowns(a: ReturnBreakdown, b: ReturnBreakdown): ReturnBreakdown {
  return {
    realizedTradingPnl: a.realizedTradingPnl + b.realizedTradingPnl,
    dividendPnl: a.dividendPnl + b.dividendPnl,
    transactionFeePnl: a.transactionFeePnl + b.transactionFeePnl,
    taxPnl: a.taxPnl + b.taxPnl,
    feePnl: a.feePnl + b.feePnl,
    capitalFlow: finiteNumber(a.capitalFlow) + finiteNumber(b.capitalFlow),
  };
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ymdFromEventValue(value: unknown, fallback = new Date()) {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  if (match) {
    const parsed = new Date(`${match[0]}T00:00:00.000Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[0]) return match[0]!;
  }
  const year = fallback.getFullYear();
  const month = String(fallback.getMonth() + 1).padStart(2, "0");
  const day = String(fallback.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidYmd(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
    if (["buy", "sell", "dividend_reinvest", "share_dividend", "split"].includes(event.type)) {
      baseline.positionHistoryStart = !baseline.positionHistoryStart || event.date > baseline.positionHistoryStart
        ? event.date
        : baseline.positionHistoryStart;
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
  if (typeof raw.date !== "string" || !isValidYmd(raw.date.slice(0, 10))) return null;
  const rawAmount = finiteNumber(raw.amount);
  const amount = type === "fee" || type === "tax"
    ? -Math.abs(rawAmount)
    : ["cash_dividend", "dividend_reinvest", "interest", "bond_coupon", "buy"].includes(type)
      ? Math.abs(rawAmount)
      : rawAmount;
  const currency = typeof raw.currency === "string" && raw.currency ? raw.currency : "CNY";
  const date = ymdFromEventValue(raw.date);
  const rawAmountInBase = Number.isFinite(raw.amountInBase) ? Number(raw.amountInBase) : amountInBase(amount, currency);
  const normalizedAmountInBase = type === "fee" || type === "tax"
    ? -Math.abs(rawAmountInBase)
    : ["cash_dividend", "dividend_reinvest", "interest", "bond_coupon", "buy"].includes(type)
      ? Math.abs(rawAmountInBase)
      : rawAmountInBase;
  const fxRateToBase = Number.isFinite(raw.fxRateToBase) && Number(raw.fxRateToBase) > 0
    ? Number(raw.fxRateToBase)
    : amount !== 0 && currency.toUpperCase() !== "CNY"
      ? Math.abs(normalizedAmountInBase / amount)
      : undefined;
  const normalizedProceeds = Number.isFinite(raw.proceeds)
    ? Number(raw.proceeds)
    : Math.max(0, finiteNumber(raw.quantity) * finiteNumber(raw.price));
  return {
    id: raw.id,
    date,
    settlementDate: typeof raw.settlementDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.settlementDate)
      ? raw.settlementDate
      : undefined,
    holdingId: typeof raw.holdingId === "string" ? raw.holdingId : undefined,
    groupId: typeof raw.groupId === "string" ? raw.groupId : undefined,
    symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    market: typeof raw.market === "string" ? raw.market : undefined,
    assetType: typeof raw.assetType === "string" ? raw.assetType : undefined,
    type,
    quantity: Number.isFinite(raw.quantity) ? Number(raw.quantity) : undefined,
    price: Number.isFinite(raw.price) ? Number(raw.price) : undefined,
    amount,
    amountInBase: normalizedAmountInBase,
    fxRateToBase,
    fxRateEstimated: raw.fxRateEstimated === true
      || (currency.toUpperCase() !== "CNY" && date !== ymdFromEventValue(undefined)),
    capitalFlowInBase: Number.isFinite(raw.capitalFlowInBase)
      ? Number(raw.capitalFlowInBase)
      : type === "buy"
        ? (Number.isFinite(raw.amountInBase) ? Number(raw.amountInBase) : amountInBase(amount, currency))
        : type === "sell"
          ? -amountInBase(normalizedProceeds, currency)
          : undefined,
    capitalFlowIncomplete: type === "sell" && !(normalizedProceeds > 0) ? true : undefined,
    currency,
    source: ["manual", "auto", "import", "system", "migration"].includes(String(raw.source))
      ? raw.source as PortfolioEventSource
      : "manual",
    corporateActionId: typeof raw.corporateActionId === "string" ? raw.corporateActionId : undefined,
    corporateActionKind: raw.corporateActionKind === "share_bonus_transfer" ? "share_bonus_transfer" : undefined,
    relatedEventId: typeof raw.relatedEventId === "string" ? raw.relatedEventId : undefined,
    costBasisAtEvent: Number.isFinite(raw.costBasisAtEvent) ? Number(raw.costBasisAtEvent) : undefined,
    proceeds: type === "sell" && normalizedProceeds > 0 ? normalizedProceeds : undefined,
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
    groupId: holding.groupId,
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    assetType: holding.assetType,
    currency: holding.currency,
  };
}

function eventFromCorporateAction(holding: Holding, action: CorporateActionLike, source: PortfolioEventSource): PortfolioEvent | null {
  const recognizesOnExDate = action.type === "cash_dividend"
    || action.type === "dividend_reinvest"
    || action.type === "share_dividend"
    || action.type === "split";
  const date = ymdFromEventValue(recognizesOnExDate
    ? (action.exDate || action.date || action.payDate)
    : (action.payDate || action.date || action.exDate));
  const settlementDate = action.payDate && action.payDate !== date
    ? ymdFromEventValue(action.payDate)
    : undefined;
  const corporateActionKind: PortfolioEvent["corporateActionKind"] = action.type === "split" && action.source === "eastmoney-stock"
    ? "share_bonus_transfer"
    : undefined;
  const base = {
    ...eventIdentityForHolding(holding),
    date,
    settlementDate,
    source,
    corporateActionId: action.id,
    corporateActionKind,
    note: action.note,
    rateUsed: action.rateUsed,
    minimumFeeUsed: action.minimumFeeUsed,
    estimatedAmount: action.estimatedAmount,
    createdAt: `${date}T00:00:00.000Z`,
    fxRateToBase: holding.currency.toUpperCase() === "CNY" ? 1 : amountInBase(1, holding.currency),
    fxRateEstimated: holding.currency.toUpperCase() !== "CNY" && date !== ymdFromEventValue(undefined),
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
  const amountBase = amountInBase(amount, holding.currency);
  return {
    id: `${input.source ?? "manual"}:buy:${holding.id}:${date}:${input.quantity}:${input.price}:${input.relatedEventId ?? Date.now()}`,
    date,
    ...eventIdentityForHolding(holding),
    type: "buy",
    quantity: input.quantity,
    price: input.price,
    amount,
    amountInBase: amountBase,
    capitalFlowInBase: amountBase,
    fxRateToBase: amount > 0 ? amountBase / amount : undefined,
    fxRateEstimated: holding.currency.toUpperCase() !== "CNY" && date !== ymdFromEventValue(undefined),
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
  const amountBase = amountInBase(amount, holding.currency);
  return {
    id: `${input.source ?? "manual"}:sell:${holding.id}:${date}:${sellQuantity}:${input.price}:${input.relatedEventId ?? Date.now()}`,
    date,
    ...eventIdentityForHolding(holding),
    type: "sell",
    quantity: sellQuantity,
    price: input.price,
    amount,
    amountInBase: amountBase,
    capitalFlowInBase: -amountInBase(proceeds, holding.currency),
    fxRateToBase: amount !== 0 ? amountBase / amount : undefined,
    fxRateEstimated: holding.currency.toUpperCase() !== "CNY" && date !== ymdFromEventValue(undefined),
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
        groupId: closed.groupId,
        symbol: closed.symbol,
        name: closed.name,
        market: closed.market,
        assetType: closed.assetType,
        type: "sell",
        quantity: closed.quantity,
        price: closed.closePrice,
        amount: sellAmount,
        amountInBase: amountInBase(sellAmount, closed.currency),
        capitalFlowInBase: -amountInBase(closed.proceeds, closed.currency),
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
        groupId: closed.groupId,
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
          groupId: closed.groupId,
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
            groupId: closed.groupId,
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
      groupId: holding?.groupId,
      symbol: holding?.symbol,
      name: holding?.name,
      market: holding?.market,
      assetType: holding?.assetType,
      type: "buy",
      quantity: quantity || undefined,
      price: price || undefined,
      amount: amount > 0 ? amount : quantity * price,
      amountInBase: amountInBase(amount > 0 ? amount : quantity * price, holding?.currency ?? "CNY"),
      capitalFlowInBase: amountInBase(amount > 0 ? amount : quantity * price, holding?.currency ?? "CNY"),
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
    if (event.type === "buy") acc.capitalFlow = finiteNumber(acc.capitalFlow) + finiteNumber(event.capitalFlowInBase, event.amountInBase);
    if (event.type === "sell") acc.capitalFlow = finiteNumber(acc.capitalFlow) + finiteNumber(
      event.capitalFlowInBase,
      -amountInBase(finiteNumber(event.proceeds), event.currency),
    );
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
  }, { realizedTradingPnl: 0, dividendPnl: 0, transactionFeePnl: 0, taxPnl: 0, feePnl: 0, capitalFlow: 0 });
}

function aggregateEventsByDate(events: PortfolioEvent[], baseline?: PortfolioEventBaseline) {
  const map = new Map<string, ReturnBreakdown>();
  for (const [date, row] of Object.entries(baseline?.daily ?? {})) {
    map.set(date, { ...row });
  }
  for (const event of events) {
    const bucket = map.get(event.date) ?? emptyReturnBreakdown();
    const single = computeReturnBreakdown([event]);
    bucket.realizedTradingPnl += single.realizedTradingPnl;
    bucket.dividendPnl += single.dividendPnl;
    bucket.transactionFeePnl += single.transactionFeePnl;
    bucket.taxPnl += single.taxPnl;
    bucket.feePnl += single.feePnl;
    bucket.capitalFlow = finiteNumber(bucket.capitalFlow) + finiteNumber(single.capitalFlow);
    map.set(event.date, bucket);
  }
  return map;
}

function precedingWeekday(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const weekday = parsed.getUTCDay();
  if (weekday === 6) parsed.setUTCDate(parsed.getUTCDate() - 1);
  if (weekday === 0) parsed.setUTCDate(parsed.getUTCDate() - 2);
  return parsed.toISOString().slice(0, 10);
}

function weekendCryptoUnrealizedChange(
  previous: Record<string, number>,
  current: Record<string, number>,
  holdingMarkets: Record<string, string>,
) {
  const holdingIds = new Set([...Object.keys(previous), ...Object.keys(current)]);
  let change = 0;
  for (const holdingId of holdingIds) {
    if (holdingMarkets[holdingId]?.toUpperCase() !== "CRYPTO") continue;
    change += (Number(current[holdingId]) || 0) - (Number(previous[holdingId]) || 0);
  }
  return change;
}

export function getDailyReturns(
  events: PortfolioEvent[],
  snapshots: PortfolioSnapshotInput[],
  baseline?: PortfolioEventBaseline,
  options: DailyReturnAttributionOptions = {},
): DailyReturn[] {
  const eventByDate = aggregateEventsByDate(events, baseline);
  const estimatedFxDates = new Set(events.filter((event) => event.fxRateEstimated).map((event) => event.date));
  const incompleteCapitalFlowDates = new Set(events.filter((event) => event.capitalFlowIncomplete).map((event) => event.date));
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
  const rowsByDate = new Map<string, DailyReturn>();
  let lastSnapshotIndex = 0;
  let lastTotalAsset = 0;
  let lastUnrealizedPnl: number | undefined;
  let lastValuationDate: string | undefined;
  let lastHoldingUnrealizedPnl: Record<string, number> | undefined;
  const holdingMarkets = options.holdingMarkets ?? {};
  const hasCryptoHolding = Object.values(holdingMarkets).some((market) => market.toUpperCase() === "CRYPTO");

  for (const date of sortedDates) {
    const snapshot = snapshotByDate.get(date);
    while (lastSnapshotIndex < sortedSnapshots.length && sortedSnapshots[lastSnapshotIndex]!.date <= date) {
      lastTotalAsset = sortedSnapshots[lastSnapshotIndex]!.totalAsset;
      lastSnapshotIndex += 1;
    }
    const hasBreakdown = Number.isFinite(snapshot?.unrealizedPnl);
    const currentUnrealized = hasBreakdown ? snapshot!.unrealizedPnl! : undefined;
    const isInitialBaseline = hasBreakdown && lastUnrealizedPnl === undefined;
    const valuationSpanDays = hasBreakdown && lastValuationDate
      ? Math.max(1, Math.round((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${lastValuationDate}T00:00:00.000Z`)) / 86_400_000))
      : undefined;
    const unrealizedPnlChange = hasBreakdown
      ? isInitialBaseline ? 0 : currentUnrealized! - lastUnrealizedPnl!
      : 0;
    if (hasBreakdown) {
      lastUnrealizedPnl = currentUnrealized;
      lastValuationDate = date;
    }
    const currentHoldingUnrealizedPnl = snapshot?.holdingUnrealizedPnl;
    const eventBreakdown = eventByDate.get(date) ?? emptyReturnBreakdown();
    const row: DailyReturn = {
      date,
      unrealizedPnlChange,
      realizedTradingPnl: eventBreakdown.realizedTradingPnl,
      dividendPnl: eventBreakdown.dividendPnl,
      feePnl: eventBreakdown.feePnl,
      totalPnl: unrealizedPnlChange + eventBreakdown.realizedTradingPnl + eventBreakdown.dividendPnl + eventBreakdown.feePnl,
      totalAsset: snapshot?.totalAsset ?? lastTotalAsset,
      capitalFlow: finiteNumber(eventBreakdown.capitalFlow),
      currency: "CNY",
      incompleteBreakdown: !snapshot || !hasBreakdown || isInitialBaseline || snapshot.migratedBaseline || estimatedFxDates.has(date) || incompleteCapitalFlowDates.has(date) || (valuationSpanDays ?? 1) > 1 || undefined,
      estimatedSnapshot: snapshot?.estimated || undefined,
      fxFallback: snapshot?.fxFallback || estimatedFxDates.has(date) || undefined,
      valuationSpanDays: (valuationSpanDays ?? 1) > 1 ? valuationSpanDays : undefined,
    };

    if (options.attributeWeekendUnrealized && hasBreakdown && !snapshot?.holdingValuationDates && precedingWeekday(date) !== date) {
      const target = rowsByDate.get(precedingWeekday(date));
      let weekendCryptoChange: number | undefined;
      if (!hasCryptoHolding) {
        weekendCryptoChange = 0;
      } else if (lastHoldingUnrealizedPnl && currentHoldingUnrealizedPnl) {
        weekendCryptoChange = weekendCryptoUnrealizedChange(
          lastHoldingUnrealizedPnl,
          currentHoldingUnrealizedPnl,
          holdingMarkets,
        );
      }
      if (target && weekendCryptoChange !== undefined) {
        const weekdayChange = unrealizedPnlChange - weekendCryptoChange;
        target.unrealizedPnlChange += weekdayChange;
        target.totalPnl += weekdayChange;
        target.estimatedSnapshot = target.estimatedSnapshot || row.estimatedSnapshot || undefined;
        target.fxFallback = target.fxFallback || row.fxFallback || undefined;
        row.unrealizedPnlChange = weekendCryptoChange;
        row.totalPnl = weekendCryptoChange + row.realizedTradingPnl + row.dividendPnl + row.feePnl;
      }
    }

    // Prefer the quote/NAV's actual valuation date over the local refresh date.
    // This correctly maps US Monday close observed in China on Tuesday back to
    // Monday and also handles non-weekend timezone shifts. Crypto remains on
    // its continuously traded local observation day.
    if (lastHoldingUnrealizedPnl && currentHoldingUnrealizedPnl && snapshot?.holdingValuationDates) {
      for (const [holdingId, currentValue] of Object.entries(currentHoldingUnrealizedPnl)) {
        if (holdingMarkets[holdingId]?.toUpperCase() === "CRYPTO") continue;
        const storedValuationDate = snapshot.holdingValuationDates[holdingId];
        // Older backfills and live fund estimates could stamp a carried quote
        // with the Saturday/Sunday observation date. Non-crypto securities do
        // not have a weekend valuation, so normalize legacy data while reading
        // it; this repairs already-persisted snapshots without rewriting the
        // user's event ledger.
        const valuationDate = storedValuationDate && precedingWeekday(storedValuationDate) !== storedValuationDate
          ? precedingWeekday(storedValuationDate)
          : storedValuationDate;
        if (!valuationDate || valuationDate >= date) continue;
        const target = rowsByDate.get(valuationDate);
        if (!target) continue;
        const change = finiteNumber(currentValue) - finiteNumber(lastHoldingUnrealizedPnl[holdingId]);
        if (!change) continue;
        target.unrealizedPnlChange += change;
        target.totalPnl += change;
        row.unrealizedPnlChange -= change;
        row.totalPnl -= change;
      }
    }

    rows.push(row);
    rowsByDate.set(date, row);
    if (currentHoldingUnrealizedPnl) {
      lastHoldingUnrealizedPnl = currentHoldingUnrealizedPnl;
    }
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
      capitalFlow: 0,
      currency: "CNY",
      incompleteBreakdown: undefined,
    };
    current.unrealizedPnlChange += row.unrealizedPnlChange;
    current.realizedTradingPnl += row.realizedTradingPnl;
    current.dividendPnl += row.dividendPnl;
    current.feePnl += row.feePnl;
    current.totalPnl += row.totalPnl;
    current.capitalFlow += row.capitalFlow;
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
      capitalFlow: 0,
      currency: "CNY",
      incompleteBreakdown: undefined,
    };
    current.unrealizedPnlChange += row.unrealizedPnlChange;
    current.realizedTradingPnl += row.realizedTradingPnl;
    current.dividendPnl += row.dividendPnl;
    current.feePnl += row.feePnl;
    current.totalPnl += row.totalPnl;
    current.capitalFlow += row.capitalFlow;
    current.incompleteBreakdown = current.incompleteBreakdown || row.incompleteBreakdown || undefined;
    map.set(year, current);
  }
  return [...map.values()].sort((a, b) => a.year.localeCompare(b.year));
}

/**
 * Calculates a position-account Modified Dietz return. Until the application
 * has a brokerage cash ledger, buys are treated as contributions and sales as
 * withdrawals. A missing result means the stored valuations are not complete
 * enough to support a defensible percentage.
 */
export function getModifiedDietzReturn(
  daily: DailyReturn[],
  startDate: string,
  endDate: string,
): number | null {
  const selected = daily.filter((row) => row.date >= startDate && row.date <= endDate);
  if (!selected.length || selected.some((row) => row.incompleteBreakdown)) return null;
  const prior = daily.filter((row) => row.date < startDate && row.totalAsset > 0).at(-1);
  if (!prior) return null;
  const openingAsset = prior.totalAsset;
  if (!(openingAsset > 0)) return null;

  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  const totalDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
  let weightedCapital = 0;
  let totalPnl = 0;
  for (const row of selected) {
    totalPnl += row.totalPnl;
    if (!row.capitalFlow) continue;
    const elapsedDays = Math.max(0, Math.round((Date.parse(`${row.date}T00:00:00.000Z`) - startMs) / 86_400_000));
    const weight = Math.max(0, Math.min(1, (totalDays - elapsedDays) / totalDays));
    weightedCapital += row.capitalFlow * weight;
  }
  const denominator = openingAsset + weightedCapital;
  return denominator > 0 ? totalPnl / denominator : null;
}

export function getHoldingReturnContributions(
  events: PortfolioEvent[],
  snapshots: PortfolioSnapshotInput[],
  startDate: string,
  endDate: string,
  expectedTotal?: number,
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
  // A migrated snapshot is a measurement taken at migration time, not a
  // zero-cost baseline. Treating it as zero turns lifetime unrealized P/L into
  // a weekly/monthly contribution. Use the first measured map as an estimated
  // baseline until a real pre-period snapshot exists.
  const fallbackBaseline = !baselineSnapshot ? firstInRange : undefined;
  const baselineMap = baselineSnapshot?.holdingUnrealizedPnl
    ?? fallbackBaseline?.holdingUnrealizedPnl;
  const endMap = endSnapshot?.holdingUnrealizedPnl;
  const incompleteBreakdown = !endMap || !baselineMap || Boolean(fallbackBaseline);

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

  const rows = [...result.values()]
    .map((row) => ({
      ...row,
      totalPnl: row.unrealizedPnlChange + row.realizedTradingPnl + row.dividendPnl + row.feePnl,
    }))
    .filter((row) => Number.isFinite(row.totalPnl) && row.totalPnl !== 0);
  if (Number.isFinite(expectedTotal)) {
    const assigned = rows.reduce((sum, row) => sum + row.totalPnl, 0);
    const residual = finiteNumber(expectedTotal) - assigned;
    if (Math.abs(residual) > 0.005) {
      rows.push({
        id: "__unallocated__",
        unrealizedPnlChange: residual,
        realizedTradingPnl: 0,
        dividendPnl: 0,
        transactionFeePnl: 0,
        taxPnl: 0,
        feePnl: 0,
        totalPnl: residual,
        incompleteBreakdown: true,
      });
    }
  }
  return rows.sort((a, b) => b.totalPnl - a.totalPnl);
}
