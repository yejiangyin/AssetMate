import type { LiveResult } from "../services/securitiesApi";
import { normalizeHoldingSymbol, normalizeHoldingType } from "../utils/holdingHelpers";

export const RESEARCH_MARKETS = ["US", "HK", "A", "JP", "FUND", "CRYPTO", "BOND", "GOLD", "INDEX", "FX", "COMMODITY"] as const;
export const RESEARCH_ASSET_TYPES = ["stock", "etf", "fund", "crypto", "bond"] as const;
export const RESEARCH_CURRENCIES = ["USD", "CNY", "HKD", "JPY", "EUR", "GBP", "USDT", "USDC"] as const;

export function defaultCurrencyForMarket(market: string) {
  if (market === "US" || market === "CRYPTO" || market === "GOLD") return "USD";
  if (market === "HK") return "HKD";
  if (market === "A" || market === "FUND" || market === "BOND") return "CNY";
  if (market === "JP") return "JPY";
  return "";
}
export function researchTargetFieldsFromSearchResult(result: LiveResult) {
  const normalized = normalizeHoldingType(result.symbol, result.name, result.market, result.assetType);
  return {
    symbol: normalizeHoldingSymbol(result.symbol, normalized.market),
    name: result.name,
    market: normalized.market,
    assetType: normalized.assetType,
    currency: result.currency || defaultCurrencyForMarket(normalized.market),
  };
}
