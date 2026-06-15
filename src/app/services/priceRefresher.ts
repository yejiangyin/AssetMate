/**
 * Batch live-price refresher for portfolio holdings.
 */

import { fetchCnFundEstimate, fetchCnFundOfficialHistory, fetchCnFundOfficialNav, fetchCnFundTradeStatus } from "./securitiesApi";
import { fetchEastMoneyQuoteBySymbol, fetchEastMoneyQuotesBySymbols, fetchEastMoneyTradeStatusesBySymbols } from "./eastMoneyApi";
import { fetchNasdaqQuote } from "./nasdaqApi";
import { fetchTencentQuote, fetchTencentQuoteFromYahooSymbol, fetchTencentTradeStatus } from "./tencentQuote";
import { fetchBinanceCryptoQuote, fetchOkxCryptoQuote } from "./publicMarketApi";
import { toYahooSymbol } from "./quoteApi";
import type { TradeStatusValue } from "../utils/tradeStatus";

export interface LivePrice {
  price:         number;
  change:        number;
  changePercent: number;
  prevClose:     number;
  high:          number;
  low:           number;
  volume:        number;
  fetchedAt:     number;
  source:        "yahoo" | "coingecko" | "eastmoney" | "tencent" | "nasdaq" | "binance" | "okx";
  priceDate?:     string;
  fundNavHistory?:        Array<{ date: string; nav: number }>;
  estimatedNav?:           number;
  estimatedChangePercent?: number;
}

export interface HoldingLiveUpdate {
  price?: LivePrice | null;
  autoTradeStatus?: TradeStatusValue | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: LivePrice["source"] | null;
  fundBuyConfirmDays?: number;
}

export type PriceMap = Record<string, HoldingLiveUpdate>;

const FX_STORAGE_KEY = "asset-helper:fx-rates";
const FX_CACHE_TTL = 24 * 60 * 60 * 1000;
const FX_DEFAULTS = {
  USD: 6.78,
  HKD: 0.87,
  JPY: 0.043,
  USDT: 6.78,
  USDC: 6.78,
  CNY: 1,
  EUR: 7.89,
  GBP: 9.15,
};

type FxCode = keyof typeof FX_DEFAULTS;

type FxRateMap = Record<FxCode, number>;

function isPositiveRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readStoredFxRates(): Partial<FxRateMap> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FX_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<FxCode | "_ts", unknown>>;
    const ts = Number(parsed._ts);
    if (Number.isFinite(ts) && Date.now() - ts > FX_CACHE_TTL) {
      window.localStorage.removeItem(FX_STORAGE_KEY);
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => key !== "_ts" && isPositiveRate(value))
    ) as Partial<FxRateMap>;
  } catch {
    return {};
  }
}

function persistFxRates() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FX_STORAGE_KEY, JSON.stringify({ ...FX, _ts: Date.now() }));
  } catch {
    // ignore storage failures
  }
}

export const FX: FxRateMap = {
  ...FX_DEFAULTS,
  ...readStoredFxRates(),
};

function syncFxRatesFromStorage() {
  applyFxRates(readStoredFxRates());
}

const FX_STORAGE_LISTENER_FLAG = "__assetHelperFxStorageListener";

if (typeof window !== "undefined" && !(window as unknown as Record<string, unknown>)[FX_STORAGE_LISTENER_FLAG]) {
  (window as unknown as Record<string, unknown>)[FX_STORAGE_LISTENER_FLAG] = true;
  window.addEventListener("storage", (event) => {
    if (event.key === FX_STORAGE_KEY) syncFxRatesFromStorage();
  });
}

