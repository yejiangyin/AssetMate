import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DCAExecution, DCAPlan } from "../context/AppContext";
import type { Holding } from "../data/mockData";
import type { FundOrder } from "./fundOrders";
import {
  computeFundConfirmationDate,
  computeNextExec,
  dedupeDCAExecutions,
  fundSettlementDays,
  hydratePlans,
  originalScheduledDate,
  parseChineseMoneyLimit,
  repairDCAData,
  recentDcaCutoff,
  recentDcaExecutions,
  recordDcaPlanChange,
  dcaPlanAtDate,
  settleDueDCAPlans,
  syncPlanWithHolding,
} from "./dcaEngine";

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

test("recent month includes all rows and clamps month ends without deleting history", () => {
  assert.equal(recentDcaCutoff(new Date(2026, 2, 31)), "2026-02-28");
  assert.equal(recentDcaCutoff(new Date(2026, 0, 15)), "2025-12-15");
  const rows = Array.from({ length: 31 }, (_, i): DCAExecution => ({
    id: `row-${i}`, planId: "p1", holdingId: "h1", amount: 2, adjusted: false,
    status: "skipped", actualDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
    scheduledDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
  }));
  const recent = recentDcaExecutions(rows, new Date(2026, 8, 16));
  assert.equal(recent.length, 16);
  assert.equal(recent.at(-1)?.actualDate, "2026-08-16");
  assert.equal(rows.length, 31);
});

test("recovers technical skips at saved amounts, posts historical NAV once, and preserves cancellations", () => {
  const fund = holding({ market: "FUND", assetType: "fund", autoTradeStatus: "fund_limit",
    autoTradeStatusNote: "基金限购，5元", autoTradeStatusStale: true,
    fundNavHistory: [{ date: "2026-06-15", nav: 2 }], fundBuyConfirmDays: 1 });
  const p = plan({ startDate: "2026-06-15", nextExecDate: "2026-06-18", amount: 100, fundBuyConfirmDays: 1 });
  const skipped: DCAExecution = { id: "recover", planId: "p1", holdingId: "h1", amount: 2,
    scheduledDate: "2026-06-15", actualDate: "2026-06-15", adjusted: false,
    status: "skipped", reason: "应用未运行，历史计划未自动补单" };
  const cancelled: DCAExecution = { ...skipped, id: "cancelled", scheduledDate: "2026-06-16", actualDate: "2026-06-16", status: "cancelled" };
  const now = new Date("2026-06-17T12:00:00+08:00");
  const first = settleDueDCAPlans([fund], [p], [skipped, cancelled], now);
  assert.equal(first.executions.find((row) => row.id === "recover")?.status, "executed");
  assert.equal(first.executions.find((row) => row.id === "recover")?.price, 2);
  assert.equal(first.executions.find((row) => row.id === "cancelled")?.status, "cancelled");
  const second = settleDueDCAPlans(first.holdings, first.plans, first.executions, now);
  assert.equal(second.holdings[0]?.quantity, first.holdings[0]?.quantity);
  assert.equal(second.executions.length, first.executions.length);
  assert.equal(second.plans[0]?.totalInvested, 2);
  const paused = settleDueDCAPlans([fund], [{ ...p, enabled: false }], [skipped], now);
  assert.equal(paused.executions[0]?.status, "skipped");
  const resumed = settleDueDCAPlans([fund], [{ ...p, catchUpFromDate: "2026-06-17" }], [skipped], now);
  assert.equal(resumed.executions.find((row) => row.id === "recover")?.status, "skipped");
  assert.equal(resumed.executions.some((row) => row.actualDate === "2026-06-16"), false);
});

