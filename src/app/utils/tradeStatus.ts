export type TradeStatusValue = "normal" | "suspended" | "fund_limit" | "buy_disabled" | "unknown";
export type TradeStatusRefreshState = "success" | "failed" | "unsupported";
export const TRADE_STATUS_FRESHNESS_MS = 36 * 60 * 60 * 1000;

export interface TradeStatusCarrier {
  tradeStatus?: TradeStatusValue;
  tradeStatusNote?: string;
  autoTradeStatus?: TradeStatusValue | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: string | null;
  autoTradeStatusUpdatedAt?: string;
  autoTradeStatusStale?: boolean;
  autoTradeStatusRefreshNote?: string;
}

export interface TradeStatusRefreshPatch {
  autoTradeStatus?: TradeStatusValue | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: string | null;
  autoTradeStatusUpdatedAt?: string;
  autoTradeStatusRefreshState?: TradeStatusRefreshState;
  autoTradeStatusRefreshNote?: string;
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
    case "unknown":
      return "交易状态未知";
    default:
      return "正常可买";
  }
}

export function mergeAutomaticTradeStatus(
  current: TradeStatusCarrier,
  incoming: TradeStatusRefreshPatch,
) {
  const refreshState = incoming.autoTradeStatusRefreshState;
  if (refreshState === "success" || (!refreshState && incoming.autoTradeStatus != null)) {
    return {
      autoTradeStatus: incoming.autoTradeStatus ?? "unknown" as TradeStatusValue,
      autoTradeStatusNote: incoming.autoTradeStatusNote ?? "",
      autoTradeStatusSource: incoming.autoTradeStatusSource ?? null,
      autoTradeStatusUpdatedAt: incoming.autoTradeStatusUpdatedAt ?? new Date().toISOString(),
      autoTradeStatusStale: false,
      autoTradeStatusRefreshNote: "",
    };
  }
  if (refreshState === "failed" || refreshState === "unsupported") {
    const previousStatus = current.autoTradeStatus && current.autoTradeStatus !== "unknown"
      ? current.autoTradeStatus
      : null;
    const refreshNote = incoming.autoTradeStatusRefreshNote
      ?? (refreshState === "unsupported" ? "当前数据源未提供交易状态" : "交易状态刷新失败");
    return {
      autoTradeStatus: previousStatus ?? "unknown" as TradeStatusValue,
      autoTradeStatusNote: previousStatus ? (current.autoTradeStatusNote ?? "") : refreshNote,
      autoTradeStatusSource: current.autoTradeStatusSource ?? incoming.autoTradeStatusSource ?? null,
      autoTradeStatusUpdatedAt: current.autoTradeStatusUpdatedAt,
      autoTradeStatusStale: true,
      autoTradeStatusRefreshNote: refreshNote,
    };
  }
  return {
    autoTradeStatus: current.autoTradeStatus ?? null,
    autoTradeStatusNote: current.autoTradeStatusNote ?? "",
    autoTradeStatusSource: current.autoTradeStatusSource ?? null,
    autoTradeStatusUpdatedAt: current.autoTradeStatusUpdatedAt,
    autoTradeStatusStale: current.autoTradeStatusStale ?? false,
    autoTradeStatusRefreshNote: current.autoTradeStatusRefreshNote ?? "",
  };
}

export function cleanTradeSource(source: string) {
  return source
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part && part !== "自动" && part !== "手动")
    .join(" · ");
}

export function cleanTradeNote(note: string | undefined, label: string) {
  const text = (note ?? "").split(/[；;]/)
    .filter((part) => !/刷新失败|未将.*视为|上次成功更新|状态已过期|未取得可靠|未提供交易状态|交易状态暂未更新/.test(part))
    .join("；").trim();
  if (!text || text === label) return "";
  for (const sep of ["，", ",", "、", " "]) {
    const prefix = `${label}${sep}`;
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return text;
}

/** Keep stored diagnostics intact while making old and new records readable. */
export function conciseDcaReason(reason: string) {
  if (/刷新失败|状态已过期|未将.*视为|暂无法确认交易状态/.test(reason)) {
    return "暂无法确认交易状态，本次未执行";
  }
  if (/应用未运行，历史计划未自动补单/.test(reason)) return "当日未运行，已跳过";
  return reason;
}

/** A DCA order rejected by the trading rules seen on its DCA day (limit, minimum, not buyable, no quote). */
export function isDcaRuleFailure(item: { status: string; reason?: string }) {
  return (item.status === "skipped" || item.status === "rejected")
    && /限购|定投起点|不可定投|不可买|不支持|暂停|停牌|暂无法确认交易状态|刷新失败|状态已过期|无有效报价|报价未刷新/.test(item.reason ?? "");
}

export function resolveDcaTradeStatus(item: TradeStatusCarrier & { market?: string; assetType?: string }) {
  const isFund = item.market === "FUND" || item.assetType === "fund";
  return resolveHoldingTradeStatus(isFund && item.autoTradeStatus && item.autoTradeStatus !== "unknown"
    ? { ...item, autoTradeStatusStale: false, autoTradeStatusUpdatedAt: undefined }
    : item);
}

export function resolveHoldingTradeStatus(item: TradeStatusCarrier) {
  const updatedAtMs = Date.parse(item.autoTradeStatusUpdatedAt ?? "");
  const timedOut = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > TRADE_STATUS_FRESHNESS_MS;
  const automaticStatusStale = Boolean(item.autoTradeStatusStale || timedOut);
  const lastSuccessfulCheck = item.autoTradeStatusUpdatedAt
    ? `上次成功更新 ${item.autoTradeStatusUpdatedAt.replace("T", " ").slice(0, 16)}`
    : "";
  const autoBlocked = item.autoTradeStatus && item.autoTradeStatus !== "normal" && item.autoTradeStatus !== "unknown"
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
      note: [autoBlocked.note, automaticStatusStale ? (item.autoTradeStatusRefreshNote || "状态已过期，沿用上次成功结果") : "", automaticStatusStale ? lastSuccessfulCheck : ""].filter(Boolean).join("；"),
      label: tradeStatusLabel(autoBlocked.status),
      stale: automaticStatusStale,
    };
  }

  if (item.tradeStatus && item.tradeStatus !== "normal") {
    return {
      status: item.tradeStatus,
      note: item.tradeStatusNote ?? "",
      source: "手动",
      label: tradeStatusLabel(item.tradeStatus),
      automatic: false,
      stale: false,
    };
  }

  if (item.autoTradeStatus === "unknown" || automaticStatusStale) {
    return {
      status: "unknown" as const,
      note: [item.autoTradeStatusRefreshNote || item.autoTradeStatusNote || "未取得可靠的交易状态", lastSuccessfulCheck].filter(Boolean).join("；"),
      source: item.autoTradeStatusSource ? `自动 · ${tradeStatusSourceLabel(item.autoTradeStatusSource)}` : "自动",
      label: tradeStatusLabel("unknown"),
      automatic: true,
      stale: automaticStatusStale,
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
    stale: false,
  };
}
