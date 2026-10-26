import {
  ChevronRight,
  CopyPlus,
  Eraser,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalSearchProvider } from "../externalSearch";
import {
  clearSavedResearchExternalSearchApiKey,
  createResearchExternalSearchProfile,
  externalSearchPresetDefaults,
  loadResearchExternalSearchProfiles,
  saveResearchExternalSearchProfiles,
  setSessionResearchExternalSearchApiKey,
  subscribeResearchStorageChanges,
} from "../storage";
import type {
  ResearchExternalSearchCollection,
  ResearchExternalSearchProvider,
  ResearchExternalSearchSettings,
} from "../types";
import type { ConnectionView } from "./ProviderSettingsCard";
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
} from "./settingsUi";

const SEARCH_PROVIDERS: ResearchExternalSearchProvider[] = ["tavily", "brave", "exa", "volcengine_search", "custom"];

function providerLabel(provider: ResearchExternalSearchProvider, isEn: boolean) {
  return ({
    tavily: "Tavily",
    brave: "Brave Search",
    exa: "Exa",
    volcengine_search: isEn ? "Volcengine Search" : "方舟联网搜索",
    custom: isEn ? "Custom search API" : "自定义搜索 API",
  })[provider];
}

function providerBlurb(provider: ResearchExternalSearchProvider, isEn: boolean) {
  return ({
    tavily: isEn ? "Research-oriented, page content enrichment" : "面向研究，可增强网页正文",
    brave: isEn ? "Independent index, extra snippets" : "独立索引，可返回更多摘要",
    exa: isEn ? "Semantic search, up to 100 results" : "语义检索，单次最多 100 条",
    volcengine_search: isEn ? "Chinese web, auto summaries" : "中文网页覆盖好，自动摘要",
    custom: isEn ? "Map any JSON search API" : "映射任意 JSON 搜索接口",
  })[provider];
}

function providerTone(provider: ResearchExternalSearchProvider): MonogramTone {
  return provider === "volcengine_search" ? "blue" : provider === "custom" ? "gray" : "green";
}