describe("DCA rule changes and retries", () => {
  const now = new Date("2026-06-17T12:00:00+08:00");
  const fund = () => holding({ market: "FUND", assetType: "fund", symbol: "006479", name: "测试基金",
    autoTradeStatus: "fund_limit", autoTradeStatusNote: "基金限购，5元" });
  const todayPlan = () => plan({ amount: 3, startDate: "2026-06-17", nextExecDate: "2026-06-17" });

  test("counts a recovered rejected mirror toward another plan's daily limit", () => {
    const h = fund();
    const skipped: DCAExecution = { id: "recovered", planId: "p1", holdingId: "h1", amount: 3,
      scheduledDate: "2026-06-17", actualDate: "2026-06-17", adjusted: false, status: "skipped", reason: "基金交易规则刷新失败" };
    const mirror: FundOrder = { id: "recovered", holdingId: h.id, symbol: h.symbol, planId: "p1",
      source: "dca", side: "buy", entryMode: "submitted", status: "rejected", requestedAmount: 3,
      effectiveDate: "2026-06-17", expectedConfirmDate: "2026-06-19", requestedDate: "2026-06-17", requestedAt: now.toISOString(),
      rule: { tradeStatus: "fund_limit", purchaseLimit: 5, confirmDays: 2, cutoffMinutes: 900, capturedAt: now.toISOString() },
      createdAt: now.toISOString(), updatedAt: now.toISOString() };
    const result = settleDueDCAPlans([h, { ...h, id: "h2" }], [todayPlan(), { ...todayPlan(), id: "p2", holdingId: "h2" }], [skipped], now, true, [mirror]);
    assert.equal(result.executions.find((x) => x.planId === "p1")?.status, "pending");
    assert.equal(result.executions.find((x) => x.planId === "p2")?.status, "skipped");
    assert.equal(result.executions.filter((x) => x.status === "pending").reduce((sum, x) => sum + x.amount, 0), 3);
  });

  test("uses historical amounts and frequencies after editing, including after reload", () => {
    const previous = plan({ amount: 2, startDate: "2026-06-15", nextExecDate: "2026-06-15" });
    const changed = recordDcaPlanChange(previous, { ...previous, amount: 100, frequency: "weekly", dayOfWeek: 5, nextExecDate: "2026-06-19" }, now);
    const restored = JSON.parse(JSON.stringify(changed)) as DCAPlan;
    const result = settleDueDCAPlans([holding({ market: "FUND", assetType: "fund" })], [restored], [], now);
    assert.deepEqual(result.executions.map((x) => [x.actualDate, x.amount]).sort(), [["2026-06-15", 2], ["2026-06-16", 2]]);
    assert.equal(dcaPlanAtDate(restored, "2026-06-16").amount, 2);
    assert.equal(dcaPlanAtDate(restored, "2026-06-17").amount, 100);
    // June 19 is a US market holiday; the Friday occurrence shifts to Monday.
    assert.equal(computeNextExec(restored, new Date("2026-06-16T12:00:00Z"), false), "2026-06-22");
    const secondEdit = recordDcaPlanChange(restored, { ...restored, amount: 50 }, now);
    assert.equal(secondEdit.ruleHistory?.length, 2);
    assert.equal(dcaPlanAtDate(secondEdit, "2026-06-16").amount, 2);
    assert.equal(dcaPlanAtDate(secondEdit, "2026-06-17").amount, 50);
  });

  test("an edited start date does not suppress earlier valid periods", () => {
    const old = plan({ amount: 2, startDate: "2026-06-15" });
    const changed = recordDcaPlanChange(old, { ...old, startDate: "2026-06-25", nextExecDate: "2026-06-25" }, now);
    const result = settleDueDCAPlans([holding({ market: "FUND", assetType: "fund" })], [changed], [], now);
    assert.deepEqual(result.executions.map((x) => x.actualDate).sort(), ["2026-06-15", "2026-06-16"]);
  });

  test("retries a same-day restriction only after conditions change and never duplicates an accepted order", () => {
    const restricted = { ...fund(), fundMinDcaAmount: 5 };
    const first = settleDueDCAPlans([restricted], [todayPlan()], [], now);
    assert.equal(first.executions[0]?.status, "skipped");
    assert.ok(first.executions[0]?.evaluationKey);
    const unchanged = settleDueDCAPlans([{ ...restricted, autoTradeStatusUpdatedAt: now.toISOString() }], first.plans, first.executions, now);
    assert.deepEqual(unchanged.executions, first.executions);
    const relaxed = { ...restricted, fundMinDcaAmount: 1 };
    const retried = settleDueDCAPlans([relaxed], first.plans, first.executions, now);
    assert.equal(retried.executions[0]?.status, "pending");
    assert.equal(retried.executions[0]?.id, first.executions[0]?.id);
    const again = settleDueDCAPlans([relaxed], retried.plans, retried.executions, now);
    assert.deepEqual(again.executions, retried.executions);
    const tomorrow = settleDueDCAPlans([relaxed], first.plans, first.executions, new Date("2026-06-18T12:00:00+08:00"));
    assert.equal(tomorrow.executions.find((x) => x.actualDate === "2026-06-17")?.status, "skipped");
  });

  test("uses an edited amount for today's rejected order but preserves accepted amounts", () => {
    const h = fund();
    const p = { ...todayPlan(), amount: 6 };
    const first = settleDueDCAPlans([h], [p], [], now);
    const changed = recordDcaPlanChange(first.plans[0]!, { ...first.plans[0]!, amount: 2 }, now);
    const retried = settleDueDCAPlans([h], [changed], first.executions, now);
    assert.equal(retried.executions[0]?.amount, 2);
    assert.equal(retried.executions[0]?.status, "pending");
    const editedAgain = recordDcaPlanChange(changed, { ...changed, amount: 4 }, now);
    const accepted = settleDueDCAPlans([h], [editedAgain], retried.executions, now);
    assert.equal(accepted.executions[0]?.amount, 2);
    assert.equal(accepted.executions.length, 1);
  });
});

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

  test("uses the fund-specific buy confirmation days when available", () => {
    const custom = plan({ fundBuyConfirmDays: 3 });

    assert.equal(fundSettlementDays(custom), 3);
    assert.equal(computeFundConfirmationDate(custom, "2026-05-22"), "2026-05-28");
  });

  test("handles T+0 and rejects invalid fund-specific confirmation days", () => {
    assert.equal(fundSettlementDays(plan({ fundBuyConfirmDays: 0 })), 0);
    assert.equal(computeFundConfirmationDate(plan({ fundBuyConfirmDays: 0 }), "2026-05-22"), "2026-05-22");
    assert.equal(fundSettlementDays(plan({ fundBuyConfirmDays: 31 })), 2);
    assert.equal(fundSettlementDays(plan({ fundBuyConfirmDays: -1 })), 2);
  });
});

