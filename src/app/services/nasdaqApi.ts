import type { ChartData, ChartPoint, QuoteInfo, TimeRange } from "./quoteApi";

type NasdaqAssetClass = "stocks" | "etf" | "index";

const NASDAQ_HOST = "https://api.nasdaq.com";

const INDEX_SYMBOL_MAP: Record<string, string> = {
  "^NDX": "NDX",
  "^GSPC": "SPX",
  "^DJI": "DJIA",
  "^IXIC": "IXIC",
  "^VIX": "VIX",
};

function buildHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0",
  };
}

function toNasdaqSymbol(symbol: string) {
  return INDEX_SYMBOL_MAP[symbol] ?? symbol.replace(/^\^/, "");
}

function candidateAssetClasses(symbol: string): NasdaqAssetClass[] {
  if (symbol.startsWith("^")) return ["index"];
  return ["stocks", "etf"];
}

function parseNumber(raw: unknown) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[$,%+,]/g, "").replace(/--|N\/A|NA/gi, "").trim();
  if (!cleaned) return 0;
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function parsePercent(raw: unknown) {
  const value = parseNumber(raw);
  if (typeof raw === "string" && raw.includes("%")) return value / 100;
  return Math.abs(value) > 1 ? value / 100 : value;
}

function parseExtendedTrade(text: unknown) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/(\$?[-+]?[\d,.]+)\s+([-+]?\$?[\d,.]+)\s+\(([-+]?[\d,.]+)%\)/);
  if (!match) return null;
  const price = parseNumber(match[1]);
  const change = parseNumber(match[2]);
  const changePercent = parseNumber(match[3]) / 100;
  if (!(price > 0)) return null;
  return { price, change, changePercent };
}

function detectCurrency(symbol: string) {
  return symbol.startsWith("^") ? "" : "USD";
}

function formatNasdaqDate(raw: string, range: TimeRange) {
  const [month = "", day = "", year = ""] = raw.split("/");
  if (!month || !day || !year) return raw;
  if (range === "fs") {
    return `${Number(month)}/${Number(day)}`;
  }
  if (range === "1mo" || range === "max") {
    return `${year.slice(2)}/${Number(month)}`;
  }
  if (range === "3mo") {
    return `${year.slice(2)}/Q${Math.floor((Number(month) - 1) / 3) + 1}`;
  }
  if (range === "1y") {
    return year;
  }
  if (range === "1d") {
    return `${year.slice(2)}/${Number(month)}/${Number(day)}`;
  }
  return `${Number(month)}/${Number(day)}`;
}

function windowStart(range: TimeRange) {
  const now = new Date();
  const d = new Date(now);
  switch (range) {
    case "fs":
      d.setDate(d.getDate() - 5);
      break;
    case "1d":
      d.setFullYear(1970, 0, 1);
      break;
    case "5d":
      d.setFullYear(1970, 0, 1);
      break;
    case "1mo":
      d.setFullYear(1970, 0, 1);
      break;
    case "3mo":
      d.setFullYear(1970, 0, 1);
      break;
    case "1y":
      d.setFullYear(1970, 0, 1);
      break;
    case "max":
      d.setFullYear(1970, 0, 1);
      break;
  }
  return d;
}

function historyLimit(range: TimeRange) {
  switch (range) {
    case "fs":
      return 120;
    case "1d":
      return 20000;
    case "5d":
      return 5000;
    case "1mo":
      return 2000;
    case "3mo":
      return 2000;
    case "1y":
      return 5000;
    case "max":
      return 5000;
    default:
      return 5000;
  }
}

