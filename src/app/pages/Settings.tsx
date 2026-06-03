import { useRef, useState, useEffect, useLayoutEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DollarSign, Clock, Eye, Download, Upload, Trash2,
  RefreshCw, Moon, Sun, Monitor, ChevronRight, Check, Shield,
  Zap, AlertCircle, CalendarClock, Languages,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { motion, AnimatePresence } from "motion/react";
import { BrandMark } from "../components/BrandMark";
import { getTradingCalendarStatus, refreshTradingCalendar } from "../services/tradingCalendar";
import { t, type AppCopy } from "../i18n";

const refreshValues = [0, 1, 5, 15, 30, 60] as const;
type SettingsCopy = AppCopy["settings"];

function formatCalendarStatus(status: ReturnType<typeof getTradingCalendarStatus>, text: SettingsCopy) {
  if (!status) return text.calendarFallback;
  const time = new Date(status.savedAt);
  const date = `${time.getFullYear()}/${String(time.getMonth() + 1).padStart(2, "0")}/${String(time.getDate()).padStart(2, "0")}`;
  const years = status.years.length ? ` · ${status.years.join("、")}` : "";
  return text.calendarUpdated(date, years);
}

/* ─── SettingRow ─────────────────────────────────────── */
function SettingRow({
  icon: Icon, label, description, children, iconColor = "#4F9CF9", tc,
}: {
  icon: any; label: string; description?: string;
  children: ReactNode; iconColor?: string; tc: any;
}) {
  return (
    <div className="flex items-center px-3 py-3"
      style={{ borderBottom: `1px solid ${tc.borderSub}` }}>
      <div className="flex items-center justify-center rounded-lg mr-3 shrink-0"
        style={{ width: 30, height: 30, background: `${iconColor}18` }}>
        <Icon size={14} color={iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p style={{ color: tc.textPrimary, fontSize: 13 }}>{label}</p>
        {description && <p style={{ color: tc.textMuted, fontSize: 10, marginTop: 1 }}>{description}</p>}
      </div>
      {children}
    </div>
  );
}

/* ─── ToggleSwitch ───────────────────────────────────── */
function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} className="rounded-full transition-all duration-200"
      style={{
        width: 36, height: 20,
        background: value ? "#4F9CF9" : "var(--border)",
        padding: 2, position: "relative",
      }}>
      <motion.div animate={{ x: value ? 16 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}
        className="rounded-full" style={{ width: 16, height: 16, background: "white" }} />
    </button>
  );
}

