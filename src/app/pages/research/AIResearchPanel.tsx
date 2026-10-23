import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  Database,
  Download,
  FileCheck2,
  Globe2,
  Layers,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Route,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Feedback, Field, Notice as InlineNotice, SelectField, StatusPill, StickyActions, Switch } from "../../research/components/settingsUi";
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
import { researchWorkflowTitle, workflowAgentIds } from "../../research/workflows/prompts";
import { WORKFLOW_CATEGORY_LABELS, getWorkflowConfig } from "../../research/workflows/registry";
import {
  InfoChip,
  JobProgressCard,
  PlanRoleCard,
  ResearchSheet,
  SummaryRow,
  WorkflowBadges,
  WorkflowPicker,
  jobStatusLabel,
  researchTargetsTitle,
} from "./researchPanelParts";

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

function isInterrupted(status: ResearchJob["status"]) {
  return status === "preparing" || status === "running" || status === "synthesizing" || status === "auditing";
}

type PanelView = "new" | "library" | "tasks";
type Notice = { type: "success" | "error"; text: string } | null;

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
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [activeJob, setActiveJob] = useState<ResearchJob | null>(null);
  const [selectedReport, setSelectedReport] = useState<ResearchReport | null>(null);
  const [providerSettings, setProviderSettings] = useState<ResearchProviderSettings | null>(null);
  const [providerProfiles, setProviderProfiles] = useState<ResearchProviderCollection | null>(null);
  const [externalSearchSettings, setExternalSearchSettings] = useState<ResearchExternalSearchSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [view, setView] = useState<PanelView>("new");
  const [notice, setNotice] = useState<Notice>(null);
  const [message, setMessage] = useState("");
  const [streamPreview, setStreamPreview] = useState("");
  const [stoppingJobId, setStoppingJobId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "report" | "job"; id: string; title: string } | null>(null);
  const [reportVisibleCount, setReportVisibleCount] = useState(20);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The job this page is running right now; reload() must not pause it as "interrupted".
  const runningJobIdRef = useRef<string | null>(null);
  const showError = (text: string) => setNotice({ type: "error", text });

  const reload = useCallback(async () => {
    const [storedJobs, storedReports, providerCollection, searchSettings] = await Promise.all([
      listResearchJobs(),
      listResearchReports(),
      loadResearchProviderProfiles(),
      loadResearchExternalSearchSettings(),
    ]);
    const settings = providerCollection.profiles.find((profile) => profile.id === providerCollection.activeProfileId) ?? providerCollection.profiles[0]!;
    const recovered = await Promise.all(storedJobs.map(async (job) => {
      if (!isInterrupted(job.status) || job.id === runningJobIdRef.current) return job;
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
      showError(isEn ? "This target is already selected." : "该标的已在研究列表中。");
      setSecurityQuery("");
      return;
    }
    if (current.length >= 5) {
      showError(isEn ? "Up to five targets can be compared at once." : "一次最多对比 5 个标的。");
      return;
    }
    if (!primary) applyPrimaryTarget(target);
    else setAdditionalTargets((items) => [...items, target]);
    setSecurityQuery("");
    setEditingTargetKey(null);
    setNotice(null);
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
    setNotice({ type: "success", text: isEn ? "Model responsibilities saved for this workflow." : `已保存“${workflowConfig.titles.zh}”的模型调用分工。` });
  };

  const setWorkflowExecutionModelRole = async (value: string) => {
    if (!providerProfiles) return;
    const executionModelRole = value === "main" || value === "fast" ? value : undefined;
    const next = updateWorkflowProviderRoute(providerProfiles, workflowId, { executionModelRole });
    const resolved = resolveResearchProviderRouting(next, workflowId);
    setProviderProfiles(next);
    setProviderSettings(resolved.routing.execution);
    await saveResearchProviderProfiles(next);
    setNotice({ type: "success", text: isEn ? "Execution model strategy saved for this workflow." : `已保存“${workflowConfig.titles.zh}”的执行模型策略。` });
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
    setView("new");
    setNotice(null);
    scrollRef.current?.scrollTo({ top: 0 });
    if (abortRef.current) {
      showError(isEn ? "The previous request is still stopping. Try again in a moment." : "上一次研究请求正在结束，请稍后再重新开始。");
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
      showError(isEn
        ? `${incomplete.role} API “${incomplete.profile.name}” is incomplete. Check its endpoint, selected model${incomplete.profile.authMode === "none" ? "" : " and API key"}.`
        : `${incomplete.role} API“${incomplete.profile.name}”配置不完整，请检查地址、所选模型${incomplete.profile.authMode === "none" ? "" : "和 API Key"}。`);
      return;
    }
    if (runUsesTopicInput && !runTopic.trim()) {
      showError(isEn ? "Enter a topic or question." : "请输入主题或问题。 ");
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
      showError(isEn ? "Enter a security symbol." : "请输入证券代码。 ");
      return;
    }
    if (config.needsPortfolioContext && holdings.length === 0) {
      showError(isEn ? "No holdings to review." : "没有持仓可分析。 ");
      return;
    }
    const targetCount = targetsToRun?.length ?? (targetToRun.symbol ? 1 : 0);
    const minTargets = config.minTargets ?? 1;
    const maxTargets = config.maxTargets ?? (config.supportsMultipleTargets ? 5 : 1);
    if (!config.needsPortfolioContext && (!runUsesTopicInput || runUsesTargetAndTopic) && targetCount < minTargets) {
      showError(isEn ? `Select at least ${minTargets} target(s).` : `请至少选择 ${minTargets} 个标的。`);
      return;
    }
    if (!config.needsPortfolioContext && (!runUsesTopicInput || runUsesTargetAndTopic) && targetCount > maxTargets) {
      showError(isEn
        ? `${config.titles.en} supports at most ${maxTargets} target(s).`
        : `${config.titles.zh}最多支持 ${maxTargets} 个标的。请减少标的，或使用“快速检查/去劣筛选”。`);
      return;
    }
    if (runWorkflowId === "thesis_drift" && !resumeJob?.thesisDriftContext && (!driftOlderReport || !driftNewerReport)) {
      showError(isEn ? "Select two reports to compare." : "请选择两份报告进行对比。 ");
      return;
    }
    setStreamPreview("");
    for (const connection of requiredConnections) {
      let permission = false;
      try {
        permission = await ensureModelEndpointPermission(connection.profile.endpoint);
      } catch (error) {
        showError(error instanceof Error ? `${connection.role} · ${error.message}` : isEn ? `Invalid ${connection.role.toLowerCase()} endpoint.` : `${connection.role}模型 API 地址无效。`);
        return;
      }
      if (!permission) {
        showError(isEn ? `${connection.role} endpoint permission was denied.` : `未授予${connection.role}模型服务域名访问权限。`);
        return;
      }
    }
    if ((settings.webSearchMode === "auto" || settings.webSearchMode === "external") && searchSettings.endpoint && searchSettings.apiKey) {
      try {
        const searchPermission = await ensureModelEndpointPermission(searchSettings.endpoint);
        if (!searchPermission && settings.webSearchMode === "external") {
          showError(isEn ? "External search endpoint permission was denied." : "未授予外部搜索服务域名访问权限。 ");
          return;
        }
      } catch (error) {
        if (settings.webSearchMode === "external") {
          showError(error instanceof Error ? error.message : isEn ? "Invalid search endpoint." : "外部搜索 API 地址无效。 ");
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
    runningJobIdRef.current = preparingJob.id;
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
      if (runningJobIdRef.current === preparingJob.id) runningJobIdRef.current = null;
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
          if (event.resetPreview) setStreamPreview("");
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
      if (runningJobIdRef.current === job.id) runningJobIdRef.current = null;
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

  const running = Boolean(activeJob && ["preparing", "running", "synthesizing", "auditing"].includes(activeJob.status));
  const stopping = Boolean(activeJob && stoppingJobId === activeJob.id);
  const busy = Boolean(running || stopping);
  const isDeepCompanySeries = workflowId === "deep_company_series";
  const showStandardTarget = !backtestContext && !workflowConfig.needsPortfolioContext && (!usesTopicInput || isDeepCompanySeries);
  const showTopicInput = !backtestContext && usesTopicInput;
  const hasMatchedTarget = allTargets.length > 0;
  const targetLimit = workflowConfig.maxTargets ?? (workflowConfig.supportsMultipleTargets ? 5 : 1);
  const activeTargetConflict = showStandardTarget && allTargets.length > targetLimit;
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
        ? (isEn ? "An industry, index, market or investment theme." : "输入行业、指数、市场或投资主题。")
        : (isEn ? "Relevant companies are discovered from this scope." : "系统会根据这个范围自动发现相关公司。")
      : (isEn ? "Only public market data is sent by default." : "默认只发送公开行情字段。");
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
  const executionProviderReady = isResearchProviderConfigured(executionProvider, activeProviderModelLabel);
  const hasExternalSearch = Boolean(externalSearchSettings?.apiKey);
  const webWarn = !executionProviderReady
    || (executionProvider?.webSearchMode !== "off" && !providerWebSearchCapability?.supported && !hasExternalSearch);
  // Short label for the model-plan chip; the full explanation only shows when something needs attention.
  const webChip = !executionProvider
    ? (isEn ? "Web unknown" : "联网状态未知")
    : executionProvider.webSearchMode === "auto"
      ? (providerWebSearchCapability?.supported
        ? (hasExternalSearch ? (isEn ? "Native + external search" : "原生联网 + 外部搜索") : (isEn ? "Native web search" : "原生联网"))
        : hasExternalSearch ? (isEn ? "External search" : "外部搜索") : (isEn ? "Prefetched data only" : "仅预取行情"))
      : executionProvider.webSearchMode === "external"
        ? (hasExternalSearch ? `${isEn ? "External" : "外部搜索"} · ${externalSearchSettings?.name}` : (isEn ? "External search: no key" : "外部搜索未配置 Key"))
        : executionProvider.webSearchMode === "native"
          ? (providerWebSearchCapability?.supported ? (isEn ? "Native web search" : "原生联网") : (isEn ? "Native web unsupported" : "不支持原生联网"))
          : (isEn ? "Web search off" : "联网关闭");
  const webNote = !executionProviderReady
    ? (isEn ? "Configure the execution model, endpoint and API key before starting." : "请先在模型方案中配置执行模型、API 地址与 Key。")
    : executionProvider?.webSearchMode === "native" && !providerWebSearchCapability?.supported
      ? (isEn ? providerWebSearchCapability?.reasonEn : providerWebSearchCapability?.reasonZh)
      : executionProvider?.webSearchMode === "external"
        ? (isEn ? "External search is selected but has no API key." : "已选择外部搜索，但尚未配置搜索 API Key。")
        : (isEn ? "No verifiable native browsing; research continues with prefetched market data." : "当前模型无可验证的原生联网；研究仍会使用插件预取行情，不会中断。");
  const executionRole = selectedProviderRoute.executionModelRole ?? "auto";
  const executionFallsBack = Boolean(executionProvider)
    && !executionProvider?.fastModel
    && (executionRole === "fast" || (executionRole === "auto" && !workflowConfig.useFullModel));
  const synthesisModelLabel = synthesisProvider?.synthesisModel || synthesisProvider?.model || "";
  const auditModelLabel = auditProvider?.auditModel || auditProvider?.model || "";
  const incompleteJobs = jobs.filter((job) => job.status === "failed" || job.status === "paused" || job.status === "cancelled");
  const showTasksTab = incompleteJobs.length > 0 || view === "tasks";

  const switchView = (next: PanelView) => {
    setView(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const restoreJob = (job: ResearchJob) => {
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
    switchView("new");
  };

  const selectWorkflow = (id: ResearchWorkflowId) => {
    setWorkflowId(id);
    setNotice(null);
    setShowModePicker(false);
  };

  const activeReport = activeJob?.reportId ? reports.find((report) => report.id === activeJob.reportId) : undefined;
  const inputClass = "h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 text-[12px] text-tp outline-none placeholder:text-tmi focus:border-app-accent";

  const tabs: Array<{ id: PanelView; label: string; count?: number; icon: typeof Sparkles }> = [
    { id: "new", label: isEn ? "New research" : "新建研究", icon: Sparkles },
    { id: "library", label: isEn ? "Reports" : "报告库", count: reports.length, icon: BookOpen },
    ...(showTasksTab ? [{ id: "tasks" as const, label: isEn ? "Unfinished" : "未完成", count: incompleteJobs.length, icon: ListChecks }] : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-2" role="tablist" aria-label={isEn ? "AI research sections" : "AI 研究分区"}>
        <div className="flex gap-4 border-b border-app-border">
          {tabs.map(({ id, label, count, icon: Icon }) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchView(id)}
                className={`relative flex items-center gap-1 pb-2 pt-1 text-[12px] font-semibold transition-colors ${active ? "text-app-accent" : "text-tm"}`}
              >
                <Icon size={12} />{label}
                {count !== undefined && <span className={`rounded-full px-1.5 text-[10px] ${active ? "bg-[rgba(79,156,249,0.12)]" : "bg-app-surface text-tmi"}`}>{count}</span>}
                {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-app-accent" />}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-3" style={{ scrollbarWidth: "none" }}>
        {view !== "new" && running && activeJob && (
          <button type="button" onClick={() => switchView("new")} className="mb-2.5 flex w-full items-center gap-2 rounded-xl border border-app-accent/30 bg-[rgba(79,156,249,0.06)] px-3 py-2 text-left">
            <Loader2 size={13} className="shrink-0 animate-spin text-app-accent" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-ts">{researchTargetsTitle(activeJob.targets ?? [activeJob.target], isEn)} · {message || jobStatusLabel(activeJob.status, isEn)}</span>
            <span className="shrink-0 text-[11px] font-semibold text-app-accent">{isEn ? "View" : "查看"}</span>
          </button>
        )}

        {view === "new" && (
          <>
            <div className="space-y-2.5">
              {backtestContext && (
                <section className="flex items-center justify-between gap-2 rounded-xl border border-app-accent/20 bg-[rgba(79,156,249,0.08)] px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-semibold text-app-accent">{isEn ? "Reviewing local backtest" : "正在解读本地回测"}</p>
                    <p className="mt-0.5 truncate text-[11px] text-tmi">{backtestContext.name} · {backtestContext.startDate} – {backtestContext.endDate}</p>
                  </div>
                  {onClearBacktestContext && <button type="button" onClick={onClearBacktestContext} className="shrink-0 rounded-lg bg-app-card px-2 py-1.5 text-[11px] font-semibold text-ts">{isEn ? "Exit" : "退出"}</button>}
                </section>
              )}

              {activeJob && (
                <JobProgressCard
                  job={activeJob}
                  message={message}
                  streamPreview={streamPreview}
                  running={running}
                  stopping={stopping}
                  isEn={isEn}
                  language={language}
                  onStop={() => void cancel()}
                  onRestart={() => void run(activeJob)}
                  onViewReport={activeReport ? () => setSelectedReport(activeReport) : undefined}
                  onDismiss={() => setActiveJob(null)}
                />
              )}

              <section aria-label={isEn ? "Research mode" : "研究模式"} className="rounded-xl border border-app-border bg-app-card p-3">
                <div className="flex items-start gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(79,156,249,0.1)] text-app-accent"><Layers size={15} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-tmi">{isEn ? "Research mode" : "研究模式"} · {isEn ? WORKFLOW_CATEGORY_LABELS[workflowConfig.category].en : WORKFLOW_CATEGORY_LABELS[workflowConfig.category].zh}</p>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      <p className="truncate text-[14px] font-semibold text-tp">{researchWorkflowTitle(workflowId, language)}</p>
                      <WorkflowBadges workflow={workflowConfig} isEn={isEn} />
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-tmi">{isEn ? workflowConfig.descriptions.en : workflowConfig.descriptions.zh}</p>
                  </div>
                  {backtestContext ? (
                    workflowId !== "backtest_interpretation" && (
                      <button type="button" onClick={() => setWorkflowId("backtest_interpretation")} className="h-8 shrink-0 rounded-lg border border-app-border bg-app-surface px-2.5 text-[11px] font-semibold text-app-accent">{isEn ? "Backtest review" : "回测解读"}</button>
                    )
                  ) : (
                    <button type="button" onClick={() => setShowModePicker(true)} className="h-8 shrink-0 rounded-lg border border-app-border bg-app-surface px-2.5 text-[11px] font-semibold text-app-accent" aria-haspopup="dialog">{isEn ? "Change" : "更换"}</button>
                  )}
                </div>
              </section>

              <section aria-label={inputTitle} className="rounded-xl border border-app-border bg-app-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-tp">{inputTitle}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-tmi">{inputDescription}</p>
                  </div>
                  {showStandardTarget && <StatusPill tone={activeTargetConflict ? "danger" : allTargets.length ? "accent" : "muted"}>{allTargets.length}/{targetLimit}</StatusPill>}
                </div>

                <div className="mt-2.5 space-y-2.5">
                  {backtestContext && (
                    <p className="rounded-lg bg-app-surface px-2.5 py-2 text-[11px] text-ts">{backtestContext.name} · {backtestContext.startDate} – {backtestContext.endDate}</p>
                  )}

                  {workflowConfig.needsPortfolioContext && (
                    <div className="flex items-center gap-2.5 rounded-lg bg-app-surface px-2.5 py-2">
                      <Bot size={14} className="shrink-0 text-app-accent" />
                      <div className="min-w-0">
                        <p className="text-[12px] font-semibold text-tp">{holdings.length} {isEn ? "holdings" : "个持仓"} · {stats.totalAsset.toFixed(0)} {holdings[0]?.currency ?? ""}</p>
                        <p className="mt-0.5 text-[11px] leading-4 text-tmi">{isEn ? "All positions are analyzed together." : "分析全部持仓的集中度、相关性和压力测试。"}</p>
                      </div>
                    </div>
                  )}

                  {workflowConfig.supportsTopicAlternative && !backtestContext && (
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-app-surface p-1" role="radiogroup" aria-label={isEn ? "Screening input" : "筛选输入方式"}>
                      {([
                        { id: "targets" as const, label: isEn ? "Selected targets" : "选择标的" },
                        { id: "scope" as const, label: isEn ? "Screening scope" : "筛选范围" },
                      ]).map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={qualityScreenInputMode === option.id}
                          onClick={() => { setQualityScreenInputMode(option.id); setNotice(null); }}
                          className={`rounded-md px-2 py-1.5 text-[12px] font-semibold transition-colors ${qualityScreenInputMode === option.id ? "bg-app-card text-app-accent shadow-sm" : "text-tm"}`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {showTopicInput && (
                    <Field label={isDeepCompanySeries ? (isEn ? "Series count and narrative" : "系列篇数与叙事主线") : inputTitle}>
                      <textarea
                        value={topic}
                        onChange={(event) => setTopic(event.target.value)}
                        placeholder={workflowId === "deep_company_series"
                          ? (isEn ? "e.g. 5 articles, from business model and moat to valuation and risks…" : "例如：5 篇，从商业模式、护城河写到财务、估值与风险…")
                          : workflowId === "era_alpha"
                            ? (isEn ? "e.g. AI compute infrastructure, next-generation batteries…" : "例如：AI 算力基础设施、新一代电池产业链…")
                            : workflowId === "quality_screen"
                              ? (isEn ? "e.g. Hang Seng Index, global cloud computing, China high dividend…" : "例如：恒生指数、全球云计算、中国高股息主题…")
                              : (isEn ? "Enter a topic, question, or industry name…" : "输入主题、问题或行业方向…")}
                        rows={3}
                        className="w-full resize-none rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[12px] leading-5 text-tp outline-none placeholder:text-tmi focus:border-app-accent"
                      />
                    </Field>
                  )}
                  {showTopicInput && allTargets.length > 0 && !isDeepCompanySeries && (
                    <p className="text-[11px] leading-4 text-tmi">
                      {workflowId === "quality_screen"
                        ? (isEn ? `${allTargets.length} selected target(s) are kept; switch back to Selected targets to use them.` : `已保留 ${allTargets.length} 个标的；切回“选择标的”即可继续使用。`)
                        : (isEn ? `${allTargets.length} selected target(s) are kept but not used by this topic mode.` : `已保留 ${allTargets.length} 个标的，当前主题模式不会使用。`)}
                    </p>
                  )}

                  {showStandardTarget && (
                    <>
                      <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2">
                        <SelectField ariaLabel={isEn ? "Market scope" : "市场范围"} value={marketScope} onChange={(value) => handleMarketScopeChange(value as Market | "")}>
                          {marketScopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </SelectField>
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

                      {!hasMatchedTarget ? (
                        <p className="rounded-lg border border-dashed border-app-border px-3 py-3 text-center text-[11px] leading-4 text-tmi">
                          {isEn ? "Pick from your holdings or search results; market, type and currency are filled in." : "从持仓或搜索结果中选择，市场、类型和币种会自动匹配"}
                        </p>
                      ) : (
                        <ul className="space-y-1.5" aria-label={isEn ? "Selected targets" : "已选标的"}>
                          {allTargets.map((target) => {
                            const key = researchTargetKey(target);
                            const editing = editingTargetKey === key;
                            return (
                              <li key={key} className="rounded-lg border border-app-border bg-app-surface px-2.5 py-2">
                                <div className="flex items-center gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[12px] font-semibold text-tp">{target.name || target.symbol} <span className="font-normal text-tmi">{target.symbol}</span></p>
                                    <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] text-tmi">
                                      <Check size={10} className="shrink-0 text-[#31A777]" />
                                      <span className="truncate">{target.holdingId ? (isEn ? "From holdings" : "来自持仓") : (isEn ? "Matched" : "自动匹配")} · {marketLabel(target.market, language)} · {assetTypeLabel(target.assetType, language)} · {target.currency || (isEn ? "Unknown" : "未识别")}</span>
                                    </p>
                                  </div>
                                  <button type="button" aria-expanded={editing} onClick={() => setEditingTargetKey(editing ? null : key)} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-ts hover:bg-app-card">
                                    {editing ? (isEn ? "Done" : "完成") : (isEn ? "Correct" : "修正")}
                                  </button>
                                  <button type="button" aria-label={isEn ? `Remove ${target.name}` : `移除${target.name}`} onClick={() => removeResearchTarget(key)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tmi hover:bg-app-card hover:text-[#F24E4E]">
                                    <X size={13} />
                                  </button>
                                </div>
                                {editing && (
                                  <div className="mt-2 grid grid-cols-3 gap-2 border-t border-app-border-sub pt-2">
                                    <Field label={isEn ? "Market" : "市场"}>
                                      <SelectField ariaLabel={isEn ? `Market for ${target.name}` : `${target.name}的市场`} value={target.market} onChange={(value) => updateResearchTarget(key, { market: value })}>
                                        {targetMarketOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                      </SelectField>
                                    </Field>
                                    <Field label={isEn ? "Type" : "类型"}>
                                      <SelectField ariaLabel={isEn ? `Type for ${target.name}` : `${target.name}的类型`} value={target.assetType} onChange={(value) => updateResearchTarget(key, { assetType: value })}>
                                        {targetAssetTypeOptions(target.assetType).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                      </SelectField>
                                    </Field>
                                    <Field label={isEn ? "Currency" : "币种"}>
                                      <SelectField ariaLabel={isEn ? `Currency for ${target.name}` : `${target.name}的币种`} value={target.currency} onChange={(value) => updateResearchTarget(key, { currency: value })}>
                                        {targetCurrencyOptions(target.currency).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                      </SelectField>
                                    </Field>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {allTargets.length > 1 && workflowConfig.supportsMultipleTargets && (
                        <InlineNotice>
                          {workflowId === "quality_screen"
                            ? (isEn ? `The same seven hard filters run on all ${allTargets.length} targets.` : `将对 ${allTargets.length} 个标的逐一应用同一套 7 项硬指标。`)
                            : (isEn ? `The six-gate checklist runs on all ${allTargets.length} targets, then one overview table.` : `将对 ${allTargets.length} 个标的逐一执行六关 Checklist，最后生成总览对比表。`)}
                        </InlineNotice>
                      )}
                      {allTargets.length > 1 && !workflowConfig.supportsMultipleTargets && (
                        <InlineNotice tone="warn">
                          {isEn
                            ? `${workflowConfig.titles.en} takes one target. Keep one, or switch to Quick Check.`
                            : `${workflowConfig.titles.zh}是单标的模式；请保留一个标的，或更换为支持多标的的“快速检查”。`}
                        </InlineNotice>
                      )}

                      {selectedHolding && allTargets.length === 1 && (
                        <Switch
                          checked={sharePrivate}
                          onChange={setSharePrivate}
                          label={isEn ? "Include my position" : "结合我的持仓分析"}
                          description={isEn ? "Sends quantity, cost, market value and portfolio weight." : "将发送数量、成本、市值和组合占比；默认关闭。"}
                        />
                      )}

                      {workflowConfig.needsPeriodInput && (
                        <Field label={isEn ? "Earnings period" : "财报期数"}>
                          <input value={period} onChange={(event) => setPeriod(event.target.value)} placeholder={isEn ? "e.g. 2025Q4" : "如 2025Q4"} className={inputClass} />
                        </Field>
                      )}

                      {workflowConfig.needsIncomeInputs && (
                        <div className="space-y-2 border-t border-app-border-sub pt-2.5">
                          <div>
                            <p className="text-[12px] font-semibold text-tp">{isEn ? "Income objectives" : "收益目标"}</p>
                            <p className="mt-0.5 text-[11px] leading-4 text-tmi">{isEn ? "Blank fields will not be guessed." : "用于判断组合角色与税后收益；未填写的不会被猜测。"}</p>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label={isEn ? "Decision" : "决策场景"}>
                              <SelectField ariaLabel={isEn ? "Income decision" : "收益型投资决策场景"} value={incomeMode} onChange={(value) => setIncomeMode(value as IncomeInvestmentContext["mode"])}>
                                <option value="new">{isEn ? "New position" : "新建仓位"}</option>
                                <option value="existing">{isEn ? "Existing position" : "已有持仓"}</option>
                              </SelectField>
                            </Field>
                            <Field label={isEn ? "Portfolio role" : "组合角色"}>
                              <SelectField ariaLabel={isEn ? "Portfolio role" : "收益型投资组合角色"} value={incomeRole} onChange={(value) => setIncomeRole(value as IncomeInvestmentContext["role"])}>
                                <option value="unspecified">{isEn ? "Not specified" : "未指定"}</option>
                                <option value="core-income">{isEn ? "Core income" : "核心收益仓"}</option>
                                <option value="opportunistic-income">{isEn ? "Opportunistic" : "机会型收益仓"}</option>
                              </SelectField>
                            </Field>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <Field label={isEn ? "Target yield" : "目标收益率"}><input value={incomeTargetYield} onChange={(event) => setIncomeTargetYield(event.target.value)} placeholder="4%" className={inputClass} /></Field>
                            <Field label={isEn ? "Tax residence" : "税务居民地"}><input value={incomeTaxResidence} onChange={(event) => setIncomeTaxResidence(event.target.value)} placeholder={isEn ? "Optional" : "选填"} className={inputClass} /></Field>
                            <Field label={isEn ? "Horizon" : "持有期限"}><input value={incomeHorizon} onChange={(event) => setIncomeHorizon(event.target.value)} placeholder={isEn ? "5 years" : "如 5 年"} className={inputClass} /></Field>
                          </div>
                        </div>
                      )}

                      {workflowId === "thesis_tracker" && (currentTarget.name || currentTarget.symbol) && (
                        <p className="text-[11px] leading-4 text-tmi">
                          {reports.some((r) => r.workflowId === "thesis_tracker" && (r.target.name?.toLowerCase().includes((currentTarget.name || currentTarget.symbol).toLowerCase()) || r.target.symbol?.toLowerCase().includes((currentTarget.name || currentTarget.symbol).toLowerCase())))
                            ? (isEn ? "Prior thesis found — will run in check mode." : "已找到历史论文 — 将进入复检模式。")
                            : (isEn ? "No prior thesis — will establish a new thesis." : "未找到历史论文 — 将建立新论文。")}
                        </p>
                      )}

                      {workflowId === "thesis_drift" && (
                        <div className="grid grid-cols-2 gap-2">
                          <Field label={isEn ? "Older report" : "较早报告"}>
                            <SelectField ariaLabel={isEn ? "Older report" : "较早报告"} value={driftOlderId} onChange={setDriftOlderId}>
                              <option value="">{isEn ? "Select" : "请选择"}</option>
                              {companyReports.filter((r) => r.id !== driftNewerId).map((r) => <option key={r.id} value={r.id}>{r.createdAt.slice(0, 10)} · {r.title}</option>)}
                            </SelectField>
                          </Field>
                          <Field label={isEn ? "Newer report" : "较新报告"}>
                            <SelectField ariaLabel={isEn ? "Newer report" : "较新报告"} value={driftNewerId} onChange={setDriftNewerId}>
                              <option value="">{isEn ? "Select" : "请选择"}</option>
                              {companyReports.filter((r) => r.id !== driftOlderId).map((r) => <option key={r.id} value={r.id}>{r.createdAt.slice(0, 10)} · {r.title}</option>)}
                            </SelectField>
                          </Field>
                          {companyReports.length === 0 && (currentTarget.name || currentTarget.symbol) && (
                            <p className="col-span-2 text-[11px] text-tmi">{isEn ? "No matching reports found." : "未找到匹配的报告。"}</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>

              <SummaryRow
                icon={<Route size={15} />}
                label={isEn ? "Model plan" : "模型方案"}
                tone={executionProviderReady ? "default" : "warn"}
                onClick={() => setShowSettings(true)}
                value={<span className="block truncate">{executionProvider?.name || (isEn ? "Not configured" : "未配置")} · {activeProviderModelLabel || (isEn ? "No model" : "未选择模型")}</span>}
              >
                <div className="flex flex-wrap gap-1">
                  <InfoChip icon={<Globe2 size={10} className="text-app-accent" />} tone={webWarn ? "warn" : "default"}>{webChip}</InfoChip>
                  <InfoChip icon={<Database size={10} className={professionalDataProvider?.apiKey ? "text-[#7C3AED]" : ""} />} tone={professionalDataProvider?.apiKey ? "default" : "muted"}>
                    {professionalDataProvider?.apiKey ? (isEn ? "DataPro" : "专业数据") : (isEn ? "No DataPro" : "未接专业数据")}
                  </InfoChip>
                  {workflowConfig.needsSynthesis && <InfoChip icon={<FileCheck2 size={10} className="text-[#8B5CF6]" />}>{isEn ? "Synthesis" : "综合"} · {synthesisModelLabel || activeProviderModelLabel || "-"}</InfoChip>}
                  <InfoChip icon={<Shield size={10} className="text-[#10B981]" />}>{auditProvider ? (isEn ? "Model audit" : "模型审计") : (isEn ? "Local audit" : "本地审计")}</InfoChip>
                </div>
              </SummaryRow>
            </div>

            <StickyActions
              status={notice
                ? <Feedback type={notice.type} message={notice.text} />
                : webWarn && !busy ? <p className="flex items-start gap-1.5 text-[11px] leading-4 text-[#C27C0E]"><AlertTriangle size={12} className="mt-0.5 shrink-0" /><span>{webNote}</span></p> : undefined}
            >
              <button type="button" onClick={() => void run()} disabled={busy || activeTargetConflict} className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-app-accent text-[13px] font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {stopping ? (isEn ? "Stopping" : "正在中断") : running ? (isEn ? "Researching" : "研究中") : (isEn ? "Start research" : "开始研究")}
              </button>
            </StickyActions>
          </>
        )}

        {view === "library" && (
          <div className="space-y-2 pb-4">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <p className="text-[11px] text-tmi">{isEn ? `${reports.length} of ${MAX_RESEARCH_REPORTS} kept on this device` : `本设备保存 ${reports.length}/${MAX_RESEARCH_REPORTS} 份`}</p>
              {reports.length > 1 && (
                <button type="button" onClick={() => downloadResearchReports(reports, language)} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-card px-2 text-[11px] font-semibold text-ts" aria-label={isEn ? "Download all reports" : "一次下载全部报告"} title={isEn ? "Download all reports as a ZIP grouped by target" : "按标的分文件夹打包 ZIP 下载"}>
                  <Download size={12} />{isEn ? "Export all" : "全部导出"}
                </button>
              )}
            </div>
            {reports.length >= MAX_RESEARCH_REPORTS * 0.9 && (
              <InlineNotice tone="warn">{isEn ? "The library is near its limit. Export all before the oldest reports rotate out." : "报告库接近上限；最旧记录轮换前请先“全部导出”。"}</InlineNotice>
            )}
            {reports.length === 0 ? (
              <div className="rounded-xl border border-dashed border-app-border py-10 text-center">
                <BookOpen size={20} className="mx-auto text-tmi" />
                <p className="mt-2 text-[12px] text-tmi">{isEn ? "No research reports yet" : "还没有研究报告"}</p>
                <button type="button" onClick={() => switchView("new")} className="mt-3 rounded-lg bg-[rgba(79,156,249,0.1)] px-3 py-1.5 text-[11px] font-semibold text-app-accent">{isEn ? "Start a research" : "开始一项研究"}</button>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {reports.slice(0, reportVisibleCount).map((report) => (
                  <li key={report.id} className="flex items-stretch overflow-hidden rounded-xl border border-app-border bg-app-card">
                    <button type="button" onClick={() => setSelectedReport(report)} className="min-w-0 flex-1 px-3 py-2.5 text-left hover:bg-app-surface">
                      <p className="truncate text-[12px] font-semibold text-tp">{report.title}</p>
                      <p className="mt-0.5 text-[10px] text-tmi">{report.createdAt.slice(0, 10)} · {researchWorkflowTitle(report.workflowId, language)}</p>
                      {report.summary && <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-tm">{report.summary}</p>}
                    </button>
                    <button type="button" onClick={() => setPendingDelete({ kind: "report", id: report.id, title: report.title })} className="flex w-10 shrink-0 items-center justify-center border-l border-app-border text-tmi hover:bg-[rgba(242,78,78,0.08)] hover:text-[#F24E4E]" aria-label={isEn ? `Delete report ${report.title}` : `删除报告${report.title}`} title={isEn ? "Delete report" : "删除报告"}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {reports.length > reportVisibleCount && (
              <button type="button" onClick={() => setReportVisibleCount((count) => count + 20)} className="w-full rounded-lg border border-app-border bg-app-card py-2 text-[11px] font-semibold text-app-accent">
                {isEn ? `Show more (${reports.length - reportVisibleCount} remaining)` : `显示更多（剩余 ${reports.length - reportVisibleCount} 条）`}
              </button>
            )}
          </div>
        )}

        {view === "tasks" && (
          <div className="space-y-2 pb-4">
            <p className="px-0.5 text-[11px] text-tmi">{isEn ? `Tap a task to restore its inputs · ${jobs.length}/${MAX_RESEARCH_JOBS} tasks stored` : `点按任务可恢复其输入 · 共保存 ${jobs.length}/${MAX_RESEARCH_JOBS} 个任务`}</p>
            {incompleteJobs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-app-border py-10 text-center text-[12px] text-tmi">{isEn ? "No unfinished tasks" : "没有未完成的任务"}</div>
            ) : (
              <ul className="space-y-1.5">
                {incompleteJobs.slice(0, 10).map((job) => (
                  <li key={job.id} className="flex items-center gap-1 rounded-xl border border-app-border bg-app-card pr-1">
                    <button type="button" onClick={() => restoreJob(job)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-[12px] font-semibold text-tp">{researchTargetsTitle(job.targets ?? [job.target], isEn)} · {researchWorkflowTitle(job.workflowId, language)}</p>
                      </div>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-tmi">
                        <StatusPill tone={job.status === "failed" ? "danger" : "warn"}>{jobStatusLabel(job.status, isEn)}</StatusPill>
                        {job.completedSteps.length}/{workflowAgentIds(job.workflowId).length} {isEn ? "steps" : "步"} · {job.updatedAt.slice(0, 10)}
                      </p>
                      {job.error?.message && <p className="mt-1 line-clamp-1 text-[11px] text-tmi">{job.error.message}</p>}
                    </button>
                    <button type="button" onClick={() => void run(job)} disabled={busy} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-app-accent hover:bg-app-surface disabled:opacity-40" aria-label={isEn ? "Restart research" : "重新开始研究"} title={isEn ? "Restart research" : "重新开始研究"}><RefreshCw size={14} /></button>
                    <button type="button" onClick={() => setPendingDelete({ kind: "job", id: job.id, title: `${researchTargetsTitle(job.targets ?? [job.target], isEn)} · ${researchWorkflowTitle(job.workflowId, language)}` })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tmi hover:bg-[rgba(242,78,78,0.08)] hover:text-[#F24E4E]" aria-label={isEn ? "Delete task" : "删除任务"} title={isEn ? "Delete task" : "删除任务"}><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {showModePicker && (
        <ResearchSheet
          title={isEn ? "Choose a research mode" : "选择研究模式"}
          subtitle={isEn ? "Workflows aligned with AI Berkshire; AssetMate-only enhancements are labeled." : "研究框架与 AI Berkshire 对齐；插件独有增强单独标注。"}
          closeLabel={isEn ? "Close" : "关闭"}
          onClose={() => setShowModePicker(false)}
        >
          <WorkflowPicker workflowId={workflowId} targetCount={allTargets.length} isEn={isEn} onSelect={selectWorkflow} />
        </ResearchSheet>
      )}

      {showSettings && (
        <ResearchSheet
          title={isEn ? "Model plan" : "模型方案"}
          subtitle={isEn ? `For “${workflowConfig.titles.en}” only. Change a step only when it needs a different API.` : `仅作用于“${workflowConfig.titles.zh}”；需要时再为某个环节切换 API。`}
          closeLabel={isEn ? "Close" : "关闭"}
          onClose={() => setShowSettings(false)}
          footer={(
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">{notice ? <Feedback type={notice.type} message={notice.text} /> : <p className="text-[11px] text-tmi">{isEn ? "Changes save automatically." : "修改会自动保存。"}</p>}</div>
              <button type="button" onClick={openAISettings} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-card px-2.5 text-[11px] font-semibold text-ts hover:text-app-accent">
                <Settings2 size={12} />{isEn ? "API settings" : "API 管理"}
              </button>
            </div>
          )}
        >
          <div className="space-y-2.5">
            <ol className={`grid gap-1.5 ${workflowConfig.needsSynthesis ? "grid-cols-3" : "grid-cols-2"}`} aria-label={isEn ? "Call order" : "调用顺序"}>
              {[
                { key: "execute", icon: <Bot size={11} />, label: isEn ? "Execute" : "执行", name: executionProvider?.name || (isEn ? "Not configured" : "未配置"), model: activeProviderModelLabel || (isEn ? "No model" : "未选择模型"), className: "border-[rgba(79,156,249,0.22)] bg-[rgba(79,156,249,0.06)] text-app-accent" },
                ...(workflowConfig.needsSynthesis ? [{ key: "synth", icon: <FileCheck2 size={11} />, label: isEn ? "Synthesize" : "综合", name: synthesisProvider?.name || executionProvider?.name || (isEn ? "Follow execution" : "跟随执行"), model: synthesisModelLabel || activeProviderModelLabel || "-", className: "border-[rgba(139,92,246,0.2)] bg-[rgba(139,92,246,0.055)] text-[#8B5CF6]" }] : []),
                { key: "audit", icon: <Shield size={11} />, label: isEn ? "Audit" : "审计", name: auditProvider?.name || (isEn ? "Local checks" : "本地规则"), model: auditModelLabel || (isEn ? "No model call" : "不调用模型"), className: "border-[rgba(16,185,129,0.2)] bg-[rgba(16,185,129,0.055)] text-[#10B981]" },
              ].map((step, index) => (
                <li key={step.key} className={`min-w-0 rounded-lg border px-2 py-1.5 ${step.className}`}>
                  <p className="flex items-center gap-1 text-[10px] font-semibold">{step.icon}{index + 1}. {step.label}</p>
                  <p className="mt-0.5 truncate text-[11px] font-semibold text-tp">{step.name}</p>
                  <p className="truncate text-[10px] text-tm">{step.model}</p>
                </li>
              ))}
            </ol>

            <PlanRoleCard
              icon={<Bot size={14} />}
              accentClass="bg-[rgba(79,156,249,0.12)] text-app-accent"
              title={isEn ? "Research execution" : "研究执行"}
              hint={isEn ? "Writes the report. Deep tasks use the main model, light ones the fast model." : "生成正文；深度任务用主模型，轻量任务优先快速模型。"}
              activeAccentClass="bg-[rgba(79,156,249,0.08)] text-app-accent"
              active={<>{executionProvider?.name || "-"} · {activeProviderModelLabel || (isEn ? "Not configured" : "未配置")}{executionFallsBack && <span className="ml-1.5 rounded bg-[rgba(245,158,11,0.12)] px-1 text-[10px] text-[#D97706]">{isEn ? "main fallback" : "已回退主模型"}</span>}</>}
            >
              <div className="grid grid-cols-2 gap-2">
                <Field label={isEn ? "API" : "使用连接"}>
                  <SelectField ariaLabel={isEn ? "Execution API" : "执行 API"} value={selectedProviderRoute.executionProfileId ?? ""} onChange={(value) => void setWorkflowProvider("execution", value)}>
                    <option value="">{isEn ? "Follow default" : "跟随默认"} · {providerProfiles?.profiles.find((profile) => profile.id === providerProfiles.activeProfileId)?.name ?? "-"}</option>
                    {(providerProfiles?.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </SelectField>
                </Field>
                <Field label={isEn ? "Model" : "使用模型"}>
                  <SelectField ariaLabel={isEn ? "Execution model strategy" : "执行模型策略"} value={selectedProviderRoute.executionModelRole ?? "auto"} onChange={(value) => void setWorkflowExecutionModelRole(value)}>
                    <option value="auto">{isEn ? "Auto" : "自动（推荐）"} · {workflowConfig.useFullModel ? (isEn ? "main" : "主模型") : (isEn ? "fast" : "快速模型")}</option>
                    <option value="main">{isEn ? "Main model" : "主模型"} · {executionProvider?.model || (isEn ? "not set" : "未配置")}</option>
                    <option value="fast">{isEn ? "Fast model" : "快速模型"} · {executionProvider?.fastModel || (isEn ? "falls back to main" : "未配置，回退主模型")}</option>
                  </SelectField>
                </Field>
              </div>
            </PlanRoleCard>

            <PlanRoleCard
              icon={<Database size={14} />}
              accentClass="bg-[rgba(124,58,237,0.1)] text-[#7C3AED]"
              title={isEn ? "Professional evidence" : "专业数据证据"}
              badge={<span className="rounded bg-[rgba(124,58,237,0.09)] px-1 py-0.5 text-[9px] font-semibold text-[#7C3AED]">DATAPRO MCP</span>}
              hint={isEn ? "Reuses an Agent Plan key and only supplies structured evidence. Failures fall back without stopping." : "复用 Agent Plan Key，只提供结构化证据；失败会自动降级，不会中断研究。"}
              activeAccentClass="bg-[rgba(124,58,237,0.07)] text-[#7C3AED]"
              active={professionalDataProvider?.apiKey ? `${professionalDataProvider.name} · DataPro MCP` : (isEn ? "Unavailable · research falls back" : "不可用 · 研究将自动降级")}
            >
              <Field label={isEn ? "Agent Plan connection" : "使用 Agent Plan 连接"}>
                <SelectField ariaLabel={isEn ? "Professional data Agent Plan connection" : "专业数据 Agent Plan 连接"} value={selectedProviderRoute.professionalDataProfileId ?? ""} onChange={(value) => void setWorkflowProvider("professionalData", value)}>
                  <option value="">{isEn ? "Automatic · prefer execution or default Plan" : "自动（推荐）· 优先执行或默认 Plan"}</option>
                  {(providerProfiles?.profiles ?? [])
                    .filter((profile) => profile.preset === "volcengine_agent_plan")
                    .map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.apiKey ? (isEn ? "Key ready" : "Key 已就绪") : (isEn ? "No key" : "未配置 Key")}</option>)}
                </SelectField>
              </Field>
            </PlanRoleCard>

            {workflowConfig.needsSynthesis && (
              <PlanRoleCard
                icon={<FileCheck2 size={14} />}
                accentClass="bg-[rgba(139,92,246,0.1)] text-[#8B5CF6]"
                title={isEn ? "Final synthesis" : "终稿综合"}
                hint={isEn ? "Combines agent outputs into the final report." : "汇总多个研究 Agent，生成最终报告。"}
                activeAccentClass="bg-[rgba(139,92,246,0.07)] text-[#8B5CF6]"
                active={`${synthesisProvider?.name || executionProvider?.name || "-"} · ${synthesisModelLabel || activeProviderModelLabel || (isEn ? "Not configured" : "未配置")}`}
              >
                <Field label={isEn ? "Synthesis API" : "使用连接与综合模型"}>
                  <SelectField ariaLabel={isEn ? "Synthesis API" : "综合 API"} value={selectedProviderRoute.synthesisProfileId ?? ""} onChange={(value) => void setWorkflowProvider("synthesis", value)}>
                    <option value="">{isEn ? "Follow execution" : "跟随执行"} · {executionProvider?.name ?? "-"}</option>
                    {(providerProfiles?.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.synthesisModel || profile.model || (isEn ? "No model" : "未选模型")}</option>)}
                  </SelectField>
                </Field>
              </PlanRoleCard>
            )}

            <PlanRoleCard
              icon={<Shield size={14} />}
              accentClass="bg-[rgba(16,185,129,0.1)] text-[#10B981]"
              title={isEn ? "Independent audit" : "独立审计"}
              hint={isEn ? "Checks citations, calculations and consistency; never writes the report." : "复核引用、计算与一致性，不参与正文撰写。"}
              activeAccentClass="bg-[rgba(16,185,129,0.07)] text-[#10B981]"
              active={auditProvider ? `${auditProvider.name} · ${auditModelLabel}` : (isEn ? "Local rule checks · no model call" : "本地规则检查 · 不调用模型")}
            >
              <Field label={isEn ? "Audit API" : "审计方式"}>
                <SelectField ariaLabel={isEn ? "Audit API" : "审计 API"} value={selectedProviderRoute.auditDisabled ? "__off__" : selectedProviderRoute.auditProfileId ?? ""} onChange={(value) => void setWorkflowProvider("audit", value)}>
                  <option value="">{isEn ? "Follow execution" : "跟随执行"} · {executionProvider?.auditModel ? `${executionProvider.name} · ${executionProvider.auditModel}` : (isEn ? "local checks only" : "仅本地检查")}</option>
                  <option value="__off__">{isEn ? "Local checks only (no model call)" : "仅本地规则检查（不调用模型）"}</option>
                  {(providerProfiles?.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.auditModel || profile.model || (isEn ? "No model" : "未选模型")}</option>)}
                </SelectField>
              </Field>
            </PlanRoleCard>

            <div className="flex flex-wrap gap-1.5">
              <InfoChip icon={<Globe2 size={10} className="text-app-accent" />} tone={webWarn ? "warn" : "default"}>{webChip}</InfoChip>
              <InfoChip icon={<RefreshCw size={10} />}>{isEn ? "Resume with original setup" : "中断后沿用原配置"}</InfoChip>
            </div>
            {webWarn && <InlineNotice tone="warn">{webNote}</InlineNotice>}
          </div>
        </ResearchSheet>
      )}

      {deleteConfirmation}
    </div>
  );
}
