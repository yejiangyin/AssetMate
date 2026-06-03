/**
 * Trading Calendar Service
 * Determines valid trading days for each market, respecting:
 *   - Weekends
 *   - Public holidays (A股/US/HK/UK/DE and common QDII markets)
 *   - Crypto: 24/7 (no closures)
 */

export type MarketType = "A" | "US" | "HK" | "JP" | "UK" | "DE" | "IN" | "VN" | "CRYPTO" | "FUND" | "BOND" | "GOLD";

const REMOTE_CALENDAR_STORAGE_KEY = "asset-helper:trading-calendar:v1";
const REMOTE_CALENDAR_REFRESH_TTL = 24 * 60 * 60 * 1000;
const EASTMONEY_CLOSE_CALENDAR_URL =
  "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_ZGXSRL&columns=ALL&pageSize=1000&sortColumns=SDATE&sortTypes=-1";

type RemoteCalendarPayload = {
  savedAt: number;
  source: string;
  years: number[];
  holidays: Partial<Record<MarketType, string[]>>;
  halfDays?: Partial<Record<MarketType, string[]>>;
};

type EastMoneyCloseRow = {
  MKT?: string;
  SDATE?: string;
  EDATE?: string;
  XS?: string | null;
};

const remoteHolidaySets: Partial<Record<MarketType, Set<string>>> = {};
const remoteHalfDaySets: Partial<Record<MarketType, Set<string>>> = {};
let remoteCalendarLoaded = false;
let remoteCalendarInFlight: Promise<RemoteCalendarPayload | null> | null = null;
let remoteCalendarStatus: { source: string; savedAt: number; years: number[] } | null = null;

/* ─── helpers ──────────────────────────────────────────── */
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromYMD(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return new Date(Number.NaN);
  return new Date(y, m - 1, d);
}

