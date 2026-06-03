import { useEffect, useMemo, useId, useState, useCallback, useRef } from "react";
import { RefreshCw, Eye, EyeOff, TrendingUp } from "lucide-react";
import { useApp } from "../context/AppContext";
import { motion } from "motion/react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useNavigate } from "react-router";
import { fetchRecentDailyChart, toYahooSymbol } from "../services/quoteApi";
import { mapWithConcurrency, toCNY } from "../services/priceRefresher";
import { BrandMark } from "../components/BrandMark";
import { formatExactMoney, formatPercent } from "../utils/numberFormat";
import { getMarketBadge } from "../utils/marketBadge";
import { groupName, t } from "../i18n";

const UNGROUPED = { id: "", name: "未分组", color: "var(--text-micro)" };
const SERIES_DISPLAY_POINTS = 30;
const ASSET_SERIES_CACHE_KEY = "dashboard.assetSeries.v4";
const ASSET_SERIES_CACHE_TTL = 4 * 60 * 60 * 1000;

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

function fmtPnl(v: number, priv: boolean, c: string) {
  const sign = v >= 0 ? "+" : "-";
  return <span style={{ color: c, whiteSpace: "nowrap" }}>{priv ? `${sign}--` : `${sign}${formatExactMoney(Math.abs(v), "CNY", 2)}`}</span>;
}

function fmtRate(v: number, c: string, priv: boolean) {
  return <span style={{ color: c, fontSize: 12 }}>{priv ? "--" : formatPercent(v)}</span>;
}


function snapshotToTime(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 0;
  const stamp = new Date(year, month - 1, day).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
}

