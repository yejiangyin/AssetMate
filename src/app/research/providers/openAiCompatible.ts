import type {
  ModelMessage,
  ModelRunRequest,
  ModelStreamEvent,
  ModelUsage,
  ResearchJobError,
  ResearchModelDefinition,
  ResearchProviderSettings,
  ResearchThinkingLevel,
  ResearchSource,
} from "../types";
import { effectiveResearchThinkingLevel, getResearchThinkingControl } from "../thinkingCapabilities";
import { getResearchWebSearchCapability } from "../webSearchCapabilities";

type ChromePermissions = {
  contains: (permissions: { origins: string[] }) => Promise<boolean>;
  request: (permissions: { origins: string[] }) => Promise<boolean>;
};

function permissionsApi(): ChromePermissions | null {
  const chromeLike = (globalThis as typeof globalThis & {
    chrome?: { permissions?: ChromePermissions };
  }).chrome;
  return chromeLike?.permissions ?? null;
}

function endpointOriginPattern(endpoint: string) {
  const url = new URL(endpoint);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) model endpoints are supported");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("Non-local model endpoints must use HTTPS");
  }
  return `${url.origin}/*`;
}

function stripKnownEndpoint(pathname: string) {
  return pathname
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses|messages|models|sonar|api\/chat|api\/tags)$/, "")
    .replace(/\/models\/[^/]+:(streamGenerateContent|generateContent)$/, "")
    .replace(/\/openai$/, "");
}