/* ─── Select ─────────────────────────────────────────── */
function Select<T extends string | number>({
  value, onChange, options, tc,
}: {
  value: T; onChange: (v: T) => void;
  options: { value: T; label: string }[]; tc: any;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open) return;

    const placeMenu = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const padding = 8;
      const menuWidth = Math.max(116, rect.width);
      const estimatedHeight = Math.min(240, options.length * 36);
      const belowSpace = window.innerHeight - rect.bottom;
      const aboveSpace = rect.top;
      const openBelow = belowSpace >= estimatedHeight + padding || belowSpace >= aboveSpace;
      const left = Math.min(
        Math.max(padding, rect.right - menuWidth),
        window.innerWidth - menuWidth - padding,
      );
      const top = openBelow
        ? Math.min(window.innerHeight - estimatedHeight - padding, rect.bottom + 4)
        : Math.max(padding, rect.top - estimatedHeight - 4);

      setMenuStyle({
        position: "fixed",
        top,
        left,
        minWidth: menuWidth,
        maxHeight: 240,
        overflowY: "auto",
        transformOrigin: openBelow ? "top right" : "bottom right",
      });
    };

    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle, true);
    return () => document.removeEventListener("mousedown", handle, true);
  }, [open]);

  const menu = (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0, y: 4, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.95 }}
          ref={menuRef}
          className="rounded-xl overflow-hidden"
          style={{ ...menuStyle, background: tc.bgOverlay, border: `1px solid ${tc.border}`,
            zIndex: 1000, boxShadow: "var(--menu-shadow)" }}>
          {options.map((o) => (
            <button key={String(o.value)} onClick={() => { onChange(o.value); setOpen(false); }}
              className="w-full flex items-center justify-between px-3 py-2 transition-colors"
              style={{
                background: value === o.value ? "rgba(79,156,249,0.15)" : "transparent",
                color: value === o.value ? "#4F9CF9" : tc.textSecondary,
                fontSize: 12,
              }}>
              {o.label}
              {value === o.value && <Check size={11} />}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative" ref={containerRef}>
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
        style={{ background: "var(--bg-control)", color: tc.textSecondary, fontSize: 11 }}>
        {current?.label}
        <ChevronRight size={11} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {typeof document !== "undefined" ? createPortal(menu, document.body) : menu}
    </div>
  );
}

/* ─── SectionCard ────────────────────────────────────── */
function SectionCard({ children, tc }: { children: ReactNode; tc: any }) {
  return (
    <div className="rounded-xl"
      style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
      {children}
    </div>
  );
}

/* ─── ThemePreview (small live preview dot row) ──────── */
function ThemePreview({ tc }: { tc: any }) {
  const { language } = useApp();
  const text = t(language).settings;
  return (
    <div className="flex items-center gap-2 mt-1.5 mb-0.5">
      {[tc.bg, tc.bgCard, tc.bgSurface, tc.border, tc.textPrimary, tc.textSecondary].map((c) => (
        <div key={c} className="rounded-full border"
          style={{ width: 12, height: 12, background: c, borderColor: tc.border, flexShrink: 0 }} />
      ))}
      <span style={{ color: tc.textMicro, fontSize: 9 }}>{text.themePreview}</span>
    </div>
  );
}

/* ─── AccentColorPicker ──────────────────────────────── */
// (accent is always #4F9CF9 for now — future extension)

/* ─── Main Settings ──────────────────────────────────── */
export function Settings() {
  const {
    defaultPrivacyMode, setDefaultPrivacyMode,
    colorScheme, setColorScheme,
    theme, setTheme,
    currency, setCurrency,
    language, setLanguage,
    refreshInterval, setRefreshInterval,
    tradeTimeOnly, setTradeTimeOnly,
    exportPortfolio, importPortfolio, clearLocalData,
    tc, dcaPlans, openDCAPanel,
  } = useApp();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [toastMessage, setToastMessage] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [calendarStatus, setCalendarStatus] = useState(() => getTradingCalendarStatus());
  const [calendarRefreshing, setCalendarRefreshing] = useState(false);
  const text = t(language).settings;
  const refreshOptions = refreshValues.map((value, index) => ({ value, label: text.refreshOptions[index] ?? String(value) }));

  const showToast = (message: string) => {
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage("");
      toastTimerRef.current = null;
    }, 2200);
  };

  useEffect(() => () => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const handleExport = () => {
    const blob = new Blob([exportPortfolio()], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asset-helper-${new Date().toISOString().slice(0, 10)}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
    showToast(text.exportOk);
  };

  const handleRefreshCalendar = async () => {
    setCalendarRefreshing(true);
    const status = await refreshTradingCalendar(true);
    setCalendarStatus(status);
    setCalendarRefreshing(false);
    showToast(status ? text.calendarOk : text.calendarFail);
  };

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    const result = importPortfolio(await file.text());
    showToast(result.ok ? text.importOk : result.error ?? text.importFail);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const THEME_BTNS = [
    { v: "light" as const, icon: Sun,     label: text.themeLight },
    { v: "system" as const, icon: Monitor, label: text.themeSystem },
    { v: "dark"  as const, icon: Moon,    label: text.themeDark },
  ];

  return (
    <div className="relative h-full flex flex-col overflow-hidden" style={{ background: tc.bg }}>
      {/* Header */}
      <div className="shrink-0 z-20 flex items-center px-4"
        style={{
          height: 50,
          borderBottom: `1px solid ${tc.border}`,
          background: tc.bgOverlay,
          backdropFilter: "blur(14px)",
        }}>
        <span style={{ color: tc.textPrimary, fontSize: 14, fontWeight: 600 }}>{text.title}</span>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "none", overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 12 }}
      >
      {/* ── Display Settings ── */}
      <div className="mt-3 px-3">
        <p style={{ color: tc.textMuted, fontSize: 11, fontWeight: 500, marginBottom: 6, paddingLeft: 2 }}>{text.display}</p>
        <SectionCard tc={tc}>
          <SettingRow icon={DollarSign} label={text.currency} iconColor="#31D08B" tc={tc}>
            <Select value={currency} onChange={setCurrency} tc={tc}
              options={[
                { value: "CNY", label: "CNY ¥" },
                { value: "USD", label: "USD $" },
                { value: "HKD", label: "HKD HK$" },
              ]} />
          </SettingRow>

          <SettingRow icon={Languages} label={text.language} description={text.languageDesc} iconColor="#38BDF8" tc={tc}>
            <Select value={language} onChange={setLanguage} tc={tc}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]} />
          </SettingRow>

          <SettingRow icon={Eye} label={text.privacy} description={text.privacyDesc} iconColor="#8B5CF6" tc={tc}>
            <ToggleSwitch value={defaultPrivacyMode} onChange={setDefaultPrivacyMode} />
          </SettingRow>

          {/* Theme — live preview + selector */}
          <SettingRow icon={Monitor} label={text.theme} iconColor="#F59E0B" tc={tc}>
            <div className="flex rounded-lg overflow-hidden" style={{ border: `1px solid ${tc.border}` }}>
              {THEME_BTNS.map(({ v, icon: Icon, label }) => (
                <button key={v} onClick={() => setTheme(v)}
                  className="flex flex-col items-center justify-center gap-0.5 transition-colors"
                  style={{
                    width: 44, height: 38, padding: "4px 0",
                    background: theme === v
                      ? (tc.isDark ? "rgba(79,156,249,0.2)" : "rgba(79,156,249,0.15)")
                      : "transparent",
                    color: theme === v ? "#4F9CF9" : tc.textMuted,
                    borderRight: v !== "dark" ? `1px solid ${tc.border}` : "none",
                  }}>
                  <Icon size={12} />
                  <span style={{ fontSize: 9 }}>{label}</span>
                </button>
              ))}
            </div>
          </SettingRow>

          {/* Theme color preview strip */}
          <div className="px-3 pb-2.5">
            <ThemePreview tc={tc} />
          </div>

          <SettingRow icon={Zap} label={text.pnlColor} description={text.pnlColorDesc} iconColor="#F24E4E" tc={tc}>
            <div className="flex rounded-lg overflow-hidden" style={{ border: `1px solid ${tc.border}` }}>
              {[
                { key: "red-up"   as const, label: text.redUp, color: "#F24E4E", activeBg: "rgba(242,78,78,0.2)"   },
                { key: "green-up" as const, label: text.greenUp, color: "#31D08B", activeBg: "rgba(49,208,139,0.2)"  },
              ].map(({ key, label, color, activeBg }) => (
                <button key={key} onClick={() => setColorScheme(key)}
                  className="px-2.5 py-1.5 transition-colors"
                  style={{
                    background: colorScheme === key ? activeBg : "transparent",
                    fontSize: 10, fontWeight: 600,
                    color: colorScheme === key ? color : tc.textMuted,
                    borderRight: key === "red-up" ? `1px solid ${tc.border}` : "none",
                  }}>
                  {label}
                  {colorScheme === key && (
                    <span style={{ display: "inline-block", marginLeft: 3, fontSize: 8 }}>●</span>
                  )}
                </button>
              ))}
            </div>
          </SettingRow>
        </SectionCard>
      </div>

      {/* ── 定投计划 ── */}
      <div className="mt-4 px-3">
        <p style={{ color: tc.textMuted, fontSize: 11, fontWeight: 500, marginBottom: 6, paddingLeft: 2 }}>{text.dca}</p>
        <button onClick={() => openDCAPanel()}
          className="w-full rounded-xl px-3 py-3 flex items-center gap-3"
          style={{
            background: tc.bgCard,
            border: `1px solid ${tc.border}`,
            textAlign: "left",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(79,156,249,0.3)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = tc.border)}
        >
          <div className="rounded-lg flex items-center justify-center shrink-0"
            style={{ width: 30, height: 30, background: "rgba(79,156,249,0.12)" }}>
            <CalendarClock size={14} color="#4F9CF9" />
          </div>
          <div className="flex-1">
            <p style={{ color: tc.textPrimary, fontSize: 13 }}>{text.dcaManage}</p>
            <p style={{ color: tc.textMuted, fontSize: 10, marginTop: 1 }}>
              {dcaPlans.length === 0
                ? text.dcaEmpty
                : text.dcaSummary(dcaPlans.filter((p) => p.enabled).length, dcaPlans.length)}
            </p>
          </div>
          <ChevronRight size={14} color={tc.textMuted} />
        </button>
      </div>

      {/* ── Refresh Settings ── */}
      <div className="mt-4 px-3">
        <p style={{ color: tc.textMuted, fontSize: 11, fontWeight: 500, marginBottom: 6, paddingLeft: 2 }}>{text.refresh}</p>
        <SectionCard tc={tc}>
          <SettingRow icon={Clock} label={text.autoRefresh} description={text.autoRefreshDesc} iconColor="#4F9CF9" tc={tc}>
            <Select value={refreshInterval} onChange={setRefreshInterval} tc={tc}
              options={refreshOptions} />
          </SettingRow>
          <SettingRow icon={RefreshCw} label={text.tradeTimeOnly} description={text.tradeTimeOnlyDesc} iconColor="#14B8A6" tc={tc}>
            <ToggleSwitch value={tradeTimeOnly} onChange={setTradeTimeOnly} />
          </SettingRow>
          <SettingRow
            icon={CalendarClock}
            label={text.calendar}
            description={formatCalendarStatus(calendarStatus, text)}
            iconColor="#8B5CF6"
            tc={tc}
          >
            <button
              onClick={() => void handleRefreshCalendar()}
              disabled={calendarRefreshing}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{
                background: "rgba(139,92,246,0.1)",
                color: "#8B5CF6",
                fontSize: 11,
                opacity: calendarRefreshing ? 0.7 : 1,
              }}
            >
              <RefreshCw size={11} className={calendarRefreshing ? "animate-spin" : ""} />
              {text.calendarUpdate}
            </button>
          </SettingRow>
        </SectionCard>
      </div>

      {/* ── Data Settings ── */}
      <div className="mt-4 px-3">
        <p style={{ color: tc.textMuted, fontSize: 11, fontWeight: 500, marginBottom: 6, paddingLeft: 2 }}>{text.data}</p>
        <SectionCard tc={tc}>
          <SettingRow icon={Download} label={text.exportData} description={text.exportDesc} iconColor="#31D08B" tc={tc}>
            <button onClick={handleExport}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(49,208,139,0.1)", color: "#31D08B", fontSize: 11 }}>
              <Download size={11} /> {text.exportAction}
            </button>
          </SettingRow>
          <SettingRow icon={Upload} label={text.importData} description={text.importDesc} iconColor="#4F9CF9" tc={tc}>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => void handleImportFile(e.target.files?.[0])}
            />
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(79,156,249,0.1)", color: "#4F9CF9", fontSize: 11 }}>
              <Upload size={11} /> {text.importAction}
            </button>
          </SettingRow>
          <SettingRow icon={Trash2} label={text.reset} description={text.resetDesc} iconColor="#F24E4E" tc={tc}>
            <button onClick={() => setShowClearConfirm(true)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(242,78,78,0.1)", color: "#F24E4E", fontSize: 11 }}>
              {text.clear}
            </button>
          </SettingRow>
        </SectionCard>
      </div>

      {/* Privacy notice */}
      <div className="mx-3 mt-4 rounded-xl px-3 py-3 flex gap-2"
        style={{ background: "rgba(79,156,249,0.06)", border: "1px solid rgba(79,156,249,0.12)" }}>
        <Shield size={14} color="#4F9CF9" className="shrink-0 mt-0.5" />
        <p style={{ color: tc.textMuted, fontSize: 11, lineHeight: 1.6 }}>
          {text.privacyNotice}
        </p>
      </div>

      {/* Version */}
      <div className="mt-4 flex items-center justify-center gap-1">
        <BrandMark size={12} />
        <span style={{ color: tc.textMicro, fontSize: 10 }}>{t(language).appName} v1.0.0</span>
      </div>
      </div>

      {/* Export Toast */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="absolute left-4 right-4 bottom-20 rounded-xl px-4 py-3 flex items-center gap-2"
            style={{ background: tc.isDark ? "#1A2F1E" : "#F0FDF4", border: "1px solid rgba(49,208,139,0.3)", zIndex: 100 }}>
            <Check size={14} color="#31D08B" />
            <span style={{ color: "#31D08B", fontSize: 13 }}>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Clear Confirm */}
      <AnimatePresence>
        {showClearConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ background: "var(--scrim)", zIndex: 50 }}>
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
              className="w-full rounded-2xl p-5"
              style={{ background: tc.bgOverlay, border: `1px solid ${tc.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle size={18} color="#F24E4E" />
                <p style={{ color: tc.textPrimary, fontSize: 15, fontWeight: 600 }}>{text.clearTitle}</p>
              </div>
              <p style={{ color: tc.textMuted, fontSize: 13, marginBottom: 16 }}>
                {text.clearDesc}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setShowClearConfirm(false)}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "var(--bg-control)", color: tc.textSecondary, fontSize: 13 }}>
                  {text.cancel}
                </button>
                <button onClick={() => { clearLocalData(); setShowClearConfirm(false); showToast(text.clearOk); }}
                  className="flex-1 rounded-xl py-2.5"
                  style={{ background: "rgba(242,78,78,0.15)", color: "#F24E4E", fontSize: 13 }}>
                  {text.confirmClear}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
