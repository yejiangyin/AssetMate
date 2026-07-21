import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  auditResearchReport,
  calculateScenarioValuation,
  calculateValuation,
  crossValidate,
  extractResearchSources,
  verifyTargetedReportCalculations,
  verifyReportCalculations,
  verifyMarketCap,
} from "./financialRigor";

describe("financial rigor", () => {
  test("uses decimal arithmetic for market cap and valuation ratios", () => {
    const marketCap = verifyMarketCap("189.125", "15204137000", "2875602265375");
    assert.equal(marketCap.calculated, "2875482410125");
    assert.equal(marketCap.status, "pass");

    const valuation = calculateValuation({ price: "100", eps: "5", bookValuePerShare: "25", fcfPerShare: "4", dividendPerShare: "2" });
    assert.deepEqual(valuation, {
      pe: "20",
      earningsYieldPercent: "5",
      pb: "4",
      roePercent: "20",
      priceToFcf: "25",
      fcfYieldPercent: "4",
      dividendYieldPercent: "2",
    });
    assert.throws(() => calculateValuation({ price: 0, eps: 1 }), /价格/);
    assert.throws(() => verifyMarketCap(-1, 100, 100), /不能为负数/);
  });

  test("calculates scenario targets and probability weighting", () => {
    const result = calculateScenarioValuation({
      currentPrice: "100",
      currentEps: "5",
      years: 2,
      scenarios: [
        { name: "bear", annualGrowth: "0", targetPe: "12", probability: "0.25" },
        { name: "base", annualGrowth: "0.1", targetPe: "20", probability: "0.75" },
      ],
    });
    assert.equal(result.scenarios[0]?.targetPrice, "60");
    assert.equal(result.scenarios[1]?.targetPrice, "121");
    assert.equal(result.weightedTargetPrice, "105.75");
  });

  test("requires two sources and flags divergent values", () => {
    assert.equal(crossValidate([{ source: "filing", value: 100 }]).status, "unverified");
    assert.equal(crossValidate([{ source: "filing", value: 100 }, { source: "exchange", value: 100.5 }], 1).status, "verified");
    assert.equal(crossValidate([{ source: "filing", value: 100 }, { source: "aggregator", value: 130 }], 1).status, "failed");
  });

  test("extracts links and never upgrades a report without calculation evidence", () => {
    const markdown = "# ACME\n数据截止日期：2026-07-15\n| 指标 | 数值 |\n| 收入 | 100 |\n## 看多优势\n证据 [Filing](https://example.com/a).\n## 看空风险\n反证 [Exchange](https://exchange.example/b).\n## 研究局限\n不构成投资建议。";
    const sources = extractResearchSources(markdown, "2026-07-15T00:00:00.000Z");
    assert.equal(sources.length, 2);
    assert.doesNotThrow(() => extractResearchSources("broken https://[invalid"));
    const partial = auditResearchReport({ markdown, dataCutoff: "2026-07-15", sources });
    assert.equal(partial.status, "partial");

    const verified = auditResearchReport({
      markdown,
      dataCutoff: "2026-07-15",
      sources,
      webSearch: {
        requested: true,
        supported: true,
        phase: "completed",
        provider: "openai",
        protocol: "responses",
        model: "gpt-test",
        queries: ["ACME filing"],
        sources: sources.map((source) => ({ ...source, origin: "provider" as const })),
        errors: [],
      },
      calculationChecks: [{ id: "valuation", label: "估值复算", status: "pass", detail: "Decimal check" }],
    });
    assert.equal(verified.status, "verified");
  });

  test("parses K/M/B/T using international financial units", () => {
    const checks = verifyReportCalculations("Price: 100 USD\nShares outstanding: 2B\nMarket cap: 200B USD");
    assert.equal(checks.find((check) => check.id === "marketcap-verify")?.status, "pass");

    const million = verifyReportCalculations("Price: 25 USD\nShares outstanding: 4M\nMarket cap: 100M USD");
    assert.equal(million.find((check) => check.id === "marketcap-verify")?.status, "pass");
  });

  test("recalculates dividend yield and earnings payout ratio", () => {
    const checks = verifyReportCalculations([
      "当前股价：100 USD",
      "EPS：8 USD",
      "年度每股股息：4 USD",
      "股息率：4%",
      "派息率：50%",
    ].join("\n"));
    assert.equal(checks.find((check) => check.id === "dividend-yield-consistency")?.status, "pass");
    assert.equal(checks.find((check) => check.id === "payout-ratio-consistency")?.status, "pass");

    const inconsistent = verifyReportCalculations("股价：100 USD\nEPS：8 USD\n每股股利：4 USD\n股息率：8%\n派息率：75%");
    assert.equal(inconsistent.find((check) => check.id === "dividend-yield-consistency")?.status, "fail");
    assert.equal(inconsistent.find((check) => check.id === "payout-ratio-consistency")?.status, "fail");
  });

  test("counts publisher domains instead of treating URLs as independent sources", () => {
    const sources = [
      { title: "A", url: "https://news.example.com/a", accessedAt: "2026-07-17" },
      { title: "B", url: "https://investor.example.com/b", accessedAt: "2026-07-17" },
    ];
    const result = auditResearchReport({ markdown: "数据截止日期：2026-07-17\n## 看多优势\n## 看空风险\n## 研究局限", dataCutoff: "2026-07-17", sources });
    assert.equal(result.sourceCount, 1);
    assert.equal(result.checks.find((check) => check.id === "source-count")?.status, "warning");
  });

  test("uses a stable sample for repeated audits", () => {
    const markdown = "数据截止日期：2026-07-17\n| 指标 | 数值 |\n| 收入 | 100 |\n| 利润 | 20 |\n| 现金 | 30 |";
    const first = auditResearchReport({ markdown, dataCutoff: "2026-07-17" });
    const second = auditResearchReport({ markdown, dataCutoff: "2026-07-17" });
    assert.equal(first.checks.find((check) => check.id === "sampled-data")?.detail, second.checks.find((check) => check.id === "sampled-data")?.detail);
  });

  test("rejects professional-data references that are outside the MCP trace", () => {
    const result = auditResearchReport({
      markdown: "数据截止日期：2026-07-20\n## 看多优势\n专业数据集 [D2]\n## 看空风险\n风险存在。",
      dataCutoff: "2026-07-20",
      professionalData: {
        requested: true,
        status: "completed",
        endpoint: "https://datapro.hqd.cn-beijing.volces.com/mcp",
        queries: ["query"],
        datasetTypes: ["financial"],
        items: [{ query: "query", datasetType: "financial", content: "{}" }],
        errors: [],
      },
    });
    const check = result.checks.find((item) => item.id === "professional-data");
    assert.equal(check?.status, "fail");
    assert.match(check?.detail ?? "", /\[D2\]/);
  });

  test("audits each company section independently in a multi-target report", () => {
    const markdown = [
      "# Apple AAPL",
      "当前股价：200 USD；EPS：10 USD；PE：20",
      "# Microsoft MSFT",
      "当前股价：500 USD；EPS：20 USD；PE：25",
    ].join("\n");
    const checks = verifyTargetedReportCalculations(markdown, [
      { target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD", currentPrice: 200 }, status: "complete", provenance: [] },
      { target: { symbol: "MSFT", name: "Microsoft", market: "US", assetType: "stock", currency: "USD", currentPrice: 500 }, status: "complete", provenance: [] },
    ]);
    assert.equal(checks.find((check) => check.id === "US-AAPL-pe-consistency")?.status, "pass");
    assert.equal(checks.find((check) => check.id === "US-MSFT-pe-consistency")?.status, "pass");
    assert.equal(checks.some((check) => check.status === "fail"), false);
  });
});
