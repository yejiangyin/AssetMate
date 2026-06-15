import { fetchTencentQuote } from "./tencentQuote";
import { fetchEastMoneyQuoteBySymbol, fetchEastMoneyQuotesBySymbols, searchEastMoneySecurities } from "./eastMoneyApi";
import { fetchBinanceCryptoQuote, fetchOkxCryptoQuote } from "./publicMarketApi";
import { isLocalDevHost } from "../utils/runtimeEnv";

/**
 * Securities live-search & price service
 *
 * Stock / ETF / US-Fund  →  Yahoo Finance (query1.finance.yahoo.com)
 * Crypto                 →  CoinGecko / Binance / OKX
 * China public fund      →  天天基金 (fundsuggest.eastmoney.com / fundgz.1234567.com.cn)
 */

/* ═══════════════════════════════════════════════════════
   Types
══════════════════════════════════════════════════════════ */
export type Market     = "US" | "HK" | "A" | "JP" | "FUND" | "CRYPTO" | "BOND" | "GOLD" | "INDEX" | "FX" | "COMMODITY";
export type AssetType  = "stock" | "etf" | "fund" | "crypto" | "bond" | "cash";

export interface LiveResult {
  symbol:    string;
  name:      string;
  enName?:   string;
  market:    Market;
  assetType: AssetType;
  currency:  string;
  price:     number;
  priceReady: boolean;
  exchange?: string;
  coinId?:   string;
  source:    "live" | "local";
}

interface FundEstimateSnapshot {
  name?: string;
  officialDate?: string;
  officialNav: number;
  estimatedNav: number;
  estimatedChangePercent: number;
}

function formatChinaFundDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  return year && month && day ? `${year}-${month}-${day}` : "";
}

/* ═══════════════════════════════════════════════════════
   Cache (much shorter for search to keep things fresh)
══════════════════════════════════════════════════════════ */
const CACHE_TTL = 30 * 1000; // 30s
const searchCache = new Map<string, { data: LiveResult[]; ts: number }>();

