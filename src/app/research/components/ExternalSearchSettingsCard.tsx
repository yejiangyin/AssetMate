import {
  Check,
  ChevronDown,
  CopyPlus,
  Eraser,
  Eye,
  EyeOff,
  Globe2,
  Loader2,
  Plus,
  Save,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

const CONTROL_CLASS = "min-h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[12px] leading-4 text-tp outline-none transition-colors placeholder:text-tmi focus:border-app-accent focus:ring-2 focus:ring-[rgba(79,156,249,0.12)]";
const LABEL_CLASS = "mb-1 block text-[11px] font-medium leading-4 text-tm";

function SelectField({ value, onChange, children, ariaLabel }: { value: string | number; onChange: (value: string) => void; children: ReactNode; ariaLabel: string }) {
  return (
    <div className="relative min-w-0">
      <select aria-label={ariaLabel} className={`${CONTROL_CLASS} appearance-none truncate pr-8`} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" />
    </div>
  );
}

function providerLabel(provider: ResearchExternalSearchProvider, isEn: boolean) {
  return ({
    tavily: "Tavily",
    brave: "Brave Search",
    exa: "Exa",
    volcengine_search: isEn ? "Volcengine Search" : "方舟联网搜索",
    custom: isEn ? "Custom search API" : "自定义搜索 API",
  })[provider];
}

export function ExternalSearchSettingsCard({
  language,
  onSaved,
  defaultExpanded = false,
}: {
  language: "zh" | "en";
  onSaved?: (settings: ResearchExternalSearchSettings) => void;
  defaultExpanded?: boolean;
}) {
  const isEn = language === "en";
  const [collection, setCollection] = useState<ResearchExternalSearchCollection | null>(null);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);
  const hasUnsavedChangesRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadResearchExternalSearchProfiles().then((value) => {
      if (cancelled) return;
      hasUnsavedChangesRef.current = false;
      setCollection(value);
      setExpandedProfileId(defaultExpanded ? value.activeProfileId : null);
    });
    return () => { cancelled = true; };
  }, [defaultExpanded]);

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
    hasUnsavedChangesRef.current = true;
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

  const selectProvider = (provider: ResearchExternalSearchProvider) => {
    if (!settings) return;
    const preset = externalSearchPresetDefaults(provider);
    const previousDefaultNames = [providerLabel(settings.provider, false), providerLabel(settings.provider, true)];
    updateProfile({
      provider,
      name: previousDefaultNames.includes(settings.name) ? providerLabel(provider, isEn) : settings.name,
      endpoint: preset.endpoint,
      authHeaderName: preset.authHeaderName,
      authHeaderPrefix: preset.authHeaderPrefix,
      maxResults: provider === "tavily" || provider === "brave"
        ? Math.min(settings.maxResults, 20)
        : provider === "volcengine_search" ? Math.min(settings.maxResults, 50) : settings.maxResults,
    });
  };

  const toggleProfile = (profileId: string) => {
    setExpandedProfileId((current) => current === profileId ? null : profileId);
    setShowKey(false);
    setMessage("");
  };

  const activate = async (profileId: string) => {
    if (!collection || collection.activeProfileId === profileId) return;
    hasUnsavedChangesRef.current = true;
    const next = { ...collection, activeProfileId: profileId };
    setCollection(next);
    setExpandedProfileId(profileId);
    await saveResearchExternalSearchProfiles(next);
    hasUnsavedChangesRef.current = false;
    const active = next.profiles.find((profile) => profile.id === profileId);
    if (active) {
      setMessageType("success");
      setMessage(isEn ? `${active.name} is now the default search connection` : `已将“${active.name}”设为默认搜索连接`);
      onSaved?.(active);
    }
  };

  const addProfile = () => {
    if (!collection) return;
    hasUnsavedChangesRef.current = true;
    const profile = createResearchExternalSearchProfile({ name: isEn ? `Search ${collection.profiles.length + 1}` : `搜索连接 ${collection.profiles.length + 1}` });
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    setExpandedProfileId(profile.id);
    setMessage("");
  };

  const duplicateProfile = () => {
    if (!collection || !settings) return;
    hasUnsavedChangesRef.current = true;
    const profile = createResearchExternalSearchProfile({
      ...settings,
      id: undefined,
      name: `${settings.name} ${isEn ? "Copy" : "副本"}`,
      apiKey: "",
      saveApiKey: false,
    });
    setCollection({ ...collection, profiles: [...collection.profiles, profile] });
    setExpandedProfileId(profile.id);
    setMessage("");
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
    await saveResearchExternalSearchProfiles(next);
    hasUnsavedChangesRef.current = false;
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
      hasUnsavedChangesRef.current = false;
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

  const maxResultOptions = settings.provider === "exa" || settings.provider === "custom"
    ? [5, 8, 10, 15, 20, 30, 50, 75, 100]
    : settings.provider === "volcengine_search" ? [5, 8, 10, 15, 20, 30, 50] : [5, 8, 10, 15, 20];
  const maxSourceOptions = [10, 15, 20, 25, 30, 40, 50, 75, 100];
  const maxPageOptions = [1, 2, 3, 5, 8, 10, 12, 15, 20, 30, 50].filter((value) => value <= settings.maxSources);
  const supportsDomainFilters = settings.provider === "tavily" || settings.provider === "exa" || settings.provider === "custom";
  const supportsSeparateContentEnrichment = settings.provider === "tavily" || settings.provider === "exa";
  const supportsInlineExtraSnippets = settings.provider === "brave";

  return (
    <section aria-label={isEn ? "Search connection list" : "搜索连接列表"}>
      <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-ts">{isEn ? "Search connection list" : "搜索连接列表"}</p>
          <p className="mt-0.5 text-[11px] leading-3 text-tmi">{collection.profiles.length} {isEn ? "connection(s) · expand to edit, or set one as the default" : "个连接 · 展开编辑，或将某个连接设为默认"}</p>
        </div>
        <button type="button" onClick={addProfile} className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-app-accent px-2.5 text-[12px] font-semibold text-white" aria-label={isEn ? "Add search connection" : "新增搜索连接"}><Plus size={12} />{isEn ? "Add" : "新增连接"}</button>
      </div>

      <div className="space-y-2">
        {collection.profiles.map((profile) => {
          const expanded = expandedProfileId === profile.id;
          const active = collection.activeProfileId === profile.id;
          return (
            <article key={profile.id} className={`overflow-hidden rounded-xl border transition-colors ${active ? "border-[#31D08B]/30 bg-[rgba(49,208,139,0.04)]" : "border-app-border bg-app-surface"}`}>
              <div className="flex items-stretch">
                <button type="button" aria-expanded={expanded} aria-controls={`search-editor-${profile.id}`} onClick={() => toggleProfile(profile.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-[rgba(49,208,139,0.12)] text-[#31D08B]" : "bg-app-card text-tm"}`}><Globe2 size={14} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-tp">{profile.name}</span>
                      {active && <span className="shrink-0 rounded-full bg-[rgba(49,208,139,0.12)] px-1.5 py-0.5 text-[11px] font-medium text-[#31A777]">{isEn ? "Default" : "默认连接"}</span>}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-3 text-tmi">{providerLabel(profile.provider, isEn)} · {profile.apiKey ? (isEn ? "Key ready" : "已配置 Key") : (isEn ? "No key" : "未配置 Key")} · {profile.maxSources} {isEn ? "sources" : "个来源"}</p>
                  </div>
                  <ChevronDown size={14} className={`shrink-0 text-tmi transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                {!active && <button type="button" onClick={() => void activate(profile.id)} className="my-2 mr-2 shrink-0 rounded-lg border border-[#31D08B]/25 bg-[rgba(49,208,139,0.08)] px-2 text-[11px] font-semibold text-[#31A777]" aria-label={isEn ? `Set ${profile.name} as default` : `将${profile.name}设为默认连接`}>{isEn ? "Set default" : "设为默认"}</button>}
              </div>

              {expanded && profile.id === settings.id && (
                <div id={`search-editor-${profile.id}`} className="border-t border-app-border bg-app-card px-2.5 pb-2.5 pt-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-[12px] font-medium text-tm">{isEn ? "Connection details" : "连接详情"}</p>
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={duplicateProfile} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-tm" aria-label={isEn ? "Duplicate search connection" : "复制搜索连接"}><CopyPlus size={11} />{isEn ? "Duplicate" : "复制"}</button>
                      <button type="button" onClick={() => void clearKey()} disabled={!settings.apiKey} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-tm disabled:opacity-40" aria-label={isEn ? "Clear search key" : "清除搜索 Key"}><Eraser size={11} />{isEn ? "Clear key" : "清除 Key"}</button>
                      <button type="button" onClick={() => setConfirmDeleteProfileId(settings.id)} className="flex h-7 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[12px] text-[#F24E4E]" aria-label={isEn ? "Delete search connection" : "删除搜索连接"}><Trash2 size={11} />{isEn ? "Delete" : "删除"}</button>
                    </div>
                  </div>
                  {confirmDeleteProfileId === settings.id && (
                    <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#F24E4E]/20 bg-[rgba(242,78,78,0.07)] px-2.5 py-2">
                      <p className="min-w-0 flex-1 text-[11px] leading-4 text-[#D94A4A]">{isEn ? `Delete “${settings.name}”? This does not affect other search connections.` : `确认删除“${settings.name}”？其他搜索连接不会受影响。`}</p>
                      <button type="button" onClick={() => setConfirmDeleteProfileId(null)} className="rounded-lg px-2 py-1 text-[11px] text-tm">{isEn ? "Cancel" : "取消"}</button>
                      <button type="button" onClick={() => void deleteProfile()} className="rounded-lg bg-[#F24E4E] px-2 py-1 text-[11px] font-semibold text-white">{isEn ? "Delete" : "确认删除"}</button>
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Connection name" : "连接名称"}</span><input aria-label={isEn ? "Search connection name" : "搜索连接名称"} className={CONTROL_CLASS} value={settings.name} onChange={(event) => update("name", event.target.value)} /></label>
                      <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Search provider" : "搜索服务商"}</span><SelectField ariaLabel={isEn ? "Search provider" : "搜索服务商"} value={settings.provider} onChange={(value) => selectProvider(value as ResearchExternalSearchProvider)}><option value="tavily">Tavily</option><option value="brave">Brave Search</option><option value="exa">Exa</option><option value="volcengine_search">{isEn ? "Volcengine Search" : "方舟联网搜索"}</option><option value="custom">{isEn ? "Custom search API" : "自定义搜索 API"}</option></SelectField></label>
                    </div>

                    <label className="block min-w-0"><span className={LABEL_CLASS}>{isEn ? "Search API endpoint" : "搜索 API 地址"}</span><input aria-label={isEn ? "Search API endpoint" : "搜索 API 地址"} className={CONTROL_CLASS} value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://..." spellCheck={false} /></label>

                    <label className="block min-w-0"><span className={LABEL_CLASS}>{isEn ? "Search API key" : "搜索 API Key"}</span><div className="relative"><input aria-label={isEn ? "Search API key" : "搜索 API Key"} className={`${CONTROL_CLASS} pr-9`} type={showKey ? "text" : "password"} value={settings.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>

                    {settings.provider === "custom" && (
                      <div className="space-y-2 rounded-xl border border-app-border bg-app-surface p-2.5">
                        <p className="text-[11px] font-semibold text-ts">{isEn ? "Custom request and response mapping" : "自定义请求与响应映射"}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Request method" : "请求方式"}</span><SelectField ariaLabel={isEn ? "Request method" : "请求方式"} value={settings.customRequestMethod || "POST"} onChange={(value) => update("customRequestMethod", value as "GET" | "POST")}><option value="POST">POST JSON</option><option value="GET">GET Query</option></SelectField></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Results array path" : "结果数组路径"}</span><input className={CONTROL_CLASS} value={settings.customResultsPath || ""} onChange={(event) => update("customResultsPath", event.target.value)} placeholder="data.results" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Query field" : "查询字段"}</span><input className={CONTROL_CLASS} value={settings.customQueryField || ""} onChange={(event) => update("customQueryField", event.target.value)} placeholder="query" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Limit field" : "数量字段"}</span><input className={CONTROL_CLASS} value={settings.customLimitField || ""} onChange={(event) => update("customLimitField", event.target.value)} placeholder="max_results" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Title path" : "标题路径"}</span><input className={CONTROL_CLASS} value={settings.customTitlePath || ""} onChange={(event) => update("customTitlePath", event.target.value)} placeholder="title" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "URL path" : "链接路径"}</span><input className={CONTROL_CLASS} value={settings.customUrlPath || ""} onChange={(event) => update("customUrlPath", event.target.value)} placeholder="url" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Snippet path" : "摘要路径"}</span><input className={CONTROL_CLASS} value={settings.customSnippetPath || ""} onChange={(event) => update("customSnippetPath", event.target.value)} placeholder="snippet" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Full content path" : "正文路径"}</span><input className={CONTROL_CLASS} value={settings.customContentPath || ""} onChange={(event) => update("customContentPath", event.target.value)} placeholder="content" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Published-time path" : "发布时间路径"}</span><input className={CONTROL_CLASS} value={settings.customPublishedAtPath || ""} onChange={(event) => update("customPublishedAtPath", event.target.value)} placeholder="published_at" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Auth header" : "鉴权 Header"}</span><input aria-label={isEn ? "Auth header" : "鉴权 Header"} className={CONTROL_CLASS} value={settings.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder="Authorization" /></label>
                          <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Value prefix" : "值前缀"}</span><input aria-label={isEn ? "Value prefix" : "鉴权值前缀"} className={CONTROL_CLASS} value={settings.authHeaderPrefix} onChange={(event) => update("authHeaderPrefix", event.target.value)} placeholder="Bearer " /></label>
                        </div>
                        <p className="text-[12px] leading-4 text-tmi">{isEn ? "Dot paths support nested JSON, for example data.web.results and metadata.publishedAt." : "字段路径支持点号读取嵌套 JSON，例如 data.web.results、metadata.publishedAt。"}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Time range" : "搜索时间范围"}</span><SelectField ariaLabel={isEn ? "Time range" : "搜索时间范围"} value={settings.timeRange} onChange={(value) => update("timeRange", value as ResearchExternalSearchSettings["timeRange"])}><option value="any">{isEn ? "Any time" : "不限"}</option><option value="day">{isEn ? "Past day" : "近一天"}</option><option value="week">{isEn ? "Past week" : "近一周"}</option><option value="month">{isEn ? "Past month" : "近一月"}</option><option value="year">{isEn ? "Past year" : "近一年"}</option></SelectField></label>
                      <label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Request timeout" : "请求超时"}</span><SelectField ariaLabel={isEn ? "Request timeout" : "请求超时"} value={settings.requestTimeoutSeconds} onChange={(value) => update("requestTimeoutSeconds", Number(value))}>{[15, 30, 45, 60].map((value) => <option key={value} value={value}>{value}s</option>)}</SelectField></label>
                    </div>

                    <div className="grid grid-cols-2 gap-2"><label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Results per query" : "每次查询结果数"}</span><SelectField ariaLabel={isEn ? "Results per query" : "每次查询结果数"} value={settings.maxResults} onChange={(value) => update("maxResults", Number(value))}>{maxResultOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField></label><label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Sources kept per research" : "整次研究保留来源"}</span><SelectField ariaLabel={isEn ? "Sources kept per research" : "整次研究保留来源"} value={settings.maxSources} onChange={(value) => updateProfile({ maxSources: Number(value), maxPages: Math.min(settings.maxPages, Number(value)) })}>{maxSourceOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField></label></div>
                    <p className="rounded-lg bg-[rgba(79,156,249,0.07)] px-2.5 py-2 text-[12px] leading-4 text-tm">
                      {isEn
                        ? (settings.provider === "exa" || settings.provider === "custom" ? "Exa/custom APIs can request up to 100 results per query; Tavily and Brave officially cap one request at 20." : settings.provider === "volcengine_search" ? "Volcengine Search supports up to 50 results per query. It uses a separate search key, not the Agent Plan model key." : "Tavily and Brave officially cap one request at 20 results. The research source budget can still combine results from multiple queries.")
                        : (settings.provider === "exa" || settings.provider === "custom" ? "Exa/自定义接口单次查询可配置到 100；Tavily 与 Brave 官方单次上限为 20。" : settings.provider === "volcengine_search" ? "方舟联网搜索单次最多返回 50 条结果；它使用独立搜索 Key，不是 Agent Plan 模型 Key。" : "Tavily 与 Brave 官方单次查询上限为 20；整次研究仍可合并多条查询，保留更多来源。")}
                    </p>

                    {supportsDomainFilters ? (
                      <div className="grid grid-cols-2 gap-2"><label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Include domains" : "优先域名（可选）"}</span><input aria-label={isEn ? "Include domains" : "优先域名（可选）"} className={CONTROL_CLASS} value={settings.includeDomains} onChange={(event) => update("includeDomains", event.target.value)} placeholder="sec.gov, company.com" /></label><label className="min-w-0"><span className={LABEL_CLASS}>{isEn ? "Exclude domains" : "排除域名（可选）"}</span><input aria-label={isEn ? "Exclude domains" : "排除域名（可选）"} className={CONTROL_CLASS} value={settings.excludeDomains} onChange={(event) => update("excludeDomains", event.target.value)} placeholder="example.com" /></label></div>
                    ) : (
                      <p className="rounded-lg border border-app-border bg-app-surface px-2.5 py-2 text-[12px] leading-4 text-tmi">
                        {isEn
                          ? "This provider adapter does not expose reliable include/exclude-domain fields, so domain filters are hidden instead of being silently ignored."
                          : "当前服务商接口没有可稳定映射的域名白名单/黑名单字段，因此不展示无效选项，避免保存后被静默忽略。"}
                      </p>
                    )}

                    <div className="space-y-2 rounded-xl bg-app-surface px-2.5 py-2.5">
                      {(supportsSeparateContentEnrichment || supportsInlineExtraSnippets) && (
                        <label className="flex min-h-5 cursor-pointer items-center justify-between gap-3 text-[11px] text-ts"><span>{supportsInlineExtraSnippets ? (isEn ? "Request extra search snippets" : "请求更多搜索摘要") : (isEn ? "Provider-side content enrichment" : "由搜索服务商增强正文")}</span><input type="checkbox" checked={settings.fetchPageContent} onChange={(event) => update("fetchPageContent", event.target.checked)} /></label>
                      )}
                      {supportsSeparateContentEnrichment && settings.fetchPageContent && <><label className="flex items-center justify-between gap-3 text-[11px] text-ts"><span>{isEn ? "Rich sources per research" : "整次研究增强来源"}</span><SelectField ariaLabel={isEn ? "Rich sources per research" : "整次研究增强来源"} value={settings.maxPages} onChange={(value) => update("maxPages", Number(value))}>{maxPageOptions.map((value) => <option key={value} value={value}>{value}</option>)}</SelectField></label><p className="text-[12px] leading-4 text-tmi">{isEn ? "Up to 50 retained sources can be enriched through the provider API. Larger source sets use shorter excerpts to stay within model context limits." : "最多可通过服务商 API 增强 50 个已保留来源；来源较多时会自动缩短单条摘录，避免挤爆模型上下文。"}</p></>}
                      {supportsInlineExtraSnippets && settings.fetchPageContent && <p className="text-[12px] leading-4 text-tmi">{isEn ? "Brave returns additional snippets in the same search response; it does not fetch third-party pages." : "Brave 会在同一次搜索响应中返回额外摘要，不会逐页抓取第三方网页。"}</p>}
                      {settings.provider === "volcengine_search" && <p className="text-[12px] leading-4 text-tmi">{isEn ? "Summary retrieval is always enabled and returned Summary/Content fields are used automatically." : "方舟联网搜索会固定请求摘要，并自动使用返回的 Summary/Content 字段，无需额外开启正文增强。"}</p>}
                      {settings.provider === "custom" && <p className="text-[12px] leading-4 text-tmi">{isEn ? "Mapped snippet and full-content fields are consumed automatically when the API returns them." : "自定义接口返回后，会自动使用已映射的摘要与正文字段。"}</p>}
                      <label className="flex min-h-5 cursor-pointer items-center justify-between gap-3 text-[11px] text-ts"><span>{isEn ? "Save search key on this device" : "在此设备保存搜索 Key"}</span><input type="checkbox" checked={settings.saveApiKey} onChange={(event) => update("saveApiKey", event.target.checked)} /></label>
                    </div>

                    <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => void test()} disabled={testing} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-ts disabled:opacity-60">{testing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}{isEn ? "Test search" : "测试搜索"}</button><button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-app-accent px-2 text-[11px] font-semibold text-white disabled:opacity-60">{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{isEn ? "Save all" : "保存全部"}</button></div>

                    <div className="flex items-start gap-2 rounded-lg bg-[rgba(245,158,11,0.08)] px-2.5 py-2 text-[12px] leading-4 text-tm"><ShieldAlert size={12} className="mt-0.5 shrink-0 text-[#F59E0B]" /><span>{isEn ? "These budgets apply only to the independent external-search API. They never cap the model provider's native web searches or citations. Each connection keeps its own key, and portfolio quantities never enter queries." : "这里的数量预算只作用于独立外部搜索 API，不会限制大模型服务商原生联网的搜索次数或引用来源。每个连接独立保存 Key，持仓数量和成本不会进入查询。"}</span></div>
                    {message && <div className="flex items-start gap-1.5 text-[11px] leading-4" style={{ color: messageType === "success" ? "#31D08B" : "#F24E4E" }}>{messageType === "success" && <Check size={11} className="mt-0.5 shrink-0" />}<span>{message}</span></div>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
