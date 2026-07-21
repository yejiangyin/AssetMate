import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildResearchReportArchiveEntries,
  buildResearchReportBundle,
  buildResearchReportSectionBundle,
  buildResearchReportsBundle,
  buildStoredZip,
  researchReportFilename,
  researchReportSectionFilename,
} from "./reportDownload";
import type { ResearchReport } from "./types";

function report(id: string, title: string, createdAt: string, target: Partial<ResearchReport["target"]> = {}): ResearchReport {
  return {
    id,
    jobId: `job-${id}`,
    workflowId: "quick_check",
    workflowVersion: "test",
    target: { symbol: "AAPL", name: "Apple/Inc", market: "US", assetType: "stock", currency: "USD", ...target },
    title,
    summary: `${title} summary`,
    markdown: `## ${title}\nBody`,
    createdAt,
    updatedAt: createdAt,
    dataCutoff: createdAt.slice(0, 10),
    sources: [],
    audit: {
      status: "unverified",
      checks: [],
      note: "test",
      checkedAt: createdAt,
      sourceCount: 0,
    },
    privateContextIncluded: false,
  };
}

describe("research report downloads", () => {
  test("creates a safe filename for one report", () => {
    assert.equal(researchReportFilename(report("1", "A/B", "2026-07-16T01:23:00.000Z")), "202607160123-A-B.md");
    assert.equal(researchReportSectionFilename(report("1", "A", "2026-07-16T01:23:00.000Z"), "财务/估值"), "202607160123-A-财务-估值.md");
  });

  test("combines multiple reports into one newest-first markdown file", () => {
    const bundle = buildResearchReportsBundle([
      report("1", "Older", "2026-07-15T01:00:00.000Z"),
      report("2", "Newer", "2026-07-16T01:00:00.000Z"),
    ], "zh");
    assert.match(bundle, /报告数量: 2/);
    assert.ok(bundle.indexOf("# 1. Newer") < bundle.indexOf("# 2. Older"));
    assert.match(bundle, /## Newer/);
    assert.match(bundle, /## Older/);
  });

  test("exports a full single report with synthesis and every agent section", () => {
    const full = report("1", "Apple team", "2026-07-16T01:00:00.000Z");
    full.dataStatus = { status: "partial", targetCount: 1, completeTargets: 0, partialTargets: 1, failedTargets: 0, warnings: ["Apple · financial_statements: timeout"] };
    full.targetContexts = [{
      target: full.target,
      status: "partial",
      provenance: [{ dataset: "quote", status: "success", provider: "Yahoo Finance", requestedAt: full.createdAt, completedAt: full.createdAt, dataDate: "2026-07-15", freshness: "delayed" }],
    }];
    full.agentResults = [
      {
        agentId: "financial-analyst",
        title: "财务与估值",
        content: "Financial section",
        completedAt: full.createdAt,
        sources: [],
      },
      {
        agentId: "business-analyst",
        title: "商业模式与护城河",
        content: "Business section",
        completedAt: full.createdAt,
        sources: [],
      },
    ];
    const bundle = buildResearchReportBundle(full, "zh");
    assert.match(bundle, /报告分栏: 3/);
    assert.match(bundle, /导出类型: 整份报告，包含所有分栏/);
    assert.match(bundle, /## 目录/);
    assert.match(bundle, /## 本地研究数据快照/);
    assert.match(bundle, /\| Apple\/Inc AAPL \| quote \| — \| success \| Yahoo Finance \| 2026-07-15 \| delayed \|/);
    assert.match(bundle, /## 1\. 综合报告/);
    assert.match(bundle, /## Apple team\nBody/);
    assert.match(bundle, /## 2\. 财务与估值/);
    assert.match(bundle, /Financial section/);
    assert.match(bundle, /## 3\. 商业模式与护城河/);
    assert.match(bundle, /Business section/);
  });

  test("exports only the selected report section", () => {
    const source = report("1", "Apple team", "2026-07-16T01:00:00.000Z");
    const section = buildResearchReportSectionBundle(source, "财务与估值", "Financial section", "zh");
    assert.match(section, /导出类型: 仅当前分栏/);
    assert.match(section, /分栏: 财务与估值/);
    assert.match(section, /Financial section/);
    assert.doesNotMatch(section, /综合报告/);
    assert.doesNotMatch(section, /商业模式与护城河/);
  });

  test("creates archive entries grouped by target with one file per report", () => {
    const entries = buildResearchReportArchiveEntries([
      report("1", "苹果 快速检查", "2026-07-16T01:00:00.000Z", { symbol: "AAPL", name: "苹果" }),
      report("2", "苹果 深度研究", "2026-07-16T02:00:00.000Z", { symbol: "AAPL", name: "苹果" }),
      report("3", "微软 快速检查", "2026-07-16T03:00:00.000Z", { symbol: "MSFT", name: "微软" }),
    ], "zh");
    assert.deepEqual(entries.map((entry) => entry.path), [
      "苹果 AAPL/202607160200-苹果 深度研究.md",
      "苹果 AAPL/202607160100-苹果 快速检查.md",
      "微软 MSFT/202607160300-微软 快速检查.md",
    ]);
    assert.match(entries[0]!.content, /## 1\. 综合报告/);
  });

  test("builds a valid stored zip payload", () => {
    const zip = buildStoredZip([{ path: "苹果 AAPL/report.md", content: "# report" }]);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    assert.equal(zip[2], 0x03);
    assert.equal(zip[3], 0x04);
    const tail = zip.slice(-22);
    assert.equal(tail[0], 0x50);
    assert.equal(tail[1], 0x4b);
    assert.equal(tail[2], 0x05);
    assert.equal(tail[3], 0x06);
  });
});
