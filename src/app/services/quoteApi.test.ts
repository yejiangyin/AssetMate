import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchBacktestDailyPrices,
  fetchChart,
  fetchDetailChart,
  fetchRecentDailyChart,
  formatYahooTimestamp,
  toYahooSymbol,
} from "./quoteApi";
import { withMockFetch } from "../testUtils";

function yahooChartResponse() {
  return {
    chart: {
      result: [{
        meta: {
          symbol: "AAPL",
          shortName: "Apple",
          currency: "USD",
          regularMarketPrice: 12,
          previousClose: 10,
          regularMarketOpen: 10,
          regularMarketDayHigh: 13,
          regularMarketDayLow: 9,
          regularMarketVolume: 1000,
        },
        timestamp: [1767225600, 1767312000],
        indicators: {
          quote: [{
            open: [10, 11],
            high: [12, 13],
            low: [9, 10],
            close: [11, 12],
            volume: [100, 200],
          }],
        },
        events: {
          dividends: {
            d1: { date: 1767312000, amount: 0.5 },
          },
          splits: {
            s1: { date: 1767312000, splitRatio: "2:1" },
          },
        },
      }],
    },
  };
}

function okJson(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

describe("formatYahooTimestamp", () => {
  test("renders Japan quotes in Beijing time (UTC+8)", () => {
    // Tokyo 15:30 (UTC+9) = Beijing 14:30 (UTC+8)
    const timestampSeconds = new Date("2026-06-22T15:30:00+09:00").getTime() / 1000;
    assert.equal(formatYahooTimestamp(timestampSeconds, "fs", "7203.T"), "14:30");
    assert.equal(formatYahooTimestamp(timestampSeconds, "fs", "^N225"), "14:30");
  });

  test("formats non-intraday ranges using their range-specific labels", () => {
    const ts = Date.parse("2026-04-15T00:00:00Z") / 1000;
    assert.equal(formatYahooTimestamp(ts, "1d"), "26/4/15");
    assert.equal(formatYahooTimestamp(ts, "5d"), "26/4/15");
    assert.equal(formatYahooTimestamp(ts, "1mo"), "26/4");
    assert.equal(formatYahooTimestamp(ts, "3mo"), "26/Q2");
    assert.equal(formatYahooTimestamp(ts, "1y"), "2026");
    assert.equal(formatYahooTimestamp(ts, "max"), "26/4");
  });
});

describe("toYahooSymbol", () => {
  test("maps supported markets to Yahoo ticker conventions", () => {
    assert.equal(toYahooSymbol("AAPL", "US"), "AAPL");
    assert.equal(toYahooSymbol("00700", "HK"), "0700.HK");
    assert.equal(toYahooSymbol("7203", "JP"), "7203.T");
    assert.equal(toYahooSymbol("600900", "A"), "600900.SS");
    assert.equal(toYahooSymbol("000001", "A"), "000001.SZ");
    assert.equal(toYahooSymbol("510300", "FUND"), "510300.SS");
    assert.equal(toYahooSymbol("113052", "BOND"), "113052.SS");
    assert.equal(toYahooSymbol("BTC", "CRYPTO"), "BTC-USD");
    assert.equal(toYahooSymbol("BTC-USDT", "CRYPTO"), "BTC-USDT");
    assert.equal(toYahooSymbol("XAUUSD", "GOLD"), "GC=F");
  });
});

describe("Yahoo chart fetchers", () => {
  test("fetchBacktestDailyPrices parses close prices and dividends", async () => {
    const requested: string[] = [];
    const referers: Array<string | null> = [];
    await withMockFetch((async (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input));
      referers.push(new Headers(init?.headers).get("Referer"));
      return okJson(yahooChartResponse());
    }) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("AAPL", "US", "2026-01-01", "2026-01-02");

      assert.deepEqual(prices, [
        { date: "2026-01-01", price: 11, dividend: 0, splitRatio: 1 },
        { date: "2026-01-02", price: 12, dividend: 0.5, splitRatio: 2 },
      ]);
      assert.ok(requested[0]?.includes("events=div%2Csplits"));
      assert.ok(requested[0]?.includes("interval=1d"));
      assert.equal(referers[0], "https://finance.yahoo.com/");
    });
  });

  test("fetchBacktestDailyPrices prefers Yahoo adjusted close when available", async () => {
    await withMockFetch((async () => okJson({
      chart: {
        result: [{
          timestamp: [1767225600, 1767312000],
          indicators: {
            quote: [{ close: [110, 120] }],
            adjclose: [{ adjclose: [100, 112] }],
          },
          events: {
            dividends: { d1: { date: 1767312000, amount: 1 } },
            splits: { s1: { date: 1767312000, splitRatio: "2:1" } },
          },
        }],
      },
    })) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("AAPL", "US", "2026-01-01", "2026-01-02");

      assert.deepEqual(prices, [
        { date: "2026-01-01", price: 100, dividend: 0, splitRatio: 1, adjusted: true },
        { date: "2026-01-02", price: 112, dividend: 0, splitRatio: 1, adjusted: true },
      ]);
    });
  });

  test("fetchBacktestDailyPrices can keep raw closes and explicit corporate actions", async () => {
    await withMockFetch((async () => okJson({
      chart: {
        result: [{
          timestamp: [1767225600, 1767312000],
          indicators: {
            quote: [{ close: [110, 60] }],
            adjclose: [{ adjclose: [100, 112] }],
          },
          events: {
            dividends: { d1: { date: 1767312000, amount: 1 } },
            splits: { s1: { date: 1767312000, splitRatio: "2:1" } },
          },
        }],
      },
    })) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("AAPL", "US", "2026-01-01", "2026-01-02", { preferAdjusted: false });

      assert.deepEqual(prices, [
        { date: "2026-01-01", price: 110, dividend: 0, splitRatio: 1 },
        { date: "2026-01-02", price: 60, dividend: 1, splitRatio: 2 },
      ]);
    });
  });

  test("fetchBacktestDailyPrices uses cumulative NAV for fund backtests", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) {
        return okJson({ Data: null });
      }
      return {
        ok: true,
        text: async () => [
          "var Data_netWorthTrend = [",
          "{\"x\":1767312000000,\"y\":1.04,\"equityReturn\":0.1},",
          "{\"x\":1767398400000,\"y\":1.05,\"equityReturn\":0.1}",
          "];",
          "var Data_ACWorthTrend = [[1767312000000,1.43],[1767398400000,1.44]];",
        ].join(""),
      } as Response;
    }) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("003547", "FUND", "2026-01-02", "2026-01-03");

      assert.deepEqual(prices, [
        { date: "2026-01-02", price: 1.43, adjusted: true },
        { date: "2026-01-03", price: 1.44, adjusted: true },
      ]);
    });
  });

  test("historical portfolio valuation can request raw fund NAV", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) return okJson({ Data: null });
      return {
        ok: true,
        text: async () => [
          "var Data_netWorthTrend = [{\"x\":1767312000000,\"y\":1.04,\"equityReturn\":0.1}];",
          "var Data_ACWorthTrend = [[1767312000000,1.43]];",
        ].join(""),
      } as Response;
    }) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("003547", "FUND", "2026-01-02", "2026-01-02", { preferAdjusted: false });
      assert.deepEqual(prices, [{ date: "2026-01-02", price: 1.04, adjusted: false }]);
    });
  });

  test("fetchBacktestDailyPrices falls back to fund unit NAV when cumulative NAV is absent", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) {
        return okJson({ Data: null });
      }
      return {
        ok: true,
        text: async () => "var Data_netWorthTrend = [{\"x\":1767398400000,\"y\":1.05,\"equityReturn\":0.1}];",
      } as Response;
    }) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("003547", "FUND", "2026-01-03", "2026-01-03");

      assert.deepEqual(prices, [{ date: "2026-01-03", price: 1.05, adjusted: false }]);
    });
  });

  test("fund backtests never mix cumulative and unit NAV in one series", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) return okJson({ Data: null });
      return {
        ok: true,
        text: async () => [
          "var Data_netWorthTrend = [{\"x\":1767312000000,\"y\":1.04},{\"x\":1767398400000,\"y\":1.05}];",
          "var Data_ACWorthTrend = [[1767312000000,1.43]];",
        ].join(""),
      } as Response;
    }) as typeof fetch, async () => {
      const prices = await fetchBacktestDailyPrices("003547", "FUND", "2026-01-02", "2026-01-03");
      assert.deepEqual(prices, [
        { date: "2026-01-02", price: 1.04, adjusted: false },
        { date: "2026-01-03", price: 1.05, adjusted: false },
      ]);
    });
  });

  test("fetchChart parses quote and daily candle points", async () => {
    await withMockFetch((async () => okJson(yahooChartResponse())) as typeof fetch, async () => {
      const chart = await fetchChart("AAPL", "1d", true);

      assert.equal(chart.quote.symbol, "AAPL");
      assert.equal(chart.quote.price, 12);
      assert.equal(chart.quote.prevClose, 10);
      assert.equal(chart.points.length, 2);
      assert.deepEqual(chart.points.map((point) => point.close), [11, 12]);
    });
  });

  test("fetchRecentDailyChart uses public crypto klines when available", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.binance.com/api/v3/ticker/24hr")) {
        return okJson({
          lastPrice: "100",
          prevClosePrice: "95",
          openPrice: "95",
          highPrice: "105",
          lowPrice: "90",
          priceChange: "5",
          priceChangePercent: "5.263",
          volume: "1000",
        });
      }
      if (url.includes("api.binance.com/api/v3/klines")) {
        return okJson([
          [1767225600000, "10", "12", "9", "11", "100"],
          [1767312000000, "11", "14", "10", "13", "150"],
        ]);
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as typeof fetch, async () => {
      const chart = await fetchRecentDailyChart("BTC", "CRYPTO", 2, true);

      assert.equal(chart.quote.symbol, "BTC");
      assert.equal(chart.quote.exchange, "Binance");
      assert.deepEqual(chart.points.map((point) => point.close), [11, 13]);
    });
  });

  test("fetchRecentDailyChart expands Yahoo range for larger day windows", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      requested.push(String(input));
      return okJson(yahooChartResponse());
    }) as typeof fetch, async () => {
      const chart = await fetchRecentDailyChart("AAPL", "US", 120, true);

      assert.equal(chart.points.length, 2);
      assert.ok(requested.some((url) => url.includes("range=1y")));
    });
  });

  test("fetchRecentDailyChart requests enough fund history for requested days", async () => {
    const requestedUrls: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/f10/lsjz")) {
        const rows = Array.from({ length: 70 }, (_, index) => {
          const date = new Date(Date.UTC(2026, 2, 11 - index));
          const day = date.toISOString().slice(0, 10);
          const nav = (1 + (70 - index) / 1000).toFixed(4);
          return { FSRQ: day, DWJZ: nav, JZZZL: "0.1" };
        });
        return okJson({ Data: { LSJZList: rows } });
      }
      if (url.includes("fundgz.1234567.com.cn")) {
        return {
          ok: true,
          text: async () => 'jsonpgz({"name":"测试基金","jzrq":"2026-03-11","dwjz":"1.0700","gsz":"1.0710","gszzl":"0.1"})',
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as typeof fetch, async () => {
      const chart = await fetchRecentDailyChart("006479", "FUND", 45, true);

      assert.equal(chart.points.length, 45);
      assert.ok(requestedUrls.some((url) => url.includes("pageSize=66")));
    });
  });

  test("fetchDetailChart falls back to Tencent HK kline with EastMoney quote", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("push2delay.eastmoney.com/api/qt/ulist.np/get")) {
        return okJson({
          data: {
            diff: [{
              f2: 350,
              f3: 1.45,
              f4: 5,
              f5: 1000,
              f6: 350000,
              f12: "00700",
              f13: 116,
              f14: "腾讯控股",
              f15: 355,
              f16: 340,
              f17: 345,
              f18: 345,
            }],
          },
        });
      }
      if (url.includes("web.ifzq.gtimg.cn/appstock/app/fqkline/get")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              hk00700: {
                day: [
                  ["2026-01-02", "340", "345", "350", "338", "100"],
                  ["2026-01-03", "345", "350", "355", "342", "150"],
                ],
              },
            },
          }),
        } as Response;
      }
      return { ok: false, status: 429, json: async () => ({}) } as Response;
    }) as typeof fetch, async () => {
      const chart = await fetchDetailChart("00700", "HK", "1d", true);

      assert.equal(chart.quote.name, "腾讯控股");
      assert.equal(chart.quote.price, 350);
      assert.deepEqual(chart.points.map((point) => point.close), [345, 350]);
    });
  });

  test("fetchChart rejects when all Yahoo chart hosts fail", async () => {
    await withMockFetch((async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch, async () => {
      await assert.rejects(() => fetchChart("ALLFAIL", "1d", true), /HTTP 503/);
    });
  });

  test("fetchRecentDailyChart rejects when crypto and fallback sources all fail", async () => {
    await withMockFetch((async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch, async () => {
      await assert.rejects(() => fetchRecentDailyChart("NOCOIN", "CRYPTO", 2, true), /recent daily unavailable/);
    });
  });

  test("fetchDetailChart rejects when regional detail sources all fail", async () => {
    await withMockFetch((async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    }) as Response) as typeof fetch, async () => {
      await assert.rejects(() => fetchDetailChart("600998", "A", "1d", true), /detail unavailable/);
    });
  });
});
