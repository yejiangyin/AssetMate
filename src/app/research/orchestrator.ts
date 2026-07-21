import { auditResearchReport, extractResearchSources, firstReportSummary, verifyTargetedReportCalculations } from "./finance/financialRigor";
import { OpenAICompatibleProvider, ResearchProviderError } from "./providers/openAiCompatible";
import { buildModelAuditRepairRequest, buildModelAuditRequest, parseModelAuditResult } from "./modelAudit";
import { getResearchWebSearchCapability } from "./webSearchCapabilities";
import { collectExternalSearchEvidence, externalBundleSources, externalEvidenceMessage, type ExternalSearchBundle } from "./externalSearch";
import { collectProfessionalData, professionalDataEvidenceMessage } from "./professionalData";
import { saveResearchJob, saveResearchReport } from "./storage";
import type {
  AgentResult,
  BacktestResearchContext,
  IncomeInvestmentContext,
  PortfolioResearchContext,
  PrivateHoldingContext,
  PublicResearchContext,
  ResearchAgentId,
  ResearchJob,
  ResearchJobError,
  ResearchProviderSettings,
  ResearchProfessionalDataTrace,
  ResearchProviderRouteSnapshot,
  ResearchRunProviderRouting,
  ResearchReport,
  ResearchModelAuditResult,
  ResearchRunOptions,
  ResearchTarget,
  ResearchSource,
  ResearchWebSearchTrace,
  ModelRunRequest,
  ModelStreamEvent,
  ResearchWorkflowId,
  ThesisDriftContext,
} from "./types";
import { getWorkflowConfig } from "./workflows/registry";
import {
  buildAgentRequest,
  buildSynthesisRequest,
  RESEARCH_WORKFLOW_VERSION,
  researchAgentTitle,
  researchWorkflowTitle,
  workflowAgentIds,
} from "./workflows/prompts";

