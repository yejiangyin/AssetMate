import { useEffect, useMemo, useId, useState, useCallback, useRef } from "react";
import { AlertTriangle, Bell, ChevronDown, ChevronUp, Eye, EyeOff, PanelRightClose, PanelRightOpen, RefreshCw, X } from "lucide-react";
import { useApp } from "../context/AppContext";
import { motion } from "motion/react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useNavigate } from "react-router";
import { fetchRecentDailyChart, toYahooSymbol } from "../services/quoteApi";
import { convertCurrency, mapWithConcurrency, toCNY } from "../services/priceRefresher";
import { BrandMark } from "../components/BrandMark";
import { formatExactMoney, formatPercent } from "../utils/numberFormat";
import { useViewSwitcher } from "../utils/useViewSwitcher";
import { getMarketBadge } from "../utils/marketBadge";
import {
  CORPORATE_ACTION_NOTICE_RETENTION_DAYS,
  getRecentCorporateActionNotices,
  mergeDismissedCorporateActionNoticeKeys,
  readDismissedCorporateActionNoticeKeys,
  subscribeDismissedCorporateActionNotices,
  writeDismissedCorporateActionNoticeKeys,
} from "../utils/corporateActionNotices";
import { groupName, t } from "../i18n";
import type { PortfolioEvent } from "../services/portfolioEvents";

const UNGROUPED = { id: "", name: "未分组", color: "var(--text-micro)" };
const SERIES_DISPLAY_POINTS = 30;
const ASSET_SERIES_CACHE_KEY = "dashboard.assetSeries.v4";
const ASSET_SERIES_CACHE_TTL = 4 * 60 * 60 * 1000;
const MARKET_TIME_ZONES: Record<string, string> = {
  A: "Asia/Shanghai",
  FUND: "Asia/Shanghai",
  BOND: "Asia/Shanghai",
  HK: "Asia/Hong_Kong",
  JP: "Asia/Tokyo",
  US: "America/New_York",
  INDEX: "Asia/Shanghai",
  CRYPTO: "UTC",
  FX: "UTC",
  GOLD: "UTC",
  COMMODITY: "UTC",
};

type AssetSeriesPoint = {
  date: string;
  asset: number;
  ts: number;
  index: number;
};

type CachedAssetSeries = {
  key: string;
  savedAt: number;
  points: AssetSeriesPoint[];
};

type EstimatedAssetSeries = {
  key: string;
  points: AssetSeriesPoint[];
};

function fmtPnl(v: number, priv: boolean, c: string, currency: string) {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  const displayValue = convertCurrency(Math.abs(v), "CNY", currency);
  return <span style={{ color: c, whiteSpace: "nowrap" }}>{priv ? `${sign}--` : `${sign}${formatExactMoney(displayValue, currency, 2)}`}</span>;
}

function fmtRate(v: number, c: string) {
  const formatted = formatPercent(v, 2);
  return <span style={{ color: c, fontSize: 12 }}>{formatted}</span>;
}

function formatNoticeMoney(value: number, currency: string, privacyMode: boolean) {
  const prefix = value < 0 ? "-" : "";
  return privacyMode ? `${prefix}${currency} --` : `${prefix}${formatExactMoney(Math.abs(value), currency, 2)}`;
}

