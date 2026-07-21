import type { SecAnnualMetrics } from "../research/types";
import { createRequestStartGate } from "./requestStartGate";

// ─── SEC EDGAR financial history (10+ years, US stocks only) ──────────────────

const SEC_TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_CONCEPT_BASE = "https://data.sec.gov/api/xbrl/companyconcept";

let cachedTickerMap: Record<string, string> | null = null;
let cachedTickerMapAt = 0;
let inflightTickerMap: Promise<Record<string, string> | null> | null = null;
const TICKER_MAP_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const SEC_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const SEC_NEGATIVE_RESULT_TTL_MS = 15 * 60 * 1000;
const SEC_RESULT_CACHE_MAX_ITEMS = 60;
// SEC's published fair-access threshold is 10 requests/second. Starting at
// most 8 requests/second leaves headroom for retries and browser timing jitter.
const secRequestGate = createRequestStartGate(125);
const secResultCache = new Map<string, { data: SecAnnualMetrics | null; fetchedAt: number }>();
const inflightSecResults = new Map<string, Promise<SecAnnualMetrics | null>>();

function abortError() {
  const error = new Error("SEC request cancelled");
  error.name = "AbortError";
  return error;
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function retryAfterMilliseconds(response: Response, attempt: number) {
  const raw = response.headers.get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - Date.now()));
  }
  return attempt === 0 ? 1_000 : 2_500;
}

async function fetchSecJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await secRequestGate.waitTurn();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMilliseconds(response, attempt)));
        continue;
      }
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      if (attempt >= 2) return null;
    } finally {
      clearTimeout(tid);
    }
  }
  return null;
}

async function loadSecTickerMap(): Promise<Record<string, string> | null> {
  const data = await fetchSecJson<Record<string, { cik_str: number; ticker: string }>>(SEC_TICKER_MAP_URL, 10_000);
  if (!data) return cachedTickerMap;
  const map: Record<string, string> = {};
  for (const key of Object.keys(data)) {
    const entry = data[key];
    if (entry?.ticker && entry?.cik_str) {
      map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
    }
  }
  cachedTickerMap = map;
  cachedTickerMapAt = Date.now();
  return map;
}

async function fetchSecTickerMap(signal?: AbortSignal): Promise<Record<string, string> | null> {
  if (cachedTickerMap && Date.now() - cachedTickerMapAt < TICKER_MAP_TTL_MS) return cachedTickerMap;
  if (!inflightTickerMap) {
    const task = loadSecTickerMap().finally(() => {
      if (inflightTickerMap === task) inflightTickerMap = null;
    });
    inflightTickerMap = task;
  }
  return waitForCaller(inflightTickerMap, signal);
}

interface ConceptAlias {
  concept: string;
  unit: string;
}

