export type ResearchEmphasis = "positive" | "risk" | "warning" | "conclusion" | "neutral";

export const RESEARCH_EMPHASIS_COLORS: Record<Exclude<ResearchEmphasis, "neutral">, string> = {
  positive: "#22A874",
  risk: "#E5484D",
  warning: "#D98B16",
  conclusion: "#3B82F6",
};

export function classifyResearchEmphasis(value: string): ResearchEmphasis {
  const text = value.trim();
  if (!text) return "neutral";

  const positive = /看多|优势|利好|催化剂?|增长驱动|上行空间|(?:^|[^未不没])通过$|bull|upside|catalysts?|strengths?/i.test(text)
    || (/机会/.test(text) && !/机会成本/.test(text));
  const risk = /看空|风险|利空|危险|红线|否决|不通过|未通过|没通过|下行空间|bear|downside|risks?|warnings?|danger/i.test(text);
  // A comparison heading such as “Bull / Bear” is navigation, not a verdict.
  if (positive && risk) return "neutral";
  if (risk) return "risk";
  if (positive) return "positive";
  if (/局限|不确定|数据不足|待验证|待核验|注意|警示|限制|不构成投资建议|limitations?|uncertain|data\s+gaps?|caution/i.test(text)) return "warning";
  if (/结论|行动|建议|一句话|核心观点|判断|评级|final|conclusion|action|recommendation|rating/i.test(text)) return "conclusion";
  return "neutral";
}

export function isKeyFigureText(value: string) {
  const text = value.trim();
  if (!text || text.length > 36 || !/\d/.test(text)) return false;
  return /(?:%|¥|￥|\$|€|£|元|万元|亿元|万|亿|倍|x\b|pe\b|pb\b|roe\b|eps\b|cagr\b|目标价|市值|收益率)/i.test(text);
}