function getCache(key: string): LiveResult[] | null {
  const e = searchCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts >= CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key);
  searchCache.set(key, e);
  return e.data;
}
function setCache(key: string, data: LiveResult[]) {
  if (searchCache.has(key)) searchCache.delete(key);
  searchCache.set(key, { data, ts: Date.now() });
  if (searchCache.size > 200) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

/* ═══════════════════════════════════════════════════════
   Helpers
══════════════════════════════════════════════════════════ */
function shouldUseYahooProxy() {
  return isLocalDevHost();
}

function yahooUrl(path: string): string {
  return shouldUseYahooProxy() ? `/api/yahoo${path}` : `https://query1.finance.yahoo.com${path}`;
}

function resolveYahooUsPrice(meta: any, market: Market) {
  const numberOrZero = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const prevClose = numberOrZero(meta?.previousClose ?? meta?.chartPreviousClose);
  const regularPrice = numberOrZero(meta?.regularMarketPrice);
  if (market !== "US") {
    return {
      price: regularPrice,
      prevClose: prevClose || regularPrice,
      high: numberOrZero(meta?.regularMarketDayHigh) || regularPrice,
      low: numberOrZero(meta?.regularMarketDayLow) || regularPrice,
      volume: numberOrZero(meta?.regularMarketVolume),
      change: Number(meta?.regularMarketChange ?? regularPrice - (prevClose || regularPrice)),
      changePercent: Number(meta?.regularMarketChangePercent ?? ((prevClose || regularPrice) > 0 ? (regularPrice - (prevClose || regularPrice)) / (prevClose || regularPrice) : 0)),
    };
  }

  const marketState = String(meta?.marketState ?? "").toUpperCase();
  const prePrice = numberOrZero(meta?.preMarketPrice);
  const postPrice = numberOrZero(meta?.postMarketPrice);
  const price = postPrice && (marketState.includes("POST") || marketState === "CLOSED")
    ? postPrice
    : prePrice && marketState.includes("PRE")
      ? prePrice
      : regularPrice;
  const change = price - (prevClose || price);
  return {
    price,
    prevClose: prevClose || price,
    high: Math.max(numberOrZero(meta?.regularMarketDayHigh) || price, price),
    low: Math.min(numberOrZero(meta?.regularMarketDayLow) || price, price),
    volume: numberOrZero(meta?.postMarketVolume ?? meta?.preMarketVolume ?? meta?.regularMarketVolume),
    change,
    changePercent: (prevClose || price) > 0 ? change / (prevClose || price) : 0,
  };
}

function mkAbort(ms: number): [AbortSignal, () => void] {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return [ctrl.signal, () => clearTimeout(tid)];
}

export async function fetchCnFundEstimate(code: string): Promise<FundEstimateSnapshot | null> {
  const [signal, clear] = mkAbort(6000);
  try {
    const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
    const res = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return null;

    const text = await res.text();
    const match = text.match(/jsonpgz\((\{[\s\S]*?\})\)/);
    if (!match) return null;

    const data = JSON.parse(match[1]!);
    return {
      name: typeof data?.name === "string" ? data.name : undefined,
      officialDate: typeof data?.jzrq === "string" ? data.jzrq : undefined,
      officialNav: parseFloat(String(data?.dwjz ?? "")),
      estimatedNav: parseFloat(String(data?.gsz ?? "")),
      estimatedChangePercent: parseFloat(String(data?.gszzl ?? "")),
    };
  } catch {
    clear();
    return null;
  }
}

export function parseFundBuyConfirmDays(text: string): number | undefined {
  const raw = text.match(/买入确认日\s*T\s*\+\s*(\d{1,2})/)?.[1];
  if (raw === undefined) return undefined;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 30 ? days : undefined;
}

export async function fetchCnFundTradeStatus(code: string): Promise<{
  status: "normal" | "fund_limit" | "buy_disabled";
  note: string;
  buyConfirmDays?: number;
} | null> {
  const [signal, clear] = mkAbort(6000);
  try {
    const base = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)
      ? "/api/eastmoney/fundf10"
      : "https://fundf10.eastmoney.com";
    const url = `${base}/jjfl_${encodeURIComponent(code)}.html`;
    const res = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return null;

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const purchase = text.match(/申购状态\s*(暂停申购|开放申购|限制大额申购|限大额|暂停|开放|不支持)/)?.[1] ?? "";
    const dca = text.match(/定投状态\s*(不支持|暂停|开放|支持)/)?.[1] ?? "";
    const limit = text.match(/(?:单日累计购买上限|日累计申购限额)\s*([0-9.]+[万千百十]?元|---|不限|无限额)/)?.[1] ?? "";
    const buyConfirmDays = parseFundBuyConfirmDays(text);
    const confirmPatch = buyConfirmDays !== undefined ? { buyConfirmDays } : {};

    if (/不支持|暂停/.test(dca)) {
      const parts = [
        purchase ? `申购状态：${purchase}` : "",
        `定投状态：${dca}`,
      ].filter(Boolean);
      return { status: "buy_disabled", note: parts.join("，") || "基金当前不可定投", ...confirmPatch };
    }

    if (/暂停|不支持/.test(purchase)) {
      const parts = [
        purchase ? `申购状态：${purchase}` : "",
        dca ? `定投状态：${dca}` : "",
      ].filter(Boolean);
      return { status: "buy_disabled", note: parts.join("，") || "基金当前不可买入", ...confirmPatch };
    }

    if (/限制|限大额/.test(purchase) || (limit && !/不限|无限额|---/.test(limit))) {
      return { status: "fund_limit", note: limit ? `基金限购，${limit}` : "基金限购", ...confirmPatch };
    }

    if (/开放|支持/.test(purchase) || /开放|支持/.test(dca)) {
      return { status: "normal", note: "东方财富基金交易状态显示可买", ...confirmPatch };
    }

    if (buyConfirmDays !== undefined) {
      return { status: "normal", note: "已获取基金买入确认规则，交易状态未识别", buyConfirmDays };
    }

    return null;
  } catch {
    clear();
    return null;
  }
}

const CURRENCY_BY_MARKET: Record<Market, string> = {
  US: "USD", HK: "HKD", A: "CNY", JP: "JPY", FUND: "CNY", CRYPTO: "USDT", BOND: "CNY", GOLD: "USD",
  INDEX: "CNY", FX: "USD", COMMODITY: "USD",
};

