import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchTencentIntraday,
  fetchTencentKline,
  fetchTencentQuote,
  fetchTencentQuoteFromYahooSymbol,
  fetchTencentTradeStatus,
} from "./tencentQuote";
import { withMockFetch } from "../testUtils";

function quoteText(parts: Record<number, string>) {
  const fields = Array.from({ length: 40 }, (_, index) => parts[index] ?? "");
  return `v_sh600900="${fields.join("~")}";`;
}

describe("Tencent quote service", () => {
  test("parses A-share quote rows", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      assert.ok(String(input).includes("q=sh600900"));
      return {
        ok: true,
        text: async () => quoteText({
          1: "长江电力",
          3: "30.50",
          4: "30.00",
          5: "30.10",
          6: "12345",
          31: "0.50",
          32: "1.67",
          33: "31.00",
          34: "29.80",
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchTencentQuote("600900", "A");

      assert.equal(quote?.name, "长江电力");
      assert.equal(quote?.price, 30.5);
      assert.equal(quote?.changePercent, 0.0167);
      assert.equal(quote?.currency, "CNY");
    });
  });

  test("detects suspended trade status", async () => {
    await withMockFetch((async () => ({
      ok: true,
      text: async () => quoteText({ 1: "停牌股", 3: "0", 4: "10", 5: "0" }),
    }) as Response) as typeof fetch, async () => {
      const status = await fetchTencentTradeStatus("600000", "A");

      assert.equal(status?.status, "suspended");
      assert.equal(status?.source, "tencent");
    });
  });

  test("maps Yahoo symbols into Tencent quote requests", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      requested.push(String(input));
      return {
        ok: true,
        text: async () => quoteText({ 1: "腾讯控股", 3: "350", 4: "345", 5: "346", 31: "5", 32: "1.45" }),
      } as Response;
    }) as typeof fetch, async () => {
      assert.equal((await fetchTencentQuoteFromYahooSymbol("0700.HK"))?.currency, "HKD");
      assert.ok(requested.some((url) => url.includes("q=hk00700")));
      assert.equal(await fetchTencentQuoteFromYahooSymbol("AAPL"), null);
    });
  });

  test("maps Shenzhen A-share quote requests", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      assert.ok(String(input).includes("q=sz000001"));
      return {
        ok: true,
        text: async () => quoteText({ 1: "平安银行", 3: "10", 4: "9.8", 5: "9.9", 31: "0.2", 32: "2.04" }),
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchTencentQuote("000001", "A");

      assert.equal(quote?.symbol, "000001");
      assert.equal(quote?.name, "平安银行");
    });
  });

  test("parses kline and intraday rows", async () => {
    const signalRequests: string[] = [];
    await withMockFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("web.ifzq.gtimg.cn") && init?.signal instanceof AbortSignal) {
        signalRequests.push(url);
      }
      if (url.includes("/fqkline/get")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              sh600900: {
                day: [
                  ["2026-01-02", "10", "11", "12", "9", "1000"],
                  ["2026-01-03", "11", "13", "14", "10", "1500"],
                ],
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            sh600900: {
              data: { data: ["0930 10 100", "0931 10.5 250"] },
            },
          },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const kline = await fetchTencentKline("600900", "A", "1d");
      const intraday = await fetchTencentIntraday("600900", "A");

      assert.deepEqual(kline?.map((point) => point.close), [11, 13]);
      assert.deepEqual(intraday?.map((point) => point.volume), [100, 150]);
      assert.equal(signalRequests.length, 2);
    });
  });

  test("aggregates kline rows into quarterly and yearly candles", async () => {
    await withMockFetch((async () => ({
      ok: true,
      text: async () => JSON.stringify({
        data: {
          sh600900: {
            month: [
              ["2026-01-02", "10", "11", "12", "9", "100"],
              ["2026-02-03", "11", "13", "14", "10", "150"],
              ["2026-04-02", "13", "15", "16", "12", "200"],
            ],
          },
        },
      }),
    }) as Response) as typeof fetch, async () => {
      const quarterly = await fetchTencentKline("600900", "A", "3mo");
      const yearly = await fetchTencentKline("600900", "A", "1y");

      assert.deepEqual(quarterly?.map((point) => point.time), ["26/Q1", "26/Q2"]);
      assert.equal(quarterly?.[0]?.open, 10);
      assert.equal(quarterly?.[0]?.high, 14);
      assert.equal(quarterly?.[0]?.low, 9);
      assert.equal(quarterly?.[0]?.close, 13);
      assert.equal(quarterly?.[0]?.volume, 250);
      assert.deepEqual(yearly?.map((point) => point.time), ["2026"]);
      assert.equal(yearly?.[0]?.close, 15);
      assert.equal(yearly?.[0]?.volume, 450);
    });
  });
});
