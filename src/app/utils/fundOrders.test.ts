import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Holding } from "../data/mockData";
import {
  computeFundEffectiveDate,
  computeFundOrderCancelDeadline,
  computeFundOrderConfirmDate,
  defaultFundConfirmDays,
  fundOrderReservedBuyAmount,
  fundOrderCancellationState,
  fundOrderConfirmationQuote,
  fundOrderMinimumViolation,
  normalizeFundOrders,
  pendingSellQuantity,
  requestFundOrderCancellation,
  resolveFundOrderCutoff,
  readyFundOrderConfirmations,
  type FundOrder,
} from "./fundOrders";

function holding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "",
    symbol: "019305",
    name: "测试场外基金",
    market: "FUND",
    assetType: "fund",
    quantity: 100,
    costPrice: 1,
    currentPrice: 1.2,
    currency: "CNY",
    marketValue: 120,
    todayPnl: 0,
    todayPnlRate: 0,
    totalPnl: 20,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    priceDate: "2026-06-12",
    fundNavHistory: [{ date: "2026-06-12", nav: 1.2 }],
    updatedAt: "2026-06-12T18:00:00+08:00",
    ...patch,
  };
}

function order(patch: Partial<FundOrder> = {}): FundOrder {
  return {
    id: "o1",
    holdingId: "h1",
    symbol: "019305",
    source: "manual",
    entryMode: "submitted",
    side: "buy",
    status: "pending",
    requestedAt: "2026-06-12T06:00:00.000Z",
    requestedDate: "2026-06-12",
    effectiveDate: "2026-06-12",
    requestedAmount: 100,
    estimatedPrice: 1.2,
    expectedConfirmDate: "2026-06-15",
    channelConfirmedAt: "2026-06-15T01:00:00.000Z",
    rule: {
      tradeStatus: "normal",
      confirmDays: 1,
      cutoffMinutes: 900,
      capturedAt: "2026-06-12T06:00:00.000Z",
    },
    createdAt: "2026-06-12T06:00:00.000Z",
    updatedAt: "2026-06-12T06:00:00.000Z",
    ...patch,
  };
}

describe("fund order dates", () => {
  test("uses the same trading day before cutoff and rolls after cutoff", () => {
    assert.equal(computeFundEffectiveDate(new Date("2026-06-12T14:59:00+08:00")), "2026-06-12");
    assert.equal(computeFundEffectiveDate(new Date("2026-06-12T15:00:00+08:00")), "2026-06-15");
    assert.equal(computeFundEffectiveDate(new Date("2026-06-13T10:00:00+08:00")), "2026-06-15");
  });

  test("keeps independent buy and sell confirmation rules", () => {
    const fund = holding({ fundBuyConfirmDays: 1, fundSellConfirmDays: 3 });
    assert.equal(defaultFundConfirmDays(fund, "buy"), 1);
    assert.equal(defaultFundConfirmDays(fund, "sell"), 3);
    assert.equal(computeFundOrderConfirmDate(fund, "2026-06-12", 3), "2026-06-17");
  });

  test("uses the effective trading-day cutoff as the cancellation deadline", () => {
    assert.equal(computeFundOrderCancelDeadline("2026-06-12"), "2026-06-12T07:00:00.000Z");
    assert.equal(computeFundOrderCancelDeadline("bad-date"), undefined);
  });

  test("prefers returned channel cutoffs and marks the 15:00 fallback as estimated", () => {
    const returned = resolveFundOrderCutoff(holding({
      fundBuyCutoffMinutes: 14 * 60 + 30,
      fundBuyCancellationAllowed: true,
      fundCancellationRuleSource: "broker-order-rule",
    }), "buy");
    assert.equal(returned.cutoffMinutes, 870);
    assert.equal(returned.cutoffEstimated, false);
    assert.equal(returned.cancellationPolicy, "channel_cutoff");
    assert.equal(computeFundEffectiveDate(new Date("2026-06-12T14:30:00+08:00"), returned.cutoffMinutes), "2026-06-15");

    const fallback = resolveFundOrderCutoff(holding(), "buy");
    assert.equal(fallback.cutoffMinutes, 900);
    assert.equal(fallback.cutoffEstimated, true);
    assert.equal(fallback.cancellationPolicy, "standard_cutoff");
  });

  test("keeps DCA trigger orders non-cancellable regardless of channel metadata", () => {
    const returned = resolveFundOrderCutoff(holding({
      fundDcaCutoffMinutes: 14 * 60 + 30,
      fundDcaCancellationAllowed: true,
      fundCancellationRuleSource: "broker-order-rule",
    }), "buy", "dca");
    assert.equal(returned.cutoffMinutes, 870);
    assert.equal(returned.cancellationPolicy, "not_cancellable");
    assert.equal(returned.cancellationPolicySource, "自动定投触发单不可手工撤销");
  });
});

