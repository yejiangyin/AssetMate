import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Database,
  Download,
  FileCheck2,
  Globe2,
  Loader2,
  Play,
  RefreshCw,
  Route,
  Settings2,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { SecuritySearchInput, type SecuritySearchSuggestion } from "../../components/SecuritySearchInput";
import { useApp } from "../../context/AppContext";
import { assetTypeLabel, marketLabel } from "../../i18n";
import type { LiveResult, Market } from "../../services/securitiesApi";
import {
  buildPortfolioContext,
  buildPrivateHoldingContext,
  buildPublicResearchContext,
  researchTargetFromBacktestSeed,
  researchTargetFromHolding,
} from "../../research/contextBuilder";
import { createResearchJob, runResearchJob } from "../../research/orchestrator";
import { enrichResearchTargets } from "../../research/marketData";
import { ensureModelEndpointPermission } from "../../research/providers/openAiCompatible";
import { isResearchProviderConfigured, resolveResearchProviderRouting, updateWorkflowProviderRoute, workflowProviderRoute } from "../../research/providerRouting";
import { getResearchWebSearchCapability } from "../../research/webSearchCapabilities";
import { ResearchReportView } from "../../research/components/ResearchReportView";
import { downloadResearchReports } from "../../research/reportDownload";
import {
  deleteResearchJob,
  deleteResearchReport,
  listResearchJobs,
  listResearchReports,
  loadResearchExternalSearchSettings,
  loadResearchProviderProfiles,
  MAX_RESEARCH_JOBS,
  MAX_RESEARCH_REPORTS,
  saveResearchJob,
  saveResearchProviderProfiles,
  subscribeResearchStorageChanges,
} from "../../research/storage";
import {
  RESEARCH_ASSET_TYPES,
  RESEARCH_CURRENCIES,
  RESEARCH_MARKETS,
  defaultCurrencyForMarket,
  researchTargetFieldsFromSearchResult,
} from "../../research/targetSelection";
import type {
  BacktestResearchContext,
  BacktestSeed,
  IncomeInvestmentContext,
  ResearchExternalSearchSettings,
  ResearchJob,
  ResearchProviderCollection,
  ResearchProviderSettings,
  ResearchReport,
  ResearchTarget,
  ResearchTargetContext,
  ResearchWorkflowId,
} from "../../research/types";
import { researchAgentTitle, researchWorkflowTitle, workflowAgentIds } from "../../research/workflows/prompts";
import {
  WORKFLOW_CATEGORY_LABELS,
  WORKFLOW_CATEGORY_ORDER,
  WORKFLOW_REGISTRY,
  getWorkflowConfig,
} from "../../research/workflows/registry";

function targetFromInputs(input: { symbol: string; name: string; market: string; assetType: string; currency: string }): ResearchTarget {
  return {
    symbol: input.symbol.trim(),
    displaySymbol: input.symbol.trim(),
    name: input.name.trim() || input.symbol.trim(),
    market: input.market,
    assetType: input.assetType,
    currency: input.currency,
  };
}

function researchTargetKey(target: Pick<ResearchTarget, "market" | "symbol">) {
  return `${target.market}:${target.symbol}`;
}

function researchTargetsTitle(targets: ResearchTarget[], isEn: boolean) {
  if (targets.length === 0) return isEn ? "No target" : "未选择标的";
  if (targets.length === 1) return targets[0]!.name || targets[0]!.symbol;
  return isEn ? `${targets.length} targets` : `${targets.length} 个标的`;
}

function researchProtocolLabel(protocol: ResearchProviderSettings["protocol"]) {
  return {
    responses: "Responses",
    chat_completions: "OpenAI Chat",
    anthropic_messages: "Anthropic Messages",
    gemini_native: "Gemini Native",
    ollama_chat: "Ollama Chat",
  }[protocol];
}

function researchMarketScope(value: string | undefined): Market | "" {
  return value && (RESEARCH_MARKETS as readonly string[]).includes(value) ? value as Market : "";
}

export async function enrichResearchContext(
  target: ResearchTarget,
  workflowId: ResearchWorkflowId,
): Promise<ResearchTargetContext> {
  const [context] = await enrichResearchTargets([target], workflowId);
  if (!context) throw new Error("研究行情上下文生成失败");
  return context;
}

