import { fetchCorporateActions } from "../services/corporateActions";
import { fetchChart, fetchDetailChart, fetchYahooQuoteSummary, toYahooSymbol, type ChartData, type ChartPoint, type QuoteInfo, type YahooQuoteSummary } from "../services/quoteApi";
import { fetchSecFinancialHistory } from "../services/secEdgar";
import { closureReason, isMarketOpenNow, type MarketType } from "../services/tradingCalendar";
import type { CorporateActionEvent } from "../services/corporateActions";
import {
  datasetRequirement,
  evaluateTargetDataStatus,
  supportsCorporateActions,
  supportsEquityFundamentals,
  supportsSecFinancials,
} from "./dataRequirements";
import type {
  ResearchDataProvenance,
  ResearchDatasetKind,
  ResearchEnrichedData,
  ResearchFundamentals,
  ResearchPricePoint,
  ResearchTarget,
  ResearchTargetContext,
  ResearchWorkflowId,
  SecAnnualMetrics,
} from "./types";

const DEEP_RESEARCH_WORKFLOWS: ResearchWorkflowId[] = [
  "investment_research",
  "deep_research",
  "deep_company_series",
  "financial_data",
  "thesis_tracker",
  "thesis_drift",
  "management_deep_dive",
  "income_investment",
  "earnings_review",
  "earnings_team",
  "quality_screen",
  "bottleneck_hunter",
];

const KNOWN_MARKETS: MarketType[] = ["A", "US", "HK", "JP", "UK", "DE", "IN", "VN", "CRYPTO", "FUND", "BOND", "GOLD"];

export interface ResearchMarketDataDependencies {
  fetchDetailChart: typeof fetchDetailChart;
  fetchCorporateActions: typeof fetchCorporateActions;
  fetchChart: typeof fetchChart;
  fetchYahooQuoteSummary: typeof fetchYahooQuoteSummary;
  fetchSecFinancialHistory: typeof fetchSecFinancialHistory;
}

const DEFAULT_DEPENDENCIES: ResearchMarketDataDependencies = {
  fetchDetailChart,
  fetchCorporateActions,
  fetchChart,
  fetchYahooQuoteSummary,
  fetchSecFinancialHistory,
};

interface DatasetResult<T> {
  value?: T;
  provenance: ResearchDataProvenance;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知数据错误";
}

function cancellationError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Research market data cancelled", "AbortError");
}