function resolveYahooUsPrice(meta: any, isUs = false) {
  const positive = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const prevClose = positive(meta?.previousClose ?? meta?.chartPreviousClose);
  const regularPrice = positive(meta?.regularMarketPrice);
  const regularHigh = positive(meta?.regularMarketDayHigh);
  const regularLow = positive(meta?.regularMarketDayLow);
  const regularVolume = positive(meta?.regularMarketVolume);
  if (!isUs) {
    const price = regularPrice;
    const basePrevClose = prevClose || price;
    const rawChange = Number(meta?.regularMarketChange ?? (price - basePrevClose));
    const rawChangePct = Number(meta?.regularMarketChangePercent ?? (basePrevClose > 0 ? rawChange / basePrevClose : 0));
    return {
      price,
      prevClose: basePrevClose,
      change: rawChange,
      changePercent: Math.abs(rawChangePct) > 1 ? rawChangePct / 100 : rawChangePct,
      high: regularHigh || price,
      low: regularLow || price,
      volume: regularVolume,
    };
  }

  const marketState = String(meta?.marketState ?? "").toUpperCase();
  const prePrice = positive(meta?.preMarketPrice);
  const postPrice = positive(meta?.postMarketPrice);
  const price = postPrice && (marketState.includes("POST") || marketState === "CLOSED")
    ? postPrice
    : prePrice && marketState.includes("PRE")
      ? prePrice
      : regularPrice;
  const basePrevClose = prevClose || price;
  const change = price - basePrevClose;
  return {
    price,
    prevClose: basePrevClose,
    change,
    changePercent: basePrevClose > 0 ? change / basePrevClose : 0,
    high: Math.max(regularHigh || price, price),
    low: Math.min(regularLow || price, price),
    volume: positive(meta?.postMarketVolume ?? meta?.preMarketVolume ?? regularVolume),
  };
}


