/**
 * DCA (Dollar-Cost-Averaging) settlement engine.
 * Extracted from AppContext.tsx to reduce file size.
 */

import type { Holding } from "../data/mockData";
import type { DCAPlan, DCAExecution } from "../context/AppContext";
import type { MarketType } from "../services/tradingCalendar";
import { nextExecutionDate, isTradingDay, marketDate, effectiveDcaMarket, closureReason } from "../services/tradingCalendar";
import { resolveHoldingTradeStatus } from "../utils/tradeStatus";
import { normalizeHoldingType, normalizeHoldingSymbol, applyHoldingAdjustment, recomputeHoldingMetrics } from "./holdingHelpers";
import { safeUUID } from "./safeId";

const DCA_QUOTE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/* ─── date helpers ──────────────────────────────────── */

export function fromYMDLocal(s: string) {
  const [year, month, day] = s.split("-").map(Number);
  if (!year || !month || !day) return new Date(Number.NaN);
  return new Date(year, month - 1, day);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function marketNoonFromYMD(s: string) {
  const [year, month, day] = s.split("-").map(Number);
  if (!year || !month || !day) return new Date(Number.NaN);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function todayYMD(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* ─── plan helpers ──────────────────────────────────── */

export function originalScheduledDate(plan: DCAPlan, adjustedDate: string): string {
  if (plan.frequency === "daily") return adjustedDate;
  const d = fromYMDLocal(adjustedDate);
  if (plan.frequency === "monthly" && plan.dayOfMonth) {
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const targetDay = Math.min(plan.dayOfMonth, lastDay);
    const original = new Date(d.getFullYear(), d.getMonth(), targetDay);
    if (original > d) original.setMonth(original.getMonth() - 1);
    return todayYMD(original);
  }
  if (plan.frequency === "weekly" && plan.dayOfWeek != null) {
    const diff = d.getDay() - normalizeDayOfWeek(plan.dayOfWeek);
    const original = new Date(d);
    original.setDate(d.getDate() - (diff >= 0 ? diff : diff + 7));
    return todayYMD(original);
  }
  return adjustedDate;
}

function normalizeDayOfWeek(value: number | undefined) {
  if (typeof value !== "number" || !Number.isInteger(value)) return 1;
  return ((value % 7) + 7) % 7;
}

export function computeNextExec(plan: DCAPlan, from = new Date(), includeFrom = true): string {
  return nextExecutionDate(effectiveDcaMarket(plan.market, plan.name), {
    frequency:  plan.frequency,
    dayOfWeek:  plan.frequency === "weekly" ? normalizeDayOfWeek(plan.dayOfWeek) : plan.dayOfWeek,
    dayOfMonth: plan.dayOfMonth,
    startDate:  plan.startDate,
  }, from, includeFrom);
}

export function syncPlanWithHolding(plan: DCAPlan, holding: Holding): DCAPlan {
  const normalizedType = normalizeHoldingType(holding.symbol, holding.name, holding.market, holding.assetType);
  const normalizedSymbol = normalizeHoldingSymbol(holding.symbol, normalizedType.market);
  const fundBuyConfirmDays = Number.isInteger(holding.fundBuyConfirmDays) && holding.fundBuyConfirmDays! >= 0 && holding.fundBuyConfirmDays! <= 30
    ? holding.fundBuyConfirmDays
    : undefined;
  return {
    ...plan,
    holdingId: holding.id,
    name: holding.name,
    symbol: normalizedSymbol,
    market: normalizedType.market as MarketType,
    assetType: normalizedType.assetType,
    currency: holding.currency,
    fundBuyConfirmDays,
  };
}

export function repairDCAData(
  holdings: Holding[],
  plans: DCAPlan[],
  executions: DCAExecution[],
): { holdings: Holding[]; plans: DCAPlan[]; executions: DCAExecution[]; changed: boolean } {
  const holdingMap = new Map(holdings.map((holding) => [holding.id, holding]));
  let changed = false;
  const syncedPlans = plans.map((plan) => {
    const holding = holdingMap.get(plan.holdingId);
    if (!holding) return plan;
    const synced = syncPlanWithHolding(plan, holding);
    if (
      synced.name !== plan.name ||
      synced.market !== plan.market ||
      synced.symbol !== plan.symbol ||
      synced.assetType !== plan.assetType ||
      synced.currency !== plan.currency ||
      synced.fundBuyConfirmDays !== plan.fundBuyConfirmDays
    ) {
      changed = true;
      return synced;
    }
    return plan;
  });
  const planMap = new Map(syncedPlans.map((p) => [p.id, p]));
  const settlementToday = todayYMD(marketDate("A", new Date()));

  const repairedExecs = executions.map((exec) => {
    const plan = planMap.get(exec.planId);
    if (!plan) return exec;
    const holding = holdingMap.get(plan.holdingId);

    const correctedScheduled = originalScheduledDate(plan, exec.actualDate);
    const scheduledFixed = correctedScheduled !== exec.scheduledDate;

    const execDate = fromYMDLocal(exec.actualDate);
    const scheduleMarket = effectiveDcaMarket(plan.market as MarketType, plan.name);
    const scheduleToday = todayYMD(marketDate(scheduleMarket, new Date()));
    const isFundPlan = isFundHolding(undefined, plan);
    const expectedFundConfirmedDate = isFundPlan ? computeFundConfirmationDate(plan, exec.actualDate) : undefined;
    const wasOnNonTradingDay = exec.status === "executed" && !isTradingDay(scheduleMarket, execDate);
    const wasSameDayFundBooked =
      exec.status === "executed" &&
      isFundPlan &&
      exec.actualDate >= scheduleToday &&
      !exec.confirmedDate;
    const wasPrematurelyConfirmed =
      exec.status === "executed" &&
      isFundPlan &&
      !wasOnNonTradingDay &&
      countFundSettlementTradingDays(plan, exec.actualDate, settlementToday) < fundSettlementDays(plan);
    const hasWrongFundConfirmedDate =
      exec.status === "executed" &&
      isFundPlan &&
      Boolean(expectedFundConfirmedDate) &&
      exec.confirmedDate !== expectedFundConfirmedDate &&
      countFundSettlementTradingDays(plan, exec.actualDate, settlementToday) >= fundSettlementDays(plan);
    const shouldRestorePendingFundSkip =
      isPendingFundSkip(exec, plan) &&
      countFundSettlementTradingDays(plan, exec.actualDate, settlementToday) <= fundSettlementDays(plan);
    const hasRecoveredFundNav =
      isFundNavDataSkip(exec, plan) &&
      Boolean(holding) &&
      Boolean(confirmedFundPrice(holding, plan, exec.actualDate, settlementToday));
    if (!scheduledFixed && !wasOnNonTradingDay && !wasSameDayFundBooked && !wasPrematurelyConfirmed && !shouldRestorePendingFundSkip && !hasWrongFundConfirmedDate && !hasRecoveredFundNav) return exec;
    changed = true;

    if (hasWrongFundConfirmedDate) {
      return {
        ...exec,
        scheduledDate: correctedScheduled,
        adjusted: correctedScheduled !== exec.actualDate,
        navDate: exec.navDate ?? exec.actualDate,
        confirmedDate: expectedFundConfirmedDate,
      };
    }

    if (wasSameDayFundBooked || wasPrematurelyConfirmed || shouldRestorePendingFundSkip || hasRecoveredFundNav) {
      return {
        ...exec,
        scheduledDate: correctedScheduled,
        adjusted: correctedScheduled !== exec.actualDate,
        status: "pending" as const,
        reason: "等待正式净值确认后入账",
        quantity: undefined,
        price: undefined,
        navDate: undefined,
        confirmedDate: undefined,
      };
    }

    if (wasOnNonTradingDay) {
      return {
        ...exec,
        scheduledDate: correctedScheduled,
        adjusted: correctedScheduled !== exec.actualDate,
        status: "skipped" as const,
        reason: `修复：${closureReason(scheduleMarket, execDate) ?? "非交易日"}不可执行`,
        quantity: undefined,
        price: undefined,
        navDate: undefined,
        confirmedDate: undefined,
      };
    }
    return { ...exec, scheduledDate: correctedScheduled, adjusted: correctedScheduled !== exec.actualDate };
  });

  if (!changed) return { holdings, plans, executions, changed: false };

  const reversals = new Map<string, { quantity: number; costAmount: number }>();
  const planReversedDates = new Map<string, string>();
  for (let i = 0; i < executions.length; i++) {
    const orig = executions[i];
    const repaired = repairedExecs[i];
    if (!orig || !repaired) continue;
    if (orig.status === "executed" && repaired.status !== "executed") {
      if (orig.quantity && orig.price) {
        const prev = reversals.get(orig.holdingId) ?? { quantity: 0, costAmount: 0 };
        prev.quantity += orig.quantity;
        prev.costAmount += orig.quantity * orig.price;
        reversals.set(orig.holdingId, prev);
      }
      const earliest = planReversedDates.get(orig.planId);
      if (!earliest || orig.actualDate < earliest) {
        planReversedDates.set(orig.planId, orig.actualDate);
      }
    }
  }

  const repairedHoldings = holdings.map((h) => {
    const rev = reversals.get(h.id);
    if (!rev || rev.quantity <= 0) return h;
    const effectiveRevQuantity = Math.min(rev.quantity, h.quantity);
    const effectiveRevCost = rev.costAmount * (effectiveRevQuantity / rev.quantity);
    const nextQuantity = Math.max(0, h.quantity - effectiveRevQuantity);
    const remainingCostBasis = h.quantity * h.costPrice - effectiveRevCost;
    const nextCostPrice = nextQuantity > 0 ? remainingCostBasis / nextQuantity : h.costPrice;
    return recomputeHoldingMetrics(h, {
      quantity: nextQuantity,
      costPrice: Math.max(0, nextCostPrice),
    });
  });

  const planExecStats = new Map<string, { count: number; invested: number }>();
  for (const exec of repairedExecs) {
    if (exec.status !== "executed") continue;
    const prev = planExecStats.get(exec.planId) ?? { count: 0, invested: 0 };
    prev.count += 1;
    prev.invested += exec.amount;
    planExecStats.set(exec.planId, prev);
  }

  const repairedPlans = syncedPlans.map((plan) => {
    const stats = planExecStats.get(plan.id) ?? { count: 0, invested: 0 };
    const shouldRollbackStats = planReversedDates.has(plan.id);
    const nextCount = shouldRollbackStats ? stats.count : Math.max(plan.execCount ?? 0, stats.count);
    const nextInvested = shouldRollbackStats ? stats.invested : Math.max(plan.totalInvested ?? 0, stats.invested);
    const needsReset = plan.execCount !== nextCount || plan.totalInvested !== nextInvested;
    if (!needsReset) return plan;
    const repaired = {
      ...plan,
      execCount: nextCount,
      totalInvested: nextInvested,
    };
    const reversedDate = planReversedDates.get(plan.id);
    repaired.nextExecDate = reversedDate
      ? computeNextExec(repaired, fromYMDLocal(reversedDate), true)
      : computeNextExec(repaired);
    return repaired;
  });

  return { holdings: repairedHoldings, plans: repairedPlans, executions: repairedExecs, changed: true };
}

export function hydratePlans(plans: DCAPlan[], executions: DCAExecution[] = []): DCAPlan[] {
  const today = todayYMD();
  const executedPlanIds = new Set(executions.filter((item) => item.status === "executed").map((item) => item.planId));
  return plans.map((p) => {
    const hasSettled = executedPlanIds.has(p.id) || (p.execCount ?? 0) > 0 || (p.totalInvested ?? 0) > 0;
    const shouldRecoverFirstDueDate = !hasSettled && Boolean(p.startDate) && p.startDate <= today;
    return {
      ...p,
      nextExecDate: shouldRecoverFirstDueDate
        ? computeNextExec(p, fromYMDLocal(p.startDate), true)
        : (p.nextExecDate || computeNextExec(p)),
      totalInvested: p.totalInvested ?? 0,
      execCount: p.execCount ?? 0,
    };
  });
}

/* ─── evaluation ────────────────────────────────────── */

export function parseChineseMoneyLimit(text: string): number | null {
  const match = text.match(/(?:人民币|RMB|¥)?\s*((?:[0-9]+(?:\.[0-9]+)?\s*[万千百十]?[\s零]*)+)\s*(?:元|块)?/i);
  if (!match) return null;
  const unitMultiplier = (unit: string) => (
    unit === "万" ? 10000 :
    unit === "千" ? 1000 :
    unit === "百" ? 100 :
    unit === "十" ? 10 :
    1
  );
  let total = 0;
  let matched = false;
  const amountText = match[1] ?? "";
  for (const part of amountText.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*([万千百十]?)/g)) {
    const base = Number(part[1]);
    if (!Number.isFinite(base) || base <= 0) continue;
    total += base * unitMultiplier(part[2] ?? "");
    matched = true;
  }
  return matched && total > 0 ? total : null;
}

function fundLimitReason(note: string, amount?: number, limit?: number) {
  const details = limit != null && amount != null ? `，计划金额 ${amount} 元，限购 ${limit} 元` : "";
  return `${note || "基金限购"}${details}，自动定投已跳过`;
}

function evaluateHoldingBuyStatus(
  holding: Holding | undefined,
  amount?: number,
  options: { requirePrice?: boolean; requireFreshQuote?: boolean } = {},
): { ok: boolean; reason?: string } {
  const requirePrice = options.requirePrice ?? true;
  const requireFreshQuote = options.requireFreshQuote ?? true;
  if (!holding) return { ok: false, reason: "关联持仓不存在" };
  const resolved = resolveHoldingTradeStatus(holding);
  if (resolved.status === "fund_limit") {
    const limit = parseChineseMoneyLimit(resolved.note ?? "");
    if (limit != null && amount != null && amount <= limit + 1e-8) {
      return { ok: true, reason: `限购额度内执行（${resolved.note}）` };
    }
    return { ok: false, reason: fundLimitReason(resolved.note || resolved.label, amount, limit ?? undefined) };
  }
  if (resolved.status !== "normal") return { ok: false, reason: resolved.note || resolved.label };
  if (!requirePrice) return { ok: true };
  if (!Number.isFinite(holding.currentPrice) || holding.currentPrice <= 0) return { ok: false, reason: "暂无有效报价" };
  const updatedAt = Date.parse(holding.updatedAt ?? "");
  if (requireFreshQuote && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > DCA_QUOTE_FRESHNESS_MS)) {
    return { ok: false, reason: "报价未刷新，跳过自动定投" };
  }
  return { ok: true };
}

function isFundHolding(holding: Holding | undefined, plan?: DCAPlan) {
  return holding?.market === "FUND" || holding?.assetType === "fund" || plan?.market === "FUND" || plan?.assetType === "fund";
}

function dcaExecutionSortKey(item: DCAExecution) {
  return item.actualDate ?? item.confirmedDate ?? item.scheduledDate ?? "";
}

function dcaExecutionStatusRank(item: DCAExecution) {
  if (item.status === "executed") return 3;
  if (item.status === "pending") return 2;
  return 1;
}

function shouldReplaceDCAExecution(current: DCAExecution, next: DCAExecution) {
  const statusDiff = dcaExecutionStatusRank(next) - dcaExecutionStatusRank(current);
  if (statusDiff !== 0) return statusDiff > 0;
  return dcaExecutionSortKey(next).localeCompare(dcaExecutionSortKey(current)) > 0;
}

export function dedupeDCAExecutions(executions: DCAExecution[]) {
  const byExecutionDate = new Map<string, DCAExecution>();
  for (const execution of executions) {
    const key = `${execution.planId}:${execution.actualDate}`;
    const current = byExecutionDate.get(key);
    if (!current || shouldReplaceDCAExecution(current, execution)) {
      byExecutionDate.set(key, execution);
    }
  }
  return [...byExecutionDate.values()];
}

function fundHistoryWindow(holding: Holding | undefined) {
  const rows = holding?.fundNavHistory?.filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0) ?? [];
  if (!rows.length) return null;
  let latest = rows[0]!.date;
  let oldest = rows[0]!.date;
  for (const row of rows) {
    if (row.date > latest) latest = row.date;
    if (row.date < oldest) oldest = row.date;
  }
  return { latest, oldest };
}

