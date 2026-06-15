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

  test("uses the fund-specific buy confirmation days when available", () => {
    const custom = plan({ fundBuyConfirmDays: 3 });

    assert.equal(fundSettlementDays(custom), 3);
    assert.equal(computeFundConfirmationDate(custom, "2026-05-22"), "2026-05-28");
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

  test("rechecks purchase limits before posting pending fund executions", () => {
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

    assert.equal(settled.executions.find((item) => item.id === "pending-limit")?.status, "skipped");
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

  test("backfills missed weekly fund executions and posts them when official NAV is available", () => {
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
      new Date("2026-06-16T12:00:00+08:00"),
      true,
    );

    const missed = settled.executions.find((item) => item.actualDate === "2026-06-15");
    assert.equal(missed?.status, "executed");
    assert.equal(missed?.confirmedDate, "2026-06-16");
  });

  test("backfills missed monthly fund executions without using current limits as historical truth", () => {
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
        fundNavHistory: [],
        fundBuyConfirmDays: 2,
        autoTradeStatus: "fund_limit",
        autoTradeStatusNote: "基金限购，10元",
        autoTradeStatusSource: "eastmoney",
      })],
      [monthlyPlan],
      [],
      new Date("2026-06-16T12:00:00+08:00"),
      true,
    );

    const missed = settled.executions.find((item) => item.actualDate === "2026-06-15");
    assert.equal(missed?.status, "pending");
    assert.match(missed?.reason ?? "", /补录待确认定投/);
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
});
