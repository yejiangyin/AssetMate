import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchEastMoneyChart,
  fetchEastMoneyQuoteBySymbol,
  fetchEastMoneyQuotes,
  fetchEastMoneyTradeStatuses,
  searchEastMoneySecurities,
  isEastMoneyFxPer100,
  toEastMoneySecid,
} from "./eastMoneyApi";
import { withMockFetch } from "../testUtils";

describe("isEastMoneyFxPer100", () => {
  test("flags JPY/CNY pairs which EastMoney quotes per 100 JPY", () => {
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "FX"), true);
    assert.equal(isEastMoneyFxPer100("jpycny=x", "FX"), true);
  });

  test("does not flag other FX pairs quoted per 1 unit", () => {
    assert.equal(isEastMoneyFxPer100("USDCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("EURCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("HKDCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("GBPCNY=X", "FX"), false);
  });

  test("does not flag non-FX markets even if the symbol collides", () => {
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "A"), false);
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "INDEX"), false);
  });
});

describe("toEastMoneySecid", () => {
  test("maps A-share, HK, index, FX, and commodity symbols", () => {
    assert.equal(toEastMoneySecid("600900", "A"), "1.600900");
    assert.equal(toEastMoneySecid("000002.SZ", "A"), "0.000002");
    assert.equal(toEastMoneySecid("00700", "HK"), "116.00700");
    assert.equal(toEastMoneySecid("000001", "A"), "1.000001");
    assert.equal(toEastMoneySecid("HSTECH", "HK"), "124.HSTECH");
    assert.equal(toEastMoneySecid("^N225", "INDEX"), "100.N225");
    assert.equal(toEastMoneySecid("JPYCNY=X", "FX"), "120.JPYCNYC");
    assert.equal(toEastMoneySecid("GC=F", "COMMODITY"), "101.GC00Y");
    assert.equal(toEastMoneySecid("AAPL", "US"), null);
  });
});

describe("fetchEastMoneyChart", () => {
  test("parses kline rows when quote data is unavailable", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/qt/stock/kline/get")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              klines: [
                "2026-01-02,10,11,12,9,1000,0,0",
                "2026-01-03,11,13,14,10,1500,0,0",
              ],
            },
          }),
        } as Response;
      }
      if (url.includes("/api/qt/ulist.np/get")) {
        return { ok: true, json: async () => ({ data: { diff: [] } }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      const chart = await fetchEastMoneyChart("600900", "A", "1d");

      assert.equal(chart.quote.symbol, "600900");
      assert.equal(chart.quote.price, 13);
      assert.equal(chart.points.length, 2);
      assert.deepEqual(chart.points.map((point) => point.close), [11, 13]);
      assert.deepEqual(chart.points.map((point) => point.volume), [1000, 1500]);
    });
  });

  test("parses intraday trend rows and normalizes JPY/CNY per-100 quotes", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/qt/stock/trends2/get")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              trends: [
                "2026-01-02 09:30,700,710,720,690,100",
                "2026-01-02 09:31,710,720,730,700,250",
              ],
            },
          }),
        } as Response;
      }
      if (url.includes("/api/qt/ulist.np/get")) {
        return { ok: true, json: async () => ({ data: { diff: [] } }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      const chart = await fetchEastMoneyChart("JPYCNY=X", "FX", "fs");

      assert.equal(chart.quote.price, 7.2);
      assert.deepEqual(chart.points.map((point) => Number(point.price.toFixed(1))), [7.1, 7.2]);
      assert.deepEqual(chart.points.map((point) => point.volume), [100, 150]);
    });
  });
});

