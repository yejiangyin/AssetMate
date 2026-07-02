import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Search, Plus, Minus, X, Pencil, Trash2, ChevronDown, Check,
  Loader2, Wifi, WifiOff, LineChart, RefreshCw, Circle,
  ChevronRight, BarChart2, CalendarClock, Repeat2, Eye, EyeOff,
} from "lucide-react";
import { DCAPlan, HoldingAdjustmentInput, HoldingInput, useApp } from "../context/AppContext";
import { Holding, Group, ClosedHolding } from "../data/mockData";
import { searchSecuritiesLive, fetchLivePrice, fetchCnFundTradeStatus, LiveResult, Market } from "../services/securitiesApi";
import { fetchTencentTradeStatus } from "../services/tencentQuote";
import { toYahooSymbol } from "../services/quoteApi";
import { FX, toCNY } from "../services/priceRefresher";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";
import { currencySymbol, formatExactMoney, formatExactNumber, formatPercent } from "../utils/numberFormat";
import { resolveHoldingTradeStatus, tradeStatusLabel, cleanTradeSource, cleanTradeNote } from "../utils/tradeStatus";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import { normalizeHoldingSymbol, normalizeHoldingType } from "../utils/holdingHelpers";
import { canSaveHoldingForm } from "../utils/holdingForm";
import {
  assetTypeLabel,
  groupName,
  marketLabel,
  t,
  translateTradeText,
} from "../i18n";
import type { Language } from "../context/AppContext";

/* ─── constants ──────────────────────────────────────── */
function getSecurityBadge(market: string, assetType?: string, language: Language = "zh") {
  if (market === "A" && assetType === "etf") {
    return { label: language === "en" ? "Listed ETF" : "场内ETF", color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" };
  }
  if (market === "A" && assetType === "fund") {
    return { label: language === "en" ? "Listed Fund" : "场内基金", color: "#31D08B", bg: "rgba(49,208,139,0.12)" };
  }
  return getMarketBadgeWithBg(market, 0.1, language);
}

const assetTypeOptions = [
  { value: "stock",  label: "股票"    },
  { value: "etf",    label: "ETF"     },
  { value: "fund",   label: "基金"    },
  { value: "crypto", label: "加密货币" },
  { value: "bond",   label: "债券"    },
] as const;
const currencyOptions  = ["CNY", "USD", "HKD", "JPY", "USDT", "USDC", "EUR"] as const;
type AssetType = typeof assetTypeOptions[number]["value"];

const colorOptions = ["#4F9CF9","#F24E4E","#31D08B","#F59E0B","#8B5CF6","#EC4899","#14B8A6","#F97316"];
const DEFAULT_GROUP_COLOR = "#4F9CF9";
const MARKET_SCOPE_OPTIONS: Market[] = ["US", "HK", "A", "JP", "FUND", "CRYPTO", "BOND"];

const blankForm = (): HoldingInput => ({
  groupId: "", symbol: "", name: "", market: "US", assetType: "",
  quantity: 0, costPrice: 0, currentPrice: 0, currency: "",
  tradeStatus: "normal",
  tradeStatusNote: "",
  dividendReinvest: null,
});

function normalizeHoldingForm(input: HoldingInput): HoldingInput {
  const normalizedType = normalizeHoldingType(input.symbol, input.name, input.market, input.assetType);
  const isFund = normalizedType.market === "FUND" || normalizedType.assetType === "fund";
  return {
    ...input,
    symbol: normalizeHoldingSymbol(input.symbol, normalizedType.market),
    market: normalizedType.market,
    assetType: normalizedType.assetType,
    tradeStatus: "normal",
    tradeStatusNote: "",
    dividendReinvest: isFund ? input.dividendReinvest ?? null : null,
  };
}

function isFundLike(input: Pick<HoldingInput, "market" | "assetType"> | Pick<Holding, "market" | "assetType">) {
  return input.market === "FUND" || input.assetType === "fund";
}

function assetTypeSelectLabel(market: string, assetType: string, fallback: string, language: Language) {
  if (!assetType) return fallback;
  return getSecurityBadge(market, assetType, language).label || fallback;
}


function convertAmount(value: number, fromCurrency: string, toCurrency: string) {
  const sourceFx = FX[fromCurrency as keyof typeof FX] ?? 1;
  const targetFx = FX[toCurrency as keyof typeof FX] ?? 1;
  return value * sourceFx / targetFx;
}

function quantityUnit(market: string, assetType: string, language: Language = "zh") {
  const units = t(language).holdings.units;
  if (market === "CRYPTO") return units.crypto;
  if (assetType === "fund" || market === "FUND") return units.fund;
  if (assetType === "bond") return units.bond;
  return units.stock;
}

function holdingMarketValue(h: Holding) {
  return h.quantity * h.currentPrice;
}

function holdingTotalPnl(h: Holding) {
  return h.quantity * (h.currentPrice - h.costPrice) + (h.cashDividendTotal ?? 0);
}

function holdingTotalPnlRate(h: Holding) {
  const cost = h.quantity * h.costPrice;
  return cost > 0 ? holdingTotalPnl(h) / cost : 0;
}

function todayLocalYMD() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayCashDividendAmount(h: Holding, today = todayLocalYMD()) {
  return (h.corporateActions ?? [])
    .filter((action) => action.type === "cash_dividend" && action.date === today)
    .reduce((sum, action) => sum + (Number.isFinite(action.amount) ? Math.max(0, action.amount ?? 0) : 0), 0);
}

function holdingTodayPnlRate(h: Holding) {
  return Number.isFinite(h.todayPnlRate) ? h.todayPnlRate : 0;
}

function holdingRateChange(price: number, rate: number) {
  if (!Number.isFinite(price) || !Number.isFinite(rate) || price <= 0) return 0;
  const denominator = 1 + rate;
  if (denominator <= 0) return 0;
  return price * rate / denominator;
}

function formatSummaryMoney(value: number, currency: string) {
  return formatExactMoney(Math.abs(value), currency, 2);
}

function formatHoldingQuantity(value: number | undefined | null) {
  return formatExactNumber(value, 2, 2);
}

function holdingUnitPriceDecimals(h: Holding) {
  if (h.market === "FUND" || h.assetType === "fund") return 4;
  if (h.market === "A" && (h.assetType === "etf" || h.assetType === "bond")) return 3;
  if (h.market === "CRYPTO" || h.assetType === "crypto") {
    if (h.currentPrice >= 1000) return 2;
    if (h.currentPrice >= 1) return 3;
    return 4;
  }
  return 2;
}

function ClosedHoldingsView({
  items,
  baseCurrency,
  privacyMode,
  profitColor,
  onDelete,
  language,
}: {
  items: ClosedHolding[];
  baseCurrency: string;
  privacyMode: boolean;
  profitColor: (value: number) => string;
  onDelete: (id: string) => void;
  language: Language;
}) {
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => `${b.closedAt}_${b.id}`.localeCompare(`${a.closedAt}_${a.id}`));
  }, [items]);
  const emptyText = language === "en" ? "No realized records yet" : "暂无已实现记录";
  const subtitle = language === "en"
    ? "Sell and close records keep realized P/L, including cash dividends when applicable."
    : "卖出和清仓后会在这里保留已实现收益，完整清仓记录会计入现金分红。";

  if (!sorted.length) {
    return (
      <div className="flex flex-col items-center justify-center py-14 gap-2 px-6 text-center">
        <BarChart2 size={30} color="var(--text-micro)" />
        <p style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 700 }}>{emptyText}</p>
        <p style={{ color: "var(--text-micro)", fontSize: 11, lineHeight: 1.5 }}>{subtitle}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {sorted.map((item) => {
        const pnl = convertAmount(item.realizedPnl, item.currency, baseCurrency);
        const proceeds = convertAmount(item.proceeds, item.currency, baseCurrency);
        const color = profitColor(pnl);
        return (
          <div
            key={item.id}
            className="rounded-2xl p-3"
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-sub)" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 800 }}>
                    {item.name}
                  </p>
                  <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 700 }}>{item.symbol}</span>
                </div>
                <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 3 }}>
                  {item.isPartial
                    ? (language === "en" ? "Partial" : "减仓")
                    : (language === "en" ? "Closed" : "清仓")} {item.closedAt || "-"} · {marketLabel(item.market, language)} · {assetTypeLabel(item.assetType, language)}
                </p>
              </div>
              <button
                onClick={() => onDelete(item.id)}
                className="flex items-center justify-center rounded-lg shrink-0"
                style={{ width: 28, height: 28, background: "rgba(242,78,78,0.1)", color: "#F24E4E" }}
                title={language === "en" ? "Delete record" : "删除历史记录"}
              >
                <Trash2 size={13} />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Quantity" : "数量"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {formatHoldingQuantity(item.quantity)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Sell Price" : "卖出价"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {privacyMode ? `${currencySymbol(item.currency)}***` : formatExactMoney(item.closePrice, item.currency, 4)}
                </p>
              </div>
              <div>
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{language === "en" ? "Proceeds" : "卖出金额"}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 12, fontWeight: 700 }}>
                  {privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(proceeds, baseCurrency)}
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-xl px-3 py-2 flex items-center justify-between" style={{ background: `${color}12` }}>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {language === "en" ? "Realized P/L" : "已实现收益"}
                {(item.cashDividendTotal ?? 0) > 0 && (
                  <span style={{ marginLeft: 5, color: "var(--text-micro)" }}>
                    {language === "en" ? "incl. dividend" : "含分红"}
                  </span>
                )}
              </span>
              <span className="truncate" style={{ color, fontSize: 13, fontWeight: 800 }}>
                {pnl >= 0 ? "+" : "-"}{privacyMode ? `${currencySymbol(baseCurrency)}--` : formatSummaryMoney(pnl, baseCurrency)}
                <span style={{ marginLeft: 6, fontSize: 11 }}>
                  {privacyMode ? "--" : formatPercent(item.realizedReturn)}
                </span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── tiny primitives ─────────────────────────────────── */
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{label}</p>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text" }: {
  value: string | number; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      style={{
        width: "100%", height: 38, background: "var(--bg-card)",
        border: "1px solid var(--border)", borderRadius: 10, padding: "0 12px",
        color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box",
      }} />
  );
}

