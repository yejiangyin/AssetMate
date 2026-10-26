import { AlertTriangle, Check, ChevronDown, CircleStop, Clock3, Eye, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusPill, type Tone } from "../../research/components/settingsUi";
import type { ResearchJob, ResearchWorkflowId } from "../../research/types";
import { researchAgentTitle, researchWorkflowTitle, workflowAgentIds } from "../../research/workflows/prompts";
import {
  WORKFLOW_CATEGORY_LABELS,
  WORKFLOW_CATEGORY_ORDER,
  WORKFLOW_REGISTRY,
  type WorkflowConfig,
} from "../../research/workflows/registry";

// Presentational pieces of the AI research panel; state and research logic stay in AIResearchPanel.

export function jobStatusLabel(status: ResearchJob["status"], isEn: boolean) {
  const labels = isEn
    ? { draft: "Draft", preparing: "Preparing", running: "Running", synthesizing: "Synthesizing", auditing: "Auditing", paused: "Paused", cancelled: "Cancelled", failed: "Failed", completed: "Completed" }
    : { draft: "草稿", preparing: "准备中", running: "研究中", synthesizing: "综合中", auditing: "审计中", paused: "已暂停", cancelled: "已取消", failed: "失败", completed: "已完成" };
  return labels[status];
}

function jobStatusTone(status: ResearchJob["status"]): Tone {
  if (status === "completed") return "ok";
  if (status === "failed") return "danger";
  if (status === "paused" || status === "cancelled") return "warn";
  return "accent";
}

export function researchTargetsTitle(targets: ResearchJob["target"][], isEn: boolean) {
  if (targets.length === 0) return isEn ? "No target" : "未选择标的";
  if (targets.length === 1) return targets[0]!.name || targets[0]!.symbol;
  return isEn ? `${targets.length} targets` : `${targets.length} 个标的`;
}

