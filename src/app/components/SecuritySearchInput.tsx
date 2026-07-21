import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bookmark, Loader2, Wifi, WifiOff } from "lucide-react";
import { useApp, type Language } from "../context/AppContext";
import type { LiveResult, Market } from "../services/securitiesApi";
import { t } from "../i18n";
import { normalizeHoldingType } from "../utils/holdingHelpers";
import { getMarketBadgeWithBg } from "../utils/marketBadge";
import { formatExactMoney } from "../utils/numberFormat";
import { useSecuritySearch } from "../utils/useSecuritySearch";

function securityBadge(market: string, assetType: string, language: Language) {
  if (market === "A" && assetType === "etf") {
    return { label: language === "en" ? "Listed ETF" : "场内ETF", color: "#4F9CF9", bg: "rgba(79,156,249,0.12)" };
  }
  if (market === "A" && assetType === "fund") {
    return { label: language === "en" ? "Listed Fund" : "场内基金", color: "#31D08B", bg: "rgba(49,208,139,0.12)" };
  }
  return getMarketBadgeWithBg(market, 0.1, language);
}

export interface SecuritySearchSuggestion {
  id: string;
  result: LiveResult;
}

export function SecuritySearchInput({
  value,
  onChange,
  onSelect,
  placeholder,
  marketFilter,
  suggestions = [],
  suggestionsLabel,
  onSuggestionSelect,
}: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (result: LiveResult) => void | Promise<void>;
  placeholder?: string;
  marketFilter?: Market;
  suggestions?: SecuritySearchSuggestion[];
  suggestionsLabel?: string;
  onSuggestionSelect?: (suggestion: SecuritySearchSuggestion) => void | Promise<void>;
}) {
  const { language } = useApp();
  const text = t(language);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { apiOk, hits, loading, open, setOpen, scheduleSearch } = useSecuritySearch(value, marketFilter);
  const normalizedQuery = value.trim().toLowerCase();
  const visibleSuggestions = suggestions.filter(({ result }) => {
    if (marketFilter && result.market !== marketFilter) return false;
    if (!normalizedQuery) return true;
    return result.name.toLowerCase().includes(normalizedQuery) || result.symbol.toLowerCase().includes(normalizedQuery);
  });
  const displayedSuggestions = visibleSuggestions;
  const displayedHits = hits.slice(0, 8);
  const hiddenHitCount = Math.max(0, hits.length - displayedHits.length);
  const hasResults = visibleSuggestions.length > 0 || hits.length > 0;

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [setOpen]);

  const handleChange = (next: string) => {
    onChange(next);
    scheduleSearch(next, marketFilter);
  };

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open && hasResults}
          aria-controls="security-search-listbox"
          aria-autocomplete="list"
          aria-label={placeholder}
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onFocus={() => { if (hasResults) setOpen(true); }}
          onClick={() => { if (hasResults) setOpen(true); }}
          placeholder={placeholder}
          className="h-[38px] w-full rounded-[10px] border bg-app-card px-3 pr-8 text-[13px] text-tp outline-none transition-colors placeholder:text-tmi"
          style={{ borderColor: open ? "rgba(79,156,249,0.45)" : "var(--border)" }}
        />
        <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
          {loading
            ? <Loader2 size={13} color="#4F9CF9" className="animate-spin-smooth" />
            : apiOk === true
              ? <Wifi size={12} color="#31D08B" />
              : apiOk === false
                ? <WifiOff size={12} className="text-tm" />
                : null}
        </div>
      </div>

      <AnimatePresence>
        {open && hasResults && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-x-0 top-[calc(100%+5px)] z-[999] overflow-hidden rounded-xl border border-app-accent/20 bg-app-overlay shadow-[var(--menu-shadow)]"
          >
            <div role="listbox" id="security-search-listbox" className="max-h-[268px] overflow-y-auto overscroll-contain" style={{ scrollbarWidth: "thin" }}>
              {displayedSuggestions.length > 0 && (
                <div className="border-b border-app-border-sub">
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-app-surface2 px-3 py-1.5 text-[9px] font-semibold text-tmi">
                    <span className="flex min-w-0 items-center gap-1.5"><Bookmark size={10} /><span className="truncate">{suggestionsLabel || (language === "en" ? "Saved" : "已保存")}</span></span>
                    <span className="shrink-0">{displayedSuggestions.length}/{visibleSuggestions.length}</span>
                  </div>
                  {displayedSuggestions.map((suggestion, index) => {
                    const result = suggestion.result;
                    const normalized = normalizeHoldingType(result.symbol, result.name, result.market, result.assetType);
                    const badge = securityBadge(normalized.market, normalized.assetType, language);
                    return (
                      <button
                        key={suggestion.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void onSuggestionSelect?.(suggestion);
                          setOpen(false);
                        }}
                        className="w-full px-3 py-2 text-left transition-colors hover:bg-[rgba(79,156,249,0.09)]"
                        style={{ borderBottom: index < displayedSuggestions.length - 1 ? "1px solid var(--border)" : undefined }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-tp">{result.name}</span>
                          <span className="shrink-0 text-[9px] font-semibold text-ts">{result.symbol}</span>
                          <span className="shrink-0 rounded px-[5px] py-0.5 text-[8px] font-bold" style={{ color: badge.color, background: badge.bg }}>{badge.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {displayedHits.length > 0 && (
                <div className="sticky top-0 z-10 flex items-center justify-between bg-app-surface2 px-3 py-1.5 text-[9px] font-semibold text-tmi">
                  <span>{language === "en" ? "Market search" : "市场搜索"}</span>
                  <span>{displayedHits.length}/{hits.length}</span>
                </div>
              )}
              {displayedHits.map((result, index) => {
                const normalized = normalizeHoldingType(result.symbol, result.name, result.market, result.assetType);
                const badge = securityBadge(normalized.market, normalized.assetType, language);
                return (
                  <button
                    key={`${result.market}:${result.symbol}:${index}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      void onSelect(result);
                      setOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left transition-colors hover:bg-[rgba(79,156,249,0.09)]"
                    style={{ borderBottom: `1px solid ${index < displayedHits.length - 1 ? "var(--border)" : "transparent"}` }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-bold leading-[1.35] text-tp">{result.name}</span>
                      <span className={`shrink-0 whitespace-nowrap text-[11px] font-bold ${result.price > 0 ? "text-app-accent" : "text-tmi"}`}>
                        {result.price > 0 ? formatExactMoney(result.price, result.currency) : text.holdings.waitingQuote}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5">
                      <span className="text-[11px] font-bold text-ts">{result.symbol}</span>
                      <span className="rounded px-[5px] py-0.5 text-[8px] font-bold" style={{ color: badge.color, background: badge.bg }}>
                        {badge.label}
                      </span>
                      {result.exchange && <span className="min-w-0 truncate text-[9px] text-tmi">{result.exchange}</span>}
                      <span className={`ml-auto rounded px-[5px] py-px text-[8px] ${result.source === "live" && result.price > 0 ? "bg-[rgba(49,208,139,0.1)] text-[#31D08B]" : "bg-[rgba(100,116,139,0.1)] text-tm"}`}>
                        {result.source === "live" && result.price > 0 ? text.common.live : result.source === "live" ? text.common.matched : text.common.local}
                      </span>
                    </div>
                  </button>
                );
              })}
              {hiddenHitCount > 0 && (
                <p className="px-3 py-1.5 text-center text-[9px] text-tmi">{language === "en" ? `${hiddenHitCount} more results · refine your search` : `还有 ${hiddenHitCount} 条结果 · 请缩小搜索范围`}</p>
              )}
            </div>
            {hits.length > 0 && (
              <div className="flex items-center justify-between border-t border-app-border-sub bg-app-surface2 px-3 py-1 text-[9px] text-tmi">
                <span className="truncate">Yahoo · Tencent · EastMoney · CoinGecko</span>
                <span className="ml-2 shrink-0">{text.common.referenceOnly}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