function yahooExchangeToMarket(exchange: string, quoteType: string, symbol: string): Market | null {
  const ex = exchange.toUpperCase();
  const qt = quoteType.toUpperCase();
  if (qt === "CRYPTOCURRENCY") return "CRYPTO";
  // Check exchange before quoteType: HK/JP/A-listed funds must not be routed to the
  // CN-OTC "FUND" path — they need Yahoo/Tencent pricing, not EastMoney.
  if (ex === "HKG"   || symbol.endsWith(".HK"))              return "HK";
  if (ex === "JPX"   || ex === "TYO" || symbol.endsWith(".T")) return "JP";
  if (ex === "SHH"   || ex === "SHZ"
      || symbol.endsWith(".SS") || symbol.endsWith(".SZ"))   return "A";
  if (qt === "MUTUALFUND") return "FUND";   // only CN OTC public funds reach here
  if (["NMS","NGM","NYQ","PCX","ASE","BATS","NCM","OTC","PNK"].includes(ex)) return "US";
  return null;
}

function stripSuffix(symbol: string) {
  return symbol.replace(/\.(SS|SZ|HK)$/i, "");
}

function toYahooTicker(symbol: string, market: Market): string {
  const raw = symbol.replace(/\.(SS|SZ)$/i, "");
  if (market === "A") {
    if (/\.(SS|SZ)$/i.test(symbol)) return symbol;
    const isShanghai = /^(5|6|9)/.test(raw) || /^(11|13)/.test(raw);
    return isShanghai ? `${raw}.SS` : `${raw}.SZ`;
  }
  if (market === "HK") {
    return `${symbol.replace(/\.HK$/i, "").replace(/^0+/, "").padStart(4, "0")}.HK`;
  }
  if (market === "JP") {
    return `${symbol.replace(/\.T$/i, "")}.T`;
  }
  return symbol;
}

function isEtfLinkedFund(code: string, name: string, shortName?: string, categoryDesc?: string): boolean {
  const text = `${name} ${shortName ?? ""} ${categoryDesc ?? ""}`.toUpperCase();
  return !looksLikeExchangeFundCode(code) && /ETF\s*联接|联接.*ETF/.test(text);
}

function isExchangeEtfCandidate(code: string, name: string, shortName?: string, categoryDesc?: string): boolean {
  if (isEtfLinkedFund(code, name, shortName, categoryDesc)) return false;
  if (!looksLikeExchangeFundCode(code)) return false;
  const text = `${name} ${shortName ?? ""} ${categoryDesc ?? ""}`.toUpperCase();
  return /ETF|REIT/.test(text);
}

function looksLikeExchangeFundCode(code: string): boolean {
  return /^(50|51|52|56|58|588|159|16|18)/.test(code);
}

function isExchangeTradedFundCandidate(params: {
  code: string;
  name: string;
  shortName?: string;
  categoryDesc?: string;
  stockMarket?: string;
  newTexch?: string;
}): boolean {
  const {
    code,
    name,
    shortName = "",
    categoryDesc = "",
    stockMarket = "",
    newTexch = "",
  } = params;

  const text = `${name} ${shortName} ${categoryDesc}`.toUpperCase();

  if (isEtfLinkedFund(code, name, shortName, categoryDesc)) return false;
  if (/ETF|REIT|LOF/.test(text)) return true;
  if (/封闭|场内|上市/.test(`${name} ${shortName} ${categoryDesc}`)) return true;
  if (looksLikeExchangeFundCode(code) && (stockMarket === "1" || stockMarket === "2")) return true;
  if (looksLikeExchangeFundCode(code) && (newTexch === "1" || newTexch === "2")) return true;
  if (looksLikeExchangeFundCode(code) && /指数|基金|ETF|LOF|REIT/.test(`${name}${shortName}${categoryDesc}`)) {
    return true;
  }

  return false;
}