async function runDataset<T>(input: {
  dataset: ResearchDatasetKind;
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
  load: () => Promise<T>;
  emptyIsSuccess?: (value: T) => boolean;
}): Promise<DatasetResult<T>> {
  const requestedAt = new Date().toISOString();
  if (input.signal?.aborted) {
    return {
      provenance: {
        dataset: input.dataset,
        provider: input.provider,
        requestedAt,
        completedAt: new Date().toISOString(),
        status: "cancelled",
        error: errorMessage(cancellationError(input.signal)),
      },
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(`${input.dataset} timed out`, "TimeoutError")), input.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancellationError(input.signal));
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([input.load(), timeoutPromise, abortPromise]);
    const emptyOk = input.emptyIsSuccess?.(value) ?? value != null;
    return {
      value,
      provenance: {
        dataset: input.dataset,
        provider: input.provider,
        requestedAt,
        completedAt: new Date().toISOString(),
        status: emptyOk ? "success" : "partial",
        ...(!emptyOk ? { error: "数据源未返回可用内容" } : {}),
      },
    };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    const status = name === "TimeoutError" ? "timeout" : name === "AbortError" || input.signal?.aborted ? "cancelled" : "failed";
    return {
      provenance: {
        dataset: input.dataset,
        provider: input.provider,
        requestedAt,
        completedAt: new Date().toISOString(),
        status,
        error: errorMessage(error),
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
}

function exactPointDate(point: ChartPoint | undefined) {
  if (!point) return undefined;
  const raw = point.dateLabel || point.time;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (point.timestamp && Number.isFinite(point.timestamp)) return new Date(point.timestamp).toISOString().slice(0, 10);
  return undefined;
}

function samplePrices(points: ChartPoint[], source: string): ResearchPricePoint[] {
  const valid = points.filter((point) => Number.isFinite(point.price) && point.price > 0);
  const sampled = valid.length <= 60
    ? valid
    : [...new Set(Array.from({ length: 60 }, (_, index) => Math.round(index * (valid.length - 1) / 59)))]
      .map((index) => valid[index]!)
      .filter(Boolean);
  return sampled
    .map((point) => ({
      date: exactPointDate(point) || point.dateLabel || point.time,
      price: point.price,
      volume: Number.isFinite(point.volume) ? point.volume : undefined,
      source,
      adjustmentMode: "unknown",
    }));
}

function quoteFundamentals(quote: QuoteInfo | null | undefined): ResearchFundamentals | undefined {
  if (!quote) return undefined;
  const result: ResearchFundamentals = {
    marketCap: quote.marketCap,
    pe: quote.pe,
    eps: quote.eps,
    week52High: quote.week52High,
    week52Low: quote.week52Low,
    currency: quote.currency,
  };
  return Object.values(result).some((value) => value != null && value !== "") ? result : undefined;
}

function enrichedSummary(summary: YahooQuoteSummary | null | undefined): ResearchEnrichedData | undefined {
  if (!summary) return undefined;
  const result: ResearchEnrichedData = {};
  if (summary.companyProfile) result.companyProfile = summary.companyProfile;
  if (summary.keyStats) result.keyStats = summary.keyStats;
  if (summary.analystData) result.analystData = summary.analystData;
  if (summary.financialStatements) result.financialStatements = summary.financialStatements;
  if (summary.calendarEvents) result.calendarEvents = summary.calendarEvents;
  return Object.keys(result).length ? result : undefined;
}

function mappedActions(events: CorporateActionEvent[] | undefined) {
  return events?.map((event) => ({
    date: event.date,
    type: event.type,
    description: event.description,
    amount: event.amount,
    ratio: event.ratio,
  }));
}

function latestExactDate(points: ChartPoint[] | undefined) {
  if (!points?.length) return undefined;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = exactPointDate(points[index]);
    if (value) return value;
  }
  return undefined;
}

function todayYmd() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function datasetMaxAgeDays(dataset: ResearchDatasetKind, target: ResearchTarget) {
  if (dataset === "quote" || dataset === "price_history") {
    if (target.market === "CRYPTO") return 2;
    if (target.market === "FUND") return 10;
    return 5;
  }
  if (dataset === "fundamentals") return 45;
  if (dataset === "financial_statements" || dataset === "sec_filings") return 550;
  return undefined;
}

function ageInDays(dataDate: string | undefined) {
  if (!dataDate || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) return undefined;
  const value = Date.parse(`${dataDate}T00:00:00Z`);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
}

function attachDatasetPolicy(
  provenance: ResearchDataProvenance,
  target: ResearchTarget,
  workflowId: ResearchWorkflowId,
) {
  const policy = datasetRequirement(workflowId, target, provenance.dataset);
  const ageDays = ageInDays(provenance.dataDate);
  const maxAgeDays = datasetMaxAgeDays(provenance.dataset, target);
  const stale = provenance.status === "success" && ageDays != null && maxAgeDays != null && ageDays > maxAgeDays;
  const missingRequiredDate = provenance.status === "success"
    && policy.requirement === "required"
    && (provenance.dataset === "quote" || provenance.dataset === "price_history")
    && !provenance.dataDate;
  return {
    ...provenance,
    ...policy,
    ...(missingRequiredDate ? { status: "partial" as const, error: "数据源未返回可核对的实际日期" } : {}),
    ...(ageDays != null ? { ageDays } : {}),
    ...(stale ? { stale: true, error: `数据已滞后 ${ageDays} 天（当前要求不超过 ${maxAgeDays} 天）` } : {}),
  } satisfies ResearchDataProvenance;
}

function unavailableDataset<T>(
  dataset: ResearchDatasetKind,
  provider: string,
): DatasetResult<T> {
  const now = new Date().toISOString();
  return {
    provenance: {
      dataset,
      status: "not_applicable",
      provider,
      requestedAt: now,
      completedAt: now,
    },
  };
}

function derivedSummaryProvenance(
  source: ResearchDataProvenance,
  dataset: ResearchDatasetKind,
  available: boolean,
): ResearchDataProvenance {
  if (source.status !== "success") return { ...source, dataset };
  return {
    ...source,
    dataset,
    status: available ? "success" : "not_applicable",
    ...(!available ? { error: "服务商暂未提供此项增强数据" } : { error: undefined }),
  };
}

function summaryDatasetDate(summary: YahooQuoteSummary | null | undefined, dataset: ResearchDatasetKind) {
  if (!summary) return undefined;
  if (dataset === "financial_statements") {
    const dates = [
      ...(summary.financialStatements?.income ?? []).map((item) => item.year),
      ...(summary.financialStatements?.balanceSheet ?? []).map((item) => item.year),
      ...(summary.financialStatements?.cashFlow ?? []).map((item) => item.year),
    ].filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)));
    return dates.sort().at(-1);
  }
  return undefined;
}

