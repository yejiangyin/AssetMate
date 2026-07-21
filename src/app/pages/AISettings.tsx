import { ArrowLeft, Bot, Check, Database, Globe2, Loader2, PlugZap, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useApp } from "../context/AppContext";
import { ExternalSearchSettingsCard } from "../research/components/ExternalSearchSettingsCard";
import { ProviderSettingsCard } from "../research/components/ProviderSettingsCard";
import { VolcengineDataProMcpClient } from "../research/professionalData";
import { loadResearchExternalSearchProfiles, loadResearchProviderProfiles, subscribeResearchStorageChanges } from "../research/storage";
import type {
  ResearchExternalSearchCollection,
  ResearchExternalSearchSettings,
  ResearchProviderCollection,
  ResearchProviderSettings,
} from "../research/types";

type AISettingsTab = "models" | "search" | "data";

function validTab(value: string | null): AISettingsTab {
  return value === "search" || value === "data" ? value : "models";
}

function searchContentSummary(settings: ResearchExternalSearchSettings, isEn: boolean) {
  if (settings.provider === "volcengine_search") return isEn ? "summaries on" : "自动摘要";
  if (settings.provider === "custom") return isEn ? "mapped content" : "自动读取映射正文";
  if (settings.provider === "brave") return settings.fetchPageContent ? (isEn ? "extra snippets" : "更多摘要") : (isEn ? "standard snippets" : "标准摘要");
  return settings.fetchPageContent
    ? (isEn ? `${settings.maxPages} enriched` : `增强 ${settings.maxPages} 个`)
    : (isEn ? "snippets only" : "仅使用摘要");
}