async function fetchOne(yahooSymbol: string): Promise<LivePrice | null> {
  const hosts = ["query1.finance.yahoo.com"];
  const isUs = !/(\.HK|\.SS|\.SZ|\.T|-USD|-USDT|=|\^)/i.test(yahooSymbol);
  for (const host of hosts) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 6000);
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d&includePrePost=${isUs ? "true" : "false"}&_=${Date.now()}`;
      const res  = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      if (!res.ok) continue;

      const json = await res.json();
      const meta  = json?.chart?.result?.[0]?.meta;
      if (!meta) continue;

      const resolved = resolveYahooUsPrice(meta, isUs);
      const price = resolved.price;
      if (!(price > 0)) continue;

      return {
        price,
        change: resolved.change,
        changePercent: resolved.changePercent,
        prevClose: resolved.prevClose,
        high: resolved.high,
        low: resolved.low,
        volume: resolved.volume,
        fetchedAt: Date.now(),
        source: "yahoo",
      };
    } catch {
      clearTimeout(tid);
    }
  }
  return null;
}

async function fetchStockLike(symbol: string, market: string): Promise<LivePrice | null> {
  if (market === "A" || market === "HK") {
    const quote = await fetchTencentQuote(symbol, market);
    if (quote) {
      return {
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        prevClose: quote.prevClose,
        high: quote.high,
        low: quote.low,
        volume: quote.volume,
        fetchedAt: Date.now(),
        source: "tencent",
      };
    }
  }

  const yahooSymbol = toYahooSymbol(symbol, market);
  const yahooQuote = await fetchOne(yahooSymbol);
  if (yahooQuote) return yahooQuote;

  if (market === "US" || market === "INDEX") {
    const nasdaqQuote = await fetchNasdaqQuote(symbol);
    if (nasdaqQuote?.price && nasdaqQuote.price > 0) {
      return {
        price: nasdaqQuote.price,
        change: nasdaqQuote.change,
        changePercent: nasdaqQuote.changePercent,
        prevClose: nasdaqQuote.prevClose,
        high: nasdaqQuote.high,
        low: nasdaqQuote.low,
        volume: nasdaqQuote.volume,
        fetchedAt: Date.now(),
        source: "nasdaq",
      };
    }
  }

  if (market === "FX" || market === "COMMODITY" || market === "JP") {
    const eastMoneyQuote = await fetchEastMoneyQuoteBySymbol(symbol, market);
    if (eastMoneyQuote?.price && eastMoneyQuote.price > 0) {
      return {
        price: eastMoneyQuote.price,
        change: eastMoneyQuote.change,
        changePercent: eastMoneyQuote.changePercent,
        prevClose: eastMoneyQuote.prevClose,
        high: eastMoneyQuote.high,
        low: eastMoneyQuote.low,
        volume: eastMoneyQuote.volume,
        fetchedAt: Date.now(),
        source: "eastmoney",
      };
    }
  }

  const tencentQuote = await fetchTencentQuoteFromYahooSymbol(yahooSymbol);
  if (!tencentQuote?.price || !(tencentQuote.price > 0)) return null;

  return {
    price: tencentQuote.price,
    change: tencentQuote.change,
    changePercent: tencentQuote.changePercent,
    prevClose: tencentQuote.prevClose,
    high: tencentQuote.high,
    low: tencentQuote.low,
    volume: tencentQuote.volume,
    fetchedAt: Date.now(),
    source: "tencent",
  };
}

function toLivePriceFromEastMoneyQuote(quote: Awaited<ReturnType<typeof fetchEastMoneyQuotesBySymbols>>[number]): LivePrice {
  return {
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
    prevClose: quote.prevClose,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    fetchedAt: Date.now(),
    source: "eastmoney",
  };
}

function normalTradeStatusFromSource(source: LivePrice["source"]): Pick<HoldingLiveUpdate, "autoTradeStatus" | "autoTradeStatusNote" | "autoTradeStatusSource"> {
  return {
    autoTradeStatus: "normal",
    autoTradeStatusNote: "自动行情源显示可正常交易",
    autoTradeStatusSource: source,
  };
}

async function eastMoneyFundLive(code: string): Promise<LivePrice | null> {
  try {
    const estimate = await fetchCnFundEstimate(code);
    const [officialNav, history] = await Promise.all([
      fetchCnFundOfficialNav(code),
      fetchCnFundOfficialHistory(code, 10),
    ]);
    const sortedHistory = [...history].sort((a, b) => b.date.localeCompare(a.date));
    const gsz = estimate?.estimatedNav ?? 0;
    const dwjz = estimate?.officialNav ?? 0;
    const gszPct = estimate?.estimatedChangePercent ?? Number.NaN;
    const latestHistory = sortedHistory[0];
    const prevHistory = sortedHistory[1];
    const historyNav = latestHistory?.nav ?? 0;
    const estimateOfficialNav = !isNaN(dwjz) && dwjz > 0 ? dwjz : 0;
    const estimateOfficialDate = estimate?.officialDate ?? "";
    const useEstimateOfficial =
      estimateOfficialNav > 0 &&
      estimateOfficialDate &&
      (!latestHistory?.date || estimateOfficialDate > latestHistory.date);
    const price = useEstimateOfficial
      ? estimateOfficialNav
      : (historyNav > 0
        ? historyNav
        : (officialNav ?? (estimateOfficialNav > 0 ? estimateOfficialNav : 0)));
    if (!(price > 0)) return null;
    const priceDate = useEstimateOfficial
      ? estimateOfficialDate
      : (latestHistory?.date ?? estimate?.officialDate);
    const prevClose = useEstimateOfficial && latestHistory?.nav && latestHistory.nav > 0
      ? latestHistory.nav
      : (prevHistory?.nav && prevHistory.nav > 0
        ? prevHistory.nav
        : price);
    const change = price - prevClose;
    const historyPct = Number(latestHistory?.changePercent);
    const pct = !useEstimateOfficial && Number.isFinite(historyPct) && historyPct !== 0
      ? historyPct / 100
      : (prevClose > 0 ? change / prevClose : 0);
    return {
      price, change, changePercent: pct, prevClose,
      high: price, low: price, volume: 0,
      fetchedAt: Date.now(), source: "eastmoney",
      priceDate,
      fundNavHistory: sortedHistory
        .filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0)
        .map((row) => ({ date: row.date, nav: row.nav })),
      estimatedNav: gsz > 0 ? gsz : undefined,
      estimatedChangePercent: gsz > 0 && !isNaN(gszPct) ? gszPct / 100 : undefined,
    };
  } catch {
    return null;
  }
}

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", BNB: "binancecoin", SOL: "solana",
  XRP: "ripple", DOGE: "dogecoin", ADA: "cardano", AVAX: "avalanche-2",
  LINK: "chainlink", DOT: "polkadot", MATIC: "matic-network", UNI: "uniswap",
};

async function fetchCrypto(symbol: string): Promise<LivePrice | null> {
  const coinId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!coinId) {
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
        fetchedAt: Date.now(),
        source: "binance",
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
        fetchedAt: Date.now(),
        source: "okx",
      };
    }
    return fetchStockLike(symbol, "CRYPTO");
  }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&_=${Date.now()}`;
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(tid);
    if (!res.ok) {
      const binance = await fetchBinanceCryptoQuote(symbol);
      if (binance) {
        return {
          price: binance.price, change: binance.change, changePercent: binance.changePercent,
          prevClose: binance.prevClose, high: binance.high, low: binance.low, volume: binance.volume,
          fetchedAt: Date.now(), source: "binance",
        };
      }
      const okx = await fetchOkxCryptoQuote(symbol);
      if (okx) {
        return {
          price: okx.price, change: okx.change, changePercent: okx.changePercent,
          prevClose: okx.prevClose, high: okx.high, low: okx.low, volume: okx.volume,
          fetchedAt: Date.now(), source: "okx",
        };
      }
      return fetchStockLike(symbol, "CRYPTO");
    }

    const json = await res.json();
    const price = json?.[coinId]?.usd;
    const changePercent = json?.[coinId]?.usd_24h_change;
    if (typeof price !== "number") {
      const binance = await fetchBinanceCryptoQuote(symbol);
      if (binance) {
        return {
          price: binance.price, change: binance.change, changePercent: binance.changePercent,
          prevClose: binance.prevClose, high: binance.high, low: binance.low, volume: binance.volume,
          fetchedAt: Date.now(), source: "binance",
        };
      }
      const okx = await fetchOkxCryptoQuote(symbol);
      if (okx) {
        return {
          price: okx.price, change: okx.change, changePercent: okx.changePercent,
          prevClose: okx.prevClose, high: okx.high, low: okx.low, volume: okx.volume,
          fetchedAt: Date.now(), source: "okx",
        };
      }
      return fetchStockLike(symbol, "CRYPTO");
    }

    const pct = typeof changePercent === "number" && Number.isFinite(changePercent) ? changePercent / 100 : 0;
    const denominator = 1 + pct;
    const estimatedPrevClose = Math.abs(denominator) < 1e-6 ? price : price / denominator;
    const prevClose = Number.isFinite(estimatedPrevClose) && estimatedPrevClose > 0 ? estimatedPrevClose : price;
    const change = price - prevClose;
    return {
      price, change, changePercent: pct, prevClose,
      high: price, low: price, volume: 0,
      fetchedAt: Date.now(), source: "coingecko",
    };
  } catch {
    clearTimeout(tid);
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
        fetchedAt: Date.now(),
        source: "binance",
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
        fetchedAt: Date.now(),
        source: "okx",
      };
    }
    return fetchStockLike(symbol, "CRYPTO");
  }
}

