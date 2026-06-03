import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { TrendingUp, TrendingDown, RefreshCw, Globe } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useApp } from "../context/AppContext";
import { SparklineChart } from "../components/SparklineChart";
import { fetchDetailChart } from "../services/quoteApi";
import type { ChartPoint } from "../services/quoteApi";
import { emitQuoteSync, isSameQuoteTarget, subscribeQuoteSync } from "../services/quoteSync";
import { formatFixedNumber } from "../utils/numberFormat";
import { categoryLabel, t } from "../i18n";

/* ─── static market catalogue ──────────────────────────
   Metadata only. Real values are fetched at runtime. */
type Category = "全部" | "美股" | "港股" | "A股" | "日股" | "加密" | "大宗" | "汇率";

interface IndexEntry {
  id:           string;
  name:         string;
  shortName?:   string;
  category:     Exclude<Category, "全部">;
  currentValue: number | null;
  changeRate:   number | null;
  changeAmount: number | null;
  unit:         string;   // "pts" | "USD" | "CNY" | "%"
  currency:     string;   // display prefix  e.g. "$"
  data:         { v: number }[];
  detailPoints?: ChartPoint[];
  yahooSymbol:  string;
  displaySymbol:string;
  chartAvailable?: boolean;
}

function sparklineDataFromPoints(points: ChartPoint[]) {
  return points
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .map((point) => ({ v: point.price }));
}

function hasSparklinePoints(points: ChartPoint[]) {
  return sparklineDataFromPoints(points).length > 1;
}

function timeLabel(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item, index);
    }
  }));
  return results;
}

