import type { ChartPoint } from "../services/quoteApi";

function timeToMinutes(time: string) {
  const [hour = "0", minute = "0"] = time.split(":");
  return Number(hour ?? "0") * 60 + Number(minute ?? "0");
}

function minutesToTime(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function inferIntradayStepMinutes(points: ChartPoint[]) {
  const minutes = points
    .map((point) => timeToMinutes(point.time))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let index = 1; index < minutes.length; index += 1) {
    const current = minutes[index];
    const previous = minutes[index - 1];
    if (current == null || previous == null) continue;
    const delta = current - previous;
    if (delta <= 0) continue;
    const normalized = Math.max(1, Math.min(60, delta));
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  if (!counts.size) return 1;
  let bestStep = 1;
  let bestCount = -1;
  for (const [step, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && step > bestStep)) {
      bestStep = step;
      bestCount = count;
    }
  }
  return bestStep;
}

type IntradaySessionSpec = {
  segments: readonly (readonly [string, string])[];
  ticks: readonly string[];
};

const US_INDEX_SYMBOLS = new Set(["^GSPC", "^NDX", "^DJI", "^IXIC", "^VIX", "SPX", "NDX", "DJIA", "IXIC", "VIX"]);
const HK_INDEX_SYMBOLS = new Set(["^HSI", "^HSTECH", "^HSCEI", "HSI", "HSTECH", "HSCEI"]);
const A_INDEX_SYMBOLS = new Set(["000001", "399001", "000300", "399006", "000688"]);
const JP_INDEX_SYMBOLS = new Set(["^N225", "N225"]);

function intradaySessionCandidates(market: string, symbol: string): IntradaySessionSpec[] {
  const upperSymbol = symbol.toUpperCase();
  if (market === "A" || (market === "INDEX" && A_INDEX_SYMBOLS.has(upperSymbol))) {
    return [{
      segments: [["09:30", "11:30"], ["13:00", "15:00"]] as const,
      ticks: ["09:30", "10:30", "11:30", "13:00", "14:00", "15:00"],
    }];
  }
  if (market === "HK" || (market === "INDEX" && HK_INDEX_SYMBOLS.has(upperSymbol))) {
    return [{
      segments: [["09:30", "12:00"], ["13:00", "16:00"]] as const,
      ticks: ["09:30", "10:30", "11:30", "13:00", "14:00", "15:00", "16:00"],
    }];
  }
  if (market === "JP" || (market === "INDEX" && JP_INDEX_SYMBOLS.has(upperSymbol))) {
    return [{
      // JPX extended the cash-equity close from 15:00 to 15:30 in Nov 2024.
      // Session times shown in Beijing time (UTC+8): Tokyo 09:00→08:00, 15:30→14:30.
      segments: [["08:00", "10:30"], ["11:30", "14:30"]] as const,
      ticks: ["08:00", "09:00", "10:30", "11:30", "13:00", "14:30"],
    }];
  }
  if (market === "INDEX" && US_INDEX_SYMBOLS.has(upperSymbol)) {
    return [
      {
        segments: [["21:30", "23:59"], ["00:00", "04:00"]] as const,
        ticks: ["21:30", "23:00", "00:30", "02:00", "04:00"],
      },
      {
        segments: [["22:30", "23:59"], ["00:00", "05:00"]] as const,
        ticks: ["22:30", "00:00", "01:30", "03:00", "05:00"],
      },
    ];
  }
  if (market === "US") {
    return [
      {
        segments: [["16:00", "23:59"], ["00:00", "08:00"]] as const,
        ticks: ["16:00", "18:00", "20:00", "21:30", "23:00", "01:00", "03:00", "05:00", "08:00"],
      },
      {
        segments: [["17:00", "23:59"], ["00:00", "09:00"]] as const,
        ticks: ["17:00", "19:00", "21:00", "22:30", "00:00", "02:00", "04:00", "06:00", "09:00"],
      },
      {
        segments: [["21:30", "23:59"], ["00:00", "04:00"]] as const,
        ticks: ["21:30", "23:00", "00:30", "02:00", "04:00"],
      },
      {
        segments: [["22:30", "23:59"], ["00:00", "05:00"]] as const,
        ticks: ["22:30", "00:00", "01:30", "03:00", "05:00"],
      },
      {
        segments: [["09:30", "16:00"]] as const,
        ticks: ["09:30", "11:00", "12:30", "14:00", "16:00"],
      },
    ];
  }
  return [];
}

