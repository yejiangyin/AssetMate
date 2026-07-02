import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { groups as initialGroups, holdings as initialHoldings, closedHoldings as initialClosedHoldings, Group, Holding, ClosedHolding } from "../data/mockData";
import { FX, refreshPrices, toCNY } from "../services/priceRefresher";
import { MarketType, DCAFrequency, isMarketOpenNow, isTradingDay, refreshTradingCalendar } from "../services/tradingCalendar";
import type { ChartPoint } from "../services/quoteApi";
import { fetchCorporateActions } from "../services/corporateActions";
import { normalizeHolding, buildHolding, applyHoldingAdjustment, applyCorporateAction as applyHoldingCorporateAction } from "../utils/holdingHelpers";
import { dedupeDCAExecutions, hydratePlans, repairDCAData, settleDueDCAPlans, syncPlanWithHolding, computeNextExec } from "../utils/dcaEngine";
import { safeUUID } from "../utils/safeId";
import { DEFAULT_OPEN_MODE, normalizeOpenMode, syncExtensionOpenMode, type ExtensionOpenMode } from "../utils/extensionOpenMode";

/* ─── types ──────────────────────────────────────────── */
type ColorScheme    = "red-up" | "green-up";
type Theme          = "dark" | "light" | "system";
type Currency       = "CNY" | "USD" | "HKD";
type RefreshInterval = 0 | 1 | 5 | 15 | 30 | 60;
export type Language = "zh" | "en";
export type HoldingTradeStatus = "normal" | "suspended" | "fund_limit" | "buy_disabled";
export type HoldingAdjustmentType = "buy" | "sell";
export type HoldingCorporateActionType = "cash_dividend" | "share_dividend" | "split";

const COLOR_SCHEMES = new Set<ColorScheme>(["red-up", "green-up"]);
const THEMES = new Set<Theme>(["dark", "light", "system"]);
const CURRENCIES = new Set<Currency>(["CNY", "USD", "HKD"]);
const REFRESH_INTERVALS = new Set<RefreshInterval>([0, 1, 5, 15, 30, 60]);
const LANGUAGES = new Set<Language>(["zh", "en"]);
const CORPORATE_ACTION_CHECK_TTL = 24 * 60 * 60 * 1000;
const MAX_CORPORATE_ACTION_CHECKS = 500;
const corporateActionCheckedAt = new Map<string, number>();

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
  fundBuyConfirmDays?: number;
  dividendReinvest?: boolean | null;
};

export type HoldingAdjustmentInput = {
  type: HoldingAdjustmentType;
  quantity: number;
  price: number;
};