/** Bottom sheet over the research pane; Escape or the scrim closes it. */
export function ResearchSheet({
  title,
  subtitle,
  onClose,
  closeLabel,
  footer,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-[var(--scrim)]" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88%] w-full max-w-[480px] flex-col rounded-t-2xl border border-app-border bg-app-bg shadow-xl outline-none"
      >
        <div className="flex shrink-0 items-start gap-2 border-b border-app-border px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-tp">{title}</p>
            {subtitle && <p className="mt-0.5 text-[11px] leading-4 text-tmi">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-card text-tm">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={{ scrollbarWidth: "none" }}>{children}</div>
        {footer && <div className="shrink-0 border-t border-app-border px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

function workflowMaxTargets(workflow: WorkflowConfig) {
  return workflow.maxTargets ?? (workflow.supportsMultipleTargets ? 5 : 1);
}

function workflowUsesTargets(workflow: WorkflowConfig) {
  return !workflow.needsPortfolioContext && (!workflow.needsTopicInput || workflow.id === "deep_company_series");
}

export function WorkflowBadges({ workflow, isEn }: { workflow: WorkflowConfig; isEn: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="rounded bg-[rgba(79,156,249,0.08)] px-1 py-0.5 text-[10px] font-medium text-app-accent">{workflow.origin === "assetmate" ? "AssetMate" : "Berkshire"}</span>
      <span className="text-[10px] text-tmi" title={isEn ? "Model calls" : "模型调用次数"}>{workflow.calls}×</span>
    </span>
  );
}

/** Every research mode grouped by category; modes that cannot take the current targets are disabled. */
export function WorkflowPicker({
  workflowId,
  targetCount,
  isEn,
  onSelect,
}: {
  workflowId: ResearchWorkflowId;
  targetCount: number;
  isEn: boolean;
  onSelect: (id: ResearchWorkflowId) => void;
}) {
  return (
    <div className="space-y-4">
      {WORKFLOW_CATEGORY_ORDER.map((category) => {
        const workflows = Object.values(WORKFLOW_REGISTRY).filter((workflow) => workflow.category === category && workflow.id !== "backtest_interpretation");
        if (!workflows.length) return null;
        return (
          <section key={category} aria-label={isEn ? WORKFLOW_CATEGORY_LABELS[category].en : WORKFLOW_CATEGORY_LABELS[category].zh}>
            <p className="mb-1.5 px-0.5 text-[11px] font-semibold text-tm">{isEn ? WORKFLOW_CATEGORY_LABELS[category].en : WORKFLOW_CATEGORY_LABELS[category].zh}</p>
            <div className="space-y-1.5">
              {workflows.map((workflow) => {
                const active = workflow.id === workflowId;
                const max = workflowMaxTargets(workflow);
                const incompatible = workflowUsesTargets(workflow) && targetCount > max;
                return (
                  <button
                    key={workflow.id}
                    type="button"
                    disabled={incompatible}
                    aria-pressed={active}
                    onClick={() => onSelect(workflow.id)}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${active ? "border-app-accent/50 bg-[rgba(79,156,249,0.08)]" : "border-app-border bg-app-card hover:border-app-accent/30"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`min-w-0 truncate text-[13px] font-semibold ${active ? "text-app-accent" : "text-tp"}`}>{isEn ? workflow.titles.en : workflow.titles.zh}</span>
                        <WorkflowBadges workflow={workflow} isEn={isEn} />
                      </div>
                      <p className="mt-0.5 text-[11px] leading-4 text-tmi">
                        {incompatible
                          ? (isEn ? `Supports up to ${max} target(s); you selected ${targetCount}.` : `最多支持 ${max} 个标的，当前已选 ${targetCount} 个`)
                          : (isEn ? workflow.descriptions.en : workflow.descriptions.zh)}
                      </p>
                    </div>
                    {active && <Check size={15} className="mt-0.5 shrink-0 text-app-accent" />}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ElapsedTime({ startedAt, isEn }: { startedAt: string; isEn: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const label = seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : isEn ? `${seconds}s` : `${seconds} 秒`;
  return <span className="tabular-nums">{label}</span>;
}

/** The active research job: status, steps, live preview and its stop / restart / view actions. */
export function JobProgressCard({
  job,
  message,
  streamPreview,
  running,
  stopping,
  isEn,
  language,
  onStop,
  onRestart,
  onViewReport,
  onDismiss,
}: {
  job: ResearchJob;
  message: string;
  streamPreview: string;
  running: boolean;
  stopping: boolean;
  isEn: boolean;
  language: "zh" | "en";
  onStop: () => void;
  onRestart: () => void;
  onViewReport?: () => void;
  onDismiss: () => void;
}) {
  const [showPreview, setShowPreview] = useState(true);
  const agentIds = workflowAgentIds(job.workflowId);
  const doneCount = agentIds.filter((agentId) => job.completedSteps.includes(agentId)).length;
  const progress = job.status === "completed" ? 100 : Math.round((doneCount / Math.max(1, agentIds.length)) * 100);
  return (
    <section aria-label={isEn ? "Current research" : "当前研究"} className={`rounded-xl border bg-app-card p-3 ${running ? "border-app-accent/35" : "border-app-border"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <StatusPill tone={jobStatusTone(job.status)}>
              {running && <Loader2 size={9} className="animate-spin" />}
              {jobStatusLabel(job.status, isEn)}
            </StatusPill>
            {running && (
              <span className="flex items-center gap-1 text-[11px] text-tmi"><Clock3 size={10} /><ElapsedTime key={job.id} startedAt={job.startedAt ?? job.createdAt} isEn={isEn} /></span>
            )}
          </div>
          <p className="mt-1 truncate text-[13px] font-semibold text-tp">{researchTargetsTitle(job.targets ?? [job.target], isEn)} · {researchWorkflowTitle(job.workflowId, language)}</p>
          {(running || !job.error) && message && <p className="mt-0.5 text-[11px] leading-4 text-tm" aria-live="polite">{message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stopping ? (
            <button type="button" disabled className="flex h-8 items-center gap-1 rounded-lg bg-[rgba(242,78,78,0.08)] px-2 text-[11px] font-semibold text-[#F24E4E] opacity-70" aria-label={isEn ? "Stopping research" : "正在中断研究"}><Loader2 size={12} className="animate-spin" />{isEn ? "Stopping" : "中断中"}</button>
          ) : running ? (
            <button type="button" onClick={onStop} className="flex h-8 items-center gap-1 rounded-lg bg-[rgba(242,78,78,0.1)] px-2 text-[11px] font-semibold text-[#F24E4E]" aria-label={isEn ? "Stop research" : "中断研究"}><CircleStop size={13} />{isEn ? "Stop" : "中断"}</button>
          ) : (
            <>
              {job.status === "completed"
                ? onViewReport && <button type="button" onClick={onViewReport} className="flex h-8 items-center gap-1 rounded-lg bg-[rgba(79,156,249,0.1)] px-2 text-[11px] font-semibold text-app-accent"><Eye size={13} />{isEn ? "Report" : "查看报告"}</button>
                : <button type="button" onClick={onRestart} className="flex h-8 items-center gap-1 rounded-lg bg-[rgba(79,156,249,0.1)] px-2 text-[11px] font-semibold text-app-accent" aria-label={isEn ? "Restart research" : "重新开始研究"}><RefreshCw size={13} />{isEn ? "Restart" : "重新开始"}</button>}
              <button type="button" onClick={onDismiss} className="flex h-8 w-8 items-center justify-center rounded-lg text-tmi hover:bg-app-surface" aria-label={isEn ? "Hide this task" : "收起此任务"}><X size={14} /></button>
            </>
          )}
        </div>
      </div>

      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-app-control" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <div className={`h-full rounded-full transition-all ${job.status === "failed" ? "bg-[#F24E4E]" : "bg-app-accent"}`} style={{ width: `${Math.max(progress, running ? 4 : 0)}%` }} />
      </div>
      <ol className="mt-2 flex flex-wrap gap-1.5" aria-label={isEn ? "Research steps" : "研究步骤"}>
        {agentIds.map((agentId) => {
          const done = job.completedSteps.includes(agentId);
          const current = running && job.currentStep === agentId;
          return (
            <li key={agentId} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${done ? "bg-[rgba(49,208,139,0.1)] text-[#1F9D6A]" : current ? "bg-[rgba(79,156,249,0.12)] text-app-accent" : "bg-app-surface text-tmi"}`}>
              {done ? <Check size={10} /> : current ? <Loader2 size={10} className="animate-spin" /> : <Clock3 size={10} />}
              {researchAgentTitle(agentId, language)}
            </li>
          );
        })}
      </ol>

      {job.error && (
        <div role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg bg-[rgba(242,78,78,0.08)] px-2.5 py-2 text-[11px] leading-4 text-[#E04848]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /><span className="min-w-0 break-words">{job.error.message}</span>
        </div>
      )}

      {streamPreview && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowPreview((value) => !value)} aria-expanded={showPreview} className="flex items-center gap-1 text-[11px] font-medium text-tm">
            <ChevronDown size={12} className={`transition-transform ${showPreview ? "" : "-rotate-90"}`} />{isEn ? "Live output" : "实时输出"}
          </button>
          {showPreview && <pre aria-live="polite" className="mt-1 max-h-32 overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-app-surface px-2.5 py-2 font-sans text-[11px] leading-4 text-tmi">{streamPreview.slice(-1600)}</pre>}
        </div>
      )}
    </section>
  );
}

/** One collapsed-by-default row: label, current value, and a chevron to open its editor. */
export function SummaryRow({
  icon,
  label,
  value,
  tone = "default",
  onClick,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: "default" | "warn";
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={`w-full rounded-xl border bg-app-card px-3 py-2.5 text-left transition-colors hover:border-app-accent/30 ${tone === "warn" ? "border-[#F59E0B]/40" : "border-app-border"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone === "warn" ? "bg-[rgba(245,158,11,0.12)] text-[#D97706]" : "bg-[rgba(79,156,249,0.1)] text-app-accent"}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-tmi">{label}</p>
          <div className="mt-0.5 min-w-0 text-[13px] font-semibold text-tp">{value}</div>
        </div>
        <ChevronDown size={14} className="shrink-0 -rotate-90 text-tmi" />
      </div>
      {children && <div className="mt-2 pl-[42px]">{children}</div>}
    </button>
  );
}

export function InfoChip({ icon, children, tone = "default" }: { icon: ReactNode; children: ReactNode; tone?: "default" | "warn" | "muted" }) {
  const className = tone === "warn"
    ? "bg-[rgba(245,158,11,0.1)] text-[#C27C0E]"
    : tone === "muted" ? "bg-app-surface text-tmi" : "bg-app-surface text-ts";
  return <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}>{icon}<span className="truncate">{children}</span></span>;
}

/** One responsibility in the model plan sheet (execution, DataPro, synthesis, audit). */
export function PlanRoleCard({
  icon,
  accentClass,
  title,
  hint,
  active,
  activeAccentClass,
  badge,
  children,
}: {
  icon: ReactNode;
  accentClass: string;
  title: string;
  hint: string;
  active: ReactNode;
  activeAccentClass: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-app-border bg-app-card p-3">
      <div className="flex items-start gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${accentClass}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[12px] font-semibold text-tp">{title}</p>
            {badge}
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-tmi">{hint}</p>
        </div>
      </div>
      <div className="mt-2.5 space-y-2">{children}</div>
      <div className={`mt-2 flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] ${activeAccentClass}`}>
        <Check size={12} className="shrink-0" />
        <span className="min-w-0 truncate font-medium text-tp">{active}</span>
      </div>
    </section>
  );
}
