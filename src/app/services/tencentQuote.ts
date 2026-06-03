import { isLocalDevHost } from "../utils/runtimeEnv";

export interface TencentQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  volume: number;
  currency: string;
  exchange: string;
}

export interface TencentTradeStatusSnapshot {
  symbol: string;
  status: "normal" | "suspended";
  note: string;
  source: "tencent";
}

export interface TencentKlinePoint {
  time: string;
  price: number;
  timestamp?: number;
  dateLabel?: string;
  volume?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

export interface TencentIntradayPoint {
  time: string;
  price: number;
  timestamp?: number;
  dateLabel?: string;
  volume?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

function sanitizeName(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("�")) return fallback;
  return trimmed;
}

function toTencentSymbol(symbol: string, market: "A" | "HK"): string {
  if (market === "HK") {
    return `hk${symbol.replace(/\.HK$/i, "").padStart(5, "0")}`;
  }

  const raw = symbol.replace(/\.(SS|SZ)$/i, "");
  const isShanghai = /^(5|6)/.test(raw) || /^(11|13)/.test(raw);
  return `${isShanghai ? "sh" : "sz"}${raw}`;
}

function parseTencentParts(parts: string[], symbol: string, market: "A" | "HK"): TencentQuote | null {
  if (parts.length < 35) return null;

  const price = parseFloat(parts[3] ?? "");
  const prevClose = parseFloat(parts[4] ?? "");
  const open = parseFloat(parts[5] ?? "");
  const volume = parseFloat(parts[6] ?? "") || 0;
  const change = parseFloat(parts[31] ?? "");
  const rawPercent = parseFloat(parts[32] ?? "");
  const high = parseFloat(parts[33] ?? "");
  const low = parseFloat(parts[34] ?? "");

  if (!(price > 0)) return null;

  return {
    symbol,
    name: sanitizeName(parts[1] ?? "", symbol),
    price,
    prevClose: prevClose > 0 ? prevClose : price,
    open: open > 0 ? open : prevClose > 0 ? prevClose : price,
    high: high > 0 ? high : price,
    low: low > 0 ? low : price,
    change: Number.isFinite(change) ? change : price - prevClose,
    changePercent: Number.isFinite(rawPercent) ? rawPercent / 100 : prevClose > 0 ? (price - prevClose) / prevClose : 0,
    volume,
    currency: market === "HK" ? "HKD" : "CNY",
    exchange: market === "HK" ? "HKEX" : "Tencent Quote",
  };
}

function parseTencentTradeStatusParts(parts: string[], symbol: string): TencentTradeStatusSnapshot | null {
  if (parts.length < 6) return null;
  const price = parseFloat(parts[3] ?? "");
  const prevClose = parseFloat(parts[4] ?? "");
  const open = parseFloat(parts[5] ?? "");

  if (price > 0) {
    return {
      symbol,
      status: "normal",
      note: "自动行情源显示可正常交易",
      source: "tencent",
    };
  }

  if (prevClose > 0 || open > 0) {
    return {
      symbol,
      status: "suspended",
      note: "腾讯行情显示停牌或暂停交易",
      source: "tencent",
    };
  }

  return null;
}

// Parse raw text response from fetch (contains `v_hkXXXXX="field0~field1~..."`)
function parseTencentText(text: string, symbol: string, market: "A" | "HK"): TencentQuote | null {
  const m = text.match(/="([^"]*)"/);
  if (!m) return null;
  return parseTencentParts(m[1]!.split("~"), symbol, market);
}

function parseTencentTradeStatusText(text: string, symbol: string): TencentTradeStatusSnapshot | null {
  const m = text.match(/="([^"]*)"/);
  if (!m) return null;
  return parseTencentTradeStatusParts(m[1]!.split("~"), symbol);
}

function shouldUseTencentProxy() {
  return isLocalDevHost();
}

