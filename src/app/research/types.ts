export type ResearchWorkflowId =
  | "quick_check"
  | "news_pulse"
  | "investment_research"
  | "deep_research"
  | "deep_company_series"
  | "backtest_interpretation"
  | "earnings_review"
  | "earnings_team"
  | "portfolio_review"
  | "thesis_tracker"
  | "thesis_drift"
  | "dyp_ask"
  | "industry_research"
  | "industry_funnel"
  | "quality_screen"
  | "bottleneck_hunter"
  | "management_deep_dive"
  | "private_company_research"
  | "income_investment"
  | "wechat_article"
  | "financial_data";

export type ResearchAgentId =
  | "quick-check"
  | "news-pulse"
  | "investment-researcher"
  | "business-analyst"
  | "financial-analyst"
  | "industry-researcher"
  | "risk-assessor"
  | "backtest-analyst"
  | "synthesis"
  | "earnings-reviewer"
  | "portfolio-reviewer"
  | "thesis-tracker"
  | "thesis-drift"
  | "dyp-ask"
  | "industry-panorama"
  | "industry-funnel"
  | "quality-screener"
  | "bottleneck-hunter"
  | "management-analyst"
  | "income-analyst"
  | "private-business"
  | "private-financial"
  | "private-competitive"
  | "private-risk"
  | "earnings-business"
  | "earnings-financial"
  | "earnings-industry"
  | "earnings-risk"
  | "wechat-researcher"
  | "wechat-writer"
  | "wechat-editor"
  | "wechat-reader"
  | "financial-data-auditor"
  | "series-researcher"
  | "series-writer";

export interface IncomeInvestmentContext {
  mode: "new" | "existing";
  role: "core-income" | "opportunistic-income" | "unspecified";
  targetYield?: string;
  taxResidence?: string;
  horizon?: string;
}

export type ResearchJobStatus =
  | "draft"
  | "preparing"
  | "running"
  | "synthesizing"
  | "auditing"
  | "paused"
  | "cancelled"
  | "failed"
  | "completed";

export type ResearchAuditStatus =
  | "verified"
  | "partial"
  | "unverified"
  | "failed";

export interface ResearchTarget {
  symbol: string;
  yahooSymbol?: string;
  displaySymbol?: string;
  name: string;
  market: string;
  exchange?: string;
  assetType: string;
  currency: string;
  currentPrice?: number;
  dailyChangePercent?: number;
  holdingId?: string;
}

export interface ResearchPricePoint {
  date: string;
  price: number;
  volume?: number;
  source?: string;
  adjustmentMode?: "adjusted" | "unadjusted" | "unknown";
}

export interface ResearchCorporateAction {
  date: string;
  type: string;
  description?: string;
  amount?: number;
  ratio?: number;
}

export interface ResearchFundamentals {
  marketCap?: number;
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
  currency?: string;
}

export interface ResearchEnrichedData {
  companyProfile?: {
    sector?: string;
    industry?: string;
    description?: string;
    website?: string;
    employees?: number;
    country?: string;
  };
  keyStats?: {
    enterpriseValue?: number;
    evToRevenue?: number;
    evToEbitda?: number;
    pegRatio?: number;
    beta?: number;
    priceToBook?: number;
    profitMargins?: number;
    grossMargins?: number;
    operatingMargins?: number;
    ebitdaMargins?: number;
    returnOnEquity?: number;
    returnOnAssets?: number;
    debtToEquity?: number;
    currentRatio?: number;
    quickRatio?: number;
    totalCash?: number;
    totalDebt?: number;
    revenueGrowth?: number;
    earningsGrowth?: number;
  };
  analystData?: {
    targetHigh?: number;
    targetLow?: number;
    targetMean?: number;
    strongBuy?: number;
    buy?: number;
    hold?: number;
    sell?: number;
    strongSell?: number;
  };
  financialStatements?: {
    income?: Array<{
      year?: string;
      totalRevenue?: number;
      grossProfit?: number;
      operatingIncome?: number;
      netIncome?: number;
      ebitda?: number;
      researchAndDevelopment?: number;
    }>;
    balanceSheet?: Array<{
      year?: string;
      totalAssets?: number;
      totalLiabilities?: number;
      stockholdersEquity?: number;
      totalCash?: number;
      totalDebt?: number;
    }>;
    cashFlow?: Array<{
      year?: string;
      operatingCashFlow?: number;
      capitalExpenditures?: number;
      freeCashFlow?: number;
    }>;
  };
  /** 10+ years of annual financial metrics from SEC EDGAR (US stocks, deep research only) */
  secAnnualMetrics?: SecAnnualMetrics;
  calendarEvents?: {
    nextEarningsDate?: string;
    exDividendDate?: string;
    dividendDate?: string;
  };
  marketStatus?: {
    isOpen: boolean;
    closureReason?: string;
  };
}

