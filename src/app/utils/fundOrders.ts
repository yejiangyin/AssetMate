import type { Holding, TransactionCostProfile } from "../data/mockData";
import { normalizeTransactionCostProfile } from "./transactionCosts";
import { effectiveDcaMarket, isTradingDay, marketDate, type MarketType } from "../services/tradingCalendar";

export type FundOrderSide = "buy" | "sell";
export type FundOrderSource = "manual" | "dca";
export type FundOrderEntryMode = "submitted" | "recorded";
export type FundOrderStatus = "pending" | "confirmed" | "rejected" | "cancelled";
export type FundOrderCancellationPolicy = "channel_cutoff" | "standard_cutoff" | "not_cancellable" | "unknown";
export type FundOrderCancellationState = "cancellable" | "accepted" | "not_cancellable" | "unknown" | "closed";
export type FundOrderCancelError = "not_found" | "not_pending" | "not_cancellable" | "rule_unknown" | "deadline_passed";

export interface FundOrderRuleSnapshot {
  tradeStatus: "normal" | "fund_limit" | "buy_disabled" | "sell_disabled" | "suspended" | "unknown";
  tradeStatusNote?: string;
  tradeStatusSource?: string | null;
  purchaseLimit?: number;
  minimumPurchaseAmount?: number;
  minimumRedemptionQuantity?: number;
  minimumRemainingQuantity?: number;
  confirmDays: number;
  cutoffMinutes: number;
  cutoffSource?: string;
  cutoffEstimated?: boolean;
  cancellationPolicy?: FundOrderCancellationPolicy;
  cancellationPolicySource?: string;
  /** undefined = legacy order without a snapshot; null = explicitly no transaction costs. */
  transactionCostProfile?: TransactionCostProfile | null;
  capturedAt: string;
}

