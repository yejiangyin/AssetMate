import type { Holding } from "../data/mockData";
import type { PortfolioEvent, PortfolioEventSource } from "../services/portfolioEvents";
import type { FundOrder, FundOrderSource, FundOrderStatus } from "./fundOrders";

export type TransactionRecordStatus = FundOrderStatus | "recorded";

export interface TransactionRecord {
  id: string;
  kind: "order" | "execution" | "trade";
  holdingId?: string;
  groupId?: string;
  symbol: string;
  name: string;
  market?: string;
  currency: string;
  side: "buy" | "sell";
  status: TransactionRecordStatus;
  source: FundOrderSource | PortfolioEventSource;
  date: string;
  sortTime: string;
  amount?: number;
  quantity?: number;
  price?: number;
  fee?: number;
  tax?: number;
  effectiveDate?: string;
  expectedConfirmDate?: string;
  confirmedDate?: string;
  navDate?: string;
  reason?: string;
  order?: FundOrder;
  execution?: TransactionDCAExecution;
  event?: PortfolioEvent;
}

export interface TransactionDCAExecution {
  id: string;
  holdingId: string;
  actualDate: string;
  amount: number;
  status: "pending" | "executed" | "skipped" | "cancelled";
  quantity?: number;
  price?: number;
  expectedConfirmDate?: string;
  confirmedDate?: string;
  reason?: string;
}

type TransactionIdentity = Pick<Holding, "id" | "groupId" | "symbol" | "name" | "market" | "currency">;

function closeEnough(a: number | undefined, b: number | undefined) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
}

function confirmedSellOrderForEvent(
  event: PortfolioEvent,
  orders: FundOrder[],
  claimedOrderIds: Set<string>,
) {
  return orders.find((order) => (
    !claimedOrderIds.has(order.id)
    && order.source === "manual"
    && order.side === "sell"
    && order.status === "confirmed"
    && order.holdingId === event.holdingId
    && order.effectiveDate === event.date
    && closeEnough(order.confirmedQuantity, event.quantity)
    && closeEnough(order.confirmedPrice, event.price)
  ));
}

/**
 * Merge the order ledger and the filled-trade ledger for presentation.
 * Submitted fund orders remain the canonical row throughout their lifecycle;
 * the buy/sell PortfolioEvent generated on confirmation is therefore hidden.
 */
