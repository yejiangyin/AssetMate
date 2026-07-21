import type {
  ResearchExternalSearchProvider,
  ResearchExternalSearchCollection,
  ResearchExternalSearchSettings,
  ResearchJob,
  ResearchModelDefinition,
  ResearchProviderCollection,
  ResearchProviderSettings,
  ResearchReport,
  ResearchThinkingLevel,
  ResearchWorkflowId,
  ResearchWorkflowProviderRoute,
  StoredResearchProviderSettings,
  StoredResearchExternalSearchSettings,
} from "./types";

const DB_NAME = "assetmate-research";
const DB_VERSION = 1;
const JOB_STORE = "jobs";
const REPORT_STORE = "reports";
const LEGACY_SETTINGS_KEY = "asset-helper:research-provider:v1";
const LEGACY_API_KEY_STORAGE_KEY = "asset-helper:research-api-key:v1";
const SETTINGS_KEY = "asset-helper:research-providers:v2";
const API_KEY_STORAGE_KEY = "asset-helper:research-api-keys:v2";
const SESSION_API_KEY_STORAGE_KEY = "asset-helper:research-session-api-keys:v1";
const LEGACY_EXTERNAL_SEARCH_SETTINGS_KEY = "asset-helper:research-external-search:v1";
const LEGACY_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY = "asset-helper:research-external-search-key:v1";
const EXTERNAL_SEARCH_SETTINGS_KEY = "asset-helper:research-external-search-profiles:v2";
const EXTERNAL_SEARCH_API_KEY_STORAGE_KEY = "asset-helper:research-external-search-keys:v2";
const SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY = "asset-helper:research-external-search-session-keys:v1";
const DEFAULT_PROFILE_ID = "provider-default";
const DEFAULT_SEARCH_PROFILE_ID = "search-default";
export const MAX_RESEARCH_REPORTS = 500;
export const MAX_RESEARCH_JOBS = 1000;

const PROVIDER_PRESETS: ResearchProviderSettings["preset"][] = [
  "openai",
  "anthropic",
  "xai",
  "volcengine_ark",
  "volcengine_agent_plan",
  "deepseek",
  "alibaba_qwen",
  "zhipu",
  "moonshot",
  "minimax",
  "siliconflow",
  "openrouter",
  "google_gemini",
  "groq",
  "mistral",
  "perplexity",
  "ollama",
  "lm_studio",
  "custom",
];

const API_PROTOCOLS: ResearchProviderSettings["protocol"][] = [
  "chat_completions",
  "responses",
  "anthropic_messages",
  "gemini_native",
  "ollama_chat",
];

const AUTH_MODES: ResearchProviderSettings["authMode"][] = [
  "bearer",
  "x_api_key",
  "x_google_api_key",
  "none",
  "custom_header",
];

const THINKING_LEVELS: ResearchProviderSettings["thinkingLevel"][] = [
  "auto",
  "off",
  "enabled",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function normalizeReasoning(value: unknown): ResearchModelDefinition["reasoning"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const supportedEfforts = Array.isArray(record.supportedEfforts)
    ? record.supportedEfforts.filter((effort): effort is ResearchThinkingLevel => THINKING_LEVELS.includes(effort as ResearchThinkingLevel))
    : undefined;
  const defaultEffort = THINKING_LEVELS.includes(record.defaultEffort as ResearchThinkingLevel)
    ? record.defaultEffort as ResearchThinkingLevel
    : undefined;
  if (!supportedEfforts?.length && !defaultEffort && !record.mandatory && !record.supportsMaxTokens) return undefined;
  return {
    supportedEfforts,
    defaultEffort,
    mandatory: Boolean(record.mandatory),
    supportsMaxTokens: Boolean(record.supportsMaxTokens),
  };
}

const sessionApiKeys = new Map<string, string>();
const sessionExternalSearchApiKeys = new Map<string, string>();
let sessionApiKeyWriteQueue = Promise.resolve();
let sessionExternalSearchApiKeyWriteQueue = Promise.resolve();
const RESEARCH_SYNC_CHANNEL = "asset-helper-research-storage-v1";
const researchStorageListeners = new Set<() => void>();
let researchSyncChannel: BroadcastChannel | null = null;

function ensureResearchSyncChannel() {
  if (researchSyncChannel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return researchSyncChannel;
  researchSyncChannel = new BroadcastChannel(RESEARCH_SYNC_CHANNEL);
  researchSyncChannel.onmessage = () => researchStorageListeners.forEach((listener) => listener());
  return researchSyncChannel;
}

function notifyResearchStorageChanged() {
  researchStorageListeners.forEach((listener) => listener());
  ensureResearchSyncChannel()?.postMessage({ changedAt: Date.now() });
}

export function subscribeResearchStorageChanges(listener: () => void) {
  researchStorageListeners.add(listener);
  ensureResearchSyncChannel();
  return () => {
    researchStorageListeners.delete(listener);
  };
}

type ChromeStorageArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function chromeStorage(areaName: "local" | "session" = "local"): ChromeStorageArea | null {
  const chromeLike = (globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: ChromeStorageArea; session?: ChromeStorageArea } };
  }).chrome;
  return chromeLike?.storage?.[areaName] ?? null;
}

