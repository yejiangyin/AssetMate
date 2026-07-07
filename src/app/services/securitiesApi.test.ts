import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchCnFundEstimate,
  fetchCnFundOfficialNav,
  fetchCnFundOfficialHistory,
  fetchCnFundTradeStatus,
  fetchCryptoPrice,
  fetchLivePrice,
  normalizeSearchSymbol,
  parseFundPurchaseLimitText,
  parseFundBuyConfirmDays,
  resolveYahooUsPrice,
  searchSecuritiesLive,
} from "./securitiesApi";
import { withMockFetch } from "../testUtils";

describe("parseFundBuyConfirmDays", () => {
  test("extracts buy confirmation days from EastMoney fund fee text", () => {
    assert.equal(parseFundBuyConfirmDays("交易确认日 买入确认日 T+3 卖出确认日 T+2"), 3);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T + 10 卖出确认日 T+10"), 10);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T+0 卖出确认日 T+1"), 0);
  });

  test("ignores missing or unreasonable confirmation days", () => {
    assert.equal(parseFundBuyConfirmDays("交易确认日 卖出确认日 T+2"), undefined);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T+99"), undefined);
  });

  test("keeps confirmation days even when the trade status text is not recognized", async () => {
    await withMockFetch((async () => ({
      ok: true,
      text: async () => "<html><body>交易规则 买入确认日 T+2 其他文本</body></html>",
    }) as Response) as typeof fetch, async () => {
      const status = await fetchCnFundTradeStatus("021277");

      assert.equal(status?.status, "normal");
      assert.equal(status?.buyConfirmDays, 2);
      assert.match(status?.note ?? "", /确认规则/);
    });
  });
});

describe("parseFundPurchaseLimitText", () => {
  test("keeps composite purchase limit amounts intact", () => {
    assert.equal(parseFundPurchaseLimitText("单日累计购买上限 1万5千元"), "1万5千元");
    assert.equal(parseFundPurchaseLimitText("日累计申购限额 1万零500元"), "1万零500元");
    assert.equal(parseFundPurchaseLimitText("日累计申购限额 不限"), "不限");
  });
});

