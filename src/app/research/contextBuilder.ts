import type { DCAPlan, DetailTarget, PortfolioStats } from "../context/AppContext";
import type { Holding } from "../data/mockData";
import type { ChartPoint } from "../services/quoteApi";
import { toCNY } from "../services/priceRefresher";
import type {
  BacktestSeed,
  PortfolioResearchContext,
  PrivateHoldingContext,
  PublicResearchContext,
  ResearchCorporateAction,
  ResearchEnrichedData,
  ResearchFundamentals,
  ResearchTargetContext,
  ResearchTarget,
} from "./types";

function todayYmd() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sampleResearchPrices(points: ChartPoint[]) {
  const valid = points.filter((point) => Number.isFinite(point.price) && point.price > 0);
  const sampled = valid.length <= 60
    ? valid
    : [...new Set(Array.from({ length: 60 }, (_, index) => Math.round(index * (valid.length - 1) / 59)))]
      .map((index) => valid[index]!)
      .filter(Boolean);
  return sampled
    .map((point) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(point.dateLabel || point.time)
        ? point.dateLabel || point.time
        : point.timestamp && Number.isFinite(point.timestamp)
          ? new Date(point.timestamp).toISOString().slice(0, 10)
          : point.dateLabel || point.time,
      price: point.price,
      volume: Number.isFinite(point.volume) ? point.volume : undefined,
      adjustmentMode: "unknown" as const,
    }));
}

function publicTarget(target: ResearchTarget) {
  const result = { ...target };
  delete result.holdingId;
  return result;
}

function publicTargetContext(context: ResearchTargetContext): ResearchTargetContext {
  return { ...context, target: publicTarget(context.target) };
}

function deriveDataCutoff(contexts: ResearchTargetContext[]) {
  const marketDates = contexts.flatMap((context) => context.provenance
    .filter((item) => (item.dataset === "quote" || item.dataset === "price_history") && /^\d{4}-\d{2}-\d{2}$/.test(item.dataDate ?? ""))
    .map((item) => item.dataDate!));
  return marketDates.length ? [...marketDates].sort()[0]! : todayYmd();
}

function summarizeDataStatus(contexts: ResearchTargetContext[]) {
  if (!contexts.length) return undefined;
  const completeTargets = contexts.filter((context) => context.status === "complete").length;
  const partialTargets = contexts.filter((context) => context.status === "partial").length;
  const failedTargets = contexts.filter((context) => context.status === "failed").length;
  const datasetLabels: Record<string, string> = {
    quote: "实时报价",
    price_history: "历史行情",
    company_profile: "公司资料",
    financial_statements: "财务报表",
    analyst_data: "分析师预测",
    calendar_events: "事件日历",
    corporate_actions: "公司行动",
    fundamentals: "基础估值数据",
    sec_filings: "SEC 年报数据",
    market_status: "市场交易状态",
  };
  const warnings = contexts.flatMap((context) => {
    const satisfiedGroups = new Set(context.provenance
      .filter((item) => item.requirementGroup && item.status === "success" && !item.stale)
      .map((item) => item.requirementGroup!));
    return context.provenance
      .filter((item) => (
        (item.requirement === "required" || (Boolean(item.requirementGroup) && !satisfiedGroups.has(item.requirementGroup!)))
        && (["partial", "failed", "timeout", "cancelled"].includes(item.status) || item.stale)
      ))
      .map((item) => `${context.target.name || context.target.symbol} · ${datasetLabels[item.dataset] || item.dataset}：${item.error || item.status}`);
  });
  const optionalNotes = contexts.flatMap((context) => context.provenance
    .filter((item) => item.requirement === "optional" && item.status !== "success" && Boolean(item.error))
    .map((item) => `${context.target.name || context.target.symbol} · ${datasetLabels[item.dataset] || item.dataset}：${item.error}`));
  return {
    status: failedTargets === contexts.length ? "failed" as const : partialTargets > 0 || failedTargets > 0 ? "partial" as const : "complete" as const,
    targetCount: contexts.length,
    completeTargets,
    partialTargets,
    failedTargets,
    warnings,
    optionalNotes,
  };
}

export function researchTargetFromHolding(holding: Holding): ResearchTarget {
  return {
    symbol: holding.symbol,
    displaySymbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    assetType: holding.assetType,
    currency: holding.currency,
    currentPrice: holding.currentPrice,
    dailyChangePercent: holding.todayPnlRate,
    holdingId: holding.id,
  };
}

export function researchTargetFromDetail(target: DetailTarget): ResearchTarget {
  return {
    symbol: target.displaySymbol || target.yahooSymbol,
    yahooSymbol: target.yahooSymbol,
    displaySymbol: target.displaySymbol,
    name: target.name,
    market: target.market,
    assetType: target.assetType,
    currency: target.fallbackQuote?.currency ?? "",
    currentPrice: target.fallbackQuote?.price,
    dailyChangePercent: target.fallbackQuote?.changePercent,
  };
}

export function researchTargetFromBacktestSeed(seed: BacktestSeed): ResearchTarget {
  return {
    symbol: seed.symbol,
    displaySymbol: seed.symbol,
    name: seed.name,
    market: seed.market,
    assetType: seed.assetType,
    currency: "",
  };
}

