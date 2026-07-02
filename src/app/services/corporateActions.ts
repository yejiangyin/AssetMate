import type { Holding } from "../data/mockData";
import { toYahooSymbol } from "./quoteApi";
import {
  readPersistentEntry,
  shouldFullRefresh,
  shouldUseFreshCache,
  writePersistentEntry,
} from "./persistentDataCache";

export type CorporateActionEvent = {
  id: string;
  source: "yahoo" | "eastmoney-fund" | "eastmoney-stock";
  type: "cash_dividend" | "split" | "dividend_resolution" | "split_resolution";
  date: string;
  amount?: number;
  ratio?: number;
  recordDate?: string;
  exDate?: string;
  payDate?: string;
  announcementDate?: string;
  description?: string;
};

type YahooDividendEvent = {
  date?: number | string;
  amount?: number | string;
};

type YahooSplitEvent = {
  date?: number | string;
  splitRatio?: string;
  numerator?: number | string;
  denominator?: number | string;
};

const cache = new Map<string, { ts: number; data: CorporateActionEvent[] }>();
const inflight = new Map<string, Promise<CorporateActionEvent[]>>();
const CACHE_TTL = 30 * 60 * 1000;
const PERSISTENT_ACTION_STORAGE_KEY = "asset-helper:corporate-actions-cache:v3";
const PERSISTENT_ACTION_MAX_ITEMS = 120;
const PERSISTENT_ACTION_TTL = 24 * 60 * 60 * 1000;
const ACTION_FULL_REFRESH_TTL = 7 * 24 * 60 * 60 * 1000;

