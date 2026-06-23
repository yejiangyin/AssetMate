/**
 * Quote & Chart data service
 * Detail charts always prefer real upstream data.
 * When real chart data is unavailable, we keep the latest valid quote
 * and surface an explicit empty-chart state in the UI.
 */

import { fetchCnFundEstimate, fetchCnFundOfficialHistory, fetchCnFundOfficialNav, fetchCryptoPrice } from "./securitiesApi";
import { fetchEastMoneyChart, fetchEastMoneyQuoteBySymbol } from "./eastMoneyApi";
import { fetchNasdaqChart, fetchNasdaqExtendedQuote } from "./nasdaqApi";
import { fetchTencentIntraday, fetchTencentKline, fetchTencentQuote, fetchTencentQuoteFromYahooSymbol } from "./tencentQuote";
import { fetchBinanceCryptoKline, fetchBinanceCryptoQuote, fetchOkxCryptoKline, fetchOkxCryptoQuote, type PublicQuote } from "./publicMarketApi";
import { fetchRobinhoodExtendedQuote } from "./robinhoodApi";
import { formatExactMoney, formatExactNumber } from "../utils/numberFormat";
import {
  mergePointSeries,
  readPersistentEntry,
  shouldFullRefresh,
  shouldUseFreshCache,
  writePersistentEntry,
} from "./persistentDataCache";

/* ═══════════════════════════════════════════════════════
   Types
══════════════════════════════════════════════════════════ */
export type TimeRange = "fs" | "1d" | "5d" | "1mo" | "3mo" | "1y" | "max"
  | "f1mo" | "f3mo" | "f6mo" | "f1y" | "f3y" | "f5y" | "f10y" | "fmax";

export const RANGE_TABS: { value: TimeRange; label: string }[] = [
  { value: "fs",  label: "分时" },
  { value: "1d",  label: "日" },
  { value: "5d",  label: "周" },
  { value: "1mo", label: "月" },
  { value: "3mo", label: "季" },
  { value: "1y",  label: "年" },
  { value: "max", label: "全时" },
];

export const FUND_RANGE_TABS: { value: TimeRange; label: string }[] = [
  { value: "f1mo",  label: "近1月" },
  { value: "f3mo",  label: "近3月" },
  { value: "f6mo",  label: "近半年" },
  { value: "f1y",   label: "近1年" },
  { value: "f3y",   label: "近3年" },
  { value: "f5y",   label: "近5年" },
  { value: "f10y",  label: "近10年" },
  { value: "fmax",  label: "全时" },
];

function yahooQuerySpec(range: TimeRange) {
  switch (range) {
    case "fs":
      // 1m granularity for the intraday view. Yahoo allows up to 7 days of
      // 1m data, so we pull 5d to safely cover Monday-morning lookbacks where
      // the last US session was Friday. buildIntradayViewportPoints filters
      // to the latest trading day on the client side.
      return { rangeParam: "5d", interval: "1m" };
    case "1d":
      return { rangeParam: "max", interval: "1d" };
    case "5d":
      return { rangeParam: "max", interval: "1wk" };
    case "1mo":
      return { rangeParam: "max", interval: "1mo" };
    case "3mo":
      return { rangeParam: "max", interval: "1mo" };
    case "1y":
      return { rangeParam: "max", interval: "1mo" };
    case "max":
    default:
      return { rangeParam: "max", interval: "1mo" };
  }
}

function yahooIncrementalWindowDays(range: TimeRange) {
  switch (range) {
    case "1d":
      return 45;
    case "5d":
      return 140;
    case "1mo":
    case "max":
      return 540;
    default:
      return 0;
  }
}

export interface ChartPoint {
  time:   string;
  price:  number;
  timestamp?: number;
  dateLabel?: string;
  volume?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

export interface QuoteInfo {
  symbol:        string;
  name:          string;
  price:         number;
  change:        number;
  changePercent: number;
  open:          number;
  high:          number;
  low:           number;
  prevClose:     number;
  volume:        number;
  marketCap?:    number;
  pe?:           number;
  eps?:          number;
  week52High?:   number;
  week52Low?:    number;
  currency:      string;
  exchange:      string;
  isLive:        boolean;
  /** Extended hours fields (US stocks / crypto) */
  marketState?:           string;
  preMarketPrice?:        number;
  preMarketChange?:       number;
  preMarketChangePercent?: number;
  postMarketPrice?:       number;
  postMarketChange?:      number;
  postMarketChangePercent?: number;
  overnightPrice?:        number;
  overnightChange?:       number;
  overnightChangePercent?: number;
}

export interface ChartData {
  quote:  QuoteInfo;
  points: ChartPoint[];
}

interface FundHistoryItem {
  date: string;
  nav: number;
  changePercent?: number;
}

/* ═══════════════════════════════════════════════════════
   Symbol helpers
══════════════════════════════════════════════════════════ */

/** Map our internal market+symbol to Yahoo Finance ticker */
export function toYahooSymbol(symbol: string, market: string): string {
  const raw = symbol.replace(/\.(SS|SZ)$/i, "");
  if (market === "CRYPTO") {
    if (symbol.endsWith("-USD") || symbol.endsWith("-USDT")) return symbol;
    return `${symbol}-USD`;
  }
  if (market === "GOLD") {
    if (symbol === "XAUUSD") return "GC=F";
    return toYahooSymbol(symbol, "A");
  }
  if (market === "HK") {
    const hkRaw = symbol.replace(/\.HK$/i, "");
    // Yahoo Finance uses 4-digit Hong Kong tickers, while our app stores HK codes as 5 digits.
    return `${hkRaw.replace(/^0+/, "").padStart(4, "0")}.HK`;
  }
  if (market === "JP") {
    return `${symbol.replace(/\.T$/i, "")}.T`;
  }
  if (market === "A" || market === "FUND" || market === "BOND") {
    if (/\.(SS|SZ)$/i.test(symbol)) return symbol;
    const isShanghai = /^(5|6|9)/.test(raw) || /^(11|13)/.test(raw);
    return isShanghai ? `${raw}.SS` : `${raw}.SZ`;
  }
  return symbol; // US stocks are already in Yahoo format
}

/** Known index id → Yahoo Finance mapping */
export const INDEX_YAHOO: Record<string, { yahoo: string; display: string }> = {
  ndx100: { yahoo: "^NDX",     display: "NDX"     },
  hstech: { yahoo: "^HSTECH",  display: "HSTECH"  },
  hscei:  { yahoo: "^HSCEI",   display: "HSCEI"   },
  sse:    { yahoo: "000001.SS", display: "000001"  },
  btc:    { yahoo: "BTC-USD",   display: "BTC"     },
  sp500:  { yahoo: "^GSPC",    display: "SPX"     },
  dji:    { yahoo: "^DJI",     display: "DJIA"    },
  hsi:    { yahoo: "^HSI",     display: "HSI"     },
  szse:   { yahoo: "399001.SZ", display: "399001" },
  cyb:    { yahoo: "399006.SZ", display: "399006" },
  nikkei: { yahoo: "^N225",    display: "N225"    },
};

const HK_INDEX_YAHOO_SYMBOL: Record<string, string> = {
  HSI: "^HSI",
  HSTECH: "^HSTECH",
  HSCEI: "^HSCEI",
};

const HK_INDEX_SYMBOLS = new Set(["HSI", "HSTECH", "HSCEI"]);

const A_INDEX_SYMBOLS = new Set(["000001", "399001", "000300", "399006", "000688"]);
const A_INDEX_YAHOO_SYMBOL: Record<string, string> = {
  "000001": "000001.SS",
  "399001": "399001.SZ",
  "000300": "000300.SS",
  "399006": "399006.SZ",
  "000688": "000688.SS",
};

/* ═══════════════════════════════════════════════════════
   Time label formatter
══════════════════════════════════════════════════════════ */
function yahooDisplayTimeZone(yahooSymbol: string) {
  const upper = yahooSymbol.toUpperCase();
  // Japan quotes are displayed in Beijing time (UTC+8) for consistency with
  // the rest of the app. Tokyo is UTC+9, so all JPX session times shift back 1h.
  if (upper.endsWith(".T") || upper === "^N225" || upper === "N225") return "Asia/Shanghai";
  return undefined;
}

export function formatYahooTimestamp(ts: number, range: TimeRange, yahooSymbol = ""): string {
  const d = new Date(ts * 1000);
  const timeZone = yahooDisplayTimeZone(yahooSymbol);
  if (range === "fs") {
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
  }
  if (range === "1d") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (range === "5d") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (range === "1mo" || range === "max") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
  }
  if (range === "3mo") {
    return `${String(d.getFullYear()).slice(2)}/Q${Math.floor(d.getMonth() / 3) + 1}`;
  }
  if (range === "1y") {
    return String(d.getFullYear());
  }
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
}