const INDICES: IndexEntry[] = [
  /* ── US ───────────────────────────────────────────── */
  {
    id: "sp500", name: "标普 500", shortName: "S&P 500",
    category: "美股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^GSPC", displaySymbol: "SPX",
  },
  {
    id: "ndx100", name: "纳斯达克 100", shortName: "NASDAQ 100",
    category: "美股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^NDX", displaySymbol: "NDX",
  },
  {
    id: "dji", name: "道琼斯工业", shortName: "DJIA",
    category: "美股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^DJI", displaySymbol: "DJIA",
  },
  {
    id: "vix", name: "恐慌指数", shortName: "VIX",
    category: "美股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^VIX", displaySymbol: "VIX",
  },
  /* ── HK ───────────────────────────────────────────── */
  {
    id: "hsi", name: "恒生指数", shortName: "HSI",
    category: "港股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^HSI", displaySymbol: "HSI",
  },
  {
    id: "hstech", name: "恒生科技", shortName: "HSTECH",
    category: "港股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^HSTECH", displaySymbol: "HSTECH",
  },
  {
    id: "hscei", name: "国企指数", shortName: "HSCEI",
    category: "港股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^HSCEI", displaySymbol: "HSCEI",
  },
  /* ── A股 ──────────────────────────────────────────── */
  {
    id: "sse", name: "上证指数", shortName: "SSE",
    category: "A股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "000001", displaySymbol: "000001",
  },
  {
    id: "szse", name: "深证成指", shortName: "SZSE",
    category: "A股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "399001", displaySymbol: "399001",
  },
  {
    id: "csi300", name: "沪深 300", shortName: "CSI 300",
    category: "A股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "000300", displaySymbol: "000300",
  },
  {
    id: "cyb", name: "创业板指", shortName: "GEM",
    category: "A股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "399006", displaySymbol: "399006",
  },
  {
    id: "kcb", name: "科创 50", shortName: "STAR 50",
    category: "A股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "000688", displaySymbol: "000688",
  },
  /* ── 日股 ─────────────────────────────────────────── */
  {
    id: "nikkei225", name: "日经 225", shortName: "NIKKEI 225",
    category: "日股", currentValue: null, changeRate: null, changeAmount: null,
    unit: "pts", currency: "", data: [],
    yahooSymbol: "^N225", displaySymbol: "N225",
  },
  /* ── 加密 ─────────────────────────────────────────── */
  {
    id: "btc", name: "比特币", shortName: "BTC",
    category: "加密", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD", currency: "$", data: [],
    yahooSymbol: "BTC-USD", displaySymbol: "BTC",
  },
  {
    id: "eth", name: "以太坊", shortName: "ETH",
    category: "加密", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD", currency: "$", data: [],
    yahooSymbol: "ETH-USD", displaySymbol: "ETH",
  },
  {
    id: "sol", name: "Solana", shortName: "SOL",
    category: "加密", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD", currency: "$", data: [],
    yahooSymbol: "SOL-USD", displaySymbol: "SOL",
  },
  {
    id: "bnb", name: "币安币", shortName: "BNB",
    category: "加密", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD", currency: "$", data: [],
    yahooSymbol: "BNB-USD", displaySymbol: "BNB",
  },
  {
    id: "xrp", name: "瑞波币", shortName: "XRP",
    category: "加密", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD", currency: "$", data: [],
    yahooSymbol: "XRP-USD", displaySymbol: "XRP",
  },
  /* ── 大宗 ─────────────────────────────────────────── */
  {
    id: "gold", name: "COMEX 黄金", shortName: "GC=F",
    category: "大宗", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD/oz", currency: "$", data: [],
    yahooSymbol: "GC=F", displaySymbol: "GC=F",
  },
  {
    id: "silver", name: "COMEX 白银", shortName: "SI=F",
    category: "大宗", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD/oz", currency: "$", data: [],
    yahooSymbol: "SI=F", displaySymbol: "SI=F",
  },
  {
    id: "oil", name: "NYMEX WTI 原油", shortName: "CL=F",
    category: "大宗", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD/桶", currency: "$", data: [],
    yahooSymbol: "CL=F", displaySymbol: "CL=F",
  },
  {
    id: "copper", name: "COMEX 铜", shortName: "HG=F",
    category: "大宗", currentValue: null, changeRate: null, changeAmount: null,
    unit: "USD/lb", currency: "$", data: [],
    yahooSymbol: "HG=F", displaySymbol: "HG=F",
  },
  /* ── 汇率 ─────────────────────────────────────────── */
  {
    id: "usdcny", name: "美元/人民币", shortName: "USD/CNY",
    category: "汇率", currentValue: null, changeRate: null, changeAmount: null,
    unit: "CNY", currency: "¥", data: [],
    yahooSymbol: "CNY=X", displaySymbol: "USDCNY",
  },
  {
    id: "eurcny", name: "欧元/人民币", shortName: "EUR/CNY",
    category: "汇率", currentValue: null, changeRate: null, changeAmount: null,
    unit: "CNY", currency: "¥", data: [],
    yahooSymbol: "EURCNY=X", displaySymbol: "EURCNY",
  },
  {
    id: "gbpcny", name: "英镑/人民币", shortName: "GBP/CNY",
    category: "汇率", currentValue: null, changeRate: null, changeAmount: null,
    unit: "CNY", currency: "¥", data: [],
    yahooSymbol: "GBPCNY=X", displaySymbol: "GBPCNY",
  },
  {
    id: "hkdcny", name: "港元/人民币", shortName: "HKD/CNY",
    category: "汇率", currentValue: null, changeRate: null, changeAmount: null,
    unit: "CNY", currency: "¥", data: [],
    yahooSymbol: "HKDCNY=X", displaySymbol: "HKDCNY",
  },
  {
    id: "jpycny", name: "日元/人民币", shortName: "JPY/CNY",
    category: "汇率", currentValue: null, changeRate: null, changeAmount: null,
    unit: "CNY", currency: "¥", data: [],
    yahooSymbol: "JPYCNY=X", displaySymbol: "JPYCNY",
  },
];

/* ─── category config ────────────────────────────────── */
const CATS: { key: Category; label: string; color: string }[] = [
  { key: "全部", label: "全部",   color: "#4F9CF9" },
  { key: "美股", label: "美股",   color: "#60A5FA" },
  { key: "港股", label: "港股",   color: "#F472B6" },
  { key: "A股",  label: "A股",    color: "#F24E4E" },
  { key: "日股", label: "日股",   color: "#38BDF8" },
  { key: "加密", label: "加密",   color: "#F59E0B" },
  { key: "大宗", label: "大宗",   color: "#FCD34D" },
  { key: "汇率", label: "汇率",   color: "var(--text-secondary)" },
];

let marketPageCache: {
  indices: IndexEntry[];
  lastRefreshed: string;
  syncedAt: number;
} | null = null;

