import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eastMoneyFundLive, resolveFundEstimateUpdate } from "./priceRefresher";
import { withMockFetch } from "../testUtils";

function fundMockFetch(estimate: { jzrq: string; dwjz: string; gsz: string; gszzl: string }, history: Array<{ FSRQ: string; DWJZ: string; JZZZL: string }>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("fundgz.1234567.com.cn")) {
      return {
        ok: true,
        text: async () => `jsonpgz({"name":"测试基金","jzrq":"${estimate.jzrq}","dwjz":"${estimate.dwjz}","gsz":"${estimate.gsz}","gszzl":"${estimate.gszzl}"})`,
      } as Response;
    }
    if (url.includes("/FundValuationLast")) {
      return {
        ok: true,
        json: async () => ({
          data: [{
            FCODE: "006479", SHORTNAME: "测试基金", PDATE: estimate.jzrq,
            NAV: Number(estimate.dwjz), GSZ: Number(estimate.gsz) || null,
            GSZZL: Number(estimate.gszzl), GZTIME: Number(estimate.gsz) > 0 ? "2026-07-31 10:00" : null,
          }],
        }),
      } as Response;
    }
    if (url.includes("/f10/lsjz")) {
      return {
        ok: true,
        json: async () => ({ Data: { LSJZList: history } }),
      } as Response;
    }
    // pingzhongdata fallback and any other URL: return OK with empty body so
    // fetchCnFundOfficialHistory keeps the officialRows it already parsed.
    return { ok: true, text: async () => "" } as Response;
  }) as typeof fetch;
}

describe("eastMoneyFundLive intraday estimate (Plan A)", () => {
  test("uses intraday estimate (gsz) as price when official NAV date is before today", async () => {
    // Friday morning: official NAV is Thursday (2026-07-30), gsz is the Friday estimate.
    await withMockFetch(fundMockFetch(
      { jzrq: "2026-07-30", dwjz: "1.1000", gsz: "1.2500", gszzl: "2.0" },
      [{ FSRQ: "2026-07-30", DWJZ: "1.1000", JZZZL: "0.5" }],
    ), async () => {
      const quote = await eastMoneyFundLive("006479", new Date("2026-07-31T10:00:00+08:00"));

      assert.equal(quote?.price, 1.25);
      assert.equal(quote?.priceDate, "2026-07-31");
      assert.equal(quote?.prevClose, 1.1);
      assert.equal(quote?.estimatedNav, 1.25);
      assert.equal(quote?.estimatedNavAt, "2026-07-31 10:00");
      assert.equal(quote?.fundEstimateStatus, "available");
      assert.equal(quote?.changePercent, 0.02);
    });
  });

  test("falls back to history NAV when official date equals today (no intraday override)", async () => {
    // Thursday morning: official NAV is already Thursday (published overnight), gsz is intraday.
    await withMockFetch(fundMockFetch(
      { jzrq: "2026-07-30", dwjz: "1.1000", gsz: "1.2500", gszzl: "2.0" },
      [{ FSRQ: "2026-07-30", DWJZ: "1.1000", JZZZL: "0.5" }],
    ), async () => {
      const quote = await eastMoneyFundLive("006479", new Date("2026-07-30T10:00:00+08:00"));

      assert.equal(quote?.price, 1.1);
      assert.equal(quote?.priceDate, "2026-07-30");
    });
  });

  test("falls back to history NAV when no intraday estimate is available", async () => {
    // Friday morning but gsz is 0 (pre-open or post-publication).
    await withMockFetch(fundMockFetch(
      { jzrq: "2026-07-30", dwjz: "1.1000", gsz: "0", gszzl: "0" },
      [{ FSRQ: "2026-07-30", DWJZ: "1.1000", JZZZL: "0.5" }],
    ), async () => {
      const quote = await eastMoneyFundLive("006479", new Date("2026-07-31T10:00:00+08:00"));

      assert.equal(quote?.price, 1.1);
      assert.equal(quote?.priceDate, "2026-07-30");
      assert.equal(quote?.estimatedNav, undefined);
      assert.equal(quote?.fundEstimateStatus, "unavailable");
    });
  });

  test("does not turn a stale fund estimate into a weekend price update", async () => {
    await withMockFetch(fundMockFetch(
      { jzrq: "2026-07-31", dwjz: "1.1000", gsz: "1.2500", gszzl: "2.0" },
      [{ FSRQ: "2026-07-31", DWJZ: "1.1000", JZZZL: "0.5" }],
    ), async () => {
      const quote = await eastMoneyFundLive("006479", new Date("2026-08-01T10:00:00+08:00"));

      assert.equal(quote?.price, 1.1);
      assert.equal(quote?.priceDate, "2026-07-31");
      assert.equal(quote?.estimatedNav, 1.25);
    });
  });

  test("keeps an already fetched estimate only for same-day transient failures", () => {
    const previous = { estimatedNav: 1.25, estimatedChangePercent: 0.02, estimatedNavAt: "2026-07-31 10:00" };
    const failed = { fundEstimateStatus: "failed" as const };
    assert.deepEqual(resolveFundEstimateUpdate(previous, failed, "2026-07-31"), previous);
    assert.deepEqual(resolveFundEstimateUpdate(previous, failed, "2026-08-01"), {
      estimatedNav: undefined, estimatedChangePercent: undefined, estimatedNavAt: undefined,
    });
  });

  test("clears cached estimate when the provider explicitly reports none", () => {
    assert.deepEqual(resolveFundEstimateUpdate(
      { estimatedNav: 1.25, estimatedChangePercent: 0.02, estimatedNavAt: "2026-07-31 10:00" },
      { fundEstimateStatus: "unavailable" },
      "2026-07-31",
    ), { estimatedNav: undefined, estimatedChangePercent: undefined, estimatedNavAt: undefined });
  });
});
