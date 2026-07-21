import Decimal, { type Numeric } from "decimal.js-light";
import type {
  ResearchAuditCheck,
  ResearchAuditResult,
  ResearchModelAuditResult,
  ResearchProfessionalDataTrace,
  PublicResearchContext,
  ResearchSource,
  ResearchTargetContext,
  ResearchWebSearchTrace,
} from "../types";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface MarketCapVerification {
  calculated: string;
  reported: string;
  deviationPercent: string;
  status: "pass" | "warning" | "fail";
}

export function verifyMarketCap(
  price: Numeric,
  shares: Numeric,
  reported: Numeric,
): MarketCapVerification {
  const priceValue = new Decimal(price);
  const sharesValue = new Decimal(shares);
  const reportedValue = new Decimal(reported);
  if (priceValue.isNegative() || sharesValue.isNegative() || reportedValue.isNegative()) throw new Error("市值、价格和股本不能为负数");
  const calculated = priceValue.times(sharesValue);
  const hasInfiniteDeviation = reportedValue.isZero() && !calculated.isZero();
  const deviation = reportedValue.isZero()
    ? new Decimal(0)
    : calculated.minus(reportedValue).abs().div(reportedValue.abs()).times(100);
  return {
    calculated: calculated.toSignificantDigits(18).toString(),
    reported: reportedValue.toSignificantDigits(18).toString(),
    deviationPercent: hasInfiniteDeviation ? "Infinity" : deviation.toDecimalPlaces(4).toString(),
    status: hasInfiniteDeviation ? "fail" : deviation.lte(1) ? "pass" : deviation.lte(5) ? "warning" : "fail",
  };
}

export interface ValuationMetrics {
  pe?: string;
  earningsYieldPercent?: string;
  pb?: string;
  roePercent?: string;
  priceToFcf?: string;
  fcfYieldPercent?: string;
  dividendYieldPercent?: string;
}

export function calculateValuation(input: {
  price: Numeric;
  eps?: Numeric;
  bookValuePerShare?: Numeric;
  fcfPerShare?: Numeric;
  dividendPerShare?: Numeric;
}): ValuationMetrics {
  const price = new Decimal(input.price);
  if (price.lte(0)) throw new Error("价格必须大于 0");
  const result: ValuationMetrics = {};
  if (input.eps != null) {
    const eps = new Decimal(input.eps);
    if (!eps.isZero()) {
      result.pe = price.div(eps).toDecimalPlaces(4).toString();
      result.earningsYieldPercent = eps.div(price).times(100).toDecimalPlaces(4).toString();
    }
  }
  if (input.bookValuePerShare != null) {
    const bvps = new Decimal(input.bookValuePerShare);
    if (!bvps.isZero()) {
      result.pb = price.div(bvps).toDecimalPlaces(4).toString();
      if (input.eps != null) result.roePercent = new Decimal(input.eps).div(bvps).times(100).toDecimalPlaces(4).toString();
    }
  }
  if (input.fcfPerShare != null) {
    const fcf = new Decimal(input.fcfPerShare);
    if (!fcf.isZero()) {
      result.priceToFcf = price.div(fcf).toDecimalPlaces(4).toString();
      result.fcfYieldPercent = fcf.div(price).times(100).toDecimalPlaces(4).toString();
    }
  }
  if (input.dividendPerShare != null && !price.isZero()) {
    result.dividendYieldPercent = new Decimal(input.dividendPerShare).div(price).times(100).toDecimalPlaces(4).toString();
  }
  return result;
}

export interface ScenarioValuationInput {
  name: string;
  annualGrowth: Numeric;
  targetPe: Numeric;
  probability?: Numeric;
}

export interface ScenarioValuationResult {
  name: string;
  futureEps: string;
  targetPrice: string;
  returnPercent: string;
  probability?: string;
}