function mergeCorporateActions(base: CorporateActionEvent[], incoming: CorporateActionEvent[]) {
  const map = new Map<string, CorporateActionEvent>();
  for (const item of base) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function readPersistentActions(key: string) {
  const entry = readPersistentEntry<CorporateActionEvent[]>(PERSISTENT_ACTION_STORAGE_KEY, key);
  return entry && Array.isArray(entry.data) ? entry : null;
}

function getFreshPersistentActions(key: string) {
  const entry = readPersistentActions(key);
  return shouldUseFreshCache(entry, PERSISTENT_ACTION_TTL) ? entry?.data ?? null : null;
}

function writePersistentActions(
  key: string,
  data: CorporateActionEvent[],
  options: { fullRefresh: boolean; previousFullRefreshAt?: number },
) {
  writePersistentEntry(PERSISTENT_ACTION_STORAGE_KEY, key, data, {
    maxEntries: PERSISTENT_ACTION_MAX_ITEMS,
    fullRefresh: options.fullRefresh,
    previousFullRefreshAt: options.previousFullRefreshAt,
  });
}

function ymdFromUnix(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function parseSplitRatio(raw: unknown, numerator?: unknown, denominator?: unknown) {
  const n = typeof numerator === "number" ? numerator : Number(numerator);
  const d = typeof denominator === "number" ? denominator : Number(denominator);
  if (Number.isFinite(n) && Number.isFinite(d) && n > 0 && d > 0) return n / d;

  const text = String(raw ?? "");
  const match = text.match(/([\d.]+)\s*:\s*([\d.]+)/);
  if (!match) return 0;
  const left = Number(match[1]);
  const right = Number(match[2]);
  return left > 0 && right > 0 ? left / right : 0;
}

function canUseYahooActions(holding: Holding) {
  if (holding.market === "CRYPTO" || holding.market === "GOLD" || holding.assetType === "crypto") return false;
  if (holding.market === "FUND" && holding.assetType === "fund") return false;
  return ["US", "HK", "JP", "A"].includes(holding.market);
}

function normalizeFundCode(symbol: string) {
  return symbol.replace(/\.(SS|SZ)$/i, "").trim();
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function parseHtmlTableRows(html: string, className: string) {
  const tableMatch = html.match(new RegExp(`<table[^>]*class=['"][^'"]*${className}[^'"]*['"][\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`, "i"));
  if (!tableMatch) return [];
  return [...tableMatch[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripTags(cell[1] ?? "")))
    .filter((row) => row.length > 1 && !row.join("").includes("暂无"));
}

function parsePositiveNumber(raw: string) {
  const match = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const value = match ? Number(match[0]) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeYMD(raw: unknown) {
  const match = String(raw ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

async function fetchEastMoneyFundCorporateActions(symbol: string): Promise<CorporateActionEvent[]> {
  const code = normalizeFundCode(symbol);
  if (!/^\d{6}$/.test(code)) return [];
  const key = `eastmoney-fund-actions:${code}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const persistentHit = getFreshPersistentActions(key);
  if (persistentHit) {
    cache.set(key, { ts: Date.now(), data: persistentHit });
    return persistentHit;
  }
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const persistent = readPersistentActions(key);
    const fullRefresh = shouldFullRefresh(persistent, ACTION_FULL_REFRESH_TTL);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://fundf10.eastmoney.com/fhsp_${encodeURIComponent(code)}.html`, {
        signal: ctrl.signal,
        cache: "no-store",
        headers: { Accept: "text/html,*/*" },
      });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`EastMoney fund actions HTTP ${res.status}`);
      const html = await res.text();
      const dividendRows = parseHtmlTableRows(html, "cfxq");
      const splitRows = parseHtmlTableRows(html, "fhxq");
      const dividends = dividendRows.map((row) => {
        const recordDate = normalizeYMD(row[1]);
        const exDate = normalizeYMD(row[2]);
        const payDate = normalizeYMD(row[4]);
        const date = exDate || recordDate || payDate;
        const amount = parsePositiveNumber(row[3] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount > 0)) return null;
        return {
          id: `eastmoney-fund:cash_dividend:${code}:${date}:${amount}`,
          source: "eastmoney-fund" as const,
          type: "cash_dividend" as const,
          date,
          amount,
          recordDate,
          exDate,
          payDate,
          description: row.join(" "),
        };
      });
      const splits = splitRows.map((row) => {
        const exDate = normalizeYMD(row[1]);
        const date = exDate;
        const ratio = parsePositiveNumber(row[3] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(ratio > 0) || Math.abs(ratio - 1) < 1e-8) return null;
        return {
          id: `eastmoney-fund:split:${code}:${date}:${ratio}`,
          source: "eastmoney-fund" as const,
          type: "split" as const,
          date,
          ratio,
          exDate,
          description: row.join(" "),
        };
      });
      const data = [...dividends, ...splits].filter(Boolean).sort((a, b) => a!.date.localeCompare(b!.date)) as CorporateActionEvent[];
      const merged = fullRefresh ? data : mergeCorporateActions(persistent?.data ?? [], data);
      cache.set(key, { ts: Date.now(), data: merged });
      writePersistentActions(key, merged, { fullRefresh, previousFullRefreshAt: persistent?.lastFullRefreshAt });
      return merged;
    } catch {
      clearTimeout(tid);
      return persistent?.data ?? [];
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

function normalizeAStockCode(symbol: string) {
  return symbol.replace(/\.(SH|SS|SZ)$/i, "").trim();
}

function isDisplayableEastMoneyStockAction(event: CorporateActionEvent) {
  if (event.source !== "eastmoney-stock") return true;
  if (event.type === "dividend_resolution" || event.type === "split_resolution") {
    return Boolean(event.announcementDate || event.date);
  }
  return Boolean(event.exDate);
}

export function parseEastMoneyStockCorporateActionRows(code: string, rows: unknown[]): CorporateActionEvent[] {
  return rows.flatMap((rawRow) => {
    const row = rawRow as Record<string, unknown>;
    const exDate = normalizeYMD(row.EX_DIVIDEND_DATE);
    const recordDate = normalizeYMD(row.EQUITY_RECORD_DATE);
    const announcementDate = normalizeYMD(row.NOTICE_DATE || row.PLAN_NOTICE_DATE || row.PUBLISH_DATE);
    const progress = String(row.ASSIGN_PROGRESS ?? "").trim();
    const description = String(row.IMPL_PLAN_PROFILE ?? progress).trim();
    const result: CorporateActionEvent[] = [];

    const cashPerTen = Number(row.PRETAX_BONUS_RMB);
    const amount = Number.isFinite(cashPerTen) && cashPerTen > 0
      ? Number((cashPerTen / 10).toFixed(6))
      : 0;
    const bonus = Number(row.BONUS_RATIO);
    const transfer = Number(row.IT_RATIO);
    const totalBonusPerTen = (Number.isFinite(bonus) && bonus > 0 ? bonus : 0) + (Number.isFinite(transfer) && transfer > 0 ? transfer : 0);
    const ratio = totalBonusPerTen > 0 ? 1 + totalBonusPerTen / 10 : 0;

    if (!exDate) {
      const shareholderApproved = /股东大会.*(?:决议|通过)|(?:决议|通过).*股东大会/.test(progress);
      if (!shareholderApproved || !announcementDate) return [];
      if (amount > 0) {
        result.push({
          id: `eastmoney-stock:dividend_resolution:${code}:${announcementDate}:${amount}`,
          source: "eastmoney-stock",
          type: "dividend_resolution",
          date: announcementDate,
          amount,
          announcementDate,
          description,
        });
      }
      if (ratio > 0 && Math.abs(ratio - 1) > 1e-8) {
        result.push({
          id: `eastmoney-stock:split_resolution:${code}:${announcementDate}:${ratio}`,
          source: "eastmoney-stock",
          type: "split_resolution",
          date: announcementDate,
          ratio,
          announcementDate,
          description,
        });
      }
      return result;
    }

    if (amount > 0) {
      result.push({
        id: `eastmoney-stock:cash_dividend:${code}:${exDate}:${amount}`,
        source: "eastmoney-stock",
        type: "cash_dividend",
        date: exDate,
        amount,
        recordDate,
        exDate,
        announcementDate,
        description,
      });
    }

    if (ratio > 0 && Math.abs(ratio - 1) > 1e-8) {
      result.push({
        id: `eastmoney-stock:split:${code}:${exDate}:${ratio}`,
        source: "eastmoney-stock",
        type: "split",
        date: exDate,
        ratio,
        recordDate,
        exDate,
        announcementDate,
        description,
      });
    }
    return result;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchEastMoneyStockCorporateActions(symbol: string): Promise<CorporateActionEvent[]> {
  const code = normalizeAStockCode(symbol);
  if (!/^\d{6}$/.test(code)) return [];
  const key = `eastmoney-stock-actions:${code}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data.filter(isDisplayableEastMoneyStockAction);
  const persistentHit = getFreshPersistentActions(key);
  if (persistentHit) {
    const displayable = persistentHit.filter(isDisplayableEastMoneyStockAction);
    cache.set(key, { ts: Date.now(), data: displayable });
    return displayable;
  }
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const persistent = readPersistentActions(key);
    const validPersistentActions = (persistent?.data ?? []).filter(isDisplayableEastMoneyStockAction);
    const fullRefresh = shouldFullRefresh(persistent, ACTION_FULL_REFRESH_TTL);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    try {
      const params = new URLSearchParams({
        reportName: "RPT_SHAREBONUS_DET",
        columns: "ALL",
        source: "WEB",
        client: "WEB",
        pageSize: "50",
        pageNumber: "1",
        sortColumns: "EX_DIVIDEND_DATE",
        sortTypes: "-1",
        filter: `(SECURITY_CODE="${code}")`,
      });
      const res = await fetch(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`, {
        signal: ctrl.signal,
        cache: "no-store",
        headers: { Accept: "application/json,*/*", Referer: "https://data.eastmoney.com/yjfp/" },
      });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`EastMoney stock actions HTTP ${res.status}`);
      const json = await res.json();
      const rows = Array.isArray(json?.result?.data) ? json.result.data : [];
      const actions = parseEastMoneyStockCorporateActionRows(code, rows);
      const merged = fullRefresh ? actions : mergeCorporateActions(validPersistentActions, actions);
      cache.set(key, { ts: Date.now(), data: merged });
      writePersistentActions(key, merged, { fullRefresh, previousFullRefreshAt: persistent?.lastFullRefreshAt });
      return merged;
    } catch {
      clearTimeout(tid);
      return validPersistentActions;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

async function fetchYahooCorporateActions(yahooSymbol: string, days = 45): Promise<CorporateActionEvent[]> {
  const key = `yahoo-actions:${yahooSymbol}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const persistentHit = getFreshPersistentActions(key);
  if (persistentHit) {
    cache.set(key, { ts: Date.now(), data: persistentHit });
    return persistentHit;
  }
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const persistent = readPersistentActions(key);
    const fullRefresh = shouldFullRefresh(persistent, ACTION_FULL_REFRESH_TTL);
    const windowDays = fullRefresh ? Math.max(days, 3650) : days;
    const period2 = Math.floor(Date.now() / 1000) + 86400;
    const period1 = period2 - windowDays * 86400;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 7000);
    try {
      const params = new URLSearchParams({
        interval: "1d",
        period1: String(period1),
        period2: String(period2),
        events: "div,splits",
        includePrePost: "false",
      });
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${params.toString()}`;
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`Yahoo actions HTTP ${res.status}`);
      const json = await res.json();
      const events = json?.chart?.result?.[0]?.events ?? {};
      const dividends = Object.values(events.dividends ?? {}) as YahooDividendEvent[];
      const splits = Object.values(events.splits ?? {}) as YahooSplitEvent[];
      const data: CorporateActionEvent[] = [
        ...dividends.map((item) => {
          const ts = Number(item?.date);
          const amount = Number(item?.amount);
          if (!Number.isFinite(ts) || !(amount > 0)) return null;
          const date = ymdFromUnix(ts);
          return {
            id: `yahoo:cash_dividend:${yahooSymbol}:${date}:${amount}`,
            source: "yahoo" as const,
            type: "cash_dividend" as const,
            date,
            amount,
          };
        }),
        ...splits.map((item) => {
          const ts = Number(item?.date);
          const ratio = parseSplitRatio(item?.splitRatio, item?.numerator, item?.denominator);
          if (!Number.isFinite(ts) || !(ratio > 0) || Math.abs(ratio - 1) < 1e-8) return null;
          const date = ymdFromUnix(ts);
          return {
            id: `yahoo:split:${yahooSymbol}:${date}:${ratio}`,
            source: "yahoo" as const,
            type: "split" as const,
            date,
            ratio,
          };
        }),
      ].filter(Boolean) as CorporateActionEvent[];
      const sorted = data.sort((a, b) => a.date.localeCompare(b.date));
      const merged = fullRefresh ? sorted : mergeCorporateActions(persistent?.data ?? [], sorted);
      cache.set(key, { ts: Date.now(), data: merged });
      writePersistentActions(key, merged, { fullRefresh, previousFullRefreshAt: persistent?.lastFullRefreshAt });
      return merged;
    } catch {
      clearTimeout(tid);
      return persistent?.data ?? [];
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

export async function fetchCorporateActions(holding: Holding, days = 45): Promise<CorporateActionEvent[]> {
  if (holding.market === "FUND" && holding.assetType === "fund") {
    return fetchEastMoneyFundCorporateActions(holding.symbol);
  }
  if (holding.market === "A") {
    return fetchEastMoneyStockCorporateActions(holding.symbol);
  }
  if (!canUseYahooActions(holding)) return [];
  return fetchYahooCorporateActions(toYahooSymbol(holding.symbol, holding.market), days);
}