/* ═══════════════════════════════════════════════════════
   Yahoo Finance — search
══════════════════════════════════════════════════════════ */
async function yahooSearch(query: string): Promise<LiveResult[]> {
  const [signal, clear] = mkAbort(5000);
  try {
    const path =
      `/v1/finance/search` +
      `?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true&_=${Date.now()}`;
    const url = yahooUrl(path);
    const res = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return [];

    const data = await res.json();
    const quotes: any[] = data.quotes ?? [];

    const out: LiveResult[] = [];
    for (const q of quotes) {
      if (!q.symbol) continue;
      const skip = ["OPTION", "CURRENCY", "INDEX", "FUTURE"];
      if (skip.includes((q.quoteType ?? "").toUpperCase())) continue;

      const market = yahooExchangeToMarket(q.exchange ?? "", q.quoteType ?? "", q.symbol);
      if (!market) continue;

      const qt = (q.quoteType ?? "").toUpperCase();
      const rawName: string = q.shortname || q.longname || q.symbol;
      let assetType: AssetType = "stock";
      if (market === "HK") {
        // HK-listed securities may come back as MUTUALFUND from Yahoo. Treat
        // normal HK equities like 01810 as stocks; only ETF-like names become ETF.
        assetType = qt === "ETF" || /ETF|FUND|TRACKER|ISHARES|CSOP|HANG SENG/i.test(rawName) ? "etf" : "stock";
      } else if (qt === "ETF")               assetType = "etf";
      else if (qt === "MUTUALFUND")   assetType = "fund";
      else if (qt === "CRYPTOCURRENCY") assetType = "crypto";

      const symbol = stripSuffix(q.symbol);

      // Yahoo search results frequently include the live market price — use it
      // directly so we avoid a second network round-trip (which can hit CORS/429).
      const searchPrice: number =
        typeof q.regularMarketPrice === "number" && q.regularMarketPrice > 0
          ? q.regularMarketPrice
          : 0;

      out.push({
        symbol,
        name:      rawName,
        enName:    market !== "A" ? (q.longname || q.shortname || undefined) : undefined,
        market,
        assetType,
        currency:  CURRENCY_BY_MARKET[market],
        price:     searchPrice,
        priceReady: searchPrice > 0,
        exchange:  q.exchDisp || q.exchange || undefined,
        source:    "live",
      });
    }
    return out;
  } catch {
    clear();
  }
  return [];
}

