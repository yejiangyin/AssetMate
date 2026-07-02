import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calculator, CalendarDays, ChevronDown, ChevronLeft, ChevronRight,
  Loader2, RefreshCw, TrendingUp, Wifi, WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "../context/AppContext";
import { fetchBacktestDailyPrices } from "../services/quoteApi";
import { searchSecuritiesLive, type LiveResult, type Market } from "../services/securitiesApi";
import { currencySymbol, formatExactMoney, formatPercent } from "../utils/numberFormat";
import { BacktestInput, BacktestResult, BacktestStrategy, runBacktest } from "../utils/backtestEngine";
import { SparklineChart } from "../components/SparklineChart";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import { normalizeHoldingSymbol, normalizeHoldingType } from "../utils/holdingHelpers";
import { assetTypeLabel, marketLabel, t } from "../i18n";

const marketOptions = [
  { value: "US", label: "美股" },
  { value: "HK", label: "港股" },
  { value: "A", label: "A股" },
  { value: "JP", label: "日股" },
  { value: "FUND", label: "基金" },
  { value: "CRYPTO", label: "加密" },
];

function monthsAgoYMD(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

function yearsAgoYMD(years: number) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function displayDate(value: string) {
  return value ? value.replace(/-/g, "/") : "";
}

function parseYMD(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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
  if (market === "CRYPTO") return "USD";
  return "CNY";
}

function numberInput(value: number, onChange: (value: number) => void, placeholder?: string) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => onChange(Number(event.target.value))}
      placeholder={placeholder}
      className="w-full rounded-xl px-3"
      style={{
        height: 38,
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        color: "var(--text-primary)",
        fontSize: 13,
        outline: "none",
      }}
    />
  );
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
    <div className="rounded-2xl p-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
      <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{label}</p>
      <p className="truncate" style={{ color: color ?? "var(--text-primary)", fontSize: 14, fontWeight: 800, marginTop: 4 }}>
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
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<LiveResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doSearch = useCallback(async (query: string, filter?: Market) => {
    if (!query.trim()) {
      setHits([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const results = await searchSecuritiesLive(query, filter);
      setHits(results);
      setOpen(results.length > 0);
      setApiOk(results.length ? results[0]?.source === "live" : false);
    } catch {
      setHits([]);
      setApiOk(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (next: string) => {
    onChange(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(next, marketFilter), 350);
  };

  useEffect(() => {
    if (!value.trim()) return;
    void doSearch(value, marketFilter);
    // Re-run only when the market filter changes; typing is debounced in handleChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSearch, marketFilter]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      clearTimeout(timerRef.current);
    };
  }, []);

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

function strategyBuyLabelWithPeriod(strategy: BacktestStrategy, period: number, isEn: boolean) {
  const label = strategyBuyLabel(strategy, isEn);
  if (strategy === "lump_sum" || period <= 0) return label;
  return isEn ? `${label} #${period}` : `${label} 第${period}期`;
}

export function Backtest() {
  const { language, profitColor, privacyMode } = useApp();
  const isEn = language === "en";
  const text = t(language);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 400 : window.innerWidth);
  const localizedMarketScopeOptions = useMemo(() => [
    { value: "" as Market | "", label: text.holdings.allMarkets },
    ...marketOptions.map((option) => ({ value: option.value as Market | "", label: marketLabel(option.value, language) })),
  ], [language, text.holdings.allMarkets]);
  const [form, setForm] = useState<BacktestInput>({
    symbol: "",
    market: "US",
    assetType: "stock",
    startDate: yearsAgoYMD(3),
    endDate: todayYMD(),
    initialAmount: 10000,
    strategy: "lump_sum",
    monthlyAmount: 1000,
    feeRate: 0,
  });
  const [securityQuery, setSecurityQuery] = useState("");
  const [marketScope, setMarketScope] = useState<Market | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);

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
  const quoteCurrency = currencyForMarket(form.market);
  const isCompactForm = viewportWidth < 380;

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const updateForm = <K extends keyof BacktestInput>(key: K, value: BacktestInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSecuritySelect = (result: LiveResult) => {
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
    setError("");
  };

  const run = async () => {
    const symbol = form.symbol.trim();
    if (!symbol) {
      setError(isEn ? "Enter a symbol first." : "请先输入标的代码。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const prices = await fetchBacktestDailyPrices(symbol, form.market, form.startDate, form.endDate);
      const sortedDates = prices.map((point) => point.date).sort();
      const inSelectedRange = prices.some((point) => point.date >= form.startDate && point.date <= form.endDate);
      if (!inSelectedRange) {
        const firstDate = sortedDates[0] ?? "";
        const lastDate = sortedDates[sortedDates.length - 1] ?? "";
        throw new Error(firstDate && lastDate ? `NO_PRICE_DATA:${firstDate}:${lastDate}` : "NO_PRICE_DATA");
      }
      const nextResult = runBacktest({ ...form, symbol }, prices);
      setResult(nextResult);
    } catch (err) {
      setResult(null);
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
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
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
        <button
          onClick={run}
          disabled={loading}
          className="flex items-center gap-1 rounded-xl px-3 py-2"
          style={{ background: "rgba(79,156,249,0.15)", color: "#4F9CF9", fontSize: 12, fontWeight: 800 }}
        >
          <RefreshCw size={13} className={loading ? "animate-spin-smooth" : undefined} />
          {isEn ? "Run" : "开始"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3" style={{ scrollbarWidth: "none", paddingBottom: 16 }}>
        <div className="rounded-2xl p-3" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-sub)" }}>
          <div className="flex gap-2 items-end mb-3">
            <label style={{ width: 120, flexShrink: 0 }}>
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{text.holdings.marketScope}</p>
              {selectInput(marketScope, (value) => {
                const next = value as Market | "";
                setMarketScope(next);
                setSecurityQuery("");
                setResult(null);
                setError("");
                if (next) updateForm("market", next);
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

          <div
            className="grid gap-2 items-end mt-3"
            style={{ gridTemplateColumns: isCompactForm ? "minmax(0, 1fr)" : "minmax(0, 1fr) 112px" }}
          >
            <label className="flex-1 min-w-0">
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Time Range" : "时间范围"}</p>
              <DateRangeField
                startDate={form.startDate}
                endDate={form.endDate}
                onChange={(startDate, endDate) => {
                  setForm((current) => ({ ...current, startDate, endDate }));
                  setResult(null);
                  setError("");
                }}
                isEn={isEn}
              />
            </label>
            <label style={{ minWidth: 0 }}>
              <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 5 }}>{isEn ? "Fee Rate" : "手续费率"}</p>
              {numberInput(form.feeRate, (value) => updateForm("feeRate", value), "0.001")}
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
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-2xl px-3 py-2" style={{ background: "rgba(242,78,78,0.1)", color: "#F24E4E", fontSize: 12 }}>
            {error}
          </div>
        )}

        {result ? (
          <div className="mt-3 flex flex-col gap-3">
            <div className="rounded-2xl p-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
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
                    {result.priceMode === "adjusted"
                      ? (isEn ? "adjusted" : "复权口径")
                      : (isEn ? "incl. dividends" : "含分红")}
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
                  const money = (value: number) => privacyMode
                    ? `${currencySymbol(quoteCurrency)}***`
                    : formatExactMoney(value, quoteCurrency, 2);
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
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MetricCard label={isEn ? "Invested" : "投入本金"} value={privacyMode ? `${currencySymbol(quoteCurrency)}***` : formatExactMoney(result.totalInvested, quoteCurrency, 2)} />
              <MetricCard
                label={result.priceMode === "adjusted" ? (isEn ? "Adjusted Value" : "复权期末值") : (isEn ? "Market Value" : "期末市值")}
                value={privacyMode ? `${currencySymbol(quoteCurrency)}***` : formatExactMoney(result.finalMarketValue, quoteCurrency, 2)}
              />
              {result.priceMode === "adjusted" ? (
                <MetricCard label={isEn ? "Return Basis" : "收益口径"} value={isEn ? "Adjusted" : "前复权"} color={profitColor(result.totalPnl)} />
              ) : (
                <MetricCard
                  label={isEn ? "Dividends" : "分红收入"}
                  value={privacyMode ? `${currencySymbol(quoteCurrency)}***` : formatExactMoney(result.totalDividends, quoteCurrency, 2)}
                  color={profitColor(result.totalDividends)}
                />
              )}
              <MetricCard label={isEn ? "Ending Value" : "期末总值"} value={privacyMode ? `${currencySymbol(quoteCurrency)}***` : formatExactMoney(result.finalValue, quoteCurrency, 2)} />
              <MetricCard
                label={result.priceMode === "adjusted" ? (isEn ? "Total P/L" : "总收益") : (isEn ? "Total P/L incl. Div." : "总收益(含分红)")}
                value={`${result.totalPnl >= 0 ? "+" : "-"}${privacyMode ? `${currencySymbol(quoteCurrency)}--` : formatExactMoney(Math.abs(result.totalPnl), quoteCurrency, 2)}`}
                color={profitColor(result.totalPnl)}
              />
              <MetricCard label={isEn ? "Annualized" : "年化收益"} value={formatPercent(result.annualizedReturn)} color={profitColor(result.annualizedReturn)} />
              <MetricCard label={isEn ? "Max Drawdown" : "最大回撤"} value={formatPercent(-result.maxDrawdown)} color={profitColor(-result.maxDrawdown)} />
              <MetricCard label={isEn ? "Data Points" : "日线点数"} value={`${result.points.length}`} />
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-2xl p-4 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}>
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 800 }}>
              {isEn ? "Run a backtest to see the result." : "输入参数后开始回测。"}
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              {isEn ? "Uses daily historical prices only. Intraday data is intentionally excluded." : "回测只使用日线历史，不使用分时数据。"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
