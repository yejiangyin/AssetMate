import {
  Check,
  ChevronDown,
  CopyPlus,
  Database,
  Eraser,
  Eye,
  EyeOff,
  Globe2,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  RESEARCH_PROVIDER_PRESET_MAP,
  RESEARCH_PROVIDER_PRESETS,
  type ResearchProviderGroup,
} from "../providerPresets";
import { OpenAICompatibleProvider, resolveResearchEndpoint } from "../providers/openAiCompatible";
import { getResearchThinkingControl, resolveEffectiveResearchThinkingLevel } from "../thinkingCapabilities";
import { getResearchWebSearchCapability } from "../webSearchCapabilities";
import {
  clearSavedResearchApiKey,
  createResearchProviderProfile,
  loadResearchProviderProfiles,
  saveResearchProviderProfiles,
  setSessionResearchApiKey,
  subscribeResearchStorageChanges,
} from "../storage";
import type {
  ResearchExternalSearchSettings,
  ResearchModelDefinition,
  ResearchProviderCollection,
  ResearchProviderPreset,
  ResearchProviderSettings,
} from "../types";
import { ExternalSearchSettingsCard } from "./ExternalSearchSettingsCard";

const CONTROL_CLASS = "min-h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[12px] leading-4 text-tp outline-none transition-colors placeholder:text-tmi focus:border-app-accent focus:ring-2 focus:ring-[rgba(79,156,249,0.12)]";
const LABEL_CLASS = "mb-1 block text-[11px] font-medium leading-4 text-tm";
const TOKEN_LIMIT_STEPS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000] as const;