async function fetchYahooSearchPrice(symbol: string, market: Market) {
  try {
    const results = await yahooSearch(symbol);
    const exact = results.find((item) => item.market === market && item.symbol.toUpperCase() === symbol.toUpperCase());
    if (!exact || !(exact.price > 0)) return null;
    return {
      price: exact.price,
      change: 0,
      changePercent: 0,
      prevClose: exact.price,
      high: exact.price,
      low: exact.price,
      volume: 0,
      currency: exact.currency,
    };
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════
   CoinGecko — search
══════════════════════════════════════════════════════════ */
async function coinGeckoSearch(query: string): Promise<LiveResult[]> {
  const [signal, clear] = mkAbort(5000);
  try {
    const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`;
    const res  = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return [];

    const data  = await res.json();
    const coins: any[] = (data.coins ?? []).slice(0, 6);

    return coins.map((c) => ({
      symbol:     (c.symbol as string).toUpperCase(),
      name:       c.name as string,
      market:     "CRYPTO" as Market,
      assetType:  "crypto" as AssetType,
      currency:   "USDT",
      price:      0,
      priceReady: false,
      coinId:     c.id as string,
      exchange:   "Crypto",
      source:     "live" as const,
    }));
  } catch {
    clear();
    return [];
  }
}

/* ═══════════════════════════════════════════════════════
   东方财富天天基金 — fund search & quote (China public funds)
══════════════════════════════════════════════════════════ */
async function eastMoneyFundSearch(query: string): Promise<LiveResult[]> {
  // Endpoint used to return JSONP-like text: var r={...};
  // It now often returns raw JSON directly, so we need to accept both.
  const [signal, clear] = mkAbort(5000);
  try {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(query)}&_=${Date.now()}`;
    const res = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return [];

    const text = await res.text();
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      const m = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (!m) return [];
      obj = JSON.parse(m[1]!);
    }
    const items: any[] = obj?.Datas ?? [];

    return items.slice(0, 6).map((it: any) => {
      const categoryDesc = String(it.CATEGORYDESC ?? "");
      const stockMarket = String(it.STOCKMARKET ?? "");
      const shortName = String(it.FundBaseInfo?.SHORTNAME ?? it.NAME ?? "");
      const newTexch = String(it.FundBaseInfo?.NEWTEXCH ?? it.NEWTEXCH ?? "");
      const isFund = categoryDesc.includes("基金") || Boolean(it.FundBaseInfo) || Number(it.CATEGORY) >= 700;
      const isAStock = stockMarket === "1" || stockMarket === "2" || categoryDesc.includes("沪市") || categoryDesc.includes("深市");
      const isExchangeEtf = isFund && isExchangeEtfCandidate(String(it.CODE), String(it.NAME), shortName, categoryDesc);
      const isExchangeFund = isFund && isExchangeTradedFundCandidate({
        code: String(it.CODE),
        name: String(it.NAME),
        shortName,
        categoryDesc,
        stockMarket,
        newTexch,
      });
      if (!isFund && !isExchangeFund) return null;
      const officialNav = parseFloat(String(it.FundBaseInfo?.DWJZ ?? ""));

      const market: Market = isExchangeFund ? "A" : isFund ? "FUND" : isAStock ? "A" : "FUND";
      const assetType: AssetType = isExchangeEtf ? "etf" : isFund ? "fund" : "stock";
      const exchangeLabel =
        isExchangeEtf ? "场内ETF" :
        isExchangeFund ? "场内基金" :
        categoryDesc || (isFund ? "基金" : "A股");

      return {
        symbol:     String(it.CODE),
        name:       String(it.NAME),
        market,
        assetType,
        currency:   "CNY",
        price:      isFund && !isExchangeFund && officialNav > 0 ? officialNav : 0,
        priceReady: Boolean(isFund && !isExchangeFund && officialNav > 0),
        exchange:   exchangeLabel,
        source:     "live" as const,
      };
    }).filter((item): item is NonNullable<typeof item> => item != null) as LiveResult[];
  } catch {
    clear();
    return [];
  }
}

function dedupeResults(results: LiveResult[]) {
  const merged = new Map<string, LiveResult>();
  for (const item of results) {
    const key = `${item.market}:${item.symbol}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, mergeResult(prev, item));
  }
  return [...merged.values()];
}

function mergeSearchResults(...groups: LiveResult[][]) {
  return dedupeResults(groups.flat());
}

function searchResultScore(query: string, item: LiveResult) {
  const qRaw = query.trim();
  const q = qRaw.toUpperCase();
  const symbol = item.symbol.toUpperCase();
  const enName = item.enName?.toUpperCase() ?? "";
  let score = 0;

  if (symbol === q) score += 1000;
  else if (symbol.startsWith(q)) score += 720;
  else if (symbol.includes(q)) score += 360;

  if (item.name === qRaw) score += 980;
  else if (item.name.startsWith(qRaw)) {
    score += 700;
    score += Math.max(0, 120 - Math.max(0, item.name.length - qRaw.length) * 12);
  } else if (item.name.includes(qRaw)) {
    score += 260;
  }

  if (enName === q) score += 920;
  else if (enName.startsWith(q)) score += 520;
  else if (enName.includes(q)) score += 220;

  if (item.assetType === "stock") score += 40;
  else if (item.assetType === "etf") score += 36;
  else if (item.assetType === "fund") score += 30;
  else if (item.assetType === "crypto") score += 20;

  if (item.price > 0) score += 28;
  if (item.source === "live") score += 12;

  if (/-R$/i.test(item.name)) score -= 18;
  if (/-SW$/i.test(item.name)) score -= 6;
  if (/牛熊|窝轮|渦輪|涡轮|权证|認購|認沽|认购证|认沽证|CALL WARRANT|PUT WARRANT|WARRANT|CBBC/i.test(`${item.name} ${item.exchange ?? ""}`)) {
    score -= 1000;
  }

  return score;
}

function sortSearchResults(query: string, results: LiveResult[]) {
  return [...results].sort((a, b) => {
    const diff = searchResultScore(query, b) - searchResultScore(query, a);
    if (diff !== 0) return diff;
    if (a.price > 0 !== (b.price > 0)) return a.price > 0 ? -1 : 1;
    return a.name.length - b.name.length;
  });
}

function isExactSearchMatch(query: string, item: LiveResult) {
  const qRaw = query.trim();
  const q = qRaw.toUpperCase();
  return item.symbol.toUpperCase() === q || item.name === qRaw || (item.enName?.toUpperCase() ?? "") === q;
}

function resultScore(item: LiveResult) {
  let score = 0;
  if (item.source === "live") score += 8;
  if (item.price > 0) score += 16;
  if (item.priceReady) score += 8;
  if (item.coinId) score += 2;
  if (item.exchange) score += 1;
  if (item.enName) score += 1;
  return score;
}

function mergeResult(current: LiveResult, incoming: LiveResult): LiveResult {
  const preferred = resultScore(incoming) > resultScore(current) ? incoming : current;
  const fallback = preferred === current ? incoming : current;
  const mergedPrice = preferred.price > 0 ? preferred.price : fallback.price;

  return {
    ...fallback,
    ...preferred,
    name: preferred.name || fallback.name,
    enName: preferred.enName || fallback.enName,
    assetType: preferred.assetType || fallback.assetType,
    currency: preferred.currency || fallback.currency,
    exchange: preferred.exchange || fallback.exchange,
    coinId: preferred.coinId || fallback.coinId,
    price: mergedPrice,
    priceReady: mergedPrice > 0 || preferred.priceReady || fallback.priceReady,
    source: preferred.source === "live" || fallback.source === "live" ? "live" : "local",
  };
}

async function fetchYahooLivePrice(symbol: string, market: Market) {
  const ticker = toYahooTicker(symbol, market);
  const [signal, clear] = mkAbort(6000);
  try {
    const path =
      `/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=1d&range=1d&includePrePost=${market === "US" ? "true" : "false"}&_=${Date.now()}`;
    const res = await fetch(yahooUrl(path), { signal, cache: "no-store" });
    clear();
    if (!res.ok) return null;

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const resolved = resolveYahooUsPrice(meta, market);
    const price = resolved.price;
    if (!(price > 0)) return null;

    return {
      price,
      change: resolved.change,
      changePercent: resolved.changePercent,
      prevClose: resolved.prevClose,
      high: resolved.high,
      low: resolved.low,
      volume: resolved.volume,
      currency: String(meta?.currency || CURRENCY_BY_MARKET[market] || "USD"),
    };
  } catch {
    clear();
    return null;
  }
}

export async function fetchCnFundOfficialNav(code: string): Promise<number | null> {
  const history = await fetchCnFundOfficialHistory(code, 1);
  if (history[0]?.nav && history[0].nav > 0) return history[0].nav;
  const estimate = await fetchCnFundEstimate(code);
  if (estimate?.officialNav && estimate.officialNav > 0) return estimate.officialNav;
  return history[0]?.nav && history[0].nav > 0 ? history[0].nav : null;
}

export async function fetchCnFundOfficialHistory(code: string, pageSize = 60) {
  const timeoutMs = pageSize >= 1000 ? 20000 : 10000;
  const [signal, clear] = mkAbort(timeoutMs);
  try {
    const url =
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}` +
      `&pageIndex=1&pageSize=${pageSize}&startDate=&endDate=&_=${Date.now()}`;
    const res = await fetch(url, {
      signal,
      cache: "no-store",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://fundf10.eastmoney.com/",
      },
    });
    clear();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const rows: any[] = json?.Data?.LSJZList ?? [];
    const parsed = rows
      .map((row) => ({
        date: String(row?.FSRQ ?? ""),
        nav: parseFloat(String(row?.DWJZ ?? "")),
        changePercent: parseFloat(String(row?.JZZZL ?? "")),
      }))
      .filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0);
    const sorted = parsed.sort((a, b) => b.date.localeCompare(a.date));
    if (sorted.length) return sorted;
  } catch {
    clear();
  }

  const [fallbackSignal, fallbackClear] = mkAbort(7000);
  try {
    const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js?v=${Date.now()}`;
    const res = await fetch(url, {
      signal: fallbackSignal,
      cache: "no-store",
    });
    fallbackClear();
    if (!res.ok) return [];

    const text = await res.text();
    const match = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return [];
    const rows = JSON.parse(match[1]!) as Array<{ x?: number; y?: number; equityReturn?: number }>;
    return rows
      .map((row) => {
        const timestamp = Number(row?.x ?? 0);
        const nav = Number(row?.y ?? 0);
        const changePercent = Number(row?.equityReturn ?? 0);
        return { date: formatChinaFundDate(timestamp), nav, changePercent };
      })
      .filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, pageSize);
  } catch {
    fallbackClear();
    return [];
  }
}

export async function fetchCryptoPrice(symbol: string, coinId?: string) {
  const id = coinId?.trim().toLowerCase();
  if (!id) {
    const binance = await fetchBinanceCryptoQuote(symbol);
    if (binance) {
      return {
        price: binance.price,
        change: binance.change,
        changePercent: binance.changePercent,
        prevClose: binance.prevClose,
        high: binance.high,
        low: binance.low,
        volume: binance.volume,
        currency: binance.currency,
      };
    }

    const okx = await fetchOkxCryptoQuote(symbol);
    if (okx) {
      return {
        price: okx.price,
        change: okx.change,
        changePercent: okx.changePercent,
        prevClose: okx.prevClose,
        high: okx.high,
        low: okx.low,
        volume: okx.volume,
        currency: okx.currency,
      };
    }
    return null;
  }

  const [signal, clear] = mkAbort(6000);
  try {
    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}` +
      `&vs_currencies=usd&include_24hr_change=true&_=${Date.now()}`;
    const res = await fetch(url, { signal, cache: "no-store" });
    clear();
    if (!res.ok) return null;

    const json = await res.json();
    const price = Number(json?.[id]?.usd);
    if (!(price > 0)) return null;

    const rawChange = Number(json?.[id]?.usd_24h_change);
    const changePercent = Number.isFinite(rawChange) ? rawChange / 100 : 0;
    const prevClose = changePercent === -1 ? price : price / (1 + changePercent);
    const change = price - prevClose;

    return {
      price,
      change,
      changePercent,
      prevClose,
      high: price,
      low: price,
      volume: 0,
      currency: "USDT",
    };
  } catch {
    clear();
    const binance = await fetchBinanceCryptoQuote(symbol);
    if (binance) {
      return {
        price: binance.price,
        change: binance.change,
        changePercent: binance.changePercent,
        prevClose: binance.prevClose,
        high: binance.high,
        low: binance.low,
        volume: binance.volume,
        currency: binance.currency,
      };
    }

    const okx = await fetchOkxCryptoQuote(symbol);
    if (okx) {
      return {
        price: okx.price,
        change: okx.change,
        changePercent: okx.changePercent,
        prevClose: okx.prevClose,
        high: okx.high,
        low: okx.low,
        volume: okx.volume,
        currency: okx.currency,
      };
    }

    return null;
  }
}