export function calculateScenarioValuation(input: {
  currentPrice: Numeric;
  currentEps: Numeric;
  years: number;
  scenarios: ScenarioValuationInput[];
}) {
  const currentPrice = new Decimal(input.currentPrice);
  const currentEps = new Decimal(input.currentEps);
  if (currentPrice.lte(0)) throw new Error("当前价格必须大于 0");
  const years = Math.max(1, Math.floor(input.years));
  const results: ScenarioValuationResult[] = input.scenarios.map((scenario) => {
    const futureEps = currentEps.times(new Decimal(1).plus(scenario.annualGrowth).pow(years));
    const targetPrice = futureEps.times(scenario.targetPe);
    return {
      name: scenario.name,
      futureEps: futureEps.toDecimalPlaces(6).toString(),
      targetPrice: targetPrice.toDecimalPlaces(4).toString(),
      returnPercent: targetPrice.minus(currentPrice).div(currentPrice).times(100).toDecimalPlaces(4).toString(),
      probability: scenario.probability == null ? undefined : new Decimal(scenario.probability).toString(),
    };
  });
  const withProbability = results.every((result) => result.probability != null);
  const probabilitySum = withProbability
    ? input.scenarios.reduce((sum, item) => sum.plus(item.probability ?? 0), new Decimal(0))
    : new Decimal(0);
  const weightedTargetPrice = withProbability && !probabilitySum.isZero()
    ? results.reduce((sum, result) => {
        const weight = new Decimal(result.probability ?? 0).div(probabilitySum);
        return sum.plus(new Decimal(result.targetPrice).times(weight));
      }, new Decimal(0)).toDecimalPlaces(4).toString()
    : undefined;
  return { scenarios: results, weightedTargetPrice };
}

export interface ReverseDCFResult {
  impliedGrowthRatePercent: string;
  fairPrices: Array<{ growthPercent: string; fairPrice: string; returnPercent: string }>;
}

export function calculateReverseDCF(input: {
  currentPrice: Numeric;
  currentEps: Numeric;
  years: number;
  discountRate: Numeric;
  terminalPe: Numeric;
}): ReverseDCFResult {
  const currentPrice = new Decimal(input.currentPrice);
  const currentEps = new Decimal(input.currentEps);
  if (currentPrice.lte(0)) throw new Error("当前价格必须大于 0");
  const years = Math.max(1, Math.floor(input.years));
  const discountRate = new Decimal(input.discountRate);
  const terminalPe = new Decimal(input.terminalPe);
  const discountFactor = new Decimal(1).plus(discountRate).pow(years);

  const growthRates = [0, 5, 10, 15, 20];
  const fairPrices = growthRates.map((growth) => {
    const growthDecimal = new Decimal(growth).div(100);
    const futureEps = currentEps.times(new Decimal(1).plus(growthDecimal).pow(years));
    const futurePrice = futureEps.times(terminalPe);
    const presentValue = futurePrice.div(discountFactor);
    const returnPercent = presentValue.minus(currentPrice).div(currentPrice).times(100);
    return {
      growthPercent: growth.toString(),
      fairPrice: presentValue.toDecimalPlaces(4).toString(),
      returnPercent: returnPercent.toDecimalPlaces(4).toString(),
    };
  });

  let impliedGrowth = "无法确定";
  for (let i = 0; i < fairPrices.length - 1; i++) {
    const lower = new Decimal(fairPrices[i]!.fairPrice);
    const upper = new Decimal(fairPrices[i + 1]!.fairPrice);
    const lowerIsBelow = lower.lte(currentPrice);
    const upperIsAbove = upper.gte(currentPrice);
    const lowerIsAbove = lower.gte(currentPrice);
    const upperIsBelow = upper.lte(currentPrice);
    if ((lowerIsBelow && upperIsAbove) || (lowerIsAbove && upperIsBelow)) {
      const lowerGrowth = new Decimal(fairPrices[i]!.growthPercent);
      const upperGrowth = new Decimal(fairPrices[i + 1]!.growthPercent);
      const span = upper.minus(lower);
      const ratio = span.isZero() ? new Decimal(0) : currentPrice.minus(lower).div(span);
      impliedGrowth = lowerGrowth.plus(upperGrowth.minus(lowerGrowth).times(ratio)).toDecimalPlaces(2).toString();
      break;
    }
  }

  return { impliedGrowthRatePercent: impliedGrowth, fairPrices };
}

export interface CrossValidationResult {
  status: "verified" | "warning" | "failed" | "unverified";
  consensus?: string;
  deviations: Array<{ source: string; value: string; deviationPercent: string }>;
  message: string;
}

