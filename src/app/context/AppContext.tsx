import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { groups as initialGroups, holdings as initialHoldings, Group, Holding } from "../data/mockData";
import { FX, refreshPrices, toCNY } from "../services/priceRefresher";
import { MarketType, DCAFrequency, isMarketOpenNow, refreshTradingCalendar } from "../services/tradingCalendar";
import type { ChartPoint } from "../services/quoteApi";
import { normalizeHolding, buildHolding, applyHoldingAdjustment } from "../utils/holdingHelpers";
import { dedupeDCAExecutions, hydratePlans, repairDCAData, settleDueDCAPlans, syncPlanWithHolding, computeNextExec } from "../utils/dcaEngine";

/* ─── types ──────────────────────────────────────────── */
type ColorScheme    = "red-up" | "green-up";
type Theme          = "dark" | "light" | "system";
type Currency       = "CNY" | "USD" | "HKD";
type RefreshInterval = 0 | 1 | 5 | 15 | 30 | 60;
export type Language = "zh" | "en";
export type HoldingTradeStatus = "normal" | "suspended" | "fund_limit" | "buy_disabled";
export type HoldingAdjustmentType = "buy" | "sell";

const COLOR_SCHEMES = new Set<ColorScheme>(["red-up", "green-up"]);
const THEMES = new Set<Theme>(["dark", "light", "system"]);
const CURRENCIES = new Set<Currency>(["CNY", "USD", "HKD"]);
const REFRESH_INTERVALS = new Set<RefreshInterval>([0, 1, 5, 15, 30, 60]);
const LANGUAGES = new Set<Language>(["zh", "en"]);

function enumOr<T extends string | number>(value: unknown, allowed: Set<T>, fallback: T): T {
  return allowed.has(value as T) ? value as T : fallback;
}

export type HoldingInput = {
  groupId:      string;
  symbol:       string;
  name:         string;
  market:       string;
  assetType:    string;
  quantity:     number;
  costPrice:    number;
  currentPrice: number;
  currency:     string;
  tradeStatus:  HoldingTradeStatus;
  tradeStatusNote?: string;
  autoTradeStatus?: HoldingTradeStatus | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: string | null;
};

export type HoldingAdjustmentInput = {
  type: HoldingAdjustmentType;
  quantity: number;
  price: number;
};

export type DetailTarget = {
  yahooSymbol:   string;
  displaySymbol: string;
  name:          string;
  market:        string;
  assetType:     string;
  unit?:         string;
  showCurrency?: boolean;
  fallbackQuote?: {
    price:         number;
    change:        number;
    changePercent: number;
    currency:      string;
    exchange?:     string;
    points?:       ChartPoint[];
  };
  decimals?:      number;
};

export interface PortfolioStats {
  totalAsset:     number;
  holdingValue:   number;
  availableCash:  number;
  todayPnl:       number;
  todayPnlRate:   number;
  cumulativePnl:  number;
  cumulativeRate: number;
  usdEquiv:       number;
  lastUpdated:    string;
}

export interface PortfolioSnapshot {
  date:          string;
  totalAsset:    number;
  todayPnl:      number;
  cumulativePnl: number;
}

/* ─── DCA types ──────────────────────────────────────── */
export interface DCAPlan {
  id:           string;
  holdingId:    string;
  name:         string;
  symbol:       string;
  market:       MarketType;
  assetType:    string;
  amount:       number;     // per investment, in plan currency
  currency:     string;
  frequency:    DCAFrequency;
  dayOfWeek?:   number;     // 1-5 for weekly (Mon=1)
  dayOfMonth?:  number;     // 1-28 for monthly
  startDate:    string;     // YYYY-MM-DD
  enabled:      boolean;
  nextExecDate: string;     // computed
  totalInvested:number;
  execCount:    number;
  note?:        string;
}

export type DCAExecutionStatus = "pending" | "executed" | "skipped";

export interface DCAExecution {
  id:            string;
  planId:        string;
  holdingId:     string;
  scheduledDate: string;
  actualDate:    string;
  amount:        number;
  adjusted:      boolean;
  status:        DCAExecutionStatus;
  quantity?:     number;
  price?:        number;
  reason?:       string;
  navDate?:      string;
  confirmedDate?: string;
}

