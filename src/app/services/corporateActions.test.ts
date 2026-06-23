import test from "node:test";
import assert from "node:assert/strict";

import { parseEastMoneyStockCorporateActionRows } from "./corporateActions";

test("shows shareholder-approved A-share dividend resolutions without treating them as implemented", () => {
  const actions = parseEastMoneyStockCorporateActionRows("600900", [{
    PRETAX_BONUS_RMB: 7.9,
    PLAN_NOTICE_DATE: "2026-04-30 00:00:00",
    EQUITY_RECORD_DATE: null,
    EX_DIVIDEND_DATE: null,
    ASSIGN_PROGRESS: "股东大会决议通过",
    IMPL_PLAN_PROFILE: "10派7.90元(含税)",
    NOTICE_DATE: "2026-04-30 00:00:00",
  }]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "dividend_resolution");
  assert.equal(actions[0]?.date, "2026-04-30");
  assert.equal(actions[0]?.amount, 0.79);
  assert.equal(actions[0]?.exDate, undefined);
});

test("ignores board proposals before shareholder approval", () => {
  const actions = parseEastMoneyStockCorporateActionRows("600900", [{
    PRETAX_BONUS_RMB: 7.9,
    PLAN_NOTICE_DATE: "2026-03-30 00:00:00",
    EQUITY_RECORD_DATE: null,
    EX_DIVIDEND_DATE: null,
    ASSIGN_PROGRESS: "董事会预案",
    IMPL_PLAN_PROFILE: "10派7.90元(含税)",
    NOTICE_DATE: "2026-03-30 00:00:00",
  }]);

  assert.deepEqual(actions, []);
});

test("shows shareholder-approved bonus share or transfer resolutions", () => {
  const actions = parseEastMoneyStockCorporateActionRows("000001", [{
    PRETAX_BONUS_RMB: null,
    BONUS_RATIO: 2,
    IT_RATIO: 3,
    EQUITY_RECORD_DATE: null,
    EX_DIVIDEND_DATE: null,
    ASSIGN_PROGRESS: "股东大会决议通过",
    IMPL_PLAN_PROFILE: "10送2股转增3股",
    NOTICE_DATE: "2026-05-20 00:00:00",
  }]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "split_resolution");
  assert.equal(actions[0]?.ratio, 1.5);
});

test("keeps implemented A-share dividends on their ex-dividend date", () => {
  const actions = parseEastMoneyStockCorporateActionRows("600900", [{
    PRETAX_BONUS_RMB: 2.1,
    EQUITY_RECORD_DATE: "2026-02-11 00:00:00",
    EX_DIVIDEND_DATE: "2026-02-12 00:00:00",
    ASSIGN_PROGRESS: "实施分配",
    IMPL_PLAN_PROFILE: "10派2.10元(含税,扣税后1.89元)",
    NOTICE_DATE: "2026-02-05 00:00:00",
  }]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.date, "2026-02-12");
  assert.equal(actions[0]?.exDate, "2026-02-12");
  assert.equal(actions[0]?.recordDate, "2026-02-11");
  assert.equal(actions[0]?.amount, 0.21);
});