export interface FundOrder {
  id: string;
  holdingId: string;
  symbol: string;
  planId?: string;
  source: FundOrderSource;
  entryMode: FundOrderEntryMode;
  side: FundOrderSide;
  status: FundOrderStatus;
  requestedAt: string;
  requestedDate: string;
  effectiveDate: string;
  requestedAmount?: number;
  requestedQuantity?: number;
  estimatedPrice?: number;
  expectedConfirmDate: string;
  /** User/channel attestation that the submitted order actually succeeded. */
  channelConfirmedAt?: string;
  cancelDeadline?: string;
  cancelledAt?: string;
  confirmedDate?: string;
  navDate?: string;
  confirmedPrice?: number;
  confirmedQuantity?: number;
  confirmedAmount?: number;
  fee?: number;
  tax?: number;
  reason?: string;
  rule: FundOrderRuleSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface FundOrderConfirmation {
  orderId: string;
  side: FundOrderSide;
  price: number;
  quantity: number;
  amount: number;
  navDate: string;
  confirmedDate: string;
}

export type FundOrderMinimumViolation = {
  type: "purchase_minimum" | "redemption_minimum" | "remaining_minimum";
  minimum: number;
};

export type FundOrderRuleCarrier = Pick<Holding,
  | "fundBuyCutoffMinutes"
  | "fundSellCutoffMinutes"
  | "fundDcaCutoffMinutes"
  | "fundBuyCancellationAllowed"
  | "fundSellCancellationAllowed"
  | "fundDcaCancellationAllowed"
  | "fundCancellationRuleSource"
>;

export function resolveFundOrderCutoff(
  holding: FundOrderRuleCarrier,
  side: FundOrderSide,
  source: FundOrderSource = "manual",
) {
  const returnedCutoff = source === "dca"
    ? holding.fundDcaCutoffMinutes ?? holding.fundBuyCutoffMinutes
    : side === "buy"
      ? holding.fundBuyCutoffMinutes
      : holding.fundSellCutoffMinutes;
  const cancellationAllowed = source === "dca"
    ? holding.fundDcaCancellationAllowed
    : side === "buy"
      ? holding.fundBuyCancellationAllowed
      : holding.fundSellCancellationAllowed;
  const validReturnedCutoff = Number.isInteger(returnedCutoff) && returnedCutoff! >= 0 && returnedCutoff! < 24 * 60
    ? returnedCutoff
    : undefined;
  const cutoffMinutes = validReturnedCutoff ?? 15 * 60;
  const cutoffSource = validReturnedCutoff != null
    ? holding.fundCancellationRuleSource || "渠道返回的交易规则"
    : "场外基金通用15:00规则（数据源未返回，按兜底估算）";
  const cancellationPolicy: FundOrderCancellationPolicy = source === "dca"
    ? "not_cancellable"
    : cancellationAllowed === false
      ? "not_cancellable"
      : validReturnedCutoff != null || cancellationAllowed === true
        ? "channel_cutoff"
        : "standard_cutoff";
  const cancellationPolicySource = source === "dca"
    ? "自动定投触发单不可手工撤销"
    : cancellationAllowed === false
      ? holding.fundCancellationRuleSource || "渠道返回不支持撤单"
      : cutoffSource;
  return {
    cutoffMinutes,
    cutoffSource,
    cutoffEstimated: validReturnedCutoff == null,
    cancellationPolicy,
    cancellationPolicySource,
  };
}

const ORDER_STATUSES = new Set<FundOrderStatus>(["pending", "confirmed", "rejected", "cancelled"]);
const ORDER_SIDES = new Set<FundOrderSide>(["buy", "sell"]);
const ORDER_SOURCES = new Set<FundOrderSource>(["manual", "dca"]);

function ymd(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fromYMD(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return new Date(Number.NaN);
  return new Date(year, month - 1, day);
}

function validYMD(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = fromYMD(value);
  return Number.isFinite(parsed.getTime()) && ymd(parsed) === value;
}

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeConfirmDays(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 30 ? parsed : fallback;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseChineseMoneyLimit(text: string): number | null {
  const match = text.match(/(?:人民币|RMB|¥)?\s*((?:[0-9]+(?:\.[0-9]+)?\s*[万千百十]?[\s零]*)+)\s*(?:元|块)?/i);
  if (!match) return null;
  const multipliers: Record<string, number> = { 万: 10000, 千: 1000, 百: 100, 十: 10, "": 1 };
  let total = 0;
  let matched = false;
  for (const part of (match[1] ?? "").matchAll(/([0-9]+(?:\.[0-9]+)?)\s*([万千百十]?)/g)) {
    const base = Number(part[1]);
    if (!Number.isFinite(base) || base < 0) continue;
    total += base * (multipliers[part[2] ?? ""] ?? 1);
    matched = true;
  }
  return matched ? total : null;
}

export function defaultFundConfirmDays(
  holding: Pick<Holding, "market" | "assetType" | "name" | "fundBuyConfirmDays" | "fundSellConfirmDays">,
  side: FundOrderSide,
) {
  const configured = side === "buy" ? holding.fundBuyConfirmDays : holding.fundSellConfirmDays;
  if (Number.isInteger(configured) && configured! >= 0 && configured! <= 30) return configured!;
  const market = effectiveDcaMarket((holding.assetType === "fund" ? "FUND" : holding.market) as MarketType, holding.name);
  return market !== "FUND" && market !== "A" ? 2 : 1;
}

function isFundSettlementDay(holding: Pick<Holding, "market" | "assetType" | "name">, date: Date) {
  const base = holding.assetType === "fund" || holding.market === "FUND" ? "FUND" : holding.market;
  const effective = effectiveDcaMarket(base as MarketType, holding.name);
  if (effective === "FUND" || effective === "A") return isTradingDay("A", date);
  return isTradingDay("A", date) && isTradingDay(effective, date);
}

export function addFundTradingDays(
  holding: Pick<Holding, "market" | "assetType" | "name">,
  fromDate: string,
  days: number,
) {
  const date = fromYMD(fromDate);
  let added = 0;
  while (added < Math.max(0, days)) {
    date.setDate(date.getDate() + 1);
    if (isFundSettlementDay(holding, date)) added += 1;
  }
  return ymd(date);
}

export function computeFundOrderConfirmDate(
  holding: Pick<Holding, "market" | "assetType" | "name">,
  effectiveDate: string,
  confirmDays: number,
) {
  return addFundTradingDays(holding, effectiveDate, confirmDays);
}

function shanghaiParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return {
    date: new Date(get("year"), get("month") - 1, get("day")),
    minutes: (get("hour") % 24) * 60 + get("minute"),
  };
}

export function computeFundEffectiveDate(requestedAt: Date, cutoffMinutes = 15 * 60) {
  const cn = shanghaiParts(requestedAt);
  const date = cn.date;
  if (cn.minutes >= cutoffMinutes) date.setDate(date.getDate() + 1);
  while (!isTradingDay("FUND", date)) date.setDate(date.getDate() + 1);
  return ymd(date);
}

export function computeFundOrderCancelDeadline(effectiveDate: string, cutoffMinutes = 15 * 60) {
  if (!validYMD(effectiveDate)) return undefined;
  const safeMinutes = Number.isInteger(cutoffMinutes) ? Math.max(0, Math.min(24 * 60 - 1, cutoffMinutes)) : 15 * 60;
  const hour = String(Math.floor(safeMinutes / 60)).padStart(2, "0");
  const minute = String(safeMinutes % 60).padStart(2, "0");
  return new Date(`${effectiveDate}T${hour}:${minute}:00+08:00`).toISOString();
}

export function fundOrderCancellationState(order: FundOrder, now = new Date()): FundOrderCancellationState {
  if (order.status !== "pending") return "closed";
  // Auto-invest executions are system-triggered records, not interactive orders.
  // Keep this product invariant independent from incomplete or stale channel metadata.
  if (order.source === "dca") return "not_cancellable";
  const policy = order.rule.cancellationPolicy ?? (order.source === "manual" ? "standard_cutoff" : "unknown");
  if (policy === "not_cancellable") return "not_cancellable";
  if (policy === "unknown") return "unknown";
  const deadline = order.cancelDeadline ?? computeFundOrderCancelDeadline(order.effectiveDate, order.rule.cutoffMinutes);
  if (!deadline || !Number.isFinite(Date.parse(deadline))) return "accepted";
  return now.getTime() < Date.parse(deadline) ? "cancellable" : "accepted";
}

export function requestFundOrderCancellation(orders: FundOrder[], id: string, now = new Date()): {
  ok: boolean;
  error?: FundOrderCancelError;
  orders: FundOrder[];
} {
  const order = orders.find((item) => item.id === id);
  if (!order) return { ok: false, error: "not_found", orders };
  if (order.status !== "pending") return { ok: false, error: "not_pending", orders };
  const cancellationState = fundOrderCancellationState(order, now);
  if (cancellationState === "not_cancellable") return { ok: false, error: "not_cancellable", orders };
  if (cancellationState === "unknown") return { ok: false, error: "rule_unknown", orders };
  if (cancellationState !== "cancellable") return { ok: false, error: "deadline_passed", orders };
  const cancelledAt = now.toISOString();
  return {
    ok: true,
    orders: orders.map((item) => item.id === id ? {
      ...item,
      status: "cancelled" as const,
      cancelledAt,
      reason: "用户在受理截止时间前撤销",
      updatedAt: cancelledAt,
    } : item),
  };
}

export function fundOrderReservedBuyAmount(orders: FundOrder[], holding: Pick<Holding, "id" | "symbol">, effectiveDate: string) {
  return orders.reduce((total, order) => {
    if (order.side !== "buy" || order.effectiveDate !== effectiveDate) return total;
    if (order.status !== "pending" && order.status !== "confirmed") return total;
    if (order.holdingId !== holding.id && order.symbol !== holding.symbol) return total;
    return total + (order.requestedAmount ?? order.confirmedAmount ?? 0);
  }, 0);
}

export function pendingSellQuantity(orders: FundOrder[], holdingId: string) {
  return orders.reduce((total, order) => (
    order.holdingId === holdingId && order.side === "sell" && order.status === "pending"
      ? total + (order.requestedQuantity ?? 0)
      : total
  ), 0);
}

export function fundOrderMinimumViolation(
  side: FundOrderSide,
  rule: Pick<FundOrderRuleSnapshot, "minimumPurchaseAmount" | "minimumRedemptionQuantity" | "minimumRemainingQuantity">,
  input: { requestedAmount?: number; requestedQuantity?: number; availableQuantity?: number },
): FundOrderMinimumViolation | null {
  if (side === "buy") {
    if (rule.minimumPurchaseAmount != null && (input.requestedAmount ?? 0) + 1e-8 < rule.minimumPurchaseAmount) {
      return { type: "purchase_minimum", minimum: rule.minimumPurchaseAmount };
    }
    return null;
  }
  const quantity = input.requestedQuantity ?? 0;
  const available = input.availableQuantity ?? 0;
  const remaining = Math.max(0, available - quantity);
  if (remaining > 1e-8 && rule.minimumRedemptionQuantity != null && quantity + 1e-8 < rule.minimumRedemptionQuantity) {
    return { type: "redemption_minimum", minimum: rule.minimumRedemptionQuantity };
  }
  if (remaining > 1e-8 && rule.minimumRemainingQuantity != null && remaining + 1e-8 < rule.minimumRemainingQuantity) {
    return { type: "remaining_minimum", minimum: rule.minimumRemainingQuantity };
  }
  return null;
}

export function normalizeFundOrder(raw: Partial<FundOrder> & Record<string, unknown>): FundOrder | null {
  if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.holdingId !== "string" || !raw.holdingId) return null;
  if (!ORDER_SIDES.has(raw.side as FundOrderSide) || !ORDER_SOURCES.has(raw.source as FundOrderSource)) return null;
  let status = ORDER_STATUSES.has(raw.status as FundOrderStatus) ? raw.status as FundOrderStatus : "pending";
  const requestedAt = typeof raw.requestedAt === "string" && Number.isFinite(Date.parse(raw.requestedAt))
    ? raw.requestedAt
    : new Date().toISOString();
  const requestedDate = validYMD(raw.requestedDate) ? raw.requestedDate : ymd(marketDate("FUND", new Date(requestedAt)));
  const effectiveDate = validYMD(raw.effectiveDate) ? raw.effectiveDate : requestedDate;
  const expectedConfirmDate = validYMD(raw.expectedConfirmDate) ? raw.expectedConfirmDate : effectiveDate;
  const rawRule = raw.rule && typeof raw.rule === "object" ? raw.rule as Partial<FundOrderRuleSnapshot> : {};
  const confirmDays = normalizeConfirmDays(rawRule.confirmDays, 1);
  const cutoffMinutes = Number.isInteger(rawRule.cutoffMinutes) ? Math.max(0, Math.min(24 * 60 - 1, Number(rawRule.cutoffMinutes))) : 15 * 60;
  const cancellationPolicy: FundOrderCancellationPolicy = raw.source === "dca"
    ? "not_cancellable"
    : ["channel_cutoff", "standard_cutoff", "not_cancellable", "unknown"].includes(String(rawRule.cancellationPolicy))
      ? rawRule.cancellationPolicy as FundOrderCancellationPolicy
      : "standard_cutoff";
  const cancelDeadline = cancellationPolicy === "channel_cutoff" && validIsoTimestamp(raw.cancelDeadline)
    ? raw.cancelDeadline
    : cancellationPolicy === "standard_cutoff" || cancellationPolicy === "channel_cutoff"
      ? computeFundOrderCancelDeadline(effectiveDate, cutoffMinutes)
      : undefined;
  const requestedAmount = finitePositive(raw.requestedAmount);
  const requestedQuantity = finitePositive(raw.requestedQuantity);
  const missingPendingPayload = status === "pending" && (
    raw.side === "buy" ? requestedAmount == null : requestedQuantity == null
  );
  if (missingPendingPayload) status = "rejected";
  const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : requestedAt;
  return {
    id: raw.id,
    holdingId: raw.holdingId,
    symbol: typeof raw.symbol === "string" ? raw.symbol : "",
    planId: typeof raw.planId === "string" ? raw.planId : undefined,
    source: raw.source as FundOrderSource,
    entryMode: raw.entryMode === "recorded" ? "recorded" : "submitted",
    side: raw.side as FundOrderSide,
    status,
    requestedAt,
    requestedDate,
    effectiveDate,
    requestedAmount,
    requestedQuantity,
    estimatedPrice: finitePositive(raw.estimatedPrice),
    expectedConfirmDate,
    channelConfirmedAt: validIsoTimestamp(raw.channelConfirmedAt) ? raw.channelConfirmedAt : undefined,
    cancelDeadline,
    cancelledAt: validIsoTimestamp(raw.cancelledAt) ? raw.cancelledAt : undefined,
    confirmedDate: validYMD(raw.confirmedDate) ? raw.confirmedDate : undefined,
    navDate: validYMD(raw.navDate) ? raw.navDate : undefined,
    confirmedPrice: finitePositive(raw.confirmedPrice),
    confirmedQuantity: finitePositive(raw.confirmedQuantity),
    confirmedAmount: finitePositive(raw.confirmedAmount),
    fee: finitePositive(raw.fee),
    tax: finitePositive(raw.tax),
    reason: missingPendingPayload ? "订单关键金额或份额缺失" : typeof raw.reason === "string" ? raw.reason : undefined,
    rule: {
      tradeStatus: ["normal", "fund_limit", "buy_disabled", "sell_disabled", "suspended", "unknown"].includes(String(rawRule.tradeStatus))
        ? rawRule.tradeStatus as FundOrderRuleSnapshot["tradeStatus"]
        : "unknown",
      tradeStatusNote: typeof rawRule.tradeStatusNote === "string" ? rawRule.tradeStatusNote : undefined,
      tradeStatusSource: typeof rawRule.tradeStatusSource === "string" ? rawRule.tradeStatusSource : null,
      purchaseLimit: finiteNonNegative(rawRule.purchaseLimit),
      minimumPurchaseAmount: finitePositive(rawRule.minimumPurchaseAmount),
      minimumRedemptionQuantity: finitePositive(rawRule.minimumRedemptionQuantity),
      minimumRemainingQuantity: finitePositive(rawRule.minimumRemainingQuantity),
      confirmDays,
      cutoffMinutes,
      cutoffSource: typeof rawRule.cutoffSource === "string" ? rawRule.cutoffSource : undefined,
      cutoffEstimated: typeof rawRule.cutoffEstimated === "boolean" ? rawRule.cutoffEstimated : undefined,
      cancellationPolicy,
      cancellationPolicySource: raw.source === "dca"
        ? "自动定投触发单不可手工撤销"
        : typeof rawRule.cancellationPolicySource === "string"
        ? rawRule.cancellationPolicySource
        : cancellationPolicy === "standard_cutoff"
          ? "通用场外基金受理截止规则"
          : cancellationPolicy === "unknown"
            ? "渠道未返回撤单规则"
            : cancellationPolicy === "not_cancellable"
              ? "渠道返回不支持撤单"
              : "渠道返回的撤单规则",
      transactionCostProfile: Object.prototype.hasOwnProperty.call(rawRule, "transactionCostProfile")
        ? normalizeTransactionCostProfile(rawRule.transactionCostProfile as TransactionCostProfile | null | undefined) ?? null
        : undefined,
      capturedAt: typeof rawRule.capturedAt === "string" && Number.isFinite(Date.parse(rawRule.capturedAt)) ? rawRule.capturedAt : requestedAt,
    },
    createdAt: typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : requestedAt,
    updatedAt,
  };
}

export function normalizeFundOrders(raw: unknown): FundOrder[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, FundOrder>();
  for (const item of raw) {
    const order = normalizeFundOrder(item as Partial<FundOrder> & Record<string, unknown>);
    if (order) byId.set(order.id, order);
  }
  return [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function fundOrderConfirmationQuote(
  holding: Holding | undefined,
  order: FundOrder,
  asOfDate: string,
): FundOrderConfirmation | null {
  if (!holding || order.status !== "pending" || asOfDate < order.expectedConfirmDate) return null;
  // Only the official NAV ledger can unlock a fill. `currentPrice` may be an
  // intraday estimated NAV whose priceDate is also the effective date.
  const price = holding.fundNavHistory?.find((row) => row.date === order.effectiveDate)?.nav;
  if (!(typeof price === "number" && Number.isFinite(price) && price > 0)) return null;
  const quantity = order.side === "buy"
    ? (order.requestedAmount ?? 0) / price
    : order.requestedQuantity ?? 0;
  if (!(quantity > 0)) return null;
  return {
    orderId: order.id,
    side: order.side,
    price,
    quantity,
    amount: quantity * price,
    navDate: order.effectiveDate,
    confirmedDate: order.expectedConfirmDate,
  };
}

export function readyFundOrderConfirmations(holdings: Holding[], orders: FundOrder[], asOfDate: string): FundOrderConfirmation[] {
  const holdingById = new Map(holdings.map((holding) => [holding.id, holding]));
  return [...orders]
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .filter((order) => order.source === "manual")
    .flatMap((order) => {
      const confirmation = fundOrderConfirmationQuote(holdingById.get(order.holdingId), order, asOfDate);
      return confirmation ? [confirmation] : [];
    });
}