describe("fund order cancellation", () => {
  test("allows cancellation before the acceptance cutoff and releases reservations", () => {
    const pending = order({ cancelDeadline: "2026-06-12T07:00:00.000Z" });
    assert.equal(fundOrderCancellationState(pending, new Date("2026-06-12T14:59:59+08:00")), "cancellable");
    const result = requestFundOrderCancellation([pending], pending.id, new Date("2026-06-12T14:59:59+08:00"));
    assert.equal(result.ok, true);
    assert.equal(result.orders[0]?.status, "cancelled");
    assert.equal(fundOrderReservedBuyAmount(result.orders, holding(), "2026-06-12"), 0);
  });

  test("rejects cancellation at or after cutoff without releasing funds or shares", () => {
    const pendingBuy = order({ cancelDeadline: "2026-06-12T07:00:00.000Z" });
    const pendingSell = order({ id: "sell", side: "sell", requestedAmount: undefined, requestedQuantity: 20, cancelDeadline: "2026-06-12T07:00:00.000Z" });
    assert.equal(fundOrderCancellationState(pendingBuy, new Date("2026-06-12T15:00:00+08:00")), "accepted");
    const result = requestFundOrderCancellation([pendingBuy, pendingSell], pendingBuy.id, new Date("2026-06-12T15:00:00+08:00"));
    assert.equal(result.ok, false);
    assert.equal(result.error, "deadline_passed");
    assert.equal(fundOrderReservedBuyAmount(result.orders, holding(), "2026-06-12"), 100);
    assert.equal(pendingSellQuantity(result.orders, "h1"), 20);
  });

  test("never allows manual cancellation of DCA trigger orders", () => {
    const dcaOrder = order({ source: "dca", rule: { ...order().rule, cancellationPolicy: "not_cancellable" } });
    assert.equal(fundOrderCancellationState(dcaOrder, new Date("2026-06-12T14:00:00+08:00")), "not_cancellable");
    assert.equal(requestFundOrderCancellation([dcaOrder], dcaOrder.id).error, "not_cancellable");

    const cancellableDca = order({
      id: "dca-cancellable",
      source: "dca",
      cancelDeadline: "2026-06-12T06:30:00.000Z",
      rule: { ...order().rule, cutoffMinutes: 870, cancellationPolicy: "channel_cutoff" },
    });
    assert.equal(fundOrderCancellationState(cancellableDca, new Date("2026-06-12T14:00:00+08:00")), "not_cancellable");
    assert.equal(requestFundOrderCancellation([cancellableDca], cancellableDca.id, new Date("2026-06-12T14:00:00+08:00")).error, "not_cancellable");

    const unknownDca = order({ id: "dca-unknown", source: "dca", rule: { ...order().rule, cancellationPolicy: "unknown" } });
    assert.equal(fundOrderCancellationState(unknownDca), "not_cancellable");
    assert.equal(requestFundOrderCancellation([unknownDca], unknownDca.id).error, "not_cancellable");
  });
});

describe("fund order reservations", () => {
  test("aggregates same-fund daily purchases and releases cancelled orders", () => {
    const sameSymbolOtherHolding = order({ id: "o2", holdingId: "h2", requestedAmount: 50 });
    const cancelled = order({ id: "o3", requestedAmount: 1000, status: "cancelled" });
    const otherDate = order({ id: "o4", requestedAmount: 1000, effectiveDate: "2026-06-15" });
    assert.equal(fundOrderReservedBuyAmount([order(), sameSymbolOtherHolding, cancelled, otherDate], holding(), "2026-06-12"), 150);
  });

  test("freezes only pending redemption quantities", () => {
    assert.equal(pendingSellQuantity([
      order({ side: "sell", requestedQuantity: 30 }),
      order({ id: "o2", side: "sell", requestedQuantity: 20, status: "confirmed" }),
      order({ id: "o3", side: "sell", requestedQuantity: 10, status: "cancelled" }),
    ], "h1"), 30);
  });
});

describe("fund order minimums", () => {
  const rule = {
    minimumPurchaseAmount: 10,
    minimumRedemptionQuantity: 5,
    minimumRemainingQuantity: 10,
  };

  test("validates additional purchases and partial redemptions", () => {
    assert.deepEqual(fundOrderMinimumViolation("buy", rule, { requestedAmount: 9 }), { type: "purchase_minimum", minimum: 10 });
    assert.deepEqual(fundOrderMinimumViolation("sell", rule, { requestedQuantity: 4, availableQuantity: 100 }), { type: "redemption_minimum", minimum: 5 });
    assert.deepEqual(fundOrderMinimumViolation("sell", rule, { requestedQuantity: 95, availableQuantity: 100 }), { type: "remaining_minimum", minimum: 10 });
  });

  test("allows a full redemption even when the remaining quantity is below minimums", () => {
    assert.equal(fundOrderMinimumViolation("sell", rule, { requestedQuantity: 4, availableQuantity: 4 }), null);
  });
});