export function AISettings() {
  const { tc, language } = useApp();
  const isEn = language === "en";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = validTab(params.get("tab"));
  const [providers, setProviders] = useState<ResearchProviderCollection | null>(null);
  const [searchProfiles, setSearchProfiles] = useState<ResearchExternalSearchCollection | null>(null);
  const [testingDataProfileId, setTestingDataProfileId] = useState<string | null>(null);
  const [dataTestMessage, setDataTestMessage] = useState("");
  const [dataTestError, setDataTestError] = useState(false);

  const reloadSummary = useCallback(async () => {
    const [providerCollection, externalCollection] = await Promise.all([
      loadResearchProviderProfiles(),
      loadResearchExternalSearchProfiles(),
    ]);
    setProviders(providerCollection);
    setSearchProfiles(externalCollection);
  }, []);

  useEffect(() => { void reloadSummary(); }, [reloadSummary]);
  useEffect(() => subscribeResearchStorageChanges(() => { void reloadSummary(); }), [reloadSummary]);

  const activeProvider = providers?.profiles.find((profile) => profile.id === providers.activeProfileId) ?? providers?.profiles[0];
  const activeSearch = searchProfiles?.profiles.find((profile) => profile.id === searchProfiles.activeProfileId) ?? searchProfiles?.profiles[0];
  const agentPlanProfiles = providers?.profiles.filter((profile) => profile.preset === "volcengine_agent_plan") ?? [];
  const activeDataProfile = agentPlanProfiles.find((profile) => profile.id === providers?.activeProfileId) ?? agentPlanProfiles[0];
  const selectTab = (next: AISettingsTab) => {
    setParams(next === "models" ? {} : { tab: next }, { replace: true });
  };
  const handleProviderSaved = (_settings: ResearchProviderSettings) => {
    void loadResearchProviderProfiles().then(setProviders);
  };
  const handleSearchSaved = (_settings: ResearchExternalSearchSettings) => {
    void loadResearchExternalSearchProfiles().then(setSearchProfiles);
  };
  const testProfessionalData = async (profile: ResearchProviderSettings) => {
    setTestingDataProfileId(profile.id);
    setDataTestMessage("");
    setDataTestError(false);
    try {
      const result = await new VolcengineDataProMcpClient(profile.apiKey, Math.min(30, profile.requestTimeoutSeconds)).test();
      setDataTestMessage(isEn ? `MCP verified · ${result.toolCount} tool(s)` : `MCP 已验证 · ${result.toolCount} 个工具`);
    } catch (error) {
      setDataTestError(true);
      setDataTestMessage(error instanceof Error ? error.message : (isEn ? "MCP test failed" : "MCP 测试失败"));
    } finally {
      setTestingDataProfileId(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: tc.bg }}>
      <header className="flex h-[50px] shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: tc.border, background: tc.bg }}>
        <button type="button" onClick={() => navigate("/settings")} className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: tc.bgCard, color: tc.textMuted }} aria-label={isEn ? "Back to settings" : "返回设置"}>
          <ArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold" style={{ color: tc.textPrimary }}>{isEn ? "AI research connections" : "AI 投研连接"}</p>
          <p className="truncate text-[12px]" style={{ color: tc.textMicro }}>{isEn ? "Models, web search and professional data stay under your control" : "统一管理模型、联网搜索与专业数据"}</p>
        </div>
        <div className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium" style={{ background: "rgba(49,208,139,0.1)", color: "#31D08B" }}>
          <ShieldCheck size={11} />{isEn ? "Local" : "本地直连"}
        </div>
      </header>

      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="grid grid-cols-3 gap-1 rounded-xl p-1" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }} role="tablist" aria-label={isEn ? "AI connection sections" : "AI 连接设置页签"}>
          {([
            { id: "models" as const, icon: Bot, zh: "大模型", en: "Models" },
            { id: "search" as const, icon: Globe2, zh: "联网搜索", en: "Web search" },
            { id: "data" as const, icon: Database, zh: "专业数据", en: "DataPro" },
          ]).map(({ id, icon: Icon, zh, en }) => {
            const active = tab === id;
            return (
              <button key={id} type="button" role="tab" aria-selected={active} onClick={() => selectTab(id)} className="flex h-9 items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold transition-colors" style={{ background: active ? "rgba(79,156,249,0.13)" : "transparent", color: active ? "#4F9CF9" : tc.textMuted }}>
                <Icon size={13} />{isEn ? en : zh}
              </button>
            );
          })}
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-5" style={{ scrollbarWidth: "none" }}>
        {tab === "models" ? (
          <div role="tabpanel" aria-label={isEn ? "Model connections" : "大模型连接"}>
            <section className="mb-2.5 flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(79,156,249,0.11)", color: "#4F9CF9" }}><PlugZap size={14} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold" style={{ color: tc.textPrimary }}>{isEn ? "Default API connection" : "默认 API 连接"}</p>
                <p className="mt-0.5 truncate text-[11px] leading-3" style={{ color: tc.textMicro }}>
                  {providers ? `${activeProvider?.name || (isEn ? "Not configured" : "未配置")} · ${providers.profiles.length} ${isEn ? "connection(s)" : "个连接"}${activeProvider?.model ? ` · ${activeProvider.model}` : ""}` : (isEn ? "Loading connections…" : "正在读取连接…")}
                </p>
              </div>
              <span className="rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9" }}>{isEn ? "Default" : "默认"}</span>
            </section>
            <p className="mb-2.5 rounded-xl px-3 py-2 text-[11px] leading-4" style={{ background: "rgba(79,156,249,0.08)", color: tc.textMuted }}>
              {isEn ? "The default is used only by research workflows set to “Follow default” and as a fallback. It does not overwrite workflow-specific model responsibilities." : "默认连接仅供选择“跟随默认”的研究模式使用，并作为回退连接；不会覆盖研究模式的专属调用分工。"}
            </p>
            <section className="rounded-xl p-3" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <ProviderSettingsCard language={language} compact includeExternalSearch={false} defaultExpanded={false} onSaved={handleProviderSaved} onOpenWebSearch={() => selectTab("search")} />
            </section>
          </div>
        ) : tab === "search" ? (
          <div role="tabpanel" aria-label={isEn ? "External web search" : "联网搜索"}>
            <section className="mb-2.5 flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(49,208,139,0.11)", color: "#31D08B" }}><Globe2 size={14} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold" style={{ color: tc.textPrimary }}>{isEn ? "Default search connection" : "默认搜索连接"}</p>
                <p className="mt-0.5 truncate text-[11px] leading-3" style={{ color: tc.textMicro }}>
                  {activeSearch
                    ? (isEn
                      ? `${activeSearch.name} · ${searchProfiles?.profiles.length ?? 1} connection(s) · ${activeSearch.maxSources} sources · ${searchContentSummary(activeSearch, true)}`
                      : `${activeSearch.name} · ${searchProfiles?.profiles.length ?? 1} 个连接 · ${activeSearch.maxSources} 个来源 · ${searchContentSummary(activeSearch, false)}`)
                    : (isEn ? "Fallback evidence when the model cannot browse" : "当大模型无法联网时提供带引用的搜索证据")}
                </p>
              </div>
              <span className="rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: activeSearch?.apiKey ? "rgba(49,208,139,0.1)" : "rgba(148,163,184,0.12)", color: activeSearch?.apiKey ? "#31D08B" : tc.textMicro }}>{activeSearch?.apiKey ? (isEn ? "Default" : "默认") : (isEn ? "No key" : "未配置 Key")}</span>
            </section>
            <section className="rounded-xl p-3" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <ExternalSearchSettingsCard language={language} defaultExpanded={false} onSaved={handleSearchSaved} />
            </section>
          </div>
        ) : (
          <div role="tabpanel" aria-label={isEn ? "Volcengine professional data" : "方舟专业数据"}>
            <section className="mb-2.5 flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(124,58,237,0.10)] text-[#7C3AED]"><Database size={14} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold" style={{ color: tc.textPrimary }}>{isEn ? "Agent Plan DataPro MCP" : "Agent Plan 专业数据集 MCP"}</p>
                <p className="mt-0.5 truncate text-[11px] leading-3" style={{ color: tc.textMicro }}>
                  {activeDataProfile
                    ? `${activeDataProfile.name} · ${activeDataProfile.apiKey ? (isEn ? "reuses Plan key" : "复用 Plan Key") : (isEn ? "key missing" : "未配置 Key")}`
                    : (isEn ? "No Agent Plan connection" : "暂无方舟 Agent Plan 连接")}
                </p>
              </div>
              <span className="rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: activeDataProfile?.apiKey ? "rgba(49,208,139,0.1)" : "rgba(148,163,184,0.12)", color: activeDataProfile?.apiKey ? "#31D08B" : tc.textMicro }}>
                {activeDataProfile?.apiKey ? (isEn ? "Automatic" : "自动接入") : (isEn ? "Unavailable" : "不可用")}
              </span>
            </section>

            <section className="rounded-xl p-3" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
              <p className="text-[13px] font-semibold" style={{ color: tc.textPrimary }}>{isEn ? "How it is routed" : "调用规则"}</p>
              <p className="mt-1.5 text-[11px] leading-4" style={{ color: tc.textMuted }}>
                {isEn
                  ? "Enabled automatically without another key. Research first reuses its routed Agent Plan connection; otherwise it uses the default or first available Agent Plan connection. DataPro failures fall back to market and web evidence."
                  : "无需新增 Key，研究会优先复用当前模式选中的方舟 Plan 连接；若执行模型不是方舟 Plan，则使用默认或首个可用的方舟 Plan 连接。专业数据失败只会降级到行情与联网证据，不会中断研究。"}
              </p>
              <div className="mt-3 space-y-2">
                {agentPlanProfiles.map((profile) => {
                  const active = profile.id === activeDataProfile?.id;
                  return (
                    <div key={profile.id} className="flex items-center gap-2 rounded-xl border px-2.5 py-2.5" style={{ borderColor: active ? "rgba(124,58,237,0.28)" : tc.border, background: active ? "rgba(124,58,237,0.05)" : tc.bgCard }}>
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(124,58,237,0.09)] text-[#7C3AED]"><Database size={14} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5"><p className="truncate text-[12px] font-semibold" style={{ color: tc.textPrimary }}>{profile.name}</p>{active && <span className="rounded bg-[rgba(124,58,237,0.1)] px-1.5 py-0.5 text-[10px] text-[#7C3AED]">{isEn ? "Fallback" : "当前回退"}</span>}</div>
                        <p className="mt-0.5 truncate text-[11px]" style={{ color: tc.textMicro }}>{profile.model || (isEn ? "No model" : "未选择模型")} · {profile.apiKey ? (isEn ? "Key ready" : "Key 已就绪") : (isEn ? "No key" : "未配置 Key")}</p>
                      </div>
                      <button type="button" onClick={() => void testProfessionalData(profile)} disabled={!profile.apiKey || testingDataProfileId !== null} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold disabled:opacity-40" style={{ borderColor: tc.border, color: tc.textMuted }} aria-label={isEn ? `Test DataPro with ${profile.name}` : `使用${profile.name}测试专业数据`}>
                        {testingDataProfileId === profile.id ? <Loader2 size={11} className="animate-spin" /> : <PlugZap size={11} />}{isEn ? "Test" : "测试"}
                      </button>
                    </div>
                  );
                })}
                {agentPlanProfiles.length === 0 && <div className="rounded-xl border border-dashed px-3 py-5 text-center text-[11px] leading-4" style={{ borderColor: tc.border, color: tc.textMicro }}>{isEn ? "Add a Volcengine Agent Plan connection in the Models tab first." : "请先在“大模型”页签新增方舟 Agent Plan 连接。"}</div>}
              </div>
              {dataTestMessage && <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4" style={{ color: dataTestError ? "#F24E4E" : "#31D08B" }}>{!dataTestError && <Check size={11} className="mt-0.5 shrink-0" />}<span>{dataTestMessage}</span></div>}
              <p className="mt-3 rounded-lg bg-[rgba(79,156,249,0.07)] px-2.5 py-2 text-[11px] leading-4" style={{ color: tc.textMuted }}>
                {isEn ? "DataPro routes each query to financial, corporate registry, risk or academic datasets. Security queries are batched at up to three targets per request, matching the official limit." : "DataPro 会把查询自动路由到金融、工商、企业风险或学术数据集。证券查询按官方限制自动拆分，每次最多 3 个标的。"}
              </p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