/* ─── helpers ────────────────────────────────────────── */
function showCurrencyForEntry(entry: IndexEntry) {
  return entry.category !== "美股" && entry.category !== "港股" && entry.category !== "A股"
    && !(entry.category === "日股" && entry.unit === "pts");
}

function marketForEntry(entry: IndexEntry) {
  if (entry.category === "A股") return "A";
  if (entry.category === "港股") return "HK";
  if (entry.category === "加密") return "CRYPTO";
  if (entry.category === "汇率") return "FX";
  if (entry.category === "日股" && entry.unit !== "pts") return "JP";
  if (entry.category === "大宗") return "COMMODITY";
  return "INDEX";
}

function assetTypeForEntry(entry: IndexEntry) {
  if (entry.category === "日股" && entry.unit !== "pts") return "stock";
  if (entry.category === "加密") return "crypto";
  if (entry.category === "大宗") return "commodity";
  return "index";
}


function fmtValue(entry: IndexEntry) {
  const { currentValue, currency, category } = entry;
  if (!(typeof currentValue === "number" && Number.isFinite(currentValue) && currentValue > 0)) return "—";
  const decimals = category === "汇率" ? 5 : 3;
  return `${showCurrencyForEntry(entry) ? currency : ""}${formatFixedNumber(currentValue, decimals)}`;
}
function fmtChange(entry: IndexEntry, color: string, language: "zh" | "en") {
  const { changeAmount, changeRate, currency, category } = entry;
  if (changeAmount == null || changeRate == null || !Number.isFinite(changeAmount) || !Number.isFinite(changeRate)) {
    return (
      <span style={{ color: "var(--text-micro)", fontSize: 10, fontWeight: 500 }}>
        {t(language).common.noData}
      </span>
    );
  }
  const decimals = category === "汇率" ? 5 : 3;
  const direction = changeAmount === 0
    ? (changeRate >= 0 ? 1 : -1)
    : (changeAmount >= 0 ? 1 : -1);
  const sign   = direction >= 0 ? "+" : "-";
  const arrow  = direction >= 0 ? "▲" : "▼";
  const prefix = showCurrencyForEntry(entry) ? currency : "";
  return (
    <span style={{ color, fontSize: 11, fontWeight: 600 }}>
      {sign}{prefix}{formatFixedNumber(Math.abs(changeAmount), decimals)} ({arrow}{(Math.abs(changeRate) * 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)
    </span>
  );
}

/* ═══════════════════════════════════════════════════════
   IndexCard
══════════════════════════════════════════════════════════ */
function IndexCard({ entry, catColor, onPress }: {
  entry:    IndexEntry;
  catColor: string;
  onPress:  () => void;
}) {
  const { profitColor, language } = useApp();
  const text = t(language);
  const [hovered, setHovered] = useState(false);
  const resolvedRate = entry.changeAmount != null && Number.isFinite(entry.changeAmount)
    ? entry.changeAmount
    : (entry.changeRate ?? 0);
  const sparklineData = useMemo(
    () => entry.detailPoints?.length
      ? sparklineDataFromPoints(entry.detailPoints)
      : entry.data,
    [entry],
  );
  const c  = profitColor(resolvedRate);
  const isUp = resolvedRate >= 0;
  const borderColor = hovered ? "rgba(79,156,249,0.25)" : "var(--border-sub)";

  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      whileTap={{ scale: 0.98 }}
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative w-full rounded-xl overflow-hidden px-3 py-2.5 text-left transition-all"
      style={{
        background:      "var(--bg-card)",
        borderStyle:     "solid",
        borderWidth:     1,
        borderColor,
      }}
    >
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 bottom-0"
        style={{ width: 3, background: catColor }}
      />
      <div className="flex items-start gap-2">
        {/* Left: name + value */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 600 }}>{language === "en" ? entry.shortName ?? entry.name : entry.name}</span>
            {entry.shortName && (
              <span style={{ color: "var(--text-micro)", fontSize: 9 }}>{entry.shortName}</span>
            )}
          </div>
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
            {fmtValue(entry)}
          </span>
          <div className="flex items-center gap-1 mt-0.5">
            {isUp
              ? <TrendingUp  size={10} color={c} />
              : <TrendingDown size={10} color={c} />}
            {fmtChange(entry, c, language)}
          </div>
          <span style={{ color: "var(--text-micro)", fontSize: 9, marginTop: 2, display: "block" }}>{entry.unit}</span>
        </div>
        {/* Right: sparkline */}
        <div style={{ width: 120, flexShrink: 0, marginTop: 4 }}>
          {sparklineData.length > 1 ? (
            <SparklineChart data={sparklineData} color={c} height={40} />
          ) : (
            <div
              className="h-[40px] rounded-lg flex items-center justify-center"
              style={{ background: "var(--bg-surface2)", color: "var(--text-micro)", fontSize: 9 }}
            >
              {text.common.noChart}
            </div>
          )}
        </div>
      </div>
    </motion.button>
  );
}

