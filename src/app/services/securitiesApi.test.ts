import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchCnFundTradeStatus,
  fetchLivePrice,
  normalizeSearchSymbol,
  parseFundBuyConfirmDays,
  searchSecuritiesLive,
} from "./securitiesApi";

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
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () => "<html><body>交易规则 买入确认日 T+2 其他文本</body></html>",
    })) as any;

    try {
      const status = await fetchCnFundTradeStatus("021277");
      assert.equal(status?.status, "normal");
      assert.equal(status?.buyConfirmDays, 2);
      assert.match(status?.note ?? "", /确认规则/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("live quote normalization", () => {
  test("normalizes Yahoo crypto and Japan symbols before merging search results", () => {
    assert.equal(normalizeSearchSymbol("BTC-USD", "CRYPTO"), "BTC");
    assert.equal(normalizeSearchSymbol("ETH-USDT", "CRYPTO"), "ETH");
    assert.equal(normalizeSearchSymbol("7203.T", "JP"), "7203");
  });

  test("uses the live query2 chart endpoint for a Japan quote", async () => {
    const previousFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;

    try {
      const quote = await fetchLivePrice("7203", "JP");
      assert.equal(quote?.price, 2746);
      assert.equal(quote?.currency, "JPY");
      assert.ok(requested.some((url) => url.includes("query2.finance.yahoo.com")));
      assert.ok(requested.some((url) => url.includes("interval=1m")));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("prefers a tradable exchange quote over CoinGecko for crypto entry", async () => {
    const previousFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;

    try {
      const quote = await fetchLivePrice("BTC", "CRYPTO", "bitcoin");
      assert.equal(quote?.price, 64233.79);
      assert.equal(quote?.currency, "USDT");
      assert.equal(requested.filter((url) => url.includes("api.binance.com")).length, 1);
      assert.equal(requested.some((url) => url.includes("api.coingecko.com")), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("keeps exact Japan ticker search available when Yahoo search is rate-limited", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;

    try {
      const results = await searchSecuritiesLive("7203");
      const toyota = results.find((item) => item.market === "JP" && item.symbol === "7203");
      assert.equal(toyota?.name, "Toyota Motor Corporation");
      assert.equal(toyota?.price, 2746);
      assert.equal(toyota?.currency, "JPY");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("marketFilter=JP drops non-Japan matches and still probes Tokyo for a 4-digit code", async () => {
    const previousFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;

    try {
      const results = await searchSecuritiesLive("7203", "JP");
      assert.ok(results.every((item) => item.market === "JP"), "no non-JP results should leak through");
      const toyota = results.find((item) => item.symbol === "7203");
      assert.equal(toyota?.market, "JP");
      assert.equal(toyota?.name, "Toyota Motor Corporation");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("marketFilter=CRYPTO skips regional and fund data sources", async () => {
    const previousFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;

    try {
      const results = await searchSecuritiesLive("btc", "CRYPTO");
      assert.ok(results.every((item) => item.market === "CRYPTO"));
      assert.ok(requested.some((url) => url.includes("coingecko.com")));
      assert.ok(!requested.some((url) => url.includes("fundsuggest.eastmoney.com")));
      assert.ok(!requested.some((url) => url.includes("/v1/finance/search")));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