function confirmedFundPrice(holding: Holding | undefined, plan: DCAPlan | undefined, executionDate: string, asOfDate: string) {
  if (!holding || !isFundHolding(holding, plan) || !plan) return null;
  const confirmedDate = computeFundConfirmationDate(plan, executionDate);
  if (asOfDate < confirmedDate) return null;
  const historicalNav = holding.fundNavHistory?.find((row) => row.date === executionDate)?.nav;
  const price: number | undefined = holding.priceDate === executionDate
    ? holding.currentPrice
    : historicalNav;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  return {
    price,
    navDate: executionDate,
    confirmedDate,
  };
}

function isPendingFundSkip(exec: DCAExecution, plan?: DCAPlan) {
  if (exec.status !== "skipped" || !isFundHolding(undefined, plan)) return false;
  const reason = exec.reason ?? "";
  return (
    reason.includes("报价未刷新") ||
    reason.includes("暂无有效报价")
  );
}

function isFundNavDataSkip(exec: DCAExecution, plan?: DCAPlan) {
  if (exec.status !== "skipped" || !isFundHolding(undefined, plan)) return false;
  const reason = exec.reason ?? "";
  return (
    reason.includes("未获取到") ||
    reason.includes("正式净值") ||
    reason.includes("净值缓存")
  );
}