function ymdFromTime(time: number) {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
      h.currentPrice,
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
  const { stats, holdings, groups, privacyMode, togglePrivacy, refresh, isRefreshing, lastRefreshed, profitColor, openDetail, tc, assetSnapshots, language } = useApp();
  const text = t(language);
  const navigate = useNavigate();
  const heroGradId = useId().replace(/:/g, "");
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [pnlSort, setPnlSort] = useState<"gain" | "loss" | "abs">("gain");
  const [assetFilter, setAssetFilter] = useState("ALL");
  const [estimatedAssetSeries, setEstimatedAssetSeries] = useState<EstimatedAssetSeries | null>(null);
  const [loadingEstimated, setLoadingEstimated] = useState(false);

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
    if (seriesHoldings.length === 0 || hasCompleteSnapshotSeries) {
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
        const valuedHoldings = seriesHoldings
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

        const results = await mapWithConcurrency(
          valuedHoldings,
          4,
          async ({ holding, currentValueCny }) => {
            const chart = await fetchRecentDailyChart(holding.symbol, holding.market, SERIES_DISPLAY_POINTS + 10);
            const validPoints = chart.points
              .filter((point) => point.price > 0 && point.timestamp)
              .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
            if (validPoints.length < 2) return false;
            const latestPrice = validPoints[validPoints.length - 1]?.price || holding.currentPrice;
            if (!(latestPrice > 0)) return false;

            let cursor = 0;
            let lastPrice: number | null = null;
            for (const date of targetDates) {
              const dayEnd = snapshotToTime(date) + 24 * 60 * 60 * 1000 - 1;
              while (cursor < validPoints.length && (validPoints[cursor]?.timestamp ?? 0) <= dayEnd) {
                lastPrice = validPoints[cursor]?.price ?? lastPrice;
                cursor += 1;
              }
              if (lastPrice == null) continue;
              const price = lastPrice;
              const estimatedValue = currentValueCny * (price / latestPrice);
              totals.set(date, (totals.get(date) ?? 0) + estimatedValue);
              contributionCounts.set(date, (contributionCounts.get(date) ?? 0) + 1);
            }
            return true;
          },
        );

        const hasAnyChart = results.some((result) => result.status === "fulfilled" && result.value === true);
        if (!hasAnyChart || cancelled) return;

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
      } finally {
        if (!cancelled) setLoadingEstimated(false);
      }
    };

    void loadEstimatedSeries();
    return () => {
      cancelled = true;
    };
  }, [freshCachedAssetSeries, staleCachedAssetSeries, hasCompleteSnapshotSeries, seriesHoldings, seriesCacheKey]);

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
  const cumulColor = profitColor(stats.cumulativePnl);
  const costBasis  = stats.totalAsset - stats.cumulativePnl;

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

  const topMovers = useMemo(() => {
    const filtered = assetFilter === "ALL" ? holdings : holdings.filter((h) => h.market === assetFilter);
    const sorted = [...filtered].sort((a, b) => {
      const av = toCNY(a.todayPnl, a.currency);
      const bv = toCNY(b.todayPnl, b.currency);
      if (pnlSort === "gain") return bv - av;          // 盈利多的在前
      if (pnlSort === "loss") return av - bv;          // 亏损多的在前
      return Math.abs(bv) - Math.abs(av);              // 波动大的在前
    });
    return sorted;
  }, [holdings, pnlSort, assetFilter]);

  const dashboardRefreshing = isRefreshing || manualRefreshing;

  useEffect(() => {
    if (!isRefreshing) setManualRefreshing(false);
  }, [isRefreshing]);

  const handleRefresh = useCallback(() => {
    if (dashboardRefreshing) return;
    setManualRefreshing(true);
    void refresh();
  }, [refresh, dashboardRefreshing]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 h-[50px] border-b border-app-border backdrop-blur-sm"
        style={{ background: "color-mix(in srgb, var(--bg) 92%, transparent)" }}
      >
        <div className="flex items-center gap-2">
          <BrandMark size={28} />
          <span className="text-tp text-sm font-semibold tracking-tight">{text.appName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-tm text-[11px]">{lastRefreshed}</span>
          <button onClick={togglePrivacy} className="flex items-center justify-center rounded-lg size-[30px] bg-app-card">
            {privacyMode ? <EyeOff size={14} color="var(--text-secondary)" /> : <Eye size={14} color="var(--text-secondary)" />}
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
      {/* Hero Card */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="mx-3 mt-3 rounded-2xl p-4 bg-app-surface border border-app-accent/15">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-tm text-[11px] mb-0.5">{text.dashboard.totalAsset}</p>
            <p className="text-tp text-[26px] font-bold tracking-tighter leading-tight">
              {privacyMode ? "¥ ******" : formatExactMoney(stats.totalAsset, "CNY", 2)}
            </p>
            <p className="text-tm text-[10px] mt-0.5">
              ≈ {privacyMode ? "***" : formatExactMoney(stats.usdEquiv, "USD", 2)} USD
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-full px-2 py-1"
            style={{ background: `${todayColor}15` }}>
            <span className="text-[10px]" style={{ color: todayColor }}>{text.dashboard.today}</span>
          </div>
        </div>

        <div className="flex gap-3 mt-4 pt-4 border-t border-app-border">
          <div className="flex-1 min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.todayPnl}</p>
            <p className="truncate text-sm font-semibold tracking-tight">{fmtPnl(stats.todayPnl, privacyMode, todayColor)}</p>
            <div>{fmtRate(stats.todayPnlRate, todayColor, privacyMode)}</div>
          </div>
          <div className="w-px shrink-0 bg-app-surface2" />
          <div className="flex-1 min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.cumulativePnl}</p>
            <p className="truncate text-sm font-semibold tracking-tight">{fmtPnl(stats.cumulativePnl, privacyMode, cumulColor)}</p>
            <div>{fmtRate(stats.cumulativeRate, cumulColor, privacyMode)}</div>
          </div>
          <div className="w-px shrink-0 bg-app-surface2" />
          <div className="flex-1 min-w-0">
            <p className="text-tm text-[10px]">{text.dashboard.costBasis}</p>
            <p className="truncate text-tp text-sm font-semibold tracking-tight">
              {privacyMode ? "¥***" : formatExactMoney(costBasis, "CNY", 2)}
            </p>
            <span className="text-tm text-[10px]">{text.dashboard.positionsGroups(holdings.length, groups.length)}</span>
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
		                          {privacyMode ? "¥***" : formatExactMoney(Number(payload[0]?.value), "CNY", 2)}
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
                    {privacyMode ? "**" : formatExactMoney(value, "CNY", 2)}
                  </span>
                  <span className="text-tmi text-[10px]">{formatPercent(pct / 100)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Market Trends → replaced by Market page; show a compact entry banner */}
      <div className="mt-4 px-3">
        <button
          onClick={() => navigate("/market")}
          className="w-full rounded-xl px-4 py-3 flex items-center justify-between"
          style={{
            background: "linear-gradient(135deg, rgba(79,156,249,0.08) 0%, rgba(124,58,237,0.08) 100%)",
            border: "1px solid rgba(79,156,249,0.15)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(79,156,249,0.35)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(79,156,249,0.15)")}
        >
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg flex items-center justify-center"
              style={{ width: 32, height: 32, background: "rgba(79,156,249,0.12)" }}>
              <TrendingUp size={16} color="#4F9CF9" />
            </div>
            <div className="text-left">
              <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{text.dashboard.marketTitle}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.dashboard.marketDesc}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span style={{ color: "#4F9CF9", fontSize: 11 }}>{text.dashboard.view}</span>
            <TrendingUp size={12} color="#4F9CF9" style={{ transform: "rotate(0deg)" }} />
          </div>
        </button>
      </div>

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
                          {item.todayPnl >= 0 ? "+" : "-"}
                          {privacyMode ? "--" : formatExactMoney(Math.abs(todayPnlCny), "CNY", 2)}
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
