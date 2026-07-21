import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { datasetRequirement, evaluateTargetDataStatus } from "./dataRequirements";
import type { ResearchDataProvenance, ResearchTarget } from "./types";

const stock: ResearchTarget = {
  symbol: "AAPL",
  name: "Apple",
  market: "US",
  assetType: "stock",
  currency: "USD",
};

function item(overrides: Partial<ResearchDataProvenance>): ResearchDataProvenance {
  return {
    dataset: "quote",
    status: "success",
    provider: "test",
    requestedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    ...overrides,
  };
}

describe("research data requirements", () => {
  test("requires equity fundamentals and a financial-evidence group for deep research", () => {
    assert.equal(datasetRequirement("deep_research", stock, "fundamentals").requirement, "required");
    assert.equal(datasetRequirement("deep_research", stock, "financial_statements").requirementGroup, "financial_evidence");
    assert.equal(datasetRequirement("deep_research", stock, "sec_filings").requirementGroup, "financial_evidence");
  });

  test("does not request stock-only datasets for funds or crypto", () => {
    assert.equal(datasetRequirement("quick_check", { ...stock, market: "FUND", assetType: "fund" }, "fundamentals").requirement, "not_applicable");
    assert.equal(datasetRequirement("quick_check", { ...stock, market: "CRYPTO", assetType: "crypto" }, "corporate_actions").requirement, "not_applicable");
  });

  test("accepts either financial source but rejects a missing or stale required dataset", () => {
    const base = [
      item({ dataset: "quote", requirement: "required" }),
      item({ dataset: "price_history", requirement: "required" }),
      item({ dataset: "fundamentals", requirement: "required" }),
      item({ dataset: "financial_statements", status: "partial", requirement: "optional", requirementGroup: "financial_evidence" }),
      item({ dataset: "sec_filings", requirement: "optional", requirementGroup: "financial_evidence" }),
    ];
    assert.equal(evaluateTargetDataStatus(base), "complete");
    assert.equal(evaluateTargetDataStatus(base.map((value) => value.dataset === "sec_filings" ? { ...value, status: "failed" } : value)), "partial");
    assert.equal(evaluateTargetDataStatus(base.map((value) => value.dataset === "price_history" ? { ...value, stale: true } : value)), "partial");
  });
});