async function fetchTencentRawText(symbol: string, market: "A" | "HK"): Promise<string | null> {
  const qs = toTencentSymbol(symbol, market);
  const directUrl = `https://qt.gtimg.cn/q=${qs}&_=${Date.now()}`;
  const urls = shouldUseTencentProxy()
    ? [`/api/tencent/q=${qs}&_=${Date.now()}`, directUrl]
    : [directUrl];

  for (const url of urls) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) return await res.text();
    } catch {
      clearTimeout(tid);
    }
  }

  return null;
}

export async function fetchTencentQuote(symbol: string, market: string): Promise<TencentQuote | null> {
  if (market !== "A" && market !== "HK") return null;
  const m = market as "A" | "HK";

  try {
    const text = await fetchTencentRawText(symbol, m);
    if (text) return parseTencentText(text, symbol, m);
    return null;
  } catch {
    return null;
  }
}

export async function fetchTencentTradeStatus(symbol: string, market: string): Promise<TencentTradeStatusSnapshot | null> {
  if (market !== "A" && market !== "HK") return null;
  const m = market as "A" | "HK";
  try {
    const text = await fetchTencentRawText(symbol, m);
    if (text) return parseTencentTradeStatusText(text, symbol);
    return null;
  } catch {
    return null;
  }
}

export async function fetchTencentQuoteFromYahooSymbol(yahooSymbol: string): Promise<TencentQuote | null> {
  if (/\.HK$/i.test(yahooSymbol)) {
    return fetchTencentQuote(yahooSymbol.replace(/\.HK$/i, ""), "HK");
  }
  if (/\.(SS|SZ)$/i.test(yahooSymbol)) {
    return fetchTencentQuote(yahooSymbol.replace(/\.(SS|SZ)$/i, ""), "A");
  }
  return null;
}

function tencentKlinePeriod(range: string) {
  switch (range) {
    case "1d":
      return { period: "day", limit: 10000 };
    case "5d":
      return { period: "week", limit: 3000 };
    case "1mo":
      return { period: "month", limit: 1500 };
    case "3mo":
    case "1y":
      return { period: "month", limit: 1500 };
    case "max":
      return { period: "month", limit: 3000 };
    default:
      return { period: "day", limit: 10000 };
  }
}