function fmtFundDate(date: string, range: TimeRange): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  // Full history: year/month
  if (range === "max" || range === "fmax" || range === "f10y" || range === "f5y") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
  }
  // 3-year: year/month
  if (range === "f3y") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
  }
  // 1-year: month/day (all same year)
  if (range === "1y" || range === "f1y") {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  // Quarter / 6-month: may span year boundary
  if (range === "3mo" || range === "f6mo") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  // 1-month, 3-month, week: recent, month/day sufficient
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtFundFullDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fundHistoryPageSize(range: TimeRange): number {
  switch (range) {
    case "fs":
    case "1d":
      return 2;
    case "5d":
    case "f1mo":
      return 22;   // ~1 month of trading days
    case "1mo":
    case "f3mo":
      return 66;   // ~3 months
    case "f6mo":
      return 130;  // ~6 months
    case "3mo":
    case "f1y":
    case "1y":
      return 260;  // ~1 year
    case "f3y":
      return 780;  // ~3 years
    case "f5y":
      return 1300; // ~5 years
    case "f10y":
      return 2600; // ~10 years
    case "max":
    case "fmax":
      return 5000; // full history
  }
}

// Max display points per range — keeps chart readable
function fundMaxDisplayPoints(range: TimeRange): number {
  switch (range) {
    case "f1mo": return 22;
    case "f3mo": return 66;
    case "f6mo": return 130;
    case "f1y":  return 180;
    case "f3y":  return 220;
    case "f5y":  return 260;
    case "f10y": return 320;
    case "fmax": return 360;
    default:     return 180;
  }
}

function sampleFundPoints(points: ChartPoint[], maxPoints: number): ChartPoint[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const sampled: ChartPoint[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    const point = points[Math.round(i * step)];
    if (point) sampled.push(point);
  }
  const lastPoint = points[points.length - 1];
  if (lastPoint) sampled.push(lastPoint);
  return sampled;
}

async function fetchFundHistory(code: string, range: TimeRange, signal: AbortSignal): Promise<FundHistoryItem[]> {
  if (signal.aborted) throw new Error("fund history aborted");
  const requiredSize = fundHistoryPageSize(range);
  const cacheKey = `fund-history::${code}`;
  const cached = readPersistentEntry<FundHistoryItem[]>(PERSISTENT_FUND_HISTORY_STORAGE_KEY, cacheKey);
  const cachedPoints = Array.isArray(cached?.data) ? cached.data : [];
  const hasEnoughCachedHistory = cachedPoints.length >= Math.min(requiredSize, 5000);
  const needsFullRefresh = shouldFullRefresh(cached, WEEKLY_FULL_REFRESH_TTL) || !hasEnoughCachedHistory;
  const pageSize = needsFullRefresh ? requiredSize : Math.min(INCREMENTAL_FUND_HISTORY_SIZE, Math.max(requiredSize, 2));
  const rows = await fetchCnFundOfficialHistory(code, pageSize);
  const points = rows
    .map((row) => ({
      date: row.date,
      nav: row.nav,
      changePercent: row.changePercent,
    }))
    .reverse();
  if (!points.length && cachedPoints.length) return cachedPoints.slice(-requiredSize);
  if (!points.length) throw new Error("empty fund history");

  const merged = needsFullRefresh
    ? points
    : mergePointSeries(cachedPoints, points, 5000);
  writePersistentEntry(PERSISTENT_FUND_HISTORY_STORAGE_KEY, cacheKey, merged, {
    maxEntries: PERSISTENT_FUND_HISTORY_MAX_ITEMS,
    fullRefresh: needsFullRefresh,
    previousFullRefreshAt: cached?.lastFullRefreshAt,
  });
  return merged.slice(-requiredSize);
}

function hasRealChartPoints(points: ChartPoint[]) {
  return points.some((point) => point.price > 0);
}

function buildYahooRawPoints(result: any, range: TimeRange, yahooSymbol = "") {
  const tss: number[] = result?.timestamp ?? [];
  const q0 = result?.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = q0.open ?? [];
  const highs: (number | null)[] = q0.high ?? [];
  const lows: (number | null)[] = q0.low ?? [];
  const closes: (number | null)[] = q0.close ?? [];
  const vols: (number | null)[] = q0.volume ?? [];

  const rawPoints: Array<ChartPoint & { ts: number }> = [];
  for (let i = 0; i < tss.length; i++) {
    const price = closes[i];
    if (price == null || isNaN(price)) continue;
    rawPoints.push({
      ts: tss[i]!,
      time: formatYahooTimestamp(tss[i]!, range, yahooSymbol),
      timestamp: tss[i]! * 1000,
      dateLabel: range === "fs"
        ? new Date(tss[i]! * 1000).toLocaleDateString("zh-CN", {
          month: "numeric",
          day: "numeric",
          ...(yahooDisplayTimeZone(yahooSymbol) ? { timeZone: yahooDisplayTimeZone(yahooSymbol) } : {}),
        })
        : undefined,
      price,
      volume: typeof vols[i] === "number" ? (vols[i] as number) : undefined,
      open: typeof opens[i] === "number" && Number.isFinite(opens[i]) ? opens[i] as number : undefined,
      high: typeof highs[i] === "number" && Number.isFinite(highs[i]) ? highs[i] as number : undefined,
      low: typeof lows[i] === "number" && Number.isFinite(lows[i]) ? lows[i] as number : undefined,
      close: typeof closes[i] === "number" && Number.isFinite(closes[i]) ? closes[i] as number : undefined,
    });
  }
  return rawPoints;
}

function toSourceRange(range: TimeRange): Exclude<TimeRange, "fs"> {
  if (range === "fs") return "1d";
  // Fund-specific ranges pass through directly to fetchFundChart
  return range;
}

function detailYahooSymbol(symbol: string, market: string) {
  if (market === "HK") {
    const raw = symbol.replace(/^\^/, "").replace(/\.HK$/i, "").toUpperCase();
    return HK_INDEX_YAHOO_SYMBOL[raw] ?? toYahooSymbol(raw, market);
  }
  const aRaw = symbol.replace(/\.(SS|SZ)$/i, "");
  if (market === "A" || (market === "INDEX" && A_INDEX_SYMBOLS.has(aRaw))) {
    return A_INDEX_YAHOO_SYMBOL[aRaw] ?? toYahooSymbol(aRaw, market);
  }
  return symbol;
}

function chartDataFromQuote(quote: QuoteInfo): ChartData {
  return { quote, points: [] };
}

function positiveValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizedExtendedSession(price: number | undefined, regularClose: number | undefined) {
  const safePrice = positiveValue(price);
  const safeRegularClose = positiveValue(regularClose);
  if (!safePrice || !safeRegularClose) return null;
  const change = safePrice - safeRegularClose;
  return {
    price: safePrice,
    change,
    changePercent: change / safeRegularClose,
  };
}

function normalizeUsExtendedQuote(quote: QuoteInfo): QuoteInfo {
  const regularClose = positiveValue(quote.price)
    ?? (positiveValue(quote.postMarketPrice) && typeof quote.postMarketChange === "number"
      ? positiveValue(quote.postMarketPrice! - quote.postMarketChange)
      : undefined)
    ?? (positiveValue(quote.preMarketPrice) && typeof quote.preMarketChange === "number"
      ? positiveValue(quote.preMarketPrice! - quote.preMarketChange)
      : undefined)
    ?? (positiveValue(quote.overnightPrice) && typeof quote.overnightChange === "number"
      ? positiveValue(quote.overnightPrice! - quote.overnightChange)
      : undefined)
    ?? positiveValue(quote.prevClose);
  if (!regularClose) return quote;

  const pre = normalizedExtendedSession(quote.preMarketPrice, regularClose);
  const post = normalizedExtendedSession(quote.postMarketPrice, regularClose);
  const overnight = normalizedExtendedSession(quote.overnightPrice, regularClose);
  return {
    ...quote,
    preMarketPrice: pre?.price ?? quote.preMarketPrice,
    preMarketChange: pre?.change ?? quote.preMarketChange,
    preMarketChangePercent: pre?.changePercent ?? quote.preMarketChangePercent,
    postMarketPrice: post?.price ?? quote.postMarketPrice,
    postMarketChange: post?.change ?? quote.postMarketChange,
    postMarketChangePercent: post?.changePercent ?? quote.postMarketChangePercent,
    overnightPrice: overnight?.price ?? quote.overnightPrice,
    overnightChange: overnight?.change ?? quote.overnightChange,
    overnightChangePercent: overnight?.changePercent ?? quote.overnightChangePercent,
  };
}

function normalizeUsExtendedChartData(data: ChartData): ChartData {
  return {
    ...data,
    quote: normalizeUsExtendedQuote(data.quote),
  };
}

function mergeUsExtendedQuotes(
  nasdaqQuote: Partial<QuoteInfo> | null,
  robinhoodQuote: Partial<QuoteInfo> | null,
): Partial<QuoteInfo> | null {
  const merged: Partial<QuoteInfo> = { ...(nasdaqQuote ?? {}) };
  if (robinhoodQuote?.overnightPrice && robinhoodQuote.overnightPrice > 0) {
    merged.overnightPrice = robinhoodQuote.overnightPrice;
    merged.overnightChange = robinhoodQuote.overnightChange;
    merged.overnightChangePercent = robinhoodQuote.overnightChangePercent;
  }
  if ((!merged.preMarketPrice || merged.preMarketPrice <= 0) && robinhoodQuote?.preMarketPrice && robinhoodQuote.preMarketPrice > 0) {
    merged.preMarketPrice = robinhoodQuote.preMarketPrice;
    merged.preMarketChange = robinhoodQuote.preMarketChange;
    merged.preMarketChangePercent = robinhoodQuote.preMarketChangePercent;
  }
  if ((!merged.postMarketPrice || merged.postMarketPrice <= 0) && robinhoodQuote?.postMarketPrice && robinhoodQuote.postMarketPrice > 0) {
    merged.postMarketPrice = robinhoodQuote.postMarketPrice;
    merged.postMarketChange = robinhoodQuote.postMarketChange;
    merged.postMarketChangePercent = robinhoodQuote.postMarketChangePercent;
  }
  return Object.keys(merged).length ? merged : null;
}

function mergeQuoteIntoChart(base: ChartData, quote: QuoteInfo): ChartData {
  return {
    quote: {
      ...base.quote,
      ...quote,
      symbol: quote.symbol || base.quote.symbol,
      name: quote.name || base.quote.name,
      price: quote.price > 0 ? quote.price : base.quote.price,
      open: quote.open > 0 ? quote.open : base.quote.open,
      high: quote.high > 0 ? quote.high : base.quote.high,
      low: quote.low > 0 ? quote.low : base.quote.low,
      prevClose: quote.prevClose > 0 ? quote.prevClose : base.quote.prevClose,
      volume: quote.volume > 0 ? quote.volume : base.quote.volume,
    },
    points: base.points,
  };
}

function chartDataFromPoints(symbol: string, name: string, points: ChartPoint[], quote?: QuoteInfo | null): ChartData | null {
  const latest = points[points.length - 1];
  const previous = points[Math.max(0, points.length - 2)];
  const price = quote?.price && quote.price > 0 ? quote.price : latest?.price ?? 0;
  if (!(price > 0) || !points.length) return null;
  const prevClose = quote?.prevClose && quote.prevClose > 0
    ? quote.prevClose
    : previous?.close ?? previous?.price ?? price;
  const change = quote?.change ?? (price - prevClose);
  const changePercent = quote?.changePercent ?? (prevClose > 0 ? change / prevClose : 0);
  return {
    quote: {
      symbol: quote?.symbol || symbol,
      name: quote?.name || name || symbol,
      price,
      change,
      changePercent,
      open: quote?.open && quote.open > 0 ? quote.open : latest?.open ?? price,
      high: quote?.high && quote.high > 0 ? quote.high : latest?.high ?? price,
      low: quote?.low && quote.low > 0 ? quote.low : latest?.low ?? price,
      prevClose,
      volume: quote?.volume ?? latest?.volume ?? 0,
      currency: quote?.currency || "",
      exchange: quote?.exchange || "",
      isLive: quote?.isLive ?? true,
    },
    points,
  };
}

function quoteFromPublicSource(baseSymbol: string, quote: PublicQuote): QuoteInfo {
  return {
    symbol: baseSymbol,
    name: quote.name || baseSymbol,
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    prevClose: quote.prevClose,
    volume: quote.volume,
    currency: quote.currency,
    exchange: quote.exchange,
    isLive: true,
  };
}

function aggregateYahooCalendarPoints(
  points: Array<ChartPoint & { ts: number }>,
  mode: "quarter" | "year",
): ChartPoint[] {
  const grouped = new Map<string, Array<ChartPoint & { ts: number }>>();
  for (const point of points) {
    const d = new Date(point.ts * 1000);
    if (Number.isNaN(d.getTime())) continue;
    const key = mode === "quarter"
      ? `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
      : `${d.getFullYear()}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(point);
  }

  return Array.from(grouped.entries()).map(([key, bucket]) => {
	    const first = bucket[0]!;
	    const last = bucket[bucket.length - 1]!;
    const highs = bucket.map((item) => item.high ?? item.close ?? item.price).filter((value) => value != null && value > 0) as number[];
    const lows = bucket.map((item) => item.low ?? item.close ?? item.price).filter((value) => value != null && value > 0) as number[];
    return {
      time: mode === "quarter"
        ? `${String(key.slice(2, 4))}/${key.slice(-2)}`
        : key,
      price: last.close ?? last.price,
      timestamp: last.ts * 1000,
      volume: bucket.reduce((sum, item) => sum + (item.volume ?? 0), 0) || undefined,
      open: first.open ?? first.price,
      high: highs.length ? Math.max(...highs) : last.price,
      low: lows.length ? Math.min(...lows) : last.price,
      close: last.close ?? last.price,
    };
  });
}

async function fetchFundLatestQuote(code: string): Promise<QuoteInfo | null> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 7000);
  try {
    const [estimate, officialNav] = await Promise.all([
      fetchCnFundEstimate(code),
      fetchCnFundOfficialNav(code),
    ]);
    const history = await fetchCnFundOfficialHistory(code, 2);
    clearTimeout(tid);

    const dwjz = estimate?.officialNav ?? 0;
    const latestHistory = history[0];
    const prevHistory = history[1];
    const historyNav = latestHistory?.nav ?? 0;
    const price = historyNav > 0
      ? historyNav
      : (officialNav ?? (!isNaN(dwjz) && dwjz > 0 ? dwjz : 0));
    if (!(price > 0)) return null;

    const prevClose = prevHistory?.nav && prevHistory.nav > 0
      ? prevHistory.nav
      : price;
    const change = price - prevClose;
    const historyPct = Number(latestHistory?.changePercent);
    const changePercent = Number.isFinite(historyPct) && historyPct !== 0
      ? historyPct / 100
      : (prevClose > 0 ? change / prevClose : 0);
    return {
      symbol: code,
      name: estimate?.name ?? code,
      price,
      change,
      changePercent,
      open: price,
      high: Math.max(price, prevClose),
      low: Math.min(price, prevClose),
      prevClose,
      volume: 0,
      currency: "CNY",
      exchange: "EastMoney Fund",
      isLive: true,
    };
  } catch {
    clearTimeout(tid);
    return null;
  }
}

