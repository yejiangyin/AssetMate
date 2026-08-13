import type { Holding } from "../data/mockData";

function parseYmd(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day, date };
}

function localYmd(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isCurrentFundEstimate(holding: Holding, today: string) {
  if (holding.market !== "FUND" || holding.assetType !== "fund" || holding.priceDate !== today) return false;
  if (holding.estimatedNavAt?.slice(0, 10) !== today) return false;
  const estimate = Number(holding.estimatedNav);
  if (!(estimate > 0) || !(holding.currentPrice > 0)) return false;
  return Math.abs(estimate - holding.currentPrice) <= Math.max(1e-8, holding.currentPrice * 1e-8);
}

/** Label the actual period represented by a holding's latest P/L. */
export function latestPnlDateLabel(
  holding: Holding,
  today: string,
  language: "zh" | "en",
): string | null {
  if (isCurrentFundEstimate(holding, today)) return language === "en" ? "Estimate" : "估值";
  const valuation = parseYmd(holding.priceDate ?? "");
  const current = parseYmd(today);
  if (!valuation || !current || holding.priceDate! >= today) return null;

  const yesterday = new Date(current.date);
  yesterday.setDate(yesterday.getDate() - 1);
  if (holding.priceDate === localYmd(yesterday)) return language === "en" ? "Yesterday" : "昨日";

  if (language === "zh") {
    return valuation.year === current.year
      ? `${valuation.month}月${valuation.day}日`
      : `${valuation.year}年${valuation.month}月${valuation.day}日`;
  }
  return new Intl.DateTimeFormat("en-US", {
    ...(valuation.year === current.year ? {} : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
  }).format(valuation.date);
}
