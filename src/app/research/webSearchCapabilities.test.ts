import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getResearchWebSearchCapability } from "./webSearchCapabilities";

describe("research web-search capabilities", () => {
  test("requires the provider-specific protocol instead of enabling every Chat endpoint", () => {
    assert.equal(getResearchWebSearchCapability({ preset: "openai", protocol: "chat_completions", model: "gpt-test" }).supported, false);
    assert.equal(getResearchWebSearchCapability({ preset: "openai", protocol: "responses", model: "gpt-test" }).adapter, "openai_responses");
    assert.equal(getResearchWebSearchCapability({ preset: "anthropic", protocol: "anthropic_messages", model: "claude-test" }).adapter, "anthropic_server");
    assert.equal(getResearchWebSearchCapability({ preset: "google_gemini", protocol: "gemini_native", model: "gemini-test" }).adapter, "gemini_grounding");
    assert.equal(getResearchWebSearchCapability({ preset: "deepseek", protocol: "chat_completions", model: "deepseek-chat" }).supported, false);
  });

  test("allows custom services only when the selected native protocol defines search", () => {
    assert.equal(getResearchWebSearchCapability({ preset: "custom", protocol: "chat_completions", model: "custom" }).supported, false);
    assert.equal(getResearchWebSearchCapability({ preset: "custom", protocol: "responses", model: "custom" }).adapter, "openai_responses");
    assert.equal(getResearchWebSearchCapability({ preset: "custom", protocol: "anthropic_messages", model: "custom" }).adapter, "anthropic_server");
  });

  test("routes Agent Plan browsing to its separate Harness search connection", () => {
    const capability = getResearchWebSearchCapability({
      preset: "volcengine_agent_plan",
      protocol: "responses",
      model: "glm-5.2",
    });
    assert.equal(capability.supported, false);
    assert.equal(capability.modelDependent, false);
    assert.match(capability.reasonZh, /独立 Harness/);
    assert.match(capability.reasonZh, /联网搜索/);
  });

  test("does not let a stale diagnostic override Agent Plan's separate search architecture", () => {
    const capability = getResearchWebSearchCapability({
      preset: "volcengine_agent_plan",
      protocol: "responses",
      model: "glm-5.2",
      nativeWebSearchVerification: {
        model: "glm-5.2",
        protocol: "responses",
        status: "failed",
        checkedAt: "2026-07-20T00:00:00.000Z",
        message: "temporary provider error",
      },
    });
    assert.equal(capability.supported, false);
    assert.match(capability.reasonZh, /模型 API Key 不会自动启用/);
  });
});