export function ExternalSearchSettingsCard({
  language,
  onSaved,
  onViewChange,
}: {
  language: "zh" | "en";
  onSaved?: (settings: ResearchExternalSearchSettings) => void;
  onViewChange?: (view: ConnectionView) => void;
}) {
  const isEn = language === "en";
  const [collection, setCollection] = useState<ResearchExternalSearchCollection | null>(null);
  const [view, setViewState] = useState<ConnectionView>("list");
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const hasUnsavedChangesRef = useRef(false);

  const setDirty = (value: boolean) => {
    hasUnsavedChangesRef.current = value;
    setDirtyState(value);
  };

  const setView = (next: ConnectionView) => {
    setViewState(next);
    onViewChange?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    void loadResearchExternalSearchProfiles().then((value) => {
      if (cancelled) return;
      setDirty(false);
      setCollection(value);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => subscribeResearchStorageChanges(() => {
    if (hasUnsavedChangesRef.current) return;
    void loadResearchExternalSearchProfiles().then((value) => {
      if (!hasUnsavedChangesRef.current) setCollection(value);
    });
  }), []);

  const settings = useMemo(() => {
    if (!collection) return null;
    const editingProfileId = expandedProfileId ?? collection.activeProfileId;
    return collection.profiles.find((profile) => profile.id === editingProfileId) ?? collection.profiles[0] ?? null;
  }, [collection, expandedProfileId]);

  const updateProfile = (changes: Partial<ResearchExternalSearchSettings>) => {
    if (!settings) return;
    setDirty(true);
    setCollection((current) => current ? {
      ...current,
      profiles: current.profiles.map((profile) => profile.id === settings.id ? { ...profile, ...changes } : profile),
    } : current);
    if (typeof changes.apiKey === "string") setSessionResearchExternalSearchApiKey(changes.apiKey, settings.id);
    setMessage("");
  };

  const update = <K extends keyof ResearchExternalSearchSettings>(key: K, value: ResearchExternalSearchSettings[K]) => {
    updateProfile({ [key]: value } as Pick<ResearchExternalSearchSettings, K>);
  };

  const providerChanges = (provider: ResearchExternalSearchProvider, current: ResearchExternalSearchSettings): Partial<ResearchExternalSearchSettings> => {
    const preset = externalSearchPresetDefaults(provider);
    const previousDefaultNames = [providerLabel(current.provider, false), providerLabel(current.provider, true)];
    return {
      provider,
      name: previousDefaultNames.includes(current.name) ? providerLabel(provider, isEn) : current.name,
      endpoint: preset.endpoint,
      authHeaderName: preset.authHeaderName,
      authHeaderPrefix: preset.authHeaderPrefix,
      maxResults: provider === "tavily" || provider === "brave"
        ? Math.min(current.maxResults, 20)
        : provider === "volcengine_search" ? Math.min(current.maxResults, 50) : current.maxResults,
    };
  };

  const selectProvider = (provider: ResearchExternalSearchProvider) => {
    if (!settings) return;
    updateProfile(providerChanges(provider, settings));
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

  const reload = async () => {
    const value = await loadResearchExternalSearchProfiles();
    setDirty(false);
    setCollection(value);
  };

  const activate = async (profileId: string) => {
    if (!collection || collection.activeProfileId === profileId) return;
    hasUnsavedChangesRef.current = true;
    const next = { ...collection, activeProfileId: profileId };
    setCollection(next);
    await saveResearchExternalSearchProfiles(next);
    setDirty(false);
    const active = next.profiles.find((profile) => profile.id === profileId);
    if (active) {
      setMessageType("success");
      setMessage(isEn ? `${active.name} is now the default search connection` : `已将“${active.name}”设为默认搜索连接`);
      onSaved?.(active);
    }
  };

  const addProfile = (provider: ResearchExternalSearchProvider) => {
    if (!collection) return;
    setDirty(true);
    const base = createResearchExternalSearchProfile({ name: providerLabel(provider, isEn) });
    const profile = { ...base, ...providerChanges(provider, { ...base, name: providerLabel(base.provider, isEn) }) };
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    openEditor(profile.id);
  };

  const duplicateProfile = () => {
    if (!collection || !settings) return;
    setDirty(true);
    const profile = createResearchExternalSearchProfile({
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
    const profiles = remaining.length ? remaining : [createResearchExternalSearchProfile()];
    const activeProfileId = profiles.some((profile) => profile.id === collection.activeProfileId) ? collection.activeProfileId : profiles[0]!.id;
    const next = { activeProfileId, profiles };
    setCollection(next);
    setExpandedProfileId(null);
    setConfirmDeleteProfileId(null);
    setView("list");
    await saveResearchExternalSearchProfiles(next);
    setDirty(false);
    onSaved?.(profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]!);
  };

  const clearKey = async () => {
    if (!settings) return;
    hasUnsavedChangesRef.current = true;
    await clearSavedResearchExternalSearchApiKey(settings.id);
    updateProfile({ apiKey: "", saveApiKey: false });
    setMessageType("success");
    setMessage(isEn ? "Key cleared for this search connection" : "已清除当前搜索连接的 API Key");
  };

  const save = async () => {
    if (!collection) return;
    setSaving(true);
    setMessage("");
    try {
      await saveResearchExternalSearchProfiles(collection);
      setDirty(false);
      const active = collection.profiles.find((profile) => profile.id === collection.activeProfileId) ?? collection.profiles[0]!;
      setMessageType("success");
      setMessage(isEn ? "Search connections saved" : "搜索连接已保存");
      onSaved?.(active);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : isEn ? "Save failed" : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!settings) return;
    setTesting(true);
    setMessage("");
    try {
      setSessionResearchExternalSearchApiKey(settings.apiKey, settings.id);
      const result = await new ExternalSearchProvider(settings).test();
      setMessageType("success");
      setMessage(isEn ? `Search verified · ${result.results.length} source(s)` : result.message);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : isEn ? "Search test failed" : "搜索测试失败");
    } finally {
      setTesting(false);
    }
  };

  if (!collection || !settings) return <div className="flex items-center justify-center py-8 text-tm"><Loader2 size={16} className="animate-spin" /></div>;

  if (view === "picker") {
    return (
      <div>
        <EditorHeader backLabel={isEn ? "Back to search connections" : "返回搜索连接"} onBack={backToList} title={isEn ? "Add a search connection" : "新增搜索连接"} subtitle={isEn ? "Used when the model cannot browse, or to add cited evidence" : "模型无法联网时提供证据，也可增强引用来源"} />
        <div className="space-y-1.5">
          {SEARCH_PROVIDERS.map((provider) => (
            <button key={provider} type="button" onClick={() => addProfile(provider)} className="flex w-full items-center gap-2.5 rounded-xl border border-app-border bg-app-card px-2.5 py-2.5 text-left hover:border-app-accent/40">
              <Monogram label={providerLabel(provider, isEn)} tone={providerTone(provider)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-tp">{providerLabel(provider, isEn)}</p>
                <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">{providerBlurb(provider, isEn)}</p>
              </div>
              <ChevronRight size={14} className="shrink-0 text-tmi" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (view === "list") {
    return (
      <div aria-label={isEn ? "Search connection list" : "搜索连接列表"}>
        <div className="mb-2 px-0.5">
          <p className="text-[12px] font-semibold text-tp">{isEn ? "Search connections" : "搜索连接"}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-tmi">
            {isEn
              ? "The starred default supplies cited evidence when the model cannot browse, or adds extra sources."
              : "带星标的默认连接在模型无法联网时提供带引用的证据，也可作为额外来源。"}
          </p>
        </div>
        <Feedback type={messageType} message={message} />
        <div className="mt-1.5 space-y-2">
          {collection.profiles.map((profile) => {
            const active = collection.activeProfileId === profile.id;
            return (
              <article key={profile.id} className={`flex items-stretch overflow-hidden rounded-xl border bg-app-card ${active ? "border-[#31D08B]/40" : "border-app-border"}`}>
                <button type="button" onClick={() => openEditor(profile.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left" aria-label={isEn ? `Edit ${profile.name}` : `编辑${profile.name}`}>
                  <Monogram label={providerLabel(profile.provider, isEn)} tone={providerTone(profile.provider)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-tp">{profile.name}</span>
                      {active && <Star size={11} className="shrink-0 fill-[#F5B70B] text-[#F5B70B]" aria-label={isEn ? "Default" : "默认连接"} />}
                      <StatusPill tone={profile.apiKey ? "ok" : "warn"}>{profile.apiKey ? (isEn ? "Key ready" : "已配置 Key") : (isEn ? "No key" : "缺少 Key")}</StatusPill>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">{providerLabel(profile.provider, isEn)} · {profile.maxSources} {isEn ? "sources" : "个来源"}</p>
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
          <button type="button" onClick={() => setView("picker")} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-app-border text-[12px] font-semibold text-app-accent hover:border-app-accent/50" aria-label={isEn ? "Add search connection" : "新增搜索连接"}>
            <Plus size={13} />{isEn ? "Add search connection" : "新增搜索连接"}
          </button>
        </div>
        {dirty && (
          <StickyActions status={<p className="flex items-center gap-1.5 text-[11px] text-tm"><UnsavedDot />{isEn ? "You have unsaved changes" : "有未保存的修改"}</p>}>
            <button type="button" onClick={() => void reload()} className="h-9 flex-1 rounded-lg border border-app-border bg-app-card text-[12px] font-semibold text-tm">{isEn ? "Discard" : "放弃修改"}</button>
            <button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-app-accent text-[12px] font-semibold text-white disabled:opacity-60">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}
            </button>
          </StickyActions>
        )}
      </div>
    );
  }

  const maxResultOptions = settings.provider === "exa" || settings.provider === "custom"
    ? [5, 8, 10, 15, 20, 30, 50, 75, 100]
    : settings.provider === "volcengine_search" ? [5, 8, 10, 15, 20, 30, 50] : [5, 8, 10, 15, 20];
  const maxSourceOptions = [10, 15, 20, 25, 30, 40, 50, 75, 100];
  const maxPageOptions = [1, 2, 3, 5, 8, 10, 12, 15, 20, 30, 50].filter((value) => value <= settings.maxSources);
  const supportsDomainFilters = settings.provider === "tavily" || settings.provider === "exa" || settings.provider === "custom";
  const supportsSeparateContentEnrichment = settings.provider === "tavily" || settings.provider === "exa";
  const supportsInlineExtraSnippets = settings.provider === "brave";
  const isDefault = collection.activeProfileId === settings.id;

  return (
    <div>
      <EditorHeader
        backLabel={isEn ? "Back to search connections" : "返回搜索连接"}
        onBack={backToList}
        title={settings.name}
        subtitle={`${providerLabel(settings.provider, isEn)}${isDefault ? (isEn ? " · Default" : " · 默认连接") : ""}`}
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
                { label: isEn ? "Clear key" : "清除 Key", icon: <Eraser size={12} />, onSelect: () => void clearKey(), disabled: !settings.apiKey },
                { label: isEn ? "Delete" : "删除连接", icon: <Trash2 size={12} />, onSelect: () => setConfirmDeleteProfileId(settings.id), danger: true },
              ]}
            />
          </>
        )}
      />

      <div className="space-y-2.5">
        {confirmDeleteProfileId === settings.id && (
          <ConfirmBar
            message={isEn ? `Delete “${settings.name}”? This does not affect other search connections.` : `确认删除“${settings.name}”？其他搜索连接不会受影响。`}
            confirmLabel={isEn ? "Delete" : "确认删除"}
            cancelLabel={isEn ? "Cancel" : "取消"}
            onCancel={() => setConfirmDeleteProfileId(null)}
            onConfirm={() => void deleteProfile()}
          />
        )}

        <SettingsSection title={isEn ? "Provider and key" : "服务商与 Key"}>
          <div className="grid grid-cols-2 gap-2">
            <Field label={isEn ? "Connection name" : "连接名称"}>
              <input aria-label={isEn ? "Search connection name" : "搜索连接名称"} className={CONTROL_CLASS} value={settings.name} onChange={(event) => update("name", event.target.value)} />
            </Field>
            <Field label={isEn ? "Search provider" : "搜索服务商"}>
              <SelectField ariaLabel={isEn ? "Search provider" : "搜索服务商"} value={settings.provider} onChange={(value) => selectProvider(value as ResearchExternalSearchProvider)}>
                {SEARCH_PROVIDERS.map((provider) => <option key={provider} value={provider}>{providerLabel(provider, isEn)}</option>)}
              </SelectField>
            </Field>
          </div>
          <Field label={isEn ? "Search API key" : "搜索 API Key"}>
            <div className="relative">
              <input aria-label={isEn ? "Search API key" : "搜索 API Key"} className={`${CONTROL_CLASS} pr-9`} type={showKey ? "text" : "password"} value={settings.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="off" spellCheck={false} placeholder={isEn ? "Paste your key" : "粘贴服务商提供的 Key"} />
              <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </Field>
          <Switch checked={settings.saveApiKey} onChange={(checked) => update("saveApiKey", checked)} label={isEn ? "Save search key on this device" : "在此设备保存搜索 Key"} description={isEn ? "Off keeps it for this browser session only." : "关闭时仅在本次浏览器会话中保留。"} />
        </SettingsSection>

        <SettingsSection title={isEn ? "Search budget" : "检索预算"}>
          <div className="grid grid-cols-2 gap-2">
            <Field label={isEn ? "Results per query" : "每次查询结果数"}>
              <SelectField ariaLabel={isEn ? "Results per query" : "每次查询结果数"} value={settings.maxResults} onChange={(value) => update("maxResults", Number(value))}>{maxResultOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField>
            </Field>
            <Field label={isEn ? "Sources kept per research" : "整次研究保留来源"}>
              <SelectField ariaLabel={isEn ? "Sources kept per research" : "整次研究保留来源"} value={settings.maxSources} onChange={(value) => updateProfile({ maxSources: Number(value), maxPages: Math.min(settings.maxPages, Number(value)) })}>{maxSourceOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField>
            </Field>
            <Field label={isEn ? "Time range" : "搜索时间范围"}>
              <SelectField ariaLabel={isEn ? "Time range" : "搜索时间范围"} value={settings.timeRange} onChange={(value) => update("timeRange", value as ResearchExternalSearchSettings["timeRange"])}><option value="any">{isEn ? "Any time" : "不限"}</option><option value="day">{isEn ? "Past day" : "近一天"}</option><option value="week">{isEn ? "Past week" : "近一周"}</option><option value="month">{isEn ? "Past month" : "近一月"}</option><option value="year">{isEn ? "Past year" : "近一年"}</option></SelectField>
            </Field>
            <Field label={isEn ? "Request timeout" : "请求超时"}>
              <SelectField ariaLabel={isEn ? "Request timeout" : "请求超时"} value={settings.requestTimeoutSeconds} onChange={(value) => update("requestTimeoutSeconds", Number(value))}>{[15, 30, 45, 60].map((value) => <option key={value} value={value}>{value}s</option>)}</SelectField>
            </Field>
          </div>
          <Notice>
            {isEn
              ? (settings.provider === "exa" || settings.provider === "custom" ? "Exa/custom APIs can request up to 100 results per query; Tavily and Brave officially cap one request at 20." : settings.provider === "volcengine_search" ? "Volcengine Search supports up to 50 results per query. It uses a separate search key, not the Agent Plan model key." : "Tavily and Brave officially cap one request at 20 results. The research source budget can still combine results from multiple queries.")
              : (settings.provider === "exa" || settings.provider === "custom" ? "Exa/自定义接口单次查询可配置到 100；Tavily 与 Brave 官方单次上限为 20。" : settings.provider === "volcengine_search" ? "方舟联网搜索单次最多返回 50 条结果；它使用独立搜索 Key，不是 Agent Plan 模型 Key。" : "Tavily 与 Brave 官方单次查询上限为 20；整次研究仍可合并多条查询，保留更多来源。")}
          </Notice>
        </SettingsSection>

        <SettingsSection title={isEn ? "Sources and content" : "来源与正文"}>
          {supportsDomainFilters ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label={isEn ? "Include domains" : "优先域名（可选）"}><input aria-label={isEn ? "Include domains" : "优先域名（可选）"} className={CONTROL_CLASS} value={settings.includeDomains} onChange={(event) => update("includeDomains", event.target.value)} placeholder="sec.gov, company.com" /></Field>
              <Field label={isEn ? "Exclude domains" : "排除域名（可选）"}><input aria-label={isEn ? "Exclude domains" : "排除域名（可选）"} className={CONTROL_CLASS} value={settings.excludeDomains} onChange={(event) => update("excludeDomains", event.target.value)} placeholder="example.com" /></Field>
            </div>
          ) : (
            <Notice tone="muted">
              {isEn
                ? "This provider adapter does not expose reliable include/exclude-domain fields, so domain filters are hidden instead of being silently ignored."
                : "当前服务商接口没有可稳定映射的域名白名单/黑名单字段，因此不展示无效选项，避免保存后被静默忽略。"}
            </Notice>
          )}
          {(supportsSeparateContentEnrichment || supportsInlineExtraSnippets) && (
            <Switch
              checked={settings.fetchPageContent}
              onChange={(checked) => update("fetchPageContent", checked)}
              label={supportsInlineExtraSnippets ? (isEn ? "Request extra search snippets" : "请求更多搜索摘要") : (isEn ? "Provider-side content enrichment" : "由搜索服务商增强正文")}
              description={supportsInlineExtraSnippets
                ? (isEn ? "Brave returns additional snippets in the same search response; it does not fetch third-party pages." : "Brave 会在同一次搜索响应中返回额外摘要，不会逐页抓取第三方网页。")
                : (isEn ? "Up to 50 retained sources can be enriched through the provider API. Larger source sets use shorter excerpts to stay within model context limits." : "最多可通过服务商 API 增强 50 个已保留来源；来源较多时会自动缩短单条摘录，避免挤爆模型上下文。")}
            />
          )}
          {supportsSeparateContentEnrichment && settings.fetchPageContent && (
            <Field label={isEn ? "Rich sources per research" : "整次研究增强来源"}>
              <SelectField ariaLabel={isEn ? "Rich sources per research" : "整次研究增强来源"} value={settings.maxPages} onChange={(value) => update("maxPages", Number(value))}>{maxPageOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField>
            </Field>
          )}
          {settings.provider === "volcengine_search" && <p className="text-[11px] leading-4 text-tmi">{isEn ? "Summary retrieval is always enabled and returned Summary/Content fields are used automatically." : "方舟联网搜索会固定请求摘要，并自动使用返回的 Summary/Content 字段，无需额外开启正文增强。"}</p>}
          {settings.provider === "custom" && <p className="text-[11px] leading-4 text-tmi">{isEn ? "Mapped snippet and full-content fields are consumed automatically when the API returns them." : "自定义接口返回后，会自动使用已映射的摘要与正文字段。"}</p>}
        </SettingsSection>

        <Disclosure title={isEn ? "Advanced" : "高级设置"} summary={settings.endpoint || (isEn ? "No endpoint" : "未填地址")} defaultOpen={settings.provider === "custom"}>
          <Field label={isEn ? "Search API endpoint" : "搜索 API 地址"}>
            <input aria-label={isEn ? "Search API endpoint" : "搜索 API 地址"} className={CONTROL_CLASS} value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://..." spellCheck={false} />
          </Field>
          {settings.provider === "custom" && (
            <>
              <p className="text-[11px] font-semibold text-ts">{isEn ? "Custom request and response mapping" : "自定义请求与响应映射"}</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label={isEn ? "Request method" : "请求方式"}><SelectField ariaLabel={isEn ? "Request method" : "请求方式"} value={settings.customRequestMethod || "POST"} onChange={(value) => update("customRequestMethod", value as "GET" | "POST")}><option value="POST">POST JSON</option><option value="GET">GET Query</option></SelectField></Field>
                <Field label={isEn ? "Results array path" : "结果数组路径"}><input className={CONTROL_CLASS} value={settings.customResultsPath || ""} onChange={(event) => update("customResultsPath", event.target.value)} placeholder="data.results" /></Field>
                <Field label={isEn ? "Query field" : "查询字段"}><input className={CONTROL_CLASS} value={settings.customQueryField || ""} onChange={(event) => update("customQueryField", event.target.value)} placeholder="query" /></Field>
                <Field label={isEn ? "Limit field" : "数量字段"}><input className={CONTROL_CLASS} value={settings.customLimitField || ""} onChange={(event) => update("customLimitField", event.target.value)} placeholder="max_results" /></Field>
                <Field label={isEn ? "Title path" : "标题路径"}><input className={CONTROL_CLASS} value={settings.customTitlePath || ""} onChange={(event) => update("customTitlePath", event.target.value)} placeholder="title" /></Field>
                <Field label={isEn ? "URL path" : "链接路径"}><input className={CONTROL_CLASS} value={settings.customUrlPath || ""} onChange={(event) => update("customUrlPath", event.target.value)} placeholder="url" /></Field>
                <Field label={isEn ? "Snippet path" : "摘要路径"}><input className={CONTROL_CLASS} value={settings.customSnippetPath || ""} onChange={(event) => update("customSnippetPath", event.target.value)} placeholder="snippet" /></Field>
                <Field label={isEn ? "Full content path" : "正文路径"}><input className={CONTROL_CLASS} value={settings.customContentPath || ""} onChange={(event) => update("customContentPath", event.target.value)} placeholder="content" /></Field>
                <Field label={isEn ? "Published-time path" : "发布时间路径"}><input className={CONTROL_CLASS} value={settings.customPublishedAtPath || ""} onChange={(event) => update("customPublishedAtPath", event.target.value)} placeholder="published_at" /></Field>
                <Field label={isEn ? "Auth header" : "鉴权 Header"}><input aria-label={isEn ? "Auth header" : "鉴权 Header"} className={CONTROL_CLASS} value={settings.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder="Authorization" /></Field>
                <Field label={isEn ? "Value prefix" : "值前缀"}><input aria-label={isEn ? "Value prefix" : "鉴权值前缀"} className={CONTROL_CLASS} value={settings.authHeaderPrefix} onChange={(event) => update("authHeaderPrefix", event.target.value)} placeholder="Bearer " /></Field>
              </div>
              <p className="text-[11px] leading-4 text-tmi">{isEn ? "Dot paths support nested JSON, for example data.web.results and metadata.publishedAt." : "字段路径支持点号读取嵌套 JSON，例如 data.web.results、metadata.publishedAt。"}</p>
            </>
          )}
        </Disclosure>

        <Notice tone="warn">{isEn ? "These budgets apply only to the independent external-search API. They never cap the model provider's native web searches or citations. Each connection keeps its own key, and portfolio quantities never enter queries." : "这里的数量预算只作用于独立外部搜索 API，不会限制大模型服务商原生联网的搜索次数或引用来源。每个连接独立保存 Key，持仓数量和成本不会进入查询。"}</Notice>
      </div>

      <StickyActions
        status={message
          ? <Feedback type={messageType} message={message} />
          : dirty ? <p className="flex items-center gap-1.5 text-[11px] text-tm"><UnsavedDot />{isEn ? "Unsaved changes" : "有未保存的修改"}</p> : undefined}
      >
        <button type="button" onClick={() => void test()} disabled={testing} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-card px-2 text-[12px] font-semibold text-ts disabled:opacity-60">{testing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}{isEn ? "Test search" : "测试搜索"}</button>
        <button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-app-accent px-2 text-[12px] font-semibold text-white disabled:opacity-60">{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}</button>
      </StickyActions>
    </div>
  );
}