export async function fetchLivePrice(symbol: string, market: Market, coinId?: string) {
  if (market === "CRYPTO") {
    const crypto = await fetchCryptoPrice(symbol, coinId);
    if (crypto) return crypto;
    return fetchYahooLivePrice(symbol, market);
  }

  if (market === "A" || market === "HK") {
    const eastMoney = await fetchEastMoneyQuoteBySymbol(symbol, market);
    if (eastMoney) {
      return {
        price: eastMoney.price,
        change: eastMoney.change,
        changePercent: eastMoney.changePercent,
        prevClose: eastMoney.prevClose,
        high: eastMoney.high,
        low: eastMoney.low,
        volume: eastMoney.volume,
        currency: eastMoney.currency,
      };
    }

    const tencent = await fetchTencentQuote(symbol, market);
    if (tencent) return tencent;

    return fetchYahooLivePrice(symbol, market);
  }

  if (market === "FUND") {
    try {
      const estimate = await fetchCnFundEstimate(symbol);
      const history = await fetchCnFundOfficialHistory(symbol, 2);
      const sortedHistory = [...history].sort((a, b) => b.date.localeCompare(a.date));
      const latestHistory = sortedHistory[0];
      const prevHistory = sortedHistory[1];
      const historyNav = latestHistory?.nav ?? 0;
      const officialNav = estimate?.officialNav ?? 0;
      const price = historyNav > 0
        ? historyNav
        : (officialNav > 0 ? officialNav : 0);
      if (price > 0) {
        const prevClose = prevHistory?.nav && prevHistory.nav > 0
          ? prevHistory.nav
          : price;
        const change = price - prevClose;
        const historyPct = Number(latestHistory?.changePercent);
        const changePercent = Number.isFinite(historyPct) && historyPct !== 0
          ? historyPct / 100
          : (prevClose > 0 ? change / prevClose : 0);
        return {
          price,
          change,
          changePercent,
          prevClose,
          high: Math.max(price, prevClose),
          low: Math.min(price, prevClose),
          volume: 0,
          currency: "CNY",
        };
      }
    } catch {
      // fall through to single-value fallback below
    }

    const nav = await fetchCnFundOfficialNav(symbol);
    if (nav && nav > 0) {
      return {
        price: nav,
        change: 0,
        changePercent: 0,
        prevClose: nav,
        high: nav,
        low: nav,
        volume: 0,
        currency: "CNY",
      };
    }

    return fetchYahooLivePrice(symbol, market);
  }

  const yahoo = await fetchYahooLivePrice(symbol, market);
  if (yahoo) return yahoo;

  return fetchYahooSearchPrice(symbol, market);
}

