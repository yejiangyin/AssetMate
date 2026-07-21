import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import {
  Search, Plus, Minus, X, Pencil, Trash2, ChevronDown, Check,
  LineChart, RefreshCw, Circle,
  ChevronRight, BarChart2, CalendarClock, Repeat2, Eye, EyeOff,
  CloudDownload, Keyboard, Upload, Cpu, History,
} from "lucide-react";
import { DCAPlan, HoldingAdjustmentInput, HoldingInput, useApp } from "../context/AppContext";
import { Holding, Group, ClosedHolding, type TransactionCostProfile } from "../data/mockData";
import { fetchLivePrice, fetchCnFundTradeStatus, LiveResult, Market } from "../services/securitiesApi";
import { fetchTencentTradeStatus } from "../services/tencentQuote";
import { toYahooSymbol } from "../services/quoteApi";
import { FX } from "../services/priceRefresher";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";
import { currencySymbol, formatExactMoney, formatExactNumber, formatPercent } from "../utils/numberFormat";
import { resolveHoldingTradeStatus, tradeStatusLabel, cleanTradeSource, cleanTradeNote } from "../utils/tradeStatus";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import { normalizeHoldingSymbol, normalizeHoldingType } from "../utils/holdingHelpers";
import { canSaveHoldingForm } from "../utils/holdingForm";
import { SecuritySearchInput } from "../components/SecuritySearchInput";
import { estimateTransactionCosts, normalizeTransactionCostProfile } from "../utils/transactionCosts";
import {
  assetTypeLabel,
  groupName,
  marketLabel,
  t,
  translateTradeText,
} from "../i18n";
import type { Language } from "../context/AppContext";
import type { PortfolioEvent } from "../services/portfolioEvents";

/* ─── constants ──────────────────────────────────────── */
function getSecurityBadge(market: string, assetType?: string, language: Language = "zh") {
  if (market === "A" && assetType === "etf") {
    return { label: language === "en" ? "Listed ETF" : "场内ETF", color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" };
  }
  if (market === "A" && assetType === "fund") {
    return { label: language === "en" ? "Listed Fund" : "场内基金", color: "#31D08B", bg: "rgba(49,208,139,0.12)" };
  }
  return getMarketBadgeWithBg(market, 0.1, language);
}

const assetTypeOptions = [
  { value: "stock",  label: "股票"    },
  { value: "etf",    label: "ETF"     },
  { value: "fund",   label: "基金"    },
  { value: "crypto", label: "加密货币" },
  { value: "bond",   label: "债券"    },
] as const;
const currencyOptions  = ["CNY", "USD", "HKD", "JPY", "USDT", "USDC", "EUR"] as const;
type AssetType = typeof assetTypeOptions[number]["value"];

const colorOptions = ["#4F9CF9","#F24E4E","#31D08B","#F59E0B","#8B5CF6","#EC4899","#14B8A6","#F97316"];
const DEFAULT_GROUP_COLOR = "#4F9CF9";
const MARKET_SCOPE_OPTIONS: Market[] = ["US", "HK", "A", "JP", "FUND", "CRYPTO", "BOND"];

const blankForm = (): HoldingInput => ({
  groupId: "", symbol: "", name: "", market: "US", assetType: "",
  quantity: 0, costPrice: 0, currentPrice: 0, currency: "",
  tradeStatus: "normal",
  tradeStatusNote: "",
  dividendReinvest: null,
  transactionCostProfile: undefined,
});

function ratePercentValue(rate: number | undefined) {
  return rate == null ? "" : String(Number((rate * 100).toFixed(6)));
}

function optionalRateFromPercent(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed / 100 : Number.NaN;
}

function optionalNonNegative(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function costInputValue(value: number) {
  if (!(value > 0)) return "";
  return String(Number(value.toFixed(6)));
}

function normalizeHoldingForm(input: HoldingInput): HoldingInput {
  const normalizedType = normalizeHoldingType(input.symbol, input.name, input.market, input.assetType);
  const canReinvest = normalizedType.market === "FUND" && normalizedType.assetType === "fund";
  return {
    ...input,
    symbol: normalizeHoldingSymbol(input.symbol, normalizedType.market),
    market: normalizedType.market,
    assetType: normalizedType.assetType,
    tradeStatus: "normal",
    tradeStatusNote: "",
    dividendReinvest: canReinvest ? input.dividendReinvest ?? null : null,
    transactionCostProfile: normalizeTransactionCostProfile(input.transactionCostProfile),
  };
}

function isFundLike(input: Pick<HoldingInput, "market" | "assetType"> | Pick<Holding, "market" | "assetType">) {
  return input.market === "FUND" || input.assetType === "fund";
}

function canConfigureDividendReinvest(input: Pick<HoldingInput, "market" | "assetType"> | Pick<Holding, "market" | "assetType">) {
  return input.market === "FUND" && input.assetType === "fund";
}

function assetTypeSelectLabel(market: string, assetType: string, fallback: string, language: Language) {
  if (!assetType) return fallback;
  return getSecurityBadge(market, assetType, language).label || fallback;
}


function convertAmount(value: number, fromCurrency: string, toCurrency: string) {
  const sourceFx = FX[fromCurrency as keyof typeof FX] ?? 1;
  const targetFx = FX[toCurrency as keyof typeof FX] ?? 1;
  return value * sourceFx / targetFx;
}

function pnlSign(value: number) {
  return value > 0 ? "+" : value < 0 ? "-" : "";
}

function quantityUnit(market: string, assetType: string, language: Language = "zh") {
  const units = t(language).holdings.units;
  if (market === "CRYPTO") return units.crypto;
  if (assetType === "fund" || market === "FUND") return units.fund;
  if (assetType === "bond") return units.bond;
  return units.stock;
}

function requiresWholeTradeQuantity(input: Pick<Holding, "market" | "assetType">) {
  return input.market !== "CRYPTO" && !isFundLike(input);
}

function holdingMarketValue(h: Holding) {
  return h.quantity * h.currentPrice;
}

function holdingFeeTaxTotal(h: Holding) {
  return (h.corporateActions ?? []).reduce((sum, action) => (
    action.type === "fee" || action.type === "tax"
      ? sum - Math.abs(Number.isFinite(action.amount) ? action.amount ?? 0 : 0)
      : sum
  ), 0);
}

function holdingTotalPnl(h: Holding) {
  return h.quantity * (h.currentPrice - h.costPrice) + (h.cashDividendTotal ?? 0) + holdingFeeTaxTotal(h);
}

function holdingTotalPnlRate(h: Holding) {
  const cost = h.quantity * h.costPrice;
  return cost > 0 ? holdingTotalPnl(h) / cost : 0;
}

function todayLocalYMD() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isValidYMD(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]);
}

function todayDividendAmount(h: Holding, today = todayLocalYMD()) {
  return (h.corporateActions ?? [])
    .filter((action) => (
      (action.type === "cash_dividend" || action.type === "dividend_reinvest") &&
      action.date === today
    ))
    .reduce((sum, action) => sum + (Number.isFinite(action.amount) ? Math.max(0, action.amount ?? 0) : 0), 0);
}

function holdingTodayPnlRate(h: Holding) {
  return Number.isFinite(h.todayPnlRate) ? h.todayPnlRate : 0;
}

function holdingRateChange(price: number, rate: number) {
  if (!Number.isFinite(price) || !Number.isFinite(rate) || price <= 0) return 0;
  const denominator = 1 + rate;
  if (denominator <= 0) return 0;
  return price * rate / denominator;
}

function formatSummaryMoney(value: number, currency: string) {
  return formatExactMoney(Math.abs(value), currency, 2);
}

function formatHoldingQuantity(value: number | undefined | null) {
  return formatExactNumber(value, 2, 2);
}

const REALIZED_HISTORY_EVENT_TYPES = new Set<PortfolioEvent["type"]>([
  "cash_dividend",
  "dividend_reinvest",
  "interest",
  "bond_coupon",
  "fee",
  "tax",
]);

function realizedEventLabel(type: PortfolioEvent["type"], language: Language) {
  const isEn = language === "en";
  switch (type) {
    case "cash_dividend": return isEn ? "Cash dividend" : "现金分红";
    case "dividend_reinvest": return isEn ? "Dividend reinvestment" : "红利再投";
    case "interest": return isEn ? "Interest" : "利息";
    case "bond_coupon": return isEn ? "Bond coupon" : "债券票息";
    case "fee": return isEn ? "Fee" : "手续费";
    case "tax": return isEn ? "Tax" : "税费";
    default: return isEn ? "Realized event" : "已实现流水";
  }
}

function realizedEventSourceLabel(event: PortfolioEvent, language: Language) {
  const isEn = language === "en";
  const note = event.note?.trim().toLowerCase() ?? "";
  if (note === "initial buy transaction cost" || note === "buy transaction cost") {
    return isEn ? "Calculated from the buy record" : "根据买入记录自动计算";
  }
  if (note === "sell transaction cost") {
    return isEn ? "Calculated from the sell record" : "根据卖出记录自动计算";
  }
  if (note === "dca transaction cost") {
    return isEn ? "Calculated from the DCA record" : "根据定投记录自动计算";
  }
  if (note === "automatic dividend withholding tax") {
    return isEn ? "Calculated from the dividend record" : "根据分红记录自动计算";
  }
  if (note === "inferred aggregate transaction cost from legacy closed holding") {
    return isEn ? "Reconstructed from a historical close record" : "根据历史清仓记录补算";
  }
  switch (event.source) {
    case "auto": return isEn ? "Synced automatically from market data" : "由行情数据自动同步";
    case "manual": return isEn ? "Entered directly by the user" : "用户手动录入";
    case "import": return isEn ? "Imported record" : "导入记录";
    case "system": return isEn ? "Generated automatically by the system" : "系统自动生成";
    case "migration": return isEn ? "Migrated historical record" : "历史数据迁移";
    default: return "";
  }
}

function RealizedSourceIcon({ source }: { source: PortfolioEvent["source"] }) {
  const Icon = source === "auto" ? CloudDownload
    : source === "manual" ? Keyboard
      : source === "import" ? Upload
        : source === "migration" ? History
          : Cpu;
  return <Icon size={11} aria-hidden="true" />;
}

function realizedEventNoteLabel(note: string | undefined, language: Language) {
  const value = note?.trim();
  if (!value || value.toLowerCase() === "auto") return "";
  const normalized = value.toLowerCase();
  const isEn = language === "en";
  const knownNotes: Record<string, [string, string]> = {
    "auto dividend reinvest": ["分红已按设置自动再投资", "Dividend automatically reinvested"],
    "auto dividend reinvest, net of dividend withholding tax": ["分红已按税后净额自动再投资", "Net dividend automatically reinvested after withholding tax"],
    "automatic dividend withholding tax": ["现金分红预扣税", "Dividend withholding tax"],
    "initial buy transaction cost": ["首次买入交易费用", "Initial buy transaction cost"],
    "buy transaction cost": ["买入交易费用", "Buy transaction cost"],
    "sell transaction cost": ["卖出交易费用", "Sell transaction cost"],
    "dca transaction cost": ["定投交易费用", "DCA transaction cost"],
    "migrated cashdividendtotal summary": ["历史累计分红迁移记录", "Migrated cumulative dividend record"],
    "migrated closed holding cashdividendtotal summary": ["历史已清仓分红迁移记录", "Migrated closed-holding dividend record"],
    "migrated recorded transaction fee": ["历史手续费迁移记录", "Migrated transaction-fee record"],
    "migrated recorded transaction tax": ["历史税费迁移记录", "Migrated transaction-tax record"],
    "inferred aggregate transaction cost from legacy closed holding": ["根据历史清仓记录补算的交易费用", "Transaction cost inferred from a legacy closed holding"],
  };
  const translated = knownNotes[normalized];
  return translated ? translated[isEn ? 1 : 0] : value;
}

function holdingUnitPriceDecimals(h: Holding) {
  if (h.market === "FUND" || h.assetType === "fund") return 4;
  if (h.market === "A" && (h.assetType === "etf" || h.assetType === "bond")) return 3;
  if (h.market === "CRYPTO" || h.assetType === "crypto") {
    if (h.currentPrice >= 1000) return 2;
    if (h.currentPrice >= 1) return 3;
    return 4;
  }
  return 2;
}