/* ─── Theme colors ───────────────────────────────────── */
export interface ThemeColors {
  bg:            string;
  bgCard:        string;
  bgSurface:     string;
  bgSurface2:    string;
  bgOverlay:     string;
  bgControl:     string;
  controlHover:  string;
  border:        string;
  borderSub:     string;
  textPrimary:   string;
  textSecondary: string;
  textMuted:     string;
  textMicro:     string;
  navBg:         string;
  navBorder:     string;
  optionBg:      string;
  menuShadow:    string;
  scrim:         string;
  isDark:        boolean;
}

function buildThemeColors(theme: Theme): ThemeColors {
  const prefersDark =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);

  if (isDark) {
    return {
      bg:            "#080E1D",
      bgCard:        "rgba(255,255,255,0.03)",
      bgSurface:     "#101C38",
      bgSurface2:    "#0E1A33",
      bgOverlay:     "#111C31",
      bgControl:     "rgba(255,255,255,0.07)",
      controlHover:  "rgba(255,255,255,0.11)",
      border:        "rgba(255,255,255,0.05)",
      borderSub:     "rgba(255,255,255,0.04)",
      textPrimary:   "#F1F5F9",
      textSecondary: "#94A3B8",
      textMuted:     "#475569",
      textMicro:     "#334155",
      navBg:         "rgba(10,15,30,0.97)",
      navBorder:     "rgba(255,255,255,0.06)",
      optionBg:      "#17223F",
      menuShadow:    "0 18px 44px rgba(2,6,23,0.56)",
      scrim:         "rgba(2,6,23,0.72)",
      isDark:        true,
    };
  }
  return {
    bg:            "#EFF3F8",
    bgCard:        "rgba(255,255,255,0.92)",
    bgSurface:     "#FFFFFF",
    bgSurface2:    "#E8EEF6",
    bgOverlay:     "#FFFFFF",
    bgControl:     "#E2EAF4",
    controlHover:  "#D8E3F1",
    border:        "rgba(15,23,42,0.08)",
    borderSub:     "rgba(15,23,42,0.06)",
    textPrimary:   "#0F172A",
    textSecondary: "#475569",
    textMuted:     "#64748B",
    textMicro:     "#94A3B8",
    navBg:         "rgba(248,250,252,0.98)",
    navBorder:     "rgba(15,23,42,0.08)",
    optionBg:      "#FFFFFF",
    menuShadow:    "0 16px 40px rgba(15,23,42,0.16)",
    scrim:         "rgba(15,23,42,0.26)",
    isDark:        false,
  };
}

/* ─── Initial DCA sample data ────────────────────────── */
const initialDCAPlans: DCAPlan[] = [];

/* ─── PortfolioStats ─────────────────────────────────── */
function computeStats(holdings: Holding[]): PortfolioStats {
  const totalMV    = holdings.reduce((s, h) => s + toCNY(h.quantity * h.currentPrice, h.currency), 0);
  const todayPnl   = holdings.reduce((s, h) => s + toCNY(h.todayPnl,    h.currency), 0);
  const totalPnl   = holdings.reduce((s, h) => s + toCNY(h.quantity * (h.currentPrice - h.costPrice), h.currency), 0);
  const costBasis  = holdings.reduce((s, h) => s + toCNY(h.quantity * h.costPrice, h.currency), 0);
  const prevMV     = totalMV - todayPnl;
  return {
    totalAsset:     totalMV,
    holdingValue:   totalMV,
    availableCash:  0,
    todayPnl,
    todayPnlRate:   prevMV  > 0 ? todayPnl  / prevMV   : 0,
    cumulativePnl:  totalPnl,
    cumulativeRate: costBasis > 0 ? totalPnl / costBasis : 0,
    usdEquiv:       totalMV / (FX.USD || 7.25),
    lastUpdated:    new Date().toISOString(),
  };
}

/* ─── AppState ───────────────────────────────────────── */
interface AppState {
  groups:          Group[];
  holdings:        Holding[];
  defaultPrivacyMode: boolean;
  privacyMode:     boolean;
  colorScheme:     ColorScheme;
  theme:           Theme;
  currency:        Currency;
  language:        Language;
  refreshInterval: RefreshInterval;
  tradeTimeOnly:   boolean;
  isRefreshing:    boolean;
  lastRefreshed:   string;
  lastRefreshAt:   number;
  detailTarget:    DetailTarget | null;
  dcaPlans:        DCAPlan[];
  dcaExecutions:   DCAExecution[];
  assetSnapshots:  PortfolioSnapshot[];
  dcaPanelOpen:    boolean;
  dcaPanelHoldingId: string | null;
}

