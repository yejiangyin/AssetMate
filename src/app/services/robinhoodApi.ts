import type { QuoteInfo } from "./quoteApi";

const ROBINHOOD_HOST = "https://api.robinhood.com";

function positive(raw: unknown) {
  const value = typeof raw === "number"
    ? raw
    : parseFloat(String(raw ?? "").replace(/[$,%+,]/g, "").trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function newYorkHour(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

type ExtendedSession = "overnight" | "pre" | "post";

function getFreshExtendedSessions(timestamp: string): ExtendedSession[] | null {
  const tradeTime = new Date(timestamp).getTime();
  if (!Number.isFinite(tradeTime)) return null;
  // 14h window: covers entire overnight cycle for users in Asian timezones
  if (Date.now() - tradeTime > 14 * 60 * 60 * 1000) return null;
  const tradeMinutes = newYorkHour(timestamp);
  if (tradeMinutes == null) return null;

  // Determine what session the trade occurred in
  const tradeSession: ExtendedSession | null =
    (tradeMinutes >= 20 * 60 || tradeMinutes < 4 * 60) ? "overnight"
    : (tradeMinutes >= 4 * 60 && tradeMinutes < 9 * 60 + 30) ? "pre"
    : (tradeMinutes >= 16 * 60 && tradeMinutes < 20 * 60) ? "post"
    : null;
  if (!tradeSession) return null;

  // Determine current NY session
  const nowMinutes = newYorkHour(new Date().toISOString());
  const nowIsOvernight = nowMinutes != null && (nowMinutes >= 20 * 60 || nowMinutes < 4 * 60);

  // If trade was post-market and we're now in overnight, show both post + overnight
  if (tradeSession === "post" && nowIsOvernight) return ["post", "overnight"];
  return [tradeSession];
}

export async function fetchRobinhoodExtendedQuote(symbol: string): Promise<Partial<QuoteInfo> | null> {
  if (symbol.startsWith("^") || symbol.includes(".")) return null;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ROBINHOOD_HOST}/marketdata/quotes/${encodeURIComponent(symbol)}/`, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    const timestamp = String(data?.venue_last_non_reg_trade_time ?? "");
    const sessions = timestamp ? getFreshExtendedSessions(timestamp) : null;
    if (!sessions?.length) return null;

    const price = positive(data?.last_non_reg_trade_price ?? data?.last_extended_hours_trade_price);
    const previousClose = positive(data?.adjusted_previous_close ?? data?.previous_close);
    if (!(price > 0) || !(previousClose > 0)) return null;
    const change = price - previousClose;
    const changePercent = change / previousClose;
    const result: Partial<QuoteInfo> = {};
    for (const session of sessions) {
      if (session === "overnight") {
        result.overnightPrice = price;
        result.overnightChange = change;
        result.overnightChangePercent = changePercent;
      } else if (session === "pre") {
        result.preMarketPrice = price;
        result.preMarketChange = change;
        result.preMarketChangePercent = changePercent;
      } else {
        result.postMarketPrice = price;
        result.postMarketChange = change;
        result.postMarketChangePercent = changePercent;
      }
    }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}
