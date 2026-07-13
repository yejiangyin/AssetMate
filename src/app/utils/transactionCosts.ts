import type { TransactionCostProfile } from "../data/mockData";

const PROFILE_KEYS = ["buyFeeRate", "sellFeeRate", "minimumFee", "buyTaxRate", "sellTaxRate", "dividendTaxRate"] as const;

function optionalNonNegative(value: unknown) {
  if (value === "" || value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normalizeTransactionCostProfile(profile: TransactionCostProfile | null | undefined) {
  if (!profile) return undefined;
  const normalized: TransactionCostProfile = {};
  for (const key of PROFILE_KEYS) {
    const value = optionalNonNegative(profile[key]);
    if (value != null) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeTransactionCostProfile(
  current: TransactionCostProfile | undefined,
  patch: TransactionCostProfile | undefined,
) {
  return normalizeTransactionCostProfile({ ...current, ...patch });
}

export function estimateTransactionCosts(
  profile: TransactionCostProfile | undefined,
  side: "buy" | "sell",
  amount: number,
) {
  const safeAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const feeRate = side === "buy" ? profile?.buyFeeRate : profile?.sellFeeRate;
  const taxRate = side === "buy" ? profile?.buyTaxRate : profile?.sellTaxRate;
  const minimumFee = profile?.minimumFee;
  const fee = safeAmount > 0 && feeRate != null
    ? Math.max(safeAmount * feeRate, minimumFee ?? 0)
    : 0;
  const tax = safeAmount > 0 && taxRate != null ? safeAmount * taxRate : 0;
  return { fee, tax, feeRate, taxRate, minimumFee };
}

/** Maximum buy notional whose notional + estimated costs stays within budget. */
export function affordableBuyAmount(profile: TransactionCostProfile | undefined, budget: number) {
  const safeBudget = Number.isFinite(budget) ? Math.max(0, budget) : 0;
  let low = 0;
  let high = safeBudget;
  for (let index = 0; index < 48; index += 1) {
    const candidate = (low + high) / 2;
    const { fee, tax } = estimateTransactionCosts(profile, "buy", candidate);
    if (candidate + fee + tax <= safeBudget) low = candidate;
    else high = candidate;
  }
  return low;
}