describe("fund order confirmation", () => {
  test("produces an automatic fill without a channel confirmation marker", () => {
    const pending = order({ channelConfirmedAt: undefined });
    assert.ok(fundOrderConfirmationQuote(holding(), pending, "2026-06-15"));
    assert.equal(readyFundOrderConfirmations([holding()], [pending], "2026-06-15").length, 1);
  });

  test("never unlocks confirmation from a same-day intraday NAV estimate", () => {
    const pending = order({ channelConfirmedAt: undefined, effectiveDate: "2026-06-15", expectedConfirmDate: "2026-06-15" });
    const estimated = holding({
      currentPrice: 1.25,
      priceDate: "2026-06-15",
      fundNavHistory: [{ date: "2026-06-12", nav: 1.2 }],
      estimatedNav: 1.25,
      estimatedNavAt: "2026-06-15 14:30",
    });
    assert.equal(fundOrderConfirmationQuote(estimated, pending, "2026-06-15"), null);
  });

  test("waits for both T+N and the effective-date official NAV", () => {
    const pending = order();
    assert.deepEqual(readyFundOrderConfirmations([holding()], [pending], "2026-06-12"), []);
    assert.equal(readyFundOrderConfirmations([holding()], [pending], "2026-06-15")[0]?.quantity, 100 / 1.2);
    assert.deepEqual(readyFundOrderConfirmations([holding({ priceDate: "2026-06-13", fundNavHistory: [] })], [pending], "2026-06-15"), []);
  });

  test("keeps the requested redemption quantity so settlement can reject inconsistent oversells", () => {
    const redemption = order({ side: "sell", requestedAmount: undefined, requestedQuantity: 120 });
    assert.equal(readyFundOrderConfirmations([holding()], [redemption], "2026-06-15")[0]?.quantity, 120);
  });

  test("normalizes imported orders and rejects malformed rows", () => {
    const normalized = normalizeFundOrders([
      order({ rule: { ...order().rule, transactionCostProfile: { buyFeeRate: 0.01, minimumFee: -1 } } }),
      { id: "bad" },
    ]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0]?.id, "o1");
    assert.equal(normalized[0]?.channelConfirmedAt, "2026-06-15T01:00:00.000Z");
    assert.deepEqual(normalized[0]?.rule.transactionCostProfile, { buyFeeRate: 0.01 });
  });

  test("migrates persisted DCA orders from unknown or channel cutoff to non-cancellable", () => {
    for (const cancellationPolicy of ["unknown", "channel_cutoff"] as const) {
      const [normalized] = normalizeFundOrders([
        order({
          id: `dca-${cancellationPolicy}`,
          source: "dca",
          cancelDeadline: "2099-01-01T00:00:00.000Z",
          rule: {
            ...order().rule,
            cancellationPolicy,
            cancellationPolicySource: "legacy-channel-rule",
          },
        }),
      ]);
      assert.equal(normalized?.rule.cancellationPolicy, "not_cancellable");
      assert.equal(normalized?.rule.cancellationPolicySource, "自动定投触发单不可手工撤销");
      assert.equal(normalized?.cancelDeadline, undefined);
      assert.equal(normalized && fundOrderCancellationState(normalized), "not_cancellable");
    }
  });

  test("preserves an exact deadline returned for a channel order", () => {
    const [normalized] = normalizeFundOrders([
      order({
        cancelDeadline: "2026-06-12T06:25:00.000Z",
        rule: {
          ...order().rule,
          cutoffMinutes: 870,
          cancellationPolicy: "channel_cutoff",
          cutoffSource: "broker-order-response",
          cutoffEstimated: false,
        },
      }),
    ]);
    assert.equal(normalized?.cancelDeadline, "2026-06-12T06:25:00.000Z");
    assert.equal(normalized?.rule.cutoffEstimated, false);
  });

  test("marks malformed pending payloads rejected and derives a safe cancellation deadline", () => {
    const [normalized] = normalizeFundOrders([
      order({ requestedAmount: undefined, cancelDeadline: "2099-01-01T00:00:00.000Z" }),
    ]);
    assert.equal(normalized?.status, "rejected");
    assert.match(normalized?.reason ?? "", /金额或份额缺失/);
    assert.equal(normalized?.cancelDeadline, "2026-06-12T07:00:00.000Z");
  });
});