export function crossValidate(
  values: Array<{ source: string; value: Numeric }>,
  tolerancePercent = 1,
): CrossValidationResult {
  if (values.length < 2) {
    return {
      status: "unverified",
      deviations: values.map((item) => ({ source: item.source, value: new Decimal(item.value).toString(), deviationPercent: "0" })),
      message: "至少需要两个独立来源才能完成交叉验证",
    };
  }
  const sorted = values.map((item) => new Decimal(item.value)).sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]!
    : sorted[middle - 1]!.plus(sorted[middle]!).div(2);
  const deviations = values.map((item) => {
    const value = new Decimal(item.value);
    const infinite = median.isZero() && !value.isZero();
    const deviation = median.isZero()
      ? new Decimal(0)
      : value.minus(median).abs().div(median.abs()).times(100);
    return {
      source: item.source,
      value: value.toString(),
      deviationPercent: infinite ? "Infinity" : deviation.toDecimalPlaces(4).toString(),
    };
  });
  const hasInfinite = deviations.some((item) => item.deviationPercent === "Infinity");
  const maximum = deviations.reduce((max, item) => {
    if (item.deviationPercent === "Infinity") return max;
    const current = new Decimal(item.deviationPercent);
    return current.gt(max) ? current : max;
  }, new Decimal(0));
  const status = !hasInfinite && maximum.lte(tolerancePercent)
    ? "verified"
    : !hasInfinite && maximum.lte(5) ? "warning" : "failed";
  return {
    status,
    consensus: median.toSignificantDigits(18).toString(),
    deviations,
    message: status === "verified"
      ? `两个以上来源偏差均不超过 ${tolerancePercent}%`
      : status === "warning"
        ? "来源存在口径差异，需要人工核对"
        : "来源差异超过 5%，不能作为已验证数据使用",
  };
}

export function extractResearchSources(markdown: string, accessedAt = new Date().toISOString()): ResearchSource[] {
  const found = new Map<string, ResearchSource>();
  const addSource = (urlValue: string, title?: string) => {
    const url = urlValue.replace(/[.,;]+$/, "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      found.set(url, { title: title?.trim() || parsed.hostname, url, accessedAt });
    } catch {
      // Model output can contain malformed pseudo-links. They are not sources.
    }
  };
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(markdown))) {
    addSource(match[2]!, match[1]!);
  }
  const bareUrl = /https?:\/\/[^\s)\]>]+/g;
  while ((match = bareUrl.exec(markdown))) {
    const url = match[0]!.replace(/[.,;]+$/, "");
    if (!found.has(url)) addSource(url);
  }
  return [...found.values()];
}

function extractNumericDataPoints(markdown: string): string[] {
  const points: string[] = [];
  const tableRowPattern = /\|\s*([^|]+?)\s*\|\s*([0-9][0-9,]*\.?[0-9]*\s*[%亿万元$]?)\s*\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRowPattern.exec(markdown))) {
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    if (label && value && !/^[-: ]+$/.test(label)) {
      points.push(`${label}: ${value}`);
    }
  }
  return points;
}

function parseChineseNumber(text: string): number | null {
  const cleaned = text.replace(/[,，\s]/g, "");
  const match = cleaned.match(/^([\d.]+)(万亿|亿|万|B|M|K|T|%)?$/i);
  if (!match) return null;
  const base = parseFloat(match[1]!);
  if (!Number.isFinite(base)) return null;
  const unit = match[2]?.toLowerCase();
  if (unit === "万亿" || unit === "t") return base * 1e12;
  if (unit === "亿") return base * 1e8;
  if (unit === "b") return base * 1e9;
  if (unit === "万") return base * 1e4;
  if (unit === "m") return base * 1e6;
  if (unit === "k") return base * 1e3;
  if (unit === "%") return base;
  return base;
}

interface ExtractedMetric {
  label: string;
  value: number;
  raw: string;
}

function extractMetric(markdown: string, patterns: RegExp[]): ExtractedMetric[] {
  const results: ExtractedMetric[] = [];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(markdown))) {
      const rawValue = m[1]!.trim();
      const value = parseChineseNumber(rawValue);
      if (value != null && Number.isFinite(value) && value > 0) {
        results.push({ label: pattern.source.slice(0, 20), value, raw: rawValue });
      }
    }
  }
  return results;
}

function firstValid(metrics: ExtractedMetric[]): number | undefined {
  return metrics[0]?.value;
}