function quoteFromTencent(yahooSymbol: string, tencent: Awaited<ReturnType<typeof fetchTencentQuoteFromYahooSymbol>>): ChartData | null {
  if (!tencent?.price || !(tencent.price > 0)) return null;
  return chartDataFromQuote({
    symbol: yahooSymbol,
    name: tencent.name,
    price: tencent.price,
    change: tencent.change,
    changePercent: tencent.changePercent,
    open: tencent.open,
    high: tencent.high,
    low: tencent.low,
    prevClose: tencent.prevClose,
    volume: tencent.volume,
    currency: tencent.currency,
    exchange: tencent.exchange,
    isLive: true,
  });
}

async function fetchEastMoneyGlobalFallback(symbol: string, market: string, range: TimeRange): Promise<ChartData | null> {
  try {
    const result = await fetchEastMoneyChart(symbol, market, range as any);
    return {
      quote: {
        symbol: result.quote.symbol,
        name: result.quote.name,
        price: result.quote.price,
        change: result.quote.change,
        changePercent: result.quote.changePercent,
        open: result.quote.open,
        high: result.quote.high,
        low: result.quote.low,
        prevClose: result.quote.prevClose,
        volume: result.quote.volume,
        currency: result.quote.currency,
        exchange: result.quote.exchange,
        isLive: true,
      },
      points: result.points,
    };
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════
   Simple cache (2-min TTL per symbol+range)
══════════════════════════════════════════════════════════ */
const CACHE_TTL = 2 * 60 * 1000;
const CACHE_MAX_ITEMS = 80;
const PERSISTENT_CHART_STORAGE_KEY = "asset-helper:chart-cache:v3";
const PERSISTENT_FUND_HISTORY_STORAGE_KEY = "asset-helper:fund-history-cache:v1";
const PERSISTENT_CHART_MAX_ITEMS = 36;
const PERSISTENT_FUND_HISTORY_MAX_ITEMS = 60;
const PERSISTENT_CHART_TTL = 6 * 60 * 60 * 1000;
const DAILY_FULL_REFRESH_TTL = 24 * 60 * 60 * 1000;
const WEEKLY_FULL_REFRESH_TTL = 7 * 24 * 60 * 60 * 1000;
const INCREMENTAL_FUND_HISTORY_SIZE = 90;
const chartCache = new Map<string, { data: ChartData; ts: number }>();
const inflightChartRequests = new Map<string, Promise<ChartData>>();
const inflightDetailRequests = new Map<string, Promise<ChartData>>();

function getCached(key: string): ChartData | null {
  const e = chartCache.get(key);
  return e && Date.now() - e.ts < CACHE_TTL ? e.data : null;
}
function setCached(key: string, data: ChartData) {
  if (chartCache.has(key)) chartCache.delete(key);
  chartCache.set(key, { data, ts: Date.now() });
  while (chartCache.size > CACHE_MAX_ITEMS) {
    const oldestKey = chartCache.keys().next().value;
    if (!oldestKey) break;
    chartCache.delete(oldestKey);
  }
}

function detailCacheKey(symbol: string, market: string, range: TimeRange) {
  return `detail-chart::${market}::${symbol}::${range}`;
}

function getPersistentChart(key: string, ttlMs = PERSISTENT_CHART_TTL): ChartData | null {
  const entry = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, key);
  if (!shouldUseFreshCache(entry, ttlMs)) return null;
  return entry?.data && hasRealChartPoints(entry.data.points) ? entry.data : null;
}

function setPersistentChart(key: string, data: ChartData, fullRefresh: boolean) {
  if (!hasRealChartPoints(data.points)) return;
  const previous = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, key);
  writePersistentEntry(PERSISTENT_CHART_STORAGE_KEY, key, data, {
    maxEntries: PERSISTENT_CHART_MAX_ITEMS,
    fullRefresh,
    previousFullRefreshAt: previous?.lastFullRefreshAt,
  });
}

