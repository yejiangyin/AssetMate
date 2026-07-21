import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildModelAuditRepairRequest, buildModelAuditRequest, parseModelAuditResult } from "./modelAudit";

describe("independent model audit", () => {
  test("disables web search and includes bounded source evidence", () => {
    const request = buildModelAuditRequest({
      markdown: "报告正文",
      model: "audit-model",
      maxOutputTokens: 8000,
      sources: [{ title: "Source", url: "https://example.com", accessedAt: "2026-07-20", snippet: "evidence" }],
      publicContext: {
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD", currentPrice: 200 },
        generatedAt: "2026-07-20T00:00:00.000Z",
        dataCutoff: "2026-07-18",
        targetContexts: [{
          target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD", currentPrice: 200 },
          status: "complete",
          fundamentals: { pe: 20, currency: "USD" },
          provenance: [{
            dataset: "quote",
            status: "success",
            provider: "Yahoo Finance",
            requestedAt: "2026-07-20T00:00:00.000Z",
            completedAt: "2026-07-20T00:00:01.000Z",
            dataDate: "2026-07-18",
          }],
        }],
      },
    });
    assert.equal(request.model, "audit-model");
    assert.equal(request.enableWebSearch, false);
    assert.equal(request.maxOutputTokens, 8000);
    assert.equal(request.thinkingLevel, "off");
    assert.match(request.messages[1]!.content, /evidence/);
    assert.match(request.messages[1]!.content, /"pe": 20/);
    assert.match(request.messages[0]!.content, /本地结构化数据快照/);
  });

  test("parses fenced JSON and keeps independence metadata", () => {
    const result = parseModelAuditResult('```json\n{"status":"warning","summary":"一项待核验","checkedClaims":3,"verifiedClaims":2,"findings":[{"severity":"warning","category":"citation","detail":"来源不足"}]}\n```', "audit-model", true);
    assert.equal(result.status, "warning");
    assert.equal(result.independent, true);
    assert.equal(result.findings[0]?.category, "citation");
  });

  test("builds a bounded offline repair request for non-JSON audit output", () => {
    const request = buildModelAuditRepairRequest({ content: "审计基本通过，但有一项引用不足。", model: "audit-model" });
    assert.equal(request.enableWebSearch, false);
    assert.equal(request.maxOutputTokens, 2000);
    assert.match(request.messages[0]!.content, /JSON 格式修复器/);
    assert.match(request.messages[1]!.content, /引用不足/);
  });
});
