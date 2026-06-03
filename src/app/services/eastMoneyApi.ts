import { isLocalDevHost } from "../utils/runtimeEnv";

export type EastMoneyMarket = "US" | "HK" | "A" | "JP" | "FUND" | "CRYPTO" | "BOND" | "GOLD" | "INDEX" | "FX" | "COMMODITY";
export type EastMoneyAssetType = "stock" | "etf" | "fund" | "crypto" | "bond" | "cash";
export type EastMoneyChartRange = "fs" | "1d" | "5d" | "1mo" | "3mo" | "1y" | "max";

export interface EastMoneySecurity {
  symbol: string;
  name: string;
  enName?: string;
  market: EastMoneyMarket;
  assetType: EastMoneyAssetType;
  currency: string;
  exchange?: string;
  price: number;
  priceReady: boolean;
  secid?: string;
}

export interface EastMoneyQuote {
  secid: string;
  symbol: string;
  name: string;
  market: EastMoneyMarket;
  currency: string;
  exchange: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  amount: number;
  source: "eastmoney";
}

export interface EastMoneyTradeStatusSnapshot {
  symbol: string;
  market: EastMoneyMarket;
  status: "normal" | "suspended";
  note: string;
  source: "eastmoney";
}

export interface EastMoneyChartPoint {
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

const HOSTS = {
  push2delay: ["https://push2delay.eastmoney.com"],
  push2his: ["https://push2his.eastmoney.com"],
  searchapi: ["https://searchapi.eastmoney.com"],
} as const;

type HostGroup = keyof typeof HOSTS;

const DEV_PROXY: Record<HostGroup, string> = {
  push2delay: "/api/eastmoney/push2delay",
  push2his: "/api/eastmoney/push2his",
  searchapi: "/api/eastmoney/searchapi",
};

const CURRENCY_BY_MARKET: Record<EastMoneyMarket, string> = {
  US: "USD",
  HK: "HKD",
  A: "CNY",
  JP: "JPY",
  FUND: "CNY",
  CRYPTO: "USDT",
  BOND: "CNY",
  GOLD: "USD",
  INDEX: "",
  FX: "CNY",
  COMMODITY: "USD",
};

const KLINE_BY_RANGE: Record<Exclude<EastMoneyChartRange, "fs">, { klt: string; lmt: number }> = {
  "1d": { klt: "101", lmt: 10000 },
  "5d": { klt: "102", lmt: 3000 },
  "1mo": { klt: "103", lmt: 1500 },
  "3mo": { klt: "103", lmt: 1500 },
  "1y": { klt: "103", lmt: 1500 },
  max: { klt: "103", lmt: 3000 },
};

const EASTMONEY_INDEX_SECID: Record<string, string> = {
  "A:000001": "1.000001",
  "A:399001": "0.399001",
  "A:000300": "1.000300",
  "A:399006": "0.399006",
  "A:000688": "1.000688",
  "HK:HSI": "100.HSI",
  "HK:HSCEI": "100.HSCEI",
  "HK:HSTECH": "124.HSTECH",
  "INDEX:^N225": "100.N225",
  "FX:CNY=X": "120.USDCNYC",
  "FX:EURCNY=X": "120.EURCNYC",
  "FX:GBPCNY=X": "120.GBPCNYC",
  "FX:HKDCNY=X": "120.HKDCNYC",
  "FX:JPYCNY=X": "120.JPYCNYC",
  "COMMODITY:GC=F": "101.GC00Y",
  "COMMODITY:SI=F": "101.SI00Y",
  "COMMODITY:CL=F": "102.CL00Y",
  "COMMODITY:HG=F": "101.HG00Y",
};

const EASTMONEY_CHART_SECID_ALIASES: Record<string, string[]> = {
  "HK:HSTECH": ["124.HSTECH", "100.HSTECH"],
};

function isLocalDev() {
  return isLocalDevHost();
}

function buildUrl(_group: HostGroup, host: string, path: string, params: Record<string, string | number | boolean | undefined>) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    qs.set(key, String(value));
  });
  return `${host}${path}?${qs.toString()}`;
}