describe("live quote normalization", () => {
  test("normalizes Yahoo crypto and Japan symbols before merging search results", () => {
    assert.equal(normalizeSearchSymbol("BTC-USD", "CRYPTO"), "BTC");
    assert.equal(normalizeSearchSymbol("ETH-USDT", "CRYPTO"), "ETH");
    assert.equal(normalizeSearchSymbol("7203.T", "JP"), "7203");
    assert.equal(normalizeSearchSymbol("AAPL", "US"), "AAPL");
    assert.equal(normalizeSearchSymbol("0700.HK", "HK"), "0700");
    assert.equal(normalizeSearchSymbol("600900.SS", "A"), "600900");
    assert.equal(normalizeSearchSymbol("006479.SZ", "FUND"), "006479");
  });

  test("normalizes Yahoo price metadata for regular and extended US sessions", () => {
    const regular = resolveYahooUsPrice({
      regularMarketPrice: 101,
      previousClose: 100,
      regularMarketDayHigh: 102,
      regularMarketDayLow: 99,
      regularMarketVolume: 1234,
    }, "US");
    const pre = resolveYahooUsPrice({
      marketState: "PRE",
      regularMarketPrice: 101,
      preMarketPrice: 103,
      previousClose: 100,
      preMarketVolume: 55,
    }, "US");
    const hk = resolveYahooUsPrice({
      regularMarketPrice: 10.5,
      previousClose: 10,
      regularMarketChangePercent: 5,
    }, "HK");
    const closed = resolveYahooUsPrice({
      marketState: "CLOSED",
      regularMarketPrice: 101,
      postMarketPrice: 105,
      previousClose: 100,
    }, "US");

    assert.equal(regular.price, 101);
    assert.equal(regular.changePercent, 0.01);
    assert.equal(pre.price, 103);
    assert.equal(pre.volume, 55);
    assert.equal(hk.changePercent, 0.05);
    assert.equal(closed.price, 101);
  });

  test("uses the live query2 chart endpoint for a Japan quote", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("query2.finance.yahoo.com")) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                meta: {
                  currency: "JPY",
                  regularMarketPrice: 2746,
                  previousClose: 2776.5,
                  regularMarketDayHigh: 2802,
                  regularMarketDayLow: 2743,
                  regularMarketVolume: 16795100,
                },
              }],
            },
          }),
        } as Response;
      }
      return { ok: false, status: 429 } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchLivePrice("7203", "JP");

      assert.equal(quote?.price, 2746);
      assert.equal(quote?.currency, "JPY");
      assert.ok(requested.some((url) => url.includes("query2.finance.yahoo.com")));
      assert.ok(requested.some((url) => url.includes("interval=1m")));
    });
  });

  test("uses EastMoney quotes for A-share and Hong Kong live prices", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const isHk = url.includes("116.00700");
      return {
        ok: true,
        json: async () => ({
          data: {
            diff: [isHk
              ? { f2: 350, f3: 1.45, f4: 5, f5: 1000, f6: 350000, f12: "00700", f13: 116, f14: "腾讯控股", f15: 355, f16: 340, f17: 345, f18: 345 }
              : { f2: 30.5, f3: 1.67, f4: 0.5, f5: 1000, f6: 30500, f12: "600900", f13: 1, f14: "长江电力", f15: 31, f16: 30, f17: 30.1, f18: 30 }],
          },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const aShare = await fetchLivePrice("600900", "A");
      const hk = await fetchLivePrice("00700", "HK");

      assert.equal(aShare?.price, 30.5);
      assert.equal(aShare?.currency, "CNY");
      assert.equal(hk?.price, 350);
      assert.equal(hk?.currency, "HKD");
      assert.ok(requested.some((url) => url.includes("1.600900")));
      assert.ok(requested.some((url) => url.includes("116.00700")));
      assert.ok(requested.some((url) => url.includes("qt.gtimg.cn")));
    });
  });

  test("does not refetch fund NAV sources when the initial live fund lookup has no usable price", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("fundgz.1234567.com.cn")) {
        return {
          ok: true,
          text: async () => 'jsonpgz({"name":"测试基金","jzrq":"2026-01-02","dwjz":"0","gsz":"0","gszzl":"0"})',
        } as Response;
      }
      if (url.includes("/f10/lsjz")) {
        return { ok: true, json: async () => ({ Data: { LSJZList: [] } }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchLivePrice("006479", "FUND");

      assert.equal(quote, null);
      assert.equal(requested.filter((url) => url.includes("fundgz.1234567.com.cn")).length, 1);
      assert.equal(requested.filter((url) => url.includes("/f10/lsjz")).length, 1);
    });
  });

  test("uses official fund history for live fund prices before realtime estimates", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) {
        return {
          ok: true,
          json: async () => ({
            Data: {
              LSJZList: [
                { FSRQ: "2026-01-03", DWJZ: "1.3000", JZZZL: "0.2" },
                { FSRQ: "2026-01-02", DWJZ: "1.2000", JZZZL: "0.1" },
              ],
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        text: async () => 'jsonpgz({"name":"测试基金","jzrq":"2026-01-02","dwjz":"1.1000","gsz":"1.5000","gszzl":"2.0"})',
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchLivePrice("006479", "FUND");

      assert.equal(quote?.price, 1.3);
      assert.equal(quote?.prevClose, 1.2);
      assert.equal(quote?.change, 0.10000000000000009);
      assert.equal(quote?.changePercent, 0.002);
      assert.equal(quote?.currency, "CNY");
    });
  });

  test("prefers a tradable exchange quote over CoinGecko for crypto entry", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("api.binance.com")) {
        return {
          ok: true,
          json: async () => ({
            lastPrice: "64233.79",
            prevClosePrice: "64000",
            openPrice: "64000",
            highPrice: "64823.52",
            lowPrice: "63270",
            priceChange: "233.79",
            priceChangePercent: "0.365",
            volume: "10607.18",
          }),
        } as Response;
      }
      return { ok: false, status: 429 } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchLivePrice("BTC", "CRYPTO", "bitcoin");

      assert.equal(quote?.price, 64233.79);
      assert.equal(quote?.currency, "USDT");
      assert.equal(requested.filter((url) => url.includes("api.binance.com")).length, 1);
      assert.equal(requested.some((url) => url.includes("api.coingecko.com")), false);
    });
  });

  test("keeps exact Japan ticker search available when Yahoo search is rate-limited", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/finance/search")) {
        return { ok: false, status: 429 } as Response;
      }
      if (url.includes("/v8/finance/chart/7203.T")) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                meta: {
                  currency: "JPY",
                  longName: "Toyota Motor Corporation",
                  fullExchangeName: "Tokyo Stock Exchange",
                  regularMarketPrice: 2746,
                  previousClose: 2776.5,
                  regularMarketDayHigh: 2802,
                  regularMarketDayLow: 2743,
                  regularMarketVolume: 16795100,
                },
              }],
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ Data: [], coins: [] }), text: async () => "{}" } as Response;
    }) as typeof fetch, async () => {
      const results = await searchSecuritiesLive("7203");

      const toyota = results.find((item) => item.market === "JP" && item.symbol === "7203");
      assert.equal(toyota?.name, "Toyota Motor Corporation");
      assert.equal(toyota?.price, 2746);
      assert.equal(toyota?.currency, "JPY");
    });
  });

  test("marketFilter=JP drops non-Japan matches and still probes Tokyo for a 4-digit code", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/v1/finance/search")) {
        return {
          ok: true,
          json: async () => ({
            quotes: [
              { symbol: "7203.HK", exchange: "HKG", quoteType: "EQUITY", shortname: "700 HK", regularMarketPrice: 0 },
            ],
          }),
        } as Response;
      }
      if (url.includes("/v8/finance/chart/7203.T")) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                meta: {
                  currency: "JPY",
                  longName: "Toyota Motor Corporation",
                  fullExchangeName: "Tokyo Stock Exchange",
                  regularMarketPrice: 2746,
                  previousClose: 2776.5,
                },
              }],
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ Data: [], coins: [] }), text: async () => "{}" } as Response;
    }) as typeof fetch, async () => {
      const results = await searchSecuritiesLive("7203", "JP");

      assert.ok(results.every((item) => item.market === "JP"), "no non-JP results should leak through");
      const toyota = results.find((item) => item.symbol === "7203");
      assert.equal(toyota?.market, "JP");
      assert.equal(toyota?.name, "Toyota Motor Corporation");
    });
  });

  test("marketFilter=CRYPTO skips regional and fund data sources", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("api.coingecko.com/api/v3/search")) {
        return {
          ok: true,
          json: async () => ({
            coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ Data: [], quotes: [] }), text: async () => "{}" } as Response;
    }) as typeof fetch, async () => {
      const results = await searchSecuritiesLive("btc", "CRYPTO");

      assert.ok(results.every((item) => item.market === "CRYPTO"));
      assert.ok(requested.some((url) => url.includes("coingecko.com")));
      assert.ok(!requested.some((url) => url.includes("fundsuggest.eastmoney.com")));
      assert.ok(!requested.some((url) => url.includes("/v1/finance/search")));
    });
  });
});