function normalizeYMD(value: string | undefined) {
  const match = value?.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

function eachDateYMD(start: string, end: string) {
  const dates: string[] = [];
  if (!start || !end) return dates;
  const cursor = fromYMD(start);
  const last = fromYMD(end);
  for (let guard = 0; cursor <= last && guard < 370; guard++) {
    dates.push(ymd(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function addRemoteHoliday(market: MarketType, date: string) {
  const bucket = remoteHolidaySets[market] ?? new Set<string>();
  bucket.add(date);
  remoteHolidaySets[market] = bucket;
}

function addRemoteHalfDay(market: MarketType, date: string) {
  const bucket = remoteHalfDaySets[market] ?? new Set<string>();
  bucket.add(date);
  remoteHalfDaySets[market] = bucket;
}

function applyRemoteCalendar(payload: RemoteCalendarPayload) {
  for (const key of Object.keys(remoteHolidaySets) as MarketType[]) {
    remoteHolidaySets[key]?.clear();
  }
  for (const key of Object.keys(remoteHalfDaySets) as MarketType[]) {
    remoteHalfDaySets[key]?.clear();
  }
  for (const [market, dates] of Object.entries(payload.holidays) as Array<[MarketType, string[] | undefined]>) {
    for (const date of dates ?? []) addRemoteHoliday(market, date);
  }
  for (const [market, dates] of Object.entries(payload.halfDays ?? {}) as Array<[MarketType, string[] | undefined]>) {
    for (const date of dates ?? []) addRemoteHalfDay(market, date);
  }
  remoteCalendarStatus = {
    source: payload.source,
    savedAt: payload.savedAt,
    years: payload.years,
  };
}

function loadCachedRemoteCalendar() {
  if (remoteCalendarLoaded || typeof window === "undefined") return;
  remoteCalendarLoaded = true;
  try {
    const raw = window.localStorage.getItem(REMOTE_CALENDAR_STORAGE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw) as RemoteCalendarPayload;
    if (!payload || typeof payload.savedAt !== "number" || !payload.holidays) return;
    applyRemoteCalendar(payload);
  } catch {
    // Remote calendars are an accuracy upgrade; built-in calendars remain the fallback.
  }
}

function marketsFromEastMoneyMkt(mkt = ""): MarketType[] {
  if (mkt.includes("A股")) return ["A", "FUND", "BOND", "GOLD"];
  if (mkt.includes("港股") && !mkt.includes("港股通")) return ["HK"];
  return [];
}

function parseEastMoneyCloseCalendar(rows: EastMoneyCloseRow[]): RemoteCalendarPayload | null {
  const holidays: Partial<Record<MarketType, string[]>> = {};
  const halfDays: Partial<Record<MarketType, string[]>> = {};
  const years = new Set<number>();
  for (const row of rows) {
    const markets = marketsFromEastMoneyMkt(row.MKT);
    if (!markets.length) continue;
    for (const date of eachDateYMD(normalizeYMD(row.SDATE), normalizeYMD(row.EDATE))) {
      years.add(Number(date.slice(0, 4)));
      for (const market of markets) {
        if (row.XS === "1") {
          halfDays[market] = [...(halfDays[market] ?? []), date];
        } else {
          holidays[market] = [...(holidays[market] ?? []), date];
        }
      }
    }
  }
  for (const market of Object.keys(holidays) as MarketType[]) {
    holidays[market] = [...new Set(holidays[market])].sort();
  }
  for (const market of Object.keys(halfDays) as MarketType[]) {
    halfDays[market] = [...new Set(halfDays[market])].sort();
  }
  if (!Object.keys(holidays).length && !Object.keys(halfDays).length) return null;
  return {
    savedAt: Date.now(),
    source: "EastMoney close calendar",
    years: [...years].sort((a, b) => a - b),
    holidays,
    halfDays,
  };
}

export function getTradingCalendarStatus() {
  loadCachedRemoteCalendar();
  return remoteCalendarStatus;
}

export async function refreshTradingCalendar(force = false) {
  loadCachedRemoteCalendar();
  const now = Date.now();
  if (!force && remoteCalendarStatus && now - remoteCalendarStatus.savedAt < REMOTE_CALENDAR_REFRESH_TTL) {
    return remoteCalendarStatus;
  }
  if (remoteCalendarInFlight) return remoteCalendarInFlight;

  const task = (async () => {
    try {
      const ctrl = new AbortController();
      const setTimer = typeof window !== "undefined" ? window.setTimeout.bind(window) : setTimeout;
      const clearTimer = typeof window !== "undefined" ? window.clearTimeout.bind(window) : clearTimeout;
      const tid = setTimer(() => ctrl.abort(), 8000);
      const res = await fetch(EASTMONEY_CLOSE_CALENDAR_URL, {
        cache: "no-store",
        signal: ctrl.signal,
      }).finally(() => clearTimer(tid));
      if (!res.ok) return null;
      const json = await res.json();
      const rows = json?.result?.data;
      if (!Array.isArray(rows)) return null;
      const payload = parseEastMoneyCloseCalendar(rows);
      if (!payload) return null;
      applyRemoteCalendar(payload);
      try {
        window.localStorage.setItem(REMOTE_CALENDAR_STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Ignore storage quota/private-mode failures.
      }
      return payload;
    } catch {
      return null;
    }
  })();
  remoteCalendarInFlight = task;

  const payload = await task.finally(() => {
    if (remoteCalendarInFlight === task) remoteCalendarInFlight = null;
  });
  return payload ? getTradingCalendarStatus() : remoteCalendarStatus;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number) {
  const d = new Date(year, month, 1);
  const offset = (weekday - d.getDay() + 7) % 7;
  d.setDate(1 + offset + (nth - 1) * 7);
  return d;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number) {
  const d = new Date(year, month + 1, 0);
  const offset = (d.getDay() - weekday + 7) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function observedFixedHoliday(year: number, month: number, day: number) {
  const d = new Date(year, month, day);
  if (d.getDay() === 0) d.setDate(day + 1);
  if (d.getDay() === 6) d.setDate(day - 1);
  return d;
}

function easterSunday(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function addCalendarDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isUsAlgorithmicHoliday(date: Date) {
  const d = ymd(date);
  const year = date.getFullYear();
  return [
    observedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    addCalendarDays(easterSunday(year), -2),
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25),
  ].some((item) => ymd(item) === d);
}

/* ─── Holiday definitions ──────────────────────────────── */

/** A股 / FUND / BOND 公众假日 (上交所) */
const A_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", // 元旦
  "2025-01-28","2025-01-29","2025-01-30","2025-01-31",
  "2025-02-03","2025-02-04", // 春节 (Jan 28 – Feb 4)
  "2025-04-04","2025-04-05","2025-04-06", // 清明
  "2025-05-01","2025-05-02","2025-05-05", // 劳动节
  "2025-05-31","2025-06-02", // 端午 (Sat Jun 1 included in weekend)
  "2025-10-01","2025-10-02","2025-10-03","2025-10-06","2025-10-07","2025-10-08", // 国庆
  // 2026
  "2026-01-01","2026-01-02", // 元旦
  "2026-02-15","2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20","2026-02-21","2026-02-22","2026-02-23", // 春节
  "2026-04-04","2026-04-05","2026-04-06", // 清明
  "2026-05-01","2026-05-02","2026-05-03","2026-05-04","2026-05-05", // 劳动节
  "2026-06-19","2026-06-20","2026-06-21", // 端午
  "2026-09-25","2026-09-26","2026-09-27", // 中秋
  "2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07", // 国庆
]);

/** US Market holidays (NYSE/NASDAQ) */
const US_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", // New Year's
  "2025-01-20", // MLK Day
  "2025-02-17", // Presidents' Day
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas
  // 2026
  "2026-01-01", // New Year's
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed Fri)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

/** HK Market holidays */
const HK_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", // New Year
  "2025-01-29","2025-01-30","2025-01-31", // CNY
  "2025-04-04", // Ching Ming
  "2025-04-18","2025-04-19","2025-04-21", // Good Friday + Easter
  "2025-05-01", // Labour Day
  "2025-05-05", // Buddha's Birthday
  "2025-05-31", // Dragon Boat
  "2025-07-01", // HKSAR Establishment Day
  "2025-10-01", // National Day
  "2025-10-07", // Day after Mid-Autumn (Chung Yeung next day)
  "2025-10-29", // Chung Yeung
  "2025-12-25","2025-12-26", // Christmas
  // 2026
  "2026-01-01", // New Year
  "2026-02-17","2026-02-18","2026-02-19", // CNY
  "2026-04-03","2026-04-06","2026-04-07", // Good Friday + Easter + Ching Ming observed
  "2026-05-01", // Labour Day
  "2026-05-25", // Day following Buddha's Birthday
  "2026-06-19", // Dragon Boat
  "2026-07-01", // HKSAR
  "2026-10-01", // National Day
  "2026-10-19", // Chung Yeung observed
  "2026-12-25", // Christmas
]);

/** Japan Market holidays (JPX/TSE common full-day holidays) */
const JP_HOLIDAYS = new Set([
  // 2025
  "2025-01-01","2025-01-02","2025-01-03",
  "2025-01-13","2025-02-11","2025-02-24","2025-03-20",
  "2025-04-29","2025-05-05","2025-05-06",
  "2025-07-21","2025-08-11","2025-09-15","2025-09-23",
  "2025-10-13","2025-11-03","2025-11-24","2025-12-31",
  // 2026
  "2026-01-01","2026-01-02","2026-01-12","2026-02-11","2026-02-23","2026-03-20",
  "2026-04-29","2026-05-04","2026-05-05","2026-05-06",
  "2026-07-20","2026-08-11","2026-09-21","2026-09-22","2026-09-23",
  "2026-10-12","2026-11-03","2026-11-23","2026-12-31",
]);

/** UK Market holidays (London Stock Exchange) */
const UK_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-04-18","2025-04-21",
  "2025-05-05","2025-05-26",
  "2025-08-25",
  "2025-12-25","2025-12-26",
  // 2026
  "2026-01-01",
  "2026-04-03","2026-04-06",
  "2026-05-04","2026-05-25",
  "2026-08-31",
  "2026-12-25","2026-12-28",
]);