function filterSearchResults(query: string, results: LiveResult[]) {
  const pricedCount = results.filter((item) => item.price > 0).length;
  return results.filter((item) => {
    if (item.price > 0) return true;
    if (isExactSearchMatch(query, item)) return true;
    if (pricedCount === 0) return true;
    if (item.market === "FUND" && item.assetType === "fund") return true;
    return false;
  });
}

async function enrichSearchResults(query: string, results: LiveResult[]) {
  const enriched = results.map((item) => ({ ...item }));
  const pendingAOrH = enriched.filter((item) => item.price <= 0 && (item.market === "A" || item.market === "HK"));

  if (pendingAOrH.length) {
    const quotes = await fetchEastMoneyQuotesBySymbols(
      pendingAOrH.map((item) => ({ symbol: item.symbol, market: item.market }))
    ).catch(() => []);
    const quoteMap = new Map(quotes.map((quote) => [`${quote.market}:${quote.symbol}`, quote]));

    enriched.forEach((item) => {
      if (!(item.price <= 0 && (item.market === "A" || item.market === "HK"))) return;
      const quote = quoteMap.get(`${item.market}:${item.symbol}`);
      if (!quote?.price || quote.price <= 0) return;
      item.price = quote.price;
      item.priceReady = true;
      item.currency = quote.currency || item.currency;
      item.exchange = item.exchange || quote.exchange;
      item.source = "live";
    });
  }

  const stillPending = enriched.filter((item) => item.price <= 0);
  await Promise.all(stillPending.map(async (item) => {
    const quote = await fetchLivePrice(item.symbol, item.market, item.coinId);
    if (!quote?.price || quote.price <= 0) return;
    item.price = quote.price;
    item.priceReady = true;
    item.currency = quote.currency || item.currency;
    item.source = "live";
  }));

  return filterSearchResults(query, enriched);
}

export async function searchSecuritiesLive(query: string): Promise<LiveResult[]> {
  const q = query.trim();
  if (!q) return [];

  const cacheKey = q.toUpperCase();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const [eastMoneyResults, yahooResults, cryptoResults, fundResults] = await Promise.allSettled([
    searchEastMoneySecurities(q),
    yahooSearch(q),
    coinGeckoSearch(q),
    eastMoneyFundSearch(q),
  ]);

  const merged = sortSearchResults(q, mergeSearchResults(
    eastMoneyResults.status === "fulfilled" ? eastMoneyResults.value.map((item) => ({ ...item, source: "live" as const })) : [],
    yahooResults.status === "fulfilled" ? yahooResults.value : [],
    cryptoResults.status === "fulfilled" ? cryptoResults.value : [],
    fundResults.status === "fulfilled" ? fundResults.value : [],
  )).slice(0, 12);

  const hydrated = sortSearchResults(q, await enrichSearchResults(q, merged));

  setCache(cacheKey, hydrated);
  return hydrated;
}