describe("computeNextExec", () => {
  test("computes daily, weekly, and monthly execution dates", () => {
    assert.equal(computeNextExec(plan({
      market: "US",
      frequency: "daily",
      startDate: "2026-06-01",
    }), new Date("2026-06-01T12:00:00Z"), true), "2026-06-01");

    assert.equal(computeNextExec(plan({
      market: "US",
      frequency: "weekly",
      dayOfWeek: 1,
      startDate: "2026-06-01",
    }), new Date("2026-06-02T12:00:00Z"), true), "2026-06-08");

    assert.equal(computeNextExec(plan({
      market: "US",
      frequency: "monthly",
      dayOfMonth: 15,
      startDate: "2026-06-01",
    }), new Date("2026-06-16T12:00:00Z"), true), "2026-07-15");
  });

  test("moves non-trading scheduled dates to the next open day", () => {
    assert.equal(computeNextExec(plan({
      market: "US",
      frequency: "monthly",
      dayOfMonth: 4,
      startDate: "2026-07-01",
    }), new Date("2026-07-01T12:00:00Z"), true), "2026-07-06");
  });

  test("supports weekend schedules for crypto plans", () => {
    assert.equal(computeNextExec(plan({
      market: "CRYPTO",
      assetType: "crypto",
      name: "Bitcoin",
      frequency: "weekly",
      dayOfWeek: 0,
      startDate: "2026-06-01",
    }), new Date("2026-06-07T12:00:00Z"), true), "2026-06-07");
  });
});

describe("originalScheduledDate", () => {
  test("reconstructs daily, weekly, and monthly scheduled dates", () => {
    assert.equal(originalScheduledDate(plan({ frequency: "daily" }), "2026-02-03"), "2026-02-03");
    assert.equal(originalScheduledDate(plan({ frequency: "weekly", dayOfWeek: 1 }), "2026-06-10"), "2026-06-08");
    assert.equal(originalScheduledDate(plan({ frequency: "monthly", dayOfMonth: 31 }), "2026-02-28"), "2026-02-28");
  });
});

describe("syncPlanWithHolding", () => {
  test("syncs identity and keeps valid fund confirmation days only", () => {
    const synced = syncPlanWithHolding(plan({ symbol: "OLD", market: "US", fundBuyConfirmDays: 3 }), holding({
      id: "h2",
      symbol: "006479",
      name: "广发纳斯达克100ETF联接人民币(QDII)C",
      market: "FUND",
      assetType: "fund",
      currency: "CNY",
      fundBuyConfirmDays: 0,
    }));
    const invalid = syncPlanWithHolding(plan({ fundBuyConfirmDays: 3 }), holding({ fundBuyConfirmDays: 31 }));

    assert.equal(synced.holdingId, "h2");
    assert.equal(synced.symbol, "006479");
    assert.equal(synced.market, "FUND");
    assert.equal(synced.assetType, "fund");
    assert.equal(synced.currency, "CNY");
    assert.equal(synced.fundBuyConfirmDays, 0);
    assert.equal(invalid.fundBuyConfirmDays, undefined);
  });
});