export type HoldingCorporateActionInput = {
  id?: string;
  type: HoldingCorporateActionType;
  date: string;
  amount?: number;
  shares?: number;
  ratio?: number;
  price?: number;
  recordDate?: string;
  exDate?: string;
  payDate?: string;
  announcementDate?: string;
  source?: string;
  note?: string;
  description?: string;
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
  unrealizedPnl:  number;
  unrealizedRate: number;
  realizedPnl:    number;
  realizedRate:   number;
  totalInvestmentPnl: number;
  totalInvestmentRate: number;
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
  fundBuyConfirmDays?: number;
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
function computeStats(holdings: Holding[], closedHoldings: ClosedHolding[] = []): PortfolioStats {
  const totalMV    = holdings.reduce((s, h) => s + toCNY(h.quantity * h.currentPrice, h.currency), 0);
  const todayPnl   = holdings.reduce((s, h) => s + toCNY(h.todayPnl,    h.currency), 0);
  // Open-position P/L includes cash dividends received while holding — dividends
  // are realized income even if the position is still open, so they must be
  // reflected in the open-position return, not only at full close.
  const totalPnl   = holdings.reduce((s, h) => s + toCNY(
    h.quantity * (h.currentPrice - h.costPrice) + (h.cashDividendTotal ?? 0),
    h.currency,
  ), 0);
  const costBasis  = holdings.reduce((s, h) => s + toCNY(h.quantity * h.costPrice, h.currency), 0);
  const realizedPnl = closedHoldings.reduce((s, h) => s + toCNY(h.realizedPnl, h.currency), 0);
  const realizedCostBasis = closedHoldings.reduce((s, h) => s + toCNY(h.costBasis, h.currency), 0);
  const totalInvestmentPnl = totalPnl + realizedPnl;
  const totalInvestmentCostBasis = costBasis + realizedCostBasis;
  const prevMV     = totalMV - todayPnl;
  return {
    totalAsset:     totalMV,
    holdingValue:   totalMV,
    availableCash:  0,
    todayPnl,
    todayPnlRate:   prevMV  > 0 ? todayPnl  / prevMV   : 0,
    cumulativePnl:  totalPnl,
    cumulativeRate: costBasis > 0 ? totalPnl / costBasis : 0,
    unrealizedPnl:  totalPnl,
    unrealizedRate: costBasis > 0 ? totalPnl / costBasis : 0,
    realizedPnl,
    realizedRate: realizedCostBasis > 0 ? realizedPnl / realizedCostBasis : 0,
    totalInvestmentPnl,
    totalInvestmentRate: totalInvestmentCostBasis > 0 ? totalInvestmentPnl / totalInvestmentCostBasis : 0,
    usdEquiv:       totalMV / (FX.USD || 7.25),
    lastUpdated:    new Date().toISOString(),
  };
}

/* ─── AppState ───────────────────────────────────────── */
interface AppState {
  groups:          Group[];
  holdings:        Holding[];
  closedHoldings:  ClosedHolding[];
  defaultPrivacyMode: boolean;
  privacyMode:     boolean;
  colorScheme:     ColorScheme;
  theme:           Theme;
  currency:        Currency;
  language:        Language;
  refreshInterval: RefreshInterval;
  tradeTimeOnly:   boolean;
  dividendReinvest:boolean;
  defaultOpenMode:  ExtensionOpenMode;
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
  setDividendReinvest: (v: boolean) => void;
  setDefaultOpenMode: (v: ExtensionOpenMode) => void;
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
  applyCorporateAction: (id: string, input: HoldingCorporateActionInput) => void;
  removeHolding:      (id: string) => void;
  removeClosedHolding: (id: string) => void;
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
const REFRESH_META_KEY = "asset-helper:portfolio-refresh-meta:v1";
const REFRESH_RECENT_TTL = 45_000;
const REFRESH_LOCK_TTL = 25_000;
const MAX_DCA_EXECUTIONS = 300;
const MAX_DCA_EXECUTIONS_PER_PLAN = 24;
const NON_CRITICAL_STORAGE_KEYS = [
  "asset-helper:chart-cache:v1",
  "asset-helper:chart-cache:v2",
  "asset-helper:chart-cache:v3",
  "asset-helper:chart-cache:v4",
  "asset-helper:chart-cache:v5",
  "asset-helper:fund-history-cache:v1",
  "asset-helper:corporate-actions-cache:v1",
  "asset-helper:corporate-actions-cache:v2",
  "asset-helper:corporate-actions-cache:v3",
  "asset-helper:market-page-cache:v1",
  "asset-helper:market-page-cache:v2",
  "asset-helper:market-page-cache:v3",
  "asset-helper:market-page-cache:v4",
  "asset-helper:market-page-cache:v5",
  "asset-helper:market-page-cache:v6",
  "asset-helper:trading-calendar:v1",
  "asset-helper:fx-rates",
  "dashboard.assetSeries.v4",
];

type PersistedState = Partial<Pick<
  AppState,
  | "groups"
  | "holdings"
  | "closedHoldings"
  | "defaultPrivacyMode"
  | "privacyMode"
  | "colorScheme"
  | "theme"
  | "currency"
  | "language"
  | "refreshInterval"
  | "tradeTimeOnly"
  | "dividendReinvest"
  | "defaultOpenMode"
  | "dcaPlans"
  | "dcaExecutions"
  | "assetSnapshots"
>> & { version?: number };

type RefreshMeta = {
  startedAt?: number;
  finishedAt?: number;
};

const normalizedInitialHoldings = initialHoldings.map(normalizeHolding);
const normalizedInitialClosedHoldings = initialClosedHoldings;

function positiveNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeClosedHolding(raw: Partial<ClosedHolding> & Record<string, unknown>): ClosedHolding | null {
  if (!raw || typeof raw.symbol !== "string" || typeof raw.name !== "string") return null;
  const quantity = positiveNumber(raw.quantity);
  const costPrice = positiveNumber(raw.costPrice);
  const closePrice = positiveNumber(raw.closePrice);
  const costBasis = positiveNumber(raw.costBasis, quantity * costPrice);
  const proceeds = positiveNumber(raw.proceeds, quantity * closePrice);
  const cashDividendTotal = positiveNumber(raw.cashDividendTotal);
  const realizedPnl = positiveNumber(raw.realizedPnl, proceeds + cashDividendTotal - costBasis);
  const closedAt = typeof raw.closedAt === "string" && raw.closedAt ? raw.closedAt : todayLocalYMD();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `closed_${safeUUID()}`,
    sourceHoldingId: typeof raw.sourceHoldingId === "string" ? raw.sourceHoldingId : "",
    groupId: typeof raw.groupId === "string" ? raw.groupId : "",
    symbol: raw.symbol,
    name: raw.name,
    market: raw.market as Holding["market"],
    assetType: raw.assetType as Holding["assetType"],
    quantity,
    costPrice,
    closePrice,
    costBasis,
    proceeds,
    realizedPnl,
    realizedReturn: costBasis > 0 ? realizedPnl / costBasis : positiveNumber(raw.realizedReturn),
    cashDividendTotal,
    currency: typeof raw.currency === "string" && raw.currency ? raw.currency : "CNY",
    openedAt: typeof raw.openedAt === "string" && raw.openedAt ? raw.openedAt : closedAt,
    closedAt,
    isPartial: raw.isPartial === true ? true : undefined,
  };
}

function todayLocalYMD(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ymdFromIsoLike(value: string | undefined) {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

export function buildClosedHolding(
  holding: Holding,
  closePrice = holding.currentPrice,
  closedAt = todayLocalYMD(),
  closedQuantity?: number,
): ClosedHolding {
  const totalQuantity = Number.isFinite(holding.quantity) ? holding.quantity : 0;
  // For partial closes, only the sold quantity is recorded; for full closes
  // the entire remaining position is recorded.
  const quantity = Number.isFinite(closedQuantity) && closedQuantity! > 0
    ? Math.min(closedQuantity!, totalQuantity)
    : totalQuantity;
  const costPrice = Number.isFinite(holding.costPrice) ? holding.costPrice : 0;
  const safeClosePrice = Number.isFinite(closePrice) && closePrice > 0 ? closePrice : holding.currentPrice;
  const costBasis = quantity * costPrice;
  const proceeds = quantity * safeClosePrice;
  // Dividends are attributed to the full close only; partial closes would
  // double-count if they each carried the lifetime dividend total.
  const isPartial = quantity < totalQuantity;
  const cashDividendTotal = isPartial ? 0 : (holding.cashDividendTotal ?? 0);
  const realizedPnl = proceeds + cashDividendTotal - costBasis;
  return {
    id: `closed_${safeUUID()}`,
    sourceHoldingId: holding.id,
    groupId: holding.groupId,
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    assetType: holding.assetType,
    quantity,
    costPrice,
    closePrice: safeClosePrice,
    costBasis,
    proceeds,
    realizedPnl,
    realizedReturn: costBasis > 0 ? realizedPnl / costBasis : 0,
    cashDividendTotal,
    currency: holding.currency,
    openedAt: ymdFromIsoLike(holding.updatedAt) || closedAt,
    closedAt,
    isPartial: isPartial || undefined,
  };
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
  // Skip weekends/holidays — CN public funds only publish NAV on trading days,
  // so polling outside those days just wastes network requests.
  if (!isTradingDay("FUND", now)) return false;
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

function corporateActionTargetKey(holding: Holding) {
  return `${holding.market}:${holding.symbol}`;
}

function pruneCorporateActionCheckedAt(activeHoldings: Holding[] = [], now = Date.now()) {
  const activeKeys = new Set(activeHoldings.map(corporateActionTargetKey));
  for (const [key, checkedAt] of corporateActionCheckedAt) {
    if ((activeKeys.size > 0 && !activeKeys.has(key)) || now - checkedAt >= CORPORATE_ACTION_CHECK_TTL) {
      corporateActionCheckedAt.delete(key);
    }
  }
  while (corporateActionCheckedAt.size > MAX_CORPORATE_ACTION_CHECKS) {
    const oldestKey = corporateActionCheckedAt.keys().next().value;
    if (!oldestKey) break;
    corporateActionCheckedAt.delete(oldestKey);
  }
}

async function fetchCorporateActionMap(holdings: Holding[], force = false) {
  const now = Date.now();
  pruneCorporateActionCheckedAt(holdings, now);
  const entries = await Promise.all(
    holdings.map(async (holding) => {
      const key = corporateActionTargetKey(holding);
      const checkedAt = corporateActionCheckedAt.get(key) ?? 0;
      if (!force && checkedAt && now - checkedAt < CORPORATE_ACTION_CHECK_TTL) {
        return [holding.id, [] as Awaited<ReturnType<typeof fetchCorporateActions>>] as const;
      }
      const actions = await fetchCorporateActions(holding);
      corporateActionCheckedAt.set(key, Date.now());
      return [holding.id, actions] as const;
    }),
  );
  return new Map(entries);
}

function actionAlreadyApplied(holding: Holding, actionId: string) {
  return (holding.corporateActions ?? []).some((action) => action.id === actionId);
}

function canAutoReinvestDividend(holding: Holding) {
  return holding.market === "FUND" || holding.assetType === "fund";
}

function applyAutomaticCorporateActions(
  holdings: Holding[],
  actionMap: Map<string, Awaited<ReturnType<typeof fetchCorporateActions>>>,
  dividendReinvest: boolean,
  today = todayLocalYMD(),
) {
  let changed = false;
  const nextHoldings = holdings.map((holding) => {
    const since = holding.autoCorporateActionSince || ymdFromIsoLike(holding.updatedAt) || today;
    const actions = actionMap.get(holding.id) ?? [];
    let next: Holding = holding.autoCorporateActionSince ? holding : { ...holding, autoCorporateActionSince: since };
    if (!holding.autoCorporateActionSince) changed = true;

    for (const action of actions) {
      if (action.date < since || action.date > today || actionAlreadyApplied(next, action.id)) continue;
      if (action.type === "split" && action.ratio && action.ratio > 0) {
        next = applyHoldingCorporateAction(next, {
          id: action.id,
          type: "split",
          date: action.date,
          ratio: action.ratio,
          recordDate: action.recordDate,
          exDate: action.exDate,
          payDate: action.payDate,
          announcementDate: action.announcementDate,
          source: action.source,
          description: action.description,
          note: "auto",
        });
        changed = true;
      }
      if (action.type === "cash_dividend" && action.amount && action.amount > 0) {
        const totalAmount = action.amount * next.quantity;
        if (!(totalAmount > 0)) continue;
        const shouldReinvest = canAutoReinvestDividend(next) && (next.dividendReinvest ?? dividendReinvest);
        if (shouldReinvest && next.currentPrice > 0) {
          next = applyHoldingCorporateAction(next, {
            id: action.id,
            type: "share_dividend",
            date: action.date,
            amount: totalAmount,
            shares: totalAmount / next.currentPrice,
            price: next.currentPrice,
            recordDate: action.recordDate,
            exDate: action.exDate,
            payDate: action.payDate,
            announcementDate: action.announcementDate,
            source: action.source,
            description: action.description,
            note: "auto dividend reinvest",
          });
        } else {
          next = applyHoldingCorporateAction(next, {
            id: action.id,
            type: "cash_dividend",
            date: action.date,
            amount: totalAmount,
            recordDate: action.recordDate,
            exDate: action.exDate,
            payDate: action.payDate,
            announcementDate: action.announcementDate,
            source: action.source,
            description: action.description,
            note: "auto",
          });
        }
        changed = true;
      }
    }
    return next;
  });

  return { holdings: nextHoldings, changed };
}

function defaultState(): AppState {
  return {
    groups:          initialGroups,
    holdings:        normalizedInitialHoldings,
    closedHoldings:  normalizedInitialClosedHoldings,
    defaultPrivacyMode: false,
    privacyMode:     false,
    colorScheme:     "red-up",
    theme:           "light",
    currency:        "CNY",
    language:        "zh",
    refreshInterval: 1,
    tradeTimeOnly:   false,
    dividendReinvest:false,
    defaultOpenMode:  DEFAULT_OPEN_MODE,
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

/**
 * Blank state used by "Reset Local Data": no holdings, no groups, no DCA plans,
 * no snapshots — and the demo portfolio is wiped too. User-facing settings
 * (language/theme/color-scheme/currency/refresh interval/privacy mode) are
 * preserved from the current state so the UI doesn't visually flip when the
 * data is cleared.
 */
function blankState(current: AppState): AppState {
  const base = defaultState();
  return {
    ...base,
    groups:          [],
    holdings:        [],
    closedHoldings:  [],
    dcaPlans:        [],
    dcaExecutions:   [],
    assetSnapshots:  [],
    // Preserve user's UI preferences instead of resetting them to defaults.
    colorScheme:     current.colorScheme,
    theme:           current.theme,
    currency:        current.currency,
    language:        current.language,
    refreshInterval: current.refreshInterval,
    tradeTimeOnly:   current.tradeTimeOnly,
    dividendReinvest:current.dividendReinvest,
    defaultOpenMode: current.defaultOpenMode,
    defaultPrivacyMode: current.defaultPrivacyMode,
    privacyMode:     current.defaultPrivacyMode,
  };
}

function buildPersistedState(state: AppState): PersistedState {
  return {
    version: STORAGE_VERSION,
    groups: state.groups,
    holdings: state.holdings,
    closedHoldings: state.closedHoldings,
    defaultPrivacyMode: state.defaultPrivacyMode,
    colorScheme: state.colorScheme,
    theme: state.theme,
    currency: state.currency,
    language: state.language,
    refreshInterval: state.refreshInterval,
    tradeTimeOnly: state.tradeTimeOnly,
    dividendReinvest: state.dividendReinvest,
    defaultOpenMode: state.defaultOpenMode,
    dcaPlans: state.dcaPlans,
    dcaExecutions: pruneDCAExecutions(state.dcaExecutions),
    assetSnapshots: state.assetSnapshots,
  };
}

function clearNonCriticalStorage() {
  if (typeof window === "undefined") return;
  for (const key of NON_CRITICAL_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best effort only; these caches can be rebuilt.
    }
  }
}

function savePersistedState(snapshot: PersistedState, options: { clearCachesOnFailure?: boolean; errorMessage?: string } = {}) {
  if (typeof window === "undefined") return { ok: true };
  const raw = JSON.stringify(snapshot);
  const write = () => {
    window.localStorage.setItem(STORAGE_KEY, raw);
    return window.localStorage.getItem(STORAGE_KEY) === raw;
  };

  try {
    if (write()) return { ok: true };
  } catch {
    // Retry after clearing rebuildable caches below.
  }

  if (options.clearCachesOnFailure) {
    clearNonCriticalStorage();
    try {
      if (write()) return { ok: true };
    } catch {
      // Fall through to the user-facing error below.
    }
  }

  return {
    ok: false,
    error: options.errorMessage ?? "Browser extension storage is full.",
  };
}

function readRefreshMeta(): RefreshMeta {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(REFRESH_META_KEY);
    return raw ? JSON.parse(raw) as RefreshMeta : {};
  } catch {
    return {};
  }
}

function writeRefreshMeta(meta: RefreshMeta) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REFRESH_META_KEY, JSON.stringify(meta));
  } catch {
    // Best effort only; refresh coordination is an optimization.
  }
}

function shouldSkipCoordinatedRefresh(now = Date.now()) {
  const meta = readRefreshMeta();
  if (meta.finishedAt && now - meta.finishedAt < REFRESH_RECENT_TTL) return true;
  if (meta.startedAt && now - meta.startedAt < REFRESH_LOCK_TTL) return true;
  return false;
}

export function loadInitialState(): AppState {
  const base = defaultState();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<PersistedState>;
    // An empty holdings array means the user explicitly cleared their data
    // (clearLocalData writes []). Only fall back to demo holdings when the
    // key is missing entirely (first run / pre-migration). Same for groups.
    const hasSavedHoldings = Array.isArray(saved.holdings);
    const holdings = hasSavedHoldings
      ? saved.holdings!.map(normalizeHolding)
      : base.holdings;
    const closedHoldings = Array.isArray(saved.closedHoldings)
      ? saved.closedHoldings
          .map((item) => normalizeClosedHolding(item as Partial<ClosedHolding> & Record<string, unknown>))
          .filter((item): item is ClosedHolding => item != null)
      : [];
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
      closedHoldings,
      dcaPlans,
      dcaExecutions,
      assetSnapshots,
      colorScheme: enumOr(saved.colorScheme, COLOR_SCHEMES, base.colorScheme),
      theme: enumOr(saved.theme, THEMES, base.theme),
      currency: enumOr(saved.currency, CURRENCIES, base.currency),
      language: enumOr(saved.language, LANGUAGES, base.language),
      refreshInterval: enumOr(saved.refreshInterval, REFRESH_INTERVALS, base.refreshInterval),
      tradeTimeOnly: typeof saved.tradeTimeOnly === "boolean" ? saved.tradeTimeOnly : base.tradeTimeOnly,
      dividendReinvest: typeof saved.dividendReinvest === "boolean" ? saved.dividendReinvest : base.dividendReinvest,
      defaultOpenMode: normalizeOpenMode(saved.defaultOpenMode),
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
  const pendingRefreshOptionsRef = useRef<{ forceCorporateActions?: boolean; bypassCoordination?: boolean } | null>(null);
  const corporateActionRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const persistedSnapshotRef = useRef<PersistedState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void refreshTradingCalendar();
  }, []);

  /* theme colors — recomputed when theme changes */
  const tc = useMemo(() => buildThemeColors(state.theme), [state.theme]);
  const stats = useMemo(() => computeStats(state.holdings, state.closedHoldings), [state.holdings, state.closedHoldings]);
  const persistedSnapshot = useMemo<PersistedState>(() => ({
    version: STORAGE_VERSION,
    groups: state.groups,
    holdings: state.holdings,
    closedHoldings: state.closedHoldings,
    defaultPrivacyMode: state.defaultPrivacyMode,
    colorScheme: state.colorScheme,
    theme: state.theme,
    currency: state.currency,
    language: state.language,
    refreshInterval: state.refreshInterval,
    tradeTimeOnly: state.tradeTimeOnly,
    dividendReinvest: state.dividendReinvest,
    defaultOpenMode: state.defaultOpenMode,
    dcaPlans: state.dcaPlans,
    dcaExecutions: pruneDCAExecutions(state.dcaExecutions),
    assetSnapshots: state.assetSnapshots,
  }), [
    state.groups,
    state.holdings,
    state.closedHoldings,
    state.defaultPrivacyMode,
    state.colorScheme,
    state.theme,
    state.currency,
    state.language,
    state.refreshInterval,
    state.tradeTimeOnly,
    state.dividendReinvest,
    state.defaultOpenMode,
    state.dcaPlans,
    state.dcaExecutions,
    state.assetSnapshots,
  ]);

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

  const applyCorporateActionsToLatestState = useCallback((
    corporateActionMap: Awaited<ReturnType<typeof fetchCorporateActionMap>>,
  ) => {
    if (!corporateActionMap.size) return;
    const now = new Date();
    setState((s) => {
      const corporateState = applyAutomaticCorporateActions(
        s.holdings,
        corporateActionMap,
        s.dividendReinvest,
        todayLocalYMD(now),
      );
      const dcaState = applyDCAState(corporateState.holdings, s.dcaPlans, s.dcaExecutions, false);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
      };
    });
  }, [applyDCAState]);

  const runCorporateActionRefresh = useCallback((currentHoldings: Holding[], force = false) => {
    if (!currentHoldings.length) return Promise.resolve();
    if (corporateActionRefreshPromiseRef.current) return corporateActionRefreshPromiseRef.current;

    const task = fetchCorporateActionMap(currentHoldings, force)
      .then(applyCorporateActionsToLatestState)
      .catch(() => undefined)
      .finally(() => {
        corporateActionRefreshPromiseRef.current = null;
      });

    corporateActionRefreshPromiseRef.current = task;
    return task;
  }, [applyCorporateActionsToLatestState]);

  /* live price refresh */
  const doRefresh = useCallback(async (currentHoldings: Holding[], options: { forceCorporateActions?: boolean; bypassCoordination?: boolean } = {}) => {
    const coordinated = !options.forceCorporateActions && !options.bypassCoordination;
    if (coordinated && shouldSkipCoordinatedRefresh()) return;
    if (coordinated) writeRefreshMeta({ ...readRefreshMeta(), startedAt: Date.now() });
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
            fundBuyConfirmDays: liveUpdate.fundBuyConfirmDays ?? h.fundBuyConfirmDays,
            priceDate: h.priceDate ?? "",
            fundNavHistory: h.fundNavHistory,
          };
          }
          const marketValue = h.quantity * lp.price;
          const costBasis   = h.quantity * h.costPrice;
          const cashDividendTotal = h.cashDividendTotal ?? 0;
          // totalPnl includes cash dividends received while holding.
          const totalPnl    = marketValue - costBasis + cashDividendTotal;
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
            fundBuyConfirmDays: liveUpdate.fundBuyConfirmDays ?? h.fundBuyConfirmDays,
            priceDate: lp.priceDate ?? h.priceDate ?? "",
            fundNavHistory: lp.fundNavHistory ?? h.fundNavHistory,
            estimatedNav: lp.estimatedNav,
            estimatedChangePercent: lp.estimatedChangePercent,
            cashDividendTotal: h.cashDividendTotal ?? 0,
            dividendReinvest: h.dividendReinvest ?? null,
            autoCorporateActionSince: h.autoCorporateActionSince ?? "",
            corporateActions: h.corporateActions ?? [],
            updatedAt:    new Date().toISOString(),
          };
        });
        const now = new Date();
        const t   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
        writeRefreshMeta({ startedAt: 0, finishedAt: now.getTime() });
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
      void runCorporateActionRefresh(currentHoldings, options.forceCorporateActions);
    } catch {
      if (coordinated) writeRefreshMeta({ ...readRefreshMeta(), startedAt: 0 });
      setState((s) => ({ ...s, isRefreshing: false }));
    }
  }, [applyDCAState, runCorporateActionRefresh]);

  const runRefresh = useCallback((currentHoldings: Holding[], options: { forceCorporateActions?: boolean; bypassCoordination?: boolean } = {}) => {
    if (refreshPromiseRef.current) {
      pendingRefreshOptionsRef.current = {
        forceCorporateActions: Boolean(options.forceCorporateActions || pendingRefreshOptionsRef.current?.forceCorporateActions),
        bypassCoordination: Boolean(options.bypassCoordination || pendingRefreshOptionsRef.current?.bypassCoordination),
      };
      return refreshPromiseRef.current;
    }

    const task = doRefresh(currentHoldings, options)
      .finally(() => {
        refreshPromiseRef.current = null;
        const pendingOptions = pendingRefreshOptionsRef.current;
        pendingRefreshOptionsRef.current = null;
        if (pendingOptions) {
          void runRefresh(stateRef.current.holdings, pendingOptions);
        }
      });

    refreshPromiseRef.current = task;
    return task;
  }, [doRefresh]);

  useEffect(() => {
    // Bypass the cross-view refresh coordination on initial mount: when the
    // user switches from popup to side panel (or vice versa) within the
    // 45s TTL, the coordinated skip would otherwise prevent the new view
    // from fetching data at all, leaving it showing stale values with no
    // "refreshing" indication. Each view should always refresh at least once
    // on open.
    void runRefresh(stateRef.current.holdings, { bypassCoordination: true });
  }, [runRefresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    persistedSnapshotRef.current = persistedSnapshot;
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      savePersistedState(persistedSnapshot);
      persistTimerRef.current = null;
    }, 250);
  }, [persistedSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    return () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (persistedSnapshotRef.current) savePersistedState(persistedSnapshotRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const next = loadInitialState();
      setState((current) => ({
        ...next,
        isRefreshing: current.isRefreshing,
        lastRefreshed: current.lastRefreshed,
        lastRefreshAt: current.lastRefreshAt,
        detailTarget: current.detailTarget,
        dcaPanelOpen: current.dcaPanelOpen,
        dcaPanelHoldingId: current.dcaPanelHoldingId,
      }));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    void syncExtensionOpenMode(state.defaultOpenMode);
  }, [state.defaultOpenMode]);

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
    return runRefresh(stateRef.current.holdings, { forceCorporateActions: true });
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
  const setDividendReinvest = useCallback((v: boolean) => setState((s) => ({ ...s, dividendReinvest: v })), []);
  const setDefaultOpenMode = useCallback((v: ExtensionOpenMode) => {
    const mode = normalizeOpenMode(v);
    setState((s) => {
      const next = { ...s, defaultOpenMode: mode };
      savePersistedState(buildPersistedState(next));
      return next;
    });
    void syncExtensionOpenMode(mode);
  }, []);

  const exportPortfolio = useCallback(() => JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: "资产助手",
    version: 2,
    data: {
      groups: state.groups,
      holdings: state.holdings,
      closedHoldings: state.closedHoldings,
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
        dividendReinvest: state.dividendReinvest,
        defaultOpenMode: state.defaultOpenMode,
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
      const current = stateRef.current;
      const closedHoldings = Array.isArray(data.closedHoldings)
        ? data.closedHoldings
            .map((item: unknown) => normalizeClosedHolding(item as Partial<ClosedHolding> & Record<string, unknown>))
            .filter((item: ClosedHolding | null): item is ClosedHolding => item != null)
        : current.closedHoldings;
      const settings = data.settings ?? {};
      const dcaExecutions = Array.isArray(data.dcaExecutions) ? pruneDCAExecutions(data.dcaExecutions) : current.dcaExecutions;
      const dcaPlans = Array.isArray(data.dcaPlans) ? hydratePlans(data.dcaPlans, dcaExecutions) : current.dcaPlans;
      const dcaState = applyDCAState(holdings, dcaPlans, dcaExecutions);
      const nextState: AppState = {
        ...current,
        groups: Array.isArray(data.groups) ? data.groups : current.groups,
        holdings: dcaState.holdings,
        closedHoldings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        // upsertPortfolioSnapshot(snapshots, holdings, date) keeps all
        // historical snapshots from the first arg and replaces only today's
        // entry with a freshly computed one from `holdings`. Passing the
        // imported snapshot array here preserves the 180-day trend history;
        // the .slice(-180) inside the function caps the total length.
        assetSnapshots: Array.isArray(data.assetSnapshots)
          ? upsertPortfolioSnapshot(data.assetSnapshots, dcaState.holdings)
          : upsertPortfolioSnapshot(current.assetSnapshots, dcaState.holdings),
        defaultPrivacyMode: typeof settings.defaultPrivacyMode === "boolean"
          ? settings.defaultPrivacyMode
          : typeof settings.privacyMode === "boolean"
            ? settings.privacyMode
            : current.defaultPrivacyMode,
        privacyMode: current.privacyMode,
        colorScheme: enumOr(settings.colorScheme, COLOR_SCHEMES, current.colorScheme),
        theme: enumOr(settings.theme, THEMES, current.theme),
        currency: enumOr(settings.currency, CURRENCIES, current.currency),
        language: enumOr(settings.language, LANGUAGES, current.language),
        refreshInterval: enumOr(settings.refreshInterval, REFRESH_INTERVALS, current.refreshInterval),
        tradeTimeOnly: typeof settings.tradeTimeOnly === "boolean" ? settings.tradeTimeOnly : current.tradeTimeOnly,
        dividendReinvest: typeof settings.dividendReinvest === "boolean" ? settings.dividendReinvest : current.dividendReinvest,
        defaultOpenMode: normalizeOpenMode(settings.defaultOpenMode ?? current.defaultOpenMode),
      };
      const storageError = nextState.language === "en"
        ? "Import failed: browser extension storage is full. Market caches were cleared; please import again or clear local data first."
        : "导入失败：浏览器扩展存储空间不足，已尝试清理行情缓存，请重新导入或先清空本地数据。";
      const saved = savePersistedState(buildPersistedState(nextState), {
        clearCachesOnFailure: true,
        errorMessage: storageError,
      });
      if (!saved.ok) return saved;
      pruneCorporateActionCheckedAt(dcaState.holdings);
      setState(nextState);
      void runRefresh(dcaState.holdings, { forceCorporateActions: true, bypassCoordination: true });
      return { ok: true };
    } catch {
      return { ok: false, error: "JSON 格式无法解析" };
    }
  }, [applyDCAState, runRefresh]);

  const clearLocalData = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
      // Clear every asset-helper:* cache (chart, market page, fx rates,
      // corporate actions, trading calendar, fund history …). Scanning by
      // prefix avoids the list going stale whenever a cache version bumps.
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith("asset-helper:") && key !== STORAGE_KEY) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((key) => window.localStorage.removeItem(key));
      } catch {
        // localStorage access can throw in private mode; ignore.
      }
    }
    pruneCorporateActionCheckedAt([]);
    // Reset to a truly blank portfolio (no demo data) while preserving the
    // user's UI preferences so the screen doesn't visually flip on clear.
    setState((current) => blankState(current));
  }, []);

  /* groups */
  const addGroup    = useCallback((g: Omit<Group, "id" | "sort">) => {
    setState((s) => ({ ...s, groups: [...s.groups, { ...g, id: `group_${safeUUID()}`, sort: Date.now() }] }));
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
    const h = buildHolding(input, `holding_${safeUUID()}`);
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
          cashDividendTotal: previous.cashDividendTotal ?? 0,
          dividendReinvest: rebuilt.dividendReinvest ?? null,
          corporateActions: previous.corporateActions ?? [],
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
      const numericQuantity = Number(input.quantity);
      const numericPrice = Number(input.price);
      const isSell = input.type === "sell"
        && Number.isFinite(numericQuantity) && numericQuantity > 0
        && Number.isFinite(numericPrice) && numericPrice > 0
        && target.quantity > 0;
      const willClose = isSell && numericQuantity >= target.quantity;
      // Record every sell (partial or full) as a closed-holding entry so the
      // realized P/L shows up in the closed history. For partial sells the
      // entry carries only the sold quantity; the remaining position stays.
      const closedHolding = isSell
        ? buildClosedHolding(target, numericPrice, todayLocalYMD(), willClose ? target.quantity : numericQuantity)
        : null;
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
      // Full close: closedHolding is set and adjusted is null → prepend.
      // Partial close: closedHolding is set and adjusted is non-null → still prepend.
      const nextClosedHoldings = closedHolding ? [closedHolding, ...s.closedHoldings] : s.closedHoldings;
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        closedHoldings: nextClosedHoldings,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
      };
    });
  }, [applyDCAState]);
  const applyCorporateAction = useCallback((id: string, input: HoldingCorporateActionInput) => {
    setState((s) => {
      const target = s.holdings.find((item) => item.id === id);
      if (!target) return s;
      const adjusted = applyHoldingCorporateAction(target, input);
      const updatedHoldings = s.holdings.map((item) => item.id === id ? adjusted : item);
      const updatedPlans = s.dcaPlans.map((plan) => (plan.holdingId === id ? syncPlanWithHolding(plan, adjusted) : plan));
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
  const removeHolding = useCallback((id: string) => {
    setState((s) => {
      const target = s.holdings.find((h) => h.id === id);
      if (!target) return s;
      const updatedHoldings = s.holdings.filter((h) => h.id !== id);
      pruneCorporateActionCheckedAt(updatedHoldings);
      const updatedPlans = s.dcaPlans.filter((plan) => plan.holdingId !== id);
      const updatedExecutions = s.dcaExecutions.filter((item) => item.holdingId !== id);
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, updatedExecutions);
      return {
        ...s,
        holdings: dcaState.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        closedHoldings: [buildClosedHolding(target), ...s.closedHoldings],
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaState.holdings),
        dcaPanelHoldingId: s.dcaPanelHoldingId === id ? null : s.dcaPanelHoldingId,
      };
    });
  }, [applyDCAState]);

  const removeClosedHolding = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      closedHoldings: s.closedHoldings.filter((item) => item.id !== id),
    }));
  }, []);

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
      id:           `dca_${safeUUID()}`,
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
      setTradeTimeOnly, setDividendReinvest, setDefaultOpenMode, refresh,
      exportPortfolio, importPortfolio, clearLocalData,
      addGroup, updateGroup, removeGroup,
      addHolding, updateHolding, adjustHolding, applyCorporateAction, removeHolding, removeClosedHolding,
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
