import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Layers3,
  ReceiptText,
  RefreshCw,
  Trophy,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { t } from "../i18n";
import {
  computeReturnBreakdown,
  emptyReturnBreakdown,
  getDailyReturns,
  getHoldingReturnContributions,
  getMonthlyReturns,
  getYearlyReturns,
  mergeReturnBreakdowns,
  type DailyReturn,
  type MonthlyReturn,
  type PortfolioSnapshotInput,
  type YearlyReturn,
} from "../services/portfolioEvents";
import { convertCurrency, toCNY } from "../services/priceRefresher";
import { formatPercent } from "../utils/numberFormat";
import { breakdownBarWidth, formatCalendarMoney, formatCompactMoney, hasMeaningfulReturnData, returnEventValue } from "../utils/returnsPresentation";

type ScopeMode = "week" | "month" | "year" | "all";
type ViewLevel = "day" | "week" | "days" | "months" | "years";
type ReturnRow = DailyReturn | MonthlyReturn | YearlyReturn;

const chartColors = {
  unrealized: "#4F9CF9",
  realized: "#31D08B",
  dividend: "#F59E0B",
  fee: "#94A3B8",
  tax: "#64748B",
};

function localYMD(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addLocalDays(ymd: string, amount: number) {
  const [year = 1970, month = 1, day = 1] = ymd.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return localYMD(date);
}

export function startOfLocalWeek(ymd: string) {
  const [year = 1970, month = 1, day = 1] = ymd.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return localYMD(date);
}

function addLocalMonths(monthKey: string, amount: number) {
  const [year = 1970, month = 1] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1 + amount, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function addLocalYears(yearKey: string, amount: number) {
  return String(Number(yearKey) + amount);
}

function lastDayOfMonth(monthKey: string) {
  const [year = 1970, month = 1] = monthKey.split("-").map(Number);
  return localYMD(new Date(year, month, 0));
}

function rowKey(row: ReturnRow) {
  return "date" in row ? row.date : "month" in row ? row.month : row.year;
}

function sumRows(rows: ReturnRow[]) {
  return rows.reduce((total, row) => ({
    unrealizedPnlChange: total.unrealizedPnlChange + row.unrealizedPnlChange,
    realizedTradingPnl: total.realizedTradingPnl + row.realizedTradingPnl,
    dividendPnl: total.dividendPnl + row.dividendPnl,
    feePnl: total.feePnl + row.feePnl,
    totalPnl: total.totalPnl + row.totalPnl,
  }), {
    unrealizedPnlChange: 0,
    realizedTradingPnl: 0,
    dividendPnl: 0,
    feePnl: 0,
    totalPnl: 0,
  });
}

function formatPeriodTitle(key: string, level: ViewLevel, language: "zh" | "en", locale: string) {
  if (level === "years") return language === "en" ? "All Time" : "累计收益";
  if (level === "week") {
    const end = addLocalDays(key, 6);
    const format = (value: string) => {
      const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
      return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(year, month - 1, day));
    };
    return `${format(key)} - ${format(end)}`;
  }
  if (level === "months") return language === "en" ? key : `${key}年`;
  if (level === "days") {
    const [year = 1970, month = 1] = key.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month - 1, 1));
  }
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(new Date(year, month - 1, day));
}

function formatRowTitle(row: ReturnRow, locale: string) {
  const key = rowKey(row);
  if ("date" in row) {
    const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }).format(new Date(year, month - 1, day));
  }
  if ("month" in row) {
    const [year = 1970, month = 1] = key.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month - 1, 1));
  }
  return locale === "zh-CN" ? `${key}年` : key;
}

function priorTotalAsset(dailyRows: DailyReturn[], beforeDate: string): number {
  let asset = 0;
  for (const row of dailyRows) {
    if (row.date >= beforeDate) break;
    asset = row.totalAsset;
  }
  return asset;
}

function cellRate(totalPnl: number, startingAsset: number): number {
  return startingAsset > 0 ? totalPnl / startingAsset : 0;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function formatMonthShort(monthKey: string, locale: string) {
  const [, month = 1] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2000, month - 1, 1));
}

type GridCell = {
  key?: string;
  label: string;
  totalPnl: number;
  rate: number;
  row?: ReturnRow;
  disabled?: boolean;
  isToday?: boolean;
  blank?: boolean;
};