async function readSessionValue<T>(key: string): Promise<T | null> {
  const area = chromeStorage("session");
  if (!area) return null;
  try {
    const result = await area.get(key);
    return (result[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeSessionValue(key: string, value: unknown): Promise<void> {
  const area = chromeStorage("session");
  if (area) {
    await area.set({ [key]: value });
    notifyResearchStorageChanged();
  }
}

async function removeSessionValue(key: string): Promise<void> {
  const area = chromeStorage("session");
  if (area) {
    await area.remove(key);
    notifyResearchStorageChanged();
  }
}

export const DEFAULT_RESEARCH_PROVIDER_SETTINGS: ResearchProviderSettings = {
  id: DEFAULT_PROFILE_ID,
  name: "OpenAI",
  preset: "openai",
  protocol: "responses",
  authMode: "bearer",
  authHeaderName: "Authorization",
  authHeaderPrefix: "Bearer ",
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  saveApiKey: false,
  models: [],
  model: "",
  fastModel: "",
  synthesisModel: "",
  auditModel: "",
  webSearchMode: "auto",
  thinkingLevel: "auto",
  maxConcurrency: 2,
  maxOutputTokens: 8000,
  requestTimeoutSeconds: 180,
};

export const DEFAULT_RESEARCH_EXTERNAL_SEARCH_SETTINGS: ResearchExternalSearchSettings = {
  id: DEFAULT_SEARCH_PROFILE_ID,
  name: "Tavily",
  provider: "tavily",
  endpoint: "https://api.tavily.com/search",
  apiKey: "",
  saveApiKey: false,
  authHeaderName: "Authorization",
  authHeaderPrefix: "Bearer ",
  maxResults: 10,
  maxSources: 20,
  timeRange: "month",
  includeDomains: "",
  excludeDomains: "",
  fetchPageContent: false,
  maxPages: 8,
  requestTimeoutSeconds: 30,
  customRequestMethod: "POST",
  customQueryField: "query",
  customLimitField: "max_results",
  customResultsPath: "results",
  customTitlePath: "title",
  customUrlPath: "url",
  customSnippetPath: "snippet",
  customContentPath: "content",
  customPublishedAtPath: "published_at",
};

function normalizeModels(
  models: unknown,
  selectedModel: unknown,
  fastModel: unknown,
  synthesisModel: unknown,
  auditModel: unknown,
): ResearchModelDefinition[] {
  const candidates: ResearchModelDefinition[] = Array.isArray(models)
    ? models.flatMap((item) => {
      if (typeof item === "string") return [{ id: item, name: item }];
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : id;
      return id ? [{ id, name: name || id, reasoning: normalizeReasoning(record.reasoning) }] : [];
    })
    : [];
  for (const value of [selectedModel, fastModel, synthesisModel, auditModel]) {
    if (typeof value === "string" && value.trim()) {
      candidates.push({ id: value.trim(), name: value.trim() });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = item.id.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSettings(value: Partial<ResearchProviderSettings>): ResearchProviderSettings {
  const concurrency = Number(value.maxConcurrency);
  const maxConcurrency = ([1, 2, 3, 4] as const).includes(concurrency as 1 | 2 | 3 | 4)
    ? concurrency as 1 | 2 | 3 | 4
    : 2;
  const maxOutputTokens = Math.max(1000, Math.min(256000, Number(value.maxOutputTokens) || 8000));
  const requestTimeoutSeconds = Math.max(30, Math.min(300, Number(value.requestTimeoutSeconds) || 180));
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const fastModel = typeof value.fastModel === "string" ? value.fastModel.trim() : "";
  const synthesisModel = typeof value.synthesisModel === "string" ? value.synthesisModel.trim() : "";
  const auditModel = typeof value.auditModel === "string" ? value.auditModel.trim() : "";
  const rawVerification = value.nativeWebSearchVerification;
  const nativeWebSearchVerification = rawVerification
    && typeof rawVerification.model === "string"
    && API_PROTOCOLS.includes(rawVerification.protocol)
    && (rawVerification.status === "verified" || rawVerification.status === "failed")
    && typeof rawVerification.checkedAt === "string"
    && typeof rawVerification.message === "string"
    ? { ...rawVerification, model: rawVerification.model.trim(), message: rawVerification.message.slice(0, 500) }
    : undefined;
  return {
    ...DEFAULT_RESEARCH_PROVIDER_SETTINGS,
    ...value,
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : DEFAULT_PROFILE_ID,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "OpenAI",
    preset: PROVIDER_PRESETS.includes(value.preset as ResearchProviderSettings["preset"])
      ? value.preset as ResearchProviderSettings["preset"]
      : "custom",
    protocol: API_PROTOCOLS.includes(value.protocol as ResearchProviderSettings["protocol"])
      ? value.protocol as ResearchProviderSettings["protocol"]
      : "chat_completions",
    authMode: AUTH_MODES.includes(value.authMode as ResearchProviderSettings["authMode"])
      ? value.authMode as ResearchProviderSettings["authMode"]
      : "bearer",
    authHeaderName: typeof value.authHeaderName === "string" && value.authHeaderName.trim()
      ? value.authHeaderName.trim()
      : "Authorization",
    authHeaderPrefix: typeof value.authHeaderPrefix === "string" ? value.authHeaderPrefix : "Bearer ",
    endpoint: typeof value.endpoint === "string" ? value.endpoint.trim() : DEFAULT_RESEARCH_PROVIDER_SETTINGS.endpoint,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    models: normalizeModels(value.models, model, fastModel, synthesisModel, auditModel),
    model,
    fastModel,
    synthesisModel,
    auditModel,
    saveApiKey: Boolean(value.saveApiKey),
    // Web access is managed automatically instead of being a per-connection user setting.
    // Keep the field in the persisted shape for backwards-compatible job/report snapshots.
    webSearchMode: "auto",
    nativeWebSearchVerification,
    thinkingLevel: THINKING_LEVELS.includes(value.thinkingLevel as ResearchProviderSettings["thinkingLevel"])
      ? value.thinkingLevel as ResearchProviderSettings["thinkingLevel"]
      : "auto",
    maxConcurrency,
    maxOutputTokens,
    requestTimeoutSeconds,
  };
}

function newProviderId() {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `provider-${suffix}`;
}

export function createResearchProviderProfile(
  input: Partial<ResearchProviderSettings> = {},
): ResearchProviderSettings {
  return normalizeSettings({
    ...DEFAULT_RESEARCH_PROVIDER_SETTINGS,
    name: input.name || "New API",
    preset: input.preset ?? "custom",
    ...input,
    id: input.id || newProviderId(),
  });
}

async function readSmallValue<T>(key: string): Promise<T | null> {
  const area = chromeStorage();
  if (area) {
    try {
      const result = await area.get(key);
      return (result[key] as T | undefined) ?? null;
    } catch {
      // Fall through to localStorage for regular browser development.
    }
  }
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

async function writeSmallValue(key: string, value: unknown): Promise<void> {
  const area = chromeStorage();
  if (area) {
    await area.set({ [key]: value });
    notifyResearchStorageChanged();
    return;
  }
  globalThis.localStorage?.setItem(key, JSON.stringify(value));
  notifyResearchStorageChanged();
}

async function removeSmallValue(key: string): Promise<void> {
  const area = chromeStorage();
  if (area) {
    await area.remove(key);
    notifyResearchStorageChanged();
    return;
  }
  globalThis.localStorage?.removeItem(key);
  notifyResearchStorageChanged();
}

type StoredProviderCollection = {
  activeProfileId: string;
  profiles: StoredResearchProviderSettings[];
  workflowRoutes?: Partial<Record<ResearchWorkflowId, ResearchWorkflowProviderRoute>>;
};

function normalizeProviderRoutes(
  value: unknown,
  profiles: Array<Pick<ResearchProviderSettings, "id">>,
): Partial<Record<ResearchWorkflowId, ResearchWorkflowProviderRoute>> {
  if (!value || typeof value !== "object") return {};
  const validProfileIds = new Set(profiles.map((profile) => profile.id));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([workflowId, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const route = raw as Record<string, unknown>;
    const executionProfileId = typeof route.executionProfileId === "string" && validProfileIds.has(route.executionProfileId)
      ? route.executionProfileId : undefined;
    const executionModelRole = route.executionModelRole === "main" || route.executionModelRole === "fast"
      ? route.executionModelRole : undefined;
    const synthesisProfileId = typeof route.synthesisProfileId === "string" && validProfileIds.has(route.synthesisProfileId)
      ? route.synthesisProfileId : undefined;
    const auditProfileId = typeof route.auditProfileId === "string" && validProfileIds.has(route.auditProfileId)
      ? route.auditProfileId : undefined;
    const professionalDataProfileId = typeof route.professionalDataProfileId === "string" && validProfileIds.has(route.professionalDataProfileId)
      ? route.professionalDataProfileId : undefined;
    const auditDisabled = Boolean(route.auditDisabled);
    if (!executionProfileId && !executionModelRole && !synthesisProfileId && !auditProfileId && !auditDisabled && !professionalDataProfileId) return [];
    return [[workflowId, {
      executionProfileId,
      executionModelRole,
      synthesisProfileId,
      auditProfileId,
      auditDisabled,
      ...(professionalDataProfileId ? { professionalDataProfileId } : {}),
    }]];
  })) as Partial<Record<ResearchWorkflowId, ResearchWorkflowProviderRoute>>;
}

async function migrateLegacyProvider(): Promise<ResearchProviderCollection | null> {
  const legacy = await readSmallValue<StoredResearchProviderSettings>(LEGACY_SETTINGS_KEY);
  if (!legacy) return null;
  const legacyKey = legacy.hasSavedApiKey
    ? await readSmallValue<string>(LEGACY_API_KEY_STORAGE_KEY) ?? ""
    : "";
  const profile = normalizeSettings({
    ...legacy,
    id: DEFAULT_PROFILE_ID,
    name: "Migrated API",
    preset: "custom",
    protocol: "chat_completions",
    apiKey: legacyKey,
    saveApiKey: Boolean(legacy.hasSavedApiKey),
  });
  await saveResearchProviderProfiles({ activeProfileId: profile.id, profiles: [profile] });
  await removeSmallValue(LEGACY_SETTINGS_KEY);
  await removeSmallValue(LEGACY_API_KEY_STORAGE_KEY);
  return { activeProfileId: profile.id, profiles: [profile] };
}

export async function loadResearchProviderProfiles(): Promise<ResearchProviderCollection> {
  const stored = await readSmallValue<StoredProviderCollection>(SETTINGS_KEY);
  if (!stored?.profiles?.length) {
    const migrated = await migrateLegacyProvider();
    if (migrated) return migrated;
    return { activeProfileId: DEFAULT_PROFILE_ID, profiles: [{ ...DEFAULT_RESEARCH_PROVIDER_SETTINGS }] };
  }
  const savedKeys = await readSmallValue<Record<string, string>>(API_KEY_STORAGE_KEY) ?? {};
  const sharedSessionKeys = await readSessionValue<Record<string, string>>(SESSION_API_KEY_STORAGE_KEY) ?? {};
  const profiles = stored.profiles.map((profile) => normalizeSettings({
    ...profile,
    apiKey: sessionApiKeys.get(profile.id) || sharedSessionKeys[profile.id] || (profile.hasSavedApiKey ? savedKeys[profile.id] ?? "" : ""),
    saveApiKey: Boolean(profile.hasSavedApiKey),
  }));
  const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
    ? stored.activeProfileId
    : profiles[0]!.id;
  return { activeProfileId, profiles, workflowRoutes: normalizeProviderRoutes(stored.workflowRoutes, profiles) };
}

export async function saveResearchProviderProfiles(collection: ResearchProviderCollection): Promise<void> {
  const profiles = collection.profiles.length
    ? collection.profiles.map((profile) => normalizeSettings(profile))
    : [{ ...DEFAULT_RESEARCH_PROVIDER_SETTINGS }];
  const activeProfileId = profiles.some((profile) => profile.id === collection.activeProfileId)
    ? collection.activeProfileId
    : profiles[0]!.id;
  const workflowRoutes = normalizeProviderRoutes(collection.workflowRoutes, profiles);
  const savedKeys = await readSmallValue<Record<string, string>>(API_KEY_STORAGE_KEY) ?? {};
  const nextSavedKeys: Record<string, string> = {};
  const nextSessionKeys: Record<string, string> = {};
  const storedProfiles: StoredResearchProviderSettings[] = profiles.map((profile) => {
    sessionApiKeys.set(profile.id, profile.apiKey.trim());
    if (profile.apiKey.trim()) nextSessionKeys[profile.id] = profile.apiKey.trim();
    if (profile.saveApiKey && profile.apiKey) nextSavedKeys[profile.id] = profile.apiKey.trim();
    else if (profile.saveApiKey && savedKeys[profile.id]) nextSavedKeys[profile.id] = savedKeys[profile.id]!;
    const storedProfile = { ...profile } as Partial<ResearchProviderSettings>;
    delete storedProfile.apiKey;
    return {
      ...storedProfile,
      hasSavedApiKey: profile.saveApiKey && Boolean(nextSavedKeys[profile.id]),
    } as StoredResearchProviderSettings;
  });
  await writeSmallValue(SETTINGS_KEY, { activeProfileId, profiles: storedProfiles, workflowRoutes } satisfies StoredProviderCollection);
  if (Object.keys(nextSavedKeys).length) await writeSmallValue(API_KEY_STORAGE_KEY, nextSavedKeys);
  else await removeSmallValue(API_KEY_STORAGE_KEY);
  if (Object.keys(nextSessionKeys).length) await writeSessionValue(SESSION_API_KEY_STORAGE_KEY, nextSessionKeys);
  else await removeSessionValue(SESSION_API_KEY_STORAGE_KEY);
}

export async function loadResearchProviderSettings(): Promise<ResearchProviderSettings> {
  const collection = await loadResearchProviderProfiles();
  return collection.profiles.find((profile) => profile.id === collection.activeProfileId) ?? collection.profiles[0]!;
}

export async function saveResearchProviderSettings(settings: ResearchProviderSettings): Promise<void> {
  const collection = await loadResearchProviderProfiles();
  const normalized = normalizeSettings(settings);
  const profiles = collection.profiles.some((profile) => profile.id === normalized.id)
    ? collection.profiles.map((profile) => profile.id === normalized.id ? normalized : profile)
    : [...collection.profiles, normalized];
  await saveResearchProviderProfiles({ ...collection, activeProfileId: normalized.id, profiles });
}

export function setSessionResearchApiKey(apiKey: string, profileId = DEFAULT_PROFILE_ID) {
  sessionApiKeys.set(profileId, apiKey.trim());
  sessionApiKeyWriteQueue = sessionApiKeyWriteQueue.then(async () => {
    const keys = await readSessionValue<Record<string, string>>(SESSION_API_KEY_STORAGE_KEY);
    await writeSessionValue(SESSION_API_KEY_STORAGE_KEY, { ...(keys ?? {}), [profileId]: apiKey.trim() });
  }).catch(() => undefined);
}

export async function clearSavedResearchApiKey(profileId?: string) {
  await sessionApiKeyWriteQueue;
  if (!profileId) {
    sessionApiKeys.clear();
    await removeSessionValue(SESSION_API_KEY_STORAGE_KEY);
    await removeSmallValue(API_KEY_STORAGE_KEY);
    const collection = await loadResearchProviderProfiles();
    await saveResearchProviderProfiles({
      ...collection,
      profiles: collection.profiles.map((profile) => ({ ...profile, apiKey: "", saveApiKey: false })),
    });
    return;
  }
  sessionApiKeys.delete(profileId);
  const sessionKeys = await readSessionValue<Record<string, string>>(SESSION_API_KEY_STORAGE_KEY) ?? {};
  delete sessionKeys[profileId];
  if (Object.keys(sessionKeys).length) await writeSessionValue(SESSION_API_KEY_STORAGE_KEY, sessionKeys);
  else await removeSessionValue(SESSION_API_KEY_STORAGE_KEY);
  const collection = await loadResearchProviderProfiles();
  await saveResearchProviderProfiles({
    ...collection,
    profiles: collection.profiles.map((profile) => profile.id === profileId
      ? { ...profile, apiKey: "", saveApiKey: false }
      : profile),
  });
}

const EXTERNAL_SEARCH_ENDPOINTS: Record<ResearchExternalSearchProvider, string> = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
  volcengine_search: "https://open.feedcoopapi.com/search_api/web_search",
  custom: "",
};

const EXTERNAL_SEARCH_NAMES: Record<ResearchExternalSearchProvider, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  exa: "Exa",
  volcengine_search: "方舟联网搜索",
  custom: "自定义搜索 API",
};

type StoredExternalSearchCollection = {
  activeProfileId: string;
  profiles: StoredResearchExternalSearchSettings[];
};

function newSearchProfileId() {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `search-${suffix}`;
}

function normalizeExternalSearchSettings(
  value: Partial<ResearchExternalSearchSettings> = {},
): ResearchExternalSearchSettings {
  const isLegacySettings = value.maxSources === undefined;
  const maxResultsValue = isLegacySettings && Number(value.maxResults) === 8 ? 10 : value.maxResults;
  const maxPagesValue = isLegacySettings && Number(value.maxPages) === 3 ? 8 : value.maxPages;
  const provider = (["tavily", "brave", "exa", "volcengine_search", "custom"] as const).includes(value.provider as ResearchExternalSearchProvider)
    ? value.provider as ResearchExternalSearchProvider
    : "tavily";
  const timeRange = (["any", "day", "week", "month", "year"] as const).includes(value.timeRange as ResearchExternalSearchSettings["timeRange"])
    ? value.timeRange as ResearchExternalSearchSettings["timeRange"]
    : "month";
  const maxSources = Math.max(5, Math.min(100, Math.round(Number(value.maxSources) || 20)));
  const maxPages = Math.min(maxSources, Math.max(1, Math.min(50, Math.round(Number(maxPagesValue) || 8))));
  return {
    ...DEFAULT_RESEARCH_EXTERNAL_SEARCH_SETTINGS,
    ...value,
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : DEFAULT_SEARCH_PROFILE_ID,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : EXTERNAL_SEARCH_NAMES[provider],
    provider,
    endpoint: typeof value.endpoint === "string" && value.endpoint.trim()
      ? value.endpoint.trim()
      : EXTERNAL_SEARCH_ENDPOINTS[provider],
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    saveApiKey: Boolean(value.saveApiKey),
    authHeaderName: typeof value.authHeaderName === "string" && value.authHeaderName.trim()
      ? value.authHeaderName.trim()
      : provider === "brave" ? "X-Subscription-Token" : provider === "exa" ? "x-api-key" : "Authorization",
    authHeaderPrefix: typeof value.authHeaderPrefix === "string"
      ? value.authHeaderPrefix
      : provider === "tavily" || provider === "volcengine_search" ? "Bearer " : "",
    maxResults: Math.max(3, Math.min(
      provider === "exa" || provider === "custom" ? 100 : provider === "volcengine_search" ? 50 : 20,
      Math.round(Number(maxResultsValue) || 10),
    )),
    maxSources,
    timeRange,
    includeDomains: typeof value.includeDomains === "string" ? value.includeDomains.trim() : "",
    excludeDomains: typeof value.excludeDomains === "string" ? value.excludeDomains.trim() : "",
    fetchPageContent: Boolean(value.fetchPageContent),
    maxPages,
    requestTimeoutSeconds: Math.max(10, Math.min(60, Math.round(Number(value.requestTimeoutSeconds) || 30))),
    customRequestMethod: value.customRequestMethod === "GET" ? "GET" : "POST",
    customQueryField: typeof value.customQueryField === "string" && value.customQueryField.trim() ? value.customQueryField.trim() : "query",
    customLimitField: typeof value.customLimitField === "string" && value.customLimitField.trim() ? value.customLimitField.trim() : "max_results",
    customResultsPath: typeof value.customResultsPath === "string" ? value.customResultsPath.trim() : "results",
    customTitlePath: typeof value.customTitlePath === "string" && value.customTitlePath.trim() ? value.customTitlePath.trim() : "title",
    customUrlPath: typeof value.customUrlPath === "string" && value.customUrlPath.trim() ? value.customUrlPath.trim() : "url",
    customSnippetPath: typeof value.customSnippetPath === "string" ? value.customSnippetPath.trim() : "snippet",
    customContentPath: typeof value.customContentPath === "string" ? value.customContentPath.trim() : "content",
    customPublishedAtPath: typeof value.customPublishedAtPath === "string" ? value.customPublishedAtPath.trim() : "published_at",
  };
}

export function createResearchExternalSearchProfile(
  input: Partial<ResearchExternalSearchSettings> = {},
): ResearchExternalSearchSettings {
  const provider = input.provider ?? "tavily";
  const preset = externalSearchPresetDefaults(provider);
  return normalizeExternalSearchSettings({
    ...preset,
    ...input,
    id: input.id || newSearchProfileId(),
    name: input.name || EXTERNAL_SEARCH_NAMES[provider],
  });
}

export function externalSearchPresetDefaults(provider: ResearchExternalSearchProvider) {
  return normalizeExternalSearchSettings({
    ...DEFAULT_RESEARCH_EXTERNAL_SEARCH_SETTINGS,
    name: EXTERNAL_SEARCH_NAMES[provider],
    provider,
    endpoint: EXTERNAL_SEARCH_ENDPOINTS[provider],
    authHeaderName: provider === "brave" ? "X-Subscription-Token" : provider === "exa" ? "x-api-key" : "Authorization",
    authHeaderPrefix: provider === "tavily" || provider === "volcengine_search" ? "Bearer " : "",
  });
}

async function migrateLegacyExternalSearch(): Promise<ResearchExternalSearchCollection | null> {
  const legacy = await readSmallValue<StoredResearchExternalSearchSettings>(LEGACY_EXTERNAL_SEARCH_SETTINGS_KEY);
  if (!legacy) return null;
  const savedKey = legacy.hasSavedApiKey
    ? await readSmallValue<string>(LEGACY_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY) ?? ""
    : "";
  const profile = normalizeExternalSearchSettings({
    ...legacy,
    id: DEFAULT_SEARCH_PROFILE_ID,
    name: EXTERNAL_SEARCH_NAMES[legacy.provider] ?? EXTERNAL_SEARCH_NAMES.tavily,
    apiKey: savedKey,
    saveApiKey: Boolean(legacy.hasSavedApiKey),
  });
  const collection = { activeProfileId: profile.id, profiles: [profile] };
  await saveResearchExternalSearchProfiles(collection);
  await removeSmallValue(LEGACY_EXTERNAL_SEARCH_SETTINGS_KEY);
  await removeSmallValue(LEGACY_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
  return collection;
}

export async function loadResearchExternalSearchProfiles(): Promise<ResearchExternalSearchCollection> {
  const stored = await readSmallValue<StoredExternalSearchCollection>(EXTERNAL_SEARCH_SETTINGS_KEY);
  if (!stored?.profiles?.length) {
    const migrated = await migrateLegacyExternalSearch();
    if (migrated) return migrated;
    return { activeProfileId: DEFAULT_SEARCH_PROFILE_ID, profiles: [{ ...DEFAULT_RESEARCH_EXTERNAL_SEARCH_SETTINGS }] };
  }
  const savedKeys = await readSmallValue<Record<string, string>>(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY) ?? {};
  const sharedSessionKeys = await readSessionValue<Record<string, string>>(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY) ?? {};
  const profiles = stored.profiles.map((profile) => normalizeExternalSearchSettings({
    ...profile,
    apiKey: sessionExternalSearchApiKeys.get(profile.id) || sharedSessionKeys[profile.id] || (profile.hasSavedApiKey ? savedKeys[profile.id] ?? "" : ""),
    saveApiKey: Boolean(profile.hasSavedApiKey),
  }));
  const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
    ? stored.activeProfileId
    : profiles[0]!.id;
  return { activeProfileId, profiles };
}

export async function saveResearchExternalSearchProfiles(collection: ResearchExternalSearchCollection): Promise<void> {
  const profiles = collection.profiles.length
    ? collection.profiles.map((profile) => normalizeExternalSearchSettings(profile))
    : [{ ...DEFAULT_RESEARCH_EXTERNAL_SEARCH_SETTINGS }];
  const activeProfileId = profiles.some((profile) => profile.id === collection.activeProfileId)
    ? collection.activeProfileId
    : profiles[0]!.id;
  const savedKeys = await readSmallValue<Record<string, string>>(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY) ?? {};
  const nextSavedKeys: Record<string, string> = {};
  const nextSessionKeys: Record<string, string> = {};
  const storedProfiles: StoredResearchExternalSearchSettings[] = profiles.map((profile) => {
    sessionExternalSearchApiKeys.set(profile.id, profile.apiKey.trim());
    if (profile.apiKey.trim()) nextSessionKeys[profile.id] = profile.apiKey.trim();
    if (profile.saveApiKey && profile.apiKey) nextSavedKeys[profile.id] = profile.apiKey.trim();
    else if (profile.saveApiKey && savedKeys[profile.id]) nextSavedKeys[profile.id] = savedKeys[profile.id]!;
    const storedProfile = { ...profile } as Partial<ResearchExternalSearchSettings>;
    delete storedProfile.apiKey;
    return {
      ...storedProfile,
      hasSavedApiKey: profile.saveApiKey && Boolean(nextSavedKeys[profile.id]),
    } as StoredResearchExternalSearchSettings;
  });
  await writeSmallValue(EXTERNAL_SEARCH_SETTINGS_KEY, { activeProfileId, profiles: storedProfiles } satisfies StoredExternalSearchCollection);
  if (Object.keys(nextSavedKeys).length) await writeSmallValue(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY, nextSavedKeys);
  else await removeSmallValue(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
  if (Object.keys(nextSessionKeys).length) await writeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY, nextSessionKeys);
  else await removeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
}

export async function loadResearchExternalSearchSettings(): Promise<ResearchExternalSearchSettings> {
  const collection = await loadResearchExternalSearchProfiles();
  return collection.profiles.find((profile) => profile.id === collection.activeProfileId) ?? collection.profiles[0]!;
}

export async function saveResearchExternalSearchSettings(settings: ResearchExternalSearchSettings): Promise<void> {
  const collection = await loadResearchExternalSearchProfiles();
  const normalized = normalizeExternalSearchSettings(settings);
  const profiles = collection.profiles.some((profile) => profile.id === normalized.id)
    ? collection.profiles.map((profile) => profile.id === normalized.id ? normalized : profile)
    : [...collection.profiles, normalized];
  await saveResearchExternalSearchProfiles({ activeProfileId: normalized.id, profiles });
}

export function setSessionResearchExternalSearchApiKey(apiKey: string, profileId = DEFAULT_SEARCH_PROFILE_ID) {
  sessionExternalSearchApiKeys.set(profileId, apiKey.trim());
  sessionExternalSearchApiKeyWriteQueue = sessionExternalSearchApiKeyWriteQueue.then(async () => {
    const keys = await readSessionValue<Record<string, string>>(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
    await writeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY, { ...(keys ?? {}), [profileId]: apiKey.trim() });
  }).catch(() => undefined);
}

export async function clearSavedResearchExternalSearchApiKey(profileId?: string) {
  await sessionExternalSearchApiKeyWriteQueue;
  if (!profileId) {
    sessionExternalSearchApiKeys.clear();
    await removeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
    await removeSmallValue(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
    const collection = await loadResearchExternalSearchProfiles();
    await saveResearchExternalSearchProfiles({
      ...collection,
      profiles: collection.profiles.map((profile) => ({ ...profile, apiKey: "", saveApiKey: false })),
    });
    return;
  }
  sessionExternalSearchApiKeys.delete(profileId);
  const sessionKeys = await readSessionValue<Record<string, string>>(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY) ?? {};
  delete sessionKeys[profileId];
  if (Object.keys(sessionKeys).length) await writeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY, sessionKeys);
  else await removeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
  const collection = await loadResearchExternalSearchProfiles();
  await saveResearchExternalSearchProfiles({
    ...collection,
    profiles: collection.profiles.map((profile) => profile.id === profileId
      ? { ...profile, apiKey: "", saveApiKey: false }
      : profile),
  });
}

// While the library is being cleared, refuse new DB connections so a
// concurrent putRecord can't reopen the database and resurrect the data
// we're trying to delete. putRecord/allRecords already fall back to the
// in-memory maps when openDatabase returns null.
let clearingLibrary = false;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (clearingLibrary) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOB_STORE)) {
        const jobs = db.createObjectStore(JOB_STORE, { keyPath: "id" });
        jobs.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(REPORT_STORE)) {
        const reports = db.createObjectStore(REPORT_STORE, { keyPath: "id" });
        reports.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open research storage"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Research storage request failed"));
  });
}