describe("hydratePlans", () => {
  test("recovers first due date for never-settled persisted plans", () => {
    const hydrated = hydratePlans([plan({
      id: "p-never",
      market: "US",
      assetType: "stock",
      frequency: "daily",
      startDate: "2026-01-05",
      nextExecDate: "",
      totalInvested: undefined as any,
      execCount: undefined as any,
    })], []);

    assert.equal(hydrated[0]?.nextExecDate, "2026-01-05");
    assert.equal(hydrated[0]?.totalInvested, 0);
    assert.equal(hydrated[0]?.execCount, 0);
  });

  test("keeps existing next date for settled plans", () => {
    const hydrated = hydratePlans([plan({
      id: "p-settled",
      nextExecDate: "2026-08-01",
      totalInvested: 100,
      execCount: 1,
    })], [{ ...({} as DCAExecution), id: "e1", planId: "p-settled", holdingId: "h1", scheduledDate: "2026-07-01", actualDate: "2026-07-01", amount: 100, adjusted: false, status: "executed" }]);

    assert.equal(hydrated[0]?.nextExecDate, "2026-08-01");
  });
});

describe("parseChineseMoneyLimit", () => {
  test("parses common Chinese RMB units", () => {
    assert.equal(parseChineseMoneyLimit("限购 1万 元"), 10000);
    assert.equal(parseChineseMoneyLimit("限购 1.5万元"), 15000);
    assert.equal(parseChineseMoneyLimit("限购 2千元"), 2000);
    assert.equal(parseChineseMoneyLimit("限购 3百元"), 300);
    assert.equal(parseChineseMoneyLimit("限购 4十元"), 40);
    assert.equal(parseChineseMoneyLimit("限购 100元"), 100);
    assert.equal(parseChineseMoneyLimit("限购1万5千元"), 15000);
    assert.equal(parseChineseMoneyLimit("限购1万零500元"), 10500);
    assert.equal(parseChineseMoneyLimit("限购 0.5万元"), 5000);
    assert.equal(parseChineseMoneyLimit("限购 100.5元"), 100.5);
    assert.equal(parseChineseMoneyLimit("限购 1万"), 10000);
  });

  test("rejects missing or invalid limits", () => {
    assert.equal(parseChineseMoneyLimit("不限额"), null);
    assert.equal(parseChineseMoneyLimit("限购 0元"), 0);
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

  test("does not resurrect a cancelled execution from a duplicate pending row", () => {
    const pending = {
      id: "pending",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-10",
      actualDate: "2026-06-10",
      amount: 100,
      adjusted: false,
      status: "pending" as const,
    };
    const cancelled = { ...pending, id: "cancelled", status: "cancelled" as const, reason: "用户撤销" };
    assert.equal(dedupeDCAExecutions([pending, cancelled])[0]?.status, "cancelled");
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
  test("marks missed non-fund periods skipped and automatically posts the valid current trigger", () => {
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
    assert.equal(settled.executions.find((item) => item.actualDate === "2026-06-01")?.status, "skipped");
    const current = settled.executions.find((item) => item.actualDate === "2026-06-02");
    assert.equal(current?.status, "executed");
    assert.equal(current?.price, 120);
    assert.ok((current?.quantity ?? 0) > 0);
    assert.equal(current?.reason, undefined);
    assert.ok((settled.holdings[0]?.quantity ?? 0) > 10);
    assert.equal(settled.plans[0]?.nextExecDate, "2026-06-03");

    const repeated = settleDueDCAPlans(
      settled.holdings,
      settled.plans,
      settled.executions,
      new Date("2026-06-02T12:00:00Z"),
      true,
    );
    assert.equal(repeated.holdings[0]?.quantity, settled.holdings[0]?.quantity);
    assert.equal(repeated.executions.filter((item) => item.actualDate === "2026-06-02").length, 1);
  });

  test("allows one-hour-old non-fund quotes but skips quotes older than one day", () => {
    const previousNow = Date.now;
    Date.now = () => Date.parse("2026-06-02T12:00:00Z");
    try {
      const duePlan = plan({
        market: "US",
        assetType: "stock",
        symbol: "AAPL",
        name: "Apple Inc.",
        nextExecDate: "2026-06-01",
        startDate: "2026-06-01",
      });
      const recent = settleDueDCAPlans(
        [holding({ updatedAt: "2026-06-02T11:00:00Z" })],
        [duePlan],
        [],
        new Date("2026-06-01T12:00:00Z"),
        true,
      );
      const stale = settleDueDCAPlans(
        [holding({ updatedAt: "2026-06-01T11:00:00Z" })],
        [duePlan],
        [],
        new Date("2026-06-01T12:00:00Z"),
        true,
      );

      assert.equal(recent.executions[0]?.status, "executed");
      assert.equal(stale.executions[0]?.status, "skipped");
      assert.match(stale.executions[0]?.reason ?? "", /报价未刷新/);
    } finally {
      Date.now = previousNow;
    }
  });

  test("allows fund DCA when the amount is within the current purchase limit", () => {
    const limitedPlan = plan({
      amount: 10,
      nextExecDate: "2026-06-10",
      startDate: "2026-06-10",
    });
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.2,
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [limitedPlan],
      [],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions[0]?.status, "pending");
  });

  for (const scenario of [
    { amount: 2, patch: {}, expected: "pending" },
    { amount: 5, patch: {}, expected: "pending" },
    { amount: 6, patch: {}, expected: "skipped" },
    { amount: 2, patch: { fundDcaStatus: "buy_disabled" }, expected: "skipped" },
    { amount: 2, patch: { fundMinDcaAmount: 3 }, expected: "skipped" },
    { amount: 2, patch: { tradeStatus: "suspended" }, expected: "skipped" },
    { amount: 2, patch: { autoTradeStatusNote: "基金限购" }, expected: "skipped" },
    { amount: 2, patch: { currentPrice: 0 }, expected: "pending" },
  ] satisfies { amount: number; patch: Partial<Holding>; expected: string }[]) {
  test(`uses last-known limit with guards: ${JSON.stringify(scenario)}`, () => {
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "006479",
        name: "测试限购基金",
        currency: "CNY",
        currentPrice: 1.2,
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，5元",
        autoTradeStatusSource: "eastmoney",
        autoTradeStatusUpdatedAt: "2026-06-09T08:00:00.000Z",
        autoTradeStatusStale: true,
        autoTradeStatusRefreshNote: "基金交易规则刷新失败",
        ...scenario.patch,
      })],
      [plan({ amount: scenario.amount, nextExecDate: "2026-06-10", startDate: "2026-06-10" })],
      [],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions[0]?.status, scenario.expected);
  });
  }

  test("skips fund DCA when the amount is above the current purchase limit", () => {
    const limitedPlan = plan({
      amount: 100,
      nextExecDate: "2026-06-10",
      startDate: "2026-06-10",
    });
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.2,
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [limitedPlan],
      [],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions[0]?.status, "skipped");
    assert.match(settled.executions[0]?.reason ?? "", /计划金额 100 元，限购 10 元/);
  });

  test("uses the independent DCA minimum before the additional-purchase minimum", () => {
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "测试基金",
        currency: "CNY",
        currentPrice: 1.2,
        fundMinPurchaseAmount: 1,
        fundMinDcaAmount: 100,
      })],
      [plan({ amount: 10, nextExecDate: "2026-06-10", startDate: "2026-06-10" })],
      [],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
    );
    assert.equal(settled.executions[0]?.status, "skipped");
    assert.match(settled.executions[0]?.reason ?? "", /低于定投起点 100 元/);
  });

  for (const stale of [false, true]) {
  test(`shares the daily purchase limit with manually submitted fund orders (stale=${stale})`, () => {
    const limitedPlan = plan({ amount: 10, nextExecDate: "2026-06-10", startDate: "2026-06-10" });
    const fundHolding = holding({
      market: "FUND",
      assetType: "fund",
      symbol: "019305",
      name: "摩根标普500指数(QDII)人民币C",
      currency: "CNY",
      currentPrice: 1.2,
      autoTradeStatus: "fund_limit",
      autoTradeStatusNote: "基金限购，10元",
      autoTradeStatusSource: "eastmoney",
    });
    fundHolding.autoTradeStatusStale = stale;
    const manualOrder: FundOrder = {
      id: "manual-order",
      holdingId: fundHolding.id,
      symbol: fundHolding.symbol,
      source: "manual",
      entryMode: "submitted",
      side: "buy",
      status: "pending",
      requestedAt: "2026-06-10T01:00:00.000Z",
      requestedDate: "2026-06-10",
      effectiveDate: "2026-06-10",
      requestedAmount: 5,
      expectedConfirmDate: "2026-06-12",
      rule: { tradeStatus: "fund_limit", purchaseLimit: 10, confirmDays: 2, cutoffMinutes: 900, capturedAt: "2026-06-10T01:00:00.000Z" },
      createdAt: "2026-06-10T01:00:00.000Z",
      updatedAt: "2026-06-10T01:00:00.000Z",
    };

    const settled = settleDueDCAPlans(
      [fundHolding],
      [limitedPlan],
      [],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
      [manualOrder],
    );

    assert.equal(settled.executions[0]?.status, "skipped");
    assert.match(settled.executions[0]?.reason ?? "", /计划金额 15 元，限购 10 元/);
  });
  }

  test("counts mirrored DCA fund orders once when sharing the daily limit", () => {
    const fundHolding = holding({
      market: "FUND",
      assetType: "fund",
      symbol: "019305",
      name: "测试基金",
      currency: "CNY",
      currentPrice: 1.2,
      autoTradeStatus: "fund_limit",
      autoTradeStatusNote: "基金限购，10元",
    });
    const previousExecution: DCAExecution = {
      id: "mirrored-dca",
      planId: "old-plan",
      holdingId: fundHolding.id,
      scheduledDate: "2026-06-10",
      actualDate: "2026-06-10",
      amount: 5,
      adjusted: false,
      status: "pending",
    };
    const mirroredOrder: FundOrder = {
      id: previousExecution.id,
      holdingId: fundHolding.id,
      symbol: fundHolding.symbol,
      planId: previousExecution.planId,
      source: "dca",
      entryMode: "submitted",
      side: "buy",
      status: "pending",
      requestedAt: "2026-06-10T01:00:00.000Z",
      requestedDate: "2026-06-10",
      effectiveDate: "2026-06-10",
      requestedAmount: 5,
      expectedConfirmDate: "2026-06-12",
      rule: { tradeStatus: "fund_limit", purchaseLimit: 10, confirmDays: 2, cutoffMinutes: 900, cancellationPolicy: "not_cancellable", capturedAt: "2026-06-10T01:00:00.000Z" },
      createdAt: "2026-06-10T01:00:00.000Z",
      updatedAt: "2026-06-10T01:00:00.000Z",
    };
    const settled = settleDueDCAPlans(
      [fundHolding],
      [plan({ amount: 5, nextExecDate: "2026-06-10", startDate: "2026-06-10" })],
      [previousExecution],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
      [mirroredOrder],
    );
    const currentExecution = settled.executions.find((item) => item.planId === "p1");
    assert.equal(currentExecution?.status, "pending");
  });

  test("does not retroactively reject an accepted order when the current limit changes", () => {
    const limitedPlan = plan({
      amount: 100,
      nextExecDate: "2026-06-12",
      startDate: "2026-06-08",
    });
    const pending: DCAExecution = {
      id: "pending-limit",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      reason: "等待正式净值确认后入账",
    };

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.6419 }],
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [limitedPlan],
      [pending],
      new Date("2026-06-12T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions.find((item) => item.id === "pending-limit")?.status, "executed");
  });

  test("uses the transaction-cost snapshot captured by a pending fund DCA order", () => {
    const pending: DCAExecution = {
      id: "pending-cost-snapshot",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 121,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-12T01:00:00.000Z",
      transactionCostProfile: { buyFeeRate: 0.01 },
    };
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.2,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.2 }],
        transactionCostProfile: { buyFeeRate: 0.5 },
      })],
      [plan({ amount: 121, nextExecDate: "2026-06-15", startDate: "2026-06-08" })],
      [pending],
      new Date("2026-06-12T12:00:00+08:00"),
      true,
    );
    const execution = settled.executions.find((item) => item.id === pending.id);
    assert.equal(execution?.status, "executed");
    assert.ok(Math.abs((execution?.quantity ?? 0) - (121 / 1.01 / 1.2)) < 1e-8);
  });

  test("uses the confirmation date captured when a fund DCA order was submitted", () => {
    const pending: DCAExecution = {
      id: "pending-confirm-snapshot",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-09T01:00:00.000Z",
      expectedConfirmDate: "2026-06-09",
    };
    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.2,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.2 }],
      })],
      [plan({ fundBuyConfirmDays: 10, nextExecDate: "2026-06-15", startDate: "2026-06-08" })],
      [pending],
      new Date("2026-06-09T12:00:00+08:00"),
      true,
    );
    const execution = settled.executions.find((item) => item.id === pending.id);
    assert.equal(execution?.status, "executed");
    assert.equal(execution?.confirmedDate, "2026-06-09");
  });

  test("does not apply current purchase-limit checks before the official NAV is available", () => {
    const limitedPlan = plan({
      amount: 100,
      nextExecDate: "2026-06-12",
      startDate: "2026-06-08",
      fundBuyConfirmDays: 2,
    });
    const pending: DCAExecution = {
      id: "pending-limit-no-nav",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-12T01:00:00.000Z",
      reason: "等待正式净值确认后入账",
    };

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-10",
        fundNavHistory: [{ date: "2026-06-09", nav: 1.6 }],
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [limitedPlan],
      [pending],
      new Date("2026-06-12T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions.find((item) => item.id === "pending-limit-no-nav")?.status, "pending");
  });

  test("posts pending fund executions even when the plan has been paused", () => {
    const pausedPlan = plan({
      amount: 100,
      enabled: false,
      nextExecDate: "2026-06-12",
      startDate: "2026-06-08",
    });
    const pending: DCAExecution = {
      id: "pending-paused",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-12T01:00:00.000Z",
      reason: "等待正式净值确认后入账",
    };

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.6419 }],
      })],
      [pausedPlan],
      [pending],
      new Date("2026-06-12T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions.find((item) => item.id === "pending-paused")?.status, "executed");
  });

  test("does not require a fresh quote when posting pending fund executions with official NAV", () => {
    const stalePlan = plan({
      amount: 100,
      nextExecDate: "2026-06-12",
      startDate: "2026-06-08",
    });
    const pending: DCAExecution = {
      id: "pending-stale-quote",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-11T01:00:00.000Z",
      reason: "等待正式净值确认后入账",
    };

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.6419 }],
        updatedAt: "2026-06-08T00:00:00.000Z",
      })],
      [stalePlan],
      [pending],
      new Date("2026-06-12T12:00:00+08:00"),
      true,
    );

    assert.equal(settled.executions.find((item) => item.id === "pending-stale-quote")?.status, "executed");
  });

  test("waits for the fund-specific T+ confirmation window before posting pending executions", () => {
    const t3Plan = plan({
      amount: 100,
      fundBuyConfirmDays: 3,
      nextExecDate: "2026-06-12",
      startDate: "2026-06-08",
    });
    const pending: DCAExecution = {
      id: "pending-t3",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-11T01:00:00.000Z",
      reason: "等待正式净值确认后入账",
    };

    const beforeConfirm = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.6419 }],
        fundBuyConfirmDays: 3,
      })],
      [t3Plan],
      [pending],
      new Date("2026-06-10T12:00:00+08:00"),
      true,
    );

    assert.equal(beforeConfirm.executions.find((item) => item.id === "pending-t3")?.status, "pending");

    const afterConfirm = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        currentPrice: 1.6419,
        priceDate: "2026-06-08",
        fundNavHistory: [{ date: "2026-06-08", nav: 1.6419 }],
        fundBuyConfirmDays: 3,
      })],
      [t3Plan],
      [pending],
      new Date("2026-06-11T12:00:00+08:00"),
      true,
    );

    assert.equal(afterConfirm.executions.find((item) => item.id === "pending-t3")?.status, "executed");
  });

  test("preserves cumulative plan stats when old posted records have been pruned", () => {
    const inflatedPlan = plan({
      execCount: 3,
      totalInvested: 300,
      nextExecDate: "2026-06-12",
    });
    const skipped: DCAExecution = {
      id: "skipped-only",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "skipped",
      reason: "基金限购",
    };

    const settled = settleDueDCAPlans(
      [holding({ market: "FUND", assetType: "fund", currency: "CNY" })],
      [inflatedPlan],
      [skipped],
      new Date("2026-06-12T12:00:00+08:00"),
      false,
    );

    assert.equal(settled.plans[0]?.execCount, 3);
    assert.equal(settled.plans[0]?.totalInvested, 300);
  });

  test("backfills missed weekly fund executions using official historical NAV", () => {
    const weeklyPlan = plan({
      frequency: "weekly",
      dayOfWeek: 1,
      nextExecDate: "2026-06-22",
      startDate: "2026-06-01",
      fundBuyConfirmDays: 1,
    });

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "021277",
        name: "东方财富纳斯达克100指数(QDII)C",
        currency: "CNY",
        currentPrice: 1.1,
        priceDate: "2026-06-15",
        fundNavHistory: [{ date: "2026-06-15", nav: 1.1 }],
        fundBuyConfirmDays: 1,
      })],
      [weeklyPlan],
      [],
      new Date("2026-06-17T12:00:00+08:00"),
      true,
    );

    const missed = settled.executions.find((item) => item.actualDate === "2026-06-15");
    assert.equal(missed?.status, "executed");
    assert.equal(missed?.price, 1.1);
    assert.equal(settled.executions.find((item) => item.actualDate === "2026-06-01")?.status, "pending");
    assert.equal(settled.executions.find((item) => item.actualDate === "2026-06-08")?.status, "pending");
  });

  test("checks purchase limits when backfilling missed monthly fund executions", () => {
    const monthlyPlan = plan({
      frequency: "monthly",
      dayOfMonth: 15,
      amount: 100,
      nextExecDate: "2026-07-15",
      startDate: "2026-05-01",
      fundBuyConfirmDays: 2,
    });

    const settled = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019548",
        name: "招商纳斯达克100ETF发起式联接(QDII)C",
        currency: "CNY",
        currentPrice: 1.1,
        priceDate: "2026-06-16",
        fundNavHistory: [{ date: "2026-06-15", nav: 1.1 }],
        fundBuyConfirmDays: 2,
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [monthlyPlan],
      [],
      new Date("2026-06-17T12:00:00+08:00"),
      true,
    );

    const missed = settled.executions.find((item) => item.actualDate === "2026-06-15");
    assert.equal(missed?.status, "skipped");
    assert.match(missed?.reason ?? "", /计划金额 100 元，限购 10 元/);
  });

  test("keeps stale fund executions pending and allows confirmation when official NAV appears", () => {
    const fundPlan = plan({
      amount: 100,
      nextExecDate: "2026-06-20",
      startDate: "2026-05-01",
      fundBuyConfirmDays: 2,
    });
    const pending: DCAExecution = {
      id: "pending-stale-nav",
      planId: "p1",
      holdingId: "h1",
        scheduledDate: "2026-06-01",
        actualDate: "2026-06-01",
      amount: 100,
      adjusted: false,
      status: "pending",
      channelConfirmedAt: "2026-06-15T01:00:00.000Z",
    };

    const skipped = settleDueDCAPlans(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "006479",
        name: "广发纳斯达克100ETF联接人民币(QDII)C",
        currency: "CNY",
        priceDate: "2026-06-15",
        fundBuyConfirmDays: 2,
      })],
      [fundPlan],
      [pending],
      new Date("2026-06-15T12:00:00+08:00"),
      true,
    );
    const recoveredHolding = holding({
        market: "FUND",
        assetType: "fund",
        symbol: "006479",
        name: "广发纳斯达克100ETF联接人民币(QDII)C",
        currency: "CNY",
        priceDate: "2026-06-15",
        fundNavHistory: [{ date: "2026-06-01", nav: 1.25 }],
        fundBuyConfirmDays: 2,
      });
    const repaired = repairDCAData([recoveredHolding], [fundPlan], skipped.executions);
    const recovered = settleDueDCAPlans(
      repaired.holdings,
      repaired.plans,
      repaired.executions,
      new Date("2026-06-15T12:00:00+08:00"),
      true,
    );

    const skippedRecord = skipped.executions.find((item) => item.id === "pending-stale-nav");
    const recoveredRecord = recovered.executions.find((item) => item.id === "pending-stale-nav");

    assert.equal(skippedRecord?.status, "pending");
    assert.match(skippedRecord?.reason ?? "", /等待人工核对/);
    assert.equal(recoveredRecord?.status, "executed");
    assert.equal(recoveredRecord?.price, 1.25);
  });
});