export type ResearchDatasetKind =
  | "quote"
  | "price_history"
  | "corporate_actions"
  | "fundamentals"
  | "company_profile"
  | "financial_statements"
  | "analyst_data"
  | "calendar_events"
  | "sec_filings"
  | "market_status";

export type ResearchDatasetStatus = "success" | "partial" | "failed" | "timeout" | "cancelled" | "not_applicable";

export interface ResearchDataProvenance {
  dataset: ResearchDatasetKind;
  status: ResearchDatasetStatus;
  provider: string;
  requestedAt: string;
  completedAt: string;
  dataDate?: string;
  /** Human-verifiable landing page or API URL for the upstream dataset. */
  sourceUrl?: string;
  /** Currency/unit metadata for numeric facts when the upstream exposes it. */
  currency?: string;
  unit?: string;
  freshness?: "live" | "delayed" | "cached" | "unknown";
  ageDays?: number;
  stale?: boolean;
  adjustmentMode?: "adjusted" | "unadjusted" | "unknown";
  requirement?: "required" | "optional" | "not_applicable";
  requirementGroup?: string;
  error?: string;
}

export interface ResearchTargetContext {
  target: ResearchTarget;
  status: "complete" | "partial" | "failed";
  recentPrices?: ResearchPricePoint[];
  corporateActions?: ResearchCorporateAction[];
  fundamentals?: ResearchFundamentals;
  enrichedData?: ResearchEnrichedData;
  provenance: ResearchDataProvenance[];
}

export interface ResearchDataStatusSummary {
  status: "complete" | "partial" | "failed";
  targetCount: number;
  completeTargets: number;
  partialTargets: number;
  failedTargets: number;
  warnings: string[];
  optionalNotes?: string[];
}

/** Multi-year annual financial metrics from SEC EDGAR (US stocks) */
export interface SecAnnualMetrics {
  symbol: string;
  cik: string;
  /** Fiscal year -> metrics */
  years: Array<{
    fiscalYear?: number;
    revenue?: number;
    netIncome?: number;
    eps?: number;
    totalAssets?: number;
    totalLiabilities?: number;
    stockholdersEquity?: number;
    cashAndEquivalents?: number;
    operatingCashFlow?: number;
    capitalExpenditures?: number;
    freeCashFlow?: number;
    grossProfit?: number;
    operatingIncome?: number;
    researchAndDevelopment?: number;
    dividendsPaid?: number;
  }>;
}

export interface PublicResearchContext {
  target: ResearchTarget;
  targets?: ResearchTarget[];
  targetContexts?: ResearchTargetContext[];
  generatedAt: string;
  dataCutoff: string;
  dataStatus?: ResearchDataStatusSummary;
  recentPrices?: ResearchPricePoint[];
  corporateActions?: ResearchCorporateAction[];
  fundamentals?: ResearchFundamentals;
  enrichedData?: ResearchEnrichedData;
}

export interface PrivateHoldingContext {
  quantity?: number;
  costPrice?: number;
  marketValue?: number;
  currency?: string;
  baseCurrency?: string;
  fxRateToBase?: number;
  costBasisInBase?: number;
  marketValueInBase?: number;
  unrealizedPnlRate?: number;
  portfolioWeight?: number;
  dcaSummary?: string;
  cashDividendTotal?: number;
  dividendReinvest?: boolean;
  transactionCostProfile?: {
    buyFeeRate?: number;
    sellFeeRate?: number;
    minimumFee?: number;
    buyTaxRate?: number;
    sellTaxRate?: number;
    dividendTaxRate?: number;
  };
  recentCorporateActions?: Array<{
    type: string;
    date: string;
    amount?: number;
    shares?: number;
    ratio?: number;
    price?: number;
    source?: string;
  }>;
}