async function fetchFxRate(yahooSymbol: string): Promise<number | null> {
  const quote = await fetchOne(yahooSymbol);
  return quote?.price && quote.price > 0 ? quote.price : null;
}

async function fetchFxRatesFromOpenErApi(): Promise<Partial<FxRateMap>> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/CNY", {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    if (!res.ok) return {};

    const json = await res.json();
    const rates = json?.rates ?? {};
    const toCny = (code: FxCode) => {
      const rate = Number(rates?.[code]);
      return rate > 0 ? 1 / rate : null;
    };

    const usd = toCny("USD");
    const hkd = toCny("HKD");
    const jpy = toCny("JPY");
    const eur = toCny("EUR");
    const gbp = toCny("GBP");

    return {
      ...(usd ? { USD: usd, USDT: usd, USDC: usd } : {}),
      ...(hkd ? { HKD: hkd } : {}),
      ...(jpy ? { JPY: jpy } : {}),
      ...(eur ? { EUR: eur } : {}),
      ...(gbp ? { GBP: gbp } : {}),
      CNY: 1,
    };
  } catch {
    clearTimeout(tid);
    return {};
  }
}

function applyFxRates(nextRates: Partial<FxRateMap>) {
  let changed = false;
  (Object.keys(FX) as FxCode[]).forEach((code) => {
    const next = nextRates[code];
    if (isPositiveRate(next) && FX[code] !== next) {
      FX[code] = next;
      changed = true;
    }
  });
  FX.USDT = FX.USD;
  FX.USDC = FX.USD;
  FX.CNY = 1;
  if (changed) persistFxRates();
}