/** Germany/Xetra common full-day holidays */
const DE_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-04-18","2025-04-21",
  "2025-05-01",
  "2025-12-24","2025-12-25","2025-12-26","2025-12-31",
  // 2026
  "2026-01-01",
  "2026-04-03","2026-04-06",
  "2026-05-01","2026-05-25",
  "2026-12-24","2026-12-25","2026-12-31",
]);

/** India/NSE common holidays used for QDII scheduling */
const IN_HOLIDAYS = new Set([
  // 2026 weekday holidays commonly published for NSE equity segment
  "2026-01-26",
  "2026-02-15",
  "2026-03-03","2026-03-04",
  "2026-03-21",
  "2026-03-26",
  "2026-04-03","2026-04-14",
  "2026-05-01",
  "2026-05-27",
  "2026-08-26",
  "2026-09-04",
  "2026-10-02","2026-10-20","2026-10-21",
  "2026-11-24",
  "2026-12-25",
]);

/** Vietnam/HOSE common holidays used for QDII scheduling */
const VN_HOLIDAYS = new Set([
  // 2026
  "2026-01-01",
  "2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20",
  "2026-04-27",
  "2026-04-30","2026-05-01",
  "2026-09-02",
]);

/* ─── Core functions ──────────────────────────────────── */

export function isWeekend(date: Date): boolean {
  const dow = date.getDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

export function isHoliday(market: MarketType, date: Date): boolean {
  loadCachedRemoteCalendar();
  const d = ymd(date);
  if (remoteHolidaySets[market]?.has(d)) return true;
  switch (market) {
    case "A": case "FUND": case "BOND": case "GOLD":
      return A_HOLIDAYS.has(d);
    case "US":
      return US_HOLIDAYS.has(d) || isUsAlgorithmicHoliday(date);
    case "HK":
      return HK_HOLIDAYS.has(d);
    case "JP":
      return JP_HOLIDAYS.has(d);
    case "UK":
      return UK_HOLIDAYS.has(d);
    case "DE":
      return DE_HOLIDAYS.has(d);
    case "IN":
      return IN_HOLIDAYS.has(d);
    case "VN":
      return VN_HOLIDAYS.has(d);
    case "CRYPTO":
      return false; // crypto never closes
    default:
      return A_HOLIDAYS.has(d);
  }
}

export function isHalfTradingDay(market: MarketType, date: Date): boolean {
  loadCachedRemoteCalendar();
  return remoteHalfDaySets[market]?.has(ymd(date)) ?? false;
}

/** Returns true if the market is open on this date */
export function isTradingDay(market: MarketType, date: Date): boolean {
  if (market === "CRYPTO") return true; // 24/7
  if (isWeekend(date)) return false;
  if (isHoliday(market, date)) return false;
  return true;
}

export function effectiveDcaMarket(market: MarketType, name = ""): MarketType {
  if (market !== "FUND") return market;
  const text = name.toUpperCase();
  if (/纳斯达克|NASDAQ|标普|S&P|SP500|美国|道琼斯|DOW|中概/.test(text)) return "US";
  if (/恒生|港股|香港|HANG\s*SENG|HSI|HSTECH|中国互联网/.test(text)) return "HK";
  if (/富时|FTSE|英国|英股|伦敦|LSE/.test(text)) return "UK";
  if (/德国|德股|DAX/.test(text)) return "DE";
  if (/印度|INDIA|NIFTY|SENSEX/.test(text)) return "IN";
  if (/越南|VIETNAM|VN30/.test(text)) return "VN";
  if (/日经|日本|NIKKEI/.test(text)) return "JP";
  return "FUND";
}

/**
 * Given a target date, finds the next (or same) valid trading day.
 * `direction`: 1 = forward (default), -1 = backward (find previous)
 */
export function nearestTradingDay(
  market: MarketType,
  date: Date,
  direction: 1 | -1 = 1,
): Date {
  const d = new Date(date);
  // Limit search to 30 iterations to avoid infinite loop
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(market, d)) return new Date(d);
    d.setDate(d.getDate() + direction);
  }
  return new Date(date); // fallback
}