function aggregateNasdaqRows(points: Array<ChartPoint & { rawDate: string }>, range: TimeRange): ChartPoint[] {
  if (range !== "5d" && range !== "3mo" && range !== "1y") {
    return points.map(({ rawDate: _rawDate, ...point }) => point);
  }

  const mode = range === "5d" ? "week" : range === "3mo" ? "quarter" : "year";
  const grouped = new Map<string, Array<ChartPoint & { rawDate: string }>>();
  for (const point of points) {
    const [month = "", day = "", year = ""] = point.rawDate.split("/");
    if (!month || !day || !year) continue;
    const d = new Date(`${year}-${month}-${day}T00:00:00`);
    if (Number.isNaN(d.getTime())) continue;
    const key = mode === "week"
      ? `${d.getFullYear()}-W${Math.ceil((((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + new Date(d.getFullYear(), 0, 1).getDay() + 1) / 7)}`
      : mode === "quarter"
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
      time: mode === "week"
        ? formatNasdaqDate(last.rawDate, "5d")
        : mode === "quarter"
          ? `${String(key.slice(2, 4))}/${key.slice(-2)}`
          : key,
      price: last.close ?? last.price,
      volume: bucket.reduce((sum, item) => sum + (item.volume ?? 0), 0) || undefined,
      open: first.open ?? first.price,
      high: highs.length ? Math.max(...highs) : last.price,
      low: lows.length ? Math.min(...lows) : last.price,
      close: last.close ?? last.price,
    };
  });
}