function ClosedHoldingsView({
  items,
  events,
  baseCurrency,
  privacyMode,
  profitColor,
  onDelete,
  onEditEvent,
  onDeleteEvent,
  language,
}: {
  items: ClosedHolding[];
  events: PortfolioEvent[];
  baseCurrency: string;
  privacyMode: boolean;
  profitColor: (value: number) => string;
  onDelete: (id: string) => void;
  onEditEvent: (event: PortfolioEvent) => void;
  onDeleteEvent: (event: PortfolioEvent) => void;
  language: Language;
}) {
  const PAGE_SIZE = 80;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const rows = useMemo(() => {
    const closedRows = items.map((item) => ({
      kind: "closed" as const,
      id: `closed:${item.id}`,
      date: item.closedAt || "",
      createdAt: `${item.closedAt || ""}T23:59:59`,
      item,
    }));
    const eventRows = events.map((event) => ({
      kind: "event" as const,
      id: `event:${event.id}`,
      date: event.date || "",
      createdAt: event.createdAt || `${event.date || ""}T00:00:00`,
      event,
    }));
    return [...closedRows, ...eventRows].sort((a, b) => (
      b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    ));
  }, [events, items]);
  const visibleRows = rows.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount((current) => Math.min(current, Math.max(PAGE_SIZE, rows.length)));
  }, [rows.length]);

  const emptyText = language === "en" ? "No realized records yet" : "暂无已实现记录";
  const subtitle = language === "en"
    ? "Sell, close, dividend, reinvestment, fee and tax records are collected here."
    : "卖出、清仓、现金分红、红利再投、手续费和税费都会汇总到这里。";

  if (!rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-14 gap-2 px-6 text-center">
        <BarChart2 size={30} color="var(--text-micro)" />
        <p style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 700 }}>{emptyText}</p>
        <p style={{ color: "var(--text-micro)", fontSize: 11, lineHeight: 1.5 }}>{subtitle}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {visibleRows.map((row) => {
        if (row.kind === "event") {
          const event = row.event;
          const amountInBase = Number.isFinite(event.amountInBase)
            ? event.amountInBase
            : convertAmount(event.amount, event.currency, "CNY");
          const pnl = convertAmount(amountInBase, "CNY", baseCurrency);
          const color = profitColor(pnl);
          const isReinvest = event.type === "dividend_reinvest";
          const displayNote = realizedEventNoteLabel(event.note, language);
          const sourceLabel = realizedEventSourceLabel(event, language);
          return (
            <div
              key={row.id}
              className="rounded-2xl p-3"
              style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 800 }}>
                      {event.name || event.symbol || (language === "en" ? "Unlinked holding" : "未关联标的")}
                    </p>
                    {event.symbol && <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 700 }}>{event.symbol}</span>}
                  </div>
                  <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                    {realizedEventLabel(event.type, language)} · {event.date || "-"}
                    {event.market ? ` · ${marketLabel(event.market, language)}` : ""}
                    {event.assetType ? ` · ${assetTypeLabel(event.assetType, language)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => onEditEvent(event)} className="flex size-7 items-center justify-center rounded-lg bg-app-surface2 text-tm hover:text-app-accent" title={language === "en" ? "Correct record" : "纠正记录"}>
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => onDeleteEvent(event)} className="flex size-7 items-center justify-center rounded-lg text-app-danger" style={{ background: "rgba(242,78,78,0.1)" }} title={language === "en" ? "Delete record" : "删除记录"}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div className={`grid ${isReinvest ? "grid-cols-3" : "grid-cols-1"} gap-2 mt-3`}>
                <div>
                  <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Amount" : "金额"}</p>
                  <p className="truncate" style={{ color, fontSize: 12, fontWeight: 800 }}>
                    {pnlSign(pnl)}{privacyMode ? `${currencySymbol(baseCurrency)}--` : formatSummaryMoney(pnl, baseCurrency)}
                  </p>
                </div>
                {isReinvest && (
                  <>
                    <div>
                      <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Quantity" : "份额/数量"}</p>
                      <p className="truncate" style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                        {event.quantity != null && event.quantity > 0 ? formatHoldingQuantity(event.quantity) : "—"}
                      </p>
                    </div>
                    <div>
                      <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Price/NAV" : "价格/净值"}</p>
                      <p className="truncate" style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                        {event.price != null && event.price > 0 ? formatExactMoney(event.price, event.currency, 4) : "—"}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {(isReinvest || event.estimatedAmount != null || event.rateUsed != null || displayNote) && (
                <div className="mt-3 rounded-xl px-3 py-2" style={{ background: "var(--bg-surface2)" }}>
                  {isReinvest && (
                    <p style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                      {language === "en" ? "Marked as dividend reinvestment" : "已标识为红利再投"}
                    </p>
                  )}
                  {event.estimatedAmount != null && event.estimatedAmount > 0 && (
                    <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                      {language === "en" ? "Gross dividend" : "税前/核减前金额"}：
                      {privacyMode ? `${currencySymbol(event.currency)}--` : formatExactMoney(event.estimatedAmount, event.currency, 2)}
                    </p>
                  )}
                  {event.rateUsed != null && event.rateUsed > 0 && (
                    <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                      {language === "en" ? "Applied rate" : "适用比例"}：{formatPercent(event.rateUsed)}
                    </p>
                  )}
                  {displayNote && (
                    <p className="truncate" style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                      {displayNote}
                    </p>
                  )}
                </div>
              )}
              {sourceLabel && (
                <div className="mt-2 flex items-center gap-1.5" style={{ color: "var(--text-micro)", fontSize: 10 }}>
                  <RealizedSourceIcon source={event.source} />
                  <span>{sourceLabel}</span>
                </div>
              )}
            </div>
          );
        }

        const item = row.item;
        const pnl = convertAmount(item.realizedPnl - (item.cashDividendTotal ?? 0), item.currency, baseCurrency);
        const proceeds = convertAmount(item.proceeds, item.currency, baseCurrency);
        const costBasis = convertAmount(item.costBasis, item.currency, baseCurrency);
        const transactionFee = item.transactionFee == null
          ? null
          : convertAmount(item.transactionFee, item.currency, baseCurrency);
        const transactionTax = item.transactionTax == null
          ? null
          : convertAmount(item.transactionTax, item.currency, baseCurrency);
        const color = profitColor(pnl);
        return (
          <div
            key={item.id}
            className="rounded-2xl p-3"
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 800 }}>
                    {item.name}
                  </p>
                  <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 700 }}>{item.symbol}</span>
                </div>
                <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                  {item.isPartial
                    ? (language === "en" ? "Partial" : "减仓")
                    : (language === "en" ? "Closed" : "清仓")} {item.closedAt || "-"} · {marketLabel(item.market, language)} · {assetTypeLabel(item.assetType, language)}
                </p>
              </div>
              <button
                onClick={() => onDelete(item.id)}
                className="flex items-center justify-center rounded-lg shrink-0"
                style={{ width: 28, height: 28, background: "rgba(242,78,78,0.1)", color: "#F24E4E" }}
                title={language === "en" ? "Delete record" : "删除历史记录"}
              >
                <Trash2 size={13} />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Quantity" : "数量"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {formatHoldingQuantity(item.quantity)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Sell Price" : "卖出价"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {privacyMode ? `${currencySymbol(item.currency)}***` : formatExactMoney(item.closePrice, item.currency, 4)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Proceeds" : "卖出金额"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(proceeds, baseCurrency)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-2 border-t pt-2" style={{ borderColor: "var(--border-sub)" }}>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Cost Basis" : "卖出成本"}</p>
                <p className="truncate" style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                  {privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(costBasis, baseCurrency)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Fee" : "手续费"}</p>
                <p className="truncate" title={transactionFee == null ? (language === "en" ? "Not recorded in legacy data" : "历史记录未保存") : undefined} style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                  {transactionFee == null
                    ? (language === "en" ? "Not recorded" : "未记录")
                    : privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(transactionFee, baseCurrency)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Tax" : "税费"}</p>
                <p className="truncate" title={transactionTax == null ? (language === "en" ? "Not recorded in legacy data" : "历史记录未保存") : undefined} style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>
                  {transactionTax == null
                    ? (language === "en" ? "Not recorded" : "未记录")
                    : privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(transactionTax, baseCurrency)}
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-xl px-3 py-2 flex items-center justify-between" style={{ background: `${color}12` }}>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {language === "en" ? "Sale P/L" : "卖出交易收益"}
              </span>
              <span className="truncate" style={{ color, fontSize: 13, fontWeight: 800 }}>
                {pnlSign(pnl)}{privacyMode ? `${currencySymbol(baseCurrency)}--` : formatSummaryMoney(pnl, baseCurrency)}
                <span style={{ marginLeft: 6, fontSize: 11 }}>
                  {formatPercent(item.realizedReturn)}
                </span>
              </span>
            </div>
          </div>
        );
      })}
      {visibleCount < rows.length && (
        <button
          onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, rows.length))}
          className="rounded-xl py-2.5"
          style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)", color: "#4F9CF9", fontSize: 12, fontWeight: 700 }}
        >
          {language === "en"
            ? `Show more (${rows.length - visibleCount})`
            : `加载更多（剩余 ${rows.length - visibleCount} 条）`}
        </button>
      )}
    </div>
  );
}

/* ─── tiny primitives ─────────────────────────────────── */
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{label}</p>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text", step, min, max }: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  step?: string | number;
  min?: string | number;
  max?: string | number;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      step={step} min={min} max={max}
      style={{
        width: "100%", height: 38, background: "var(--bg-card)",
        border: "1px solid var(--border)", borderRadius: 10, padding: "0 12px",
        color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box",
      }} />
  );
}

function Sel<T extends string>({ value, onChange, options, style }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; style?: React.CSSProperties;
}) {
  return (
    <div style={{ position: "relative", ...style }}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}
        style={{
          width: "100%", height: 38, background: "var(--bg-card)",
          border: "1px solid var(--border)", borderRadius: 10,
          padding: "0 30px 0 12px", color: "var(--text-primary)", fontSize: 13,
          outline: "none", appearance: "none", boxSizing: "border-box",
        }}>
        {options.map((o) => <option key={o.value} value={o.value} style={{ background: "var(--bg-overlay)" }}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} color="var(--text-muted)" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
    </div>
  );
}

/* ─── PnL preview strip ──────────────────────────────── */
function PnLPreview({ form, cashDividendTotal = 0 }: { form: HoldingInput; cashDividendTotal?: number }) {
  const { profitColor, language } = useApp();
  const text = t(language).holdings;
  const mv   = form.quantity * form.currentPrice;
  const cost = form.quantity * form.costPrice;
  const pnl  = mv - cost + Math.max(0, Number.isFinite(cashDividendTotal) ? cashDividendTotal : 0);
  const rate = cost > 0 ? pnl / cost : 0;
  const col  = profitColor(pnl);
  return (
    <div className="rounded-xl px-3 py-2.5 flex gap-3"
      style={{ background: "rgba(79,156,249,0.05)", border: "1px solid rgba(79,156,249,0.12)" }}>
      {[
        { label: text.estimatedMarketValue, val: mv > 0 ? formatSummaryMoney(mv, form.currency) : "—", color: "var(--text-primary)" },
        { label: text.cumulativePnl, val: cost > 0 ? `${pnlSign(pnl)}${formatSummaryMoney(pnl, form.currency)}` : "—", color: cost > 0 ? col : "var(--text-muted)" },
        { label: text.returnRate,   val: cost > 0 ? formatPercent(rate) : "—", color: cost > 0 ? col : "var(--text-muted)" },
      ].map((it) => (
        <div key={it.label} className="flex-1">
          <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{it.label}</p>
          <p style={{ color: it.color, fontSize: 13, fontWeight: 700 }}>{it.val}</p>
        </div>
      ))}
    </div>
  );
}

/* ─── Add / Edit form sheet ──────────────────────────── */
function FormSheet({ initial, groups, onSave, onClose, isEdit, cashDividendTotal = 0 }: {
  initial: HoldingInput; groups: Group[];
  onSave: (h: HoldingInput) => void; onClose: () => void; isEdit: boolean;
  cashDividendTotal?: number;
}) {
  const { language } = useApp();
  const text = t(language);
  const [form, setForm] = useState<HoldingInput>(initial);
  // String drafts for numeric fields so users can type "0.5" without the
  // leading "0" disappearing (parseFloat("0")||0 = 0, and 0||"" = "").
  const [numberDraft, setNumberDraft] = useState({
    quantity: initial.quantity ? String(initial.quantity) : "",
    costPrice: initial.costPrice ? String(initial.costPrice) : "",
    currentPrice: initial.currentPrice ? String(initial.currentPrice) : "",
  });
  const setNumberField = (k: "quantity" | "costPrice" | "currentPrice", v: string) => {
    setNumberDraft((d) => ({ ...d, [k]: v }));
    set(k, v === "" ? 0 : parseFloat(v) || 0);
  };
  const [costProfileDraft, setCostProfileDraft] = useState(() => ({
    buyFeeRate: ratePercentValue(initial.transactionCostProfile?.buyFeeRate),
    sellFeeRate: ratePercentValue(initial.transactionCostProfile?.sellFeeRate),
    minimumFee: initial.transactionCostProfile?.minimumFee == null ? "" : String(initial.transactionCostProfile.minimumFee),
    buyTaxRate: ratePercentValue(initial.transactionCostProfile?.buyTaxRate),
    sellTaxRate: ratePercentValue(initial.transactionCostProfile?.sellTaxRate),
    dividendTaxRate: ratePercentValue(initial.transactionCostProfile?.dividendTaxRate),
  }));
  const [saving, setSaving] = useState(false);
  const [securityQuery, setSecurityQuery] = useState(() =>
    initial.symbol && initial.name ? `${initial.name} (${initial.symbol})` : [initial.symbol, initial.name].filter(Boolean).join(" ")
  );
  // Market scope narrows the live search to a single market so identical
  // tickers from different exchanges (e.g. HK 00700 vs JP 7001) don't get
  // mixed together. Defaults to the holding's market when editing.
  const [marketScope, setMarketScope] = useState<Market | "">(() =>
    isEdit && (MARKET_SCOPE_OPTIONS as string[]).includes(initial.market) ? (initial.market as Market) : ""
  );
  const requestSeqRef = useRef(0);
  const set = <K extends keyof HoldingInput>(k: K, v: HoldingInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const costProfileForSave = normalizeTransactionCostProfile({
    buyFeeRate: optionalRateFromPercent(costProfileDraft.buyFeeRate),
    sellFeeRate: optionalRateFromPercent(costProfileDraft.sellFeeRate),
    minimumFee: optionalNonNegative(costProfileDraft.minimumFee),
    buyTaxRate: optionalRateFromPercent(costProfileDraft.buyTaxRate),
    sellTaxRate: optionalRateFromPercent(costProfileDraft.sellTaxRate),
    dividendTaxRate: optionalRateFromPercent(costProfileDraft.dividendTaxRate),
  });
  const validCostProfile = Object.values(costProfileDraft).every((value) => (
    !value.trim() || (Number.isFinite(Number(value)) && Number(value) >= 0)
  )) && [costProfileDraft.buyFeeRate, costProfileDraft.sellFeeRate, costProfileDraft.buyTaxRate, costProfileDraft.sellTaxRate, costProfileDraft.dividendTaxRate]
    .every((value) => !value.trim() || Number(value) <= 100);
  const valid = canSaveHoldingForm(form) && validCostProfile;
  const assetTypeSelectOptions = useMemo(() => [
    { value: "" as AssetType, label: text.holdings.selectAfterSecurity },
    ...assetTypeOptions.map((option) => ({
      value: option.value as AssetType,
      label: option.value === form.assetType
        ? assetTypeSelectLabel(form.market, form.assetType, assetTypeLabel(option.value, language), language)
        : assetTypeLabel(option.value, language),
    })),
  ], [form.assetType, form.market, language, text.holdings.selectAfterSecurity]);

  const groupOpts = [
    { value: "", label: text.holdings.noGroup },
    ...groups.map((g) => ({ value: g.id, label: groupName(g.id, g.name, language) })),
  ];
  const showDividendMode = canConfigureDividendReinvest(form);
  const dividendMode = form.dividendReinvest == null ? "inherit" : form.dividendReinvest ? "reinvest" : "cash";
  const dividendModeOptions = [
    { value: "inherit", label: text.holdings.dividendInherit },
    { value: "cash", label: text.holdings.dividendCash },
    { value: "reinvest", label: text.holdings.dividendReinvest },
  ];

  const marketScopeOptions = useMemo(() => [
    { value: "" as Market | "", label: text.holdings.allMarkets },
    ...MARKET_SCOPE_OPTIONS.map((m) => ({ value: m as Market | "", label: marketLabel(m, language) })),
  ], [language, text.holdings.allMarkets]);

  const handleMarketScopeChange = (next: Market | "") => {
    requestSeqRef.current += 1;
    setMarketScope(next);
    // Clear the previously selected security so stale cross-market data
    // doesn't get saved alongside the new scope.
    setSecurityQuery("");
    setNumberDraft({ quantity: "", costPrice: "", currentPrice: "" });
    setForm((f) => ({
      ...f,
      symbol: "",
      name: "",
      assetType: "",
      currency: "",
      currentPrice: 0,
      autoTradeStatus: null,
      autoTradeStatusNote: "",
      autoTradeStatusSource: null,
    }));
  };

  const handleSelect = (r: LiveResult) => {
    const requestSeq = ++requestSeqRef.current;
    const normalizedType = normalizeHoldingType(r.symbol, r.name, r.market, r.assetType);
    const normalizedSymbol = normalizeHoldingSymbol(r.symbol, normalizedType.market);
    setSecurityQuery(`${r.name} (${r.symbol})`);
    if (r.price > 0) setNumberDraft((d) => ({ ...d, currentPrice: String(r.price) }));
    setForm((f) => ({
      ...f,
      symbol: normalizedSymbol,
      name: r.name,
      market: normalizedType.market,
      assetType: normalizedType.assetType,
      currency: r.currency,
      currentPrice: r.price > 0 ? r.price : f.currentPrice,
      dividendReinvest: canConfigureDividendReinvest(normalizedType) ? f.dividendReinvest : null,
      autoTradeStatus: null,
      autoTradeStatusNote: "",
      autoTradeStatusSource: null,
    }));

    // Search endpoints may include delayed or previous-session prices. Keep that
    // value for immediate feedback, then always verify it through the live quote
    // path before the user saves the holding.
    void fetchLivePrice(r.symbol, r.market, r.coinId).then((quote) => {
      if (requestSeq !== requestSeqRef.current) return;
      if (!quote || quote.price <= 0) return;
      setNumberDraft((d) => (
        d.currentPrice === String(quote.price) ? d : { ...d, currentPrice: String(quote.price) }
      ));
      setForm((f) => (
        f.symbol === normalizedSymbol && f.market === normalizedType.market
          ? { ...f, currentPrice: quote.price, currency: quote.currency || f.currency }
          : f
      ));
    }).catch(() => null);

    const market = normalizedType.market;
    const sym = normalizedSymbol;
    if (market === "FUND") {
      void fetchCnFundTradeStatus(sym).then((status) => {
        if (requestSeq !== requestSeqRef.current) return;
        if (!status) return;
        setForm((f) => f.symbol === sym && f.market === market
          ? { ...f, autoTradeStatus: status.status, autoTradeStatusNote: status.note, autoTradeStatusSource: "eastmoney", fundBuyConfirmDays: status.buyConfirmDays }
          : f);
      }).catch(() => null);
    } else if (market === "A" || market === "HK") {
      void fetchTencentTradeStatus(sym, market).then((status) => {
        if (requestSeq !== requestSeqRef.current) return;
        if (!status) return;
        setForm((f) => f.symbol === sym && f.market === market
          ? { ...f, autoTradeStatus: status.status, autoTradeStatusNote: status.note, autoTradeStatusSource: status.source }
          : f);
      }).catch(() => null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col justify-end"
      style={{ background: "var(--scrim)", zIndex: 50 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        className="flex flex-col rounded-t-2xl"
        style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)", maxHeight: "92%" }}>

        <div className="flex items-center justify-between px-4 shrink-0"
          style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>{isEdit ? text.holdings.editHolding : text.holdings.addHolding}</span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>

        <div className="overflow-y-auto px-4 py-3 flex flex-col gap-3" style={{ scrollbarWidth: "none" }}>
          <p style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600 }}>{text.holdings.basicInfo}</p>

          <div className="flex gap-2 items-end">
            <Field label={text.holdings.marketScope}>
              <Sel value={marketScope} onChange={(v) => handleMarketScopeChange(v)} options={marketScopeOptions}
                style={{ width: 96, flexShrink: 0 }} />
            </Field>
            <Field label={text.holdings.security} className="flex-1 min-w-0">
              <SecuritySearchInput value={securityQuery} onChange={setSecurityQuery}
                onSelect={handleSelect} placeholder={text.holdings.searchSecurityPlaceholder}
                marketFilter={marketScope || undefined} />
            </Field>
          </div>

          {form.autoTradeStatus && form.autoTradeStatus !== "normal" && (
            <div className="rounded-lg px-2.5 py-2" style={{
              background: form.autoTradeStatus === "buy_disabled" ? "rgba(242,78,78,0.08)" : "rgba(245,158,11,0.08)",
              border: `1px solid ${form.autoTradeStatus === "buy_disabled" ? "rgba(242,78,78,0.18)" : "rgba(245,158,11,0.18)"}`,
            }}>
              {(() => {
                const rawLabel = tradeStatusLabel(form.autoTradeStatus);
                const label = translateTradeText(rawLabel, language);
                const note = translateTradeText(cleanTradeNote(form.autoTradeStatusNote, rawLabel), language);
                const color = form.autoTradeStatus === "buy_disabled" ? "#F24E4E" : "#F59E0B";
                const source = translateTradeText(cleanTradeSource(form.autoTradeStatusSource ?? ""), language);
                return (
                  <p style={{ color, fontSize: 11, fontWeight: 600 }}>
                    {source ? `${source} · ` : ""}{label}{note ? `, ${note}` : ""}
                  </p>
                );
              })()}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label={text.holdings.assetType}>
              <Sel value={form.assetType as AssetType} onChange={(v) => setForm((f) => ({
                ...f,
                assetType: v,
                dividendReinvest: canConfigureDividendReinvest({ ...f, assetType: v }) ? f.dividendReinvest : null,
              }))}
                options={assetTypeSelectOptions} />
            </Field>
            <Field label={text.holdings.currency}>
              <Sel value={form.currency} onChange={(v) => set("currency", v)}
                options={[
                  { value: "", label: text.holdings.autoFill },
                  ...currencyOptions.map((c) => ({ value: c, label: c })),
                ]} />
            </Field>
          </div>

          <Field label={text.holdings.group}>
            <Sel value={form.groupId} onChange={(v) => set("groupId", v)} options={groupOpts} />
          </Field>

          {showDividendMode && (
            <Field label={text.holdings.dividendMode}>
              <Sel
                value={dividendMode}
                onChange={(v) => set("dividendReinvest", v === "inherit" ? null : v === "reinvest")}
                options={dividendModeOptions}
              />
            </Field>
          )}

          <p style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600, marginTop: 2 }}>{text.holdings.holdingInfo}</p>

          <Field label={text.holdings.quantity}>
            <Input type="number" value={numberDraft.quantity} onChange={(v) => setNumberField("quantity", v)} placeholder={language === "en" ? "e.g. 100" : "例：100"} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label={text.holdings.costPrice}>
              <Input type="number" value={numberDraft.costPrice} onChange={(v) => setNumberField("costPrice", v)} placeholder={language === "en" ? "Avg cost" : "买入均价"} />
            </Field>
            <Field label={text.holdings.currentPrice}>
              <Input type="number" value={numberDraft.currentPrice} onChange={(v) => setNumberField("currentPrice", v)} placeholder={language === "en" ? "Latest quote" : "最新报价"} />
            </Field>
          </div>

          <PnLPreview form={form} cashDividendTotal={isEdit ? cashDividendTotal : 0} />

          <div className="rounded-xl p-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>{text.holdings.costProfile}</p>
            <p style={{ color: "var(--text-micro)", fontSize: 10, lineHeight: 1.45, marginTop: 3, marginBottom: 10 }}>
              {text.holdings.costProfileHint}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Field label={text.holdings.buyFeeRate}>
                <Input type="number" step="0.01" min="0" max="100" value={costProfileDraft.buyFeeRate} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, buyFeeRate: value }))} placeholder="0.03" />
              </Field>
              <Field label={text.holdings.sellFeeRate}>
                <Input type="number" step="0.01" min="0" max="100" value={costProfileDraft.sellFeeRate} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, sellFeeRate: value }))} placeholder="0.03" />
              </Field>
              <Field label={text.holdings.buyTaxRate}>
                <Input type="number" step="0.01" min="0" max="100" value={costProfileDraft.buyTaxRate} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, buyTaxRate: value }))} placeholder="0" />
              </Field>
              <Field label={text.holdings.sellTaxRate}>
                <Input type="number" step="0.01" min="0" max="100" value={costProfileDraft.sellTaxRate} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, sellTaxRate: value }))} placeholder="0" />
              </Field>
              <Field label={text.holdings.dividendTaxRate}>
                <Input type="number" step="0.01" min="0" max="100" value={costProfileDraft.dividendTaxRate} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, dividendTaxRate: value }))} placeholder="0" />
              </Field>
            </div>
            <div className="mt-2">
              <Field label={text.holdings.minimumFee(form.currency)}>
                <Input type="number" step="0.01" min="0" value={costProfileDraft.minimumFee} onChange={(value) => setCostProfileDraft((draft) => ({ ...draft, minimumFee: value }))} placeholder="0" />
              </Field>
            </div>
          </div>

          <button onClick={() => {
            if (!valid || saving) return;
            setSaving(true);
            onSave(normalizeHoldingForm({ ...form, transactionCostProfile: costProfileForSave }));
          }} disabled={!valid || saving} className="w-full rounded-xl py-3 flex items-center justify-center gap-2 shrink-0"
            style={{
              background: valid && !saving ? "linear-gradient(135deg, #4F9CF9 0%, #7C3AED 100%)" : "var(--bg-card)",
              color: valid && !saving ? "#fff" : "var(--text-micro)", fontSize: 13, fontWeight: 600, marginBottom: 8,
              cursor: valid && !saving ? "pointer" : "not-allowed",
            }}>
            <Check size={15} /> {saving ? text.common.saving : isEdit ? text.holdings.saveChanges : text.holdings.confirmInput}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AdjustSheet({
  holding,
  mode,
  onSave,
  onClose,
}: {
  holding: Holding;
  mode: "buy" | "sell";
  onSave: (input: HoldingAdjustmentInput) => void;
  onClose: () => void;
}) {
  const { language } = useApp();
  const text = t(language).holdings;
  const [inputMode, setInputMode] = useState<"quantity" | "amount">("quantity");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState(holding.currentPrice ? String(holding.currentPrice) : "");
  const [date, setDate] = useState(todayLocalYMD());
  const configuredFeeRate = mode === "buy" ? holding.transactionCostProfile?.buyFeeRate : holding.transactionCostProfile?.sellFeeRate;
  const configuredTaxRate = mode === "buy" ? holding.transactionCostProfile?.buyTaxRate : holding.transactionCostProfile?.sellTaxRate;
  const configuredMinimumFee = holding.transactionCostProfile?.minimumFee;
  const hasConfiguredRule = configuredFeeRate != null || configuredTaxRate != null || configuredMinimumFee != null;
  const [feeRate, setFeeRate] = useState(() => ratePercentValue(configuredFeeRate));
  const [taxRate, setTaxRate] = useState(() => ratePercentValue(configuredTaxRate));
  const [minimumFee, setMinimumFee] = useState(() => configuredMinimumFee == null ? "" : String(configuredMinimumFee));
  const [feeOverride, setFeeOverride] = useState<string | null>(null);
  const [taxOverride, setTaxOverride] = useState<string | null>(null);
  const [rememberCostProfile, setRememberCostProfile] = useState(!hasConfiguredRule);
  const [saving, setSaving] = useState(false);
  const maxSell = holding.quantity;
  const validPrice = Number(price);
  const wholeQuantityRequired = requiresWholeTradeQuantity(holding);
  const rawQuantity = inputMode === "amount"
    ? Number(amount) / validPrice
    : Number(quantity);
  const normalizedQuantity = Number.isFinite(rawQuantity)
    ? wholeQuantityRequired && inputMode === "amount"
      ? Math.floor(rawQuantity + 1e-8)
      : rawQuantity
    : 0;
  const wholeQuantityInvalid = wholeQuantityRequired
    && inputMode === "quantity"
    && normalizedQuantity > 0
    && Math.abs(normalizedQuantity - Math.round(normalizedQuantity)) > 1e-8;
  const validQuantity = wholeQuantityRequired && inputMode === "quantity" && !wholeQuantityInvalid
    ? Math.round(normalizedQuantity)
    : normalizedQuantity;
  const validAmount = validQuantity * validPrice;
  const parsedFeeRate = optionalRateFromPercent(feeRate);
  const parsedTaxRate = optionalRateFromPercent(taxRate);
  const parsedMinimumFee = optionalNonNegative(minimumFee);
  const costProfilePatch: TransactionCostProfile = mode === "buy"
    ? { buyFeeRate: parsedFeeRate, buyTaxRate: parsedTaxRate, minimumFee: parsedMinimumFee }
    : { sellFeeRate: parsedFeeRate, sellTaxRate: parsedTaxRate, minimumFee: parsedMinimumFee };
  const costEstimate = estimateTransactionCosts(costProfilePatch, mode, validAmount);
  const fee = feeOverride ?? costInputValue(costEstimate.fee);
  const tax = taxOverride ?? costInputValue(costEstimate.tax);
  const numericFee = fee === "" ? 0 : Number(fee);
  const numericTax = tax === "" ? 0 : Number(tax);
  const validRules = (!feeRate.trim() || Number.isFinite(parsedFeeRate))
    && (!taxRate.trim() || Number.isFinite(parsedTaxRate))
    && (!minimumFee.trim() || Number.isFinite(parsedMinimumFee));
  const validCosts = validRules
    && Number.isFinite(numericFee) && numericFee >= 0
    && Number.isFinite(numericTax) && numericTax >= 0;
  const validDate = isValidYMD(date);
  const transactionCosts = validCosts ? numericFee + numericTax : 0;
  const unit = quantityUnit(holding.market, holding.assetType, language);
  const currency = holding.currency;
  const maxSellAmount = maxSell * (validPrice > 0 ? validPrice : holding.currentPrice);
  const exceedsSell = mode === "sell" && validQuantity > maxSell + 1e-8;
  const valid = validQuantity > 0
    && validPrice > 0
    && validAmount > 0
    && !wholeQuantityInvalid
    && !exceedsSell
    && validCosts
    && validDate;
  const estimatedQuantity = validPrice > 0 && Number.isFinite(validQuantity) ? validQuantity : 0;
  const estimatedAmount = validPrice > 0 && Number.isFinite(validAmount) ? validAmount : 0;
  const estimatedSettlement = mode === "buy"
    ? estimatedAmount + transactionCosts
    : Math.max(0, estimatedAmount - transactionCosts);
  const hasDraftRule = feeRate.trim() !== "" || taxRate.trim() !== "" || minimumFee.trim() !== "";
  const profileChanged = parsedFeeRate !== configuredFeeRate
    || parsedTaxRate !== configuredTaxRate
    || parsedMinimumFee !== configuredMinimumFee;
  const sellShortcuts = [
    { label: language === "en" ? "1/4" : "1/4仓", fraction: 0.25 },
    { label: language === "en" ? "1/3" : "1/3仓", fraction: 1 / 3 },
    { label: language === "en" ? "Half" : "半仓", fraction: 0.5 },
    { label: language === "en" ? "All" : "清仓", fraction: 1 },
  ];
  const formatShortcutInput = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return "";
    const fixed = value.toFixed(8).replace(/\.?0+$/, "");
    return fixed || "";
  };
  const sellShortcutQuantity = (fraction: number) => {
    const rawNextQuantity = Math.min(maxSell, maxSell * fraction);
    return wholeQuantityRequired
      ? (fraction >= 1 ? Math.floor(maxSell + 1e-8) : Math.floor(rawNextQuantity + 1e-8))
      : rawNextQuantity;
  };
  const applySellShortcut = (fraction: number) => {
    const nextQuantity = sellShortcutQuantity(fraction);
    if (!(nextQuantity > 0)) return;
    const nextPrice = validPrice > 0 ? validPrice : holding.currentPrice;
    setQuantity(formatShortcutInput(nextQuantity));
    if (nextPrice > 0) setAmount(formatShortcutInput(nextQuantity * nextPrice));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col justify-end"
      style={{ background: "var(--scrim)", zIndex: 55 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        className="flex flex-col rounded-t-2xl"
        style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)", maxHeight: "92%" }}
      >
        <div className="flex items-center justify-between px-4 shrink-0" style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>
            {mode === "buy" ? text.buy : text.sell}
          </span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>
        <div className="overflow-y-auto px-4 py-4 flex flex-col gap-3" style={{ scrollbarWidth: "none" }}>
          <div className="rounded-xl px-3 py-2.5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 700 }}>{holding.name}</p>
            <p style={{ color: "var(--text-secondary)", fontSize: 11 }}>{holding.symbol} · {language === "en" ? "Current" : "当前持仓"} {formatHoldingQuantity(holding.quantity)} {unit}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl p-1" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            {([
              ["quantity", text.byQuantity],
              ["amount", text.byAmount],
            ] as const).map(([value, label]) => {
              const active = inputMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setInputMode(value)}
                  className="rounded-lg py-2"
                  style={{
                    background: active ? "rgba(79,156,249,0.16)" : "transparent",
                    color: active ? "#4F9CF9" : "var(--text-secondary)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={text.transactionDate}>
              <Input value={date} onChange={setDate} placeholder={text.inputTransactionDate} />
            </Field>
            <Field label={text.transactionPrice}>
              <Input type="number" value={price} onChange={setPrice} placeholder={text.inputTransactionPrice} />
            </Field>
          </div>
          {!validDate && (
            <p style={{ color: "#F24E4E", fontSize: 11 }}>{text.transactionDateError}</p>
          )}
          {mode === "sell" && (
            <div className="grid grid-cols-4 gap-2">
              {sellShortcuts.map((item) => {
                const shortcutQuantity = sellShortcutQuantity(item.fraction);
                const disabled = !(shortcutQuantity > 0);
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => applySellShortcut(item.fraction)}
                    disabled={disabled}
                    className="rounded-lg py-2"
                    style={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      color: disabled ? "var(--text-micro)" : item.fraction === 1 ? "#F24E4E" : "var(--text-secondary)",
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled ? 0.55 : 1,
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
          {inputMode === "quantity" ? (
            <Field label={mode === "buy" ? text.buyQuantity(unit) : text.sellQuantity(unit)}>
              <Input
                type="number"
                value={quantity}
                onChange={setQuantity}
                placeholder={mode === "buy" ? text.inputBuyQuantity : text.max(formatHoldingQuantity(maxSell))}
              />
            </Field>
          ) : (
            <Field label={mode === "buy" ? text.buyAmount(currency) : text.sellAmount(currency)}>
              <Input
                type="number"
                value={amount}
                onChange={setAmount}
                placeholder={mode === "buy" ? text.inputBuyAmount : text.max(formatExactMoney(maxSellAmount, currency))}
              />
            </Field>
          )}
          <div>
            <p style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>{text.transactionCosts}</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label={text.currentFeeRate}>
                <Input type="number" step="0.01" min="0" max="100" value={feeRate} onChange={(value) => { setFeeRate(value); setFeeOverride(null); }} placeholder="0.03" />
              </Field>
              <Field label={text.currentTaxRate}>
                <Input type="number" step="0.01" min="0" max="100" value={taxRate} onChange={(value) => { setTaxRate(value); setTaxOverride(null); }} placeholder="0" />
              </Field>
            </div>
            <div className="mt-2">
              <Field label={text.minimumFee(currency)}>
                <Input type="number" step="0.01" min="0" value={minimumFee} onChange={(value) => { setMinimumFee(value); setFeeOverride(null); }} placeholder="0" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Field label={text.actualFee(currency)}>
                <Input type="number" step="0.01" min="0" value={fee} onChange={setFeeOverride} placeholder="0" />
              </Field>
              <Field label={text.actualTax(currency)}>
                <Input type="number" step="0.01" min="0" value={tax} onChange={setTaxOverride} placeholder="0" />
              </Field>
            </div>
            {(feeOverride != null || taxOverride != null) && (
              <button
                type="button"
                onClick={() => { setFeeOverride(null); setTaxOverride(null); }}
                style={{ color: "#4F9CF9", fontSize: 10, fontWeight: 700, marginTop: 6 }}
              >
                {text.resetCostEstimate}
              </button>
            )}
            {validAmount > 0 && hasDraftRule && (
              <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 5 }}>
                {text.costEstimateDetail(formatExactMoney(costEstimate.fee + costEstimate.tax, currency))}
              </p>
            )}
            <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 5, lineHeight: 1.45 }}>{text.transactionCostsHint}</p>
            {hasDraftRule && profileChanged && (
              <button
                type="button"
                role="checkbox"
                aria-checked={rememberCostProfile}
                onClick={() => setRememberCostProfile((value) => !value)}
                className="flex items-center gap-2 mt-2 text-left"
                style={{ color: rememberCostProfile ? "#4F9CF9" : "var(--text-secondary)", fontSize: 11, fontWeight: 600 }}
              >
                <span className="flex items-center justify-center rounded" style={{ width: 16, height: 16, border: `1px solid ${rememberCostProfile ? "#4F9CF9" : "var(--border)"}`, background: rememberCostProfile ? "rgba(79,156,249,0.14)" : "var(--bg-card)" }}>
                  {rememberCostProfile && <Check size={12} />}
                </span>
                {hasConfiguredRule ? text.updateCostProfile : text.saveCostProfile}
              </button>
            )}
          </div>
          {(estimatedQuantity > 0 || estimatedAmount > 0) && (
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(79,156,249,0.08)", border: "1px solid rgba(79,156,249,0.14)" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                {text.estimatedTrade(mode, formatHoldingQuantity(estimatedQuantity), unit)}
                <span style={{ color: "var(--text-micro)" }}> · </span>
                {formatExactMoney(estimatedAmount, currency)}
              </p>
              <p style={{ color: "var(--text-secondary)", fontSize: 10, marginTop: 2 }}>
                {text.estimatedSettlement(mode)} {formatExactMoney(estimatedSettlement, currency)}
                {transactionCosts > 0 && ` · ${text.costsIncluded(formatExactMoney(transactionCosts, currency))}`}
              </p>
              {mode === "sell" && estimatedQuantity > 0 && (
                <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 2 }}>
                  {text.remaining(formatHoldingQuantity(Math.max(0, maxSell - estimatedQuantity)), unit)}
                </p>
              )}
            </div>
          )}
          {exceedsSell && (
            <p style={{ color: "#F24E4E", fontSize: 11 }}>
              {inputMode === "amount" ? text.sellAmountError : text.sellQuantityError}
            </p>
          )}
          {wholeQuantityInvalid && (
            <p style={{ color: "#F24E4E", fontSize: 11 }}>
              {text.wholeQuantityError(unit)}
            </p>
          )}
          <button
            onClick={() => {
              if (!valid || saving) return;
              setSaving(true);
              onSave({
                type: mode,
                quantity: validQuantity,
                price: validPrice,
                date,
                fee: numericFee,
                tax: numericTax,
                costProfilePatch,
                rememberCostProfile: hasDraftRule && profileChanged && rememberCostProfile,
                feeRateUsed: Number.isFinite(parsedFeeRate) ? parsedFeeRate : undefined,
                taxRateUsed: Number.isFinite(parsedTaxRate) ? parsedTaxRate : undefined,
                minimumFeeUsed: Number.isFinite(parsedMinimumFee) ? parsedMinimumFee : undefined,
                estimatedFee: costEstimate.fee,
                estimatedTax: costEstimate.tax,
              });
            }}
            disabled={!valid || saving}
            className="w-full rounded-xl py-3"
            style={{
              background: valid && !saving ? (mode === "buy" ? "linear-gradient(135deg, #4F9CF9, #7C3AED)" : "rgba(242,78,78,0.15)") : "var(--bg-card)",
              color: valid && !saving ? (mode === "buy" ? "#fff" : "#F24E4E") : "var(--text-micro)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {saving ? t(language).common.saving : mode === "buy" ? text.confirmBuy : text.confirmSell}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── Holding card ───────────────────────────────────── */
const HoldingCard = memo(function HoldingCard({
  h, groups, dcaPlans, onEdit, onDelete, onQuote, onDCA, onBuy, onSell, isSelected, onSelect,
}: {
  h: Holding; groups: Group[]; isSelected: boolean;
  dcaPlans: DCAPlan[];
  onEdit: (h: Holding) => void; onDelete: (id: string) => void; onQuote: (h: Holding) => void; onDCA: (h: Holding) => void; onBuy: (h: Holding) => void; onSell: (h: Holding) => void; onSelect: (id: string) => void;
}) {
  const { profitColor, privacyMode, language } = useApp();
  const text = t(language).holdings;
  const [hovered, setHovered] = useState(false);
  const todayC    = profitColor(h.todayPnl);
  const totalPnl  = holdingTotalPnl(h);
  const totalRate = holdingTotalPnlRate(h);
  const todayDividend = todayDividendAmount(h);
  const totalC    = profitColor(totalPnl);
  const badge     = getSecurityBadge(h.market, h.assetType, language);
  const group     = groups.find((g) => g.id === h.groupId);
  const sign      = pnlSign;
  const borderColor = isSelected || hovered ? "rgba(79,156,249,0.2)" : "var(--border-sub)";
  const sym = currencySymbol(h.currency);
  const priceDecimals = holdingUnitPriceDecimals(h);
  const fmtMoney = (p: number) => sym + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtUnitPrice = (p: number) => sym + p.toLocaleString("en-US", { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals });
  const marketValueText = fmtMoney(holdingMarketValue(h));
  const todayPnlText = fmtMoney(Math.abs(h.todayPnl));
  const tradeStatus = resolveHoldingTradeStatus(h);
  const tradeStatusColor = tradeStatus.status === "normal"
    ? "#31D08B"
    : tradeStatus.status === "suspended"
      ? "#F24E4E"
      : tradeStatus.status === "fund_limit"
        ? "#F59E0B"
        : "#94A3B8";
  const tsSource = translateTradeText(cleanTradeSource(tradeStatus.source), language);
  const tsLabel = translateTradeText(tradeStatus.label, language);
  const tsNote = translateTradeText(cleanTradeNote(tradeStatus.note, tradeStatus.label), language);
  const tsLabelFull = tsNote ? `${tsLabel}, ${tsNote}` : tsLabel;
  const tradeStatusText = tsSource ? `${tsSource} · ${tsLabelFull}` : tsLabelFull;
  const activeDCAPlans = dcaPlans.filter((plan) => plan.holdingId === h.id && plan.enabled);
  const pausedDCAPlans = dcaPlans.filter((plan) => plan.holdingId === h.id && !plan.enabled);
  const dcaBadge = activeDCAPlans.length > 0
    ? { label: activeDCAPlans.length > 1 ? `${text.dca}×${activeDCAPlans.length}` : text.dca, color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" }
    : pausedDCAPlans.length > 0
      ? { label: text.dcaPaused, color: "#94A3B8", bg: "rgba(148,163,184,0.12)" }
      : null;
  const priceDateLabel = h.priceDate
    ? `${h.market === "FUND" || h.assetType === "fund" ? text.nav : text.quote} ${h.priceDate.slice(5).replace("-", "/")}`
    : "";

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      className="relative rounded-xl overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:        isSelected ? "rgba(79,156,249,0.06)" : "var(--bg-card)",
        borderStyle:       "solid",
        borderWidth:       1,
        borderColor,
        transition:        "background 0.15s, border-color 0.15s",
      }}>
      <button className="w-full text-left px-3 pt-3 pb-2" onClick={() => onSelect(h.id)}>
        <div className="flex items-start">
          <div className="flex-1 min-w-0 mr-2">
            <div className="flex items-center gap-2 mb-0.5">
              <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{h.symbol}</span>
              <span className="rounded px-1.5 py-0.5" style={{ fontSize: 9, fontWeight: 600, color: badge.color, background: badge.bg }}>{badge.label}</span>
              {dcaBadge && (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ fontSize: 9, fontWeight: 700, color: dcaBadge.color, background: dcaBadge.bg }}>
                  <Repeat2 size={9} /> {dcaBadge.label}
                </span>
              )}
              {group && <span style={{ fontSize: 9, color: group.color, opacity: 0.8 }}>{groupName(group.id, group.name, language)}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="truncate" style={{ color: "var(--text-secondary)", fontSize: 11 }}>{h.name}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                {privacyMode ? "***" : formatHoldingQuantity(h.quantity)} {quantityUnit(h.market, h.assetType, language)} ×
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 500, whiteSpace: "nowrap" }}>{fmtUnitPrice(h.currentPrice)}</span>
              {priceDateLabel && (
                <span style={{ color: "var(--text-micro)", fontSize: 9, whiteSpace: "nowrap" }}>{priceDateLabel}</span>
              )}
            </div>
            {(h.market === "FUND" || h.assetType === "fund") && h.estimatedNav != null && h.estimatedNav > 0 && (
              <div className="mt-0.5 flex items-center gap-1">
                <span style={{ color: "var(--text-micro)", fontSize: 9 }}>{text.estimated}</span>
                <span style={{ color: "#F59E0B", fontSize: 9, fontWeight: 600 }}>{h.estimatedNav.toFixed(4)}</span>
                {h.estimatedChangePercent != null && Number.isFinite(h.estimatedChangePercent) && (
                  <span style={{
                    color: profitColor(h.estimatedChangePercent),
                    fontSize: 9, fontWeight: 600,
                  }}>
                    {formatPercent(h.estimatedChangePercent)}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1">
              <span style={{ color: tradeStatusColor, fontSize: 10 }}>
                {tradeStatusText}
              </span>
            </div>
            {todayDividend > 0 && (
              <div className="mt-0.5">
                <span style={{ color: "#31D08B", fontSize: 10, fontWeight: 600 }}>
                  {language === "en" ? "Dividend" : "分红"} {privacyMode ? `${currencySymbol(h.currency)}--` : fmtMoney(todayDividend)}
                </span>
              </div>
            )}
            {canConfigureDividendReinvest(h) && typeof h.dividendReinvest === "boolean" && (
              <div className="mt-0.5">
                <span style={{ color: "var(--text-micro)", fontSize: 9 }}>
                  {h.dividendReinvest
                    ? (language === "en" ? "Dividend: Reinvest" : "分红：再投")
                    : (language === "en" ? "Dividend: Cash" : "分红：现金")}
                </span>
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
              {privacyMode ? `${sym || h.currency}***` : marketValueText}
            </p>
            <p style={{ color: todayC, fontSize: 11, marginTop: 1 }}>
              {sign(h.todayPnl)}{privacyMode ? `${sym || h.currency}--` : todayPnlText}
              &nbsp;<span style={{ fontSize: 10 }}>({`${sign(h.todayPnlRate)}${(Number.isFinite(h.todayPnlRate) ? h.todayPnlRate * 100 : 0).toFixed(2)}%`})</span>
            </p>
            <p style={{ color: totalC, fontSize: 10, marginTop: 1 }}>
              {language === "en" ? "Total" : "累计"} {sign(totalRate)}{(totalRate * 100).toFixed(2)}%
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-2 pt-2" style={{ borderTop: "1px solid var(--border-sub)" }}>
          <div className="flex items-center justify-between mb-1">
            <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{text.cost} <span style={{ color: "var(--text-secondary)" }}>{fmtUnitPrice(h.costPrice)}</span></span>
            <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{text.price} <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{fmtUnitPrice(h.currentPrice)}</span></span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 3, background: "var(--bg-surface2)" }}>
            <div className="h-full rounded-full" style={{
              width: h.costPrice > 0
                ? `${Math.min(100, Math.max(0, ((h.currentPrice - h.costPrice) / h.costPrice + 1) * 50))}%`
                : "0%",
              background: totalC, transition: "width 0.3s",
            }} />
          </div>
        </div>
      </button>

      {/* Action row */}
      <div
        className="overflow-hidden"
        style={{
          height: isSelected ? 88 : 0,
          transition: "height 0.18s ease",
          borderTop: `1px solid ${isSelected ? "var(--border)" : "transparent"}`,
        }}
      >
        <div className="px-3 py-2 grid grid-cols-3 gap-2" style={{ minHeight: 88 }}>
          <button onClick={() => onQuote(h)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA", fontSize: 11 }}>
            <LineChart size={11} /> {text.quote}
          </button>
          <button onClick={() => onBuy(h)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(49,208,139,0.1)", color: "#31D08B", fontSize: 11 }}>
            <Plus size={11} /> {text.buy}
          </button>
          <button onClick={() => onSell(h)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(245,158,11,0.1)", color: "#F59E0B", fontSize: 11 }}>
            <Minus size={11} /> {text.sell}
          </button>
          <button onClick={() => onDCA(h)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9", fontSize: 11 }}>
            <CalendarClock size={11} /> {text.dca}
          </button>
          <button onClick={() => onEdit(h)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9", fontSize: 11 }}>
            <Pencil size={11} /> {t(language).common.edit}
          </button>
          <button onClick={() => onDelete(h.id)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(242,78,78,0.08)", color: "#F24E4E", fontSize: 11 }}>
            <Trash2 size={11} /> {t(language).common.delete}
          </button>
        </div>
      </div>
    </motion.div>
  );
});

/* ─── Groups view ────────────────────────────────────── */
function GroupsView({ groups, holdings, dcaPlans, baseCurrency, selectedId, onSelectHolding, onEditHolding, onDeleteHolding, onQuote, onDCA, onBuy, onSell }: {
  groups: Group[]; holdings: Holding[];
  dcaPlans: DCAPlan[];
  baseCurrency: string;
  selectedId: string | null;
  onSelectHolding: (id: string) => void;
  onEditHolding: (holding: Holding) => void;
  onDeleteHolding: (id: string) => void;
  onQuote: (h: Holding) => void;
  onDCA: (h: Holding) => void;
  onBuy: (h: Holding) => void;
  onSell: (h: Holding) => void;
}) {
  const { privacyMode, profitColor, language } = useApp();
  const text = t(language).holdings;
  const [expanded, setExpanded] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map: Record<string, Holding[]> = {};
    for (const g of groups) map[g.id] = [];
    map[""] = []; // ungrouped
    for (const h of holdings) {
      const key = h.groupId ?? "";
      if (map[key]) map[key].push(h);
      else map[""].push(h); // orphaned groupId → ungrouped
    }
    return map;
  }, [groups, holdings]);

  const totalAll = useMemo(
    () => holdings.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, baseCurrency), 0),
    [baseCurrency, holdings],
  );

  const groupStatsById = useMemo(() => {
    const stats = new Map<string, { total: number; todayPnl: number; pct: number }>();
    const calculate = (gHoldings: Holding[]) => {
      const total = gHoldings.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, baseCurrency), 0);
      const todayPnl = gHoldings.reduce((s, h) => s + convertAmount(h.todayPnl, h.currency, baseCurrency), 0);
      return { total, todayPnl, pct: totalAll > 0 ? total / totalAll * 100 : 0 };
    };
    for (const group of groups) {
      stats.set(group.id, calculate(grouped[group.id] ?? []));
    }
    stats.set("__ungrouped", calculate(grouped[""] ?? []));
    return stats;
  }, [baseCurrency, grouped, groups, totalAll]);

  const allocationGroups = [
    ...groups.map((group) => ({
      id: group.id,
      name: groupName(group.id, group.name, language),
      color: group.color,
      holdings: grouped[group.id] ?? [],
    })),
    {
      id: "__ungrouped",
      name: t(language).common.notGrouped,
      color: "var(--text-micro)",
      holdings: grouped[""] ?? [],
    },
  ].filter((group) => group.holdings.length > 0 && (groupStatsById.get(group.id)?.total ?? 0) > 0);

  return (
    <div className="flex flex-col gap-2 px-3">
      {/* Total allocation bar */}
      {allocationGroups.length > 0 && (
        <div className="rounded-xl p-3 mb-1" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 6 }}>{text.groupAssetRatio}</p>
          <div className="flex rounded-full overflow-hidden gap-px" style={{ height: 6 }}>
            {allocationGroups.map((g) => {
              const pct = groupStatsById.get(g.id)?.pct ?? 0;
              return pct > 0 ? <div key={g.id} style={{ width: `${pct}%`, background: g.color, borderRadius: 99 }} /> : null;
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {allocationGroups.map((g) => {
              const { pct } = groupStatsById.get(g.id) ?? { pct: 0 };
              return (
                <div key={g.id} className="flex items-center gap-1">
                  <div className="rounded-full" style={{ width: 6, height: 6, background: g.color }} />
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{g.name}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>{formatPercent(pct / 100)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Group cards */}
      {groups.map((g, i) => {
        const gHoldings = grouped[g.id] ?? [];
        const stats     = groupStatsById.get(g.id) ?? { total: 0, todayPnl: 0, pct: 0 };
        const isOpen    = expanded === g.id;
        const todayC    = profitColor(stats.todayPnl);

        return (
          <motion.div layout key={g.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.2) }}
            className="relative rounded-xl overflow-hidden"
            style={{
              background: "var(--bg-card)",
              borderStyle: "solid",
              borderWidth: 1,
              borderColor: "var(--border)",
            }}>
            <div
              aria-hidden="true"
              className="absolute left-0 top-0 bottom-0"
              style={{ width: 3, background: g.color }}
            />

            <div
              className="w-full flex items-center px-3 py-3"
              role="button"
              tabIndex={0}
              onClick={() => setExpanded(isOpen ? null : g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded(isOpen ? null : g.id);
                }
              }}
            >
              <div className="rounded-full mr-3 shrink-0" style={{ width: 8, height: 8, background: g.color, boxShadow: `0 0 5px ${g.color}80` }} />
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{groupName(g.id, g.name, language)}</span>
                  <span className="rounded-full px-1.5" style={{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg-surface2)" }}>
                    {language === "en" ? gHoldings.length : `${gHoldings.length} 只`}
                  </span>
                </div>
              </div>
              <div className="text-right mr-2">
                <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
                  {privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(stats.total, baseCurrency)}
                </p>
                <p style={{ color: todayC, fontSize: 10 }}>
                  {pnlSign(stats.todayPnl)}{privacyMode ? `${currencySymbol(baseCurrency)}--` : formatSummaryMoney(stats.todayPnl, baseCurrency)}
                </p>
              </div>
              <ChevronRight size={14} color="var(--text-muted)"
                style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} />
            </div>

            <AnimatePresence>
              {isOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: "hidden" }}>
                  <div className="px-3 pb-2" style={{ borderTop: "1px solid var(--border)" }}>
                    {gHoldings.length === 0 ? (
                      <p style={{ color: "var(--text-micro)", fontSize: 12, textAlign: "center", padding: "12px 0" }}>
                        {text.noHoldingsInGroup}
                      </p>
                    ) : (
                      gHoldings.map((h) => {
                        return (
                          <div key={h.id} className="pt-2">
                            <HoldingCard
                              h={h}
                              groups={groups}
                              dcaPlans={dcaPlans}
                              isSelected={selectedId === h.id}
                              onSelect={onSelectHolding}
                              onEdit={onEditHolding}
                              onDelete={onDeleteHolding}
                              onQuote={onQuote}
                              onDCA={onDCA}
                              onBuy={onBuy}
                              onSell={onSell}
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}

      {/* Ungrouped */}
      {(grouped[""]?.length ?? 0) > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <button className="w-full flex items-center px-3 py-2.5" onClick={() => setExpanded(expanded === "__ungrouped" ? null : "__ungrouped")}>
            <div className="rounded-full mr-3 shrink-0" style={{ width: 8, height: 8, background: "var(--text-micro)" }} />
            <span style={{ color: "var(--text-muted)", fontSize: 12, flex: 1, textAlign: "left" }}>{t(language).common.notGrouped}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11, marginRight: 8 }}>{language === "en" ? (grouped[""]?.length ?? 0) : `${grouped[""]?.length ?? 0} 只`}</span>
            <ChevronRight size={14} color="var(--text-muted)" style={{ transform: expanded === "__ungrouped" ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} />
          </button>
          <AnimatePresence>
            {expanded === "__ungrouped" && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: "hidden" }}>
                <div className="px-3 pb-2" style={{ borderTop: "1px solid var(--border)" }}>
	                  {(grouped[""] ?? []).map((h) => {
                    return (
                      <div key={h.id} className="pt-2">
                        <HoldingCard
                          h={h}
                          groups={groups}
                          dcaPlans={dcaPlans}
                          isSelected={selectedId === h.id}
                          onSelect={() => onSelectHolding(h.id)}
                          onEdit={() => onEditHolding(h)}
                          onDelete={() => onDeleteHolding(h.id)}
                          onQuote={() => onQuote(h)}
                          onDCA={() => onDCA(h)}
                          onBuy={() => onBuy(h)}
                          onSell={() => onSell(h)}
                        />
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {groups.length === 0 && (grouped[""]?.length ?? 0) === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Circle size={30} color="var(--text-micro)" />
          <p style={{ color: "var(--text-micro)", fontSize: 13 }}>{text.noGroups}</p>
        </div>
      )}
    </div>
  );
}

/* ─── Group sheet ────────────────────────────────────── */
function NewGroupSheet({
  initial,
  title = "新建分组",
  saveLabel = "确认创建",
  onSave,
  onClose,
}: {
  initial?: Pick<Group, "name" | "color">;
  title?: string;
  saveLabel?: string;
  onSave: (name: string, color: string) => void;
  onClose: () => void;
}) {
  const { language } = useApp();
  const text = t(language).holdings;
  const [name,  setName]  = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? DEFAULT_GROUP_COLOR);
  const [saving, setSaving] = useState(false);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 flex items-end" style={{ background: "var(--scrim)", zIndex: 50 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="w-full rounded-t-2xl p-5" style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between mb-4">
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>{title}</span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ color: "var(--text-muted)", fontSize: 11, display: "block", marginBottom: 4 }}>{text.groupName}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={text.groupNamePlaceholder}
              className="w-full rounded-xl px-3"
              style={{ height: 38, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
          </div>
          <div>
            <label style={{ color: "var(--text-muted)", fontSize: 11, display: "block", marginBottom: 8 }}>{text.groupColor}</label>
            <div className="flex gap-2 flex-wrap">
              {colorOptions.map((c) => (
                <button key={c} onClick={() => setColor(c)} className="rounded-full transition-transform"
                  style={{ width: 26, height: 26, background: c,
                    border: color === c ? "3px solid white" : "3px solid transparent",
                    boxShadow: color === c ? `0 0 8px ${c}` : "none",
                    transform: color === c ? "scale(1.15)" : "scale(1)" }} />
              ))}
            </div>
          </div>
          <button onClick={() => {
            if (!name.trim() || saving) return;
            setSaving(true);
            onSave(name.trim(), color || DEFAULT_GROUP_COLOR);
            onClose();
          }}
            disabled={!name.trim() || saving} className="w-full rounded-xl py-3"
            style={{ background: name.trim() && !saving ? "linear-gradient(135deg, #4F9CF9, #7C3AED)" : "var(--bg-card)",
              color: name.trim() && !saving ? "white" : "var(--text-micro)", fontSize: 13, fontWeight: 600 }}>
            {saving ? t(language).common.saving : saveLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════
   Main page
══════════════════════════════════════════════════════════ */
export function Holdings() {
  const { holdings, closedHoldings, groups, privacyMode, profitColor, currency,
    addHolding, updateHolding, adjustHolding, removeHolding, removeClosedHolding, updatePortfolioEvent, removePortfolioEvent, addGroup, updateGroup, removeGroup,
    openDetail, refresh, isRefreshing, lastRefreshed, lastRefreshAt, lastRefreshError, dcaPlans, openDCAPanel, togglePrivacy, language,
    portfolioEvents } = useApp();
  const text = t(language);

  const [viewMode,     setViewMode]     = useState<"current" | "closed">("current");
  const [activeGroup,  setActiveGroup]  = useState("ALL");
  const [search,       setSearch]       = useState("");
  const [sortKey,      setSortKey]      = useState<"marketValue" | "todayPnlRate" | "totalPnlRate">("marketValue");
  const [sortDesc,     setSortDesc]     = useState(true);
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [sheetMode,    setSheetMode]    = useState<"add" | "edit" | null>(null);
  const [editTarget,   setEditTarget]   = useState<Holding | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<{ holding: Holding; mode: "buy" | "sell" } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteClosedTarget, setDeleteClosedTarget] = useState<string | null>(null);
  const [deleteEventTarget, setDeleteEventTarget] = useState<PortfolioEvent | null>(null);
  const [editEventTarget, setEditEventTarget] = useState<PortfolioEvent | null>(null);
  const [editEventAmount, setEditEventAmount] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editEventNote, setEditEventNote] = useState("");
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const skippedInitialAutoRefreshRef = useRef(false);

  useEffect(() => {
    if (!skippedInitialAutoRefreshRef.current) {
      skippedInitialAutoRefreshRef.current = true;
      return;
    }
    if (isRefreshing) return;
    if (!lastRefreshAt) return;
    if (Date.now() - lastRefreshAt < 30_000) return;
    void refresh();
  }, [isRefreshing, lastRefreshAt, refresh]);

  /* filtered + sorted holdings */
  const filtered = useMemo(() => {
    const sortValue = (holding: Holding) => {
      switch (sortKey) {
        case "todayPnlRate":
          return holdingTodayPnlRate(holding);
        case "totalPnlRate":
          return holdingTotalPnlRate(holding);
        case "marketValue":
        default:
          return convertAmount(holdingMarketValue(holding), holding.currency, "CNY");
      }
    };
    return holdings
      .filter((h) => {
        if (activeGroup === "__ungrouped" && h.groupId) return false;
        if (activeGroup !== "ALL" && activeGroup !== "__ungrouped" && h.groupId !== activeGroup) return false;
        const query = search.trim().toLowerCase();
        if (query && !h.symbol.toLowerCase().includes(query) && !h.name.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => {
        const av = sortValue(a);
        const bv = sortValue(b);
        const diff = av - bv;
        return sortDesc ? -diff : diff;
      });
  }, [holdings, activeGroup, search, sortKey, sortDesc]);

  const activeGroupMeta = activeGroup === "ALL"
    ? null
    : groups.find((group) => group.id === activeGroup) ?? null;
  const hasUngroupedHoldings = holdings.some((holding) => !holding.groupId);
  const hasUngroupedClosedHoldings = closedHoldings.some((holding) => !holding.groupId);

  useEffect(() => {
    if (activeGroup === "ALL") return;
    if (activeGroup === "__ungrouped") {
      const hasUngroupedInView = viewMode === "closed" ? hasUngroupedClosedHoldings : hasUngroupedHoldings;
      if (!hasUngroupedInView) setActiveGroup("ALL");
      return;
    }
    if (!groups.some((group) => group.id === activeGroup)) {
      setActiveGroup("ALL");
    }
  }, [activeGroup, groups, hasUngroupedClosedHoldings, hasUngroupedHoldings, viewMode]);

  const filteredClosedHoldings = useMemo(() => {
    return closedHoldings.filter((item) => {
      if (activeGroup === "__ungrouped" && item.groupId) return false;
      if (activeGroup !== "ALL" && activeGroup !== "__ungrouped" && item.groupId !== activeGroup) return false;
      const query = search.trim().toLowerCase();
      if (query && !item.symbol.toLowerCase().includes(query) && !item.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [activeGroup, closedHoldings, search]);

  const holdingById = useMemo(() => new Map(holdings.map((holding) => [holding.id, holding])), [holdings]);
  const closedById = useMemo(() => new Map(closedHoldings.map((holding) => [holding.id, holding])), [closedHoldings]);
  const filteredRealizedEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return portfolioEvents.filter((event) => {
      if (!REALIZED_HISTORY_EVENT_TYPES.has(event.type)) return false;
      // Sale fees/taxes are already included in their closed-position summary
      // and are shown inside that card. Keeping them as standalone rows would
      // count the same cost twice in the realized-income header.
      if ((event.type === "fee" || event.type === "tax") && event.relatedEventId && closedById.has(event.relatedEventId)) {
        return false;
      }
      const linkedHolding = event.holdingId ? holdingById.get(event.holdingId) : undefined;
      const linkedClose = event.relatedEventId ? closedById.get(event.relatedEventId) : undefined;
      const groupId = event.groupId ?? linkedHolding?.groupId ?? linkedClose?.groupId ?? "";
      if (activeGroup === "__ungrouped" && groupId) return false;
      if (activeGroup !== "ALL" && activeGroup !== "__ungrouped" && groupId !== activeGroup) return false;
      if (query) {
        const symbol = (event.symbol || linkedHolding?.symbol || "").toLowerCase();
        const name = (event.name || linkedHolding?.name || "").toLowerCase();
        if (!symbol.includes(query) && !name.includes(query)) return false;
      }
      return true;
    });
  }, [activeGroup, closedById, holdingById, portfolioEvents, search]);

  /* ── strip stats: reflect current tab/filter context, all values in CNY ── */
  const stripStats = useMemo(() => {
    const source = filtered;
    const totalAsset   = source.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, currency), 0);
    const todayPnl     = source.reduce((s, h) => s + convertAmount(h.todayPnl, h.currency, currency), 0);
    const cumulPnl     = source.reduce((s, h) => s + convertAmount(holdingTotalPnl(h), h.currency, currency), 0);
    return { totalAsset, todayPnl, cumulPnl };
  }, [currency, filtered]);

  /* ── closed-history strip stats: realized P/L, cost basis, proceeds ── */
  const closedStripStats = useMemo(() => {
    const proceeds = filteredClosedHoldings.reduce((s, h) => s + convertAmount(h.proceeds, h.currency, currency), 0);
    const cost     = filteredClosedHoldings.reduce((s, h) => s + convertAmount(h.costBasis, h.currency, currency), 0);
    // Legacy ClosedHolding.realizedPnl includes its lifetime cash dividends.
    // Dividends are represented by event rows, so remove them from the close
    // summary before merging the two ledgers.
    const closedPnl = filteredClosedHoldings.reduce((s, h) => (
      s + convertAmount(h.realizedPnl - (h.cashDividendTotal ?? 0), h.currency, currency)
    ), 0);
    const eventPnl = filteredRealizedEvents.reduce((sum, event) => {
      const amountInBase = Number.isFinite(event.amountInBase)
        ? event.amountInBase
        : convertAmount(event.amount, event.currency, "CNY");
      return sum + convertAmount(amountInBase, "CNY", currency);
    }, 0);
    return { proceeds, cost, pnl: closedPnl + eventPnl };
  }, [currency, filteredClosedHoldings, filteredRealizedEvents]);
  const realizedRecordCount = filteredClosedHoldings.length + filteredRealizedEvents.length;

  const stripTodayColor = profitColor(stripStats.todayPnl);
  const stripCumulColor = profitColor(stripStats.cumulPnl);
  const stripClosedPnlColor = profitColor(closedStripStats.pnl);

  const openQuote = useCallback((h: Holding) => {
    openDetail({
      yahooSymbol: toYahooSymbol(h.symbol, h.market),
      displaySymbol: h.symbol,
      name: h.name,
      market: h.market,
      assetType: h.assetType,
      showCurrency: true,
      fallbackQuote: {
        price: h.currentPrice,
        change: holdingRateChange(h.currentPrice, h.todayPnlRate),
        changePercent: h.todayPnlRate,
        currency: h.currency,
        exchange: "Holding",
      },
    });
  }, [openDetail]);

  // Stable handlers for HoldingCard — avoids creating new closures on every render,
  // which would defeat React.memo and re-render all 500+ cards on each price tick.
  const handleSelectHolding = useCallback((id: string) => {
    setSelectedId((current) => current === id ? null : id);
  }, []);
  const handleEditHolding = useCallback((h: Holding) => {
    setEditTarget(h); setSheetMode("edit"); setSelectedId(null);
  }, []);
  const handleDeleteHolding = useCallback((id: string) => {
    setDeleteTarget(id);
  }, []);
  const handleDCA = useCallback((h: Holding) => {
    setSelectedId(null); openDCAPanel(h.id);
  }, [openDCAPanel]);
  const handleBuy = useCallback((h: Holding) => {
    setSelectedId(null); setAdjustTarget({ holding: h, mode: "buy" });
  }, []);
  const handleSell = useCallback((h: Holding) => {
    setSelectedId(null); setAdjustTarget({ holding: h, mode: "sell" });
  }, []);

  const handleSave = (input: HoldingInput) => {
    if (sheetMode === "edit" && editTarget) updateHolding(editTarget.id, input);
    else addHolding(input);
    setSheetMode(null); setEditTarget(null);
  };

  const handleAdjustSave = (input: HoldingAdjustmentInput) => {
    if (!adjustTarget) return;
    adjustHolding(adjustTarget.holding.id, input);
    setAdjustTarget(null);
    setSelectedId(null);
  };

  const refreshingActive = isRefreshing || manualRefreshing;

  useEffect(() => {
    if (!isRefreshing) setManualRefreshing(false);
  }, [isRefreshing]);

  const handleRefresh = useCallback(() => {
    if (refreshingActive) return;
    setManualRefreshing(true);
    void refresh();
  }, [refresh, refreshingActive]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden">

      <div
        className="shrink-0 z-20"
        style={{
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          backdropFilter: "blur(14px)",
        }}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4"
          style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>{text.holdings.title}</span>
          <div className="ml-2 flex min-w-0 items-center gap-2">
            <span
              className="max-w-[70px] truncate"
              title={lastRefreshError || lastRefreshed}
              aria-label={lastRefreshError || lastRefreshed}
              style={{ color: lastRefreshError ? "#D97706" : "var(--text-muted)", fontSize: 11, fontWeight: lastRefreshError ? 600 : 400 }}
            >
              {lastRefreshError ? (language === "en" ? "Sync issue" : "同步异常") : lastRefreshed}
            </span>
            <button onClick={togglePrivacy}
              className="flex items-center justify-center rounded-lg"
              aria-label={privacyMode ? (language === "en" ? "Show sensitive data" : "显示敏感数据") : (language === "en" ? "Hide sensitive data" : "隐藏敏感数据")}
              title={privacyMode ? (language === "en" ? "Show sensitive data" : "显示敏感数据") : (language === "en" ? "Hide sensitive data" : "隐藏敏感数据")}
              style={{ width: 30, height: 30, background: "var(--bg-card)" }}>
              {privacyMode
                ? <EyeOff size={13} color="var(--text-muted)" />
                : <Eye size={13} color="var(--text-muted)" />}
            </button>
            <button onClick={handleRefresh}
              className="flex items-center justify-center rounded-lg"
              aria-label={text.common.refresh}
              aria-busy={refreshingActive}
              disabled={refreshingActive}
              style={{ width: 30, height: 30, background: "var(--bg-card)" }}>
              <RefreshCw
                size={13}
                color={refreshingActive ? "#4F9CF9" : "var(--text-muted)"}
                className={refreshingActive ? "animate-spin-smooth" : undefined}
              />
            </button>
            <button onClick={() => openDCAPanel()}
              className="flex size-[30px] items-center justify-center rounded-lg bg-app-card text-tm transition-colors hover:text-app-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(79,156,249,0.24)]"
              aria-label={text.dca.title}
              title={text.dca.title}>
              <CalendarClock size={13} />
            </button>
            <button onClick={() => setSheetMode("add")}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(79,156,249,0.15)", color: "#4F9CF9", fontSize: 11 }}>
              <Plus size={13} strokeWidth={2.5} /> {text.holdings.add}
            </button>
          </div>
        </div>

        {/* ── Summary strip ── */}
        <div className="flex gap-3 px-4 py-2.5" style={{ borderBottom: "1px solid var(--border-sub)" }}>
          {viewMode === "closed" ? (
            <>
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedProceeds}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(closedStripStats.proceeds, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedCost}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(closedStripStats.cost, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedPnl}</p>
                <p className="truncate" style={{ color: stripClosedPnlColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {pnlSign(closedStripStats.pnl)}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(closedStripStats.pnl, currency)}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.totalMarketValue}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(stripStats.totalAsset, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.todayPnl}</p>
                <p className="truncate" style={{ color: stripTodayColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {pnlSign(stripStats.todayPnl)}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(stripStats.todayPnl, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.cumulativePnl}</p>
                <p className="truncate" style={{ color: stripCumulColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {pnlSign(stripStats.cumulPnl)}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(stripStats.cumulPnl, currency)}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 px-4 py-2" style={{ borderBottom: "1px solid var(--border-sub)" }}>
          {([
            { key: "current" as const, label: language === "en" ? "Open Holdings" : "当前持仓" },
            { key: "closed" as const, label: language === "en" ? "Realized P/L" : "已实现收益" },
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => setViewMode(item.key)}
              className="flex-1 rounded-xl py-2 transition-colors"
              style={{
                background: viewMode === item.key ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                color: viewMode === item.key ? "#4F9CF9" : "var(--text-muted)",
                border: viewMode === item.key ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border-sub)",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {item.label}{item.key === "closed" ? ` · ${realizedRecordCount}` : ""}
            </button>
          ))}
        </div>

      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 16 }}
      >
        {viewMode === "closed" ? (
          <>
            <div style={{ padding: "14px 12px 8px" }}>
              <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "var(--bg-card)", height: 36, marginTop: 2 }}>
                <Search size={14} color="var(--text-muted)" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={text.holdings.searchPlaceholder}
                  style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: 13 }} />
                {search && <button onClick={() => setSearch("")} style={{ color: "var(--text-muted)", fontSize: 16 }}>×</button>}
              </div>
            </div>

            <div className="px-3 mb-2">
              <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
                <button key="ALL" onClick={() => setActiveGroup("ALL")}
                  className="rounded-full shrink-0 transition-all"
                  style={{
                    padding: "4px 12px", fontSize: 11, fontWeight: 500,
                    background: activeGroup === "ALL" ? "#4F9CF9" : "var(--bg-card)",
                    color:      activeGroup === "ALL" ? "#fff"    : "var(--text-muted)",
                    border:     activeGroup === "ALL" ? "1px solid transparent" : "1px solid var(--border)",
                  }}>
                  {text.common.all}
                </button>
                {groups.map((group) => (
                  <button
                    key={group.id}
                    onClick={() => setActiveGroup(group.id)}
                    className="rounded-full shrink-0 transition-all flex items-center gap-1.5"
                    style={{
                      padding: "4px 12px",
                      fontSize: 11,
                      fontWeight: 500,
                      background: activeGroup === group.id ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                      color: activeGroup === group.id ? "#4F9CF9" : "var(--text-muted)",
                      border: activeGroup === group.id ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                    }}
                  >
                    <span className="rounded-full" style={{ width: 6, height: 6, background: group.color, flexShrink: 0 }} />
                    {groupName(group.id, group.name, language)}
                  </button>
                ))}
                {hasUngroupedClosedHoldings && (
                  <button
                    onClick={() => setActiveGroup("__ungrouped")}
                    className="rounded-full shrink-0 transition-all flex items-center gap-1.5"
                    style={{
                      padding: "4px 12px",
                      fontSize: 11,
                      fontWeight: 500,
                      background: activeGroup === "__ungrouped" ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                      color: activeGroup === "__ungrouped" ? "#4F9CF9" : "var(--text-muted)",
                      border: activeGroup === "__ungrouped" ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                    }}
                  >
                    <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--text-micro)", flexShrink: 0 }} />
                    {text.common.notGrouped}
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 px-3 mb-1">
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {language === "en" ? `${realizedRecordCount} records` : `${realizedRecordCount} 条记录`}
              </span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>·</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>
                {activeGroup === "__ungrouped"
                  ? text.holdings.currentGroup(text.common.notGrouped)
                  : activeGroupMeta
                    ? text.holdings.currentGroup(groupName(activeGroupMeta.id, activeGroupMeta.name, language))
                    : text.holdings.allGroups(groups.length)}
              </span>
            </div>

            <ClosedHoldingsView
              items={filteredClosedHoldings}
              events={filteredRealizedEvents}
              baseCurrency={currency}
              privacyMode={privacyMode}
              profitColor={profitColor}
              onDelete={(id) => setDeleteClosedTarget(id)}
              onEditEvent={(event) => {
                setEditEventTarget(event);
                setEditEventAmount(String(Math.abs(event.amount)));
                setEditEventDate(event.date);
                setEditEventNote(event.note ?? "");
              }}
              onDeleteEvent={setDeleteEventTarget}
              language={language}
            />
          </>
        ) : (
        <>
          {/* Search */}
          <div style={{ padding: "14px 12px 8px" }}>
            <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "var(--bg-card)", height: 36, marginTop: 2 }}>
              <Search size={14} color="var(--text-muted)" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={text.holdings.searchPlaceholder}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: 13 }} />
              {search && <button onClick={() => setSearch("")} style={{ color: "var(--text-muted)", fontSize: 16 }}>×</button>}
            </div>
          </div>

          {/* Group filter */}
          <div className="px-3 mb-2">
            <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              <button key="ALL" onClick={() => setActiveGroup("ALL")}
                className="rounded-full shrink-0 transition-all"
                style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 500,
                  background: activeGroup === "ALL" ? "#4F9CF9" : "var(--bg-card)",
                  color:      activeGroup === "ALL" ? "#fff"    : "var(--text-muted)",
                  border:     activeGroup === "ALL" ? "1px solid transparent" : "1px solid var(--border)",
                }}>
                {text.common.all}
              </button>
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="rounded-full shrink-0 flex items-center overflow-hidden"
                  style={{
                    background: activeGroup === group.id ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color:      activeGroup === group.id ? "#4F9CF9"               : "var(--text-muted)",
                    border:     activeGroup === group.id ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                  }}
                >
                  <button onClick={() => setActiveGroup(group.id)}
                    className="flex items-center gap-1.5 transition-all"
                    style={{
                      padding: activeGroup === group.id ? "4px 8px 4px 12px" : "4px 12px",
                      fontSize: 11,
                      fontWeight: 500,
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: group.color, flexShrink: 0 }} />
                    {groupName(group.id, group.name, language)}
                  </button>
                  {activeGroup === group.id && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingGroup(group);
                        }}
                        className="flex items-center justify-center"
                        style={{
                          width: 24,
                          height: 24,
                          color: "#4F9CF9",
                        }}
                        title={`${text.common.edit} ${groupName(group.id, group.name, language)}`}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteGroupTarget(group);
                        }}
                        className="flex items-center justify-center"
                        style={{
                          width: 24,
                          height: 24,
                          color: "#4F9CF9",
                        }}
                        title={`${text.common.delete} ${groupName(group.id, group.name, language)}`}
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {hasUngroupedHoldings && (
                <button
                  onClick={() => setActiveGroup("__ungrouped")}
                  className="rounded-full shrink-0 transition-all flex items-center gap-1.5"
                  style={{
                    padding: "4px 12px",
                    fontSize: 11,
                    fontWeight: 500,
                    background: activeGroup === "__ungrouped" ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color: activeGroup === "__ungrouped" ? "#4F9CF9" : "var(--text-muted)",
                    border: activeGroup === "__ungrouped" ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                  }}
                >
                  <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--text-micro)", flexShrink: 0 }} />
                  {text.common.notGrouped}
                </button>
              )}
              <button onClick={() => setShowNewGroup(true)}
                className="rounded-full shrink-0"
                style={{
                  padding: "4px 12px",
                  fontSize: 11,
                  fontWeight: 500,
                  background: "rgba(79,156,249,0.12)",
                  color: "#4F9CF9",
                  border: "1px solid rgba(79,156,249,0.18)",
                }}>
                {text.holdings.addGroup}
              </button>
            </div>
          </div>

          {/* Sort */}
          <div className="flex items-center justify-between px-3 mb-2">
            <div className="flex items-center gap-2">
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{text.holdings.positionCount(filtered.length)}</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>·</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>
                {activeGroup === "__ungrouped"
                  ? text.holdings.currentGroup(text.common.notGrouped)
                  : activeGroupMeta
                    ? text.holdings.currentGroup(groupName(activeGroupMeta.id, activeGroupMeta.name, language))
                    : text.holdings.allGroups(groups.length)}
              </span>
            </div>
            <div className="flex gap-1.5">
              {([
                { k: "marketValue",  label: text.holdings.sortMarketValue },
                { k: "todayPnlRate", label: text.holdings.sortToday },
                { k: "totalPnlRate", label: text.holdings.sortTotal },
              ] as const).map(({ k, label }) => (
                <button key={k}
                  onClick={() => { if (sortKey === k) setSortDesc((v) => !v); else { setSortKey(k); setSortDesc(true); } }}
                  className="rounded-lg px-2 py-1 transition-colors"
                  style={{
                    background: sortKey === k ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color:      sortKey === k ? "#4F9CF9"               : "var(--text-muted)",
                    fontSize: 10,
                  }}>
                  {label} {sortKey === k ? (sortDesc ? "↓" : "↑") : ""}
                </button>
              ))}
            </div>
          </div>

          {/* List / Grouped cards */}
          <div className="flex flex-col gap-1.5 px-3">
            {activeGroup === "ALL" ? (
              <LayoutGroup>
                <GroupsView
                  groups={groups}
                  holdings={filtered}
                  dcaPlans={dcaPlans}
                  baseCurrency={currency}
                  selectedId={selectedId}
                  onSelectHolding={handleSelectHolding}
                  onEditHolding={handleEditHolding}
                  onDeleteHolding={handleDeleteHolding}
                  onQuote={openQuote}
                  onDCA={handleDCA}
                  onBuy={handleBuy}
                  onSell={handleSell}
                />
              </LayoutGroup>
            ) : (
              <>
                <LayoutGroup>
                  <AnimatePresence>
                    {filtered.map((h, i) => (
	                      <motion.div key={h.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i * 0.015, 0.12) }}>
                        <HoldingCard
                          h={h} groups={groups}
                          dcaPlans={dcaPlans}
                          isSelected={selectedId === h.id}
                          onSelect={handleSelectHolding}
                          onEdit={handleEditHolding}
                          onDelete={handleDeleteHolding}
                          onQuote={openQuote}
                          onDCA={handleDCA}
                          onBuy={handleBuy}
                          onSell={handleSell}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </LayoutGroup>

                {filtered.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <BarChart2 size={30} color="var(--text-micro)" />
                    <p style={{ color: "var(--text-micro)", fontSize: 13 }}>{text.holdings.emptyGroup}</p>
                    <button onClick={() => setSheetMode("add")}
                      className="flex items-center gap-1.5 rounded-xl px-4 py-2 mt-1"
                      style={{ background: "rgba(79,156,249,0.12)", color: "#4F9CF9", fontSize: 12 }}>
                      <Plus size={13} /> {text.holdings.firstHolding}
                    </button>
                  </div>
                )}
              </>
            )}

            {filtered.length > 0 && (
              <div className="flex justify-center mt-3">
                <button onClick={() => setSheetMode("add")}
                  className="flex items-center gap-2 rounded-full px-5 py-2.5"
                  style={{ background: "linear-gradient(135deg, #4F9CF9, #7C3AED)", color: "white", fontSize: 12, fontWeight: 600, boxShadow: "0 4px 16px rgba(79,156,249,0.3)" }}>
                  <Plus size={14} strokeWidth={2.5} /> {text.holdings.addNewHolding}
                </button>
              </div>
            )}
          </div>
        </>
        )}
      </div>

      {/* ── Modals / sheets ── */}
      <AnimatePresence>
        {sheetMode && (
          <FormSheet
            key={sheetMode === "edit" ? editTarget?.id : "add"}
            initial={
              sheetMode === "edit" && editTarget
                ? { groupId: editTarget.groupId, symbol: editTarget.symbol, name: editTarget.name,
                    market: editTarget.market, assetType: editTarget.assetType,
                    quantity: editTarget.quantity, costPrice: editTarget.costPrice,
                    currentPrice: editTarget.currentPrice, currency: editTarget.currency,
                    tradeStatus: editTarget.tradeStatus ?? "normal",
                    tradeStatusNote: editTarget.tradeStatusNote ?? "",
                    autoTradeStatus: editTarget.autoTradeStatus,
                    autoTradeStatusNote: editTarget.autoTradeStatusNote,
                    autoTradeStatusSource: editTarget.autoTradeStatusSource,
                    fundBuyConfirmDays: editTarget.fundBuyConfirmDays,
                    dividendReinvest: editTarget.dividendReinvest ?? null,
                    transactionCostProfile: editTarget.transactionCostProfile }
                : blankForm()
            }
            groups={groups}
            cashDividendTotal={sheetMode === "edit" ? editTarget?.cashDividendTotal ?? 0 : 0}
            onSave={handleSave}
            onClose={() => { setSheetMode(null); setEditTarget(null); }}
            isEdit={sheetMode === "edit"}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(showNewGroup || editingGroup) && (
          <NewGroupSheet
            key={editingGroup?.id ?? "new-group"}
            initial={editingGroup ? { name: editingGroup.name, color: editingGroup.color } : undefined}
            title={editingGroup ? text.holdings.editGroup : text.holdings.newGroup}
            saveLabel={editingGroup ? text.holdings.saveChanges : text.holdings.confirmCreate}
            onSave={(name, color) => {
              if (editingGroup) updateGroup(editingGroup.id, { name, color });
              else addGroup({ name, color, visible: true });
            }}
            onClose={() => {
              setShowNewGroup(false);
              setEditingGroup(null);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {adjustTarget && (
          <AdjustSheet
            holding={adjustTarget.holding}
            mode={adjustTarget.mode}
            onSave={handleAdjustSave}
            onClose={() => setAdjustTarget(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{text.holdings.deleteHolding}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>{text.holdings.deleteHoldingDesc}</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => { removeHolding(deleteTarget); setDeleteTarget(null); setSelectedId(null); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>{text.common.confirmDelete}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteClosedTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                {language === "en" ? "Delete Record" : "删除清仓记录"}
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>{text.holdings.deleteHoldingDesc}</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteClosedTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => { removeClosedHolding(deleteClosedTarget); setDeleteClosedTarget(null); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>{text.common.confirmDelete}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editEventTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700 }}>
                {language === "en" ? "Correct realized record" : "纠正已实现流水"}
              </p>
              <p className="mt-1 mb-4" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
                {language === "en" ? "The linked holding ledger will be updated at the same time." : "保存后会同步修正关联持仓账本，不会只改显示。"}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={language === "en" ? "Amount" : "金额"}>
                  <Input type="number" min="0" step="0.01" value={editEventAmount} onChange={setEditEventAmount} />
                </Field>
                <Field label={language === "en" ? "Date" : "日期"}>
                  <Input type="date" value={editEventDate} onChange={setEditEventDate} />
                </Field>
              </div>
              <div className="mt-3">
                <Field label={language === "en" ? "Note" : "备注"}>
                  <Input value={editEventNote} onChange={setEditEventNote} />
                </Field>
              </div>
              <div className="mt-5 flex gap-2">
                <button onClick={() => setEditEventTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button
                  disabled={!(Number(editEventAmount) > 0) || !isValidYMD(editEventDate)}
                  onClick={() => {
                    updatePortfolioEvent(editEventTarget.id, { amount: Number(editEventAmount), date: editEventDate, note: editEventNote });
                    setEditEventTarget(null);
                  }}
                  className="flex-1 rounded-xl py-2.5 disabled:opacity-40"
                  style={{ background: "#4F9CF9", color: "white", fontSize: 13, fontWeight: 700 }}>
                  {text.common.save}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteEventTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} exit={{ scale: 0.96 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700 }}>
                {language === "en" ? "Delete realized record?" : "删除这条已实现流水？"}
              </p>
              <p className="mt-1 mb-4" style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                {language === "en" ? "Its linked dividend, fee or tax will also be reversed from the holding ledger." : "关联的分红、手续费或税费也会从持仓账本同步冲销。"}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteEventTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => { removePortfolioEvent(deleteEventTarget.id); setDeleteEventTarget(null); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 700 }}>{text.common.confirmDelete}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteGroupTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{text.holdings.deleteGroup}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
                {text.holdings.deleteGroupDesc(groupName(deleteGroupTarget.id, deleteGroupTarget.name, language))}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteGroupTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => {
                  removeGroup(deleteGroupTarget.id);
                  setDeleteGroupTarget(null);
                  setActiveGroup("ALL");
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

    </div>
  );
}
