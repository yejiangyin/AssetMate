import assert from "node:assert/strict";
import test from "node:test";
import type { Holding } from "../data/mockData";
import type { PortfolioEvent } from "../services/portfolioEvents";
import type { FundOrder } from "./fundOrders";
import { buildTransactionRecords } from "./transactionRecords";

const holding = {
  id: "h1", groupId: "g1", symbol: "000001", name: "测试基金", market: "FUND", currency: "CNY",
} as Holding;

function order(patch: Partial<FundOrder> = {}): FundOrder {
  return {
    id: "o1", holdingId: "h1", symbol: "000001", source: "manual", entryMode: "submitted",
    side: "buy", status: "confirmed", requestedAt: "2026-08-14T02:00:00.000Z", requestedDate: "2026-08-14",
    effectiveDate: "2026-08-14", requestedAmount: 1000, estimatedPrice: 1,
    expectedConfirmDate: "2026-08-15", confirmedDate: "2026-08-15", navDate: "2026-08-14",
    confirmedPrice: 1, confirmedQuantity: 1000, confirmedAmount: 1000,
    rule: { tradeStatus: "normal", confirmDays: 1, cutoffMinutes: 900, capturedAt: "2026-08-14T02:00:00.000Z" },
    createdAt: "2026-08-14T02:00:00.000Z", updatedAt: "2026-08-15T02:00:00.000Z", ...patch,
  };
}

function event(patch: Partial<PortfolioEvent> = {}): PortfolioEvent {
  return {
    id: "e1", holdingId: "h1", symbol: "000001", name: "测试基金", market: "FUND",
    date: "2026-08-14", type: "buy", quantity: 1000, price: 1, amount: 1000, amountInBase: 1000,
    currency: "CNY", source: "manual", createdAt: "2026-08-15T02:00:00.000Z", ...patch,
  };
}

test("confirmed purchase keeps the order row and hides its generated fill event", () => {
  const rows = buildTransactionRecords([order()], [event({ relatedEventId: "o1" })], [holding]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "order");
  assert.equal(rows[0]?.status, "confirmed");
});

test("recorded buy remains a standalone filled-trade row", () => {
  const fee = event({ id: "fee", type: "fee", quantity: undefined, price: undefined, amount: -5, amountInBase: -5, note: "buy transaction cost" });
  const rows = buildTransactionRecords([], [event(), fee], [holding]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "trade");
  assert.equal(rows[0]?.status, "recorded");
  assert.equal(rows[0]?.fee, 5);
});

test("confirmed redemption is not duplicated by its closed-position sell event", () => {
  const sellOrder = order({ side: "sell", requestedAmount: undefined, requestedQuantity: 100, confirmedQuantity: 100, confirmedPrice: 1.2, confirmedAmount: 120 });
  const sellEvent = event({ type: "sell", quantity: 100, price: 1.2, relatedEventId: "closed-1" });
  const rows = buildTransactionRecords([sellOrder], [sellEvent], [holding]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "order");
  assert.equal(rows[0]?.side, "sell");
});

test("pending, cancelled and rejected orders remain visible", () => {
  const rows = buildTransactionRecords([
    order({ id: "pending", status: "pending" }),
    order({ id: "cancelled", status: "cancelled" }),
    order({ id: "rejected", status: "rejected" }),
  ], [], [holding]);
  assert.deepEqual(new Set(rows.map((row) => row.status)), new Set(["pending", "cancelled", "rejected"]));
});

test("automatically posted non-fund DCA executions remain canonical transaction rows", () => {
  const stock = { ...holding, symbol: "AAPL", name: "Apple", market: "US", currency: "USD" } as Holding;
  const rows = buildTransactionRecords([], [event({ relatedEventId: "dca-stock", symbol: "AAPL", market: "US" })], [stock], [{
    id: "dca-stock",
    holdingId: "h1",
    actualDate: "2026-08-14",
    amount: 100,
    status: "executed",
    quantity: 0.5,
    price: 200,
    confirmedDate: "2026-08-14",
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "execution");
  assert.equal(rows[0]?.status, "confirmed");
  assert.equal(rows[0]?.reason, undefined);
});