function SelectControl({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-[40px] w-full appearance-none rounded-[10px] border border-app-border bg-app-card pl-3 pr-8 text-[12px] font-medium text-tp outline-none focus:border-app-accent"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tm" />
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[12px] font-medium text-tm">{children}</p>;
}

function jobStatusLabel(status: ResearchJob["status"], isEn: boolean) {
  const labels = isEn
    ? { draft: "Draft", preparing: "Preparing", running: "Running", synthesizing: "Synthesizing", auditing: "Auditing", paused: "Paused", cancelled: "Cancelled", failed: "Failed", completed: "Completed" }
    : { draft: "草稿", preparing: "准备中", running: "研究中", synthesizing: "综合中", auditing: "审计中", paused: "已暂停", cancelled: "已取消", failed: "失败", completed: "已完成" };
  return labels[status];
}

function isInterrupted(status: ResearchJob["status"]) {
  return status === "preparing" || status === "running" || status === "synthesizing" || status === "auditing";
}

export function AIResearchPanel({
  initialSeed,
  backtestContext,
  onBacktest,
  onClearBacktestContext,
}: {
  initialSeed?: BacktestSeed | null;
  backtestContext?: BacktestResearchContext | null;
  onBacktest: (seed: BacktestSeed) => void;
  onClearBacktestContext?: () => void;
}) {
  const { language, holdings, stats, dcaPlans } = useApp();
  const navigate = useNavigate();
  const isEn = language === "en";
  const [workflowId, setWorkflowId] = useState<ResearchWorkflowId>(backtestContext ? "backtest_interpretation" : "quick_check");
  const [selectedHoldingId, setSelectedHoldingId] = useState("");
  const [symbol, setSymbol] = useState(initialSeed?.symbol ?? backtestContext?.symbol ?? "");
  const [name, setName] = useState(initialSeed?.name ?? backtestContext?.name ?? "");
  const [market, setMarket] = useState(initialSeed?.market ?? backtestContext?.market ?? "US");
  const [assetType, setAssetType] = useState(initialSeed?.assetType ?? "stock");
  const [currency, setCurrency] = useState(backtestContext?.currency ?? "");
  const [additionalTargets, setAdditionalTargets] = useState<ResearchTarget[]>([]);
  const [securityQuery, setSecurityQuery] = useState("");
  const [marketScope, setMarketScope] = useState<Market | "">(() => researchMarketScope(initialSeed?.market ?? backtestContext?.market));
  const [editingTargetKey, setEditingTargetKey] = useState<string | null>(null);
  const [sharePrivate, setSharePrivate] = useState(false);
  const [topic, setTopic] = useState("");
  const [qualityScreenInputMode, setQualityScreenInputMode] = useState<"targets" | "scope">("targets");
  const [period, setPeriod] = useState("");
  const [incomeMode, setIncomeMode] = useState<IncomeInvestmentContext["mode"]>("new");
  const [incomeRole, setIncomeRole] = useState<IncomeInvestmentContext["role"]>("unspecified");
  const [incomeTargetYield, setIncomeTargetYield] = useState("");
  const [incomeTaxResidence, setIncomeTaxResidence] = useState("");
  const [incomeHorizon, setIncomeHorizon] = useState("");
  const [driftOlderId, setDriftOlderId] = useState("");
  const [driftNewerId, setDriftNewerId] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set(["deep", "earnings", "portfolio", "tools", "assetmate"]));
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [activeJob, setActiveJob] = useState<ResearchJob | null>(null);
  const [selectedReport, setSelectedReport] = useState<ResearchReport | null>(null);
  const [providerSettings, setProviderSettings] = useState<ResearchProviderSettings | null>(null);
  const [providerProfiles, setProviderProfiles] = useState<ResearchProviderCollection | null>(null);
  const [externalSearchSettings, setExternalSearchSettings] = useState<ResearchExternalSearchSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);
  const [message, setMessage] = useState("");
  const [streamPreview, setStreamPreview] = useState("");
  const [stoppingJobId, setStoppingJobId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "report" | "job"; id: string; title: string } | null>(null);
  const [reportVisibleCount, setReportVisibleCount] = useState(20);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const [storedJobs, storedReports, providerCollection, searchSettings] = await Promise.all([
      listResearchJobs(),
      listResearchReports(),
      loadResearchProviderProfiles(),
      loadResearchExternalSearchSettings(),
    ]);
    const settings = providerCollection.profiles.find((profile) => profile.id === providerCollection.activeProfileId) ?? providerCollection.profiles[0]!;
    const recovered = await Promise.all(storedJobs.map(async (job) => {
      if (!isInterrupted(job.status)) return job;
      const paused = { ...job, status: "paused" as const, updatedAt: new Date().toISOString() };
      await saveResearchJob(paused);
      return paused;
    }));
    setJobs(recovered);
    setReports(storedReports);
    setProviderProfiles(providerCollection);
    setProviderSettings(settings);
    setExternalSearchSettings(searchSettings);
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => subscribeResearchStorageChanges(() => { void reload(); }), [reload]);
  useEffect(() => {
    if (!providerProfiles) return;
    setProviderSettings(resolveResearchProviderRouting(providerProfiles, workflowId).routing.execution);
  }, [providerProfiles, workflowId]);

  useEffect(() => {
    if (backtestContext) {
      setWorkflowId("backtest_interpretation");
      setSymbol(backtestContext.symbol);
      setName(backtestContext.name);
      setMarket(backtestContext.market);
      setMarketScope(researchMarketScope(backtestContext.market));
      setCurrency(backtestContext.currency);
      setAdditionalTargets([]);
      setSecurityQuery("");
      setSelectedReport(null);
    } else if (initialSeed) {
      setSymbol(initialSeed.symbol);
      setName(initialSeed.name);
      setMarket(initialSeed.market);
      setMarketScope(researchMarketScope(initialSeed.market));
      setAssetType(initialSeed.assetType);
      setCurrency((current) => current || defaultCurrencyForMarket(initialSeed.market));
      setAdditionalTargets([]);
      setSecurityQuery("");
      setWorkflowId((current) => current === "backtest_interpretation" ? "quick_check" : current);
    } else {
      setWorkflowId((current) => current === "backtest_interpretation" ? "quick_check" : current);
    }
  }, [backtestContext, initialSeed]);

  const selectedHolding = useMemo(
    () => holdings.find((holding) => holding.id === selectedHoldingId),
    [holdings, selectedHoldingId],
  );

  const workflowConfig = useMemo(() => getWorkflowConfig(workflowId), [workflowId]);
  const usesTopicInput = Boolean(workflowConfig.needsTopicInput)
    || (workflowId === "quality_screen" && qualityScreenInputMode === "scope");

  const applyPrimaryTarget = (target: ResearchTarget) => {
    setSymbol(target.symbol);
    setName(target.name);
    setMarket(target.market);
    setAssetType(target.assetType);
    setCurrency(target.currency || defaultCurrencyForMarket(target.market));
    setSelectedHoldingId(target.holdingId ?? "");
  };

  const addResearchTarget = (target: ResearchTarget) => {
    const primary = symbol ? targetFromInputs({ symbol, name, market, assetType, currency }) : null;
    const current = primary ? [primary, ...additionalTargets] : additionalTargets;
    if (current.some((item) => researchTargetKey(item) === researchTargetKey(target))) {
      setMessage(isEn ? "This target is already selected." : "该标的已在研究列表中。");
      setSecurityQuery("");
      return;
    }
    if (current.length >= 5) {
      setMessage(isEn ? "Up to five targets can be compared at once." : "一次最多对比 5 个标的。");
      return;
    }
    if (!primary) applyPrimaryTarget(target);
    else setAdditionalTargets((items) => [...items, target]);
    setSecurityQuery("");
    setEditingTargetKey(null);
    setMessage("");
  };

  const handleHoldingSuggestionSelect = (suggestion: SecuritySearchSuggestion) => {
    const holding = holdings.find((item) => item.id === suggestion.id);
    if (holding) addResearchTarget(researchTargetFromHolding(holding));
  };

  const handleMarketScopeChange = (next: Market | "") => {
    setMarketScope(next);
    setSecurityQuery("");
    setEditingTargetKey(null);
  };

  const handleSecurityQueryChange = (next: string) => setSecurityQuery(next);

  const handleSecuritySelect = (result: LiveResult) => {
    addResearchTarget({
      ...researchTargetFieldsFromSearchResult(result),
      currentPrice: result.price > 0 ? result.price : undefined,
    });
  };

  const updateResearchTarget = (key: string, patch: Partial<ResearchTarget>) => {
    const primary = targetFromInputs({ symbol, name, market, assetType, currency });
    if (symbol && researchTargetKey(primary) === key) {
      const nextMarket = patch.market ?? market;
      const previousDefault = defaultCurrencyForMarket(market);
      setSelectedHoldingId("");
      if (patch.market != null) {
        setMarket(patch.market);
        setEditingTargetKey(`${patch.market}:${symbol}`);
      }
      if (patch.assetType != null) setAssetType(patch.assetType);
      if (patch.currency != null) setCurrency(patch.currency);
      else if (patch.market != null && (!currency || currency === previousDefault)) setCurrency(defaultCurrencyForMarket(nextMarket));
      return;
    }
    setAdditionalTargets((items) => items.map((item) => {
      if (researchTargetKey(item) !== key) return item;
      const nextMarket = patch.market ?? item.market;
      const previousDefault = defaultCurrencyForMarket(item.market);
      return {
        ...item,
        ...patch,
        holdingId: undefined,
        currency: patch.currency ?? (patch.market != null && (!item.currency || item.currency === previousDefault)
          ? defaultCurrencyForMarket(nextMarket)
          : item.currency),
      };
    }));
    if (patch.market != null) setEditingTargetKey(`${patch.market}:${key.slice(key.indexOf(":") + 1)}`);
  };

  const removeResearchTarget = (key: string) => {
    const primary = targetFromInputs({ symbol, name, market, assetType, currency });
    if (symbol && researchTargetKey(primary) === key) {
      const [next, ...rest] = additionalTargets;
      if (next) {
        applyPrimaryTarget(next);
        setAdditionalTargets(rest);
        setMarketScope(researchMarketScope(next.market));
      } else {
        setSymbol("");
        setName("");
        setMarket(marketScope || "US");
        setAssetType(marketScope === "CRYPTO" ? "crypto" : marketScope === "FUND" ? "fund" : marketScope === "BOND" ? "bond" : "stock");
        setCurrency(defaultCurrencyForMarket(marketScope));
        setSelectedHoldingId("");
      }
    } else {
      setAdditionalTargets((items) => items.filter((item) => researchTargetKey(item) !== key));
    }
    setEditingTargetKey(null);
  };

  const setWorkflowProvider = async (
    role: "execution" | "synthesis" | "audit" | "professionalData",
    profileId: string,
  ) => {
    if (!providerProfiles) return;
    const changes = role === "execution"
      ? { executionProfileId: profileId || undefined }
      : role === "synthesis"
        ? { synthesisProfileId: profileId || undefined }
        : role === "professionalData"
          ? { professionalDataProfileId: profileId || undefined }
        : profileId === "__off__"
          ? { auditProfileId: undefined, auditDisabled: true }
          : { auditProfileId: profileId || undefined, auditDisabled: false };
    const next = updateWorkflowProviderRoute(providerProfiles, workflowId, changes);
    const resolved = resolveResearchProviderRouting(next, workflowId);
    setProviderProfiles(next);
    setProviderSettings(resolved.routing.execution);
    await saveResearchProviderProfiles(next);
    setMessage(isEn ? "Model responsibilities saved for this workflow." : `已保存“${workflowConfig.titles.zh}”的模型调用分工。`);
  };

  const setWorkflowExecutionModelRole = async (value: string) => {
    if (!providerProfiles) return;
    const executionModelRole = value === "main" || value === "fast" ? value : undefined;
    const next = updateWorkflowProviderRoute(providerProfiles, workflowId, { executionModelRole });
    const resolved = resolveResearchProviderRouting(next, workflowId);
    setProviderProfiles(next);
    setProviderSettings(resolved.routing.execution);
    await saveResearchProviderProfiles(next);
    setMessage(isEn ? "Execution model strategy saved for this workflow." : `已保存“${workflowConfig.titles.zh}”的执行模型策略。`);
  };

  const openAISettings = () => {
    navigate("/settings/ai");
  };

  const currentTarget = useMemo(() => {
    if (selectedHolding) return researchTargetFromHolding(selectedHolding);
    if (backtestContext) return researchTargetFromBacktestSeed({
      symbol: backtestContext.symbol,
      name: backtestContext.name,
      market: backtestContext.market,
      assetType,
    });
    return targetFromInputs({ symbol, name, market, assetType, currency });
  }, [assetType, backtestContext, currency, market, name, selectedHolding, symbol]);

  const allTargets = useMemo(
    () => symbol ? [currentTarget, ...additionalTargets] : additionalTargets,
    [additionalTargets, currentTarget, symbol],
  );

  const holdingSearchSuggestions = useMemo<SecuritySearchSuggestion[]>(() => holdings.map((holding) => ({
    id: holding.id,
    result: {
      symbol: holding.symbol,
      name: holding.name,
      market: holding.market as Market,
      assetType: holding.assetType,
      currency: holding.currency,
      price: holding.currentPrice,
      priceReady: holding.currentPrice > 0,
      source: "local",
    },
  })), [holdings]);

  const companyReports = useMemo(() => {
    if (workflowId !== "thesis_drift") return [];
    const query = (currentTarget.name || currentTarget.symbol || "").toLowerCase();
    if (!query) return reports;
    return reports.filter((report) => {
      const name = report.target.name?.toLowerCase() ?? "";
      const sym = report.target.symbol?.toLowerCase() ?? "";
      return name.includes(query) || sym.includes(query);
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [reports, workflowId, currentTarget.name, currentTarget.symbol]);

  const driftOlderReport = useMemo(() => reports.find((r) => r.id === driftOlderId), [reports, driftOlderId]);
  const driftNewerReport = useMemo(() => reports.find((r) => r.id === driftNewerId), [reports, driftNewerId]);

  const run = async (resumeJob?: ResearchJob) => {
    if (abortRef.current) {
      setMessage(isEn ? "The previous request is still stopping. Try again in a moment." : "上一次研究请求正在结束，请稍后再重新开始。");
      return;
    }
    const providerCollection = providerProfiles ?? await loadResearchProviderProfiles();
    const searchSettings = externalSearchSettings ?? await loadResearchExternalSearchSettings();
    const runWorkflowId = resumeJob?.workflowId ?? workflowId;
    const config = getWorkflowConfig(runWorkflowId);
    const resolvedProviders = resolveResearchProviderRouting(providerCollection, runWorkflowId, resumeJob?.providerRoute);
    const providerRouting = resolvedProviders.routing;
    const providerRouteSnapshot = resolvedProviders.snapshot;
    const settings = providerRouting.execution;
    const runUsesTopicInput = resumeJob ? Boolean(resumeJob.topic) : usesTopicInput;
    const runUsesTargetAndTopic = runWorkflowId === "deep_company_series";
    const runTopic = resumeJob?.topic ?? topic.trim();
    const runPeriod = resumeJob?.period ?? period.trim();
    const incomeInvestmentContext: IncomeInvestmentContext | undefined = resumeJob?.incomeInvestmentContext
      ?? (config.needsIncomeInputs ? {
        mode: incomeMode,
        role: incomeRole,
        targetYield: incomeTargetYield.trim() || undefined,
        taxResidence: incomeTaxResidence.trim() || undefined,
        horizon: incomeHorizon.trim() || undefined,
      } : undefined);
    const requiredConnections = [
      { role: isEn ? "Execution" : "执行", profile: providerRouting.execution, model: providerRouting.executionModel },
      ...(config.needsSynthesis ? [{ role: isEn ? "Synthesis" : "综合", profile: providerRouting.synthesis, model: providerRouting.synthesisModel }] : []),
      ...(providerRouting.audit ? [{ role: isEn ? "Audit" : "审计", profile: providerRouting.audit, model: providerRouting.auditModel }] : []),
    ].filter((item, index, items) => items.findIndex((candidate) => candidate.profile.id === item.profile.id) === index);
    const incomplete = requiredConnections.find((item) => !isResearchProviderConfigured(item.profile, item.model));
    if (incomplete) {
      setShowSettings(true);
      setMessage(isEn
        ? `${incomplete.role} API “${incomplete.profile.name}” is incomplete. Check its endpoint, selected model${incomplete.profile.authMode === "none" ? "" : " and API key"}.`
        : `${incomplete.role} API“${incomplete.profile.name}”配置不完整，请检查地址、所选模型${incomplete.profile.authMode === "none" ? "" : "和 API Key"}。`);
      return;
    }
    if (runUsesTopicInput && !runTopic.trim()) {
      setMessage(isEn ? "Enter a topic or question." : "请输入主题或问题。 ");
      return;
    }
    let targetToRun: ResearchTarget;
    let targetsToRun: ResearchTarget[] | undefined;
    if (resumeJob) {
      targetToRun = resumeJob.target;
      targetsToRun = resumeJob.targets;
    } else if (config.needsPortfolioContext) {
      targetToRun = {
        symbol: "PORTFOLIO",
        displaySymbol: "PORTFOLIO",
        name: isEn ? "My Portfolio" : "我的组合",
        market: "US",
        assetType: "stock",
        currency: holdings[0]?.currency ?? "",
      };
    } else if (runUsesTopicInput && !runUsesTargetAndTopic) {
      const trimmed = runTopic.trim();
      targetToRun = {
        symbol: "TOPIC",
        displaySymbol: "TOPIC",
        name: trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed,
        market: "US",
        assetType: "stock",
        currency: "",
      };
    } else {
      targetToRun = currentTarget;
      targetsToRun = allTargets;
    }
    if (!config.needsPortfolioContext && (!runUsesTopicInput || runUsesTargetAndTopic) && !targetToRun.symbol) {
      setMessage(isEn ? "Enter a security symbol." : "请输入证券代码。 ");
      return;
    }
    if (config.needsPortfolioContext && holdings.length === 0) {
      setMessage(isEn ? "No holdings to review." : "没有持仓可分析。 ");
      return;
    }
    const targetCount = targetsToRun?.length ?? (targetToRun.symbol ? 1 : 0);
    const minTargets = config.minTargets ?? 1;
    const maxTargets = config.maxTargets ?? (config.supportsMultipleTargets ? 5 : 1);
    if (!config.needsPortfolioContext && (!runUsesTopicInput || runUsesTargetAndTopic) && targetCount < minTargets) {
      setMessage(isEn ? `Select at least ${minTargets} target(s).` : `请至少选择 ${minTargets} 个标的。`);
      return;
    }
    if (!config.needsPortfolioContext && (!runUsesTopicInput || runUsesTargetAndTopic) && targetCount > maxTargets) {
      setMessage(isEn
        ? `${config.titles.en} supports at most ${maxTargets} target(s).`
        : `${config.titles.zh}最多支持 ${maxTargets} 个标的。请减少标的，或使用“快速检查/去劣筛选”。`);
      return;
    }
    if (runWorkflowId === "thesis_drift" && !resumeJob?.thesisDriftContext && (!driftOlderReport || !driftNewerReport)) {
      setMessage(isEn ? "Select two reports to compare." : "请选择两份报告进行对比。 ");
      return;
    }
    setMessage("");
    setStreamPreview("");
    for (const connection of requiredConnections) {
      let permission = false;
      try {
        permission = await ensureModelEndpointPermission(connection.profile.endpoint);
      } catch (error) {
        setMessage(error instanceof Error ? `${connection.role} · ${error.message}` : isEn ? `Invalid ${connection.role.toLowerCase()} endpoint.` : `${connection.role}模型 API 地址无效。`);
        return;
      }
      if (!permission) {
        setMessage(isEn ? `${connection.role} endpoint permission was denied.` : `未授予${connection.role}模型服务域名访问权限。`);
        return;
      }
    }
    if ((settings.webSearchMode === "auto" || settings.webSearchMode === "external") && searchSettings.endpoint && searchSettings.apiKey) {
      try {
        const searchPermission = await ensureModelEndpointPermission(searchSettings.endpoint);
        if (!searchPermission && settings.webSearchMode === "external") {
          setMessage(isEn ? "External search endpoint permission was denied." : "未授予外部搜索服务域名访问权限。 ");
          return;
        }
      } catch (error) {
        if (settings.webSearchMode === "external") {
          setMessage(error instanceof Error ? error.message : isEn ? "Invalid search endpoint." : "外部搜索 API 地址无效。 ");
          return;
        }
      }
    }
    const controller = new AbortController();
    setStoppingJobId(null);
    if (resumeJob) setWorkflowId(resumeJob.workflowId);
    const initialPortfolioContext = config.needsPortfolioContext ? buildPortfolioContext(holdings, stats) : undefined;
    const thesisDriftContext = runWorkflowId === "thesis_drift" && resumeJob?.thesisDriftContext
      ? resumeJob.thesisDriftContext
      : runWorkflowId === "thesis_drift" && driftOlderReport && driftNewerReport ? {
          olderReport: { id: driftOlderReport.id, createdAt: driftOlderReport.createdAt, markdown: driftOlderReport.markdown },
          newerReport: { id: driftNewerReport.id, createdAt: driftNewerReport.createdAt, markdown: driftNewerReport.markdown },
        }
      : undefined;
    let thesisTrackerPrior = undefined;
    if (runWorkflowId === "thesis_tracker" && !resumeJob) {
      const query = (targetToRun.name || targetToRun.symbol || "").toLowerCase();
      const prior = reports
        .filter((r) => r.workflowId === "thesis_tracker" && (r.target.name?.toLowerCase().includes(query) || r.target.symbol?.toLowerCase().includes(query)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (prior) {
        thesisTrackerPrior = {
          olderReport: { id: prior.id, createdAt: prior.createdAt, markdown: prior.markdown },
          newerReport: { id: prior.id, createdAt: prior.createdAt, markdown: prior.markdown },
        };
      }
    }
    const targetsForEnrichment = config.needsPortfolioContext
      ? holdings.map(researchTargetFromHolding)
      : targetsToRun?.length ? targetsToRun : [targetToRun];
    const preparationBaseJob = createResearchJob({
      workflowId: runWorkflowId,
      target: targetToRun,
      targets: targetsForEnrichment,
      publicContext: buildPublicResearchContext(targetToRun, { targets: targetsForEnrichment }),
      portfolioContext: initialPortfolioContext,
      thesisDriftContext: thesisDriftContext ?? thesisTrackerPrior,
      incomeInvestmentContext,
      topic: runUsesTopicInput ? runTopic : undefined,
      period: config.needsPeriodInput ? runPeriod : undefined,
      backtestContext: runWorkflowId === "backtest_interpretation" ? backtestContext ?? undefined : undefined,
      outputLanguage: language,
      providerRoute: providerRouteSnapshot,
    });
    const preparingJob: ResearchJob = {
      ...preparationBaseJob,
      ...(resumeJob ? { id: resumeJob.id, createdAt: resumeJob.createdAt } : {}),
      status: "preparing",
      completedSteps: [],
      pendingSteps: [...config.agentIds],
      agentResults: [],
      currentStep: undefined,
      startedAt: undefined,
      completedAt: undefined,
      reportId: undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    abortRef.current = controller;
    await saveResearchJob(preparingJob);
    setActiveJob(preparingJob);
    setJobs((current) => [preparingJob, ...current.filter((item) => item.id !== preparingJob.id)]);
    setMessage(resumeJob
      ? (isEn ? "Refreshing market data before restarting..." : "正在刷新行情后重新开始...")
      : (isEn ? `Fetching market data for ${targetsForEnrichment.length} target(s)...` : `正在获取 ${targetsForEnrichment.length} 个标的的行情数据...`));
    let targetContexts;
    try {
      targetContexts = await enrichResearchTargets(targetsForEnrichment, runWorkflowId, {
        signal: controller.signal,
        concurrency: Math.min(settings.maxConcurrency, 3),
        onTargetComplete: (context, completed, total) => {
          setMessage(isEn
            ? `Market data ${completed}/${total} · ${context.target.name || context.target.symbol}`
            : `行情数据 ${completed}/${total} · ${context.target.name || context.target.symbol}`);
        },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const errorText = cancelled
        ? (isEn ? "Market-data preparation was cancelled." : "行情数据准备已中断。")
        : error instanceof Error ? error.message : (isEn ? "Market-data preparation failed." : "行情数据准备失败。");
      const terminalJob: ResearchJob = {
        ...preparingJob,
        status: cancelled ? "cancelled" : "failed",
        updatedAt: new Date().toISOString(),
        error: {
          code: cancelled ? "cancelled" : "network",
          message: errorText,
          retryable: true,
        },
      };
      await saveResearchJob(terminalJob);
      setActiveJob(terminalJob);
      setJobs((current) => [terminalJob, ...current.filter((item) => item.id !== terminalJob.id)]);
      setMessage(errorText);
      if (abortRef.current === controller) abortRef.current = null;
      setStoppingJobId(null);
      return;
    }
    const enrichedTarget = config.needsPortfolioContext ? targetToRun : targetContexts[0]?.target ?? targetToRun;
    const enrichedTargets = targetContexts.map((context) => context.target);
    const refreshedHoldings = config.needsPortfolioContext
      ? holdings.map((holding) => {
          const context = targetContexts.find((item) => item.target.market === holding.market && item.target.symbol === holding.symbol);
          const currentPrice = context?.target.currentPrice;
          return currentPrice && currentPrice > 0
            ? { ...holding, currentPrice, marketValue: holding.quantity * currentPrice }
            : holding;
        })
      : holdings;
    const portfolioContext = config.needsPortfolioContext ? buildPortfolioContext(refreshedHoldings, stats) : undefined;
    const runHolding = selectedHolding ?? holdings.find((holding) =>
      holding.id === targetToRun.holdingId || (holding.market === targetToRun.market && holding.symbol === targetToRun.symbol));
    const includePrivateContext = Boolean(runHolding) && (sharePrivate || Boolean(resumeJob?.privateContext)) && enrichedTargets.length <= 1;
    const publicContext = buildPublicResearchContext(enrichedTarget, {
      targets: enrichedTargets,
      targetContexts,
    });
    const baseJob = createResearchJob({
      workflowId: runWorkflowId,
      target: enrichedTarget,
      targets: config.needsPortfolioContext ? undefined : enrichedTargets,
      publicContext,
      privateContext: includePrivateContext && runHolding
        ? buildPrivateHoldingContext(runHolding, stats, dcaPlans)
        : undefined,
      portfolioContext,
      thesisDriftContext: thesisDriftContext ?? thesisTrackerPrior,
      incomeInvestmentContext,
      topic: runUsesTopicInput ? runTopic : undefined,
      period: config.needsPeriodInput ? runPeriod : undefined,
      backtestContext: runWorkflowId === "backtest_interpretation" ? backtestContext ?? undefined : undefined,
      outputLanguage: language,
      providerRoute: providerRouteSnapshot,
    });
    const jobDefinition = {
      ...baseJob,
      id: preparingJob.id,
      createdAt: preparingJob.createdAt,
      completedSteps: [],
      pendingSteps: [...config.agentIds],
      agentResults: [],
      startedAt: undefined,
      completedAt: undefined,
      reportId: undefined,
    };
    const job: ResearchJob = {
      ...jobDefinition,
      status: "preparing",
      currentStep: resumeJob ? undefined : jobDefinition.currentStep,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    await saveResearchJob(job);
    setActiveJob(job);
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    try {
      const result = await runResearchJob(job, providerRouting, {
        signal: controller.signal,
        externalSearchSettings: searchSettings,
        onProgress: (event) => {
          if (controller.signal.aborted) return;
          setActiveJob(event.job);
          setJobs((current) => [event.job, ...current.filter((item) => item.id !== event.job.id)]);
          setMessage(event.message);
          if (event.delta) setStreamPreview((current) => `${current}${event.delta}`.slice(-6000));
        },
      });
      setActiveJob(result.job);
      setReports((current) => [result.report, ...current.filter((item) => item.id !== result.report.id)]);
      setSelectedReport(result.report);
      setStreamPreview("");
    } catch (error) {
      setMessage(controller.signal.aborted
        ? (isEn ? "Research stopped. You can restart it from the task card." : "研究已中断，可在任务卡片中点击重新开始。")
        : error instanceof Error ? error.message : isEn ? "Research failed" : "研究失败");
      await reload();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStoppingJobId(null);
    }
  };

  const cancel = async () => {
    const controller = abortRef.current;
    if (!controller || !activeJob || stoppingJobId === activeJob.id) return;
    setStoppingJobId(activeJob.id);
    setMessage(isEn ? "Stopping the current request…" : "正在中断当前请求…");
    controller.abort(new DOMException("Research cancelled by user", "AbortError"));
    const cancelled: ResearchJob = {
      ...activeJob,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      error: {
        code: "cancelled",
        message: isEn ? "Research stopped by user" : "研究任务已由用户中断",
        retryable: true,
        agentId: activeJob.currentStep,
      },
    };
    setActiveJob(cancelled);
    setJobs((current) => [cancelled, ...current.filter((item) => item.id !== cancelled.id)]);
    await saveResearchJob(cancelled);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "report") {
      await deleteResearchReport(pendingDelete.id);
      setReports((current) => current.filter((item) => item.id !== pendingDelete.id));
      setSelectedReport(null);
    } else {
      await deleteResearchJob(pendingDelete.id);
      setJobs((current) => current.filter((item) => item.id !== pendingDelete.id));
      if (activeJob?.id === pendingDelete.id) setActiveJob(null);
    }
    setPendingDelete(null);
  };

  const deleteConfirmation = pendingDelete && (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--scrim)] px-6" role="dialog" aria-modal="true" aria-label={isEn ? "Confirm deletion" : "确认删除"}>
      <div
        className="w-full max-w-sm rounded-2xl border border-app-border bg-app-overlay p-5 shadow-xl"
        onKeyDown={(event) => { if (event.key === "Escape") setPendingDelete(null); }}
      >
        <div className="flex items-center gap-2 text-[#F24E4E]"><AlertTriangle size={17} /><p className="text-[14px] font-bold">{isEn ? "Confirm deletion" : "确认删除"}</p></div>
        <p className="mt-3 text-[12px] leading-5 text-tm">{isEn ? `Delete "${pendingDelete.title}"? This cannot be undone.` : `确定删除"${pendingDelete.title}"吗？删除后无法恢复。`}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" autoFocus onClick={() => setPendingDelete(null)} className="h-10 rounded-xl bg-app-surface text-[12px] font-semibold text-ts">{isEn ? "Cancel" : "取消"}</button>
          <button type="button" onClick={() => void confirmDelete()} className="h-10 rounded-xl bg-[rgba(242,78,78,0.13)] text-[12px] font-semibold text-[#F24E4E]">{isEn ? "Delete" : "删除"}</button>
        </div>
      </div>
    </div>
  );

  if (selectedReport) {
    return <>
      <ResearchReportView
        report={selectedReport}
        language={language}
        onBack={() => setSelectedReport(null)}
        onDelete={() => setPendingDelete({ kind: "report", id: selectedReport.id, title: selectedReport.title })}
        onBacktest={onBacktest}
      />
      {deleteConfirmation}
    </>;
  }

  const running = activeJob && ["preparing", "running", "synthesizing", "auditing"].includes(activeJob.status);
  const stopping = Boolean(activeJob && stoppingJobId === activeJob.id);
  const busy = Boolean(running || stopping);
  const toggleCategory = (category: string) => {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const isDeepCompanySeries = workflowId === "deep_company_series";
  const showStandardTarget = !backtestContext && !workflowConfig.needsPortfolioContext && (!usesTopicInput || isDeepCompanySeries);
  const showTopicInput = !backtestContext && usesTopicInput;
  const hasMatchedTarget = allTargets.length > 0;
  const activeTargetConflict = showStandardTarget
    && allTargets.length > (workflowConfig.maxTargets ?? (workflowConfig.supportsMultipleTargets ? 5 : 1));
  const inputTitle = backtestContext
    ? (isEn ? "Backtest result" : "回测结果")
    : workflowConfig.needsPortfolioContext
      ? (isEn ? "Portfolio input" : "持仓组合")
      : showTopicInput && !isDeepCompanySeries
        ? workflowId === "dyp_ask"
          ? (isEn ? "Question" : "研究问题")
          : workflowId === "wechat_article"
            ? (isEn ? "Article topic" : "文章主题")
            : workflowId === "quality_screen"
              ? (isEn ? "Screening scope" : "筛选范围")
              : (isEn ? "Industry or topic" : "行业或研究主题")
        : workflowId === "quality_screen"
          ? (isEn ? "Screening targets" : "筛选标的")
          : (isEn ? "Research target" : "研究标的");
  const inputDescription = workflowConfig.needsPortfolioContext
    ? (isEn ? "Uses the portfolio stored on this device." : "读取本设备保存的全部持仓。")
    : showTopicInput && !isDeepCompanySeries
      ? workflowId === "quality_screen"
        ? (isEn ? "Enter an industry, index, market or investment theme." : "输入行业、指数、市场或投资主题。")
        : (isEn ? "The workflow will discover relevant companies from this scope." : "系统会根据这个范围自动发现相关公司。")
      : (isEn ? "Public market data is shared by default." : "默认只发送公开行情字段。");
  const marketScopeOptions = [
    { value: "", label: isEn ? "All markets" : "全部市场" },
    ...RESEARCH_MARKETS.filter((value) => value !== "FX" && value !== "COMMODITY").map((value) => ({ value, label: marketLabel(value, language) })),
  ];
  const targetMarketOptions = RESEARCH_MARKETS.map((value) => ({ value, label: marketLabel(value, language) }));
  const targetAssetTypeOptions = (value: string) => [
    ...(!RESEARCH_ASSET_TYPES.includes(value as typeof RESEARCH_ASSET_TYPES[number]) && value
      ? [{ value, label: assetTypeLabel(value, language) }]
      : []),
    ...RESEARCH_ASSET_TYPES.map((value) => ({ value, label: assetTypeLabel(value, language) })),
  ];
  const targetCurrencyOptions = (value: string) => [
    { value: "", label: isEn ? "Not specified" : "未指定" },
    ...(!RESEARCH_CURRENCIES.includes(value as typeof RESEARCH_CURRENCIES[number]) && value
      ? [{ value, label: value }]
      : []),
    ...RESEARCH_CURRENCIES.map((value) => ({ value, label: value })),
  ];
  const selectedProviderRoute = providerProfiles ? workflowProviderRoute(providerProfiles, workflowId) : {};
  const resolvedProviderSelection = providerProfiles?.profiles.length
    ? resolveResearchProviderRouting(providerProfiles, workflowId)
    : null;
  const executionProvider = resolvedProviderSelection?.routing.execution ?? providerSettings;
  const synthesisProvider = resolvedProviderSelection?.routing.synthesis;
  const auditProvider = resolvedProviderSelection?.routing.audit;
  const professionalDataProvider = resolvedProviderSelection?.routing.professionalData;
  const providerWebSearchCapability = executionProvider ? getResearchWebSearchCapability(executionProvider) : null;
  const activeProviderModelLabel = executionProvider
    ? resolvedProviderSelection?.routing.executionModel
      || (workflowConfig.useFullModel ? executionProvider.model : executionProvider.fastModel || executionProvider.model)
    : "";
  const providerSummary = executionProvider
    ? `${executionProvider.name} · ${isEn ? "Execution" : "执行"} ${activeProviderModelLabel || (isEn ? "No model" : "未选择模型")} · ${researchProtocolLabel(executionProvider.protocol)}`
    : (isEn ? "Model not configured" : "模型未配置");
  const executionProviderReady = isResearchProviderConfigured(executionProvider, activeProviderModelLabel);
  const webSearchSummary = !executionProvider
    ? ""
    : executionProvider.webSearchMode === "native"
      ? (providerWebSearchCapability?.supported ? (isEn ? "Native web search on" : "服务商原生联网开启") : (isEn ? "Native web search unsupported" : "当前模型不支持原生联网"))
      : executionProvider.webSearchMode === "external"
        ? (externalSearchSettings?.apiKey ? (isEn ? `External search: ${externalSearchSettings.name}` : `外部搜索：${externalSearchSettings.name}`) : (isEn ? "External search needs a key" : "外部搜索未配置 Key"))
        : executionProvider.webSearchMode === "auto"
          ? (isEn ? "Auto web evidence" : "自动联网证据")
          : (isEn ? "Web search off" : "联网关闭");
  const executionRole = selectedProviderRoute.executionModelRole ?? "auto";
  const executionFallsBack = Boolean(executionProvider)
    && !executionProvider?.fastModel
    && (executionRole === "fast" || (executionRole === "auto" && !workflowConfig.useFullModel));
  const synthesisModelLabel = synthesisProvider?.synthesisModel || synthesisProvider?.model || "";
  const auditModelLabel = auditProvider?.auditModel || auditProvider?.model || "";

  return (
    <div className="h-full space-y-3 overflow-y-auto px-3 pb-5 pt-3" style={{ scrollbarWidth: "none" }}>
      {backtestContext && (
        <section className="flex items-center justify-between gap-2 rounded-xl border border-app-accent/20 bg-[rgba(79,156,249,0.08)] px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-[12px] font-semibold text-app-accent">{isEn ? "Reviewing local backtest" : "正在解读本地回测"}</p>
            <p className="mt-0.5 truncate text-[11px] text-tmi">{backtestContext.name} · {backtestContext.startDate} – {backtestContext.endDate}</p>
          </div>
          {onClearBacktestContext && <button type="button" onClick={onClearBacktestContext} className="shrink-0 rounded-lg bg-app-card px-2 py-1.5 text-[11px] font-semibold text-ts">{isEn ? "Exit" : "退出"}</button>}
        </section>
      )}
      <section className="rounded-xl border border-app-border bg-app-card p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-tp">{inputTitle}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-tmi">{inputDescription}</p>
            {executionProvider && (
              <p className={`mt-0.5 truncate text-[12px] ${executionProvider.model ? "text-app-accent" : "text-[#F59E0B]"}`}>
                {executionProvider.model ? providerSummary : (isEn ? "Model not configured · choose or manage on the right" : "模型未配置 · 点击右侧选择或管理")}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={isEn ? "Configure model responsibilities" : "配置模型调用分工"}
            title={isEn ? "Configure model responsibilities" : "配置模型调用分工"}
            aria-expanded={showSettings}
            onClick={() => setShowSettings((value) => !value)}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-app-surface text-tm transition-colors hover:text-app-accent"
          >
            <Settings2 size={13} />
          </button>
        </div>

        {backtestContext && (
          <p className="mt-3 rounded-lg bg-app-surface px-2.5 py-2 text-[11px] text-ts">{backtestContext.name} · {backtestContext.startDate} – {backtestContext.endDate}</p>
        )}

        {workflowConfig.needsPortfolioContext && (
          <div className="mt-3 rounded-lg bg-app-surface px-2.5 py-2 text-[11px] leading-4 text-ts">
            <strong>{isEn ? "Portfolio review" : "组合管理"}</strong> · {holdings.length} {isEn ? "holdings" : "个持仓"} · {stats.totalAsset.toFixed(0)} {holdings[0]?.currency ?? ""}
            <p className="mt-1 text-[11px] leading-4 text-tmi">{isEn ? "All positions will be analyzed together." : "将分析全部持仓的集中度、相关性和压力测试。"}</p>
          </div>
        )}

        {workflowConfig.supportsTopicAlternative && !backtestContext && (
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-app-border bg-app-surface p-1">
            <button
              type="button"
              aria-pressed={qualityScreenInputMode === "targets"}
              onClick={() => { setQualityScreenInputMode("targets"); setMessage(""); }}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${qualityScreenInputMode === "targets" ? "bg-app-card text-app-accent shadow-sm" : "text-tm"}`}
            >
              {isEn ? "Selected targets" : "选择标的"}
            </button>
            <button
              type="button"
              aria-pressed={qualityScreenInputMode === "scope"}
              onClick={() => { setQualityScreenInputMode("scope"); setMessage(""); }}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${qualityScreenInputMode === "scope" ? "bg-app-card text-app-accent shadow-sm" : "text-tm"}`}
            >
              {isEn ? "Screening scope" : "筛选范围"}
            </button>
          </div>
        )}

        {showTopicInput && (
          <>
            {isDeepCompanySeries && <div className="mt-3"><FieldLabel>{isEn ? "Series count and narrative" : "系列篇数与叙事主线"}</FieldLabel></div>}
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder={workflowId === "deep_company_series"
                ? (isEn ? "e.g. 5 articles, from business model and moat to valuation and risks…" : "例如：5 篇，从商业模式、护城河写到财务、估值与风险…")
                : workflowId === "quality_screen"
                ? (isEn ? "e.g. Hang Seng Index, global cloud computing, China high dividend…" : "例如：恒生指数、全球云计算、中国高股息主题…")
                : (isEn ? "Enter a topic, question, or industry name…" : "输入主题、问题或行业方向…")}
              rows={3}
              className={`${isDeepCompanySeries ? "mt-1" : "mt-3"} w-full resize-none rounded-lg border border-app-border bg-app-surface px-2.5 py-2.5 text-[12px] leading-5 text-tp outline-none focus:border-app-accent`}
            />
            {allTargets.length > 0 && !isDeepCompanySeries && (
              <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-[rgba(79,156,249,0.07)] px-2.5 py-2 text-[11px] leading-4 text-tmi">
                <Check size={10} className="shrink-0 text-app-accent" />
                <span>{workflowId === "quality_screen"
                  ? (isEn ? `${allTargets.length} selected target(s) are saved. Switch back to Selected targets to use them.` : `已保留 ${allTargets.length} 个标的；切回“选择标的”即可继续使用。`)
                  : (isEn ? `${allTargets.length} selected target(s) are retained but not used by this topic workflow.` : `已保留 ${allTargets.length} 个标的，当前主题模式不会使用。`)}</span>
              </p>
            )}
          </>
        )}

        {showStandardTarget && (
          <>
            <div className="mt-3 flex items-end gap-2">
              <div className="w-24 shrink-0">
                <FieldLabel>{isEn ? "Market scope" : "市场范围"}</FieldLabel>
                <SelectControl
                  ariaLabel={isEn ? "Market scope" : "市场范围"}
                  value={marketScope}
                  onChange={(value) => handleMarketScopeChange(value as Market | "")}
                  options={marketScopeOptions}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-tm">{isEn ? "Add target" : "添加标的"}</span>
                  <span className="text-[11px] text-tmi">{allTargets.length}/5</span>
                </div>
                <SecuritySearchInput
                  value={securityQuery}
                  onChange={handleSecurityQueryChange}
                  onSelect={handleSecuritySelect}
                  placeholder={isEn ? "Holdings, name or symbol" : "持仓、名称或代码"}
                  marketFilter={marketScope || undefined}
                  suggestions={holdingSearchSuggestions}
                  suggestionsLabel={isEn ? "My holdings" : "我的持仓"}
                  onSuggestionSelect={handleHoldingSuggestionSelect}
                />
              </div>
            </div>

            <div className="mt-2.5 space-y-2">
              {!hasMatchedTarget && (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface px-2.5 py-2.5 text-[11px] leading-4 text-tmi">
                  {isEn ? "Choose from your holdings or market results. Market, type and currency will be filled automatically." : "可直接选择我的持仓或市场搜索结果；市场、类型和币种会自动匹配。"}
                </div>
              )}
              {allTargets.map((target) => {
                const key = researchTargetKey(target);
                const editing = editingTargetKey === key;
                return (
                  <div key={key} className="rounded-xl border border-app-border bg-app-surface px-2.5 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 text-[11px] font-semibold text-[#31A777]">
                          <Check size={11} />
                          <span>{target.holdingId ? (isEn ? "Added from holdings" : "已从持仓添加") : (isEn ? "Matched automatically" : "已自动匹配")}</span>
                        </div>
                        <p className="mt-1 truncate text-[12px] font-semibold text-tp">{target.name || target.symbol} · {target.symbol}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-expanded={editing}
                          onClick={() => setEditingTargetKey(editing ? null : key)}
                          className="rounded-lg px-2 py-1 text-[11px] font-semibold text-ts hover:bg-app-card"
                        >
                          {editing ? (isEn ? "Done" : "完成") : (isEn ? "Correct" : "修正")}
                        </button>
                        <button
                          type="button"
                          aria-label={isEn ? `Remove ${target.name}` : `移除${target.name}`}
                          onClick={() => removeResearchTarget(key)}
                          className="flex h-6 w-6 items-center justify-center rounded-lg text-tmi hover:bg-app-card hover:text-[#F24E4E]"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>

                    <p className="mt-1.5 truncate whitespace-nowrap text-[11px] leading-4 text-tmi">
                      <span>{isEn ? "Market" : "市场"}</span> <strong className="font-semibold text-ts">{marketLabel(target.market, language)}</strong>
                      <span className="mx-1.5">·</span>
                      <span>{isEn ? "Type" : "类型"}</span> <strong className="font-semibold text-ts">{assetTypeLabel(target.assetType, language)}</strong>
                      <span className="mx-1.5">·</span>
                      <span>{isEn ? "Currency" : "币种"}</span> <strong className="font-semibold text-ts">{target.currency || (isEn ? "Unknown" : "未识别")}</strong>
                    </p>

                    {editing && (
                      <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-app-border-sub pt-2.5">
                        <div className="min-w-0">
                          <FieldLabel>{isEn ? "Market" : "市场"}</FieldLabel>
                          <SelectControl ariaLabel={isEn ? `Market for ${target.name}` : `${target.name}的市场`} value={target.market} onChange={(value) => updateResearchTarget(key, { market: value })} options={targetMarketOptions} />
                        </div>
                        <div className="min-w-0">
                          <FieldLabel>{isEn ? "Type" : "类型"}</FieldLabel>
                          <SelectControl ariaLabel={isEn ? `Type for ${target.name}` : `${target.name}的类型`} value={target.assetType} onChange={(value) => updateResearchTarget(key, { assetType: value })} options={targetAssetTypeOptions(target.assetType)} />
                        </div>
                        <div className="min-w-0">
                          <FieldLabel>{isEn ? "Currency" : "币种"}</FieldLabel>
                          <SelectControl ariaLabel={isEn ? `Currency for ${target.name}` : `${target.name}的币种`} value={target.currency} onChange={(value) => updateResearchTarget(key, { currency: value })} options={targetCurrencyOptions(target.currency)} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {allTargets.length > 1 && workflowConfig.supportsMultipleTargets && (
              <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-[rgba(79,156,249,0.08)] px-2.5 py-2 text-[11px] leading-4 text-app-accent">
                <Check size={11} className="shrink-0" />
                <span>{workflowId === "quality_screen"
                  ? (isEn ? `Quality Screen will apply the same seven hard filters to all ${allTargets.length} targets.` : `去劣筛选将对 ${allTargets.length} 个标的逐一应用同一套 7 项硬指标。`)
                  : (isEn ? `Quick Check will run the same six-gate checklist for all ${allTargets.length} targets and append one overview table.` : `快速检查将对 ${allTargets.length} 个标的逐一执行同一套六关 Checklist，并在最后生成总览对比表。`)}</span>
              </p>
            )}

            {allTargets.length > 1 && !workflowConfig.supportsMultipleTargets && (
              <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-[rgba(255,159,67,0.1)] px-2.5 py-2 text-[11px] leading-4 text-[#E58A2B]">
                <AlertTriangle size={11} className="shrink-0" />
                <span>{isEn
                  ? `${workflowConfig.titles.en} is a single-target workflow. Keep one target or switch to Quick Check.`
                  : `${workflowConfig.titles.zh}是单标的模式；请保留一个标的，或切换到支持多标的的“快速检查”。`}</span>
              </p>
            )}

            {selectedHolding && allTargets.length === 1 && (
              <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg bg-app-surface px-2.5 py-2 text-[11px] leading-4 text-ts">
                <input type="checkbox" checked={sharePrivate} onChange={(event) => setSharePrivate(event.target.checked)} className="mt-0.5" />
                <span><strong>{isEn ? "Include my position" : "结合我的持仓分析"}</strong><br /><span className="text-tmi">{isEn ? "Shares quantity, cost, market value and portfolio weight will be sent." : "将发送数量、成本、市值和组合占比；默认关闭。"}</span></span>
              </label>
            )}
          </>
        )}

        {workflowConfig.needsPeriodInput && showStandardTarget && (
          <input value={period} onChange={(event) => setPeriod(event.target.value)} placeholder={isEn ? "Earnings period (e.g. 2025Q4)" : "财报期数（如 2025Q4）"} className="mt-2 w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-2 text-[12px] text-tp outline-none" />
        )}

        {workflowConfig.needsIncomeInputs && showStandardTarget && (
          <div className="mt-3 rounded-xl border border-app-border bg-app-surface p-2.5">
            <div className="mb-2">
              <p className="text-[12px] font-semibold text-tp">{isEn ? "Income objectives" : "收益目标"}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-tmi">
                {isEn ? "Used to assess portfolio fit and after-tax income. Blank fields will not be guessed." : "用于判断组合角色与税后收益；未填写的信息不会由模型猜测。"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
                <FieldLabel>{isEn ? "Decision" : "决策场景"}</FieldLabel>
                <SelectControl
                  ariaLabel={isEn ? "Income decision" : "收益型投资决策场景"}
                  value={incomeMode}
                  onChange={(value) => setIncomeMode(value as IncomeInvestmentContext["mode"])}
                  options={[
                    { value: "new", label: isEn ? "New position" : "新建仓位" },
                    { value: "existing", label: isEn ? "Existing position" : "已有持仓" },
                  ]}
                />
              </div>
              <div className="min-w-0">
                <FieldLabel>{isEn ? "Portfolio role" : "组合角色"}</FieldLabel>
                <SelectControl
                  ariaLabel={isEn ? "Portfolio role" : "收益型投资组合角色"}
                  value={incomeRole}
                  onChange={(value) => setIncomeRole(value as IncomeInvestmentContext["role"])}
                  options={[
                    { value: "unspecified", label: isEn ? "Not specified" : "未指定" },
                    { value: "core-income", label: isEn ? "Core income" : "核心收益仓" },
                    { value: "opportunistic-income", label: isEn ? "Opportunistic" : "机会型收益仓" },
                  ]}
                />
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div className="min-w-0">
                <FieldLabel>{isEn ? "Target yield" : "目标收益率"}</FieldLabel>
                <input value={incomeTargetYield} onChange={(event) => setIncomeTargetYield(event.target.value)} placeholder="4%" className="h-[40px] w-full rounded-[10px] border border-app-border bg-app-card px-3 text-[12px] text-tp outline-none focus:border-app-accent" />
              </div>
              <div className="min-w-0">
                <FieldLabel>{isEn ? "Tax residence" : "税务居民地"}</FieldLabel>
                <input value={incomeTaxResidence} onChange={(event) => setIncomeTaxResidence(event.target.value)} placeholder={isEn ? "Optional" : "选填"} className="h-[40px] w-full rounded-[10px] border border-app-border bg-app-card px-3 text-[12px] text-tp outline-none focus:border-app-accent" />
              </div>
              <div className="min-w-0">
                <FieldLabel>{isEn ? "Horizon" : "持有期限"}</FieldLabel>
                <input value={incomeHorizon} onChange={(event) => setIncomeHorizon(event.target.value)} placeholder={isEn ? "5 years" : "如 5 年"} className="h-[40px] w-full rounded-[10px] border border-app-border bg-app-card px-3 text-[12px] text-tp outline-none focus:border-app-accent" />
              </div>
            </div>
          </div>
        )}

        {workflowId === "thesis_tracker" && showStandardTarget && (currentTarget.name || currentTarget.symbol) && (
          <p className="mt-2 text-[11px] leading-4 text-tmi">
            {reports.some((r) => r.workflowId === "thesis_tracker" && (r.target.name?.toLowerCase().includes((currentTarget.name || currentTarget.symbol).toLowerCase()) || r.target.symbol?.toLowerCase().includes((currentTarget.name || currentTarget.symbol).toLowerCase())))
              ? (isEn ? "Prior thesis found — will run in check mode." : "已找到历史论文 — 将进入复检模式。")
              : (isEn ? "No prior thesis — will establish a new thesis." : "未找到历史论文 — 将建立新论文。")}
          </p>
        )}

        {workflowId === "thesis_drift" && showStandardTarget && (
          <div className="mt-2 space-y-2">
            <select value={driftOlderId} onChange={(event) => setDriftOlderId(event.target.value)} className="w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-2 text-[12px] text-ts outline-none">
              <option value="">{isEn ? "Older report" : "较早报告"}</option>
              {companyReports.filter((r) => r.id !== driftNewerId).map((r) => <option key={r.id} value={r.id}>{r.createdAt.slice(0, 10)} · {r.title}</option>)}
            </select>
            <select value={driftNewerId} onChange={(event) => setDriftNewerId(event.target.value)} className="w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-2 text-[12px] text-ts outline-none">
              <option value="">{isEn ? "Newer report" : "较新报告"}</option>
              {companyReports.filter((r) => r.id !== driftOlderId).map((r) => <option key={r.id} value={r.id}>{r.createdAt.slice(0, 10)} · {r.title}</option>)}
            </select>
            {companyReports.length === 0 && (currentTarget.name || currentTarget.symbol) && (
              <p className="text-[11px] text-tmi">{isEn ? "No matching reports found." : "未找到匹配的报告。"}</p>
            )}
          </div>
        )}
      </section>

      {showSettings && (
        <section className="overflow-hidden rounded-xl border border-app-accent/25 bg-app-card">
          <div className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(79,156,249,0.12)] text-app-accent">
                <Route size={16} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-[14px] font-semibold text-tp">{isEn ? "Model plan" : "本次模型方案"}</p>
                  <span className="rounded-md bg-[rgba(79,156,249,0.1)] px-1.5 py-0.5 text-[10px] font-semibold text-app-accent">
                    {researchWorkflowTitle(workflowId, language)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-4 text-tmi">{isEn ? "See what runs first; change only the parts that need a different API." : "先确认实际调用链路，需要时再为某个环节切换 API。"}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={openAISettings}
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2.5 text-[11px] font-semibold text-ts transition-colors hover:border-app-accent/40 hover:text-app-accent"
            >
              <Settings2 size={12} />
              {isEn ? "API settings" : "API 管理"}
            </button>
          </div>

          <div className={`mt-3 grid gap-2 ${workflowConfig.needsSynthesis ? "grid-cols-3" : "grid-cols-2"}`}>
            <div className="min-w-0 rounded-[10px] border border-[rgba(79,156,249,0.22)] bg-[rgba(79,156,249,0.06)] px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-app-accent">
                <Bot size={12} />
                <span className="text-[10px] font-semibold">{isEn ? "EXECUTE" : "执行"}</span>
                <span className="ml-auto rounded-full bg-app-card px-1.5 py-0.5 text-[9px] font-semibold">{isEn ? "First" : "第 1 步"}</span>
              </div>
              <p className="mt-1 truncate text-[12px] font-semibold text-tp">{executionProvider?.name || (isEn ? "Not configured" : "未配置连接")}</p>
              <p className="mt-0.5 truncate text-[11px] text-tm">{activeProviderModelLabel || (isEn ? "No model" : "未选择模型")}</p>
            </div>
            {workflowConfig.needsSynthesis && (
              <div className="min-w-0 rounded-[10px] border border-[rgba(139,92,246,0.2)] bg-[rgba(139,92,246,0.055)] px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[#8B5CF6]">
                  <FileCheck2 size={12} />
                  <span className="text-[10px] font-semibold">{isEn ? "SYNTHESIZE" : "综合"}</span>
                  <span className="ml-auto rounded-full bg-app-card px-1.5 py-0.5 text-[9px] font-semibold">{isEn ? "Then" : "第 2 步"}</span>
                </div>
                <p className="mt-1 truncate text-[12px] font-semibold text-tp">{synthesisProvider?.name || executionProvider?.name || (isEn ? "Follow execution" : "跟随执行")}</p>
                <p className="mt-0.5 truncate text-[11px] text-tm">{synthesisModelLabel || activeProviderModelLabel || (isEn ? "No model" : "未选择模型")}</p>
              </div>
            )}
            <div className="min-w-0 rounded-[10px] border border-[rgba(16,185,129,0.2)] bg-[rgba(16,185,129,0.055)] px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[#10B981]">
                <Shield size={12} />
                <span className="text-[10px] font-semibold">{isEn ? "AUDIT" : "审计"}</span>
                <span className="ml-auto rounded-full bg-app-card px-1.5 py-0.5 text-[9px] font-semibold">{isEn ? "Last" : `第 ${workflowConfig.needsSynthesis ? "3" : "2"} 步`}</span>
              </div>
              <p className="mt-1 truncate text-[12px] font-semibold text-tp">{auditProvider?.name || (isEn ? "Local checks" : "本地规则检查")}</p>
              <p className="mt-0.5 truncate text-[11px] text-tm">{auditModelLabel || (isEn ? "No model call" : "不调用模型")}</p>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <div className="rounded-xl border border-app-border bg-app-surface p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[rgba(79,156,249,0.12)] text-app-accent"><Bot size={13} /></span>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-tp">{isEn ? "Research execution" : "研究执行"}</p>
                    <p className="truncate text-[10px] text-tmi">{isEn ? "Deep → main model · Lightweight → fast model" : "深度任务用主模型 · 轻量任务优先快速模型"}</p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-[rgba(79,156,249,0.1)] px-1.5 py-0.5 text-[9px] font-semibold text-app-accent">{isEn ? "WRITES REPORT" : "生成正文"}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <FieldLabel>{isEn ? "API" : "使用连接"}</FieldLabel>
                  <SelectControl
                    ariaLabel={isEn ? "Execution API" : "执行 API"}
                    value={selectedProviderRoute.executionProfileId ?? ""}
                    onChange={(value) => void setWorkflowProvider("execution", value)}
                    options={[
                      { value: "", label: `${isEn ? "Follow default" : "跟随默认"} · ${providerProfiles?.profiles.find((profile) => profile.id === providerProfiles.activeProfileId)?.name ?? "-"}` },
                      ...(providerProfiles?.profiles ?? []).map((profile) => ({ value: profile.id, label: profile.name })),
                    ]}
                  />
                </div>
                <div>
                  <FieldLabel>{isEn ? "Model" : "使用模型"}</FieldLabel>
                  <SelectControl
                    ariaLabel={isEn ? "Execution model strategy" : "执行模型策略"}
                    value={selectedProviderRoute.executionModelRole ?? "auto"}
                    onChange={(value) => void setWorkflowExecutionModelRole(value)}
                    options={[
                      { value: "auto", label: `${isEn ? "Auto" : "自动（推荐）"} · ${workflowConfig.useFullModel ? (isEn ? "main" : "主模型") : (isEn ? "fast" : "快速模型")}` },
                      { value: "main", label: `${isEn ? "Main model" : "主模型"} · ${executionProvider?.model || (isEn ? "not set" : "未配置")}` },
                      { value: "fast", label: `${isEn ? "Fast model" : "快速模型"} · ${executionProvider?.fastModel || (isEn ? "falls back to main" : "未配置，回退主模型")}` },
                    ]}
                  />
                </div>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg bg-[rgba(79,156,249,0.08)] px-2 py-1.5 text-[11px]">
                <Check size={12} className="shrink-0 text-app-accent" />
                <span className="shrink-0 font-medium text-tm">{isEn ? "Active" : "实际调用"}</span>
                <span className="truncate font-semibold text-tp">{executionProvider?.name || "-"} · {activeProviderModelLabel || (isEn ? "Not configured" : "未配置")}</span>
                {executionFallsBack && <span className="ml-auto shrink-0 rounded bg-[rgba(245,158,11,0.12)] px-1.5 py-0.5 text-[9px] font-semibold text-[#D97706]">{isEn ? "MAIN FALLBACK" : "已回退主模型"}</span>}
              </div>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[rgba(124,58,237,0.1)] text-[#7C3AED]"><Database size={13} /></span>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-tp">{isEn ? "Professional evidence" : "专业数据证据"}</p>
                    <p className="truncate text-[10px] text-tmi">{isEn ? "Reuses an Agent Plan key; does not write the report" : "复用 Agent Plan Key，只提供结构化证据"}</p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-[rgba(124,58,237,0.09)] px-1.5 py-0.5 text-[9px] font-semibold text-[#7C3AED]">DATAPRO MCP</span>
              </div>
              <div className="mt-2">
                <FieldLabel>{isEn ? "Agent Plan connection" : "使用 Agent Plan 连接"}</FieldLabel>
                <SelectControl
                  ariaLabel={isEn ? "Professional data Agent Plan connection" : "专业数据 Agent Plan 连接"}
                  value={selectedProviderRoute.professionalDataProfileId ?? ""}
                  onChange={(value) => void setWorkflowProvider("professionalData", value)}
                  options={[
                    { value: "", label: isEn ? "Automatic · prefer execution or default Plan" : "自动（推荐）· 优先执行或默认 Plan" },
                    ...(providerProfiles?.profiles ?? [])
                      .filter((profile) => profile.preset === "volcengine_agent_plan")
                      .map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.apiKey ? (isEn ? "Key ready" : "Key 已就绪") : (isEn ? "No key" : "未配置 Key")}` })),
                  ]}
                />
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg bg-[rgba(124,58,237,0.07)] px-2 py-1.5 text-[11px]">
                <Check size={12} className="shrink-0 text-[#7C3AED]" />
                <span className="shrink-0 font-medium text-tm">{isEn ? "Active" : "实际调用"}</span>
                <span className="truncate font-semibold text-tp">{professionalDataProvider?.apiKey ? `${professionalDataProvider.name} · DataPro MCP` : (isEn ? "Unavailable · research will fall back" : "不可用 · 研究将自动降级")}</span>
              </div>
            </div>

            {workflowConfig.needsSynthesis && (
              <div className="rounded-xl border border-app-border bg-app-surface p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[rgba(139,92,246,0.1)] text-[#8B5CF6]"><FileCheck2 size={13} /></span>
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-tp">{isEn ? "Final synthesis" : "终稿综合"}</p>
                      <p className="truncate text-[10px] text-tmi">{isEn ? "Combines agent outputs into the final report" : "汇总多个研究 Agent，生成最终报告"}</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-md bg-[rgba(139,92,246,0.09)] px-1.5 py-0.5 text-[9px] font-semibold text-[#8B5CF6]">{isEn ? "MERGES" : "汇总终稿"}</span>
                </div>
                <div className="mt-2">
                  <FieldLabel>{isEn ? "Synthesis API" : "使用连接与综合模型"}</FieldLabel>
                  <SelectControl
                    ariaLabel={isEn ? "Synthesis API" : "综合 API"}
                    value={selectedProviderRoute.synthesisProfileId ?? ""}
                    onChange={(value) => void setWorkflowProvider("synthesis", value)}
                    options={[
                      { value: "", label: `${isEn ? "Follow execution" : "跟随执行"} · ${executionProvider?.name ?? "-"}` },
                      ...(providerProfiles?.profiles ?? []).map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.synthesisModel || profile.model || (isEn ? "No model" : "未选模型")}` })),
                    ]}
                  />
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg bg-[rgba(139,92,246,0.07)] px-2 py-1.5 text-[11px]">
                  <Check size={12} className="shrink-0 text-[#8B5CF6]" />
                  <span className="shrink-0 font-medium text-tm">{isEn ? "Active" : "实际调用"}</span>
                  <span className="truncate font-semibold text-tp">{synthesisProvider?.name || executionProvider?.name || "-"} · {synthesisModelLabel || activeProviderModelLabel || (isEn ? "Not configured" : "未配置")}</span>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-app-border bg-app-surface p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[rgba(16,185,129,0.1)] text-[#10B981]"><Shield size={13} /></span>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-tp">{isEn ? "Independent audit" : "独立审计"}</p>
                    <p className="truncate text-[10px] text-tmi">{isEn ? "Checks citations, calculations and consistency" : "复核引用、计算与一致性，不参与正文撰写"}</p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-[rgba(16,185,129,0.09)] px-1.5 py-0.5 text-[9px] font-semibold text-[#059669]">{isEn ? "CHECKS ONLY" : "只做复核"}</span>
              </div>
              <div className="mt-2">
                <FieldLabel>{isEn ? "Audit API" : "审计方式"}</FieldLabel>
                <SelectControl
                  ariaLabel={isEn ? "Audit API" : "审计 API"}
                  value={selectedProviderRoute.auditDisabled ? "__off__" : selectedProviderRoute.auditProfileId ?? ""}
                  onChange={(value) => void setWorkflowProvider("audit", value)}
                  options={[
                    { value: "", label: `${isEn ? "Follow execution" : "跟随执行"} · ${executionProvider?.auditModel ? `${executionProvider.name} · ${executionProvider.auditModel}` : (isEn ? "local checks only" : "仅本地检查")}` },
                    { value: "__off__", label: isEn ? "Local checks only (no model call)" : "仅本地规则检查（不调用模型）" },
                    ...(providerProfiles?.profiles ?? []).map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.auditModel || profile.model || (isEn ? "No model" : "未选模型")}` })),
                  ]}
                />
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg bg-[rgba(16,185,129,0.07)] px-2 py-1.5 text-[11px]">
                <Check size={12} className="shrink-0 text-[#10B981]" />
                <span className="shrink-0 font-medium text-tm">{isEn ? "Active" : "实际方式"}</span>
                <span className="truncate font-semibold text-tp">{auditProvider ? `${auditProvider.name} · ${auditModelLabel}` : (isEn ? "Local rule checks · no model call" : "本地规则检查 · 不调用模型")}</span>
              </div>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-app-border/70 pt-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-1 text-[10px] font-medium text-ts"><Globe2 size={11} className="text-app-accent" />{webSearchSummary || (isEn ? "Search unavailable" : "联网状态未知")}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-1 text-[10px] font-medium text-ts"><Database size={11} className={professionalDataProvider?.apiKey ? "text-[#7C3AED]" : "text-tmi"} />{professionalDataProvider?.apiKey ? (isEn ? `DataPro · ${professionalDataProvider.name}` : `专业数据 · ${professionalDataProvider.name}`) : (isEn ? "DataPro unavailable" : "专业数据未接入")}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-1 text-[10px] font-medium text-ts"><Shield size={11} className="text-[#10B981]" />{auditProvider ? (isEn ? "Model audit" : "模型审计") : (isEn ? "Local audit" : "本地审计")}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-1 text-[10px] font-medium text-ts"><RefreshCw size={11} className="text-tm" />{isEn ? "Resume with original setup" : "中断后沿用原配置"}</span>
          </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-app-border bg-app-card p-3">
        <p className="text-[13px] font-semibold text-tp">{isEn ? "Research mode" : "研究模式"}</p>
        {!backtestContext && <p className="mt-1 text-[11px] leading-4 text-tmi">{isEn ? "AI Berkshire workflows, adapted to local holdings, quotes and report storage. AssetMate-only enhancements are labeled." : "研究框架与 AI Berkshire 对齐，并接入本地持仓、行情和报告库；插件独有增强会单独标注。"}</p>}
        {backtestContext ? (
          <div className="mt-2 grid grid-cols-1 gap-2">
            <button type="button" onClick={() => setWorkflowId("backtest_interpretation")} className="rounded-xl border px-2 py-2.5 text-left" style={{ borderColor: workflowId === "backtest_interpretation" ? "rgba(79,156,249,0.5)" : "var(--border)", background: workflowId === "backtest_interpretation" ? "rgba(79,156,249,0.1)" : "var(--bg-surface)" }}>
              <div className="flex items-center justify-between"><span className="text-[12px] font-semibold" style={{ color: workflowId === "backtest_interpretation" ? "#4F9CF9" : "var(--text-primary)" }}>{isEn ? "Backtest Review" : "回测解读"}</span><span className="text-[12px] text-tmi">1×</span></div>
              <p className="mt-1 text-[11px] leading-4 text-tmi">{isEn ? "Review robustness and limitations" : "结合策略结果分析稳健性"}</p>
            </button>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {WORKFLOW_CATEGORY_ORDER.map((category) => {
              const workflows = Object.values(WORKFLOW_REGISTRY).filter((w) => {
                if (w.category !== category || w.id === "backtest_interpretation") return false;
                return true;
              });
              if (workflows.length === 0) return null;
              const collapsed = collapsedCategories.has(category);
              return (
                <div key={category}>
                  <button type="button" onClick={() => toggleCategory(category)} className="flex w-full items-center gap-1.5 py-1 text-left">
                    {collapsed ? <ChevronRight size={11} className="text-tmi" /> : <ChevronDown size={11} className="text-tmi" />}
                    <span className="text-[12px] font-semibold text-ts">{isEn ? WORKFLOW_CATEGORY_LABELS[category].en : WORKFLOW_CATEGORY_LABELS[category].zh}</span>
                    <span className="text-[12px] text-tmi">{workflows.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      {workflows.map((workflow) => {
                        const active = workflowId === workflow.id;
                        const usesSelectedTargets = !workflow.needsPortfolioContext && (!workflow.needsTopicInput || workflow.id === "deep_company_series");
                        const maxTargets = workflow.maxTargets ?? (workflow.supportsMultipleTargets ? 5 : 1);
                        const incompatible = usesSelectedTargets && allTargets.length > maxTargets;
                        return (
                          <button key={workflow.id} type="button" disabled={incompatible} onClick={() => setWorkflowId(workflow.id)} className="rounded-xl border px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45" title={incompatible ? (isEn ? "This workflow supports one target." : "此模式仅支持单标的") : undefined} style={{ borderColor: active ? "rgba(79,156,249,0.5)" : "var(--border)", background: active ? "rgba(79,156,249,0.1)" : "var(--bg-surface)" }}>
                            <div className="flex items-center justify-between gap-1"><span className="min-w-0 truncate text-[12px] font-semibold" style={{ color: active ? "#4F9CF9" : "var(--text-primary)" }}>{isEn ? workflow.titles.en : workflow.titles.zh}</span><span className="flex shrink-0 items-center gap-1"><span className="rounded bg-[rgba(79,156,249,0.08)] px-1 py-0.5 text-[11px] text-app-accent">{workflow.origin === "assetmate" ? "AssetMate" : "Berkshire"}</span><span className="text-[12px] text-tmi">{workflow.calls}×</span></span></div>
                            <p className="mt-1 text-[11px] leading-4 text-tmi">{isEn ? workflow.descriptions.en : workflow.descriptions.zh}</p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button type="button" onClick={() => void run()} disabled={busy || activeTargetConflict} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-app-accent py-2.5 text-[12px] font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {stopping ? (isEn ? "Stopping" : "正在中断") : running ? (isEn ? "Researching" : "研究中") : (isEn ? "Start research" : "开始研究")}
        </button>
        <div className={`mt-2 flex items-start gap-1.5 text-[11px] leading-4 ${!executionProviderReady || (executionProvider?.webSearchMode !== "off" && !providerWebSearchCapability?.supported && !externalSearchSettings?.apiKey) ? "text-[#F59E0B]" : "text-tmi"}`}>
          <Shield size={11} className="mt-0.5 shrink-0" />
          <span>
            {!executionProviderReady
              ? (isEn ? "Configure the execution model, endpoint and API key before starting. Web access will be resolved after the model is ready." : "请先配置执行模型、API 地址与 Key；模型可用后才会判断并启用对应联网方式。")
              : executionProvider?.webSearchMode === "auto"
              ? (providerWebSearchCapability?.supported
                ? (externalSearchSettings?.apiKey
                  ? (isEn ? "Web access is automatic: native browsing plus external-search evidence." : "联网已自动启用：模型原生搜索 + 外部搜索证据增强。")
                  : (isEn ? "Web access is automatic: this model will use provider-native browsing." : "联网已自动启用：研究时将调用模型原生搜索。"))
                : externalSearchSettings?.apiKey
                  ? (isEn ? "Native browsing is unavailable; external search will be used automatically." : "当前模型无可验证的原生联网，将自动使用外部搜索。")
                  : (isEn ? "Native browsing is unavailable. Research will continue with prefetched market data." : "当前模型无可验证的原生联网；研究仍会使用插件预取行情，不会中断。"))
              : executionProvider?.webSearchMode === "external"
                ? (externalSearchSettings?.apiKey
                  ? (isEn ? "Research will use the configured external search service." : "研究将使用已配置的外部联网搜索服务。")
                  : (isEn ? "External search is selected but not configured." : "已选择外部搜索，但尚未配置搜索 API Key。"))
                : executionProvider?.webSearchMode === "native" && providerWebSearchCapability?.supported
                  ? (isEn ? "Native web search is configured. Every run verifies provider citations." : "已配置原生联网；每次研究都会核验实际搜索事件和服务商引用。")
                  : executionProvider?.webSearchMode === "native"
                    ? (isEn ? providerWebSearchCapability?.reasonEn : providerWebSearchCapability?.reasonZh)
                    : (isEn ? "Web search is off. The report must disclose this limitation." : "未启用联网搜索，报告会强制披露该限制。")}
          </span>
        </div>
        {professionalDataProvider?.apiKey && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-[#7C3AED]">
            <Database size={11} className="mt-0.5 shrink-0" />
            <span>{isEn ? `Professional datasets are automatic and reuse the Agent Plan key from “${professionalDataProvider.name}”. Failures fall back without stopping research.` : `专业数据集已自动接入，复用“${professionalDataProvider.name}”的 Agent Plan Key；查询失败会自动降级，不会中断研究。`}</span>
          </div>
        )}
      </section>

      {activeJob && (
        <section className="rounded-xl border border-app-border bg-app-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold text-tp">{researchTargetsTitle(activeJob.targets ?? [activeJob.target], isEn)} · {researchWorkflowTitle(activeJob.workflowId, language)}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-tmi" aria-live="polite">{jobStatusLabel(activeJob.status, isEn)} · {message}</p>
            </div>
            {stopping ? (
              <button type="button" disabled className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(242,78,78,0.08)] text-[#F24E4E] opacity-70" aria-label={isEn ? "Stopping research" : "正在中断研究"}><Loader2 size={13} className="animate-spin" /></button>
            ) : running ? (
              <button type="button" onClick={() => void cancel()} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(242,78,78,0.1)] text-[#F24E4E]" aria-label={isEn ? "Stop research" : "中断研究"} title={isEn ? "Stop research" : "中断研究"}><CircleStop size={14} /></button>
            ) : activeJob.status !== "completed" ? (
              <button type="button" onClick={() => void run(activeJob)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(79,156,249,0.1)] text-app-accent" aria-label={isEn ? "Restart research" : "重新开始研究"} title={isEn ? "Restart research" : "重新开始研究"}><RefreshCw size={14} /></button>
            ) : null}
          </div>
          <div className="mt-3 space-y-1.5">
            {workflowAgentIds(activeJob.workflowId).map((agentId) => {
              const done = activeJob.completedSteps.includes(agentId);
              const current = activeJob.currentStep === agentId && running;
              return (
                <div key={agentId} className="flex items-center gap-2 rounded-lg bg-app-surface px-2.5 py-2 text-[12px]">
                  {done ? <Check size={11} color="#31D08B" /> : current ? <Loader2 size={11} className="animate-spin text-app-accent" /> : <Clock3 size={11} className="text-tmi" />}
                  <span className={done ? "text-ts" : current ? "text-app-accent" : "text-tmi"}>{researchAgentTitle(agentId, language)}</span>
                </div>
              );
            })}
          </div>
          {activeJob.error && <div role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg bg-[rgba(242,78,78,0.08)] px-2.5 py-2 text-[11px] leading-4 text-[#F24E4E]"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{activeJob.error.message}</div>}
          {streamPreview && <pre aria-live="polite" className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap rounded-lg bg-app-surface px-2.5 py-2 text-[11px] leading-4 text-tmi">{streamPreview.slice(-1600)}</pre>}
        </section>
      )}

      <section className="rounded-xl border border-app-border bg-app-card">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <button type="button" onClick={() => setShowLibrary((value) => !value)} className="flex min-h-9 min-w-0 flex-1 items-center justify-between rounded-lg px-1 text-left">
            <div className="flex min-w-0 items-center gap-2"><BookOpen size={14} color="#4F9CF9" /><span className="text-[13px] font-semibold text-tp">{isEn ? "Research library" : "研究报告库"}</span><span className="rounded bg-app-surface px-1.5 py-0.5 text-[12px] text-tmi">{reports.length}/{MAX_RESEARCH_REPORTS}</span></div>
            {showLibrary ? <ChevronDown size={14} className="text-tmi" /> : <ChevronRight size={14} className="text-tmi" />}
          </button>
          {reports.length > 1 && (
            <button type="button" onClick={() => downloadResearchReports(reports, language)} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-ts" aria-label={isEn ? "Download all reports" : "一次下载全部报告"} title={isEn ? "Download all reports as a ZIP grouped by target" : "按标的分文件夹打包 ZIP 下载"}>
              <Download size={12} />{isEn ? "All" : "全部导出"}
            </button>
          )}
        </div>
        {showLibrary && (
          <div className="border-t border-app-border p-2.5">
            {reports.length >= MAX_RESEARCH_REPORTS * 0.9 && (
              <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-[rgba(245,158,11,0.1)] px-2.5 py-2 text-[11px] leading-4 text-[#D18416]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{isEn ? "The local library is near its limit. Export all reports before the oldest records are rotated." : "本地报告库接近上限；最旧记录轮换前请先执行“全部导出”。"}</span>
              </div>
            )}
            {reports.length === 0 ? (
              <div className="py-7 text-center"><Bot size={21} className="mx-auto text-tmi" /><p className="mt-2 text-[12px] text-tmi">{isEn ? "No research reports yet" : "还没有研究报告"}</p></div>
            ) : (
              <div className="space-y-2">
                {reports.slice(0, reportVisibleCount).map((report) => (
                  <div key={report.id} className="flex items-start gap-1 rounded-lg bg-app-surface p-1">
                    <button type="button" onClick={() => setSelectedReport(report)} className="flex min-w-0 flex-1 items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-card">
                      <div className="min-w-0"><p className="truncate text-[12px] font-semibold text-tp">{report.title}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-tmi">{report.summary}</p></div>
                      <ChevronRight size={11} className="mt-0.5 shrink-0 text-tmi" />
                    </button>
                    <button type="button" onClick={() => setPendingDelete({ kind: "report", id: report.id, title: report.title })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tmi hover:bg-[rgba(242,78,78,0.08)] hover:text-[#F24E4E]" aria-label={isEn ? `Delete report ${report.title}` : `删除报告${report.title}`} title={isEn ? "Delete report" : "删除报告"}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                {reports.length > reportVisibleCount && (
                  <button type="button" onClick={() => setReportVisibleCount((count) => count + 20)} className="w-full rounded-lg bg-app-surface py-2 text-[11px] font-semibold text-app-accent hover:bg-app-card">
                    {isEn ? `Show more (${reports.length - reportVisibleCount} remaining)` : `显示更多（剩余 ${reports.length - reportVisibleCount} 条）`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {jobs.some((job) => job.status === "failed" || job.status === "paused" || job.status === "cancelled") && (
        <section className="rounded-xl border border-app-border bg-app-card p-3">
          <div className="flex items-center justify-between gap-2"><p className="text-[13px] font-semibold text-tp">{isEn ? "Incomplete tasks" : "未完成任务"}</p><span className="text-[11px] text-tmi">{jobs.length}/{MAX_RESEARCH_JOBS}</span></div>
          <div className="mt-2 space-y-2">
            {jobs.filter((job) => job.status === "failed" || job.status === "paused" || job.status === "cancelled").slice(0, 10).map((job) => (
              <div key={job.id} className="flex items-center gap-2 rounded-lg bg-app-surface px-2.5 py-2">
                <button type="button" onClick={() => {
                  const restoredTargets = job.targets ?? [job.target];
                  const [primary, ...rest] = restoredTargets;
                  setActiveJob(job);
                  setWorkflowId(job.workflowId);
                  if (primary) applyPrimaryTarget(primary);
                  setAdditionalTargets(rest);
                  setTopic(job.topic ?? "");
                  setPeriod(job.period ?? "");
                  if (job.incomeInvestmentContext) {
                    setIncomeMode(job.incomeInvestmentContext.mode);
                    setIncomeRole(job.incomeInvestmentContext.role);
                    setIncomeTargetYield(job.incomeInvestmentContext.targetYield ?? "");
                    setIncomeTaxResidence(job.incomeInvestmentContext.taxResidence ?? "");
                    setIncomeHorizon(job.incomeInvestmentContext.horizon ?? "");
                  }
                  setSecurityQuery("");
                }} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-[12px] font-semibold text-ts">{researchTargetsTitle(job.targets ?? [job.target], isEn)} · {researchWorkflowTitle(job.workflowId, language)}</p>
                  <p className="mt-0.5 text-[11px] text-tmi">{jobStatusLabel(job.status, isEn)} · {job.completedSteps.length}/{workflowAgentIds(job.workflowId).length}</p>
                </button>
                <button type="button" onClick={() => void run(job)} disabled={busy} className="flex h-8 w-8 items-center justify-center rounded-lg text-app-accent disabled:opacity-40" aria-label={isEn ? "Restart research" : "重新开始研究"} title={isEn ? "Restart research" : "重新开始研究"}><RefreshCw size={13} /></button>
                <button type="button" onClick={() => setPendingDelete({ kind: "job", id: job.id, title: `${researchTargetsTitle(job.targets ?? [job.target], isEn)} · ${researchWorkflowTitle(job.workflowId, language)}` })} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#F24E4E]" aria-label={isEn ? "Delete task" : "删除任务"} title={isEn ? "Delete task" : "删除任务"}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
      {deleteConfirmation}
    </div>
  );
}