function isBackfilledPendingFundExecution(exec: DCAExecution) {
  return exec.status === "pending" && (exec.reason ?? "").includes("补录待确认定投");
}

export function fundSettlementDays(plan: Pick<DCAPlan, "market" | "name"> & { assetType?: string; fundBuyConfirmDays?: number }): number {
  if (Number.isInteger(plan.fundBuyConfirmDays) && plan.fundBuyConfirmDays! >= 0 && plan.fundBuyConfirmDays! <= 30) {
    return plan.fundBuyConfirmDays!;
  }
  const baseMarket = plan.assetType === "fund" || plan.market === "FUND" ? "FUND" : plan.market;
  const effective = effectiveDcaMarket(baseMarket as MarketType, plan.name);
  return effective !== "FUND" && effective !== "A" ? 2 : 1;
}

function isFundSettlementTradingDay(plan: Pick<DCAPlan, "market" | "name"> & { assetType?: string; fundBuyConfirmDays?: number }, date: Date) {
  const baseMarket = plan.assetType === "fund" || plan.market === "FUND" ? "FUND" : plan.market;
  const effective = effectiveDcaMarket(baseMarket as MarketType, plan.name);
  if (effective === "FUND" || effective === "A") return isTradingDay("A", date);
  return isTradingDay("A", date) && isTradingDay(effective, date);
}

