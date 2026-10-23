import {
  ChevronRight,
  CopyPlus,
  Eraser,
  Eye,
  EyeOff,
  Globe2,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  RESEARCH_PROVIDER_PRESET_MAP,
  RESEARCH_PROVIDER_PRESETS,
  type ResearchProviderGroup,
  type ResearchProviderPresetDefinition,
} from "../providerPresets";
import {
  CODEX_DEFAULT_MODELS,
  consumeCodexCallback,
  serializeCodexCredentials,
  subscribeCodexCallback,
  type CodexCredentials,
} from "../providers/codexAuth";
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
  ResearchModelDefinition,
  ResearchProviderCollection,
  ResearchProviderPreset,
  ResearchProviderSettings,
} from "../types";
import { CodexAccountPanel } from "./CodexAccountPanel";
import {
  CONTROL_CLASS,
  ConfirmBar,
  Disclosure,
  EditorHeader,
  Feedback,
  Field,
  Monogram,
  Notice,
  OverflowMenu,
  SelectField,
  SettingsSection,
  StatusPill,
  StickyActions,
  Switch,
  UnsavedDot,
  type MonogramTone,
  type Tone,
} from "./settingsUi";

const TOKEN_LIMIT_STEPS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000] as const;

export type ConnectionView = "list" | "picker" | "editor";

function cleanModels(models: ResearchModelDefinition[]) {
  const seen = new Set<string>();
  return models.flatMap((item) => {
    const id = item.id.trim();
    if (!id || seen.has(id.toLowerCase())) return [];
    seen.add(id.toLowerCase());
    return [{ ...item, id, name: item.name.trim() || id }];
  });
}