const memoryJobs = new Map<string, ResearchJob>();
const memoryReports = new Map<string, ResearchReport>();

function normalizeLegacyAgentId(value: unknown) {
  return value === "comparison-analyst" ? "quick-check" : value;
}

function normalizeLegacyWorkflow<T extends ResearchJob | ResearchReport>(record: T): T {
  const rawWorkflowId = (record as unknown as { workflowId: string }).workflowId;
  if (rawWorkflowId !== "multi_asset_comparison") return record;
  const next = {
    ...record,
    workflowId: "quick_check" as const,
    agentResults: record.agentResults?.map((result) => ({
      ...result,
      agentId: normalizeLegacyAgentId(result.agentId),
    })),
  } as T & Partial<ResearchJob>;
  if ("completedSteps" in record) {
    next.completedSteps = record.completedSteps.map(normalizeLegacyAgentId) as ResearchJob["completedSteps"];
    next.pendingSteps = record.pendingSteps.map(normalizeLegacyAgentId) as ResearchJob["pendingSteps"];
    next.currentStep = normalizeLegacyAgentId(record.currentStep) as ResearchJob["currentStep"];
  }
  return next as T;
}

async function putRecord<T extends { id: string }>(storeName: string, value: T): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    (storeName === JOB_STORE ? memoryJobs : memoryReports).set(value.id, value as never);
    notifyResearchStorageChanged();
    return;
  }
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Research storage transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Research storage transaction aborted"));
    });
  } finally {
    db.close();
  }
  notifyResearchStorageChanged();
}

