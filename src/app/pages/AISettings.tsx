import { ArrowLeft, Bot, Database, Globe2, Loader2, PlugZap, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useApp } from "../context/AppContext";
import { ExternalSearchSettingsCard } from "../research/components/ExternalSearchSettingsCard";
import { ProviderSettingsCard, type ConnectionView } from "../research/components/ProviderSettingsCard";
import { Feedback, Monogram, Notice, SettingsSection, StatusPill } from "../research/components/settingsUi";
import { VolcengineDataProMcpClient } from "../research/professionalData";
import { loadResearchProviderProfiles, subscribeResearchStorageChanges } from "../research/storage";
import type { ResearchProviderCollection, ResearchProviderSettings } from "../research/types";

type AISettingsTab = "models" | "search" | "data";

function validTab(value: string | null): AISettingsTab {
  return value === "search" || value === "data" ? value : "models";
}

const TABS = [
  { id: "models" as const, icon: Bot, zh: "大模型", en: "Models" },
  { id: "search" as const, icon: Globe2, zh: "联网搜索", en: "Web search" },
  { id: "data" as const, icon: Database, zh: "专业数据", en: "DataPro" },
];

function DataProPanel({ isEn, providers }: { isEn: boolean; providers: ResearchProviderCollection | null }) {
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  const agentPlanProfiles = providers?.profiles.filter((profile) => profile.preset === "volcengine_agent_plan") ?? [];
  const fallbackProfile = agentPlanProfiles.find((profile) => profile.id === providers?.activeProfileId) ?? agentPlanProfiles[0];

  const test = async (profile: ResearchProviderSettings) => {
    setTestingProfileId(profile.id);
    setMessage("");
    try {
      const result = await new VolcengineDataProMcpClient(profile.apiKey, Math.min(30, profile.requestTimeoutSeconds)).test();
      setMessageType("success");
      setMessage(isEn ? `MCP verified · ${result.toolCount} tool(s)` : `MCP 已验证 · ${result.toolCount} 个工具`);
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : (isEn ? "MCP test failed" : "MCP 测试失败"));
    } finally {
      setTestingProfileId(null);
    }
  };

  if (!providers) return <div className="flex items-center justify-center py-8 text-tm"><Loader2 size={16} className="animate-spin" /></div>;

  return (
    <div className="space-y-2.5">
      <div className="px-0.5">
        <p className="text-[12px] font-semibold text-tp">{isEn ? "Agent Plan DataPro MCP" : "Agent Plan 专业数据集 MCP"}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-tmi">
          {isEn
            ? "Enabled automatically without another key. Research first reuses its routed Agent Plan connection; otherwise it uses the default or first available Agent Plan connection. DataPro failures fall back to market and web evidence."
            : "无需新增 Key，研究会优先复用当前模式选中的方舟 Plan 连接；若执行模型不是方舟 Plan，则使用默认或首个可用的方舟 Plan 连接。专业数据失败只会降级到行情与联网证据，不会中断研究。"}
        </p>
      </div>

      <SettingsSection
        title={isEn ? "Agent Plan connections" : "方舟 Plan 连接"}
        description={isEn ? "Reuses the model connection's key" : "复用模型连接的 Key"}
        action={(
          <StatusPill tone={fallbackProfile?.apiKey ? "ok" : "muted"}>
            {fallbackProfile?.apiKey ? (isEn ? "Automatic" : "自动接入") : (isEn ? "Unavailable" : "不可用")}
          </StatusPill>
        )}
      >
        {agentPlanProfiles.length ? (
          <div className="space-y-1.5">
            {agentPlanProfiles.map((profile) => {
              const isFallback = profile.id === fallbackProfile?.id;
              return (
                <div key={profile.id} className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2.5 ${isFallback ? "border-[rgba(124,58,237,0.28)] bg-[rgba(124,58,237,0.04)]" : "border-app-border bg-app-card"}`}>
                  <Monogram label={profile.name} tone="violet" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-tp">{profile.name}</span>
                      {isFallback && <StatusPill tone="accent">{isEn ? "Fallback" : "当前回退"}</StatusPill>}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">
                      {profile.model || (isEn ? "No model" : "未选择模型")} · {profile.apiKey ? (isEn ? "Key ready" : "Key 已就绪") : (isEn ? "No key" : "未配置 Key")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void test(profile)}
                    disabled={!profile.apiKey || testingProfileId !== null}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 text-[11px] font-semibold text-tm disabled:opacity-40"
                    aria-label={isEn ? `Test DataPro with ${profile.name}` : `使用${profile.name}测试专业数据`}
                  >
                    {testingProfileId === profile.id ? <Loader2 size={11} className="animate-spin" /> : <PlugZap size={11} />}{isEn ? "Test" : "测试"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-app-border px-3 py-5 text-center text-[11px] leading-4 text-tmi">
            {isEn ? "Add a Volcengine Agent Plan connection in the Models tab first." : "请先在“大模型”页签新增方舟 Agent Plan 连接。"}
          </div>
        )}
        <Feedback type={messageType} message={message} />
      </SettingsSection>

      <Notice>
        {isEn
          ? "DataPro routes each query to financial, corporate registry, risk or academic datasets. Security queries are batched at up to three targets per request, matching the official limit."
          : "DataPro 会把查询自动路由到金融、工商、企业风险或学术数据集。证券查询按官方限制自动拆分，每次最多 3 个标的。"}
      </Notice>
    </div>
  );
}

export function AISettings() {
  const { language } = useApp();
  const isEn = language === "en";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = validTab(params.get("tab"));
  const [providers, setProviders] = useState<ResearchProviderCollection | null>(null);
  // Remembers which tab the drill-in view belongs to, so leaving the tab resets it.
  const [connectionView, setConnectionView] = useState<{ tab: AISettingsTab; view: ConnectionView }>({ tab, view: "list" });
  const view = connectionView.tab === tab ? connectionView.view : "list";
  const mainRef = useRef<HTMLElement>(null);

  const reloadProviders = useCallback(async () => {
    setProviders(await loadResearchProviderProfiles());
  }, []);

  useEffect(() => { void reloadProviders(); }, [reloadProviders]);
  useEffect(() => subscribeResearchStorageChanges(() => { void reloadProviders(); }), [reloadProviders]);

  const selectTab = (next: AISettingsTab) => {
    setConnectionView({ tab: next, view: "list" });
    setParams(next === "models" ? {} : { tab: next }, { replace: true });
  };

  const handleViewChange = (next: ConnectionView) => {
    setConnectionView({ tab, view: next });
    mainRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg">
      {/* A picker/editor pins its own header as the top bar, so only one back button shows. */}
      {view === "list" && (
        <>
          <header className="flex h-[50px] shrink-0 items-center gap-2 border-b border-app-border bg-app-bg px-3">
            <button type="button" onClick={() => navigate("/settings")} className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-card text-tm" aria-label={isEn ? "Back to settings" : "返回设置"}>
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold text-tp">{isEn ? "AI research connections" : "AI 投研连接"}</p>
              <p className="truncate text-[12px] text-tmi">{isEn ? "Models, web search and professional data stay under your control" : "统一管理模型、联网搜索与专业数据"}</p>
            </div>
            <div className="flex items-center gap-1 rounded-full bg-[rgba(49,208,139,0.1)] px-2 py-1 text-[12px] font-medium text-[#31D08B]">
              <ShieldCheck size={11} />{isEn ? "Local" : "本地直连"}
            </div>
          </header>

          <div className="shrink-0 px-3 pb-1 pt-3">
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-app-border bg-app-card p-1" role="tablist" aria-label={isEn ? "AI connection sections" : "AI 连接设置页签"}>
              {TABS.map(({ id, icon: Icon, zh, en }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => selectTab(id)}
                    className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold transition-colors ${active ? "bg-[rgba(79,156,249,0.13)] text-app-accent" : "text-tm"}`}
                  >
                    <Icon size={13} />{isEn ? en : zh}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2" style={{ scrollbarWidth: "none" }}>
        {tab === "models" ? (
          <div role="tabpanel" aria-label={isEn ? "Model connections" : "大模型连接"}>
            <ProviderSettingsCard
              language={language}
              onSaved={() => void reloadProviders()}
              onOpenWebSearch={() => selectTab("search")}
              onViewChange={handleViewChange}
            />
          </div>
        ) : tab === "search" ? (
          <div role="tabpanel" aria-label={isEn ? "External web search" : "联网搜索"}>
            <ExternalSearchSettingsCard language={language} onViewChange={handleViewChange} />
          </div>
        ) : (
          <div role="tabpanel" aria-label={isEn ? "Volcengine professional data" : "方舟专业数据"}>
            <DataProPanel isEn={isEn} providers={providers} />
          </div>
        )}
      </main>
    </div>
  );
}