function reuseInflight(
  store: Map<string, Promise<ChartData>>,
  key: string,
  loader: () => Promise<ChartData>,
) {
  const existing = store.get(key);
  if (existing) return existing;
  const task = loader().finally(() => {
    if (store.get(key) === task) store.delete(key);
  });
  store.set(key, task);
  return task;
}

async function fetchFundChart(code: string, range: TimeRange, force = false): Promise<ChartData> {
  const key = `fund::${code}::${range}`;
  if (!force) {
    const hit = getCached(key);
    if (hit) return hit;
    const persisted = getPersistentChart(key);
    if (persisted) {
      setCached(key, persisted);
      return persisted;
    }
    return reuseInflight(inflightChartRequests, key, async () => fetchFundChart(code, range, true));
  }

  const persistedEntry = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, key);
  const fullRefresh = shouldFullRefresh(persistedEntry, DAILY_FULL_REFRESH_TTL);
  const ctrl = new AbortController();
  const timeoutMs = (range === "max" || range === "fmax" || range === "f10y" || range === "f5y") ? 20000 : 10000;
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const [historyResult, quoteResult] = await Promise.allSettled([
      fetchFundHistory(code, range, ctrl.signal),
      fetchFundLatestQuote(code),
    ]);
    clearTimeout(tid);

    if (historyResult.status !== "fulfilled") throw historyResult.reason;
    const history = historyResult.value;
    const latestNav = history[history.length - 1]?.nav ?? 0;
    const previousNav = history[Math.max(0, history.length - 2)]?.nav ?? latestNav;
    const liveQuote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
    const price = liveQuote?.price ?? latestNav;
    if (!(price > 0)) throw new Error("invalid fund price");
    const prevClose = previousNav > 0 ? previousNav : (liveQuote?.prevClose ?? price);
    const change = liveQuote?.change ?? (price - prevClose);
    const changePercent = liveQuote?.changePercent ?? (prevClose > 0 ? change / prevClose : 0);
    const points = history.map((point) => ({
      time: fmtFundDate(point.date, range),
      price: point.nav,
      timestamp: new Date(`${point.date}T00:00:00`).getTime(),
      dateLabel: fmtFundFullDate(point.date),
      volume: 0,
    }));
    const sampledPoints = sampleFundPoints(points, fundMaxDisplayPoints(range));

    const data: ChartData = {
      quote: {
        symbol: code,
        name: liveQuote?.name ?? code,
        price,
        change,
        changePercent,
        open: price,
        high: Math.max(...history.map((point) => point.nav), price),
        low: Math.min(...history.map((point) => point.nav), price),
        prevClose,
        volume: liveQuote?.volume ?? 0,
        currency: "CNY",
        exchange: liveQuote?.exchange ?? "EastMoney Fund",
        isLive: liveQuote?.isLive ?? true,
      },
      points: sampledPoints,
    };

    setCached(key, data);
    setPersistentChart(key, data, fullRefresh);
    return data;
  } catch {
    clearTimeout(tid);
    const fallbackQuote = await fetchFundLatestQuote(code);
    if (fallbackQuote) {
      if (persistedEntry?.data && hasRealChartPoints(persistedEntry.data.points)) {
        const data = mergeQuoteIntoChart(persistedEntry.data, fallbackQuote);
        setCached(key, data);
        return data;
      }
      return chartDataFromQuote(fallbackQuote);
    }
    if (persistedEntry?.data && hasRealChartPoints(persistedEntry.data.points)) return persistedEntry.data;
    throw new Error(`fund chart unavailable for ${code}`);
  }
}

