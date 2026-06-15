import { useEffect, useMemo, useRef, useState } from "react";
import {
  X, Plus, Pencil, Trash2, ToggleLeft, ToggleRight,
  CalendarClock, AlertCircle,
  CheckCircle2, Info,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useApp, DCAExecution, DCAPlan } from "../context/AppContext";
import { Holding } from "../data/mockData";
import {
  calcNextExecutions, isTradingDay, closureReason, effectiveDcaMarket,
  DCAFrequency, MarketType,
} from "../services/tradingCalendar";
import { formatFixedNumber } from "../utils/numberFormat";
import { resolveHoldingTradeStatus, cleanTradeSource, cleanTradeNote } from "../utils/tradeStatus";
import { getMarketBadge } from "../utils/marketBadge";
import { computeFundConfirmationDate, fundSettlementDays, parseChineseMoneyLimit } from "../utils/dcaEngine";
import type { Language } from "../context/AppContext";
import {
  dcaMarketForLabel,
  frequencyLabel,
  monthDayLabel,
  t,
  translateClosureReason,
  translateDcaReason,
  translateTradeText,
  weekdayLabel,
} from "../i18n";

const FREQ_OPTIONS: DCAFrequency[] = ["daily","weekly","monthly"];

const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5];
const CHECKER_MARKETS: MarketType[] = ["US", "HK", "UK", "DE", "IN", "VN", "A", "JP", "CRYPTO", "FUND", "BOND", "GOLD"];

/* ─── helpers ────────────────────────────────────────── */
function freqSummary(plan: DCAPlan, language: Language): string {
  if (plan.frequency === "daily") return frequencyLabel("daily", language);
  if (plan.frequency === "weekly") return language === "en"
    ? `${frequencyLabel("weekly", language)} ${weekdayLabel(plan.dayOfWeek ?? 1, language)}`
    : `每周${weekdayLabel(plan.dayOfWeek ?? 1, language)}`;
  return language === "en" ? `Monthly on day ${plan.dayOfMonth ?? 1}` : `每月 ${plan.dayOfMonth ?? 1} 日`;
}

function dateLabel(d: string, language: Language): string {
  return monthDayLabel(d, language);
}

function planStatusMeta(holding: Holding | undefined, language: Language) {
  const text = t(language).dca;
  if (!holding) return { label: text.missingHolding, color: "#F24E4E" };
  const resolved = resolveHoldingTradeStatus(holding);
  if (resolved.status === "suspended") return { label: text.suspended, color: "#F24E4E", source: resolved.source };
  if (resolved.status === "fund_limit") return { label: text.limited, color: "#F59E0B", source: resolved.source };
  if (resolved.status === "buy_disabled") return { label: text.notBuyable, color: "#94A3B8", source: resolved.source };
  return { label: text.executable, color: "#31D08B", source: resolved.source };
}

function dcaBlockedStatus(holding: Holding | undefined, amountText: string, language: Language) {
  if (!holding) return null;
  const resolved = resolveHoldingTradeStatus(holding);
  if (resolved.status === "normal") return null;
  if (resolved.status === "fund_limit") {
    const amount = Number(amountText);
    const limit = parseChineseMoneyLimit(resolved.note ?? "");
    if (Number.isFinite(amount) && limit != null && amount <= limit + 1e-8) return null;
  }
  return planStatusMeta(holding, language);
}

