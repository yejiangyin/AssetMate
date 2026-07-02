export interface PublicQuote {
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

export interface PublicChartPoint {
  time: string;
  price: number;
  volume?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

export type PublicMarketTimeRange = "fs" | "1d" | "5d" | "1mo" | "3mo" | "1y" | "max";

type BinanceKlineRow = [
  number | string,
  string,
  string,
  string,
  string,
  string,
  ...unknown[],
];

type OkxKlineRow = [
  number | string,
  string,
  string,
  string,
  string,
  string,
  ...unknown[],
];

function mkAbort(ms: number): [AbortSignal, () => void] {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return [ctrl.signal, () => clearTimeout(tid)];
}

function num(value: unknown) {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cryptoBaseSymbol(symbol: string) {
  return symbol
    .toUpperCase()
    .replace(/-USD$/i, "")
    .replace(/-USDT$/i, "")
    .replace(/\/USD$/i, "")
    .replace(/\/USDT$/i, "");
}

function toBinanceSymbol(symbol: string) {
  return `${cryptoBaseSymbol(symbol)}USDT`;
}

function toOkxInstId(symbol: string) {
  return `${cryptoBaseSymbol(symbol)}-USDT`;
}

function formatDateLabel(input: Date, range: PublicMarketTimeRange) {
  const year = String(input.getFullYear()).slice(2);
  const month = input.getMonth() + 1;
  const day = input.getDate();
  if (range === "fs") {
    const hh = String(input.getHours()).padStart(2, "0");
    const mm = String(input.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (range === "1mo" || range === "max") return `${year}/${month}`;
  if (range === "3mo") return `${year}/Q${Math.floor((month - 1) / 3) + 1}`;
  if (range === "1y") return String(input.getUTCFullYear());
  return `${year}/${month}/${day}`;
}

function binanceInterval(range: PublicMarketTimeRange) {
  switch (range) {
    case "fs":
      return { interval: "5m", limit: 288 };
    case "1d":
      return { interval: "1d", limit: 1000 };
    case "5d":
      return { interval: "1w", limit: 520 };
    case "1mo":
      return { interval: "1M", limit: 240 };
    case "3mo":
      return { interval: "1M", limit: 240 };
    case "1y":
      return { interval: "1M", limit: 240 };
    case "max":
      return { interval: "1M", limit: 240 };
  }
}

function okxBar(range: PublicMarketTimeRange) {
  switch (range) {
    case "fs":
      return { bar: "5m", limit: 288 };
    case "1d":
      return { bar: "1Dutc", limit: 300 };
    case "5d":
      return { bar: "1Wutc", limit: 260 };
    case "1mo":
      return { bar: "1Mutc", limit: 120 };
    case "3mo":
      return { bar: "1Mutc", limit: 120 };
    case "1y":
      return { bar: "3Mutc", limit: 120 };
    case "max":
      return { bar: "1Mutc", limit: 300 };
  }
}

function aggregateCalendarPoints(points: PublicChartPoint[], mode: "quarter" | "year"): PublicChartPoint[] {
  const groups = new Map<string, PublicChartPoint[]>();
  for (const point of points) {
    const [yearPart = "", monthPart = ""] = String(point.time).split("/");
    const fullYear = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    const month = Number(monthPart);
    if (!fullYear || !month) continue;
    const key = mode === "quarter"
      ? `${fullYear}-Q${Math.floor((month - 1) / 3) + 1}`
      : fullYear;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(point);
  }

  return Array.from(groups.entries()).map(([key, bucket]) => {
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const highs = bucket.map((item) => item.high ?? item.price).filter((value) => value != null && value > 0) as number[];
    const lows = bucket.map((item) => item.low ?? item.price).filter((value) => value != null && value > 0) as number[];
    return {
      time: mode === "quarter" ? `${String(key.slice(2, 4))}/${key.slice(-2)}` : key,
      price: last.close ?? last.price,
      volume: bucket.reduce((sum, item) => sum + (item.volume ?? 0), 0) || undefined,
      open: first.open ?? first.price,
      high: highs.length ? Math.max(...highs) : last.price,
      low: lows.length ? Math.min(...lows) : last.price,
      close: last.close ?? last.price,
    };
  });
}

export async function fetchBinanceCryptoQuote(symbol: string): Promise<PublicQuote | null> {
  const pair = toBinanceSymbol(symbol);
  const [signal, clear] = mkAbort(6000);
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`, {
      signal,
      cache: "no-store",
    });
    clear();
    if (!res.ok) return null;
    const json = await res.json();
    const price = num(json?.lastPrice);
    if (!(price > 0)) return null;
    const prevClose = num(json?.prevClosePrice) || num(json?.openPrice) || price;
    const change = num(json?.priceChange) || (price - prevClose);
    const rawPct = num(json?.priceChangePercent);
    return {
      symbol: cryptoBaseSymbol(symbol),
      name: cryptoBaseSymbol(symbol),
      price,
      prevClose,
      open: num(json?.openPrice) || prevClose,
      high: num(json?.highPrice) || price,
      low: num(json?.lowPrice) || price,
      change,
      changePercent: rawPct / 100,
      volume: num(json?.volume),
      currency: "USDT",
      exchange: "Binance",
    };
  } catch {
    clear();
    return null;
  }
}

export async function fetchBinanceCryptoKline(symbol: string, range: PublicMarketTimeRange): Promise<PublicChartPoint[] | null> {
  const pair = toBinanceSymbol(symbol);
  const { interval, limit } = binanceInterval(range);
  const [signal, clear] = mkAbort(7000);
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`,
      { signal, cache: "no-store" },
    );
    clear();
    if (!res.ok) return null;
    const rows = await res.json() as BinanceKlineRow[];
    const points = rows.map((row) => {
      const time = new Date(Number(row?.[0] ?? 0));
      const open = num(row?.[1]);
      const high = num(row?.[2]);
      const low = num(row?.[3]);
      const close = num(row?.[4]);
      const volume = num(row?.[5]);
      return {
        time: formatDateLabel(time, range),
        price: close,
        volume,
        open,
        high,
        low,
        close,
      };
    }).filter((point) => point.price > 0);
    if (!points.length) return null;
    if (range === "3mo") return aggregateCalendarPoints(points, "quarter");
    if (range === "1y") return aggregateCalendarPoints(points, "year");
    return points;
  } catch {
    clear();
    return null;
  }
}

export async function fetchOkxCryptoQuote(symbol: string): Promise<PublicQuote | null> {
  const instId = toOkxInstId(symbol);
  const [signal, clear] = mkAbort(6000);
  try {
    const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`, {
      signal,
      cache: "no-store",
    });
    clear();
    if (!res.ok) return null;
    const json = await res.json();
    const item = json?.data?.[0];
    const price = num(item?.last);
    if (!(price > 0)) return null;
    const open = num(item?.open24h) || price;
    const prevClose = open;
    return {
      symbol: cryptoBaseSymbol(symbol),
      name: cryptoBaseSymbol(symbol),
      price,
      prevClose,
      open,
      high: num(item?.high24h) || price,
      low: num(item?.low24h) || price,
      change: price - prevClose,
      changePercent: prevClose > 0 ? (price - prevClose) / prevClose : 0,
      volume: num(item?.vol24h),
      currency: "USDT",
      exchange: "OKX",
    };
  } catch {
    clear();
    return null;
  }
}

export async function fetchOkxCryptoKline(symbol: string, range: PublicMarketTimeRange): Promise<PublicChartPoint[] | null> {
  const instId = toOkxInstId(symbol);
  const { bar, limit } = okxBar(range);
  const [signal, clear] = mkAbort(7000);
  try {
    const res = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`,
      { signal, cache: "no-store" },
    );
    clear();
    if (!res.ok) return null;
    const rows = await res.json() as { data?: OkxKlineRow[] };
    const points = (rows.data ?? []).slice().reverse().map((row) => {
      const time = new Date(Number(row?.[0] ?? 0));
      const open = num(row?.[1]);
      const high = num(row?.[2]);
      const low = num(row?.[3]);
      const close = num(row?.[4]);
      const volume = num(row?.[5]);
      return {
        time: formatDateLabel(time, range),
        price: close,
        volume,
        open,
        high,
        low,
        close,
      };
    }).filter((point) => point.price > 0);
    if (!points.length) return null;
    if (range === "3mo") return aggregateCalendarPoints(points, "quarter");
    if (range === "1y") return aggregateCalendarPoints(points, "year");
    return points;
  } catch {
    clear();
    return null;
  }
}