export function verifyReportCalculations(
  markdown: string,
  contextPrice?: number,
): ResearchAuditCheck[] {
  const checks: ResearchAuditCheck[] = [];

  const priceMetrics = extractMetric(markdown, [
    /(?:当前股价|股价|现价|当前价格|current price|price)\s*[:：]?\s*[$￥港元]*\s*([\d,]+\.?\d*\s*(?:万亿|亿|万)?)\s*(?:港元|美元|港币|人民币|元|USD|HKD|CNY|\$|￥)?/gi,
  ]);
  const epsMetrics = extractMetric(markdown, [
    /(?:每股收益|EPS|每股盈利)\s*[:：]?\s*[$￥]*\s*([\d,]+\.?\d*)\s*(?:美元|港元|元|USD|HKD|\$|￥)?/gi,
  ]);
  const peMetrics = extractMetric(markdown, [
    /(?:PE|P\/E|市盈率)\s*[（(]?[A-Za-z]*[)）]?\s*[:：]?\s*([\d,]+\.?\d*)(?!\s*年)/gi,
  ]);
  const marketCapMetrics = extractMetric(markdown, [
    /(?:市值|总市值|market cap|market capitalization)\s*[:：]?\s*[$￥]*\s*([\d,]+\.?\d*\s*(?:万亿|亿|万|B|M|K)?)\s*(?:港元|美元|港币|人民币|元|USD|HKD|CNY|\$|￥)?/gi,
  ]);
  const sharesMetrics = extractMetric(markdown, [
    /(?:总股本|股本|shares? outstanding|total shares?)\s*[:：]?\s*([\d,]+\.?\d*\s*(?:万亿|亿|万|B|M|K)?)\s*(?:股)?/gi,
  ]);
  const dividendPerShareMetrics = extractMetric(markdown, [
    /(?:年度每股股息|全年每股股息|每股股利|每股分红|annual dividends? per share|dividends? per share)\s*[:：]?\s*[$￥]*\s*([\d,]+\.?\d*)\s*(?:美元|港元|元|USD|HKD|CNY|\$|￥)?/gi,
  ]);
  const dividendYieldMetrics = extractMetric(markdown, [
    /(?:股息率|股利收益率|dividend yield)\s*[:：]?\s*([\d,]+\.?\d*)\s*%/gi,
  ]);
  const payoutRatioMetrics = extractMetric(markdown, [
    /(?:派息率|股利支付率|股息支付率|payout ratio)\s*[:：]?\s*([\d,]+\.?\d*)\s*%/gi,
  ]);

  const price = contextPrice ?? firstValid(priceMetrics);
  const eps = firstValid(epsMetrics);
  const pe = firstValid(peMetrics);
  const marketCap = firstValid(marketCapMetrics);
  const shares = firstValid(sharesMetrics);
  const dividendPerShare = firstValid(dividendPerShareMetrics);
  const dividendYield = firstValid(dividendYieldMetrics);
  const payoutRatio = firstValid(payoutRatioMetrics);

  // 1. PE consistency: PE = price / EPS
  if (price != null && eps != null && pe != null && eps > 0) {
    try {
      const result = calculateValuation({ price, eps });
      if (result.pe) {
        const calculatedPe = new Decimal(result.pe);
        const reportedPe = new Decimal(pe);
        const deviation = calculatedPe.minus(reportedPe).abs().div(reportedPe).times(100);
        const devNum = deviation.toNumber();
        checks.push({
          id: "pe-consistency",
          label: "PE 一致性校验",
          status: devNum <= 1 ? "pass" : devNum <= 5 ? "warning" : "fail",
          detail: `报告 PE=${pe}，本地计算 price/EPS=${result.pe}（股价 ${price} / EPS ${eps}），偏差 ${devNum.toFixed(2)}%`,
        });
      }
    } catch { /* ignore calculation errors */ }
  }

  // 2. Market cap verification: MC = price × shares
  if (price != null && shares != null && marketCap != null) {
    try {
      const result = verifyMarketCap(price, shares, marketCap);
      checks.push({
        id: "marketcap-verify",
        label: "市值校验",
        status: result.status === "pass" ? "pass" : result.status === "warning" ? "warning" : "fail",
        detail: `报告市值=${marketCap}，本地计算 股价×股本=${result.calculated}，偏差 ${result.deviationPercent}%`,
      });
    } catch { /* ignore */ }
  }

  // 3. Price context check
  if (contextPrice != null && priceMetrics.length > 0) {
    const reportedPrice = priceMetrics[0]!.value;
    if (reportedPrice > 0 && contextPrice > 0) {
      const dev = Math.abs(reportedPrice - contextPrice) / contextPrice * 100;
      if (dev > 5) {
        checks.push({
          id: "price-context",
          label: "价格与上下文一致性",
          status: dev > 20 ? "fail" : "warning",
          detail: `报告提及股价 ${reportedPrice}，上下文提供价格 ${contextPrice}，偏差 ${dev.toFixed(1)}%`,
        });
      }
    }
  }

  // 4. Dividend yield consistency: annual dividend per share / price
  if (price != null && dividendPerShare != null && dividendYield != null && price > 0) {
    try {
      const calculated = new Decimal(dividendPerShare).div(price).times(100);
      const deviation = calculated.minus(dividendYield).abs().div(dividendYield).times(100).toNumber();
      checks.push({
        id: "dividend-yield-consistency",
        label: "股息率一致性校验",
        status: deviation <= 1 ? "pass" : deviation <= 5 ? "warning" : "fail",
        detail: `报告股息率=${dividendYield}%，本地计算 每股股息/股价=${calculated.toDecimalPlaces(4)}%（${dividendPerShare} / ${price}），偏差 ${deviation.toFixed(2)}%`,
      });
    } catch { /* ignore calculation errors */ }
  }

  // 5. Earnings payout consistency: annual dividend per share / EPS
  if (eps != null && dividendPerShare != null && payoutRatio != null && eps > 0) {
    try {
      const calculated = new Decimal(dividendPerShare).div(eps).times(100);
      const deviation = calculated.minus(payoutRatio).abs().div(payoutRatio).times(100).toNumber();
      checks.push({
        id: "payout-ratio-consistency",
        label: "派息率一致性校验",
        status: deviation <= 1 ? "pass" : deviation <= 5 ? "warning" : "fail",
        detail: `报告派息率=${payoutRatio}%，本地计算 每股股息/EPS=${calculated.toDecimalPlaces(4)}%（${dividendPerShare} / ${eps}），偏差 ${deviation.toFixed(2)}%`,
      });
    } catch { /* ignore calculation errors */ }
  }

  // 6. Summary check if no calculations could be verified
  if (checks.length === 0) {
    checks.push({
      id: "calc-coverage",
      label: "数值校验覆盖",
      status: "warning",
      detail: "未能从报告中提取足够的数值组件（价格/EPS/PE/市值/股本/每股股息/收益率）进行本地精确校验",
    });
  }

  return checks;
}

