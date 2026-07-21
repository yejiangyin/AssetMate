import type { ResearchAgentId, ResearchWorkflowId } from "../types";

export type WorkflowCategory = "deep" | "earnings" | "industry" | "portfolio" | "tools" | "assetmate";

export interface WorkflowConfig {
  id: ResearchWorkflowId;
  category: WorkflowCategory;
  agentIds: ResearchAgentId[];
  needsSynthesis: boolean;
  useFullModel: boolean;
  parallel: boolean;
  needsPortfolioContext?: boolean;
  needsReportLibrary?: boolean;
  needsTopicInput?: boolean;
  needsPeriodInput?: boolean;
  needsIncomeInputs?: boolean;
  supportsMultipleTargets?: boolean;
  supportsTopicAlternative?: boolean;
  minTargets?: number;
  maxTargets?: number;
  executionGroups?: ResearchAgentId[][];
  canonicalSkill?: string;
  origin?: "ai-berkshire" | "assetmate";
  titles: { zh: string; en: string };
  descriptions: { zh: string; en: string };
  calls: string;
}

export const WORKFLOW_REGISTRY: Record<ResearchWorkflowId, WorkflowConfig> = {
  quick_check: {
    id: "quick_check",
    category: "industry",
    agentIds: ["quick-check"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    supportsMultipleTargets: true,
    minTargets: 1,
    maxTargets: 5,
    canonicalSkill: "investment-checklist",
    titles: { zh: "快速检查", en: "Quick Check" },
    descriptions: { zh: "单个或多个标的执行六关 Checklist", en: "Six-gate checklist for one or more targets" },
    calls: "1",
  },
  news_pulse: {
    id: "news_pulse",
    category: "portfolio",
    agentIds: ["news-pulse"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    canonicalSkill: "news-pulse",
    titles: { zh: "异动归因", en: "News Pulse" },
    descriptions: { zh: "区分价值事件与情绪波动", en: "Explain a recent price move" },
    calls: "1",
  },
  dyp_ask: {
    id: "dyp_ask",
    category: "tools",
    agentIds: ["dyp-ask"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    needsTopicInput: true,
    canonicalSkill: "dyp-ask",
    titles: { zh: "段永平问答", en: "Dyp Ask" },
    descriptions: { zh: "以段永平的方式思考任何问题", en: "Think through problems like Duan Yongping" },
    calls: "1",
  },
  investment_research: {
    id: "investment_research",
    category: "deep",
    agentIds: ["investment-researcher"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    canonicalSkill: "investment-research",
    titles: { zh: "综合深研", en: "Investment Research" },
    descriptions: { zh: "四大师七模块综合分析，一次生成完整报告", en: "Four-master, seven-module complete report" },
    calls: "1",
  },
  deep_research: {
    id: "deep_research",
    category: "deep",
    agentIds: ["business-analyst", "financial-analyst", "industry-researcher", "risk-assessor", "synthesis"],
    needsSynthesis: true,
    useFullModel: true,
    parallel: true,
    canonicalSkill: "investment-team",
    titles: { zh: "投研团队", en: "Investment Team" },
    descriptions: { zh: "四角色并行独立研究后综合", en: "Four independent agents + synthesis" },
    calls: "5",
  },
  deep_company_series: {
    id: "deep_company_series",
    category: "deep",
    agentIds: ["series-researcher", "series-writer", "synthesis"],
    needsSynthesis: true,
    useFullModel: true,
    parallel: false,
    executionGroups: [["series-researcher"], ["series-writer"]],
    needsTopicInput: true,
    canonicalSkill: "deep-company-series",
    titles: { zh: "深度公司系列", en: "Deep Company Series" },
    descriptions: { zh: "先建事实底稿，再写 3–8 篇一致的深度系列", en: "Fact base followed by a consistent 3–8 article series" },
    calls: "3",
  },
  management_deep_dive: {
    id: "management_deep_dive",
    category: "deep",
    agentIds: ["management-analyst"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    canonicalSkill: "management-deep-dive",
    titles: { zh: "管理层纵深", en: "Management Deep Dive" },
    descriptions: { zh: "诚信一票否决，承诺兑现跟踪", en: "Integrity veto, promise-delivery tracking" },
    calls: "1",
  },
  private_company_research: {
    id: "private_company_research",
    category: "deep",
    agentIds: ["private-business", "private-financial", "private-competitive", "private-risk", "synthesis"],
    needsSynthesis: true,
    useFullModel: true,
    parallel: true,
    needsTopicInput: true,
    canonicalSkill: "private-company-research",
    titles: { zh: "未上市公司研究", en: "Private Company Research" },
    descriptions: { zh: "侦探式拼凑，每数据点带置信度", en: "Detective-style, confidence-tagged data" },
    calls: "5",
  },
  income_investment: {
    id: "income_investment",
    category: "portfolio",
    agentIds: ["income-analyst"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    needsIncomeInputs: true,
    canonicalSkill: "income-investment",
    titles: { zh: "收益型投资", en: "Income Investment" },
    descriptions: { zh: "股息耐久性、收益陷阱与组合角色", en: "Dividend durability, yield traps and portfolio role" },
    calls: "1",
  },
  earnings_review: {
    id: "earnings_review",
    category: "earnings",
    agentIds: ["earnings-reviewer"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    needsPeriodInput: true,
    canonicalSkill: "earnings-review",
    titles: { zh: "财报精读", en: "Earnings Review" },
    descriptions: { zh: "只读一手财报，beat/meet/miss 判定", en: "Primary-source earnings deep read" },
    calls: "1",
  },
  earnings_team: {
    id: "earnings_team",
    category: "earnings",
    agentIds: ["earnings-business", "earnings-financial", "earnings-industry", "earnings-risk", "synthesis"],
    needsSynthesis: true,
    useFullModel: true,
    parallel: true,
    needsPeriodInput: true,
    canonicalSkill: "earnings-team",
    titles: { zh: "财报团队", en: "Earnings Team" },
    descriptions: { zh: "四大师并行解读财报后综合", en: "Four masters decode earnings in parallel" },
    calls: "5",
  },
  industry_research: {
    id: "industry_research",
    category: "industry",
    agentIds: ["industry-panorama"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    needsTopicInput: true,
    canonicalSkill: "industry-research",
    titles: { zh: "产业链全景", en: "Industry Research" },
    descriptions: { zh: "按产业链环节切片扫描", en: "Industry chain panorama scan" },
    calls: "1",
  },
  industry_funnel: {
    id: "industry_funnel",
    category: "industry",
    agentIds: ["industry-funnel"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    needsTopicInput: true,
    canonicalSkill: "industry-funnel",
    titles: { zh: "漏斗筛选", en: "Industry Funnel" },
    descriptions: { zh: "全市场→10→3 家漏斗", en: "Market → 10 → 3 funnel" },
    calls: "1",
  },
  quality_screen: {
    id: "quality_screen",
    category: "industry",
    agentIds: ["quality-screener"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    supportsMultipleTargets: true,
    supportsTopicAlternative: true,
    minTargets: 1,
    maxTargets: 5,
    canonicalSkill: "quality-screen",
    titles: { zh: "去劣筛选", en: "Quality Screen" },
    descriptions: { zh: "个股或行业/指数/主题的 7 指标筛选", en: "7-factor screen for targets or a wider scope" },
    calls: "1",
  },
  bottleneck_hunter: {
    id: "bottleneck_hunter",
    category: "industry",
    agentIds: ["bottleneck-hunter"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    needsTopicInput: true,
    canonicalSkill: "bottleneck-hunter",
    titles: { zh: "瓶颈猎手", en: "Bottleneck Hunter" },
    descriptions: { zh: "超级趋势找物理瓶颈公司", en: "Find physical bottleneck companies" },
    calls: "1",
  },
  portfolio_review: {
    id: "portfolio_review",
    category: "portfolio",
    agentIds: ["portfolio-reviewer"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    needsPortfolioContext: true,
    canonicalSkill: "portfolio-review",
    titles: { zh: "组合管理", en: "Portfolio Review" },
    descriptions: { zh: "仓位/集中度/压力测试/再平衡", en: "Sizing, stress test, rebalancing" },
    calls: "1",
  },
  thesis_tracker: {
    id: "thesis_tracker",
    category: "portfolio",
    agentIds: ["thesis-tracker"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    needsReportLibrary: true,
    canonicalSkill: "thesis-tracker",
    titles: { zh: "论文追踪", en: "Thesis Tracker" },
    descriptions: { zh: "建立/复检投资论文，健康分", en: "Establish or check investment thesis" },
    calls: "1",
  },
  thesis_drift: {
    id: "thesis_drift",
    category: "portfolio",
    agentIds: ["thesis-drift"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    needsReportLibrary: true,
    canonicalSkill: "thesis-drift",
    titles: { zh: "论文漂移", en: "Thesis Drift" },
    descriptions: { zh: "对比两份论文，区分事实与措辞变化", en: "Compare two theses, fact vs wording" },
    calls: "1",
  },
  wechat_article: {
    id: "wechat_article",
    category: "tools",
    agentIds: ["wechat-researcher", "wechat-writer", "wechat-editor", "wechat-reader", "synthesis"],
    needsSynthesis: true,
    useFullModel: true,
    parallel: false,
    executionGroups: [["wechat-researcher"], ["wechat-writer"], ["wechat-editor", "wechat-reader"]],
    needsTopicInput: true,
    canonicalSkill: "wechat-article",
    titles: { zh: "公众号文章", en: "WeChat Article" },
    descriptions: { zh: "研究、初稿、编辑与读者审阅后定稿", en: "Research, draft, editor and reader review, then final copy" },
    calls: "5",
  },
  financial_data: {
    id: "financial_data",
    category: "tools",
    agentIds: ["financial-data-auditor"],
    needsSynthesis: false,
    useFullModel: true,
    parallel: false,
    canonicalSkill: "financial-data",
    titles: { zh: "财务数据核验", en: "Financial Data" },
    descriptions: { zh: "提取、统一口径并标注财务数据可信度", en: "Normalize and validate financial facts" },
    calls: "1",
  },
  backtest_interpretation: {
    id: "backtest_interpretation",
    category: "assetmate",
    agentIds: ["backtest-analyst"],
    needsSynthesis: false,
    useFullModel: false,
    parallel: false,
    origin: "assetmate",
    titles: { zh: "回测解读", en: "Backtest Review" },
    descriptions: { zh: "结合策略结果分析稳健性", en: "Review robustness and limitations" },
    calls: "1",
  },
};

export const WORKFLOW_CATEGORY_ORDER: WorkflowCategory[] = ["deep", "earnings", "industry", "portfolio", "tools", "assetmate"];

export const WORKFLOW_CATEGORY_LABELS: Record<WorkflowCategory, { zh: string; en: string }> = {
  deep: { zh: "深度研究", en: "Deep Research" },
  earnings: { zh: "财报分析", en: "Earnings Analysis" },
  industry: { zh: "行业筛选", en: "Industry Screening" },
  portfolio: { zh: "持仓管理", en: "Portfolio Management" },
  tools: { zh: "思维工具", en: "Thinking Tools" },
  assetmate: { zh: "插件增强", en: "AssetMate Enhancements" },
};

export function getWorkflowConfig(workflowId: ResearchWorkflowId): WorkflowConfig {
  const config = WORKFLOW_REGISTRY[workflowId];
  if (!config) throw new Error(`Unknown workflow: ${workflowId}`);
  return config;
}

export function workflowAgentIds(workflowId: ResearchWorkflowId): ResearchAgentId[] {
  return getWorkflowConfig(workflowId).agentIds;
}
