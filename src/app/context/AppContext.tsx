import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { groups as initialGroups, holdings as initialHoldings, closedHoldings as initialClosedHoldings, Group, Holding, ClosedHolding, type TransactionCostProfile } from "../data/mockData";
import { FX, refreshPrices, resolveFundEstimateUpdate, toCNY } from "../services/priceRefresher";
import { MarketType, DCAFrequency, isMarketOpenNow, isTradingDay, refreshTradingCalendar } from "../services/tradingCalendar";
import type { ChartPoint } from "../services/quoteApi";
import { fetchCorporateActions, type CorporateActionEvent } from "../services/corporateActions";
import {
  PortfolioEvent,
  PortfolioEventBaseline,
  PortfolioEventSource,
  buildBuyEvent,
  buildPortfolioEventFromCorporateAction,
  buildSellEvent,
  compactPortfolioEventHistory,
  computeBaselineBreakdown,
  computeReturnBreakdown,
  dedupePortfolioEvents,
  migratePortfolioEvents,
  normalizePortfolioEvents,
  normalizePortfolioEventBaseline,
  ymdFromEventValue,
} from "../services/portfolioEvents";
import { normalizeHolding, buildHolding, applyHoldingAdjustment, applyCorporateAction as applyHoldingCorporateAction, recomputeHoldingMetrics, reverseCorporateAction } from "../utils/holdingHelpers";
import { dedupeDCAExecutions, hydratePlans, repairDCAData, settleDueDCAPlans, syncPlanWithHolding, computeNextExec } from "../utils/dcaEngine";
import { safeUUID } from "../utils/safeId";
import { acknowledgeSnapshotDueDates, DEFAULT_OPEN_MODE, getConfiguredExtensionOpenMode, getSnapshotDueDates, normalizeOpenMode, syncExtensionOpenMode, type ExtensionOpenMode } from "../utils/extensionOpenMode";
import { estimateTransactionCosts, mergeTransactionCostProfile } from "../utils/transactionCosts";
import { affordableBuyAmount } from "../utils/transactionCosts";
import { backfillPortfolioSnapshots, collectMissingSnapshotDates } from "../services/portfolioSnapshotBackfill";
import { collectStaleSnapshotDates } from "../services/staleSnapshotDetector";
import { backfillPortfolioEventFxRates } from "../services/portfolioEventFxBackfill";
import { mergeAutomaticTradeStatus, resolveHoldingTradeStatus } from "../utils/tradeStatus";
import {
  computeFundEffectiveDate,
  computeFundOrderCancelDeadline,
  computeFundOrderConfirmDate,
  defaultFundConfirmDays,
  fundOrderReservedBuyAmount,
  fundOrderMinimumViolation,
  normalizeFundOrders,
  parseChineseMoneyLimit,
  pendingSellQuantity,
  readyFundOrderConfirmations,
  requestFundOrderCancellation,
  resolveFundOrderCutoff,
  type FundOrder,
  type FundOrderRuleSnapshot,
} from "../utils/fundOrders";

/* ─── types ──────────────────────────────────────────── */
type ColorScheme    = "red-up" | "green-up";
type Theme          = "dark" | "light" | "system";
type Currency       = "CNY" | "USD" | "HKD";
type RefreshInterval = 0 | 1 | 5 | 15 | 30 | 60;
export type Language = "zh" | "en";
export type HoldingTradeStatus = "normal" | "suspended" | "fund_limit" | "buy_disabled" | "unknown";
export type HoldingAdjustmentType = "buy" | "sell";
export type HoldingCorporateActionType = "cash_dividend" | "dividend_reinvest" | "share_dividend" | "split" | "interest" | "bond_coupon" | "fee" | "tax";

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

function importPortfolioError(language: Language, key: "missingHoldings" | "invalidJson") {
  if (language === "en") {
    return key === "missingHoldings"
      ? "Import file is missing holdings data"
      : "JSON format could not be parsed";
  }
  return key === "missingHoldings"
    ? "导入文件缺少 holdings 数据"
    : "JSON 格式无法解析";
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
  autoTradeStatusUpdatedAt?: string;
  autoTradeStatusStale?: boolean;
  autoTradeStatusRefreshNote?: string;
  fundBuyConfirmDays?: number;
  fundSellConfirmDays?: number;
  fundPurchaseStatus?: Holding["fundPurchaseStatus"];
  fundDcaStatus?: Holding["fundDcaStatus"];
  fundRedemptionStatus?: Holding["fundRedemptionStatus"];
  fundPurchaseStatusNote?: string;
  fundDcaStatusNote?: string;
  fundRedemptionStatusNote?: string;
  fundMinPurchaseAmount?: number;
  fundMinDcaAmount?: number;
  fundMinRedemptionQuantity?: number;
  fundMinRemainingQuantity?: number;
  fundBuyCutoffMinutes?: number;
  fundSellCutoffMinutes?: number;
  fundDcaCutoffMinutes?: number;
  fundBuyCancellationAllowed?: boolean;
  fundSellCancellationAllowed?: boolean;
  fundDcaCancellationAllowed?: boolean;
  fundCancellationRuleSource?: string;
  fundTradeRulesUpdatedAt?: string;
  dividendReinvest?: boolean | null;
  transactionCostProfile?: TransactionCostProfile;
};

export type HoldingAdjustmentInput = {
  type: HoldingAdjustmentType;
  quantity: number;
  price: number;
  date?: string;
  fee?: number;
  tax?: number;
  costProfilePatch?: TransactionCostProfile;
  rememberCostProfile?: boolean;
  feeRateUsed?: number;
  taxRateUsed?: number;
  minimumFeeUsed?: number;
  estimatedFee?: number;
  estimatedTax?: number;
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
  rateUsed?: number;
  minimumFeeUsed?: number;
  estimatedAmount?: number;
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
  costBasis:      number;
  todayPnl:       number;
  todayPnlRate:   number;
  cumulativePnl:  number;
  cumulativeRate: number;
  unrealizedPnl:  number;
  unrealizedRate: number;
  realizedPnl:    number;
  realizedRate:   number;
  realizedTradingPnl: number;
  dividendPnl:    number;
  feePnl:         number;
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
  unrealizedPnl?: number;
  realizedTradingPnl?: number;
  dividendPnl?: number;
  feePnl?: number;
  totalPnl?: number;
  migratedBaseline?: boolean;
  estimated?: boolean;
  estimateReason?: "historical_backfill";
  fxFallback?: boolean;
  holdingUnrealizedPnl?: Record<string, number>;
  holdingValuationDates?: Record<string, string>;
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
  archived?: boolean;
}

export type DCAExecutionStatus = "pending" | "executed" | "skipped" | "cancelled";

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
  expectedConfirmDate?: string;
  channelConfirmedAt?: string;
  confirmedDate?: string;
  /** undefined = legacy execution; null = no costs at submission time. */
  transactionCostProfile?: TransactionCostProfile | null;
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
export function computeStats(
  holdings: Holding[],
  closedHoldings: ClosedHolding[] = [],
  portfolioEvents: PortfolioEvent[] = [],
  portfolioEventBaseline: PortfolioEventBaseline = { daily: {}, realizedCostBasis: 0 },
): PortfolioStats {
  const totalMV    = holdings.reduce((s, h) => s + toCNY(h.quantity * h.currentPrice, h.currency), 0);
  const todayPnl   = holdings.reduce((s, h) => s + toCNY(h.todayPnl,    h.currency), 0);
  const unrealizedPnl = holdings.reduce((s, h) => s + toCNY(
    h.quantity * (h.currentPrice - h.costPrice),
    h.currency,
  ), 0);
  const costBasis  = holdings.reduce((s, h) => s + toCNY(h.quantity * h.costPrice, h.currency), 0);
  const eventBreakdown = computeReturnBreakdown(portfolioEvents);
  const baselineBreakdown = computeBaselineBreakdown(portfolioEventBaseline);
  const hasEventHistory = portfolioEvents.length > 0 || Object.keys(portfolioEventBaseline.daily).length > 0;
  const fallbackClosedPnl = hasEventHistory
    ? 0
    : closedHoldings.reduce((s, h) => s + toCNY(h.realizedPnl - (h.cashDividendTotal ?? 0), h.currency), 0);
  const fallbackClosedDividend = hasEventHistory
    ? 0
    : closedHoldings.reduce((s, h) => s + toCNY(h.cashDividendTotal ?? 0, h.currency), 0);
  const realizedTradingPnl = baselineBreakdown.realizedTradingPnl + eventBreakdown.realizedTradingPnl + fallbackClosedPnl;
  const dividendPnl = baselineBreakdown.dividendPnl + eventBreakdown.dividendPnl + fallbackClosedDividend;
  const feePnl = baselineBreakdown.feePnl + eventBreakdown.feePnl;
  const realizedPnl = realizedTradingPnl + dividendPnl + feePnl;
  const realizedCostBasis = closedHoldings.reduce((s, h) => s + toCNY(h.costBasis, h.currency), 0);
  const eventRealizedCostBasis = portfolioEvents.reduce((sum, event) => {
    if (event.type !== "sell") return sum;
    return sum + toCNY(event.costBasisAtEvent ?? 0, event.currency);
  }, 0);
  const realizedRateCostBasis = portfolioEventBaseline.realizedCostBasis + eventRealizedCostBasis > 0
    ? portfolioEventBaseline.realizedCostBasis + eventRealizedCostBasis
    : realizedCostBasis;
  const totalInvestmentPnl = unrealizedPnl + realizedPnl;
  const totalInvestmentCostBasis = costBasis + realizedRateCostBasis;
  const prevMV     = totalMV - todayPnl;
  return {
    totalAsset:     totalMV,
    holdingValue:   totalMV,
    availableCash:  0,
    costBasis,
    todayPnl,
    todayPnlRate:   prevMV  > 0 ? todayPnl  / prevMV   : 0,
    cumulativePnl:  totalInvestmentPnl,
    cumulativeRate: totalInvestmentCostBasis > 0 ? totalInvestmentPnl / totalInvestmentCostBasis : 0,
    unrealizedPnl,
    unrealizedRate: costBasis > 0 ? unrealizedPnl / costBasis : 0,
    realizedPnl,
    realizedTradingPnl,
    dividendPnl,
    feePnl,
    realizedRate: realizedRateCostBasis > 0 ? realizedPnl / realizedRateCostBasis : 0,
    totalInvestmentPnl,
    totalInvestmentRate: totalInvestmentCostBasis > 0 ? totalInvestmentPnl / totalInvestmentCostBasis : 0,
    usdEquiv:       totalMV / (FX.USD || 7.25),
    lastUpdated:    new Date().toISOString(),
  };
}

