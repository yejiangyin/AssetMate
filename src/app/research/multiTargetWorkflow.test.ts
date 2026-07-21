import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPublicResearchContext } from "./contextBuilder";
import { buildAgentRequest, buildSynthesisRequest } from "./workflows/prompts";
import { getWorkflowConfig, WORKFLOW_CATEGORY_ORDER, WORKFLOW_REGISTRY } from "./workflows/registry";

describe("AI Berkshire workflow alignment", () => {
  const targets = [
    { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
    { symbol: "MSFT", name: "Microsoft", market: "US", assetType: "stock", currency: "USD" },
  ];

  test("matches the upstream five-category, twenty-skill catalog", () => {
    assert.deepEqual(WORKFLOW_CATEGORY_ORDER.slice(0, 5), ["deep", "earnings", "industry", "portfolio", "tools"]);
    const upstream = Object.values(WORKFLOW_REGISTRY).filter((workflow) => workflow.origin !== "assetmate");
    assert.equal(upstream.length, 20);
    assert.deepEqual(
      Object.fromEntries(WORKFLOW_CATEGORY_ORDER.slice(0, 5).map((category) => [category, upstream.filter((workflow) => workflow.category === category).length])),
      { deep: 5, earnings: 2, industry: 5, portfolio: 5, tools: 3 },
    );
  });

  test("keeps multi-target research inside investment-checklist", () => {
    const config = getWorkflowConfig("quick_check");
    assert.equal(config.supportsMultipleTargets, true);
    assert.equal(config.minTargets, 1);
    assert.equal(config.maxTargets, 5);
    assert.equal(config.canonicalSkill, "investment-checklist");
    assert.deepEqual(config.agentIds, ["quick-check"]);
  });

  test("runs the complete checklist for every selected target", () => {
    const publicContext = buildPublicResearchContext(targets[0]!, { targets });
    const request = buildAgentRequest({
      workflowId: "quick_check",
      agentId: "quick-check",
      publicContext,
      webSearchMode: "off",
      maxOutputTokens: 4000,
      outputLanguage: "zh",
    });
    const prompt = request.messages[1]?.content ?? "";
    assert.match(prompt, /investment-checklist/);
    assert.match(prompt, /AAPL/);
    assert.match(prompt, /MSFT/);
    assert.match(prompt, /逐一覆盖所有标的/);
    assert.match(prompt, /多公司总览/);
    assert.match(prompt, /不得只分析第一个标的/);
  });

  test("distinguishes one-call investment research from the multi-agent team", () => {
    const single = getWorkflowConfig("investment_research");
    const team = getWorkflowConfig("deep_research");
    assert.equal(single.canonicalSkill, "investment-research");
    assert.deepEqual(single.agentIds, ["investment-researcher"]);
    assert.equal(team.canonicalSkill, "investment-team");
    assert.equal(team.parallel, true);
    assert.equal(team.needsSynthesis, true);
  });

  test("keeps quality-screen as a hybrid target-or-scope workflow", () => {
    const config = getWorkflowConfig("quality_screen");
    assert.equal(config.supportsMultipleTargets, true);
    assert.equal(config.supportsTopicAlternative, true);
    assert.equal(config.needsTopicInput, undefined);
    assert.equal(config.minTargets, 1);
    assert.equal(config.maxTargets, 5);

    const publicContext = buildPublicResearchContext(targets[0]!, { targets });
    const request = buildAgentRequest({
      workflowId: "quality_screen",
      agentId: "quality-screener",
      publicContext,
      webSearchMode: "off",
      maxOutputTokens: 4000,
      outputLanguage: "zh",
    });
    const prompt = request.messages[1]?.content ?? "";
    assert.match(prompt, /7 硬指标/);
    assert.match(prompt, /AAPL/);
    assert.match(prompt, /MSFT/);
    assert.match(prompt, /逐一覆盖所有标的/);
  });

  test("syncs the latest income-investment workflow and decision inputs", () => {
    const config = getWorkflowConfig("income_investment");
    assert.equal(config.canonicalSkill, "income-investment");
    assert.equal(config.needsIncomeInputs, true);
    assert.deepEqual(config.agentIds, ["income-analyst"]);

    const request = buildAgentRequest({
      workflowId: "income_investment",
      agentId: "income-analyst",
      publicContext: buildPublicResearchContext(targets[0]!),
      incomeInvestmentContext: {
        mode: "existing",
        role: "core-income",
        targetYield: "4%",
        taxResidence: "中国大陆",
        horizon: "10 年",
      },
      webSearchMode: "off",
      maxOutputTokens: 8000,
      outputLanguage: "zh",
    });
    const prompt = request.messages[1]?.content ?? "";
    assert.match(prompt, /至少五年派息历史/);
    assert.match(prompt, /股息率、派息率、自由现金流覆盖/);
    assert.match(prompt, /YIELD TRAP/);
    assert.match(prompt, /中国大陆/);
  });

  test("hands WeChat research to the writer, reviews the draft, then synthesizes", () => {
    const config = getWorkflowConfig("wechat_article");
    assert.equal(config.needsSynthesis, true);
    assert.equal(config.calls, "5");
    assert.deepEqual(config.executionGroups, [
      ["wechat-researcher"],
      ["wechat-writer"],
      ["wechat-editor", "wechat-reader"],
    ]);
    const publicContext = buildPublicResearchContext(targets[0]!);
    const prior = [
      { agentId: "wechat-researcher" as const, title: "内容研究", content: "研究素材：核心数据 [来源](https://example.com/source)", completedAt: "2026-07-20", sources: [] },
      { agentId: "wechat-writer" as const, title: "文章撰写", content: "文章初稿：这是开头。", completedAt: "2026-07-20", sources: [] },
    ];
    const writer = buildAgentRequest({ workflowId: "wechat_article", agentId: "wechat-writer", publicContext, agentResults: prior.slice(0, 1), topic: "AI 投资", webSearchMode: "off", maxOutputTokens: 8000 });
    assert.match(writer.messages[1]?.content ?? "", /研究素材：核心数据/);
    const editor = buildAgentRequest({ workflowId: "wechat_article", agentId: "wechat-editor", publicContext, agentResults: prior, topic: "AI 投资", webSearchMode: "off", maxOutputTokens: 8000 });
    const reader = buildAgentRequest({ workflowId: "wechat_article", agentId: "wechat-reader", publicContext, agentResults: prior, topic: "AI 投资", webSearchMode: "off", maxOutputTokens: 8000 });
    assert.match(editor.messages[1]?.content ?? "", /文章初稿：这是开头/);
    assert.match(reader.messages[1]?.content ?? "", /文章初稿：这是开头/);

    const synthesis = buildSynthesisRequest({ workflowId: "wechat_article", publicContext, agentResults: prior, topic: "AI 投资", webSearchMode: "off", maxOutputTokens: 8000 });
    assert.match(synthesis.messages[1]?.content ?? "", /最终可发布文章/);
    assert.match(synthesis.messages[1]?.content ?? "", /研究素材：核心数据/);
    assert.match(synthesis.messages[1]?.content ?? "", /文章初稿：这是开头/);
  });

  test("builds a three-stage deep company series from a shared fact base", () => {
    const config = getWorkflowConfig("deep_company_series");
    assert.equal(config.canonicalSkill, "deep-company-series");
    assert.deepEqual(config.executionGroups, [["series-researcher"], ["series-writer"]]);
    const publicContext = buildPublicResearchContext(targets[0]!);
    const facts = [{ agentId: "series-researcher" as const, title: "事实底稿", content: "事实账本：收入 100，来源 A", completedAt: "2026-07-20", sources: [] }];
    const draft = buildAgentRequest({ workflowId: "deep_company_series", agentId: "series-writer", publicContext, agentResults: facts, topic: "5 篇，从生意到估值", webSearchMode: "off", maxOutputTokens: 32000 });
    assert.match(draft.messages[1]?.content ?? "", /事实账本：收入 100/);
    assert.match(draft.messages[1]?.content ?? "", /3–8 篇/);
  });
});