export function resolveResearchEndpoint(
  endpoint: string,
  protocol: ResearchProviderSettings["protocol"] = "chat_completions",
  model = "{model}",
  stream = false,
  preset?: ResearchProviderSettings["preset"],
) {
  const url = new URL(endpoint.trim());
  let basePath = stripKnownEndpoint(url.pathname);
  if (protocol === "gemini_native") {
    const normalizedModel = model.replace(/^models\//, "");
    const modelSegment = normalizedModel === "{model}" ? "{model}" : encodeURIComponent(normalizedModel);
    url.pathname = `${basePath}/models/${modelSegment}:${stream ? "streamGenerateContent" : "generateContent"}`.replace(/\/{2,}/g, "/");
    if (stream) url.searchParams.set("alt", "sse");
    else url.searchParams.delete("alt");
    return decodeURI(url.toString());
  }
  url.searchParams.delete("alt");
  if (protocol === "ollama_chat") {
    url.pathname = `${basePath}/api/chat`.replace(/\/{2,}/g, "/");
    return url.toString();
  }
  if (protocol === "anthropic_messages") {
    if (!basePath.endsWith("/v1")) basePath = `${basePath}/v1`;
    url.pathname = `${basePath}/messages`.replace(/\/{2,}/g, "/");
    return url.toString();
  }
  if (preset === "perplexity") {
    if (!basePath.endsWith("/v1")) basePath = `${basePath}/v1`;
    url.pathname = `${basePath}/sonar`.replace(/\/{2,}/g, "/");
    return url.toString();
  }
  url.pathname = `${basePath}/${protocol === "responses" ? "responses" : "chat/completions"}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

export function resolveModelListEndpoint(
  endpoint: string,
  protocol: ResearchProviderSettings["protocol"] = "chat_completions",
) {
  const url = new URL(endpoint.trim());
  let basePath = stripKnownEndpoint(url.pathname);
  url.search = "";
  if (protocol === "ollama_chat") {
    url.pathname = `${basePath}/api/tags`.replace(/\/{2,}/g, "/");
  } else if (protocol === "anthropic_messages") {
    if (!basePath.endsWith("/v1")) basePath = `${basePath}/v1`;
    url.pathname = `${basePath}/models`.replace(/\/{2,}/g, "/");
  } else {
    url.pathname = `${basePath}/models`.replace(/\/{2,}/g, "/");
  }
  return url.toString();
}

export async function ensureModelEndpointPermission(endpoint: string): Promise<boolean> {
  const api = permissionsApi();
  if (!api) return true;
  const origins = [endpointOriginPattern(endpoint)];
  if (await api.contains({ origins })) return true;
  return api.request({ origins });
}

function mapStatusError(status: number, message: string, endpoint?: string): ResearchJobError {
  // Messages are bilingual so English-language users aren't shown Chinese.
  // The UI surfaces these via errorDetail(); keeping both languages inline
  // avoids plumbing a language param through every provider call.
  const bilingual = (zh: string, en: string) => `${zh} / ${en}`;
  if (status === 401 || status === 403) {
    return { code: "auth", message: message || bilingual("API Key 无效或没有调用权限", "API key invalid or missing permission"), retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limit", message: message || bilingual("模型服务请求过于频繁", "Model service rate limited"), retryable: true };
  }
  if (status === 404) {
    return {
      code: "invalid_response",
      message: `${message || bilingual("模型请求地址不存在", "Model endpoint not found")}${endpoint ? ` / endpoint: ${endpoint}` : ""}`,
      retryable: false,
    };
  }
  if (status === 400 || status === 422) {
    return { code: "invalid_response", message: message || bilingual("请求参数与当前模型、思考深度或 API 协议不兼容", "Request parameters incompatible with the model, thinking level, or API protocol"), retryable: false };
  }
  return {
    code: "network",
    message: message || bilingual(`模型服务返回 HTTP ${status}`, `Model service returned HTTP ${status}`),
    retryable: status >= 500,
  };
}

export class ResearchProviderError extends Error {
  detail: ResearchJobError;

  constructor(detail: ResearchJobError) {
    super(detail.message);
    this.name = "ResearchProviderError";
    this.detail = detail;
  }
}

function responseErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof record.message === "string") return record.message;
  return fallback;
}

function readModels(payload: unknown): ResearchModelDefinition[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const models = items.flatMap((item) => {
    if (typeof item === "string") return [{ id: item, name: item }];
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model.id === "string"
      ? model.id.trim()
      : typeof model.name === "string"
        ? model.name.trim()
        : typeof model.model === "string"
          ? model.model.trim()
          : typeof model.key === "string"
            ? model.key.trim()
            : "";
    const name = typeof model.display_name === "string"
      ? model.display_name.trim()
      : typeof model.displayName === "string"
        ? model.displayName.trim()
      : typeof model.name === "string"
        ? model.name.trim()
        : id;
    const rawReasoning = model.reasoning && typeof model.reasoning === "object"
      ? model.reasoning as Record<string, unknown>
      : null;
    const supportedEfforts = Array.isArray(rawReasoning?.supported_efforts)
      ? rawReasoning.supported_efforts.filter((effort): effort is ResearchThinkingLevel => [
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
      ].includes(String(effort)))
      : undefined;
    const defaultEffort = typeof rawReasoning?.default_effort === "string"
      ? rawReasoning.default_effort as ResearchThinkingLevel
      : undefined;
    const reasoning = supportedEfforts?.length || defaultEffort || rawReasoning?.mandatory || rawReasoning?.supports_max_tokens
      ? {
        supportedEfforts,
        defaultEffort,
        mandatory: Boolean(rawReasoning?.mandatory),
        supportsMaxTokens: Boolean(rawReasoning?.supports_max_tokens),
      }
      : undefined;
    return id ? [{ id, name: name || id, ...(reasoning ? { reasoning } : {}) }] : [];
  });
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = model.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function geminiNextPageToken(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  return typeof record?.nextPageToken === "string" && record.nextPageToken.trim()
    ? record.nextPageToken.trim()
    : "";
}

function textParts(parts: unknown) {
  return Array.isArray(parts) ? parts.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return record.thought === true ? "" : typeof record.text === "string" ? record.text : "";
  }).join("") : "";
}

function readDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (record.type === "response.output_text.delta" && typeof record.delta === "string") return record.delta;
  if (typeof record.output_text === "string") return record.output_text;
  const anthropicDelta = record.delta;
  if (anthropicDelta && typeof anthropicDelta === "object") {
    const delta = anthropicDelta as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") return delta.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const anthropicText = content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
  if (anthropicText) return anthropicText;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidate = candidates[0];
  if (candidate && typeof candidate === "object") {
    const candidateContent = (candidate as Record<string, unknown>).content;
    if (candidateContent && typeof candidateContent === "object") {
      const geminiText = textParts((candidateContent as Record<string, unknown>).parts);
      if (geminiText) return geminiText;
    }
  }
  const ollamaMessage = record.message;
  if (ollamaMessage && typeof ollamaMessage === "object" && typeof (ollamaMessage as Record<string, unknown>).content === "string") {
    return (ollamaMessage as { content: string }).content;
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const responseText = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const itemContent = (item as Record<string, unknown>).content;
    return Array.isArray(itemContent) ? itemContent : [];
  }).map((item) => {
    if (!item || typeof item !== "object") return "";
    const outputContent = item as Record<string, unknown>;
    return outputContent.type === "output_text" && typeof outputContent.text === "string" ? outputContent.text : "";
  }).join("");
  if (responseText) return responseText;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const choice = first as Record<string, unknown>;
  const delta = choice.delta;
  if (delta && typeof delta === "object") {
    const deltaContent = (delta as Record<string, unknown>).content;
    if (typeof deltaContent === "string") return deltaContent;
    if (Array.isArray(deltaContent)) return textParts(deltaContent);
  }
  const message = choice.message;
  if (message && typeof message === "object") {
    const messageContent = (message as Record<string, unknown>).content;
    return typeof messageContent === "string" ? messageContent : textParts(messageContent);
  }
  return "";
}

function finiteNumber(...values: unknown[]) {
  for (const value of values) {
    const result = Number(value);
    if (Number.isFinite(result)) return result;
  }
  return undefined;
}

function readUsage(payload: unknown): ModelUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const payloadRecord = payload as Record<string, unknown>;
  const response = payloadRecord.response;
  const rawUsage = payloadRecord.usage ?? (response && typeof response === "object" ? (response as Record<string, unknown>).usage : undefined);
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage as Record<string, unknown> : {};
  const metadata = payloadRecord.usageMetadata && typeof payloadRecord.usageMetadata === "object"
    ? payloadRecord.usageMetadata as Record<string, unknown>
    : {};
  const input = finiteNumber(usage.prompt_tokens, usage.input_tokens, metadata.promptTokenCount, payloadRecord.prompt_eval_count);
  const output = finiteNumber(usage.completion_tokens, usage.output_tokens, metadata.candidatesTokenCount, payloadRecord.eval_count);
  const total = finiteNumber(usage.total_tokens, metadata.totalTokenCount, input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  if (input === undefined && output === undefined && total === undefined) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function providerSource(value: unknown, fallbackTitle = "Web source", query?: string): ResearchSource | null {
  if (typeof value === "string") {
    const url = validHttpUrl(value);
    return url ? { title: fallbackTitle, url, accessedAt: new Date().toISOString(), origin: "provider", query } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nestedWeb = record.web && typeof record.web === "object" ? record.web as Record<string, unknown> : null;
  const nestedCitation = record.url_citation && typeof record.url_citation === "object" ? record.url_citation as Record<string, unknown> : null;
  const url = validHttpUrl(record.url ?? record.uri ?? nestedWeb?.uri ?? nestedWeb?.url ?? nestedCitation?.url);
  if (!url) return null;
  const title = [record.title, record.name, nestedWeb?.title, nestedCitation?.title, fallbackTitle].find((item) => typeof item === "string" && item.trim()) as string;
  const publishedAt = [record.published_at, record.publishedAt, record.date, record.page_age].find((item) => typeof item === "string" && item.trim());
  return {
    title: title.trim(),
    url,
    accessedAt: new Date().toISOString(),
    origin: "provider",
    query,
    ...(typeof publishedAt === "string" ? { publishedAt } : {}),
  };
}

function pushSources(target: ResearchSource[], values: unknown, fallbackTitle?: string, query?: string) {
  if (!Array.isArray(values)) return;
  values.forEach((value) => {
    const source = providerSource(value, fallbackTitle, query);
    if (source && !target.some((item) => item.url === source.url)) target.push(source);
  });
}

function readWebSearchEvents(payload: unknown): ModelStreamEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const response = record.response && typeof record.response === "object" ? record.response as Record<string, unknown> : null;
  const type = typeof record.type === "string" ? record.type : "";
  const sources: ResearchSource[] = [];
  const queries: string[] = [];
  const errors: string[] = [];
  const lifecycleEvents: ModelStreamEvent[] = [];

  const addQuery = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !queries.includes(value.trim())) queries.push(value.trim());
  };
  const inspectBlock = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const block = value as Record<string, unknown>;
    if (block.type === "web_search_call") {
      const action = block.action && typeof block.action === "object" ? block.action as Record<string, unknown> : null;
      addQuery(action?.query);
    }
    if (block.type === "server_tool_use" && block.name === "web_search") {
      const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : null;
      addQuery(input?.query);
    }
    if (block.type === "web_search_result") {
      const source = providerSource(block, "Web search result", queries[0]);
      if (source) sources.push(source);
    }
    if (block.type === "web_search_tool_result") {
      const content = Array.isArray(block.content) ? block.content : [block.content];
      content.forEach((item) => {
        if (item && typeof item === "object" && (item as Record<string, unknown>).type === "web_search_tool_result_error") {
          errors.push(String((item as Record<string, unknown>).error_code ?? "Web search tool failed"));
        } else inspectBlock(item);
      });
    }
    const citation = block.citation && typeof block.citation === "object" ? block.citation : null;
    const source = providerSource(citation ?? block.annotation, "Citation", queries[0]);
    if (source) sources.push(source);
    pushSources(sources, block.annotations, "Citation", queries[0]);
    pushSources(sources, block.citations, "Citation", queries[0]);
  };

  if (type.startsWith("response.web_search_call.")) {
    const phase = type.endsWith("completed") ? "completed" : "searching";
    lifecycleEvents.push({ type: "web_search", phase });
  }
  inspectBlock(record.content_block);
  inspectBlock(record.delta);
  inspectBlock(record.item);
  (Array.isArray(record.content) ? record.content : []).forEach(inspectBlock);
  [
    ...(Array.isArray(record.output) ? record.output : []),
    ...(Array.isArray(response?.output) ? response.output : []),
  ].forEach((item) => {
    inspectBlock(item);
    if (item && typeof item === "object") {
      const content = (item as Record<string, unknown>).content;
      if (Array.isArray(content)) content.forEach(inspectBlock);
    }
  });

  const annotation = record.annotation;
  const annotationSource = providerSource(annotation, "Citation", queries[0]);
  if (annotationSource) sources.push(annotationSource);
  pushSources(sources, record.citations, "Citation", queries[0]);
  pushSources(sources, response?.citations, "Citation", queries[0]);
  pushSources(sources, record.search_results, "Search result", queries[0]);
  pushSources(sources, response?.search_results, "Search result", queries[0]);
  pushSources(sources, record.web_search, "Search result", queries[0]);
  const searchInfo = record.search_info && typeof record.search_info === "object" ? record.search_info as Record<string, unknown> : null;
  pushSources(sources, searchInfo?.search_results, "Search result", queries[0]);

  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  candidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    const candidateRecord = candidate as Record<string, unknown>;
    const grounding = candidateRecord.groundingMetadata && typeof candidateRecord.groundingMetadata === "object"
      ? candidateRecord.groundingMetadata as Record<string, unknown>
      : null;
    (Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries : []).forEach(addQuery);
    pushSources(sources, grounding?.groundingChunks, "Google Search result", queries[0]);
  });

  const choices = Array.isArray(record.choices) ? record.choices : [];
  choices.forEach((choice) => {
    if (!choice || typeof choice !== "object") return;
    const choiceRecord = choice as Record<string, unknown>;
    const message = choiceRecord.message;
    const messageRecord = message && typeof message === "object" ? message as Record<string, unknown> : null;
    pushSources(sources, messageRecord?.citations, "Citation", queries[0]);
    pushSources(sources, messageRecord?.annotations, "Citation", queries[0]);
    const messageSearchInfo = messageRecord?.search_info && typeof messageRecord.search_info === "object"
      ? messageRecord.search_info as Record<string, unknown>
      : null;
    pushSources(sources, messageSearchInfo?.search_results, "Search result", queries[0]);
    const deltas = [choiceRecord.delta, messageRecord];
    deltas.forEach((container) => {
      if (!container || typeof container !== "object") return;
      const toolCalls = (container as Record<string, unknown>).tool_calls;
      if (!Array.isArray(toolCalls)) return;
      toolCalls.forEach((toolCall) => {
        if (!toolCall || typeof toolCall !== "object") return;
        const fn = (toolCall as Record<string, unknown>).function;
        if (!fn || typeof fn !== "object") return;
        const fnRecord = fn as Record<string, unknown>;
        if (!/web_search/i.test(String(fnRecord.name ?? ""))) return;
        if (typeof fnRecord.arguments === "string") {
          try {
            const parsed = JSON.parse(fnRecord.arguments) as Record<string, unknown>;
            addQuery(parsed.query ?? parsed.search_query);
          } catch {
            addQuery(fnRecord.arguments);
          }
        }
      });
    });
  });

  const events: ModelStreamEvent[] = [...lifecycleEvents, ...queries.map((query): ModelStreamEvent => ({ type: "web_search", phase: "searching", query }))];
  if (sources.length) events.push({ type: "web_search", phase: "completed", sources: [...new Map(sources.map((source) => [source.url, source])).values()] });
  errors.forEach((error) => events.push({ type: "web_search", phase: "failed", error }));
  return events;
}

function combineSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(external?.reason);
  external?.addEventListener("abort", abort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    },
  };
}

function anthropicMessages(messages: ModelMessage[]) {
  return messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  }));
}

function geminiThinkingConfig(model: string, level: ResearchProviderSettings["thinkingLevel"]) {
  if (level === "auto") return undefined;
  if (model.toLowerCase().includes("gemini-2.5")) {
    const budgetMap: Partial<Record<ResearchThinkingLevel, number>> = {
      off: 0,
      low: 1024,
      medium: 4096,
      high: 8192,
    };
    const budget = budgetMap[level] ?? -1;
    return { thinkingBudget: budget };
  }
  return { thinkingLevel: level === "off" ? "minimal" : level };
}

function applyThinking(
  body: Record<string, unknown>,
  settings: ResearchProviderSettings,
  model: string,
  overrideLevel?: ResearchThinkingLevel,
) {
  const level = overrideLevel ?? effectiveResearchThinkingLevel({ ...settings, model });
  if (level === "auto") return;
  if (settings.protocol === "responses") {
    body.reasoning = { effort: level === "off" ? "none" : level };
  } else if (settings.protocol === "chat_completions") {
    if (settings.preset === "openrouter") body.reasoning = { effort: level === "off" ? "none" : level };
    else body.reasoning_effort = level === "off" ? "none" : level;
  } else if (settings.protocol === "anthropic_messages") {
    body.thinking = level === "off" ? { type: "disabled" } : { type: "adaptive" };
    if (level !== "off") body.output_config = { effort: level };
  } else if (settings.protocol === "gemini_native") {
    const generationConfig = body.generationConfig as Record<string, unknown>;
    generationConfig.thinkingConfig = geminiThinkingConfig(model, level);
  } else if (settings.protocol === "ollama_chat") {
    body.think = level === "off" ? false : level === "enabled" ? true : model.toLowerCase().includes("gpt-oss") ? level : true;
  }
}

const THINKING_DOWNGRADE_ORDER: ResearchThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];

function thinkingAttemptLevels(settings: ResearchProviderSettings, model: string): Array<ResearchThinkingLevel | undefined> {
  const first = effectiveResearchThinkingLevel({ ...settings, model });
  if (first === "auto") return [undefined];
  const control = getResearchThinkingControl({ ...settings, model });
  const available = new Set(control.options.map((option) => option.value));
  const startIndex = THINKING_DOWNGRADE_ORDER.indexOf(first);
  if (startIndex < 0) return [first];
  const attempts = THINKING_DOWNGRADE_ORDER
    .slice(startIndex)
    .filter((level) => available.has(level));
  return [...new Set(attempts)];
}

function shouldRetryWithLowerThinking(status: number, message: string, current: ResearchThinkingLevel | undefined, hasNext: boolean) {
  if (!current || !hasNext || (status !== 400 && status !== 422)) return false;
  return /reasoning|thinking|effort|xhigh|max|minimal|unsupported|invalid|parameter|参数|思考|不支持|无效/i.test(message);
}

function shouldRetryWithoutNativeWebSearch(status: number, message: string) {
  if (![400, 404, 422, 501].includes(status)) return false;
  return /web.?search|search tool|grounding|plugin|tools?\b|unsupported|not supported|unknown|invalid|联网|搜索|工具|不支持|未知|无效/i.test(message);
}

function thinkingRetryMessage(level: ResearchThinkingLevel | undefined) {
  return level ? `思考深度已自动降级为 ${level}` : "思考深度已自动降级为服务商默认";
}

function requestBody(settings: ResearchProviderSettings, request: ModelRunRequest, stream: boolean, thinkingLevel?: ResearchThinkingLevel) {
  const model = request.model || settings.model;
  const webSearchRequested = Boolean(request.enableWebSearch && (settings.webSearchMode === "native" || settings.webSearchMode === "auto"));
  const webSearchCapability = getResearchWebSearchCapability({ ...settings, model });
  if (webSearchRequested && !webSearchCapability.supported) {
    throw new ResearchProviderError({
      code: "invalid_response",
      message: webSearchCapability.reasonZh,
      retryable: false,
    });
  }
  let body: Record<string, unknown>;
  if (settings.protocol === "responses") {
    body = {
      model,
      input: request.messages,
      stream,
      store: false,
      max_output_tokens: request.maxOutputTokens ?? settings.maxOutputTokens,
    };
    if (webSearchRequested) body.tools = [{ type: "web_search" }];
  } else if (settings.protocol === "anthropic_messages") {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    body = {
      model,
      messages: anthropicMessages(request.messages),
      stream,
      max_tokens: request.maxOutputTokens ?? settings.maxOutputTokens,
    };
    if (system) body.system = system;
    if (webSearchRequested) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  } else if (settings.protocol === "gemini_native") {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    body = {
      contents: request.messages.filter((message) => message.role !== "system").map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens ?? settings.maxOutputTokens,
        temperature: request.temperature ?? 0.2,
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (webSearchRequested) body.tools = [{ google_search: {} }];
  } else if (settings.protocol === "ollama_chat") {
    body = {
      model,
      messages: request.messages,
      stream,
      options: {
        temperature: request.temperature ?? 0.2,
        num_predict: request.maxOutputTokens ?? settings.maxOutputTokens,
      },
    };
  } else {
    body = {
      model,
      messages: request.messages,
      stream,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxOutputTokens ?? settings.maxOutputTokens,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (webSearchRequested) {
      const adapter = webSearchCapability.adapter;
      if (adapter === "zhipu_tool") {
        body.tools = [{ type: "web_search", web_search: { enable: true, search_result: true } }];
      } else if (adapter === "moonshot_tool") {
        body.tools = [{ type: "builtin_function", function: { name: "$web_search" } }];
      } else if (adapter === "qwen_search") {
        body.enable_search = true;
      } else if (adapter === "perplexity_sonar") {
        body.web_search_options = {};
      } else if (adapter === "openrouter_plugin") {
        body.plugins = [{ id: "web" }];
      }
    }
  }
  applyThinking(body, settings, model, thinkingLevel);
  return body;
}

export class OpenAICompatibleProvider {
  constructor(private settings: ResearchProviderSettings) {}

  async listModels(signal?: AbortSignal) {
    this.validateEndpointAndKey();
    const permission = await ensureModelEndpointPermission(this.settings.endpoint);
    if (!permission) throw new ResearchProviderError({ code: "permission", message: "未授予模型服务域名访问权限", retryable: false });
    const combined = combineSignal(signal, Math.min(30, this.settings.requestTimeoutSeconds) * 1000);
    const endpoint = resolveModelListEndpoint(this.settings.endpoint, this.settings.protocol);
    try {
      const payloads: unknown[] = [];
      let nextEndpoint = endpoint;
      for (let page = 0; page < 20 && nextEndpoint; page += 1) {
        const response = await fetch(nextEndpoint, { method: "GET", headers: this.headers(), signal: combined.signal });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new ResearchProviderError(mapStatusError(response.status, responseErrorMessage(payload, "获取模型列表失败"), nextEndpoint));
        payloads.push(payload);
        const token = this.settings.protocol === "gemini_native" ? geminiNextPageToken(payload) : "";
        if (!token) break;
        const url = new URL(endpoint);
        url.searchParams.set("pageToken", token);
        nextEndpoint = url.toString();
      }
      const models = readModels(payloads.flatMap((payload) => {
        const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
        return Array.isArray(record?.models) ? record.models : Array.isArray(record?.data) ? record.data : Array.isArray(payload) ? payload : [];
      }));
      if (!models.length) throw new ResearchProviderError({ code: "invalid_response", message: "服务商未返回可识别的模型列表，请手动添加模型 ID", retryable: false });
      return models;
    } catch (error) {
      throw this.mapThrownError(error);
    } finally {
      combined.dispose();
    }
  }

  async testConnection(signal?: AbortSignal, modelOverride?: string) {
    this.validateRequiredSettings();
    const permission = await ensureModelEndpointPermission(this.settings.endpoint);
    if (!permission) throw new ResearchProviderError({ code: "permission", message: "未授予模型服务域名访问权限", retryable: false });
    const combined = combineSignal(signal, Math.min(30, this.settings.requestTimeoutSeconds) * 1000);
    try {
      const model = modelOverride?.trim() || this.settings.model;
      const endpoint = this.resolvedEndpoint(model, false);
      const request: ModelRunRequest = {
        model,
        messages: [{ role: "user", content: "Reply with OK only." }],
        maxOutputTokens: 128,
        temperature: 0,
      };
      const attempts = thinkingAttemptLevels(this.settings, model);
      for (let index = 0; index < attempts.length; index += 1) {
        const thinkingLevel = attempts[index];
        const response = await fetch(endpoint, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(requestBody(this.settings, request, false, thinkingLevel)),
          signal: combined.signal,
        });
        const payload = await response.json().catch(() => null);
        if (response.ok) {
          const suffix = index > 0 ? ` · ${thinkingRetryMessage(thinkingLevel)}` : "";
          return { ok: true, message: `${readDelta(payload) || "OK"}${suffix}` };
        }
        const message = responseErrorMessage(payload, "连接测试失败");
        if (shouldRetryWithLowerThinking(response.status, message, thinkingLevel, index < attempts.length - 1)) continue;
        throw new ResearchProviderError(mapStatusError(response.status, message, endpoint));
      }
      throw new ResearchProviderError({
        code: "invalid_response",
        message: "连接测试失败：思考深度降级后仍被模型服务拒绝",
        retryable: false,
      });
    } catch (error) {
      throw this.mapThrownError(error);
    } finally {
      combined.dispose();
    }
  }

  async testWebSearch(signal?: AbortSignal) {
    this.validateRequiredSettings();
    const capability = getResearchWebSearchCapability(this.settings);
    if (!capability.supported) {
      throw new ResearchProviderError({ code: "invalid_response", message: capability.reasonZh, retryable: false });
    }
    if (this.settings.webSearchMode !== "native" && this.settings.webSearchMode !== "auto") {
      throw new ResearchProviderError({ code: "invalid_response", message: "请先开启服务商原生联网搜索", retryable: false });
    }
    const queries: string[] = [];
    const sources: ResearchSource[] = [];
    const errors: string[] = [];
    let completed = false;
    for await (const event of this.run({
      model: this.settings.model,
      messages: [{ role: "user", content: "Use web search to find this provider's official API documentation. Reply with one short sentence and cite the source." }],
      maxOutputTokens: 512,
      temperature: 0,
      enableWebSearch: true,
    }, signal)) {
      if (event.type !== "web_search") continue;
      if (event.query && !queries.includes(event.query)) queries.push(event.query);
      event.sources?.forEach((source) => {
        if (!sources.some((item) => item.url === source.url)) sources.push(source);
      });
      if (event.error) errors.push(event.error);
      if (event.phase === "completed") completed = true;
    }
    if (!completed || !sources.length) {
      throw new ResearchProviderError({
        code: "invalid_response",
        message: errors[0] || (completed
          ? "联网工具已执行，但服务商没有返回结构化引用"
          : "模型响应成功，但没有返回可验证的联网调用或结构化引用"),
        retryable: false,
      });
    }
    return {
      ok: true,
      message: `联网已验证 · ${sources.length} 个结构化来源${queries.length ? ` · ${queries.length} 条查询` : ""}`,
      queries,
      sources,
    };
  }

  async *run(request: ModelRunRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    this.validateRequiredSettings();
    const combined = combineSignal(signal, this.settings.requestTimeoutSeconds * 1000);
    try {
      const model = request.model || this.settings.model;
      const endpoint = this.resolvedEndpoint(model, true);
      const webSearchRequested = Boolean(request.enableWebSearch && (this.settings.webSearchMode === "native" || this.settings.webSearchMode === "auto"));
      if (webSearchRequested) yield { type: "web_search", phase: "requested" };
      // Per-request thinking override (e.g. audits set "off" so reasoning
      // tokens don't consume the entire max_output_tokens budget and leave
      // nothing for visible output). If the requested level is rejected
      // (some models like GPT-OSS can't fully disable thinking), fall back
      // to the provider's normal supported levels.
      const providerLevels = thinkingAttemptLevels(this.settings, model);
      const attempts = request.thinkingLevel
        ? [request.thinkingLevel, ...providerLevels.filter((level) => level !== request.thinkingLevel)]
        : providerLevels;
      let response: Response | null = null;
      let webSearchActive = webSearchRequested;
      for (let index = 0; index < attempts.length; index += 1) {
        const thinkingLevel = attempts[index];
        const effectiveRequest = webSearchActive ? request : { ...request, enableWebSearch: false };
        response = await fetch(endpoint, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(requestBody(this.settings, effectiveRequest, true, thinkingLevel)),
          signal: combined.signal,
        });
        if (response.ok) break;
        const payload = await response.json().catch(() => null);
        const message = responseErrorMessage(payload, "模型请求失败");
        if (webSearchActive && request.continueOnWebSearchFailure && shouldRetryWithoutNativeWebSearch(response.status, message)) {
          webSearchActive = false;
          response = null;
          yield { type: "web_search", phase: "failed", error: `原生联网不可用，已自动回退为无原生搜索：${message}` };
          // Retry from the requested thinking level; the rejected web-search
          // tool should not also force reasoning-depth degradation.
          index = -1;
          continue;
        }
        if (shouldRetryWithLowerThinking(response.status, message, thinkingLevel, index < attempts.length - 1)) continue;
        throw new ResearchProviderError(mapStatusError(response.status, message, endpoint));
      }
      if (!response?.ok) throw new ResearchProviderError({ code: "invalid_response", message: "思考深度降级后仍被模型服务拒绝", retryable: false });
      if (this.settings.protocol === "ollama_chat") {
        yield* this.readNdjson(response);
        return;
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!response.body || !contentType.includes("text/event-stream")) {
        const payload = await response.json().catch(() => null);
        const webEvents = readWebSearchEvents(payload);
        let observed = false;
        for (const event of webEvents) {
          if (event.type === "web_search") {
            observed ||= event.phase === "searching" || event.phase === "completed";
            if (event.phase === "failed" && !request.continueOnWebSearchFailure) {
              yield event;
              throw new ResearchProviderError({ code: "network", message: event.error || "联网搜索工具执行失败", retryable: true });
            }
          }
          yield event;
        }
        const delta = readDelta(payload);
        if (!delta) throw new ResearchProviderError({ code: "invalid_response", message: "模型返回了空响应", retryable: true });
        yield { type: "delta", text: delta };
        const usage = readUsage(payload);
        if (usage) yield { type: "usage", usage };
        if (webSearchActive && !observed) {
          yield { type: "web_search", phase: "unverified", error: "服务商未返回可验证的搜索事件或结构化引用" };
        }
        yield { type: "done" };
        return;
      }
      const stream = this.readSse(response);
      let observed = false;
      for await (const event of stream) {
        if (event.type === "web_search") {
          observed ||= event.phase === "searching" || event.phase === "completed";
          if (event.phase === "failed" && !request.continueOnWebSearchFailure) {
            yield event;
            throw new ResearchProviderError({ code: "network", message: event.error || "联网搜索工具执行失败", retryable: true });
          }
        }
        if (event.type === "done" && webSearchActive && !observed) {
          yield { type: "web_search", phase: "unverified", error: "服务商未返回可验证的搜索事件或结构化引用" };
        }
        yield event;
      }
    } catch (error) {
      throw this.mapThrownError(error);
    } finally {
      combined.dispose();
    }
  }

  private async *readSse(response: Response): AsyncGenerator<ModelStreamEvent> {
    if (!response.body) throw new ResearchProviderError({ code: "invalid_response", message: "模型返回了空响应", retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parseBlock = (block: string) => block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    const emit = function* (data: string): Generator<ModelStreamEvent> {
      if (!data || data === "[DONE]") return;
      try {
        const payload: unknown = JSON.parse(data);
        yield* readWebSearchEvents(payload);
        const delta = readDelta(payload);
        if (delta) yield { type: "delta", text: delta };
        const usage = readUsage(payload);
        if (usage) yield { type: "usage", usage };
      } catch {
        // Ignore malformed or truncated provider events.
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) for (const data of parseBlock(block)) yield* emit(data);
        if (done) break;
      }
      for (const data of parseBlock(buffer)) yield* emit(data);
    } finally {
      // Release the stream lock so the response body can be GC'd even when
      // the consumer aborts or breaks out of the generator early.
      reader.releaseLock();
    }
    yield { type: "done" };
  }

  private async *readNdjson(response: Response): AsyncGenerator<ModelStreamEvent> {
    if (!response.body) throw new ResearchProviderError({ code: "invalid_response", message: "模型返回了空响应", retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        const readLine = function* (line: string): Generator<ModelStreamEvent> {
          if (!line.trim()) return;
          let payload: unknown;
          try {
            payload = JSON.parse(line);
          } catch {
            return;
          }
          yield* readWebSearchEvents(payload);
          const delta = readDelta(payload);
          if (delta) yield { type: "delta", text: delta };
          const usage = readUsage(payload);
          if (usage) yield { type: "usage", usage };
        };
        for (const line of lines) yield* readLine(line);
        if (done) break;
      }
      if (buffer.trim()) {
        let payload: unknown;
        try {
          payload = JSON.parse(buffer);
        } catch {
          payload = null;
        }
        if (payload) {
          yield* readWebSearchEvents(payload);
          const delta = readDelta(payload);
          if (delta) yield { type: "delta", text: delta };
          const usage = readUsage(payload);
          if (usage) yield { type: "usage", usage };
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { type: "done" };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.authMode === "bearer") headers.Authorization = `Bearer ${this.settings.apiKey}`;
    else if (this.settings.authMode === "x_api_key") {
      headers["x-api-key"] = this.settings.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (this.settings.authMode === "x_google_api_key") headers["x-goog-api-key"] = this.settings.apiKey;
    else if (this.settings.authMode === "custom_header" && this.settings.authHeaderName) {
      headers[this.settings.authHeaderName] = `${this.settings.authHeaderPrefix}${this.settings.apiKey}`;
    }
    return headers;
  }

  private validateRequiredSettings() {
    this.validateEndpointAndKey();
    if (!this.settings.model) throw new ResearchProviderError({ code: "unknown", message: "请添加并选择主模型", retryable: false });
  }

  private validateEndpointAndKey() {
    if (!this.settings.endpoint) throw new ResearchProviderError({ code: "unknown", message: "请填写模型 API 地址", retryable: false });
    try {
      endpointOriginPattern(resolveResearchEndpoint(this.settings.endpoint, this.settings.protocol, this.settings.model || "model"));
    } catch {
      throw new ResearchProviderError({ code: "unknown", message: "模型 API 地址无效", retryable: false });
    }
    if (this.settings.authMode !== "none" && !this.settings.apiKey) {
      throw new ResearchProviderError({ code: "auth", message: "请填写 API Key / Token", retryable: false });
    }
    if (this.settings.authMode === "custom_header" && !this.settings.authHeaderName.trim()) {
      throw new ResearchProviderError({ code: "auth", message: "请填写自定义鉴权 Header 名称", retryable: false });
    }
  }

  private resolvedEndpoint(model: string, stream: boolean) {
    return resolveResearchEndpoint(this.settings.endpoint, this.settings.protocol, model, stream, this.settings.preset);
  }

  private mapThrownError(error: unknown) {
    if (error instanceof ResearchProviderError) return error;
    if (error instanceof DOMException && error.name === "AbortError") {
      return new ResearchProviderError({ code: "cancelled", message: "研究任务已取消或请求超时", retryable: true });
    }
    const message = error instanceof Error ? error.message : "模型服务连接失败";
    const cors = /Failed to fetch|NetworkError|CORS/i.test(message);
    return new ResearchProviderError({
      code: cors ? "cors" : "network",
      message: cors ? "无法连接模型服务；请检查域名权限、CORS 和网络" : message,
      retryable: true,
    });
  }
}
