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
      assert.deepEqual(result.sources.map((source) => source.url), ["https://platform.openai.com/docs"]);
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
      assert.equal("max_output_tokens" in body, false);
      assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.type === "delta" ? event.text : "").join(""), "OK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