function parseTencentKlineJson(text: string) {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.replace(/^[^{]*/, "");
  return JSON.parse(jsonText);
}

function formatTencentKlineTime(rawDate: string, range: string) {
  const [year = "", month = "", day = ""] = rawDate.split("-");
  if (!year || !month) return rawDate;
  if (range === "1d" || range === "5d") return `${String(year).slice(2)}/${Number(month)}/${Number(day)}`;
  if (range === "1mo" || range === "max") return `${String(year).slice(2)}/${Number(month)}`;
  return rawDate;
}

function toIncrementalIntradayVolumes<T extends { volume?: number }>(points: T[]): T[] {
  let previous = 0;
  const next = points.map((point) => {
    const current = typeof point.volume === "number" && Number.isFinite(point.volume) && point.volume > 0
      ? point.volume
      : 0;
    const volume = current >= previous ? current - previous : current;
    previous = current;
    return {
      ...point,
      volume,
    };
  });
  const hasIncremental = next.some((point) => typeof point.volume === "number" && point.volume > 0);
  const hasOriginal = points.some((point) => typeof point.volume === "number" && point.volume > 0);
  return hasIncremental || !hasOriginal ? next : points;
}

function parseTencentKlineRows(rows: any[], range: string): Array<TencentKlinePoint & { rawDate: string }> {
  return rows
    .map((row) => {
      const rawDate = String(row?.[0] ?? "");
      const open = parseFloat(String(row?.[1] ?? ""));
      const close = parseFloat(String(row?.[2] ?? row?.[1] ?? ""));
      const high = parseFloat(String(row?.[3] ?? row?.[2] ?? row?.[1] ?? ""));
      const low = parseFloat(String(row?.[4] ?? row?.[2] ?? row?.[1] ?? ""));
      const volume = parseFloat(String(row?.[5] ?? "")) || 0;
      return {
        rawDate,
        time: formatTencentKlineTime(rawDate, range),
        timestamp: Date.parse(`${rawDate}T00:00:00`),
        price: close,
        open,
        high,
        low,
        close,
        volume,
      };
    })
    .filter((point) => point.rawDate && point.price > 0);
}

function parseTencentIntradayRows(rows: any[]): TencentIntradayPoint[] {
  const todayLabel = new Date().toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  const points = rows
    .map((row) => {
      const parts = String(row ?? "").trim().split(/\s+/);
      const rawTime = parts[0] ?? "";
      const price = parseFloat(parts[1] ?? "");
      const volume = parseFloat(parts[2] ?? "") || 0;
      if (!/^\d{4}$/.test(rawTime) || !(price > 0)) return null;
      const time = `${rawTime.slice(0, 2)}:${rawTime.slice(2)}`;
      const now = new Date();
      const datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      return {
        time,
        timestamp: Date.parse(`${datePrefix}T${time}:00`),
        dateLabel: todayLabel,
        price,
        volume,
        open: price,
        high: price,
        low: price,
        close: price,
      };
    })
    .filter((point) => point != null) as TencentIntradayPoint[];
  return toIncrementalIntradayVolumes(points);
}

function aggregateTencentCalendarPoints(points: Array<TencentKlinePoint & { rawDate: string }>, mode: "quarter" | "year"): TencentKlinePoint[] {
  const grouped = new Map<string, Array<TencentKlinePoint & { rawDate: string }>>();
  for (const point of points) {
    const [year = "", month = ""] = point.rawDate.split("-");
    if (!year || !month) continue;
    const key = mode === "quarter"
      ? `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`
      : year;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(point);
  }

  return Array.from(grouped.entries()).map(([key, bucket]) => {
	  const first = bucket[0]!;
	  const last = bucket[bucket.length - 1]!;
    const highs = bucket.map((item) => item.high ?? item.close ?? item.price).filter((value) => value != null && value > 0) as number[];
    const lows = bucket.map((item) => item.low ?? item.close ?? item.price).filter((value) => value != null && value > 0) as number[];
    return {
      time: mode === "quarter" ? `${String(key.slice(2, 4))}/${key.slice(-2)}` : key,
      price: last.close ?? last.price,
      timestamp: Date.parse(`${last.rawDate}T00:00:00`),
      volume: bucket.reduce((sum, item) => sum + (item.volume ?? 0), 0) || undefined,
      open: first.open ?? first.price,
      high: highs.length ? Math.max(...highs) : last.price,
      low: lows.length ? Math.min(...lows) : last.price,
      close: last.close ?? last.price,
    };
  });
}

export async function fetchTencentKline(symbol: string, market: string, range: string): Promise<TencentKlinePoint[] | null> {
  if (market !== "HK" && market !== "A") return null;
  const qs = toTencentSymbol(symbol, market as "A" | "HK");
  const { period, limit } = tencentKlinePeriod(range);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${qs},${period},,,${limit},qfq&_=${Date.now()}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = parseTencentKlineJson(await res.text());
    const rows: any[] = json?.data?.[qs]?.[period] ?? json?.data?.[qs]?.[`qfq${period}`] ?? [];
    const rawPoints = parseTencentKlineRows(rows, range);
    if (!rawPoints.length) return null;
    if (range === "3mo") return aggregateTencentCalendarPoints(rawPoints, "quarter");
    if (range === "1y") return aggregateTencentCalendarPoints(rawPoints, "year");
    return rawPoints.map(({ rawDate: _rawDate, ...point }) => point);
  } catch {
    return null;
  }
}

export async function fetchTencentIntraday(symbol: string, market: string): Promise<TencentIntradayPoint[] | null> {
  if (market !== "HK" && market !== "A") return null;
  const qs = toTencentSymbol(symbol, market as "A" | "HK");
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${qs}&_=${Date.now()}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = parseTencentKlineJson(await res.text());
    const rows: any[] = json?.data?.[qs]?.data?.data ?? [];
    const points = parseTencentIntradayRows(rows);
    return points.length > 1 ? points : null;
  } catch {
    return null;
  }
}