/* ═══════════════════════════════════════════════════════
   Market page
══════════════════════════════════════════════════════════ */
export function Market() {
  const {
    openDetail,
    lastRefreshAt: globalLastRefreshAt,
    lastRefreshed: globalLastRefreshed,
    isRefreshing: globalIsRefreshing,
    profitColor,
    language,
  } = useApp();
  const text = t(language);
  const [indices, setIndices] = useState<IndexEntry[]>(() => marketPageCache?.indices ?? []);
  const [activeTab, setActiveTab] = useState<Category>("全部");
  const [refreshing, setRefreshing] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(() => Boolean(marketPageCache));
  const lastSyncedRefreshRef = useRef<number>(marketPageCache?.syncedAt ?? 0);
  const indicesRef = useRef(indices);
  useEffect(() => { indicesRef.current = indices; }, [indices]);

  // Display global refresh time when available, otherwise show local cache time
  const lastRefreshed = globalLastRefreshed || marketPageCache?.lastRefreshed || text.common.loading;

  const doRefresh = useCallback(async (
    current: IndexEntry[],
    force = false,
    syncedAt = 0,
    showSpinner = false,
  ) => {
    if (showSpinner) setRefreshing(true);
    try {
      const source = current.length ? current : INDICES;
      const updated = await mapWithConcurrency(source, 6, async (entry) => {
        try {
          const chart = await fetchDetailChart(entry.yahooSymbol, marketForEntry(entry), "fs", force);
          const q = chart.quote;
          const nextValue = q.price > 0 ? q.price : null;
          const normalizedChange = Number.isFinite(q.change) ? q.change : null;
          const normalizedChangeRate = Number.isFinite(q.changePercent)
            ? (normalizedChange != null && normalizedChange !== 0
              ? Math.abs(q.changePercent) * (normalizedChange >= 0 ? 1 : -1)
              : q.changePercent)
            : null;
          emitQuoteSync({
            symbol: entry.yahooSymbol,
            market: marketForEntry(entry),
            range: "fs",
            source: "market",
            quote: {
              ...q,
              change: normalizedChange ?? q.change,
              changePercent: normalizedChangeRate ?? q.changePercent,
            },
            points: chart.points,
            refreshedAt: Date.now(),
          });
          const hasChart = hasSparklinePoints(chart.points);
          return {
            ...entry,
            currentValue: nextValue,
            changeAmount: normalizedChange,
            changeRate: normalizedChangeRate,
            data: hasChart
              ? sparklineDataFromPoints(chart.points)
              : [],
            detailPoints: hasChart ? chart.points : entry.detailPoints,
            chartAvailable: hasChart,
          };
        } catch {
          return {
            ...entry,
            currentValue: entry.currentValue ?? null,
            changeAmount: entry.changeAmount ?? null,
            changeRate: entry.changeRate ?? null,
            data: entry.data,
            detailPoints: entry.detailPoints,
            chartAvailable: entry.chartAvailable ?? false,
          };
        }
      });
      setIndices(updated);
      marketPageCache = {
        indices: updated,
        lastRefreshed: timeLabel(),
        syncedAt,
      };
    } finally {
      if (showSpinner) setRefreshing(false);
      setBootstrapped(true);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    if (refreshing || manualRefreshing || globalIsRefreshing) return;
    setManualRefreshing(true);
    const source = indicesRef.current.length ? indicesRef.current : (marketPageCache?.indices ?? INDICES);
    void doRefresh(source, true, Date.now(), true);
  }, [doRefresh, refreshing, manualRefreshing, globalIsRefreshing]);

  useEffect(() => {
    if (!refreshing) {
      setManualRefreshing(false);
    }
  }, [refreshing]);

  // Follow the global holdings refresh cycle so settings-based auto refresh
  // also keeps the market page in sync. Uses cache (force=false) to avoid
  // redundant network requests if data was recently fetched.
  useEffect(() => {
    if (!globalLastRefreshAt) return;
    if (lastSyncedRefreshRef.current === globalLastRefreshAt) return;
    lastSyncedRefreshRef.current = globalLastRefreshAt;
    const source = indicesRef.current.length ? indicesRef.current : (marketPageCache?.indices ?? INDICES);
    void doRefresh(source, false, globalLastRefreshAt, false);
  }, [doRefresh, globalLastRefreshAt]);

  useEffect(() => subscribeQuoteSync((payload) => {
    if (payload.source !== "detail") return;
    setIndices((current) => {
      let changed = false;
      const next = current.map((entry) => {
        if (!isSameQuoteTarget(
          { symbol: entry.yahooSymbol, market: marketForEntry(entry) },
          { symbol: payload.symbol, market: payload.market },
        )) {
          return entry;
        }
        changed = true;
        const normalizedChange = Number.isFinite(payload.quote.change) ? payload.quote.change : entry.changeAmount;
        const normalizedChangeRate = Number.isFinite(payload.quote.changePercent)
          ? (normalizedChange != null && normalizedChange !== 0
            ? Math.abs(payload.quote.changePercent) * (normalizedChange >= 0 ? 1 : -1)
            : payload.quote.changePercent)
          : entry.changeRate;
        const hasChart = payload.range === "fs" && payload.points
          ? hasSparklinePoints(payload.points)
          : false;
        return {
          ...entry,
          currentValue: payload.quote.price > 0 ? payload.quote.price : entry.currentValue,
          changeAmount: normalizedChange,
          changeRate: normalizedChangeRate,
          data: hasChart
            ? sparklineDataFromPoints(payload.points ?? [])
            : entry.data,
          detailPoints: hasChart
            ? payload.points
            : entry.detailPoints,
          chartAvailable: payload.range === "fs" && payload.points ? hasChart : entry.chartAvailable,
        };
      });
      if (!changed) return current;
      marketPageCache = {
        indices: next,
        lastRefreshed: timeLabel(),
        syncedAt: marketPageCache?.syncedAt ?? lastSyncedRefreshRef.current,
      };
      return next;
    });
  }), []);

  const isAnyRefreshing = refreshing || manualRefreshing || globalIsRefreshing;

  const filtered = useMemo(
    () => activeTab === "全部" ? indices : indices.filter((e) => e.category === activeTab),
    [activeTab, indices],
  );

  /* group by category when showing "全部" */
  const sections = useMemo((): { key: Exclude<Category, "全部">; items: IndexEntry[] }[] => {
    if (activeTab !== "全部") return [{ key: activeTab as Exclude<Category, "全部">, items: filtered }];
    const map = new Map<Exclude<Category, "全部">, IndexEntry[]>();
    for (const entry of filtered) {
      if (!map.has(entry.category)) map.set(entry.category, []);
      map.get(entry.category)!.push(entry);
    }
    return Array.from(map.entries()).map(([key, items]) => ({ key, items }));
  }, [activeTab, filtered]);

  const handlePress = (entry: IndexEntry) => {
    openDetail({
      yahooSymbol:   entry.yahooSymbol,
      displaySymbol: entry.displaySymbol,
      name:          language === "en" ? entry.shortName ?? entry.name : entry.name,
      assetType:     assetTypeForEntry(entry),
      market:        marketForEntry(entry),
      unit:          entry.unit,
      showCurrency:  showCurrencyForEntry(entry),
      fallbackQuote: entry.currentValue && entry.changeAmount != null && entry.changeRate != null ? {
        price:         entry.currentValue,
        change:        entry.changeAmount,
        changePercent: entry.changeRate,
        currency:      entry.currency || "",
        exchange:      "Market List",
        points:        entry.detailPoints,
      } : undefined,
      decimals:       entry.category === "汇率" ? 5 : 3,
    });
  };

  /* summary stats for header */
  const activeMoves = indices
    .map((entry) => {
      if (typeof entry.changeAmount === "number" && Number.isFinite(entry.changeAmount) && entry.changeAmount !== 0) {
        return entry.changeAmount;
      }
      if (typeof entry.changeRate === "number" && Number.isFinite(entry.changeRate) && entry.changeRate !== 0) {
        return entry.changeRate;
      }
      return null;
    })
    .filter((value): value is number => value != null);
  const upCount   = activeMoves.filter((value) => value > 0).length;
  const downCount = activeMoves.filter((value) => value < 0).length;
  const upColor = profitColor(1);
  const downColor = profitColor(-1);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className="shrink-0 z-20"
        style={{
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          backdropFilter: "blur(14px)",
        }}
      >
        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-4 shrink-0"
          style={{ height: 50, borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2">
            <Globe size={15} color="#4F9CF9" />
            <span style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>{text.market.title}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg px-2 py-1"
              style={{ background: "var(--bg-card)" }}>
              <span style={{ color: upColor, fontSize: 10 }}>↑{upCount}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 10 }}>·</span>
              <span style={{ color: downColor, fontSize: 10 }}>↓{downCount}</span>
            </div>
            <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{lastRefreshed}</span>
            <button
              onClick={handleRefresh}
              className="flex items-center justify-center rounded-lg"
              aria-label={text.market.refresh}
              aria-busy={isAnyRefreshing}
              disabled={isAnyRefreshing}
              style={{ width: 30, height: 30, background: "var(--bg-card)" }}
            >
              <RefreshCw
                size={13}
                color={isAnyRefreshing ? "#4F9CF9" : "var(--text-muted)"}
                className={isAnyRefreshing ? "animate-spin-smooth" : undefined}
              />
            </button>
          </div>
        </div>

        {/* ── Category tabs ── */}
        <div className="flex gap-1.5 px-3 pt-2.5 pb-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {CATS.map(({ key, color }) => {
            const isActive = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className="rounded-full shrink-0 transition-all"
                style={{
                  padding:    "5px 13px",
                  fontSize:   11,
                  fontWeight: isActive ? 600 : 400,
                  background: isActive ? color                   : "var(--bg-card)",
                  color:      isActive ? "var(--bg)"               : "var(--text-muted)",
                  border:     isActive ? "1px solid transparent" : "1px solid var(--border)",
                }}
              >
                {categoryLabel(key, language)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Market sections ── */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 12 }}
      >
      <div className="flex flex-col gap-4 px-3 pt-1">
        {!bootstrapped && (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2, 3].map((n) => (
              <div
                key={n}
                className="rounded-xl"
                style={{ height: 72, background: "var(--bg-card)", animation: "pulse 1.5s ease-in-out infinite" }}
              />
            ))}
          </div>
        )}
        <AnimatePresence mode="wait">
          {bootstrapped && (
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-4"
          >
            {sections.map(({ key, items }) => {
              const sectionText = text.market.sections[key];
              const catEntry = CATS.find((c) => c.key === key);
              const catColor = catEntry?.color ?? "#4F9CF9";
              return (
                <div key={key}>
                  {/* Section title */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="rounded-full" style={{ width: 6, height: 6, background: catColor, boxShadow: `0 0 6px ${catColor}80` }} />
                    <span style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 600 }}>{sectionText?.[0] ?? categoryLabel(key, language)}</span>
                    {sectionText?.[1] && (
                      <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{sectionText[1]}</span>
                    )}
                    <span className="ml-auto rounded-full px-1.5 py-0.5"
                      style={{ fontSize: 9, color: "var(--text-micro)", background: "var(--bg-card)" }}>
                      {text.market.count(items.length)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {items.map((entry, i) => (
                      <motion.div
                        key={entry.id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.03 }}
                      >
                        <IndexCard
                          entry={entry}
                          catColor={catColor}
                          onPress={() => handlePress(entry)}
                        />
                      </motion.div>
                    ))}
                  </div>
                </div>
              );
            })}
          </motion.div>
          )}
        </AnimatePresence>
      </div>
      </div>

    </div>
  );
}