// The Codex catalog is authoritative for a subscription, so it replaces the library (retired
// models drop out, priority order is kept); other providers keep manually added IDs.
function mergeDiscoveredModels(profile: ResearchProviderSettings, discovered: ResearchModelDefinition[]): Partial<ResearchProviderSettings> {
  if (profile.preset === "openai_codex" || profile.authMode === "chatgpt_oauth") {
    const available = new Set(discovered.map((model) => model.id));
    const keep = (id: string) => (available.has(id) ? id : "");
    return {
      models: discovered,
      model: keep(profile.model) || discovered[0]?.id || "",
      fastModel: keep(profile.fastModel),
      synthesisModel: keep(profile.synthesisModel),
      auditModel: keep(profile.auditModel),
    };
  }
  const existing = cleanModels(profile.models);
  const known = new Set(existing.map((model) => model.id.toLowerCase()));
  const models = [...existing, ...discovered.filter((model) => !known.has(model.id.toLowerCase()))];
  return { models, model: profile.model || models[0]?.id || "" };
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

function presetTone(preset: ResearchProviderPresetDefinition): MonogramTone {
  if (preset.id === "openai_codex" || preset.id === "openai") return "openai";
  return ({ domestic: "blue", international: "violet", local: "green", custom: "gray" } as const)[preset.group];
}

function profileStatus(profile: ResearchProviderSettings, isEn: boolean): { tone: Tone; label: string } {
  if (profile.authMode === "chatgpt_oauth" && !profile.apiKey) return { tone: "warn", label: isEn ? "Signed out" : "未登录" };
  if (profile.authMode !== "none" && !profile.apiKey) return { tone: "warn", label: isEn ? "No key" : "缺少 Key" };
  if (!profile.endpoint) return { tone: "warn", label: isEn ? "No URL" : "缺少地址" };
  if (!profile.model) return { tone: "warn", label: isEn ? "No model" : "未选模型" };
  return { tone: "ok", label: isEn ? "Ready" : "可用" };
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
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-tm">{isEn ? "Output token cap" : "输出 Token 上限"}</span>
        <output className="rounded-md bg-app-surface px-2 py-1 text-[11px] font-semibold tabular-nums text-ts">
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

function ProviderPicker({ isEn, onPick, onBack }: { isEn: boolean; onPick: (preset: ResearchProviderPreset) => void; onBack: () => void }) {
  const codex = RESEARCH_PROVIDER_PRESET_MAP.openai_codex;
  const groups: Array<{ id: ResearchProviderGroup; label: string }> = [
    { id: "domestic", label: isEn ? "China providers" : "国内服务商" },
    { id: "international", label: isEn ? "Global providers" : "国际服务商" },
    { id: "local", label: isEn ? "Local models" : "本地模型" },
    { id: "custom", label: isEn ? "Other" : "其他" },
  ];
  return (
    <div>
      <EditorHeader backLabel={isEn ? "Back to connections" : "返回连接列表"} onBack={onBack} title={isEn ? "Add a model connection" : "新增模型连接"} subtitle={isEn ? "Pick a provider. Endpoint and protocol are filled in for you." : "选择服务商，地址与协议会自动填好"} />
      <button type="button" onClick={() => onPick("openai_codex")} className="mb-3 flex w-full items-center gap-3 rounded-xl border border-[rgba(16,163,127,0.3)] bg-[rgba(16,163,127,0.06)] px-3 py-3 text-left">
        <Monogram label="Codex" tone="openai" size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[13px] font-semibold text-tp">{isEn ? codex.labelEn : codex.label}</p>
            <StatusPill tone="ok">{isEn ? "No API key" : "免 API Key"}</StatusPill>
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-tm">{isEn ? "Sign in with your ChatGPT Plus / Pro account, like the Codex CLI." : "用 ChatGPT Plus / Pro 账号登录，与 Codex CLI 相同"}</p>
        </div>
        <ChevronRight size={15} className="shrink-0 text-tmi" />
      </button>
      <div className="space-y-3">
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <p className="mb-1.5 px-0.5 text-[11px] font-semibold text-tm">{group.label}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {RESEARCH_PROVIDER_PRESETS.filter((preset) => preset.group === group.id && preset.id !== "openai_codex").map((preset) => (
                <button key={preset.id} type="button" onClick={() => onPick(preset.id)} className="flex min-w-0 items-center gap-2 rounded-xl border border-app-border bg-app-card px-2.5 py-2 text-left hover:border-app-accent/40">
                  <Monogram label={isEn ? preset.labelEn : preset.label} tone={presetTone(preset)} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ts">{isEn ? preset.labelEn : preset.label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function ProviderSettingsCard({
  language,
  onSaved,
  onOpenWebSearch,
  onViewChange,
}: {
  language: "zh" | "en";
  onSaved?: (settings: ResearchProviderSettings) => void;
  onOpenWebSearch?: () => void;
  onViewChange?: (view: ConnectionView) => void;
}) {
  const isEn = language === "en";
  const [collection, setCollection] = useState<ResearchProviderCollection | null>(null);
  const [view, setViewState] = useState<ConnectionView>("list");
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const hasUnsavedChangesRef = useRef(false);
  const collectionRef = useRef<ResearchProviderCollection | null>(null);
  collectionRef.current = collection;

  const setDirty = (value: boolean) => {
    hasUnsavedChangesRef.current = value;
    setDirtyState(value);
  };

  const setView = (next: ConnectionView) => {
    setViewState(next);
    onViewChange?.(next);
  };

  const reload = async () => {
    const value = await loadResearchProviderProfiles();
    setDirty(false);
    setCollection(value);
    return value;
  };

  useEffect(() => {
    let cancelled = false;
    void loadResearchProviderProfiles().then((value) => {
      if (!cancelled) {
        setDirty(false);
        setCollection(value);
      }
    });
    return () => { cancelled = true; };
  }, []);

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
    setDirty(true);
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

  const presetChanges = (preset: ResearchProviderPreset, current?: ResearchProviderSettings): Partial<ResearchProviderSettings> => {
    const nextPreset = RESEARCH_PROVIDER_PRESET_MAP[preset];
    const currentPreset = current ? RESEARCH_PROVIDER_PRESET_MAP[current.preset] : undefined;
    const hasDefaultName = !current
      || !current.name.trim()
      || current.name === currentPreset?.defaultName
      || current.name === currentPreset?.defaultNameEn
      || (current.preset === "openai" && current.name === "OpenAI Compatible");
    const switchingAuth = current && (current.authMode === "chatgpt_oauth") !== (nextPreset.authMode === "chatgpt_oauth");
    return {
      preset,
      name: hasDefaultName || !current ? (isEn ? nextPreset.defaultNameEn : nextPreset.defaultName) : current.name,
      endpoint: nextPreset.endpoint,
      protocol: nextPreset.protocol,
      authMode: nextPreset.authMode,
      authHeaderName: nextPreset.authHeaderName ?? "Authorization",
      authHeaderPrefix: nextPreset.authHeaderPrefix ?? "Bearer ",
      thinkingLevel: "auto",
      // An API key and ChatGPT login tokens are never interchangeable.
      ...(switchingAuth ? { apiKey: "" } : {}),
      ...(preset === "openai_codex" && !cleanModels(current?.models ?? []).length
        ? { models: CODEX_DEFAULT_MODELS, model: CODEX_DEFAULT_MODELS[0]!.id }
        : {}),
    };
  };

  const applyPreset = (preset: ResearchProviderPreset) => {
    if (!settings) return;
    updateProfile(presetChanges(preset, settings));
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
      setDirty(false);
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

  const openEditor = (profileId: string) => {
    setExpandedProfileId(profileId);
    setConfirmDeleteProfileId(null);
    setShowKey(false);
    setMessage("");
    setView("editor");
  };

  const backToList = () => {
    setConfirmDeleteProfileId(null);
    setShowKey(false);
    setMessage("");
    setView("list");
  };

  const activate = async (profileId: string) => {
    if (!collection) return;
    if (collection.activeProfileId === profileId) return;
    hasUnsavedChangesRef.current = true;
    const next = { ...collection, activeProfileId: profileId };
    setCollection(next);
    setMessage("");
    await saveResearchProviderProfiles(next);
    setDirty(false);
    const active = next.profiles.find((profile) => profile.id === profileId);
    if (active) {
      setMessageType("success");
      setMessage(isEn ? `${active.name} is now the default connection` : `已将“${active.name}”设为默认连接`);
      onSaved?.(active);
    }
  };

  const addProfile = (preset: ResearchProviderPreset) => {
    if (!collection) return;
    setDirty(true);
    const profile = createResearchProviderProfile(presetChanges(preset));
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    openEditor(profile.id);
  };

  const duplicateProfile = () => {
    if (!collection || !settings) return;
    setDirty(true);
    const profile = createResearchProviderProfile({
      ...settings,
      id: undefined,
      name: `${settings.name} ${isEn ? "Copy" : "副本"}`,
      apiKey: "",
      saveApiKey: false,
    });
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    openEditor(profile.id);
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
    setView("list");
    await saveResearchProviderProfiles(next);
    setDirty(false);
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
      updateProfile(mergeDiscoveredModels(settings, discovered));
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
      setDirty(false);
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
      setDirty(false);
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
    setMessage(settings.authMode === "chatgpt_oauth"
      ? (isEn ? "Signed out of ChatGPT for this connection" : "已退出当前连接的 ChatGPT 登录")
      : (isEn ? "Key cleared for this connection" : "已清除当前连接的 API Key"));
  };

  // Lands ChatGPT tokens on the connection that started the login, then syncs its model list.
  const applyCodexCredentials = async (profileId: string, credentials: CodexCredentials) => {
    const current = collectionRef.current;
    if (!current?.profiles.some((profile) => profile.id === profileId)) {
      setMessageType("error");
      setMessage(isEn ? "The connection that started this sign-in no longer exists." : "发起登录的连接已不存在，请重新登录。");
      return;
    }
    const apiKey = serializeCodexCredentials(credentials);
    setSessionResearchApiKey(apiKey, profileId);
    const signedIn = {
      ...current,
      profiles: current.profiles.map((profile) => profile.id === profileId ? { ...profile, apiKey } : profile),
    };
    await saveCollection(signedIn);
    setExpandedProfileId(profileId);
    setView("editor");
    const who = credentials.email ?? (isEn ? "ChatGPT account" : "ChatGPT 账号");
    try {
      const profile = signedIn.profiles.find((item) => item.id === profileId)!;
      const discovered = await new OpenAICompatibleProvider(profile).listModels();
      const synced = {
        ...signedIn,
        profiles: signedIn.profiles.map((item) => item.id === profileId ? { ...item, ...mergeDiscoveredModels(item, discovered) } : item),
      };
      await saveCollection(synced);
      setMessageType("success");
      setMessage(isEn ? `Signed in as ${who} · ${discovered.length} model(s) available` : `已登录 ${who} · 同步到 ${discovered.length} 个可用模型`);
    } catch {
      setMessageType("success");
      setMessage(isEn ? `Signed in as ${who}. Fetch models to sync your plan's model list.` : `已登录 ${who}。可点击“获取模型”同步订阅可用的模型。`);
    }
  };
  const applyCodexRef = useRef(applyCodexCredentials);
  applyCodexRef.current = applyCodexCredentials;
  const loaded = collection !== null;

  useEffect(() => {
    if (!loaded) return undefined;
    const redeem = () => {
      void consumeCodexCallback()
        .then((result) => result && applyCodexRef.current(result.profileId, result.credentials))
        .catch((error: unknown) => {
          setMessageType("error");
          setMessage(error instanceof Error ? error.message : isEn ? "ChatGPT sign-in failed" : "ChatGPT 登录失败");
        });
    };
    redeem();
    return subscribeCodexCallback(redeem);
  }, [loaded, isEn]);

  const resolvedEndpoint = (() => {
    if (!settings?.endpoint) return "";
    try { return resolveResearchEndpoint(settings.endpoint, settings.protocol, "{model}", false, settings.preset); } catch { return ""; }
  })();

  if (!collection || !settings) {
    return <div className="flex items-center justify-center py-8 text-tm"><Loader2 size={16} className="animate-spin" /></div>;
  }

  if (view === "picker") {
    return <ProviderPicker isEn={isEn} onPick={addProfile} onBack={backToList} />;
  }

  if (view === "list") {
    return (
      <div aria-label={isEn ? "API connection list" : "API 连接列表"}>
        <div className="mb-2 flex items-end justify-between gap-2 px-0.5">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-tp">{isEn ? "Model connections" : "模型连接"}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-tmi">
              {isEn
                ? "The starred default serves “Follow default” workflows and acts as the fallback."
                : "带星标的默认连接供“跟随默认”的研究模式使用，并作为回退。"}
            </p>
          </div>
        </div>
        <Feedback type={messageType} message={message} />
        <div className="mt-1.5 space-y-2">
          {collection.profiles.map((profile) => {
            const preset = RESEARCH_PROVIDER_PRESET_MAP[profile.preset];
            const active = collection.activeProfileId === profile.id;
            const status = profileStatus(profile, isEn);
            return (
              <article key={profile.id} className={`flex items-stretch overflow-hidden rounded-xl border bg-app-card ${active ? "border-app-accent/35" : "border-app-border"}`}>
                <button type="button" onClick={() => openEditor(profile.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left" aria-label={isEn ? `Edit ${profile.name}` : `编辑${profile.name}`}>
                  <Monogram label={isEn ? preset.labelEn : preset.label} tone={presetTone(preset)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-tp">{profile.name || preset.defaultName}</span>
                      {active && <Star size={11} className="shrink-0 fill-[#F5B70B] text-[#F5B70B]" aria-label={isEn ? "Default" : "默认连接"} />}
                      <StatusPill tone={status.tone}>{status.label}</StatusPill>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">
                      {isEn ? preset.labelEn : preset.label}{profile.model ? ` · ${profile.model}` : ""}
                    </p>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-tmi" />
                </button>
                {!active && (
                  <button type="button" onClick={() => void activate(profile.id)} className="flex w-11 shrink-0 items-center justify-center border-l border-app-border text-tmi hover:text-[#F5B70B]" aria-label={isEn ? `Set ${profile.name} as default` : `将${profile.name}设为默认连接`} title={isEn ? "Set as default" : "设为默认"}>
                    <Star size={14} />
                  </button>
                )}
              </article>
            );
          })}
          <button type="button" onClick={() => setView("picker")} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-app-border text-[12px] font-semibold text-app-accent hover:border-app-accent/50" aria-label={isEn ? "Add connection" : "新增连接"}>
            <Plus size={13} />{isEn ? "Add connection" : "新增连接"}
          </button>
        </div>
        {dirty && (
          <StickyActions status={<p className="flex items-center gap-1.5 text-[11px] text-tm"><UnsavedDot />{isEn ? "You have unsaved changes" : "有未保存的修改"}</p>}>
            <button type="button" onClick={() => void reload()} className="h-9 flex-1 rounded-lg border border-app-border bg-app-card text-[12px] font-semibold text-tm">{isEn ? "Discard" : "放弃修改"}</button>
            <button type="button" onClick={() => void saveCollection()} disabled={saving} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-app-accent text-[12px] font-semibold text-white disabled:opacity-60">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}
            </button>
          </StickyActions>
        )}
      </div>
    );
  }

  const selectedPreset = RESEARCH_PROVIDER_PRESET_MAP[settings.preset];
  const isCodex = settings.authMode === "chatgpt_oauth";
  const isDefault = collection.activeProfileId === settings.id;
  const models = cleanModels(settings.models);
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
    <div>
      <EditorHeader
        backLabel={isEn ? "Back to connections" : "返回连接列表"}
        onBack={backToList}
        title={settings.name || selectedPreset.defaultName}
        subtitle={`${isEn ? selectedPreset.labelEn : selectedPreset.label}${isDefault ? (isEn ? " · Default" : " · 默认连接") : ""}`}
        actions={(
          <>
            {!isDefault && (
              <button type="button" onClick={() => void activate(settings.id)} className="flex h-8 items-center gap-1 rounded-lg border border-app-border bg-app-card px-2 text-[11px] font-semibold text-tm" aria-label={isEn ? `Set ${settings.name} as default` : `将${settings.name}设为默认连接`}>
                <Star size={12} />{isEn ? "Default" : "设为默认"}
              </button>
            )}
            <OverflowMenu
              label={isEn ? "More actions" : "更多操作"}
              items={[
                { label: isEn ? "Duplicate" : "复制连接", icon: <CopyPlus size={12} />, onSelect: duplicateProfile },
                { label: isCodex ? (isEn ? "Sign out" : "退出登录") : (isEn ? "Clear key" : "清除 Key"), icon: <Eraser size={12} />, onSelect: () => void clearKey(), disabled: !settings.apiKey },
                { label: isEn ? "Delete" : "删除连接", icon: <Trash2 size={12} />, onSelect: () => setConfirmDeleteProfileId(settings.id), danger: true },
              ]}
            />
          </>
        )}
      />

      <div className="space-y-2.5">
        {confirmDeleteProfileId === settings.id && (
          <ConfirmBar
            message={isEn ? `Delete “${settings.name}”? This does not affect other connections.` : `确认删除“${settings.name}”？其他连接不会受影响。`}
            confirmLabel={isEn ? "Delete" : "确认删除"}
            cancelLabel={isEn ? "Cancel" : "取消"}
            onCancel={() => setConfirmDeleteProfileId(null)}
            onConfirm={() => void deleteProfile()}
          />
        )}

        <SettingsSection title={isEn ? "Provider" : "服务商"}>
          <div className="grid grid-cols-2 gap-2">
            <Field label={isEn ? "Connection name" : "连接名称"}>
              <input aria-label={isEn ? "Connection name" : "连接名称"} className={CONTROL_CLASS} value={settings.name} onChange={(event) => update("name", event.target.value)} />
            </Field>
            <Field label={isEn ? "Provider preset" : "服务商预设"}>
              <SelectField ariaLabel={isEn ? "Provider preset" : "服务商预设"} value={settings.preset} onChange={(value) => applyPreset(value as ResearchProviderPreset)}>
                {groups.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {RESEARCH_PROVIDER_PRESETS.filter((preset) => preset.group === group.id).map((preset) => (
                      <option key={preset.id} value={preset.id}>{isEn ? preset.labelEn : preset.label}</option>
                    ))}
                  </optgroup>
                ))}
              </SelectField>
            </Field>
          </div>
          {selectedPreset.note && <Notice>{isEn ? selectedPreset.noteEn : selectedPreset.note}</Notice>}
        </SettingsSection>

        <SettingsSection
          title={isCodex ? (isEn ? "ChatGPT account" : "ChatGPT 账号") : (isEn ? "Authentication" : "鉴权")}
          description={isCodex
            ? (isEn ? "Requests use your subscription quota instead of API billing." : "调用消耗订阅额度，不产生 API 账单。")
            : settings.authMode === "none" ? (isEn ? "This endpoint needs no key." : "该服务无需 API Key。") : undefined}
        >
          {isCodex ? (
            <CodexAccountPanel
              profileId={settings.id}
              apiKey={settings.apiKey}
              isEn={isEn}
              onBeforeLogin={() => saveCollection()}
              onSignedIn={(credentials) => void applyCodexCredentials(settings.id, credentials)}
              onSignOut={() => void clearKey()}
            />
          ) : settings.authMode !== "none" && (
            <Field label={isEn ? "API Key / token" : "API Key / Token"}>
              <div className="relative">
                <input aria-label="API Key / Token" className={`${CONTROL_CLASS} pr-9`} type={showKey ? "text" : "password"} value={settings.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="off" spellCheck={false} placeholder={isEn ? "Paste your key" : "粘贴服务商提供的 Key"} />
                <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              </div>
            </Field>
          )}
          {settings.authMode !== "none" && (
            <Switch
              checked={settings.saveApiKey}
              onChange={(checked) => update("saveApiKey", checked)}
              label={isCodex ? (isEn ? "Stay signed in on this device" : "在此设备保持登录") : (isEn ? "Save this API Key on device" : "在此设备保存当前 API Key")}
              description={isEn ? "Off keeps it for this browser session only. Keys never enter exports." : "关闭时仅在本次浏览器会话中保留；Key 不会进入数据导出。"}
            />
          )}
        </SettingsSection>

        <SettingsSection
          ariaLabel={isEn ? "Model library" : "模型库"}
          title={isEn ? "Models" : "模型"}
          description={isEn ? `${models.length} in library` : `模型库 ${models.length} 个`}
          action={(
            <>
              <button type="button" onClick={() => void fetchModels()} disabled={loadingModels} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-medium text-tm disabled:opacity-60">
                {loadingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {isEn ? "Fetch" : "获取模型"}
              </button>
              <button type="button" onClick={addModel} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-medium text-tm" aria-label={isEn ? "Add model" : "添加模型"}><Plus size={11} />{isEn ? "Add" : "添加"}</button>
            </>
          )}
        >
          {settings.models.length ? (
            <div className="space-y-1.5">
              {settings.models.map((model, index) => (
                <div key={`${settings.id}-model-${index}`} className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_30px] gap-1.5">
                  <input aria-label={`${isEn ? "Model ID" : "模型 ID"} ${index + 1}`} className={`${CONTROL_CLASS} min-h-8 py-1.5`} value={model.id} onChange={(event) => updateModel(index, { id: event.target.value, name: model.name === model.id ? event.target.value : model.name })} placeholder={isEn ? "Model / Endpoint ID" : "模型 / Endpoint ID"} />
                  <input aria-label={`${isEn ? "Display name" : "显示名称"} ${index + 1}`} className={`${CONTROL_CLASS} min-h-8 py-1.5`} value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder={isEn ? "Name (optional)" : "名称（可选）"} />
                  <button type="button" onClick={() => removeModel(index)} className="flex h-8 w-[30px] items-center justify-center rounded-lg border border-app-border bg-app-surface text-tmi hover:text-[#F24E4E]" aria-label={isEn ? `Remove model ${index + 1}` : `删除第 ${index + 1} 个模型`}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          ) : (
            <button type="button" onClick={addModel} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-app-border bg-app-surface px-3 py-3 text-[11px] leading-4 text-tmi">
              <Plus size={11} />{isEn ? "Add a model ID manually, or fetch the provider model list" : "手动添加模型 ID，或从服务商获取模型列表"}
            </button>
          )}

          <div className="grid grid-cols-2 gap-2 border-t border-app-border pt-2.5">
            <Field label={isEn ? "Research model" : "研究模型"}>
              <SelectField ariaLabel={isEn ? "Research model" : "研究模型"} value={settings.model} disabled={!models.length} onChange={(value) => update("model", value)}>
                <option value="">{isEn ? "Select a model" : "请选择模型"}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </Field>
            <Field label={isEn ? "Fast model (optional)" : "快速模型（可选）"}>
              <SelectField ariaLabel={isEn ? "Fast model" : "快速模型"} value={settings.fastModel} disabled={!models.length} onChange={(value) => update("fastModel", value)}>
                <option value="">{isEn ? "Use research model" : "使用研究模型"}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </Field>
            <Field label={isEn ? "Synthesis model (optional)" : "综合模型（可选）"}>
              <SelectField ariaLabel={isEn ? "Synthesis model" : "综合模型"} value={settings.synthesisModel} disabled={!models.length} onChange={(value) => update("synthesisModel", value)}>
                <option value="">{isEn ? "Use research model" : "使用研究模型"}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </Field>
            <Field label={isEn ? "Audit model (optional)" : "审计模型（可选）"}>
              <SelectField ariaLabel={isEn ? "Audit model" : "审计模型"} value={settings.auditModel} disabled={!models.length} onChange={(value) => update("auditModel", value)}>
                <option value="">{isEn ? "Local checks only" : "仅本地规则检查"}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </SelectField>
            </Field>
          </div>
          <p className="text-[11px] leading-4 text-tmi">
            {isEn
              ? "Research handles deep analysis; Fast handles light workflows; Synthesis merges agent reports; Audit independently reviews the final output. Empty optional roles fall back to Research."
              : "研究模型负责深度分析；快速模型负责轻量任务；综合模型合并多角色报告；审计模型独立复核终稿。可选职责留空时回退到研究模型。"}
          </p>
          {settings.auditModel && [settings.model, settings.synthesisModel || settings.model].includes(settings.auditModel) && (
            <p className="text-[11px] leading-4 text-[#D97706]">
              {isEn ? "The audit role reuses a writing model, so the review is not fully independent." : "审计模型与写作模型相同，复核可用但独立性较弱；建议选择不同模型。"}
            </p>
          )}
        </SettingsSection>

        <SettingsSection title={isEn ? "Generation" : "生成参数"}>
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={isEn ? "Thinking depth" : "思考深度"}
              hint={(
                <>
                  {isEn ? thinkingControl.noteEn : thinkingControl.note}
                  {thinkingFallbackActive && (
                    <span className="mt-1 block text-[#D97706]">
                      {isEn
                        ? `Requested ${requestedThinkingLabel}; this model will use ${effectiveThinkingLabel?.labelEn ?? displayedThinkingLevel}.`
                        : `已选择${requestedThinkingLabel}；当前模型不支持时将自动使用${effectiveThinkingLabel?.label ?? displayedThinkingLevel}。`}
                    </span>
                  )}
                </>
              )}
            >
              <SelectField ariaLabel={isEn ? "Thinking depth" : "思考深度"} value={displayedThinkingLevel} onChange={(value) => update("thinkingLevel", value as ResearchProviderSettings["thinkingLevel"])}>
                {thinkingControl.options.map((option) => (
                  <option key={option.value} value={option.value}>{isEn ? option.labelEn : option.label}</option>
                ))}
              </SelectField>
            </Field>
            <Field label={isEn ? "Concurrency" : "并发数"}>
              <SelectField ariaLabel={isEn ? "Concurrency" : "并发数"} value={settings.maxConcurrency} onChange={(value) => update("maxConcurrency", Number(value) as 1 | 2 | 3 | 4)}>
                {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
              </SelectField>
            </Field>
          </div>
          {isCodex
            ? <Notice tone="muted">{isEn ? "The ChatGPT backend sets the output length itself, so no token cap is sent." : "ChatGPT 订阅接口由服务端决定输出长度，不发送输出 Token 上限。"}</Notice>
            : <TokenLimitSlider value={settings.maxOutputTokens} onChange={(value) => update("maxOutputTokens", value)} isEn={isEn} />}
        </SettingsSection>

        <SettingsSection
          title={isEn ? "Automatic web access" : "自动联网"}
          action={(
            <StatusPill tone={nativeWebStatus === "verified" ? "ok" : nativeWebStatus === "failed" ? "warn" : "accent"}>
              {nativeWebStatus === "verified"
                ? (isEn ? "VERIFIED" : "已验证")
                : nativeWebStatus === "failed"
                  ? (isEn ? "RETRY" : "可重试")
                  : nativeWebStatus === "available"
                    ? (isEn ? "AUTO" : "自动启用")
                    : (isEn ? "FALLBACK" : "自动回退")}
            </StatusPill>
          )}
        >
          <p className="text-[11px] leading-4 text-tmi">
            {nativeWebStatus === "verified"
              ? (isEn ? "Native browsing was verified and can be tested again at any time. Research enables it automatically; external search remains optional fallback evidence." : "当前模型已验证可原生联网，可随时重复检测；研究时会自动启用，外部搜索仅作为可选证据增强和兜底。")
              : nativeWebStatus === "failed"
                ? (isEn ? webSearchCapability.reasonEn : webSearchCapability.reasonZh)
                : supportsNativeWebSearch
                  ? (isEn ? "Native browsing is enabled automatically. The repeatable diagnostic below only verifies actual search events and citations." : "原生联网已自动启用；下方检测不是开关，可反复运行，仅用于确认服务商是否实际返回搜索事件和引用。")
                  : `${isEn ? webSearchCapability.reasonEn : webSearchCapability.reasonZh} ${isEn ? "Research will fall back to configured external search or prefetched market data without blocking." : "研究会自动回退到已配置的外部搜索或插件预取行情，不会因此中断。"}`}
          </p>
          {supportsNativeWebSearch ? (
            <button type="button" onClick={() => void testWebSearch()} disabled={testingWebSearch} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] font-semibold text-ts disabled:opacity-45">{testingWebSearch ? <Loader2 size={12} className="animate-spin" /> : <Globe2 size={12} />}{isEn ? "Test native web" : "检测原生联网"}</button>
          ) : (
            <button type="button" onClick={onOpenWebSearch} disabled={!onOpenWebSearch} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] font-semibold text-ts disabled:opacity-45"><Globe2 size={12} />{isEn ? "Open web-search test" : "前往联网测试"}</button>
          )}
        </SettingsSection>

        <Disclosure
          title={isEn ? "Advanced" : "高级设置"}
          summary={`${protocolLabel(settings.protocol)} · ${settings.endpoint || (isEn ? "no URL" : "未填地址")}`}
          defaultOpen={settings.preset === "custom"}
        >
          <Field label={isEn ? "Base URL or full endpoint" : "Base URL 或完整请求地址"} hint={resolvedEndpoint ? <span className="break-all">{isEn ? "Actual request" : "实际请求"}: {resolvedEndpoint}</span> : undefined}>
            <input aria-label={isEn ? "Base URL or full endpoint" : "Base URL 或完整请求地址"} className={CONTROL_CLASS} value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://.../v1" spellCheck={false} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={isEn ? "API protocol" : "API 协议"}>
              <SelectField ariaLabel={isEn ? "API protocol" : "API 协议"} value={settings.protocol} disabled={isCodex} onChange={(value) => updateProfile({ protocol: value as ResearchProviderSettings["protocol"] })}>
                <option value="responses">Responses API</option>
                <option value="chat_completions">OpenAI Chat Completions</option>
                <option value="anthropic_messages">Anthropic Messages</option>
                <option value="gemini_native">Gemini GenerateContent</option>
                <option value="ollama_chat">Ollama Chat</option>
              </SelectField>
            </Field>
            <Field label={isEn ? "Authentication" : "鉴权方式"}>
              <SelectField ariaLabel={isEn ? "Authentication" : "鉴权方式"} value={settings.authMode} disabled={isCodex} onChange={(value) => update("authMode", value as ResearchProviderSettings["authMode"])}>
                <option value="bearer">Authorization: Bearer</option>
                <option value="x_api_key">x-api-key (Anthropic)</option>
                <option value="x_google_api_key">x-goog-api-key (Gemini)</option>
                <option value="custom_header">{isEn ? "Custom header" : "自定义 Header"}</option>
                <option value="none">{isEn ? "No authentication" : "无需鉴权"}</option>
                {isCodex && <option value="chatgpt_oauth">{isEn ? "ChatGPT sign-in" : "ChatGPT 账号登录"}</option>}
              </SelectField>
            </Field>
          </div>
          {settings.authMode === "custom_header" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={isEn ? "Header name" : "Header 名称"}><input aria-label={isEn ? "Header name" : "Header 名称"} className={CONTROL_CLASS} value={settings.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder="Authorization" /></Field>
              <Field label={isEn ? "Value prefix (optional)" : "值前缀（可选）"}><input aria-label={isEn ? "Value prefix" : "值前缀"} className={CONTROL_CLASS} value={settings.authHeaderPrefix} onChange={(event) => update("authHeaderPrefix", event.target.value)} placeholder="Bearer " /></Field>
            </div>
          )}
        </Disclosure>

        <Notice tone="warn">{isEn ? "Each connection keeps its own key. Keys are excluded from exports; session-only mode remains recommended." : "每个连接独立保存 Key，且 Key 不会进入持仓导出。仍建议优先使用仅会话保存。"}</Notice>
      </div>

      <StickyActions
        status={message
          ? <Feedback type={messageType} message={message} />
          : dirty ? <p className="flex items-center gap-1.5 text-[11px] text-tm"><UnsavedDot />{isEn ? "Unsaved changes" : "有未保存的修改"}</p> : undefined}
      >
        <button type="button" onClick={() => void test()} disabled={testing} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-card px-2 text-[12px] font-semibold text-ts disabled:opacity-60">{testing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}{isEn ? "Test role models" : "测试职责模型"}</button>
        <button type="button" onClick={() => void saveCollection()} disabled={saving} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-app-accent px-2 text-[12px] font-semibold text-white disabled:opacity-60">{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}</button>
      </StickyActions>
    </div>
  );
}
