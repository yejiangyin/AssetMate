import type {
  ResearchDataProvenance,
  ResearchDatasetKind,
  ResearchTarget,
  ResearchWorkflowId,
} from "./types";

export type ResearchDatasetRequirement = "required" | "optional" | "not_applicable";

const FINANCIAL_WORKFLOWS = new Set<ResearchWorkflowId>([
  "investment_research",
  "deep_research",
  "deep_company_series",
  "management_deep_dive",
  "income_investment",
  "earnings_review",
  "earnings_team",
  "financial_data",
  "quality_screen",
  "thesis_tracker",
]);

const PROFILE_WORKFLOWS = new Set<ResearchWorkflowId>([
  "investment_research",
  "deep_research",
  "deep_company_series",
  "management_deep_dive",
]);

const FUNDAMENTAL_WORKFLOWS = new Set<ResearchWorkflowId>([
  "quick_check",
  "investment_research",
  "deep_research",
  "deep_company_series",
  "management_deep_dive",
  "income_investment",
  "earnings_review",
  "earnings_team",
  "financial_data",
  "quality_screen",
  "thesis_tracker",
]);

function isPublicEquity(target: ResearchTarget) {
  return target.assetType === "stock" || target.assetType === "etf";
}

export function supportsCorporateActions(target: ResearchTarget) {
  return isPublicEquity(target) || target.assetType === "fund" || target.assetType === "bond";
}

export function supportsEquityFundamentals(target: ResearchTarget) {
  return isPublicEquity(target);
}

export function supportsSecFinancials(target: ResearchTarget) {
  return target.market === "US" && target.assetType === "stock";
}

export function datasetRequirement(
  workflowId: ResearchWorkflowId,
  target: ResearchTarget,
  dataset: ResearchDatasetKind,
): { requirement: ResearchDatasetRequirement; requirementGroup?: string } {
  if (target.market === "TOPIC" || target.market === "PORTFOLIO") {
    return { requirement: "not_applicable" };
  }
  if (dataset === "quote" || dataset === "price_history") return { requirement: "required" };
  if (dataset === "market_status") return { requirement: "optional" };

  if (dataset === "corporate_actions") {
    if (!supportsCorporateActions(target)) return { requirement: "not_applicable" };
    return { requirement: workflowId === "income_investment" ? "required" : "optional" };
  }

  if (dataset === "fundamentals") {
    if (!supportsEquityFundamentals(target)) return { requirement: "not_applicable" };
    return { requirement: FUNDAMENTAL_WORKFLOWS.has(workflowId) ? "required" : "optional" };
  }

  if (dataset === "company_profile") {
    if (!supportsEquityFundamentals(target)) return { requirement: "not_applicable" };
    return { requirement: PROFILE_WORKFLOWS.has(workflowId) ? "required" : "optional" };
  }

  if (dataset === "financial_statements") {
    if (!supportsEquityFundamentals(target)) return { requirement: "not_applicable" };
    return FINANCIAL_WORKFLOWS.has(workflowId)
      ? { requirement: "optional", requirementGroup: "financial_evidence" }
      : { requirement: "optional" };
  }

  if (dataset === "sec_filings") {
    if (!supportsSecFinancials(target) || !FINANCIAL_WORKFLOWS.has(workflowId)) {
      return { requirement: "not_applicable" };
    }
    return { requirement: "optional", requirementGroup: "financial_evidence" };
  }

  if (dataset === "calendar_events") {
    if (!supportsEquityFundamentals(target)) return { requirement: "not_applicable" };
    return {
      requirement: workflowId === "earnings_review" || workflowId === "earnings_team" ? "required" : "optional",
    };
  }

  if (dataset === "analyst_data") {
    return { requirement: supportsEquityFundamentals(target) ? "optional" : "not_applicable" };
  }

  return { requirement: "optional" };
}

function isUnavailable(item: ResearchDataProvenance) {
  return item.status !== "success" || item.stale === true;
}

export function evaluateTargetDataStatus(provenance: ResearchDataProvenance[]) {
  const required = provenance.filter((item) => item.requirement === "required");
  if (required.length && required.every((item) => isUnavailable(item))) return "failed" as const;
  if (required.some((item) => isUnavailable(item))) return "partial" as const;

  const groups = new Map<string, ResearchDataProvenance[]>();
  provenance.forEach((item) => {
    if (!item.requirementGroup) return;
    const values = groups.get(item.requirementGroup) ?? [];
    values.push(item);
    groups.set(item.requirementGroup, values);
  });
  if ([...groups.values()].some((items) => !items.some((item) => item.status === "success" && !item.stale))) {
    return "partial" as const;
  }
  return "complete" as const;
}
