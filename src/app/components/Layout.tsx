import { NavLink, Outlet, useLocation } from "react-router";
import { LayoutDashboard, BarChart2, Settings, Globe, Calculator } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { AppProvider } from "../context/AppContext";
import { useApp } from "../context/AppContext";
import { StockDetail } from "./StockDetail";
import { DCAPanel } from "./DCAPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { t } from "../i18n";
import { getExtensionViewMode } from "../utils/extensionOpenMode";

const tabs = [
  { to: "/",         key: "dashboard" as const, icon: LayoutDashboard },
  { to: "/holdings", key: "holdings" as const, icon: BarChart2 },
  { to: "/market",   key: "market" as const, icon: Globe },
  { to: "/backtest", key: "backtest" as const, icon: Calculator },
  { to: "/settings", key: "settings" as const, icon: Settings },
];

/** Inner layout — can safely call useApp() because AppProvider is its parent */
function LayoutInner() {
  const { detailTarget, closeDetail, dcaPanelOpen, closeDCAPanel, tc, language } = useApp();
  const text = t(language);
  const location = useLocation();
  const previousPathRef = useRef(location.pathname);
  const accent = "var(--app-accent, #4F9CF9)";
  const isSidePanel = getExtensionViewMode() === "sidepanel";
  const rootStyle = useMemo(() => ({
    width: isSidePanel ? "100vw" : "min(400px, 100vw)",
    height: isSidePanel ? "100vh" : "min(600px, 100vh)",
    minWidth: isSidePanel ? 320 : "min(320px, 100vw)",
    minHeight: isSidePanel ? 0 : "min(480px, 100vh)",
    maxHeight: "100vh",
    background: tc.bg,
    fontFamily: "'Inter', system-ui, sans-serif",
    "--bg": tc.bg,
    "--bg-card": tc.bgCard,
    "--bg-surface": tc.bgSurface,
    "--bg-surface2": tc.bgSurface2,
    "--bg-overlay": tc.bgOverlay,
    "--bg-control": tc.bgControl,
    "--control-hover": tc.controlHover,
    "--border": tc.border,
    "--border-sub": tc.borderSub,
    "--text-primary": tc.textPrimary,
    "--text-secondary": tc.textSecondary,
    "--text-muted": tc.textMuted,
    "--text-micro": tc.textMicro,
    "--option-bg": tc.optionBg,
    "--menu-shadow": tc.menuShadow,
    "--scrim": tc.scrim,
    "--app-accent": "#4F9CF9",
  }) as CSSProperties, [isSidePanel, tc]);

  useEffect(() => {
    if (previousPathRef.current !== location.pathname) {
      previousPathRef.current = location.pathname;
      if (detailTarget) closeDetail();
      if (dcaPanelOpen) closeDCAPanel();
    }
  }, [closeDCAPanel, closeDetail, dcaPanelOpen, detailTarget, location.pathname]);

  return (
    <div
      className="relative flex flex-col overflow-hidden"
      style={rootStyle}
    >
      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{
          overscrollBehaviorY: "contain",
        }}
      >
        <ErrorBoundary tc={tc} text={text}>
          <Outlet />
        </ErrorBoundary>
      </div>

      {/* Bottom nav */}
      <nav
        className="shrink-0 flex items-stretch border-t"
        style={{
          height:      58,
          background:  tc.navBg,
          borderColor: tc.navBorder,
          backdropFilter: "blur(12px)",
        }}
      >
        {tabs.map(({ to, key, icon: Icon }) => (
          <NavLink
            key={to} to={to} end={to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center flex-1 gap-0.5 transition-colors duration-150 ${isActive ? "" : "opacity-40"}`
            }
            style={({ isActive }) => ({ color: isActive ? accent : tc.textSecondary })}
          >
            <Icon size={19} strokeWidth={1.8} />
            <span style={{ fontSize: 10, fontWeight: 500 }}>{text.nav[key]}</span>
          </NavLink>
        ))}
      </nav>

      {/* Stock detail overlay */}
      <AnimatePresence>
        {detailTarget && <StockDetail />}
      </AnimatePresence>

      {/* DCA panel overlay */}
      <AnimatePresence>
        {dcaPanelOpen && <DCAPanel />}
      </AnimatePresence>
    </div>
  );
}

/** Layout wraps itself with AppProvider so context is always available in the router tree */
export function Layout() {
  return (
    <AppProvider>
      <LayoutInner />
    </AppProvider>
  );
}
