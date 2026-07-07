import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DCAExecution, DCAPlan } from "../context/AppContext";
import type { Holding } from "../data/mockData";
import {
  computeFundConfirmationDate,
  computeNextExec,
  dedupeDCAExecutions,
  fundSettlementDays,
  hydratePlans,
  originalScheduledDate,
  parseChineseMoneyLimit,
  repairDCAData,
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
    assert.equal(parseChineseMoneyLimit("限购 0元"), null);
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
      new Date("2026-06-17T12:00:00+08:00"),
      true,
    );

    const missed = settled.executions.find((item) => item.actualDate === "2026-06-15");
    assert.equal(missed?.status, "executed");
    assert.equal(missed?.confirmedDate, "2026-06-16");
    assert.equal(settled.executions.some((item) => item.actualDate === "2026-06-01"), false);
    assert.equal(settled.executions.some((item) => item.actualDate === "2026-06-08"), false);
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
    assert.equal(missed?.status, "executed");
    assert.equal(missed?.price, 1.1);
    assert.equal(missed?.confirmedDate, "2026-06-17");
  });

  test("skips stale pending fund executions and recovers them when official NAV appears", () => {
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

    assert.equal(skippedRecord?.status, "skipped");
    assert.match(skippedRecord?.reason ?? "", /正式净值/);
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
