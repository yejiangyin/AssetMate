import test from "node:test";
import assert from "node:assert/strict";

import { fetchCorporateActions, parseEastMoneyStockCorporateActionRows } from "./corporateActions";
import { createHolding, withMockFetch } from "../testUtils";

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

test("falls back from Yahoo query2 to query1 for corporate actions", async () => {
  const requested: string[] = [];
  await withMockFetch((async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("query2.finance.yahoo.com")) {
      return { ok: false, status: 503 } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            events: {
              dividends: {
                d1: { date: Date.parse("2026-01-02T00:00:00Z") / 1000, amount: 0.5 },
              },
            },
          }],
        },
      }),
    } as Response;
  }) as typeof fetch, async () => {
    const actions = await fetchCorporateActions(createHolding({ symbol: "AAPL", market: "US", assetType: "stock" }), 45);

    assert.deepEqual(requested.map((url) => new URL(url).host), ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]);
    assert.equal(actions[0]?.type, "cash_dividend");
    assert.equal(actions[0]?.amount, 0.5);
  });
});

test("attaches the official ex-date NAV used for fund dividend reinvestment", async () => {
  await withMockFetch((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("fundf10.eastmoney.com/fhsp_123456.html")) {
      return {
        ok: true,
        text: async () => `
          <table class="cfxq"><tbody>
            <tr><td>1</td><td>2026-06-04</td><td>2026-06-05</td><td>每份派现金0.40元</td><td>2026-06-08</td></tr>
          </tbody></table>
        `,
      } as Response;
    }
    if (url.includes("api.fund.eastmoney.com/f10/lsjz")) {
      return {
        ok: true,
        json: async () => ({ Data: { LSJZList: [{ FSRQ: "2026-06-05", DWJZ: "2.0000", JZZZL: "0" }] } }),
      } as Response;
    }
    return { ok: true, text: async () => "" } as Response;
  }) as typeof fetch, async () => {
    const actions = await fetchCorporateActions(createHolding({
      symbol: "123456",
      market: "FUND",
      assetType: "fund",
    }));
    assert.equal(actions[0]?.type, "cash_dividend");
    assert.equal(actions[0]?.reinvestPrice, 2);
  });
});
