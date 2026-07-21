import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { effectiveResearchThinkingLevel, getResearchThinkingControl } from "./thinkingCapabilities";
import type { ResearchProviderSettings } from "./types";

const base: ResearchProviderSettings = {
  id: "thinking-test",
  name: "Thinking Test",
  preset: "custom",
  protocol: "chat_completions",
  authMode: "bearer",
  authHeaderName: "Authorization",
  authHeaderPrefix: "Bearer ",
  endpoint: "https://example.com/v1",
  apiKey: "key",
  saveApiKey: false,
  models: [],
  model: "",
  fastModel: "",
  synthesisModel: "",
  auditModel: "",
  webSearchMode: "off",
  thinkingLevel: "auto",
  maxConcurrency: 1,
  maxOutputTokens: 8000,
  requestTimeoutSeconds: 30,
};

function values(settings: ResearchProviderSettings) {
  return getResearchThinkingControl(settings).options.map((option) => option.value);
}

describe("protocol-aware thinking controls", () => {
  test("uses model-list reasoning metadata before provider defaults", () => {
    const settings: ResearchProviderSettings = {
      ...base,
      preset: "openrouter",
      models: [{
        id: "mandatory-model",
        name: "Mandatory model",
        reasoning: {
          supportedEfforts: ["minimal", "low", "high"],
          defaultEffort: "low",
          mandatory: true,
        },
      }],
      model: "mandatory-model",
    };
    assert.deepEqual(values(settings), ["auto", "minimal", "low", "high"]);
    assert.equal(getResearchThinkingControl(settings).source, "model");
  });

  test("distinguishes Gemini 2.5 budgets from Gemini 3 levels", () => {
    assert.deepEqual(values({ ...base, protocol: "gemini_native", model: "gemini-2.5-flash" }), ["auto", "off", "low", "medium", "high"]);
    assert.deepEqual(values({ ...base, protocol: "gemini_native", model: "gemini-3.1-pro-preview" }), ["auto", "low", "medium", "high"]);
    assert.deepEqual(values({ ...base, protocol: "gemini_native", model: "gemini-3.5-flash" }), ["auto", "minimal", "low", "medium", "high"]);
  });

  test("distinguishes Ollama boolean thinking from GPT-OSS levels", () => {
    assert.deepEqual(values({ ...base, protocol: "ollama_chat", model: "qwen3:8b" }), ["auto", "off", "enabled"]);
    assert.deepEqual(values({ ...base, protocol: "ollama_chat", model: "gpt-oss:20b" }), ["auto", "low", "medium", "high"]);
  });

  test("only exposes extended Claude levels to recognized models", () => {
    assert.deepEqual(values({ ...base, protocol: "anthropic_messages", model: "claude-haiku-4-5" }), ["auto", "off", "low", "medium", "high"]);
    assert.deepEqual(values({ ...base, protocol: "anthropic_messages", model: "claude-opus-4-6" }), ["auto", "off", "low", "medium", "high", "max"]);
    assert.deepEqual(values({ ...base, protocol: "anthropic_messages", model: "claude-opus-4-8" }), ["auto", "off", "low", "medium", "high", "xhigh", "max"]);
  });

  test("keeps advanced Ark Responses levels selectable when model metadata is absent", () => {
    assert.deepEqual(values({
      ...base,
      preset: "volcengine_agent_plan",
      protocol: "responses",
      model: "glm-5.2",
    }), ["auto", "off", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(values({
      ...base,
      preset: "volcengine_agent_plan",
      protocol: "responses",
      model: "deepseek-v4-pro",
    }), ["auto", "off", "low", "medium", "high", "xhigh", "max"]);
  });

  test("downgrades unsupported high-effort preferences to the model's strongest supported level", () => {
    assert.equal(effectiveResearchThinkingLevel({
      ...base,
      preset: "volcengine_agent_plan",
      protocol: "responses",
      model: "glm-5.2",
      thinkingLevel: "max",
    }), "max");
    assert.equal(effectiveResearchThinkingLevel({
      ...base,
      protocol: "gemini_native",
      model: "gemini-2.5-flash",
      thinkingLevel: "xhigh",
    }), "high");
    assert.equal(effectiveResearchThinkingLevel({
      ...base,
      models: [{
        id: "medium-only",
        name: "Medium only",
        reasoning: { supportedEfforts: ["low", "medium"] },
      }],
      model: "medium-only",
      thinkingLevel: "max",
    }), "medium");
  });

  test("does not invent a universal effort field for unsupported presets", () => {
    assert.deepEqual(values({ ...base, preset: "deepseek", model: "deepseek-reasoner" }), ["auto"]);
  });
});
