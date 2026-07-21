import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChartData, QuoteInfo } from "../services/quoteApi";
import { buildPublicResearchContext } from "./contextBuilder";
import { enrichResearchTarget, enrichResearchTargets, type ResearchMarketDataDependencies } from "./marketData";
import type { ResearchTarget } from "./types";

function quote(symbol: string, price: number, currency = "USD"): QuoteInfo {
  return {
    symbol,
    name: `${symbol} Inc.`,
    price,
    change: 1,
    changePercent: 0.5,
    open: price - 1,
    high: price + 2,
    low: price - 2,
    prevClose: price - 1,
    volume: 1_000,
    marketCap: price * 1_000_000,
    pe: 20,
    eps: 5,
    week52High: price + 20,
    week52Low: price - 20,
    currency,
    exchange: "NASDAQ",
    isLive: false,
  };
}

function chart(symbol: string, price: number, currency = "USD"): ChartData {
  return {
    quote: quote(symbol, price, currency),
    points: [
      { time: "2026-07-17", dateLabel: "2026-07-17", timestamp: Date.parse("2026-07-17T00:00:00Z"), price: price - 1, volume: 900 },
      { time: "2026-07-18", dateLabel: "2026-07-18", timestamp: Date.parse("2026-07-18T00:00:00+08:00"), price, volume: 1_000 },
    ],
  };
}

function dependencies(overrides: Partial<ResearchMarketDataDependencies> = {}): ResearchMarketDataDependencies {
  return {
    fetchDetailChart: async (symbol) => chart(symbol, symbol === "MSFT" ? 500 : 200),
    fetchCorporateActions: async () => [],
    fetchChart: async (symbol) => chart(symbol, symbol === "MSFT" ? 500 : 200),
    fetchYahooQuoteSummary: async () => ({ companyProfile: { sector: "Technology" } }),
    fetchSecFinancialHistory: async (symbol) => ({ symbol, cik: "1", years: [{ fiscalYear: 2025, revenue: 100 }] }),
    ...overrides,
  };
}

const apple: ResearchTarget = {
  symbol: "AAPL",
  name: "Apple",
  market: "US",
  assetType: "stock",
  currency: "USD",
};

describe("research market-data enrichment", () => {
  test("keeps per-target quotes, history and provenance for multi-target research", async () => {
    const contexts = await enrichResearchTargets([
      apple,
      { ...apple, symbol: "MSFT", name: "Microsoft" },
    ], "quick_check", { dependencies: dependencies(), concurrency: 2 });

    assert.equal(contexts.length, 2);
    assert.equal(contexts[0]?.target.currentPrice, 200);
    assert.equal(contexts[1]?.target.currentPrice, 500);
    assert.equal(contexts[0]?.recentPrices?.at(-1)?.date, "2026-07-18");
    assert.equal(contexts[0]?.provenance.find((item) => item.dataset === "quote")?.provider, "AssetMate market data router");
    assert.equal(contexts[0]?.provenance.find((item) => item.dataset === "price_history")?.adjustmentMode, "unknown");

    const publicContext = buildPublicResearchContext(contexts[0]!.target, {
      targets: contexts.map((context) => context.target),
      targetContexts: contexts,
    });
    assert.equal(publicContext.dataCutoff, "2026-07-18");
    assert.equal(publicContext.dataStatus?.targetCount, 2);
    assert.equal(publicContext.targetContexts?.length, 2);
  });

  test("preserves complete core market data when an optional source times out", async () => {
    const context = await enrichResearchTarget(apple, "quick_check", {
      timeoutMs: 10,
      dependencies: dependencies({
        fetchYahooQuoteSummary: async () => new Promise(() => undefined),
      }),
    });

    assert.equal(context.target.currentPrice, 200);
    assert.equal(context.recentPrices?.length, 2);
    assert.equal(context.status, "complete");
    assert.equal(context.provenance.find((item) => item.dataset === "financial_statements")?.status, "timeout");
    assert.equal(context.provenance.find((item) => item.dataset === "quote")?.status, "success");
  });

  test("aborts the whole multi-target preparation without starting another target", async () => {
    const controller = new AbortController();
    const never = async () => new Promise<never>(() => undefined);
    const pendingDependencies = dependencies({
      fetchDetailChart: never,
      fetchCorporateActions: never,
      fetchChart: never,
      fetchYahooQuoteSummary: never,
      fetchSecFinancialHistory: never,
    });
    const promise = enrichResearchTargets([apple, { ...apple, symbol: "MSFT" }], "deep_research", {
      dependencies: pendingDependencies,
      signal: controller.signal,
      timeoutMs: 1_000,
      concurrency: 1,
    });
    controller.abort(new DOMException("cancelled in test", "AbortError"));

    await assert.rejects(promise, /cancelled/i);
  });

  test("prefers the dedicated live quote over a long-range Yahoo chart quote", async () => {
    const context = await enrichResearchTarget(apple, "quick_check", {
      dependencies: dependencies({
        fetchDetailChart: async (symbol, _market, range) => ({
          ...chart(symbol, range === "fs" ? 210 : 200),
          quote: { ...quote(symbol, range === "fs" ? 210 : 200), changePercent: range === "fs" ? 0.025 : 0.00000001 },
        }),
        fetchChart: async (symbol) => chart(symbol, 190),
      }),
    });

    assert.equal(context.target.currentPrice, 210);
    assert.equal(context.target.dailyChangePercent, 0.025);
  });

  test("uses the newest SEC fiscal year and requires deep-research evidence", async () => {
    const complete = await enrichResearchTarget(apple, "deep_research", {
      dependencies: dependencies({
        fetchSecFinancialHistory: async (symbol) => ({
          symbol,
          cik: "1",
          years: [{ fiscalYear: 2025, revenue: 100 }, { fiscalYear: 2016, revenue: 50 }],
        }),
      }),
    });
    assert.equal(complete.provenance.find((item) => item.dataset === "sec_filings")?.dataDate, "2025");
    assert.equal(complete.status, "complete");

    const missingEvidence = await enrichResearchTarget({ ...apple, market: "HK" }, "deep_research", {
      dependencies: dependencies({ fetchYahooQuoteSummary: async () => null }),
    });
    assert.equal(missingEvidence.status, "partial");
    assert.equal(missingEvidence.provenance.find((item) => item.dataset === "company_profile")?.requirement, "required");
  });

  test("skips stock-only data calls for funds and caps prompt price samples at 60", async () => {
    let yahooCalls = 0;
    const manyPoints = Array.from({ length: 1000 }, (_, index) => ({
      time: `2024-${String(Math.floor(index / 28) % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`,
      dateLabel: `2024-${String(Math.floor(index / 28) % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`,
      price: 1 + index / 1000,
    }));
    const context = await enrichResearchTarget({
      symbol: "019548",
      name: "Fund",
      market: "FUND",
      assetType: "fund",
      currency: "CNY",
    }, "quick_check", {
      dependencies: dependencies({
        fetchDetailChart: async () => ({ quote: quote("019548", 1.5, "CNY"), points: manyPoints }),
        fetchChart: async () => { yahooCalls += 1; return chart("019548", 1.5, "CNY"); },
        fetchYahooQuoteSummary: async () => { yahooCalls += 1; return null; },
      }),
    });

    assert.equal(yahooCalls, 0);
    assert.equal(context.recentPrices?.length, 60);
    assert.equal(context.provenance.find((item) => item.dataset === "fundamentals")?.status, "not_applicable");
  });
});