interface AppContextType extends AppState {
  stats:              PortfolioStats;
  tc:                 ThemeColors;
  togglePrivacy:      () => void;
  setDefaultPrivacyMode: (v: boolean) => void;
  setColorScheme:     (v: ColorScheme) => void;
  setTheme:           (v: Theme) => void;
  setCurrency:        (v: Currency) => void;
  setLanguage:        (v: Language) => void;
  setRefreshInterval: (v: RefreshInterval) => void;
  setTradeTimeOnly:   (v: boolean) => void;
  refresh:            () => Promise<void>;
  exportPortfolio:    () => string;
  importPortfolio:    (raw: string) => { ok: boolean; error?: string };
  clearLocalData:     () => void;
  addGroup:           (g: Omit<Group, "id" | "sort">) => void;
  updateGroup:        (id: string, patch: Partial<Omit<Group, "id" | "sort">>) => void;
  removeGroup:        (id: string) => void;
  addHolding:         (h: HoldingInput) => void;
  updateHolding:      (id: string, h: HoldingInput) => void;
  adjustHolding:      (id: string, input: HoldingAdjustmentInput) => void;
  removeHolding:      (id: string) => void;
  openDetail:         (t: DetailTarget) => void;
  closeDetail:        () => void;
  profitColor:        (v: number) => string;
  /* DCA */
  addDCAPlan:         (p: Omit<DCAPlan, "id" | "nextExecDate" | "totalInvested" | "execCount">) => void;
  updateDCAPlan:      (id: string, p: Partial<DCAPlan>) => void;
  removeDCAPlan:      (id: string) => void;
  toggleDCAPlan:      (id: string) => void;
  openDCAPanel:       (holdingId?: string | null) => void;
  closeDCAPanel:      () => void;
}

/* ─── context ────────────────────────────────────────── */
const AppContext = createContext<AppContextType | null>(null);

const STORAGE_KEY = "asset-helper:v2";
const STORAGE_VERSION = 2;
const MAX_DCA_EXECUTIONS = 300;
const MAX_DCA_EXECUTIONS_PER_PLAN = 24;

type PersistedState = Partial<Pick<
  AppState,
  | "groups"
  | "holdings"
  | "defaultPrivacyMode"
  | "privacyMode"
  | "colorScheme"
  | "theme"
  | "currency"
  | "language"
  | "refreshInterval"
  | "tradeTimeOnly"
  | "dcaPlans"
  | "dcaExecutions"
  | "assetSnapshots"
>> & { version?: number };

const normalizedInitialHoldings = initialHoldings.map(normalizeHolding);

function todayLocalYMD(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayShanghaiYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function upsertPortfolioSnapshot(snapshots: PortfolioSnapshot[], holdings: Holding[], date = new Date()) {
  const stats = computeStats(holdings);
  const today = todayLocalYMD(date);
  const next: PortfolioSnapshot = {
    date: today,
    totalAsset: stats.totalAsset,
    todayPnl: stats.todayPnl,
    cumulativePnl: stats.cumulativePnl,
  };
  return [
    ...snapshots.filter((snapshot) => snapshot.date !== today),
    next,
  ]
    .filter((snapshot) => snapshot.date && Number.isFinite(snapshot.totalAsset))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-180);
}

function dcaExecutionSortKey(item: DCAExecution) {
  return item.actualDate ?? item.confirmedDate ?? item.scheduledDate ?? "";
}

function pruneDCAExecutions(executions: DCAExecution[]) {
  const byPlan = new Map<string, DCAExecution[]>();
  for (const execution of dedupeDCAExecutions(executions)) {
    const bucket = byPlan.get(execution.planId) ?? [];
    bucket.push(execution);
    byPlan.set(execution.planId, bucket);
  }

  const pendingAll: DCAExecution[] = [];
  const settledAll: DCAExecution[] = [];
  for (const bucket of byPlan.values()) {
    const pending = bucket.filter((item) => item.status === "pending");
    const settled = bucket
      .filter((item) => item.status !== "pending")
      .sort((a, b) => dcaExecutionSortKey(b).localeCompare(dcaExecutionSortKey(a)))
      .slice(0, MAX_DCA_EXECUTIONS_PER_PLAN);
    pendingAll.push(...pending);
    settledAll.push(...settled);
  }

  const sortedPending = pendingAll.sort((a, b) => dcaExecutionSortKey(b).localeCompare(dcaExecutionSortKey(a)));
  const settledCapacity = Math.max(0, MAX_DCA_EXECUTIONS - sortedPending.length);
  const sortedSettled = settledAll
    .sort((a, b) => dcaExecutionSortKey(b).localeCompare(dcaExecutionSortKey(a)))
    .slice(0, settledCapacity);
  return [...sortedPending, ...sortedSettled];
}

