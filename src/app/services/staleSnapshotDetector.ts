import type { Holding } from "../data/mockData";
import { shiftDate } from "./portfolioSnapshotBackfill";

/**
 * Detects portfolio snapshot dates whose `unrealizedPnl` may be stale because
 * a fund holding's official NAV had not yet published when the snapshot was
 * captured. Returns the existing snapshot dates that fall inside the gap
 * between a fund's previous latest NAV date and its newly-published latest NAV
 * date, so they can be recomputed with the now-available official NAV.
 */
export function collectStaleSnapshotDates(
  holdingsBefore: Holding[],
  holdingsAfter: Holding[],
  existingSnapshotDates: string[],
  today: string,
): string[] {
  const existing = new Set(existingSnapshotDates);
  const stale = new Set<string>();
  const afterById = new Map(holdingsAfter.map((h) => [h.id, h]));
  for (const before of holdingsBefore) {
    if (before.market !== "FUND" || before.assetType !== "fund") continue;
    const after = afterById.get(before.id);
    if (!after?.fundNavHistory?.length) continue;
    const oldLatest = before.fundNavHistory?.[0]?.date ?? before.priceDate;
    if (!oldLatest) continue;
    const newLatest = after.fundNavHistory[0]?.date ?? after.priceDate;
    if (!newLatest) continue;
    if (newLatest <= oldLatest) continue;
    for (let date = shiftDate(oldLatest, 1); date <= newLatest; date = shiftDate(date, 1)) {
      if (date < today && existing.has(date)) stale.add(date);
    }
  }
  return [...stale].sort();
}