function notApplicableContext(target: ResearchTarget): ResearchTargetContext {
  const now = new Date().toISOString();
  return {
    target,
    status: "complete",
    provenance: [{
      dataset: "quote",
      status: "not_applicable",
      provider: "AssetMate local context",
      requestedAt: now,
      completedAt: now,
    }],
  };
}

export async function enrichResearchTarget(
  target: ResearchTarget,
  workflowId: ResearchWorkflowId,
  options: {
    signal?: AbortSignal;
    dependencies?: ResearchMarketDataDependencies;
    timeoutMs?: number;
  } = {},
): Promise<ResearchTargetContext> {
  if (target.symbol === "PORTFOLIO" || target.symbol === "TOPIC") return notApplicableContext(target);
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const timeoutMs = options.timeoutMs ?? (DEEP_RESEARCH_WORKFLOWS.includes(workflowId) && target.market === "US" ? 35_000 : 20_000);
  const symbol = target.yahooSymbol || target.symbol;
  const yahooSymbol = target.yahooSymbol || toYahooSymbol(target.symbol, target.market);
  const canUseEquityFundamentals = supportsEquityFundamentals(target);
  const needsSec = supportsSecFinancials(target)
    && Boolean(datasetRequirement(workflowId, target, "sec_filings").requirementGroup);

  const [live, detail, actions, yahoo, summary, sec] = await Promise.all([
    runDataset({
      dataset: "quote",
      provider: "AssetMate market data router",
      timeoutMs,
      signal: options.signal,
      load: () => dependencies.fetchDetailChart(symbol, target.market, "fs", true, true),
      emptyIsSuccess: (value) => value.quote.price > 0,
    }),
    runDataset({
      dataset: "price_history",
      provider: "AssetMate market data router",
      timeoutMs,
      signal: options.signal,
      load: () => dependencies.fetchDetailChart(symbol, target.market, "max", true, true),
      emptyIsSuccess: (value) => value.points.some((point) => point.price > 0),
    }),
    supportsCorporateActions(target)
      ? runDataset({
          dataset: "corporate_actions",
          provider: "AssetMate corporate action router",
          timeoutMs,
          signal: options.signal,
          load: () => dependencies.fetchCorporateActions({ symbol, market: target.market, assetType: target.assetType }, 1825),
          emptyIsSuccess: () => true,
        })
      : Promise.resolve(unavailableDataset<CorporateActionEvent[]>("corporate_actions", "AssetMate corporate action router")),
    canUseEquityFundamentals
      ? runDataset({
          dataset: "fundamentals",
          provider: "Yahoo Finance",
          timeoutMs,
          signal: options.signal,
          load: () => dependencies.fetchChart(yahooSymbol, "1y", true),
          emptyIsSuccess: (value) => [
            value.quote.marketCap,
            value.quote.pe,
            value.quote.eps,
            value.quote.week52High,
            value.quote.week52Low,
          ].some((item) => typeof item === "number" && Number.isFinite(item)),
        })
      : Promise.resolve(unavailableDataset<ChartData>("fundamentals", "Yahoo Finance")),
    canUseEquityFundamentals
      ? runDataset({
          dataset: "financial_statements",
          provider: "Yahoo Finance Quote Summary",
          timeoutMs,
          signal: options.signal,
          load: () => dependencies.fetchYahooQuoteSummary(yahooSymbol),
          emptyIsSuccess: (value) => value != null,
        })
      : Promise.resolve(unavailableDataset<YahooQuoteSummary | null>("financial_statements", "Yahoo Finance Quote Summary")),
    needsSec
      ? runDataset({
          dataset: "sec_filings",
          provider: "SEC EDGAR",
          timeoutMs,
          signal: options.signal,
          load: () => dependencies.fetchSecFinancialHistory(symbol, options.signal),
          emptyIsSuccess: (value) => value != null && value.years.length > 0,
        })
      : Promise.resolve(unavailableDataset<SecAnnualMetrics | null>("sec_filings", "SEC EDGAR")),
  ]);

  const liveChart = live.value as ChartData | undefined;
  const detailChart = detail.value as ChartData | undefined;
  const yahooChart = yahoo.value as ChartData | undefined;
  const yahooQuote = yahooChart?.quote;
  const detailQuote = detailChart?.quote;
  const liveQuote = liveChart?.quote;
  const bestQuote = liveQuote?.price && liveQuote.price > 0
    ? liveQuote
    : detailQuote?.price && detailQuote.price > 0 ? detailQuote : yahooQuote;
  const quoteProvider = bestQuote === yahooQuote ? "Yahoo Finance" : "AssetMate market data router";
  const historyChart = detailChart?.points.some((point) => point.price > 0) ? detailChart : yahooChart;
  const historyProvider = historyChart === yahooChart ? "Yahoo Finance" : detail.provenance.provider;
  const rawHistoryDate = latestExactDate(historyChart?.points);
  const latestQuoteDate = latestExactDate(liveChart?.points)
    ?? (target.market !== "FUND" && bestQuote?.isLive ? todayYmd() : rawHistoryDate);
  // Long-range charts are calendar-aggregated by the public market adapter. The
  // current month's bucket is still current even though its timestamp is the
  // first day of that month, so use the independently fetched quote date for
  // freshness without changing the underlying sampled observations.
  const latestHistoryDate = rawHistoryDate && latestQuoteDate
    && rawHistoryDate.slice(0, 7) === latestQuoteDate.slice(0, 7)
    ? latestQuoteDate
    : rawHistoryDate;
  const completedAt = new Date().toISOString();
  const quoteProvenance: ResearchDataProvenance = {
    ...live.provenance,
    dataset: "quote",
    status: bestQuote?.price && bestQuote.price > 0 ? "success" : live.provenance.status === "timeout" || detail.provenance.status === "timeout" ? "timeout" : "failed",
    provider: quoteProvider,
    completedAt,
    dataDate: latestQuoteDate,
    sourceUrl: bestQuote === yahooQuote ? `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}` : undefined,
    currency: bestQuote?.currency || target.currency || undefined,
    freshness: bestQuote?.isLive && latestQuoteDate === todayYmd() ? "live" : latestQuoteDate ? "delayed" : "unknown",
    ...(!(bestQuote?.price && bestQuote.price > 0) ? { error: "未取得有效报价" } : {}),
  };
  const historyProvenance: ResearchDataProvenance = {
    ...(historyChart === yahooChart ? yahoo.provenance : detail.provenance),
    dataset: "price_history",
    provider: historyProvider,
    dataDate: latestHistoryDate,
    sourceUrl: historyChart === yahooChart ? `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/history` : undefined,
    currency: bestQuote?.currency || target.currency || undefined,
    freshness: latestHistoryDate ? "delayed" : "unknown",
    adjustmentMode: "unknown",
    status: historyChart?.points.some((point) => point.price > 0)
      ? "success"
      : detail.provenance.status === "timeout" || yahoo.provenance.status === "timeout" ? "timeout" : "failed",
    ...(!historyChart?.points.some((point) => point.price > 0) ? { error: "未取得有效历史价格" } : { error: undefined }),
  };
  if (actions.value?.length) {
    actions.provenance.provider = [...new Set(actions.value.map((event) => event.source))].join(", ");
    actions.provenance.dataDate = actions.value[actions.value.length - 1]?.date;
    actions.provenance.sourceUrl = actions.value.some((event) => event.source === "yahoo")
      ? `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/history`
      : actions.value.some((event) => event.source === "eastmoney-fund")
        ? `https://fundf10.eastmoney.com/fhsp_${encodeURIComponent(target.symbol.replace(/\.(SS|SZ)$/i, ""))}.html`
        : actions.value.some((event) => event.source === "eastmoney-stock")
          ? `https://data.eastmoney.com/yjfp/detail/${encodeURIComponent(target.symbol.replace(/\.(SS|SZ)$/i, ""))}.html`
          : undefined;
  }
  if (sec.value?.years.length) {
    sec.provenance.dataDate = String(sec.value.years[0]?.fiscalYear ?? "") || undefined;
    sec.provenance.sourceUrl = `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(sec.value.cik)}`;
    sec.provenance.currency = "USD";
    sec.provenance.unit = "USD; EPS uses USD/share";
  }
  yahoo.provenance.sourceUrl = canUseEquityFundamentals
    ? `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}`
    : undefined;
  yahoo.provenance.currency = yahooQuote?.currency || target.currency || undefined;

  const fundamentals = quoteFundamentals(yahooQuote) ?? quoteFundamentals(detailQuote);
  let enrichedData = enrichedSummary(summary.value);
  if (sec.value) {
    enrichedData = enrichedData ?? {};
    enrichedData.secAnnualMetrics = sec.value;
  }
  if (KNOWN_MARKETS.includes(target.market as MarketType)) {
    const market = target.market as MarketType;
    enrichedData = enrichedData ?? {};
    const isOpen = isMarketOpenNow(market);
    enrichedData.marketStatus = { isOpen, closureReason: isOpen ? undefined : closureReason(market, new Date()) ?? undefined };
  }
  const enrichedTarget: ResearchTarget = bestQuote
    ? {
        ...target,
        name: target.name && target.name !== target.symbol ? target.name : bestQuote.name || target.name,
        currency: bestQuote.currency || target.currency,
        exchange: bestQuote.exchange || target.exchange,
        currentPrice: bestQuote.price > 0 ? bestQuote.price : target.currentPrice,
        dailyChangePercent: Number.isFinite(bestQuote.changePercent) ? bestQuote.changePercent : target.dailyChangePercent,
      }
    : target;
  const summaryValue = summary.value;
  const summaryProvenance = [
    derivedSummaryProvenance(summary.provenance, "company_profile", Boolean(summaryValue?.companyProfile)),
    derivedSummaryProvenance(summary.provenance, "financial_statements", Boolean(summaryValue?.financialStatements)),
    derivedSummaryProvenance(summary.provenance, "analyst_data", Boolean(summaryValue?.analystData)),
    derivedSummaryProvenance(summary.provenance, "calendar_events", Boolean(summaryValue?.calendarEvents)),
  ].map((item) => ({
    ...item,
    dataDate: summaryDatasetDate(summaryValue, item.dataset),
    sourceUrl: canUseEquityFundamentals ? `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}` : undefined,
    currency: target.currency || undefined,
  }));
  const marketStatusProvenance: ResearchDataProvenance = {
    dataset: "market_status",
    provider: "AssetMate trading calendar",
    requestedAt: completedAt,
    completedAt,
    status: enrichedData?.marketStatus ? "success" : "not_applicable",
    freshness: "live",
  };
  const provenance = [quoteProvenance, historyProvenance, actions.provenance, yahoo.provenance, ...summaryProvenance, sec.provenance, marketStatusProvenance]
    .map((item) => attachDatasetPolicy(item, target, workflowId));
  return {
    target: enrichedTarget,
    status: evaluateTargetDataStatus(provenance),
    recentPrices: historyChart?.points.length ? samplePrices(historyChart.points, historyProvider) : undefined,
    corporateActions: mappedActions(actions.value),
    fundamentals,
    enrichedData,
    provenance,
  };
}

export async function enrichResearchTargets(
  targets: ResearchTarget[],
  workflowId: ResearchWorkflowId,
  options: {
    signal?: AbortSignal;
    dependencies?: ResearchMarketDataDependencies;
    timeoutMs?: number;
    concurrency?: number;
    onTargetComplete?: (context: ResearchTargetContext, completed: number, total: number) => void;
  } = {},
) {
  const results = new Array<ResearchTargetContext>(targets.length);
  let cursor = 0;
  let completed = 0;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, targets.length));
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const context = await enrichResearchTarget(targets[index]!, workflowId, options);
      results[index] = context;
      completed += 1;
      options.onTargetComplete?.(context, completed, targets.length);
      if (options.signal?.aborted) break;
    }
  });
  await Promise.all(workers);
  if (options.signal?.aborted) throw cancellationError(options.signal);
  return results.filter(Boolean);
}