export interface BacktestResearchContext {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  strategy: string;
  startDate: string;
  endDate: string;
  totalPnl: number;
  totalInvested: number;
  finalValue: number;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  totalFees: number;
  totalTaxes: number;
  totalDividends?: number;
  tradeCount: number;
  benchmarkLabel?: string;
  benchmarkReturn?: number;
  benchmarkAnnualizedReturn?: number;
  benchmarkMaxDrawdown?: number;
  monthlyReturns?: Array<{ month: string; returnRate: number }>;
}

export interface PortfolioHoldingSummary {
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  currency?: string;
  baseCurrency?: string;
  fxRateToBase?: number;
  quantity?: number;
  costPrice?: number;
  currentPrice?: number;
  marketValue?: number;
  costBasisInBase?: number;
  marketValueInBase?: number;
  unrealizedPnlRate?: number;
  portfolioWeight?: number;
}

export interface PortfolioResearchContext {
  holdings: PortfolioHoldingSummary[];
  totalAsset?: number;
  totalCost?: number;
  totalUnrealizedPnl?: number;
  totalUnrealizedPnlRate?: number;
  currency?: string;
  baseCurrency?: string;
  currencies?: string[];
  weightTotal?: number;
  realizedPnl?: number;
  realizedTradingPnl?: number;
  dividendPnl?: number;
  feePnl?: number;
}

export interface ThesisDriftContext {
  olderReport: { id: string; createdAt: string; markdown: string };
  newerReport: { id: string; createdAt: string; markdown: string };
}

export interface ResearchSource {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt: string;
  origin?: "provider" | "external_search" | "model_output";
  query?: string;
  snippet?: string;
}

export interface ResearchSearchResult extends ResearchSource {
  score?: number;
  content?: string;
}

export interface ResearchProfessionalDataItem {
  query: string;
  datasetType: string;
  content: string;
}

export interface ResearchProfessionalDataTrace {
  requested: boolean;
  status: "not_requested" | "completed" | "partial" | "failed";
  providerId?: string;
  providerName?: string;
  endpoint: string;
  queriedAt?: string;
  queries: string[];
  datasetTypes: string[];
  items: ResearchProfessionalDataItem[];
  errors: string[];
}

export type ResearchWebSearchPhase =
  | "not_requested"
  | "requested"
  | "searching"
  | "completed"
  | "unverified"
  | "failed";