function addFundSettlementTradingDays(plan: Pick<DCAPlan, "market" | "name"> & { assetType?: string; fundBuyConfirmDays?: number }, fromDate: string, days: number): string {
  const d = fromYMDLocal(fromDate);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (isFundSettlementTradingDay(plan, d)) added++;
  }
  return todayYMD(d);
}

export function computeFundConfirmationDate(plan: Pick<DCAPlan, "market" | "name"> & { assetType?: string; fundBuyConfirmDays?: number }, executionDate: string): string {
  return addFundSettlementTradingDays(plan, executionDate, fundSettlementDays(plan));
}

function countFundSettlementTradingDays(
  plan: Pick<DCAPlan, "market" | "name"> & { assetType?: string; fundBuyConfirmDays?: number },
  fromDate: string,
  toDate: string,
): number {
  const start = fromYMDLocal(fromDate);
  const end = fromYMDLocal(toDate);
  let count = 0;
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  while (d <= end) {
    if (isFundSettlementTradingDay(plan, d)) count++;
    d.setDate(d.getDate() + 1);
    if (count > 30) break;
  }
  return count;
}

function dcaScheduleDate(plan: DCAPlan, now: Date): Date {
  return isFundHolding(undefined, plan)
    ? marketDate("FUND", now)
    : marketDate(effectiveDcaMarket(plan.market as MarketType, plan.name), now);
}