/* ═══════════════════════════════════════════════════════
   Public: fetchChart
══════════════════════════════════════════════════════════ */
export async function fetchChart(yahooSymbol: string, range: TimeRange, force = false, includePrePost = false): Promise<ChartData> {
  const key = `${yahooSymbol}::${range}${includePrePost ? "::prepost" : ""}`;
  if (!force) {
    const hit = getCached(key);
    if (hit) return hit;
    const persisted = getPersistentChart(`yahoo::${key}`);
    if (persisted) {
      setCached(key, persisted);
      return persisted;
    }
    return reuseInflight(inflightChartRequests, key, async () => fetchChart(yahooSymbol, range, true, includePrePost));
  }
  const { rangeParam, interval } = yahooQuerySpec(range);
  const persistentKey = `yahoo::${key}`;
  const persistedEntry = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, persistentKey);
  const canIncremental = !includePrePost && yahooIncrementalWindowDays(range) > 0 && persistedEntry?.data && hasRealChartPoints(persistedEntry.data.points);
  const fullRefresh = shouldFullRefresh(persistedEntry, DAILY_FULL_REFRESH_TTL) || !canIncremental;
  const windowDays = fullRefresh ? 0 : yahooIncrementalWindowDays(range);
  const hosts = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
  let lastError: unknown = null;

  for (const host of hosts) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 7000);
    try {
      const params = new URLSearchParams({
        interval,
        includePrePost: String(includePrePost),
      });
      if (windowDays > 0) {
        const period2 = Math.floor(Date.now() / 1000) + 86400;
        const period1 = period2 - windowDays * 86400;
        params.set("period1", String(period1));
        params.set("period2", String(period2));
      } else {
        params.set("range", rangeParam);
      }
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${params.toString()}`;
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error("empty result");

      const meta   = result.meta ?? {};

      const positive = (n: unknown): number | undefined => (
        typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined
      );

      const rawPoints = buildYahooRawPoints(result, range, yahooSymbol);
      const points: ChartPoint[] = range === "3mo"
        ? aggregateYahooCalendarPoints(rawPoints, "quarter")
        : range === "1y"
          ? aggregateYahooCalendarPoints(rawPoints, "year")
          : rawPoints.map(({ ts: _ts, ...point }) => point);

      const latestRawPoint = rawPoints[rawPoints.length - 1];
      const previousRawPoint = rawPoints[rawPoints.length - 2] ?? latestRawPoint;
      const latestClose = positive(latestRawPoint?.close ?? latestRawPoint?.price);
      const latestOpen = positive(latestRawPoint?.open);
      const latestHigh = positive(latestRawPoint?.high ?? latestRawPoint?.close ?? latestRawPoint?.price);
      const latestLow = positive(latestRawPoint?.low ?? latestRawPoint?.close ?? latestRawPoint?.price);
      const fallbackPrevClose = positive(previousRawPoint?.close ?? previousRawPoint?.price) ?? latestOpen ?? latestClose ?? 0;
      const alignedReference = latestClose ?? positive(meta.regularMarketPrice) ?? 0;
      const looksAligned = (candidate?: number, reference = alignedReference) => {
        if (!(candidate && reference)) return false;
        return candidate >= reference * 0.5 && candidate <= reference * 1.5;
      };

      const regularPrice = positive(meta.regularMarketPrice)
        ?? latestClose
        ?? positive(meta.previousClose)
        ?? 0;
      const rawPrevClose = positive(meta.previousClose)
        ?? positive(meta.chartPreviousClose)
        ?? 0;
      const prevClose = looksAligned(rawPrevClose, latestClose ?? regularPrice)
        ? rawPrevClose
        : fallbackPrevClose;
      const rawChange = typeof meta.regularMarketChange === "number" && Number.isFinite(meta.regularMarketChange)
        ? meta.regularMarketChange
        : undefined;
      const regularChange = rawChange != null && Math.abs(rawChange) <= Math.max(1, (regularPrice || latestClose || 0) * 0.25)
        ? rawChange
        : (regularPrice - prevClose);
      const rawChangePct = typeof meta.regularMarketChangePercent === "number" && Number.isFinite(meta.regularMarketChangePercent)
        ? meta.regularMarketChangePercent
        : (prevClose > 0 ? regularChange / prevClose : 0);
      const regularChangePct = Math.abs(rawChangePct) > 1 ? rawChangePct / 100 : rawChangePct;
      const rawOpen = positive(meta.regularMarketOpen);
      const openPrice = looksAligned(rawOpen, latestClose ?? regularPrice)
        ? rawOpen!
        : latestOpen
          ?? latestClose
          ?? positive(prevClose)
          ?? positive(regularPrice)
          ?? 0;
      const rawDayHigh = positive(meta.regularMarketDayHigh);
      const dayHigh = looksAligned(rawDayHigh, latestClose ?? regularPrice)
        ? rawDayHigh!
        : latestHigh
          ?? positive(regularPrice)
          ?? openPrice;
      const rawDayLow = positive(meta.regularMarketDayLow);
      const dayLow = looksAligned(rawDayLow, latestClose ?? regularPrice)
        ? rawDayLow!
        : latestLow
          ?? positive(regularPrice)
          ?? openPrice;
      const totalVolume = positive(meta.regularMarketVolume)
        ?? positive(latestRawPoint?.volume)
        ?? rawPoints.reduce((sum, item) => sum + (typeof item.volume === "number" && Number.isFinite(item.volume) && item.volume > 0 ? item.volume : 0), 0);
      const hasUsableQuote = [regularPrice, prevClose, openPrice, dayHigh, dayLow].some((value) => value > 0) || points.length > 0;
      if (!hasUsableQuote) throw new Error("invalid chart quote");

      const quote: QuoteInfo = {
        symbol:        meta.symbol ?? yahooSymbol,
        name:          meta.shortName ?? meta.longName ?? yahooSymbol,
        price:         regularPrice,
        change:        regularChange,
        changePercent: regularChangePct,
        open:          openPrice,
        high:          dayHigh,
        low:           dayLow,
        prevClose,
        volume:        totalVolume,
        marketCap:     meta.marketCap,
        pe:            meta.trailingPE,
        eps:           meta.epsTrailingTwelveMonths,
        week52High:    meta.fiftyTwoWeekHigh,
        week52Low:     meta.fiftyTwoWeekLow,
        currency:      meta.currency ?? "USD",
        exchange:      meta.exchangeName ?? meta.fullExchangeName ?? "",
        isLive:        true,
        marketState:           meta.marketState,
        preMarketPrice:        positive(meta.preMarketPrice),
        preMarketChange:       typeof meta.preMarketChange === "number" && Number.isFinite(meta.preMarketChange) ? meta.preMarketChange : undefined,
        preMarketChangePercent: typeof meta.preMarketChangePercent === "number" && Number.isFinite(meta.preMarketChangePercent)
          ? (Math.abs(meta.preMarketChangePercent) > 1 ? meta.preMarketChangePercent / 100 : meta.preMarketChangePercent)
          : undefined,
        postMarketPrice:       positive(meta.postMarketPrice),
        postMarketChange:      typeof meta.postMarketChange === "number" && Number.isFinite(meta.postMarketChange) ? meta.postMarketChange : undefined,
        postMarketChangePercent: typeof meta.postMarketChangePercent === "number" && Number.isFinite(meta.postMarketChangePercent)
          ? (Math.abs(meta.postMarketChangePercent) > 1 ? meta.postMarketChangePercent / 100 : meta.postMarketChangePercent)
          : undefined,
      };

      const data: ChartData = fullRefresh || !persistedEntry?.data
        ? { quote, points }
        : {
          quote,
          points: mergePointSeries(persistedEntry.data.points, points, 6000),
        };
      setCached(key, data);
      setPersistentChart(persistentKey, data, fullRefresh);
      return data;
    } catch (error) {
      clearTimeout(tid);
      lastError = error;
    }
  }

  const tencentFallback = quoteFromTencent(yahooSymbol, await fetchTencentQuoteFromYahooSymbol(yahooSymbol));
  if (tencentFallback) return tencentFallback;
  if (persistedEntry?.data && hasRealChartPoints(persistedEntry.data.points)) return persistedEntry.data;
  throw lastError instanceof Error ? lastError : new Error(`chart unavailable for ${yahooSymbol}`);
}

async function fetchYahooRecentDailyChart(yahooSymbol: string, days: number, force = false): Promise<ChartData> {
  const key = `recent-yahoo-daily::${yahooSymbol}::${days}`;
  if (!force) {
    const hit = getCached(key);
    if (hit && hasRealChartPoints(hit.points)) return hit;
    return reuseInflight(inflightChartRequests, key, async () => fetchYahooRecentDailyChart(yahooSymbol, days, true));
  }

  const hosts = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
  let lastError: unknown = null;
  for (const host of hosts) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4500);
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=3mo&includePrePost=false`;
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error("empty recent daily result");

      const rawPoints = buildYahooRawPoints(result, "1d", yahooSymbol);
      const points = rawPoints
        .slice(-Math.max(days, 30))
        .map(({ ts: _ts, ...point }) => point);
      if (!hasRealChartPoints(points)) throw new Error("empty recent daily points");

      const meta = result.meta ?? {};
      const latest = points[points.length - 1];
      const previous = points[Math.max(0, points.length - 2)] ?? latest;
      const price = positiveValue(meta.regularMarketPrice) ?? latest?.close ?? latest?.price ?? 0;
      const prevClose = positiveValue(meta.previousClose)
        ?? positiveValue(meta.chartPreviousClose)
        ?? previous?.close
        ?? previous?.price
        ?? price;
      const change = typeof meta.regularMarketChange === "number" && Number.isFinite(meta.regularMarketChange)
        ? meta.regularMarketChange
        : price - prevClose;
      const rawPct = typeof meta.regularMarketChangePercent === "number" && Number.isFinite(meta.regularMarketChangePercent)
        ? meta.regularMarketChangePercent
        : (prevClose > 0 ? change / prevClose : 0);
      const quote: QuoteInfo = {
        symbol: yahooSymbol,
        name: meta.longName ?? meta.shortName ?? yahooSymbol,
        price,
        change,
        changePercent: Math.abs(rawPct) > 1 ? rawPct / 100 : rawPct,
        open: positiveValue(meta.regularMarketOpen) ?? latest?.open ?? price,
        high: positiveValue(meta.regularMarketDayHigh) ?? latest?.high ?? price,
        low: positiveValue(meta.regularMarketDayLow) ?? latest?.low ?? price,
        prevClose,
        volume: positiveValue(meta.regularMarketVolume) ?? latest?.volume ?? 0,
        currency: meta.currency ?? "USD",
        exchange: meta.exchangeName ?? meta.fullExchangeName ?? "",
        isLive: true,
      };
      const data = { quote, points };
      setCached(key, data);
      return data;
    } catch (error) {
      clearTimeout(tid);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`recent daily unavailable for ${yahooSymbol}`);
}