function fmtApiDate(date: Date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchNasdaqJson(path: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(`${NASDAQ_HOST}${path}`, {
        signal: ctrl.signal,
        cache: "no-store",
        headers: buildHeaders(),
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (attempt === 0 && retryable) throw new Error(`HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      const retryable = /HTTP (429|5\d\d)/.test(error instanceof Error ? error.message : "");
      if (attempt === 0 && retryable) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      } else {
        break;
      }
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Nasdaq request failed");
}

function buildQuoteFromInfo(symbol: string, assetClass: NasdaqAssetClass, data: any, rowHint?: any): QuoteInfo | null {
  const primary = data?.primaryData ?? {};
  const keyStats = data?.keyStats ?? {};
  const price = parseNumber(primary.lastSalePrice);
  const change = parseNumber(primary.netChange);
  const changePercent = parsePercent(primary.percentageChange);
  const prevClose = parseNumber(keyStats.previousclose?.value) || (price && change ? price - change : 0);

  let open = parseNumber(rowHint?.open);
  let high = parseNumber(rowHint?.high);
  let low = parseNumber(rowHint?.low);
  const volume = parseNumber(primary.volume) || parseNumber(rowHint?.volume);

  const dayRangeText = String(keyStats.dayrange?.value ?? "").trim();
  if ((!low || !high) && dayRangeText.includes("-")) {
    const [rangeLow = 0, rangeHigh = 0] = dayRangeText.split("-").map((part) => parseNumber(part));
    low = low || rangeLow;
    high = high || rangeHigh;
  }

  if (!open && prevClose > 0 && change) open = prevClose;
  if (!high) high = parseNumber(rowHint?.close) || price || open || prevClose;
  if (!low) low = parseNumber(rowHint?.close) || price || open || prevClose;
  if (!open) open = parseNumber(rowHint?.close) || prevClose || price;

  if (!(price > 0) && !(prevClose > 0)) return null;

  return {
    symbol,
    name: data?.companyName ?? symbol,
    price: price || parseNumber(rowHint?.close) || prevClose,
    change,
    changePercent,
    open,
    high,
    low,
    prevClose: prevClose || open || high || low || price,
    volume,
    currency: detectCurrency(symbol),
    exchange: typeof data?.exchange === "string" ? data.exchange : assetClass.toUpperCase(),
    isLive: true,
  };
}

export async function fetchNasdaqChart(symbol: string, range: TimeRange): Promise<ChartData | null> {
  const nasdaqSymbol = toNasdaqSymbol(symbol);
  const today = fmtApiDate(new Date());
  const fromDate = fmtApiDate(windowStart(range));
  const limit = historyLimit(range);

  for (const assetClass of candidateAssetClasses(symbol)) {
    try {
      const [infoJson, historyJson] = await Promise.all([
        fetchNasdaqJson(`/api/quote/${encodeURIComponent(nasdaqSymbol)}/info?assetclass=${assetClass}`),
        fetchNasdaqJson(
          `/api/quote/${encodeURIComponent(nasdaqSymbol)}/historical?assetclass=${assetClass}&fromdate=${fromDate}&limit=${limit}&todate=${today}`
        ),
      ]);

      const infoData = infoJson?.data;
      const rows: any[] = historyJson?.data?.tradesTable?.rows ?? [];
      const rawPoints: Array<ChartPoint & { rawDate: string }> = rows
        .slice()
        .reverse()
        .map((row) => ({
          rawDate: String(row?.date ?? ""),
          time: formatNasdaqDate(String(row?.date ?? ""), range),
          price: parseNumber(row?.close),
          volume: parseNumber(row?.volume) || undefined,
          open: parseNumber(row?.open) || undefined,
          high: parseNumber(row?.high) || undefined,
          low: parseNumber(row?.low) || undefined,
          close: parseNumber(row?.close) || undefined,
        }))
        .filter((row) => row.price > 0);
      const points = aggregateNasdaqRows(rawPoints, range);

      const latestRow = rows[0] ?? null;
      const quote = buildQuoteFromInfo(symbol, assetClass, infoData, latestRow);
      if (!quote) continue;

      return { quote, points };
    } catch {
      continue;
    }
  }

  return null;
}

export async function fetchNasdaqQuote(symbol: string): Promise<QuoteInfo | null> {
  const nasdaqSymbol = toNasdaqSymbol(symbol);

  for (const assetClass of candidateAssetClasses(symbol)) {
    try {
      const infoJson = await fetchNasdaqJson(`/api/quote/${encodeURIComponent(nasdaqSymbol)}/info?assetclass=${assetClass}`);
      const quote = buildQuoteFromInfo(symbol, assetClass, infoJson?.data);
      if (quote) return quote;
    } catch {
      continue;
    }
  }

  return null;
}

function extendedSessionsForMarketState(marketState?: string): Array<"pre" | "post"> {
  const normalized = String(marketState ?? "").toUpperCase();
  if (normalized.includes("PRE")) return ["pre"];
  if (normalized.includes("POST")) return ["post"];
  return ["pre", "post"];
}

export async function fetchNasdaqExtendedQuote(symbol: string, marketState?: string): Promise<Partial<QuoteInfo> | null> {
  if (symbol.startsWith("^")) return null;
  const nasdaqSymbol = toNasdaqSymbol(symbol);
  const result: Partial<QuoteInfo> = {};

  for (const assetClass of candidateAssetClasses(symbol)) {
    let found = false;
    const sessions = extendedSessionsForMarketState(marketState);
    const responses = await Promise.allSettled(
      sessions.map((session) => fetchNasdaqJson(
        `/api/quote/${encodeURIComponent(nasdaqSymbol)}/extended-trading?assetclass=${assetClass}&markettype=${session}`
      ))
    );
    for (let i = 0; i < sessions.length; i++) {
      const response = responses[i];
      if (!response) continue;
      if (response.status !== "fulfilled") continue;
      const session = sessions[i];
      try {
        const json = response.value;
        const row = json?.data?.infoTable?.rows?.[0];
        const parsed = parseExtendedTrade(row?.consolidated);
        if (!parsed) continue;

        if (session === "pre") {
          result.preMarketPrice = parsed.price;
          result.preMarketChange = parsed.change;
          result.preMarketChangePercent = parsed.changePercent;
        } else {
          result.postMarketPrice = parsed.price;
          result.postMarketChange = parsed.change;
          result.postMarketChangePercent = parsed.changePercent;
        }
        found = true;
      } catch {
        continue;
      }
    }
    if (found) return result;
  }

  return null;
}
