import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OpenAICompatibleProvider, resolveModelListEndpoint, resolveResearchEndpoint } from "./openAiCompatible";
import type { ResearchProviderSettings } from "../types";

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
  models: [{ id: "test-model", name: "Test Model" }],
  model: "test-model",
  fastModel: "",
  synthesisModel: "",
  auditModel: "",
  webSearchMode: "off",
  thinkingLevel: "auto",
  maxConcurrency: 1,
  maxOutputTokens: 1000,
  requestTimeoutSeconds: 30,
};

async function collect(provider: OpenAICompatibleProvider) {
  const events = [];
  for await (const event of provider.run({ messages: [{ role: "user", content: "hello" }] })) events.push(event);
  return events;
}

describe("OpenAI-compatible browser provider", () => {
  test("normalizes Ark and Agent Plan base URLs for both protocols", () => {
    assert.equal(
      resolveResearchEndpoint("https://ark.cn-beijing.volces.com/api/v3", "chat_completions"),
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
    assert.equal(
      resolveResearchEndpoint("https://ark.cn-beijing.volces.com/api/plan/v3", "responses"),
      "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
    );
    assert.equal(
      resolveResearchEndpoint("https://ark.cn-beijing.volces.com/api/v3/chat/completions", "responses"),
      "https://ark.cn-beijing.volces.com/api/v3/responses",
    );
    assert.equal(
      resolveModelListEndpoint("https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1/models",
    );
    assert.equal(
      resolveResearchEndpoint("https://api.anthropic.com/v1", "anthropic_messages"),
      "https://api.anthropic.com/v1/messages",
    );
    assert.equal(
      resolveModelListEndpoint("https://api.anthropic.com/v1/messages", "anthropic_messages"),
      "https://api.anthropic.com/v1/models",
    );
    assert.equal(
      resolveResearchEndpoint("https://generativelanguage.googleapis.com/v1beta", "gemini_native", "gemini-2.5-pro", true),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    assert.equal(
      resolveResearchEndpoint("https://generativelanguage.googleapis.com/v1beta", "gemini_native", "models/gemini-2.5-pro"),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    assert.equal(
      resolveResearchEndpoint("http://localhost:11434", "ollama_chat"),
      "http://localhost:11434/api/chat",
    );
    assert.equal(
      resolveModelListEndpoint("http://localhost:11434/api/chat", "ollama_chat"),
      "http://localhost:11434/api/tags",
    );
  });

  test("loads and normalizes an OpenAI-compatible model list", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        data: [
          { id: "model-b", display_name: "Model B" },
          { id: "model-a" },
          { id: "model-b" },
        ],
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const models = await new OpenAICompatibleProvider(settings).listModels();
      assert.equal(requestedUrl, "https://model.example/v1/models");
      assert.deepEqual(models, [
        { id: "model-a", name: "model-a" },
        { id: "model-b", name: "Model B" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("loads paginated native Gemini model lists", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      const pageToken = new URL(url).searchParams.get("pageToken");
      return new Response(JSON.stringify(pageToken ? {
        models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }],
      } : {
        models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }],
        nextPageToken: "next-page",
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const models = await new OpenAICompatibleProvider({
        ...settings,
        preset: "google_gemini",
        protocol: "gemini_native",
        authMode: "x_google_api_key",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
      }).listModels();
      assert.equal(requested[0], "https://generativelanguage.googleapis.com/v1beta/models");
      assert.equal(requested[1], "https://generativelanguage.googleapis.com/v1beta/models?pageToken=next-page");
      assert.deepEqual(models, [
        { id: "models/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        { id: "models/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves model-declared reasoning capabilities from model discovery", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{
        id: "reasoning-model",
        reasoning: {
          supported_efforts: ["minimal", "low", "high"],
          default_effort: "low",
          mandatory: true,
          supports_max_tokens: true,
        },
      }],
    }), { headers: { "content-type": "application/json" } });
    try {
      assert.deepEqual(await new OpenAICompatibleProvider(settings).listModels(), [{
        id: "reasoning-model",
        name: "reasoning-model",
        reasoning: {
          supportedEfforts: ["minimal", "low", "high"],
          defaultEffort: "low",
          mandatory: true,
          supportsMaxTokens: true,
        },
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects insecure non-local endpoints before sending credentials", async () => {
    const provider = new OpenAICompatibleProvider({ ...settings, endpoint: "http://model.example/v1/chat/completions" });
    await assert.rejects(() => provider.testConnection(), /模型 API 地址无效/);
  });

  test("handles a non-streaming JSON fallback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "JSON answer" } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }), { headers: { "content-type": "application/json" } });
    try {
      const events = await collect(new OpenAICompatibleProvider(settings));
      assert.equal(events[0]?.type, "delta");
      assert.equal(events[0]?.type === "delta" ? events[0].text : "", "JSON answer");
      assert.equal(events.some((event) => event.type === "usage" && event.usage.totalTokens === 13), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses SSE deltas and the final usage block", async () => {
    const originalFetch = globalThis.fetch;
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
      'data: {"choices":[],"usage":{"total_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join("\n");
    globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    try {
      const events = await collect(new OpenAICompatibleProvider(settings));
      const output = events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join("");
      assert.equal(output, "Hello world");
      assert.equal(events.some((event) => event.type === "usage" && event.usage.totalTokens === 7), true);
      assert.equal(events.at(-1)?.type, "done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("supports standard Ark Responses streaming and native web search", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const body = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Ark "}',
      '',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"works"}',
      '',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
      '',
    ].join("\n");
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "volcengine_ark",
        protocol: "responses",
        endpoint: "https://ark.cn-beijing.volces.com/api/v3",
        webSearchMode: "native",
      });
      const events = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "hello" }], enableWebSearch: true })) events.push(event);
      assert.equal(requestedUrl, "https://ark.cn-beijing.volces.com/api/v3/responses");
      assert.deepEqual(requestedBody.tools, [{ type: "web_search" }]);
      assert.equal(Array.isArray(requestedBody.input), true);
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "Ark works");
      assert.equal(events.some((event) => event.type === "usage" && event.usage.totalTokens === 6), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("auto mode retries without native web search when the provider rejects the tool", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "unsupported web_search tool" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ output_text: "Offline fallback completed" }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "openai",
        protocol: "responses",
        endpoint: "https://api.openai.com/v1",
        webSearchMode: "auto",
      });
      const events = [];
      for await (const event of provider.run({
        messages: [{ role: "user", content: "research" }],
        enableWebSearch: true,
        continueOnWebSearchFailure: true,
      })) events.push(event);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0]?.tools, [{ type: "web_search" }]);
      assert.equal("tools" in (bodies[1] ?? {}), false);
      assert.equal(events.some((event) => event.type === "web_search" && event.phase === "failed"), true);
      assert.equal(events.some((event) => event.type === "delta" && event.text === "Offline fallback completed"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses Responses web-search events and structured URL citations", async () => {
    const originalFetch = globalThis.fetch;
    const body = [
      'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching"}',
      "",
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://platform.openai.com/docs","title":"OpenAI docs"}}',
      "",
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Verified"}',
      "",
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":5}}}',
      "",
    ].join("\n");
    globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "openai",
        protocol: "responses",
        endpoint: "https://api.openai.com/v1",
        webSearchMode: "native",
      });
      const events = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "search" }], enableWebSearch: true })) events.push(event);
      assert.equal(events.some((event) => event.type === "web_search" && event.phase === "searching"), true);
      assert.equal(events.some((event) => event.type === "web_search" && event.sources?.[0]?.url === "https://platform.openai.com/docs"), true);
      assert.equal(events.some((event) => event.type === "web_search" && event.phase === "unverified"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses non-streaming Responses search actions and nested annotations", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      output: [
        { type: "web_search_call", action: { type: "search", query: "OpenAI API docs" } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Verified",
            annotations: [{ type: "url_citation", url: "https://platform.openai.com/docs", title: "OpenAI docs" }],
          }],
        },
      ],
    }), { headers: { "content-type": "application/json" } });
    try {
      const result = await new OpenAICompatibleProvider({
        ...settings,
        preset: "openai",
        protocol: "responses",
        endpoint: "https://api.openai.com/v1",
        webSearchMode: "native",
      }).testWebSearch();
      assert.deepEqual(result.queries, ["OpenAI API docs"]);
      assert.equal(result.sources[0]?.url, "https://platform.openai.com/docs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps and parses Anthropic server-side web search", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    const body = [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"server_tool_use","name":"web_search","input":{"query":"Anthropic API docs"}}}',
      "",
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://docs.anthropic.com/","title":"Anthropic docs"}]}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Verified"}}',
      "",
    ].join("\n");
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "anthropic",
        protocol: "anthropic_messages",
        authMode: "x_api_key",
        endpoint: "https://api.anthropic.com/v1",
        webSearchMode: "native",
      });
      const events = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "search" }], enableWebSearch: true })) events.push(event);
      assert.deepEqual(requestedBody.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
      assert.equal(events.some((event) => event.type === "web_search" && event.query === "Anthropic API docs"), true);
      assert.equal(events.some((event) => event.type === "web_search" && event.sources?.[0]?.url === "https://docs.anthropic.com/"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces Anthropic web-search tool errors returned inside HTTP 200", async () => {
    const originalFetch = globalThis.fetch;
    const body = [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}]}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Fallback"}}',
      "",
    ].join("\n");
    globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "anthropic",
        protocol: "anthropic_messages",
        authMode: "x_api_key",
        endpoint: "https://api.anthropic.com/v1",
        webSearchMode: "native",
      });
      await assert.rejects(async () => {
        for await (const event of provider.run({ messages: [{ role: "user", content: "search" }], enableWebSearch: true })) void event.type;
      }, /max_uses_exceeded/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps Gemini grounding and parses grounding metadata", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Verified"}]},"groundingMetadata":{"webSearchQueries":["Gemini API docs"],"groundingChunks":[{"web":{"uri":"https://ai.google.dev/gemini-api/docs","title":"Gemini docs"}}]}}]}',
      "",
    ].join("\n");
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "google_gemini",
        protocol: "gemini_native",
        authMode: "x_google_api_key",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        webSearchMode: "native",
      });
      const events = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "search" }], enableWebSearch: true })) events.push(event);
      assert.deepEqual(requestedBody.tools, [{ google_search: {} }]);
      assert.equal(events.some((event) => event.type === "web_search" && event.query === "Gemini API docs"), true);
      assert.equal(events.some((event) => event.type === "web_search" && event.sources?.[0]?.url === "https://ai.google.dev/gemini-api/docs"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses Perplexity Sonar and verifies citations through the dedicated web test", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Verified" } }],
        citations: ["https://docs.perplexity.ai/"],
        search_results: [{ url: "https://docs.perplexity.ai/", title: "Perplexity docs" }],
      }), { headers: { "content-type": "application/json" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "perplexity",
        endpoint: "https://api.perplexity.ai/v1",
        webSearchMode: "native",
      });
      const result = await provider.testWebSearch();
      assert.equal(requestedUrl, "https://api.perplexity.ai/v1/sonar");
      assert.deepEqual(requestedBody.web_search_options, {});
      assert.equal(result.sources[0]?.url, "https://docs.perplexity.ai/");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unverified generic Chat Completions search before sending a request", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response();
    };
    try {
      const provider = new OpenAICompatibleProvider({ ...settings, preset: "deepseek", webSearchMode: "native" });
      await assert.rejects(async () => {
        for await (const event of provider.run({ messages: [{ role: "user", content: "search" }], enableWebSearch: true })) void event.type;
      }, /尚未接入|requires/);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("supports Anthropic Messages headers, adaptive thinking and SSE", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    let requestedBody: Record<string, unknown> = {};
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude works"}}',
      "",
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}',
      "",
    ].join("\n");
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "anthropic",
        protocol: "anthropic_messages",
        authMode: "x_api_key",
        endpoint: "https://api.anthropic.com/v1",
        model: "claude-sonnet-test",
        thinkingLevel: "medium",
      });
      const events = [];
      for await (const event of provider.run({
        messages: [
          { role: "system", content: "Be accurate." },
          { role: "user", content: "hello" },
        ],
      })) events.push(event);
      assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");
      assert.equal(requestedHeaders.get("x-api-key"), "test-key");
      assert.equal(requestedHeaders.get("anthropic-version"), "2023-06-01");
      assert.equal(requestedBody.system, "Be accurate.");
      assert.deepEqual(requestedBody.thinking, { type: "adaptive" });
      assert.deepEqual(requestedBody.output_config, { effort: "medium" });
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "Claude works");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("supports native Gemini request mapping and thinking budget", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    let requestedBody: Record<string, unknown> = {};
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"internal"},{"text":"Gemini works"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}',
      "",
    ].join("\n");
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "google_gemini",
        protocol: "gemini_native",
        authMode: "x_google_api_key",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-pro",
        thinkingLevel: "high",
      });
      const events = await collect(provider);
      assert.equal(requestedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
      assert.equal(requestedHeaders.get("x-goog-api-key"), "test-key");
      assert.deepEqual(
        (requestedBody.generationConfig as Record<string, unknown>).thinkingConfig,
        { thinkingBudget: 8192 },
      );
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "Gemini works");
      assert.equal(events.some((event) => event.type === "usage" && event.usage.totalTokens === 6), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("supports keyless Ollama model discovery and NDJSON chat", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3:8b", model: "qwen3:8b" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response([
        '{"message":{"role":"assistant","content":"Local "},"done":false}',
        'provider status: reconnecting',
        '{"message":{"role":"assistant","content":"works"},"done":true,"prompt_eval_count":4,"eval_count":2}',
        "",
      ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({
        ...settings,
        preset: "ollama",
        protocol: "ollama_chat",
        authMode: "none",
        endpoint: "http://localhost:11434",
        apiKey: "",
        model: "qwen3:8b",
        thinkingLevel: "low",
      });
      assert.deepEqual(await provider.listModels(), [{ id: "qwen3:8b", name: "qwen3:8b" }]);
      const events = await collect(provider);
      assert.deepEqual(requested, ["http://localhost:11434/api/tags", "http://localhost:11434/api/chat"]);
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "Local works");
      assert.equal(events.some((event) => event.type === "usage" && event.usage.totalTokens === 6), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps thinking depth for OpenAI-compatible requests", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await new OpenAICompatibleProvider({ ...settings, thinkingLevel: "high" }).testConnection();
      assert.equal(requestedBody.reasoning_effort, "high");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes advanced Ark Responses reasoning levels through when selected", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await new OpenAICompatibleProvider({
        ...settings,
        preset: "volcengine_agent_plan",
        protocol: "responses",
        endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
        thinkingLevel: "high",
      }).testConnection();
      await new OpenAICompatibleProvider({
        ...settings,
        preset: "volcengine_agent_plan",
        protocol: "responses",
        endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
        thinkingLevel: "max",
      }).testConnection();
      assert.deepEqual(bodies[0]?.reasoning, { effort: "high" });
      assert.deepEqual(bodies[1]?.reasoning, { effort: "max" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries with lower thinking effort when a provider rejects the selected effort", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "unsupported reasoning effort max" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const result = await new OpenAICompatibleProvider({
        ...settings,
        preset: "volcengine_agent_plan",
        protocol: "responses",
        endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
        thinkingLevel: "max",
      }).testConnection();
      assert.deepEqual(bodies[0]?.reasoning, { effort: "max" });
      assert.deepEqual(bodies[1]?.reasoning, { effort: "xhigh" });
      assert.match(result.message, /降级/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses OpenRouter's unified reasoning object and omits unsupported provider fields", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await new OpenAICompatibleProvider({ ...settings, preset: "openrouter", thinkingLevel: "max" }).testConnection();
      await new OpenAICompatibleProvider({ ...settings, preset: "deepseek", thinkingLevel: "high" }).testConnection();
      assert.deepEqual(bodies[0]?.reasoning, { effort: "max" });
      assert.equal("reasoning_effort" in bodies[0]!, false);
      assert.equal("reasoning_effort" in bodies[1]!, false);
      assert.equal("reasoning" in bodies[1]!, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
