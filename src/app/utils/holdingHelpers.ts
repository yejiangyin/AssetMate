/**
 * Pure helper functions for Holding normalization, building, and metrics.
 * Extracted from AppContext.tsx to reduce file size.
 */

import type { Holding } from "../data/mockData";
import type { HoldingInput, HoldingAdjustmentInput } from "../context/AppContext";

/* ─── normalize helpers ─────────────────────────────── */

function looksLikeExchangeFundCode(code: string): boolean {
  return /^(50|51|52|56|58|588|159|16|18)/.test(code);
}

function isEtfLinkedFund(symbol: string, name: string): boolean {
  return /^\d{6}$/.test(symbol) && !looksLikeExchangeFundCode(symbol) && /ETF\s*联接|联接.*ETF/i.test(name);
}

export function normalizeHoldingType(symbol: string, name: string, market: string, assetType: string) {
  if (isEtfLinkedFund(symbol, name)) {
    return { market: "FUND", assetType: "fund" };
  }
  return { market, assetType };
}

export function normalizeHoldingSymbol(symbol: string, market: string) {
  if (market === "HK") return symbol.replace(/\.HK$/i, "").padStart(5, "0");
  return symbol;
}

export function normalizeHolding(h: Holding): Holding {
  const normalizedType = normalizeHoldingType(h.symbol, h.name, h.market, h.assetType);
  const normalizedSymbol = normalizeHoldingSymbol(h.symbol, normalizedType.market);
  const marketValue = h.quantity * h.currentPrice;
  const costBasis = h.quantity * h.costPrice;
  const totalPnl = marketValue - costBasis;
  const fundNavHistory = Array.isArray(h.fundNavHistory)
    ? h.fundNavHistory
      .filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20)
    : undefined;
  return {
    ...h,
    symbol: normalizedSymbol,
    market: normalizedType.market as Holding["market"],
    assetType: normalizedType.assetType as Holding["assetType"],
    tradeStatus: h.tradeStatus ?? "normal",
    tradeStatusNote: h.tradeStatusNote ?? "",
    autoTradeStatus: h.autoTradeStatus ?? null,
    autoTradeStatusNote: h.autoTradeStatusNote ?? "",
    autoTradeStatusSource: h.autoTradeStatusSource ?? null,
    priceDate: h.priceDate ?? "",
    fundNavHistory,
    marketValue,
    totalPnl,
    totalPnlRate: costBasis > 0 ? totalPnl / costBasis : 0,
  };
}

/* ─── metrics ───────────────────────────────────────── */

export function recomputeHoldingMetrics(
  holding: Holding,
  patch: Partial<Holding> = {},
  resetToday = false,
): Holding {
  const next = { ...holding, ...patch };
  const marketValue = next.quantity * next.currentPrice;
  const costBasis = next.quantity * next.costPrice;
  const totalPnl = marketValue - costBasis;
  return {
    ...next,
    marketValue,
    totalPnl,
    totalPnlRate: costBasis > 0 ? totalPnl / costBasis : 0,
    todayPnl: resetToday ? 0 : next.todayPnl,
    todayPnlRate: resetToday ? 0 : next.todayPnlRate,
    updatedAt: new Date().toISOString(),
  };
}

/* ─── build / adjust ────────────────────────────────── */

export function buildHolding(input: HoldingInput, id: string): Holding {
  const normalizedType = normalizeHoldingType(input.symbol, input.name, input.market, input.assetType);
  const normalizedSymbol = normalizeHoldingSymbol(input.symbol, normalizedType.market);
  const marketValue = input.quantity * input.currentPrice;
  const costBasis   = input.quantity * input.costPrice;
  const totalPnl    = marketValue - costBasis;
  return {
    id,
    groupId:      input.groupId,
    symbol:       normalizedSymbol,
    name:         input.name,
    market:       normalizedType.market as Holding["market"],
    assetType:    normalizedType.assetType as Holding["assetType"],
    quantity:     input.quantity,
    costPrice:    input.costPrice,
    currentPrice: input.currentPrice,
    currency:     input.currency,
    marketValue,
    todayPnl:     0,
    todayPnlRate: 0,
    totalPnl,
    totalPnlRate: costBasis > 0 ? totalPnl / costBasis : 0,
    tradeStatus:  input.tradeStatus ?? "normal",
    tradeStatusNote: input.tradeStatusNote?.trim() || "",
    autoTradeStatus: input.autoTradeStatus ?? null,
    autoTradeStatusNote: input.autoTradeStatusNote ?? "",
    autoTradeStatusSource: input.autoTradeStatusSource ?? null,
    updatedAt:    new Date().toISOString(),
  };
}

export function applyHoldingAdjustment(current: Holding, input: HoldingAdjustmentInput): Holding | null {
  const quantity = Number(input.quantity);
  const price = Number(input.price);
  if (!(quantity > 0) || !(price > 0)) return current;

  const rateDenominator = 1 + current.todayPnlRate;
  const dailyChangePerUnit = Math.abs(rateDenominator) > 1e-6
      ? current.currentPrice * (current.todayPnlRate / rateDenominator)
      : 0;
  const withScaledToday = (patch: Partial<Holding>, nextQuantity: number) => recomputeHoldingMetrics(current, {
    ...patch,
    todayPnl: Number.isFinite(dailyChangePerUnit) ? dailyChangePerUnit * nextQuantity : 0,
    todayPnlRate: current.todayPnlRate,
  });

  if (input.type === "buy") {
    const nextQuantity = current.quantity + quantity;
    const nextCostPrice = nextQuantity > 0
      ? ((current.quantity * current.costPrice) + (quantity * price)) / nextQuantity
      : price;
    return withScaledToday({
      quantity: nextQuantity,
      costPrice: nextCostPrice,
    }, nextQuantity);
  }

  const sellQuantity = Math.min(quantity, current.quantity);
  const nextQuantity = current.quantity - sellQuantity;
  if (nextQuantity <= 0) return null;
  return withScaledToday({
    quantity: nextQuantity,
  }, nextQuantity);
}
