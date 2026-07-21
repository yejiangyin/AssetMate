import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createResearchJob, runResearchJob } from "./orchestrator";
import { clearResearchLibrary, listResearchJobs, listResearchReports } from "./storage";
import type { ResearchProviderSettings } from "./types";

const settings: ResearchProviderSettings = {
  id: "test-provider",
  name: "Test Provider",
  preset: "custom",
  protocol: "chat_completions",
  authMode: "bearer",
  authHeaderName: "Authorization",
  authHeaderPrefix: "Bearer ",
  endpoint: "https://model.example/v1/chat/completions",
  apiKey: "test-key",
  saveApiKey: false,
  models: [
    { id: "research-model", name: "Research Model" },
    { id: "fast-model", name: "Fast Model" },
  ],
  model: "research-model",
  fastModel: "fast-model",
  synthesisModel: "",
  auditModel: "",
  webSearchMode: "off",
  thinkingLevel: "auto",
  maxConcurrency: 2,
  maxOutputTokens: 1000,
  requestTimeoutSeconds: 30,
};

describe("research orchestrator", () => {
  test("completes, audits and persists a browser-only research job", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-15\n## 看多优势\n[Filing](https://example.com/filing)\n## 看空风险\n[Exchange](https://exchange.example/data)\n## 研究局限\n未联网验证，不构成投资建议。" } }],
    }), { headers: { "content-type": "application/json" } });
    try {
      const job = createResearchJob({
        workflowId: "quick_check",
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
        publicContext: {
          target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
          generatedAt: "2026-07-15T00:00:00.000Z",
          dataCutoff: "2026-07-15",
        },
      });
      const result = await runResearchJob(job, { ...settings, webSearchMode: "auto" });
      assert.equal(result.job.status, "completed");
      assert.equal(result.report.sources.length, 2);
      assert.equal(result.report.webSearch?.phase, "not_requested");
      assert.equal(result.report.audit.status, "partial");
      assert.equal((await listResearchJobs())[0]?.status, "completed");
      assert.equal((await listResearchReports())[0]?.id, result.report.id);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("persists actual search traces and provider citations", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    const stream = [
      'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching"}',
      "",
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.com/provider-source","title":"Provider source"}}',
      "",
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.net/provider-source-2","title":"Provider source 2"}}',
      "",
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"# Apple快速检查\\n数据截止日期：2026-07-15\\n## 看多优势\\n[Second](https://example.org/second)\\n## 看空风险\\n风险存在。\\n## 研究局限\\n不构成投资建议。"}',
      "",
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":10}}}',
      "",
    ].join("\n");
    globalThis.fetch = async () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
    try {
      const job = createResearchJob({
        workflowId: "quick_check",
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
        publicContext: {
          target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
          generatedAt: "2026-07-15T00:00:00.000Z",
          dataCutoff: "2026-07-15",
        },
      });
      const result = await runResearchJob(job, {
        ...settings,
        protocol: "responses",
        endpoint: "https://model.example/v1",
        webSearchMode: "native",
      }, {
        externalSearchSettings: {
          id: "unused-external-budget",
          name: "Unused external budget",
          provider: "tavily",
          endpoint: "https://api.tavily.com/search",
          apiKey: "search-key",
          saveApiKey: false,
          authHeaderName: "Authorization",
          authHeaderPrefix: "Bearer ",
          maxResults: 5,
          maxSources: 1,
          timeRange: "month",
          includeDomains: "",
          excludeDomains: "",
          fetchPageContent: false,
          maxPages: 1,
          requestTimeoutSeconds: 30,
        },
      });
      assert.equal(result.report.webSearch?.phase, "completed");
      assert.equal(result.report.webSearch?.sources[0]?.origin, "provider");
      assert.equal(result.report.webSearch?.sources.filter((source) => source.origin === "provider").length, 2);
      assert.equal(result.report.sources.some((source) => source.url.includes("provider-source")), true);
      assert.equal(result.report.audit.checks.find((check) => check.id === "web-search")?.status, "pass");
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("injects independent search evidence when the model has no native browsing", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    let modelRequestBody = "";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.tavily.com")) {
        return new Response(JSON.stringify({ results: [{
          title: "Apple investor relations",
          url: "https://investor.apple.com/results",
          content: "Apple published its latest quarterly results.",
        }] }), { headers: { "content-type": "application/json" } });
      }
      modelRequestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-15\n## 看多优势\n[Apple IR](https://investor.apple.com/results)\n## 看空风险\n风险存在。\n## 研究局限\n使用外部搜索，不构成投资建议。" } }],
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const job = createResearchJob({
        workflowId: "quick_check",
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
        publicContext: {
          target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
          generatedAt: "2026-07-15T00:00:00.000Z",
          dataCutoff: "2026-07-15",
        },
      });
      const result = await runResearchJob(job, { ...settings, webSearchMode: "external" }, {
        externalSearchSettings: {
          id: "search-test",
          name: "Test search",
          provider: "tavily",
          endpoint: "https://api.tavily.com/search",
          apiKey: "search-key",
          saveApiKey: false,
          authHeaderName: "Authorization",
          authHeaderPrefix: "Bearer ",
          maxResults: 5,
          maxSources: 10,
          timeRange: "month",
          includeDomains: "",
          excludeDomains: "",
          fetchPageContent: false,
          maxPages: 2,
          requestTimeoutSeconds: 30,
        },
      });
      assert.match(modelRequestBody, /独立执行的外部搜索/);
      assert.match(modelRequestBody, /\[S1\]/);
      assert.equal(result.report.webSearch?.phase, "completed");
      assert.equal(result.report.webSearch?.method, "external");
      assert.equal(result.report.webSearch?.externalProvider, "tavily");
      assert.equal(result.report.sources.some((source) => source.origin === "external_search"), true);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("keeps verified external-search sources even when the report forgets to cite them", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.tavily.com")) {
        return new Response(JSON.stringify({ results: [{
          title: "Apple investor relations",
          url: "https://investor.apple.com/results",
          content: "Apple published its latest quarterly results.",
        }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-20\n## 看多优势\n收入保持增长。\n## 看空风险\n风险存在。\n## 研究局限\n未在正文列出链接，不构成投资建议。" } }],
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const target = { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" };
      const job = createResearchJob({
        workflowId: "quick_check",
        target,
        publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
      });
      const result = await runResearchJob(job, { ...settings, webSearchMode: "external" }, {
        externalSearchSettings: {
          id: "search-trace-test",
          name: "Trace search",
          provider: "tavily",
          endpoint: "https://api.tavily.com/search",
          apiKey: "search-key",
          saveApiKey: false,
          authHeaderName: "Authorization",
          authHeaderPrefix: "Bearer ",
          maxResults: 5,
          maxSources: 10,
          timeRange: "month",
          includeDomains: "",
          excludeDomains: "",
          fetchPageContent: false,
          maxPages: 2,
          requestTimeoutSeconds: 30,
        },
      });
      assert.equal(result.report.sources.length, 0);
      assert.equal(result.report.webSearch?.phase, "completed");
      assert.equal(result.report.webSearch?.sources.length, 1);
      assert.equal(result.report.audit.checks.find((check) => check.id === "web-search")?.status, "pass");
      assert.equal(result.report.audit.checks.find((check) => check.id === "source-count")?.status, "warning");
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("keeps cited external provenance when a team synthesis reuses upstream evidence", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.tavily.com")) {
        return new Response(JSON.stringify({ results: [{
          title: "Apple filing",
          url: "https://investor.apple.com/filing",
          content: "Apple official filing evidence.",
        }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "# Apple AAPL\n数据截止日期：2026-07-15\n| 指标 | 数值 |\n| 收入 | 100 |\n## 看多优势\n[Apple filing](https://investor.apple.com/filing)\n## 看空风险\n风险存在。\n## 研究局限\n不构成投资建议。" } }],
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const job = createResearchJob({
        workflowId: "deep_research",
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
        publicContext: {
          target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
          generatedAt: "2026-07-15T00:00:00.000Z",
          dataCutoff: "2026-07-15",
        },
      });
      const result = await runResearchJob(job, { ...settings, maxConcurrency: 2, webSearchMode: "external" }, {
        externalSearchSettings: {
          id: "team-search-test",
          name: "Team search",
          provider: "tavily",
          endpoint: "https://api.tavily.com/search",
          apiKey: "search-key",
          saveApiKey: false,
          authHeaderName: "Authorization",
          authHeaderPrefix: "Bearer ",
          maxResults: 5,
          maxSources: 10,
          timeRange: "month",
          includeDomains: "",
          excludeDomains: "",
          fetchPageContent: false,
          maxPages: 2,
          requestTimeoutSeconds: 30,
        },
      });
      assert.equal(result.report.sources.find((source) => source.url === "https://investor.apple.com/filing")?.origin, "external_search");
      assert.equal(result.report.webSearch?.sources.some((source) => source.origin === "external_search"), true);
      assert.equal(result.report.webSearch?.phase, "completed");
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("executes the WeChat workflow as research, draft, parallel reviews and final rewrite", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = String(init?.body ?? "");
      requestBodies.push(body);
      let content = "UNKNOWN";
      if (body.includes("内容研究 Agent")) content = "RESEARCH_BUNDLE [Primary](https://example.com/primary)";
      else if (body.includes("深度内容作者")) content = "DRAFT_BODY [Primary](https://example.com/primary)";
      else if (body.includes("资深公众号编辑")) content = "EDIT_REVIEW";
      else if (body.includes("目标读者")) content = "READER_REVIEW";
      else if (body.includes("终稿作者")) content = "# FINAL_ARTICLE\n数据截止日期：2026-07-20\n## 原始资料与研究局限\n[Primary](https://example.com/primary)\n不构成投资建议。";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const target = { symbol: "TOPIC", name: "AI 投资", market: "US", assetType: "stock", currency: "" };
      const job = createResearchJob({
        workflowId: "wechat_article",
        target,
        topic: "AI 投资",
        publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
      });
      const result = await runResearchJob(job, settings);
      assert.equal(requestBodies.length, 5);
      assert.equal(requestBodies.some((body) => body.includes("深度内容作者") && body.includes("RESEARCH_BUNDLE")), true);
      assert.equal(requestBodies.some((body) => body.includes("资深公众号编辑") && body.includes("DRAFT_BODY")), true);
      assert.equal(requestBodies.some((body) => body.includes("目标读者") && body.includes("DRAFT_BODY")), true);
      assert.equal(requestBodies.some((body) => body.includes("终稿作者") && body.includes("EDIT_REVIEW") && body.includes("READER_REVIEW")), true);
      assert.match(result.report.markdown, /FINAL_ARTICLE/);
      assert.equal(result.report.agentResults?.length, 4);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("routes execution, synthesis and audit through different API connections", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });
      const content = url.includes("audit.example")
        ? JSON.stringify({ status: "pass", summary: "Evidence is consistent", checkedClaims: 2, verifiedClaims: 2, findings: [] })
        : "# Apple research\n数据截止日期：2026-07-20\n## 看多优势\n[Primary](https://example.com/primary)\n## 看空风险\n风险存在。\n## 研究局限\n不构成投资建议。";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
    };
    const execution = { ...settings, id: "exec", name: "Execution API", endpoint: "https://exec.example/v1", model: "exec-model" };
    const synthesis = { ...settings, id: "synth", name: "Synthesis API", endpoint: "https://synth.example/v1", model: "synth-main", synthesisModel: "synth-model" };
    const audit = { ...settings, id: "audit", name: "Audit API", endpoint: "https://audit.example/v1", model: "audit-main", auditModel: "audit-model" };
    try {
      const target = { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" };
      const providerRoute = {
        execution: { profileId: execution.id, profileName: execution.name },
        synthesis: { profileId: synthesis.id, profileName: synthesis.name },
        audit: { profileId: audit.id, profileName: audit.name },
      };
      const job = createResearchJob({
        workflowId: "deep_research",
        target,
        publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
        providerRoute,
      });
      const result = await runResearchJob(job, { execution, executionModel: "exec-fast", executionModelRole: "fast", synthesis, synthesisModel: "synth-model", audit, auditModel: "audit-model" });

      assert.equal(requests.filter((request) => request.url.includes("exec.example")).length, 4);
      assert.equal(requests.filter((request) => request.url.includes("synth.example")).length, 1);
      assert.equal(requests.filter((request) => request.url.includes("audit.example")).length, 1);
      assert.equal(requests.filter((request) => request.url.includes("exec.example")).every((request) => request.body.includes("exec-fast")), true);
      assert.equal(requests.some((request) => request.url.includes("synth.example") && request.body.includes("synth-model")), true);
      assert.equal(requests.some((request) => request.url.includes("audit.example") && request.body.includes("audit-model")), true);
      assert.equal(result.report.agentResults?.every((agent) => agent.providerId === execution.id), true);
      assert.equal(result.report.audit.modelReview?.providerId, audit.id);
      assert.deepEqual(result.report.providerRoute, providerRoute);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("repairs a non-JSON audit response once instead of discarding the review", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    let auditRequests = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (url.includes("audit.example")) {
        auditRequests += 1;
        const content = body.includes("JSON 格式修复器")
          ? JSON.stringify({ status: "warning", summary: "已修复审计格式", checkedClaims: 2, verifiedClaims: 1, findings: [] })
          : "审计完成，但返回成了普通文字。";
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-20\n## 看多优势\n优势存在。\n## 看空风险\n风险存在。\n## 研究局限\n不构成投资建议。" } }] }), { headers: { "content-type": "application/json" } });
    };
    const audit = { ...settings, id: "repair-audit", name: "Repair Audit", endpoint: "https://audit.example/v1", model: "audit-model", auditModel: "audit-model" };
    try {
      const target = { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" };
      const job = createResearchJob({
        workflowId: "quick_check",
        target,
        publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
      });
      const result = await runResearchJob(job, {
        execution: settings,
        executionModelRole: "auto",
        synthesis: settings,
        audit,
        auditModel: "audit-model",
      });
      assert.equal(auditRequests, 2);
      assert.equal(result.report.audit.modelReview?.status, "warning");
      assert.equal(result.report.audit.modelReview?.summary, "已修复审计格式");
      assert.equal(result.report.audit.modelReview?.checkedClaims, 2);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("injects DataPro MCP evidence into research and persists its trace", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    let modelRequestBody = "";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
      if (url.includes("datapro.hqd.cn-beijing.volces.com")) {
        if (body.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "datapro", version: "1" } } }), { headers: { "mcp-session-id": "research-session" } });
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "query_data", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] } }));
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ dataset_type: "financial", revenue: 100, data_date: "2026-07-19" }) }] } }));
      }
      modelRequestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-20\n## 看多优势\n专业数据集 [D1] 显示收入为 100。\n## 看空风险\n风险存在。\n## 研究局限\n不构成投资建议。" } }] }), { headers: { "content-type": "application/json" } });
    };
    const dataPro = { ...settings, id: "plan", name: "Agent Plan", preset: "volcengine_agent_plan" as const, apiKey: "same-plan-key" };
    try {
      const target = { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" };
      const providerRoute = {
        execution: { profileId: settings.id, profileName: settings.name },
        professionalData: { profileId: dataPro.id, profileName: dataPro.name },
        auditDisabled: true,
      };
      const job = createResearchJob({
        workflowId: "quick_check",
        target,
        publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
        providerRoute,
      });
      const result = await runResearchJob(job, {
        execution: settings,
        executionModelRole: "auto",
        synthesis: settings,
        professionalData: dataPro,
      });

      assert.match(modelRequestBody, /方舟 Agent Plan 专业数据集 MCP/);
      assert.match(modelRequestBody, /\[D1\]/);
      assert.equal(result.report.professionalData?.status, "completed");
      assert.equal(result.report.professionalData?.items[0]?.datasetType, "financial");
      assert.equal(result.report.audit.checks.find((check) => check.id === "professional-data")?.status, "pass");
      assert.deepEqual(result.report.providerRoute, providerRoute);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });

  test("persists cancellation promptly and allows the same job to restart", async () => {
    await clearResearchLibrary();
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async () => { throw new Error("fetch should not start after cancellation"); };
    const job = createResearchJob({
      workflowId: "quick_check",
      target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
      publicContext: {
        target: { symbol: "AAPL", name: "Apple", market: "US", assetType: "stock", currency: "USD" },
        generatedAt: "2026-07-16T00:00:00.000Z",
        dataCutoff: "2026-07-16",
      },
    });
    try {
      await assert.rejects(runResearchJob(job, settings, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }), /中断|cancel/i);
      const cancelled = (await listResearchJobs())[0]!;
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.error?.retryable, true);

      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: "# Apple快速检查\n数据截止日期：2026-07-16\n## 看多优势\n[Source](https://example.com/source)\n## 看空风险\n风险存在。\n## 研究局限\n未联网，不构成投资建议。" } }],
      }), { headers: { "content-type": "application/json" } });
      const restarted = await runResearchJob(cancelled, settings);
      assert.equal(restarted.job.status, "completed");
      assert.equal(restarted.report.jobId, cancelled.id);
    } finally {
      globalThis.fetch = originalFetch;
      await clearResearchLibrary();
    }
  });
});