async function allRecords<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  if (!db) {
    return [...(storeName === JOB_STORE ? memoryJobs.values() : memoryReports.values())] as T[];
  }
  try {
    const tx = db.transaction(storeName, "readonly");
    return await requestResult(tx.objectStore(storeName).getAll()) as T[];
  } finally {
    db.close();
  }
}

async function deleteRecord(storeName: string, id: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    (storeName === JOB_STORE ? memoryJobs : memoryReports).delete(id);
    notifyResearchStorageChanged();
    return;
  }
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Research storage delete failed"));
    });
  } finally {
    db.close();
  }
  notifyResearchStorageChanged();
}

async function pruneRecords<T extends { id: string; updatedAt: string }>(
  storeName: string,
  max: number,
) {
  const records = await allRecords<T>(storeName);
  const overflow = records
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(max);
  await Promise.all(overflow.map((item) => deleteRecord(storeName, item.id)));
}

export async function saveResearchJob(job: ResearchJob) {
  await putRecord(JOB_STORE, job);
  await pruneRecords<ResearchJob>(JOB_STORE, MAX_RESEARCH_JOBS);
}

export async function listResearchJobs(): Promise<ResearchJob[]> {
  return (await allRecords<ResearchJob>(JOB_STORE))
    .map(normalizeLegacyWorkflow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteResearchJob(id: string) {
  await deleteRecord(JOB_STORE, id);
}

export async function saveResearchReport(report: ResearchReport) {
  await putRecord(REPORT_STORE, report);
  await pruneRecords<ResearchReport>(REPORT_STORE, MAX_RESEARCH_REPORTS);
}

export async function listResearchReports(): Promise<ResearchReport[]> {
  return (await allRecords<ResearchReport>(REPORT_STORE))
    .map(normalizeLegacyWorkflow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function queryResearchReports(filter: {
  targetName?: string;
  workflowId?: ResearchWorkflowId;
}): Promise<ResearchReport[]> {
  const all = await listResearchReports();
  return all.filter((report) => {
    if (filter.workflowId && report.workflowId !== filter.workflowId) return false;
    if (filter.targetName) {
      const name = report.target.name?.toLowerCase() ?? "";
      const symbol = report.target.symbol?.toLowerCase() ?? "";
      const query = filter.targetName.toLowerCase();
      return name.includes(query) || symbol.includes(query);
    }
    return true;
  });
}

export async function deleteResearchReport(id: string) {
  await deleteRecord(REPORT_STORE, id);
}

export interface ResearchBackupData {
  version: 1;
  exportedAt: string;
  jobs: ResearchJob[];
  reports: ResearchReport[];
  providers: ResearchProviderCollection;
  externalSearch: ResearchExternalSearchCollection;
  apiKeysIncluded: false;
}

/**
 * Export every recoverable research record and connection setting. API keys
 * are deliberately omitted so a normal portfolio backup can be shared or
 * stored without silently leaking credentials.
 */
export async function exportResearchBackup(): Promise<ResearchBackupData> {
  const [jobs, reports, providerCollection, externalSearchCollection] = await Promise.all([
    listResearchJobs(),
    listResearchReports(),
    loadResearchProviderProfiles(),
    loadResearchExternalSearchProfiles(),
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    jobs,
    reports,
    providers: {
      activeProfileId: providerCollection.activeProfileId,
      workflowRoutes: providerCollection.workflowRoutes,
      profiles: providerCollection.profiles.map((profile) => ({
        ...profile,
        apiKey: "",
        saveApiKey: false,
      })),
    },
    externalSearch: {
      activeProfileId: externalSearchCollection.activeProfileId,
      profiles: externalSearchCollection.profiles.map((profile) => ({
        ...profile,
        apiKey: "",
        saveApiKey: false,
      })),
    },
    apiKeysIncluded: false,
  };
}

export async function importResearchBackup(value: unknown): Promise<void> {
  if (!value || typeof value !== "object") return;
  const backup = value as Partial<ResearchBackupData>;
  const jobs = Array.isArray(backup.jobs) ? backup.jobs : [];
  const reports = Array.isArray(backup.reports) ? backup.reports : [];
  await Promise.all([
    ...jobs.filter((item): item is ResearchJob => Boolean(item?.id && item?.updatedAt)).map((item) => putRecord(JOB_STORE, normalizeLegacyWorkflow(item))),
    ...reports.filter((item): item is ResearchReport => Boolean(item?.id && item?.updatedAt)).map((item) => putRecord(REPORT_STORE, normalizeLegacyWorkflow(item))),
  ]);
  if (backup.providers?.profiles?.length) {
    await saveResearchProviderProfiles({
      activeProfileId: backup.providers.activeProfileId,
      workflowRoutes: backup.providers.workflowRoutes,
      profiles: backup.providers.profiles.map((profile) => ({ ...profile, apiKey: "", saveApiKey: false })),
    });
  }
  if (backup.externalSearch?.profiles?.length) {
    await saveResearchExternalSearchProfiles({
      activeProfileId: backup.externalSearch.activeProfileId,
      profiles: backup.externalSearch.profiles.map((profile) => ({ ...profile, apiKey: "", saveApiKey: false })),
    });
  }
  await Promise.all([
    pruneRecords<ResearchJob>(JOB_STORE, MAX_RESEARCH_JOBS),
    pruneRecords<ResearchReport>(REPORT_STORE, MAX_RESEARCH_REPORTS),
  ]);
}

export async function clearResearchLibrary(options: { includeSettings?: boolean; includeApiKey?: boolean } = {}) {
  // Set the clearing flag FIRST, before any DB operation, so that concurrent
  // putRecord/allRecords calls immediately fall back to the in-memory maps
  // and can't reopen the database mid-delete (which would resurrect the
  // data or block the delete). We don't need to open a connection ourselves
  // — indexedDB.deleteDatabase works without one.
  clearingLibrary = true;
  try {
    if (typeof indexedDB !== "undefined") {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("Unable to clear research storage"));
        // If a stale connection from an in-flight putRecord is still open,
        // don't hang forever — resolve and let the caller move on. The
        // clearing flag ensures no new connections will be opened.
        request.onblocked = () => resolve();
      });
    }
    memoryJobs.clear();
    memoryReports.clear();
    if (options.includeApiKey) {
      sessionApiKeys.clear();
      sessionExternalSearchApiKeys.clear();
      await removeSessionValue(SESSION_API_KEY_STORAGE_KEY);
      await removeSessionValue(SESSION_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
      await removeSmallValue(API_KEY_STORAGE_KEY);
      await removeSmallValue(LEGACY_API_KEY_STORAGE_KEY);
      await removeSmallValue(EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
      await removeSmallValue(LEGACY_EXTERNAL_SEARCH_API_KEY_STORAGE_KEY);
    }
    if (options.includeSettings) {
      await removeSmallValue(SETTINGS_KEY);
      await removeSmallValue(LEGACY_SETTINGS_KEY);
      await removeSmallValue(EXTERNAL_SEARCH_SETTINGS_KEY);
      await removeSmallValue(LEGACY_EXTERNAL_SEARCH_SETTINGS_KEY);
    }
    notifyResearchStorageChanged();
  } finally {
    clearingLibrary = false;
  }
}
