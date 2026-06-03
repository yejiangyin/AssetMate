export type TradeStatusValue = "normal" | "suspended" | "fund_limit" | "buy_disabled";

export interface TradeStatusCarrier {
  tradeStatus?: TradeStatusValue;
  tradeStatusNote?: string;
  autoTradeStatus?: TradeStatusValue | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: string | null;
}

export function tradeStatusSourceLabel(source?: string | null) {
  switch ((source ?? "").toLowerCase()) {
    case "eastmoney":
      return "东方财富";
    case "tencent":
      return "腾讯行情";
    case "yahoo":
      return "Yahoo Finance";
    case "nasdaq":
      return "Nasdaq";
    case "coingecko":
      return "CoinGecko";
    case "binance":
      return "Binance";
    case "okx":
      return "OKX";
    default:
      return source ?? "";
  }
}

export function tradeStatusLabel(status: TradeStatusValue) {
  switch (status) {
    case "suspended":
      return "停牌/暂停交易";
    case "fund_limit":
      return "基金限购";
    case "buy_disabled":
      return "当前不可买入";
    default:
      return "正常可买";
  }
}

export function cleanTradeSource(source: string) {
  return source
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part && part !== "自动" && part !== "手动")
    .join(" · ");
}

export function cleanTradeNote(note: string | undefined, label: string) {
  const text = (note ?? "").trim();
  if (!text || text === label) return "";
  for (const sep of ["，", ",", "、", " "]) {
    const prefix = `${label}${sep}`;
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return text;
}

export function resolveHoldingTradeStatus(item: TradeStatusCarrier) {
  const autoBlocked = item.autoTradeStatus && item.autoTradeStatus !== "normal"
    ? {
        status: item.autoTradeStatus,
        note: item.autoTradeStatusNote ?? "",
        source: item.autoTradeStatusSource ? `自动 · ${tradeStatusSourceLabel(item.autoTradeStatusSource)}` : "自动",
        automatic: true,
      }
    : null;

  if (autoBlocked) {
    return {
      ...autoBlocked,
      label: tradeStatusLabel(autoBlocked.status),
    };
  }

  if (item.tradeStatus && item.tradeStatus !== "normal") {
    return {
      status: item.tradeStatus,
      note: item.tradeStatusNote ?? "",
      source: "手动",
      label: tradeStatusLabel(item.tradeStatus),
      automatic: false,
    };
  }

  return {
    status: "normal" as const,
    note: item.autoTradeStatus === "normal" ? (item.autoTradeStatusNote ?? "") : (item.tradeStatusNote ?? ""),
    source: item.autoTradeStatus === "normal"
      ? (item.autoTradeStatusSource ? `自动 · ${tradeStatusSourceLabel(item.autoTradeStatusSource)}` : "自动")
      : "",
    label: tradeStatusLabel("normal"),
    automatic: item.autoTradeStatus === "normal",
  };
}