const SEC_CONCEPT_ALIASES: Record<string, ConceptAlias[]> = {
  revenue: [
    { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", unit: "USD" },
    { concept: "Revenues", unit: "USD" },
    { concept: "SalesRevenueNet", unit: "USD" },
  ],
  netIncome: [{ concept: "NetIncomeLoss", unit: "USD" }],
  eps: [{ concept: "EarningsPerShareBasic", unit: "USD/shares" }],
  totalAssets: [{ concept: "Assets", unit: "USD" }],
  totalLiabilities: [{ concept: "Liabilities", unit: "USD" }],
  stockholdersEquity: [
    { concept: "StockholdersEquity", unit: "USD" },
    { concept: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", unit: "USD" },
  ],
  cashAndEquivalents: [
    { concept: "CashAndCashEquivalentsAtCarryingValue", unit: "USD" },
    { concept: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", unit: "USD" },
  ],
  operatingCashFlow: [
    { concept: "NetCashProvidedByUsedInOperatingActivities", unit: "USD" },
  ],
  capitalExpenditures: [
    { concept: "PaymentsToAcquirePropertyPlantAndEquipment", unit: "USD" },
    { concept: "PaymentsToAcquireProductiveAssets", unit: "USD" },
  ],
  grossProfit: [{ concept: "GrossProfit", unit: "USD" }],
  operatingIncome: [{ concept: "OperatingIncomeLoss", unit: "USD" }],
  researchAndDevelopment: [{ concept: "ResearchAndDevelopmentExpense", unit: "USD" }],
  dividendsPaid: [
    { concept: "PaymentsOfDividends", unit: "USD" },
    { concept: "PaymentsForDividends", unit: "USD" },
  ],
};

interface SecDataPoint {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}

export function calculateSecFreeCashFlow(
  operatingCashFlow: number | undefined,
  capitalExpenditures: number | undefined,
) {
  return operatingCashFlow != null && capitalExpenditures != null
    ? operatingCashFlow - capitalExpenditures
    : undefined;
}

async function fetchSecConcept(cik: string, alias: ConceptAlias, signal?: AbortSignal): Promise<SecDataPoint[] | null> {
  const url = `${SEC_CONCEPT_BASE}/CIK${cik}/us-gaap/${alias.concept}.json`;
  const request = fetchSecJson<{ units?: Record<string, SecDataPoint[]> }>(url, 8_000)
    .then((json) => json?.units?.[alias.unit] ?? null);
  return waitForCaller(request, signal);
}

function extractAnnualValues(dataPoints: SecDataPoint[]): Array<{ fiscalYear: number; value: number }> {
  // Filter for annual (10-K) data, deduplicate by fiscal year (take most recent filing)
  const byYear = new Map<number, { filed: string; value: number }>();
  for (const dp of dataPoints) {
    if (dp.form !== "10-K") continue;
    if (typeof dp.fy !== "number" || typeof dp.val !== "number") continue;
    const existing = byYear.get(dp.fy);
    if (!existing || String(dp.filed ?? "") > existing.filed) {
      byYear.set(dp.fy, { filed: String(dp.filed ?? ""), value: dp.val });
    }
  }
  return Array.from(byYear.entries())
    .map(([fy, { value }]) => ({ fiscalYear: fy, value }))
    .sort((a, b) => b.fiscalYear - a.fiscalYear)
    .slice(0, 12); // up to 12 years
}

/**
 * Fetches 10+ years of annual financial metrics from SEC EDGAR for US stocks.
 * Uses the companyconcept API with concept aliases for robustness.
 * Returns null for non-US stocks or if data is unavailable.
 */
async function loadSecFinancialHistory(ticker: string): Promise<SecAnnualMetrics | null> {
  const tickerMap = await fetchSecTickerMap();
  if (!tickerMap) return null;

  const cik = tickerMap[ticker];
  if (!cik) return null;

  // Fetch all concept aliases in parallel, then pick the first that has data for each metric
  const metricResults: Record<string, Array<{ fiscalYear: number; value: number }>> = {};

  const entries = Object.entries(SEC_CONCEPT_ALIASES);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const [metric, aliases] = entries[cursor++]!;
      for (const alias of aliases) {
        const dataPoints = await fetchSecConcept(cik, alias);
        if (dataPoints && dataPoints.length) {
          const annual = extractAnnualValues(dataPoints);
          if (annual.length) {
            metricResults[metric] = annual;
            break;
          }
        }
      }
    }
  });

  await Promise.allSettled(workers);

  if (Object.keys(metricResults).length === 0) return null;

  // Build a map: fiscalYear -> { metric: value }
  const yearMap = new Map<number, Record<string, number>>();
  for (const [metric, values] of Object.entries(metricResults)) {
    for (const { fiscalYear, value } of values) {
      if (!yearMap.has(fiscalYear)) yearMap.set(fiscalYear, {});
      yearMap.get(fiscalYear)![metric] = value;
    }
  }

  const years = Array.from(yearMap.entries())
    .map(([fy, m]) => ({
      fiscalYear: fy,
      revenue: m.revenue,
      netIncome: m.netIncome,
      eps: m.eps,
      totalAssets: m.totalAssets,
      totalLiabilities: m.totalLiabilities,
      stockholdersEquity: m.stockholdersEquity,
      cashAndEquivalents: m.cashAndEquivalents,
      operatingCashFlow: m.operatingCashFlow,
      capitalExpenditures: m.capitalExpenditures,
      // SEC PaymentsToAcquirePropertyPlantAndEquipment is a positive outflow.
      freeCashFlow: calculateSecFreeCashFlow(m.operatingCashFlow, m.capitalExpenditures),
      grossProfit: m.grossProfit,
      operatingIncome: m.operatingIncome,
      researchAndDevelopment: m.researchAndDevelopment,
      dividendsPaid: m.dividendsPaid,
    }))
    .sort((a, b) => (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0))
    .slice(0, 10);

  if (!years.length) return null;

  return { symbol: ticker, cik, years };
}

/**
 * Fetches and coalesces annual SEC data. A caller may cancel its own wait
 * without aborting a shared upstream request that another research job uses.
 */
export async function fetchSecFinancialHistory(symbol: string, signal?: AbortSignal): Promise<SecAnnualMetrics | null> {
  const ticker = symbol.replace(/\.US$/, "").toUpperCase();
  const cached = secResultCache.get(ticker);
  const cacheTtl = cached?.data ? SEC_RESULT_TTL_MS : SEC_NEGATIVE_RESULT_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < cacheTtl) return cached.data;

  let task = inflightSecResults.get(ticker);
  if (!task) {
    task = loadSecFinancialHistory(ticker)
      .then((data) => {
        if (secResultCache.has(ticker)) secResultCache.delete(ticker);
        secResultCache.set(ticker, { data, fetchedAt: Date.now() });
        while (secResultCache.size > SEC_RESULT_CACHE_MAX_ITEMS) {
          const oldest = secResultCache.keys().next().value;
          if (!oldest) break;
          secResultCache.delete(oldest);
        }
        return data;
      })
      .finally(() => inflightSecResults.delete(ticker));
    inflightSecResults.set(ticker, task);
  }
  return waitForCaller(task, signal);
}

export function resetSecEdgarStateForTests() {
  cachedTickerMap = null;
  cachedTickerMapAt = 0;
  inflightTickerMap = null;
  secResultCache.clear();
  inflightSecResults.clear();
  secRequestGate.reset();
}