export function buildTransactionRecords(
  orders: FundOrder[],
  events: PortfolioEvent[],
  identities: TransactionIdentity[],
  dcaExecutions: TransactionDCAExecution[] = [],
): TransactionRecord[] {
  const identityById = new Map(identities.map((identity) => [identity.id, identity]));
  const eventIdentityById = new Map<string, PortfolioEvent>();
  for (const event of events) {
    if (event.holdingId && !eventIdentityById.has(event.holdingId)) eventIdentityById.set(event.holdingId, event);
  }
  const orderIds = new Set(orders.map((order) => order.id));
  const standaloneExecutions = dcaExecutions.filter((execution) => !orderIds.has(execution.id));
  const canonicalRecordIds = new Set([...orderIds, ...standaloneExecutions.map((execution) => execution.id)]);
  const claimedSellOrderIds = new Set<string>();
  const costEvents = events.filter((event) => event.type === "fee" || event.type === "tax");
  const tradeCountByHoldingDate = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "buy" && event.type !== "sell") continue;
    const key = `${event.holdingId ?? ""}:${event.date}:${event.type}`;
    tradeCountByHoldingDate.set(key, (tradeCountByHoldingDate.get(key) ?? 0) + 1);
  }

  const linkedCost = (type: "fee" | "tax", relatedEventId: string) => costEvents
    .filter((event) => event.type === type && event.relatedEventId === relatedEventId)
    .reduce((sum, event) => sum + Math.abs(event.amount), 0);

  const rows: TransactionRecord[] = orders.map((order) => {
    const identity = identityById.get(order.holdingId);
    const eventIdentity = eventIdentityById.get(order.holdingId);
    const price = order.confirmedPrice ?? order.estimatedPrice;
    const quantity = order.confirmedQuantity ?? order.requestedQuantity;
    const amount = order.confirmedAmount ?? order.requestedAmount
      ?? (price != null && quantity != null ? price * quantity : undefined);
    return {
      id: `order:${order.id}`,
      kind: "order",
      holdingId: order.holdingId,
      groupId: identity?.groupId ?? eventIdentity?.groupId,
      symbol: identity?.symbol ?? eventIdentity?.symbol ?? order.symbol,
      name: identity?.name ?? eventIdentity?.name ?? order.symbol,
      market: identity?.market ?? eventIdentity?.market,
      currency: identity?.currency ?? eventIdentity?.currency ?? "CNY",
      side: order.side,
      status: order.status,
      source: order.source,
      date: order.requestedDate,
      sortTime: order.requestedAt || order.createdAt,
      amount,
      quantity,
      price,
      fee: order.fee ?? (linkedCost("fee", order.id) || undefined),
      tax: order.tax ?? (linkedCost("tax", order.id) || undefined),
      effectiveDate: order.effectiveDate,
      expectedConfirmDate: order.expectedConfirmDate,
      confirmedDate: order.confirmedDate,
      navDate: order.navDate,
      reason: order.reason,
      order,
    };
  });

  for (const execution of standaloneExecutions) {
    const identity = identityById.get(execution.holdingId);
    rows.push({
      id: `execution:${execution.id}`,
      kind: "execution",
      holdingId: execution.holdingId,
      groupId: identity?.groupId,
      symbol: identity?.symbol ?? "—",
      name: identity?.name ?? identity?.symbol ?? "—",
      market: identity?.market,
      currency: identity?.currency ?? "CNY",
      side: "buy",
      status: execution.status === "executed"
        ? "confirmed"
        : execution.status === "skipped"
          ? "rejected"
          : execution.status,
      source: "dca",
      date: execution.actualDate,
      sortTime: `${execution.actualDate}T12:00:00.000+08:00`,
      amount: execution.amount,
      quantity: execution.quantity,
      price: execution.price,
      expectedConfirmDate: execution.expectedConfirmDate,
      confirmedDate: execution.confirmedDate,
      reason: execution.reason,
      execution,
    });
  }

  for (const event of events) {
    if (event.type !== "buy" && event.type !== "sell") continue;
    if (event.relatedEventId && canonicalRecordIds.has(event.relatedEventId)) continue;
    if (event.type === "sell") {
      const matchedOrder = confirmedSellOrderForEvent(event, orders, claimedSellOrderIds);
      if (matchedOrder) {
        claimedSellOrderIds.add(matchedOrder.id);
        continue;
      }
    }
    const identity = event.holdingId ? identityById.get(event.holdingId) : undefined;
    const grossAmount = event.quantity != null && event.price != null
      ? event.quantity * event.price
      : Math.abs(event.capitalFlowInBase ?? event.amount);
    const tradeKey = `${event.holdingId ?? ""}:${event.date}:${event.type}`;
    const matchingCosts = costEvents.filter((cost) => {
      if (event.relatedEventId && cost.relatedEventId === event.relatedEventId) return true;
      if (event.type !== "buy" || tradeCountByHoldingDate.get(tradeKey) !== 1 || cost.relatedEventId) return false;
      return cost.holdingId === event.holdingId
        && cost.date === event.date
        && cost.note?.toLowerCase() === "buy transaction cost";
    });
    rows.push({
      id: `event:${event.id}`,
      kind: "trade",
      holdingId: event.holdingId,
      groupId: event.groupId ?? identity?.groupId,
      symbol: event.symbol ?? identity?.symbol ?? "—",
      name: event.name ?? identity?.name ?? event.symbol ?? "—",
      market: event.market ?? identity?.market,
      currency: event.currency || identity?.currency || "CNY",
      side: event.type,
      status: "recorded",
      source: event.source,
      date: event.date,
      sortTime: event.createdAt || `${event.date}T00:00:00.000Z`,
      amount: grossAmount,
      quantity: event.quantity,
      price: event.price,
      fee: matchingCosts.filter((cost) => cost.type === "fee").reduce((sum, cost) => sum + Math.abs(cost.amount), 0) || undefined,
      tax: matchingCosts.filter((cost) => cost.type === "tax").reduce((sum, cost) => sum + Math.abs(cost.amount), 0) || undefined,
      event,
    });
  }

  return rows.sort((a, b) => b.sortTime.localeCompare(a.sortTime) || b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