function settlePendingFundExecutions(
  holdings: Holding[],
  plans: DCAPlan[],
  executions: DCAExecution[],
  asOfDate: string,
) {
  const holdingMap = new Map(holdings.map((holding) => [holding.id, holding]));
  const planMap = new Map(plans.map((plan) => [plan.id, plan]));
  const nextHoldings = [...holdings];
  const nextExecutions = [...executions];
  let changed = false;

  for (let i = 0; i < nextExecutions.length; i++) {
    const execution = nextExecutions[i];
    if (!execution) continue;
    if (execution.status !== "pending") continue;

    const plan = planMap.get(execution.planId);
    const holdingIndex = nextHoldings.findIndex((holding) => holding.id === execution.holdingId);
    const holding = holdingIndex >= 0 ? nextHoldings[holdingIndex] : holdingMap.get(execution.holdingId);
    if (!holding || holdingIndex < 0) {
      nextExecutions[i] = {
        ...execution,
        status: "skipped",
        reason: "关联持仓不存在",
      };
      changed = true;
      continue;
    }

    if (plan && isFundHolding(holding, plan)) {
      const required = fundSettlementDays(plan);
      const elapsed = countFundSettlementTradingDays(plan, execution.actualDate, asOfDate);
      if (elapsed < required) continue;
    }

    const confirmed = confirmedFundPrice(holding, plan, execution.actualDate, asOfDate);
    if (!confirmed) {
      if (!isFundHolding(holding, plan)) {
        nextExecutions[i] = {
          ...execution,
          status: "skipped",
          reason: "待入账记录已不再关联基金持仓",
        };
        changed = true;
      } else if (plan && countFundSettlementTradingDays(plan, execution.actualDate, asOfDate) > fundSettlementDays(plan) + 5) {
        const staleAfterDays = fundSettlementDays(plan) + 5;
        const reason = `超过 ${staleAfterDays} 个确认交易日仍未获取到 ${execution.actualDate} 正式净值，已跳过`;
        nextExecutions[i] = {
          ...execution,
          status: "skipped",
          reason,
        };
        changed = true;
      } else if (holding.priceDate && holding.priceDate > execution.actualDate) {
        const window = fundHistoryWindow(holding);
        const isOutsideHistory = Boolean(window && execution.actualDate < window.oldest);
        const reason = isOutsideHistory
          ? `超出自动净值缓存窗口，暂未匹配 ${execution.actualDate} 正式净值，暂不入账`
          : `未获取到 ${execution.actualDate} 对应正式净值，暂不入账`;
        if (execution.reason === reason && execution.status === "pending") continue;
        nextExecutions[i] = {
          ...execution,
          status: "pending",
          reason,
        };
        changed = true;
      }
      continue;
    }

    if (plan && isFundHolding(holding, plan) && !isBackfilledPendingFundExecution(execution)) {
      const evaluation = evaluateHoldingBuyStatus(holding, execution.amount, {
        requirePrice: false,
        requireFreshQuote: false,
      });
      if (!evaluation.ok) {
        nextExecutions[i] = {
          ...execution,
          status: "skipped",
          reason: evaluation.reason,
        };
        changed = true;
        continue;
      }
    }

    const quantity = execution.amount / confirmed.price;
    if (!(quantity > 0)) {
      nextExecutions[i] = {
        ...execution,
        status: "skipped",
        reason: "确认份额计算失败",
      };
      changed = true;
      continue;
    }

    nextHoldings[holdingIndex] = applyHoldingAdjustment(holding, {
      type: "buy",
      quantity,
      price: confirmed.price,
    }) ?? holding;
    nextExecutions[i] = {
      ...execution,
      status: "executed",
      quantity,
      price: confirmed.price,
      navDate: confirmed.navDate,
      confirmedDate: confirmed.confirmedDate,
      reason: undefined,
    };
    changed = true;
  }

  if (!changed) return { holdings, executions, changed: false };
  return { holdings: nextHoldings, executions: nextExecutions, changed: true };
}

