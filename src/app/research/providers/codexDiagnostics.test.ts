import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { credentialsFromTokenResponse, serializeCodexCredentials } from "./codexAuth";
import { formatCodexDiagnostics, runCodexDiagnostics } from "./codexDiagnostics";

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

const accessToken = jwt({ exp: 2_000_000_000 });
const apiKey = serializeCodexCredentials(credentialsFromTokenResponse({
  access_token: accessToken,
  refresh_token: "r1",
  id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }),
}));
const input = { profileId: "diag", apiKey, endpoint: "https://chatgpt.com/backend-api/codex", model: "gpt-5.5" };

type Handler = (url: URL, init?: RequestInit) => Promise<Response>;

async function withFetch<T>(handler: Handler, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => handler(new URL(String(request)), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("Codex connection diagnostics", () => {
  test("passes every hop and keeps credentials out of the report", async () => {
    const steps = await withFetch(async (url, init) => {
      if (url.hostname === "registry.npmjs.org") throw new TypeError("offline");
      if (url.hostname === "auth.openai.com") return new Response("{}", { headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/models")) {
        const authorized = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
        return authorized
          ? new Response(JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }] }), { headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(sse([{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: {} }]), { headers: { "content-type": "text/event-stream" } });
    }, () => runCodexDiagnostics(input));
    assert.deepEqual(steps.map((step) => `${step.id}:${step.status}`), [
      "permissions:skip", "reach_chatgpt:ok", "reach_auth:ok", "credentials:ok", "models:ok", "responses:ok",
    ]);
    const report = formatCodexDiagnostics(steps, input.model);
    assert.equal(report.includes(accessToken), false);
    assert.match(report, /HTTP 401/);
  });

  test("pins a browser network failure and skips authenticated calls", async () => {
    const steps = await withFetch(async (url) => {
      if (url.hostname === "chatgpt.com") throw new TypeError("Failed to fetch");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }, () => runCodexDiagnostics(input));
    const byId = Object.fromEntries(steps.map((step) => [step.id, step]));
    assert.equal(byId.reach_chatgpt?.status, "fail");
    assert.match(byId.reach_chatgpt?.detail ?? "", /网络层失败（Failed to fetch）/);
    assert.equal(byId.models?.status, "skip");
    assert.equal(byId.responses?.status, "skip");
  });

  test("reports where a /responses request stalls", async () => {
    const steps = await withFetch(async (url, init) => {
      if (url.hostname === "registry.npmjs.org") throw new TypeError("offline");
      if (url.pathname.endsWith("/responses")) {
        // Headers arrive, then the stream stays silent.
        return new Response(new ReadableStream({ start() { /* never enqueues */ } }), { headers: { "content-type": "text/event-stream" } });
      }
      const authorized = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (url.pathname.endsWith("/models") && authorized) return new Response(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }), { headers: { "content-type": "application/json" } });
      return new Response("{}", { status: url.hostname === "chatgpt.com" ? 401 : 200, headers: { "content-type": "application/json" } });
    }, () => runCodexDiagnostics({ ...input, timeoutsMs: { responses: 200 } }));
    const responses = steps.find((step) => step.id === "responses");
    assert.equal(responses?.status, "fail");
    assert.match(responses?.detail ?? "", /卡在：已收到响应头.*等待首字节/);
  });

  test("flags a Cloudflare challenge on the unauthenticated probe", async () => {
    const steps = await withFetch(async (url) => {
      if (url.hostname === "chatgpt.com") return new Response("<html>challenge</html>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }, () => runCodexDiagnostics({ ...input, apiKey: "" }));
    const reach = steps.find((step) => step.id === "reach_chatgpt");
    assert.equal(reach?.status, "warn");
    assert.match(reach?.detail ?? "", /cf-mitigated: challenge/);
    assert.equal(steps.find((step) => step.id === "credentials")?.status, "fail");
  });
});
