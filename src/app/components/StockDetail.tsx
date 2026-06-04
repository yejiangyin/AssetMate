import { useState, useEffect, useId, useCallback, useRef, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft, RefreshCw, Wifi, WifiOff,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
  CartesianGrid,
} from "recharts";
import { motion } from "motion/react";
import { useApp, type DetailTarget } from "../context/AppContext";
import {
  fetchDetailChart, fmtLarge,
  RANGE_TABS, FUND_RANGE_TABS, TimeRange, ChartData, ChartPoint,
} from "../services/quoteApi";
import { emitQuoteSync, getLatestSyncedQuote, isSameQuoteTarget, subscribeQuoteSync } from "../services/quoteSync";
import { buildIntradayViewportPoints, US_SESSION_LABELS, usSessionHasData, pickDefaultUsSession, type UsSessionType } from "../utils/intradayViewport";
import { formatExactMoney, formatExactNumber, formatFixedNumber, formatPercent } from "../utils/numberFormat";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import type { Language } from "../context/AppContext";
import { t } from "../i18n";

const EMPTY_DETAIL_TARGET: DetailTarget = {
  yahooSymbol: "",
  displaySymbol: "",
  name: "",
  market: "US",
  assetType: "stock",
};

/* ─── market badge ───────────────────────────────────── */
function getDetailBadge(market: string, assetType: string | undefined, language: Language) {
  if (market === "A" && assetType === "etf") {
    return { label: language === "en" ? "Listed ETF" : "场内ETF", color: "#4F9CF9", bg: "rgba(79,156,249,0.15)" };
  }
  if (market === "A" && assetType === "fund") {
    return { label: language === "en" ? "Listed Fund" : "场内基金", color: "#31D08B", bg: "rgba(49,208,139,0.15)" };
  }
  return getMarketBadgeWithBg(market, 0.15, language);
}

/* ─── stat row ───────────────────────────────────────── */
function StatRow({ items }: { items: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-px" style={{ background: "var(--bg-card)" }}>
      {items.map((it) => (
        <div key={it.label} className="px-3 py-2.5" style={{ background: "var(--bg)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 2 }}>{it.label}</p>
          <p style={{ color: it.color ?? "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{it.value}</p>
        </div>
      ))}
    </div>
  );
}

/* ─── skeleton ───────────────────────────────────────── */
function Skeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {[80, 200, 120].map((h) => (
        <div key={h} className="rounded-xl" style={{ height: h, background: "var(--bg-card)", animation: "pulse 1.5s ease-in-out infinite" }} />
      ))}
    </div>
  );
}

/* ─── crosshair cursor for recharts ─────────────────── */
function CrosshairCursor({ points: cursorPoints, width, height, top, left }: any) {
  const point = cursorPoints?.[0];
  if (!point) return null;
  const x = point.x;
  const y = point.y;
  const bottom = top + height;
  const right = left + width;
  return (
    <g pointerEvents="none">
      <line x1={x} x2={x} y1={top} y2={bottom} stroke="rgba(148,163,184,0.65)" strokeWidth="1" strokeDasharray="3 3" />
      <line x1={left} x2={right} y1={y} y2={y} stroke="rgba(148,163,184,0.65)" strokeWidth="1" strokeDasharray="3 3" />
    </g>
  );
}

function isUsRegularSessionTime(time: string) {
  const minute = timeToMinutes(time);
  if (!Number.isFinite(minute)) return false;
  const summerRegular = minute >= timeToMinutes("21:30") || minute <= timeToMinutes("04:00");
  const winterRegular = minute >= timeToMinutes("22:30") || minute <= timeToMinutes("05:00");
  return summerRegular || winterRegular;
}

/* ─── custom chart tooltip ───────────────────────────── */
function formatTooltipTimeLabel(point: any) {
  const timestamp = typeof point?.timestamp === "number" && Number.isFinite(point.timestamp)
    ? point.timestamp
    : null;
  if (timestamp != null) {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) {
      const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      const time = typeof point?.time === "string" && /^\d{1,2}:\d{2}/.test(point.time)
        ? ` ${point.time}`
        : "";
      return `${date}${time}`;
    }
  }
  if (typeof point?.dateLabel === "string" && point.dateLabel) {
    const time = typeof point?.time === "string" && /^\d{1,2}:\d{2}/.test(point.time)
      ? ` ${point.time}`
      : "";
    return `${point.dateLabel}${time}`;
  }
  return point?.time ?? "";
}

function formatTooltipTimeLabelI18n(point: any, language: Language) {
  if (language === "zh") return formatTooltipTimeLabel(point);
  const timestamp = typeof point?.timestamp === "number" && Number.isFinite(point.timestamp)
    ? point.timestamp
    : null;
  if (timestamp != null) {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) {
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const time = typeof point?.time === "string" && /^\d{1,2}:\d{2}/.test(point.time)
        ? ` ${point.time}`
        : "";
      return `${date}${time}`;
    }
  }
  return formatTooltipTimeLabel(point);
}

function ChartTooltip({ active, payload, currency, prefix, decimals = 3, prevClose = 0, regularClose = 0, market = "", upColor, downColor, language = "zh" }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  const value = typeof d?.price === "number" && Number.isFinite(d.price) ? d.price : null;
  const title = formatTooltipTimeLabelI18n(d, language);
  const hoverTime = typeof d?.time === "string" ? d.time : "";
  const reference = market === "US" && hoverTime && !isUsRegularSessionTime(hoverTime) && regularClose > 0
    ? regularClose
    : prevClose;
  const changeValue = value != null && reference > 0 ? (value - reference) : null;
  const changePct = changeValue != null && reference > 0 ? changeValue / reference : null;
  const changeColor = changePct == null ? "var(--text-muted)" : changePct >= 0 ? upColor : downColor;
  return (
    <div style={{
      background: "var(--bg-overlay)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "var(--text-primary)", minWidth: 80,
    }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>{title}</div>
      <div style={{ fontWeight: 700 }}>{value == null ? "—" : currency ? formatExactMoney(value, currency, decimals) : `${prefix ?? ""}${formatFixedNumber(value, decimals)}`}</div>
      {changeValue != null && changePct != null && (
        <div style={{ color: changeColor, marginTop: 2, fontSize: 10, fontWeight: 600 }}>
          <span>{changeValue >= 0 ? "+" : "-"}{currency ? formatExactMoney(Math.abs(changeValue), currency, decimals) : `${prefix ?? ""}${formatFixedNumber(Math.abs(changeValue), decimals)}`}</span>
          <span style={{ marginLeft: 4 }}>{formatPercent(changePct)}</span>
        </div>
      )}
    </div>
  );
}

function formatChartAxisTime(value: unknown, range: TimeRange, isFund: boolean) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    if (range === "fs") {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    if (isFund) {
      if (range === "f1mo" || range === "f3mo" || range === "f6mo" || range === "f1y") {
        return `${d.getMonth() + 1}/${d.getDate()}`;
      }
      return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
    }
    if (range === "1d" || range === "5d") return `${d.getMonth() + 1}/${d.getDate()}`;
    if (range === "1mo" || range === "3mo") return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
    if (range === "1y" || range === "max") return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
  }
  return String(value ?? "");
}

function timeToMinutes(time: string) {
  const [hour = "0", minute = "0"] = time.split(":");
  return Number(hour) * 60 + Number(minute);
}

function intradayPointCoverageScore(points: ChartPoint[]) {
  const valid = points.filter((point) => point.price > 0);
  if (!valid.length) return 0;
  const minutes = valid
    .map((point) => timeToMinutes(point.time))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const span = minutes.length > 1 ? Math.max(0, minutes[minutes.length - 1]! - minutes[0]!) : 0;
  return valid.length * 10000 + span;
}