function reconcilePlanExecutionStats(plans: DCAPlan[], executions: DCAExecution[]) {
  const stats = new Map<string, { count: number; invested: number }>();
  for (const execution of executions) {
    if (execution.status !== "executed") continue;
    const current = stats.get(execution.planId) ?? { count: 0, invested: 0 };
    current.count += 1;
    current.invested += execution.amount;
    stats.set(execution.planId, current);
  }

  let changed = false;
  const nextPlans = plans.map((plan) => {
    const stat = stats.get(plan.id) ?? { count: 0, invested: 0 };
    const nextCount = Math.max(plan.execCount ?? 0, stat.count);
    const nextInvested = Math.max(plan.totalInvested ?? 0, stat.invested);
    if (plan.execCount === nextCount && plan.totalInvested === nextInvested) return plan;
    changed = true;
    return {
      ...plan,
      execCount: nextCount,
      totalInvested: nextInvested,
    };
  });

  return { plans: nextPlans, changed };
}

function backfillMissingPendingFundExecutions(
  plans: DCAPlan[],
  holdings: Holding[],
  executions: DCAExecution[],
  executionKeys: Set<string>,
  now: Date,
) {
  const holdingMap = new Map(holdings.map((holding) => [holding.id, holding]));
  const nextExecutions = [...executions];
  let changed = false;

  for (const plan of plans) {
    if (!plan.enabled || !isFundHolding(undefined, plan)) continue;
    const holding = holdingMap.get(plan.holdingId);
    if (!holding) continue;

    const planMarket = effectiveDcaMarket(plan.market as MarketType, plan.name);
    const planTodayDate = dcaScheduleDate(plan, now);
    const planToday = todayYMD(planTodayDate);
    const settlementToday = todayYMD(marketDate("A", now));
    const requiredSettlementDays = fundSettlementDays(plan);
    const cursor = new Date(planTodayDate);
    const scanLimit = plan.frequency === "daily" ? 14 : 45;

    for (let scanned = 0; scanned < scanLimit; scanned++) {
      const actualDate = todayYMD(cursor);
      if (actualDate < plan.startDate) break;
      if (actualDate >= planToday) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }

      if (isTradingDay(planMarket, cursor)) {
        const scheduledDate = originalScheduledDate(plan, actualDate);
        const expectedActualDate = computeNextExec(plan, marketNoonFromYMD(scheduledDate), true);
        if (expectedActualDate !== actualDate) {
          cursor.setDate(cursor.getDate() - 1);
          continue;
        }

        const elapsed = countFundSettlementTradingDays(plan, actualDate, settlementToday);
        const staleThreshold = requiredSettlementDays + 5;
        if (elapsed > staleThreshold) {
          cursor.setDate(cursor.getDate() - 1);
          continue;
        }

        const executionKey = `${plan.id}:${actualDate}`;
        if (!executionKeys.has(executionKey)) {
          nextExecutions.unshift({
            id: `dca_exec_${safeUUID()}`,
            planId: plan.id,
            holdingId: plan.holdingId,
            scheduledDate,
            actualDate,
            amount: plan.amount,
            adjusted: scheduledDate !== actualDate,
            status: "pending",
            reason: "补录待确认定投，等待正式净值确认后入账",
          });
          executionKeys.add(executionKey);
          changed = true;
        }
      }

      cursor.setDate(cursor.getDate() - 1);
    }
  }

  return { executions: nextExecutions, changed };
}

