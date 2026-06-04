/**
 * Pure helper functions for Holding normalization, building, and metrics.
 * Extracted from AppContext.tsx to reduce file size.
 */

import type { Holding } from "../data/mockData";
import type { HoldingInput, HoldingAdjustmentInput, HoldingCorporateActionInput } from "../context/AppContext";

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
  const cashDividendTotal = Number.isFinite(h.cashDividendTotal) ? Math.max(0, h.cashDividendTotal ?? 0) : 0;
  const totalPnl = marketValue - costBasis + cashDividendTotal;
  const fundNavHistory = Array.isArray(h.fundNavHistory)
    ? h.fundNavHistory
      .filter((row) => row.date && Number.isFinite(row.nav) && row.nav > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20)
    : undefined;
  const corporateActions = Array.isArray(h.corporateActions)
    ? h.corporateActions
      .filter((action) => typeof action?.id === "string" && typeof action?.type === "string" && typeof action?.date === "string")
      .slice(-60)
    : [];
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
    cashDividendTotal,
    dividendReinvest: typeof h.dividendReinvest === "boolean" ? h.dividendReinvest : null,
    autoCorporateActionSince: h.autoCorporateActionSince ?? "",
    corporateActions,
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
  const cashDividendTotal = Number.isFinite(next.cashDividendTotal) ? Math.max(0, next.cashDividendTotal ?? 0) : 0;
  const totalPnl = marketValue - costBasis + cashDividendTotal;
  return {
    ...next,
    cashDividendTotal,
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
    cashDividendTotal: 0,
    dividendReinvest: typeof input.dividendReinvest === "boolean" ? input.dividendReinvest : null,
    corporateActions: [],
    tradeStatus:  input.tradeStatus ?? "normal",
    tradeStatusNote: input.tradeStatusNote?.trim() || "",
    autoTradeStatus: input.autoTradeStatus ?? null,
    autoTradeStatusNote: input.autoTradeStatusNote ?? "",
    autoTradeStatusSource: input.autoTradeStatusSource ?? null,
    updatedAt:    new Date().toISOString(),
  };
}

export function applyCorporateAction(current: Holding, input: HoldingCorporateActionInput): Holding {
  const currentCostBasis = current.quantity * current.costPrice;
  const baseAction = {
    id: input.id || `corp_${crypto.randomUUID()}`,
    type: input.type,
    date: input.date || new Date().toISOString().slice(0, 10),
    source: input.source,
    note: input.note?.trim() || "",
  };

  if (input.type === "cash_dividend") {
    const amount = Number(input.amount);
    if (!(amount > 0)) return current;
    return recomputeHoldingMetrics(current, {
      cashDividendTotal: (current.cashDividendTotal ?? 0) + amount,
      corporateActions: [
        ...(current.corporateActions ?? []),
        { ...baseAction, amount },
      ].slice(-60),
    });
  }

  if (input.type === "share_dividend") {
    const shares = Number(input.shares);
    if (!(shares > 0)) return current;
    const nextQuantity = current.quantity + shares;
    const nextCostPrice = nextQuantity > 0 ? currentCostBasis / nextQuantity : current.costPrice;
    return recomputeHoldingMetrics(current, {
      quantity: nextQuantity,
      costPrice: nextCostPrice,
      corporateActions: [
        ...(current.corporateActions ?? []),
        {
          ...baseAction,
          shares,
          amount: Number.isFinite(input.amount) && (input.amount ?? 0) > 0 ? input.amount : undefined,
          price: Number.isFinite(input.price) && (input.price ?? 0) > 0 ? input.price : undefined,
        },
      ].slice(-60),
    });
  }

  const ratio = Number(input.ratio);
  if (!(ratio > 0)) return current;
  const nextQuantity = current.quantity * ratio;
  const nextCostPrice = nextQuantity > 0 ? currentCostBasis / nextQuantity : current.costPrice;
  return recomputeHoldingMetrics(current, {
    quantity: nextQuantity,
    costPrice: nextCostPrice,
    corporateActions: [
      ...(current.corporateActions ?? []),
      { ...baseAction, ratio },
    ].slice(-60),
  });
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