function executionStatusMeta(execution: DCAExecution, language: Language) {
  const text = t(language).dca;
  if (execution.status === "executed") {
    return { label: text.posted, color: "#31D08B", bg: "rgba(49,208,139,0.1)" };
  }
  if (execution.status === "pending") {
    return { label: text.pendingStatus, color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" };
  }
  return { label: text.skippedStatus, color: "#F59E0B", bg: "rgba(245,158,11,0.12)" };
}

function skippedSummary(reason: string | undefined, language: Language) {
  const text = t(language).dca;
  const raw = reason ?? "";
  const prefix = text.skippedStatus;
  if (/限购|limited/i.test(raw)) return `${prefix} · ${text.limited}`;
  if (/暂停申购|不可买|不支持|buy|disabled/i.test(raw)) return `${prefix} · ${text.notBuyable}`;
  if (/停牌|suspended/i.test(raw)) return `${prefix} · ${text.suspended}`;
  if (/非交易日|休市|closed|holiday/i.test(raw)) return `${prefix} · ${language === "en" ? "Closed" : "休市"}`;
  if (/报价|quote|价格|price/i.test(raw)) return `${prefix} · ${language === "en" ? "No quote" : "无报价"}`;
  if (/净值|NAV|缓存|未获取/i.test(raw)) return `${prefix} · ${language === "en" ? "NAV missing" : "缺净值"}`;
  return prefix;
}

/* ─── NextDateBadge ──────────────────────────────────── */
function NextDateBadge({ plan, tc: _tc, language }: { plan: DCAPlan; tc: any; language: Language }) {
  const { nextExecDate } = plan;
  if (!nextExecDate) return null;
  const text = t(language).dca;

  const today = new Date();
  const exec  = new Date(nextExecDate);
  const diff  = Math.round((exec.getTime() - today.setHours(0,0,0,0)) / 86400000);

  const label = diff === 0 ? text.today : diff === 1 ? text.tomorrow : diff <= 7 ? text.daysLater(diff) : dateLabel(nextExecDate, language);
  const color = diff <= 2 ? "#31D08B" : diff <= 7 ? "#F59E0B" : "var(--text-secondary)";

  return (
    <span className="rounded-full px-1.5 py-0.5 shrink-0"
      style={{ fontSize: 10, color, background: `${color}18`, fontWeight: 600, border: `1px solid ${color}40` }}>
      {label}
    </span>
  );
}

/* ─── PlanCard ───────────────────────────────────────── */
function PlanCard({
  plan, holding, latestExecution, tc, language, onEdit, onDelete, onToggle,
}: {
  plan: DCAPlan; tc: any;
  holding?: Holding;
  latestExecution?: DCAExecution;
  language: Language;
  onEdit: () => void; onDelete: () => void; onToggle: () => void;
}) {
  const text = t(language).dca;
  const badge = getMarketBadge(plan.market, language);
  const status = planStatusMeta(holding, language);
  const latestText = latestExecution
    ? latestExecution.status === "executed"
      ? text.latestConfirmed(dateLabel(latestExecution.confirmedDate || latestExecution.actualDate, language))
      : latestExecution.status === "pending"
        ? text.pending(dateLabel(latestExecution.actualDate, language))
      : skippedSummary(latestExecution.reason, language)
    : text.noExecutions;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -30 }}
      className="rounded-xl px-3 py-3"
      style={{
        background: plan.enabled ? tc.bgCard : "var(--border-sub)",
        border: `1px solid ${plan.enabled ? tc.border : "var(--bg-card)"}`,
        borderLeft: `3px solid ${plan.enabled ? badge.color : "var(--text-micro)"}`,
        opacity: plan.enabled ? 1 : 0.55,
      }}
    >
      {/* Row 1: name + badge + toggle */}
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ color: tc.textPrimary, fontSize: 13, fontWeight: 600, flex: 1 }}>{holding?.name ?? plan.name}</span>
        <span className="rounded-full px-1.5 py-0.5" style={{ fontSize: 9, color: badge.color, background: `${badge.color}18` }}>{badge.label}</span>
        <span className="rounded-full px-1.5 py-0.5" style={{ fontSize: 9, color: status.color, background: `${status.color}18` }}>{status.label}</span>
        <NextDateBadge plan={plan} tc={tc} language={language} />
        <button onClick={onToggle}>
          {plan.enabled
            ? <ToggleRight size={20} color="#4F9CF9" />
            : <ToggleLeft  size={20} color="var(--text-micro)" />}
        </button>
      </div>
      {/* Row 2: symbol + amount + frequency */}
      <div className="flex items-center gap-3">
        <span style={{ color: tc.textSecondary, fontSize: 11 }}>{plan.symbol}</span>
        <span style={{ color: tc.textMuted, fontSize: 11 }}>·</span>
        <span style={{ color: tc.textSecondary, fontSize: 11, fontWeight: 600 }}>
          {formatFixedNumber(plan.amount)} {plan.currency}
        </span>
        <span style={{ color: tc.textMuted, fontSize: 11 }}>·</span>
        <span style={{ color: tc.textMuted, fontSize: 11 }}>{freqSummary(plan, language)}</span>
      </div>
      {/* Row 3: stats + actions */}
      <div className="flex items-center justify-between mt-2 pt-2"
        style={{ borderTop: `1px solid ${tc.borderSub}` }}>
        <div className="flex items-center gap-4">
          <div>
            <p style={{ color: tc.textMicro, fontSize: 9 }}>{text.posted}</p>
            <p style={{ color: tc.textSecondary, fontSize: 11, fontWeight: 600 }}>{language === "en" ? plan.execCount : `${plan.execCount} 次`}</p>
          </div>
          <div>
            <p style={{ color: tc.textMicro, fontSize: 9 }}>{text.amountPosted}</p>
            <p style={{ color: tc.textSecondary, fontSize: 11, fontWeight: 600 }}>
              {formatFixedNumber(plan.totalInvested, 2)} {plan.currency}
            </p>
          </div>
          <div>
            <p style={{ color: tc.textMicro, fontSize: 9 }}>{text.status}</p>
            <p
              className="truncate"
              title={latestExecution?.reason ? translateDcaReason(latestExecution.reason, language) : undefined}
              style={{ color: latestExecution?.status === "skipped" ? "#F59E0B" : "#4F9CF9", fontSize: 11, fontWeight: 600, maxWidth: 150 }}
            >
              {latestText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onEdit} className="rounded-lg p-1.5" style={{ background: "rgba(79,156,249,0.1)" }}>
            <Pencil size={11} color="#4F9CF9" />
          </button>
          <button onClick={onDelete} className="rounded-lg p-1.5" style={{ background: "rgba(242,78,78,0.1)" }}>
            <Trash2 size={11} color="#F24E4E" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── SchedulePreview ────────────────────────────────── */