describe("EastMoney quote and search endpoints", () => {
  test("parses security search results and filters unsupported derivatives", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      assert.ok(String(input).includes("/api/Info/Search"));
      return {
        ok: true,
        json: async () => ({
          Data: [
            { Code: "600900", Name: "长江电力", MktNum: 1, SecurityTypeName: "股票" },
            { Code: "00700", Name: "腾讯控股", MktNum: 116, SecurityTypeName: "股票" },
            { Code: "12345", Name: "某认购证", MktNum: 116, SecurityTypeName: "权证" },
          ],
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const results = await searchEastMoneySecurities("电力");

      assert.deepEqual(results.map((item) => `${item.market}:${item.symbol}`), ["A:600900", "HK:00700"]);
      assert.equal(results[0]?.currency, "CNY");
      assert.equal(results[1]?.currency, "HKD");
    });
  });

  test("parses batch quotes and single-symbol JPY/CNY scaling", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      const isJpy = url.includes("120.JPYCNYC");
      return {
        ok: true,
        json: async () => ({
          data: {
            diff: isJpy
              ? [{ f2: 720, f3: 0.7, f4: 5, f5: 200, f6: 144000, f12: "JPYCNYC", f13: 120, f14: "100日元人民币", f15: 730, f16: 710, f17: 715, f18: 715 }]
              : [{ f2: 30.5, f3: 1.67, f4: 0.5, f5: 1000, f6: 30500, f12: "600900", f13: 1, f14: "长江电力", f15: 31, f16: 30, f17: 30.1, f18: 30 }],
          },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const quotes = await fetchEastMoneyQuotes(["1.600900"], { "1.600900": "A" });
      const jpy = await fetchEastMoneyQuoteBySymbol("JPYCNY=X", "FX");

      assert.equal(quotes[0]?.symbol, "600900");
      assert.equal(quotes[0]?.changePercent, 0.0167);
      assert.equal(jpy?.price, 7.2);
      assert.equal(jpy?.prevClose, 7.15);
    });
  });

  test("filters invalid quote rows from batch responses", async () => {
    await withMockFetch((async () => ({
      ok: true,
      json: async () => ({
        data: {
          diff: [
            { f2: 30.5, f3: 1.67, f4: 0.5, f5: 1000, f6: 30500, f12: "600900", f13: 1, f14: "长江电力", f15: 31, f16: 30, f17: 30.1, f18: 30 },
            { f2: 0, f12: "600901", f13: 1, f14: "零价格", f18: 10 },
            { f2: 10, f12: "", f13: 1, f14: "空代码", f18: 9 },
            { f2: 10, f12: "600902", f13: 1, f14: "", f18: 9 },
            { f2: 10, f12: "ABC", f13: 999, f14: "未知市场", f18: 9 },
          ],
        },
      }),
    }) as Response) as typeof fetch, async () => {
      const quotes = await fetchEastMoneyQuotes(["1.600900", "1.600901", "1.600902", "999.ABC"]);

      assert.deepEqual(quotes.map((quote) => quote.symbol), ["600900"]);
    });
  });

  test("splits large batch quote requests", async () => {
    const batchSizes: number[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const secids = url.searchParams.get("secids")?.split(",").filter(Boolean) ?? [];
      batchSizes.push(secids.length);
      return {
        ok: true,
        json: async () => ({
          data: {
            diff: secids.map((secid) => {
              const [, code = ""] = secid.split(".");
              return { f2: 10, f3: 0, f4: 0, f5: 100, f6: 1000, f12: code, f13: 1, f14: `股票${code}`, f15: 11, f16: 9, f17: 10, f18: 10 };
            }),
          },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const secids = Array.from({ length: 51 }, (_, index) => `1.${String(600000 + index)}`);
      const quotes = await fetchEastMoneyQuotes(secids, Object.fromEntries(secids.map((secid) => [secid, "A"])));

      assert.deepEqual(batchSizes, [50, 1]);
      assert.equal(quotes.length, 51);
    });
  });

  test("splits large batch trade status requests", async () => {
    const batchSizes: number[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const secids = url.searchParams.get("secids")?.split(",").filter(Boolean) ?? [];
      batchSizes.push(secids.length);
      return {
        ok: true,
        json: async () => ({
          data: {
            diff: secids.map((secid) => {
              const [, code = ""] = secid.split(".");
              return { f2: 10, f12: code, f13: 1, f14: `股票${code}`, f15: 11, f16: 9, f17: 10, f18: 10 };
            }),
          },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const secids = Array.from({ length: 51 }, (_, index) => `1.${String(600000 + index)}`);
      const statuses = await fetchEastMoneyTradeStatuses(secids, Object.fromEntries(secids.map((secid) => [secid, "A"])));

      assert.deepEqual(batchSizes, [50, 1]);
      assert.equal(statuses.length, 51);
    });
  });

  test("parses suspended and normal trade statuses", async () => {
    await withMockFetch((async () => ({
      ok: true,
      json: async () => ({
        data: {
          diff: [
            { f2: 30.5, f12: "600900", f13: 1, f14: "长江电力", f15: 31, f16: 30, f17: 30.1, f18: 30 },
            { f2: 0, f12: "000001", f13: 0, f14: "停牌股", f15: 0, f16: 0, f17: 0, f18: 10 },
          ],
        },
      }),
    }) as Response) as typeof fetch, async () => {
      const statuses = await fetchEastMoneyTradeStatuses(["1.600900", "0.000001"], {
        "1.600900": "A",
        "0.000001": "A",
      });

      assert.deepEqual(statuses.map((item) => item.status), ["normal", "suspended"]);
    });
  });

  test("throws for unsupported chart symbols", async () => {
    await assert.rejects(() => fetchEastMoneyChart("AAPL", "US", "1d"), /unsupported/);
  });
});