function hasFundNavRefreshWindow(holdings: Holding[], now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  }).format(now));
  if (hour < 15 || hour >= 23) return false;
  const today = todayShanghaiYMD(now);
  return holdings.some((holding) =>
    holding.market === "FUND" &&
    holding.assetType === "fund" &&
    holding.priceDate !== today
  );
}

function defaultState(): AppState {
  return {
    groups:          initialGroups,
    holdings:        normalizedInitialHoldings,
    defaultPrivacyMode: false,
    privacyMode:     false,
    colorScheme:     "red-up",
    theme:           "light",
    currency:        "CNY",
    language:        "zh",
    refreshInterval: 1,
    tradeTimeOnly:   false,
    isRefreshing:    false,
    lastRefreshed:   "—",
    lastRefreshAt:   0,
    detailTarget:    null,
    dcaPlans:        hydratePlans(initialDCAPlans),
    dcaExecutions:   [],
    assetSnapshots:  [],
    dcaPanelOpen:    false,
    dcaPanelHoldingId: null,
  };
}

export function loadInitialState(): AppState {
  const base = defaultState();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<PersistedState>;
    const holdings = Array.isArray(saved.holdings) && saved.holdings.length
      ? saved.holdings.map(normalizeHolding)
      : base.holdings;
    const rawExecutions = Array.isArray(saved.dcaExecutions)
      ? pruneDCAExecutions(saved.dcaExecutions)
      : base.dcaExecutions;
    const rawPlans = Array.isArray(saved.dcaPlans) ? saved.dcaPlans : [];
    const repaired = rawPlans.length > 0
      ? repairDCAData(holdings, rawPlans, rawExecutions)
      : { holdings, plans: rawPlans, executions: rawExecutions, changed: false };
    const dcaExecutions = repaired.executions;
    const dcaPlans = repaired.plans.length > 0 ? hydratePlans(repaired.plans, dcaExecutions) : base.dcaPlans;
    const finalHoldings = repaired.changed ? repaired.holdings : holdings;
    const assetSnapshots = Array.isArray(saved.assetSnapshots)
      ? saved.assetSnapshots
          .filter((snapshot) => (
            typeof snapshot?.date === "string" &&
            Number.isFinite(snapshot?.totalAsset)
          ))
          .slice(-180)
      : base.assetSnapshots;
    const savedDefaultPrivacyMode = typeof saved.defaultPrivacyMode === "boolean" ? saved.defaultPrivacyMode : undefined;
    const savedPrivacyMode = typeof saved.privacyMode === "boolean" ? saved.privacyMode : undefined;
    const defaultPrivacyMode = savedDefaultPrivacyMode ?? savedPrivacyMode ?? base.defaultPrivacyMode;
    return {
      ...base,
      defaultPrivacyMode,
      privacyMode: defaultPrivacyMode,
      groups: Array.isArray(saved.groups) ? saved.groups : base.groups,
      holdings: finalHoldings,
      dcaPlans,
      dcaExecutions,
      assetSnapshots,
      colorScheme: enumOr(saved.colorScheme, COLOR_SCHEMES, base.colorScheme),
      theme: enumOr(saved.theme, THEMES, base.theme),
      currency: enumOr(saved.currency, CURRENCIES, base.currency),
      language: enumOr(saved.language, LANGUAGES, base.language),
      refreshInterval: enumOr(saved.refreshInterval, REFRESH_INTERVALS, base.refreshInterval),
      tradeTimeOnly: typeof saved.tradeTimeOnly === "boolean" ? saved.tradeTimeOnly : base.tradeTimeOnly,
      isRefreshing: false,
      lastRefreshAt: 0,
      detailTarget: null,
      dcaPanelOpen: false,
      dcaPanelHoldingId: null,
    };
  } catch {
    return base;
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(() => loadInitialState());
  const stateRef = useRef(state);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void refreshTradingCalendar();
  }, []);

  /* theme colors — recomputed when theme changes */
  const tc = useMemo(() => buildThemeColors(state.theme), [state.theme]);
  const stats = useMemo(() => computeStats(state.holdings), [state.holdings]);

  const applyDCAState = useCallback((
    holdings: Holding[],
    plans: DCAPlan[],
    executions: DCAExecution[],
    settleDue = false,
  ) => {
    const repaired = plans.length > 0
      ? repairDCAData(holdings, plans, executions)
      : { holdings, plans, executions, changed: false };
    const settled = settleDueDCAPlans(
      repaired.holdings,
      repaired.plans,
      repaired.executions,
      new Date(),
      settleDue,
    );
    return {
      holdings: settled.holdings,
      dcaPlans: settled.plans,
      dcaExecutions: pruneDCAExecutions(settled.executions),
    };
  }, []);

  /* live price refresh */
  const doRefresh = useCallback(async (currentHoldings: Holding[]) => {
    setState((s) => ({ ...s, isRefreshing: true }));
    try {
      const priceMap = await refreshPrices(
        currentHoldings.map((h) => ({ id: h.id, symbol: h.symbol, market: h.market }))
      );
      setState((s) => {
        const updated = s.holdings.map((h) => {
          const liveUpdate = priceMap[h.id];
          if (!liveUpdate) return h;
          const lp = liveUpdate.price;
          if (!lp) {
            return {
              ...h,
            autoTradeStatus: liveUpdate.autoTradeStatus ?? null,
            autoTradeStatusNote: liveUpdate.autoTradeStatusNote ?? "",
            autoTradeStatusSource: liveUpdate.autoTradeStatusSource ?? null,
            priceDate: h.priceDate ?? "",
            fundNavHistory: h.fundNavHistory,
          };
          }
          const marketValue = h.quantity * lp.price;
          const costBasis   = h.quantity * h.costPrice;
          const totalPnl    = marketValue - costBasis;
          const todayPnl    = Number.isFinite(lp.change) ? h.quantity * lp.change : 0;
          return {
            ...h,
            currentPrice: lp.price,
            marketValue,
            todayPnl,
            todayPnlRate: Number.isFinite(lp.changePercent) ? lp.changePercent : 0,
            totalPnl,
            totalPnlRate: costBasis > 0 ? totalPnl / costBasis : 0,
            autoTradeStatus: liveUpdate.autoTradeStatus ?? null,
            autoTradeStatusNote: liveUpdate.autoTradeStatusNote ?? "",
            autoTradeStatusSource: liveUpdate.autoTradeStatusSource ?? null,
            priceDate: lp.priceDate ?? h.priceDate ?? "",
            fundNavHistory: lp.fundNavHistory ?? h.fundNavHistory,
            estimatedNav: lp.estimatedNav,
            estimatedChangePercent: lp.estimatedChangePercent,
            updatedAt:    new Date().toISOString(),
          };
        });
        const now = new Date();
        const t   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
        const dcaState = applyDCAState(updated, s.dcaPlans, s.dcaExecutions, true);
        return {
          ...s,
          holdings: dcaState.holdings,
          dcaPlans: dcaState.dcaPlans,
          dcaExecutions: dcaState.dcaExecutions,
          assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings, now),
          isRefreshing: false,
          lastRefreshed: t,
          lastRefreshAt: now.getTime(),
        };
      });
    } catch {
      setState((s) => ({ ...s, isRefreshing: false }));
    }
  }, [applyDCAState]);

  const runRefresh = useCallback((currentHoldings: Holding[]) => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    const task = doRefresh(currentHoldings)
      .finally(() => {
        refreshPromiseRef.current = null;
      });

    refreshPromiseRef.current = task;
    return task;
  }, [doRefresh]);

  useEffect(() => {
    void runRefresh(stateRef.current.holdings);
  }, [runRefresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const snapshot: PersistedState = {
      version: STORAGE_VERSION,
      groups: state.groups,
      holdings: state.holdings,
      defaultPrivacyMode: state.defaultPrivacyMode,
      colorScheme: state.colorScheme,
      theme: state.theme,
      currency: state.currency,
      language: state.language,
      refreshInterval: state.refreshInterval,
      tradeTimeOnly: state.tradeTimeOnly,
      dcaPlans: state.dcaPlans,
      dcaExecutions: pruneDCAExecutions(state.dcaExecutions),
      assetSnapshots: state.assetSnapshots,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // QuotaExceededError — silently ignore
    }
  }, [
    state.groups,
    state.holdings,
    state.defaultPrivacyMode,
    state.colorScheme,
    state.theme,
    state.currency,
    state.language,
    state.refreshInterval,
    state.tradeTimeOnly,
    state.dcaPlans,
    state.dcaExecutions,
    state.assetSnapshots,
  ]);

  useEffect(() => {
    if (!state.refreshInterval) return;
    const id = window.setInterval(() => {
      const current = stateRef.current;
      if (current.isRefreshing) return;
      const shouldRefresh = !current.tradeTimeOnly ||
        current.holdings.some((h) => isMarketOpenNow(h.market as MarketType)) ||
        hasFundNavRefreshWindow(current.holdings);
      if (shouldRefresh) void runRefresh(current.holdings);
    }, state.refreshInterval * 60 * 1000);
    return () => window.clearInterval(id);
  }, [state.refreshInterval, runRefresh]);

  const refresh = useCallback(() => {
    return runRefresh(stateRef.current.holdings);
  }, [runRefresh]);

  /* settings */
  const togglePrivacy  = useCallback(() => setState((s) => ({ ...s, privacyMode: !s.privacyMode })), []);
  const setDefaultPrivacyMode = useCallback((v: boolean) => setState((s) => ({ ...s, defaultPrivacyMode: v })), []);
  const setColorScheme = useCallback((v: ColorScheme)     => setState((s) => ({ ...s, colorScheme: v })), []);
  const setTheme       = useCallback((v: Theme)           => setState((s) => ({ ...s, theme: v })), []);
  const setCurrency    = useCallback((v: Currency)        => setState((s) => ({ ...s, currency: v })), []);
  const setLanguage    = useCallback((v: Language)        => setState((s) => ({ ...s, language: v })), []);
  const setRefreshInterval = useCallback((v: RefreshInterval) => setState((s) => ({ ...s, refreshInterval: v })), []);
  const setTradeTimeOnly = useCallback((v: boolean) => setState((s) => ({ ...s, tradeTimeOnly: v })), []);

  const exportPortfolio = useCallback(() => JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: "资产助手",
    version: 2,
    data: {
      groups: state.groups,
      holdings: state.holdings,
      dcaPlans: state.dcaPlans,
      dcaExecutions: state.dcaExecutions,
      assetSnapshots: state.assetSnapshots,
      settings: {
        defaultPrivacyMode: state.defaultPrivacyMode,
        colorScheme: state.colorScheme,
        theme: state.theme,
        currency: state.currency,
        language: state.language,
        refreshInterval: state.refreshInterval,
        tradeTimeOnly: state.tradeTimeOnly,
      },
    },
  }, null, 2), [state]);

  const importPortfolio = useCallback((raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      const data = parsed?.data ?? parsed;
      if (!Array.isArray(data?.holdings)) {
        return { ok: false, error: "导入文件缺少 holdings 数据" };
      }
      const holdings = data.holdings.map(normalizeHolding);
      const settings = data.settings ?? {};
      setState((s) => {
        const dcaExecutions = Array.isArray(data.dcaExecutions) ? pruneDCAExecutions(data.dcaExecutions) : s.dcaExecutions;
        const dcaPlans = Array.isArray(data.dcaPlans) ? hydratePlans(data.dcaPlans, dcaExecutions) : s.dcaPlans;
        const dcaState = applyDCAState(holdings, dcaPlans, dcaExecutions);
        return {
          ...s,
          groups: Array.isArray(data.groups) ? data.groups : s.groups,
          holdings: dcaState.holdings,
          dcaPlans: dcaState.dcaPlans,
          dcaExecutions: dcaState.dcaExecutions,
          assetSnapshots: Array.isArray(data.assetSnapshots)
            ? upsertPortfolioSnapshot(data.assetSnapshots, dcaState.holdings)
            : upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
          defaultPrivacyMode: typeof settings.defaultPrivacyMode === "boolean"
            ? settings.defaultPrivacyMode
            : typeof settings.privacyMode === "boolean"
              ? settings.privacyMode
              : s.defaultPrivacyMode,
          privacyMode: s.privacyMode,
          colorScheme: enumOr(settings.colorScheme, COLOR_SCHEMES, s.colorScheme),
          theme: enumOr(settings.theme, THEMES, s.theme),
          currency: enumOr(settings.currency, CURRENCIES, s.currency),
          language: enumOr(settings.language, LANGUAGES, s.language),
          refreshInterval: enumOr(settings.refreshInterval, REFRESH_INTERVALS, s.refreshInterval),
          tradeTimeOnly: typeof settings.tradeTimeOnly === "boolean" ? settings.tradeTimeOnly : s.tradeTimeOnly,
        };
      });
      return { ok: true };
    } catch {
      return { ok: false, error: "JSON 格式无法解析" };
    }
  }, [applyDCAState]);

  const clearLocalData = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    setState(defaultState());
  }, []);

  /* groups */
  const addGroup    = useCallback((g: Omit<Group, "id" | "sort">) => {
    setState((s) => ({ ...s, groups: [...s.groups, { ...g, id: `group_${crypto.randomUUID()}`, sort: Date.now() }] }));
  }, []);
  const updateGroup = useCallback((id: string, patch: Partial<Omit<Group, "id" | "sort">>) => {
    setState((s) => ({
      ...s,
      groups: s.groups.map((g) => g.id === id ? { ...g, ...patch } : g),
    }));
  }, []);
  const removeGroup = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      groups:   s.groups.filter((g) => g.id !== id),
      holdings: s.holdings.map((h) => h.groupId === id ? { ...h, groupId: "" } : h),
    }));
  }, []);

  /* holdings */
  const addHolding = useCallback((input: HoldingInput) => {
    const h = buildHolding(input, `holding_${crypto.randomUUID()}`);
    setState((s) => {
      const updated = [h, ...s.holdings];
      const dcaState = applyDCAState(updated, s.dcaPlans, s.dcaExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
      };
    });
  }, [applyDCAState]);
  const updateHolding = useCallback((id: string, input: HoldingInput) => {
    setState((s) => {
      const previous = s.holdings.find((item) => item.id === id);
      const rebuilt = buildHolding(input, id);
      const preserveLive = Boolean(
        previous &&
        previous.symbol === rebuilt.symbol &&
        previous.market === rebuilt.market &&
        previous.currency === rebuilt.currency,
      );
      const scaledTodayPnl = preserveLive && previous && Number.isFinite(previous.todayPnl) && previous.quantity > 0
        ? (previous.todayPnl / previous.quantity) * rebuilt.quantity
        : rebuilt.todayPnl;
      const safeScaledTodayPnl = Number.isFinite(scaledTodayPnl) ? scaledTodayPnl : 0;
      const h: Holding = preserveLive && previous
        ? {
          ...rebuilt,
          todayPnl: safeScaledTodayPnl,
          todayPnlRate: previous.todayPnlRate,
          autoTradeStatus: previous.autoTradeStatus ?? null,
          autoTradeStatusNote: previous.autoTradeStatusNote ?? "",
          autoTradeStatusSource: previous.autoTradeStatusSource ?? null,
          priceDate: previous.priceDate ?? "",
          fundNavHistory: previous.fundNavHistory,
          estimatedNav: previous.estimatedNav,
          estimatedChangePercent: previous.estimatedChangePercent,
        }
        : rebuilt;
      const updatedHoldings = s.holdings.map((x) => (x.id === id ? h : x));
      const updatedPlans = s.dcaPlans.map((plan) => (plan.holdingId === id ? syncPlanWithHolding(plan, h) : plan));
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, s.dcaExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
      };
    });
  }, [applyDCAState]);
  const adjustHolding = useCallback((id: string, input: HoldingAdjustmentInput) => {
    setState((s) => {
      const target = s.holdings.find((item) => item.id === id);
      if (!target) return s;
      const adjusted = applyHoldingAdjustment(target, input);
      const updatedHoldings = adjusted
        ? s.holdings.map((item) => item.id === id ? adjusted : item)
        : s.holdings.filter((item) => item.id !== id);
      const updatedPlans = adjusted
        ? s.dcaPlans.map((plan) => (plan.holdingId === id ? syncPlanWithHolding(plan, adjusted) : plan))
        : s.dcaPlans.filter((plan) => plan.holdingId !== id);
      const updatedExecutions = adjusted
        ? s.dcaExecutions
        : s.dcaExecutions.filter((item) => item.holdingId !== id);
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, updatedExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
      };
    });
  }, [applyDCAState]);
  const removeHolding = useCallback((id: string) => {
    setState((s) => {
      const updatedHoldings = s.holdings.filter((h) => h.id !== id);
      const updatedPlans = s.dcaPlans.filter((plan) => plan.holdingId !== id);
      const updatedExecutions = s.dcaExecutions.filter((item) => item.holdingId !== id);
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, updatedExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
        dcaPanelHoldingId: s.dcaPanelHoldingId === id ? null : s.dcaPanelHoldingId,
      };
    });
  }, [applyDCAState]);

  /* detail overlay */
  const openDetail  = useCallback((t: DetailTarget) => setState((s) => ({ ...s, detailTarget: t })), []);
  const closeDetail = useCallback(() => setState((s) => ({ ...s, detailTarget: null })), []);

  /* DCA */
  const addDCAPlan = useCallback((p: Omit<DCAPlan, "id" | "nextExecDate" | "totalInvested" | "execCount">) => {
    const linkedHolding = stateRef.current.holdings.find((holding) => holding.id === p.holdingId);
    if (!linkedHolding) return;
    if (stateRef.current.dcaPlans.some((plan) => plan.holdingId === p.holdingId)) return;
    const plan: DCAPlan = {
      ...syncPlanWithHolding({
        ...p,
        id: "",
        nextExecDate: "",
        totalInvested: 0,
        execCount: 0,
      }, linkedHolding),
      id:           `dca_${crypto.randomUUID()}`,
      nextExecDate: "",
      totalInvested: 0,
      execCount: 0,
    };
    plan.nextExecDate = computeNextExec(plan);
    setState((s) => {
      const dcaState = applyDCAState(s.holdings, [...s.dcaPlans, plan], s.dcaExecutions);
      return {
        ...s,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        holdings: dcaState.holdings,
        dcaPanelHoldingId: null,
      };
    });
  }, [applyDCAState]);

  const updateDCAPlan = useCallback((id: string, partial: Partial<DCAPlan>) => {
    setState((s) => ({
      ...s,
      ...(() => {
        const nextPlans = s.dcaPlans.map((plan) => {
          if (plan.id !== id) return plan;
          if (
            partial.holdingId &&
            partial.holdingId !== plan.holdingId &&
            s.dcaPlans.some((other) => other.id !== id && other.holdingId === partial.holdingId)
          ) {
            return plan;
          }
          const targetHolding = s.holdings.find((holding) => holding.id === (partial.holdingId ?? plan.holdingId));
          const updated = targetHolding
            ? syncPlanWithHolding({ ...plan, ...partial }, targetHolding)
            : { ...plan, ...partial };
          updated.nextExecDate = computeNextExec(updated);
          return updated;
        });
        const dcaState = applyDCAState(s.holdings, nextPlans, s.dcaExecutions);
        return {
          holdings: dcaState.holdings,
          dcaPlans: dcaState.dcaPlans,
          dcaExecutions: dcaState.dcaExecutions,
        };
      })(),
    }));
  }, [applyDCAState]);

  const removeDCAPlan = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      dcaPlans: s.dcaPlans.filter((p) => p.id !== id),
      dcaExecutions: s.dcaExecutions.filter((item) => item.planId !== id),
    }));
  }, []);

  const toggleDCAPlan = useCallback((id: string) => {
    setState((s) => {
      const nextPlans = s.dcaPlans.map((p) =>
        p.id === id ? { ...p, enabled: !p.enabled } : p
      );
      const dcaState = applyDCAState(s.holdings, nextPlans, s.dcaExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
      };
    });
  }, [applyDCAState]);

  const openDCAPanel  = useCallback((holdingId?: string | null) => setState((s) => ({
    ...s,
    dcaPanelOpen: true,
    dcaPanelHoldingId: holdingId ?? null,
  })), []);
  const closeDCAPanel = useCallback(() => setState((s) => ({ ...s, dcaPanelOpen: false, dcaPanelHoldingId: null })), []);

  /* profit color */
  const profitColor = useCallback((v: number) => {
    if (v === 0) return "#94A3B8";
    if (state.colorScheme === "red-up") return v > 0 ? "#F24E4E" : "#31D08B";
    return v > 0 ? "#31D08B" : "#F24E4E";
  }, [state.colorScheme]);

  return (
    <AppContext.Provider value={{
      ...state, stats, tc,
      togglePrivacy, setDefaultPrivacyMode, setColorScheme, setTheme, setCurrency, setLanguage, setRefreshInterval,
      setTradeTimeOnly, refresh,
      exportPortfolio, importPortfolio, clearLocalData,
      addGroup, updateGroup, removeGroup,
      addHolding, updateHolding, adjustHolding, removeHolding,
      openDetail, closeDetail,
      profitColor,
      addDCAPlan, updateDCAPlan, removeDCAPlan, toggleDCAPlan,
      openDCAPanel, closeDCAPanel,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