function formatNoticeQuantity(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function formatSplitNotice(ratio: number, language: string) {
  const isEn = language === "en";
  if (!(ratio > 0)) return "";
  if (ratio > 1) {
    return isEn
      ? `1 share becomes ${formatNoticeQuantity(ratio)}`
      : `每 1 股变为 ${formatNoticeQuantity(ratio)} 股`;
  }
  if (ratio < 1) {
    const originalShares = 1 / ratio;
    return isEn
      ? `${formatNoticeQuantity(originalShares)} shares become 1`
      : `每 ${formatNoticeQuantity(originalShares)} 股合为 1 股`;
  }
  return isEn ? "1:1 (no quantity change)" : "1:1（数量不变）";
}

function corporateActionNoticeMeta(event: PortfolioEvent, privacyMode: boolean, language: string) {
  const isEn = language === "en";
  const parts: string[] = [];
  const amount = Number.isFinite(event.amount) ? event.amount : 0;
  const quantity = Number.isFinite(event.quantity) ? event.quantity ?? 0 : 0;
  const price = Number.isFinite(event.price) ? event.price ?? 0 : 0;

  if (event.type === "dividend_reinvest") {
    if (amount > 0) parts.push(`${isEn ? "Net" : "净额"} ${formatNoticeMoney(amount, event.currency, privacyMode)}`);
    if (quantity > 0) parts.push(`${isEn ? "Shares" : "份额"} ${formatNoticeQuantity(quantity)}`);
    if (event.estimatedAmount != null && event.estimatedAmount > amount) {
      parts.push(`${isEn ? "Gross" : "税前"} ${formatNoticeMoney(event.estimatedAmount, event.currency, privacyMode)}`);
    }
  } else if (event.type === "cash_dividend" || event.type === "interest" || event.type === "bond_coupon") {
    if (amount !== 0) parts.push(formatNoticeMoney(amount, event.currency, privacyMode));
  } else if (event.type === "share_dividend") {
    if (quantity > 0) parts.push(`${isEn ? "Added" : "新增"} ${formatNoticeQuantity(quantity)} ${isEn ? "shares" : "股"}`);
  } else if (event.type === "split") {
    const ratio = quantity > 0 ? quantity : price;
    if (ratio > 0) {
      parts.push(event.corporateActionKind === "share_bonus_transfer" && ratio > 1
        ? (isEn
            ? `+${formatNoticeQuantity((ratio - 1) * 100)} shares per 100`
            : `每 10 股送转 ${formatNoticeQuantity((ratio - 1) * 10)} 股`)
        : formatSplitNotice(ratio, language));
    }
  }

  return parts.slice(0, 2).join(" · ");
}


function snapshotToTime(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 0;
  const stamp = new Date(year, month - 1, day).getTime();
  const parsed = new Date(stamp);
  if (
    !Number.isFinite(stamp)
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return 0;
  }
  return stamp;
}

function ymdFromTime(time: number) {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ymdFromTimeZone(time: number, market: string) {
  const timeZone = MARKET_TIME_ZONES[market] ?? "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(time));
  } catch {
    return ymdFromTime(time);
  }
}

function dateLabelFromYMD(date: string) {
  return date.slice(5).replace("-", "/");
}

function makeSeriesCacheKey(holdings: ReturnType<typeof useApp>["holdings"]) {
  return holdings
    .map((h) => [
      h.id,
      h.symbol,
      h.market,
      h.currency,
      h.quantity,
    ].join(":"))
    .sort()
    .join("|");
}

function holdingRateChange(price: number, rate: number) {
  if (!Number.isFinite(price) || !Number.isFinite(rate) || price <= 0) return 0;
  const denominator = 1 + rate;
  if (denominator <= 0) return 0;
  return price * rate / denominator;
}

function readCachedAssetSeries(cacheKey: string, ignoreTtl = false) {
  try {
    const raw = localStorage.getItem(ASSET_SERIES_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedAssetSeries;
    if (cached.key !== cacheKey) return null;
    if (!ignoreTtl && Date.now() - cached.savedAt > ASSET_SERIES_CACHE_TTL) return null;
    if (!Array.isArray(cached.points) || cached.points.length < 2) return null;
    return cached.points;
  } catch {
    return null;
  }
}

function writeCachedAssetSeries(cacheKey: string, points: AssetSeriesPoint[]) {
  try {
    const cached: CachedAssetSeries = { key: cacheKey, savedAt: Date.now(), points };
    localStorage.setItem(ASSET_SERIES_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Cache is only a speed-up; ignore storage failures.
  }
}

export function Dashboard() {
  const { stats, holdings, groups, privacyMode, togglePrivacy, refresh, isRefreshing, lastRefreshed, lastRefreshError, profitColor, openDetail, tc, assetSnapshots, portfolioEvents, language, currency } = useApp();
  const text = t(language);
  const navigate = useNavigate();
  const heroGradId = useId().replace(/:/g, "");
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [pnlSort, setPnlSort] = useState<"gain" | "loss" | "abs">("gain");
  const [assetFilter, setAssetFilter] = useState("ALL");
  const [estimatedAssetSeries, setEstimatedAssetSeries] = useState<EstimatedAssetSeries | null>(null);
  const [loadingEstimated, setLoadingEstimated] = useState(false);
  const [noticesExpanded, setNoticesExpanded] = useState(false);
  const [noticeToday, setNoticeToday] = useState(() => new Date());
  const [dismissedNoticeKeys, setDismissedNoticeKeys] = useState(readDismissedCorporateActionNoticeKeys);

  useEffect(() => subscribeDismissedCorporateActionNotices(setDismissedNoticeKeys), []);

  const rankBadgeStyle = (index: number) => {
    if (index === 0) {
      return tc.isDark
        ? { color: "#FFE2E2", background: "#B42318" }
        : { color: "#FFFFFF", background: "#D92D20" };
    }
    if (index === 1) {
      return tc.isDark
        ? { color: "#FFF3D6", background: "#B54708" }
        : { color: "#FFFFFF", background: "#F38744" };
    }
    if (index === 2) {
      return tc.isDark
        ? { color: "#DCEBFF", background: "#175CD3" }
        : { color: "#FFFFFF", background: "#2E90FA" };
    }
    return { color: "var(--text-muted)", background: "transparent" };
  };

  const snapshotSeries = useMemo(() => {
    if (holdings.length === 0) {
      return [];
    }

    const sortedSnapshots = [...assetSnapshots]
      .filter((snapshot) => snapshot.date && Number.isFinite(snapshot.totalAsset))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    if (!sortedSnapshots.length) {
      return [];
    }

    return sortedSnapshots.map((snapshot, index) => ({
      date: dateLabelFromYMD(snapshot.date),
      asset: snapshot.totalAsset,
      ts: snapshotToTime(snapshot.date),
      index,
    }));
  }, [assetSnapshots, holdings]);

  const seriesCacheKey = useMemo(() => makeSeriesCacheKey(holdings), [holdings]);
  const seriesHoldingsRef = useRef<{ key: string; holdings: typeof holdings }>({ key: "", holdings: [] });
  // The trend cache key tracks structural position inputs. Live price ticks should
  // not invalidate the historical-series cache on every quote refresh.
  if (seriesHoldingsRef.current.key !== seriesCacheKey) {
    seriesHoldingsRef.current = { key: seriesCacheKey, holdings };
  }
  const seriesHoldings = seriesHoldingsRef.current.holdings;

  const hasCompleteSnapshotSeries = snapshotSeries.length >= SERIES_DISPLAY_POINTS;

  const freshCachedAssetSeries = useMemo(() => {
    if (seriesHoldings.length === 0 || hasCompleteSnapshotSeries) return null;
    return readCachedAssetSeries(seriesCacheKey);
  }, [hasCompleteSnapshotSeries, seriesHoldings.length, seriesCacheKey]);

  const staleCachedAssetSeries = useMemo(() => {
    if (seriesHoldings.length === 0 || hasCompleteSnapshotSeries || freshCachedAssetSeries) return null;
    return readCachedAssetSeries(seriesCacheKey, true);
  }, [hasCompleteSnapshotSeries, seriesHoldings.length, seriesCacheKey, freshCachedAssetSeries]);

  useEffect(() => {
    const holdingsForSeries = seriesHoldingsRef.current.holdings;
    if (holdingsForSeries.length === 0 || hasCompleteSnapshotSeries) {
      setEstimatedAssetSeries(null);
      setLoadingEstimated(false);
      return;
    }

    if (freshCachedAssetSeries) {
      setEstimatedAssetSeries({ key: seriesCacheKey, points: freshCachedAssetSeries });
      setLoadingEstimated(false);
      return;
    }

    if (staleCachedAssetSeries) {
      setEstimatedAssetSeries({ key: seriesCacheKey, points: staleCachedAssetSeries });
    }

    let cancelled = false;
    setLoadingEstimated(true);

    const loadEstimatedSeries = async () => {
      try {
        const valuedHoldings = holdingsForSeries
          .map((holding) => ({
            holding,
            currentValueCny: toCNY(holding.quantity * holding.currentPrice, holding.currency),
          }))
          .filter(({ holding, currentValueCny }) => holding.quantity > 0 && holding.currentPrice > 0 && currentValueCny > 0);

        if (!valuedHoldings.length) return;

        const end = new Date();
        const targetDates = Array.from({ length: SERIES_DISPLAY_POINTS }, (_, index) => {
          const date = new Date(end);
          date.setDate(end.getDate() - (SERIES_DISPLAY_POINTS - 1 - index));
          return ymdFromTime(date.getTime());
        });

        const totals = new Map<string, number>();
        const contributionCounts = new Map<string, number>();
        for (const date of targetDates) {
          totals.set(date, 0);
          contributionCounts.set(date, 0);
        }

        const addFlatFallback = (currentValueCny: number) => {
          for (const date of targetDates) {
            totals.set(date, (totals.get(date) ?? 0) + currentValueCny);
            contributionCounts.set(date, (contributionCounts.get(date) ?? 0) + 1);
          }
        };

        const results = await mapWithConcurrency(
          valuedHoldings,
          4,
          async ({ holding, currentValueCny }) => {
            try {
              const chart = await fetchRecentDailyChart(holding.symbol, holding.market, SERIES_DISPLAY_POINTS + 10);
              const validPoints = chart.points
                .filter((point) => point.price > 0 && point.timestamp)
                .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
              if (validPoints.length < 2) {
                addFlatFallback(currentValueCny);
                return false;
              }
              const latestPrice = validPoints[validPoints.length - 1]?.price || holding.currentPrice;
              if (!(latestPrice > 0)) {
                addFlatFallback(currentValueCny);
                return false;
              }

              let cursor = 0;
              let lastPrice: number | null = null;
              const contributedDates = new Set<string>();
              const datedPoints = validPoints.map((point) => ({
                ...point,
                marketDate: ymdFromTimeZone(point.timestamp ?? 0, holding.market),
              }));
              for (const date of targetDates) {
                while (cursor < datedPoints.length && (datedPoints[cursor]?.marketDate ?? "") <= date) {
                  lastPrice = datedPoints[cursor]?.price ?? lastPrice;
                  cursor += 1;
                }
                if (lastPrice == null) continue;
                const price = lastPrice;
                const estimatedValue = currentValueCny * (price / latestPrice);
                totals.set(date, (totals.get(date) ?? 0) + estimatedValue);
                contributionCounts.set(date, (contributionCounts.get(date) ?? 0) + 1);
                contributedDates.add(date);
              }

              for (const date of targetDates) {
                if (contributedDates.has(date)) continue;
                totals.set(date, (totals.get(date) ?? 0) + currentValueCny);
                contributionCounts.set(date, (contributionCounts.get(date) ?? 0) + 1);
              }
              return contributedDates.size > 0;
            } catch (error) {
              console.warn("Failed to load estimated asset series for holding", holding.symbol, error);
              addFlatFallback(currentValueCny);
              return false;
            }
          },
        );

        const hasAnyContribution = results.some((result) => result.status === "fulfilled");
        if (!hasAnyContribution || cancelled) return;

        const points = targetDates.map((date, index) => ({
          date: dateLabelFromYMD(date),
          asset: totals.get(date) ?? 0,
          ts: snapshotToTime(date),
          index,
        })).filter((point) => point.asset > 0 && (contributionCounts.get(targetDates[point.index] ?? "") ?? 0) > 0);

        if (points.length >= 2) {
          writeCachedAssetSeries(seriesCacheKey, points);
          if (!cancelled) setEstimatedAssetSeries({ key: seriesCacheKey, points });
        }
      } catch (error) {
        console.warn("Failed to load estimated asset series", error);
      } finally {
        if (!cancelled) setLoadingEstimated(false);
      }
    };

    void loadEstimatedSeries();
    return () => {
      cancelled = true;
    };
  }, [freshCachedAssetSeries, staleCachedAssetSeries, hasCompleteSnapshotSeries, seriesCacheKey]);

  const assetSeries = useMemo(() => {
    if (hasCompleteSnapshotSeries) return snapshotSeries;
    if (estimatedAssetSeries?.key === seriesCacheKey && estimatedAssetSeries.points.length) {
      return estimatedAssetSeries.points;
    }
    if (freshCachedAssetSeries?.length) return freshCachedAssetSeries;
    if (staleCachedAssetSeries?.length) return staleCachedAssetSeries;
    return snapshotSeries;
  }, [freshCachedAssetSeries, staleCachedAssetSeries, estimatedAssetSeries, hasCompleteSnapshotSeries, seriesCacheKey, snapshotSeries]);

  const todayColor = profitColor(stats.todayPnl);
  const cumulColor = profitColor(stats.unrealizedPnl);
  const realizedColor = profitColor(stats.realizedPnl);
  const totalColor = profitColor(stats.totalInvestmentPnl);
  const costBasis  = stats.costBasis;

  /* ── asset allocation by holding group, same as Holdings page ── */
  const alloc = useMemo(() => {
    const map = new Map<string, { name: string; color: string; value: number }>();
    for (const group of groups) {
      map.set(group.id, { name: groupName(group.id, group.name, language), color: group.color, value: 0 });
    }
    for (const h of holdings) {
      const v = toCNY(h.quantity * h.currentPrice, h.currency);
      const key = h.groupId || UNGROUPED.id;
      const current = map.get(key) ?? { name: groupName("", UNGROUPED.name, language), color: UNGROUPED.color, value: 0 };
      current.value += v;
      map.set(key, current);
    }
    const total = Array.from(map.values()).reduce((s, item) => s + item.value, 0);
    return Array.from(map.entries())
      .map(([id, item]) => ({ id, ...item, pct: total > 0 ? (item.value / total) * 100 : 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [groups, holdings, language]);

  /* ── top movers from real holdings ── */
  const marketTabs = useMemo(() => {
    const seen = new Map<string, number>();
    for (const h of holdings) {
      seen.set(h.market, (seen.get(h.market) ?? 0) + 1);
    }
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([market]) => ({ market, ...getMarketBadge(market, language) }));
  }, [holdings, language]);

  useEffect(() => {
    if (assetFilter === "ALL") return;
    if (!marketTabs.some((tab) => tab.market === assetFilter)) {
      setAssetFilter("ALL");
    }
  }, [assetFilter, marketTabs]);

  const topMovers = useMemo(() => {
    const filtered = assetFilter === "ALL" ? holdings : holdings.filter((h) => h.market === assetFilter);
    const sorted = [...filtered].sort((a, b) => {
      const av = toCNY(a.todayPnl, a.currency);
      const bv = toCNY(b.todayPnl, b.currency);
      if (pnlSort === "gain") return bv - av;          // 盈利多的在前
      if (pnlSort === "loss") return av - bv;          // 亏损多的在前
      return Math.abs(bv) - Math.abs(av);              // 波动大的在前
    });
    return sorted.slice(0, 20);
  }, [holdings, pnlSort, assetFilter]);

  const dashboardRefreshing = isRefreshing || manualRefreshing;
  const dismissedNoticeKeySet = useMemo(() => new Set(dismissedNoticeKeys), [dismissedNoticeKeys]);
  const corporateActionNotices = useMemo(
    () => getRecentCorporateActionNotices(
      portfolioEvents,
      noticeToday,
      CORPORATE_ACTION_NOTICE_RETENTION_DAYS,
      dismissedNoticeKeySet,
    ),
    [dismissedNoticeKeySet, noticeToday, portfolioEvents],
  );

  const corporateActionLabel = useCallback((event: (typeof corporateActionNotices)[number]) => {
    const type = event.type;
    if (type === "cash_dividend") return text.dashboard.actionCashDividend;
    if (type === "dividend_reinvest") return text.dashboard.actionDividendReinvest;
    if (type === "share_dividend") return text.dashboard.actionShareDividend;
    if (type === "split") return event.corporateActionKind === "share_bonus_transfer"
      ? text.dashboard.actionShareBonusTransfer
      : text.dashboard.actionSplit;
    if (type === "interest") return text.dashboard.actionInterest;
    if (type === "bond_coupon") return text.dashboard.actionBondCoupon;
    return type;
  }, [text.dashboard]);
  const latestCorporateActionNotice = corporateActionNotices[0];
  const hasActionRequiredNotice = corporateActionNotices.some(
    (event) => event.type === "split" || event.type === "share_dividend",
  );
  const noticeAccent = hasActionRequiredNotice ? "#D97706" : "#4F9CF9";

  useEffect(() => {
    if (!isRefreshing) setManualRefreshing(false);
  }, [isRefreshing]);

  useEffect(() => {
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNextDay = () => {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      midnightTimer = setTimeout(() => {
        setNoticeToday(new Date());
        scheduleNextDay();
      }, Math.max(1_000, nextDay.getTime() - now.getTime()));
    };
    scheduleNextDay();
    return () => {
      if (midnightTimer) clearTimeout(midnightTimer);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    if (dashboardRefreshing) return;
    setManualRefreshing(true);
    void refresh();
  }, [refresh, dashboardRefreshing]);

  const dismissCorporateActionNotices = useCallback(() => {
    const nextKeys = mergeDismissedCorporateActionNoticeKeys(dismissedNoticeKeys, corporateActionNotices);
    writeDismissedCorporateActionNoticeKeys(nextKeys);
    setDismissedNoticeKeys(nextKeys);
    setNoticesExpanded(false);
  }, [corporateActionNotices, dismissedNoticeKeys]);

  const dismissCorporateActionNotice = useCallback((event: PortfolioEvent) => {
    const nextKeys = mergeDismissedCorporateActionNoticeKeys(dismissedNoticeKeys, [event]);
    writeDismissedCorporateActionNoticeKeys(nextKeys);
    setDismissedNoticeKeys(nextKeys);
  }, [dismissedNoticeKeys]);

  const { isSidePanel, switchTitle, toggleView: handleSwitchView } = useViewSwitcher();

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 h-[50px] border-b border-app-border backdrop-blur-sm"
        style={{ background: "color-mix(in srgb, var(--bg) 92%, transparent)" }}
      >
        <div className="flex shrink-0 items-center gap-2">
          <BrandMark size={28} />
          <span className="text-tp text-sm font-semibold tracking-tight">{text.appName}</span>
        </div>
        <div className="ml-2 flex min-w-0 items-center gap-2">
          <span
            className={`max-w-[82px] truncate text-[11px] ${lastRefreshError ? "font-semibold text-[#D97706]" : "text-tm"}`}
            title={lastRefreshError || lastRefreshed}
            aria-label={lastRefreshError || lastRefreshed}
          >
            {lastRefreshError ? (language === "en" ? "Sync issue" : "同步异常") : lastRefreshed}
          </span>
          <button
            onClick={togglePrivacy}
            className="flex items-center justify-center rounded-lg size-[30px] bg-app-card"
            aria-label={privacyMode ? (language === "en" ? "Show asset amounts" : "显示资产金额") : (language === "en" ? "Hide asset amounts" : "隐藏资产金额")}
            title={privacyMode ? (language === "en" ? "Show asset amounts" : "显示资产金额") : (language === "en" ? "Hide asset amounts" : "隐藏资产金额")}
          >
            {privacyMode ? <EyeOff size={14} color="var(--text-secondary)" /> : <Eye size={14} color="var(--text-secondary)" />}
          </button>
          <button onClick={handleSwitchView}
            className="flex items-center justify-center rounded-lg size-[30px] bg-app-card"
            title={switchTitle}
            aria-label={switchTitle}>
            {isSidePanel
              ? <PanelRightClose size={14} color="var(--text-secondary)" />
              : <PanelRightOpen size={14} color="var(--text-secondary)" />}
          </button>
          <button onClick={handleRefresh}
            className="flex items-center justify-center rounded-lg size-[30px] bg-app-card"
            aria-label={text.common.refresh}
            aria-busy={dashboardRefreshing}
            disabled={dashboardRefreshing}>
            <RefreshCw
              size={14}
              color={dashboardRefreshing ? "#4F9CF9" : "var(--text-secondary)"}
              className={dashboardRefreshing ? "animate-spin-smooth" : undefined}
            />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 16 }}
      >
      {corporateActionNotices.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="relative mx-3 mt-3 overflow-hidden rounded-xl border"
          style={{
            borderColor: `${noticeAccent}40`,
            borderLeftWidth: 3,
            background: `${noticeAccent}10`,
          }}
        >
          <div className="flex items-center">
            <button
              type="button"
              className="min-w-0 flex-1 flex items-center gap-2.5 pl-2.5 pr-2 py-3 text-left"
              onClick={() => setNoticesExpanded((current) => !current)}
              aria-expanded={noticesExpanded}
            >
              <span
                className="relative flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: `${noticeAccent}1F`, color: noticeAccent }}
              >
                {hasActionRequiredNotice ? <AlertTriangle size={17} /> : <Bell size={17} />}
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-app-card bg-[#F24E4E]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-tp text-[13px] font-bold">{text.dashboard.actionNoticeTitle}</span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ background: `${noticeAccent}1F`, color: noticeAccent }}
                  >
                    {text.dashboard.actionNoticeCount(corporateActionNotices.length)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] font-medium text-ts">
                  {latestCorporateActionNotice && [
                    text.dashboard.actionNoticeSummary(
                      latestCorporateActionNotice.name || latestCorporateActionNotice.symbol || text.dashboard.unknownHolding,
                      corporateActionLabel(latestCorporateActionNotice),
                    ),
                    corporateActionNoticeMeta(latestCorporateActionNotice, privacyMode, language),
                    latestCorporateActionNotice.date.slice(5),
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
              {noticesExpanded
                ? <ChevronUp size={16} color={noticeAccent} />
                : <ChevronDown size={16} color={noticeAccent} />}
            </button>
            <button
              type="button"
              className="mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-app-control"
              onClick={dismissCorporateActionNotices}
              title={text.dashboard.actionNoticeDismiss}
              aria-label={text.dashboard.actionNoticeDismiss}
            >
              <X size={14} color={noticeAccent} />
            </button>
          </div>
          {noticesExpanded && (
            <div
              className="border-t px-3"
              style={{ borderColor: `${noticeAccent}24` }}
            >
              {corporateActionNotices.slice(0, 5).map((event) => (
                <div key={event.id} className="flex items-center gap-2 border-b border-app-border py-2.5 last:border-b-0">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: (event.type === "split" || event.type === "share_dividend") ? "#D97706" : "#4F9CF9" }}
                  />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-tp">
                      <span className="truncate">{event.name || event.symbol || text.dashboard.unknownHolding}</span>
                      {(event.type === "split" || event.type === "share_dividend") && (
                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(217,119,6,0.14)", color: "#D97706" }}>
                          {language === "en" ? "Check shares" : "需核对份额"}
                        </span>
                      )}
                    </p>
                    <p className="text-tm text-[10px] mt-0.5 truncate">
                      {[corporateActionLabel(event), corporateActionNoticeMeta(event, privacyMode, language)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <span className="ml-auto text-tmi text-[10px] shrink-0">{event.date}</span>
                  <button
                    type="button"
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-app-control"
                    onClick={() => dismissCorporateActionNotice(event)}
                    title={text.dashboard.actionNoticeDismissOne}
                    aria-label={text.dashboard.actionNoticeDismissOne}
                  >
                    <X size={12} color="var(--text-muted)" />
                  </button>
                </div>
              ))}
              {corporateActionNotices.length > 5 && (
                <p className="text-tmi text-[10px] text-center py-2">
                  {text.dashboard.actionNoticeMore(corporateActionNotices.length - 5)}
                </p>
              )}
            </div>
          )}
        </motion.div>
      )}
      {/* Hero Card */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="mx-3 mt-3 rounded-2xl p-4 bg-app-surface border border-app-accent/15">
        {/* ── Row 1: total asset (primary) + today P/L (accent) ── */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-tm text-[11px] mb-0.5">{text.dashboard.totalAsset}</p>
            <p className="text-tp text-[26px] font-bold tracking-tighter leading-tight">
              {privacyMode ? `${currency} ******` : formatExactMoney(convertCurrency(stats.totalAsset, "CNY", currency), currency, 2)}
            </p>
            <p className="text-tm text-[10px] mt-0.5">
              ≈ {privacyMode ? "***" : formatExactMoney(stats.usdEquiv, "USD", 2)} USD
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-tm text-[10px]">{text.dashboard.todayPnl}</p>
            <p className="truncate text-base font-bold tracking-tight" style={{ color: todayColor }}>
              {fmtPnl(stats.todayPnl, privacyMode, todayColor, currency)}
            </p>
            <div className="mt-0.5">{fmtRate(stats.todayPnlRate, todayColor)}</div>
          </div>
        </div>

        {/* ── Row 2: cost basis + position count (auxiliary, small) ── */}
        <div className="flex items-center justify-between gap-3 mt-2">
          <p className="text-tm text-[10px]">
            {text.dashboard.costBasis} {privacyMode ? `${currency} ***` : formatExactMoney(convertCurrency(costBasis, "CNY", currency), currency, 2)}
          </p>
          <p className="text-tmi text-[10px]">{text.dashboard.positionsGroups(holdings.length, groups.length)}</p>
        </div>

        {/* ── Row 3: total + unrealized + realized P/L (3 cols) ── */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-2 mt-3 pt-3 border-t border-app-border">
          <div className="min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.totalInvestmentPnl}</p>
            <p className="truncate text-sm font-semibold tracking-tight">{fmtPnl(stats.totalInvestmentPnl, privacyMode, totalColor, currency)}</p>
            <div>{fmtRate(stats.totalInvestmentRate, totalColor)}</div>
          </div>
          <div className="min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.totalPnl}</p>
            <p className="truncate text-sm font-semibold tracking-tight">{fmtPnl(stats.unrealizedPnl, privacyMode, cumulColor, currency)}</p>
            <div>{fmtRate(stats.unrealizedRate, cumulColor)}</div>
          </div>
          <div className="min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.realizedPnl}</p>
            <p className="truncate text-sm font-semibold tracking-tight">{fmtPnl(stats.realizedPnl, privacyMode, realizedColor, currency)}</p>
            <div>{fmtRate(stats.realizedRate, realizedColor)}</div>
          </div>
        </div>

        {/* 30-day trend */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-tm text-[10px]">
              {hasCompleteSnapshotSeries ? text.dashboard.snapshotTrend : text.dashboard.estimatedTrend}
            </span>
            {loadingEstimated && (
              <span className="text-tmi text-[9px]" style={{ color: "#4F9CF9" }}>{text.common.loading}</span>
            )}
          </div>
          <div style={{ height: 50 }}>
            {assetSeries.length >= 2 ? (
              <ResponsiveContainer width="100%" height={50}>
                <AreaChart data={assetSeries} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={heroGradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F9CF9" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#4F9CF9" stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis domain={["auto", "auto"]} hide />
                  <Area type="monotone" dataKey="asset" stroke="#4F9CF9" strokeWidth={1.5}
                    fill={`url(#${heroGradId})`} dot={false} isAnimationActive={false} />
                  <Tooltip content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)",
	                        borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--text-primary)" }}>
	                        <div>{payload[0]?.payload?.date}</div>
	                        <div style={{ color: "#4F9CF9" }}>
		                          {privacyMode ? `${currency} ***` : formatExactMoney(convertCurrency(Number(payload[0]?.value), "CNY", currency), currency, 2)}
	                        </div>
	                      </div>
                    ) : null}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full">
                <span className="text-tmi text-[10px]">
                  {loadingEstimated ? text.dashboard.trendLoading : holdings.length > 0 ? text.dashboard.noTrend : text.dashboard.addHoldingsForTrend}
                </span>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Asset Allocation */}
      {alloc.length > 0 && (
        <div className="mt-4 px-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-ts text-xs font-medium">{text.dashboard.allocation}</span>
            <button onClick={() => navigate("/holdings")}
              className="text-app-accent text-[11px]">{text.dashboard.holdingDetails}</button>
          </div>
          <div className="rounded-xl p-3 bg-app-card border border-app-border">
            {/* Stacked bar */}
            <div className="flex rounded-full overflow-hidden gap-px mb-3 h-2">
              {alloc.map(({ id, color, pct }) => (
                <div key={id} className="min-w-0.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
              ))}
            </div>
            {/* Legend */}
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {alloc.map(({ id, name, color, value, pct }) => (
                <div key={id} className="flex items-center gap-1.5">
                  <div className="rounded-full size-1.5" style={{ background: color }} />
                  <span className="text-tm text-[10px]">{name}</span>
                  <span className="text-ts text-[10px] font-medium">
                    {privacyMode ? "**" : formatExactMoney(convertCurrency(value, "CNY", currency), currency, 2)}
                  </span>
                  <span className="text-tmi text-[10px]">{formatPercent(pct / 100)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Today's Movers — from real holdings */}
      {holdings.length > 0 && (
        <div className="mt-4 px-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-ts text-xs font-medium">{text.dashboard.movers}</span>
            <div className="flex items-center gap-1">
              {([
                { k: "gain", label: text.dashboard.gainRank },
                { k: "loss", label: text.dashboard.lossRank },
                { k: "abs",  label: text.dashboard.volatilityRank },
              ] as const).map(({ k, label }) => (
                <button key={k} onClick={() => setPnlSort(k)}
                  style={{
                    fontSize: 10, padding: "2px 7px", borderRadius: 6,
                    background: pnlSort === k ? "rgba(79,156,249,0.15)" : "transparent",
                    color:      pnlSort === k ? "#4F9CF9" : "var(--text-muted)",
                    border:     pnlSort === k ? "1px solid rgba(79,156,249,0.3)" : "1px solid transparent",
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Asset type filter chips */}
          {marketTabs.length > 1 && (
            <div className="flex items-center gap-1 mb-2 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              <button onClick={() => setAssetFilter("ALL")}
                className="shrink-0 rounded-full px-2.5 py-1 transition-colors"
                style={{
                  fontSize: 10, fontWeight: assetFilter === "ALL" ? 600 : 400,
                  background: assetFilter === "ALL" ? "rgba(79,156,249,0.15)" : "var(--bg-control)",
                  color: assetFilter === "ALL" ? "#4F9CF9" : "var(--text-muted)",
                  border: assetFilter === "ALL" ? "1px solid rgba(79,156,249,0.25)" : "1px solid transparent",
                }}>
                {text.common.all}
              </button>
              {marketTabs.map(({ market, label, color }) => {
                const active = assetFilter === market;
                return (
                  <button key={market} onClick={() => setAssetFilter(active ? "ALL" : market)}
                    className="shrink-0 rounded-full px-2.5 py-1 transition-colors"
                    style={{
                      fontSize: 10, fontWeight: active ? 600 : 400,
                      background: active ? `${color}20` : "var(--bg-control)",
                      color: active ? color : "var(--text-muted)",
                      border: active ? `1px solid ${color}40` : "1px solid transparent",
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {topMovers.length > 0 ? (
          <div className="rounded-xl overflow-hidden bg-app-card border border-app-border">
            <div>
              {topMovers
                .map((item, i, arr) => {
                  const c = profitColor(item.todayPnl);
                  const rankBadge = rankBadgeStyle(i);
                  const todayPnlCny = toCNY(item.todayPnl, item.currency);
                  return (
                    <button key={item.id}
                      onClick={() => openDetail({
                        yahooSymbol:   toYahooSymbol(item.symbol, item.market),
                        displaySymbol: item.symbol,
                        name:          item.name,
                        market:        item.market,
                        assetType:     item.assetType,
                        showCurrency:  true,
                        fallbackQuote: {
                          price: item.currentPrice,
                          change: holdingRateChange(item.currentPrice, item.todayPnlRate),
                          changePercent: item.todayPnlRate,
                          currency: item.currency,
                          exchange: "Holding",
                        },
                      })}
                      className="w-full flex items-center px-3 py-2 text-left"
                      style={{ borderBottom: `1px solid ${i < arr.length - 1 ? "var(--border)" : "transparent"}`, background: "transparent" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(79,156,249,0.04)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span className="rounded mr-3 flex items-center justify-center shrink-0"
                        style={{
                          width: 18, height: 18, fontSize: 9, fontWeight: 700,
                          color: rankBadge.color,
                          background: rankBadge.background,
                        }}>
                        {i + 1}
                      </span>
                      <div className="flex-1">
                        <span className="text-tp text-xs font-medium">{item.symbol}</span>
                        <span className="text-tm text-[10px] ml-1.5">{item.name}</span>
                      </div>
                      <div className="text-right">
                        <span style={{ color: c, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                          {item.todayPnl > 0 ? "+" : item.todayPnl < 0 ? "-" : ""}
                          {privacyMode ? "--" : formatExactMoney(convertCurrency(Math.abs(todayPnlCny), "CNY", currency), currency, 2)}
                        </span>
                        <span style={{ color: c, fontSize: 10, marginLeft: 4, whiteSpace: "nowrap" }}>
                          ({formatPercent(item.todayPnlRate, 2)})
                        </span>
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>
          ) : (
            <div className="rounded-xl bg-app-card border border-app-border px-3 py-6 flex items-center justify-center">
              <span className="text-tmi text-[11px]">{text.dashboard.emptyType}</span>
            </div>
          )}
        </div>
      )}

      </div>
    </div>
  );
}