function newId(prefix: string) {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

export function createResearchJob(input: {
  workflowId: ResearchWorkflowId;
  target: ResearchTarget;
  targets?: ResearchTarget[];
  publicContext: PublicResearchContext;
  privateContext?: PrivateHoldingContext;
  backtestContext?: BacktestResearchContext;
  portfolioContext?: PortfolioResearchContext;
  thesisDriftContext?: ThesisDriftContext;
  incomeInvestmentContext?: IncomeInvestmentContext;
  topic?: string;
  period?: string;
  providerRoute?: ResearchProviderRouteSnapshot;
  outputLanguage?: "zh" | "en";
}): ResearchJob {
  const now = new Date().toISOString();
  return {
    id: newId("research"),
    workflowId: input.workflowId,
    workflowVersion: RESEARCH_WORKFLOW_VERSION,
    outputLanguage: input.outputLanguage ?? "zh",
    target: input.target,
    targets: input.targets && input.targets.length > 1 ? input.targets : undefined,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    completedSteps: [],
    pendingSteps: workflowAgentIds(input.workflowId),
    agentResults: [],
    publicContext: input.publicContext,
    privateContext: input.privateContext,
    backtestContext: input.backtestContext,
    portfolioContext: input.portfolioContext,
    thesisDriftContext: input.thesisDriftContext,
    incomeInvestmentContext: input.incomeInvestmentContext,
    topic: input.topic,
    period: input.period,
    providerRoute: input.providerRoute,
  };
}

function errorDetail(error: unknown, agentId?: ResearchAgentId): ResearchJobError {
  if (error instanceof ResearchProviderError) return { ...error.detail, agentId };
  const message = error instanceof Error ? error.message : "未知研究错误";
  return {
    code: /abort|cancel/i.test(message) ? "cancelled" : "unknown",
    message,
    retryable: true,
    agentId,
  };
}

function cancellationError(agentId?: ResearchAgentId) {
  return new ResearchProviderError({
    code: "cancelled",
    message: "研究任务已由用户中断",
    retryable: true,
    agentId,
  });
}

function throwIfAborted(signal?: AbortSignal, agentId?: ResearchAgentId) {
  if (signal?.aborted) throw cancellationError(agentId);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

function mergeSourceLists(...lists: ResearchSource[][]) {
  const map = new Map<string, ResearchSource>();
  lists.flat().forEach((source) => {
    const existing = map.get(source.url);
    if (!existing || existing.origin === "model_output" || source.origin !== "model_output") map.set(source.url, source);
  });
  return [...map.values()];
}

function normalizedSourceUrl(value: string) {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function finalReportSources(markdown: string, sources: ResearchSource[]) {
  const cited = new Set(extractResearchSources(markdown).map((source) => normalizedSourceUrl(source.url)));
  return sources.filter((source) => source.origin === "provider" || cited.has(normalizedSourceUrl(source.url)));
}

function citedUpstreamSources(markdown: string, results: AgentResult[], finalResult: AgentResult) {
  const cited = new Set(extractResearchSources(markdown).map((source) => normalizedSourceUrl(source.url)));
  return mergeSourceLists(
    ...results
      .filter((result) => result !== finalResult)
      .map((result) => result.sources.filter((source) => cited.has(normalizedSourceUrl(source.url)))),
  );
}

function createWebSearchTrace(
  settings: ResearchProviderSettings,
  requested: boolean,
  model?: string,
): ResearchWebSearchTrace {
  const capability = getResearchWebSearchCapability({ ...settings, model: model || settings.model });
  return {
    requested,
    supported: capability.supported,
    phase: requested ? "requested" : "not_requested",
    provider: settings.preset,
    protocol: settings.protocol,
    model,
    method: requested ? "native" : undefined,
    queries: [],
    sources: [],
    errors: [],
  };
}

function applyWebSearchEvent(trace: ResearchWebSearchTrace, event: Extract<ModelStreamEvent, { type: "web_search" }>) {
  const hasExternalEvidence = trace.sources.some((source) => source.origin === "external_search");
  if (!hasExternalEvidence || event.phase === "completed" || event.phase === "searching" || event.phase === "requested") {
    trace.phase = event.phase;
  }
  if (event.query && !trace.queries.includes(event.query)) trace.queries.push(event.query);
  if (event.sources?.length) trace.sources = mergeSourceLists(trace.sources, event.sources);
  if (event.error && !trace.errors.includes(event.error)) trace.errors.push(event.error);
}

function mergeWebSearchTraces(results: AgentResult[], settings: ResearchProviderSettings): ResearchWebSearchTrace {
  const traces = results.flatMap((result) => result.webSearch ? [result.webSearch] : []);
  const requested = traces.some((trace) => trace.requested);
  const errors = [...new Set(traces.flatMap((trace) => trace.errors))];
  const completed = traces.some((trace) => trace.phase === "completed" || trace.sources.length > 0);
  const unverified = traces.some((trace) => trace.phase === "unverified");
  return {
    requested,
    supported: traces.length ? traces.every((trace) => !trace.requested || trace.supported) : getResearchWebSearchCapability(settings).supported,
    phase: completed ? "completed" : errors.length ? "failed" : unverified ? "unverified" : requested ? "requested" : "not_requested",
    provider: settings.preset,
    protocol: settings.protocol,
    model: settings.model,
    method: traces.some((trace) => trace.method === "hybrid")
      ? "hybrid"
      : traces.some((trace) => trace.method === "external") ? "external" : requested ? "native" : undefined,
    externalProvider: traces.find((trace) => trace.externalProvider)?.externalProvider,
    queries: [...new Set(traces.flatMap((trace) => trace.queries))],
    sources: mergeSourceLists(...traces.map((trace) => trace.sources)),
    errors,
  };
}

export async function runResearchJob(
  initialJob: ResearchJob,
  settingsOrRouting: ResearchProviderSettings | ResearchRunProviderRouting,
  options: ResearchRunOptions = {},
): Promise<{ job: ResearchJob; report: ResearchReport }> {
  const routing: ResearchRunProviderRouting = "execution" in settingsOrRouting
    ? settingsOrRouting
    : {
      execution: settingsOrRouting,
      executionModel: undefined,
      executionModelRole: "auto",
      synthesis: settingsOrRouting,
        ...(settingsOrRouting.auditModel ? { audit: settingsOrRouting } : {}),
      };
  const settings = routing.execution;
  const provider = new OpenAICompatibleProvider(settings);
  const synthesisSettings = routing.synthesis;
  const synthesisProvider = synthesisSettings.id === settings.id
    ? provider
    : new OpenAICompatibleProvider(synthesisSettings);
  const auditSettings = routing.audit;
  const auditProvider = auditSettings
    ? auditSettings.id === settings.id ? provider
      : auditSettings.id === synthesisSettings.id ? synthesisProvider
        : new OpenAICompatibleProvider(auditSettings)
    : undefined;
  const language = initialJob.outputLanguage ?? "zh";
  const message = (zh: string, en: string) => language === "en" ? en : zh;
  let job: ResearchJob = {
    ...initialJob,
    status: "running",
    startedAt: initialJob.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: undefined,
  };
  let commitQueue = Promise.resolve();

  const commit = async (update: (current: ResearchJob) => ResearchJob, message: string, delta?: string) => {
    commitQueue = commitQueue.then(async () => {
      try {
        job = { ...update(job), updatedAt: new Date().toISOString() };
        try {
          await saveResearchJob(job);
        } catch {
          // IndexedDB may be full or unavailable. Continue in-memory so the
          // research task doesn't crash - the job just won't be persisted.
        }
        // Isolate onProgress so a throwing callback (e.g. React setState on
        // an unmounted component) doesn't poison commitQueue and permanently
        // break job persistence + progress reporting.
        try {
          options.onProgress?.({ job, message, delta });
        } catch {
          // ignore callback errors
        }
      } catch (error) {
        // Last-resort guard: if update() or anything else throws, the queue
        // must stay healthy or every subsequent commit (and thus the whole
        // research run) fails.
        console.error("[research] commit failed", error);
      }
    });
    await commitQueue;
  };

  await commit((current) => current, message("研究任务已启动", "Research task started"));

  const externalBundlePromises = new Map<string, Promise<ExternalSearchBundle>>();
  let professionalDataPromise: Promise<ResearchProfessionalDataTrace> | null = null;
  const loadExternalBundle = (agentId?: ResearchAgentId) => {
    const externalSettings = options.externalSearchSettings;
    if (!externalSettings?.endpoint.trim() || !externalSettings.apiKey.trim()) return null;
    // Share one external search bundle across all agents in a multi-agent
    // workflow. Per-agent searches multiply external-search cost and rate-
    // limit quota by the agent count while returning largely overlapping
    // results (same target, same topic). Agent-specific focus is still
    // covered by native web search and the model's own reasoning. For
    // single-agent workflows, agentId is passed through normally.
    const agentCount = job.pendingSteps.filter((step) => step !== "synthesis").length;
    const key = agentCount > 1 ? "shared" : (agentId ?? "general");
    const existing = externalBundlePromises.get(key);
    if (existing) return existing;
    const pending = collectExternalSearchEvidence(job, externalSettings, options.signal, agentCount > 1 ? undefined : agentId);
    externalBundlePromises.set(key, pending);
    return pending;
  };

  const loadProfessionalData = () => {
    const profile = routing.professionalData;
    if (profile?.preset !== "volcengine_agent_plan" || !profile.apiKey.trim()) return null;
    if (!professionalDataPromise) professionalDataPromise = collectProfessionalData(job, profile, options.signal);
    return professionalDataPromise;
  };

  const prepareProfessionalData = async (request: ModelRunRequest): Promise<ResearchProfessionalDataTrace | undefined> => {
    const pending = loadProfessionalData();
    if (!pending) return undefined;
    options.onProgress?.({ job, message: message("正在通过方舟专业数据集补充结构化数据", "Collecting structured evidence from Volcengine DataPro") });
    try {
      const trace = await pending;
      throwIfAborted(options.signal);
      if (trace.items.length) {
        const evidence = { role: "system" as const, content: professionalDataEvidenceMessage(trace) };
        request.messages = request.messages.length > 1
          ? [request.messages[0]!, evidence, ...request.messages.slice(1)]
          : [evidence, ...request.messages];
        options.onProgress?.({
          job,
          message: message(
            `专业数据集已返回 ${trace.items.length}/${trace.queries.length} 组数据`,
            `DataPro returned ${trace.items.length}/${trace.queries.length} dataset result(s)`,
          ),
        });
      } else {
        options.onProgress?.({ job, message: message("专业数据集暂未返回数据，继续使用现有行情与联网证据", "DataPro returned no data; continuing with existing market and web evidence") });
      }
      return trace;
    } catch (error) {
      if (error instanceof ResearchProviderError && error.detail.code === "cancelled") throw error;
      const detail = error instanceof Error ? error.message : "专业数据集查询失败";
      options.onProgress?.({ job, message: message(`专业数据集不可用，已自动降级：${detail}`, `DataPro unavailable; continuing without it: ${detail}`) });
      return {
        requested: true,
        status: "failed",
        providerId: routing.professionalData?.id,
        providerName: routing.professionalData?.name,
        endpoint: "https://datapro.hqd.cn-beijing.volces.com/mcp",
        queriedAt: new Date().toISOString(),
        queries: [],
        datasetTypes: [],
        items: [],
        errors: [detail],
      };
    }
  };

  const prepareWebAccess = async (
    request: ModelRunRequest,
    model: string,
    phaseSettings: ResearchProviderSettings,
    agentId?: ResearchAgentId,
    allowExternal = true,
  ): Promise<ResearchWebSearchTrace> => {
    const mode = phaseSettings.webSearchMode;
    const nativeCapability = getResearchWebSearchCapability({ ...phaseSettings, model });
    const useNative = (mode === "native" || mode === "auto") && nativeCapability.supported;
    const wantsExternal = allowExternal && (mode === "external" || mode === "auto");
    let externalBundle: ExternalSearchBundle | null = null;
    let externalError = "";

    if (mode === "native" && !nativeCapability.supported) {
      throw new ResearchProviderError({ code: "invalid_response", message: nativeCapability.reasonZh, retryable: false });
    }
    if (wantsExternal) {
      const pending = loadExternalBundle(agentId);
      if (!pending && mode === "external") {
        throw new ResearchProviderError({
          code: "auth",
          message: "当前联网策略需要外部搜索，请到“设置 → AI 投研 → 外部联网搜索”填写 API 地址和 Key",
          retryable: false,
        });
      }
      if (pending) {
        try {
          options.onProgress?.({ job, message: message("正在通过独立搜索服务获取联网证据", "Collecting evidence through the external search service") });
          externalBundle = await pending;
          throwIfAborted(options.signal);
        } catch (error) {
          externalError = error instanceof Error ? error.message : "外部搜索失败";
          if (mode === "external" || !useNative) throw error;
          options.onProgress?.({ job, message: message(`外部搜索失败，继续使用模型原生联网：${externalError}`, `External search failed; continuing with native browsing: ${externalError}`) });
        }
      }
    }

    request.enableWebSearch = useNative;
    // Automatic mode must never turn an optional provider-native search tool
    // rejection into a failed research task. The provider retries without the
    // tool while preserving the failure in the research trace.
    request.continueOnWebSearchFailure = mode === "auto" || Boolean(externalBundle);
    if (externalBundle) {
      const evidence = { role: "system" as const, content: externalEvidenceMessage(externalBundle) };
      request.messages = request.messages.length > 1
        ? [request.messages[0]!, evidence, ...request.messages.slice(1)]
        : [evidence, ...request.messages];
    }

    const requested = mode !== "off" && (useNative || Boolean(externalBundle));
    const trace = createWebSearchTrace(phaseSettings, requested, model);
    trace.supported = requested;
    trace.method = useNative && externalBundle ? "hybrid" : externalBundle ? "external" : useNative ? "native" : undefined;
    if (externalBundle) {
      trace.phase = "completed";
      trace.externalProvider = externalBundle.provider;
      trace.queries = externalBundle.queries;
      trace.sources = externalBundleSources(externalBundle);
      trace.errors = [...externalBundle.errors];
    } else if (externalError) {
      trace.errors = [externalError];
    }
    return trace;
  };

  const workflowConfig = getWorkflowConfig(initialJob.workflowId);
  const agentCount = workflowConfig.agentIds.filter((id) => id !== "synthesis").length;

  const runAgent = async (agentId: Exclude<ResearchAgentId, "synthesis">) => {
    if (job.completedSteps.includes(agentId) && job.agentResults.some((item) => item.agentId === agentId)) return;
    await commit((current) => ({ ...current, currentStep: agentId }), message(`${researchAgentTitle(agentId)}开始研究`, `${researchAgentTitle(agentId, "en")} started`));
    let content = "";
    let usage: AgentResult["usage"];
    let professionalData: ResearchProfessionalDataTrace | undefined;
    const request = buildAgentRequest({
      workflowId: job.workflowId,
      agentId,
      publicContext: job.publicContext,
      privateContext: job.privateContext,
      backtestContext: job.backtestContext,
      portfolioContext: job.portfolioContext,
      thesisDriftContext: job.thesisDriftContext,
      incomeInvestmentContext: job.incomeInvestmentContext,
      agentResults: job.agentResults,
      topic: job.topic,
      period: job.period,
      webSearchMode: settings.webSearchMode,
      maxOutputTokens: settings.maxOutputTokens,
      outputLanguage: language,
    });
    request.model = routing.executionModel
      || (workflowConfig.useFullModel ? settings.model : (settings.fastModel || settings.model));
    let webSearch = createWebSearchTrace(settings, false, request.model);
    try {
      throwIfAborted(options.signal, agentId);
      const usesPriorResearchOnly = agentId === "wechat-writer"
        || agentId === "wechat-editor"
        || agentId === "wechat-reader"
        || agentId === "series-writer";
      if (usesPriorResearchOnly) {
        request.enableWebSearch = false;
      } else {
        professionalData = await prepareProfessionalData(request);
        webSearch = await prepareWebAccess(request, request.model, settings, agentId);
      }
      throwIfAborted(options.signal, agentId);
      for await (const event of provider.run(request, options.signal)) {
        if (event.type === "delta") {
          content += event.text;
          options.onProgress?.({ job, message: message(`${researchAgentTitle(agentId)}正在输出`, `${researchAgentTitle(agentId, "en")} is writing`), delta: event.text });
        } else if (event.type === "usage") usage = event.usage;
        else if (event.type === "web_search") {
          applyWebSearchEvent(webSearch, event);
          const statusMessage = event.phase === "searching"
            ? message(`${researchAgentTitle(agentId)}正在联网检索`, `${researchAgentTitle(agentId, "en")} is searching the web`)
            : event.phase === "completed"
              ? message(`${researchAgentTitle(agentId)}已取得联网来源`, `${researchAgentTitle(agentId, "en")} received web sources`)
              : event.phase === "unverified"
                ? message("联网请求未取得可验证引用", "Web search returned no verifiable citations")
                : event.phase === "failed"
                  ? message("联网工具执行失败", "Web search tool failed")
                  : message("已请求联网搜索", "Web search requested");
          options.onProgress?.({ job, message: statusMessage });
        }
      }
      throwIfAborted(options.signal, agentId);
      if (!content.trim()) throw new ResearchProviderError({ code: "invalid_response", message: "模型返回了空报告", retryable: true });
      const result: AgentResult = {
        agentId,
        title: researchAgentTitle(agentId, language),
        content: content.trim(),
        completedAt: new Date().toISOString(),
        sources: mergeSourceLists(
          webSearch.sources,
          extractResearchSources(content).map((source) => ({ ...source, origin: "model_output" as const })),
        ),
        usage,
        model: request.model,
        providerId: settings.id,
        providerName: settings.name,
        webSearch,
        professionalData,
      };
      await commit((current) => ({
        ...current,
        agentResults: [...current.agentResults.filter((item) => item.agentId !== agentId), result],
        completedSteps: [...new Set([...current.completedSteps, agentId])],
        pendingSteps: current.pendingSteps.filter((item) => item !== agentId),
      }), message(`${researchAgentTitle(agentId)}已完成`, `${researchAgentTitle(agentId, "en")} completed`));
    } catch (error) {
      const detail = errorDetail(error, agentId);
      await commit((current) => ({
        ...current,
        status: detail.code === "cancelled" ? "cancelled" : "failed",
        error: detail,
        currentStep: agentId,
      }), detail.message);
      throw error;
    }
  };

  const agentIds = workflowAgentIds(job.workflowId).filter((id): id is Exclude<ResearchAgentId, "synthesis"> => id !== "synthesis");
  if (workflowConfig.executionGroups?.length) {
    for (const group of workflowConfig.executionGroups) {
      const runnable = group.filter((id): id is Exclude<ResearchAgentId, "synthesis"> => id !== "synthesis");
      await runWithConcurrency(runnable, Math.max(1, Math.min(settings.maxConcurrency, runnable.length)), runAgent);
    }
  } else {
    await runWithConcurrency(agentIds, workflowConfig.parallel ? settings.maxConcurrency : 1, runAgent);
  }

  let finalResult: AgentResult;
  if (workflowConfig.needsSynthesis) {
    const existing = job.agentResults.find((item) => item.agentId === "synthesis");
    if (existing && job.completedSteps.includes("synthesis")) {
      finalResult = existing;
    } else {
      const synthesisProgress = workflowConfig.executionGroups?.length
        ? message(`正在汇总${agentCount}个前序产物`, `Synthesizing ${agentCount} staged outputs`)
        : message(`正在综合${agentCount}份独立报告`, `Synthesizing ${agentCount} independent reports`);
      await commit((current) => ({ ...current, status: "synthesizing", currentStep: "synthesis" }), synthesisProgress);
      const request = buildSynthesisRequest({
        workflowId: job.workflowId,
        publicContext: job.publicContext,
        privateContext: job.privateContext,
        agentResults: job.agentResults.filter((item) => item.agentId !== "synthesis"),
        webSearchMode: synthesisSettings.webSearchMode,
        maxOutputTokens: synthesisSettings.maxOutputTokens,
        outputLanguage: language,
        period: job.period,
        topic: job.topic,
      });
      request.model = routing.synthesisModel || synthesisSettings.synthesisModel || synthesisSettings.model;
      let content = "";
      let usage: AgentResult["usage"];
      let webSearch = createWebSearchTrace(synthesisSettings, false, request.model);
      try {
        throwIfAborted(options.signal, "synthesis");
        // The synthesis prompt already contains the independently researched
        // reports and their citations. Avoid injecting the same external
        // evidence bundle a fifth time; native search may still verify gaps.
        if (job.workflowId === "wechat_article" || job.workflowId === "deep_company_series") {
          request.enableWebSearch = false;
        } else {
          webSearch = await prepareWebAccess(request, request.model, synthesisSettings, "synthesis", false);
        }
        throwIfAborted(options.signal, "synthesis");
        for await (const event of synthesisProvider.run(request, options.signal)) {
          if (event.type === "delta") {
            content += event.text;
            options.onProgress?.({ job, message: message("正在生成综合报告", "Writing the synthesis report"), delta: event.text });
          } else if (event.type === "usage") usage = event.usage;
          else if (event.type === "web_search") {
            applyWebSearchEvent(webSearch, event);
            options.onProgress?.({
              job,
              message: event.phase === "completed"
                ? message("综合阶段已取得联网来源", "Synthesis received web sources")
                : event.phase === "searching"
                  ? message("综合阶段正在联网核验", "Synthesis is verifying online")
                  : event.error || message("已请求综合联网核验", "Synthesis web verification requested"),
            });
          }
        }
        throwIfAborted(options.signal, "synthesis");
        if (!content.trim()) throw new ResearchProviderError({ code: "invalid_response", message: "综合报告为空", retryable: true });
        finalResult = {
          agentId: "synthesis",
          title: researchAgentTitle("synthesis", language),
          content: content.trim(),
          completedAt: new Date().toISOString(),
          sources: mergeSourceLists(
            webSearch.sources,
            extractResearchSources(content).map((source) => ({ ...source, origin: "model_output" as const })),
          ),
          usage,
          model: request.model,
          providerId: synthesisSettings.id,
          providerName: synthesisSettings.name,
          webSearch,
        };
        await commit((current) => ({
          ...current,
          agentResults: [...current.agentResults.filter((item) => item.agentId !== "synthesis"), finalResult],
          completedSteps: [...new Set([...current.completedSteps, "synthesis" as const])],
          pendingSteps: current.pendingSteps.filter((item) => item !== "synthesis"),
        }), message("综合报告已生成", "Synthesis report completed"));
      } catch (error) {
        const detail = errorDetail(error, "synthesis");
        await commit((current) => ({ ...current, status: detail.code === "cancelled" ? "cancelled" : "failed", error: detail }), detail.message);
        throw error;
      }
    }
  } else {
    const singleAgentResult = agentIds[0] ? job.agentResults.find((item) => item.agentId === agentIds[0]) : undefined;
    if (!singleAgentResult) {
      throw new ResearchProviderError({
        code: "invalid_response",
        message: `未找到代理 ${agentIds[0] ?? "(空)"} 的输出结果`,
        retryable: false,
      });
    }
    finalResult = singleAgentResult;
  }

  if (options.signal?.aborted) {
    const error = cancellationError(job.currentStep);
    await commit((current) => ({ ...current, status: "cancelled", error: error.detail }), error.detail.message);
    throw error;
  }
  await commit((current) => ({ ...current, status: "auditing", currentStep: undefined }), message("正在执行本地报告审计", "Running the local report audit"));
  const allWebSearch = mergeWebSearchTraces(job.agentResults, settings);
  const professionalData = job.agentResults.find((result) => result.professionalData?.requested)?.professionalData;
  const sources = mergeSourceLists(
    finalReportSources(finalResult.content, finalResult.sources),
    citedUpstreamSources(finalResult.content, job.agentResults, finalResult),
  );
  const structuredSearchSources = allWebSearch.sources.filter((source) => source.origin !== "model_output");
  const webSearch: ResearchWebSearchTrace = {
    ...allWebSearch,
    // Search verification records whether the provider/search service actually
    // returned sources. Whether the final report cited them is audited separately.
    sources: structuredSearchSources,
    phase: allWebSearch.requested && structuredSearchSources.length === 0
      ? (allWebSearch.errors.length ? "failed" : "unverified")
      : allWebSearch.phase,
  };
  let modelReview: ResearchModelAuditResult | undefined;
  const auditModel = auditSettings ? routing.auditModel || auditSettings.auditModel || auditSettings.model : "";
  if (auditSettings && auditProvider && auditModel) {
    await commit((current) => ({ ...current, status: "auditing", currentStep: undefined }), message("正在使用审计模型复核终稿", "Reviewing the final report with the audit model"));
    const writingModels = new Set(job.agentResults
      .filter((item) => item.model)
      .map((item) => `${item.providerId || settings.id}:${item.model}`));
    let auditContent = "";
    try {
      const request = buildModelAuditRequest({
        markdown: finalResult.content,
        sources,
        publicContext: job.publicContext,
        model: auditModel,
        maxOutputTokens: auditSettings.maxOutputTokens,
      });
      for await (const event of auditProvider.run(request, options.signal)) {
        if (event.type === "delta") auditContent += event.text;
      }
      // The audit request sets thinkingLevel: "off" so reasoning models don't
      // burn the output token budget on internal reasoning. If content is
      // still empty, the model either doesn't support disabling thinking and
      // the fallback levels also produced no output, or the input exceeded
      // its context window. Surface as unavailable rather than going to the
      // repair path (repairing empty content yields "0 claims reviewed").
      if (!auditContent.trim()) {
        throw new Error("审计模型返回空内容（模型可能在推理中耗尽输出额度，或输入超出上下文长度）");
      }
      const independent = !writingModels.has(`${auditSettings.id}:${auditModel}`);
      let parsedReview: ResearchModelAuditResult;
      try {
        parsedReview = parseModelAuditResult(auditContent, auditModel, independent);
      } catch {
        options.onProgress?.({ job, message: message("审计输出格式不合规，正在自动修复并重试", "Repairing the audit model's structured output") });
        let repairedContent = "";
        const repairRequest = buildModelAuditRepairRequest({ content: auditContent, model: auditModel });
        for await (const event of auditProvider.run(repairRequest, options.signal)) {
          if (event.type === "delta") repairedContent += event.text;
        }
        parsedReview = parseModelAuditResult(repairedContent, auditModel, independent);
      }
      modelReview = {
        ...parsedReview,
        providerId: auditSettings.id,
        providerName: auditSettings.name,
      };
    } catch (error) {
      modelReview = {
        status: "unavailable",
        model: auditModel,
        providerId: auditSettings.id,
        providerName: auditSettings.name,
        checkedAt: new Date().toISOString(),
        independent: !writingModels.has(`${auditSettings.id}:${auditModel}`),
        summary: error instanceof Error ? `模型复核未完成：${error.message}` : "模型复核未完成",
        checkedClaims: 0,
        verifiedClaims: 0,
        findings: [],
      };
    }
  }
  const calculationChecks = verifyTargetedReportCalculations(finalResult.content, job.publicContext.targetContexts);
  const audit = auditResearchReport({
    markdown: finalResult.content,
    dataCutoff: job.publicContext.dataCutoff,
    sources,
    webSearch,
    professionalData,
    calculationChecks,
    publicContext: job.publicContext,
    modelReview,
  });
  const now = new Date().toISOString();
  const independentResults = job.agentResults.filter((item) => item.agentId !== "synthesis");
  const targetTitle = job.targets && job.targets.length > 1
    ? job.targets.map((target) => target.name || target.symbol).join(" vs ")
    : job.target.name || job.target.symbol;
  const report: ResearchReport = {
    id: newId("report"),
    jobId: job.id,
    workflowId: job.workflowId,
    workflowVersion: job.workflowVersion,
    target: job.target,
    targets: job.targets,
    title: `${targetTitle} · ${researchWorkflowTitle(job.workflowId, language)}`,
    summary: firstReportSummary(finalResult.content),
    markdown: finalResult.content,
    agentResults: independentResults.length > 1 ? independentResults : undefined,
    createdAt: now,
    updatedAt: now,
    dataCutoff: job.publicContext.dataCutoff,
    dataStatus: job.publicContext.dataStatus,
    targetContexts: job.publicContext.targetContexts,
    sources,
    webSearch,
    professionalData,
    audit,
    backtestContext: job.backtestContext,
    privateContextIncluded: Boolean(job.privateContext),
    providerRoute: job.providerRoute,
  };
  if (options.signal?.aborted) {
    const error = cancellationError();
    await commit((current) => ({ ...current, status: "cancelled", error: error.detail }), error.detail.message);
    throw error;
  }
  await saveResearchReport(report);
  await commit((current) => ({
    ...current,
    status: "completed",
    completedAt: new Date().toISOString(),
    reportId: report.id,
    currentStep: undefined,
    error: undefined,
  }), message("研究任务已完成", "Research task completed"));
  return { job, report };
}