function pickBestIntradayPoints(...groups: Array<ChartPoint[] | null | undefined>) {
  let best: ChartPoint[] = [];
  let bestScore = 0;
  for (const group of groups) {
    if (!group?.length) continue;
    const score = intradayPointCoverageScore(group);
    if (score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best;
}

function hasMeaningfulQuoteDelta(quote: ChartData["quote"] | null | undefined) {
  if (!quote || !(quote.price > 0) || !(quote.prevClose > 0)) return false;
  if (Math.abs(quote.change) > 0.000001) return true;
  if (Math.abs(quote.changePercent) > 0.000001) return true;
  return Math.abs(quote.price - quote.prevClose) > 0.000001;
}

function pickPreferredDisplayQuote(
  range: TimeRange,
  nextQuote: ChartData["quote"] | null | undefined,
  currentQuote: ChartData["quote"] | null | undefined,
  syncedQuote: ChartData["quote"] | null | undefined,
) {
  if (range === "fs") return nextQuote ?? currentQuote ?? syncedQuote ?? null;
  if (hasMeaningfulQuoteDelta(syncedQuote)) return syncedQuote!;
  if (hasMeaningfulQuoteDelta(currentQuote)) return currentQuote!;
  return nextQuote ?? currentQuote ?? syncedQuote ?? null;
}

function CandlestickChart({
  points,
  height,
  prevClose,
  currentPrice,
  decimals,
  upColor,
  downColor,
  currency,
  prefix,
}: {
  points: ChartPoint[];
  height: number;
  prevClose: number;
  currentPrice: number;
  decimals: number;
  upColor: string;
  downColor: string;
  currency: string;
  prefix: string;
}) {
  const { language } = useApp();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const padTop = 10;
  const padBottom = 20;
  const padLeft = 12;
  const padRight = 84;
  const innerWidth = Math.max(1, width - padLeft - padRight);
  const innerHeight = Math.max(1, height - padTop - padBottom);
  const priceCandidates = points.flatMap((point) => [
    point.low ?? point.price,
    point.high ?? point.price,
    point.open ?? point.price,
    point.close ?? point.price,
  ]).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const minValue = priceCandidates.length ? Math.min(...priceCandidates) : 0;
  const maxValue = priceCandidates.length ? Math.max(...priceCandidates) : 1;
  const span = Math.max(maxValue - minValue, maxValue * 0.02, 1e-6);
  const yMin = minValue - span * 0.05;
  const yMax = maxValue + span * 0.05;
  const stepX = innerWidth / Math.max(points.length, 1);
  const candleWidth = Math.max(3, Math.min(12, stepX * 0.55));

  const mapY = (value: number) => (
    padTop + (yMax - value) / (yMax - yMin || 1) * innerHeight
  );

  const yTicks = [yMax, yMax - (yMax - yMin) / 2, yMin];
  const xTickIndexes = [...new Set([
    0,
    Math.max(0, Math.floor((points.length - 1) / 3)),
    Math.max(0, Math.floor((points.length - 1) * 2 / 3)),
    Math.max(0, points.length - 1),
  ])];

  const hoveredIndex = hovered?.index ?? null;
  const hoveredPoint = hoveredIndex == null ? null : points[hoveredIndex] ?? null;
  const formatValue = (value: number | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
    return currency ? formatExactMoney(value, currency, decimals) : `${prefix ?? ""}${formatFixedNumber(value, decimals)}`;
  };
  const currentPriceText = currentPrice > 0
    ? (currency ? formatExactMoney(currentPrice, currency, decimals) : `${prefix ?? ""}${formatFixedNumber(currentPrice, decimals)}`)
    : "";
  const currentPriceLabelWidth = Math.max(34, currentPriceText.length * 6.1 + 10);
  const currentPriceY = Math.min(
    padTop + innerHeight - 6,
    Math.max(padTop + 10, mapY(currentPrice)),
  );
  const currentPriceLabelX = Math.max(padLeft + innerWidth + 6, width - currentPriceLabelWidth - 2);
  const tooltipWidth = 186;
  const tooltipLeft = hovered
    ? hovered.x > width * 0.58
      ? Math.max(8, hovered.x - tooltipWidth - 14)
      : Math.max(8, Math.min(width - tooltipWidth - 8, hovered.x + 14))
    : 8;
  const tooltipTop = hovered
    ? Math.max(8, Math.min(height - 84, hovered.y < 68 ? hovered.y + 12 : hovered.y - 78))
    : 8;

  return (
    <div ref={rootRef} style={{ width: "100%", height, position: "relative" }}>
      {hoveredPoint && (
        <div
          style={{
            position: "absolute",
            left: tooltipLeft,
            top: tooltipTop,
            zIndex: 2,
            background: "var(--bg-overlay)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--text-primary)",
            minWidth: tooltipWidth,
            pointerEvents: "none",
            boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
          }}
        >
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{formatTooltipTimeLabelI18n(hoveredPoint, language)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "2px 8px" }}>
            <span>{language === "en" ? "Open" : "开"} {formatValue(hoveredPoint.open)}</span>
            <span>{language === "en" ? "Close" : "收"} {formatValue(hoveredPoint.close ?? hoveredPoint.price)}</span>
            <span>{language === "en" ? "High" : "高"} {formatValue(hoveredPoint.high)}</span>
            <span>{language === "en" ? "Low" : "低"} {formatValue(hoveredPoint.low)}</span>
            <span style={{ gridColumn: "1 / -1" }}>{language === "en" ? "Volume" : "量"} {fmtLarge(hoveredPoint.volume)}</span>
          </div>
        </div>
      )}
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={language === "en" ? "Candlestick chart" : "K线图"}>
          {yTicks.map((tick) => {
            const y = mapY(tick);
            const overlapsCurrentPrice = currentPrice > 0 && Math.abs(y - currentPriceY) < 12;
            return (
              <g key={tick}>
                <line x1={padLeft} x2={width - padRight + 4} y1={y} y2={y} stroke="rgba(148,163,184,0.15)" strokeDasharray="3 3" />
                {!overlapsCurrentPrice && (
                  <text x={width - 4} y={y + 3} textAnchor="end" fill="var(--text-secondary)" fontSize="9">
                    {formatFixedNumber(tick, decimals)}
                  </text>
                )}
              </g>
            );
          })}

          {prevClose > 0 && (
            <line
              x1={padLeft}
              x2={width - padRight + 4}
              y1={mapY(prevClose)}
              y2={mapY(prevClose)}
              stroke="rgba(148,163,184,0.35)"
              strokeDasharray="4 3"
            />
          )}

          {currentPrice > 0 && (
            <g>
              <line
                x1={padLeft}
                x2={currentPriceLabelX - 6}
                y1={currentPriceY}
                y2={currentPriceY}
                stroke="rgba(79,156,249,0.92)"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
              <circle cx={currentPriceLabelX - 6} cy={currentPriceY} r="2.6" fill="#4F9CF9" />
              <rect
                x={currentPriceLabelX}
                y={currentPriceY - 10}
                width={currentPriceLabelWidth}
                height={15}
                rx="4"
                fill="rgba(255,255,255,0.98)"
                stroke="rgba(79,156,249,0.78)"
                strokeWidth="1"
              />
              <text x={currentPriceLabelX + 5} y={currentPriceY + 1.3} fill="#4F9CF9" fontSize="8.5" fontWeight="700">
                {currentPriceText}
              </text>
            </g>
          )}

          {hoveredIndex !== null && hoveredPoint && (
            <g pointerEvents="none">
              <line
                x1={padLeft + hoveredIndex * stepX + stepX / 2}
                x2={padLeft + hoveredIndex * stepX + stepX / 2}
                y1={padTop}
                y2={padTop + innerHeight}
                stroke="rgba(148,163,184,0.65)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <line
                x1={padLeft}
                x2={padLeft + innerWidth}
                y1={mapY(hoveredPoint.close ?? hoveredPoint.price)}
                y2={mapY(hoveredPoint.close ?? hoveredPoint.price)}
                stroke="rgba(148,163,184,0.65)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            </g>
          )}

          {points.map((point, index) => {
            const open = point.open ?? point.price;
            const close = point.close ?? point.price;
            const high = point.high ?? Math.max(open, close);
            const low = point.low ?? Math.min(open, close);
            const rise = close >= open;
            const color = rise ? upColor : downColor;
            const x = padLeft + index * stepX + stepX / 2;
            const bodyTop = mapY(Math.max(open, close));
            const bodyBottom = mapY(Math.min(open, close));
            const bodyHeight = Math.max(1.5, bodyBottom - bodyTop);
            return (
              <g key={`${point.time}-${index}`}>
                <line x1={x} x2={x} y1={mapY(high)} y2={mapY(low)} stroke={color} strokeWidth="1" />
                <rect
                  x={x - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  rx="1"
                  fill={rise ? `${color}22` : color}
                  stroke={color}
                  strokeWidth="1"
                />
                <rect
                  x={x - stepX / 2}
                  y={padTop}
                  width={Math.max(stepX, candleWidth)}
                  height={innerHeight}
                  fill="transparent"
                  onMouseEnter={(event) => {
                    const rect = rootRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHovered({ index, x: event.clientX - rect.left, y: event.clientY - rect.top });
                  }}
                  onMouseMove={(event) => {
                    const rect = rootRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHovered({ index, x: event.clientX - rect.left, y: event.clientY - rect.top });
                  }}
                  onMouseLeave={() => setHovered((current) => (current?.index === index ? null : current))}
                />
              </g>
            );
          })}

          {xTickIndexes.map((index) => {
            const point = points[index];
            if (!point) return null;
            const x = padLeft + index * stepX + stepX / 2;
            const isFirst = index === 0;
            const isLast = index === points.length - 1;
            return (
              <text
                key={`${point.time}-${index}`}
                x={isFirst ? padLeft : isLast ? width - padRight - 4 : x}
                y={height - 4}
                textAnchor={isFirst ? "start" : isLast ? "end" : "middle"}
                fill="var(--text-secondary)"
                fontSize="9"
              >
                {point.time}
              </text>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function ChartNavigator({
  points,
  viewWindow,
  lineColor,
  minSpan,
  maxSpan,
  onChange,
}: {
  points: ChartPoint[];
  viewWindow: { startIndex: number; endIndex: number };
  lineColor: string;
  minSpan: number;
  maxSpan: number;
  onChange: (window: { startIndex: number; endIndex: number }) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<null | {
    mode: "move" | "left" | "right";
    startX: number;
    startIndex: number;
    endIndex: number;
  }>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || width <= 0 || points.length < 2) return;
      const maxIndex = points.length - 1;
      const minWindowSpan = Math.max(0, Math.min(maxIndex, minSpan - 1));
      const maxWindowSpan = Math.max(minWindowSpan, Math.min(maxIndex, maxSpan - 1));
      const deltaIndex = Math.round((event.clientX - drag.startX) / width * maxIndex);

      if (drag.mode === "move") {
        const span = drag.endIndex - drag.startIndex;
        const nextStart = Math.max(0, Math.min(maxIndex - span, drag.startIndex + deltaIndex));
        onChange({ startIndex: nextStart, endIndex: nextStart + span });
        return;
      }

      if (drag.mode === "left") {
        const boundedStart = Math.max(0, Math.min(drag.endIndex - minWindowSpan, drag.startIndex + deltaIndex));
        const limitedStart = Math.max(drag.endIndex - maxWindowSpan, boundedStart);
        const nextStart = Math.max(0, limitedStart);
        onChange({ startIndex: nextStart, endIndex: drag.endIndex });
        return;
      }

      const boundedEnd = Math.max(drag.startIndex + minWindowSpan, Math.min(maxIndex, drag.endIndex + deltaIndex));
      const limitedEnd = Math.min(drag.startIndex + maxWindowSpan, boundedEnd);
      const nextEnd = Math.max(drag.startIndex + minWindowSpan, limitedEnd);
      onChange({ startIndex: drag.startIndex, endIndex: nextEnd });
    };

    const stopDrag = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [maxSpan, minSpan, onChange, points.length, width]);

  const safeStartIndex = Number.isFinite(viewWindow.startIndex) ? Math.max(0, Math.min(points.length - 1, viewWindow.startIndex)) : 0;
  const safeEndIndex = Number.isFinite(viewWindow.endIndex) ? Math.max(safeStartIndex, Math.min(points.length - 1, viewWindow.endIndex)) : safeStartIndex;

  const maxIndex = Math.max(points.length - 1, 1);
  const chartTop = 5;
  const chartBottom = 31;
  const handleHitWidth = 24;
  const trackInset = 12;
  const trackWidth = Math.max(1, width - trackInset * 2);
  const values = points.map((point) => point.close ?? point.price).filter((value) => Number.isFinite(value) && value > 0);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 1;
  const span = Math.max(maxValue - minValue, maxValue * 0.015, 1e-6);
  const mapX = (index: number) => trackInset + (index / maxIndex) * trackWidth;
  const mapY = (value: number) => {
    const inner = chartBottom - chartTop;
    return chartTop + (maxValue + span * 0.08 - value) / (maxValue - minValue + span * 0.16) * inner;
  };
  const polyline = points
    .map((point, index) => {
      const value = point.close ?? point.price;
      if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) return null;
      return `${mapX(index)},${mapY(value)}`;
    })
    .filter((point): point is string => Boolean(point))
    .join(" ");
  const actualSelectedLeft = mapX(safeStartIndex);
  const actualSelectedRight = mapX(safeEndIndex);
  const actualSelectedWidth = Math.max(0, actualSelectedRight - actualSelectedLeft);
  const denseSelectionMinWidth = actualSelectedWidth / Math.max(trackWidth, 1) < 0.08 ? trackWidth * 0.28 : 0;
  const minVisualSelectionWidth = Math.max(52, trackWidth * 0.2, denseSelectionMinWidth);
  const visualSelectedWidth = Math.max(minVisualSelectionWidth, actualSelectedWidth, handleHitWidth * 2 + 12);
  const visualCenter = (actualSelectedLeft + actualSelectedRight) / 2;
  const selectedLeft = Math.max(trackInset, Math.min(trackInset + trackWidth - visualSelectedWidth, visualCenter - visualSelectedWidth / 2));
  const selectedRight = selectedLeft + visualSelectedWidth;
  const selectedWidth = visualSelectedWidth;

  const beginDrag = (mode: "move" | "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.cancelable) event.preventDefault();
    dragStateRef.current = {
      mode,
      startX: event.clientX,
      startIndex: safeStartIndex,
      endIndex: safeEndIndex,
    };
  };

  if (width <= 0 || points.length < 2 || !values.length) {
    return <div ref={rootRef} style={{ width: "100%", height: 42 }} />;
  }

  return (
    <div
      ref={rootRef}
      style={{
        width: "100%",
        height: 42,
        position: "relative",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <svg width={width} height={42} viewBox={`0 0 ${width} 42`} role="img" aria-label="K线导航缩略轴">
        <defs>
          <linearGradient id="detail-navigator-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <rect x={trackInset} y={chartTop} width={trackWidth} height={chartBottom - chartTop} rx="10" fill="rgba(148,163,184,0.06)" />
        {polyline && (
          <>
            <polyline fill="none" stroke={lineColor} strokeWidth="1.15" points={polyline} />
            <polygon
              fill="url(#detail-navigator-fill)"
              points={`${trackInset},${chartBottom} ${polyline} ${trackInset + trackWidth},${chartBottom}`}
            />
          </>
        )}
        <rect x={trackInset} y={chartTop} width={Math.max(0, selectedLeft - trackInset)} height={chartBottom - chartTop} fill="rgba(15,23,42,0.14)" />
        <rect x={selectedRight} y={chartTop} width={Math.max(0, trackInset + trackWidth - selectedRight)} height={chartBottom - chartTop} fill="rgba(15,23,42,0.14)" />
        <rect
          x={selectedLeft}
          y={chartTop}
          width={selectedWidth}
          height={chartBottom - chartTop}
          rx="10"
          fill="rgba(79,156,249,0.10)"
          stroke="rgba(79,156,249,0.45)"
        />
        {actualSelectedWidth > 0 && actualSelectedWidth < visualSelectedWidth && (
          <line
            x1={actualSelectedLeft}
            x2={actualSelectedRight}
            y1={chartTop + (chartBottom - chartTop) / 2}
            y2={chartTop + (chartBottom - chartTop) / 2}
            stroke="rgba(79,156,249,0.55)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>

      <div
        onPointerDown={beginDrag("move")}
        style={{
          position: "absolute",
          left: selectedLeft,
          top: chartTop,
          width: selectedWidth,
          height: chartBottom - chartTop,
          cursor: "grab",
          zIndex: 1,
        }}
      />

      <div
        onPointerDown={beginDrag("left")}
        style={{
          position: "absolute",
          left: selectedLeft - handleHitWidth / 2 - 3,
          top: chartTop - 1,
          width: handleHitWidth,
          height: chartBottom - chartTop + 2,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "ew-resize",
          zIndex: 2,
        }}
      >
        <div
          style={{
            width: 8,
            height: 16,
            borderRadius: 999,
            background: "var(--bg-overlay, rgba(255,255,255,0.82))",
            border: "1px solid rgba(148,163,184,0.28)",
            boxShadow: "0 1px 4px rgba(15,23,42,0.06)",
            position: "relative",
          }}
        >
          <span style={{ position: "absolute", left: 2.5, top: 3.5, width: 0.5, height: 8, background: "rgba(100,116,139,0.4)" }} />
          <span style={{ position: "absolute", right: 2.5, top: 3.5, width: 0.5, height: 8, background: "rgba(100,116,139,0.4)" }} />
        </div>
      </div>

      <div
        onPointerDown={beginDrag("right")}
        style={{
          position: "absolute",
          left: selectedRight - handleHitWidth / 2 + 3,
          top: chartTop - 1,
          width: handleHitWidth,
          height: chartBottom - chartTop + 2,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "ew-resize",
          zIndex: 2,
        }}
      >
        <div
          style={{
            width: 8,
            height: 16,
            borderRadius: 999,
            background: "var(--bg-overlay, rgba(255,255,255,0.82))",
            border: "1px solid rgba(148,163,184,0.28)",
            boxShadow: "0 1px 4px rgba(15,23,42,0.06)",
            position: "relative",
          }}
        >
          <span style={{ position: "absolute", left: 2.5, top: 3.5, width: 0.5, height: 8, background: "rgba(100,116,139,0.4)" }} />
          <span style={{ position: "absolute", right: 2.5, top: 3.5, width: 0.5, height: 8, background: "rgba(100,116,139,0.4)" }} />
        </div>
      </div>
    </div>
  );
}

function fallbackQuoteData(target: NonNullable<ReturnType<typeof useApp>["detailTarget"]>, language: Language): ChartData | null {
  const fallback = target.fallbackQuote;
  if (!fallback || !(fallback.price > 0)) return null;
  const prevClose = fallback.changePercent
    ? fallback.price / (1 + fallback.changePercent)
    : fallback.price - fallback.change;
  return {
    quote: {
      symbol: target.displaySymbol,
      name: target.name,
      price: fallback.price,
      change: fallback.change,
      changePercent: fallback.changePercent,
      open: prevClose,
      high: Math.max(fallback.price, prevClose),
      low: Math.min(fallback.price, prevClose),
      prevClose,
      volume: 0,
      currency: fallback.currency,
      exchange: fallback.exchange ?? (language === "en" ? "Cached Quote" : "缓存报价"),
      isLive: false,
    },
    points: fallback.points?.filter((point) => point.price > 0) ?? [],
  };
}

function normalizeDisplayName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasChineseName(name: string) {
  return /[\u3400-\u9FFF]/.test(name);
}

type NavigatorCadence = "intraday" | "day" | "week" | "month" | "quarter" | "year";

function inferNavigatorCadence(range: TimeRange, points: ChartPoint[]): NavigatorCadence {
  if (range === "fs") return "intraday";
  if (range === "1d") return "day";
  if (range === "5d" || range === "f1mo" || range === "f3mo") return "week";
  if (range === "1mo" || range === "f6mo") return "month";
  if (range === "3mo" || range === "f1y") return "quarter";
  if (range === "1y" || range === "f3y" || range === "f5y" || range === "f10y" || range === "fmax") return "year";

  const sample = points.find((point) => point.time)?.time ?? "";
  if (/^\d{4}$/.test(sample)) return "year";
  if (/Q\d$/i.test(sample)) return "quarter";
  if (/^\d{2}\/\d{1,2}$/.test(sample)) return "month";
  return "week";
}

function navigatorWindowPolicy(range: TimeRange, points: ChartPoint[]) {
  const totalPoints = points.length;
  const cadence = inferNavigatorCadence(range, points);
  const policy = (() => {
    switch (range) {
      case "fs":
        return { defaultSpan: totalPoints, maxSpan: totalPoints, minSpan: Math.min(totalPoints, 20) };
      case "1d":
        return { defaultSpan: 60, maxSpan: Number.POSITIVE_INFINITY, minSpan: 20 };
      case "5d":
        return { defaultSpan: 52, maxSpan: 104, minSpan: 16 };
      case "1mo":
        return { defaultSpan: 36, maxSpan: 60, minSpan: 12 };
      case "3mo":
        return { defaultSpan: 24, maxSpan: 40, minSpan: 8 };
      case "1y":
        return { defaultSpan: 15, maxSpan: Number.POSITIVE_INFINITY, minSpan: 6 };
      case "max":
      default:
        if (cadence === "year") {
          return { defaultSpan: 15, maxSpan: Number.POSITIVE_INFINITY, minSpan: 6 };
        }
        if (cadence === "week") {
          return { defaultSpan: 104, maxSpan: Number.POSITIVE_INFINITY, minSpan: 16 };
        }
        return { defaultSpan: 60, maxSpan: Number.POSITIVE_INFINITY, minSpan: 12 };
    }
  })();
  return {
    defaultSpan: Math.max(1, Math.min(totalPoints, policy.defaultSpan)),
    maxSpan: Math.max(1, Math.min(totalPoints, policy.maxSpan)),
    minSpan: Math.max(1, Math.min(totalPoints, policy.minSpan)),
  };
}

function detailSourceLabel(market: string, language: Language) {
  const prefix = language === "en" ? "Sources: " : "数据来源：";
  if (market === "HK") return `${prefix}Yahoo Finance · Tencent Quotes · EastMoney`;
  if (market === "CRYPTO") return `${prefix}CoinGecko · Binance · OKX · Yahoo Finance`;
  if (market === "FX") return `${prefix}Yahoo Finance · open.er-api · EastMoney`;
  if (market === "COMMODITY") return `${prefix}Yahoo Finance · EastMoney`;
  if (market === "FUND") return `${prefix}1234567 · EastMoney`;
  if (market === "A") return `${prefix}EastMoney · Tencent Quotes · Yahoo Finance`;
  if (market === "US") return `${prefix}Yahoo Finance · Nasdaq · Robinhood · EastMoney`;
  if (market === "INDEX" || market === "JP") return `${prefix}Yahoo Finance · Nasdaq · EastMoney`;
  return `${prefix}Yahoo Finance · EastMoney`;
}

function buildDefaultChartWindow(points: ChartPoint[], range: TimeRange) {
  const totalPoints = points.length;
  if (totalPoints <= 0) return null;
  const { defaultSpan } = navigatorWindowPolicy(range, points);
  return {
    startIndex: Math.max(0, totalPoints - defaultSpan),
    endIndex: totalPoints - 1,
  };
}

function shouldShowNavigator(market: string, _range: TimeRange, hasNavigableChart: boolean, chartPoints: ChartPoint[], defaultSpan: number) {
  if (!hasNavigableChart) return false;
  if (market === "FUND") return false;
  return chartPoints.length > defaultSpan || chartPoints.length > 8;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function countDisplayPrices(points: Array<ChartPoint & { displayPrice?: number }>) {
  return points.filter((point) => isPositiveFiniteNumber(point.displayPrice ?? point.price)).length;
}

function sessionQuoteFromDisplayQuote(
  quote: ChartData["quote"] | null | undefined,
  session: UsSessionType,
) {
  if (!quote) return null;
  const sessionPriceMap: Partial<Record<UsSessionType, { price?: number; change?: number; changePct?: number }>> = {
    pre:       { price: quote.preMarketPrice, change: quote.preMarketChange, changePct: quote.preMarketChangePercent },
    post:      { price: quote.postMarketPrice, change: quote.postMarketChange, changePct: quote.postMarketChangePercent },
    overnight: { price: quote.overnightPrice, change: quote.overnightChange, changePct: quote.overnightChangePercent },
  };
  const s = sessionPriceMap[session];
  if (isPositiveFiniteNumber(s?.price)) {
    return { price: s.price, change: s.change ?? 0, changePercent: s.changePct ?? 0 };
  }
  return null;
}

/* ═══════════════════════════════════════════════════════
   Main component
══════════════════════════════════════════════════════════ */
export function StockDetail() {
  const { detailTarget, closeDetail, colorScheme, lastRefreshAt, language } = useApp();
  const text = t(language);

  // Keep last valid target so the component can still render during AnimatePresence exit
  const lastTargetRef = useRef<typeof detailTarget>(null);
  if (detailTarget) lastTargetRef.current = detailTarget;
  const displayTarget = detailTarget ?? lastTargetRef.current ?? EMPTY_DETAIL_TARGET;

  const gradId  = useId().replace(/:/g, "");
  const volGrad = useId().replace(/:/g, "");

  const [range,    setRange]    = useState<TimeRange>("fs");
  const [usSession, setUsSession] = useState<UsSessionType | null>(null);
  const [data,     setData]     = useState<ChartData | null>(null);
  const [dataRange, setDataRange] = useState<TimeRange | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [chartWindow, setChartWindow] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const lastSyncedRefreshRef = useRef<number>(0);
  const requestSeqRef = useRef(0);
  const windowContextRef = useRef<string>("");
  const dataRef = useRef<ChartData | null>(null);
  const dataRangeRef = useRef<TimeRange | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    dataRangeRef.current = dataRange;
  }, [dataRange]);

  const load = useCallback(async (
    r: TimeRange,
    options: { force?: boolean; reset?: boolean } = {},
  ) => {
    if (!detailTarget) return;
    const { force = false, reset = false } = options;
    const requestSeq = ++requestSeqRef.current;
    const existingData = reset ? null : dataRef.current;
    const existingDataRange = reset ? null : dataRangeRef.current;
    const hasExistingData = Boolean(existingData);
    if (reset || !hasExistingData) setLoading(true);
    else setRefreshing(true);
    try {
      const result = await fetchDetailChart(
        detailTarget.market === "FUND" ? detailTarget.displaySymbol : detailTarget.yahooSymbol,
        detailTarget.market,
        r,
        force,
      );
      const fallback = fallbackQuoteData(detailTarget, language);
      const currentHasRealPoints = Boolean(
        existingData
        && existingDataRange === r
        && existingData.points.some((point) => point.price > 0),
      );
      const resultHasRealPoints = result.points.some((point) => point.price > 0);
      const hasUsableResult = result.quote.price > 0
        || result.quote.prevClose > 0
        || result.quote.open > 0
        || resultHasRealPoints;
      if (requestSeq !== requestSeqRef.current) return;
      const nextData = hasUsableResult ? result : (fallback ?? result);
      const syncedFsPayload = r === "fs"
        ? getLatestSyncedQuote({
          symbol: detailTarget.yahooSymbol,
          market: detailTarget.market,
          range: "fs",
        })
        : null;
      const latestSyncedFsPayload = getLatestSyncedQuote({
        symbol: detailTarget.yahooSymbol,
        market: detailTarget.market,
        range: "fs",
      });
      const preferredDisplayQuote = detailTarget.market === "FUND"
        ? nextData.quote
        : pickPreferredDisplayQuote(
          r,
          nextData.quote,
          existingData?.quote,
          latestSyncedFsPayload?.quote,
        );
      const syncedFsPoints = syncedFsPayload?.points?.filter((point) => point.price > 0) ?? [];
      const fallbackFsPoints = detailTarget.fallbackQuote?.points?.filter((point) => point.price > 0) ?? [];
      const preferredFsPoints = r === "fs"
        ? pickBestIntradayPoints(
          result.points,
          currentHasRealPoints && existingData ? existingData.points : [],
          syncedFsPoints,
          fallbackFsPoints,
        )
        : [];
      const mergedData = r === "fs" && preferredFsPoints.length
        ? { quote: preferredDisplayQuote ?? nextData.quote, points: preferredFsPoints }
        : !resultHasRealPoints && currentHasRealPoints && existingData
          ? { quote: preferredDisplayQuote ?? nextData.quote, points: existingData.points }
          : { quote: preferredDisplayQuote ?? nextData.quote, points: nextData.points };
      setData(mergedData);
      setDataRange(r);
      emitQuoteSync({
        symbol: detailTarget.yahooSymbol,
        market: detailTarget.market,
        range: r,
        source: "detail",
        quote: mergedData.quote,
        points: mergedData.points,
        refreshedAt: Date.now(),
      });
    } catch {
      if (requestSeq !== requestSeqRef.current) return;
      const fallback = fallbackQuoteData(detailTarget, language);
      const currentHasRealPoints = Boolean(
        existingData
        && existingDataRange === r
        && existingData.points.some((point) => point.price > 0),
      );
      const syncedFsPayload = r === "fs"
        ? getLatestSyncedQuote({
          symbol: detailTarget.yahooSymbol,
          market: detailTarget.market,
          range: "fs",
        })
        : null;
      const syncedFsPoints = syncedFsPayload?.points?.filter((point) => point.price > 0) ?? [];
      const fallbackFsPoints = detailTarget.fallbackQuote?.points?.filter((point) => point.price > 0) ?? [];
      const preferredFsPoints = r === "fs"
        ? pickBestIntradayPoints(
          currentHasRealPoints && existingData ? existingData.points : [],
          syncedFsPoints,
          fallbackFsPoints,
        )
        : [];
      if (fallback) {
        setData(
          preferredFsPoints.length && r === "fs"
            ? { quote: fallback.quote, points: preferredFsPoints }
            : fallback,
        );
        setDataRange(r);
      } else if (preferredFsPoints.length && r === "fs") {
        const syncedQuote = syncedFsPayload?.quote ?? null;
        const fallbackQuote = fallbackQuoteData(detailTarget, language)?.quote ?? null;
        const fallbackCurrency = syncedQuote?.currency ?? fallbackQuote?.currency ?? "";
        setData({
          quote: existingData?.quote ?? syncedQuote ?? fallbackQuote ?? {
            symbol: detailTarget.yahooSymbol,
            name: detailTarget.name,
            price: 0,
            change: 0,
            changePercent: 0,
            open: 0,
            high: 0,
            low: 0,
            prevClose: 0,
            volume: 0,
            currency: fallbackCurrency,
            exchange: "",
            isLive: false,
          },
          points: preferredFsPoints,
        });
        setDataRange(r);
      } else if (!hasExistingData || reset) {
        setData(null);
        setDataRange(null);
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
        setSpinning(false);
      }
    }
  }, [detailTarget, language]);

  useEffect(() => {
    if (!detailTarget) return;
    const defaultRange: TimeRange = detailTarget.market === "FUND" ? "f1y" : "fs";
    setRange(defaultRange);
    setChartWindow(null);
    windowContextRef.current = "";
    setData(null);
    setDataRange(null);
    setRefreshing(false);
    setLoading(true);
    lastSyncedRefreshRef.current = lastRefreshAt;
    void load(defaultRange, { reset: true });
    if (detailTarget.market === "FUND") return;
    const symbol = detailTarget.yahooSymbol;
    const market = detailTarget.market;
    const tid = window.setTimeout(() => {
      void fetchDetailChart(symbol, market, "1d").catch(() => null);
    }, 250);
    return () => window.clearTimeout(tid);
  }, [detailTarget, lastRefreshAt, load]);

  useEffect(() => {
    if (!detailTarget || !lastRefreshAt) return;
    if (lastSyncedRefreshRef.current === lastRefreshAt) return;
    lastSyncedRefreshRef.current = lastRefreshAt;
    void load(range, { force: true });
  }, [lastRefreshAt, detailTarget, range, load]);

  useEffect(() => subscribeQuoteSync((payload) => {
    if (payload.source !== "market" || !detailTarget) return;
    if (!isSameQuoteTarget(
      { symbol: detailTarget.yahooSymbol, market: detailTarget.market },
      { symbol: payload.symbol, market: payload.market },
    )) {
      return;
    }
    setData((current) => {
      if (!current) {
        if (range === "fs" && payload.range === "fs") {
          return {
            quote: payload.quote,
            points: payload.points ?? [],
          };
        }
        return current;
      }
      return {
        quote: payload.quote,
        points: range === "fs" && payload.range === "fs" && payload.points?.length
          ? payload.points
          : current.points,
      };
    });
  }), [detailTarget, range]);

  const handleRange = (r: TimeRange) => {
    if (r === range) return;
    setRange(r);
    setUsSession(null);
    setChartWindow(null);
    windowContextRef.current = "";
    void load(r);
  };

  const handleRefresh = () => {
    if (spinning) return;
    setSpinning(true);
    void load(range, { force: true });
  };
  const q       = data?.quote;
  const isRangeReady = dataRange === range;
  const points = useMemo(() => (isRangeReady ? (data?.points ?? []) : []), [data?.points, isRangeReady]);
  const upColor = colorScheme === "red-up" ? "#F24E4E" : "#31D08B";
  const dnColor = colorScheme === "red-up" ? "#31D08B" : "#F24E4E";
  const hasCandleData = range !== "fs" && points.some((point) =>
    typeof point.open === "number"
    && typeof point.high === "number"
    && typeof point.low === "number"
    && typeof point.close === "number"
    && point.high > 0
    && point.low > 0
  );
  const chartPoints = points;
  const hasNavigableChart = range !== "fs" && chartPoints.filter((point) => point.price > 0).length > 1;
  const windowPolicy = useMemo(
    () => navigatorWindowPolicy(range, chartPoints),
    [chartPoints, range],
  );
  const defaultChartWindow = useMemo(
    () => buildDefaultChartWindow(chartPoints, range),
    [chartPoints, range],
  );
  const windowContextKey = detailTarget
    ? `${detailTarget.yahooSymbol}::${detailTarget.market}::${range}::${chartPoints.length}`
    : "";
  const effectiveChartWindow = hasNavigableChart && detailTarget?.market !== "FUND"
    ? (chartWindow ?? defaultChartWindow)
    : null;
  const visiblePoints = effectiveChartWindow
    ? chartPoints.slice(effectiveChartWindow.startIndex, effectiveChartWindow.endIndex + 1)
    : chartPoints;
  const effectiveUsSession = useMemo(() => {
    if (usSession) return usSession;
    if (range === "fs" && detailTarget?.market === "US") return pickDefaultUsSession(chartPoints);
    return undefined;
  }, [usSession, range, detailTarget?.market, chartPoints]);
  const intradayDisplay = useMemo(
    () => range === "fs" && detailTarget
      ? buildIntradayViewportPoints(visiblePoints, detailTarget.market, detailTarget.yahooSymbol, effectiveUsSession)
      : { points: visiblePoints.map((point) => ({ ...point, displayPrice: point.price, displayVolume: point.volume })), ticks: null as string[] | null },
    [detailTarget, range, visiblePoints, effectiveUsSession],
  );
  const areaChartData = intradayDisplay.points;
  const intradayTicks = intradayDisplay.ticks;
  const useTimeXAxis = range !== "fs" && areaChartData.length > 1 && areaChartData.every((point) => typeof point.timestamp === "number" && Number.isFinite(point.timestamp));
  const canUseNavigator = shouldShowNavigator(detailTarget?.market ?? "", range, hasNavigableChart, chartPoints, windowPolicy.defaultSpan);

  useEffect(() => {
    if (!hasNavigableChart || !defaultChartWindow) {
      windowContextRef.current = "";
      setChartWindow((current) => (current == null ? current : null));
      return;
    }
    if (windowContextRef.current !== windowContextKey) {
      windowContextRef.current = windowContextKey;
      setChartWindow(defaultChartWindow);
      return;
    }
    setChartWindow((current) => {
      if (!current) return defaultChartWindow;
      const startIndex = Math.max(0, Math.min(current.startIndex, chartPoints.length - 1));
      const endIndex = Math.max(startIndex, Math.min(current.endIndex, chartPoints.length - 1));
      if (current.startIndex === startIndex && current.endIndex === endIndex) return current;
      return { startIndex, endIndex };
    });
  }, [chartPoints.length, defaultChartWindow, hasNavigableChart, windowContextKey]);

  const handleNavigatorChange = (next: { startIndex?: number; endIndex?: number }) => {
    if (typeof next.startIndex !== "number" || typeof next.endIndex !== "number") return;
    if (next.endIndex <= next.startIndex) return;
    setChartWindow({
      startIndex: Math.max(0, next.startIndex),
      endIndex: Math.min(chartPoints.length - 1, next.endIndex),
    });
  };
  const priceSource = areaChartData.length > 0 ? areaChartData : visiblePoints;
  const linePrices = priceSource.map((p) => p.price).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const minP = linePrices.length ? Math.min(...linePrices) * 0.995 : 0;
  const maxP = linePrices.length ? Math.max(...linePrices) * 1.005 : 1;

  const { displaySymbol, name, market, assetType } = displayTarget;
  const isNavFund = market === "FUND";
  const rangeTabs = isNavFund ? FUND_RANGE_TABS : RANGE_TABS;
  const badge   = getDetailBadge(market, assetType, language);
  const rawCurrency = q?.currency ?? "";
  const currencyCode = /^[A-Z]{3,5}$/.test(rawCurrency) ? rawCurrency : "";
  const showCurrency = displayTarget.showCurrency ?? !["INDEX", "FX"].includes(market);
  const displayPrefix = !currencyCode && showCurrency ? rawCurrency : "";
  const currency  = showCurrency ? currencyCode : "";
  const unitLabel = displayTarget.unit || rawCurrency;
  const resolvedNames = [name, q?.name ?? ""]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, list) => list.findIndex((candidate) => normalizeDisplayName(candidate) === normalizeDisplayName(item)) === index);
  const primaryName = resolvedNames.find(hasChineseName) ?? resolvedNames[0] ?? displaySymbol;
  const secondaryName = resolvedNames.find((item) => normalizeDisplayName(item) !== normalizeDisplayName(primaryName)) ?? "";
  const resolvedName = secondaryName ? `${primaryName} · ${secondaryName}` : primaryName;
  const decimals = displayTarget.decimals ?? (market === "FUND" ? 4 : 3);
  const syncedFsDisplayQuote = getLatestSyncedQuote({
    symbol: displayTarget.yahooSymbol,
    market: displayTarget.market,
    range: "fs",
  })?.quote ?? null;
  const fallbackDisplayQuote = fallbackQuoteData(displayTarget, language)?.quote ?? null;
  const displayQuote = market === "FUND"
    ? (q ?? fallbackDisplayQuote ?? null)
    : range === "fs"
    ? (q ?? syncedFsDisplayQuote ?? fallbackDisplayQuote)
    : (pickPreferredDisplayQuote(range, q, syncedFsDisplayQuote, fallbackDisplayQuote) ?? q ?? syncedFsDisplayQuote ?? fallbackDisplayQuote ?? null);
  // Keep session-specific quotes for the chart fallback only; the hero quote should stay on the live primary quote.
  const sessionAwareQuote = useMemo(() => {
    if (!displayQuote || market !== "US" || range !== "fs" || !effectiveUsSession) return null;
    return sessionQuoteFromDisplayQuote(displayQuote, effectiveUsSession);
  }, [displayQuote, market, range, effectiveUsSession]);
  const heroPrice = displayQuote?.price;
  const heroChange = displayQuote?.change ?? 0;
  const heroChangePct = displayQuote?.changePercent ?? 0;
  const isUp = heroChange >= 0;
  const lineColor = isUp ? upColor : dnColor;
  const prevClose = displayQuote?.prevClose ?? q?.prevClose ?? 0;
  const hasRealChart = points.some((point) => point.price > 0);
  const sessionHasChart = countDisplayPrices(areaChartData) >= 2;
  const hasSessionVolume = sessionHasChart && areaChartData.some((point) => isPositiveFiniteNumber(point.displayVolume));
  const isRangeLoading = !isRangeReady && (loading || refreshing);
  const showSkeleton = loading && !data;
  const hasQuoteValue = (n: number | undefined | null) => typeof n === "number" && Number.isFinite(n) && n > 0;
  const formatQuoteValue = (n: number | undefined | null) => (
    showCurrency && currencyCode ? formatExactMoney(n, currencyCode, decimals)
    : showCurrency && displayPrefix ? `${displayPrefix}${formatFixedNumber(n, decimals)}`
    : formatFixedNumber(n, decimals)
  );
  const formatMaybeQuoteValue = (n: number | undefined | null) => hasQuoteValue(n) ? formatQuoteValue(n) : "—";
  const fundRangePrices = isNavFund
    ? chartPoints
      .map((point) => point.price)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    : [];
  const fundRangeHigh = fundRangePrices.length ? Math.max(...fundRangePrices) : displayQuote?.high;
  const fundRangeLow = fundRangePrices.length ? Math.min(...fundRangePrices) : displayQuote?.low;

  // Stats rows
  const statQuote = isRangeReady ? displayQuote : null;
  const statItems = isNavFund
    ? [
      { label: language === "en" ? "Latest NAV" : "最新净值", value: statQuote ? formatMaybeQuoteValue(statQuote.price) : "—" },
      { label: language === "en" ? "Prev NAV" : "上一净值", value: statQuote ? formatMaybeQuoteValue(statQuote.prevClose) : "—" },
      { label: language === "en" ? "Range High" : "区间高",   value: statQuote ? formatMaybeQuoteValue(fundRangeHigh) : "—", color: upColor },
      { label: language === "en" ? "Range Low" : "区间低",   value: statQuote ? formatMaybeQuoteValue(fundRangeLow) : "—",  color: dnColor },
      { label: language === "en" ? "Source" : "数据源",   value: statQuote?.exchange || "—" },
      { label: "",        value: "" },
    ]
    : [
      { label: language === "en" ? "Open" : "今开",    value: statQuote ? formatMaybeQuoteValue(statQuote.open) : "—" },
      { label: language === "en" ? "Prev Close" : "昨收",    value: statQuote ? formatMaybeQuoteValue(statQuote.prevClose) : "—" },
      { label: language === "en" ? "High" : "最高",    value: statQuote ? formatMaybeQuoteValue(statQuote.high) : "—",  color: upColor },
      { label: language === "en" ? "Low" : "最低",    value: statQuote ? formatMaybeQuoteValue(statQuote.low) : "—",   color: dnColor },
      { label: language === "en" ? "Volume" : "成交量",  value: statQuote ? fmtLarge(statQuote.volume) : "—" },
      { label: language === "en" ? "Exchange" : "交易所",  value: statQuote?.exchange || "—" },
      ...(statQuote?.week52High != null ? [{ label: language === "en" ? "52W High" : "52W高", value: formatQuoteValue(statQuote.week52High), color: upColor }] : []),
      ...(statQuote?.week52Low  != null ? [{ label: language === "en" ? "52W Low" : "52W低", value: formatQuoteValue(statQuote.week52Low),  color: dnColor }] : []),
      ...(statQuote?.marketCap  != null && currencyCode ? [{ label: language === "en" ? "Market Cap" : "市值",   value: formatExactMoney(statQuote.marketCap, currencyCode, 2) }] : []),
      ...(statQuote?.pe         != null ? [{ label: language === "en" ? "P/E" : "市盈率", value: formatExactNumber(statQuote.pe) }] : []),
    ];

  // Make items even
  if (statItems.length % 2 !== 0) statItems.push({ label: "", value: "" });

  return (
    <motion.div
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 340 }}
      className="absolute inset-0 flex flex-col"
      style={{ background: "var(--bg)", zIndex: 60 }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{ height: 50, borderBottom: "1px solid var(--border)" }}
      >
        <button
          onClick={closeDetail}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={16} />
          <span style={{ fontSize: 12 }}>{text.common.back}</span>
        </button>

        <div className="min-w-0 flex flex-col items-center px-2">
          <div className="flex items-center gap-2 min-w-0">
            <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700 }}>{displaySymbol}</span>
            <span
              className="rounded px-1.5 py-0.5 shrink-0"
              style={{ fontSize: 10, fontWeight: 700, color: badge.color, background: badge.bg }}
            >
              {badge.label}
            </span>
          </div>
          <p
            className="truncate max-w-[180px]"
            style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2, textAlign: "center" }}
            title={resolvedName}
          >
            {resolvedName}
          </p>
        </div>

        <button
          onClick={handleRefresh}
          className="rounded-lg p-1.5"
          aria-label={text.common.refresh}
          aria-busy={spinning}
          disabled={spinning}
          style={{ background: "var(--bg-card)" }}
        >
          <RefreshCw
            size={14}
            color={spinning ? "#4F9CF9" : "var(--text-muted)"}
            className={spinning ? "animate-spin-smooth" : undefined}
          />
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div
        className="flex-1 overflow-y-auto"
        style={{
          scrollbarWidth: "none",
          overscrollBehaviorY: "contain",
          WebkitOverflowScrolling: "touch",
        }}
      >

        {showSkeleton ? (
          <Skeleton />
        ) : (
          <>
            {/* ── Live Quote ── */}
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-end justify-between">
                <div>
                  <p style={{ color: "var(--text-primary)", fontSize: 30, fontWeight: 800, letterSpacing: "-1px", lineHeight: 1 }}>
                    {heroPrice ? formatQuoteValue(heroPrice) : "—"}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span style={{ color: lineColor, fontSize: 13, fontWeight: 600 }}>
                      {isUp ? "▲" : "▼"} {heroPrice ? formatQuoteValue(Math.abs(heroChange)) : "—"}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5"
                      style={{ fontSize: 11, fontWeight: 700, background: `${lineColor}18`, color: lineColor }}
                    >
                      {heroPrice ? formatPercent(heroChangePct) : "—"}
                    </span>
                  </div>
                </div>

                <div className="text-right">
                  <div className="flex items-center gap-1.5 justify-end mb-1">
                    {(displayQuote?.isLive ?? q?.isLive)
                      ? <><Wifi size={11} color="#31D08B" /><span style={{ color: "#31D08B", fontSize: 10 }}>{text.common.live}</span></>
                      : <><WifiOff size={11} color="var(--text-muted)" /><span style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Cached" : "缓存"}</span></>
                    }
                    {refreshing && (
                      <span style={{ color: "var(--text-micro)", fontSize: 10, marginLeft: 4 }}>{language === "en" ? "Updating" : "更新中"}</span>
                    )}
                  </div>
                  <p style={{ color: "var(--text-muted)", fontSize: 11 }}>{displayQuote?.exchange ?? q?.exchange}</p>
                  {unitLabel && <p style={{ color: "var(--text-micro)", fontSize: 10 }}>{unitLabel}</p>}
                </div>
              </div>

              {/* ── Extended Hours (US stocks) ── */}
              {market === "US" && (() => {
                const cards = [
                  {
                    label: language === "en" ? "Pre" : "盘前",
                    price: displayQuote?.preMarketPrice,
                    change: displayQuote?.preMarketChange,
                    changePct: displayQuote?.preMarketChangePercent,
                  },
                  {
                    label: language === "en" ? "Post" : "盘后",
                    price: displayQuote?.postMarketPrice,
                    change: displayQuote?.postMarketChange,
                    changePct: displayQuote?.postMarketChangePercent,
                  },
                  {
                    label: language === "en" ? "Overnight" : "夜盘",
                    price: displayQuote?.overnightPrice,
                    change: displayQuote?.overnightChange,
                    changePct: displayQuote?.overnightChangePercent,
                  },
                ];
                const visibleCards = cards.filter((card) => card.price && card.price > 0);
                if (!visibleCards.length) return null;

                return (
                  <div className={`grid gap-2 mt-3 ${visibleCards.length === 1 ? "grid-cols-1" : visibleCards.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
                    {visibleCards.map((card) => {
                      const cardIsUp = (card.change ?? 0) >= 0;
                      const cardColor = cardIsUp ? upColor : dnColor;
                      return (
                        <div
                          key={card.label}
                          className="rounded-lg px-2 py-1.5"
                          style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
                        >
                          <p style={{ color: "var(--text-muted)", fontSize: 9, fontWeight: 700 }}>{card.label}</p>
                          <p
                            className="truncate"
                            style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 800 }}
                          >
                            {formatQuoteValue(card.price!)}
                          </p>
                          {card.changePct != null && (
                            <p style={{ color: cardColor, fontSize: 9, fontWeight: 700 }}>
                              {formatPercent(card.changePct)}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* ── Time Range Tabs ── */}
            <div className="flex px-4 gap-1 pb-2">
              {rangeTabs.map((t) => (
                <button
                  key={t.value}
                  onClick={() => handleRange(t.value)}
                  className="flex-1 rounded-lg py-1.5 transition-all"
                  style={{
                    background: range === t.value ? lineColor : "var(--bg-card)",
                    color:      range === t.value ? "#fff"     : "var(--text-muted)",
                    fontSize: 11, fontWeight: 600,
                  }}
                >
                  {language === "en"
                    ? ({
                        fs: "Intraday",
                        "1d": "Day",
                        "5d": "Week",
                        "1mo": "Month",
                        "3mo": "Quarter",
                        "1y": "Year",
                        max: "All",
                        f1mo: "1M",
                        f3mo: "3M",
                        f6mo: "6M",
                        f1y: "1Y",
                        f3y: "3Y",
                        f5y: "5Y",
                        f10y: "10Y",
                        fmax: "All",
                      } as Partial<Record<TimeRange, string>>)[t.value] ?? t.label
                    : t.label}
                </button>
              ))}
            </div>

            {/* ── US session sub-tabs (only for 分时 + US stocks) ── */}
            {range === "fs" && market === "US" && (
              <div className="flex items-center gap-0.5 px-4">
                {US_SESSION_LABELS.map((s) => {
                  const active = effectiveUsSession === s.value;
                  const hasData = s.value === "full"
                    || usSessionHasData(chartPoints, s.value)
                    || Boolean(sessionQuoteFromDisplayQuote(displayQuote, s.value));
                  return (
                    <button
                      key={s.value}
                      onClick={() => setUsSession(s.value)}
                      disabled={!hasData}
                      className="rounded px-2 py-0.5 transition-colors"
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        background: active ? "var(--bg-surface2)" : "transparent",
                        color: active ? "var(--text-primary)" : hasData ? "var(--text-muted)" : "var(--text-micro)",
                        opacity: hasData ? 1 : 0.4,
                      }}
                    >
                      {language === "en"
                        ? ({ pre: "Pre", regular: "Regular", post: "Post", full: "Full" } as Partial<Record<UsSessionType, string>>)[s.value] ?? s.label
                        : s.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Price Chart ── */}
            <div style={{ height: 170, position: "relative" }}>
              {hasRealChart && sessionHasChart ? (
                hasCandleData ? (
                  <CandlestickChart
                    points={visiblePoints}
                    height={170}
                    prevClose={prevClose}
                    currentPrice={displayQuote?.price ?? q?.price ?? 0}
                    decimals={decimals}
                    upColor={upColor}
                    downColor={dnColor}
                    currency={currency}
                    prefix={displayPrefix}
                  />
                ) : (
                  <ResponsiveContainer width="100%" height={170}>
                    <AreaChart data={areaChartData} margin={{ top: 8, right: 8, left: 8, bottom: 2 }}>
                      <defs>
                        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor={lineColor} stopOpacity={0.25} />
                          <stop offset="100%" stopColor={lineColor} stopOpacity={0}    />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" vertical={false} />
                      <XAxis
                        dataKey={useTimeXAxis ? "timestamp" : "time"}
                        type={useTimeXAxis ? "number" : "category"}
                        domain={useTimeXAxis ? ["dataMin", "dataMax"] : undefined}
                        scale={useTimeXAxis ? "time" : undefined}
                        ticks={useTimeXAxis ? undefined : intradayTicks as string[] ?? undefined}
                        tick={{ fontSize: 9, fill: "var(--text-muted)", fontFamily: "inherit", fontWeight: 600 }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        tickFormatter={(v) => formatChartAxisTime(v, range, isNavFund)}
                      />
                      <YAxis
                        domain={[minP, maxP]}
                        orientation="right"
                        tick={{ fontSize: 9, fill: "var(--text-muted)", fontFamily: "inherit", fontWeight: 600 }}
                        tickLine={false}
                        axisLine={false}
                        width={50}
                        tickFormatter={(v) => formatFixedNumber(Number(v), decimals)}
                      />
                      {prevClose > 0 && (
                        <ReferenceLine
                          y={prevClose}
                          stroke="rgba(148,163,184,0.35)"
                          strokeDasharray="4 3"
                        />
                      )}
                      <Tooltip
                        cursor={<CrosshairCursor />}
                        content={
                          <ChartTooltip
                            currency={currency}
                            prefix={displayPrefix}
                            decimals={decimals}
                            prevClose={prevClose}
                            regularClose={displayQuote?.price ?? q?.price ?? 0}
                            market={market}
                            upColor={upColor}
                            downColor={dnColor}
                            language={language}
                          />
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="displayPrice"
                        stroke={lineColor}
                        strokeWidth={1.8}
                        fill={`url(#${gradId})`}
                        dot={false}
                        activeDot={{ r: 4, fill: lineColor, strokeWidth: 0 }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )
              ) : isRangeLoading ? (
                <div
                  className="h-full flex items-center justify-center rounded-xl"
                  style={{
                    background: "var(--bg-card)",
                    border: "1px dashed var(--border)",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  {language === "en" ? "Loading current range" : "正在加载当前周期数据"}
                </div>
              ) : !sessionHasChart && sessionAwareQuote ? (
                <div
                  className="h-full flex flex-col items-center justify-center rounded-xl px-4"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
                >
                  <p style={{ color: "var(--text-primary)", fontSize: 22, fontWeight: 800 }}>
                    {formatQuoteValue(sessionAwareQuote.price)}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span style={{ color: lineColor, fontSize: 12, fontWeight: 600 }}>
                      {sessionAwareQuote.change >= 0 ? "+" : ""}{formatQuoteValue(sessionAwareQuote.change)}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5"
                      style={{ fontSize: 10, fontWeight: 700, background: `${lineColor}18`, color: lineColor }}
                    >
                      {formatPercent(sessionAwareQuote.changePercent)}
                    </span>
                  </div>
                  <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 8 }}>
                    {language === "en" ? "No intraday points for this session. Showing latest quote only." : "当前时段暂无分时数据，仅展示最新报价"}
                  </p>
                </div>
              ) : (
                <div
                  className="h-full flex items-center justify-center rounded-xl"
                  style={{
                    background: "var(--bg-card)",
                    border: "1px dashed var(--border)",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  {hasRealChart && !sessionHasChart
                    ? (language === "en" ? "No intraday data for this session" : "当前时段暂无分时数据")
                    : (language === "en" ? "No chart data" : "暂无真实图表数据")}
                </div>
              )}
            </div>

            {hasRealChart && sessionHasChart && canUseNavigator && effectiveChartWindow && (
              <div
                className="px-1"
                style={{ margin: "2px 8px 0", borderRadius: 8, background: "var(--bg-surface2)" }}
              >
                <ChartNavigator
                  points={chartPoints}
                  viewWindow={effectiveChartWindow}
                  lineColor={lineColor}
                  minSpan={windowPolicy.minSpan}
                  maxSpan={windowPolicy.maxSpan}
                  onChange={handleNavigatorChange}
                />
              </div>
            )}

            {/* ── Volume Bars ── */}
            {hasRealChart && hasSessionVolume && (
              <div style={{ height: 44 }}>
                <ResponsiveContainer width="100%" height={44}>
                  <BarChart data={areaChartData} margin={{ top: 2, right: 8, left: 8, bottom: 0 }} barCategoryGap="5%">
                    <defs>
                      <linearGradient id={volGrad} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor={lineColor} stopOpacity={0.45} />
                        <stop offset="100%" stopColor={lineColor} stopOpacity={0.1}  />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="time" hide />
                    <YAxis hide domain={[0, "auto"]} />
                    <Bar dataKey="displayVolume" fill={`url(#${volGrad})`} radius={[1, 1, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
                <p style={{ textAlign: "center", color: "var(--text-micro)", fontSize: 9, marginTop: -4 }}>{language === "en" ? "Volume" : "成交量"}</p>
              </div>
            )}

            {/* ── Divider ── */}
            <div style={{ height: 8, background: "var(--bg-surface2)", margin: "8px 0" }} />

            {/* ── Stats Grid ── */}
            <div className="mx-0 overflow-hidden" style={{ borderRadius: 0 }}>
              <div className="px-4 py-2 flex items-center justify-between">
                <span style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600, letterSpacing: "0.5px" }}>{language === "en" ? "Market Data" : "行情数据"}</span>
                {!q?.isLive && (q?.price ?? 0) > 0 && (
                  <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{language === "en" ? "Showing latest valid quote" : "当前展示最近一次有效报价"}</span>
                )}
              </div>
              <StatRow items={statItems} />
            </div>

            {/* ── Source ── */}
            <div style={{ padding: "12px 16px calc(10px + env(safe-area-inset-bottom))" }}>
              <p
                style={{
                  color: "var(--text-micro)",
                  fontSize: 10,
                  lineHeight: 1.5,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {detailSourceLabel(market, language)}
              </p>
              <p style={{ color: "var(--text-micro)", fontSize: 10, textAlign: "center", marginTop: 2 }}>
                {text.common.referenceOnly}
              </p>
            </div>
          </>
        )}
      </div>

    </motion.div>
  );
}
