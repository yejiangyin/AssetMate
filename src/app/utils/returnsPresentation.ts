import type { PortfolioEvent } from "../services/portfolioEvents";
import type { PortfolioSnapshotInput } from "../services/portfolioEvents";

export function hasMeaningfulReturnData(
  holdingCount: number,
  eventCount: number,
  snapshots: PortfolioSnapshotInput[],
) {
  if (holdingCount > 0 || eventCount > 0) return true;
  return snapshots.some((snapshot) => [
    snapshot.totalAsset,
    snapshot.todayPnl,
    snapshot.cumulativePnl,
    snapshot.unrealizedPnl,
    snapshot.realizedTradingPnl,
    snapshot.dividendPnl,
    snapshot.feePnl,
    snapshot.totalPnl,
  ].some((value) => Number.isFinite(value) && value !== 0));
}

function currencySymbol(currency: string) {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  if (currency === "HKD") return "HK$";
  return `${currency} `;
}

export function formatCompactMoney(value: number, privacyMode: boolean, locale: string, currency = "CNY") {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const symbol = currencySymbol(currency);
  if (privacyMode) return `${sign}${symbol}--`;
  const absolute = Math.abs(value);
  return `${sign}${symbol}${absolute.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCalendarMoney(value: number, privacyMode: boolean, locale: string, currency = "CNY") {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const symbol = currencySymbol(currency);
  if (privacyMode) return `${symbol}--`;
  const absolute = Math.abs(value);
  if (locale.startsWith("zh") && absolute >= 100_000_000) return `${sign}${symbol}${(absolute / 100_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}亿`;
  if (locale.startsWith("zh") && absolute >= 10_000) return `${sign}${symbol}${(absolute / 10_000).toLocaleString(locale, { maximumFractionDigits: 1 })}万`;
  if (!locale.startsWith("zh") && absolute >= 1_000_000) return `${sign}${symbol}${(absolute / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}M`;
  if (!locale.startsWith("zh") && absolute >= 1_000) return `${sign}${symbol}${(absolute / 1_000).toLocaleString(locale, { maximumFractionDigits: 1 })}K`;
  return `${sign}${symbol}${absolute.toLocaleString(locale, { maximumFractionDigits: 2 })}`;
}

export const formatCompactCny = (value: number, privacyMode: boolean, locale: string) => formatCompactMoney(value, privacyMode, locale, "CNY");
export const formatCalendarCny = (value: number, privacyMode: boolean, locale: string) => formatCalendarMoney(value, privacyMode, locale, "CNY");

export function returnEventValue(event: PortfolioEvent) {
  if (
    event.type === "sell"
    || event.type === "cash_dividend"
    || event.type === "dividend_reinvest"
    || event.type === "interest"
    || event.type === "bond_coupon"
    || event.type === "fee"
    || event.type === "tax"
  ) {
    return event.amountInBase;
  }
  return 0;
}

export function breakdownBarWidth(value: number, rows: Array<{ value: number }>) {
  if (value === 0) return 0;
  const absoluteTotal = rows.reduce((sum, row) => sum + Math.abs(row.value), 0);
  if (!(absoluteTotal > 0)) return 0;
  return Math.min(100, Math.max(3, Math.round(Math.abs(value) / absoluteTotal * 100)));
}
