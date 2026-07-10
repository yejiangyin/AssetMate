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

export function formatCompactCny(value: number, privacyMode: boolean, locale: string) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  if (privacyMode) return `${sign}¥--`;
  const absolute = Math.abs(value);
  const formatScaled = (scaled: number, unit: string) => (
    `${sign}¥${scaled.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}${unit}`
  );
  if (absolute >= 100_000_000) return formatScaled(absolute / 100_000_000, "亿");
  if (absolute >= 10_000) return formatScaled(absolute / 10_000, "万");
  if (absolute >= 1_000) return formatScaled(absolute / 1_000, "k");
  return `${sign}¥${absolute.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
