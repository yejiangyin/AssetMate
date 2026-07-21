import { ArrowLeft, Bot, Calculator, Download, ExternalLink, FileDown, FileText, Globe2, Layers, ShieldCheck, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, type ReactNode } from "react";
import { downloadFullResearchReport, downloadResearchReportSection } from "../reportDownload";
import { classifyResearchEmphasis, isKeyFigureText, RESEARCH_EMPHASIS_COLORS } from "../reportEmphasis";
import type { BacktestSeed, ResearchReport } from "../types";

function auditColor(status: ResearchReport["audit"]["status"]) {
  if (status === "verified") return "#31D08B";
  if (status === "partial") return "#F59E0B";
  if (status === "failed") return "#F24E4E";
  return "#94A3B8";
}

function extractText(children: unknown): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function emphasisColor(text: string): string | null {
  const emphasis = classifyResearchEmphasis(text);
  return emphasis === "neutral" ? null : RESEARCH_EMPHASIS_COLORS[emphasis];
}

// Hoisted to module level so ReactMarkdown doesn't re-render the full tree
// on every parent update. All renderers only reference module-level symbols.
const RESEARCH_REMARK_PLUGINS = [remarkGfm];
const RESEARCH_MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => <a href={href} target="_blank" rel="noreferrer" className="text-app-accent underline underline-offset-2">{children}<ExternalLink size={9} className="ml-0.5 inline" /></a>,
  h1: ({ children }: { children?: ReactNode }) => <h1 className="mb-4 mt-1 text-lg font-bold leading-7 text-tp">{children}</h1>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="mb-3 mt-6 border-b border-app-border pb-2 text-[15px] font-bold leading-6 text-tp">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="mb-2 mt-4 text-[14px] font-bold leading-5 text-tp">{children}</h3>,
  p: ({ children }: { children?: ReactNode }) => <p className="my-2 text-ts">{children}</p>,
  strong: ({ children }: { children?: ReactNode }) => {
    const text = extractText(children).trim();
    const accent = text.length <= 48 ? emphasisColor(text) : null;
    if (accent) return <strong className="rounded px-1 py-0.5 font-bold" style={{ background: `${accent}12`, color: accent }}>{children}</strong>;
    if (isKeyFigureText(text)) return <strong className="font-extrabold tabular-nums text-app-accent">{children}</strong>;
    return <strong className="font-bold text-tp">{children}</strong>;
  },
  table: ({ children }: { children?: ReactNode }) => <div className="my-3 overflow-x-auto rounded-lg border border-app-border"><table className="w-full min-w-[360px] border-collapse text-[12px] leading-[1.6]">{children}</table></div>,
  th: ({ children }: { children?: ReactNode }) => <th className="border border-app-border bg-app-surface px-2 py-1.5 text-left text-tp">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="border border-app-border px-2 py-1.5 align-top">{children}</td>,
  blockquote: ({ children }: { children?: ReactNode }) => {
    const accent = emphasisColor(extractText(children).slice(0, 80)) || "#4F9CF9";
    return <blockquote className="my-3 rounded-r-lg px-3 py-2 text-tm" style={{ borderLeft: `3px solid ${accent}`, background: `${accent}0C` }}>{children}</blockquote>;
  },
  ul: ({ children }: { children?: ReactNode }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  hr: () => <hr className="my-5 border-app-border" />,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-app-surface px-1 py-0.5 text-[12px]">{children}</code>,
} as const;