export function Returns() {
  const {
    portfolioEvents,
    portfolioEventBaseline,
    assetSnapshots,
    holdings,
    stats,
    privacyMode,
    togglePrivacy,
    refresh,
    isRefreshing,
    lastRefreshed,
    lastRefreshError,
    profitColor,
    language,
    currency,
  } = useApp();
  const text = t(language);
  const copy = text.returns;
  const locale = language === "en" ? "en-US" : "zh-CN";
  const today = localYMD();
  const currentWeek = startOfLocalWeek(today);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);
  const [scope, setScope] = useState<ScopeMode>("week");
  const [path, setPath] = useState<string[]>([]);
  const [selectedWeek, setSelectedWeek] = useState(currentWeek);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const refreshingActive = isRefreshing || manualRefreshing;

  useEffect(() => {
    if (!isRefreshing) setManualRefreshing(false);
  }, [isRefreshing]);

  const handleRefresh = useCallback(() => {
    if (refreshingActive) return;
    setManualRefreshing(true);
    void refresh();
  }, [refresh, refreshingActive]);

  const handleScopeChange = (next: ScopeMode) => {
    setScope(next);
    setPath([]);
    if (next === "week") setSelectedWeek(currentWeek);
    if (next === "month") setSelectedMonth(currentMonth);
    if (next === "year") setSelectedYear(currentYear);
  };

  const analysisSnapshots = useMemo<PortfolioSnapshotInput[]>(() => {
    const existingToday = assetSnapshots.find((snapshot) => snapshot.date === today);
    const holdingUnrealizedPnl = Object.fromEntries(holdings.map((holding) => [
      holding.id,
      toCNY((holding.currentPrice - holding.costPrice) * holding.quantity, holding.currency),
    ]));
    const currentSnapshot: PortfolioSnapshotInput = {
      ...existingToday,
      date: today,
      totalAsset: stats.totalAsset,
      todayPnl: stats.todayPnl,
      cumulativePnl: stats.cumulativePnl,
      unrealizedPnl: stats.unrealizedPnl,
      realizedTradingPnl: stats.realizedTradingPnl,
      dividendPnl: stats.dividendPnl,
      feePnl: stats.feePnl,
      totalPnl: stats.totalInvestmentPnl,
      migratedBaseline: existingToday?.migratedBaseline
        || (!assetSnapshots.some((snapshot) => Number.isFinite(snapshot.unrealizedPnl)) ? true : undefined),
      holdingUnrealizedPnl,
    };
    return [...assetSnapshots.filter((snapshot) => snapshot.date !== today), currentSnapshot]
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [assetSnapshots, holdings, stats, today]);

  const dailyRows = useMemo(
    () => getDailyReturns(portfolioEvents, analysisSnapshots, portfolioEventBaseline),
    [analysisSnapshots, portfolioEventBaseline, portfolioEvents],
  );

  const view = useMemo(() => {
    let level: ViewLevel;
    let key: string;
    if (scope === "week") {
      level = path[0] ? "day" : "week";
      key = path[0] || selectedWeek;
    } else if (scope === "month") {
      level = path[0] ? "day" : "days";
      key = path[0] || selectedMonth;
    } else if (scope === "year") {
      level = path[1] ? "day" : path[0] ? "days" : "months";
      key = path[1] || path[0] || selectedYear;
    } else {
      level = path[2] ? "day" : path[1] ? "days" : path[0] ? "months" : "years";
      key = path[2] || path[1] || path[0] || "all";
    }

    let start = dailyRows[0]?.date ?? today;
    let end = today;
    if (level === "day") {
      start = key;
      end = key;
    } else if (level === "week") {
      start = key;
      end = addLocalDays(key, 6);
    } else if (level === "days") {
      start = `${key}-01`;
      end = lastDayOfMonth(key);
    } else if (level === "months") {
      start = `${key}-01-01`;
      end = `${key}-12-31`;
    }
    if (end > today) end = today;

    return {
      level,
      key,
      start,
      end,
      title: formatPeriodTitle(key, level, language, locale),
    };
  }, [dailyRows, language, locale, path, scope, selectedMonth, selectedWeek, selectedYear, today]);

  const selectedDailyRows = useMemo(
    () => dailyRows.filter((row) => row.date >= view.start && row.date <= view.end),
    [dailyRows, view.end, view.start],
  );
  const displayRows = useMemo<ReturnRow[]>(() => {
    if (view.level === "years") return getYearlyReturns(selectedDailyRows);
    if (view.level === "months") return getMonthlyReturns(selectedDailyRows);
    return selectedDailyRows;
  }, [selectedDailyRows, view.level]);
  const totals = useMemo(() => sumRows(selectedDailyRows), [selectedDailyRows]);
  const periodEvents = useMemo(
    () => portfolioEvents.filter((event) => event.date >= view.start && event.date <= view.end),
    [portfolioEvents, view.end, view.start],
  );
  const eventBreakdown = useMemo(() => computeReturnBreakdown(periodEvents), [periodEvents]);
  const archivedBreakdown = useMemo(() => Object.entries(portfolioEventBaseline.daily)
    .filter(([date]) => date >= view.start && date <= view.end)
    .reduce((sum, [, row]) => mergeReturnBreakdowns(sum, row), emptyReturnBreakdown()),
  [portfolioEventBaseline, view.end, view.start]);
  const periodBreakdown = useMemo(
    () => mergeReturnBreakdowns(archivedBreakdown, eventBreakdown),
    [archivedBreakdown, eventBreakdown],
  );
  const incompleteCount = selectedDailyRows.filter((row) => row.incompleteBreakdown).length;
  const trackingStart = dailyRows[0]?.date;
  const containsBaseline = selectedDailyRows.some((row) => row.incompleteBreakdown)
    && analysisSnapshots.some((snapshot) => snapshot.migratedBaseline && snapshot.date >= view.start && snapshot.date <= view.end);
  const positiveDays = selectedDailyRows.filter((row) => row.totalPnl > 0).length;
  const activeDays = selectedDailyRows.filter((row) =>
    row.unrealizedPnlChange || row.realizedTradingPnl || row.dividendPnl || row.feePnl
  ).length;
  const startingAsset = selectedDailyRows[0]
    ? Math.max(0, selectedDailyRows[0].totalAsset - selectedDailyRows[0].totalPnl)
    : stats.costBasis;
  const periodRate = startingAsset > 0 ? totals.totalPnl / startingAsset : 0;
  const realizedIncome = periodBreakdown.realizedTradingPnl + periodBreakdown.dividendPnl + periodBreakdown.feePnl;

  const sourceRows = [
    { key: "unrealized", label: copy.unrealizedChange, value: totals.unrealizedPnlChange, color: chartColors.unrealized },
    { key: "realized", label: copy.realizedTrading, value: totals.realizedTradingPnl, color: chartColors.realized },
    { key: "dividend", label: copy.dividendIncome, value: totals.dividendPnl, color: chartColors.dividend },
    { key: "fee", label: copy.transactionFee, value: periodBreakdown.transactionFeePnl, color: chartColors.fee },
    { key: "tax", label: copy.transactionTax, value: periodBreakdown.taxPnl, color: chartColors.tax },
  ];

  const identityById = useMemo(() => {
    const map = new Map<string, { name: string; symbol: string }>();
    for (const holding of holdings) map.set(holding.id, { name: holding.name, symbol: holding.symbol });
    for (const event of portfolioEvents) {
      const id = event.holdingId || `${event.market ?? ""}:${event.symbol ?? ""}`;
      if (id && id !== ":" && !map.has(id)) {
        map.set(id, { name: event.name || event.symbol || id, symbol: event.symbol || "-" });
      }
    }
    return map;
  }, [holdings, portfolioEvents]);
  const rankRows = useMemo(() => getHoldingReturnContributions(
    portfolioEvents,
    analysisSnapshots,
    view.start,
    view.end,
  ).slice(0, 8).map((row) => ({
    ...row,
    ...(identityById.get(row.id) ?? { name: row.id, symbol: "-" }),
  })), [analysisSnapshots, identityById, portfolioEvents, view.end, view.start]);
  const rankIsEstimated = rankRows.some((row) => row.incompleteBreakdown)
    || Object.keys(portfolioEventBaseline.daily).some((date) => date >= view.start && date <= view.end);

  const gridCells = useMemo<GridCell[]>(() => {
    if (view.level === "week") {
      const rowByDate = new Map(selectedDailyRows.map((row) => [row.date, row]));
      return Array.from({ length: 7 }, (_, index) => {
        const date = addLocalDays(view.key, index);
        const row = rowByDate.get(date);
        const startingAsset = priorTotalAsset(dailyRows, date);
        return {
          key: date,
          label: String(Number(date.slice(-2))),
          totalPnl: row?.totalPnl ?? 0,
          rate: cellRate(row?.totalPnl ?? 0, startingAsset),
          row,
          disabled: date > today,
          isToday: date === today,
        };
      });
    }
    if (view.level === "days") {
      const [year = 1970, month = 1] = view.key.split("-").map(Number);
      const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
      const days = new Date(year, month, 0).getDate();
      const rowByDate = new Map(selectedDailyRows.map((row) => [row.date, row]));
      const blanks: GridCell[] = Array.from({ length: firstWeekday }, () => ({ blank: true, label: "", totalPnl: 0, rate: 0 }));
      const cells: GridCell[] = Array.from({ length: days }, (_, index) => {
        const day = index + 1;
        const date = `${view.key}-${String(day).padStart(2, "0")}`;
        const row = rowByDate.get(date);
        const startingAsset = priorTotalAsset(dailyRows, date);
        return {
          key: date,
          label: String(day),
          totalPnl: row?.totalPnl ?? 0,
          rate: cellRate(row?.totalPnl ?? 0, startingAsset),
          row,
          disabled: date > today,
          isToday: date === today,
        };
      });
      return [...blanks, ...cells];
    }
    if (view.level === "months") {
      const rowByKey = new Map(displayRows.map((row) => [rowKey(row), row]));
      return Array.from({ length: 12 }, (_, index) => {
        const monthKey = `${view.key}-${String(index + 1).padStart(2, "0")}`;
        const row = rowByKey.get(monthKey);
        const startingAsset = priorTotalAsset(dailyRows, `${monthKey}-01`);
        return {
          key: monthKey,
          label: formatMonthShort(monthKey, locale),
          totalPnl: row?.totalPnl ?? 0,
          rate: cellRate(row?.totalPnl ?? 0, startingAsset),
          row,
          disabled: `${monthKey}-01` > today,
        };
      });
    }
    if (view.level === "years") {
      const currentYearNum = Number(today.slice(0, 4));
      const rowByKey = new Map(displayRows.map((row) => [rowKey(row), row]));
      return Array.from({ length: 10 }, (_, index) => {
        const yearKey = String(currentYearNum - 9 + index);
        const row = rowByKey.get(yearKey);
        const startingAsset = priorTotalAsset(dailyRows, `${yearKey}-01-01`);
        return {
          key: yearKey,
          label: yearKey,
          totalPnl: row?.totalPnl ?? 0,
          rate: cellRate(row?.totalPnl ?? 0, startingAsset),
          row,
          disabled: `${yearKey}-01-01` > today,
        };
      });
    }
    return [];
  }, [dailyRows, displayRows, locale, selectedDailyRows, today, view.key, view.level]);

  const displayValue = useCallback((value: number) => convertCurrency(value, "CNY", currency), [currency]);
  const signedMoney = (value: number) => formatCompactMoney(displayValue(value), privacyMode, locale, currency);
  const handleDrill = (row: ReturnRow) => {
    if (view.level === "day") return;
    setPath((current) => [...current, rowKey(row)]);
  };
  const handleCellClick = (cell: GridCell) => {
    if (cell.blank || cell.disabled || !cell.key) return;
    const key = cell.key;
    setPath((current) => [...current, key]);
  };
  const navigateToDay = (date: string) => {
    if (date > today) return;
    setPath((current) => current.length > 0 ? [...current.slice(0, -1), date] : [date]);
  };
  const navigatePeriod = (direction: -1 | 1) => {
    if (view.level === "day") {
      navigateToDay(addLocalDays(view.key, direction));
      return;
    }
    if (scope === "week" && path.length === 0) {
      const next = addLocalDays(selectedWeek, direction * 7);
      if (next <= currentWeek) setSelectedWeek(next);
      return;
    }
    if (scope === "month" && path.length === 0) {
      const next = addLocalMonths(selectedMonth, direction);
      if (next <= currentMonth) setSelectedMonth(next);
      return;
    }
    if (scope === "year" && path.length === 0) {
      const next = addLocalYears(selectedYear, direction);
      if (next <= currentYear) setSelectedYear(next);
    }
  };
  const canGoBack = path.length > 0;
  const canDrill = view.level !== "day";
  const showPeriodNavigation = view.level === "day"
    || (scope === "week" && path.length === 0)
    || (scope === "month" && path.length === 0)
    || (scope === "year" && path.length === 0);
  const nextPeriodDisabled = view.level === "day"
    ? view.key >= today
    : scope === "week"
      ? selectedWeek >= currentWeek
      : scope === "month"
      ? selectedMonth >= currentMonth
      : selectedYear >= currentYear;
  const visibleEvents = useMemo(
    () => periodEvents
      .filter((event) => returnEventValue(event) !== 0)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [periodEvents],
  );
  const dailyRowByDate = useMemo(() => new Map(dailyRows.map((row) => [row.date, row])), [dailyRows]);
  const dayContextCells = view.level === "day"
    ? [-1, 0, 1].map((offset) => {
      const date = addLocalDays(view.key, offset);
      return { date, row: dailyRowByDate.get(date), disabled: date > today, selected: offset === 0 };
    })
    : [];
  const returnEventCount = portfolioEvents.filter((event) => returnEventValue(event) !== 0).length;
  const isPortfolioEmpty = !hasMeaningfulReturnData(holdings.length, returnEventCount, assetSnapshots);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        className="z-20 shrink-0"
        style={{ background: "color-mix(in srgb, var(--bg) 94%, transparent)", backdropFilter: "blur(14px)" }}
      >
        <div className="flex h-[50px] items-center justify-between border-b border-app-border px-4">
          <span className="text-sm font-semibold text-tp">{copy.title}</span>
          <div className="flex items-center gap-2">
            <span
              className="max-w-[82px] truncate text-[11px]"
              title={lastRefreshError || lastRefreshed}
              aria-label={lastRefreshError || lastRefreshed}
              style={{ color: lastRefreshError ? "#D97706" : "var(--text-muted)", fontWeight: lastRefreshError ? 600 : 400 }}
            >
              {lastRefreshError ? (language === "en" ? "Sync issue" : "同步异常") : lastRefreshed}
            </span>
            <HeaderIconButton
              label={privacyMode ? (language === "en" ? "Show sensitive data" : "显示敏感数据") : (language === "en" ? "Hide sensitive data" : "隐藏敏感数据")}
              onClick={togglePrivacy}
            >
              {privacyMode ? <EyeOff size={14} /> : <Eye size={14} />}
            </HeaderIconButton>
            <HeaderIconButton label={text.common.refresh} onClick={handleRefresh} disabled={refreshingActive}>
              <RefreshCw size={14} className={refreshingActive ? "animate-spin-smooth" : undefined} />
            </HeaderIconButton>
          </div>
        </div>
        {path.length === 0 && (
          <div className="border-b border-app-border px-3 py-2">
            <div className="grid grid-cols-4 rounded-xl bg-app-card p-1">
              {(["week", "month", "year", "all"] as ScopeMode[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => handleScopeChange(item)}
                  className="rounded-lg px-1 py-1.5 text-[11px] font-bold transition-colors"
                  style={{
                    color: scope === item ? "#4F9CF9" : "var(--text-muted)",
                    background: scope === item ? "rgba(79,156,249,0.14)" : "transparent",
                    border: scope === item ? "1px solid rgba(79,156,249,0.22)" : "1px solid transparent",
                  }}
                >
                  {copy.scopes[item]}
                </button>
              ))}
            </div>
          </div>
        )}
        {!isPortfolioEmpty && (
          <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-app-border px-4">
            <div className="flex min-w-0 items-center gap-1.5">
              {canGoBack && (
                <button
                  type="button"
                  onClick={() => setPath((current) => current.slice(0, -1))}
                  aria-label={copy.back}
                  title={copy.back}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-app-card text-tm"
                >
                  <ChevronLeft size={15} />
                </button>
              )}
              <span className="truncate text-xs font-semibold text-ts">{view.title}</span>
            </div>
            {showPeriodNavigation ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => navigatePeriod(-1)}
                  aria-label={copy.previousPeriod}
                  title={copy.previousPeriod}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-app-card text-tm"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => navigatePeriod(1)}
                  disabled={nextPeriodDisabled}
                  aria-label={copy.nextPeriod}
                  title={copy.nextPeriod}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-app-card text-tm disabled:opacity-35"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : trackingStart ? <span className="shrink-0 text-[9px] text-tmi">{copy.trackedSince(trackingStart)}</span> : null}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-3" style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain" }}>
        {isPortfolioEmpty ? (
          <section className="flex min-h-[390px] flex-col items-center justify-center px-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(79,156,249,0.10)", color: "#4F9CF9" }}>
              <Layers3 size={22} />
            </div>
            <p className="mt-4 text-sm font-semibold text-tp">{copy.emptyTitle}</p>
            <p className="mt-1.5 text-[11px] leading-5 text-tm">{copy.emptyDescription}</p>
            <Link
              to="/holdings"
              className="mt-5 rounded-xl px-5 py-2.5 text-xs font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #4F9CF9, #7C3AED)" }}
            >
              {copy.addHolding}
            </Link>
          </section>
        ) : (
          <>
        {incompleteCount > 0 && (
          <div className="mb-3 flex gap-2 rounded-xl border px-3 py-2" style={{ borderColor: "rgba(245,158,11,0.24)", background: "rgba(245,158,11,0.07)" }}>
            <AlertCircle size={14} color="#F59E0B" className="mt-0.5 shrink-0" />
            <div className="text-[10px] leading-4 text-tm">
              <p>{copy.incomplete(incompleteCount)}</p>
              {containsBaseline && <p className="mt-0.5 text-tmi">{copy.baselineIncluded}</p>}
            </div>
          </div>
        )}

        <section className="rounded-xl border border-app-accent/15 bg-app-surface p-3">
          <p className="text-[10px] text-tm">{scope === "all" && path.length === 0 ? copy.cumulativeReturn : copy.totalReturn}</p>
          <p className="mt-0.5 break-words text-[25px] font-bold leading-tight" style={{ color: profitColor(totals.totalPnl) }}>
            {signedMoney(totals.totalPnl)}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-app-border pt-2.5">
            <Metric label={copy.periodRate} value={formatPercent(periodRate, 2, locale)} color={profitColor(periodRate)} />
            <Metric label={copy.realizedIncome} value={signedMoney(realizedIncome)} color={profitColor(realizedIncome)} />
            <Metric label={copy.positiveDays} value={copy.dayCount(positiveDays, activeDays)} color="var(--text-secondary)" />
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-app-border pt-2.5">
            {sourceRows.map((row) => (
              <DetailMetric key={row.key} label={row.label} value={signedMoney(row.value)} color={profitColor(row.value)} />
            ))}
          </div>
        </section>

        {view.level !== "day" && (
          <section className="mt-4">
            <SectionHeader icon={<CalendarDays size={14} color="#4F9CF9" />} title={copy.calendar} meta={view.title} />
            <div className="rounded-xl border border-app-border bg-app-card p-2">
              {gridCells.length > 0 ? (
                <div className={`grid ${view.level === "days" || view.level === "week" ? "grid-cols-7 gap-1" : "grid-cols-3 gap-1.5"}`}>
                  {(view.level === "days" || view.level === "week") && copy.weekday.map((weekday, index) => (
                    <span key={`wd-${index}`} className="pb-1.5 text-center text-[9px] font-semibold text-tm">{weekday}</span>
                  ))}
                  {gridCells.map((cell, index) => {
                    if (cell.blank) return <span key={`blank-${index}`} />;
                    const isDays = view.level === "days" || view.level === "week";
                    const rawColor = cell.totalPnl !== 0 ? profitColor(cell.totalPnl) : "";
                    const absRate = Math.min(Math.abs(cell.rate), 1);
                    const bgIntensity = 0.035 + absRate * 0.07;
                    return (
                      <button
                        key={cell.key ?? `cell-${index}`}
                        type="button"
                        disabled={cell.disabled}
                        onClick={() => handleCellClick(cell)}
                        aria-current={cell.isToday ? "date" : undefined}
                        className={`group min-w-0 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${isDays ? "rounded-md px-1.5 py-1" : "rounded-lg p-2"}`}
                        style={{
                          minHeight: isDays ? 56 : 58,
                          background: cell.disabled
                            ? "transparent"
                            : cell.totalPnl !== 0
                              ? hexToRgba(rawColor, bgIntensity)
                              : "transparent",
                          opacity: cell.disabled ? 0.28 : 1,
                          border: cell.isToday
                            ? "1px solid rgba(79,156,249,0.42)"
                            : rawColor
                              ? `1px solid ${hexToRgba(rawColor, 0.12)}`
                              : "1px solid transparent",
                        }}
                      >
                        <span
                          className={`inline-flex leading-tight ${isDays ? "min-h-4 items-center text-[9px] font-semibold" : "text-[11px] font-medium"}`}
                          style={{ color: cell.isToday ? "#4F9CF9" : "var(--text-muted)" }}
                        >
                          {cell.label}
                        </span>
                        <span
                          className={`mt-1 block font-bold leading-tight break-words ${isDays ? "text-[9px]" : "text-[12px]"}`}
                          style={{ color: rawColor || "var(--text-micro)" }}
                        >
                          {cell.row && cell.totalPnl !== 0 ? formatCalendarMoney(displayValue(cell.totalPnl), privacyMode, locale, currency) : "-"}
                        </span>
                        {cell.row && cell.totalPnl !== 0 && (
                          <span
                            className={`mt-0.5 block leading-tight ${isDays ? "text-[8px]" : "text-[9px]"}`}
                            style={{ color: rawColor }}
                          >
                            {formatPercent(cell.rate, 2, locale)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : <EmptyState text={copy.empty} />}
            </div>
          </section>
        )}

        {view.level !== "day" && (
          <section className="mt-4">
            <SectionHeader title={copy.detail} meta={copy.drillHint} />
            <div className="overflow-hidden rounded-xl border border-app-border bg-app-card">
              {displayRows.slice().reverse().map((row, index, rows) => (
                <button
                  key={rowKey(row)}
                  type="button"
                  onClick={() => handleDrill(row)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                  style={{ borderBottom: index < rows.length - 1 ? "1px solid var(--border)" : "none" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-tp">{formatRowTitle(row, locale)}</span>
                      <span className="shrink-0 text-xs font-bold" style={{ color: profitColor(row.totalPnl) }}>{signedMoney(row.totalPnl)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-tmi">
                      <DetailMetric label={copy.shortUnrealized} value={signedMoney(row.unrealizedPnlChange)} />
                      <DetailMetric label={copy.shortRealized} value={signedMoney(row.realizedTradingPnl)} />
                      <DetailMetric label={copy.shortDividend} value={signedMoney(row.dividendPnl)} />
                      <DetailMetric label={copy.shortFee} value={signedMoney(row.feePnl)} />
                    </div>
                  </div>
                  {canDrill && <ChevronRight size={14} color="var(--text-micro)" className="shrink-0" />}
                </button>
              ))}
              {displayRows.length === 0 && <EmptyState text={copy.empty} />}
            </div>
          </section>
        )}

        {view.level === "day" && (
          <section className="mt-4">
            <SectionHeader
              icon={<CalendarDays size={14} color="#4F9CF9" />}
              title={copy.dayContext}
              meta={copy.dayPosition(Number(view.key.slice(-2)), new Date(Number(view.key.slice(0, 4)), Number(view.key.slice(5, 7)), 0).getDate())}
            />
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-app-border bg-app-card p-2">
              {dayContextCells.map((cell) => (
                <button
                  key={cell.date}
                  type="button"
                  disabled={cell.disabled}
                  onClick={() => navigateToDay(cell.date)}
                  className="min-w-0 rounded-lg px-1.5 py-2 text-center disabled:opacity-35"
                  style={{
                    background: cell.selected ? "rgba(79,156,249,0.12)" : "var(--bg-surface2)",
                    border: cell.selected ? "1px solid rgba(79,156,249,0.22)" : "1px solid transparent",
                  }}
                >
                  <span className="block truncate text-[9px] text-tmi">{formatRowTitle(cell.row ?? {
                    date: cell.date,
                    unrealizedPnlChange: 0,
                    realizedTradingPnl: 0,
                    dividendPnl: 0,
                    feePnl: 0,
                    totalPnl: 0,
                    totalAsset: 0,
                    currency: "CNY",
                  }, locale)}</span>
                  <span className="mt-1 block truncate text-[10px] font-bold" style={{ color: cell.row ? profitColor(cell.row.totalPnl) : "var(--text-micro)" }}>
                    {cell.row && cell.row.totalPnl !== 0 ? formatCalendarMoney(displayValue(cell.row.totalPnl), privacyMode, locale, currency) : "-"}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mt-4">
          <SectionHeader
            icon={<ReceiptText size={14} color="#4F9CF9" />}
            title={copy.eventDetail}
            meta={visibleEvents.length > 0 ? String(visibleEvents.length) : undefined}
          />
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-card">
            {visibleEvents.map((event, index) => {
              const value = returnEventValue(event);
              return (
                <div key={event.id} className="flex items-center justify-between gap-3 px-3 py-2.5" style={{ borderBottom: index < visibleEvents.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-tp">{event.name || event.symbol || copy.eventType(event.type)}</p>
                    <p className="mt-0.5 text-[9px] text-tmi">{copy.eventType(event.type)}{event.symbol ? ` · ${event.symbol}` : ""}{view.level === "day" ? "" : ` · ${event.date}`}</p>
                  </div>
                  <span className="shrink-0 text-xs font-bold" style={{ color: profitColor(value) }}>{signedMoney(value)}</span>
                </div>
              );
            })}
            {visibleEvents.length === 0 && <EmptyState text={copy.noEvents} />}
          </div>
        </section>

        <section className="mt-4">
          <SectionHeader
            icon={<Trophy size={14} color="#F59E0B" />}
            title={copy.holdingRank}
            meta={rankIsEstimated ? copy.holdingRankEstimated : copy.holdingRankNote}
          />
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-card">
            {rankRows.map((row, index) => {
              const realized = row.realizedTradingPnl + row.dividendPnl + row.feePnl;
              const contributionRate = startingAsset > 0 ? row.totalPnl / startingAsset : 0;
              return (
                <div key={row.id} className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: index < rankRows.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold" style={{ color: index < 3 ? "#F59E0B" : "var(--text-micro)", background: index < 3 ? "rgba(245,158,11,0.10)" : "var(--bg-surface2)" }}>
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-tp">{row.name}</p>
                    <p className="mt-0.5 truncate text-[9px] text-tmi">
                      {row.symbol} · {copy.shortUnrealized} {signedMoney(row.unrealizedPnlChange)} · {copy.rankRealized} {signedMoney(realized)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="block text-xs font-bold" style={{ color: profitColor(row.totalPnl) }}>{signedMoney(row.totalPnl)}</span>
                    <span className="mt-0.5 block text-[9px] font-semibold" style={{ color: profitColor(contributionRate) }}>
                      {copy.rankContribution} {formatPercent(contributionRate, 2, locale)}
                    </span>
                  </div>
                </div>
              );
            })}
            {rankRows.length === 0 && <EmptyState text={copy.noRank} />}
          </div>
        </section>

        <section className="mt-4">
          <SectionHeader icon={<Layers3 size={14} color="#4F9CF9" />} title={copy.sourceBreakdown} />
          <BreakdownPanel rows={sourceRows} privacyMode={privacyMode} profitColor={profitColor} locale={locale} currency={currency} />
        </section>
          </>
        )}
      </div>
    </div>
  );
}

function HeaderIconButton({ children, label, onClick, disabled = false }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-app-card text-tm disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[9px] text-tm">{label}</p>
      <p className="mt-0.5 truncate text-xs font-bold" title={value} style={{ color }}>{value}</p>
    </div>
  );
}

function DetailMetric({ label, value, color = "var(--text-secondary)" }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-1">
      <span className="shrink-0">{label}</span>
      <span className="truncate font-semibold" title={value} style={{ color }}>{value}</span>
    </span>
  );
}

function SectionHeader({ icon, title, meta }: { icon?: ReactNode; title: string; meta?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-xs font-medium text-ts">{title}</span>
      </div>
      {meta && <span className="max-w-[58%] truncate text-right text-[9px] text-tmi">{meta}</span>}
    </div>
  );
}

function BreakdownPanel({
  rows,
  privacyMode,
  profitColor,
  locale,
  currency,
}: {
  rows: Array<{ key: string; label: string; value: number; color: string }>;
  privacyMode: boolean;
  profitColor: (value: number) => string;
  locale: string;
  currency: string;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-app-border bg-app-card p-3">
      {rows.map((row) => {
        const width = breakdownBarWidth(row.value, rows);
        const barColor = row.value >= 0 ? row.color : profitColor(row.value);
        return (
          <div key={row.key}>
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
              <span className="text-tm">{row.label}</span>
              <span className="font-bold" style={{ color: profitColor(row.value) }}>{formatCompactMoney(convertCurrency(row.value, "CNY", currency), privacyMode, locale, currency)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-app-surface2">
              <div className="h-1.5 rounded-full" style={{ width: `${width}%`, background: barColor }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-[10px] leading-4 text-tmi">{text}</div>;
}
