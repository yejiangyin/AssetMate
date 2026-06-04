import type { Holding } from "../data/mockData";
import { toYahooSymbol } from "./quoteApi";

export type CorporateActionEvent = {
  id: string;
  source: "yahoo" | "eastmoney-fund";
  type: "cash_dividend" | "split";
  date: string;
  amount?: number;
  ratio?: number;
};

const cache = new Map<string, { ts: number; data: CorporateActionEvent[] }>();
const inflight = new Map<string, Promise<CorporateActionEvent[]>>();
const CACHE_TTL = 30 * 60 * 1000;

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

async function fetchEastMoneyFundCorporateActions(symbol: string): Promise<CorporateActionEvent[]> {
  const code = normalizeFundCode(symbol);
  if (!/^\d{6}$/.test(code)) return [];
  const key = `eastmoney-fund-actions:${code}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
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
        const date = row[2] || row[1] || "";
        const amount = parsePositiveNumber(row[3] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount > 0)) return null;
        return {
          id: `eastmoney-fund:cash_dividend:${code}:${date}:${amount}`,
          source: "eastmoney-fund" as const,
          type: "cash_dividend" as const,
          date,
          amount,
        };
      });
      const splits = splitRows.map((row) => {
        const date = row[1] || "";
        const ratio = parsePositiveNumber(row[3] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(ratio > 0) || Math.abs(ratio - 1) < 1e-8) return null;
        return {
          id: `eastmoney-fund:split:${code}:${date}:${ratio}`,
          source: "eastmoney-fund" as const,
          type: "split" as const,
          date,
          ratio,
        };
      });
      const data = [...dividends, ...splits].filter(Boolean).sort((a, b) => a!.date.localeCompare(b!.date)) as CorporateActionEvent[];
      cache.set(key, { ts: Date.now(), data });
      return data;
    } catch {
      clearTimeout(tid);
      return [];
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
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const period2 = Math.floor(Date.now() / 1000) + 86400;
    const period1 = period2 - days * 86400;
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
      const dividends = Object.values(events.dividends ?? {}) as any[];
      const splits = Object.values(events.splits ?? {}) as any[];
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
      cache.set(key, { ts: Date.now(), data: sorted });
      return sorted;
    } catch {
      clearTimeout(tid);
      return [];
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

export async function fetchCorporateActions(holding: Holding): Promise<CorporateActionEvent[]> {
  if (holding.market === "FUND" && holding.assetType === "fund") {
    return fetchEastMoneyFundCorporateActions(holding.symbol);
  }
  if (!canUseYahooActions(holding)) return [];
  return fetchYahooCorporateActions(toYahooSymbol(holding.symbol, holding.market));
}
