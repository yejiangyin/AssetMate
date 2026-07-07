import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchNasdaqChart, fetchNasdaqExtendedQuote, fetchNasdaqQuote } from "./nasdaqApi";
import { withMockFetch } from "../testUtils";

function nasdaqInfo() {
  return {
    data: {
      companyName: "Apple Inc.",
      exchange: "NASDAQ",
      primaryData: {
        lastSalePrice: "$200.00",
        netChange: "+2.00",
        percentageChange: "1.01%",
        volume: "1,234",
      },
      keyStats: {
        previousclose: { value: "$198.00" },
        dayrange: { value: "$197.00 - $201.00" },
      },
    },
  };
}

describe("Nasdaq API", () => {
  test("parses quote, chart, and extended-session responses", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/info?")) return { ok: true, json: async () => nasdaqInfo() } as Response;
      if (url.includes("/historical?")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              tradesTable: {
                rows: [
                  { date: "01/03/2026", close: "$203", open: "$201", high: "$204", low: "$200", volume: "300" },
                  { date: "01/02/2026", close: "$201", open: "$199", high: "$202", low: "$198", volume: "200" },
                ],
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: { infoTable: { rows: [{ consolidated: "$205.00 +3.00 (1.49%)" }] } },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchNasdaqQuote("AAPL");
      const chart = await fetchNasdaqChart("AAPL", "1d");
      const extended = await fetchNasdaqExtendedQuote("AAPL");

      assert.equal(quote?.price, 200);
      assert.equal(chart?.points.length, 2);
      assert.equal(chart?.points[1]?.close, 203);
      assert.equal(extended?.preMarketPrice, 205);
      assert.equal(extended?.postMarketPrice, 205);
      assert.ok(requested.some((url) => url.includes("assetclass=stocks")));
    });
  });

  test("maps index symbols and skips extended quotes for indexes", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      assert.ok(url.includes("/quote/NDX/"));
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      assert.equal(await fetchNasdaqQuote("^NDX"), null);
      assert.equal(await fetchNasdaqExtendedQuote("^NDX"), null);
    });
  });

  test("retries transient Nasdaq JSON failures once", async () => {
    let infoAttempts = 0;
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/info?")) {
        infoAttempts += 1;
        if (infoAttempts === 1) return { ok: false, status: 503 } as Response;
        return { ok: true, json: async () => nasdaqInfo() } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      const quote = await fetchNasdaqQuote("AAPL");

      assert.equal(quote?.price, 200);
      assert.equal(infoAttempts, 2);
    });
  });

  test("requests only the relevant extended session when market state is known", async () => {
    const requested: string[] = [];
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return {
        ok: true,
        json: async () => ({
          data: { infoTable: { rows: [{ consolidated: "$205.00 +3.00 (1.49%)" }] } },
        }),
      } as Response;
    }) as typeof fetch, async () => {
      const extended = await fetchNasdaqExtendedQuote("AAPL", "PRE");

      assert.equal(extended?.preMarketPrice, 205);
      assert.equal(extended?.postMarketPrice, undefined);
      assert.ok(requested.some((url) => url.includes("markettype=pre")));
      assert.equal(requested.some((url) => url.includes("markettype=post")), false);
    });
  });

  test("aggregates historical rows for weekly, quarterly, and yearly chart ranges", async () => {
    await withMockFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/info?")) return { ok: true, json: async () => nasdaqInfo() } as Response;
      if (url.includes("/historical?")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              tradesTable: {
                rows: [
                  { date: "04/02/2026", close: "$30", open: "$28", high: "$31", low: "$27", volume: "300" },
                  { date: "01/06/2026", close: "$12", open: "$11", high: "$14", low: "$10", volume: "200" },
                  { date: "01/05/2026", close: "$10", open: "$9", high: "$11", low: "$8", volume: "100" },
                ],
              },
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch, async () => {
      const weekly = await fetchNasdaqChart("AAPL", "5d");
      const quarterly = await fetchNasdaqChart("AAPL", "3mo");
      const yearly = await fetchNasdaqChart("AAPL", "1y");

      assert.deepEqual(weekly?.points.map((point) => point.time), ["1/6", "4/2"]);
      assert.equal(weekly?.points[0]?.open, 9);
      assert.equal(weekly?.points[0]?.high, 14);
      assert.equal(weekly?.points[0]?.low, 8);
      assert.equal(weekly?.points[0]?.close, 12);
      assert.equal(weekly?.points[0]?.volume, 300);
      assert.deepEqual(quarterly?.points.map((point) => point.time), ["26/Q1", "26/Q2"]);
      assert.deepEqual(yearly?.points.map((point) => point.time), ["2026"]);
      assert.equal(yearly?.points[0]?.close, 30);
      assert.equal(yearly?.points[0]?.volume, 600);
    });
  });
});