/* ─── settlement ────────────────────────────────────── */

export function settleDueDCAPlans(
  holdings: Holding[],
  plans: DCAPlan[],
  executions: DCAExecution[],
  now = new Date(),
  settleDue = true,
) {
  const holdingMap = new Map(holdings.map((holding) => [holding.id, holding]));
  const dedupedExecutions = dedupeDCAExecutions(executions);
  const executionKeys = new Set(dedupedExecutions.map((item) => `${item.planId}:${item.actualDate}`));
  const nextExecutions = [...dedupedExecutions];
  const nextHoldings = [...holdings];
  let nextPlans = [...plans];
  let changed = false;

  nextPlans = nextPlans.map((plan) => {
    const synced = holdingMap.has(plan.holdingId) ? syncPlanWithHolding(plan, holdingMap.get(plan.holdingId)!) : plan;
    if (synced !== plan) changed = true;
    return synced;
  });

  nextPlans = nextPlans.map((plan) => {
    if (!settleDue || !plan.enabled || plan.frequency !== "daily" || !isFundHolding(undefined, plan)) return plan;
    const planMarket = effectiveDcaMarket(plan.market as MarketType, plan.name);
    const planToday = todayYMD(dcaScheduleDate(plan, now));
    if (plan.startDate > planToday || !isTradingDay(planMarket, fromYMDLocal(planToday))) return plan;
    const hasTodayExecution = executionKeys.has(`${plan.id}:${planToday}`);
    if (hasTodayExecution || !plan.nextExecDate || plan.nextExecDate <= planToday) return plan;
    changed = true;
    return { ...plan, nextExecDate: planToday };
  });

  if (settleDue) {
    const backfilled = backfillMissingPendingFundExecutions(nextPlans, nextHoldings, nextExecutions, executionKeys, now);
    if (backfilled.changed) {
      nextExecutions.splice(0, nextExecutions.length, ...backfilled.executions);
      changed = true;
    }
  }

  if (!settleDue) {
    const statsState = reconcilePlanExecutionStats(nextPlans, nextExecutions);
    return {
      holdings: nextHoldings,
      plans: statsState.plans,
      executions: nextExecutions,
      changed: changed || statsState.changed,
    };
  }

  const todayForPendingSettlement = todayYMD(marketDate("A", now));
  const pendingState = settlePendingFundExecutions(nextHoldings, nextPlans, nextExecutions, todayForPendingSettlement);
  if (pendingState.changed) {
    nextHoldings.splice(0, nextHoldings.length, ...pendingState.holdings);
    nextExecutions.splice(0, nextExecutions.length, ...pendingState.executions);
    changed = true;
  }

  for (let i = 0; i < nextPlans.length; i++) {
    const plan = nextPlans[i];
    if (!plan) continue;
    const planMarket = effectiveDcaMarket(plan.market as MarketType, plan.name);
    const planMarketDate = dcaScheduleDate(plan, now);
    const today = todayYMD(planMarketDate);
    if (!plan.enabled || !plan.nextExecDate || plan.nextExecDate > today) continue;

    if (!isTradingDay(planMarket, planMarketDate)) continue;
    const actualDate = plan.nextExecDate;
    const nextSearchDate = marketNoonFromYMD(actualDate);

    const continuePlanIfStillDue = (previousDate: string) => {
      const nextExecDate = nextPlans[i]?.nextExecDate;
      if (nextExecDate && nextExecDate > previousDate && nextExecDate <= today) {
        i -= 1;
      }
    };

    const executionKey = `${plan.id}:${actualDate}`;
    const scheduledDate = originalScheduledDate(plan, actualDate);
    const adjusted = scheduledDate !== actualDate;
    if (executionKeys.has(executionKey)) {
      const nextDate = computeNextExec(plan, nextSearchDate, false);
      if (nextDate !== plan.nextExecDate) {
        nextPlans[i] = { ...plan, nextExecDate: nextDate };
        changed = true;
        continuePlanIfStillDue(actualDate);
      }
      continue;
    }

    const holdingIndex = nextHoldings.findIndex((item) => item.id === plan.holdingId);
    const holding = holdingIndex >= 0 ? nextHoldings[holdingIndex] : undefined;
    const evaluation = evaluateHoldingBuyStatus(holding, plan.amount);

    if (!evaluation.ok || !holding) {
      nextExecutions.unshift({
        id: `dca_exec_${safeUUID()}`,
        planId: plan.id,
        holdingId: plan.holdingId,
        scheduledDate,
        actualDate,
        amount: plan.amount,
        adjusted,
        status: "skipped",
        reason: evaluation.reason,
      });
      executionKeys.add(executionKey);
      nextPlans[i] = { ...plan, nextExecDate: computeNextExec(plan, nextSearchDate, false) };
      changed = true;
      continuePlanIfStillDue(actualDate);
      continue;
    }

    if (isFundHolding(holding, plan)) {
      nextExecutions.unshift({
        id: `dca_exec_${safeUUID()}`,
        planId: plan.id,
        holdingId: plan.holdingId,
        scheduledDate,
        actualDate,
        amount: plan.amount,
        adjusted,
        status: "pending",
        reason: "等待正式净值确认后入账",
      });
      executionKeys.add(executionKey);
      nextPlans[i] = { ...plan, nextExecDate: computeNextExec(plan, nextSearchDate, false) };
      changed = true;
      continuePlanIfStillDue(actualDate);
      continue;
    }

    const executionPrice = holding.currentPrice;
    const confirmedDate = undefined;
    const quantity = plan.amount / executionPrice;
    if (!(quantity > 0)) {
      nextExecutions.unshift({
        id: `dca_exec_${safeUUID()}`,
        planId: plan.id,
        holdingId: plan.holdingId,
        scheduledDate,
        actualDate,
        amount: plan.amount,
        adjusted,
        status: "skipped",
        reason: "买入份额计算失败",
      });
      executionKeys.add(executionKey);
      nextPlans[i] = { ...plan, nextExecDate: computeNextExec(plan, nextSearchDate, false) };
      changed = true;
      continuePlanIfStillDue(actualDate);
      continue;
    }

    nextHoldings[holdingIndex] = applyHoldingAdjustment(holding, {
      type: "buy",
      quantity,
      price: executionPrice,
    }) ?? holding;
    nextPlans[i] = {
      ...plan,
      totalInvested: plan.totalInvested + plan.amount,
      execCount: plan.execCount + 1,
      nextExecDate: computeNextExec(plan, nextSearchDate, false),
    };
    nextExecutions.unshift({
      id: `dca_exec_${safeUUID()}`,
      planId: plan.id,
      holdingId: plan.holdingId,
      scheduledDate,
      actualDate,
      amount: plan.amount,
      adjusted,
      status: "executed",
      quantity,
      price: executionPrice,
      confirmedDate,
    });
    executionKeys.add(executionKey);
    changed = true;
    continuePlanIfStillDue(actualDate);
  }

  const finalPendingState = settlePendingFundExecutions(nextHoldings, nextPlans, nextExecutions, todayForPendingSettlement);
  if (finalPendingState.changed) {
    nextHoldings.splice(0, nextHoldings.length, ...finalPendingState.holdings);
    nextExecutions.splice(0, nextExecutions.length, ...finalPendingState.executions);
    changed = true;
  }

  const statsState = reconcilePlanExecutionStats(nextPlans, nextExecutions);

  return {
    holdings: nextHoldings,
    plans: statsState.plans,
    executions: nextExecutions,
    changed: changed || statsState.changed,
  };
}