export async function refreshFxRates(): Promise<void> {
  const updates = await Promise.allSettled([
    fetchFxRate("CNY=X"),
    fetchFxRate("HKDCNY=X"),
    fetchFxRate("JPYCNY=X"),
    fetchFxRate("EURCNY=X"),
    fetchFxRate("GBPCNY=X"),
  ]);

  const [usd, hkd, jpy, eur, gbp] = updates.map((r) => r.status === "fulfilled" ? r.value : null);
  const nextRates: Partial<FxRateMap> = {
    ...(usd && usd > 0 ? { USD: usd, USDT: usd, USDC: usd } : {}),
    ...(hkd && hkd > 0 ? { HKD: hkd } : {}),
    ...(jpy && jpy > 0 ? { JPY: jpy } : {}),
    ...(eur && eur > 0 ? { EUR: eur } : {}),
    ...(gbp && gbp > 0 ? { GBP: gbp } : {}),
    CNY: 1,
  };

  const missingCodes = (["USD", "HKD", "JPY", "EUR", "GBP"] as FxCode[])
    .filter((code) => !isPositiveRate(nextRates[code]));

  if (missingCodes.length) {
    const fallbackRates = await fetchFxRatesFromOpenErApi();
    missingCodes.forEach((code) => {
      const fallback = fallbackRates[code];
      if (isPositiveRate(fallback)) nextRates[code] = fallback;
    });
    if (isPositiveRate(fallbackRates.USD)) {
      nextRates.USDT = fallbackRates.USD;
      nextRates.USDC = fallbackRates.USD;
    }
  }

  applyFxRates(nextRates);
}


export interface HoldingRef {
  id:     string;
  symbol: string;
  market: string;
}

interface RefreshTarget {
  key: string;
  symbol: string;
  market: string;
  ids: string[];
}