function pickIntradaySessionSpec(points: ChartPoint[], market: string, symbol: string) {
  const candidates = intradaySessionCandidates(market, symbol);
  if (!candidates.length) return null;
  const pointMinutes = points
    .map((point) => timeToMinutes(point.time))
    .filter((value) => Number.isFinite(value));

  let best: IntradaySessionSpec | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = pointMinutes.reduce((sum, minute) => {
      const inSession = candidate.segments.some(([start, end]) => {
        const startMinutes = timeToMinutes(start);
        const endMinutes = timeToMinutes(end);
        return minute >= startMinutes && minute <= endMinutes;
      });
      return sum + (inSession ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

/* ─── US session sub-tabs (times in Beijing / user-local, summer EDT +12h) ── */
export type UsSessionType = "pre" | "regular" | "post" | "overnight" | "full";

export const US_SESSION_LABELS: { value: UsSessionType; label: string }[] = [
  { value: "pre",       label: "盘前" },
  { value: "regular",   label: "盘中" },
  { value: "post",      label: "盘后" },
  { value: "full",      label: "全天" },
];

/**
 * Fixed session specs for US stocks, in Beijing time (EDT +12h / EST +13h).
 * ET 04:00→BJ 16:00, ET 09:30→BJ 21:30, ET 16:00→BJ 04:00, ET 20:00→BJ 08:00
 */
const US_FIXED_SESSIONS: Record<UsSessionType, IntradaySessionSpec> = {
  pre:       { segments: [["16:00", "21:29"]], ticks: ["16:00", "17:30", "19:00", "20:30"] },
  regular:   { segments: [["21:30", "23:59"], ["00:00", "04:00"]], ticks: ["21:30", "23:00", "00:30", "02:00", "04:00"] },
  post:      { segments: [["04:00", "08:00"]], ticks: ["04:00", "05:00", "06:00", "07:00", "08:00"] },
  overnight: { segments: [["08:00", "16:00"]], ticks: ["08:00", "10:00", "12:00", "14:00", "16:00"] },
  full:      { segments: [["04:00", "23:59"], ["00:00", "03:59"]], ticks: ["04:00", "08:00", "12:00", "16:00", "20:00", "00:00"] },
};

/**
 * From multi-day points, extract only the latest day's data for a given session.
 * For sessions spanning midnight (e.g. regular 21:30-04:00), points are grouped
 * by shifting times before noon to the previous calendar day.
 */
function filterLatestSessionPoints(points: ChartPoint[], sessionType: UsSessionType): ChartPoint[] {
  if (sessionType === "full") return points; // full = show all days
  const spec = US_FIXED_SESSIONS[sessionType];

  // Filter to points within session time range
  const sessionPoints = points.filter((p) => {
    const m = timeToMinutes(p.time);
    return Number.isFinite(m) && spec.segments.some(([s, e]) => m >= timeToMinutes(s) && m <= timeToMinutes(e));
  });
  if (!sessionPoints.length) return sessionPoints;

  // Group by "trading day": for sessions that cross midnight (regular: 21:30-04:00),
  // treat early-morning points (00:00-12:00) as belonging to the previous calendar day.
  const crossesMidnight = spec.segments.some(([s, e]) => timeToMinutes(s) > timeToMinutes(e))
    || spec.segments.length > 1;
  const tradingDay = (p: ChartPoint) => {
    if (!p.timestamp) return p.dateLabel ?? p.time;
    const d = new Date(typeof p.timestamp === "number" ? p.timestamp : Number(p.timestamp));
    if (crossesMidnight && d.getHours() < 12) d.setDate(d.getDate() - 1);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  };

  // Find the latest trading day
  let latestDay = "";
  for (const p of sessionPoints) {
    const day = tradingDay(p);
    if (day > latestDay) latestDay = day;
  }

  return sessionPoints.filter((p) => tradingDay(p) === latestDay);
}

/** Pick the best default session: prefer regular → whichever has data → full. */
export function pickDefaultUsSession(points: ChartPoint[]): UsSessionType {
  const priority: UsSessionType[] = ["regular", "pre", "post"];
  for (const s of priority) {
    if (usSessionHasData(points, s)) return s;
  }
  return "full";
}

/** Returns true if the session has enough data points for a meaningful chart (>= 2). */
export function usSessionHasData(points: ChartPoint[], sessionType: UsSessionType) {
  const spec = US_FIXED_SESSIONS[sessionType];
  let count = 0;
  for (const point of points) {
    const m = timeToMinutes(point.time);
    if (Number.isFinite(m) && spec.segments.some(([s, e]) => m >= timeToMinutes(s) && m <= timeToMinutes(e))) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

export function buildIntradayViewportPoints(
  points: ChartPoint[],
  market: string,
  symbol: string,
  usSession?: UsSessionType,
) {
  // For US stocks with session selection, filter to latest day then use fixed spec
  if (market === "US" && usSession) {
    const filtered = filterLatestSessionPoints(points, usSession);
    return buildFromSpec(filtered, US_FIXED_SESSIONS[usSession]);
  }

  const upperSymbol = symbol.toUpperCase();
  const isJapan = market === "JP" || (market === "INDEX" && JP_INDEX_SYMBOLS.has(upperSymbol));
  const effectivePoints = isJapan ? filterLatestMarketDate(points, "Asia/Shanghai") : points;
  const session = pickIntradaySessionSpec(effectivePoints, market, symbol);
  if (!session || effectivePoints.length < 2) {
    return {
      points: effectivePoints.map((point) => ({ ...point, displayPrice: point.price, displayVolume: point.volume })),
      ticks: null as string[] | null,
    };
  }
  return buildFromSpec(effectivePoints, session);
}

function filterLatestMarketDate(points: ChartPoint[], timeZone: string) {
  const dated = points
    .map((point) => {
      if (typeof point.timestamp !== "number" || !Number.isFinite(point.timestamp)) return null;
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(point.timestamp));
      return { point, date };
    })
    .filter((item): item is { point: ChartPoint; date: string } => item != null);
  if (!dated.length) return points;
  const latestDate = dated.reduce((latest, item) => item.date > latest ? item.date : latest, "");
  return dated.filter((item) => item.date === latestDate).map((item) => item.point);
}

function buildFromSpec(points: ChartPoint[], session: IntradaySessionSpec) {
  if (points.length < 2) {
    return {
      points: points.map((point) => ({ ...point, displayPrice: point.price, displayVolume: point.volume })),
      ticks: null as string[] | null,
    };
  }
  const byTime = new Map(points.map((point) => [point.time, point]));
  const stepMinutes = inferIntradayStepMinutes(points);
  const displayPoints: Array<ChartPoint & { displayPrice?: number; displayVolume?: number }> = [];

  for (const [start, end] of session.segments) {
    for (let minute = timeToMinutes(start); minute <= timeToMinutes(end); minute += stepMinutes) {
      const time = minutesToTime(minute);
      const point = byTime.get(time);
      if (point) {
        displayPoints.push({ ...point, displayPrice: point.price, displayVolume: point.volume });
      } else {
        displayPoints.push({
          time,
          price: Number.NaN,
          volume: undefined,
          displayPrice: undefined,
          displayVolume: undefined,
        });
      }
    }
  }

  return { points: displayPoints, ticks: session.ticks };
}