export async function fetchRecentDailyChart(symbol: string, market: string, days = 45, force = false): Promise<ChartData> {
  const key = `recent-daily::${market}::${symbol}::${days}`;
  if (!force) {
    const hit = getCached(key);
    if (hit && hasRealChartPoints(hit.points)) return hit;
    const persisted = getPersistentChart(key);
    if (persisted) {
      setCached(key, persisted);
      return persisted;
    }
    return reuseInflight(inflightDetailRequests, key, async () => fetchRecentDailyChart(symbol, market, days, true));
  }
  const persistedEntry = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, key);
  const fullRefresh = shouldFullRefresh(persistedEntry, DAILY_FULL_REFRESH_TTL);

  if (market === "FUND") {
    const fundData = await fetchFundChart(symbol, "1mo", force);
    const data = { ...fundData, points: fundData.points.slice(-days) };
    setCached(key, data);
    setPersistentChart(key, data, fullRefresh);
    return data;
  }

  if (market === "CRYPTO") {
    const normalizedSymbol = symbol.toUpperCase().replace(/-USD$/i, "").replace(/-USDT$/i, "");
    const [binanceQuote, binanceKline, okxQuote, okxKline] = await Promise.allSettled([
      fetchBinanceCryptoQuote(normalizedSymbol),
      fetchBinanceCryptoKline(normalizedSymbol, "1d"),
      fetchOkxCryptoQuote(normalizedSymbol),
      fetchOkxCryptoKline(normalizedSymbol, "1d"),
    ]);
    const preferredQuote =
      (binanceQuote.status === "fulfilled" && binanceQuote.value?.price
        ? quoteFromPublicSource(normalizedSymbol, binanceQuote.value)
        : null)
      ?? (okxQuote.status === "fulfilled" && okxQuote.value?.price
        ? quoteFromPublicSource(normalizedSymbol, okxQuote.value)
        : null);
    const binancePoints = binanceKline.status === "fulfilled" ? binanceKline.value?.slice(-days) : null;
    const okxPoints = okxKline.status === "fulfilled" ? okxKline.value?.slice(-days) : null;
    const publicPoints = binancePoints?.some((point) => point.price > 0)
      ? binancePoints
      : okxPoints?.some((point) => point.price > 0)
        ? okxPoints
        : null;
    if (publicPoints?.length) {
      const mergedPoints = fullRefresh || !persistedEntry?.data
        ? publicPoints
        : mergePointSeries(persistedEntry.data.points, publicPoints, Math.max(days + 30, 120));
      const data = chartDataFromPoints(normalizedSymbol, preferredQuote?.name ?? normalizedSymbol, mergedPoints.slice(-days), preferredQuote);
      if (data) {
        setCached(key, data);
        setPersistentChart(key, data, fullRefresh);
        return data;
      }
    }
  }

  const yahooSymbol = detailYahooSymbol(symbol, market);
  try {
    const data = await fetchYahooRecentDailyChart(yahooSymbol, days, force);
    const mergedData = fullRefresh || !persistedEntry?.data
      ? data
      : { ...data, points: mergePointSeries(persistedEntry.data.points, data.points, Math.max(days + 30, 120)).slice(-days) };
    setCached(key, mergedData);
    setPersistentChart(key, mergedData, fullRefresh);
    return mergedData;
  } catch {
    const fallback = await fetchDetailChart(symbol, market, "1d", force).catch(() => null);
    if (fallback) {
      const data = { ...fallback, points: fallback.points.slice(-days) };
      setCached(key, data);
      setPersistentChart(key, data, fullRefresh);
      return data;
    }
    if (persistedEntry?.data && hasRealChartPoints(persistedEntry.data.points)) return persistedEntry.data;
    throw new Error(`recent daily unavailable for ${market}:${symbol}`);
  }
}
export async function fetchDetailChart(symbol: string, market: string, range: TimeRange, force = false): Promise<ChartData> {
  const detailKey = `detail::${market}::${symbol}::${range}`;
  const detailChartKey = detailCacheKey(symbol, market, range);
  const persistedDetail = readPersistentEntry<ChartData>(PERSISTENT_CHART_STORAGE_KEY, detailChartKey);
  const detailFullRefresh = shouldFullRefresh(persistedDetail, DAILY_FULL_REFRESH_TTL);
  const storeDetailChart = (data: ChartData, fullRefresh = detailFullRefresh) => {
    setCached(detailChartKey, data);
    setPersistentChart(detailChartKey, data, fullRefresh);
    return data;
  };
  if (!force) {
    const hit = getCached(detailChartKey);
    // Detail charts should not be blocked by a stale quote-only cache entry.
    if (hit && hasRealChartPoints(hit.points)) return hit;
    const persisted = getPersistentChart(detailChartKey);
    if (persisted) {
      setCached(detailChartKey, persisted);
      return persisted;
    }
    return reuseInflight(inflightDetailRequests, detailKey, async () => fetchDetailChart(symbol, market, range, true));
  }
  const normalizedRange = toSourceRange(range);
  if (market === "FUND") return fetchFundChart(symbol, normalizedRange, force);
  if (market === "A" || market === "HK") {
    const rawSymbol = market === "HK"
      ? symbol.replace(/^\^/, "").replace(/\.HK$/i, "")
      : symbol.replace(/\.(SS|SZ)$/i, "");

    if (market === "HK" && range === "fs") {
      // EastMoney HK trend can report a non-zero total with an empty trends array.
      // In extensions Yahoo can also be rate-limited, so prefer Tencent's direct intraday feed.
      const [tencentIntradayResult, eastMoneyQuoteResult] = await Promise.allSettled([
        fetchTencentIntraday(rawSymbol, market),
        fetchEastMoneyQuoteBySymbol(rawSymbol, market),
      ]);
      const tencentPoints = tencentIntradayResult.status === "fulfilled" ? tencentIntradayResult.value : null;
      const emQuote = eastMoneyQuoteResult.status === "fulfilled" ? eastMoneyQuoteResult.value : null;
      const liveQuote = emQuote?.price && emQuote.price > 0
        ? {
          symbol: rawSymbol,
          name: emQuote.name,
          price: emQuote.price,
          change: emQuote.change,
          changePercent: emQuote.changePercent,
          open: emQuote.open,
          high: emQuote.high,
          low: emQuote.low,
          prevClose: emQuote.prevClose,
          volume: emQuote.volume,
          currency: emQuote.currency,
          exchange: emQuote.exchange,
          isLive: true,
        }
        : null;
      if (tencentPoints?.some((point) => point.price > 0)) {
        const data = chartDataFromPoints(rawSymbol, emQuote?.name ?? rawSymbol, tencentPoints, liveQuote);
        if (data) {
          return storeDetailChart(data);
        }
      }

      const isHkIndex = HK_INDEX_SYMBOLS.has(rawSymbol.toUpperCase());
      const [eastMoneyResult, yahooData] = await Promise.all([
        fetchEastMoneyChart(rawSymbol, market, range).catch(() => null),
        fetchChart(detailYahooSymbol(symbol, market), range, force).catch(() => null),
      ]);

      if (isHkIndex && eastMoneyResult && hasRealChartPoints(eastMoneyResult.points)) {
        return storeDetailChart(eastMoneyResult);
      }

      if (yahooData && hasRealChartPoints(yahooData.points)) {
        const data = liveQuote ? mergeQuoteIntoChart(yahooData, liveQuote) : yahooData;
        return storeDetailChart(data);
      }

      if (eastMoneyResult && hasRealChartPoints(eastMoneyResult.points)) {
        return storeDetailChart(eastMoneyResult);
      }
    }

    // EastMoney kline API has no data for HK stocks; use Yahoo chart + EastMoney quote
    if (market === "HK" && range !== "fs") {
      const [yahooResult, eastMoneyQuoteResult, tencentKlineResult] = await Promise.allSettled([
        fetchChart(detailYahooSymbol(symbol, market), range, force),
        fetchEastMoneyQuoteBySymbol(rawSymbol, market),
        fetchTencentKline(rawSymbol, market, range),
      ]);
      const yahooData = yahooResult.status === "fulfilled" ? yahooResult.value : null;
      const emQuote = eastMoneyQuoteResult.status === "fulfilled" ? eastMoneyQuoteResult.value : null;
      const tencentPoints = tencentKlineResult.status === "fulfilled" ? tencentKlineResult.value : null;
      const liveQuote = emQuote?.price && emQuote.price > 0
        ? {
          symbol: rawSymbol, name: emQuote.name, price: emQuote.price,
          change: emQuote.change, changePercent: emQuote.changePercent,
          open: emQuote.open, high: emQuote.high, low: emQuote.low,
          prevClose: emQuote.prevClose, volume: emQuote.volume,
          currency: emQuote.currency, exchange: emQuote.exchange, isLive: true,
        }
        : null;
      if (yahooData && hasRealChartPoints(yahooData.points)) {
        const data = liveQuote ? mergeQuoteIntoChart(yahooData, liveQuote) : yahooData;
        return storeDetailChart(data);
      }
      if (tencentPoints?.some((point) => point.price > 0)) {
        const data = chartDataFromPoints(rawSymbol, emQuote?.name ?? rawSymbol, tencentPoints, liveQuote);
        if (data) {
          return storeDetailChart(data);
        }
      }
      // Both real HK chart sources failed; fall through to quote-only fallback.
    }

    try {
      const result = await fetchEastMoneyChart(rawSymbol, market, range as any);
      const data = {
        quote: {
          symbol: result.quote.symbol,
          name: result.quote.name,
          price: result.quote.price,
          change: result.quote.change,
          changePercent: result.quote.changePercent,
          open: result.quote.open,
          high: result.quote.high,
          low: result.quote.low,
          prevClose: result.quote.prevClose,
          volume: result.quote.volume,
          currency: result.quote.currency,
          exchange: result.quote.exchange,
          isLive: true,
        },
        points: result.points,
      };
      return storeDetailChart(data);
    } catch {
      const eastMoneyQuote = await fetchEastMoneyQuoteBySymbol(rawSymbol, market).catch(() => null);
      const tencent = await fetchTencentQuote(rawSymbol, market).catch(() => null);
      const cachedDetail = getCached(detailChartKey);
      let yahooData: ChartData | null = null;
      try {
        yahooData = await fetchChart(detailYahooSymbol(symbol, market), range, force);
      } catch {
        yahooData = null;
      }

      if (yahooData && hasRealChartPoints(yahooData.points)) {
        if (eastMoneyQuote?.price && eastMoneyQuote.price > 0) {
          return mergeQuoteIntoChart(yahooData, {
            symbol: rawSymbol,
            name: eastMoneyQuote.name,
            price: eastMoneyQuote.price,
            change: eastMoneyQuote.change,
            changePercent: eastMoneyQuote.changePercent,
            open: eastMoneyQuote.open,
            high: eastMoneyQuote.high,
            low: eastMoneyQuote.low,
            prevClose: eastMoneyQuote.prevClose,
            volume: eastMoneyQuote.volume,
            currency: eastMoneyQuote.currency,
            exchange: eastMoneyQuote.exchange,
            isLive: true,
          });
        }
        return yahooData;
      }

      if (yahooData && tencent?.price && tencent.price > 0) {
        return mergeQuoteIntoChart(yahooData, {
          symbol: rawSymbol,
          name: tencent.name,
          price: tencent.price,
          change: tencent.change,
          changePercent: tencent.changePercent,
          open: tencent.open,
          high: tencent.high,
          low: tencent.low,
          prevClose: tencent.prevClose,
          volume: tencent.volume,
          currency: tencent.currency,
          exchange: tencent.exchange,
          isLive: true,
        });
      }

      if (eastMoneyQuote?.price && eastMoneyQuote.price > 0) {
        const quoteOnly = chartDataFromQuote({
          symbol: rawSymbol,
          name: eastMoneyQuote.name,
          price: eastMoneyQuote.price,
          change: eastMoneyQuote.change,
          changePercent: eastMoneyQuote.changePercent,
          open: eastMoneyQuote.open,
          high: eastMoneyQuote.high,
          low: eastMoneyQuote.low,
          prevClose: eastMoneyQuote.prevClose,
          volume: eastMoneyQuote.volume,
          currency: eastMoneyQuote.currency,
          exchange: eastMoneyQuote.exchange,
          isLive: true,
        });
        if (cachedDetail && hasRealChartPoints(cachedDetail.points)) {
          const merged = mergeQuoteIntoChart(cachedDetail, quoteOnly.quote);
          return storeDetailChart(merged, false);
        }
        return quoteOnly;
      }

      if (tencent?.price && tencent.price > 0) {
        const quoteOnly = chartDataFromQuote({
          symbol: rawSymbol,
          name: tencent.name,
          price: tencent.price,
          change: tencent.change,
          changePercent: tencent.changePercent,
          open: tencent.open,
          high: tencent.high,
          low: tencent.low,
          prevClose: tencent.prevClose,
          volume: tencent.volume,
          currency: tencent.currency,
          exchange: tencent.exchange,
          isLive: true,
        });
        if (cachedDetail && hasRealChartPoints(cachedDetail.points)) {
          const merged = mergeQuoteIntoChart(cachedDetail, quoteOnly.quote);
          return storeDetailChart(merged, false);
        }
        return quoteOnly;
      }

      if (yahooData) {
        if (hasRealChartPoints(yahooData.points)) return storeDetailChart(yahooData);
        return yahooData;
      }
      if (cachedDetail && hasRealChartPoints(cachedDetail.points)) return cachedDetail;
      throw new Error(`detail unavailable for ${market}:${rawSymbol}`);
    }
  }

  if (market === "CRYPTO") {
    const normalizedSymbol = symbol.toUpperCase().replace(/-USD$/i, "").replace(/-USDT$/i, "");
    const [coinGeckoQuote, binanceQuote, binanceKline, okxQuote, okxKline, yahooResult] = await Promise.allSettled([
      fetchCryptoPrice(normalizedSymbol),
      fetchBinanceCryptoQuote(normalizedSymbol),
      fetchBinanceCryptoKline(normalizedSymbol, range as any),
      fetchOkxCryptoQuote(normalizedSymbol),
      fetchOkxCryptoKline(normalizedSymbol, range as any),
      fetchChart(symbol, range, force),
    ]);

    const preferredQuote =
      (coinGeckoQuote.status === "fulfilled" && coinGeckoQuote.value?.price && coinGeckoQuote.value.price > 0
        ? {
          symbol: normalizedSymbol,
          name: normalizedSymbol,
          price: coinGeckoQuote.value.price,
          change: coinGeckoQuote.value.change,
          changePercent: coinGeckoQuote.value.changePercent,
          open: coinGeckoQuote.value.prevClose,
          high: coinGeckoQuote.value.high,
          low: coinGeckoQuote.value.low,
          prevClose: coinGeckoQuote.value.prevClose,
          volume: coinGeckoQuote.value.volume,
          currency: coinGeckoQuote.value.currency,
          exchange: "CoinGecko",
          isLive: true,
        } satisfies QuoteInfo
        : null)
      ?? (binanceQuote.status === "fulfilled" && binanceQuote.value?.price
        ? quoteFromPublicSource(normalizedSymbol, binanceQuote.value)
        : null)
      ?? (okxQuote.status === "fulfilled" && okxQuote.value?.price
        ? quoteFromPublicSource(normalizedSymbol, okxQuote.value)
        : null);

    const binancePoints = binanceKline.status === "fulfilled" ? binanceKline.value : null;
    if (binancePoints?.some((point) => point.price > 0)) {
      const data = chartDataFromPoints(normalizedSymbol, preferredQuote?.name ?? normalizedSymbol, binancePoints, preferredQuote);
      if (data) {
        return storeDetailChart(data);
      }
    }

    const okxPoints = okxKline.status === "fulfilled" ? okxKline.value : null;
    if (okxPoints?.some((point) => point.price > 0)) {
      const data = chartDataFromPoints(normalizedSymbol, preferredQuote?.name ?? normalizedSymbol, okxPoints, preferredQuote);
      if (data) {
        return storeDetailChart(data);
      }
    }

    const yahooData = yahooResult.status === "fulfilled" ? yahooResult.value : null;
    if (yahooData && hasRealChartPoints(yahooData.points)) {
      const data = preferredQuote
        ? mergeQuoteIntoChart(yahooData, preferredQuote)
        : yahooData;
      return storeDetailChart(data);
    }

    if (preferredQuote) return chartDataFromQuote(preferredQuote);
  }

  if (market === "FX" || market === "COMMODITY" || (market === "INDEX" && symbol === "^N225")) {
    const [eastMoneyResult, yahooResult] = await Promise.allSettled([
      fetchEastMoneyGlobalFallback(symbol, market, range),
      fetchChart(symbol, range, force),
    ]);
    const eastMoneyData = eastMoneyResult.status === "fulfilled" ? eastMoneyResult.value : null;
    const yahooData = yahooResult.status === "fulfilled" ? yahooResult.value : null;
    const yahooOk = yahooData && (hasRealChartPoints(yahooData.points) || yahooData.quote.price > 0);
    const eastMoneyOk = eastMoneyData && (eastMoneyData.quote.price > 0 || hasRealChartPoints(eastMoneyData.points));
    if (market === "FX" || market === "COMMODITY") {
      if (yahooOk) return storeDetailChart(yahooData!);
      if (eastMoneyOk) return eastMoneyData!;
    } else {
      if (eastMoneyOk) return eastMoneyData!;
      if (yahooOk) return storeDetailChart(yahooData!);
    }
  }

  // For US/INDEX daily range, Nasdaq has full history (1984+) while Yahoo only returns ~10 years.
  // Fetch both in parallel: use Nasdaq chart points + Yahoo quote info for best accuracy.
  if ((market === "US" || market === "INDEX") && range === "1d") {
    const [nasdaqResult, yahooResult, extendedResult] = await Promise.allSettled([
      fetchNasdaqChart(symbol, range),
      fetchChart(symbol, range, force),
      market === "US"
        ? Promise.all([fetchNasdaqExtendedQuote(symbol), fetchRobinhoodExtendedQuote(symbol)])
        : Promise.resolve(null),
    ]);
    const nasdaqData = nasdaqResult.status === "fulfilled" ? nasdaqResult.value : null;
    const yahooData = yahooResult.status === "fulfilled" ? yahooResult.value : null;
    const extendedQuote = extendedResult.status === "fulfilled" && Array.isArray(extendedResult.value)
      ? mergeUsExtendedQuotes(extendedResult.value[0] ?? null, extendedResult.value[1] ?? null)
      : null;
    if (nasdaqData && hasRealChartPoints(nasdaqData.points)) {
      const quote = extendedQuote
        ? { ...(yahooData?.quote ?? nasdaqData.quote), ...extendedQuote }
        : (yahooData?.quote ?? nasdaqData.quote);
      const data = market === "US"
        ? normalizeUsExtendedChartData({ quote, points: nasdaqData.points })
        : { quote, points: nasdaqData.points };
      return storeDetailChart(data);
    }
    if (yahooData && (hasRealChartPoints(yahooData.points) || yahooData.quote.price > 0)) {
      const data = extendedQuote
        ? { ...yahooData, quote: { ...yahooData.quote, ...extendedQuote } }
        : yahooData;
      const normalizedData = market === "US" ? normalizeUsExtendedChartData(data) : data;
      if (hasRealChartPoints(normalizedData.points)) return storeDetailChart(normalizedData);
      return normalizedData;
    }
  }

  const shouldIncludePrePost = market === "US" && range === "fs";
  const extendedQuotePromise = market === "US"
    ? Promise.all([
      fetchNasdaqExtendedQuote(symbol).catch(() => null),
      fetchRobinhoodExtendedQuote(symbol).catch(() => null),
    ]).then(([nasdaqQuote, robinhoodQuote]) => mergeUsExtendedQuotes(nasdaqQuote, robinhoodQuote))
    : Promise.resolve(null);
  let yahooData: ChartData | null = null;
  try {
    yahooData = await fetchChart(symbol, range, force, shouldIncludePrePost);
  } catch {
    yahooData = null;
  }
  const extendedQuote = await extendedQuotePromise;

  if (yahooData && (hasRealChartPoints(yahooData.points) || yahooData.quote.price > 0)) {
    const data = extendedQuote
      ? { ...yahooData, quote: { ...yahooData.quote, ...extendedQuote } }
      : yahooData;
    const normalizedData = market === "US" ? normalizeUsExtendedChartData(data) : data;
    if (hasRealChartPoints(normalizedData.points)) return storeDetailChart(normalizedData);
    return normalizedData;
  }

  if (market === "US" || market === "INDEX") {
    const nasdaqData = await fetchNasdaqChart(symbol, range);
    if (nasdaqData && (hasRealChartPoints(nasdaqData.points) || nasdaqData.quote.price > 0)) {
      const data = extendedQuote && market === "US"
        ? { ...nasdaqData, quote: { ...nasdaqData.quote, ...extendedQuote } }
        : nasdaqData;
      const normalizedData = market === "US" ? normalizeUsExtendedChartData(data) : data;
      if (hasRealChartPoints(normalizedData.points)) return storeDetailChart(normalizedData);
      return normalizedData;
    }
  }

  if (market === "INDEX") {
    const aShareRaw = symbol.replace(/\.(SS|SZ)$/i, "");
    const aShareIndexFallback = A_INDEX_SYMBOLS.has(aShareRaw)
      ? await fetchEastMoneyGlobalFallback(aShareRaw, "A", range)
      : null;
    if (aShareIndexFallback && (hasRealChartPoints(aShareIndexFallback.points) || aShareIndexFallback.quote.price > 0)) {
      if (hasRealChartPoints(aShareIndexFallback.points)) return storeDetailChart(aShareIndexFallback);
      return aShareIndexFallback;
    }
  }

  if (market === "JP") {
    const eastMoneyData = await fetchEastMoneyGlobalFallback(symbol, market, range);
    if (eastMoneyData && (eastMoneyData.quote.price > 0 || hasRealChartPoints(eastMoneyData.points))) {
      if (hasRealChartPoints(eastMoneyData.points)) return storeDetailChart(eastMoneyData);
      return eastMoneyData;
    }
  }

  const cachedDetail = getCached(detailChartKey);
  if (cachedDetail && hasRealChartPoints(cachedDetail.points)) return cachedDetail;
  if (yahooData) return yahooData;
  throw new Error(`detail unavailable for ${market}:${symbol}`);
}

/* ═══════════════════════════════════════════════════════
   Number formatters
══════════════════════════════════════════════════════════ */
function trimCompactNumber(value: number, decimals: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function fmtLarge(n: number | undefined, language: "zh" | "en" = "zh"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (language === "en") {
    if (abs >= 1_000_000_000) return `${trimCompactNumber(n / 1_000_000_000, 2)}B`;
    if (abs >= 1_000_000) return `${trimCompactNumber(n / 1_000_000, 2)}M`;
    if (abs >= 1_000) return `${trimCompactNumber(n / 1_000, 2)}K`;
    return formatExactNumber(n, 0);
  }
  if (abs >= 100_000_000) return `${trimCompactNumber(n / 100_000_000, 2)}亿`;
  if (abs >= 10_000) return `${trimCompactNumber(n / 10_000, 2)}万`;
  return formatExactNumber(n, 0);
}

export function fmtPrice(n: number | undefined | null, currency = "USD"): string {
  if (n == null || n === 0) return "—";
  return formatExactMoney(n, currency);
}
