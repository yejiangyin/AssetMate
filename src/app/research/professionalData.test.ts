import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createResearchJob } from "./orchestrator";
import {
  VOLCENGINE_DATAPRO_MCP_ENDPOINT,
  VolcengineDataProMcpClient,
  buildProfessionalDataQueries,
  professionalDataEvidenceMessage,
} from "./professionalData";

describe("Volcengine DataPro MCP", () => {
  test("initializes a Streamable HTTP session and reuses the Agent Plan key", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), VOLCENGINE_DATAPRO_MCP_ENDPOINT);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ headers, body });
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "datapro", version: "1" } } }), {
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "query_professional_data", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ dataset_type: "financial", symbol: "AAPL", pe: 30 }) }] } }));
    };
    try {
      const result = await new VolcengineDataProMcpClient("same-agent-plan-key").query("查询 AAPL 财务数据");
      assert.equal(result.datasetType, "financial");
      assert.match(result.content, /AAPL/);
      assert.equal(requests.every((request) => request.headers.get("X-Agent-Plan-Key") === "same-agent-plan-key"), true);
      assert.equal(requests.slice(1).every((request) => request.headers.get("Mcp-Session-Id") === "session-1"), true);
      assert.equal(requests.slice(1).every((request) => request.headers.get("MCP-Protocol-Version") === "2025-03-26"), true);
      const call = requests.find((request) => request.body.method === "tools/call");
      assert.deepEqual((call?.body.params as { arguments?: unknown }).arguments, { query: "查询 AAPL 财务数据" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batches security lookups at the official three-target limit", () => {
    const target = { symbol: "S1", name: "Target 1", market: "US", assetType: "stock", currency: "USD" };
    const job = createResearchJob({
      workflowId: "deep_research",
      target,
      targets: Array.from({ length: 7 }, (_, index) => ({ ...target, symbol: `S${index + 1}`, name: `Target ${index + 1}` })),
      publicContext: { target, generatedAt: "2026-07-20T00:00:00.000Z", dataCutoff: "2026-07-20" },
    });
    const financialQueries = buildProfessionalDataQueries(job).filter((query) => query.includes("金融数据库"));
    assert.equal(financialQueries.length, 3);
    for (const query of financialQueries) {
      const symbols = [...query.matchAll(/（(S\d+)）/g)].map((match) => match[1]);
      assert.ok(symbols.length > 0 && symbols.length <= 3);
    }
  });

  test("labels professional records separately from public URL citations and enforces a prompt budget", () => {
    const message = professionalDataEvidenceMessage({
      requested: true,
      status: "completed",
      endpoint: VOLCENGINE_DATAPRO_MCP_ENDPOINT,
      queries: Array.from({ length: 8 }, (_, index) => `query-${index}`),
      datasetTypes: ["financial"],
      items: Array.from({ length: 8 }, (_, index) => ({ query: `query-${index}`, datasetType: "financial", content: "x".repeat(20_000) })),
      errors: [],
    });
    assert.match(message, /专业数据集 \[D序号\]/);
    assert.match(message, /不得将其伪装成公开网页 URL/);
    assert.ok(message.length < 65_000);
  });
});