export interface ResearchWebSearchTrace {
  requested: boolean;
  supported: boolean;
  phase: ResearchWebSearchPhase;
  provider: ResearchProviderPreset;
  protocol: ResearchApiProtocol;
  model?: string;
  method?: "native" | "external" | "hybrid";
  externalProvider?: ResearchExternalSearchProvider;
  queries: string[];
  sources: ResearchSource[];
  errors: string[];
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentResult {
  agentId: ResearchAgentId;
  title: string;
  content: string;
  completedAt: string;
  sources: ResearchSource[];
  usage?: ModelUsage;
  model?: string;
  providerId?: string;
  providerName?: string;
  webSearch?: ResearchWebSearchTrace;
  professionalData?: ResearchProfessionalDataTrace;
}

export interface ResearchAuditCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface ResearchModelAuditFinding {
  severity: "info" | "warning" | "critical";
  category: "citation" | "calculation" | "consistency" | "reasoning" | "coverage";
  detail: string;
  evidence?: string;
}

export interface ResearchModelAuditResult {
  status: "pass" | "warning" | "fail" | "unavailable";
  model: string;
  providerId?: string;
  providerName?: string;
  checkedAt: string;
  independent: boolean;
  summary: string;
  checkedClaims: number;
  verifiedClaims: number;
  findings: ResearchModelAuditFinding[];
}

export interface ResearchAuditResult {
  status: ResearchAuditStatus;
  checkedAt: string;
  sourceCount: number;
  checks: ResearchAuditCheck[];
  note: string;
  modelReview?: ResearchModelAuditResult;
}

export interface ResearchReport {
  id: string;
  jobId: string;
  workflowId: ResearchWorkflowId;
  workflowVersion: string;
  target: ResearchTarget;
  targets?: ResearchTarget[];
  title: string;
  summary: string;
  markdown: string;
  agentResults?: AgentResult[];
  createdAt: string;
  updatedAt: string;
  dataCutoff: string;
  dataStatus?: ResearchDataStatusSummary;
  targetContexts?: ResearchTargetContext[];
  sources: ResearchSource[];
  webSearch?: ResearchWebSearchTrace;
  professionalData?: ResearchProfessionalDataTrace;
  audit: ResearchAuditResult;
  backtestContext?: BacktestResearchContext;
  privateContextIncluded: boolean;
  providerRoute?: ResearchProviderRouteSnapshot;
}

export interface ResearchJobError {
  code:
    | "auth"
    | "permission"
    | "cors"
    | "rate_limit"
    | "network"
    | "invalid_response"
    | "cancelled"
    | "unknown";
  message: string;
  retryable: boolean;
  agentId?: ResearchAgentId;
}

export interface ResearchJob {
  id: string;
  workflowId: ResearchWorkflowId;
  workflowVersion: string;
  outputLanguage: "zh" | "en";
  target: ResearchTarget;
  targets?: ResearchTarget[];
  status: ResearchJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  currentStep?: ResearchAgentId;
  completedSteps: ResearchAgentId[];
  pendingSteps: ResearchAgentId[];
  agentResults: AgentResult[];
  reportId?: string;
  error?: ResearchJobError;
  publicContext: PublicResearchContext;
  privateContext?: PrivateHoldingContext;
  backtestContext?: BacktestResearchContext;
  portfolioContext?: PortfolioResearchContext;
  thesisDriftContext?: ThesisDriftContext;
  incomeInvestmentContext?: IncomeInvestmentContext;
  topic?: string;
  period?: string;
  providerRoute?: ResearchProviderRouteSnapshot;
}

export type ResearchWebSearchMode = "off" | "native" | "auto" | "external";
export type ResearchExternalSearchProvider = "tavily" | "brave" | "exa" | "volcengine_search" | "custom";
export type ResearchSearchTimeRange = "any" | "day" | "week" | "month" | "year";
export type ResearchApiProtocol =
  | "chat_completions"
  | "responses"
  | "anthropic_messages"
  | "gemini_native"
  | "ollama_chat";
export type ResearchAuthMode =
  | "bearer"
  | "x_api_key"
  | "x_google_api_key"
  | "none"
  | "custom_header";
export type ResearchThinkingLevel =
  | "auto"
  | "off"
  | "enabled"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ResearchProviderPreset =
  | "openai"
  | "anthropic"
  | "xai"
  | "volcengine_ark"
  | "volcengine_agent_plan"
  | "deepseek"
  | "alibaba_qwen"
  | "zhipu"
  | "moonshot"
  | "minimax"
  | "siliconflow"
  | "openrouter"
  | "google_gemini"
  | "groq"
  | "mistral"
  | "perplexity"
  | "ollama"
  | "lm_studio"
  | "custom";

export interface ResearchModelDefinition {
  id: string;
  name: string;
  reasoning?: {
    supportedEfforts?: ResearchThinkingLevel[];
    defaultEffort?: ResearchThinkingLevel;
    mandatory?: boolean;
    supportsMaxTokens?: boolean;
  };
}

export interface ResearchProviderSettings {
  id: string;
  name: string;
  preset: ResearchProviderPreset;
  protocol: ResearchApiProtocol;
  authMode: ResearchAuthMode;
  authHeaderName: string;
  authHeaderPrefix: string;
  endpoint: string;
  apiKey: string;
  saveApiKey: boolean;
  models: ResearchModelDefinition[];
  /** Main model used by full research agents. */
  model: string;
  /** Optional lower-cost model used by lightweight workflows. */
  fastModel: string;
  /** Optional model dedicated to merging multi-agent results. */
  synthesisModel: string;
  /** Optional model used for an independent report review. */
  auditModel: string;
  webSearchMode: ResearchWebSearchMode;
  nativeWebSearchVerification?: {
    model: string;
    protocol: ResearchApiProtocol;
    status: "verified" | "failed";
    checkedAt: string;
    message: string;
  };
  thinkingLevel: ResearchThinkingLevel;
  maxConcurrency: 1 | 2 | 3 | 4;
  maxOutputTokens: number;
  requestTimeoutSeconds: number;
}

export interface StoredResearchProviderSettings extends Omit<ResearchProviderSettings, "apiKey"> {
  hasSavedApiKey: boolean;
}

export interface ResearchExternalSearchSettings {
  id: string;
  name: string;
  provider: ResearchExternalSearchProvider;
  endpoint: string;
  apiKey: string;
  saveApiKey: boolean;
  authHeaderName: string;
  authHeaderPrefix: string;
  maxResults: number;
  maxSources: number;
  timeRange: ResearchSearchTimeRange;
  includeDomains: string;
  excludeDomains: string;
  fetchPageContent: boolean;
  maxPages: number;
  requestTimeoutSeconds: number;
  /** Mapping used only by the custom search adapter. */
  customRequestMethod?: "GET" | "POST";
  customQueryField?: string;
  customLimitField?: string;
  customResultsPath?: string;
  customTitlePath?: string;
  customUrlPath?: string;
  customSnippetPath?: string;
  customContentPath?: string;
  customPublishedAtPath?: string;
}

export interface StoredResearchExternalSearchSettings extends Omit<ResearchExternalSearchSettings, "apiKey"> {
  hasSavedApiKey: boolean;
}

export interface ResearchExternalSearchCollection {
  activeProfileId: string;
  profiles: ResearchExternalSearchSettings[];
}

export interface ResearchProviderCollection {
  activeProfileId: string;
  profiles: ResearchProviderSettings[];
  workflowRoutes?: Partial<Record<ResearchWorkflowId, ResearchWorkflowProviderRoute>>;
}

export type ResearchExecutionModelRole = "auto" | "main" | "fast";

export interface ResearchWorkflowProviderRoute {
  /** Empty/undefined follows the collection-wide default connection. */
  executionProfileId?: string;
  /** Auto follows workflow complexity; main/fast explicitly override it. */
  executionModelRole?: ResearchExecutionModelRole;
  /** Empty/undefined follows the execution connection. */
  synthesisProfileId?: string;
  /** Empty/undefined follows execution; auditDisabled explicitly turns model review off. */
  auditProfileId?: string;
  auditDisabled?: boolean;
  /** Empty/undefined automatically selects the routed/default Agent Plan connection. */
  professionalDataProfileId?: string;
}

export interface ResearchProviderRouteSnapshot {
  execution: { profileId: string; profileName: string; model?: string; modelRole?: ResearchExecutionModelRole };
  synthesis?: { profileId: string; profileName: string; model?: string };
  audit?: { profileId: string; profileName: string; model?: string };
  professionalData?: { profileId: string; profileName: string };
  auditDisabled?: boolean;
}

export interface ResearchRunProviderRouting {
  execution: ResearchProviderSettings;
  executionModel?: string;
  executionModelRole?: ResearchExecutionModelRole;
  synthesis: ResearchProviderSettings;
  synthesisModel?: string;
  audit?: ResearchProviderSettings;
  auditModel?: string;
  professionalData?: ResearchProviderSettings;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRunRequest {
  messages: ModelMessage[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  enableWebSearch?: boolean;
  continueOnWebSearchFailure?: boolean;
  /** Override the provider's thinking level for this request (e.g. "off" for
   * structured-output audits that should not burn tokens on reasoning). */
  thinkingLevel?: ResearchThinkingLevel;
}

export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: ModelUsage }
  | {
    type: "web_search";
    phase: Exclude<ResearchWebSearchPhase, "not_requested">;
    query?: string;
    sources?: ResearchSource[];
    error?: string;
  }
  | { type: "done" };

export interface ResearchProgressEvent {
  job: ResearchJob;
  message: string;
  delta?: string;
}

export interface ResearchRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: ResearchProgressEvent) => void;
  externalSearchSettings?: ResearchExternalSearchSettings;
}

export interface BacktestSeed {
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  strategy?: "lump_sum" | "monthly_dca" | "weekly_dca" | "daily_dca";
}
