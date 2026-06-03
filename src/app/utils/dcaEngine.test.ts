import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DCAExecution, DCAPlan } from "../context/AppContext";
import type { Holding } from "../data/mockData";
import { computeFundConfirmationDate, dedupeDCAExecutions, fundSettlementDays, repairDCAData, settleDueDCAPlans } from "./dcaEngine";

function plan(patch: Partial<DCAPlan> = {}): DCAPlan {
  return {
    id: "p1",
    holdingId: "h1",
    name: "广发纳斯达克100ETF联接人民币(QDII)C",
    symbol: "006479",
    market: "FUND",
    assetType: "fund",
    amount: 100,
    currency: "CNY",
    frequency: "daily",
    startDate: "2026-05-01",
    enabled: true,
    nextExecDate: "",
    totalInvested: 0,
    execCount: 0,
    ...patch,
  };
}

function holding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "",
    symbol: "AAPL",
    name: "Apple Inc.",
    market: "US",
    assetType: "stock",
    quantity: 10,
    costPrice: 100,
    currentPrice: 120,
    currency: "USD",
    marketValue: 1200,
    todayPnl: 5,
    todayPnlRate: 0.01,
    totalPnl: 200,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

describe("fund settlement", () => {
  test("uses cross-market settlement days for QDII funds", () => {
    const qdii = plan();

    assert.equal(fundSettlementDays(qdii), 2);
    assert.equal(computeFundConfirmationDate(qdii, "2026-05-22"), "2026-05-27");
  });

  test("keeps domestic funds on the A-share settlement calendar", () => {
    const domestic = plan({ name: "招商产业债券A", symbol: "217022" });

    assert.equal(fundSettlementDays(domestic), 1);
    assert.equal(computeFundConfirmationDate(domestic, "2026-05-22"), "2026-05-25");
  });
});

describe("dedupeDCAExecutions", () => {
  test("keeps the strongest record for a plan/date pair", () => {
    const base: DCAExecution = {
      id: "pending",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-05-29",
      actualDate: "2026-05-29",
      amount: 100,
      adjusted: false,
      status: "pending",
    };

    const deduped = dedupeDCAExecutions([
      base,
      { ...base, id: "executed", status: "executed", quantity: 12.3, price: 8.1 },
    ]);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0]?.id, "executed");
  });
});

describe("repairDCAData", () => {
  test("syncs plan identity from its linked holding", () => {
    const repaired = repairDCAData(
      [holding({ symbol: "MSFT", name: "Microsoft", currency: "USD" })],
      [plan({ symbol: "AAPL", name: "Apple Inc.", market: "US" })],
      [],
    );

    assert.equal(repaired.changed, true);
    assert.equal(repaired.plans[0]?.symbol, "MSFT");
    assert.equal(repaired.plans[0]?.name, "Microsoft");
  });
});

describe("settleDueDCAPlans", () => {
  test("catches up due non-fund executions and advances the next date", () => {
    const duePlan = plan({
      market: "US",
      assetType: "stock",
      symbol: "AAPL",
      name: "Apple Inc.",
      nextExecDate: "2026-06-01",
      startDate: "2026-06-01",
    });
    const settled = settleDueDCAPlans(
      [holding()],
      [duePlan],
      [],
      new Date("2026-06-02T12:00:00Z"),
      true,
    );

    assert.equal(settled.executions.length, 2);
    assert.deepEqual(settled.executions.map((item) => item.actualDate).sort(), ["2026-06-01", "2026-06-02"]);
    assert.equal(settled.executions.every((item) => item.status === "executed"), true);
    assert.equal(settled.plans[0]?.nextExecDate, "2026-06-03");
  });
});