/** Next N upcoming trading days from today */
export function nextNTradingDays(market: MarketType, n: number, from?: Date): Date[] {
  const result: Date[] = [];
  const d = new Date(from ?? new Date());
  d.setDate(d.getDate() + 1); // start from tomorrow
  while (result.length < n) {
    if (isTradingDay(market, d)) result.push(new Date(d));
    d.setDate(d.getDate() + 1);
    if (result.length > 100) break; // safety
  }
  return result;
}

function zonedDateParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get("hour") % 24;
  return {
    date: new Date(get("year"), get("month") - 1, get("day")),
    minutes: hour * 60 + get("minute"),
  };
}

export function marketDate(market: MarketType, now = new Date()): Date {
  switch (market) {
    case "US":
      return zonedDateParts(now, "America/New_York").date;
    case "HK":
      return zonedDateParts(now, "Asia/Hong_Kong").date;
    case "JP":
      return zonedDateParts(now, "Asia/Tokyo").date;
    case "UK":
      return zonedDateParts(now, "Europe/London").date;
    case "DE":
      return zonedDateParts(now, "Europe/Berlin").date;
    case "IN":
      return zonedDateParts(now, "Asia/Kolkata").date;
    case "VN":
      return zonedDateParts(now, "Asia/Ho_Chi_Minh").date;
    case "A":
    case "FUND":
    case "BOND":
    case "GOLD":
    case "CRYPTO":
    default:
      return zonedDateParts(now, "Asia/Shanghai").date;
  }
}

function inTimeRanges(minutes: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => minutes >= start && minutes <= end);
}

