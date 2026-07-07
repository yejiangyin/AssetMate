import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fetchBinanceCryptoKline,
  fetchBinanceCryptoQuote,
  fetchOkxCryptoKline,
  fetchOkxCryptoQuote,
} from "./publicMarketApi";
import { withMockFetch } from "../testUtils";

describe("public crypto market APIs", () => {
  test("parses Binance quote and kline responses", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ticker/24hr")) {
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
      return {
        ok: true,
        json: async () => [
          [1767225600000, "10", "12", "9", "11", "100"],
          [1767312000000, "11", "14", "10", "13", "150"],
        ],
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchBinanceCryptoQuote("btc-usd");
      const points = await fetchBinanceCryptoKline("BTC", "1d");

      assert.equal(quote?.symbol, "BTC");
      assert.equal(quote?.price, 64233.79);
      assert.deepEqual(points?.map((point) => point.close), [11, 13]);
    });
  });

  test("parses OKX quote and kline responses", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ticker")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ last: "100", open24h: "95", high24h: "105", low24h: "90", vol24h: "123" }],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            ["1767312000000", "11", "14", "10", "13", "150"],
            ["1767225600000", "10", "12", "9", "11", "100"],
          ],
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchOkxCryptoQuote("ETH");
      const points = await fetchOkxCryptoKline("ETH", "1d");

      assert.equal(quote?.exchange, "OKX");
      assert.equal(quote?.change, 5);
      assert.deepEqual(points?.map((point) => point.close), [11, 13]);
    });
  });

  test("aggregates public crypto klines into quarterly and yearly candles", async () => {
    const binanceRows = [
      [Date.UTC(2026, 0, 2), "10", "12", "9", "11", "100"],
      [Date.UTC(2026, 1, 2), "11", "14", "10", "13", "150"],
      [Date.UTC(2026, 3, 2), "13", "16", "12", "15", "200"],
    ];
    const okxRows = [
      [String(Date.UTC(2026, 3, 2)), "13", "16", "12", "15", "200"],
      [String(Date.UTC(2026, 1, 2)), "11", "14", "10", "13", "150"],
      [String(Date.UTC(2026, 0, 2)), "10", "12", "9", "11", "100"],
    ];

    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.binance.com")) return { ok: true, json: async () => binanceRows } as Response;
      if (url.includes("okx.com")) return { ok: true, json: async () => ({ data: okxRows }) } as Response;
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      const binanceQuarterly = await fetchBinanceCryptoKline("BTC", "3mo");
      const okxYearly = await fetchOkxCryptoKline("BTC", "1y");

      assert.deepEqual(binanceQuarterly?.map((point) => point.time), ["26/Q1", "26/Q2"]);
      assert.equal(binanceQuarterly?.[0]?.open, 10);
      assert.equal(binanceQuarterly?.[0]?.high, 14);
      assert.equal(binanceQuarterly?.[0]?.low, 9);
      assert.equal(binanceQuarterly?.[0]?.close, 13);
      assert.equal(binanceQuarterly?.[0]?.volume, 250);
      assert.deepEqual(okxYearly?.map((point) => point.time), ["2026"]);
      assert.equal(okxYearly?.[0]?.close, 15);
      assert.equal(okxYearly?.[0]?.volume, 450);
    });
  });

  test("returns null for failed public crypto responses", async () => {
    await withMockFetch((async () => ({ ok: false, status: 500 }) as Response) as typeof fetch, async () => {
      assert.equal(await fetchBinanceCryptoQuote("BTC"), null);
      assert.equal(await fetchBinanceCryptoKline("BTC", "1d"), null);
      assert.equal(await fetchOkxCryptoQuote("BTC"), null);
      assert.equal(await fetchOkxCryptoKline("BTC", "1d"), null);
    });
  });
});
