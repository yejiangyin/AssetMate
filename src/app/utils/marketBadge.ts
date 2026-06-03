/**
 * Shared market badge definitions — single source of truth.
 */
import type { Language } from "../context/AppContext";
import { marketLabel } from "../i18n";

export interface MarketBadge {
  label: string;
  color: string;
}

const MARKET_BADGES: Record<string, MarketBadge> = {
  US:        { label: "美股", color: "#60A5FA" },
  HK:        { label: "港股", color: "#F472B6" },
  A:         { label: "A股",  color: "#F24E4E" },
  JP:        { label: "日股", color: "#38BDF8" },
  UK:        { label: "英股", color: "#818CF8" },
  DE:        { label: "德股", color: "#F97316" },
  IN:        { label: "印度", color: "#22C55E" },
  VN:        { label: "越南", color: "#14B8A6" },
  CRYPTO:    { label: "加密", color: "#F59E0B" },
  FUND:      { label: "基金", color: "#31D08B" },
  BOND:      { label: "债券", color: "var(--text-secondary)" },
  GOLD:      { label: "黄金", color: "#FCD34D" },
  INDEX:     { label: "指数", color: "#A78BFA" },
  FX:        { label: "汇率", color: "var(--text-secondary)" },
  COMMODITY: { label: "大宗", color: "#FCD34D" },
};

const DEFAULT_BADGE: MarketBadge = { label: "其他", color: "var(--text-secondary)" };

export function getMarketBadge(market: string, language: Language = "zh"): MarketBadge {
  const key = (market || "").toUpperCase();
  const badge = MARKET_BADGES[key] ?? DEFAULT_BADGE;
  return { ...badge, label: marketLabel(key, language) };
}

/** Convenience: returns { label, color, bg } with a computed alpha background. */
export function getMarketBadgeWithBg(market: string, bgAlpha = 0.1, language: Language = "zh") {
  const badge = getMarketBadge(market, language);
  const bg = badge.color.startsWith("var(")
    ? `rgba(148,163,184,${bgAlpha})`
    : hexToBgAlpha(badge.color, bgAlpha);
  return { ...badge, bg };
}

function hexToBgAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