export function buildPublicResearchContext(
  target: ResearchTarget,
  options: {
    targets?: ResearchTarget[];
    targetContexts?: ResearchTargetContext[];
    pricePoints?: ChartPoint[];
    corporateActions?: ResearchCorporateAction[];
    fundamentals?: ResearchFundamentals;
    enrichedData?: ResearchEnrichedData;
  } = {},
): PublicResearchContext {
  const sanitizedTarget = publicTarget(target);
  const publicTargets = options.targets
    ?.map(publicTarget)
    .filter((item, index, array) => array.findIndex((candidate) => candidate.market === item.market && candidate.symbol === item.symbol) === index);
  const targetContexts = options.targetContexts?.map(publicTargetContext);
  const sampledPrices = sampleResearchPrices(options.pricePoints ?? []);
  const hasFundamentals = options.fundamentals && Object.values(options.fundamentals).some((v) => v != null);
  const dataStatus = summarizeDataStatus(targetContexts ?? []);
  return {
    target: sanitizedTarget,
    targets: publicTargets && publicTargets.length > 1 ? publicTargets : undefined,
    targetContexts: targetContexts?.length ? targetContexts : undefined,
    generatedAt: new Date().toISOString(),
    dataCutoff: targetContexts?.length ? deriveDataCutoff(targetContexts) : todayYmd(),
    dataStatus,
    recentPrices: sampledPrices.length ? sampledPrices : undefined,
    corporateActions: options.corporateActions?.length ? options.corporateActions.slice(-30) : undefined,
    fundamentals: hasFundamentals ? options.fundamentals : undefined,
    enrichedData: options.enrichedData,
  };
}

export function buildPrivateHoldingContext(
  holding: Holding,
  stats: PortfolioStats,
  dcaPlans: DCAPlan[],
): PrivateHoldingContext {
  const plans = dcaPlans.filter((plan) => plan.holdingId === holding.id);
  const marketValue = holding.quantity * holding.currentPrice;
  const costBasis = holding.quantity * holding.costPrice;
  const marketValueInBase = toCNY(marketValue, holding.currency);
  const costBasisInBase = toCNY(costBasis, holding.currency);
  return {
    quantity: holding.quantity,
    costPrice: holding.costPrice,
    marketValue,
    currency: holding.currency,
    baseCurrency: "CNY",
    fxRateToBase: toCNY(1, holding.currency),
    costBasisInBase,
    marketValueInBase,
    unrealizedPnlRate: holding.totalPnlRate,
    portfolioWeight: stats.totalAsset > 0 ? marketValueInBase / stats.totalAsset : undefined,
    dcaSummary: plans.length
      ? plans.map((plan) => `${plan.frequency}:${plan.amount}${plan.currency}:${plan.enabled ? "enabled" : "paused"}`).join("; ")
      : undefined,
    cashDividendTotal: holding.cashDividendTotal,
    dividendReinvest: holding.dividendReinvest === true ? true : undefined,
    transactionCostProfile: holding.transactionCostProfile,
    recentCorporateActions: holding.corporateActions?.slice(-30).map((action) => ({
      type: action.type,
      date: action.date,
      amount: action.amount,
      shares: action.shares,
      ratio: action.ratio,
      price: action.price,
      source: action.source,
    })),
  };
}

export function buildPortfolioContext(
  holdings: Holding[],
  stats: PortfolioStats,
): PortfolioResearchContext {
  const currencies = [...new Set(holdings.map((holding) => holding.currency).filter(Boolean))].sort();
  const rawSummaries = holdings.map((h) => {
    const marketValue = h.quantity * h.currentPrice;
    const costBasis = h.quantity * h.costPrice;
    const marketValueInBase = toCNY(marketValue, h.currency);
    return {
      symbol: h.symbol,
      name: h.name,
      market: h.market,
      assetType: h.assetType,
      currency: h.currency,
      baseCurrency: "CNY",
      fxRateToBase: toCNY(1, h.currency),
      quantity: h.quantity,
      costPrice: h.costPrice,
      currentPrice: h.currentPrice,
      marketValue,
      costBasisInBase: toCNY(costBasis, h.currency),
      marketValueInBase,
      unrealizedPnlRate: h.totalPnlRate,
    };
  });
  const totalAsset = rawSummaries.reduce((sum, holding) => sum + holding.marketValueInBase, 0);
  const totalCost = rawSummaries.reduce((sum, holding) => sum + holding.costBasisInBase, 0);
  const summaries = rawSummaries.map((holding) => ({
    ...holding,
    portfolioWeight: totalAsset > 0 ? holding.marketValueInBase / totalAsset : undefined,
  }));
  const totalUnrealizedPnl = totalAsset - totalCost;
  return {
    holdings: summaries,
    totalAsset,
    totalCost,
    totalUnrealizedPnl,
    totalUnrealizedPnlRate: totalCost > 0 ? totalUnrealizedPnl / totalCost : 0,
    currency: "CNY",
    baseCurrency: "CNY",
    currencies: currencies.length ? currencies : undefined,
    weightTotal: summaries.reduce((sum, holding) => sum + (holding.portfolioWeight ?? 0), 0),
    realizedPnl: stats.realizedPnl,
    realizedTradingPnl: stats.realizedTradingPnl,
    dividendPnl: stats.dividendPnl,
    feePnl: stats.feePnl,
  };
}