function SelectField({
  value,
  onChange,
  children,
  ariaLabel,
  className = "",
  disabled = false,
}: {
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative min-w-0 ${className}`}>
      <select
        aria-label={ariaLabel}
        className={`${CONTROL_CLASS} appearance-none truncate pr-8 disabled:cursor-not-allowed disabled:opacity-60`}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        size={12}
        strokeWidth={1.8}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi"
      />
    </div>
  );
}

function cleanModels(models: ResearchModelDefinition[]) {
  const seen = new Set<string>();
  return models.flatMap((item) => {
    const id = item.id.trim();
    if (!id || seen.has(id.toLowerCase())) return [];
    seen.add(id.toLowerCase());
    return [{ ...item, id, name: item.name.trim() || id }];
  });
}

function modelLabel(model: ResearchModelDefinition) {
  return model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
}

function protocolLabel(protocol: ResearchProviderSettings["protocol"]) {
  return {
    chat_completions: "OpenAI Chat",
    responses: "Responses",
    anthropic_messages: "Anthropic Messages",
    gemini_native: "Gemini Native",
    ollama_chat: "Ollama Chat",
  }[protocol];
}

function tokenStepIndex(value: number) {
  return TOKEN_LIMIT_STEPS.reduce((closest, step, index) => (
    Math.abs(step - value) < Math.abs(TOKEN_LIMIT_STEPS[closest]! - value) ? index : closest
  ), 0);
}

function compactTokenLabel(value: number) {
  return `${value / 1000}K`;
}

function TokenLimitSlider({
  value,
  onChange,
  isEn,
}: {
  value: number;
  onChange: (value: number) => void;
  isEn: boolean;
}) {
  const index = tokenStepIndex(value);
  const progress = (index / (TOKEN_LIMIT_STEPS.length - 1)) * 100;
  const sliderRef = useRef<HTMLDivElement>(null);

  const selectIndex = (nextIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(TOKEN_LIMIT_STEPS.length - 1, nextIndex));
    onChange(TOKEN_LIMIT_STEPS[clampedIndex]!);
  };

  const selectPointerPosition = (clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect) return;
    const trackStart = rect.left + 8;
    const trackWidth = Math.max(1, rect.width - 16);
    selectIndex(Math.round(((clientX - trackStart) / trackWidth) * (TOKEN_LIMIT_STEPS.length - 1)));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    selectPointerPosition(event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons === 1 || event.currentTarget.hasPointerCapture(event.pointerId)) {
      selectPointerPosition(event.clientX);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") selectIndex(index - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") selectIndex(index + 1);
    else if (event.key === "Home") selectIndex(0);
    else if (event.key === "End") selectIndex(TOKEN_LIMIT_STEPS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="rounded-xl border border-app-border bg-app-surface px-3 pb-2.5 pt-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-tm">{isEn ? "Output token cap" : "输出 Token 上限"}</span>
        <output className="rounded-md bg-app-card px-2 py-1 text-[11px] font-semibold tabular-nums text-ts">
          {TOKEN_LIMIT_STEPS[index]!.toLocaleString("en-US")}
        </output>
      </div>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={isEn ? "Output token cap" : "输出 Token 上限"}
        aria-valuemin={TOKEN_LIMIT_STEPS[0]}
        aria-valuemax={TOKEN_LIMIT_STEPS[TOKEN_LIMIT_STEPS.length - 1]}
        aria-valuenow={TOKEN_LIMIT_STEPS[index]}
        aria-valuetext={TOKEN_LIMIT_STEPS[index]!.toLocaleString("en-US")}
        className="group relative h-5 cursor-pointer touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[rgba(79,156,249,0.22)]"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
      >
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-app-control">
          <div className="h-full rounded-full bg-app-accent" style={{ width: `${progress}%` }} />
          <div
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-app-accent shadow-sm"
            style={{ left: `${progress}%` }}
          />
        </div>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-0.5">
        {TOKEN_LIMIT_STEPS.map((step, stepIndex) => (
          <button
            key={step}
            type="button"
            onClick={() => onChange(step)}
            className={`min-w-0 flex-1 text-center text-[11px] leading-3 tabular-nums transition-colors ${stepIndex === index ? "font-semibold text-app-accent" : "text-tmi"}`}
            aria-label={`${isEn ? "Set output token cap to" : "设置输出 Token 上限为"} ${step}`}
          >
            {compactTokenLabel(step)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] leading-3 text-tmi">
        {isEn ? "Actual output is still capped by the selected model/provider." : "实际可输出长度仍受所选模型与服务商硬上限约束。"}
      </p>
    </div>
  );
}

export function ProviderSettingsCard({
  language,
  compact = false,
  includeExternalSearch = true,
  defaultExpanded = true,
  onSaved,
  onExternalSearchSaved,
  onOpenWebSearch,
}: {
  language: "zh" | "en";
  compact?: boolean;
  includeExternalSearch?: boolean;
  defaultExpanded?: boolean;
  onSaved?: (settings: ResearchProviderSettings) => void;
  onExternalSearchSaved?: (settings: ResearchExternalSearchSettings) => void;
  onOpenWebSearch?: () => void;
}) {
  const isEn = language === "en";
  const [collection, setCollection] = useState<ResearchProviderCollection | null>(null);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);
  const hasUnsavedChangesRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadResearchProviderProfiles().then((value) => {
      if (!cancelled) {
        hasUnsavedChangesRef.current = false;
        setCollection(value);
        setExpandedProfileId(defaultExpanded ? value.activeProfileId : null);
      }
    });
    return () => { cancelled = true; };
  }, [defaultExpanded]);

  useEffect(() => subscribeResearchStorageChanges(() => {
    if (hasUnsavedChangesRef.current) return;
    void loadResearchProviderProfiles().then((value) => {
      if (!hasUnsavedChangesRef.current) setCollection(value);
    });
  }), []);

  const settings = useMemo(() => {
    if (!collection) return null;
    const editingProfileId = expandedProfileId ?? collection.activeProfileId;
    return collection.profiles.find((profile) => profile.id === editingProfileId) ?? collection.profiles[0] ?? null;
  }, [collection, expandedProfileId]);

  const updateProfile = (changes: Partial<ResearchProviderSettings>) => {
    if (!settings) return;
    hasUnsavedChangesRef.current = true;
    const invalidatesWebVerification = (
      (changes.model !== undefined && changes.model !== settings.model)
      || (changes.protocol !== undefined && changes.protocol !== settings.protocol)
      || (changes.preset !== undefined && changes.preset !== settings.preset)
    );
    const nextChanges = invalidatesWebVerification
      ? { ...changes, nativeWebSearchVerification: undefined }
      : changes;
    setCollection((current) => current ? {
      ...current,
      profiles: current.profiles.map((profile) => profile.id === settings.id ? { ...profile, ...nextChanges } : profile),
    } : current);
    if (typeof changes.apiKey === "string") setSessionResearchApiKey(changes.apiKey, settings.id);
    setMessage("");
  };

  const update = <K extends keyof ResearchProviderSettings>(key: K, value: ResearchProviderSettings[K]) => {
    updateProfile({ [key]: value } as Pick<ResearchProviderSettings, K>);
  };

  const applyPreset = (preset: ResearchProviderPreset) => {
    if (!settings) return;
    const currentPreset = RESEARCH_PROVIDER_PRESET_MAP[settings.preset];
    const nextPreset = RESEARCH_PROVIDER_PRESET_MAP[preset];
    const hasDefaultName = !settings.name.trim()
      || settings.name === currentPreset.defaultName
      || settings.name === currentPreset.defaultNameEn
      || (settings.preset === "openai" && settings.name === "OpenAI Compatible");
    const changes: Partial<ResearchProviderSettings> = {
      preset,
      name: hasDefaultName ? (isEn ? nextPreset.defaultNameEn : nextPreset.defaultName) : settings.name,
      endpoint: nextPreset.endpoint,
      protocol: nextPreset.protocol,
      authMode: nextPreset.authMode,
      authHeaderName: nextPreset.authHeaderName ?? "Authorization",
      authHeaderPrefix: nextPreset.authHeaderPrefix ?? "Bearer ",
      thinkingLevel: "auto",
    };
    updateProfile(changes);
  };

  const prepareCollection = (value: ResearchProviderCollection) => {
    const profiles = value.profiles.map((profile) => {
      const models = cleanModels(profile.models);
      const model = models.some((item) => item.id === profile.model) ? profile.model : models[0]?.id ?? "";
      const fastModel = models.some((item) => item.id === profile.fastModel) ? profile.fastModel : "";
      const synthesisModel = models.some((item) => item.id === profile.synthesisModel) ? profile.synthesisModel : "";
      const auditModel = models.some((item) => item.id === profile.auditModel) ? profile.auditModel : "";
      return { ...profile, models, model, fastModel, synthesisModel, auditModel };
    });
    return { ...value, profiles };
  };

  const saveCollection = async (nextCollection = collection) => {
    if (!nextCollection) return;
    const prepared = prepareCollection(nextCollection);
    setSaving(true);
    try {
      await saveResearchProviderProfiles(prepared);
      hasUnsavedChangesRef.current = false;
      setCollection(prepared);
      const active = prepared.profiles.find((profile) => profile.id === prepared.activeProfileId) ?? prepared.profiles[0]!;
      setMessageType("success");
      setMessage(isEn ? "API connections saved" : "API 连接已保存");
      onSaved?.(active);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : isEn ? "Save failed" : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleProfile = (profileId: string) => {
    setExpandedProfileId((current) => current === profileId ? null : profileId);
    setShowKey(false);
    setMessage("");
  };

  const activate = async (profileId: string) => {
    if (!collection) return;
    if (collection.activeProfileId === profileId) return;
    hasUnsavedChangesRef.current = true;
    const next = { ...collection, activeProfileId: profileId };
    setCollection(next);
    setExpandedProfileId(profileId);
    setShowKey(false);
    setMessage("");
    await saveResearchProviderProfiles(next);
    hasUnsavedChangesRef.current = false;
    const active = next.profiles.find((profile) => profile.id === profileId);
    if (active) {
      setMessageType("success");
      setMessage(isEn ? `${active.name} is now the default connection` : `已将“${active.name}”设为默认连接`);
      onSaved?.(active);
    }
  };

  const addProfile = () => {
    if (!collection) return;
    hasUnsavedChangesRef.current = true;
    const profile = createResearchProviderProfile({
      name: isEn ? `API ${collection.profiles.length + 1}` : `API 连接 ${collection.profiles.length + 1}`,
      endpoint: "",
      preset: "custom",
      protocol: "chat_completions",
      authMode: "bearer",
    });
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    setExpandedProfileId(profile.id);
    setMessage("");
  };

  const duplicateProfile = () => {
    if (!collection || !settings) return;
    hasUnsavedChangesRef.current = true;
    const profile = createResearchProviderProfile({
      ...settings,
      id: undefined,
      name: `${settings.name} ${isEn ? "Copy" : "副本"}`,
      apiKey: "",
      saveApiKey: false,
    });
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    setExpandedProfileId(profile.id);
  };

  const deleteProfile = async () => {
    if (!collection || !settings) return;
    hasUnsavedChangesRef.current = true;
    const remaining = collection.profiles.filter((profile) => profile.id !== settings.id);
    const profiles = remaining.length ? remaining : [createResearchProviderProfile()];
    const activeProfileId = profiles.some((profile) => profile.id === collection.activeProfileId)
      ? collection.activeProfileId
      : profiles[0]!.id;
    const next = { ...collection, activeProfileId, profiles };
    setCollection(next);
    setExpandedProfileId(null);
    setConfirmDeleteProfileId(null);
    await saveResearchProviderProfiles(next);
    hasUnsavedChangesRef.current = false;
    onSaved?.(profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]!);
  };

  const addModel = () => {
    if (!settings) return;
    update("models", [...settings.models, { id: "", name: "" }]);
  };

  const updateModel = (index: number, changes: Partial<ResearchModelDefinition>) => {
    if (!settings) return;
    const previous = settings.models[index];
    if (!previous) return;
    const models = settings.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...changes } : model);
    const nextId = typeof changes.id === "string" ? changes.id : previous.id;
    updateProfile({
      models,
      model: settings.model === previous.id ? nextId : settings.model,
      fastModel: previous.id && settings.fastModel === previous.id ? nextId : settings.fastModel,
      synthesisModel: previous.id && settings.synthesisModel === previous.id ? nextId : settings.synthesisModel,
      auditModel: previous.id && settings.auditModel === previous.id ? nextId : settings.auditModel,
    });
  };

  const removeModel = (index: number) => {
    if (!settings) return;
    const removed = settings.models[index];
    const models = settings.models.filter((_, modelIndex) => modelIndex !== index);
    updateProfile({
      models,
      model: removed && settings.model === removed.id ? models.find((item) => item.id.trim())?.id ?? "" : settings.model,
      fastModel: removed && settings.fastModel === removed.id ? "" : settings.fastModel,
      synthesisModel: removed && settings.synthesisModel === removed.id ? "" : settings.synthesisModel,
      auditModel: removed && settings.auditModel === removed.id ? "" : settings.auditModel,
    });
  };

  const fetchModels = async () => {
    if (!settings) return;
    setLoadingModels(true);
    setMessage("");
    try {
      setSessionResearchApiKey(settings.apiKey, settings.id);
      const discovered = await new OpenAICompatibleProvider(settings).listModels();
      const existing = cleanModels(settings.models);
      const known = new Set(existing.map((model) => model.id.toLowerCase()));
      const models = [...existing, ...discovered.filter((model) => !known.has(model.id.toLowerCase()))];
      updateProfile({ models, model: settings.model || models[0]?.id || "" });
      setMessageType("success");
      setMessage(isEn ? `Loaded ${discovered.length} model(s)` : `已获取 ${discovered.length} 个模型`);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : isEn ? "Unable to load models" : "获取模型列表失败");
    } finally {
      setLoadingModels(false);
    }
  };

  const test = async () => {
    if (!settings) return;
    setTesting(true);
    setMessage("");
    try {
      setSessionResearchApiKey(settings.apiKey, settings.id);
      const provider = new OpenAICompatibleProvider(settings);
      const roles = [
        { label: isEn ? "Research" : "研究", model: settings.model },
        { label: isEn ? "Fast" : "快速", model: settings.fastModel },
        { label: isEn ? "Synthesis" : "综合", model: settings.synthesisModel },
        { label: isEn ? "Audit" : "审计", model: settings.auditModel },
      ].filter((item) => item.model);
      const unique = roles.filter((item, index) => roles.findIndex((candidate) => candidate.model === item.model) === index);
      if (!unique.length) throw new Error(isEn ? "Select a research model first" : "请先选择研究模型");
      for (const role of unique) {
        try {
          await provider.testConnection(undefined, role.model);
        } catch (error) {
          const detail = error instanceof Error ? error.message : isEn ? "Connection failed" : "连接失败";
          throw new Error(`${role.label} · ${role.model}: ${detail}`);
        }
      }
      setMessageType("success");
      setMessage(isEn
        ? `Validated ${unique.length} configured role model(s): ${unique.map((item) => item.model).join(", ")}`
        : `已验证 ${unique.length} 个职责模型：${unique.map((item) => item.model).join("、")}`);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : isEn ? "Connection failed" : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  const testWebSearch = async () => {
    if (!settings || !collection) return;
    setTestingWebSearch(true);
    setMessage("");
    try {
      setSessionResearchApiKey(settings.apiKey, settings.id);
      const result = await new OpenAICompatibleProvider(settings).testWebSearch();
      const verification: NonNullable<ResearchProviderSettings["nativeWebSearchVerification"]> = {
        model: settings.model,
        protocol: settings.protocol,
        status: "verified",
        checkedAt: new Date().toISOString(),
        message: result.message,
      };
      const next = {
        ...collection,
        profiles: collection.profiles.map((profile) => profile.id === settings.id
          ? { ...profile, nativeWebSearchVerification: verification }
          : profile),
      };
      setCollection(next);
      await saveResearchProviderProfiles(next);
      hasUnsavedChangesRef.current = false;
      setMessageType("success");
      setMessage(isEn ? `Web search verified: ${result.sources.length} structured source(s)` : result.message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : isEn ? "Web search test failed" : "联网测试失败";
      const verification: NonNullable<ResearchProviderSettings["nativeWebSearchVerification"]> = {
        model: settings.model,
        protocol: settings.protocol,
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: errorMessage,
      };
      const next = {
        ...collection,
        profiles: collection.profiles.map((profile) => profile.id === settings.id
          ? { ...profile, nativeWebSearchVerification: verification }
          : profile),
      };
      setCollection(next);
      await saveResearchProviderProfiles(next);
      hasUnsavedChangesRef.current = false;
      setMessageType("error");
      setMessage(errorMessage);
    } finally {
      setTestingWebSearch(false);
    }
  };

  const clearKey = async () => {
    if (!settings) return;
    hasUnsavedChangesRef.current = true;
    await clearSavedResearchApiKey(settings.id);
    updateProfile({ apiKey: "", saveApiKey: false });
    setMessageType("success");
    setMessage(isEn ? "Key cleared for this connection" : "已清除当前连接的 API Key");
  };

  const resolvedEndpoint = (() => {
    if (!settings?.endpoint) return "";
    try { return resolveResearchEndpoint(settings.endpoint, settings.protocol, "{model}", false, settings.preset); } catch { return ""; }
  })();

  if (!collection || !settings) {
    return <div className="flex items-center justify-center py-8 text-tm"><Loader2 size={16} className="animate-spin" /></div>;
  }

  const selectedPreset = RESEARCH_PROVIDER_PRESET_MAP[settings.preset];
  const thinkingControl = getResearchThinkingControl(settings);
  const displayedThinkingLevel = resolveEffectiveResearchThinkingLevel(settings.thinkingLevel, thinkingControl);
  const thinkingFallbackActive = settings.thinkingLevel !== "auto" && displayedThinkingLevel !== settings.thinkingLevel;
  const requestedThinkingLabel = isEn
    ? settings.thinkingLevel
    : ({
      off: "关闭",
      enabled: "开启",
      minimal: "最小",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "超高",
      max: "最大",
      auto: "自动",
    } satisfies Record<ResearchProviderSettings["thinkingLevel"], string>)[settings.thinkingLevel];
  const effectiveThinkingLabel = thinkingControl.options.find((option) => option.value === displayedThinkingLevel);
  const webSearchCapability = getResearchWebSearchCapability(settings);
  const supportsNativeWebSearch = webSearchCapability.supported;
  const nativeWebVerification = settings.nativeWebSearchVerification?.model === settings.model
    && settings.nativeWebSearchVerification.protocol === settings.protocol
    ? settings.nativeWebSearchVerification
    : undefined;
  const nativeWebStatus = !supportsNativeWebSearch
    ? "fallback"
    : nativeWebVerification?.status === "verified"
      ? "verified"
      : nativeWebVerification?.status === "failed"
        ? "failed"
        : "available";
  const groups: Array<{ id: ResearchProviderGroup; label: string }> = [
    { id: "domestic", label: isEn ? "China providers" : "国内服务商" },
    { id: "international", label: isEn ? "Global providers" : "国际服务商" },
    { id: "local", label: isEn ? "Local models" : "本地模型" },
    { id: "custom", label: isEn ? "Custom" : "自定义" },
  ];

  return (
    <div className={compact ? "" : "rounded-xl border border-app-border bg-app-card p-3"}>
      {!compact && (
        <div className="mb-3 flex items-start gap-2">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[rgba(79,156,249,0.1)] text-app-accent">
            <PlugZap size={14} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-tp">{isEn ? "AI API connections" : "AI API 连接"}</p>
            <p className="mt-0.5 text-[12px] leading-4 text-tmi">{isEn ? "Manage providers and models stored locally in this browser." : "统一管理保存在本地浏览器中的服务商、Key 与模型。"}</p>
          </div>
        </div>
      )}

      <section aria-label={isEn ? "API connection list" : "API 连接列表"}>
        <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-ts">{isEn ? "API connection list" : "API 连接列表"}</p>
            <p className="mt-0.5 text-[11px] leading-3 text-tmi">{collection.profiles.length} {isEn ? "connection(s) · expand to edit, or set one as the default" : "个连接 · 展开编辑，或将某个连接设为默认"}</p>
          </div>
          <button type="button" onClick={addProfile} className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-app-accent px-2.5 text-[12px] font-semibold text-white" aria-label={isEn ? "Add connection" : "新增连接"}><Plus size={12} />{isEn ? "Add" : "新增连接"}</button>
        </div>

        <div className="space-y-2">
          {collection.profiles.map((profile) => {
            const preset = RESEARCH_PROVIDER_PRESET_MAP[profile.preset];
            const expanded = expandedProfileId === profile.id;
            const active = collection.activeProfileId === profile.id;
            return (
              <article key={profile.id} className={`overflow-hidden rounded-xl border transition-colors ${active ? "border-app-accent/30 bg-[rgba(79,156,249,0.04)]" : "border-app-border bg-app-surface"}`}>
                <div className="flex items-stretch">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`provider-editor-${profile.id}`}
                    onClick={() => toggleProfile(profile.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left"
                  >
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-[rgba(79,156,249,0.12)] text-app-accent" : "bg-app-card text-tm"}`}>
                      <PlugZap size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[12px] font-semibold text-tp">{profile.name || preset.defaultName}</span>
                        {active && <span className="shrink-0 rounded-full bg-[rgba(79,156,249,0.12)] px-1.5 py-0.5 text-[11px] font-medium text-app-accent">{isEn ? "Default" : "默认连接"}</span>}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] leading-3 text-tmi">{isEn ? preset.labelEn : preset.label} · {protocolLabel(profile.protocol)} · {cleanModels(profile.models).length} {isEn ? "models" : "个模型"}{profile.model ? ` · ${profile.model}` : ""}</p>
                    </div>
                    <ChevronDown size={14} className={`shrink-0 text-tmi transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  {!active && (
                    <button type="button" onClick={() => void activate(profile.id)} className="my-2 mr-2 shrink-0 rounded-lg border border-app-accent/25 bg-[rgba(79,156,249,0.08)] px-2 text-[11px] font-semibold text-app-accent" aria-label={isEn ? `Set ${profile.name} as default` : `将${profile.name}设为默认连接`}>
                      {isEn ? "Set default" : "设为默认"}
                    </button>
                  )}
                </div>

                {expanded && profile.id === settings.id && (
                  <div id={`provider-editor-${profile.id}`} className="border-t border-app-border bg-app-card px-2.5 pb-2.5 pt-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-tm">{isEn ? "Connection details" : "连接详情"}</p>
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={duplicateProfile} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-tm" aria-label={isEn ? "Duplicate connection" : "复制连接"}><CopyPlus size={11} />{isEn ? "Duplicate" : "复制"}</button>
                        <button type="button" onClick={() => void clearKey()} disabled={!settings.apiKey} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-tm disabled:opacity-40" aria-label={isEn ? "Clear current key" : "清除当前 Key"}><Eraser size={11} />{isEn ? "Clear key" : "清除 Key"}</button>
                        <button type="button" onClick={() => setConfirmDeleteProfileId(settings.id)} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-[#F24E4E]" aria-label={isEn ? "Delete connection" : "删除连接"}><Trash2 size={11} />{isEn ? "Delete" : "删除"}</button>
                      </div>
                    </div>
                    {confirmDeleteProfileId === settings.id && (
                      <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#F24E4E]/20 bg-[rgba(242,78,78,0.07)] px-2.5 py-2">
                        <p className="min-w-0 flex-1 text-[11px] leading-4 text-[#D94A4A]">{isEn ? `Delete “${settings.name}”? This does not affect other connections.` : `确认删除“${settings.name}”？其他连接不会受影响。`}</p>
                        <button type="button" onClick={() => setConfirmDeleteProfileId(null)} className="rounded-lg px-2 py-1 text-[11px] text-tm">{isEn ? "Cancel" : "取消"}</button>
                        <button type="button" onClick={() => void deleteProfile()} className="rounded-lg bg-[#F24E4E] px-2 py-1 text-[11px] font-semibold text-white">{isEn ? "Delete" : "确认删除"}</button>
                      </div>
                    )}

                    <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Connection name" : "连接名称"}</span><input aria-label={isEn ? "Connection name" : "连接名称"} className={CONTROL_CLASS} value={settings.name} onChange={(event) => update("name", event.target.value)} /></label>
          <label className="min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "Provider preset" : "服务商预设"}</span>
            <SelectField ariaLabel={isEn ? "Provider preset" : "服务商预设"} value={settings.preset} onChange={(value) => applyPreset(value as ResearchProviderPreset)}>
              {groups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {RESEARCH_PROVIDER_PRESETS.filter((preset) => preset.group === group.id).map((preset) => (
                    <option key={preset.id} value={preset.id}>{isEn ? preset.labelEn : preset.label}</option>
                  ))}
                </optgroup>
              ))}
            </SelectField>
          </label>
        </div>

        <label className="block">
          <span className={LABEL_CLASS}>{isEn ? "Base URL or full endpoint" : "Base URL 或完整请求地址"}</span>
          <input aria-label={isEn ? "Base URL or full endpoint" : "Base URL 或完整请求地址"} className={CONTROL_CLASS} value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://.../v1" />
          {resolvedEndpoint && <span className="mt-1 block break-all px-0.5 text-[11px] leading-3 text-tmi">{isEn ? "Actual request" : "实际请求"}: {resolvedEndpoint}</span>}
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "API protocol" : "API 协议"}</span>
            <SelectField ariaLabel={isEn ? "API protocol" : "API 协议"} value={settings.protocol} onChange={(value) => {
              const protocol = value as ResearchProviderSettings["protocol"];
              updateProfile({ protocol });
            }}>
              <option value="responses">Responses API</option>
              <option value="chat_completions">OpenAI Chat Completions</option>
              <option value="anthropic_messages">Anthropic Messages</option>
              <option value="gemini_native">Gemini GenerateContent</option>
              <option value="ollama_chat">Ollama Chat</option>
            </SelectField>
          </label>
          <label className="min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "Authentication" : "鉴权方式"}</span>
            <SelectField ariaLabel={isEn ? "Authentication" : "鉴权方式"} value={settings.authMode} onChange={(value) => update("authMode", value as ResearchProviderSettings["authMode"])}>
              <option value="bearer">Authorization: Bearer</option>
              <option value="x_api_key">x-api-key (Anthropic)</option>
              <option value="x_google_api_key">x-goog-api-key (Gemini)</option>
              <option value="custom_header">{isEn ? "Custom header" : "自定义 Header"}</option>
              <option value="none">{isEn ? "No authentication" : "无需鉴权"}</option>
            </SelectField>
          </label>
        </div>

        {settings.authMode !== "none" && (
          <label className="block min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "API Key / token" : "API Key / Token"}</span>
            <div className="relative">
              <input aria-label="API Key / Token" className={`${CONTROL_CLASS} pr-9`} type={showKey ? "text" : "password"} value={settings.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="off" spellCheck={false} />
              <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </label>
        )}

        {settings.authMode === "custom_header" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Header name" : "Header 名称"}</span><input aria-label={isEn ? "Header name" : "Header 名称"} className={CONTROL_CLASS} value={settings.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder="Authorization" /></label>
            <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Value prefix (optional)" : "值前缀（可选）"}</span><input aria-label={isEn ? "Value prefix" : "值前缀"} className={CONTROL_CLASS} value={settings.authHeaderPrefix} onChange={(event) => update("authHeaderPrefix", event.target.value)} placeholder="Bearer " /></label>
          </div>
        )}

        {selectedPreset.note && (
          <div className="rounded-lg bg-[rgba(79,156,249,0.08)] px-2.5 py-2 text-[12px] leading-4 text-tm">
            {isEn ? selectedPreset.noteEn : selectedPreset.note}
          </div>
        )}

        <section className="rounded-xl border border-app-border bg-app-surface p-2.5" aria-label={isEn ? "Model library" : "模型库"}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Database size={13} className="shrink-0 text-app-accent" />
              <span className="text-[11px] font-semibold text-ts">{isEn ? "Model library" : "模型库"}</span>
              <span className="rounded-full bg-app-card px-1.5 py-0.5 text-[11px] text-tmi">{cleanModels(settings.models).length}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => void fetchModels()} disabled={loadingModels} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-card px-2 text-[12px] font-medium text-tm disabled:opacity-60">
                {loadingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {isEn ? "Fetch" : "获取模型"}
              </button>
              <button type="button" onClick={addModel} className="flex h-7 items-center gap-1 rounded-lg bg-app-accent px-2 text-[12px] font-medium text-white"><Plus size={11} />{isEn ? "Add" : "添加"}</button>
            </div>
          </div>

          {settings.models.length ? (
            <div className="space-y-1.5">
              {settings.models.map((model, index) => (
                <div key={`${settings.id}-model-${index}`} className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_30px] gap-1.5">
                  <input aria-label={`${isEn ? "Model ID" : "模型 ID"} ${index + 1}`} className={`${CONTROL_CLASS} min-h-8 py-1.5`} value={model.id} onChange={(event) => updateModel(index, { id: event.target.value, name: model.name === model.id ? event.target.value : model.name })} placeholder={isEn ? "Model / Endpoint ID" : "模型 / Endpoint ID"} />
                  <input aria-label={`${isEn ? "Display name" : "显示名称"} ${index + 1}`} className={`${CONTROL_CLASS} min-h-8 py-1.5`} value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder={isEn ? "Name (optional)" : "名称（可选）"} />
                  <button type="button" onClick={() => removeModel(index)} className="flex h-8 w-[30px] items-center justify-center rounded-lg border border-app-border bg-app-card text-tmi hover:text-[#F24E4E]" aria-label={isEn ? `Remove model ${index + 1}` : `删除第 ${index + 1} 个模型`}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          ) : (
            <button type="button" onClick={addModel} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-app-border bg-app-card px-3 py-3 text-[12px] leading-4 text-tmi">
              <Plus size={11} />{isEn ? "Add a model ID manually, or fetch the provider model list" : "手动添加模型 ID，或从服务商获取模型列表"}
            </button>
          )}

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="min-w-0">
              <span className={LABEL_CLASS}>{isEn ? "Research model" : "研究模型"}</span>
              <SelectField ariaLabel={isEn ? "Research model" : "研究模型"} value={settings.model} disabled={!cleanModels(settings.models).length} onChange={(value) => update("model", value)}>
                <option value="">{isEn ? "Select a model" : "请选择模型"}</option>
                {cleanModels(settings.models).map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </label>
            <label className="min-w-0">
              <span className={LABEL_CLASS}>{isEn ? "Fast model (optional)" : "快速模型（可选）"}</span>
              <SelectField ariaLabel={isEn ? "Fast model" : "快速模型"} value={settings.fastModel} disabled={!cleanModels(settings.models).length} onChange={(value) => update("fastModel", value)}>
                <option value="">{isEn ? "Use research model" : "使用研究模型"}</option>
                {cleanModels(settings.models).map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </label>
            <label className="min-w-0">
              <span className={LABEL_CLASS}>{isEn ? "Synthesis model (optional)" : "综合模型（可选）"}</span>
              <SelectField ariaLabel={isEn ? "Synthesis model" : "综合模型"} value={settings.synthesisModel} disabled={!cleanModels(settings.models).length} onChange={(value) => update("synthesisModel", value)}>
                <option value="">{isEn ? "Use research model" : "使用研究模型"}</option>
                {cleanModels(settings.models).map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </label>
            <label className="min-w-0">
              <span className={LABEL_CLASS}>{isEn ? "Audit model (optional)" : "审计模型（可选）"}</span>
              <SelectField ariaLabel={isEn ? "Audit model" : "审计模型"} value={settings.auditModel} disabled={!cleanModels(settings.models).length} onChange={(value) => update("auditModel", value)}>
                <option value="">{isEn ? "Local checks only" : "仅本地规则检查"}</option>
                {cleanModels(settings.models).map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </label>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-tmi">
            {isEn
              ? "Research handles deep analysis; Fast handles light workflows; Synthesis merges agent reports; Audit independently reviews the final output. Empty optional roles fall back to Research."
              : "研究模型负责深度分析；快速模型负责轻量任务；综合模型合并多角色报告；审计模型独立复核终稿。可选职责留空时回退到研究模型。"}
          </p>
          {settings.auditModel && [settings.model, settings.synthesisModel || settings.model].includes(settings.auditModel) && (
            <p className="mt-1 text-[11px] leading-4 text-[#F59E0B]">
              {isEn ? "The audit role reuses a writing model, so the review is not fully independent." : "审计模型与写作模型相同，复核可用但独立性较弱；建议选择不同模型。"}
            </p>
          )}
        </section>

        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "Thinking depth" : "思考深度"}</span>
            <SelectField ariaLabel={isEn ? "Thinking depth" : "思考深度"} value={displayedThinkingLevel} onChange={(value) => update("thinkingLevel", value as ResearchProviderSettings["thinkingLevel"])}>
              {thinkingControl.options.map((option) => (
                <option key={option.value} value={option.value}>{isEn ? option.labelEn : option.label}</option>
              ))}
            </SelectField>
            <span className="mt-1 block text-[11px] leading-3 text-tmi">{isEn ? thinkingControl.noteEn : thinkingControl.note}</span>
            {thinkingFallbackActive && (
              <span className="mt-1 block text-[11px] leading-3 text-[#F59E0B]">
                {isEn
                  ? `Requested ${requestedThinkingLabel}; this model will use ${effectiveThinkingLabel?.labelEn ?? displayedThinkingLevel}.`
                  : `已选择${requestedThinkingLabel}；当前模型不支持时将自动使用${effectiveThinkingLabel?.label ?? displayedThinkingLevel}。`}
              </span>
            )}
          </label>
          <label className="min-w-0">
            <span className={LABEL_CLASS}>{isEn ? "Concurrency" : "并发数"}</span>
            <SelectField ariaLabel={isEn ? "Concurrency" : "并发数"} value={settings.maxConcurrency} onChange={(value) => update("maxConcurrency", Number(value) as 1 | 2 | 3 | 4)}>
              {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
            </SelectField>
          </label>
        </div>

        <TokenLimitSlider value={settings.maxOutputTokens} onChange={(value) => update("maxOutputTokens", value)} isEn={isEn} />

        <div className="space-y-2 rounded-xl bg-app-surface px-2.5 py-2.5">
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${nativeWebStatus === "verified" ? "bg-[rgba(49,208,139,0.1)] text-[#31D08B]" : nativeWebStatus === "failed" ? "bg-[rgba(245,158,11,0.1)] text-[#F59E0B]" : "bg-[rgba(79,156,249,0.1)] text-app-accent"}`}>
              <Globe2 size={13} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-ts">{isEn ? "Automatic web access" : "自动联网"}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${nativeWebStatus === "verified" ? "bg-[rgba(49,208,139,0.1)] text-[#20A971]" : nativeWebStatus === "failed" ? "bg-[rgba(245,158,11,0.1)] text-[#D97706]" : "bg-[rgba(79,156,249,0.1)] text-app-accent"}`}>
                  {nativeWebStatus === "verified"
                    ? (isEn ? "VERIFIED" : "已验证")
                    : nativeWebStatus === "failed"
                      ? (isEn ? "RETRY" : "可重试")
                      : nativeWebStatus === "available"
                        ? (isEn ? "AUTO" : "自动启用")
                        : (isEn ? "FALLBACK" : "自动回退")}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-tmi">
                {nativeWebStatus === "verified"
                  ? (isEn ? "Native browsing was verified and can be tested again at any time. Research enables it automatically; external search remains optional fallback evidence." : "当前模型已验证可原生联网，可随时重复检测；研究时会自动启用，外部搜索仅作为可选证据增强和兜底。")
                  : nativeWebStatus === "failed"
                    ? (isEn ? webSearchCapability.reasonEn : webSearchCapability.reasonZh)
                    : supportsNativeWebSearch
                      ? (isEn ? "Native browsing is enabled automatically. The repeatable diagnostic below only verifies actual search events and citations." : "原生联网已自动启用；下方检测不是开关，可反复运行，仅用于确认服务商是否实际返回搜索事件和引用。")
                      : `${isEn ? webSearchCapability.reasonEn : webSearchCapability.reasonZh} ${isEn ? "Research will fall back to configured external search or prefetched market data without blocking." : "研究会自动回退到已配置的外部搜索或插件预取行情，不会因此中断。"}`}
              </p>
            </div>
          </div>
          {settings.authMode !== "none" && <label className="flex min-h-5 cursor-pointer items-center justify-between gap-3 text-[11px] text-ts"><span>{isEn ? "Save this API Key on device" : "在此设备保存当前 API Key"}</span><input type="checkbox" checked={settings.saveApiKey} onChange={(event) => update("saveApiKey", event.target.checked)} /></label>}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void test()} disabled={testing} className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-ts disabled:opacity-60">{testing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}{isEn ? "Test role models" : "测试职责模型"}</button>
          {supportsNativeWebSearch ? (
            <button type="button" onClick={() => void testWebSearch()} disabled={testingWebSearch} className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-ts disabled:opacity-45">{testingWebSearch ? <Loader2 size={12} className="animate-spin" /> : <Globe2 size={12} />}{isEn ? "Test native web" : "检测原生联网"}</button>
          ) : (
            <button type="button" onClick={onOpenWebSearch} disabled={!onOpenWebSearch} className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-ts disabled:opacity-45"><Globe2 size={12} />{isEn ? "Open web-search test" : "前往联网测试"}</button>
          )}
          <button type="button" onClick={() => void saveCollection()} disabled={saving} className="col-span-2 flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg bg-app-accent px-2 text-[11px] font-semibold text-white disabled:opacity-60">{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}</button>
        </div>
                    </div>

                    <div className="mt-3 flex items-start gap-2 rounded-lg bg-[rgba(245,158,11,0.08)] px-2.5 py-2 text-[12px] leading-4 text-tm"><ShieldAlert size={12} className="mt-0.5 shrink-0 text-[#F59E0B]" /><span>{isEn ? "Each connection keeps its own key. Keys are excluded from exports; session-only mode remains recommended." : "每个连接独立保存 Key，且 Key 不会进入持仓导出。仍建议优先使用仅会话保存。"}</span></div>
                    {message && <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4" style={{ color: messageType === "success" ? "#31D08B" : "#F24E4E" }}>{messageType === "success" && <Check size={11} className="mt-0.5 shrink-0" />}<span>{message}</span></div>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
      {includeExternalSearch && <ExternalSearchSettingsCard language={language} onSaved={onExternalSearchSaved} />}
    </div>
  );
}
