import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calculator, CalendarDays, ChevronDown, ChevronLeft, ChevronRight,
  Loader2, RefreshCw, Save, Trash2, TrendingUp, Wifi, WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "../context/AppContext";
import { fetchBacktestDailyPrices } from "../services/quoteApi";
import type { LiveResult, Market } from "../services/securitiesApi";
import { formatExactMoney, formatPercent } from "../utils/numberFormat";
import { BacktestInput, BacktestResult, BacktestStrategy, runBacktest } from "../utils/backtestEngine";
import { SparklineChart } from "../components/SparklineChart";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import { normalizeHoldingSymbol, normalizeHoldingType } from "../utils/holdingHelpers";
import { useSecuritySearch } from "../utils/useSecuritySearch";
import { assetTypeLabel, marketLabel, t } from "../i18n";
import type { BacktestResearchContext, BacktestSeed } from "../research/types";

const marketOptions = [
  { value: "US", label: "美股" },
  { value: "HK", label: "港股" },
  { value: "A", label: "A股" },
  { value: "JP", label: "日股" },
  { value: "FUND", label: "基金" },
  { value: "CRYPTO", label: "加密" },
];

const benchmarkOptions = [
  { value: "auto", labelZh: "自动匹配", labelEn: "Auto", symbol: "", market: "INDEX" },
  { value: "none", labelZh: "不对比", labelEn: "None", symbol: "", market: "INDEX" },
  { value: "csi300", labelZh: "沪深300", labelEn: "CSI 300", symbol: "000300", market: "INDEX" },
  { value: "hsi", labelZh: "恒生指数", labelEn: "Hang Seng", symbol: "^HSI", market: "INDEX" },
  { value: "sp500", labelZh: "标普500", labelEn: "S&P 500", symbol: "^GSPC", market: "INDEX" },
  { value: "nikkei", labelZh: "日经225", labelEn: "Nikkei 225", symbol: "^N225", market: "INDEX" },
  { value: "btc", labelZh: "比特币", labelEn: "Bitcoin", symbol: "BTC-USD", market: "CRYPTO" },
] as const;

type BenchmarkValue = typeof benchmarkOptions[number]["value"];
type BenchmarkSummary = { label: string; totalReturn: number; annualizedReturn: number; maxDrawdown: number };
type SavedBacktest = {
  id: string;
  name: string;
  symbol: string;
  market: string;
  strategy: BacktestStrategy;
  startDate: string;
  endDate: string;
  totalPnl: number;
  totalInvested?: number;
  finalValue?: number;
  totalDividends?: number;
  dividendDataStatus?: BacktestResult["dividendDataStatus"];
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  totalFees?: number;
  totalTaxes?: number;
  tradeCount?: number;
  dividendMode?: BacktestResult["dividendMode"];
  liquidatedAtEnd?: boolean;
  benchmarkSummary?: BenchmarkSummary | null;
  currency: string;
  createdAt: string;
  form?: BacktestInput;
  securityQuery?: string;
  benchmark?: BenchmarkValue;
};

const SAVED_BACKTESTS_KEY = "asset-helper:saved-backtests:v1";

export function autoBenchmark(market: string): Exclude<BenchmarkValue, "auto" | "none"> | "none" {
  if (market === "A" || market === "FUND") return "csi300";
  if (market === "HK") return "hsi";
  if (market === "US") return "sp500";
  if (market === "CRYPTO") return "btc";
  if (market === "JP") return "nikkei";
  return "none";
}

export function buildBenchmarkInput(runForm: BacktestInput, symbol: string, market: string): BacktestInput {
  return {
    ...runForm,
    symbol,
    market,
    assetType: "index",
    feeRate: 0,
    sellFeeRate: 0,
    buyTaxRate: 0,
    sellTaxRate: 0,
    dividendTaxRate: 0,
    minimumFee: 0,
  };
}

function loadSavedBacktests(): SavedBacktest[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_BACKTESTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function monthsAgoYMD(months: number) {
  const now = new Date();
  const targetMonthIndex = now.getMonth() - months;
  const targetYear = now.getFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return dateToYMD(new Date(targetYear, targetMonth, Math.min(now.getDate(), lastDay)));
}

function yearsAgoYMD(years: number) {
  const now = new Date();
  const targetYear = now.getFullYear() - years;
  const lastDay = new Date(targetYear, now.getMonth() + 1, 0).getDate();
  return dateToYMD(new Date(targetYear, now.getMonth(), Math.min(now.getDate(), lastDay)));
}

function todayYMD() {
  return dateToYMD(new Date());
}

function displayDate(value: string) {
  return value ? value.replace(/-/g, "/") : "";
}

function parseYMD(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date();
  }
  return date;
}

