import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  clearResearchLibrary,
  createResearchExternalSearchProfile,
  createResearchProviderProfile,
  loadResearchExternalSearchProfiles,
  loadResearchProviderProfiles,
  loadResearchProviderSettings,
  loadResearchExternalSearchSettings,
  saveResearchExternalSearchSettings,
  saveResearchExternalSearchProfiles,
  saveResearchProviderProfiles,
} from "./storage";

const values: Record<string, unknown> = {};
const sessionValues: Record<string, unknown> = {};
const originalChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

before(() => {
  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (items: Record<string, unknown>) => { Object.assign(values, items); },
        remove: async (key: string) => { delete values[key]; },
      },
      session: {
        get: async (key: string) => ({ [key]: sessionValues[key] }),
        set: async (items: Record<string, unknown>) => { Object.assign(sessionValues, items); },
        remove: async (key: string) => { delete sessionValues[key]; },
      },
    },
  };
});

after(() => {
  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = originalChrome;
});

describe("research provider profile storage", () => {
  test("stores multiple independently keyed API connections and active selection", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const ark = createResearchProviderProfile({
      name: "Ark",
      preset: "volcengine_ark",
      protocol: "responses",
      endpoint: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-test",
      apiKey: "ark-secret",
      saveApiKey: true,
    });
    const plan = createResearchProviderProfile({
      name: "Agent Plan",
      preset: "volcengine_agent_plan",
      protocol: "responses",
      endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
      model: "plan-model",
      apiKey: "plan-secret",
      saveApiKey: true,
    });
    await saveResearchProviderProfiles({ activeProfileId: plan.id, profiles: [ark, plan] });

    const loaded = await loadResearchProviderProfiles();
    assert.equal(loaded.profiles.length, 2);
    assert.equal(loaded.activeProfileId, plan.id);
    assert.equal((await loadResearchProviderSettings()).apiKey, "plan-secret");
    assert.equal(loaded.profiles.find((profile) => profile.id === ark.id)?.apiKey, "ark-secret");

    const storedProfiles = JSON.stringify(values["asset-helper:research-providers:v2"]);
    assert.equal(storedProfiles.includes("ark-secret"), false);
    assert.equal(storedProfiles.includes("plan-secret"), false);
    assert.deepEqual(values["asset-helper:research-api-keys:v2"], {
      [ark.id]: "ark-secret",
      [plan.id]: "plan-secret",
    });
  });

  test("shares unsaved keys through extension session storage without persisting them locally", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    Object.keys(sessionValues).forEach((key) => delete sessionValues[key]);
    const profile = createResearchProviderProfile({ name: "Session only", apiKey: "session-secret", saveApiKey: false });
    await saveResearchProviderProfiles({ activeProfileId: profile.id, profiles: [profile] });

    assert.equal(JSON.stringify(values).includes("session-secret"), false);
    assert.deepEqual(sessionValues["asset-helper:research-session-api-keys:v1"], { [profile.id]: "session-secret" });
    const loaded = await loadResearchProviderProfiles();
    assert.equal(loaded.profiles[0]?.apiKey, "session-secret");
  });

  test("migrates the previous single connection without losing its saved key", async () => {
    await clearResearchLibrary({ includeSettings: true, includeApiKey: true });
    values["asset-helper:research-provider:v1"] = {
      endpoint: "https://legacy.example/v1/chat/completions",
      model: "legacy-model",
      fastModel: "",
      saveApiKey: true,
      webSearchMode: "off",
      maxConcurrency: 2,
      maxOutputTokens: 4000,
      requestTimeoutSeconds: 60,
      hasSavedApiKey: true,
    };
    values["asset-helper:research-api-key:v1"] = "legacy-secret";

    const migrated = await loadResearchProviderProfiles();
    assert.equal(migrated.profiles.length, 1);
    assert.equal(migrated.profiles[0]?.model, "legacy-model");
    assert.deepEqual(migrated.profiles[0]?.models, [{ id: "legacy-model", name: "legacy-model" }]);
    assert.equal(migrated.profiles[0]?.apiKey, "legacy-secret");
    assert.equal(migrated.profiles[0]?.authMode, "bearer");
    assert.equal(migrated.profiles[0]?.thinkingLevel, "auto");
    assert.equal(migrated.profiles[0]?.webSearchMode, "auto");
    assert.equal(values["asset-helper:research-provider:v1"], undefined);
    assert.ok(values["asset-helper:research-providers:v2"]);
  });

  test("preserves native protocol, custom auth and thinking depth settings", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const profile = createResearchProviderProfile({
      name: "Gemini native",
      preset: "google_gemini",
      protocol: "gemini_native",
      authMode: "custom_header",
      authHeaderName: "X-Custom-Key",
      authHeaderPrefix: "Token ",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-secret",
      saveApiKey: true,
      thinkingLevel: "high",
    });
    await saveResearchProviderProfiles({ activeProfileId: profile.id, profiles: [profile] });
    const loaded = (await loadResearchProviderProfiles()).profiles[0]!;
    assert.equal(loaded.protocol, "gemini_native");
    assert.equal(loaded.authMode, "custom_header");
    assert.equal(loaded.authHeaderName, "X-Custom-Key");
    assert.equal(loaded.authHeaderPrefix, "Token ");
    assert.equal(loaded.thinkingLevel, "high");
  });

  test("persists model roles and reasoning capability metadata", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const profile = createResearchProviderProfile({
      model: "research-model",
      fastModel: "fast-model",
      synthesisModel: "synthesis-model",
      auditModel: "audit-model",
      models: [
        { id: "research-model", name: "Research", reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high" } },
        { id: "fast-model", name: "Fast" },
        { id: "synthesis-model", name: "Synthesis" },
        { id: "audit-model", name: "Audit" },
      ],
    });
    await saveResearchProviderProfiles({ activeProfileId: profile.id, profiles: [profile] });
    const loaded = (await loadResearchProviderProfiles()).profiles[0]!;
    assert.equal(loaded.synthesisModel, "synthesis-model");
    assert.equal(loaded.auditModel, "audit-model");
    assert.deepEqual(loaded.models[0]?.reasoning?.supportedEfforts, ["low", "high", "max"]);
  });

  test("persists per-workflow API routes and drops references to deleted connections", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const execution = createResearchProviderProfile({ id: "exec", name: "Execution" });
    const synthesis = createResearchProviderProfile({ id: "synth", name: "Synthesis" });
    const dataPro = createResearchProviderProfile({ id: "plan", name: "Agent Plan", preset: "volcengine_agent_plan" });
    await saveResearchProviderProfiles({
      activeProfileId: execution.id,
      profiles: [execution, synthesis, dataPro],
      workflowRoutes: {
        deep_research: {
          executionProfileId: execution.id,
          executionModelRole: "fast",
          synthesisProfileId: synthesis.id,
          auditProfileId: "deleted-profile",
          professionalDataProfileId: dataPro.id,
        },
      },
    });

    const loaded = await loadResearchProviderProfiles();
    assert.deepEqual(loaded.workflowRoutes?.deep_research, {
      executionProfileId: execution.id,
      executionModelRole: "fast",
      synthesisProfileId: synthesis.id,
      auditProfileId: undefined,
      auditDisabled: false,
      professionalDataProfileId: dataPro.id,
    });
  });

  test("allows larger output token caps for long report exports", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const profile = createResearchProviderProfile({ maxOutputTokens: 512000 });
    await saveResearchProviderProfiles({ activeProfileId: profile.id, profiles: [profile] });
    const loaded = (await loadResearchProviderProfiles()).profiles[0]!;
    assert.equal(loaded.maxOutputTokens, 256000);
  });

  test("stores external-search configuration separately from its API key", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    await saveResearchExternalSearchSettings({
      id: "search-brave",
      name: "Brave 主搜索",
      provider: "brave",
      endpoint: "https://api.search.brave.com/res/v1/web/search",
      apiKey: "brave-secret",
      saveApiKey: true,
      authHeaderName: "X-Subscription-Token",
      authHeaderPrefix: "",
      maxResults: 10,
      maxSources: 25,
      timeRange: "week",
      includeDomains: "sec.gov",
      excludeDomains: "example.com",
      fetchPageContent: true,
      maxPages: 2,
      requestTimeoutSeconds: 45,
    });
    const stored = JSON.stringify(values["asset-helper:research-external-search-profiles:v2"]);
    assert.equal(stored.includes("brave-secret"), false);
    assert.deepEqual(values["asset-helper:research-external-search-keys:v2"], { "search-brave": "brave-secret" });
    const loaded = await loadResearchExternalSearchSettings();
    assert.equal(loaded.provider, "brave");
    assert.equal(loaded.apiKey, "brave-secret");
    assert.equal(loaded.maxResults, 10);
    assert.equal(loaded.maxSources, 25);
  });

  test("upgrades legacy default search budgets without overwriting custom values", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    values["asset-helper:research-external-search:v1"] = {
      provider: "tavily",
      endpoint: "https://api.tavily.com/search",
      maxResults: 8,
      maxPages: 3,
      fetchPageContent: true,
      hasSavedApiKey: false,
    };
    const upgraded = await loadResearchExternalSearchSettings();
    assert.equal(upgraded.maxResults, 10);
    assert.equal(upgraded.maxSources, 20);
    assert.equal(upgraded.maxPages, 8);
    assert.equal(values["asset-helper:research-external-search:v1"], undefined);

    Object.keys(values).forEach((key) => delete values[key]);
    values["asset-helper:research-external-search:v1"] = {
      provider: "tavily",
      endpoint: "https://api.tavily.com/search",
      maxResults: 12,
      maxPages: 5,
      fetchPageContent: true,
      hasSavedApiKey: false,
    };
    const preserved = await loadResearchExternalSearchSettings();
    assert.equal(preserved.maxResults, 12);
    assert.equal(preserved.maxPages, 5);
  });

  test("stores multiple search connections and resolves the selected active one", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const tavily = createResearchExternalSearchProfile({ name: "Tavily A", provider: "tavily", apiKey: "tavily-key" });
    const exa = createResearchExternalSearchProfile({ name: "Exa B", provider: "exa", apiKey: "exa-key", saveApiKey: true });
    await saveResearchExternalSearchProfiles({ activeProfileId: exa.id, profiles: [tavily, exa] });
    const collection = await loadResearchExternalSearchProfiles();
    assert.equal(collection.profiles.length, 2);
    assert.equal(collection.activeProfileId, exa.id);
    assert.equal((await loadResearchExternalSearchSettings()).name, "Exa B");
    assert.equal((await loadResearchExternalSearchSettings()).apiKey, "exa-key");
  });

  test("keeps larger external-search budgets while respecting provider request limits", async () => {
    Object.keys(values).forEach((key) => delete values[key]);
    const exa = createResearchExternalSearchProfile({
      provider: "exa",
      maxResults: 100,
      maxSources: 100,
      fetchPageContent: true,
      maxPages: 50,
    });
    const tavily = createResearchExternalSearchProfile({ provider: "tavily", maxResults: 100 });
    await saveResearchExternalSearchProfiles({ activeProfileId: exa.id, profiles: [exa, tavily] });
    const loaded = await loadResearchExternalSearchProfiles();
    assert.equal(loaded.profiles.find((profile) => profile.id === exa.id)?.maxResults, 100);
    assert.equal(loaded.profiles.find((profile) => profile.id === exa.id)?.maxSources, 100);
    assert.equal(loaded.profiles.find((profile) => profile.id === exa.id)?.maxPages, 50);
    assert.equal(loaded.profiles.find((profile) => profile.id === tavily.id)?.maxResults, 20);
  });

  test("creates a first-class Volcengine Search profile with its official limit", () => {
    const profile = createResearchExternalSearchProfile({ provider: "volcengine_search", maxResults: 100 });
    assert.equal(profile.name, "方舟联网搜索");
    assert.equal(profile.endpoint, "https://open.feedcoopapi.com/search_api/web_search");
    assert.equal(profile.authHeaderName, "Authorization");
    assert.equal(profile.authHeaderPrefix, "Bearer ");
    assert.equal(profile.maxResults, 50);
  });
});