function Sel<T extends string>({ value, onChange, options, style }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; style?: React.CSSProperties;
}) {
  return (
    <div style={{ position: "relative", ...style }}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}
        style={{
          width: "100%", height: 38, background: "var(--bg-card)",
          border: "1px solid var(--border)", borderRadius: 10,
          padding: "0 30px 0 12px", color: "var(--text-primary)", fontSize: 13,
          outline: "none", appearance: "none", boxSizing: "border-box",
        }}>
        {options.map((o) => <option key={o.value} value={o.value} style={{ background: "var(--bg-overlay)" }}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} color="var(--text-muted)" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
    </div>
  );
}

/* ─── Autocomplete with live API ─────────────────────── */
function AutoInput({
  value, onChange, onSelect, placeholder, marketFilter,
}: {
  value: string; onChange: (v: string) => void; onSelect: (r: LiveResult) => void | Promise<void>; placeholder?: string;
  marketFilter?: Market;
}) {
  const { language } = useApp();
  const text = t(language);
  const [open,    setOpen]    = useState(false);
  const [hits,    setHits]    = useState<LiveResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiOk,   setApiOk]   = useState<boolean | null>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doSearch = useCallback(async (q: string, filter?: Market) => {
    if (!q.trim()) { setHits([]); setOpen(false); return; }
    setLoading(true);
    try {
      const results = await searchSecuritiesLive(q, filter);
      setHits(results); setOpen(results.length > 0);
      if (results.length) setApiOk(results[0]?.source === "live");
    } catch { setHits([]); setApiOk(false); }
    finally { setLoading(false); }
  }, []);

  const handleChange = (v: string) => {
    onChange(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(v, marketFilter), 350);
  };

  // Re-run search when the market filter changes so results stay in scope.
  useEffect(() => {
    if (!value.trim()) return;
    void doSearch(value, marketFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketFilter]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => { document.removeEventListener("mousedown", close); clearTimeout(timerRef.current); };
  }, []);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input type="text" value={value} onChange={(e) => handleChange(e.target.value)}
          onFocus={() => { if (value && hits.length) setOpen(true); }}
          placeholder={placeholder}
          style={{
            width: "100%", height: 38, background: "var(--bg-card)",
            border: `1px solid ${open ? "rgba(79,156,249,0.45)" : "var(--border)"}`,
            borderRadius: 10, padding: "0 32px 0 12px", color: "var(--text-primary)",
            fontSize: 13, outline: "none", boxSizing: "border-box",
          }} />
        <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" }}>
          {loading
            ? <Loader2 size={13} color="#4F9CF9" className="animate-spin-smooth" />
            : apiOk === true  ? <Wifi    size={12} color="#31D08B" />
            : apiOk === false ? <WifiOff size={12} color="var(--text-muted)" />
            : null}
        </div>
      </div>

      <AnimatePresence>
        {open && hits.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.12 }}
            style={{
              position: "absolute", top: "calc(100% + 5px)", left: 0, right: 0,
              background: "var(--bg-overlay)", border: "1px solid rgba(79,156,249,0.2)",
              borderRadius: 12, boxShadow: "var(--menu-shadow)", zIndex: 999, overflow: "hidden",
            }}>
            {hits.map((r, idx) => {
              const normalizedType = normalizeHoldingType(r.symbol, r.name, r.market, r.assetType);
              const badge = getSecurityBadge(normalizedType.market, normalizedType.assetType, language);
              return (
                <button key={`${r.market}:${r.symbol}:${idx}`}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(r); setOpen(false); }}
                  className="w-full px-3 py-2.5 text-left"
                  style={{ borderBottom: `1px solid ${idx < hits.length - 1 ? "var(--border)" : "transparent"}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(79,156,249,0.09)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <div className="flex items-start justify-between gap-2">
                    <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 700, lineHeight: 1.35, flex: 1, minWidth: 0 }}>
                      {r.name}
                    </span>
                    <span style={{ color: r.price > 0 ? "#4F9CF9" : "var(--text-micro)", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
                      {r.price > 0 ? formatExactMoney(r.price, r.currency) : text.holdings.waitingQuote}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 min-w-0">
                    <span style={{ color: "var(--text-secondary)", fontSize: 12, fontWeight: 700 }}>{r.symbol}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4,
                      color: badge?.color ?? "var(--text-secondary)", background: badge?.bg ?? "rgba(148,163,184,0.1)" }}>
                      {badge?.label ?? r.market}
                    </span>
                    {r.exchange && (
                      <span style={{ color: "var(--text-micro)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.exchange}
                      </span>
                    )}
                    <span className="ml-auto" style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3,
                      background: r.source === "live" && r.price > 0 ? "rgba(49,208,139,0.1)" : "rgba(100,116,139,0.1)",
                      color:      r.source === "live" && r.price > 0 ? "#31D08B"               : "var(--text-muted)" }}>
                      {r.source === "live" && r.price > 0 ? text.common.live : r.source === "live" ? text.common.matched : text.common.local}
                    </span>
                  </div>
                </button>
              );
            })}
            <div style={{ padding: "4px 12px", borderTop: "1px solid var(--border-sub)",
              background: "var(--bg-surface2)", display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>Yahoo Finance · Tencent · EastMoney · CoinGecko · Binance · OKX</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{text.common.referenceOnly}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── PnL preview strip ──────────────────────────────── */
function PnLPreview({ form }: { form: HoldingInput }) {
  const { profitColor, language } = useApp();
  const text = t(language).holdings;
  const mv   = form.quantity * form.currentPrice;
  const cost = form.quantity * form.costPrice;
  const pnl  = mv - cost;
  const rate = cost > 0 ? pnl / cost : 0;
  const col  = profitColor(pnl);
  return (
    <div className="rounded-xl px-3 py-2.5 flex gap-3"
      style={{ background: "rgba(79,156,249,0.05)", border: "1px solid rgba(79,156,249,0.12)" }}>
      {[
        { label: text.estimatedMarketValue, val: mv > 0 ? formatSummaryMoney(mv, form.currency) : "—", color: "var(--text-primary)" },
        { label: text.cumulativePnl, val: cost > 0 ? `${pnl >= 0 ? "+" : "-"}${formatSummaryMoney(pnl, form.currency)}` : "—", color: cost > 0 ? col : "var(--text-muted)" },
        { label: text.returnRate,   val: cost > 0 ? formatPercent(rate) : "—", color: cost > 0 ? col : "var(--text-muted)" },
      ].map((it) => (
        <div key={it.label} className="flex-1">
          <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{it.label}</p>
          <p style={{ color: it.color, fontSize: 13, fontWeight: 700 }}>{it.val}</p>
        </div>
      ))}
    </div>
  );
}

/* ─── Add / Edit form sheet ──────────────────────────── */
function FormSheet({ initial, groups, onSave, onClose, isEdit }: {
  initial: HoldingInput; groups: Group[];
  onSave: (h: HoldingInput) => void; onClose: () => void; isEdit: boolean;
}) {
  const { language } = useApp();
  const text = t(language);
  const [form, setForm] = useState<HoldingInput>(initial);
  const [saving, setSaving] = useState(false);
  const [securityQuery, setSecurityQuery] = useState(() =>
    initial.symbol && initial.name ? `${initial.name} (${initial.symbol})` : [initial.symbol, initial.name].filter(Boolean).join(" ")
  );
  // Market scope narrows the live search to a single market so identical
  // tickers from different exchanges (e.g. HK 00700 vs JP 7001) don't get
  // mixed together. Defaults to the holding's market when editing.
  const [marketScope, setMarketScope] = useState<Market | "">(() =>
    isEdit && (MARKET_SCOPE_OPTIONS as string[]).includes(initial.market) ? (initial.market as Market) : ""
  );
  const set = <K extends keyof HoldingInput>(k: K, v: HoldingInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid = canSaveHoldingForm(form);
  const assetTypeSelectOptions = useMemo(() => [
    { value: "" as AssetType, label: text.holdings.selectAfterSecurity },
    ...assetTypeOptions.map((option) => ({
      value: option.value as AssetType,
      label: option.value === form.assetType
        ? assetTypeSelectLabel(form.market, form.assetType, assetTypeLabel(option.value, language), language)
        : assetTypeLabel(option.value, language),
    })),
  ], [form.assetType, form.market, language, text.holdings.selectAfterSecurity]);

  const groupOpts = [
    { value: "", label: text.holdings.noGroup },
    ...groups.map((g) => ({ value: g.id, label: groupName(g.id, g.name, language) })),
  ];
  const showDividendMode = isFundLike(form);
  const dividendMode = form.dividendReinvest == null ? "inherit" : form.dividendReinvest ? "reinvest" : "cash";
  const dividendModeOptions = [
    { value: "inherit", label: text.holdings.dividendInherit },
    { value: "cash", label: text.holdings.dividendCash },
    { value: "reinvest", label: text.holdings.dividendReinvest },
  ];

  const marketScopeOptions = useMemo(() => [
    { value: "" as Market | "", label: text.holdings.allMarkets },
    ...MARKET_SCOPE_OPTIONS.map((m) => ({ value: m as Market | "", label: marketLabel(m, language) })),
  ], [language, text.holdings.allMarkets]);

  const handleMarketScopeChange = (next: Market | "") => {
    setMarketScope(next);
    // Clear the previously selected security so stale cross-market data
    // doesn't get saved alongside the new scope.
    setSecurityQuery("");
    setForm((f) => ({
      ...f,
      symbol: "",
      name: "",
      assetType: "",
      currency: "",
      currentPrice: 0,
      autoTradeStatus: null,
      autoTradeStatusNote: "",
      autoTradeStatusSource: null,
    }));
  };

  const handleSelect = (r: LiveResult) => {
    const normalizedType = normalizeHoldingType(r.symbol, r.name, r.market, r.assetType);
    const normalizedSymbol = normalizeHoldingSymbol(r.symbol, normalizedType.market);
    setSecurityQuery(`${r.name} (${r.symbol})`);
    setForm((f) => ({
      ...f,
      symbol: normalizedSymbol,
      name: r.name,
      market: normalizedType.market,
      assetType: normalizedType.assetType,
      currency: r.currency,
      currentPrice: r.price > 0 ? r.price : f.currentPrice,
      dividendReinvest: isFundLike(normalizedType) ? f.dividendReinvest : null,
      autoTradeStatus: null,
      autoTradeStatusNote: "",
      autoTradeStatusSource: null,
    }));

    // Search endpoints may include delayed or previous-session prices. Keep that
    // value for immediate feedback, then always verify it through the live quote
    // path before the user saves the holding.
    void fetchLivePrice(r.symbol, r.market, r.coinId).then((quote) => {
      if (!quote || quote.price <= 0) return;
      setForm((f) => (
        f.symbol === normalizedSymbol && f.market === normalizedType.market
          ? { ...f, currentPrice: quote.price, currency: quote.currency || f.currency }
          : f
      ));
    }).catch(() => null);

    const market = normalizedType.market;
    const sym = normalizedSymbol;
    if (market === "FUND") {
      void fetchCnFundTradeStatus(sym).then((status) => {
        if (!status) return;
        setForm((f) => f.symbol === sym && f.market === market
          ? { ...f, autoTradeStatus: status.status, autoTradeStatusNote: status.note, autoTradeStatusSource: "eastmoney", fundBuyConfirmDays: status.buyConfirmDays }
          : f);
      }).catch(() => null);
    } else if (market === "A" || market === "HK") {
      void fetchTencentTradeStatus(sym, market).then((status) => {
        if (!status) return;
        setForm((f) => f.symbol === sym && f.market === market
          ? { ...f, autoTradeStatus: status.status, autoTradeStatusNote: status.note, autoTradeStatusSource: status.source }
          : f);
      }).catch(() => null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col justify-end"
      style={{ background: "var(--scrim)", zIndex: 50 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        className="flex flex-col rounded-t-2xl"
        style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)", maxHeight: "92%" }}>

        <div className="flex items-center justify-between px-4 shrink-0"
          style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>{isEdit ? text.holdings.editHolding : text.holdings.addHolding}</span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>

        <div className="overflow-y-auto px-4 py-3 flex flex-col gap-3" style={{ scrollbarWidth: "none" }}>
          <p style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600 }}>{text.holdings.basicInfo}</p>

          <div className="flex gap-2 items-end">
            <Field label={text.holdings.marketScope}>
              <Sel value={marketScope} onChange={(v) => handleMarketScopeChange(v)} options={marketScopeOptions}
                style={{ width: 96, flexShrink: 0 }} />
            </Field>
            <Field label={text.holdings.security} className="flex-1 min-w-0">
              <AutoInput value={securityQuery} onChange={setSecurityQuery}
                onSelect={handleSelect} placeholder={text.holdings.searchSecurityPlaceholder}
                marketFilter={marketScope || undefined} />
            </Field>
          </div>

          {form.autoTradeStatus && form.autoTradeStatus !== "normal" && (
            <div className="rounded-lg px-2.5 py-2" style={{
              background: form.autoTradeStatus === "buy_disabled" ? "rgba(242,78,78,0.08)" : "rgba(245,158,11,0.08)",
              border: `1px solid ${form.autoTradeStatus === "buy_disabled" ? "rgba(242,78,78,0.18)" : "rgba(245,158,11,0.18)"}`,
            }}>
              {(() => {
                const rawLabel = tradeStatusLabel(form.autoTradeStatus);
                const label = translateTradeText(rawLabel, language);
                const note = translateTradeText(cleanTradeNote(form.autoTradeStatusNote, rawLabel), language);
                const color = form.autoTradeStatus === "buy_disabled" ? "#F24E4E" : "#F59E0B";
                const source = translateTradeText(cleanTradeSource(form.autoTradeStatusSource ?? ""), language);
                return (
                  <p style={{ color, fontSize: 11, fontWeight: 600 }}>
                    {source ? `${source} · ` : ""}{label}{note ? `, ${note}` : ""}
                  </p>
                );
              })()}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label={text.holdings.assetType}>
              <Sel value={form.assetType as AssetType} onChange={(v) => setForm((f) => ({
                ...f,
                assetType: v,
                dividendReinvest: isFundLike({ ...f, assetType: v }) ? f.dividendReinvest : null,
              }))}
                options={assetTypeSelectOptions} />
            </Field>
            <Field label={text.holdings.currency}>
              <Sel value={form.currency} onChange={(v) => set("currency", v)}
                options={[
                  { value: "", label: text.holdings.autoFill },
                  ...currencyOptions.map((c) => ({ value: c, label: c })),
                ]} />
            </Field>
          </div>

          <Field label={text.holdings.group}>
            <Sel value={form.groupId} onChange={(v) => set("groupId", v)} options={groupOpts} />
          </Field>

          {showDividendMode && (
            <Field label={text.holdings.dividendMode}>
              <Sel
                value={dividendMode}
                onChange={(v) => set("dividendReinvest", v === "inherit" ? null : v === "reinvest")}
                options={dividendModeOptions}
              />
            </Field>
          )}

          <p style={{ color: "#4F9CF9", fontSize: 11, fontWeight: 600, marginTop: 2 }}>{text.holdings.holdingInfo}</p>

          <Field label={text.holdings.quantity}>
            <Input type="number" value={form.quantity || ""} onChange={(v) => set("quantity", parseFloat(v) || 0)} placeholder={language === "en" ? "e.g. 100" : "例：100"} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label={text.holdings.costPrice}>
              <Input type="number" value={form.costPrice || ""} onChange={(v) => set("costPrice", parseFloat(v) || 0)} placeholder={language === "en" ? "Avg cost" : "买入均价"} />
            </Field>
            <Field label={text.holdings.currentPrice}>
              <Input type="number" value={form.currentPrice || ""} onChange={(v) => set("currentPrice", parseFloat(v) || 0)} placeholder={language === "en" ? "Latest quote" : "最新报价"} />
            </Field>
          </div>

          <PnLPreview form={form} />

          <button onClick={() => {
            if (!valid || saving) return;
            setSaving(true);
            onSave(normalizeHoldingForm(form));
          }} disabled={!valid || saving} className="w-full rounded-xl py-3 flex items-center justify-center gap-2 shrink-0"
            style={{
              background: valid && !saving ? "linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)" : "var(--bg-card)",
              color: valid && !saving ? "#fff" : "var(--text-micro)", fontSize: 13, fontWeight: 600, marginBottom: 8,
              cursor: valid && !saving ? "pointer" : "not-allowed",
            }}>
            <Check size={15} /> {saving ? text.common.saving : isEdit ? text.holdings.saveChanges : text.holdings.confirmInput}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AdjustSheet({
  holding,
  mode,
  onSave,
  onClose,
}: {
  holding: Holding;
  mode: "buy" | "sell";
  onSave: (input: HoldingAdjustmentInput) => void;
  onClose: () => void;
}) {
  const { language } = useApp();
  const text = t(language).holdings;
  const [inputMode, setInputMode] = useState<"quantity" | "amount">("quantity");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState(holding.currentPrice ? String(holding.currentPrice) : "");
  const [saving, setSaving] = useState(false);
  const maxSell = holding.quantity;
  const validPrice = Number(price);
  const rawQuantity = inputMode === "amount"
    ? Number(amount) / validPrice
    : Number(quantity);
  const validQuantity = Number.isFinite(rawQuantity) ? rawQuantity : 0;
  const validAmount = inputMode === "amount" ? Number(amount) : validQuantity * validPrice;
  const unit = quantityUnit(holding.market, holding.assetType, language);
  const currency = holding.currency;
  const maxSellAmount = maxSell * (validPrice > 0 ? validPrice : holding.currentPrice);
  const exceedsSell = mode === "sell" && validQuantity > maxSell + 1e-8;
  const valid = validQuantity > 0
    && validPrice > 0
    && validAmount > 0
    && !exceedsSell;
  const estimatedQuantity = validPrice > 0 && Number.isFinite(validQuantity) ? validQuantity : 0;
  const estimatedAmount = validPrice > 0 && Number.isFinite(validAmount) ? validAmount : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col justify-end"
      style={{ background: "var(--scrim)", zIndex: 55 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        className="flex flex-col rounded-t-2xl"
        style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between px-4 shrink-0" style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>
            {mode === "buy" ? text.buy : text.sell}
          </span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>
        <div className="px-4 py-4 flex flex-col gap-3">
          <div className="rounded-xl px-3 py-2.5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 700 }}>{holding.name}</p>
            <p style={{ color: "var(--text-secondary)", fontSize: 11 }}>{holding.symbol} · {language === "en" ? "Current" : "当前持仓"} {formatHoldingQuantity(holding.quantity)} {unit}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl p-1" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            {([
              ["quantity", text.byQuantity],
              ["amount", text.byAmount],
            ] as const).map(([value, label]) => {
              const active = inputMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setInputMode(value)}
                  className="rounded-lg py-2"
                  style={{
                    background: active ? "rgba(79,156,249,0.16)" : "transparent",
                    color: active ? "#4F9CF9" : "var(--text-secondary)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <Field label={text.transactionPrice}>
            <Input type="number" value={price} onChange={setPrice} placeholder={text.inputTransactionPrice} />
          </Field>
          {inputMode === "quantity" ? (
            <Field label={mode === "buy" ? text.buyQuantity(unit) : text.sellQuantity(unit)}>
              <Input
                type="number"
                value={quantity}
                onChange={setQuantity}
                placeholder={mode === "buy" ? text.inputBuyQuantity : text.max(formatHoldingQuantity(maxSell))}
              />
            </Field>
          ) : (
            <Field label={mode === "buy" ? text.buyAmount(currency) : text.sellAmount(currency)}>
              <Input
                type="number"
                value={amount}
                onChange={setAmount}
                placeholder={mode === "buy" ? text.inputBuyAmount : text.max(formatExactMoney(maxSellAmount, currency))}
              />
            </Field>
          )}
          {(estimatedQuantity > 0 || estimatedAmount > 0) && (
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(79,156,249,0.08)", border: "1px solid rgba(79,156,249,0.14)" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                {text.estimatedTrade(mode, formatHoldingQuantity(estimatedQuantity), unit)}
                <span style={{ color: "var(--text-micro)" }}> · </span>
                {formatExactMoney(estimatedAmount, currency)}
              </p>
              {mode === "sell" && estimatedQuantity > 0 && (
                <p style={{ color: "var(--text-micro)", fontSize: 10, marginTop: 2 }}>
                  {text.remaining(formatHoldingQuantity(Math.max(0, maxSell - estimatedQuantity)), unit)}
                </p>
              )}
            </div>
          )}
          {exceedsSell && (
            <p style={{ color: "#F24E4E", fontSize: 11 }}>
              {inputMode === "amount" ? text.sellAmountError : text.sellQuantityError}
            </p>
          )}
          <button
            onClick={() => {
              if (!valid || saving) return;
              setSaving(true);
              onSave({ type: mode, quantity: validQuantity, price: validPrice });
            }}
            disabled={!valid || saving}
            className="w-full rounded-xl py-3"
            style={{
              background: valid && !saving ? (mode === "buy" ? "linear-gradient(135deg, #2563EB, #7C3AED)" : "rgba(242,78,78,0.15)") : "var(--bg-card)",
              color: valid && !saving ? (mode === "buy" ? "#fff" : "#F24E4E") : "var(--text-micro)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {saving ? t(language).common.saving : mode === "buy" ? text.confirmBuy : text.confirmSell}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── Holding card ───────────────────────────────────── */
function HoldingCard({
  h, groups, dcaPlans, onEdit, onDelete, onQuote, onDCA, onBuy, onSell, isSelected, onSelect,
}: {
  h: Holding; groups: Group[]; isSelected: boolean;
  dcaPlans: DCAPlan[];
  onEdit: () => void; onDelete: () => void; onQuote: () => void; onDCA: () => void; onBuy: () => void; onSell: () => void; onSelect: () => void;
}) {
  const { profitColor, privacyMode, language } = useApp();
  const text = t(language).holdings;
  const [hovered, setHovered] = useState(false);
  const todayC    = profitColor(h.todayPnl);
  const totalPnl  = holdingTotalPnl(h);
  const totalRate = holdingTotalPnlRate(h);
  const todayDividend = todayCashDividendAmount(h);
  const totalC    = profitColor(totalPnl);
  const badge     = getSecurityBadge(h.market, h.assetType, language);
  const group     = groups.find((g) => g.id === h.groupId);
  const sign      = (v: number) => v >= 0 ? "+" : "-";
  const borderColor = isSelected || hovered ? "rgba(79,156,249,0.2)" : "var(--border-sub)";
  const sym = currencySymbol(h.currency);
  const priceDecimals = holdingUnitPriceDecimals(h);
  const fmtMoney = (p: number) => sym + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtUnitPrice = (p: number) => sym + p.toLocaleString("en-US", { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals });
  const marketValueText = fmtMoney(holdingMarketValue(h));
  const tradeStatus = resolveHoldingTradeStatus(h);
  const tradeStatusColor = tradeStatus.status === "normal"
    ? "#31D08B"
    : tradeStatus.status === "suspended"
      ? "#F24E4E"
      : tradeStatus.status === "fund_limit"
        ? "#F59E0B"
        : "#94A3B8";
  const tsSource = translateTradeText(cleanTradeSource(tradeStatus.source), language);
  const tsLabel = translateTradeText(tradeStatus.label, language);
  const tsNote = translateTradeText(cleanTradeNote(tradeStatus.note, tradeStatus.label), language);
  const tsLabelFull = tsNote ? `${tsLabel}, ${tsNote}` : tsLabel;
  const tradeStatusText = tsSource ? `${tsSource} · ${tsLabelFull}` : tsLabelFull;
  const activeDCAPlans = dcaPlans.filter((plan) => plan.holdingId === h.id && plan.enabled);
  const pausedDCAPlans = dcaPlans.filter((plan) => plan.holdingId === h.id && !plan.enabled);
  const dcaBadge = activeDCAPlans.length > 0
    ? { label: activeDCAPlans.length > 1 ? `${text.dca}×${activeDCAPlans.length}` : text.dca, color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" }
    : pausedDCAPlans.length > 0
      ? { label: text.dcaPaused, color: "#94A3B8", bg: "rgba(148,163,184,0.12)" }
      : null;
  const priceDateLabel = h.priceDate
    ? `${h.market === "FUND" || h.assetType === "fund" ? text.nav : text.quote} ${h.priceDate.slice(5).replace("-", "/")}`
    : "";

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      className="relative rounded-xl overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:        isSelected ? "rgba(79,156,249,0.06)" : "var(--bg-card)",
        borderStyle:       "solid",
        borderWidth:       1,
        borderColor,
        transition:        "background 0.15s, border-color 0.15s",
      }}>
      <button className="w-full text-left px-3 pt-3 pb-2" onClick={onSelect}>
        <div className="flex items-start">
          <div className="flex-1 min-w-0 mr-2">
            <div className="flex items-center gap-2 mb-0.5">
              <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{h.symbol}</span>
              <span className="rounded px-1.5 py-0.5" style={{ fontSize: 9, fontWeight: 600, color: badge.color, background: badge.bg }}>{badge.label}</span>
              {dcaBadge && (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ fontSize: 9, fontWeight: 700, color: dcaBadge.color, background: dcaBadge.bg }}>
                  <Repeat2 size={9} /> {dcaBadge.label}
                </span>
              )}
              {group && <span style={{ fontSize: 9, color: group.color, opacity: 0.8 }}>{groupName(group.id, group.name, language)}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="truncate" style={{ color: "var(--text-secondary)", fontSize: 11 }}>{h.name}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                {privacyMode ? "***" : formatHoldingQuantity(h.quantity)} {quantityUnit(h.market, h.assetType, language)} ×
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 500, whiteSpace: "nowrap" }}>{fmtUnitPrice(h.currentPrice)}</span>
              {priceDateLabel && (
                <span style={{ color: "var(--text-micro)", fontSize: 9, whiteSpace: "nowrap" }}>{priceDateLabel}</span>
              )}
            </div>
            {(h.market === "FUND" || h.assetType === "fund") && h.estimatedNav != null && h.estimatedNav > 0 && (
              <div className="mt-0.5 flex items-center gap-1">
                <span style={{ color: "var(--text-micro)", fontSize: 9 }}>{text.estimated}</span>
                <span style={{ color: "#F59E0B", fontSize: 9, fontWeight: 600 }}>{h.estimatedNav.toFixed(4)}</span>
                {h.estimatedChangePercent != null && Number.isFinite(h.estimatedChangePercent) && (
                  <span style={{
                    color: profitColor(h.estimatedChangePercent),
                    fontSize: 9, fontWeight: 600,
                  }}>
                    {formatPercent(h.estimatedChangePercent)}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1">
              <span style={{ color: tradeStatusColor, fontSize: 10 }}>
                {tradeStatusText}
              </span>
            </div>
            {todayDividend > 0 && (
              <div className="mt-0.5">
                <span style={{ color: "#31D08B", fontSize: 10, fontWeight: 600 }}>
                  {language === "en" ? "Dividend" : "分红"} {fmtMoney(todayDividend)}
                </span>
              </div>
            )}
            {isFundLike(h) && typeof h.dividendReinvest === "boolean" && (
              <div className="mt-0.5">
                <span style={{ color: "var(--text-micro)", fontSize: 9 }}>
                  {h.dividendReinvest
                    ? (language === "en" ? "Dividend: Reinvest" : "分红：再投")
                    : (language === "en" ? "Dividend: Cash" : "分红：现金")}
                </span>
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
              {privacyMode ? `${sym || h.currency}***` : marketValueText}
            </p>
            <p style={{ color: todayC, fontSize: 11, marginTop: 1 }}>
              {sign(h.todayPnl)}¥{privacyMode ? "--" : Math.abs(toCNY(h.todayPnl, h.currency)).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}
              &nbsp;<span style={{ fontSize: 10 }}>({privacyMode ? "--" : `${sign(h.todayPnlRate)}${(Number.isFinite(h.todayPnlRate) ? h.todayPnlRate * 100 : 0).toFixed(2)}%`})</span>
            </p>
            <p style={{ color: totalC, fontSize: 10, marginTop: 1 }}>
              {language === "en" ? "Total" : "累计"} {sign(totalRate)}{(totalRate * 100).toFixed(2)}%
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-2 pt-2" style={{ borderTop: "1px solid var(--border-sub)" }}>
          <div className="flex items-center justify-between mb-1">
            <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{text.cost} <span style={{ color: "var(--text-secondary)" }}>{fmtUnitPrice(h.costPrice)}</span></span>
            <span style={{ color: "var(--text-micro)", fontSize: 10 }}>{text.price} <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{fmtUnitPrice(h.currentPrice)}</span></span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 3, background: "var(--bg-surface2)" }}>
            <div className="h-full rounded-full" style={{
              width: h.costPrice > 0
                ? `${Math.min(100, Math.max(0, ((h.currentPrice - h.costPrice) / h.costPrice + 1) * 50))}%`
                : "0%",
              background: totalC, transition: "width 0.3s",
            }} />
          </div>
        </div>
      </button>

      {/* Action row */}
      <div
        className="overflow-hidden"
        style={{
          height: isSelected ? 88 : 0,
          transition: "height 0.18s ease",
          borderTop: `1px solid ${isSelected ? "var(--border)" : "transparent"}`,
        }}
      >
        <div className="px-3 py-2 grid grid-cols-3 gap-2" style={{ minHeight: 88 }}>
          <button onClick={onQuote} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA", fontSize: 11 }}>
            <LineChart size={11} /> {text.quote}
          </button>
          <button onClick={onBuy} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(49,208,139,0.1)", color: "#31D08B", fontSize: 11 }}>
            <Plus size={11} /> {text.buy}
          </button>
          <button onClick={onSell} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(245,158,11,0.1)", color: "#F59E0B", fontSize: 11 }}>
            <Minus size={11} /> {text.sell}
          </button>
          <button onClick={onDCA} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9", fontSize: 11 }}>
            <CalendarClock size={11} /> {text.dca}
          </button>
          <button onClick={onEdit} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9", fontSize: 11 }}>
            <Pencil size={11} /> {t(language).common.edit}
          </button>
          <button onClick={onDelete} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 flex-1 justify-center"
            style={{ background: "rgba(242,78,78,0.08)", color: "#F24E4E", fontSize: 11 }}>
            <Trash2 size={11} /> {t(language).common.delete}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Groups view ────────────────────────────────────── */
function GroupsView({ groups, holdings, dcaPlans, baseCurrency, selectedId, onSelectHolding, onEditHolding, onDeleteHolding, onQuote, onDCA, onBuy, onSell }: {
  groups: Group[]; holdings: Holding[];
  dcaPlans: DCAPlan[];
  baseCurrency: string;
  selectedId: string | null;
  onSelectHolding: (id: string) => void;
  onEditHolding: (holding: Holding) => void;
  onDeleteHolding: (id: string) => void;
  onQuote: (h: Holding) => void;
  onDCA: (h: Holding) => void;
  onBuy: (h: Holding) => void;
  onSell: (h: Holding) => void;
}) {
  const { privacyMode, profitColor, language } = useApp();
  const text = t(language).holdings;
  const [expanded, setExpanded] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map: Record<string, Holding[]> = {};
    for (const g of groups) map[g.id] = [];
    map[""] = []; // ungrouped
    for (const h of holdings) {
      const key = h.groupId ?? "";
      if (map[key]) map[key].push(h);
      else map[""].push(h); // orphaned groupId → ungrouped
    }
    return map;
  }, [groups, holdings]);

  const totalAll = holdings.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, baseCurrency), 0);

  const groupStats = (gHoldings: Holding[]) => ({
    total:    gHoldings.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, baseCurrency), 0),
    todayPnl: gHoldings.reduce((s, h) => s + convertAmount(h.todayPnl, h.currency, baseCurrency), 0),
    pct:      totalAll > 0 ? gHoldings.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, baseCurrency), 0) / totalAll * 100 : 0,
  });
  const allocationGroups = [
    ...groups.map((group) => ({
      id: group.id,
      name: groupName(group.id, group.name, language),
      color: group.color,
      holdings: grouped[group.id] ?? [],
    })),
    {
      id: "__ungrouped",
      name: t(language).common.notGrouped,
      color: "var(--text-micro)",
      holdings: grouped[""] ?? [],
    },
  ].filter((group) => group.holdings.length > 0 && groupStats(group.holdings).total > 0);

  return (
    <div className="flex flex-col gap-2 px-3">
      {/* Total allocation bar */}
      {allocationGroups.length > 0 && (
        <div className="rounded-xl p-3 mb-1" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 6 }}>{text.groupAssetRatio}</p>
          <div className="flex rounded-full overflow-hidden gap-px" style={{ height: 6 }}>
            {allocationGroups.map((g) => {
              const pct = groupStats(g.holdings).pct;
              return pct > 0 ? <div key={g.id} style={{ width: `${pct}%`, background: g.color, borderRadius: 99 }} /> : null;
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {allocationGroups.map((g) => {
              const { pct } = groupStats(g.holdings);
              return (
                <div key={g.id} className="flex items-center gap-1">
                  <div className="rounded-full" style={{ width: 6, height: 6, background: g.color }} />
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{g.name}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>{formatPercent(pct / 100)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Group cards */}
      {groups.map((g, i) => {
        const gHoldings = grouped[g.id] ?? [];
        const stats     = groupStats(gHoldings);
        const isOpen    = expanded === g.id;
        const todayC    = profitColor(stats.todayPnl);

        return (
          <motion.div layout key={g.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.2) }}
            className="relative rounded-xl overflow-hidden"
            style={{
              background: "var(--bg-card)",
              borderStyle: "solid",
              borderWidth: 1,
              borderColor: "var(--border)",
            }}>
            <div
              aria-hidden="true"
              className="absolute left-0 top-0 bottom-0"
              style={{ width: 3, background: g.color }}
            />

            <div
              className="w-full flex items-center px-3 py-3"
              role="button"
              tabIndex={0}
              onClick={() => setExpanded(isOpen ? null : g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded(isOpen ? null : g.id);
                }
              }}
            >
              <div className="rounded-full mr-3 shrink-0" style={{ width: 8, height: 8, background: g.color, boxShadow: `0 0 5px ${g.color}80` }} />
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>{groupName(g.id, g.name, language)}</span>
                  <span className="rounded-full px-1.5" style={{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg-surface2)" }}>
                    {language === "en" ? gHoldings.length : `${gHoldings.length} 只`}
                  </span>
                </div>
              </div>
              <div className="text-right mr-2">
                <p style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
                  {privacyMode ? `${currencySymbol(baseCurrency)}***` : formatSummaryMoney(stats.total, baseCurrency)}
                </p>
                <p style={{ color: todayC, fontSize: 10 }}>
                  {stats.todayPnl >= 0 ? "+" : "-"}{privacyMode ? `${currencySymbol(baseCurrency)}--` : formatSummaryMoney(stats.todayPnl, baseCurrency)}
                </p>
              </div>
              <ChevronRight size={14} color="var(--text-muted)"
                style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} />
            </div>

            <AnimatePresence>
              {isOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: "hidden" }}>
                  <div className="px-3 pb-2" style={{ borderTop: "1px solid var(--border)" }}>
                    {gHoldings.length === 0 ? (
                      <p style={{ color: "var(--text-micro)", fontSize: 12, textAlign: "center", padding: "12px 0" }}>
                        {text.noHoldingsInGroup}
                      </p>
                    ) : (
                      gHoldings.map((h) => {
                        return (
                          <div key={h.id} className="pt-2">
                            <HoldingCard
                              h={h}
                              groups={groups}
                              dcaPlans={dcaPlans}
                              isSelected={selectedId === h.id}
                              onSelect={() => onSelectHolding(h.id)}
                              onEdit={() => onEditHolding(h)}
                              onDelete={() => onDeleteHolding(h.id)}
                              onQuote={() => onQuote(h)}
                              onDCA={() => onDCA(h)}
                              onBuy={() => onBuy(h)}
                              onSell={() => onSell(h)}
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}

      {/* Ungrouped */}
      {(grouped[""]?.length ?? 0) > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <button className="w-full flex items-center px-3 py-2.5" onClick={() => setExpanded(expanded === "__ungrouped" ? null : "__ungrouped")}>
            <div className="rounded-full mr-3 shrink-0" style={{ width: 8, height: 8, background: "var(--text-micro)" }} />
            <span style={{ color: "var(--text-muted)", fontSize: 12, flex: 1, textAlign: "left" }}>{t(language).common.notGrouped}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11, marginRight: 8 }}>{language === "en" ? (grouped[""]?.length ?? 0) : `${grouped[""]?.length ?? 0} 只`}</span>
            <ChevronRight size={14} color="var(--text-muted)" style={{ transform: expanded === "__ungrouped" ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} />
          </button>
          <AnimatePresence>
            {expanded === "__ungrouped" && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: "hidden" }}>
                <div className="px-3 pb-2" style={{ borderTop: "1px solid var(--border)" }}>
	                  {(grouped[""] ?? []).map((h) => {
                    return (
                      <div key={h.id} className="pt-2">
                        <HoldingCard
                          h={h}
                          groups={groups}
                          dcaPlans={dcaPlans}
                          isSelected={selectedId === h.id}
                          onSelect={() => onSelectHolding(h.id)}
                          onEdit={() => onEditHolding(h)}
                          onDelete={() => onDeleteHolding(h.id)}
                          onQuote={() => onQuote(h)}
                          onDCA={() => onDCA(h)}
                          onBuy={() => onBuy(h)}
                          onSell={() => onSell(h)}
                        />
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {groups.length === 0 && (grouped[""]?.length ?? 0) === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Circle size={30} color="var(--text-micro)" />
          <p style={{ color: "var(--text-micro)", fontSize: 13 }}>{text.noGroups}</p>
        </div>
      )}
    </div>
  );
}

/* ─── Group sheet ────────────────────────────────────── */
function NewGroupSheet({
  initial,
  title = "新建分组",
  saveLabel = "确认创建",
  onSave,
  onClose,
}: {
  initial?: Pick<Group, "name" | "color">;
  title?: string;
  saveLabel?: string;
  onSave: (name: string, color: string) => void;
  onClose: () => void;
}) {
  const { language } = useApp();
  const text = t(language).holdings;
  const [name,  setName]  = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? DEFAULT_GROUP_COLOR);
  const [saving, setSaving] = useState(false);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 flex items-end" style={{ background: "var(--scrim)", zIndex: 50 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="w-full rounded-t-2xl p-5" style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between mb-4">
          <span style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>{title}</span>
          <button onClick={onClose}><X size={18} color="var(--text-muted)" /></button>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ color: "var(--text-muted)", fontSize: 11, display: "block", marginBottom: 4 }}>{text.groupName}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={text.groupNamePlaceholder}
              className="w-full rounded-xl px-3"
              style={{ height: 38, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
          </div>
          <div>
            <label style={{ color: "var(--text-muted)", fontSize: 11, display: "block", marginBottom: 8 }}>{text.groupColor}</label>
            <div className="flex gap-2 flex-wrap">
              {colorOptions.map((c) => (
                <button key={c} onClick={() => setColor(c)} className="rounded-full transition-transform"
                  style={{ width: 26, height: 26, background: c,
                    border: color === c ? "3px solid white" : "3px solid transparent",
                    boxShadow: color === c ? `0 0 8px ${c}` : "none",
                    transform: color === c ? "scale(1.15)" : "scale(1)" }} />
              ))}
            </div>
          </div>
          <button onClick={() => {
            if (!name.trim() || saving) return;
            setSaving(true);
            onSave(name.trim(), color || DEFAULT_GROUP_COLOR);
            onClose();
          }}
            disabled={!name.trim() || saving} className="w-full rounded-xl py-3"
            style={{ background: name.trim() && !saving ? "linear-gradient(135deg, #2563EB, #7C3AED)" : "var(--bg-card)",
              color: name.trim() && !saving ? "white" : "var(--text-micro)", fontSize: 13, fontWeight: 600 }}>
            {saving ? t(language).common.saving : saveLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════
   Main page
══════════════════════════════════════════════════════════ */
export function Holdings() {
  const { holdings, closedHoldings, groups, privacyMode, profitColor, currency,
    addHolding, updateHolding, adjustHolding, removeHolding, removeClosedHolding, addGroup, updateGroup, removeGroup,
    openDetail, refresh, isRefreshing, lastRefreshed, lastRefreshAt, dcaPlans, openDCAPanel, togglePrivacy, language } = useApp();
  const text = t(language);

  const [viewMode,     setViewMode]     = useState<"current" | "closed">("current");
  const [activeGroup,  setActiveGroup]  = useState("ALL");
  const [search,       setSearch]       = useState("");
  const [sortKey,      setSortKey]      = useState<"marketValue" | "todayPnlRate" | "totalPnlRate">("marketValue");
  const [sortDesc,     setSortDesc]     = useState(true);
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [sheetMode,    setSheetMode]    = useState<"add" | "edit" | null>(null);
  const [editTarget,   setEditTarget]   = useState<Holding | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<{ holding: Holding; mode: "buy" | "sell" } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteClosedTarget, setDeleteClosedTarget] = useState<string | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const skippedInitialAutoRefreshRef = useRef(false);

  useEffect(() => {
    if (!skippedInitialAutoRefreshRef.current) {
      skippedInitialAutoRefreshRef.current = true;
      return;
    }
    if (isRefreshing) return;
    if (!lastRefreshAt) return;
    if (Date.now() - lastRefreshAt < 30_000) return;
    void refresh();
  }, [isRefreshing, lastRefreshAt, refresh]);

  /* filtered + sorted holdings */
  const filtered = useMemo(() => {
    return holdings
      .filter((h) => {
        if (activeGroup === "__ungrouped" && h.groupId) return false;
        if (activeGroup !== "ALL" && activeGroup !== "__ungrouped" && h.groupId !== activeGroup) return false;
        const query = search.trim().toLowerCase();
        if (query && !h.symbol.toLowerCase().includes(query) && !h.name.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => {
        const av = sortKey === "marketValue" ? convertAmount(holdingMarketValue(a), a.currency, "CNY")
          : sortKey === "todayPnlRate" ? holdingTodayPnlRate(a)
          : sortKey === "totalPnlRate" ? holdingTotalPnlRate(a)
          : a[sortKey];
        const bv = sortKey === "marketValue" ? convertAmount(holdingMarketValue(b), b.currency, "CNY")
          : sortKey === "todayPnlRate" ? holdingTodayPnlRate(b)
          : sortKey === "totalPnlRate" ? holdingTotalPnlRate(b)
          : b[sortKey];
        const diff = av - bv;
        return sortDesc ? -diff : diff;
      });
  }, [holdings, activeGroup, search, sortKey, sortDesc]);

  const activeGroupMeta = activeGroup === "ALL"
    ? null
    : groups.find((group) => group.id === activeGroup) ?? null;
  const hasUngroupedHoldings = holdings.some((holding) => !holding.groupId);

  useEffect(() => {
    if (activeGroup === "ALL") return;
    if (activeGroup === "__ungrouped") {
      if (!hasUngroupedHoldings) setActiveGroup("ALL");
      return;
    }
    if (!groups.some((group) => group.id === activeGroup)) {
      setActiveGroup("ALL");
    }
  }, [activeGroup, groups, hasUngroupedHoldings]);

  /* ── strip stats: reflect current tab/filter context, all values in CNY ── */
  const stripStats = useMemo(() => {
    const source = filtered;
    const totalAsset   = source.reduce((s, h) => s + convertAmount(holdingMarketValue(h), h.currency, currency), 0);
    const todayPnl     = source.reduce((s, h) => s + convertAmount(h.todayPnl, h.currency, currency), 0);
    const cumulPnl     = source.reduce((s, h) => s + convertAmount(holdingTotalPnl(h), h.currency, currency), 0);
    return { totalAsset, todayPnl, cumulPnl };
  }, [currency, filtered]);

  /* ── closed-history strip stats: realized P/L, cost basis, proceeds ── */
  const closedStripStats = useMemo(() => {
    const proceeds = closedHoldings.reduce((s, h) => s + convertAmount(h.proceeds, h.currency, currency), 0);
    const cost     = closedHoldings.reduce((s, h) => s + convertAmount(h.costBasis, h.currency, currency), 0);
    const pnl      = closedHoldings.reduce((s, h) => s + convertAmount(h.realizedPnl, h.currency, currency), 0);
    return { proceeds, cost, pnl };
  }, [currency, closedHoldings]);

  const stripTodayColor = profitColor(stripStats.todayPnl);
  const stripCumulColor = profitColor(stripStats.cumulPnl);
  const stripClosedPnlColor = profitColor(closedStripStats.pnl);

  const openQuote = (h: Holding) => {
    openDetail({
      yahooSymbol: toYahooSymbol(h.symbol, h.market),
      displaySymbol: h.symbol,
      name: h.name,
      market: h.market,
      assetType: h.assetType,
      showCurrency: true,
      fallbackQuote: {
        price: h.currentPrice,
        change: holdingRateChange(h.currentPrice, h.todayPnlRate),
        changePercent: h.todayPnlRate,
        currency: h.currency,
        exchange: "Holding",
      },
    });
  };

  const handleSave = (input: HoldingInput) => {
    if (sheetMode === "edit" && editTarget) updateHolding(editTarget.id, input);
    else addHolding(input);
    setSheetMode(null); setEditTarget(null);
  };

  const handleAdjustSave = (input: HoldingAdjustmentInput) => {
    if (!adjustTarget) return;
    adjustHolding(adjustTarget.holding.id, input);
    setAdjustTarget(null);
    setSelectedId(null);
  };

  const refreshingActive = isRefreshing || manualRefreshing;

  useEffect(() => {
    if (!isRefreshing) setManualRefreshing(false);
  }, [isRefreshing]);

  const handleRefresh = useCallback(() => {
    if (refreshingActive) return;
    setManualRefreshing(true);
    void refresh();
  }, [refresh, refreshingActive]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden">

      <div
        className="shrink-0 z-20"
        style={{
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          backdropFilter: "blur(14px)",
        }}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4"
          style={{ height: 50, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>{text.holdings.title}</span>
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{lastRefreshed}</span>
            <button onClick={togglePrivacy}
              className="flex items-center justify-center rounded-lg"
              aria-label={privacyMode ? (language === "en" ? "Show sensitive data" : "显示敏感数据") : (language === "en" ? "Hide sensitive data" : "隐藏敏感数据")}
              title={privacyMode ? (language === "en" ? "Show sensitive data" : "显示敏感数据") : (language === "en" ? "Hide sensitive data" : "隐藏敏感数据")}
              style={{ width: 30, height: 30, background: "var(--bg-card)" }}>
              {privacyMode
                ? <EyeOff size={13} color="var(--text-muted)" />
                : <Eye size={13} color="var(--text-muted)" />}
            </button>
            <button onClick={handleRefresh}
              className="flex items-center justify-center rounded-lg"
              aria-label={text.common.refresh}
              aria-busy={refreshingActive}
              disabled={refreshingActive}
              style={{ width: 30, height: 30, background: "var(--bg-card)" }}>
              <RefreshCw
                size={13}
                color={refreshingActive ? "#4F9CF9" : "var(--text-muted)"}
                className={refreshingActive ? "animate-spin-smooth" : undefined}
              />
            </button>
            <button onClick={() => openDCAPanel()}
              className="flex items-center justify-center rounded-lg"
              style={{ width: 30, height: 30, background: "rgba(79,156,249,0.08)" }}
              title={text.dca.title}>
              <CalendarClock size={13} color="#4F9CF9" />
            </button>
            <button onClick={() => setSheetMode("add")}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(79,156,249,0.15)", color: "#4F9CF9", fontSize: 11 }}>
              <Plus size={13} strokeWidth={2.5} /> {text.holdings.add}
            </button>
          </div>
        </div>

        {/* ── Summary strip ── */}
        <div className="flex gap-3 px-4 py-2.5" style={{ borderBottom: "1px solid var(--border-sub)" }}>
          {viewMode === "closed" ? (
            <>
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedProceeds}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(closedStripStats.proceeds, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedCost}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(closedStripStats.cost, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.closedPnl}</p>
                <p className="truncate" style={{ color: stripClosedPnlColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {closedStripStats.pnl >= 0 ? "+" : "-"}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(closedStripStats.pnl, currency)}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.totalMarketValue}</p>
                <p className="truncate" style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {privacyMode ? `${currencySymbol(currency)}***` : formatSummaryMoney(stripStats.totalAsset, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.todayPnl}</p>
                <p className="truncate" style={{ color: stripTodayColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {stripStats.todayPnl >= 0 ? "+" : "-"}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(stripStats.todayPnl, currency)}
                </p>
              </div>
              <div style={{ width: 1, flexShrink: 0, background: "var(--bg-card)" }} />
              <div className="flex-1 min-w-0">
                <p style={{ color: "var(--text-muted)", fontSize: 10 }}>{text.holdings.cumulativePnl}</p>
                <p className="truncate" style={{ color: stripCumulColor, fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
                  {stripStats.cumulPnl >= 0 ? "+" : "-"}{privacyMode ? `${currencySymbol(currency)}--` : formatSummaryMoney(stripStats.cumulPnl, currency)}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 px-4 py-2" style={{ borderBottom: "1px solid var(--border-sub)" }}>
          {([
            { key: "current" as const, label: language === "en" ? "Open Holdings" : "当前持仓" },
            { key: "closed" as const, label: language === "en" ? "Realized P/L" : "已实现收益" },
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => setViewMode(item.key)}
              className="flex-1 rounded-xl py-2 transition-colors"
              style={{
                background: viewMode === item.key ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                color: viewMode === item.key ? "#4F9CF9" : "var(--text-muted)",
                border: viewMode === item.key ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border-sub)",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {item.label}{item.key === "closed" ? ` · ${closedHoldings.length}` : ""}
            </button>
          ))}
        </div>

      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 16 }}
      >
        {viewMode === "closed" ? (
          <ClosedHoldingsView
            items={closedHoldings}
            baseCurrency={currency}
            privacyMode={privacyMode}
            profitColor={profitColor}
            onDelete={(id) => setDeleteClosedTarget(id)}
            language={language}
          />
        ) : (
        <>
          {/* Search */}
          <div style={{ padding: "14px 12px 8px" }}>
            <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "var(--bg-card)", height: 36, marginTop: 2 }}>
              <Search size={14} color="var(--text-muted)" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={text.holdings.searchPlaceholder}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: 13 }} />
              {search && <button onClick={() => setSearch("")} style={{ color: "var(--text-muted)", fontSize: 16 }}>×</button>}
            </div>
          </div>

          {/* Group filter */}
          <div className="px-3 mb-2">
            <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              <button key="ALL" onClick={() => setActiveGroup("ALL")}
                className="rounded-full shrink-0 transition-all"
                style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 500,
                  background: activeGroup === "ALL" ? "#4F9CF9" : "var(--bg-card)",
                  color:      activeGroup === "ALL" ? "#fff"    : "var(--text-muted)",
                  border:     activeGroup === "ALL" ? "1px solid transparent" : "1px solid var(--border)",
                }}>
                {text.common.all}
              </button>
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="rounded-full shrink-0 flex items-center overflow-hidden"
                  style={{
                    background: activeGroup === group.id ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color:      activeGroup === group.id ? "#4F9CF9"               : "var(--text-muted)",
                    border:     activeGroup === group.id ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                  }}
                >
                  <button onClick={() => setActiveGroup(group.id)}
                    className="flex items-center gap-1.5 transition-all"
                    style={{
                      padding: activeGroup === group.id ? "4px 8px 4px 12px" : "4px 12px",
                      fontSize: 11,
                      fontWeight: 500,
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: group.color, flexShrink: 0 }} />
                    {groupName(group.id, group.name, language)}
                  </button>
                  {activeGroup === group.id && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingGroup(group);
                        }}
                        className="flex items-center justify-center"
                        style={{
                          width: 24,
                          height: 24,
                          color: "#4F9CF9",
                        }}
                        title={`${text.common.edit} ${groupName(group.id, group.name, language)}`}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteGroupTarget(group);
                        }}
                        className="flex items-center justify-center"
                        style={{
                          width: 24,
                          height: 24,
                          color: "#4F9CF9",
                        }}
                        title={`${text.common.delete} ${groupName(group.id, group.name, language)}`}
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {hasUngroupedHoldings && (
                <button
                  onClick={() => setActiveGroup("__ungrouped")}
                  className="rounded-full shrink-0 transition-all flex items-center gap-1.5"
                  style={{
                    padding: "4px 12px",
                    fontSize: 11,
                    fontWeight: 500,
                    background: activeGroup === "__ungrouped" ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color: activeGroup === "__ungrouped" ? "#4F9CF9" : "var(--text-muted)",
                    border: activeGroup === "__ungrouped" ? "1px solid rgba(79,156,249,0.25)" : "1px solid var(--border)",
                  }}
                >
                  <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--text-micro)", flexShrink: 0 }} />
                  {text.common.notGrouped}
                </button>
              )}
              <button onClick={() => setShowNewGroup(true)}
                className="rounded-full shrink-0"
                style={{
                  padding: "4px 12px",
                  fontSize: 11,
                  fontWeight: 500,
                  background: "rgba(79,156,249,0.12)",
                  color: "#4F9CF9",
                  border: "1px solid rgba(79,156,249,0.18)",
                }}>
                {text.holdings.addGroup}
              </button>
            </div>
          </div>

          {/* Sort */}
          <div className="flex items-center justify-between px-3 mb-2">
            <div className="flex items-center gap-2">
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{text.holdings.positionCount(filtered.length)}</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>·</span>
              <span style={{ color: "var(--text-micro)", fontSize: 10 }}>
                {activeGroup === "__ungrouped"
                  ? text.holdings.currentGroup(text.common.notGrouped)
                  : activeGroupMeta
                    ? text.holdings.currentGroup(groupName(activeGroupMeta.id, activeGroupMeta.name, language))
                    : text.holdings.allGroups(groups.length)}
              </span>
            </div>
            <div className="flex gap-1.5">
              {([
                { k: "marketValue",  label: text.holdings.sortMarketValue },
                { k: "todayPnlRate", label: text.holdings.sortToday },
                { k: "totalPnlRate", label: text.holdings.sortTotal },
              ] as const).map(({ k, label }) => (
                <button key={k}
                  onClick={() => { if (sortKey === k) setSortDesc((v) => !v); else { setSortKey(k); setSortDesc(true); } }}
                  className="rounded-lg px-2 py-1 transition-colors"
                  style={{
                    background: sortKey === k ? "rgba(79,156,249,0.15)" : "var(--bg-card)",
                    color:      sortKey === k ? "#4F9CF9"               : "var(--text-muted)",
                    fontSize: 10,
                  }}>
                  {label} {sortKey === k ? (sortDesc ? "↓" : "↑") : ""}
                </button>
              ))}
            </div>
          </div>

          {/* List / Grouped cards */}
          <div className="flex flex-col gap-1.5 px-3">
            {activeGroup === "ALL" ? (
              <LayoutGroup>
                <GroupsView
                  groups={groups}
                  holdings={filtered}
                  dcaPlans={dcaPlans}
                  baseCurrency={currency}
                  selectedId={selectedId}
                  onSelectHolding={(id) => setSelectedId(selectedId === id ? null : id)}
                  onEditHolding={(h) => { setEditTarget(h); setSheetMode("edit"); setSelectedId(null); }}
                  onDeleteHolding={(id) => setDeleteTarget(id)}
                  onQuote={openQuote}
                  onDCA={(holding) => { setSelectedId(null); openDCAPanel(holding.id); }}
                  onBuy={(holding) => { setSelectedId(null); setAdjustTarget({ holding, mode: "buy" }); }}
                  onSell={(holding) => { setSelectedId(null); setAdjustTarget({ holding, mode: "sell" }); }}
                />
              </LayoutGroup>
            ) : (
              <>
                <LayoutGroup>
                  <AnimatePresence>
                    {filtered.map((h, i) => (
	                      <motion.div key={h.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i * 0.015, 0.18) }}>
                        <HoldingCard
                          h={h} groups={groups}
                          dcaPlans={dcaPlans}
                          isSelected={selectedId === h.id}
                          onSelect={() => setSelectedId(selectedId === h.id ? null : h.id)}
                          onEdit={() => { setEditTarget(h); setSheetMode("edit"); setSelectedId(null); }}
                          onDelete={() => setDeleteTarget(h.id)}
                          onQuote={() => openQuote(h)}
                          onDCA={() => { setSelectedId(null); openDCAPanel(h.id); }}
                          onBuy={() => { setSelectedId(null); setAdjustTarget({ holding: h, mode: "buy" }); }}
                          onSell={() => { setSelectedId(null); setAdjustTarget({ holding: h, mode: "sell" }); }}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </LayoutGroup>

                {filtered.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <BarChart2 size={30} color="var(--text-micro)" />
                    <p style={{ color: "var(--text-micro)", fontSize: 13 }}>{text.holdings.emptyGroup}</p>
                    <button onClick={() => setSheetMode("add")}
                      className="flex items-center gap-1.5 rounded-xl px-4 py-2 mt-1"
                      style={{ background: "rgba(79,156,249,0.12)", color: "#4F9CF9", fontSize: 12 }}>
                      <Plus size={13} /> {text.holdings.firstHolding}
                    </button>
                  </div>
                )}
              </>
            )}

            {filtered.length > 0 && (
              <div className="flex justify-center mt-3">
                <button onClick={() => setSheetMode("add")}
                  className="flex items-center gap-2 rounded-full px-5 py-2.5"
                  style={{ background: "linear-gradient(135deg, #2563EB, #7C3AED)", color: "white", fontSize: 12, fontWeight: 600, boxShadow: "0 4px 16px rgba(79,156,249,0.3)" }}>
                  <Plus size={14} strokeWidth={2.5} /> {text.holdings.addNewHolding}
                </button>
              </div>
            )}
          </div>
        </>
        )}
      </div>

      {/* ── Modals / sheets ── */}
      <AnimatePresence>
        {sheetMode && (
          <FormSheet
            key={sheetMode === "edit" ? editTarget?.id : "add"}
            initial={
              sheetMode === "edit" && editTarget
                ? { groupId: editTarget.groupId, symbol: editTarget.symbol, name: editTarget.name,
                    market: editTarget.market, assetType: editTarget.assetType,
                    quantity: editTarget.quantity, costPrice: editTarget.costPrice,
                    currentPrice: editTarget.currentPrice, currency: editTarget.currency,
                    tradeStatus: editTarget.tradeStatus ?? "normal",
                    tradeStatusNote: editTarget.tradeStatusNote ?? "",
                    autoTradeStatus: editTarget.autoTradeStatus,
                    autoTradeStatusNote: editTarget.autoTradeStatusNote,
                    autoTradeStatusSource: editTarget.autoTradeStatusSource,
                    fundBuyConfirmDays: editTarget.fundBuyConfirmDays,
                    dividendReinvest: editTarget.dividendReinvest ?? null }
                : blankForm()
            }
            groups={groups}
            onSave={handleSave}
            onClose={() => { setSheetMode(null); setEditTarget(null); }}
            isEdit={sheetMode === "edit"}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(showNewGroup || editingGroup) && (
          <NewGroupSheet
            key={editingGroup?.id ?? "new-group"}
            initial={editingGroup ? { name: editingGroup.name, color: editingGroup.color } : undefined}
            title={editingGroup ? text.holdings.editGroup : text.holdings.newGroup}
            saveLabel={editingGroup ? text.holdings.saveChanges : text.holdings.confirmCreate}
            onSave={(name, color) => {
              if (editingGroup) updateGroup(editingGroup.id, { name, color });
              else addGroup({ name, color, visible: true });
            }}
            onClose={() => {
              setShowNewGroup(false);
              setEditingGroup(null);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {adjustTarget && (
          <AdjustSheet
            holding={adjustTarget.holding}
            mode={adjustTarget.mode}
            onSave={handleAdjustSave}
            onClose={() => setAdjustTarget(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{text.holdings.deleteHolding}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>{text.holdings.deleteHoldingDesc}</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => { removeHolding(deleteTarget); setDeleteTarget(null); setSelectedId(null); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>{text.common.confirmDelete}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteClosedTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                {language === "en" ? "Delete Record" : "删除清仓记录"}
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>{text.holdings.deleteHoldingDesc}</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteClosedTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => { removeClosedHolding(deleteClosedTarget); setDeleteClosedTarget(null); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>{text.common.confirmDelete}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteGroupTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="w-full rounded-2xl p-5"
              style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{text.holdings.deleteGroup}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
                {text.holdings.deleteGroupDesc(groupName(deleteGroupTarget.id, deleteGroupTarget.name, language))}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteGroupTarget(null)} className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-surface2)", color: "var(--text-secondary)", fontSize: 13 }}>{text.common.cancel}</button>
                <button onClick={() => {
                  removeGroup(deleteGroupTarget.id);
                  setDeleteGroupTarget(null);
                  setActiveGroup("ALL");
                }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13, fontWeight: 600 }}>
                  {text.common.confirmDelete}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