/**
 * Rough regular-session check used by auto refresh. It intentionally ignores
 * half days and ad-hoc closures; holiday/weekend checks still come from
 * isTradingDay().
 */
export function isMarketOpenNow(market: MarketType, now = new Date()): boolean {
  if (market === "CRYPTO") return true;

  if (market === "US") {
    const ny = zonedDateParts(now, "America/New_York");
    return isTradingDay("US", ny.date) && inTimeRanges(ny.minutes, [[9 * 60 + 30, 16 * 60]]);
  }

  if (market === "HK") {
    const hk = zonedDateParts(now, "Asia/Hong_Kong");
    const ranges: Array<[number, number]> = isHalfTradingDay("HK", hk.date)
      ? [[9 * 60 + 30, 12 * 60]]
      : [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]];
    return isTradingDay("HK", hk.date) && inTimeRanges(hk.minutes, ranges);
  }

  if (market === "JP") {
    const jp = zonedDateParts(now, "Asia/Tokyo");
    return isTradingDay("JP", jp.date) && inTimeRanges(jp.minutes, [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60 + 30]]);
  }

  if (market === "UK") {
    const uk = zonedDateParts(now, "Europe/London");
    return isTradingDay("UK", uk.date) && inTimeRanges(uk.minutes, [[8 * 60, 16 * 60 + 30]]);
  }

  if (market === "DE") {
    const de = zonedDateParts(now, "Europe/Berlin");
    return isTradingDay("DE", de.date) && inTimeRanges(de.minutes, [[9 * 60, 17 * 60 + 30]]);
  }

  if (market === "IN") {
    const india = zonedDateParts(now, "Asia/Kolkata");
    return isTradingDay("IN", india.date) && inTimeRanges(india.minutes, [[9 * 60 + 15, 15 * 60 + 30]]);
  }

  if (market === "VN") {
    const vn = zonedDateParts(now, "Asia/Ho_Chi_Minh");
    return isTradingDay("VN", vn.date) && inTimeRanges(vn.minutes, [[9 * 60, 11 * 60 + 30], [13 * 60, 15 * 60]]);
  }

  if (market === "A" || market === "FUND" || market === "BOND") {
    const cn = zonedDateParts(now, "Asia/Shanghai");
    const ranges: Array<[number, number]> = isHalfTradingDay(market, cn.date)
      ? [[9 * 60 + 30, 11 * 60 + 30]]
      : [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]];
    return isTradingDay(market, cn.date) && inTimeRanges(cn.minutes, ranges);
  }

  const local = zonedDateParts(now, "Asia/Shanghai");
  return isTradingDay(market, local.date);
}

/* ─── DCA schedule calculation ────────────────────────── */

export type DCAFrequency = "daily" | "weekly" | "monthly";

interface ScheduleConfig {
  frequency: DCAFrequency;
  dayOfWeek?: number;   // 0=Sun…6=Sat (for weekly)
  dayOfMonth?: number;  // 1-28 (for monthly)
  startDate: string;    // YYYY-MM-DD
}

/**
 * Calculate the next N scheduled execution dates, adjusted to valid trading days.
 * Returns pairs of { scheduled, actual, adjusted } where adjusted=true means
 * the actual date differs from the scheduled date.
 */
export function calcNextExecutions(
  market: MarketType,
  config: ScheduleConfig,
  count = 5,
  from = new Date(),
  includeFrom = false,
): Array<{ scheduled: string; actual: string; adjusted: boolean }> {
  const { frequency, dayOfWeek = 1, dayOfMonth = 1, startDate } = config;
  const start = fromYMD(startDate);
  const today = marketDate(market, from);
  today.setHours(0, 0, 0, 0);

  const results: Array<{ scheduled: string; actual: string; adjusted: boolean }> = [];
  const cursor = new Date(Math.max(start.getTime(), today.getTime()));
  const safeCount = Math.max(0, Math.min(count, 3660));
  const maxScanDays = Math.max(366, safeCount * 370);
  let scanned = 0;

  if (frequency === "daily") {
    // daily: next `count` calendar days that are trading days
    const d = new Date(cursor);
    if (!includeFrom) d.setDate(d.getDate() + 1);
    while (results.length < safeCount && scanned < maxScanDays) {
      if (isTradingDay(market, d)) {
        const ds = ymd(d);
        results.push({ scheduled: ds, actual: ds, adjusted: false });
      }
      d.setDate(d.getDate() + 1);
      scanned++;
    }
  } else if (frequency === "weekly") {
    // weekly: next `count` occurrences of dayOfWeek, adjusted to nearest trading day
    const d = new Date(cursor);
    if (!includeFrom) d.setDate(d.getDate() + 1);
    while (results.length < safeCount && scanned < maxScanDays) {
      if (d.getDay() === dayOfWeek) {
        const scheduled = ymd(d);
        const actual = ymd(nearestTradingDay(market, d, 1));
        results.push({ scheduled, actual, adjusted: scheduled !== actual });
      }
      d.setDate(d.getDate() + 1);
      scanned++;
    }
  } else {
    // monthly: next `count` occurrences of dayOfMonth, adjusted to nearest trading day
    const d = new Date(cursor);
    if (!includeFrom) d.setDate(d.getDate() + 1);
    while (results.length < safeCount && scanned < maxScanDays) {
      const targetDay = Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
      if (d.getDate() === targetDay) {
        const scheduled = ymd(d);
        const actual = ymd(nearestTradingDay(market, d, 1));
        results.push({ scheduled, actual, adjusted: scheduled !== actual });
      }
      d.setDate(d.getDate() + 1);
      scanned++;
    }
  }
  return results;
}