function targetMatcher(context: ResearchTargetContext) {
  return [context.target.name, context.target.symbol, context.target.displaySymbol]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value && value !== "top"));
}

function targetSections(markdown: string, contexts: ResearchTargetContext[]) {
  const lines = markdown.split(/\r?\n/);
  const starts = contexts.map((context) => {
    const identities = targetMatcher(context);
    const heading = lines.findIndex((line) => /^#{1,6}\s/.test(line) && identities.some((identity) => line.toLowerCase().includes(identity)));
    return { context, heading };
  });
  return starts.map((item) => {
    if (item.heading < 0) return { context: item.context, markdown: "" };
    const next = starts
      .map((candidate) => candidate.heading)
      .filter((heading) => heading > item.heading)
      .sort((a, b) => a - b)[0] ?? lines.length;
    return { context: item.context, markdown: lines.slice(item.heading, next).join("\n") };
  });
}

export function verifyTargetedReportCalculations(
  markdown: string,
  contexts: ResearchTargetContext[] | undefined,
): ResearchAuditCheck[] {
  if (!contexts?.length) return verifyReportCalculations(markdown);
  if (contexts.length === 1) return verifyReportCalculations(markdown, contexts[0]!.target.currentPrice);
  return targetSections(markdown, contexts).flatMap(({ context, markdown: section }) => {
    const label = context.target.name || context.target.symbol;
    if (!section) {
      return [{
        id: `target-coverage-${context.target.market}-${context.target.symbol}`,
        label: `${label}审计覆盖`,
        status: "warning" as const,
        detail: `未能在最终报告中识别 ${label} 的独立章节，未执行跨公司数值拼接。`,
      }];
    }
    return verifyReportCalculations(section, context.target.currentPrice).map((check) => ({
      ...check,
      id: `${context.target.market}-${context.target.symbol}-${check.id}`,
      label: `${label} · ${check.label}`,
    }));
  });
}

export function auditResearchReport(input: {
  markdown: string;
  dataCutoff: string;
  sources?: ResearchSource[];
  webSearch?: ResearchWebSearchTrace;
  professionalData?: ResearchProfessionalDataTrace;
  calculationChecks?: ResearchAuditCheck[];
  publicContext?: PublicResearchContext;
  modelReview?: ResearchModelAuditResult;
}): ResearchAuditResult {
  const sources = input.sources?.length ? input.sources : extractResearchSources(input.markdown);
  const publisherKey = (source: ResearchSource) => {
    try {
      const host = new URL(source.url).hostname.toLowerCase().replace(/^www\./, "");
      const parts = host.split(".").filter(Boolean);
      const compoundSuffix = /^(?:co|com|org|net|gov|edu)\.(?:uk|cn|jp|au|hk)$/.test(parts.slice(-2).join("."));
      return parts.slice(-(compoundSuffix ? 3 : 2)).join(".") || host;
    } catch {
      return source.url;
    }
  };
  const independentSourceCount = new Set(sources.map(publisherKey)).size;
  const dataPoints = extractNumericDataPoints(input.markdown);
  const sampleSize = Math.max(1, Math.ceil(dataPoints.length * 0.15));
  // Stable ordering keeps an audit reproducible for the same report.
  const sampled = [...dataPoints]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .slice(0, Math.min(sampleSize, dataPoints.length));
  const structuredSourceCount = input.webSearch?.sources.length ?? sources.filter((source) => source.origin === "provider").length;
  const webSearchCheck: ResearchAuditCheck = !input.webSearch?.requested
    ? {
      id: "web-search",
      label: "联网检索",
      status: "warning",
      detail: "本次研究未请求联网；时效性事实需要人工复核",
    }
    : input.webSearch.phase === "completed" && structuredSourceCount > 0
      ? {
        id: "web-search",
        label: "联网检索",
        status: "pass",
        detail: `已验证实际联网，并取得 ${structuredSourceCount} 个结构化来源`,
      }
      : {
        id: "web-search",
        label: "联网检索",
        status: "fail",
        detail: input.webSearch.errors[0] || "已请求联网，但没有取得可验证的搜索事件或结构化引用",
      };
  const dataStatusCheck: ResearchAuditCheck | null = input.publicContext?.dataStatus
    ? {
        id: "market-data-coverage",
        label: "本地必需数据覆盖",
        status: input.publicContext.dataStatus.status === "complete"
          ? "pass"
          : input.publicContext.dataStatus.status === "failed" ? "fail" : "warning",
        detail: input.publicContext.dataStatus.status === "complete"
          ? `${input.publicContext.dataStatus.targetCount} 个标的满足当前研究模式的必需数据规则`
          : `${input.publicContext.dataStatus.completeTargets}/${input.publicContext.dataStatus.targetCount} 个标的满足必需数据规则；${input.publicContext.dataStatus.warnings.slice(0, 3).join("；") || "存在必需数据缺口"}`,
      }
    : null;
  const professionalReferences = [...input.markdown.matchAll(/\[D(\d+)\]/gi)].map((match) => Number(match[1]));
  const invalidProfessionalReferences = input.professionalData
    ? professionalReferences.filter((index) => !Number.isInteger(index) || index < 1 || index > input.professionalData!.items.length)
    : professionalReferences;
  const professionalDataCheck: ResearchAuditCheck | null = input.professionalData?.requested
    ? {
        id: "professional-data",
        label: "方舟专业数据集",
        status: invalidProfessionalReferences.length
          ? "fail"
          : input.professionalData.items.length && professionalReferences.length
            ? input.professionalData.status === "completed" ? "pass" : "warning"
            : "warning",
        detail: invalidProfessionalReferences.length
          ? `报告引用了不存在的专业数据编号：${[...new Set(invalidProfessionalReferences)].map((index) => `[D${index}]`).join("、")}`
          : input.professionalData.items.length && professionalReferences.length
            ? `已调用 ${input.professionalData.queries.length} 条查询、取得 ${input.professionalData.items.length} 组专业数据，并核对 ${new Set(professionalReferences).size} 个 [D…] 引用；类型：${input.professionalData.datasetTypes.join("、") || "由服务端自动路由"}`
            : input.professionalData.items.length
              ? `已取得 ${input.professionalData.items.length} 组专业数据，但报告正文未使用 [D…] 编号引用`
          : `已尝试调用专业数据集，但未取得可用结果：${input.professionalData.errors[0] || "无返回内容"}`,
      }
    : null;
  const checks: ResearchAuditCheck[] = [
    {
      id: "data-cutoff",
      label: "数据截止时间",
      status: input.markdown.includes(input.dataCutoff) ? "pass" : "warning",
      detail: input.markdown.includes(input.dataCutoff) ? `已标注 ${input.dataCutoff}` : "报告正文未明确重复标注数据截止时间",
    },
    webSearchCheck,
    ...(dataStatusCheck ? [dataStatusCheck] : []),
    ...(professionalDataCheck ? [professionalDataCheck] : []),
    {
      id: "source-count",
      label: "正文引用来源",
      status: independentSourceCount >= 2 ? "pass" : "warning",
      detail: independentSourceCount >= 2
        ? `报告正文引用 ${sources.length} 个链接，来自 ${independentSourceCount} 个独立发布域`
        : "报告正文引用不足两个独立发布域；即使检索已成功，关键事实仍不能视为完成交叉验证",
    },
    {
      id: "two-sided",
      label: "正反论证",
      status: /(看多|优势|bull)/i.test(input.markdown) && /(看空|风险|bear)/i.test(input.markdown) ? "pass" : "warning",
      detail: "检查报告是否同时包含支持与反对投资的证据",
    },
    {
      id: "limitations",
      label: "研究局限",
      status: /(局限|不确定|数据不足|不构成投资建议|limitations?|uncertain|data gaps?|not investment advice)/i.test(input.markdown) ? "pass" : "warning",
      detail: "检查报告是否披露数据与模型局限",
    },
    {
      id: "sampled-data",
      label: "抽样数据点",
      status: sampled.length > 0 ? "pass" : "warning",
      detail: sampled.length > 0
        ? `已按固定规则抽取 ${sampled.length}/${dataPoints.length} 个数据点供人工复核：${sampled.slice(0, 5).join("; ")}${sampled.length > 5 ? " ..." : ""}`
        : "未识别到表格数值数据点",
    },
    ...(input.calculationChecks ?? []),
    ...(input.modelReview ? [{
      id: "model-review",
      label: input.modelReview.independent ? "独立模型复核" : "同模型复核",
      status: input.modelReview.status === "pass" && input.modelReview.independent
        ? "pass" as const
        : input.modelReview.status === "fail" ? "fail" as const : "warning" as const,
      detail: `${input.modelReview.model} · ${input.modelReview.summary}${input.modelReview.independent ? "" : "；审计模型与写作模型相同，独立性较弱"}`,
    }] : []),
  ];
  const hasFailure = checks.some((check) => check.status === "fail");
  const allPassed = checks.every((check) => check.status === "pass");
  const status = hasFailure
    ? "failed"
    : allPassed && (input.calculationChecks?.length ?? 0) > 0
      ? "verified"
      : independentSourceCount >= 2 ? "partial" : "unverified";
  return {
    status,
    checkedAt: new Date().toISOString(),
    sourceCount: independentSourceCount,
    checks,
    modelReview: input.modelReview,
    note: status === "verified"
      ? "结构、来源和本地精确计算检查均通过；外部来源内容仍应由投资者独立复核。"
      : status === "partial"
        ? input.modelReview?.status !== "unavailable"
          ? `本地规则检查与${input.modelReview?.independent ? "独立" : "同"}模型复核已完成；模型只核对报告及已提供证据，不代表逐页打开外部网页。`
          : input.modelReview
            ? "本地规则检查已完成，但模型复核未完成；报告仍需人工复核关键主张。"
          : "本地规则与计算检查已完成；未配置审计模型，外部来源内容未逐条做语义复核。"
        : status === "failed"
          ? "存在明确失败项，报告不能标记为可用。"
          : "来源或校验信息不足，报告仅可作为研究线索。",
  };
}

export function firstReportSummary(markdown: string) {
  const lines = markdown.split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^>\s*/, "").trim())
    .filter((line) => line && !line.startsWith("|") && !/^[-:| ]+$/.test(line));
  return (lines.find((line) => line.length >= 20) ?? lines[0] ?? "研究报告已生成").slice(0, 240);
}