async function fetchWithFailover(group: HostGroup, path: string, params: Record<string, string | number | boolean | undefined>, timeoutMs = 8000) {
  const hosts = isLocalDev() ? [DEV_PROXY[group], ...HOSTS[group]] : HOSTS[group];
  let lastError: unknown = null;

  for (const host of hosts) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(buildUrl(group, host, path, params), {
        signal: ctrl.signal,
        cache: "no-store",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      clearTimeout(tid);
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`EastMoney ${group} request failed`);
}

function num(value: unknown) {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIncrementalIntradayVolumes<T extends { volume?: number }>(points: T[]) {
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

function looksLikeExchangeFundCode(code: string) {
  return /^(50|51|52|56|58|588|159|16|18)/.test(code);
}

function marketFromMktNum(mktNum: number): EastMoneyMarket | null {
  if ([0, 1].includes(mktNum)) return "A";
  if ([105, 106, 107].includes(mktNum)) return "US";
  if ([100, 116, 124, 128].includes(mktNum)) return "HK";
  return null;
}

function marketFromQuoteCode(mktNum: number): EastMoneyMarket | null {
  if ([101, 102].includes(mktNum)) return "COMMODITY";
  if ([118, 120, 122].includes(mktNum)) return "FX";
  return marketFromMktNum(mktNum);
}

function normalizeSymbol(code: string, market: EastMoneyMarket) {
  if (market === "HK") return code.replace(/\.HK$/i, "").padStart(5, "0");
  if (market === "A" || market === "FUND" || market === "BOND") return code.replace(/\.(SS|SZ)$/i, "");
  return code;
}

function inferAssetType(code: string, name: string, market: EastMoneyMarket, securityTypeName = "", classify = ""): EastMoneyAssetType {
  const text = `${name} ${securityTypeName} ${classify}`.toUpperCase();
  if (market === "FUND") return "fund";
  if (/债|BOND/.test(text)) return "bond";
  if (/ETF|REIT/.test(text)) return "etf";
  if (market === "A" && looksLikeExchangeFundCode(code) && /基金|LOF|指数/.test(text)) return "fund";
  return "stock";
}

function isUnsupportedDerivative(name: string, market: EastMoneyMarket | null, securityTypeName = "", classify = "") {
  const text = `${name} ${securityTypeName} ${classify}`.toUpperCase();
  if (/牛熊|窝轮|渦輪|涡轮|权证|認購|認沽|认购证|认沽证|CALL WARRANT|PUT WARRANT|WARRANT|CBBC/.test(text)) {
    return true;
  }
  if (market === "HK" && /[购沽]([A-Z]|$)/.test(name)) {
    return true;
  }
  return false;
}

function normalizeSearchItem(raw: any): EastMoneySecurity | null {
  const code = String(raw?.Code ?? raw?.SECURITY_CODE ?? "").trim();
  const name = String(raw?.Name ?? raw?.NAME ?? raw?.SecurityName ?? "").trim();
  if (!code || !name) return null;

  const securityTypeName = String(raw?.SecurityTypeName ?? raw?.SECURITYTYPENAME ?? raw?.CategoryDesc ?? "").trim();
  const classify = String(raw?.Classify ?? raw?.CATEGORYDESC ?? raw?.SecurityType ?? "").trim();
  const shortName = String(raw?.ShortName ?? raw?.SHORTNAME ?? "").trim();
  const mktNum = Number(raw?.MktNum4App ?? raw?.MktNum ?? raw?.MarketType ?? NaN);

  let market = marketFromMktNum(mktNum);
  if (isUnsupportedDerivative(name, market, securityTypeName, classify)) return null;
  const isExchangeFund = looksLikeExchangeFundCode(code) && /ETF|REIT|LOF|基金|指数/.test(`${name} ${shortName} ${classify} ${securityTypeName}`.toUpperCase());
  const isOffshoreFund = !market && /基金/.test(`${securityTypeName}${classify}`) && !isExchangeFund;

  if (isOffshoreFund) market = "FUND";
  if (!market) return null;

  const assetTypeByText = inferAssetType(code, name, market, securityTypeName, classify);
  const assetType = market === "FUND" ? "fund" : assetTypeByText;
  const symbol = normalizeSymbol(code, market);

  return {
    symbol,
    name,
    enName: market !== "A" && market !== "FUND" ? shortName || undefined : undefined,
    market,
    assetType,
    currency: CURRENCY_BY_MARKET[market],
    exchange:
      market === "HK" ? "HKEX" :
      market === "US" ? "US" :
      market === "A" ? (assetType === "etf" ? "场内ETF" : assetType === "fund" ? "场内基金" : "A股") :
      "基金",
    price: 0,
    priceReady: false,
    secid: toEastMoneySecid(symbol, market) ?? undefined,
  };
}

export function toEastMoneySecid(symbol: string, market: string) {
  const directIndexMatch = EASTMONEY_INDEX_SECID[`${market}:${symbol.toUpperCase()}`];
  if (directIndexMatch) return directIndexMatch;
  const raw = symbol.replace(/\.(SS|SZ|HK)$/gi, "");
  const rawDirectMatch = EASTMONEY_INDEX_SECID[`${market}:${raw.toUpperCase()}`];
  if (rawDirectMatch) return rawDirectMatch;
  if (market === "A") {
    const withSuffix = symbol.toUpperCase();
    if (withSuffix.endsWith(".SS")) return `1.${raw}`;
    if (withSuffix.endsWith(".SZ")) return `0.${raw}`;
    const isShanghai = /^(5|6|9)/.test(raw) || /^(11|13)/.test(raw);
    return `${isShanghai ? 1 : 0}.${raw}`;
  }
  if (market === "HK") return `116.${raw.padStart(5, "0")}`;
  return null;
}

function toEastMoneyChartSecids(symbol: string, market: string) {
  const primary = toEastMoneySecid(symbol, market);
  const raw = symbol.replace(/\.(SS|SZ|HK)$/gi, "").replace(/^\^/, "").toUpperCase();
  const aliases = [...(EASTMONEY_CHART_SECID_ALIASES[`${market}:${raw}`] ?? [])];
  if (market === "HK" && /^[A-Z]+$/.test(raw)) {
    aliases.push(`100.${raw}`);
    aliases.push(`124.${raw}`);
  }
  return [...new Set([primary, ...aliases].filter((item): item is string => Boolean(item)))];
}

function marketLabel(market: EastMoneyMarket) {
  switch (market) {
    case "HK": return "HKEX";
    case "US": return "US";
    case "FX": return "CNYRATE";
    case "COMMODITY": return "Global Futures";
    case "INDEX": return "Global Index";
    case "A": return "EastMoney";
    default: return "EastMoney";
  }
}

function normalizeQuoteRow(row: any, marketHint?: string): EastMoneyQuote | null {
  const market = (marketHint as EastMoneyMarket | undefined) ?? marketFromQuoteCode(Number(row?.f13));
  if (!market) return null;

  const code = String(row?.f12 ?? "").trim();
  const name = String(row?.f14 ?? "").trim();
  const price = num(row?.f2);
  if (!code || !name || !(price > 0)) return null;

  const symbol = normalizeSymbol(code, market);
  const prevClose = num(row?.f18);
  const change = num(row?.f4) || (prevClose > 0 ? price - prevClose : 0);
  const rawPct = num(row?.f3);
  const changePercent = rawPct ? rawPct / 100 : (prevClose > 0 ? change / prevClose : 0);

  return {
    secid: `${row?.f13}.${code}`,
    symbol,
    name,
    market,
    currency: CURRENCY_BY_MARKET[market],
    exchange: marketLabel(market),
    price,
    change,
    changePercent,
    open: num(row?.f17) || prevClose || price,
    high: num(row?.f15) || price,
    low: num(row?.f16) || price,
    prevClose: prevClose || price,
    volume: num(row?.f5),
    amount: num(row?.f6),
    source: "eastmoney",
  };
}

function normalizeTradeStatusRow(row: any, marketHint?: string): EastMoneyTradeStatusSnapshot | null {
  const market = (marketHint as EastMoneyMarket | undefined) ?? marketFromQuoteCode(Number(row?.f13));
  if (!market) return null;

  const code = String(row?.f12 ?? "").trim();
  const name = String(row?.f14 ?? "").trim();
  if (!code || !name) return null;

  const price = num(row?.f2);
  const prevClose = num(row?.f18);
  const open = num(row?.f17);
  const high = num(row?.f15);
  const low = num(row?.f16);

  if (price > 0) {
    return {
      symbol: normalizeSymbol(code, market),
      market,
      status: "normal",
      note: "自动行情源显示可正常交易",
      source: "eastmoney",
    };
  }

  if (prevClose > 0 || open > 0 || high > 0 || low > 0) {
    return {
      symbol: normalizeSymbol(code, market),
      market,
      status: "suspended",
      note: "东方财富报价显示停牌或暂停交易",
      source: "eastmoney",
    };
  }

  return null;
}

function formatTrendTime(raw: string, range: EastMoneyChartRange) {
  const [date = "", time = ""] = String(raw).split(" ");
  if (range === "fs") return time || raw;
  if (date) {
    const [y, m, d] = date.split("-");
    if (range === "5d") return `${String(y).slice(2)}/${Number(m)}/${Number(d)}`;
    if (range === "1mo" || range === "max") return `${String(y).slice(2)}/${Number(m)}`;
    if (range === "3mo") return `${String(y).slice(2)}/Q${Math.floor((Number(m) - 1) / 3) + 1}`;
    if (range === "1y") return String(y);
    return `${Number(m)}/${Number(d)}`;
  }
  return raw;
}

function formatTrendDateLabel(raw: string) {
  const [date = ""] = String(raw).split(" ");
  if (!date) return "";
  const [, month = "", day = ""] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

function aggregateEastMoneyCalendarPoints(points: Array<EastMoneyChartPoint & { rawDate: string }>, mode: "quarter" | "year") {
  const grouped = new Map<string, Array<EastMoneyChartPoint & { rawDate: string }>>();
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
      time: mode === "quarter"
        ? `${String(key.slice(2, 4))}/${key.slice(-2)}`
        : key,
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

async function fetchEastMoneyTrendPoints(secid: string) {
  const data = await fetchWithFailover(
    "push2delay",
    "/api/qt/stock/trends2/get",
    {
      secid,
      fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f14",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
      iscr: 0,
      iscca: 0,
      ndays: 1,
    },
  );

  const rows: string[] = data?.data?.trends ?? [];
  const points = rows
    .map((row) => String(row).split(","))
    .map((parts) => ({
      time: formatTrendTime(parts[0] ?? "", "fs"),
      timestamp: Date.parse(String(parts[0] ?? "").replace(" ", "T")),
      dateLabel: formatTrendDateLabel(parts[0] ?? ""),
      price: num(parts[2] ?? parts[1]),
      volume: num(parts[5]),
      open: num(parts[1] ?? parts[2]),
      high: num(parts[3] ?? parts[2]),
      low: num(parts[4] ?? parts[2]),
      close: num(parts[2] ?? parts[1]),
    }))
    .filter((point) => point.price > 0);

  if (!points.length) throw new Error("empty eastmoney trend data");
  return toIncrementalIntradayVolumes(points);
}

async function fetchEastMoneyKlinePoints(secid: string, range: Exclude<EastMoneyChartRange, "fs">) {
  const spec = KLINE_BY_RANGE[range];
  const data = await fetchWithFailover("push2his", "/api/qt/stock/kline/get", {
    secid,
    klt: spec.klt,
    fqt: 1,
    end: 20500101,
    iscca: 1,
    fields1: "f1,f2,f3,f4,f5",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f59",
    ut: "f057cbcbce2a86e2866ab8877db1d059",
    forcect: 1,
    lmt: spec.lmt,
  });

  const rows: string[] = data?.data?.klines ?? [];
  const rawPoints = rows
    .map((row) => String(row).split(","))
    .map((parts) => ({
      rawDate: String(parts[0] ?? "").split(" ")[0],
      time: formatTrendTime(parts[0] ?? "", range),
      timestamp: Date.parse(`${String(parts[0] ?? "").split(" ")[0]}T00:00:00`),
      price: num(parts[2] ?? parts[1]),
      volume: num(parts[5]),
      open: num(parts[1]),
      close: num(parts[2] ?? parts[1]),
      high: num(parts[3] ?? parts[2] ?? parts[1]),
      low: num(parts[4] ?? parts[2] ?? parts[1]),
    }))
    .filter((point): point is typeof point & { rawDate: string } => point.price > 0 && Boolean(point.rawDate));

  const points = range === "3mo"
    ? aggregateEastMoneyCalendarPoints(rawPoints, "quarter")
    : range === "1y"
      ? aggregateEastMoneyCalendarPoints(rawPoints, "year")
      : rawPoints.map(({ rawDate: _rawDate, ...point }) => point);

  if (!points.length) throw new Error("empty eastmoney kline data");
  return points;
}

export async function searchEastMoneySecurities(query: string) {
  const q = query.trim();
  if (!q) return [] as EastMoneySecurity[];

  const data = await fetchWithFailover("searchapi", "/api/Info/Search", {
    appid: "el1902262",
    type: 14,
    token: "CCSDCZSDCXYMYZYYSYYXSMDDSMDHHDJT",
    and14: `MultiMatch/Name,Code,PinYin/${q}/true`,
    returnfields14: "Name,Code,PinYin,MarketType,JYS,MktNum,JYS4App,MktNum4App,ID,Classify,IsExactMatch,SecurityType,SecurityTypeName,ShortName",
    pageIndex14: 1,
    pageSize14: 20,
    isAssociation14: `false${Date.now()}`,
  }, 7000);

  const rows: any[] = data?.Data ?? data?.QuotationCodeTable?.Data ?? [];
  const seen = new Set<string>();
  const results: EastMoneySecurity[] = [];
  for (const row of rows) {
    const normalized = normalizeSearchItem(row);
    if (!normalized) continue;
    const key = `${normalized.market}:${normalized.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
  }
  return results;
}

export async function fetchEastMoneyQuotes(secids: string[], marketHints?: Record<string, string>) {
  const uniqueSecids = [...new Set(secids.filter(Boolean))];
  if (!uniqueSecids.length) return [] as EastMoneyQuote[];

  const data = await fetchWithFailover("push2delay", "/api/qt/ulist.np/get", {
    fltt: 2,
    fields: "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18",
    secids: uniqueSecids.join(","),
  });

  const rows: any[] = data?.data?.diff ?? [];
  return rows
    .map((row) => {
      const secid = `${row?.f13}.${row?.f12}`;
      return normalizeQuoteRow(row, marketHints?.[secid]);
    })
    .filter((row): row is EastMoneyQuote => row != null);
}

export async function fetchEastMoneyQuotesBySymbols(items: Array<{ symbol: string; market: string }>) {
  const refs = items
    .map((item) => ({ ...item, secid: toEastMoneySecid(item.symbol, item.market) }))
    .filter((item): item is { symbol: string; market: string; secid: string } => Boolean(item.secid));

  if (!refs.length) return [] as EastMoneyQuote[];
  return fetchEastMoneyQuotes(
    refs.map((item) => item.secid),
    Object.fromEntries(refs.map((item) => [item.secid, item.market]))
  );
}

export async function fetchEastMoneyTradeStatuses(secids: string[], marketHints?: Record<string, string>) {
  const uniqueSecids = [...new Set(secids.filter(Boolean))];
  if (!uniqueSecids.length) return [] as EastMoneyTradeStatusSnapshot[];

  const data = await fetchWithFailover("push2delay", "/api/qt/ulist.np/get", {
    fltt: 2,
    fields: "f2,f12,f13,f14,f15,f16,f17,f18",
    secids: uniqueSecids.join(","),
  });

  const rows: any[] = data?.data?.diff ?? [];
  return rows
    .map((row) => {
      const secid = `${row?.f13}.${row?.f12}`;
      return normalizeTradeStatusRow(row, marketHints?.[secid]);
    })
    .filter((row): row is EastMoneyTradeStatusSnapshot => row != null);
}

export async function fetchEastMoneyTradeStatusesBySymbols(items: Array<{ symbol: string; market: string }>) {
  const refs = items
    .map((item) => ({ ...item, secid: toEastMoneySecid(item.symbol, item.market) }))
    .filter((item): item is { symbol: string; market: string; secid: string } => Boolean(item.secid));

  if (!refs.length) return [] as EastMoneyTradeStatusSnapshot[];
  return fetchEastMoneyTradeStatuses(
    refs.map((item) => item.secid),
    Object.fromEntries(refs.map((item) => [item.secid, item.market]))
  );
}

export async function fetchEastMoneyQuoteBySymbol(symbol: string, market: string) {
  const quotes = await fetchEastMoneyQuotesBySymbols([{ symbol, market }]);
  return quotes[0] ?? null;
}

export async function fetchEastMoneyChart(symbol: string, market: string, range: EastMoneyChartRange) {
  const secids = toEastMoneyChartSecids(symbol, market);
  if (!secids.length) throw new Error(`EastMoney chart unsupported for ${market}:${symbol}`);

  const quotePromise = fetchEastMoneyQuoteBySymbol(symbol, market).catch(() => null);
  let points: EastMoneyChartPoint[] | null = null;
  let resolvedSecid = secids[0];
  let lastError: unknown = null;
  for (const secid of secids) {
    try {
      points = await (range === "fs"
        ? fetchEastMoneyTrendPoints(secid)
        : fetchEastMoneyKlinePoints(secid, range));
      resolvedSecid = secid;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  const quote = await quotePromise;
  if (!points?.length) {
    throw lastError instanceof Error ? lastError : new Error(`empty eastmoney chart data for ${market}:${symbol}`);
  }

  if (quote) return { quote: { ...quote, isLive: true }, points };

  const latest = points[points.length - 1];
  const previous = points[points.length - 2] ?? latest;
  if (!latest) throw new Error(`EastMoney quote unavailable for ${market}:${symbol}`);

  const latestPrice = latest.close ?? latest.price;
  const prevClose = previous?.close ?? previous?.price ?? latestPrice;
  const change = latestPrice - prevClose;
  const normalizedMarket = market as EastMoneyMarket;

  return {
    quote: {
      secid: resolvedSecid,
      symbol: normalizeSymbol(symbol, normalizedMarket),
      name: symbol,
      market: normalizedMarket,
      currency: CURRENCY_BY_MARKET[normalizedMarket] ?? "",
      exchange: marketLabel(normalizedMarket),
      price: latestPrice,
      change,
      changePercent: prevClose > 0 ? change / prevClose : 0,
      open: latest.open ?? prevClose,
      high: latest.high ?? latestPrice,
      low: latest.low ?? latestPrice,
      prevClose,
      volume: latest.volume ?? 0,
      amount: 0,
      source: "eastmoney",
      isLive: true,
    },
    points,
  };
}