describe("repairDCAData fund limits", () => {
  test("does not rewrite historical records from the current fund purchase limit", () => {
    const limitedPlan = plan({
      amount: 100,
      symbol: "019305",
      name: "摩根标普500指数(QDII)人民币C",
      startDate: "2026-06-01",
      nextExecDate: "2026-06-12",
      totalInvested: 100,
      execCount: 1,
    });
    const executed: DCAExecution = {
      id: "executed-limit",
      planId: "p1",
      holdingId: "h1",
      scheduledDate: "2026-06-08",
      actualDate: "2026-06-08",
      amount: 100,
      adjusted: false,
      status: "executed",
      quantity: 50,
      price: 2,
      navDate: "2026-06-08",
      confirmedDate: "2026-06-10",
    };

    const repaired = repairDCAData(
      [holding({
        market: "FUND",
        assetType: "fund",
        symbol: "019305",
        name: "摩根标普500指数(QDII)人民币C",
        currency: "CNY",
        quantity: 50,
        costPrice: 2,
        currentPrice: 2,
        priceDate: "2026-06-08",
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [limitedPlan],
      [executed],
    );

    assert.equal(repaired.changed, false);
    assert.equal(repaired.executions[0]?.status, "executed");
    assert.equal(repaired.holdings[0]?.quantity, 50);
    assert.equal(repaired.plans[0]?.execCount, 1);
    assert.equal(repaired.plans[0]?.totalInvested, 100);
  });

  test("scales reversal cost when repaired executions exceed the current holding quantity", () => {
    const repaired = repairDCAData(
      [holding({
        market: "US",
        assetType: "stock",
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 4,
        costPrice: 100,
        currentPrice: 120,
        currency: "USD",
      })],
      [plan({
        market: "US",
        assetType: "stock",
        symbol: "AAPL",
        name: "Apple Inc.",
        nextExecDate: "2026-06-08",
        totalInvested: 1000,
        execCount: 1,
      })],
      [{
        id: "bad-exec",
        planId: "p1",
        holdingId: "h1",
        scheduledDate: "2026-06-07",
        actualDate: "2026-06-07",
        amount: 1000,
        adjusted: false,
        status: "executed",
        quantity: 10,
        price: 100,
      }],
    );

    assert.equal(repaired.changed, true);
    assert.equal(repaired.executions[0]?.status, "skipped");
    assert.equal(repaired.holdings[0]?.quantity, 0);
    assert.equal(repaired.holdings[0]?.costPrice, 100);
    assert.equal(repaired.plans[0]?.execCount, 0);
    assert.equal(repaired.plans[0]?.totalInvested, 0);
  });
});