export function preserveHoldingLedgerFields(previous: Holding, next: Holding): Holding {
  return {
    ...next,
    symbol: previous.symbol,
    market: previous.market,
    assetType: previous.assetType,
    currency: previous.currency,
    quantity: previous.quantity,
    costPrice: previous.costPrice,
    cashDividendTotal: previous.cashDividendTotal ?? 0,
    corporateActions: previous.corporateActions ?? [],
    fundNavHistory: previous.fundNavHistory,
    priceDate: previous.priceDate,
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
  lastRefreshError: string;
  storageError:     string;
  loadFailed:       boolean;
  detailTarget:    DetailTarget | null;
  dcaPlans:        DCAPlan[];
  dcaExecutions:   DCAExecution[];
  fundOrders:      FundOrder[];
  portfolioEvents: PortfolioEvent[];
  portfolioEventBaseline: PortfolioEventBaseline;
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
  submitFundOrder:    (id: string, input: HoldingAdjustmentInput) => { ok: boolean; error?: string };
  cancelFundOrder:    (id: string) => { ok: boolean; error?: string };
  removeHolding:      (id: string) => void;
  removeClosedHolding: (id: string) => void;
  updatePortfolioEvent: (id: string, patch: Pick<PortfolioEvent, "date" | "amount" | "note">) => void;
  removePortfolioEvent: (id: string) => void;
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
const STORAGE_BACKUP_KEY = "asset-helper:v2:backup";
const SAVED_BACKTESTS_KEY = "asset-helper:saved-backtests:v1";
const STORAGE_VERSION = 6;
const REFRESH_META_KEY = "asset-helper:portfolio-refresh-meta:v1";
const REFRESH_RECENT_TTL = 45_000;
const REFRESH_LOCK_TTL = 25_000;
const CLEAR_RUNTIME_CACHES_EVENT = "asset-helper:clear-runtime-caches";
const MAX_DCA_EXECUTIONS = 300;
const MAX_DCA_EXECUTIONS_PER_PLAN = 24;
const MAX_PORTFOLIO_SNAPSHOTS = 1825;
const COMPACT_PORTFOLIO_SNAPSHOTS = 365;
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
  "asset-helper:corporate-actions-cache:v4",
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
  | "fundOrders"
  | "portfolioEvents"
  | "portfolioEventBaseline"
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

function optionalNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function refreshedFundRule<T>(incoming: T | null | undefined, current: T | undefined) {
  return incoming === undefined ? current : incoming ?? undefined;
}

function normalizeClosedHolding(raw: Partial<ClosedHolding> & Record<string, unknown>): ClosedHolding | null {
  if (!raw || typeof raw.symbol !== "string" || typeof raw.name !== "string") return null;
  const quantity = positiveNumber(raw.quantity);
  const costPrice = positiveNumber(raw.costPrice);
  const closePrice = positiveNumber(raw.closePrice);
  const costBasis = positiveNumber(raw.costBasis, quantity * costPrice);
  const proceeds = positiveNumber(raw.proceeds, quantity * closePrice);
  const cashDividendTotal = positiveNumber(raw.cashDividendTotal);
  const transactionFee = optionalNonNegativeNumber(raw.transactionFee);
  const transactionTax = optionalNonNegativeNumber(raw.transactionTax);
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
    transactionFee,
    transactionTax,
    realizedPnl,
    realizedReturn: costBasis > 0 ? realizedPnl / costBasis : positiveNumber(raw.realizedReturn),
    cashDividendTotal,
    dividendReinvest: raw.dividendReinvest === true ? true : undefined,
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

const STALE_SNAPSHOT_RECOMPUTE_KEY = "asset-helper:stale-snapshot-recompute";

function readStaleSnapshotRecomputeQueue() {
  if (typeof window === "undefined") return [] as string[];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STALE_SNAPSHOT_RECOMPUTE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
      : [];
  } catch {
    return [];
  }
}

function writeStaleSnapshotRecomputeQueue(dates: string[]) {
  if (typeof window === "undefined") return;
  try {
    const normalized = [...new Set(dates)].sort();
    if (normalized.length) window.localStorage.setItem(STALE_SNAPSHOT_RECOMPUTE_KEY, JSON.stringify(normalized));
    else window.localStorage.removeItem(STALE_SNAPSHOT_RECOMPUTE_KEY);
  } catch {
    // Best effort: a future refresh can rediscover newly stale NAV dates.
  }
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
  transactionCosts: number | { fee?: number; tax?: number } = 0,
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
  const isPartial = quantity < totalQuantity;
  const cashDividendTotal = isPartial ? 0 : (holding.cashDividendTotal ?? 0);
  const transactionFee = typeof transactionCosts === "number"
    ? (Number.isFinite(transactionCosts) ? Math.max(0, transactionCosts) : 0)
    : (Number.isFinite(transactionCosts.fee) ? Math.max(0, transactionCosts.fee ?? 0) : 0);
  const transactionTax = typeof transactionCosts === "number"
    ? 0
    : (Number.isFinite(transactionCosts.tax) ? Math.max(0, transactionCosts.tax ?? 0) : 0);
  const safeTransactionCosts = transactionFee + transactionTax;
  const realizedPnl = proceeds - costBasis - safeTransactionCosts + cashDividendTotal;
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
    transactionFee,
    transactionTax,
    realizedPnl,
    realizedReturn: costBasis > 0 ? realizedPnl / costBasis : 0,
    cashDividendTotal,
    dividendReinvest: !isPartial && holding.dividendReinvest === true ? true : undefined,
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

function upsertPortfolioSnapshot(
  snapshots: PortfolioSnapshot[],
  holdings: Holding[],
  portfolioEvents: PortfolioEvent[] = [],
  date = new Date(),
  portfolioEventBaseline: PortfolioEventBaseline = { daily: {}, realizedCostBasis: 0 },
) {
  const stats = computeStats(holdings, [], portfolioEvents, portfolioEventBaseline);
  const today = todayLocalYMD(date);
  const existingToday = snapshots.find((snapshot) => snapshot.date === today);
  const hasBreakdownHistory = snapshots.some((snapshot) => Number.isFinite(snapshot.unrealizedPnl));
  const next: PortfolioSnapshot = {
    date: today,
    totalAsset: stats.totalAsset,
    todayPnl: stats.todayPnl,
    cumulativePnl: stats.cumulativePnl,
    unrealizedPnl: stats.unrealizedPnl,
    realizedTradingPnl: stats.realizedTradingPnl,
    dividendPnl: stats.dividendPnl,
    feePnl: stats.feePnl,
    totalPnl: stats.totalInvestmentPnl,
    migratedBaseline: existingToday?.migratedBaseline || !hasBreakdownHistory || undefined,
    holdingUnrealizedPnl: Object.fromEntries(holdings.map((holding) => [
      holding.id,
      toCNY((holding.currentPrice - holding.costPrice) * holding.quantity, holding.currency),
    ])),
    holdingValuationDates: Object.fromEntries(holdings
      .filter((holding) => /^\d{4}-\d{2}-\d{2}$/.test(holding.priceDate ?? ""))
      .map((holding) => [holding.id, holding.priceDate!])),
  };
  return [
    ...snapshots.filter((snapshot) => snapshot.date !== today),
    next,
  ]
    .filter((snapshot) => snapshot.date && Number.isFinite(snapshot.totalAsset))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-MAX_PORTFOLIO_SNAPSHOTS);
}

function prunePortfolioSnapshots(snapshots: PortfolioSnapshot[] = [], limit = MAX_PORTFOLIO_SNAPSHOTS) {
  return snapshots
    .filter((snapshot) => snapshot.date && Number.isFinite(snapshot.totalAsset))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);
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

function appendDCAExecutionEvents(
  events: PortfolioEvent[],
  holdings: Holding[],
  executions: DCAExecution[],
  source: PortfolioEventSource = "auto",
) {
  const executionStatus = new Map(executions.map((execution) => [execution.id, execution.status]));
  const invalidExecutionIds = new Set(
    executions.filter((execution) => execution.status !== "executed").map((execution) => execution.id),
  );
  const retainedEvents = events.filter((event) => !(
    event.relatedEventId && executionStatus.has(event.relatedEventId) && invalidExecutionIds.has(event.relatedEventId)
  ));
  const existingExecutionIds = new Set(retainedEvents.map((event) => event.relatedEventId).filter(Boolean));
  const holdingById = new Map(holdings.map((holding) => {
    const corporateActions = (holding.corporateActions ?? []).filter((action) => {
      const match = action.id.match(/^dca:(.+):(fee|tax)$/);
      return !match?.[1] || !invalidExecutionIds.has(match[1]);
    });
    return [holding.id, corporateActions.length === (holding.corporateActions ?? []).length ? holding : { ...holding, corporateActions }] as const;
  }));
  let nextHoldings = holdings;
  const nextEvents = [...retainedEvents];
  let changed = retainedEvents.length !== events.length || [...holdingById.values()].some((holding, index) => holding !== holdings[index]);
  for (const execution of executions) {
    if (execution.status !== "executed" || existingExecutionIds.has(execution.id)) continue;
    if (!(execution.quantity && execution.quantity > 0 && execution.price && execution.price > 0)) continue;
    let holding = holdingById.get(execution.holdingId);
    if (!holding) continue;
    const date = ymdFromEventValue(execution.actualDate);
    const buyEvent = buildBuyEvent(holding, {
      quantity: execution.quantity,
      price: execution.price,
      date: execution.actualDate,
      source,
      relatedEventId: execution.id,
    });
    nextEvents.push(buyEvent);
    const tradeAmount = execution.quantity * execution.price;
    const executionCostProfile = execution.transactionCostProfile === undefined
      ? holding.transactionCostProfile
      : execution.transactionCostProfile ?? undefined;
    const { fee, tax } = estimateTransactionCosts(executionCostProfile, "buy", tradeAmount);
    for (const [costType, costAmount] of [["fee", fee], ["tax", tax]] as const) {
      if (!(costAmount > 0)) continue;
      const actionId = `dca:${execution.id}:${costType}`;
      if (!(holding.corporateActions ?? []).some((action) => action.id === actionId)) {
        holding = applyHoldingCorporateAction(holding, {
          id: actionId,
          type: costType,
          date,
          amount: costAmount,
          source,
          note: "dca transaction cost",
        });
        holdingById.set(holding.id, holding);
      }
      const action = holding.corporateActions?.find((item) => item.id === actionId);
      const costEvent = action ? buildPortfolioEventFromCorporateAction(holding, action, source) : null;
      if (costEvent) nextEvents.push({ ...costEvent, relatedEventId: execution.id });
    }
    existingExecutionIds.add(execution.id);
    changed = true;
  }
  if (changed) {
    nextHoldings = holdings.map((holding) => holdingById.get(holding.id) ?? holding);
  }
  return {
    holdings: nextHoldings,
    portfolioEvents: changed ? dedupePortfolioEvents(nextEvents) : events,
  };
}

function fundOrderRuleForHolding(
  holding: Holding,
  side: "buy" | "sell",
  capturedAt: string,
  transactionCostProfile = holding.transactionCostProfile,
  source: "manual" | "dca" = "manual",
): FundOrderRuleSnapshot {
  const resolved = resolveHoldingTradeStatus(holding);
  const confirmDays = defaultFundConfirmDays(holding, side);
  const tradeStatus: FundOrderRuleSnapshot["tradeStatus"] = side === "buy"
    ? holding.fundPurchaseStatus && holding.fundPurchaseStatus !== "unknown"
      ? holding.autoTradeStatusStale && holding.fundPurchaseStatus === "normal" ? "unknown" : holding.fundPurchaseStatus
      : resolved.status
    : holding.fundRedemptionStatus === "sell_disabled"
      ? "sell_disabled"
      : holding.fundRedemptionStatus === "normal"
        ? holding.autoTradeStatusStale ? "unknown" : "normal"
        : "unknown";
  const tradeStatusNote = side === "buy"
    ? holding.fundPurchaseStatusNote || resolved.note
    : holding.fundRedemptionStatusNote || (tradeStatus === "sell_disabled" ? "基金当前暂停赎回" : resolved.note);
  const cutoffRule = resolveFundOrderCutoff(holding, side, source);
  return {
    tradeStatus,
    tradeStatusNote,
    tradeStatusSource: resolved.source || null,
    purchaseLimit: side === "buy" ? parseChineseMoneyLimit(resolved.note ?? "") ?? undefined : undefined,
    minimumPurchaseAmount: side === "buy" ? holding.fundMinPurchaseAmount : undefined,
    minimumRedemptionQuantity: side === "sell" ? holding.fundMinRedemptionQuantity : undefined,
    minimumRemainingQuantity: side === "sell" ? holding.fundMinRemainingQuantity : undefined,
    confirmDays,
    cutoffMinutes: cutoffRule.cutoffMinutes,
    cutoffSource: cutoffRule.cutoffSource,
    cutoffEstimated: cutoffRule.cutoffEstimated,
    cancellationPolicy: cutoffRule.cancellationPolicy,
    cancellationPolicySource: cutoffRule.cancellationPolicySource,
    transactionCostProfile: transactionCostProfile ?? null,
    capturedAt,
  };
}

function syncDCAFundOrders(
  existingOrders: FundOrder[],
  holdings: Holding[],
  plans: DCAPlan[],
  executions: DCAExecution[],
) {
  const holdingById = new Map(holdings.map((holding) => [holding.id, holding]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const byId = new Map(existingOrders.map((order) => [order.id, order]));
  for (const execution of executions) {
    const plan = planById.get(execution.planId);
    const holding = holdingById.get(execution.holdingId);
    if (!plan || !holding || !(plan.market === "FUND" || plan.assetType === "fund")) continue;
    const existing = byId.get(execution.id);
    const requestedAt = existing?.requestedAt ?? `${execution.actualDate}T14:30:00.000+08:00`;
    const executionCostProfile = execution.transactionCostProfile === undefined
      ? holding.transactionCostProfile
      : execution.transactionCostProfile ?? undefined;
    const rule = {
      ...(existing?.rule ?? fundOrderRuleForHolding(holding, "buy", requestedAt, executionCostProfile, "dca")),
      cancellationPolicy: "not_cancellable" as const,
      cancellationPolicySource: "自动定投触发单不可手工撤销",
    };
    const status: FundOrder["status"] = execution.status === "executed"
      ? "confirmed"
      : execution.status === "cancelled"
        ? "cancelled"
      : execution.status === "skipped"
        ? "rejected"
        : "pending";
    byId.set(execution.id, {
      id: execution.id,
      holdingId: execution.holdingId,
      symbol: holding.symbol,
      planId: execution.planId,
      source: "dca",
      entryMode: "submitted",
      side: "buy",
      status,
      requestedAt,
      requestedDate: execution.actualDate,
      effectiveDate: execution.actualDate,
      requestedAmount: execution.amount,
      estimatedPrice: existing?.estimatedPrice ?? holding.currentPrice,
      expectedConfirmDate: execution.expectedConfirmDate ?? computeFundOrderConfirmDate(holding, execution.actualDate, rule.confirmDays),
      channelConfirmedAt: execution.channelConfirmedAt ?? existing?.channelConfirmedAt,
      cancelDeadline: undefined,
      cancelledAt: status === "cancelled" ? existing?.cancelledAt : undefined,
      confirmedDate: execution.confirmedDate,
      navDate: execution.navDate,
      confirmedPrice: execution.price,
      confirmedQuantity: execution.quantity,
      confirmedAmount: execution.quantity && execution.price ? execution.quantity * execution.price : undefined,
      reason: execution.reason,
      rule,
      createdAt: existing?.createdAt ?? requestedAt,
      updatedAt: new Date().toISOString(),
    });
  }
  return [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function settleManualFundOrders(
  holdings: Holding[],
  closedHoldings: ClosedHolding[],
  orders: FundOrder[],
  events: PortfolioEvent[],
  asOfDate: string,
) {
  const confirmations = readyFundOrderConfirmations(holdings, orders, asOfDate);
  const nextHoldings = [...holdings];
  let nextClosed = [...closedHoldings];
  let nextOrders = [...orders];
  const nextEvents = [...events];
  let changed = false;

  for (const confirmation of confirmations) {
    const orderIndex = nextOrders.findIndex((order) => order.id === confirmation.orderId && order.status === "pending");
    if (orderIndex < 0) continue;
    const order = nextOrders[orderIndex]!;
    const holdingIndex = nextHoldings.findIndex((holding) => holding.id === order.holdingId);
    if (holdingIndex < 0) {
      nextOrders[orderIndex] = { ...order, status: "rejected", reason: "关联持仓不存在", updatedAt: new Date().toISOString() };
      changed = true;
      continue;
    }
    const target = nextHoldings[holdingIndex]!;
    const transactionCostProfile = order.rule.transactionCostProfile === undefined
      ? target.transactionCostProfile
      : order.rule.transactionCostProfile ?? undefined;
    const eventDate = order.effectiveDate;
    if (order.side === "buy") {
      const requestedAmount = order.requestedAmount ?? 0;
      const tradeAmount = affordableBuyAmount(transactionCostProfile, requestedAmount);
      const quantity = tradeAmount / confirmation.price;
      if (!(quantity > 0)) {
        nextOrders[orderIndex] = { ...order, status: "rejected", reason: "确认份额计算失败", updatedAt: new Date().toISOString() };
        changed = true;
        continue;
      }
      let adjusted = applyHoldingAdjustment(target, { type: "buy", quantity, price: confirmation.price }) ?? target;
      const buyEvent = buildBuyEvent(target, {
        quantity,
        price: confirmation.price,
        date: eventDate,
        source: "manual",
        relatedEventId: order.id,
      });
      nextEvents.push(buyEvent);
      const { fee, tax } = estimateTransactionCosts(transactionCostProfile, "buy", tradeAmount);
      for (const [costType, costAmount] of [["fee", fee], ["tax", tax]] as const) {
        if (!(costAmount > 0)) continue;
        adjusted = applyHoldingCorporateAction(adjusted, {
          id: `fund-order:${order.id}:${costType}`,
          type: costType,
          date: eventDate,
          amount: costAmount,
          source: "manual",
          note: "fund order transaction cost",
        });
        const action = adjusted.corporateActions?.find((item) => item.id === `fund-order:${order.id}:${costType}`);
        const costEvent = action ? buildPortfolioEventFromCorporateAction(adjusted, action, "manual") : null;
        if (costEvent) nextEvents.push({ ...costEvent, relatedEventId: order.id });
      }
      nextHoldings[holdingIndex] = adjusted;
      nextOrders[orderIndex] = {
        ...order,
        status: "confirmed",
        confirmedDate: confirmation.confirmedDate,
        navDate: confirmation.navDate,
        confirmedPrice: confirmation.price,
        confirmedQuantity: quantity,
        confirmedAmount: tradeAmount,
        fee,
        tax,
        reason: undefined,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
      continue;
    }

    const quantity = order.requestedQuantity ?? 0;
    if (!(quantity > 0)) {
      nextOrders[orderIndex] = { ...order, status: "rejected", reason: "可赎回份额不足", updatedAt: new Date().toISOString() };
      changed = true;
      continue;
    }
    if (quantity > target.quantity + 1e-8) {
      nextOrders[orderIndex] = { ...order, status: "rejected", reason: "确认时可赎回份额不足，未执行部分赎回", updatedAt: new Date().toISOString() };
      changed = true;
      continue;
    }
    const grossAmount = quantity * confirmation.price;
    const { fee, tax } = estimateTransactionCosts(transactionCostProfile, "sell", grossAmount);
    const closed = buildClosedHolding(target, confirmation.price, eventDate, quantity, { fee, tax });
    const adjusted = applyHoldingAdjustment(target, { type: "sell", quantity, price: confirmation.price });
    nextClosed = [closed, ...nextClosed];
    nextEvents.push(buildSellEvent(target, {
      quantity,
      price: confirmation.price,
      date: eventDate,
      source: "manual",
      relatedEventId: closed.id,
    }));
    let costCarrier = adjusted ?? target;
    for (const [costType, costAmount] of [["fee", fee], ["tax", tax]] as const) {
      if (!(costAmount > 0)) continue;
      costCarrier = applyHoldingCorporateAction(costCarrier, {
        id: `fund-order:${order.id}:${costType}`,
        type: costType,
        date: eventDate,
        amount: costAmount,
        source: "manual",
        note: "fund redemption transaction cost",
      });
      const action = costCarrier.corporateActions?.find((item) => item.id === `fund-order:${order.id}:${costType}`);
      const costEvent = action ? buildPortfolioEventFromCorporateAction(costCarrier, action, "manual") : null;
      if (costEvent) nextEvents.push({ ...costEvent, relatedEventId: closed.id });
    }
    if (adjusted) {
      nextHoldings[holdingIndex] = costCarrier;
    } else {
      const hasPendingPurchase = nextOrders.some((candidate) => (
        candidate.id !== order.id &&
        candidate.holdingId === order.holdingId &&
        candidate.side === "buy" &&
        candidate.status === "pending"
      ));
      if (hasPendingPurchase) {
        // A full redemption and a later purchase are independent accepted
        // orders at the fund account. Keep an empty carrier so the purchase can
        // still confirm instead of becoming an orphan when the old units close.
        nextHoldings[holdingIndex] = recomputeHoldingMetrics(target, {
          quantity: 0,
          costPrice: 0,
          cashDividendTotal: 0,
          corporateActions: [],
        }, true);
      } else {
        nextHoldings.splice(holdingIndex, 1);
      }
    }
    nextOrders[orderIndex] = {
      ...order,
      status: "confirmed",
      confirmedDate: confirmation.confirmedDate,
      navDate: confirmation.navDate,
      confirmedPrice: confirmation.price,
      confirmedQuantity: quantity,
      confirmedAmount: Math.max(0, grossAmount - fee - tax),
      fee,
      tax,
      reason: undefined,
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  const remainingHoldingIds = new Set(nextHoldings.map((holding) => holding.id));
  nextOrders = nextOrders.map((order) => {
    if (order.status !== "pending" || remainingHoldingIds.has(order.holdingId)) return order;
    changed = true;
    return {
      ...order,
      status: "rejected" as const,
      reason: "关联持仓不存在",
      updatedAt: new Date().toISOString(),
    };
  });

  return {
    holdings: nextHoldings,
    closedHoldings: nextClosed,
    orders: nextOrders,
    portfolioEvents: changed ? dedupePortfolioEvents(nextEvents) : events,
    changed,
  };
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
  const settled = await Promise.allSettled(
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
  const entries = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  return {
    actions: new Map(entries),
    failedCount: settled.filter((result) => result.status === "rejected").length,
  };
}

function actionAlreadyApplied(holding: Holding, actionId: string) {
  return (holding.corporateActions ?? []).some((action) => action.id === actionId);
}

function canAutoReinvestDividend(holding: Holding) {
  return holding.market === "FUND" && holding.assetType === "fund";
}

export function resolveFundDividendReinvestPrice(holding: Holding, action: CorporateActionEvent) {
  const sourcePrice = Number(action.reinvestPrice);
  if (sourcePrice > 0) return sourcePrice;
  const reinvestDate = action.exDate || action.date;
  return holding.fundNavHistory?.find((row) => row.date === reinvestDate)?.nav ?? 0;
}

export function applyAutomaticCorporateActions(
  holdings: Holding[],
  actionMap: Map<string, Awaited<ReturnType<typeof fetchCorporateActions>>>,
  dividendReinvest: boolean,
  today = todayLocalYMD(),
) {
  let changed = false;
  const portfolioEvents: PortfolioEvent[] = [];
  const nextHoldings = holdings.map((holding) => {
    const since = holding.autoCorporateActionSince || ymdFromIsoLike(holding.updatedAt) || today;
    const actions = actionMap.get(holding.id) ?? [];
    let next: Holding = holding.autoCorporateActionSince ? holding : { ...holding, autoCorporateActionSince: since };
    if (!holding.autoCorporateActionSince) changed = true;

    for (const action of actions) {
      const eligibilityDate = action.exDate || action.recordDate || action.date;
      const postingDate = action.type === "cash_dividend" ? (action.payDate || action.date) : action.date;
      if (eligibilityDate < since || postingDate > today || actionAlreadyApplied(next, action.id)) continue;
      if (action.type === "split" && action.ratio && action.ratio > 0) {
        const input: HoldingCorporateActionInput = {
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
          note: action.source === "eastmoney-stock" ? "auto share bonus / capital transfer" : "auto",
        };
        next = applyHoldingCorporateAction(next, input);
        const latestAction = next.corporateActions?.at(-1);
        const event = latestAction ? buildPortfolioEventFromCorporateAction(next, latestAction, "auto") : null;
        if (event) portfolioEvents.push(event);
        changed = true;
      }
      if (action.type === "cash_dividend" && action.amount && action.amount > 0) {
        const totalAmount = action.amount * next.quantity;
        if (!(totalAmount > 0)) continue;
        const dividendTaxRate = Math.min(1, Math.max(0, next.transactionCostProfile?.dividendTaxRate ?? 0));
        const dividendTax = totalAmount * dividendTaxRate;
        const netDividend = Math.max(0, totalAmount - dividendTax);
        const shouldReinvest = canAutoReinvestDividend(next) && (next.dividendReinvest ?? dividendReinvest);
        if (shouldReinvest) {
          const reinvestPrice = resolveFundDividendReinvestPrice(next, action);
          if (!(reinvestPrice > 0) || !(netDividend > 0)) continue;
          const input: HoldingCorporateActionInput = {
            id: action.id,
            type: "dividend_reinvest",
            date: postingDate,
            amount: netDividend,
            shares: netDividend / reinvestPrice,
            price: reinvestPrice,
            recordDate: action.recordDate,
            exDate: action.exDate,
            payDate: action.payDate,
            announcementDate: action.announcementDate,
            source: action.source,
            description: action.description,
            estimatedAmount: dividendTax > 0 ? totalAmount : undefined,
            rateUsed: dividendTax > 0 ? dividendTaxRate : undefined,
            note: dividendTax > 0 ? "auto dividend reinvest, net of dividend withholding tax" : "auto dividend reinvest",
          };
          next = applyHoldingCorporateAction(next, input);
          const latestAction = next.corporateActions?.at(-1);
          const event = latestAction ? buildPortfolioEventFromCorporateAction(next, latestAction, "auto") : null;
          if (event) portfolioEvents.push(event);
        } else {
          const input: HoldingCorporateActionInput = {
            id: action.id,
            type: "cash_dividend",
            date: postingDate,
            amount: totalAmount,
            recordDate: action.recordDate,
            exDate: action.exDate,
            payDate: action.payDate,
            announcementDate: action.announcementDate,
            source: action.source,
            description: action.description,
            note: "auto",
          };
          next = applyHoldingCorporateAction(next, input);
          const latestAction = next.corporateActions?.at(-1);
          const event = latestAction ? buildPortfolioEventFromCorporateAction(next, latestAction, "auto") : null;
          if (event) portfolioEvents.push(event);
        }
        if (dividendTax > 0) {
          next = applyHoldingCorporateAction(next, {
            id: `${action.id}:withholding-tax`,
            type: "tax",
            date: postingDate,
            amount: dividendTax,
            source: action.source,
            description: action.description,
            rateUsed: dividendTaxRate,
            estimatedAmount: totalAmount,
            note: "automatic dividend withholding tax",
          });
          const taxAction = next.corporateActions?.at(-1);
          const taxEvent = taxAction ? buildPortfolioEventFromCorporateAction(next, taxAction, "auto") : null;
          if (taxEvent) portfolioEvents.push(taxEvent);
        }
        changed = true;
      }
    }
    return next;
  });

  return { holdings: nextHoldings, changed, portfolioEvents };
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
    lastRefreshError: "",
    storageError:     "",
    loadFailed:       false,
    detailTarget:    null,
    dcaPlans:        hydratePlans(initialDCAPlans),
    dcaExecutions:   [],
    fundOrders:      [],
    portfolioEvents: [],
    portfolioEventBaseline: { daily: {}, realizedCostBasis: 0 },
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
    fundOrders:      [],
    portfolioEvents: [],
    portfolioEventBaseline: { daily: {}, realizedCostBasis: 0 },
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
  const history = compactPortfolioEventHistory(state.portfolioEvents, state.portfolioEventBaseline);
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
    fundOrders: state.fundOrders,
    portfolioEvents: history.events,
    portfolioEventBaseline: history.baseline,
    assetSnapshots: prunePortfolioSnapshots(state.assetSnapshots),
  };
}

function compactPersistedStateForStorage(snapshot: PersistedState): PersistedState {
  const snapshots = prunePortfolioSnapshots(snapshot.assetSnapshots ?? []);
  const detailedStart = Math.max(0, snapshots.length - COMPACT_PORTFOLIO_SNAPSHOTS);
  const history = compactPortfolioEventHistory(
    snapshot.portfolioEvents ?? [],
    normalizePortfolioEventBaseline(snapshot.portfolioEventBaseline),
  );
  return {
    ...snapshot,
    dcaExecutions: pruneDCAExecutions(snapshot.dcaExecutions ?? []),
    fundOrders: normalizeFundOrders(snapshot.fundOrders),
    portfolioEvents: history.events,
    portfolioEventBaseline: history.baseline,
    assetSnapshots: snapshots.map((item, index) => (
      index >= detailedStart ? item : { ...item, holdingUnrealizedPnl: undefined, holdingValuationDates: undefined }
    )),
  };
}

function clearNonCriticalStorage() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CLEAR_RUNTIME_CACHES_EVENT));
  for (const key of NON_CRITICAL_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best effort only; these caches can be rebuilt.
    }
  }
}

function readSavedBacktestsForBackup() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_BACKTESTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedState(snapshot: PersistedState, options: { clearCachesOnFailure?: boolean; errorMessage?: string } = {}) {
  if (typeof window === "undefined") return { ok: true };
  const write = (candidate: PersistedState) => {
    const raw = JSON.stringify(candidate);
    window.localStorage.setItem(STORAGE_KEY, raw);
    return window.localStorage.getItem(STORAGE_KEY) === raw;
  };

  try {
    if (write(snapshot)) return { ok: true };
  } catch {
    // Retry after clearing rebuildable caches below.
  }

  if (options.clearCachesOnFailure) {
    clearNonCriticalStorage();
    try {
      if (write(snapshot)) return { ok: true };
    } catch {
      // Fall through to a compact write below.
    }
  }

  try {
    if (write(compactPersistedStateForStorage(snapshot))) return { ok: true };
  } catch {
    // Fall through to the user-facing error below.
  }

  return {
    ok: false,
    error: options.errorMessage ?? "Browser extension storage is full.",
  };
}

function readPersistedSnapshotDates() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as PersistedState;
    return new Set((saved.assetSnapshots ?? []).map((snapshot) => snapshot.date).filter(Boolean));
  } catch {
    return new Set<string>();
  }
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
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
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
    const fundOrders = syncDCAFundOrders(normalizeFundOrders(saved.fundOrders), finalHoldings, dcaPlans, dcaExecutions);
    const existingEvents = normalizePortfolioEvents(saved.portfolioEvents);
    const portfolioEventBaseline = normalizePortfolioEventBaseline(saved.portfolioEventBaseline);
    const hasArchivedEvents = Object.keys(portfolioEventBaseline.daily).length > 0;
    const portfolioEvents = hasArchivedEvents
      ? existingEvents
      : migratePortfolioEvents(finalHoldings, closedHoldings, dcaExecutions, existingEvents);
    const assetSnapshots = Array.isArray(saved.assetSnapshots)
      ? saved.assetSnapshots
          .filter((snapshot) => (
            typeof snapshot?.date === "string" &&
            snapshot.date &&
            Number.isFinite(snapshot?.totalAsset)
          ))
          .map((snapshot) => ({
            date: snapshot.date,
            totalAsset: snapshot.totalAsset,
            todayPnl: Number.isFinite(snapshot.todayPnl) ? snapshot.todayPnl : 0,
            cumulativePnl: Number.isFinite(snapshot.cumulativePnl) ? snapshot.cumulativePnl : 0,
            unrealizedPnl: Number.isFinite(snapshot.unrealizedPnl) ? snapshot.unrealizedPnl : undefined,
            realizedTradingPnl: Number.isFinite(snapshot.realizedTradingPnl) ? snapshot.realizedTradingPnl : undefined,
            dividendPnl: Number.isFinite(snapshot.dividendPnl) ? snapshot.dividendPnl : undefined,
            feePnl: Number.isFinite(snapshot.feePnl) ? snapshot.feePnl : undefined,
            totalPnl: Number.isFinite(snapshot.totalPnl) ? snapshot.totalPnl : undefined,
            migratedBaseline: snapshot.migratedBaseline === true ? true : undefined,
            estimated: snapshot.estimated === true ? true : undefined,
            estimateReason: snapshot.estimateReason === "historical_backfill" ? "historical_backfill" as const : undefined,
            fxFallback: snapshot.fxFallback === true ? true : undefined,
            holdingUnrealizedPnl: snapshot.holdingUnrealizedPnl && typeof snapshot.holdingUnrealizedPnl === "object"
              ? Object.fromEntries(Object.entries(snapshot.holdingUnrealizedPnl)
                  .filter(([id, value]) => id && Number.isFinite(value))
                  .map(([id, value]) => [id, Number(value)]))
              : undefined,
            holdingValuationDates: snapshot.holdingValuationDates && typeof snapshot.holdingValuationDates === "object"
              ? Object.fromEntries(Object.entries(snapshot.holdingValuationDates)
                  .filter(([id, value]) => id && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
                  .map(([id, value]) => [id, String(value)]))
              : undefined,
          }))
          .slice(-MAX_PORTFOLIO_SNAPSHOTS)
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
      fundOrders,
      portfolioEvents,
      portfolioEventBaseline,
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
      lastRefreshError: "",
      detailTarget: null,
      dcaPanelOpen: false,
      dcaPanelHoldingId: null,
    };
  } catch {
    // Back up the unparseable/legacy blob so the user can recover it via export,
    // and mark the session as load-failed so the persist effect skips overwriting
    // the user's real (backed-up) data with demo state.
    if (raw) {
      try { window.localStorage.setItem(STORAGE_BACKUP_KEY, raw); } catch { /* best effort */ }
    }
    return { ...base, loadFailed: true, storageError: base.language === "en"
      ? "Saved data could not be loaded (it may be corrupted). A backup was saved. Please export a backup and re-import if needed."
      : "本地数据加载失败（可能已损坏），已自动备份。请导出备份后按需重新导入。" };
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(() => loadInitialState());
  const stateRef = useRef(state);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const pendingRefreshOptionsRef = useRef<{ forceCorporateActions?: boolean; bypassCoordination?: boolean } | null>(null);
  const corporateActionRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const recomputeInProgressRef = useRef(false);
  const eventFxBackfillInProgressRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const persistedSnapshotRef = useRef<PersistedState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (eventFxBackfillInProgressRef.current || !state.portfolioEvents.some((event) => event.fxRateEstimated)) return;
    eventFxBackfillInProgressRef.current = true;
    void backfillPortfolioEventFxRates(state.portfolioEvents)
      .then((events) => {
        if (events === state.portfolioEvents) return;
        const resolvedById = new Map(events.map((event) => [event.id, event]));
        setState((latest) => ({
          ...latest,
          portfolioEvents: latest.portfolioEvents.map((event) => {
            const resolved = resolvedById.get(event.id);
            return resolved && !resolved.fxRateEstimated ? {
              ...event,
              amountInBase: resolved.amountInBase,
              capitalFlowInBase: resolved.capitalFlowInBase,
              fxRateToBase: resolved.fxRateToBase,
              fxRateEstimated: undefined,
            } : event;
          }),
        }));
      })
      .finally(() => {
        eventFxBackfillInProgressRef.current = false;
      });
  }, [state.portfolioEvents]);

  useEffect(() => {
    void refreshTradingCalendar();
  }, []);

  /* theme colors — recomputed when theme changes */
  const tc = useMemo(() => buildThemeColors(state.theme), [state.theme]);
  const stats = useMemo(
    () => computeStats(state.holdings, state.closedHoldings, state.portfolioEvents, state.portfolioEventBaseline),
    [state.holdings, state.closedHoldings, state.portfolioEvents, state.portfolioEventBaseline],
  );
  const persistedSnapshot = useMemo<PersistedState>(() => buildPersistedState(state), [state]);

  const applyDCAState = useCallback((
    holdings: Holding[],
    plans: DCAPlan[],
    executions: DCAExecution[],
    settleDue = false,
    fundOrders: FundOrder[] = [],
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
      fundOrders,
    );
    return {
      holdings: settled.holdings,
      dcaPlans: settled.plans,
      dcaExecutions: pruneDCAExecutions(settled.executions),
    };
  }, []);

  const applyCorporateActionsToLatestState = useCallback((
    corporateActionMap: Awaited<ReturnType<typeof fetchCorporateActionMap>>["actions"],
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
      const dcaLedger = appendDCAExecutionEvents(
        [...s.portfolioEvents, ...corporateState.portfolioEvents],
        dcaState.holdings,
        dcaState.dcaExecutions,
      );
      const portfolioEvents = dcaLedger.portfolioEvents;
      const eventsChanged = portfolioEvents !== s.portfolioEvents || corporateState.portfolioEvents.length > 0;
      return {
        ...s,
        holdings: dcaLedger.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        portfolioEvents,
        assetSnapshots: corporateState.changed || eventsChanged
          ? upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, now, s.portfolioEventBaseline)
          : s.assetSnapshots,
      };
    });
  }, [applyDCAState]);

  const runCorporateActionRefresh = useCallback((currentHoldings: Holding[], force = false) => {
    if (!currentHoldings.length) return Promise.resolve();
    if (corporateActionRefreshPromiseRef.current) return corporateActionRefreshPromiseRef.current;

    const task = fetchCorporateActionMap(currentHoldings, force)
      .then(({ actions, failedCount }) => {
        applyCorporateActionsToLatestState(actions);
        if (failedCount > 0) {
          setState((state) => ({
            ...state,
            lastRefreshError: state.language === "en"
              ? `${failedCount} holding action update${failedCount === 1 ? "" : "s"} failed; other holdings were updated.`
              : `${failedCount} 个持仓的公司行动同步失败，其余标的已正常更新。`,
          }));
        }
      })
      .catch(() => {
        setState((state) => ({
          ...state,
          lastRefreshError: state.language === "en"
            ? "Corporate action updates failed. Price data remains available."
            : "公司行动同步失败，行情数据仍可正常使用。",
        }));
      })
      .finally(() => {
        corporateActionRefreshPromiseRef.current = null;
      });

    corporateActionRefreshPromiseRef.current = task;
    return task;
  }, [applyCorporateActionsToLatestState]);

  // Recompute existing historical snapshots whose unrealizedPnl was captured
  // before a fund's official NAV published. Runs after each refresh when a
  // fund's latest NAV date advanced, replacing the stale snapshots with values
  // computed from the now-available official NAV history.
  const recomputeStaleSnapshots = useCallback(async (dates: string[]) => {
    const queued = [...new Set([...readStaleSnapshotRecomputeQueue(), ...dates])].sort();
    writeStaleSnapshotRecomputeQueue(queued);
    if (recomputeInProgressRef.current) return;
    if (!queued.length) return;
    recomputeInProgressRef.current = true;
    try {
      const current = stateRef.current;
      const result = await backfillPortfolioSnapshots({
        dates: queued,
        holdings: current.holdings,
        events: current.portfolioEvents,
        baseline: current.portfolioEventBaseline,
      });
      if (result.snapshots.length) {
        setState((latest) => {
          const replacements = new Map(result.snapshots.map((snapshot) => [snapshot.date, snapshot]));
          return {
            ...latest,
            assetSnapshots: prunePortfolioSnapshots([
              ...latest.assetSnapshots.filter((snapshot) => !replacements.has(snapshot.date)),
              ...result.snapshots,
            ]),
          };
        });
      }
      const completed = new Set(result.completedDates);
      writeStaleSnapshotRecomputeQueue(queued.filter((date) => !completed.has(date)));
    } finally {
      recomputeInProgressRef.current = false;
    }
  }, []);

  /* live price refresh */
  const doRefresh = useCallback(async (currentHoldings: Holding[], options: { forceCorporateActions?: boolean; bypassCoordination?: boolean } = {}) => {
    const coordinated = !options.forceCorporateActions && !options.bypassCoordination;
    if (coordinated && shouldSkipCoordinatedRefresh()) return;
    if (coordinated) writeRefreshMeta({ ...readRefreshMeta(), startedAt: Date.now() });
    setState((s) => ({ ...s, isRefreshing: true, lastRefreshError: "" }));
    try {
      const priceMap = await refreshPrices(
        currentHoldings.map((h) => ({ id: h.id, symbol: h.symbol, market: h.market }))
      );
      // Detect fund holdings whose official NAV just advanced; their previous
      // snapshots may carry a stale unrealizedPnl based on the older NAV and
      // need to be recomputed with the now-published official value.
      const existingDates = stateRef.current.assetSnapshots.map((snapshot) => snapshot.date);
      const afterHoldings = currentHoldings.map((h) => {
        const lp = priceMap[h.id]?.price;
        return lp ? { ...h, fundNavHistory: lp.fundNavHistory ?? h.fundNavHistory } : h;
      });
      const staleDates = collectStaleSnapshotDates(
        currentHoldings,
        afterHoldings,
        existingDates,
        todayLocalYMD(),
      );
      setState((s) => {
        const now = new Date();
        const updated = s.holdings.map((h) => {
          const liveUpdate = priceMap[h.id];
          if (!liveUpdate) return h;
          const lp = liveUpdate.price;
          const automaticTradeStatus = mergeAutomaticTradeStatus(h, liveUpdate);
          if (!lp) {
            return {
              ...h,
            ...automaticTradeStatus,
            fundBuyConfirmDays: refreshedFundRule(liveUpdate.fundBuyConfirmDays, h.fundBuyConfirmDays),
            fundSellConfirmDays: refreshedFundRule(liveUpdate.fundSellConfirmDays, h.fundSellConfirmDays),
            fundPurchaseStatus: liveUpdate.fundPurchaseStatus ?? h.fundPurchaseStatus,
            fundDcaStatus: liveUpdate.fundDcaStatus ?? h.fundDcaStatus,
            fundRedemptionStatus: liveUpdate.fundRedemptionStatus ?? h.fundRedemptionStatus,
            fundPurchaseStatusNote: liveUpdate.fundPurchaseStatusNote ?? h.fundPurchaseStatusNote,
            fundDcaStatusNote: liveUpdate.fundDcaStatusNote ?? h.fundDcaStatusNote,
            fundRedemptionStatusNote: liveUpdate.fundRedemptionStatusNote ?? h.fundRedemptionStatusNote,
            fundMinPurchaseAmount: refreshedFundRule(liveUpdate.fundMinPurchaseAmount, h.fundMinPurchaseAmount),
            fundMinDcaAmount: refreshedFundRule(liveUpdate.fundMinDcaAmount, h.fundMinDcaAmount),
            fundMinRedemptionQuantity: refreshedFundRule(liveUpdate.fundMinRedemptionQuantity, h.fundMinRedemptionQuantity),
            fundMinRemainingQuantity: refreshedFundRule(liveUpdate.fundMinRemainingQuantity, h.fundMinRemainingQuantity),
            fundBuyCutoffMinutes: refreshedFundRule(liveUpdate.fundBuyCutoffMinutes, h.fundBuyCutoffMinutes),
            fundSellCutoffMinutes: refreshedFundRule(liveUpdate.fundSellCutoffMinutes, h.fundSellCutoffMinutes),
            fundDcaCutoffMinutes: refreshedFundRule(liveUpdate.fundDcaCutoffMinutes, h.fundDcaCutoffMinutes),
            fundBuyCancellationAllowed: refreshedFundRule(liveUpdate.fundBuyCancellationAllowed, h.fundBuyCancellationAllowed),
            fundSellCancellationAllowed: refreshedFundRule(liveUpdate.fundSellCancellationAllowed, h.fundSellCancellationAllowed),
            fundDcaCancellationAllowed: refreshedFundRule(liveUpdate.fundDcaCancellationAllowed, h.fundDcaCancellationAllowed),
            fundCancellationRuleSource: refreshedFundRule(liveUpdate.fundCancellationRuleSource, h.fundCancellationRuleSource),
            fundTradeRulesUpdatedAt: liveUpdate.fundTradeRulesUpdatedAt ?? h.fundTradeRulesUpdatedAt,
            priceDate: h.priceDate ?? "",
            fundNavHistory: h.fundNavHistory,
          };
          }
          const marketValue = h.quantity * lp.price;
          const costBasis   = h.quantity * h.costPrice;
          // Holding-level P/L is unrealized price P/L only. Cash dividends,
          // realized trades and costs are aggregated by the portfolio ledger.
          const totalPnl    = marketValue - costBasis;
          const todayPnl    = Number.isFinite(lp.change) ? h.quantity * lp.change : 0;
          const fundEstimate = h.market === "FUND" || h.assetType === "fund"
            ? resolveFundEstimateUpdate(h, lp, todayShanghaiYMD(now))
            : {};
          return {
            ...h,
            currentPrice: lp.price,
            marketValue,
            todayPnl,
            todayPnlRate: Number.isFinite(lp.changePercent) ? lp.changePercent : 0,
            totalPnl,
            totalPnlRate: costBasis > 0 ? totalPnl / costBasis : 0,
            ...automaticTradeStatus,
            fundBuyConfirmDays: refreshedFundRule(liveUpdate.fundBuyConfirmDays, h.fundBuyConfirmDays),
            fundSellConfirmDays: refreshedFundRule(liveUpdate.fundSellConfirmDays, h.fundSellConfirmDays),
            fundPurchaseStatus: liveUpdate.fundPurchaseStatus ?? h.fundPurchaseStatus,
            fundDcaStatus: liveUpdate.fundDcaStatus ?? h.fundDcaStatus,
            fundRedemptionStatus: liveUpdate.fundRedemptionStatus ?? h.fundRedemptionStatus,
            fundPurchaseStatusNote: liveUpdate.fundPurchaseStatusNote ?? h.fundPurchaseStatusNote,
            fundDcaStatusNote: liveUpdate.fundDcaStatusNote ?? h.fundDcaStatusNote,
            fundRedemptionStatusNote: liveUpdate.fundRedemptionStatusNote ?? h.fundRedemptionStatusNote,
            fundMinPurchaseAmount: refreshedFundRule(liveUpdate.fundMinPurchaseAmount, h.fundMinPurchaseAmount),
            fundMinDcaAmount: refreshedFundRule(liveUpdate.fundMinDcaAmount, h.fundMinDcaAmount),
            fundMinRedemptionQuantity: refreshedFundRule(liveUpdate.fundMinRedemptionQuantity, h.fundMinRedemptionQuantity),
            fundMinRemainingQuantity: refreshedFundRule(liveUpdate.fundMinRemainingQuantity, h.fundMinRemainingQuantity),
            fundBuyCutoffMinutes: refreshedFundRule(liveUpdate.fundBuyCutoffMinutes, h.fundBuyCutoffMinutes),
            fundSellCutoffMinutes: refreshedFundRule(liveUpdate.fundSellCutoffMinutes, h.fundSellCutoffMinutes),
            fundDcaCutoffMinutes: refreshedFundRule(liveUpdate.fundDcaCutoffMinutes, h.fundDcaCutoffMinutes),
            fundBuyCancellationAllowed: refreshedFundRule(liveUpdate.fundBuyCancellationAllowed, h.fundBuyCancellationAllowed),
            fundSellCancellationAllowed: refreshedFundRule(liveUpdate.fundSellCancellationAllowed, h.fundSellCancellationAllowed),
            fundDcaCancellationAllowed: refreshedFundRule(liveUpdate.fundDcaCancellationAllowed, h.fundDcaCancellationAllowed),
            fundCancellationRuleSource: refreshedFundRule(liveUpdate.fundCancellationRuleSource, h.fundCancellationRuleSource),
            fundTradeRulesUpdatedAt: liveUpdate.fundTradeRulesUpdatedAt ?? h.fundTradeRulesUpdatedAt,
            priceDate: lp.priceDate ?? h.priceDate ?? "",
            fundNavHistory: lp.fundNavHistory ?? h.fundNavHistory,
            ...fundEstimate,
            cashDividendTotal: h.cashDividendTotal ?? 0,
            dividendReinvest: h.dividendReinvest ?? null,
            autoCorporateActionSince: h.autoCorporateActionSince ?? "",
            corporateActions: h.corporateActions ?? [],
            updatedAt:    new Date().toISOString(),
          };
        });
        const t   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
        writeRefreshMeta({ startedAt: 0, finishedAt: now.getTime() });
        const dcaState = applyDCAState(updated, s.dcaPlans, s.dcaExecutions, true, s.fundOrders);
        const dcaLedger = appendDCAExecutionEvents(s.portfolioEvents, dcaState.holdings, dcaState.dcaExecutions);
        const syncedOrders = syncDCAFundOrders(s.fundOrders, dcaLedger.holdings, dcaState.dcaPlans, dcaState.dcaExecutions);
        const manualSettlement = settleManualFundOrders(
          dcaLedger.holdings,
          s.closedHoldings,
          syncedOrders,
          dcaLedger.portfolioEvents,
          todayShanghaiYMD(now),
        );
        const portfolioEvents = manualSettlement.portfolioEvents;
        const remainingHoldingIds = new Set(manualSettlement.holdings.map((holding) => holding.id));
        return {
          ...s,
          holdings: manualSettlement.holdings,
          closedHoldings: manualSettlement.closedHoldings,
          dcaPlans: dcaState.dcaPlans.map((plan) => remainingHoldingIds.has(plan.holdingId) ? plan : { ...plan, enabled: false, archived: true }),
          dcaExecutions: dcaState.dcaExecutions,
          fundOrders: manualSettlement.orders,
          portfolioEvents,
          assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, manualSettlement.holdings, portfolioEvents, now, s.portfolioEventBaseline),
          isRefreshing: false,
          lastRefreshed: t,
          lastRefreshAt: now.getTime(),
          lastRefreshError: "",
        };
      });
      // Also retries dates persisted after an earlier provider/storage failure.
      void recomputeStaleSnapshots(staleDates);
      void runCorporateActionRefresh(currentHoldings, options.forceCorporateActions);
    } catch (error) {
      if (coordinated) writeRefreshMeta({ ...readRefreshMeta(), startedAt: 0 });
      const message = error instanceof Error && error.message
        ? error.message
        : "行情刷新失败";
      setState((s) => ({ ...s, isRefreshing: false, lastRefreshError: message }));
    }
  }, [applyDCAState, recomputeStaleSnapshots, runCorporateActionRefresh]);

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

  const runSnapshotBackfill = useCallback(async (queuedDates: string[]) => {
    const current = stateRef.current;
    const today = todayLocalYMD();
    const existingDates = current.assetSnapshots.map((snapshot) => snapshot.date);
    const dates = collectMissingSnapshotDates(existingDates, queuedDates, today, MAX_PORTFOLIO_SNAPSHOTS);
    const alreadySatisfied = queuedDates.filter((date) => existingDates.includes(date));
    if (!dates.length) {
      if (alreadySatisfied.length) await acknowledgeSnapshotDueDates(alreadySatisfied);
      return { completedDates: [] as string[], failedDates: [] as string[] };
    }

    const result = await backfillPortfolioSnapshots({
      dates,
      holdings: current.holdings,
      events: current.portfolioEvents,
      baseline: current.portfolioEventBaseline,
    });
    if (result.snapshots.length) {
      setState((latest) => {
        const replacements = new Map(result.snapshots.map((snapshot) => [snapshot.date, snapshot]));
        return {
          ...latest,
          assetSnapshots: prunePortfolioSnapshots([
            ...latest.assetSnapshots.filter((snapshot) => !replacements.has(snapshot.date)),
            ...result.snapshots,
          ]),
        };
      });
      // The background queue is acknowledged only after the normal persisted
      // state effect has durably written the generated snapshots. If the popup
      // closes before this completes, the dates remain queued for the next run.
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    const persistedDates = readPersistedSnapshotDates();
    const acknowledged = [...new Set([
      ...alreadySatisfied,
      ...result.completedDates.filter((date) => queuedDates.includes(date) && persistedDates.has(date)),
    ])];
    if (acknowledged.length) await acknowledgeSnapshotDueDates(acknowledged);
    return result;
  }, []);

  useEffect(() => {
    // Bypass the cross-view refresh coordination on initial mount: when the
    // user switches from popup to side panel (or vice versa) within the
    // 45s TTL, the coordinated skip would otherwise prevent the new view
    // from fetching data at all, leaving it showing stale values with no
    // "refreshing" indication. Each view should always refresh at least once
    // on open.
    void getSnapshotDueDates().then(async (response) => {
      const queuedDates = response.dates ?? [];
      let failedBackfillCount = 0;
      try {
        const result = await runSnapshotBackfill(queuedDates);
        failedBackfillCount = result.failedDates.length;
      } catch {
        // Missing dates stay unacknowledged and will be retried next time.
        failedBackfillCount = 1;
      } finally {
        await runRefresh(stateRef.current.holdings, {
          forceCorporateActions: Boolean(queuedDates.length),
          bypassCoordination: true,
        });
        if (queuedDates.length) {
          await new Promise((resolve) => window.setTimeout(resolve, 350));
          const persistedDates = readPersistedSnapshotDates();
          const satisfied = queuedDates.filter((date) => persistedDates.has(date));
          if (satisfied.length) await acknowledgeSnapshotDueDates(satisfied);
        }
        if (failedBackfillCount > 0) {
          setState((latest) => ({
            ...latest,
            lastRefreshError: latest.language === "en"
              ? `${failedBackfillCount} historical snapshot${failedBackfillCount === 1 ? "" : "s"} could not be backfilled and will retry next time.`
              : `${failedBackfillCount} 天历史收益快照暂未补算成功，下次打开将自动重试。`,
          }));
        }
      }
    });
  }, [runRefresh, runSnapshotBackfill]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // If the initial load failed, the in-memory state is demo data. Skip
    // persisting so we don't overwrite the user's backed-up real data.
    if (state.loadFailed) return;
    persistedSnapshotRef.current = persistedSnapshot;
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      const saved = savePersistedState(persistedSnapshot, { clearCachesOnFailure: true });
      const storageError = saved.ok
        ? ""
        : stateRef.current.language === "en"
          ? "Changes could not be saved because extension storage is full. Clear local data or export a backup before continuing."
          : "数据未能保存：浏览器扩展存储空间不足。请先导出备份或清理本地数据后再继续。";
      setState((current) => current.storageError === storageError ? current : { ...current, storageError });
      persistTimerRef.current = null;
    }, 250);
  }, [persistedSnapshot, state.loadFailed]);

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
        lastRefreshError: current.lastRefreshError,
        storageError: current.storageError,
        detailTarget: current.detailTarget,
        dcaPanelOpen: current.dcaPanelOpen,
        dcaPanelHoldingId: current.dcaPanelHoldingId,
      }));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    // The service worker owns toolbar click behavior. A newly opened side panel
    // must never push its potentially stale local preference back to Chrome,
    // otherwise it can immediately restore the popup that was just disabled.
    void getConfiguredExtensionOpenMode().then((response) => {
      if (!response.ok || !response.mode) return;
      const mode = normalizeOpenMode(response.mode);
      setState((current) => current.defaultOpenMode === mode
        ? current
        : { ...current, defaultOpenMode: mode });
    });
  }, []);

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
    version: STORAGE_VERSION,
    data: {
      groups: state.groups,
      holdings: state.holdings,
      closedHoldings: state.closedHoldings,
      dcaPlans: state.dcaPlans,
      dcaExecutions: state.dcaExecutions,
      fundOrders: state.fundOrders,
      portfolioEvents: state.portfolioEvents,
      portfolioEventBaseline: state.portfolioEventBaseline,
      assetSnapshots: state.assetSnapshots,
      savedBacktests: readSavedBacktestsForBackup(),
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
      // Back up current data before attempting import, so users can recover if import fails.
      if (typeof window !== "undefined") {
        try {
          const currentRaw = window.localStorage.getItem(STORAGE_KEY);
          if (currentRaw) window.localStorage.setItem(STORAGE_BACKUP_KEY, currentRaw);
        } catch { /* best effort */ }
      }
      const parsed = JSON.parse(raw);
      const data = parsed?.data ?? parsed;
      if (!Array.isArray(data?.holdings)) {
        return { ok: false, error: importPortfolioError(stateRef.current.language, "missingHoldings") };
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
      const fundOrders = syncDCAFundOrders(normalizeFundOrders(Array.isArray(data.fundOrders) ? data.fundOrders : []), dcaState.holdings, dcaState.dcaPlans, dcaState.dcaExecutions);
      const portfolioEventBaseline = normalizePortfolioEventBaseline(data.portfolioEventBaseline);
      const importedEvents = normalizePortfolioEvents(data.portfolioEvents);
      const portfolioEvents = Object.keys(portfolioEventBaseline.daily).length > 0
        ? importedEvents
        : migratePortfolioEvents(dcaState.holdings, closedHoldings, dcaState.dcaExecutions, importedEvents);
      const nextState: AppState = {
        ...current,
        loadFailed: false,
        storageError: "",
        groups: Array.isArray(data.groups) ? data.groups : current.groups,
        holdings: dcaState.holdings,
        closedHoldings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        fundOrders,
        portfolioEvents,
        portfolioEventBaseline,
        // upsertPortfolioSnapshot(snapshots, holdings, date) keeps all
        // historical snapshots from the first arg and replaces only today's
        // entry with a freshly computed one from `holdings`. Passing the
        // imported snapshot array here preserves the 180-day trend history;
        // the .slice(-180) inside the function caps the total length.
        assetSnapshots: Array.isArray(data.assetSnapshots)
          ? upsertPortfolioSnapshot(data.assetSnapshots, dcaState.holdings, portfolioEvents, new Date(), portfolioEventBaseline)
          : upsertPortfolioSnapshot(current.assetSnapshots, dcaState.holdings, portfolioEvents, new Date(), portfolioEventBaseline),
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
      if (Array.isArray(data.savedBacktests) && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(SAVED_BACKTESTS_KEY, JSON.stringify(data.savedBacktests.slice(0, 8)));
        } catch {
          nextState.storageError = nextState.language === "en"
            ? "Portfolio data was restored, but saved backtest comparisons could not be stored."
            : "持仓数据已恢复，但保存的回测对比方案未能写入存储。";
        }
      }
      pruneCorporateActionCheckedAt(dcaState.holdings);
      setState(nextState);
      void runRefresh(dcaState.holdings, { forceCorporateActions: true, bypassCoordination: true });
      return { ok: true };
    } catch {
      return { ok: false, error: importPortfolioError(stateRef.current.language, "invalidJson") };
    }
  }, [applyDCAState, runRefresh]);

  const clearLocalData = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
      // Clear portfolio/runtime caches (chart, market page, FX rates,
      // corporate actions, trading calendar, fund history …) while keeping
      // research provider/search connections for the default reset path.
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (
            key &&
            key.startsWith("asset-helper:") &&
            key !== STORAGE_KEY &&
            key !== STORAGE_BACKUP_KEY &&
            key !== SAVED_BACKTESTS_KEY &&
            !key.startsWith("asset-helper:research-")
          ) {
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
      closedHoldings: s.closedHoldings.map((h) => h.groupId === id ? { ...h, groupId: "" } : h),
      portfolioEvents: s.portfolioEvents.map((event) => event.groupId === id ? { ...event, groupId: "" } : event),
    }));
  }, []);

  /* holdings */
  const addHolding = useCallback((input: HoldingInput) => {
    let h = buildHolding(input, `holding_${safeUUID()}`);
    const event = buildBuyEvent(h, {
      quantity: h.quantity,
      price: h.costPrice,
      source: "manual",
    });
    const tradeAmount = h.quantity * h.costPrice;
    const { fee, tax } = estimateTransactionCosts(h.transactionCostProfile, "buy", tradeAmount);
    const costEvents: PortfolioEvent[] = [];
    const date = ymdFromEventValue(event.date);
    for (const [costType, costAmount] of [["fee", fee], ["tax", tax]] as const) {
      if (!(costAmount > 0)) continue;
      h = applyHoldingCorporateAction(h, {
        id: `manual:initial-cost:${h.id}:${costType}`,
        type: costType,
        date,
        amount: costAmount,
        source: "manual",
        note: "initial buy transaction cost",
      });
      const action = h.corporateActions?.at(-1);
      const costEvent = action ? buildPortfolioEventFromCorporateAction(h, action, "manual") : null;
      if (costEvent) costEvents.push(costEvent);
    }
    setState((s) => {
      const updated = [h, ...s.holdings];
      const dcaState = applyDCAState(updated, s.dcaPlans, s.dcaExecutions);
      const dcaLedger = appendDCAExecutionEvents([...s.portfolioEvents, event, ...costEvents], dcaState.holdings, dcaState.dcaExecutions);
      const portfolioEvents = dcaLedger.portfolioEvents;
      return {
        ...s,
        holdings: dcaLedger.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
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
          autoTradeStatusUpdatedAt: previous.autoTradeStatusUpdatedAt,
          autoTradeStatusStale: previous.autoTradeStatusStale,
          autoTradeStatusRefreshNote: previous.autoTradeStatusRefreshNote,
          fundBuyConfirmDays: previous.fundBuyConfirmDays,
          fundSellConfirmDays: previous.fundSellConfirmDays,
          fundPurchaseStatus: previous.fundPurchaseStatus,
          fundDcaStatus: previous.fundDcaStatus,
          fundRedemptionStatus: previous.fundRedemptionStatus,
          fundPurchaseStatusNote: previous.fundPurchaseStatusNote,
          fundDcaStatusNote: previous.fundDcaStatusNote,
          fundRedemptionStatusNote: previous.fundRedemptionStatusNote,
          fundMinPurchaseAmount: previous.fundMinPurchaseAmount,
          fundMinDcaAmount: previous.fundMinDcaAmount,
          fundMinRedemptionQuantity: previous.fundMinRedemptionQuantity,
          fundMinRemainingQuantity: previous.fundMinRemainingQuantity,
          fundBuyCutoffMinutes: previous.fundBuyCutoffMinutes,
          fundSellCutoffMinutes: previous.fundSellCutoffMinutes,
          fundDcaCutoffMinutes: previous.fundDcaCutoffMinutes,
          fundBuyCancellationAllowed: previous.fundBuyCancellationAllowed,
          fundSellCancellationAllowed: previous.fundSellCancellationAllowed,
          fundDcaCancellationAllowed: previous.fundDcaCancellationAllowed,
          fundCancellationRuleSource: previous.fundCancellationRuleSource,
          fundTradeRulesUpdatedAt: previous.fundTradeRulesUpdatedAt,
          priceDate: previous.priceDate ?? "",
          fundNavHistory: previous.fundNavHistory,
          estimatedNav: previous.estimatedNav,
          estimatedChangePercent: previous.estimatedChangePercent,
          cashDividendTotal: previous.cashDividendTotal ?? 0,
          dividendReinvest: rebuilt.dividendReinvest ?? null,
          corporateActions: previous.corporateActions ?? [],
        }
        : rebuilt;
      // Financial identity and position fields are ledger-owned once a holding
      // exists. Buy/sell/corporate-action flows are the only supported way to
      // change them; otherwise the delta would be misclassified as market P/L.
      const ledgerSafeHolding: Holding = previous ? preserveHoldingLedgerFields(previous, h) : h;
      const updatedHoldings = s.holdings.map((x) => (x.id === id ? ledgerSafeHolding : x));
      const updatedPlans = s.dcaPlans.map((plan) => (plan.holdingId === id ? syncPlanWithHolding(plan, ledgerSafeHolding) : plan));
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, s.dcaExecutions);
      const dcaLedger = appendDCAExecutionEvents(s.portfolioEvents, dcaState.holdings, dcaState.dcaExecutions);
      const portfolioEvents = dcaLedger.portfolioEvents;
      return {
        ...s,
        holdings: dcaLedger.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
      };
    });
  }, [applyDCAState]);
  const adjustHolding = useCallback((id: string, input: HoldingAdjustmentInput) => {
    setState((s) => {
      const target = s.holdings.find((item) => item.id === id);
      if (!target) return s;
      const numericQuantity = Number(input.quantity);
      const numericPrice = Number(input.price);
      const numericFee = Number.isFinite(Number(input.fee)) ? Math.max(0, Number(input.fee)) : 0;
      const numericTax = Number.isFinite(Number(input.tax)) ? Math.max(0, Number(input.tax)) : 0;
      const transactionDate = ymdFromIsoLike(input.date) || todayLocalYMD();
      const isBuy = input.type === "buy"
        && Number.isFinite(numericQuantity) && numericQuantity > 0
        && Number.isFinite(numericPrice) && numericPrice > 0;
      const isSell = input.type === "sell"
        && Number.isFinite(numericQuantity) && numericQuantity > 0
        && Number.isFinite(numericPrice) && numericPrice > 0
        && target.quantity > 0;
      const willClose = isSell && numericQuantity >= target.quantity;
      // Record every sell (partial or full) as a closed-holding entry so the
      // realized P/L shows up in the closed history. For partial sells the
      // entry carries only the sold quantity; the remaining position stays.
      const closedHolding = isSell
        ? buildClosedHolding(target, numericPrice, transactionDate, willClose ? target.quantity : numericQuantity, {
          fee: numericFee,
          tax: numericTax,
        })
        : null;
      let adjusted = applyHoldingAdjustment(target, input);
      if (adjusted && input.rememberCostProfile && input.costProfilePatch) {
        adjusted = {
          ...adjusted,
          transactionCostProfile: mergeTransactionCostProfile(target.transactionCostProfile, input.costProfilePatch),
        };
      }
      const costEvents: PortfolioEvent[] = [];
      if (isBuy || isSell) {
        for (const [type, amount] of [["fee", numericFee], ["tax", numericTax]] as const) {
          if (!(amount > 0)) continue;
          const costHolding = applyHoldingCorporateAction(adjusted ?? target, {
            type,
            date: transactionDate,
            amount,
            source: "manual",
            note: `${input.type} transaction cost`,
            rateUsed: type === "fee" ? input.feeRateUsed : input.taxRateUsed,
            minimumFeeUsed: type === "fee" ? input.minimumFeeUsed : undefined,
            estimatedAmount: type === "fee" ? input.estimatedFee : input.estimatedTax,
          });
          const latestAction = costHolding.corporateActions?.at(-1);
          const costEvent = latestAction ? buildPortfolioEventFromCorporateAction(costHolding, latestAction, "manual") : null;
          if (costEvent) costEvents.push({
            ...costEvent,
            relatedEventId: isSell ? closedHolding?.id : costEvent.relatedEventId,
          });
          if (adjusted) adjusted = costHolding;
        }
      }
      const hasPendingPurchase = willClose && s.fundOrders.some((order) => (
        order.holdingId === id && order.side === "buy" && order.status === "pending"
      ));
      if (!adjusted && hasPendingPurchase) {
        // Bookkeeping a completed full redemption must not cancel an already
        // submitted purchase. Retain only the security/rule identity until the
        // pending purchase posts; historical dividends and actions stay in the
        // closed position and portfolio ledger.
        adjusted = recomputeHoldingMetrics(target, {
          quantity: 0,
          costPrice: 0,
          cashDividendTotal: 0,
          corporateActions: [],
        }, true);
      }
      const updatedHoldings = adjusted
        ? s.holdings.map((item) => item.id === id ? adjusted : item)
        : s.holdings.filter((item) => item.id !== id);
      const updatedPlans = adjusted
        ? s.dcaPlans.map((plan) => (plan.holdingId === id ? syncPlanWithHolding(plan, adjusted) : plan))
        : s.dcaPlans.map((plan) => plan.holdingId === id ? { ...plan, enabled: false, archived: true } : plan);
      const updatedExecutions = s.dcaExecutions;
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, updatedExecutions);
      // Full close: closedHolding is set and adjusted is null → prepend.
      // Partial close: closedHolding is set and adjusted is non-null → still prepend.
      const nextClosedHoldings = closedHolding ? [closedHolding, ...s.closedHoldings] : s.closedHoldings;
      const event = isBuy
        ? buildBuyEvent(target, { quantity: numericQuantity, price: numericPrice, date: transactionDate, source: "manual" })
        : isSell
          ? buildSellEvent(target, {
            quantity: willClose ? target.quantity : numericQuantity,
            price: numericPrice,
            date: transactionDate,
            source: "manual",
            relatedEventId: closedHolding?.id,
          })
          : null;
      const transactionEvents = event ? [event, ...costEvents] : [];
      const dcaLedger = appendDCAExecutionEvents(
        transactionEvents.length > 0 ? [...s.portfolioEvents, ...transactionEvents] : s.portfolioEvents,
        dcaState.holdings,
        dcaState.dcaExecutions,
      );
      const portfolioEvents = dcaLedger.portfolioEvents;
      return {
        ...s,
        holdings: dcaLedger.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        fundOrders: isSell ? s.fundOrders.map((order) => (
          order.holdingId === id && order.status === "pending" && order.side === "sell"
            ? { ...order, status: "rejected" as const, reason: willClose ? "持仓已补录清仓，原赎回订单需重新核对" : "持仓已补录卖出，原赎回订单需重新核对", updatedAt: new Date().toISOString() }
            : order
        )) : s.fundOrders,
        closedHoldings: nextClosedHoldings,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
      };
    });
  }, [applyDCAState]);
  const submitFundOrder = useCallback((id: string, input: HoldingAdjustmentInput) => {
    const current = stateRef.current;
    const holding = current.holdings.find((item) => item.id === id);
    if (!holding || holding.market !== "FUND" || holding.assetType !== "fund") {
      return { ok: false, error: current.language === "en" ? "Only open-end funds support submitted orders" : "仅场外基金支持提交申购/赎回" };
    }
    const quantity = Number(input.quantity);
    const price = Number(input.price);
    if (!(quantity > 0) || !(price > 0)) {
      return { ok: false, error: current.language === "en" ? "Enter a valid amount or quantity" : "请输入有效金额或份额" };
    }
    const now = new Date();
    const requestedAt = now.toISOString();
    const requestedDate = todayShanghaiYMD(now);
    const side = input.type;
    const orderCostProfile = mergeTransactionCostProfile(holding.transactionCostProfile, input.costProfilePatch);
    const rule = fundOrderRuleForHolding(holding, side, requestedAt, orderCostProfile);
    const effectiveDate = computeFundEffectiveDate(now, rule.cutoffMinutes);
    if (resolveHoldingTradeStatus(holding).stale) {
      return { ok: false, error: current.language === "en" ? "Trading status is stale; refresh the rules before submitting" : "交易状态已过期，请刷新成功后再提交" };
    }
    if (side === "buy" && (rule.tradeStatus === "buy_disabled" || rule.tradeStatus === "suspended")) {
      return { ok: false, error: rule.tradeStatusNote || (current.language === "en" ? "Fund is not currently buyable" : "基金当前不可申购") };
    }
    if (side === "buy" && rule.tradeStatus === "unknown") {
      return { ok: false, error: current.language === "en" ? "Purchase status is unavailable; refresh the fund rules before submitting" : "未取得可靠的申购状态，请刷新基金交易规则后再提交" };
    }
    if (side === "buy" && rule.tradeStatus === "fund_limit" && rule.purchaseLimit == null) {
      return {
        ok: false,
        error: current.language === "en"
          ? "The fund is purchase-limited but its current quota is unavailable; refresh the rules before submitting"
          : "基金处于限购状态但未获取到有效额度，请刷新交易规则后再提交",
      };
    }
    if (side === "sell" && rule.tradeStatus === "sell_disabled") {
      return { ok: false, error: rule.tradeStatusNote || (current.language === "en" ? "Fund redemption is currently suspended" : "基金当前暂停赎回") };
    }
    if (side === "sell" && rule.tradeStatus === "unknown") {
      return { ok: false, error: current.language === "en" ? "Redemption status is unavailable; refresh the fund rules before submitting" : "未取得可靠的赎回状态，请刷新基金交易规则后再提交" };
    }
    const requestedAmount = side === "buy" ? quantity * price : undefined;
    const buyMinimumViolation = side === "buy"
      ? fundOrderMinimumViolation(side, rule, { requestedAmount })
      : null;
    if (buyMinimumViolation?.type === "purchase_minimum") {
      return {
        ok: false,
        error: current.language === "en"
          ? `Minimum additional purchase is ${buyMinimumViolation.minimum} ${holding.currency}`
          : `追加申购起点为 ${buyMinimumViolation.minimum} ${holding.currency}`,
      };
    }
    if (side === "buy" && rule.purchaseLimit != null) {
      const reserved = fundOrderReservedBuyAmount(current.fundOrders, holding, effectiveDate);
      if ((requestedAmount ?? 0) + reserved > rule.purchaseLimit + 1e-8) {
        const remaining = Math.max(0, rule.purchaseLimit - reserved);
        return {
          ok: false,
          error: current.language === "en"
            ? `Daily purchase limit exceeded; remaining ${remaining.toFixed(2)} ${holding.currency}`
            : `超出单日累计限购，剩余额度 ${remaining.toFixed(2)} ${holding.currency}`,
        };
      }
    }
    if (side === "sell") {
      const available = Math.max(0, holding.quantity - pendingSellQuantity(current.fundOrders, holding.id));
      if (quantity > available + 1e-8) {
        return { ok: false, error: current.language === "en" ? `Only ${available} units are available` : `可赎回份额仅剩 ${available}` };
      }
      const minimumViolation = fundOrderMinimumViolation(side, rule, {
        requestedQuantity: quantity,
        availableQuantity: available,
      });
      if (minimumViolation?.type === "redemption_minimum") {
        return {
          ok: false,
          error: current.language === "en"
            ? `Minimum redemption is ${minimumViolation.minimum} units`
            : `单笔最小赎回份额为 ${minimumViolation.minimum} 份`,
        };
      }
      if (minimumViolation?.type === "remaining_minimum") {
        return {
          ok: false,
          error: current.language === "en"
            ? `At least ${minimumViolation.minimum} units must remain; redeem all available units instead`
            : `赎回后至少保留 ${minimumViolation.minimum} 份，否则请赎回全部可用份额`,
        };
      }
    }
    const orderId = `fund_order_${safeUUID()}`;
    const order: FundOrder = {
      id: orderId,
      holdingId: holding.id,
      symbol: holding.symbol,
      source: "manual",
      entryMode: "submitted",
      side,
      status: "pending",
      requestedAt,
      requestedDate,
      effectiveDate,
      requestedAmount,
      requestedQuantity: side === "sell" ? quantity : undefined,
      estimatedPrice: price,
      expectedConfirmDate: computeFundOrderConfirmDate(holding, effectiveDate, rule.confirmDays),
      cancelDeadline: rule.cancellationPolicy === "channel_cutoff" || rule.cancellationPolicy === "standard_cutoff"
        ? computeFundOrderCancelDeadline(effectiveDate, rule.cutoffMinutes)
        : undefined,
      rule,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };
    setState((state) => {
      let holdings = state.holdings;
      if (input.rememberCostProfile && input.costProfilePatch) {
        holdings = holdings.map((item) => item.id === id ? {
          ...item,
          transactionCostProfile: mergeTransactionCostProfile(item.transactionCostProfile, input.costProfilePatch),
        } : item);
      }
      const settlement = settleManualFundOrders(
        holdings,
        state.closedHoldings,
        [order, ...state.fundOrders],
        state.portfolioEvents,
        todayShanghaiYMD(now),
      );
      const remainingHoldingIds = new Set(settlement.holdings.map((item) => item.id));
      return {
        ...state,
        holdings: settlement.holdings,
        closedHoldings: settlement.closedHoldings,
        dcaPlans: state.dcaPlans.map((plan) => remainingHoldingIds.has(plan.holdingId) ? plan : { ...plan, enabled: false, archived: true }),
        fundOrders: settlement.orders,
        portfolioEvents: settlement.portfolioEvents,
        assetSnapshots: settlement.changed
          ? upsertPortfolioSnapshot(state.assetSnapshots, settlement.holdings, settlement.portfolioEvents, now, state.portfolioEventBaseline)
          : state.assetSnapshots,
      };
    });
    return { ok: true };
  }, []);

  const cancelFundOrder = useCallback((id: string) => {
    const current = stateRef.current;
    const now = new Date();
    const result = requestFundOrderCancellation(current.fundOrders, id, now);
    if (!result.ok) {
      const english = current.language === "en";
      const errors = {
        not_found: english ? "Order not found" : "订单不存在",
        not_pending: english ? "Only pending orders can be cancelled" : "订单已结束，不能撤销",
        not_cancellable: english ? "This order type cannot be cancelled" : "该类型订单不支持撤销",
        rule_unknown: english ? "The channel did not return a cancellation rule; cancellation is disabled to avoid a false success" : "渠道未返回撤单规则，为避免误报成功，暂不允许本地撤单",
        deadline_passed: english ? "The acceptance cutoff has passed; the order cannot be cancelled" : "已超过受理截止时间，订单不能撤销",
      } as const;
      return { ok: false, error: errors[result.error ?? "not_found"] };
    }
    setState((state) => {
      const latest = requestFundOrderCancellation(state.fundOrders, id, now);
      if (!latest.ok) return state;
      const target = state.fundOrders.find((order) => order.id === id);
      const dcaExecutions = target?.source === "dca"
        ? state.dcaExecutions.map((execution) => execution.id === id && execution.status === "pending"
          ? { ...execution, status: "cancelled" as const, reason: "用户在渠道截止时间前撤销定投触发单" }
          : execution)
        : state.dcaExecutions;
      return { ...state, fundOrders: latest.orders, dcaExecutions };
    });
    return { ok: true };
  }, []);

  const removeHolding = useCallback((id: string) => {
    setState((s) => {
      const target = s.holdings.find((h) => h.id === id);
      if (!target) return s;
      const updatedHoldings = s.holdings.filter((h) => h.id !== id);
      pruneCorporateActionCheckedAt(updatedHoldings);
      const updatedPlans = s.dcaPlans.map((plan) => plan.holdingId === id ? { ...plan, enabled: false, archived: true } : plan);
      const updatedExecutions = s.dcaExecutions;
      const dcaState = applyDCAState(updatedHoldings, updatedPlans, updatedExecutions);
      const historicalCloseIds = new Set(
        s.closedHoldings.filter((item) => item.sourceHoldingId === id).map((item) => item.id),
      );
      // Deleting an erroneous/open record must not fabricate a sale. Preserve
      // events linked to an existing partial/full close, and remove only the
      // open-position/DCA history that belongs exclusively to this record.
      const remainingEvents = s.portfolioEvents.filter((event) => (
        event.holdingId !== id || Boolean(event.relatedEventId && historicalCloseIds.has(event.relatedEventId))
      ));
      const dcaLedger = appendDCAExecutionEvents(remainingEvents, dcaState.holdings, dcaState.dcaExecutions);
      const portfolioEvents = dcaLedger.portfolioEvents;
      return {
        ...s,
        holdings: dcaLedger.holdings,
        dcaPlans: dcaState.dcaPlans,
        dcaExecutions: dcaState.dcaExecutions,
        fundOrders: s.fundOrders.map((order) => (
          order.holdingId === id && order.status === "pending"
            ? { ...order, status: "rejected" as const, reason: "关联持仓已删除", updatedAt: new Date().toISOString() }
            : order
        )),
        closedHoldings: s.closedHoldings,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
        dcaPanelHoldingId: s.dcaPanelHoldingId === id ? null : s.dcaPanelHoldingId,
      };
    });
  }, [applyDCAState]);

  const removeClosedHolding = useCallback((id: string) => {
    setState((s) => {
      const portfolioEvents = dedupePortfolioEvents(s.portfolioEvents.filter((event) => (
        event.relatedEventId !== id && !event.id.includes(`closed:${id}`) && !event.id.includes(`closed-${id}`)
      )));
      return {
        ...s,
        closedHoldings: s.closedHoldings.filter((item) => item.id !== id),
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, s.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
      };
    });
  }, []);

  const updatePortfolioEvent = useCallback((id: string, patch: Pick<PortfolioEvent, "date" | "amount" | "note">) => {
    setState((s) => {
      const currentEvent = s.portfolioEvents.find((event) => event.id === id);
      if (!currentEvent) return s;
      const signedAmount = currentEvent.type === "fee" || currentEvent.type === "tax"
        ? -Math.abs(patch.amount)
        : Math.abs(patch.amount);
      let holdings = s.holdings;
      let nextEvent: PortfolioEvent = {
        ...currentEvent,
        date: patch.date,
        amount: signedAmount,
        amountInBase: toCNY(signedAmount, currentEvent.currency),
        fxRateToBase: currentEvent.currency.toUpperCase() === "CNY" ? 1 : toCNY(1, currentEvent.currency),
        fxRateEstimated: currentEvent.currency.toUpperCase() !== "CNY" && patch.date !== todayLocalYMD(),
        note: patch.note?.trim() ?? "",
      };
      if (currentEvent.holdingId && currentEvent.corporateActionId) {
        holdings = holdings.map((holding) => {
          if (holding.id !== currentEvent.holdingId) return holding;
          const oldAction = (holding.corporateActions ?? []).find((item) => item.id === currentEvent.corporateActionId);
          if (!oldAction) return holding;
          const reversed = reverseCorporateAction(holding, oldAction.id);
          const corrected = applyHoldingCorporateAction(reversed, {
            ...oldAction,
            date: patch.date,
            amount: Math.abs(signedAmount),
            note: patch.note?.trim() ?? "",
          });
          const correctedAction = (corrected.corporateActions ?? []).find((item) => item.id === oldAction.id);
          const rebuilt = correctedAction
            ? buildPortfolioEventFromCorporateAction(corrected, correctedAction, currentEvent.source)
            : null;
          if (rebuilt) nextEvent = { ...rebuilt, id: currentEvent.id, date: patch.date, groupId: currentEvent.groupId, createdAt: currentEvent.createdAt };
          return corrected;
        });
      }
      const portfolioEvents = dedupePortfolioEvents(s.portfolioEvents.map((event) => event.id === id ? nextEvent : event));
      return {
        ...s,
        holdings,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
      };
    });
  }, []);

  const removePortfolioEvent = useCallback((id: string) => {
    setState((s) => {
      const target = s.portfolioEvents.find((event) => event.id === id);
      if (!target) return s;
      const holdings = target.holdingId && target.corporateActionId
        ? s.holdings.map((holding) => holding.id === target.holdingId
          ? reverseCorporateAction(holding, target.corporateActionId!)
          : holding)
        : s.holdings;
      const portfolioEvents = dedupePortfolioEvents(s.portfolioEvents.filter((event) => event.id !== id));
      return {
        ...s,
        holdings,
        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
      };
    });
  }, []);

  /* detail overlay */
  const openDetail  = useCallback((t: DetailTarget) => setState((s) => ({ ...s, detailTarget: t })), []);
  const closeDetail = useCallback(() => setState((s) => ({ ...s, detailTarget: null })), []);

  /* DCA */
  const addDCAPlan = useCallback((p: Omit<DCAPlan, "id" | "nextExecDate" | "totalInvested" | "execCount">) => {
    const linkedHolding = stateRef.current.holdings.find((holding) => holding.id === p.holdingId);
    if (!linkedHolding) return;
    if (stateRef.current.dcaPlans.some((plan) => !plan.archived && plan.holdingId === p.holdingId)) return;
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
	      const dcaLedger = appendDCAExecutionEvents(s.portfolioEvents, dcaState.holdings, dcaState.dcaExecutions);
	      const portfolioEvents = dcaLedger.portfolioEvents;
	      return {
	        ...s,
	        dcaPlans: dcaState.dcaPlans,
	        dcaExecutions: dcaState.dcaExecutions,
	        holdings: dcaLedger.holdings,
	        portfolioEvents,
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
	        const dcaLedger = appendDCAExecutionEvents(s.portfolioEvents, dcaState.holdings, dcaState.dcaExecutions);
	        const portfolioEvents = dcaLedger.portfolioEvents;
	        return {
	          holdings: dcaLedger.holdings,
	          dcaPlans: dcaState.dcaPlans,
	          dcaExecutions: dcaState.dcaExecutions,
	          portfolioEvents,
	        };
	      })(),
	    }));
  }, [applyDCAState]);

  const removeDCAPlan = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      // Keep an archived rule snapshot so already-submitted fund orders can
      // still confirm after the future schedule is removed.
      dcaPlans: s.dcaPlans.map((plan) => plan.id === id ? { ...plan, enabled: false, archived: true } : plan),
      // Removing a schedule must not erase submitted/confirmed order history.
      dcaExecutions: s.dcaExecutions,
    }));
  }, []);

  const toggleDCAPlan = useCallback((id: string) => {
    setState((s) => {
      const nextPlans = s.dcaPlans.map((p) => {
        if (p.id !== id) return p;
        if (p.enabled) return { ...p, enabled: false };
        const enabled = { ...p, enabled: true };
        // Resuming starts from the next valid occurrence; missed periods remain
        // historical misses instead of being fabricated at today's price.
        return { ...enabled, nextExecDate: computeNextExec(enabled, new Date(), true) };
      });
	      const dcaState = applyDCAState(s.holdings, nextPlans, s.dcaExecutions, true, s.fundOrders);
	      const dcaLedger = appendDCAExecutionEvents(s.portfolioEvents, dcaState.holdings, dcaState.dcaExecutions);
	      const portfolioEvents = dcaLedger.portfolioEvents;
	      const fundOrders = syncDCAFundOrders(s.fundOrders, dcaLedger.holdings, dcaState.dcaPlans, dcaState.dcaExecutions);
	      return {
	        ...s,
	        holdings: dcaLedger.holdings,
	        dcaPlans: dcaState.dcaPlans,
	        dcaExecutions: dcaState.dcaExecutions,
	        fundOrders,
	        portfolioEvents,
        assetSnapshots: upsertPortfolioSnapshot(s.assetSnapshots, dcaLedger.holdings, portfolioEvents, new Date(), s.portfolioEventBaseline),
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

  const value = useMemo<AppContextType>(() => ({
    ...state, stats, tc,
    togglePrivacy, setDefaultPrivacyMode, setColorScheme, setTheme, setCurrency, setLanguage, setRefreshInterval,
    setTradeTimeOnly, setDividendReinvest, setDefaultOpenMode, refresh,
    exportPortfolio, importPortfolio, clearLocalData,
    addGroup, updateGroup, removeGroup,
    addHolding, updateHolding, adjustHolding, submitFundOrder, cancelFundOrder, removeHolding, removeClosedHolding, updatePortfolioEvent, removePortfolioEvent,
    openDetail, closeDetail,
    profitColor,
    addDCAPlan, updateDCAPlan, removeDCAPlan, toggleDCAPlan,
    openDCAPanel, closeDCAPanel,
  }), [
    state, stats, tc, profitColor, refresh, exportPortfolio, importPortfolio, clearLocalData,
    addGroup, updateGroup, removeGroup, addHolding, updateHolding, adjustHolding, submitFundOrder, cancelFundOrder, removeHolding,
    removeClosedHolding, updatePortfolioEvent, removePortfolioEvent, openDetail, closeDetail,
    addDCAPlan, updateDCAPlan, removeDCAPlan, toggleDCAPlan, openDCAPanel, closeDCAPanel,
    togglePrivacy, setDefaultPrivacyMode, setColorScheme, setTheme, setCurrency, setLanguage,
    setRefreshInterval, setTradeTimeOnly, setDividendReinvest, setDefaultOpenMode,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