describe("fund quote history", () => {
  test("parses realtime fund estimates", async () => {
    await withMockFetch((async () => ({
      ok: true,
      text: async () => 'jsonpgz({"name":"测试基金","jzrq":"2026-01-02","dwjz":"1.2345","gsz":"1.2500","gszzl":"1.25"})',
    }) as Response) as typeof fetch, async () => {
      const estimate = await fetchCnFundEstimate("006479");

      assert.equal(estimate?.name, "测试基金");
      assert.equal(estimate?.officialDate, "2026-01-02");
      assert.equal(estimate?.officialNav, 1.2345);
      assert.equal(estimate?.estimatedNav, 1.25);
      assert.equal(estimate?.estimatedChangePercent, 1.25);
    });
  });

  test("returns null for malformed fund estimates", async () => {
    await withMockFetch((async () => ({
      ok: true,
      text: async () => "not jsonp",
    }) as Response) as typeof fetch, async () => {
      assert.equal(await fetchCnFundEstimate("006479"), null);
    });
  });

  test("parses official fund history and sorts newest first", async () => {
    await withMockFetch((async () => ({
      ok: true,
      json: async () => ({
        Data: {
          LSJZList: [
            { FSRQ: "2026-01-02", DWJZ: "1.2", JZZZL: "0.1" },
            { FSRQ: "2026-01-03", DWJZ: "1.3", JZZZL: "0.2" },
            { FSRQ: "", DWJZ: "9", JZZZL: "0" },
          ],
        },
      }),
    }) as Response) as typeof fetch, async () => {
      const history = await fetchCnFundOfficialHistory("006479", 2);

      assert.deepEqual(history.map((point) => point.date), ["2026-01-03", "2026-01-02"]);
      assert.deepEqual(history.map((point) => point.nav), [1.3, 1.2]);
    });
  });

  test("falls back to pingzhongdata history when official history is empty", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) {
        return { ok: true, json: async () => ({ Data: { LSJZList: [] } }) } as Response;
      }
      return {
        ok: true,
        text: async () => "var Data_netWorthTrend = [{\"x\":1767225600000,\"y\":1.1,\"equityReturn\":0.5}];",
      } as Response;
    }) as typeof fetch, async () => {
      const history = await fetchCnFundOfficialHistory("006479", 5);

      assert.deepEqual(history, [{ date: "2026-01-01", nav: 1.1, changePercent: 0.5 }]);
    });
  });

  test("uses official fund history before realtime estimate for NAV", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      assert.ok(url.includes("/f10/lsjz"));
      return {
        ok: true,
        json: async () => ({
          Data: { LSJZList: [{ FSRQ: "2026-01-03", DWJZ: "1.234", JZZZL: "0.2" }] },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      assert.equal(await fetchCnFundOfficialNav("006479"), 1.234);
    });
  });

  test("falls back to realtime official NAV when history is unavailable", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/f10/lsjz")) {
        return { ok: true, json: async () => ({ Data: { LSJZList: [] } }) } as Response;
      }
      if (url.includes("pingzhongdata")) {
        return { ok: false, status: 404, text: async () => "" } as Response;
      }
      return {
        ok: true,
        text: async () => 'jsonpgz({"name":"测试基金","jzrq":"2026-01-02","dwjz":"1.111","gsz":"1.120","gszzl":"0.8"})',
      } as Response;
    }) as typeof fetch, async () => {
      assert.equal(await fetchCnFundOfficialNav("006479"), 1.111);
    });
  });

  test("returns null for fund NAV when all sources fail", async () => {
    await withMockFetch((async () => ({ ok: false, status: 500, text: async () => "" }) as Response) as typeof fetch, async () => {
      assert.equal(await fetchCnFundOfficialNav("006479"), null);
    });
  });
});

describe("crypto price fallbacks", () => {
  test("uses CoinGecko when exchange quotes are unavailable", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.coingecko.com/api/v3/simple/price")) {
        return {
          ok: true,
          json: async () => ({ bitcoin: { usd: 50000, usd_24h_change: 2 } }),
        } as Response;
      }
      return { ok: false, status: 429 } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchCryptoPrice("BTC", "bitcoin");

      assert.equal(quote?.price, 50000);
      assert.equal(quote?.currency, "USDT");
      assert.equal(quote?.changePercent, 0.02);
      assert.equal(Math.round(quote?.prevClose ?? 0), 49020);
    });
  });

  test("returns null when crypto sources fail and no coin id is available", async () => {
    await withMockFetch((async () => ({ ok: false, status: 429 }) as Response) as typeof fetch, async () => {
      assert.equal(await fetchCryptoPrice("BTC"), null);
    });
  });
});