function SchedulePreview({
  market, name, frequency, dayOfWeek, dayOfMonth, startDate, blockedStatus, tc, language,
}: {
  market: MarketType; name?: string; frequency: DCAFrequency;
  dayOfWeek: number; dayOfMonth: number; startDate: string;
  blockedStatus?: { label: string; color: string } | null;
  tc: any; language: Language;
}) {
  const text = t(language).dca;
  const effectiveMarket = effectiveDcaMarket(market, name);
  const previewState = useMemo(() => {
    if (!startDate) return { items: [], error: "" };
    try {
      return { items: calcNextExecutions(effectiveMarket, { frequency, dayOfWeek, dayOfMonth, startDate }, 5), error: "" };
    } catch {
      return { items: [], error: text.previewError };
    }
  }, [effectiveMarket, frequency, dayOfWeek, dayOfMonth, startDate, text.previewError]);
  const preview = previewState.items;

  if (preview.length === 0 && !previewState.error) return null;

  return (
    <div className="rounded-xl p-3" style={{ background: "rgba(79,156,249,0.06)", border: "1px solid rgba(79,156,249,0.12)" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <CalendarClock size={12} color="#4F9CF9" />
        <span style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600 }}>{text.futurePreview}</span>
        <span style={{ color: tc.textMicro, fontSize: 9 }}>{text.byTradingDays(dcaMarketForLabel(effectiveMarket, language))}</span>
      </div>
      <p style={{ color: tc.textMicro, fontSize: 9, marginBottom: 6 }}>
        {text.previewStatusNote}
      </p>
      {previewState.error && (
        <p style={{ color: "#F59E0B", fontSize: 10 }}>{previewState.error}</p>
      )}
      <div className="flex flex-col gap-1.5">
        {preview.map((row) => (
          <div key={row.actual} className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {blockedStatus
                ? <AlertCircle size={10} color={blockedStatus.color} />
                : row.adjusted
                ? <AlertCircle size={10} color="#F59E0B" />
                : <CheckCircle2 size={10} color="#31D08B" />}
              <span style={{ color: tc.textSecondary, fontSize: 11 }}>{row.actual}</span>
              {row.adjusted && (
                <span style={{ color: "#F59E0B", fontSize: 9 }}>
                  {text.originalNonTrading(row.scheduled)}
                </span>
              )}
            </div>
            {blockedStatus ? (
              <span className="rounded px-1 py-0.5" style={{ fontSize: 9, color: blockedStatus.color, background: `${blockedStatus.color}18` }}>
                {blockedStatus.label}
              </span>
            ) : row.adjusted && (
              <span className="rounded px-1 py-0.5" style={{ fontSize: 9, color: "#F59E0B", background: "rgba(245,158,11,0.1)" }}>
                {text.postponed}
              </span>
            )}
            {!blockedStatus && !row.adjusted && (
              <span className="rounded px-1 py-0.5" style={{ fontSize: 9, color: "#31D08B", background: "rgba(49,208,139,0.1)" }}>
                {text.tradingDay}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ExecutionHistory({
  executions,
  holding,
  planForSettlement,
  planStats,
  tc,
  title,
  language,
}: {
  executions: DCAExecution[];
  holding?: Holding;
  planForSettlement?: Pick<DCAPlan, "market" | "name" | "assetType" | "fundBuyConfirmDays">;
  planStats?: Pick<DCAPlan, "execCount" | "totalInvested" | "currency">;
  tc: any;
  title: string;
  language: Language;
}) {
  const text = t(language).dca;
  const currentStatus = holding ? resolveHoldingTradeStatus(holding) : null;
  const settlementPlan = planForSettlement
    ? {
        ...planForSettlement,
        fundBuyConfirmDays: planForSettlement.fundBuyConfirmDays ?? holding?.fundBuyConfirmDays,
      }
    : holding ? {
      market: holding.market as MarketType,
      name: holding.name,
      assetType: holding.assetType,
      fundBuyConfirmDays: holding.fundBuyConfirmDays,
    } : undefined;
  const sortedExecutions = useMemo(() => (
    [...executions].sort((a, b) => {
      const bd = b.actualDate ?? b.confirmedDate ?? b.scheduledDate;
      const ad = a.actualDate ?? a.confirmedDate ?? a.scheduledDate;
      return bd.localeCompare(ad);
    })
  ), [executions]);
  const visibleExecutions = sortedExecutions.slice(0, 8);
  const hiddenCount = Math.max(0, sortedExecutions.length - visibleExecutions.length);

  return (
    <div className="rounded-xl p-3" style={{ background: "rgba(79,156,249,0.06)", border: "1px solid rgba(79,156,249,0.12)" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <CalendarClock size={12} color="#4F9CF9" />
        <span style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600 }}>{title}</span>
      </div>

      {currentStatus && currentStatus.status !== "normal" && (
        <div
          className="rounded-lg px-2.5 py-2 mb-2"
          style={{
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.18)",
          }}
        >
          {(() => {
            const src = translateTradeText(cleanTradeSource(currentStatus.source), language);
            const label = translateTradeText(currentStatus.label, language);
            const note = translateTradeText(cleanTradeNote(currentStatus.note, currentStatus.label), language);
            return (
              <>
                <p style={{ color: "#F59E0B", fontSize: 10, fontWeight: 600 }}>
                  {src ? `${src} · ` : ""}{label}{note ? `, ${note}` : ""}
                </p>
              </>
            );
          })()}
          <p style={{ color: tc.textMuted, fontSize: 10, marginTop: 2 }}>
            {text.blockedNote}
          </p>
        </div>
      )}

      {executions.length === 0 ? (
        <p style={{ color: tc.textMuted, fontSize: 11 }}>{text.noExecutions}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {planStats && (
            <div
              className="rounded-lg px-2.5 py-2 mb-0.5 flex items-center justify-between"
              style={{ background: "rgba(79,156,249,0.08)", border: "1px solid rgba(79,156,249,0.14)" }}
            >
              <span style={{ color: tc.textMuted, fontSize: 10 }}>
                {text.postedSummary(planStats.execCount)}
              </span>
              <span style={{ color: tc.textSecondary, fontSize: 10, fontWeight: 600 }}>
                {formatFixedNumber(planStats.totalInvested, 2)} {planStats.currency}
              </span>
            </div>
          )}
          {visibleExecutions.map((item) => {
            const status = executionStatusMeta(item, language);
            return (
              <div
                key={item.id}
                className="rounded-lg px-2.5 py-2"
                style={{ background: "var(--bg-card)", border: `1px solid ${tc.borderSub}` }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {item.status === "executed"
                      ? <CheckCircle2 size={11} color={status.color} />
                      : <AlertCircle size={11} color={status.color} />}
                    <span style={{ color: tc.textSecondary, fontSize: 11, fontWeight: 600 }}>
                      {item.actualDate}
                    </span>
                    <span
                      className="rounded px-1 py-0.5"
                      style={{ fontSize: 9, color: status.color, background: status.bg }}
                    >
                      {status.label}
                    </span>
                  </div>
                  <span style={{ color: tc.textMuted, fontSize: 10 }}>
                    {formatFixedNumber(item.amount, 2)}
                  </span>
                </div>

                {item.status === "executed" ? (
                  <p style={{ color: tc.textMuted, fontSize: 10, marginTop: 4 }}>
                    {text.paymentDate} {item.actualDate} · {text.bought} {item.quantity ? formatFixedNumber(item.quantity, 2) : "—"} · {text.tradePrice} {item.price ? formatFixedNumber(item.price, 4) : "—"}
                    {item.navDate ? ` · ${text.navDate} ${item.navDate}` : ""}
                    {item.confirmedDate ? ` · ${text.confirmedDate} ${item.confirmedDate}` : ""}
                    {item.adjusted ? ` · ${text.original} ${item.scheduledDate}` : ""}
                  </p>
                ) : item.status === "pending" ? (
                  <p style={{ color: "#4F9CF9", fontSize: 10, marginTop: 4 }}>
                    {text.paymentDate} {item.actualDate}
                    {settlementPlan ? ` · ${text.estimatedConfirm} ${computeFundConfirmationDate(settlementPlan, item.actualDate)} (T+${fundSettlementDays(settlementPlan)})` : ""}
                    {` · ${translateDcaReason(item.reason ?? "等待正式净值确认后入账", language)}`}
                    {item.adjusted ? ` · ${text.original} ${item.scheduledDate}` : ""}
                  </p>
                ) : (
                  <p style={{ color: "#F59E0B", fontSize: 10, marginTop: 4 }}>
                    {text.paymentDate} {item.actualDate} · {text.skipReason}: {translateDcaReason(item.reason ?? "已跳过", language)}
                    {item.adjusted ? ` · ${text.original} ${item.scheduledDate}` : ""}
                  </p>
                )}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <p style={{ color: tc.textMicro, fontSize: 10, textAlign: "center", marginTop: 2 }}>
              {text.hiddenExecutions(hiddenCount)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── DateChecker ────────────────────────────────────── */
function DateChecker({ tc, language }: { tc: any; language: Language }) {
  const text = t(language).dca;
  const [checkDate, setCheckDate] = useState("");
  const [checkMarket, setCheckMarket] = useState<MarketType>("A");

  const result = useMemo(() => {
    if (!checkDate) return null;
    const d = new Date(checkDate + "T00:00:00");
    const open = isTradingDay(checkMarket, d);
    const reason = open ? null : closureReason(checkMarket, d);
    return { open, reason };
  }, [checkDate, checkMarket]);

  return (
    <div className="rounded-xl p-3" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <Info size={12} color="#8B5CF6" />
        <span style={{ color: tc.textSecondary, fontSize: 11, fontWeight: 600 }}>{text.dateCheckerTitle}</span>
      </div>
      <div className="flex gap-2 mb-2">
        <input
          type="date"
          value={checkDate}
          onChange={(e) => setCheckDate(e.target.value)}
          className="flex-1 rounded-lg px-2 py-1.5 outline-none"
          style={{ background: "var(--bg-surface2)", color: tc.textPrimary, border: `1px solid ${tc.border}`, fontSize: 11 }}
        />
        <select
          value={checkMarket}
          onChange={(e) => setCheckMarket(e.target.value as MarketType)}
          className="rounded-lg px-2 py-1.5 outline-none"
          style={{ background: "var(--bg-surface2)", color: tc.textSecondary, border: `1px solid ${tc.border}`, fontSize: 11 }}
        >
          {CHECKER_MARKETS.map((m) => (
            <option key={m} value={m} style={{ background: "var(--option-bg)", color: tc.textPrimary }}>{getMarketBadge(m, language).label}</option>
          ))}
        </select>
      </div>
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2"
            style={{
              background: result.open ? "rgba(49,208,139,0.08)" : "rgba(242,78,78,0.08)",
              border: `1px solid ${result.open ? "rgba(49,208,139,0.2)" : "rgba(242,78,78,0.2)"}`,
            }}
          >
            {result.open
              ? <CheckCircle2 size={13} color="#31D08B" />
              : <AlertCircle  size={13} color="#F24E4E" />}
            <div>
              <span style={{ color: result.open ? "#31D08B" : "#F24E4E", fontSize: 12, fontWeight: 600 }}>
                {result.open ? text.isTradingDay : text.isClosed}
              </span>
              {result.reason && (
                <span style={{ color: tc.textMuted, fontSize: 10, marginLeft: 6 }}>{translateClosureReason(result.reason, language)}</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── PlanForm ───────────────────────────────────────── */
interface PlanFormData {
  holdingId: string;
  name: string;
  amount: string;
  currency: string;
  frequency: DCAFrequency;
  dayOfWeek: number; dayOfMonth: number; startDate: string; note: string;
}

const defaultForm = (): PlanFormData => ({
  holdingId: "",
  name: "",
  amount: "",
  currency: "",
  frequency: "monthly",
  dayOfWeek: 1, dayOfMonth: 15,
  startDate: new Date().toISOString().split("T")[0] ?? "",
  note: "",
});

function PlanForm({
  initial, tc, holdings, plans, executions, preferredHoldingId, existingPlanId, lockHolding, language, onSave, onCancel,
}: {
  initial?: PlanFormData; tc: any;
  holdings: Holding[];
  plans: DCAPlan[];
  executions: DCAExecution[];
  preferredHoldingId?: string | null;
  existingPlanId?: string | null;
  lockHolding?: boolean;
  language: Language;
  onSave: (f: PlanFormData) => void; onCancel: () => void;
}) {
  const text = t(language).dca;
  const holdingLocked = Boolean(lockHolding || existingPlanId);
  const availableHoldings = useMemo(() => {
    if (existingPlanId) return holdings;
    const plannedHoldingIds = new Set(plans.map((plan) => plan.holdingId));
    return holdings.filter((holding) => !plannedHoldingIds.has(holding.id));
  }, [existingPlanId, holdings, plans]);
  const selectableHoldings = holdingLocked ? holdings : availableHoldings;
  const [form, setForm] = useState<PlanFormData>(() => {
    const base = initial ?? defaultForm();
    const candidates = holdingLocked ? holdings : availableHoldings;
    const fallbackHoldingId = initial?.holdingId
      ?? (preferredHoldingId && candidates.some((holding) => holding.id === preferredHoldingId) ? preferredHoldingId : undefined)
      ?? "";
    const selectedHolding = holdings.find((holding) => holding.id === fallbackHoldingId);
    return {
      ...base,
      holdingId: fallbackHoldingId,
      currency: base.currency || selectedHolding?.currency || "",
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const selectedHolding = holdings.find((holding) => holding.id === form.holdingId);
  const previewBlockedStatus = dcaBlockedStatus(selectedHolding, form.amount, language);
  const relevantExecutions = useMemo(() => {
    if (existingPlanId) {
      return executions.filter((item) => item.planId === existingPlanId);
    }
    return [];
  }, [executions, existingPlanId]);

  const set = (k: keyof PlanFormData) => (v: any) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!selectedHolding) return;
    setForm((current) => ({
      ...current,
      currency: selectedHolding.currency,
    }));
  }, [selectedHolding]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.holdingId) e.holdingId = text.validateHolding;
    if (!existingPlanId && plans.some((plan) => plan.holdingId === form.holdingId)) {
      e.holdingId = text.validateDuplicate;
    }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0)
      e.amount = text.validateAmount;
    return e;
  };

  const handleSave = () => {
    if (saving) return;
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setSaving(true);
    onSave(form);
  };

  const inputStyle = (errKey?: string) => ({
    background: "var(--bg-surface2)",
    border: `1px solid ${errors[errKey!] ? "#F24E4E" : tc.border}`,
    color: tc.textPrimary,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    outline: "none",
    width: "100%",
  });

  const labelStyle = { color: tc.textSecondary, fontSize: 11, marginBottom: 4, display: "block" as const };

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {/* Name */}
      <div>
        <label style={labelStyle}>{text.selectHolding}</label>
        <select
          style={{ ...inputStyle("holdingId"), padding: "6px 8px" }}
          value={form.holdingId}
          onChange={(e) => set("holdingId")(e.target.value)}
          disabled={holdingLocked}
        >
          <option value="" style={{ background: "var(--option-bg)", color: tc.textPrimary }}>{text.chooseHolding}</option>
          {selectableHoldings.map((holding) => (
            <option key={holding.id} value={holding.id} style={{ background: "var(--option-bg)", color: tc.textPrimary }}>
              {holding.name} · {holding.symbol}
            </option>
          ))}
        </select>
        {errors.holdingId && <p style={{ color: "#F24E4E", fontSize: 10, marginTop: 2 }}>{errors.holdingId}</p>}
        {!existingPlanId && availableHoldings.length === 0 && (
          <p style={{ color: tc.textMicro, fontSize: 10, marginTop: 4 }}>{text.allHoldingsPlanned}</p>
        )}
        {selectedHolding && (
          <p style={{ color: tc.textMicro, fontSize: 10, marginTop: 4 }}>
            {getMarketBadge(selectedHolding.market, language).label} · {selectedHolding.currency} · {(() => { const m = planStatusMeta(selectedHolding, language); const s = translateTradeText(cleanTradeSource(m.source ?? ""), language); return s ? `${s} · ${m.label}` : m.label; })()}
            {holdingLocked ? ` · ${text.holdingLocked}` : ""}
          </p>
        )}
      </div>

      {/* Amount + Currency */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label style={labelStyle}>{text.amountPerPeriod}</label>
          <input type="number" style={inputStyle("amount")} value={form.amount}
            onChange={(e) => set("amount")(e.target.value)} placeholder="500" />
          {errors.amount && <p style={{ color: "#F24E4E", fontSize: 10, marginTop: 2 }}>{errors.amount}</p>}
        </div>
        <div>
          <label style={labelStyle}>{text.currency}</label>
          <div style={{ ...inputStyle(), display: "flex", alignItems: "center", color: tc.textSecondary }}>
            {form.currency || text.autoCurrency}
          </div>
        </div>
      </div>

      {/* Frequency */}
      <div>
        <label style={labelStyle}>{text.frequency}</label>
        <div className="flex gap-1.5">
          {FREQ_OPTIONS.map((f) => (
            <button key={f} onClick={() => set("frequency")(f)}
              className="flex-1 rounded-lg py-1.5 transition-all"
              style={{
                fontSize: 11, fontWeight: 500,
                background: form.frequency === f ? "rgba(79,156,249,0.2)" : "var(--bg-card)",
                color:      form.frequency === f ? "#4F9CF9" : tc.textMuted,
                border: `1px solid ${form.frequency === f ? "rgba(79,156,249,0.4)" : tc.border}`,
              }}>
              {frequencyLabel(f, language)}
            </button>
          ))}
        </div>
      </div>

      {/* Day selector (conditional) */}
      {form.frequency === "weekly" && (
        <div>
          <label style={labelStyle}>{text.weekday}</label>
          <div className="flex gap-1">
            {WEEKDAY_OPTIONS.map((v) => (
              <button key={v} onClick={() => set("dayOfWeek")(v)}
                className="flex-1 rounded-lg py-1 transition-all"
                style={{
                  fontSize: 10,
                  background: form.dayOfWeek === v ? "rgba(79,156,249,0.2)" : "var(--bg-card)",
                  color:      form.dayOfWeek === v ? "#4F9CF9" : tc.textMuted,
                  border: `1px solid ${form.dayOfWeek === v ? "rgba(79,156,249,0.3)" : tc.border}`,
                }}>
                {weekdayLabel(v, language)}
              </button>
            ))}
          </div>
          <p style={{ color: tc.textMicro, fontSize: 10, marginTop: 4 }}>
            {text.nonTradingPostpone}
          </p>
        </div>
      )}

      {form.frequency === "monthly" && (
        <div>
          <label style={labelStyle}>{text.dayOfMonth}</label>
          <div className="flex items-center gap-2">
            <input type="number" min={1} max={28}
              style={{ ...inputStyle(), width: 70 }}
              value={form.dayOfMonth}
              onChange={(e) => set("dayOfMonth")(Math.min(28, Math.max(1, Number(e.target.value))))}
            />
            <span style={{ color: tc.textMuted, fontSize: 11 }}>{text.day}</span>
            <span style={{ color: tc.textMicro, fontSize: 10 }}>{text.nonTradingPostpone}</span>
          </div>
        </div>
      )}

      {/* Start date */}
      <div>
        <label style={labelStyle}>{text.startDate}</label>
        <input type="date" style={inputStyle()} value={form.startDate}
          onChange={(e) => set("startDate")(e.target.value)} />
      </div>

      {/* Schedule preview */}
      {selectedHolding && (
        <SchedulePreview
          market={selectedHolding.market as MarketType}
          name={selectedHolding.name}
          frequency={form.frequency}
          dayOfWeek={form.dayOfWeek}
          dayOfMonth={form.dayOfMonth}
          startDate={form.startDate}
          blockedStatus={previewBlockedStatus}
          tc={tc}
          language={language}
        />
      )}

      {existingPlanId && (
        <ExecutionHistory
          executions={relevantExecutions}
          holding={selectedHolding}
          planForSettlement={selectedHolding ? {
            market: selectedHolding.market as MarketType,
            name: selectedHolding.name,
            assetType: selectedHolding.assetType,
            fundBuyConfirmDays: selectedHolding.fundBuyConfirmDays,
          } : undefined}
          planStats={existingPlanId ? plans.find((plan) => plan.id === existingPlanId) : undefined}
          tc={tc}
          title={text.records}
          language={language}
        />
      )}

      {/* Buttons */}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-xl py-2.5"
          style={{ background: "var(--bg-surface2)", color: tc.textSecondary, fontSize: 13 }}>
          {t(language).common.cancel}
        </button>
        <button onClick={handleSave} disabled={saving} className="flex-1 rounded-xl py-2.5"
          style={{ background: saving ? "var(--bg-card)" : "linear-gradient(135deg,#2563EB,#7C3AED)", color: saving ? "var(--text-micro)" : "#fff", fontSize: 13, fontWeight: 600 }}>
          {saving ? t(language).common.saving : text.savePlan}
        </button>
      </div>
    </div>
  );
}

/* ─── Main DCAPanel ──────────────────────────────────── */
type PanelView = "list" | "create" | "edit" | "checker";

export function DCAPanel() {
  const {
    tc, holdings, dcaPlans, dcaExecutions, dcaPanelOpen, dcaPanelHoldingId,
    addDCAPlan, updateDCAPlan, removeDCAPlan, toggleDCAPlan,
    closeDCAPanel, language,
  } = useApp();
  const text = t(language);

  const [view, setView] = useState<PanelView>("list");
  const [editPlan, setEditPlan] = useState<DCAPlan | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const autoNavigatedRef = useRef(false);

  const totalInvested = dcaPlans.reduce((s, p) => s + p.totalInvested, 0);
  const activeCount   = dcaPlans.filter((p) => p.enabled).length;
  const holdingsById = useMemo(() => new Map(holdings.map((holding) => [holding.id, holding])), [holdings]);
  const latestExecutionByPlan = useMemo(() => {
    const map = new Map<string, DCAExecution>();
    for (const item of dcaExecutions) {
      const prev = map.get(item.planId);
      const itemDate = item.actualDate ?? item.confirmedDate ?? item.scheduledDate;
      const prevDate = prev ? (prev.actualDate ?? prev.confirmedDate ?? prev.scheduledDate) : "";
      if (!prev || itemDate > prevDate) {
        map.set(item.planId, item);
      }
    }
    return map;
  }, [dcaExecutions]);

  useEffect(() => {
    if (!dcaPanelOpen) {
      autoNavigatedRef.current = false;
      setView("list");
      setEditPlan(null);
      return;
    }
    if (dcaPanelHoldingId && view === "list" && !autoNavigatedRef.current) {
      autoNavigatedRef.current = true;
      const existing = dcaPlans.find((plan) => plan.holdingId === dcaPanelHoldingId);
      if (existing) {
        setEditPlan(existing);
        setView("edit");
      } else {
        setEditPlan(null);
        setView("create");
      }
    }
  }, [dcaPanelHoldingId, dcaPanelOpen, dcaPlans, view]);

  const handleSave = (form: PlanFormData) => {
    const linkedHolding = holdings.find((holding) => holding.id === form.holdingId);
    if (!linkedHolding) return;
    if (!(view === "edit" && editPlan) && dcaPlans.some((plan) => plan.holdingId === form.holdingId)) {
      return;
    }
    const scheduleMarket = effectiveDcaMarket(linkedHolding.market as MarketType, linkedHolding.name);
    const nextPreview = calcNextExecutions(scheduleMarket, {
      frequency: form.frequency,
      dayOfWeek: form.dayOfWeek,
      dayOfMonth: form.dayOfMonth,
      startDate: form.startDate,
    }, 1, new Date(), true)[0];
    const base = {
      holdingId:   form.holdingId,
      name:        linkedHolding.name,
      symbol:      linkedHolding.symbol,
      market:      linkedHolding.market as MarketType,
      assetType:   linkedHolding.assetType,
      amount:     Number(form.amount),
      currency:   linkedHolding.currency,
      frequency:  form.frequency,
      dayOfWeek:  form.dayOfWeek,
      dayOfMonth: form.dayOfMonth,
      startDate:  form.startDate,
      enabled:    true,
      note:       form.note,
      nextExecDate: nextPreview?.actual,
    };
    if (view === "edit" && editPlan) {
      updateDCAPlan(editPlan.id, base);
    } else {
      addDCAPlan(base);
    }
    setView("list");
    setEditPlan(null);
    closeDCAPanel();
  };

  const editFormData = (plan: DCAPlan): PlanFormData => ({
    holdingId:   plan.holdingId,
    name:       holdingsById.get(plan.holdingId)?.name ?? plan.name,
    amount:     String(plan.amount),
    currency:   plan.currency,
    frequency:  plan.frequency,
    dayOfWeek:  plan.dayOfWeek ?? 1,
    dayOfMonth: plan.dayOfMonth ?? 15,
    startDate:  plan.startDate,
    note:       plan.note ?? "",
  });

  return (
    <AnimatePresence>
      {dcaPanelOpen && (
        <motion.div
          initial={{ x: 400 }} animate={{ x: 0 }} exit={{ x: 400 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="absolute inset-0 flex flex-col overflow-hidden z-30"
          style={{ background: tc.bg }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 shrink-0"
            style={{ height: 50, borderBottom: `1px solid ${tc.border}` }}>
            {view !== "list" && (
              <button
                onClick={() => {
                  if (autoNavigatedRef.current) {
                    closeDCAPanel();
                  } else {
                    setView("list");
                    setEditPlan(null);
                  }
                }}
                className="rounded-lg px-2 py-1"
                style={{ background: tc.bgCard, color: tc.textMuted, fontSize: 11 }}
              >
                {text.common.back}
              </button>
            )}
            <span style={{ color: tc.textPrimary, fontSize: 14, fontWeight: 600, flex: 1 }}>
              {view === "list"    ? text.dca.title
               : view === "create" ? text.dca.create
               : view === "checker"? text.dca.checker
               : text.dca.edit}
            </span>
            {view === "list" && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setView("checker")}
                  className="rounded-lg px-2 py-1"
                  style={{ background: "rgba(139,92,246,0.1)", color: "#8B5CF6", fontSize: 11 }}>
                  <CalendarClock size={13} />
                </button>
                <button onClick={() => { setEditPlan(null); setView("create"); }}
                  disabled={holdings.length === 0}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
                  style={{
                    background: holdings.length === 0 ? tc.bgCard : "linear-gradient(135deg,#2563EB,#7C3AED)",
                    color: holdings.length === 0 ? tc.textMicro : "#fff",
                    fontSize: 12,
                  }}>
                  <Plus size={12} /> {text.dca.new}
                </button>
              </div>
            )}
            {view !== "list" && (
              <button onClick={() => closeDCAPanel()}>
                <X size={16} color={tc.textMuted} />
              </button>
            )}
            {view === "list" && (
              <button onClick={() => closeDCAPanel()}>
                <X size={16} color={tc.textMuted} />
              </button>
            )}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>

            {/* ── List view ── */}
            {view === "list" && (
              <div>
                {/* Summary strip */}
                <div className="flex gap-px mx-3 mt-3 rounded-xl overflow-hidden"
                  style={{ border: `1px solid ${tc.border}` }}>
                  {[
                    { label: text.dca.planCount, value: dcaPlans.length, unit: language === "en" ? "" : "个" },
                    { label: text.dca.enabled, value: activeCount,     unit: language === "en" ? "" : "个",   color: "#31D08B" },
                    { label: text.dca.totalInvested, value: formatFixedNumber(totalInvested, 2), unit: "" },
                  ].map((item) => (
                    <div key={item.label} className="flex-1 py-2.5 text-center" style={{ background: tc.bgCard }}>
                      <p style={{ color: tc.textMicro, fontSize: 9 }}>{item.label}</p>
                      <p style={{ color: (item as any).color ?? tc.textPrimary, fontSize: 14, fontWeight: 700 }}>
                        {item.value}<span style={{ fontSize: 10 }}>{item.unit}</span>
                      </p>
                    </div>
                  ))}
                </div>

                {/* Plans */}
                <div className="flex flex-col gap-2 px-3 mt-3">
                  <AnimatePresence>
                    {dcaPlans.length === 0 && (
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="flex flex-col items-center justify-center py-12 gap-3">
                        <CalendarClock size={36} color={tc.textMicro} />
                        <p style={{ color: tc.textMuted, fontSize: 13 }}>{text.dca.empty}</p>
                        <button onClick={() => { setEditPlan(null); setView("create"); }}
                          disabled={holdings.length === 0}
                          className="rounded-xl px-4 py-2"
                          style={{
                            background: holdings.length === 0 ? tc.bgCard : "rgba(79,156,249,0.1)",
                            color: holdings.length === 0 ? tc.textMicro : "#4F9CF9",
                            fontSize: 12,
                          }}>
                          {text.dca.createNow}
                        </button>
                      </motion.div>
                    )}
                    {dcaPlans.map((plan) => (
                      <PlanCard
                        key={plan.id}
                        plan={plan}
                        holding={holdingsById.get(plan.holdingId)}
                        latestExecution={latestExecutionByPlan.get(plan.id)}
                        tc={tc}
                        language={language}
                        onEdit={() => { setEditPlan(plan); setView("edit"); }}
                        onDelete={() => setDeleteConfirm(plan.id)}
                        onToggle={() => toggleDCAPlan(plan.id)}
                      />
                    ))}
                  </AnimatePresence>
                </div>

                {/* Calendar legend */}
                <div className="mx-3 mt-4 rounded-xl px-3 py-2.5"
                  style={{ background: "rgba(79,156,249,0.05)", border: "1px solid rgba(79,156,249,0.1)" }}>
                  <div className="flex items-start gap-2">
                    <Info size={12} color="#4F9CF9" className="shrink-0 mt-0.5" />
                    <p style={{ color: tc.textMuted, fontSize: 10, lineHeight: 1.6 }}>
                      {text.dca.listNote}
                    </p>
                  </div>
                </div>

                <div style={{ height: 16 }} />
              </div>
            )}

            {/* ── Create / Edit view ── */}
            {(view === "create" || view === "edit") && (
              holdings.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <p style={{ color: tc.textMuted, fontSize: 13 }}>{text.dca.noHoldingFirst}</p>
                </div>
              ) : (
                <PlanForm
                  key={`${view}-${view === "edit" ? editPlan?.id ?? "missing" : dcaPanelHoldingId ?? "new"}`}
                  initial={view === "edit" && editPlan ? editFormData(editPlan) : undefined}
                  holdings={holdings}
                  plans={dcaPlans}
                  executions={dcaExecutions}
                  preferredHoldingId={dcaPanelHoldingId}
                  existingPlanId={view === "edit" ? editPlan?.id ?? null : null}
                  lockHolding={Boolean(dcaPanelHoldingId) || view === "edit"}
                  tc={tc}
                  language={language}
                  onSave={handleSave}
                  onCancel={() => {
                    if (autoNavigatedRef.current) {
                      closeDCAPanel();
                    } else {
                      setView("list");
                      setEditPlan(null);
                    }
                  }}
                />
              )
            )}

            {/* ── Checker view ── */}
            {view === "checker" && (
              <div className="px-3 py-3">
                <DateChecker tc={tc} language={language} />
              </div>
            )}
          </div>

          {/* Delete confirm */}
          <AnimatePresence>
            {deleteConfirm && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 flex items-center justify-center px-6"
                style={{ background: "var(--scrim)", zIndex: 10 }}>
                <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
                  className="w-full rounded-2xl p-5"
                  style={{ background: tc.bgOverlay, border: `1px solid ${tc.border}` }}>
                  <p style={{ color: tc.textPrimary, fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{text.dca.deleteTitle}</p>
                  <p style={{ color: tc.textMuted, fontSize: 13, marginBottom: 16 }}>{text.dca.deleteDesc}</p>
                  <div className="flex gap-2">
                    <button onClick={() => setDeleteConfirm(null)}
                      className="flex-1 rounded-xl py-2.5"
                      style={{ background: "var(--bg-surface2)", color: tc.textSecondary, fontSize: 13 }}>
                      {text.common.cancel}
                    </button>
                    <button onClick={() => {
                      const targetId = deleteConfirm;
                      if (!targetId) return;
                      removeDCAPlan(targetId);
                      setDeleteConfirm(null);
                    }}
                      className="flex-1 rounded-xl py-2.5"
                      style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>
                      {text.common.confirmDelete}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
