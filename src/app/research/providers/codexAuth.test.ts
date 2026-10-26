import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_LATEST_RELEASE_URL,
  CODEX_REDIRECT_URI,
  buildCodexAuthorizeUrl,
  codexModelsEndpoint,
  codexModelsFromPayload,
  createCodexPkce,
  credentialsFromTokenResponse,
  ensureFreshCodexCredentials,
  importCodexAuthJson,
  newerCodexClientVersion,
  resolveCodexClientVersion,
  parseCodexCallbackUrl,
  parseCodexCredentials,
  serializeCodexCredentials,
} from "./codexAuth";
import { OpenAICompatibleProvider } from "./openAiCompatible";
import type { ResearchProviderSettings } from "../types";

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

const idToken = jwt({
  email: "trader@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" },
});
const accessToken = jwt({ exp: 2_000_000_000 });

describe("ChatGPT (Codex) OAuth", () => {
  test("builds the Codex CLI authorize URL with PKCE", async () => {
    const { verifier, challenge } = await createCodexPkce();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    assert.equal(challenge, Buffer.from(digest).toString("base64url"));

    const url = new URL(buildCodexAuthorizeUrl({ challenge, state: "state-1" }));
    assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), CODEX_CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), CODEX_REDIRECT_URI);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.match(url.searchParams.get("scope") ?? "", /offline_access/);
  });

  test("accepts only callbacks with the expected state", () => {
    assert.deepEqual(parseCodexCallbackUrl("http://localhost:1455/auth/callback?code=abc&state=s1", "s1"), { code: "abc" });
    assert.deepEqual(parseCodexCallbackUrl("http://127.0.0.1:1455/auth/callback?code=abc&state=s1", "s1"), { code: "abc" });
    assert.throws(() => parseCodexCallbackUrl("http://localhost:1455/auth/callback?code=abc&state=other", "s1"), /state/i);
    assert.throws(() => parseCodexCallbackUrl("https://evil.example/auth/callback?code=abc&state=s1", "s1"));
    assert.throws(() => parseCodexCallbackUrl("http://localhost:1455/auth/callback?error=access_denied&state=s1", "s1"), /access_denied/);
  });

  test("reads account, plan and expiry from token responses", () => {
    const credentials = credentialsFromTokenResponse({ access_token: accessToken, refresh_token: "r1", id_token: idToken });
    assert.equal(credentials.accountId, "acct-123");
    assert.equal(credentials.email, "trader@example.com");
    assert.equal(credentials.planType, "plus");
    assert.equal(credentials.expiresAt, 2_000_000_000_000);

    const refreshed = credentialsFromTokenResponse({ access_token: accessToken, expires_in: 60 }, credentials);
    assert.equal(refreshed.refreshToken, "r1", "keeps the old refresh token when none is rotated in");
    assert.equal(refreshed.accountId, "acct-123");
    assert.ok(refreshed.expiresAt <= Date.now() + 60_000);

    assert.deepEqual(parseCodexCredentials(serializeCodexCredentials(credentials)), credentials);
    assert.equal(parseCodexCredentials("sk-plain-api-key"), null);
  });

  test("imports ~/.codex/auth.json", () => {
    const credentials = importCodexAuthJson(JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: accessToken, refresh_token: "r2", account_id: "acct-123" },
      last_refresh: "2026-10-01T00:00:00Z",
    }));
    assert.equal(credentials.refreshToken, "r2");
    assert.equal(credentials.accountId, "acct-123");
    assert.throws(() => importCodexAuthJson("{\"OPENAI_API_KEY\":\"sk-test\"}"), /tokens/);
  });

  test("bounds a stalled token refresh and releases its per-profile lock for a retry", async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", ((handler: () => void, delay?: number) => originalSetTimeout(handler, delay === 15_000 ? 10 : delay)) as typeof globalThis.setTimeout);
    let refreshSignal: AbortSignal | undefined;
    const raw = serializeCodexCredentials({
      ...credentialsFromTokenResponse({ access_token: accessToken, refresh_token: "r1", id_token: idToken }),
      expiresAt: Date.now() - 1000,
    });
    globalThis.fetch = async (_url, init) => {
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    try {
      await assert.rejects(ensureFreshCodexCredentials("refresh-deadline-test", raw), /登录授权或续期超时/);
      assert.equal(refreshSignal?.aborted, true);
      globalThis.fetch = async () => new Response(JSON.stringify({ access_token: accessToken, refresh_token: "rotated", expires_in: 3600 }));
      const result = await ensureFreshCodexCredentials("refresh-deadline-test", raw);
      assert.equal(result.refreshToken, "rotated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps the Codex model catalog", () => {
    assert.equal(
      codexModelsEndpoint("https://chatgpt.com/backend-api/codex"),
      `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
    );
    assert.deepEqual(codexModelsFromPayload({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", priority: 5, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "medium" },
        { slug: "internal-model", visibility: "hide" },
        { slug: "unlisted-model", visibility: "none", priority: 0 },
        { slug: "gpt-6", display_name: "GPT-6", visibility: "list", priority: 1 },
      ],
    }), [
      { id: "gpt-6", name: "GPT-6" },
      { id: "gpt-5.5", name: "GPT-5.5", reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "medium" } },
    ]);
  });

  test("picks the newer stable Codex client version", () => {
    assert.equal(newerCodexClientVersion("0.164.0", "0.170.2"), "0.170.2");
    assert.equal(newerCodexClientVersion("0.164.0", "0.99.9"), "0.164.0");
    assert.equal(newerCodexClientVersion("0.164.0", "1.0.0"), "1.0.0");
    assert.equal(newerCodexClientVersion("0.164.0", "0.171.0-alpha.1"), "0.164.0");
    assert.equal(newerCodexClientVersion("0.164.0", undefined), "0.164.0");
  });

  test("follows the latest Codex CLI release and falls back on failure", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    try {
      let reply: () => Promise<Response> = async () => new Response(JSON.stringify({ version: "0.170.0" }), { status: 200 });
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        return reply();
      };
      assert.equal(await resolveCodexClientVersion(), "0.170.0");
      reply = async () => new Response(JSON.stringify({ version: "0.100.0" }), { status: 200 });
      assert.equal(await resolveCodexClientVersion(), CODEX_CLIENT_VERSION);
      reply = async () => new Response("{}", { status: 503 });
      assert.equal(await resolveCodexClientVersion(), CODEX_CLIENT_VERSION);
      reply = async () => { throw new TypeError("network down"); };
      assert.equal(await resolveCodexClientVersion(), CODEX_CLIENT_VERSION);
      assert.ok(requested.every((url) => url === CODEX_LATEST_RELEASE_URL));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const codexTestSettings = (): ResearchProviderSettings => ({
    id: "codex-test",
    name: "Codex",
    preset: "openai_codex",
    protocol: "responses",
    authMode: "chatgpt_oauth",
    authHeaderName: "Authorization",
    authHeaderPrefix: "Bearer ",
    endpoint: "https://chatgpt.com/backend-api/codex",
    apiKey: serializeCodexCredentials(credentialsFromTokenResponse({ access_token: accessToken, refresh_token: "r1", id_token: idToken })),
    saveApiKey: false,
    models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    model: "gpt-5.5",
    fastModel: "",
    synthesisModel: "",
    auditModel: "",
    webSearchMode: "auto",
    thinkingLevel: "auto",
    maxConcurrency: 1,
    maxOutputTokens: 8000,
    requestTimeoutSeconds: 30,
  });

  test("verifies Codex native web search with the CLI's live-search tool", async () => {
    const originalFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      const stream = [
        { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
        { type: "response.web_search_call.searching", item_id: "ws_1" },
        { type: "response.web_search_call.completed", item_id: "ws_1" },
        { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "openai api docs" } } },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://platform.openai.com/docs", title: "OpenAI docs" } },
        { type: "response.output_text.delta", delta: "See the docs." },
        { type: "response.completed", response: {} },
      ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n");
      // No event-stream content type: the stream must still be parsed.
      return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
    };
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testWebSearch();
      assert.deepEqual(body.tools, [{ type: "web_search", external_web_access: true }]);
      assert.equal(body.tool_choice, "required", "a capability diagnostic must not leave searching optional");
      assert.deepEqual(body.reasoning, { effort: "low" }, "the diagnostic should not inherit a slow research thinking level");
      assert.deepEqual(result.sources.map((source) => source.url), ["https://platform.openai.com/docs"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A stream that sends its events but never closes, like a kept-alive connection.
  const openStream = (events: unknown[]) => new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  });

  test("stops reading a Codex stream at response.completed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.web_search_call.completed", item_id: "ws_1" },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://platform.openai.com/docs", title: "OpenAI docs" } },
      { type: "response.output_text.delta", delta: "See the docs." },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      const result = await new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }).testWebSearch();
      assert.equal(result.sources.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("recognises Codex web_search_call items without citations", async () => {
    const codexStream = () => openStream([
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["openai api docs", "responses api"] } } },
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_2", status: "in_progress" } },
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url: "https://platform.openai.com/docs/api-reference" } } },
      { type: "response.output_text.delta", delta: "See [the docs](https://platform.openai.com/docs)." },
      { type: "response.completed", response: {} },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(codexStream(), { headers: { "content-type": "text/event-stream" } });
    try {
      const provider = new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 });
      const result = await provider.testWebSearch();
      assert.deepEqual(result.queries, ["openai api docs", "responses api"]);
      assert.deepEqual(result.sources.map((source) => source.url), ["https://platform.openai.com/docs/api-reference"]);

      const phases: string[] = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "research" }], enableWebSearch: true })) {
        if (event.type === "web_search") phases.push(event.phase);
      }
      assert.ok(phases.includes("searching") && phases.includes("completed"));
      assert.equal(phases.includes("unverified"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("verifies a Codex search that returned no pages or citations", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "openai api docs" } } },
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      const result = await new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }).testWebSearch();
      assert.equal(result.sources.length, 0);
      assert.match(result.message, /1 条查询/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports reasoning before the answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_text.delta", delta: "Checking filings" },
      { type: "response.output_text.delta", delta: "Done." },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      const types: string[] = [];
      for await (const event of new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }).run({ messages: [{ role: "user", content: "hi" }] })) types.push(event.type);
      assert.deepEqual(types, ["response_started", "reasoning", "reasoning", "delta", "done"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces response.failed from a Codex stream", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.created", response: {} },
      { type: "response.failed", response: { error: { code: "server_error", message: "Web search is unavailable for this model" } } },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(
        new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }).testWebSearch(),
        /Web search is unavailable for this model/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads a kept-alive octet-stream incrementally instead of buffering the entire body", { timeout: 1000 }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_item.added", item: { type: "reasoning" } },
      { type: "response.output_item.done", item: { type: "web_search_call", status: "completed", action: { type: "search", query: "OpenAI docs" } } },
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "application/octet-stream" } });
    try {
      const types: string[] = [];
      for await (const event of new OpenAICompatibleProvider(codexTestSettings()).run({ messages: [{ role: "user", content: "research" }], enableWebSearch: true })) types.push(event.type);
      assert.ok(types.indexOf("reasoning") < types.indexOf("delta"));
      assert.equal(types.at(-1), "done");
      assert.equal(types.includes("web_search"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads a headerless kept-alive SSE body as soon as events arrive", { timeout: 1000 }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_item.added", item: { type: "reasoning" } },
      { type: "response.output_text.delta", delta: "Headerless answer" },
      { type: "response.completed", response: {} },
    ]));
    try {
      const events = [];
      for await (const event of new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 0.1 }).run({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
      assert.ok(events.some((event) => event.type === "reasoning"));
      assert.equal(events.find((event) => event.type === "delta")?.text, "Headerless answer");
      assert.equal(events.at(-1)?.type, "done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps body-read failures instead of converting them to an empty HTTP 200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("connection reset while reading")); },
    }));
    try {
      await assert.rejects(
        new OpenAICompatibleProvider(codexTestSettings()).testConnection(),
        (error: unknown) => error instanceof Error && /connection reset while reading/.test(error.message) && !/空响应/.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Emits events on a timer; stops after `count` (or never, when count is Infinity).
  const tickingStream = (events: (index: number) => unknown, everyMs: number, count: number) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        timer = setInterval(() => {
          if (index >= count) return;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events(index))}\n\n`));
          index += 1;
        }, everyMs);
      },
      cancel() { clearInterval(timer); },
    });
  };

  test("lets a research stream that keeps delivering data outlive the request timeout", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    const steps = 8;
    globalThis.fetch = async () => new Response(tickingStream((index) => index === steps - 1
      ? { type: "response.completed", response: {} }
      : index % 2 ? { type: "response.web_search_call.searching", item_id: `ws_${index}` } : { type: "response.output_text.delta", delta: "." }, 100, steps));
    try {
      // 0.3 s request timeout, ~0.8 s of streaming: only silence may fail a started stream.
      const provider = new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 0.3 }, { idleMs: 300 });
      const types: string[] = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "research" }], enableWebSearch: true })) types.push(event.type);
      assert.equal(types.at(-1), "done");
      assert.equal(types.filter((type) => type === "delta").length, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails a started stream only after it goes silent", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(tickingStream(() => ({ type: "response.web_search_call.searching", item_id: "ws_1" }), 20, 3));
    try {
      await assert.rejects(
        (async () => {
          for await (const _event of new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }, { idleMs: 200 }).run({ messages: [{ role: "user", content: "research" }] })) void _event;
        })(),
        /没有新数据.*3 个事件.*最后事件 response\.web_search_call\.searching/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caps a stream that never finishes", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(tickingStream(() => ({ type: "response.output_text.delta", delta: "." }), 20, Infinity));
    try {
      await assert.rejects(
        (async () => {
          for await (const _event of new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 5 }, { idleMs: 1000, maxMs: 300 }).run({ messages: [{ role: "user", content: "research" }] })) void _event;
        })(),
        /仍未完成/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const doneStream = () => openStream([{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: {} }]);
  // Delivers `events`, then fails the read the way a dropped connection does.
  const droppingStream = (events: unknown[]) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      setTimeout(() => controller.error(new TypeError("network error")), 5);
    },
  });
  const collect = async (provider: OpenAICompatibleProvider) => {
    const events = [];
    for await (const event of provider.run({ messages: [{ role: "user", content: "research" }] })) events.push(event);
    return events;
  };

  test("retries a request that fails before any HTTP response", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls <= 2) throw new TypeError("Failed to fetch");
      return new Response(doneStream(), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const events = await collect(new OpenAICompatibleProvider(codexTestSettings(), { retryBaseMs: 1 }));
      assert.equal(calls, 3);
      assert.deepEqual(events.filter((event) => event.type === "retry").map((event) => event.type === "retry" ? event.attempt : 0), [1, 2]);
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "OK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries a stream that drops before any answer text", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(calls === 1
        ? droppingStream([{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } }])
        : doneStream(), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const events = await collect(new OpenAICompatibleProvider(codexTestSettings(), { retryBaseMs: 1 }));
      assert.equal(calls, 2);
      assert.equal(events.at(-1)?.type, "done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("restarts a stream that drops mid-answer and tells consumers to discard the partial text", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(calls === 1
        ? droppingStream([{ type: "response.output_text.delta", delta: "Half an answer" }])
        : doneStream(), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const events = await collect(new OpenAICompatibleProvider(codexTestSettings(), { retryBaseMs: 1 }));
      assert.equal(calls, 2);
      const retry = events.find((event) => event.type === "retry");
      assert.equal(retry?.type === "retry" && retry.discardOutput, true);
      assert.match(retry?.type === "retry" ? retry.reason : "", /距上次数据 \d+ 秒 · 已持续 \d+ 秒/);
      // What a consumer keeps: text after the last discarding retry.
      let text = "";
      for (const event of events) {
        if (event.type === "retry" && event.discardOutput) text = "";
        if (event.type === "delta") text += event.text;
      }
      assert.equal(text, "OK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("names the stage after retries are exhausted and never retries auth errors", { timeout: 5000 }, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    };
    try {
      await assert.rejects(collect(new OpenAICompatibleProvider(codexTestSettings(), { retryBaseMs: 1 })), /无法连接模型服务（Failed to fetch · 登录凭据已就绪，等待 Codex \/responses 接口返回响应头）/);
      assert.equal(calls, 4);
      calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
      };
      await assert.rejects(collect(new OpenAICompatibleProvider(codexTestSettings(), { retryBaseMs: 1 })), /Forbidden/);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("times out a headerless body that stops delivering data", { timeout: 1000 }, async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start() {},
      cancel() { cancelled = true; },
    }));
    try {
      await assert.rejects(
        new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 0.02 }).testConnection(),
        /模型响应超时.*HTTP 200.*正文数据为 0 字节/,
      );
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("identifies a request stalled after credentials are ready but before response headers", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Promise<Response>(() => {});
    try {
      await assert.rejects(
        new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 0.02 }).testConnection(),
        /登录凭据已就绪，等待 Codex \/responses 接口返回响应头/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports received bytes and safe event names when an active response does not finish", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.created", response: { metadata: { private_context: "PRIVATE_TEST_SENTINEL" } } },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(
        new OpenAICompatibleProvider({ ...codexTestSettings(), requestTimeoutSeconds: 0.02 }).testConnection(),
        (error: unknown) => error instanceof Error
          && /已收到 \d+ 字节、1 个事件/.test(error.message)
          && /最后事件 response.created/.test(error.message)
          && !/PRIVATE_TEST_SENTINEL/.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses a minimal low-effort connection diagnostic without changing research settings", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openStream([
        { type: "response.output_text.delta", delta: "OK" },
        { type: "response.completed", response: {} },
      ]), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = new OpenAICompatibleProvider({ ...codexTestSettings(), thinkingLevel: "high", requestTimeoutSeconds: 180 });
      assert.equal((await provider.testConnection()).message, "OK");
      const events = [];
      for await (const event of provider.run({ messages: [{ role: "user", content: "Research" }] })) events.push(event);
      assert.ok(events.length > 0);
      assert.deepEqual(bodies.map((body) => body.reasoning), [{ effort: "low" }, { effort: "high" }]);
      assert.equal(bodies[0]?.tools, undefined);
      assert.equal(bodies[0]?.tool_choice, undefined);
      assert.deepEqual(Object.keys(bodies[0]!).slice(0, 2), ["model", "stream"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not report a successful connection for a stream that produced no answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.created", response: {} },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(new OpenAICompatibleProvider(codexTestSettings()).testConnection(), /模型连接测试未收到回答/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("still parses JSON when the provider omitted content-type", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new TextEncoder().encode(JSON.stringify({ output_text: "JSON without headers" })));
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testConnection();
      assert.equal(result.message, "JSON without headers");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports a truly empty headerless body without claiming a timeout or success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null);
    try {
      await assert.rejects(new OpenAICompatibleProvider(codexTestSettings()).testConnection(), /HTTP 200 · no content-type · 响应体 0 字节/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("finishes at the terminal event even if transport cancellation never acknowledges", { timeout: 1000 }, async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{}}\n\n'));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }), { headers: { "content-type": "text/event-stream" } });
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testConnection();
      assert.equal(result.message, "OK");
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("recognises searches supplied only in the final response output", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.completed", response: { output: [{ type: "web_search_call", status: "completed", action: { type: "search", query: "OpenAI docs" } }] } },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testWebSearch();
      assert.deepEqual(result.queries, ["OpenAI docs"]);
      assert.equal(result.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts an explicit search completion without exposed query text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.web_search_call.completed", item_id: "ws1" },
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testWebSearch();
      assert.match(result.message, /搜索工具已完成/);
      assert.deepEqual(result.queries, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads sources in the web-search action without relying on text annotations", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      output_text: "Found it.",
      output: [{ type: "web_search_call", status: "completed", action: { type: "search", query: "OpenAI docs", sources: [{ url: "https://platform.openai.com/docs", title: "OpenAI docs" }] } }],
    }), { headers: { "content-type": "application/json" } });
    try {
      const result = await new OpenAICompatibleProvider(codexTestSettings()).testWebSearch();
      assert.deepEqual(result.sources.map((source) => source.url), ["https://platform.openai.com/docs"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not claim verification when the model only returned an answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(openStream([
      { type: "response.output_text.delta", delta: "Here is a link from memory: https://platform.openai.com/docs" },
      { type: "response.completed", response: {} },
    ]), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(new OpenAICompatibleProvider(codexTestSettings()).testWebSearch(), /未返回可验证/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports what a non-streaming Codex reply contained", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Tool web_search is not enabled for this account" }), { headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(
        new OpenAICompatibleProvider(codexTestSettings()).testWebSearch(),
        /HTTP 200 · application\/json.*Tool web_search is not enabled for this account/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streams research requests through the Codex backend", async () => {
    const credentials = credentialsFromTokenResponse({ access_token: accessToken, refresh_token: "r1", id_token: idToken });
    const settings: ResearchProviderSettings = {
      id: "codex-test",
      name: "Codex",
      preset: "openai_codex",
      protocol: "responses",
      authMode: "chatgpt_oauth",
      authHeaderName: "Authorization",
      authHeaderPrefix: "Bearer ",
      endpoint: "https://chatgpt.com/backend-api/codex",
      apiKey: serializeCodexCredentials(credentials),
      saveApiKey: false,
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      model: "gpt-5.5",
      fastModel: "",
      synthesisModel: "",
      auditModel: "",
      webSearchMode: "auto",
      thinkingLevel: "auto",
      maxConcurrency: 1,
      maxOutputTokens: 8000,
      requestTimeoutSeconds: 30,
    };
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body));
      const stream = [
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"O\"}",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"K\"}",
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}",
        "",
      ].join("\n\n");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const events = [];
      for await (const event of new OpenAICompatibleProvider(settings).run({
        messages: [{ role: "system", content: "Be precise." }, { role: "user", content: "hello" }],
      })) events.push(event);
      assert.equal(requestedUrl, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(headers["chatgpt-account-id"], "acct-123");
      assert.equal(body.instructions, "Be precise.");
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal("tool_choice" in body, false, "normal research should retain automatic tool selection");
      assert.equal("max_output_tokens" in body, false);
      assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "OK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