function dateToYMD(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthTitle(date: Date, isEn: boolean) {
  if (isEn) {
    return date.toLocaleDateString("en-US", { year: "numeric", month: "short" });
  }
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月`;
}

function currencyForMarket(market: string) {
  if (market === "US") return "USD";
  if (market === "HK") return "HKD";
  if (market === "JP") return "JPY";
  if (market === "CRYPTO") return "USDT";
  return "CNY";
}

export function normalizeBacktestSeedSymbol(seed: BacktestSeed | null | undefined) {
  return seed ? normalizeHoldingSymbol(seed.symbol, seed.market) : "";
}

function numberInput(value: number, onChange: (value: number) => void, placeholder?: string, step = 1) {
  const isInvalid = Number.isFinite(value) && value < 0;
  return (
    <input
      type="number"
      min={0}
      step={step}
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => onChange(Math.max(0, Number(event.target.value)))}
      placeholder={placeholder}
      title={isInvalid ? "Value cannot be negative" : undefined}
      className="w-full rounded-xl px-3"
      style={{
        height: 38,
        background: "var(--bg-card)",
        border: isInvalid ? "1px solid rgba(242,78,78,0.45)" : "1px solid var(--border)",
        color: "var(--text-primary)",
        fontSize: 13,
        outline: "none",
        paddingRight: 34,
      }}
    />
  );
}

function feeRateInput(value: number, onChange: (value: number) => void) {
  const percentValue = Number.isFinite(value) ? Number((value * 100).toFixed(4)) : 0;
  return (
    <div className="relative">
      {numberInput(
        percentValue,
        (nextPercent) => onChange(nextPercent / 100),
        "0.10",
        0.001,
      )}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          right: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--text-muted)",
          fontSize: 12,
          fontWeight: 800,
          pointerEvents: "none",
        }}
      >
        %
      </span>
    </div>
  );
}

function backtestDataNote(market: string, priceMode: BacktestResult["priceMode"], isEn: boolean) {
  if (market === "FUND") {
    return priceMode === "adjusted"
      ? (isEn
        ? "Fund backtests use cumulative NAV when available, so distributions are already included."
        : "基金回测优先使用累计净值，分红已计入口径，不再重复计入现金分红。")
      : (isEn
        ? "This fund source only returned unit NAV; distributions may be missing from the result."
        : "该基金数据源仅返回单位净值，历史分红可能未完整计入。");
  }
  if (market === "BOND") {
    return priceMode === "adjusted"
      ? (isEn
        ? "Bond backtests use adjusted close when available, but coupon, redemption, and conversion cash flows may still be incomplete."
        : "债券回测优先使用复权收盘价，但票息、赎回和转股等现金流仍可能不完整。")
      : (isEn
        ? "Bond backtests are price based; coupon, redemption, and conversion cash flows may be incomplete."
        : "债券回测以价格为主，票息、赎回和转股等现金流可能未完整计入。");
  }
  if (market === "INDEX") {
    return isEn
      ? "Index backtests use quoted index levels, not a total-return index unless the selected symbol itself is one."
      : "指数回测使用点位价格，除非标的本身是全收益指数，否则不含成分股分红。";
  }
  if (["US", "HK", "A", "JP"].includes(market)) {
    return priceMode === "adjusted"
      ? (isEn
        ? "Stocks and exchange-traded funds use adjusted close when available, so dividends and splits are already included."
        : "股票和场内 ETF 优先使用复权收盘价，分红和拆股已计入口径。")
      : (isEn
        ? "Stocks and exchange-traded funds use daily prices plus available dividend and split events from the quote source."
        : "股票和场内 ETF 使用日线价格，并计入数据源提供的分红和拆股事件。");
  }
  if (market === "CRYPTO" || market === "GOLD") {
    return isEn
      ? "This backtest is price based; no dividend cash flow is expected for this market."
      : "该市场按价格回测，通常不存在分红现金流。";
  }
  return isEn
    ? "Backtests use daily historical prices and available corporate action events."
    : "回测使用日线历史价格及数据源可用的公司行动事件。";
}

function selectInput(value: string, onChange: (value: string) => void, options: { value: string; label: string }[]) {
  return (
    <div style={{ position: "relative" }}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl px-3"
        style={{
          height: 38,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          color: "var(--text-primary)",
          fontSize: 13,
          outline: "none",
          appearance: "none",
          paddingRight: 32,
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown size={13} color="var(--text-muted)" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-h-[68px] rounded-xl p-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
      <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{label}</p>
      <p className="break-words" style={{ color: color ?? "var(--text-primary)", fontSize: 13, fontWeight: 800, lineHeight: 1.25, marginTop: 4 }}>
        {value}
      </p>
    </div>
  );
}

function DateRangeField({
  startDate,
  endDate,
  onChange,
  isEn,
}: {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
  isEn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeSide, setActiveSide] = useState<"start" | "end">("start");
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [month, setMonth] = useState(() => parseYMD(startDate));
  const wrapRef = useRef<HTMLDivElement>(null);
  const today = todayYMD();
  const weekdays = isEn ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["日", "一", "二", "三", "四", "五", "六"];

  useEffect(() => {
    if (open) setMonth(parseYMD(activeSide === "start" ? startDate : endDate));
  }, [activeSide, endDate, open, startDate]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const dates = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [month]);

  const moveMonth = (delta: number) => {
    setMonth((current) => {
      const next = new Date(current.getFullYear(), current.getMonth() + delta, 1);
      if (dateToYMD(new Date(next.getFullYear(), next.getMonth(), 1)) > today.slice(0, 7) + "-01") {
        return current;
      }
      return next;
    });
  };

  const applyQuickRange = (range: typeof quickRanges[number]) => {
    const nextStart = "months" in range ? monthsAgoYMD(range.months) : yearsAgoYMD(range.years);
    onChange(nextStart, todayYMD());
    setHoverDate(null);
    setOpen(false);
  };

  const handlePickDate = (ymd: string) => {
    if (ymd > today) return;
    if (activeSide === "start") {
      onChange(ymd, endDate < ymd ? ymd : endDate);
      setActiveSide("end");
      setHoverDate(null);
      setMonth(parseYMD(endDate < ymd ? ymd : endDate));
      return;
    }
    onChange(startDate > ymd ? ymd : startDate, ymd);
    setHoverDate(null);
    setOpen(false);
  };

  const previewStart = hoverDate
    ? activeSide === "start"
      ? hoverDate <= endDate ? hoverDate : endDate
      : startDate <= hoverDate ? startDate : hoverDate
    : startDate;
  const previewEnd = hoverDate
    ? activeSide === "start"
      ? hoverDate <= endDate ? endDate : hoverDate
      : startDate <= hoverDate ? hoverDate : startDate
    : endDate;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => {
            const next = !current;
            if (next) {
              setActiveSide("start");
              setHoverDate(null);
              setMonth(parseYMD(startDate));
            }
            return next;
          });
        }}
        className="w-full rounded-xl px-3 flex items-center justify-between"
        style={{
          height: 38,
          background: "var(--bg-card)",
          border: open ? "1px solid rgba(79,156,249,0.45)" : "1px solid var(--border)",
          color: "var(--text-primary)",
          fontSize: 13,
          fontWeight: 700,
          textAlign: "left",
        }}
      >
        <span>{displayDate(startDate)} - {displayDate(endDate)}</span>
        <CalendarDays size={14} color="var(--text-secondary)" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              width: "100%",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              boxShadow: "var(--menu-shadow)",
              zIndex: 80,
              padding: 10,
              boxSizing: "border-box",
              overflow: "hidden",
            }}
          >
            <div className="grid grid-cols-2 gap-2 mb-2">
              {([
                { key: "start" as const, label: isEn ? "Start" : "开始", value: startDate },
                { key: "end" as const, label: isEn ? "End" : "结束", value: endDate },
              ]).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setActiveSide(item.key);
                    setHoverDate(null);
                  }}
                  className="rounded-xl px-2 py-2 text-left"
                  style={{
                    background: activeSide === item.key ? "rgba(79,156,249,0.12)" : "var(--bg-card)",
                    border: activeSide === item.key ? "1px solid rgba(79,156,249,0.28)" : "1px solid var(--border-sub)",
                  }}
                >
                  <p style={{ color: "var(--text-muted)", fontSize: 9, fontWeight: 700 }}>{item.label}</p>
                  <p className="truncate" style={{ color: activeSide === item.key ? "#4F9CF9" : "var(--text-primary)", fontSize: 11, fontWeight: 800, marginTop: 2 }}>
                    {displayDate(item.value)}
                  </p>
                </button>
              ))}
            </div>

            <div className="flex gap-1.5 overflow-x-auto mb-3" style={{ scrollbarWidth: "none", paddingBottom: 1 }}>
              {quickRanges.map((range) => {
                const nextStart = "months" in range ? monthsAgoYMD(range.months) : yearsAgoYMD(range.years);
                const active = startDate === nextStart && endDate === today;
                return (
                  <button
                    key={range.key}
                    type="button"
                    onClick={() => applyQuickRange(range)}
                    className="rounded-lg shrink-0 px-2 py-1.5"
                    style={{
                      background: active ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                      border: active ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border-sub)",
                      color: active ? "#4F9CF9" : "var(--text-muted)",
                      fontSize: 9,
                      fontWeight: 800,
                    }}
                  >
                    {isEn ? range.labelEn : range.labelZh}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={() => moveMonth(-1)} className="rounded-lg flex items-center justify-center" style={{ width: 28, height: 28, background: "var(--bg-card)" }}>
                <ChevronLeft size={15} color="var(--text-secondary)" />
              </button>
              <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 800 }}>{monthTitle(month, isEn)}</span>
              <button
                type="button"
                onClick={() => moveMonth(1)}
                disabled={dateToYMD(new Date(month.getFullYear(), month.getMonth() + 1, 1)) > today.slice(0, 7) + "-01"}
                className="rounded-lg flex items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  background: "var(--bg-card)",
                  opacity: dateToYMD(new Date(month.getFullYear(), month.getMonth() + 1, 1)) > today.slice(0, 7) + "-01" ? 0.35 : 1,
                }}
              >
                <ChevronRight size={15} color="var(--text-secondary)" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {weekdays.map((day) => (
                <div key={day} className="text-center" style={{ color: "var(--text-muted)", fontSize: 9, fontWeight: 700 }}>{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHoverDate(null)}>
              {dates.map((date) => {
                const ymd = dateToYMD(date);
                const inMonth = date.getMonth() === month.getMonth();
                const active = ymd === previewStart || ymd === previewEnd;
                const confirmedActive = ymd === startDate || ymd === endDate;
                const inRange = ymd > previewStart && ymd < previewEnd;
                const isFuture = ymd > today;
                const isToday = ymd === today;
                const isPreviewPoint = hoverDate === ymd && !confirmedActive;
                return (
                  <button
                    type="button"
                    key={ymd}
                    disabled={isFuture}
                    onMouseEnter={() => {
                      if (!isFuture) setHoverDate(ymd);
                    }}
                    onClick={() => handlePickDate(ymd)}
                    className="flex items-center justify-center transition-colors"
                    style={{
                      height: 29,
                      borderRadius: active ? 999 : 8,
                      background: confirmedActive ? "#4F9CF9" : isPreviewPoint ? "rgba(79,156,249,0.24)" : inRange ? "rgba(79,156,249,0.09)" : "transparent",
                      border: !confirmedActive && (isPreviewPoint || isToday) ? "1px solid rgba(79,156,249,0.45)" : "1px solid transparent",
                      color: confirmedActive ? "#fff" : isFuture ? "var(--text-micro)" : isPreviewPoint ? "#4F9CF9" : inMonth ? "var(--text-primary)" : "var(--text-micro)",
                      opacity: isFuture ? 0.35 : 1,
                      cursor: isFuture ? "not-allowed" : "pointer",
                      transform: isPreviewPoint ? "scale(1.03)" : "scale(1)",
                      fontSize: 11,
                      fontWeight: active || isPreviewPoint ? 800 : 700,
                    }}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 pt-2" style={{ borderTop: "1px solid var(--border-sub)" }}>
              <button type="button" onClick={() => { setActiveSide(activeSide === "start" ? "end" : "start"); setHoverDate(null); }} style={{ color: "var(--text-muted)", fontSize: 12, fontWeight: 700 }}>
                {activeSide === "start" ? (isEn ? "Pick end" : "选择结束") : (isEn ? "Pick start" : "选择开始")}
              </button>
              <button type="button" onClick={() => { onChange(startDate > today ? today : startDate, today); setOpen(false); }} style={{ color: "#4F9CF9", fontSize: 12, fontWeight: 800 }}>
                {isEn ? "Today" : "今天"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SecuritySearchInput({
  value,
  marketFilter,
  onChange,
  onSelect,
  placeholder,
}: {
  value: string;
  marketFilter?: Market;
  onChange: (value: string) => void;
  onSelect: (result: LiveResult) => void;
  placeholder: string;
}) {
  const { language } = useApp();
  const text = t(language);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { apiOk, hits, loading, open, setOpen, scheduleSearch } = useSecuritySearch(value, marketFilter);

  const handleChange = (next: string) => {
    onChange(next);
    scheduleSearch(next, marketFilter);
  };

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [setOpen]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => { if (value && hits.length) setOpen(true); }}
        placeholder={placeholder}
        className="w-full rounded-xl px-3"
        style={{
          height: 38,
          background: "var(--bg-card)",
          border: open ? "1px solid rgba(79,156,249,0.45)" : "1px solid var(--border)",
          color: "var(--text-primary)",
          fontSize: 13,
          outline: "none",
          paddingRight: 32,
        }}
      />
      <div style={{ position: "absolute", right: 10, top: 19, transform: "translateY(-50%)" }}>
        {loading
          ? <Loader2 size={13} color="#4F9CF9" className="animate-spin-smooth" />
          : apiOk === true ? <Wifi size={12} color="#31D08B" />
          : apiOk === false ? <WifiOff size={12} color="var(--text-muted)" />
          : null}
      </div>
      <AnimatePresence>
        {open && hits.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              right: 0,
              background: "var(--bg-overlay)",
              border: "1px solid rgba(79,156,249,0.2)",
              borderRadius: 12,
              boxShadow: "var(--menu-shadow)",
              zIndex: 90,
              overflow: "hidden",
            }}
          >
            {hits.map((result, index) => {
              const normalized = normalizeHoldingType(result.symbol, result.name, result.market, result.assetType);
              const badge = getMarketBadgeWithBg(normalized.market, 0.1, language);
              return (
                <button
                  key={`${result.market}:${result.symbol}:${index}`}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(result);
                    setOpen(false);
                  }}
                  className="w-full px-3 py-2.5 text-left"
                  style={{ borderBottom: `1px solid ${index < hits.length - 1 ? "var(--border)" : "transparent"}` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate" style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 800, minWidth: 0 }}>
                      {result.name}
                    </span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap" }}>{result.symbol}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 min-w-0">
                    <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 5px", borderRadius: 4, color: badge.color, background: badge.bg }}>
                      {badge.label}
                    </span>
                    <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{assetTypeLabel(normalized.assetType, language)}</span>
                    <span className="ml-auto" style={{
                      fontSize: 9,
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: result.source === "live" ? "rgba(49,208,139,0.1)" : "rgba(100,116,139,0.1)",
                      color: result.source === "live" ? "#31D08B" : "var(--text-muted)",
                    }}>
                      {result.source === "live" ? text.common.live : text.common.local}
                    </span>
                  </div>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const quickRanges = [
  { key: "1m", months: 1, labelZh: "近1月", labelEn: "1M" },
  { key: "3m", months: 3, labelZh: "近3月", labelEn: "3M" },
  { key: "6m", months: 6, labelZh: "近半年", labelEn: "6M" },
  { key: "1y", years: 1, labelZh: "近1年", labelEn: "1Y" },
  { key: "3y", years: 3, labelZh: "近3年", labelEn: "3Y" },
  { key: "5y", years: 5, labelZh: "近5年", labelEn: "5Y" },
  { key: "10y", years: 10, labelZh: "近10年", labelEn: "10Y" },
] as const;

function strategyBuyLabel(strategy: BacktestStrategy, isEn: boolean) {
  if (strategy === "monthly_dca") return isEn ? "Monthly buy" : "月定投";
  if (strategy === "weekly_dca") return isEn ? "Weekly buy" : "周定投";
  if (strategy === "daily_dca") return isEn ? "Daily buy" : "日定投";
  return isEn ? "Buy" : "买入";
}

function strategyLabel(strategy: BacktestStrategy, isEn: boolean) {
  if (strategy === "monthly_dca") return isEn ? "Monthly DCA" : "月定投";
  if (strategy === "weekly_dca") return isEn ? "Weekly DCA" : "周定投";
  if (strategy === "daily_dca") return isEn ? "Daily DCA" : "日定投";
  return isEn ? "Lump sum" : "一次性买入";
}

function strategyBuyLabelWithPeriod(strategy: BacktestStrategy, period: number, isEn: boolean) {
  const label = strategyBuyLabel(strategy, isEn);
  if (strategy === "lump_sum" || period <= 0) return label;
  return isEn ? `${label} #${period}` : `${label} 第${period}期`;
}

export type BacktestView = "backtest" | "compare";

export function Backtest({
  embedded = false,
  view: controlledView,
  onViewChange,
  initialSeed,
  onInterpret,
}: {
  embedded?: boolean;
  view?: BacktestView;
  onViewChange?: (view: BacktestView) => void;
  initialSeed?: BacktestSeed | null;
  onInterpret?: (context: BacktestResearchContext) => void;
} = {}) {
  const { language, profitColor, holdings } = useApp();
  const isEn = language === "en";
  const text = t(language);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 400 : window.innerWidth);
  const localizedMarketScopeOptions = useMemo(() => [
    { value: "" as Market | "", label: text.holdings.allMarkets },
    ...marketOptions.map((option) => ({ value: option.value as Market | "", label: marketLabel(option.value, language) })),
  ], [language, text.holdings.allMarkets]);
  const [form, setForm] = useState<BacktestInput>({
    symbol: normalizeBacktestSeedSymbol(initialSeed),
    market: initialSeed?.market ?? "US",
    assetType: initialSeed?.assetType ?? "stock",
    startDate: yearsAgoYMD(3),
    endDate: todayYMD(),
    initialAmount: 10000,
    strategy: initialSeed?.strategy ?? "lump_sum",
    monthlyAmount: 1000,
    feeRate: 0,
    sellFeeRate: 0,
    buyTaxRate: 0,
    sellTaxRate: 0,
    dividendTaxRate: 0,
    minimumFee: 0,
    liquidateAtEnd: false,
    dividendMode: "cash",
  });
  const [securityQuery, setSecurityQuery] = useState(initialSeed ? `${initialSeed.name} (${initialSeed.symbol})` : "");
  const [marketScope, setMarketScope] = useState<Market | "">(
    initialSeed && marketOptions.some((option) => option.value === initialSeed.market) ? initialSeed.market as Market : "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkValue>("auto");
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkSummary | null>(null);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [savedBacktests, setSavedBacktests] = useState<SavedBacktest[]>(loadSavedBacktests);
  const [periodView, setPeriodView] = useState<"month" | "year">("month");
  const [internalPageTab, setInternalPageTab] = useState<BacktestView>("backtest");
  const pageTab = controlledView ?? internalPageTab;
  const setPageTab = (tab: BacktestView) => {
    setInternalPageTab(tab);
    onViewChange?.(tab);
  };
  const runSeqRef = useRef(0);

  useEffect(() => {
    if (!initialSeed) return;
    runSeqRef.current += 1;
    setForm((current) => ({
      ...current,
      symbol: normalizeBacktestSeedSymbol(initialSeed),
      market: initialSeed.market,
      assetType: initialSeed.assetType,
      strategy: initialSeed.strategy ?? current.strategy,
    }));
    setSecurityQuery(`${initialSeed.name} (${initialSeed.symbol})`);
    setMarketScope(marketOptions.some((option) => option.value === initialSeed.market) ? initialSeed.market as Market : "");
    setResult(null);
    setBenchmarkResult(null);
    setBenchmarkError("");
    setError("");
    setInternalPageTab("backtest");
  }, [initialSeed]);

  const chartColor = profitColor(result?.totalPnl ?? 0);
  const chartData = useMemo(() => {
    let buyPeriod = 0;
    return result?.points.map((point, index, points) => {
      const previousInvested = index > 0 ? points[index - 1]?.invested ?? 0 : 0;
      const buyAmount = Math.max(0, point.invested - previousInvested);
      const hasBuy = buyAmount > 0.000001;
      if (hasBuy) buyPeriod += 1;
      return {
        v: point.value,
        date: point.date,
        invested: point.invested,
        marketValue: point.marketValue,
        finalValue: point.value,
        returnRate: point.returnRate,
        buyAmount,
        buyPeriod: hasBuy ? buyPeriod : 0,
        dividendCash: point.dividendCash,
      };
    }) ?? [];
  }, [result]);
  const visiblePeriodReturns = result
    ? (periodView === "month" ? result.monthlyReturns.slice(-12) : result.yearlyReturns).slice().reverse()
    : [];
  const quoteCurrency = currencyForMarket(form.market);
  const isCompactForm = viewportWidth < 380;
  const comparisonMeta = useMemo(() => {
    if (savedBacktests.length === 0) return null;
    const bestReturn = Math.max(...savedBacktests.map((item) => item.totalReturn));
    const bestAnnualized = Math.max(...savedBacktests.map((item) => item.annualizedReturn));
    const lowestDrawdown = Math.min(...savedBacktests.map((item) => item.maxDrawdown));
    const currencies = new Set(savedBacktests.map((item) => item.currency));
    const ranges = new Set(savedBacktests.map((item) => `${item.startDate}:${item.endDate}`));
    return {
      bestReturn,
      bestAnnualized,
      lowestDrawdown,
      mixedCurrencies: currencies.size > 1,
      mixedRanges: ranges.size > 1,
    };
  }, [savedBacktests]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const updateForm = <K extends keyof BacktestInput>(key: K, value: BacktestInput[K]) => {
    runSeqRef.current += 1;
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
    setBenchmarkResult(null);
    setBenchmarkError("");
    setError("");
    setLoading(false);
  };

  const matchingHolding = useMemo(() => holdings.find((holding) =>
    holding.market === form.market && normalizeHoldingSymbol(holding.symbol, holding.market) === form.symbol
  ), [form.market, form.symbol, holdings]);

  const applyHoldingCosts = () => {
    const profile = matchingHolding?.transactionCostProfile;
    if (!profile) return;
    runSeqRef.current += 1;
    setForm((current) => ({
      ...current,
      feeRate: profile.buyFeeRate ?? 0,
      sellFeeRate: profile.sellFeeRate ?? profile.buyFeeRate ?? 0,
      buyTaxRate: profile.buyTaxRate ?? 0,
      sellTaxRate: profile.sellTaxRate ?? 0,
      minimumFee: profile.minimumFee ?? 0,
    }));
    setResult(null);
    setBenchmarkResult(null);
    setBenchmarkError("");
    setError("");
    setLoading(false);
  };

  const persistSavedBacktests = (next: SavedBacktest[]) => {
    const limited = next.slice(0, 8);
    setSavedBacktests(limited);
    try { localStorage.setItem(SAVED_BACKTESTS_KEY, JSON.stringify(limited)); } catch { /* non-critical */ }
  };

  const saveCurrentResult = () => {
    if (!result) return;
    const item: SavedBacktest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: securityQuery || form.symbol,
      symbol: form.symbol,
      market: form.market,
      strategy: form.strategy,
      startDate: result.actualStartDate,
      endDate: result.actualEndDate,
      totalPnl: result.totalPnl,
      totalInvested: result.totalInvested,
      finalValue: result.finalValue,
      totalDividends: result.totalDividends,
      dividendDataStatus: result.dividendDataStatus,
      totalReturn: result.totalReturn,
      annualizedReturn: result.annualizedReturn,
      maxDrawdown: result.maxDrawdown,
      totalFees: result.totalFees,
      totalTaxes: result.totalTaxes,
      tradeCount: result.tradeCount,
      dividendMode: result.dividendMode,
      liquidatedAtEnd: result.liquidatedAtEnd,
      benchmarkSummary: benchmarkResult,
      currency: quoteCurrency,
      createdAt: new Date().toISOString(),
      form: { ...form },
      securityQuery,
      benchmark,
    };
    persistSavedBacktests([item, ...savedBacktests]);
  };

  const interpretCurrentResult = () => {
    if (!result || !onInterpret) return;
    onInterpret({
      symbol: form.symbol,
      name: securityQuery.replace(/\s*\([^)]*\)\s*$/, "") || form.symbol,
      market: form.market,
      currency: quoteCurrency,
      strategy: form.strategy,
      startDate: result.actualStartDate,
      endDate: result.actualEndDate,
      totalPnl: result.totalPnl,
      totalInvested: result.totalInvested,
      finalValue: result.finalValue,
      totalReturn: result.totalReturn,
      annualizedReturn: result.annualizedReturn,
      maxDrawdown: result.maxDrawdown,
      totalFees: result.totalFees,
      totalTaxes: result.totalTaxes,
      totalDividends: result.totalDividends,
      tradeCount: result.tradeCount,
      benchmarkLabel: benchmarkResult?.label,
      benchmarkReturn: benchmarkResult?.totalReturn,
      benchmarkAnnualizedReturn: benchmarkResult?.annualizedReturn,
      benchmarkMaxDrawdown: benchmarkResult?.maxDrawdown,
      monthlyReturns: result.monthlyReturns.slice(-24).map((item) => ({ month: item.key, returnRate: item.returnRate })),
    });
  };

  const loadSavedBacktest = (item: SavedBacktest) => {
    if (!item.form) return;
    runSeqRef.current += 1;
    setForm(item.form);
    setSecurityQuery(item.securityQuery || item.name);
    setMarketScope(marketOptions.some((option) => option.value === item.form?.market) ? item.form.market as Market : "");
    setBenchmark(item.benchmark ?? "auto");
    setResult(null);
    setBenchmarkResult(null);
    setBenchmarkError("");
    setError("");
    setLoading(false);
    setPageTab("backtest");
    void run(item.form, item.benchmark ?? "auto");
  };

  const handleSecuritySelect = (result: LiveResult) => {
    runSeqRef.current += 1;
    const normalized = normalizeHoldingType(result.symbol, result.name, result.market, result.assetType);
    const normalizedSymbol = normalizeHoldingSymbol(result.symbol, normalized.market);
    setSecurityQuery(`${result.name} (${result.symbol})`);
    setForm((current) => ({
      ...current,
      symbol: normalizedSymbol,
      market: normalized.market,
      assetType: normalized.assetType,
    }));
    setResult(null);
    setBenchmarkResult(null);
    setBenchmarkError("");
    setError("");
    setLoading(false);
  };

  const run = async (runForm: BacktestInput = form, runBenchmark: BenchmarkValue = benchmark) => {
    const runSeq = ++runSeqRef.current;
    const symbol = runForm.symbol.trim();
    if (!symbol) {
      setError(isEn ? "Enter a symbol first." : "请先输入标的代码。");
      return;
    }
    if (runForm.initialAmount <= 0 && (runForm.strategy === "lump_sum" || runForm.monthlyAmount <= 0)) {
      setError(isEn ? "Enter an investment amount greater than zero." : "请输入大于 0 的投资金额。");
      return;
    }
    setLoading(true);
    setError("");
    setBenchmarkError("");
    try {
      const resolvedBenchmark = runBenchmark === "auto" ? autoBenchmark(runForm.market) : runBenchmark;
      const benchmarkOption = benchmarkOptions.find((option) => option.value === resolvedBenchmark);
      const [prices, benchmarkPrices] = await Promise.all([
        fetchBacktestDailyPrices(symbol, runForm.market, runForm.startDate, runForm.endDate, { preferAdjusted: false }),
        benchmarkOption?.symbol
          ? fetchBacktestDailyPrices(benchmarkOption.symbol, benchmarkOption.market, runForm.startDate, runForm.endDate, { preferAdjusted: false }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const sortedDates = prices.map((point) => point.date).sort();
      const inSelectedRange = prices.some((point) => point.date >= runForm.startDate && point.date <= runForm.endDate);
      if (!inSelectedRange) {
        const firstDate = sortedDates[0] ?? "";
        const lastDate = sortedDates[sortedDates.length - 1] ?? "";
        throw new Error(firstDate && lastDate ? `NO_PRICE_DATA:${firstDate}:${lastDate}` : "NO_PRICE_DATA");
      }
      const nextResult = runBacktest({ ...runForm, symbol }, prices);
      if (runSeq !== runSeqRef.current) return;
      setResult(nextResult);
      if (benchmarkOption?.symbol && benchmarkPrices?.length) {
        try {
          const benchmarkBacktest = runBacktest(
            buildBenchmarkInput(runForm, benchmarkOption.symbol, benchmarkOption.market),
            benchmarkPrices,
          );
          setBenchmarkResult({
            label: isEn ? benchmarkOption.labelEn : benchmarkOption.labelZh,
            totalReturn: benchmarkBacktest.totalReturn,
            annualizedReturn: benchmarkBacktest.annualizedReturn,
            maxDrawdown: benchmarkBacktest.maxDrawdown,
          });
        } catch {
          setBenchmarkResult(null);
          setBenchmarkError(isEn ? "Benchmark data is unavailable for this range." : "该区间暂无基准数据。");
        }
      } else {
        setBenchmarkResult(null);
        if (benchmarkOption?.symbol) {
          setBenchmarkError(isEn ? "Benchmark data is unavailable for this range." : "该区间暂无基准数据。");
        }
      }
    } catch (err) {
      if (runSeq !== runSeqRef.current) return;
      setResult(null);
      setBenchmarkResult(null);
      const errorMessage = err instanceof Error ? err.message : "";
      const coverage = errorMessage.startsWith("NO_PRICE_DATA:") ? errorMessage.split(":").slice(1) : [];
      const message = errorMessage.startsWith("NO_PRICE_DATA")
        ? coverage.length === 2
          ? (isEn
              ? `No daily price data in this range. Available data: ${displayDate(coverage[0]!)} - ${displayDate(coverage[1]!)}.`
              : `所选区间暂无日线价格数据。可用数据范围：${displayDate(coverage[0]!)} - ${displayDate(coverage[1]!)}。`)
          : (isEn ? "No daily price data in the selected range." : "所选区间暂无日线价格数据。")
        : (isEn ? "Backtest failed. Try another symbol or range." : "回测失败，请换一个标的或时间区间。");
      setError(message);
    } finally {
      if (runSeq === runSeqRef.current) setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!embedded && <div
        className="shrink-0 flex items-center justify-between px-4"
        style={{
          height: 50,
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          backdropFilter: "blur(14px)",
        }}
      >
        <div className="flex items-center gap-2">
          <Calculator size={18} color="#4F9CF9" />
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 800 }}>
            {isEn ? "Backtest" : "收益回测"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {pageTab === "backtest" && (
            <button
              onClick={() => void run()}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg px-3 py-2"
              style={{ background: "rgba(79,156,249,0.15)", color: "#4F9CF9", fontSize: 12, fontWeight: 800 }}
            >
              <RefreshCw size={13} className={loading ? "animate-spin-smooth" : undefined} />
              {isEn ? "Run" : "开始"}
            </button>
          )}
        </div>
      </div>}

      {!embedded && <div className="shrink-0 border-b border-app-border px-3 py-2">
        <div className="grid grid-cols-2 rounded-xl bg-app-card p-1">
          {(["backtest", "compare"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setPageTab(tab)}
              className="rounded-lg py-1.5 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
              style={{ color: pageTab === tab ? "#4F9CF9" : "var(--text-muted)", background: pageTab === tab ? "rgba(79,156,249,0.14)" : "transparent" }}
            >
              {tab === "backtest" ? (isEn ? "Backtest" : "回测") : (isEn ? "Comparisons" : "方案对比")}
              {tab === "compare" && savedBacktests.length > 0 ? ` (${savedBacktests.length})` : ""}
            </button>
          ))}
        </div>
      </div>}

      <div className="flex-1 overflow-y-auto px-3 py-3" style={{ scrollbarWidth: "none", paddingBottom: 16 }}>
        <div style={{ display: pageTab === "backtest" ? "block" : "none" }}>
        <div className="rounded-xl p-3" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-sub)" }}>
          <div className="flex gap-2 items-end mb-3">
            <label style={{ width: 120, flexShrink: 0 }}>
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{text.holdings.marketScope}</p>
              {selectInput(marketScope, (value) => {
                const next = value as Market | "";
                setMarketScope(next);
                setSecurityQuery("");
                setResult(null);
                setError("");
                updateForm("market", next || "US");
              }, localizedMarketScopeOptions)}
            </label>
            <label className="flex-1 min-w-0">
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{text.holdings.security}</p>
              <SecuritySearchInput
                value={securityQuery}
                marketFilter={marketScope || undefined}
                onChange={(value) => {
                  setSecurityQuery(value);
                  updateForm("symbol", value);
                }}
                onSelect={handleSecuritySelect}
                placeholder={text.holdings.searchSecurityPlaceholder}
              />
            </label>
          </div>

          <div className="mt-3">
            <label className="flex-1 min-w-0">
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Time Range" : "时间范围"}</p>
              <DateRangeField
                startDate={form.startDate}
                endDate={form.endDate}
                onChange={(startDate, endDate) => {
                  runSeqRef.current += 1;
                  setForm((current) => ({ ...current, startDate, endDate }));
                  setResult(null);
                  setBenchmarkResult(null);
                  setBenchmarkError("");
                  setError("");
                  setLoading(false);
                }}
                isEn={isEn}
              />
            </label>
          </div>

          <div className="mt-3">
            <label>
              <p className="mb-1 text-[10px] text-tm">{isEn ? "Benchmark" : "对比基准"}</p>
              {selectInput(benchmark, (value) => {
                runSeqRef.current += 1;
                setBenchmark(value as BenchmarkValue);
                setResult(null);
                setBenchmarkResult(null);
                setBenchmarkError("");
                setLoading(false);
              }, benchmarkOptions.map((option) => ({ value: option.value, label: isEn ? option.labelEn : option.labelZh })))}
            </label>
          </div>

          <div className="mt-3">
            <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Strategy" : "投资策略"}</p>
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: isCompactForm ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))" }}
            >
              {([
                { key: "lump_sum" as BacktestStrategy, label: isEn ? "Lump" : "一次性" },
                { key: "monthly_dca" as BacktestStrategy, label: isEn ? "Monthly" : "月定投" },
                { key: "weekly_dca" as BacktestStrategy, label: isEn ? "Weekly" : "周定投" },
                { key: "daily_dca" as BacktestStrategy, label: isEn ? "Daily" : "日定投" },
              ]).map((item) => (
                <button
                  key={item.key}
                  onClick={() => updateForm("strategy", item.key)}
                  className="rounded-xl py-2"
                  style={{
                    background: form.strategy === item.key ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color: form.strategy === item.key ? "#4F9CF9" : "var(--text-muted)",
                    border: form.strategy === item.key ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {form.strategy === "lump_sum" ? (
              <div className="grid grid-cols-1 gap-3 mt-3">
                <label>
                  <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Buy Amount" : "买入金额"}</p>
                  {numberInput(form.initialAmount, (value) => updateForm("initialAmount", value))}
                </label>
              </div>
            ) : (
              <div
                className="grid gap-3 mt-3"
                style={{ gridTemplateColumns: isCompactForm ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))" }}
              >
                <label>
                  <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Initial Amount" : "初始金额"}</p>
                  {numberInput(form.initialAmount, (value) => updateForm("initialAmount", value))}
                </label>
                <label>
                  <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>
                    {form.strategy === "monthly_dca"
                      ? (isEn ? "Monthly Amount" : "每月定投")
                      : form.strategy === "weekly_dca"
                        ? (isEn ? "Weekly Amount" : "每周定投")
                        : (isEn ? "Daily Amount" : "每日定投")}
                  </p>
                  {numberInput(form.monthlyAmount, (value) => updateForm("monthlyAmount", value))}
                </label>
              </div>
            )}

            <div className="mt-3">
              <p className="mb-1 text-[10px] text-tm">{isEn ? "Dividend treatment" : "分红处理"}</p>
              <div className="grid grid-cols-2 rounded-xl border border-app-border bg-app-card p-1">
                {(["cash", "reinvest"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateForm("dividendMode", mode)}
                    className="rounded-lg py-1.5 text-[10px] font-semibold"
                    style={{ color: form.dividendMode === mode ? "#4F9CF9" : "var(--text-muted)", background: form.dividendMode === mode ? "rgba(79,156,249,0.13)" : "transparent" }}
                  >
                    {mode === "cash" ? (isEn ? "Cash dividend" : "现金分红") : (isEn ? "Reinvest" : "红利再投")}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] leading-4 text-tmi">
                {isEn ? "Reinvestment uses the ex-date close as an estimate. Adjusted prices and cumulative NAV are not counted twice." : "红利再投按除息日收盘价估算；复权价和累计净值不会重复计入分红。"}
              </p>
            </div>
          </div>

          <div className="mt-3 border-t border-app-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold text-tm">{isEn ? "Transaction costs" : "交易成本"}</p>
              {matchingHolding?.transactionCostProfile && (
                <button type="button" onClick={applyHoldingCosts} className="text-[9px] font-semibold text-app-accent">
                  {isEn ? "Use holding rules" : "使用持仓费率"}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Buy fee (%)" : "买入手续费率 (%)"}</p>
                {feeRateInput(form.feeRate, (value) => updateForm("feeRate", value))}
              </label>
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Sell fee (%)" : "卖出手续费率 (%)"}</p>
                {feeRateInput(form.sellFeeRate ?? 0, (value) => updateForm("sellFeeRate", value))}
              </label>
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Buy tax (%)" : "买入税率 (%)"}</p>
                {feeRateInput(form.buyTaxRate ?? 0, (value) => updateForm("buyTaxRate", value))}
              </label>
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Sell tax rate (%)" : "卖出税率 (%)"}</p>
                {feeRateInput(form.sellTaxRate ?? 0, (value) => updateForm("sellTaxRate", value))}
              </label>
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Dividend tax (%)" : "分红税率 (%)"}</p>
                {feeRateInput(form.dividendTaxRate ?? 0, (value) => updateForm("dividendTaxRate", value))}
              </label>
              <label>
                <p className="mb-1 text-[10px] text-tm">{isEn ? "Minimum fee" : `最低手续费 (${quoteCurrency})`}</p>
                {numberInput(form.minimumFee ?? 0, (value) => updateForm("minimumFee", value), "0", 0.01)}
              </label>
              <label className="col-span-2 flex min-h-[46px] items-end">
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.liquidateAtEnd === true}
                  aria-label={isEn ? "Liquidate at end" : "期末模拟清仓"}
                  onClick={() => updateForm("liquidateAtEnd", !form.liquidateAtEnd)}
                  className="flex h-[38px] w-full items-center justify-between rounded-xl border border-app-border bg-app-card px-3 text-[10px] font-semibold text-ts"
                >
                  <span>{isEn ? "Liquidate at end" : "期末模拟清仓"}</span>
                  <span className="relative h-5 w-9 rounded-full transition-colors" style={{ background: form.liquidateAtEnd ? "#4F9CF9" : "var(--bg-surface2)" }}>
                    <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: form.liquidateAtEnd ? 18 : 2 }} />
                  </span>
                </button>
              </label>
            </div>
            <p className="mt-2 text-[9px] leading-4 text-tmi">
              {form.liquidateAtEnd
                ? (isEn ? "Ending value deducts sell fees and taxes." : "期末总值将扣除卖出手续费和税费。")
                : (isEn ? "Ending value is a holding valuation; sell costs are not deducted." : "期末总值为持仓估值，不扣除卖出成本。")}
            </p>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-xl px-3 py-2" style={{ background: "rgba(242,78,78,0.1)", color: "#F24E4E", fontSize: 12 }}>
            {error}
          </div>
        )}

        {result ? (
          <div className="mt-3 flex flex-col gap-3">
            <section className="rounded-xl border border-app-accent/15 bg-app-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] text-tm">{isEn ? "Total return" : "总收益"}</p>
                  <p className="mt-0.5 break-words text-[25px] font-bold leading-tight" style={{ color: profitColor(result.totalPnl) }}>
                    {`${result.totalPnl >= 0 ? "+" : "-"}${formatExactMoney(Math.abs(result.totalPnl), quoteCurrency, 2)}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[10px] text-tm">{isEn ? "Return rate" : "总收益率"}</p>
                  <p className="mt-1 text-sm font-bold" style={{ color: profitColor(result.totalReturn) }}>{formatPercent(result.totalReturn)}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-app-border pt-2.5">
                <div><p className="text-[9px] text-tmi">{isEn ? "Annualized (MWR)" : "年化收益 (MWR)"}</p><p className="mt-1 text-xs font-bold" style={{ color: profitColor(result.annualizedReturn) }}>{formatPercent(result.annualizedReturn)}</p></div>
                <div><p className="text-[9px] text-tmi">{isEn ? "Max drawdown" : "最大回撤"}</p><p className="mt-1 text-xs font-bold" style={{ color: profitColor(-result.maxDrawdown) }}>{formatPercent(-result.maxDrawdown)}</p></div>
                <div><p className="text-[9px] text-tmi">{isEn ? "Trades" : "交易次数"}</p><p className="mt-1 text-xs font-bold text-ts">{result.tradeCount}</p></div>
              </div>
              <button type="button" onClick={saveCurrentResult} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-card py-2 text-[10px] font-semibold text-app-accent">
                <Save size={12} />{isEn ? "Save for comparison" : "保存当前方案用于对比"}
              </button>
              {onInterpret && (
                <button type="button" onClick={interpretCurrentResult} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-app-accent py-2 text-[10px] font-semibold text-white">
                  <TrendingUp size={12} />{isEn ? "AI review this backtest" : "AI 解读本次回测"}
                </button>
              )}
            </section>

            {(benchmarkResult || benchmarkError) && (
              <section className="rounded-xl border border-app-border bg-app-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-tp">{isEn ? "Benchmark comparison" : "基准对比"}</p>
                  {benchmarkResult && <span className="text-[9px] text-tmi">{benchmarkResult.label}</span>}
                </div>
                {benchmarkResult ? (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div><p className="text-[9px] text-tmi">{isEn ? "Benchmark" : "基准收益"}</p><p className="mt-1 text-xs font-bold" style={{ color: profitColor(benchmarkResult.totalReturn) }}>{formatPercent(benchmarkResult.totalReturn)}</p></div>
                    <div><p className="text-[9px] text-tmi">{isEn ? "Excess return" : "超额收益"}</p><p className="mt-1 text-xs font-bold" style={{ color: profitColor(result.totalReturn - benchmarkResult.totalReturn) }}>{formatPercent(result.totalReturn - benchmarkResult.totalReturn)}</p></div>
                    <div><p className="text-[9px] text-tmi">{isEn ? "Drawdown gap" : "回撤差"}</p><p className="mt-1 text-xs font-bold" style={{ color: profitColor(benchmarkResult.maxDrawdown - result.maxDrawdown) }}>{formatPercent(benchmarkResult.maxDrawdown - result.maxDrawdown)}</p></div>
                  </div>
                ) : <p className="mt-2 text-[10px] text-tmi">{benchmarkError}</p>}
              </section>
            )}

            <div className="rounded-xl p-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <TrendingUp size={15} color={chartColor} />
                  <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 800 }}>
                    {isEn ? "Equity Curve" : "收益曲线"}
                  </span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ color: chartColor, fontSize: 12, fontWeight: 800, lineHeight: 1.1 }}>
                    {formatPercent(result.totalReturn)}
                  </p>
                  <p style={{ color: "var(--text-muted)", fontSize: 9, fontWeight: 700, marginTop: 3 }}>
                    {isEn ? "incl. dividends/splits" : "含分红/拆股"}
                  </p>
                </div>
              </div>
              <SparklineChart
                data={chartData}
                color={chartColor}
                height={116}
                tooltip={(point) => {
                  const date = String(point.date ?? "");
                  const invested = Number(point.invested ?? 0);
                  const marketValue = Number(point.marketValue ?? 0);
                  const returnRate = Number(point.returnRate ?? 0);
                  const buyAmount = Number(point.buyAmount ?? 0);
                  const buyPeriod = Number(point.buyPeriod ?? 0);
                  const dividendCash = Number(point.dividendCash ?? 0);
                  const showBuy = buyAmount > 0.000001;
                  const showDividend = dividendCash > 0.000001;
                  const money = (value: number) => formatExactMoney(value, quoteCurrency, 2);
                  const row = (label: string, value: string, color = "#F1F5F9") => (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 14, lineHeight: 1.55 }}>
                      <span style={{ color: "rgba(226,232,240,0.72)" }}>{label}</span>
                      <span style={{ color, fontWeight: 800 }}>{value}</span>
                    </div>
                  );
                  return (
                    <div style={{ minWidth: 158 }}>
                      <div style={{ color: "#F8FAFC", fontWeight: 900, marginBottom: 3 }}>{date}</div>
                      {row(isEn ? "Invested" : "投入本金", money(invested))}
                      {row(isEn ? "Market value" : "期末市值", money(marketValue))}
                      {row(isEn ? "Return" : "收益率", formatPercent(returnRate), profitColor(returnRate))}
                      {showBuy && row(strategyBuyLabelWithPeriod(form.strategy, buyPeriod, isEn), money(buyAmount), "#93C5FD")}
                      {showDividend && row(isEn ? "Dividend" : "分红", money(dividendCash), profitColor(dividendCash))}
                    </div>
                  );
                }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 700, lineHeight: 1.45, marginTop: 8 }}>
                {backtestDataNote(form.market, result.priceMode, isEn)}
              </p>
              <p className="mt-1 text-[9px] leading-4 text-tmi">
                {isEn ? "Actual coverage" : "实际数据覆盖"}: {displayDate(result.actualStartDate)} - {displayDate(result.actualEndDate)}
              </p>
              <p className="text-[9px] leading-4 text-tmi">
                {isEn ? "Max drawdown period" : "最大回撤区间"}: {result.maxDrawdownStartDate && result.maxDrawdownEndDate
                  ? `${displayDate(result.maxDrawdownStartDate)} - ${displayDate(result.maxDrawdownEndDate)}`
                  : (isEn ? "No drawdown" : "无回撤")}
              </p>
            </div>

            <section className="rounded-xl border border-app-border bg-app-card p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-tp">{isEn ? "Periodic returns" : "分期收益"}</p>
                <div className="flex rounded-lg bg-app-surface p-0.5">
                  {(["month", "year"] as const).map((mode) => (
                    <button key={mode} type="button" onClick={() => setPeriodView(mode)} className="rounded-md px-2 py-1 text-[9px] font-semibold" style={{ color: periodView === mode ? "#4F9CF9" : "var(--text-muted)", background: periodView === mode ? "var(--bg-card)" : "transparent" }}>
                      {mode === "month" ? (isEn ? "Monthly" : "月度") : (isEn ? "Yearly" : "年度")}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 overflow-hidden rounded-lg border border-app-border">
                {visiblePeriodReturns.map((row, index) => (
                  <div key={row.key} className="flex items-center justify-between px-3 py-2 text-[10px]" style={{ borderBottom: index < visiblePeriodReturns.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <span className="font-medium text-ts">{row.key}</span>
                    <span className="font-bold" style={{ color: profitColor(row.returnRate) }}>{formatPercent(row.returnRate)}</span>
                  </div>
                ))}
              </div>
            </section>

            <div className="grid grid-cols-2 gap-2">
              <MetricCard label={isEn ? "Invested" : "投入本金"} value={formatExactMoney(result.totalInvested, quoteCurrency, 2)} />
              <MetricCard
                label={isEn ? "Market Value" : "期末市值"}
                value={formatExactMoney(result.finalMarketValue, quoteCurrency, 2)}
              />
              <MetricCard
                label={result.dividendDataStatus === "explicit" ? (isEn ? "Net dividends" : "税后分红收入") : (isEn ? "Dividends" : "分红收入")}
                value={result.dividendDataStatus === "embedded"
                  ? (isEn ? "Included in adjusted return" : "已含在复权/净值收益中")
                  : result.dividendDataStatus === "unavailable"
                    ? (isEn ? "Not split by source" : "数据源未拆分")
                    : result.dividendDataStatus === "not_applicable"
                      ? (isEn ? "Not applicable" : "不适用")
                      : formatExactMoney(result.totalDividends, quoteCurrency, 2)}
                color={result.dividendDataStatus === "explicit" ? profitColor(result.totalDividends) : "var(--text-secondary)"}
              />
              <MetricCard label={result.liquidatedAtEnd ? (isEn ? "Net liquidation value" : "清仓后总值") : (isEn ? "Ending valuation" : "期末持仓估值")} value={formatExactMoney(result.finalValue, quoteCurrency, 2)} />
              <MetricCard label={isEn ? "Fees" : "累计手续费"} value={formatExactMoney(result.totalFees, quoteCurrency, 2)} color={profitColor(-result.totalFees)} />
              <MetricCard label={isEn ? "Taxes" : "累计税费"} value={formatExactMoney(result.totalTaxes, quoteCurrency, 2)} color={profitColor(-result.totalTaxes)} />
              <MetricCard label={isEn ? "Price Drawdown" : "价格回撤"} value={formatPercent(-result.marketMaxDrawdown)} color={profitColor(-result.marketMaxDrawdown)} />
              <MetricCard label={isEn ? "Total Drawdown" : "总值回撤"} value={formatPercent(-result.maxDrawdown)} color={profitColor(-result.maxDrawdown)} />
              <MetricCard label={isEn ? "Data Points" : "日线点数"} value={`${result.points.length}`} />
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl p-4 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 800 }}>
              {isEn ? "Run a backtest to see the result." : "输入参数后开始回测。"}
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              {isEn ? "Uses daily historical prices only. Intraday data is intentionally excluded." : "回测只使用日线历史，不使用分时数据。"}
            </p>
          </div>
        )}

        </div>

        {pageTab === "compare" && savedBacktests.length > 0 && (
          <section>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-tp">{isEn ? "Saved comparisons" : "已保存方案对比"}</p>
              <span className="text-[10px] text-tmi">{savedBacktests.length}/8</span>
            </div>
            {(comparisonMeta?.mixedCurrencies || comparisonMeta?.mixedRanges) && (
              <div className="mt-2 rounded-lg border border-app-border bg-app-card px-3 py-2.5 text-[10px] leading-[1.55] text-tm">
                {comparisonMeta.mixedCurrencies
                  ? (isEn ? "Different currencies are present. Compare return rates, not absolute amounts." : "方案包含不同币种，绝对金额不可直接比较，建议以收益率为主。")
                  : (isEn ? "Date ranges differ. Annualized return is more comparable than total return." : "方案的回测区间不同，建议优先比较年化收益率，总收益率仅作参考。")}
              </div>
            )}
            <div className="mt-2 space-y-2">
              {savedBacktests.map((item) => (
                <div key={item.id} className="flex items-start gap-2 rounded-xl border border-app-border bg-app-card px-3 py-2.5">
                  <button type="button" onClick={() => loadSavedBacktest(item)} disabled={!item.form} className="min-w-0 flex-1 text-left disabled:cursor-default focus:outline-none">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] font-semibold text-tp">{item.name}</span>
                      <span className="shrink-0 text-[12px] font-bold" style={{ color: profitColor(item.totalReturn) }}>{formatPercent(item.totalReturn)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] leading-4 text-tmi">
                      <span>{item.symbol} · {strategyLabel(item.strategy, isEn)} · {item.startDate.slice(0, 7)} - {item.endDate.slice(0, 7)}</span>
                      {comparisonMeta && item.totalReturn === comparisonMeta.bestReturn && <span className="shrink-0 rounded bg-[rgba(242,78,78,0.1)] px-1 py-0.5 font-semibold" style={{ color: profitColor(1) }}>{isEn ? "Best return" : "总收益最高"}</span>}
                    </div>

                    <div className="mt-2.5 grid grid-cols-3 gap-x-2 gap-y-2 border-t border-app-border pt-2.5 text-[10px] leading-[1.35]">
                      <span className="text-tmi">{isEn ? "P/L" : "收益金额"}</span>
                      <span className="text-tmi">{isEn ? "Annualized" : "年化收益"}</span>
                      <span className="text-tmi">{isEn ? "Max DD" : "最大回撤"}</span>
                      <span className="font-bold" style={{ color: profitColor(item.totalPnl) }}>
                        {item.totalPnl >= 0 ? "+" : "-"}{formatExactMoney(Math.abs(item.totalPnl), item.currency, 2)}
                      </span>
                      <span className="font-bold" style={{ color: profitColor(item.annualizedReturn) }}>
                        {formatPercent(item.annualizedReturn)}{comparisonMeta && item.annualizedReturn === comparisonMeta.bestAnnualized ? ` · ${isEn ? "Best" : "最高"}` : ""}
                      </span>
                      <span className="font-bold" style={{ color: profitColor(-item.maxDrawdown) }}>
                        {formatPercent(-item.maxDrawdown)}{comparisonMeta && item.maxDrawdown === comparisonMeta.lowestDrawdown ? ` · ${isEn ? "Lowest" : "最低"}` : ""}
                      </span>

                      <span className="text-tmi">{isEn ? "Invested" : "投入本金"}</span>
                      <span className="text-tmi">{isEn ? "Ending value" : "期末总值"}</span>
                      <span className="text-tmi">{isEn ? "Fees / taxes" : "手续费 / 税费"}</span>
                      <span className="font-semibold text-ts">{item.totalInvested == null ? (isEn ? "Not recorded" : "未记录") : formatExactMoney(item.totalInvested, item.currency, 2)}</span>
                      <span className="font-semibold text-ts">{item.finalValue == null ? (isEn ? "Not recorded" : "未记录") : formatExactMoney(item.finalValue, item.currency, 2)}</span>
                      <span className="font-semibold text-ts">{item.totalFees == null || item.totalTaxes == null ? (isEn ? "Not recorded" : "未记录") : `${formatExactMoney(item.totalFees, item.currency, 2)} / ${formatExactMoney(item.totalTaxes, item.currency, 2)}`}</span>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-4 text-tmi">
                      <span>{isEn ? "Dividends" : "分红"}: <span style={{ color: item.totalDividends != null && item.dividendDataStatus === "explicit" ? profitColor(item.totalDividends) : "var(--text-micro)", fontWeight: 700 }}>
                          {item.totalDividends == null
                            ? (isEn ? "Not recorded" : "未记录")
                            : item.dividendDataStatus === "embedded"
                              ? (isEn ? "Included" : "已含在收益中")
                              : item.dividendDataStatus === "unavailable"
                                ? (isEn ? "Unavailable" : "未拆分")
                                : item.dividendDataStatus === "not_applicable"
                                  ? (isEn ? "N/A" : "不适用")
                                  : formatExactMoney(item.totalDividends, item.currency, 2)}
                      </span>
                      </span>
                      <span>·</span>
                      <span>{item.dividendMode == null ? (isEn ? "Dividend mode not recorded" : "分红方式未记录") : item.dividendMode === "reinvest" ? (isEn ? "Dividend reinvestment" : "红利再投") : (isEn ? "Cash dividends" : "现金分红")}</span>
                      {item.tradeCount != null && <><span>·</span><span>{isEn ? `${item.tradeCount} trades` : `${item.tradeCount} 笔交易`}</span></>}
                      {item.liquidatedAtEnd != null && <><span>·</span><span>{item.liquidatedAtEnd ? (isEn ? "Liquidated" : "期末清仓") : (isEn ? "Held" : "期末持有")}</span></>}
                    </div>

                    {item.benchmarkSummary && (
                      <div className="mt-2.5 rounded-lg bg-app-surface px-2.5 py-2 text-[10px] leading-4 text-tm">
                        {isEn ? "Benchmark" : "对比基准"} {item.benchmarkSummary.label} {formatPercent(item.benchmarkSummary.totalReturn)} · {isEn ? "Excess" : "超额收益"} <span className="font-bold" style={{ color: profitColor(item.totalReturn - item.benchmarkSummary.totalReturn) }}>{formatPercent(item.totalReturn - item.benchmarkSummary.totalReturn)}</span>
                      </div>
                    )}
                  </button>
                  <button type="button" onClick={() => persistSavedBacktests(savedBacktests.filter((saved) => saved.id !== item.id))} aria-label={isEn ? "Delete saved backtest" : "删除已保存方案"} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tmi">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2.5 text-[10px] leading-4 text-tmi">{isEn ? "Best labels only compare saved results. Select a row to restore and rerun it." : "“最高/最低”仅在已保存方案内比较。点击方案会恢复参数并自动重新回测。"}</p>
          </section>
        )}

        {pageTab === "compare" && savedBacktests.length === 0 && (
          <section className="flex min-h-[390px] flex-col items-center justify-center px-8 text-center">
            <Save size={22} color="#4F9CF9" />
            <p className="mt-3 text-xs font-semibold text-tp">{isEn ? "No saved comparisons" : "还没有已保存方案"}</p>
            <p className="mt-1.5 text-[10px] leading-4 text-tmi">{isEn ? "Run a backtest and save it to compare return, dividends, annualized return, and drawdown here." : "完成回测后保存方案，可在这里对比收益、分红、年化和回撤。"}</p>
            <button type="button" onClick={() => setPageTab("backtest")} className="mt-4 rounded-lg bg-app-accent px-4 py-2 text-[10px] font-semibold text-white">
              {isEn ? "Go to backtest" : "去回测"}
            </button>
          </section>
        )}
      </div>

      {embedded && pageTab === "backtest" && (
        <div
          className="shrink-0 border-t border-app-border px-3 py-2.5"
          style={{
            background: "color-mix(in srgb, var(--bg) 94%, transparent)",
            backdropFilter: "blur(16px)",
          }}
        >
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-app-accent text-[13px] font-bold text-white shadow-sm transition-[transform,opacity] active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw size={15} className={loading ? "animate-spin-smooth" : undefined} />
            {loading
              ? (isEn ? "Running backtest…" : "回测计算中…")
              : (isEn ? "Run backtest" : "开始回测")}
          </button>
        </div>
      )}
    </div>
  );
}