export function groupRefreshTargets(holdings: HoldingRef[]): RefreshTarget[] {
  const grouped = new Map<string, RefreshTarget>();
  for (const holding of holdings) {
    const symbol = holding.symbol.trim();
    const market = holding.market.trim();
    if (!holding.id || !symbol || !market) continue;
    const key = `${market}:${symbol.toUpperCase()}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.ids.push(holding.id);
    } else {
      grouped.set(key, { key, symbol, market, ids: [holding.id] });
    }
  }
  return Array.from(grouped.values());
}

function refreshTargetKey(targets: RefreshTarget[]) {
  return targets
    .map((target) => `${target.key}:${target.ids.slice().sort().join(",")}`)
    .sort()
    .join("|");
}

let refreshPricesInFlight: { key: string; promise: Promise<PriceMap>; controller: AbortController } | null = null;

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const item = items[index];
        if (item === undefined) continue;
        results[index] = { status: "fulfilled", value: await mapper(item, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));

  return results;
}

async function refreshPricesForTargets(targets: RefreshTarget[], signal: AbortSignal): Promise<PriceMap> {
  if (signal.aborted) return {};
  await refreshFxRates();
  if (signal.aborted) return {};
  const eastMoneyTargets = targets.filter((h) => h.market === "A" || h.market === "HK");
  const eastMoneyQuotes = eastMoneyTargets.length
    ? await fetchEastMoneyQuotesBySymbols(eastMoneyTargets.map((h) => ({ symbol: h.symbol, market: h.market }))).catch(() => [])
    : [];
  const eastMoneyStatuses = eastMoneyTargets.length
    ? await fetchEastMoneyTradeStatusesBySymbols(eastMoneyTargets.map((h) => ({ symbol: h.symbol, market: h.market }))).catch(() => [])
    : [];
  const eastMoneyMap = new Map(
    eastMoneyQuotes.map((quote) => [`${quote.market}:${quote.symbol}`, toLivePriceFromEastMoneyQuote(quote)])
  );
  const eastMoneyStatusMap = new Map(
    eastMoneyStatuses.map((status) => [`${status.market}:${status.symbol}`, status])
  );

  const results = await mapWithConcurrency(
    targets,
    6,
    async (h) => {
      if (signal.aborted) throw new Error("refresh aborted");
      let price: LivePrice | null = null;
      let update: HoldingLiveUpdate = {};
      if (h.market === "A" || h.market === "HK") {
        price = eastMoneyMap.get(`${h.market}:${h.symbol}`) ?? null;
        if (!price) price = await fetchStockLike(h.symbol, h.market);
        const status = eastMoneyStatusMap.get(`${h.market}:${h.symbol}`) ?? await fetchTencentTradeStatus(h.symbol, h.market);
        if (status) {
          update = {
            autoTradeStatus: status.status,
            autoTradeStatusNote: status.note,
            autoTradeStatusSource: status.source,
          };
        } else if (price) {
          update = normalTradeStatusFromSource(price.source);
        }
      } else if (h.market === "CRYPTO") {
        price = await fetchCrypto(h.symbol);
        if (price) update = normalTradeStatusFromSource(price.source);
      } else if (h.market === "FUND") {
        const [fundPrice, fundStatus] = await Promise.all([
          eastMoneyFundLive(h.symbol),
          fetchCnFundTradeStatus(h.symbol).catch(() => null),
        ]);
        price = fundPrice;
        if (!price) price = await fetchStockLike(h.symbol, h.market);
        if (fundStatus) {
          update = {
            autoTradeStatus: fundStatus.status,
            autoTradeStatusNote: fundStatus.note,
            autoTradeStatusSource: "eastmoney",
            fundBuyConfirmDays: fundStatus.buyConfirmDays,
          };
        } else if (price) {
          update = normalTradeStatusFromSource(price.source);
        }
      } else {
        price = await fetchStockLike(h.symbol, h.market);
        if (price) update = normalTradeStatusFromSource(price.source);
      }
      if (signal.aborted) throw new Error("refresh aborted");
      return { ids: h.ids, update: { ...update, ...(price ? { price } : {}) } };
    },
  );

  const map: PriceMap = {};
  for (const r of results) {
    if (r.status === "fulfilled" && (r.value.update.price || r.value.update.autoTradeStatus != null)) {
      for (const id of r.value.ids) {
        map[id] = r.value.update;
      }
    }
  }
  return map;
}

export function refreshPrices(holdings: HoldingRef[]): Promise<PriceMap> {
  const targets = groupRefreshTargets(holdings);
  const key = refreshTargetKey(targets);
  if (refreshPricesInFlight?.key === key) return refreshPricesInFlight.promise;
  refreshPricesInFlight?.controller.abort();

  const controller = new AbortController();
  const promise = refreshPricesForTargets(targets, controller.signal).finally(() => {
    if (refreshPricesInFlight?.promise === promise) refreshPricesInFlight = null;
  });
  refreshPricesInFlight = { key, promise, controller };
  return promise;
}

export function toCNY(value: number, currency: string): number {
  const result = value * (FX[currency as keyof typeof FX] ?? 1);
  return Number.isFinite(result) ? result : 0;
}