/** Get the next single execution date (actual trading day) */
export function nextExecutionDate(
  market: MarketType,
  config: ScheduleConfig,
  from = new Date(),
  includeFrom = true,
): string {
  const res = calcNextExecutions(market, config, 1, from, includeFrom);
  return res[0]?.actual ?? "";
}

/* ─── Human-readable helpers ──────────────────────────── */

export function closureReason(market: MarketType, date: Date): string | null {
  if (market === "CRYPTO") return null;
  if (isWeekend(date)) return date.getDay() === 6 ? "周六休市" : "周日休市";
  if (isHoliday(market, date)) {
    if (market === "A" || market === "FUND") {
      const d = ymd(date);
      if (d >= "2025-01-28" && d <= "2025-02-04") return "春节假期";
      if (d >= "2025-04-04" && d <= "2025-04-06") return "清明假期";
      if (d >= "2025-05-01" && d <= "2025-05-05") return "劳动节假期";
      if (d >= "2025-05-31" && d <= "2025-06-02") return "端午假期";
      if (d >= "2025-10-01" && d <= "2025-10-08") return "国庆假期";
      if (d >= "2026-02-15" && d <= "2026-02-23") return "春节假期";
      if (d >= "2026-09-25" && d <= "2026-09-27") return "中秋假期";
      return "公众假日";
    }
    if (market === "US") {
      const d = ymd(date);
      if (d === "2025-01-20" || d === "2026-01-19") return "马丁路德金日";
      if (d === "2025-02-17" || d === "2026-02-16") return "总统日";
      if (d === "2025-04-18" || d === "2026-04-03") return "耶稣受难日";
      if (d === "2025-05-26" || d === "2026-05-25") return "美国阵亡将士纪念日";
      if (d.endsWith("-07-04") || d === "2026-07-03") return "美国独立日";
      if (d.endsWith("-12-25")) return "圣诞节";
      if (d.endsWith("-11-27") || d.endsWith("-11-26")) return "感恩节";
      return "美国公众假日";
    }
    if (market === "HK") {
      const d = ymd(date);
      if (d === "2026-05-25") return "佛诞翌日";
      if (d === "2026-10-19") return "重阳节翌日";
      return "香港公众假日";
    }
    if (market === "UK") {
      const d = ymd(date);
      if (d === "2025-05-26" || d === "2026-05-25") return "英国春季银行假日";
      if (d === "2025-05-05" || d === "2026-05-04") return "英国五月银行假日";
      if (d === "2025-08-25" || d === "2026-08-31") return "英国夏季银行假日";
      return "英国公众假日";
    }
    if (market === "DE") {
      const d = ymd(date);
      if (d === "2026-05-25") return "德国圣灵降临节星期一";
      if (d.endsWith("-05-01")) return "德国劳动节";
      return "德国公众假日";
    }
    if (market === "JP") return "日本公众假日";
    if (market === "IN") return "印度公众假日";
    if (market === "VN") return "越南公众假日";
    return "公众假日";
  }
  return null;
}

export const FREQ_LABELS: Record<DCAFrequency, string> = {
  daily:   "每交易日",
  weekly:  "每周",
  monthly: "每月",
};

export const DAY_OF_WEEK_LABELS = ["周日","周一","周二","周三","周四","周五","周六"];