export function ResearchReportView({
  report,
  language,
  onBack,
  onDelete,
  onBacktest,
}: {
  report: ResearchReport;
  language: "zh" | "en";
  onBack: () => void;
  onDelete: () => void;
  onBacktest: (seed: BacktestSeed) => void;
}) {
  const isEn = language === "en";
  const color = auditColor(report.audit.status);
  const webSearch = report.webSearch;
  const webSearchVerified = webSearch?.phase === "completed" && webSearch.sources.length > 0;
  const webSearchColor = webSearchVerified ? "#31D08B" : webSearch?.requested ? "#F59E0B" : "#94A3B8";
  const dataStatus = report.dataStatus;
  const localDataSources = [...new Map((report.targetContexts ?? []).flatMap((context) => context.provenance)
    .filter((item) => Boolean(item.sourceUrl))
    .map((item) => [item.sourceUrl!, { provider: item.provider, url: item.sourceUrl! }])).values()];
  const dataStatusColor = dataStatus?.status === "complete" ? "#31D08B" : dataStatus?.status === "failed" ? "#F24E4E" : "#F59E0B";
  const modelReviewColor = report.audit.modelReview?.status === "pass"
    ? "#31D08B"
    : report.audit.modelReview?.status === "fail"
      ? "#F24E4E"
      : report.audit.modelReview?.status === "unavailable" ? "#94A3B8" : "#F59E0B";
  const auditLabel = isEn
    ? ({ verified: "Local checks passed", partial: "Local checks partially complete", unverified: "Insufficient local check data", failed: "Local checks found issues" } as const)[report.audit.status]
    : ({ verified: "本地规则检查通过", partial: "本地规则检查部分完成", unverified: "本地检查信息不足", failed: "本地规则检查发现明确问题" } as const)[report.audit.status];
  const hasAgents = (report.agentResults?.length ?? 0) > 0;
  const [activeTab, setActiveTab] = useState<string>("synthesis");
  const activeAgent = activeTab === "synthesis" ? null : report.agentResults?.find((a) => a.agentId === activeTab) ?? null;
  const activeSectionTitle = activeAgent?.title ?? (isEn ? "Synthesis" : "综合报告");
  const displayMarkdown = activeTab === "synthesis"
    ? report.markdown
    : activeAgent?.content ?? report.markdown;

  return (
    <div className="h-full overflow-y-auto px-3 pb-5" style={{ scrollbarWidth: "none" }}>
      <div className="sticky top-0 z-10 -mx-3 mb-3 border-b border-app-border bg-app-bg/95 px-3 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <button type="button" onClick={onBack} className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-semibold text-ts"><ArrowLeft size={14} />{isEn ? "Reports" : "报告列表"}</button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => downloadResearchReportSection(report, activeSectionTitle, displayMarkdown, language)} className="flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-app-border px-2 text-[11px] font-semibold text-tm" title={isEn ? "Download current section" : "导出当前分栏"} aria-label={isEn ? `Download current section: ${activeSectionTitle}` : `导出当前分栏：${activeSectionTitle}`}><FileDown size={13} />{isEn ? "This" : "当前"}</button>
            {hasAgents && <button type="button" onClick={() => downloadFullResearchReport(report, language)} className="flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-app-border px-2 text-[11px] font-semibold text-tm" title={isEn ? "Download full report" : "导出整份报告"} aria-label={isEn ? "Download the full report including every section" : "导出整份报告（包含所有分栏）"}><Download size={13} />{isEn ? "Full" : "全部"}</button>}
            <button type="button" onClick={onDelete} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border text-[#F24E4E]" title={isEn ? "Delete report" : "删除报告"} aria-label={isEn ? `Delete report: ${report.title}` : `删除报告：${report.title}`}><Trash2 size={13} /></button>
          </div>
        </div>
      </div>
      {report.audit.modelReview ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg px-2.5 py-2" style={{ background: `${modelReviewColor}12`, color: modelReviewColor }}>
          <Bot size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold">
              {report.audit.modelReview.status === "unavailable"
                ? (isEn ? "Model review incomplete" : "模型复核未完成")
                : report.audit.modelReview.independent
                  ? (isEn ? "Independent model review" : "独立模型复核")
                  : (isEn ? "Same-model review" : "同模型复核")}
              <span className="ml-1 font-normal opacity-75">· {[report.audit.modelReview.providerName, report.audit.modelReview.model].filter(Boolean).join(" · ")}</span>
            </p>
            <p className="mt-0.5 text-[11px] leading-[1.55] text-tm">{report.audit.modelReview.summary}</p>
            {report.audit.modelReview.status !== "unavailable" && (
              <p className="mt-0.5 text-[11px] leading-[1.55] text-tmi">
                {isEn
                  ? `${report.audit.modelReview.verifiedClaims}/${report.audit.modelReview.checkedClaims} reviewed claims supported by the supplied evidence; webpages were not opened by this review.`
                  : `基于已提供证据复核 ${report.audit.modelReview.checkedClaims} 个主张，其中 ${report.audit.modelReview.verifiedClaims} 个获得支持；该复核不会自行打开网页。`}
              </p>
            )}
            {report.audit.modelReview.findings.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px] leading-[1.55] text-tm">
                {report.audit.modelReview.findings.slice(0, 3).map((finding, index) => (
                  <li key={`${finding.category}-${index}`}>• {finding.detail}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="mb-3 rounded-lg bg-app-surface px-2.5 py-2 text-[11px] leading-4 text-tmi">
          {isEn ? "No audit model configured; only deterministic local checks ran." : "未配置审计模型，本次仅执行确定性的本地规则与计算检查。"}
        </p>
      )}

      <div className="rounded-xl border border-app-border bg-app-card p-3">
        <p className="text-[15px] font-bold leading-5 text-tp">{report.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-tmi">
          <span>{report.createdAt.slice(0, 16).replace("T", " ")}</span>
          <span>·</span><span>{isEn ? "Cutoff" : "截止"} {report.dataCutoff}</span>
          <span>·</span><span>{report.sources.length} {isEn ? "report citations" : "个正文引用来源"}</span>
        </div>
        {report.providerRoute && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-tmi">
            <span className="rounded-md bg-app-surface px-2 py-1">{isEn ? "Execution" : "执行"} · {[report.providerRoute.execution.profileName, report.providerRoute.execution.model].filter(Boolean).join(" · ")}</span>
            {report.providerRoute.synthesis && <span className="rounded-md bg-app-surface px-2 py-1">{isEn ? "Synthesis" : "综合"} · {[report.providerRoute.synthesis.profileName, report.providerRoute.synthesis.model].filter(Boolean).join(" · ")}</span>}
            <span className="rounded-md bg-app-surface px-2 py-1">{isEn ? "Audit" : "审计"} · {report.providerRoute.audit ? [report.providerRoute.audit.profileName, report.providerRoute.audit.model].filter(Boolean).join(" · ") : (isEn ? "local checks" : "本地检查")}</span>
            {report.providerRoute.professionalData && <span className="rounded-md bg-app-surface px-2 py-1">{isEn ? "Professional data" : "专业数据"} · {report.providerRoute.professionalData.profileName}</span>}
          </div>
        )}
        <div className="mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2" style={{ background: `${color}12`, color }}>
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold">{auditLabel}</p>
            <p className="mt-0.5 text-[11px] leading-[1.55] opacity-80">{report.audit.note}</p>
          </div>
        </div>
        {dataStatus && (
          <div className="mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2" style={{ background: `${dataStatusColor}12`, color: dataStatusColor }}>
            <Layers size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold">
                {dataStatus.status === "complete"
                  ? (isEn ? "Required local data ready" : "本地必需数据已就绪")
                  : dataStatus.status === "failed"
                    ? (isEn ? "Required local data unavailable" : "本地必需数据不可用")
                    : (isEn ? "Required local data partially available" : "本地必需数据部分可用")}
              </p>
              <p className="mt-0.5 text-[11px] leading-[1.55] opacity-80">
                {isEn
                  ? `${dataStatus.completeTargets}/${dataStatus.targetCount} target(s) meet this workflow's required-data rules; optional enhancements may still be unavailable.`
                  : `${dataStatus.completeTargets}/${dataStatus.targetCount} 个标的满足当前研究模式的必需数据要求；可选增强数据仍可能缺失。`}
              </p>
              {dataStatus.warnings.length > 0 && <p className="mt-1 text-[11px] leading-[1.55] opacity-80">{dataStatus.warnings.slice(0, 2).join("；")}</p>}
              {(dataStatus.optionalNotes?.length ?? 0) > 0 && (
                <p className="mt-1 text-[11px] leading-[1.55] text-tmi">
                  {isEn ? "Optional enhancements: " : "可选增强数据："}{dataStatus.optionalNotes!.slice(0, 2).join("；")}{dataStatus.optionalNotes!.length > 2 ? `；${isEn ? "and more" : "其余已折叠"}` : ""}
                </p>
              )}
              {localDataSources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {localDataSources.slice(0, 5).map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-app-card/70 px-1.5 py-1 text-[10px] font-medium text-ts"
                    >
                      {source.provider}<ExternalLink size={9} />
                    </a>
                  ))}
                  {localDataSources.length > 5 && <span className="px-1 py-1 text-[10px] text-tmi">+{localDataSources.length - 5}</span>}
                </div>
              )}
            </div>
          </div>
        )}
        {report.professionalData?.requested && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-[rgba(124,58,237,0.08)] px-2.5 py-2 text-[#7C3AED]">
            <Layers size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold">
                {report.professionalData.items.length
                  ? (isEn ? "Volcengine professional data used" : "已使用方舟专业数据集")
                  : (isEn ? "Professional data unavailable" : "专业数据集本次不可用")}
              </p>
              <p className="mt-0.5 text-[11px] leading-[1.55] opacity-80">
                {report.professionalData.items.length
                  ? (isEn
                    ? `${report.professionalData.items.length}/${report.professionalData.queries.length} query result(s) · ${report.professionalData.datasetTypes.join(", ") || "server-routed"}`
                    : `${report.professionalData.items.length}/${report.professionalData.queries.length} 组查询取得数据 · ${report.professionalData.datasetTypes.join("、") || "服务端自动路由"}`)
                  : (report.professionalData.errors[0] || (isEn ? "No usable result returned; research continued with other evidence." : "未返回可用结果，研究已使用其他证据继续完成。"))}
              </p>
            </div>
          </div>
        )}
        <div className="mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2" style={{ background: `${webSearchColor}12`, color: webSearchColor }}>
          <Globe2 size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold">
              {webSearchVerified
                ? (isEn ? "Web search verified" : "本次实际联网已验证")
                : webSearch?.requested
                  ? (isEn ? "Web search unverified" : "已请求联网，但未验证")
                  : (isEn ? "Offline research" : "本次未联网")}
            </p>
            <p className="mt-0.5 text-[11px] leading-[1.55] opacity-80">
              {webSearchVerified
                ? `${webSearch.method === "hybrid" ? (isEn ? "Hybrid" : "混合联网") : webSearch.method === "external" ? (isEn ? "External search" : "外部搜索") : (isEn ? "Native search" : "原生联网")} · ${webSearch.sources.length} ${isEn ? "structured sources" : "个结构化来源"}${webSearch.externalProvider ? ` · ${webSearch.externalProvider}` : ""}${webSearch.queries.length ? ` · ${webSearch.queries.length} ${isEn ? "queries" : "条查询"}` : ""}`
                : webSearch?.errors[0]
                  || (webSearch?.queries.length
                    ? (isEn
                      ? `${webSearch.queries.length} queries were generated, but no structured search source was returned.`
                      : `已生成 ${webSearch.queries.length} 条查询，但服务商没有返回结构化搜索来源。`)
                    : (isEn ? "No provider search event or structured source was recorded." : "没有记录到服务商搜索事件或结构化来源。"))}
            </p>
            {webSearch?.queries.length ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {webSearch.queries.slice(0, 5).map((query) => <span key={query} className="max-w-full truncate rounded bg-app-card px-1.5 py-0.5 text-[12px] text-tm">{query}</span>)}
              </div>
            ) : null}
          </div>
        </div>
        {report.audit.checks.length > 0 && (
          <div className="mt-2 space-y-1">
            {report.audit.checks.map((check) => {
              const checkColor = check.status === "pass" ? "#31D08B" : check.status === "warning" ? "#F59E0B" : "#F24E4E";
              return (
                <div key={check.id} className="flex items-start gap-1.5 rounded-lg bg-app-surface px-2.5 py-2 text-[11px] leading-[1.55]">
                  <span className="mt-0.5 shrink-0 font-bold" style={{ color: checkColor }}>
                    {check.status === "pass" ? "✓" : check.status === "warning" ? "⚠" : "✗"}
                  </span>
                  <div className="min-w-0">
                    <span className="font-semibold text-ts">{check.label}</span>
                    <span className="ml-1 text-tmi">{check.detail}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() => onBacktest({
            symbol: report.target.symbol,
            name: report.target.name,
            market: report.target.market,
            assetType: report.target.assetType,
          })}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-app-accent py-2.5 text-[12px] font-semibold text-white"
        >
          <Calculator size={12} />{isEn ? "Validate with a backtest" : "用策略回测验证"}
        </button>
      </div>

      {hasAgents && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab("synthesis")}
            className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold"
            style={{
              borderColor: activeTab === "synthesis" ? "rgba(79,156,249,0.5)" : "var(--border)",
              background: activeTab === "synthesis" ? "rgba(79,156,249,0.1)" : "var(--bg-surface)",
              color: activeTab === "synthesis" ? "#4F9CF9" : "var(--text-secondary)",
            }}
          >
            <Layers size={11} />{isEn ? "Synthesis" : "综合报告"}
          </button>
          {report.agentResults!.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => setActiveTab(agent.agentId)}
              className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold"
              style={{
                borderColor: activeTab === agent.agentId ? "rgba(79,156,249,0.5)" : "var(--border)",
                background: activeTab === agent.agentId ? "rgba(79,156,249,0.1)" : "var(--bg-surface)",
                color: activeTab === agent.agentId ? "#4F9CF9" : "var(--text-secondary)",
              }}
            >
              <FileText size={11} />{agent.title}
            </button>
          ))}
        </div>
      )}

      {activeAgent?.providerName && (
        <p className="mt-2 text-[11px] text-tmi">{isEn ? "Generated by" : "生成连接"}：{activeAgent.providerName} · {activeAgent.model}</p>
      )}

      <article className="research-markdown mt-3 rounded-xl border border-app-border bg-app-card px-3.5 py-4 text-[13px] leading-[1.8] text-ts">
        <ReactMarkdown
          remarkPlugins={RESEARCH_REMARK_PLUGINS}
          skipHtml
          components={RESEARCH_MARKDOWN_COMPONENTS}
        >
          {displayMarkdown}
        </ReactMarkdown>
      </article>

      {report.sources.length > 0 && (
        <section className="mt-3 rounded-xl border border-app-border bg-app-card p-3">
          <p className="text-[13px] font-semibold text-tp">{isEn ? "Research sources" : "研究来源"}</p>
          <div className="mt-2 space-y-1.5">
            {report.sources.map((source) => (
              <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-lg bg-app-surface px-2.5 py-2.5 text-[12px] leading-4 text-app-accent">
                <span className="min-w-0 flex-1 truncate">{source.title}</span>
                <span className="shrink-0 rounded bg-app-card px-1.5 py-0.5 text-[12px] text-tmi">{source.origin === "provider" ? (isEn ? "API citation" : "API 引用") : source.origin === "external_search" ? (isEn ? "External search" : "外部搜索") : (isEn ? "report link" : "正文链接")}</span>
                <ExternalLink size={10} className="shrink-0" />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
