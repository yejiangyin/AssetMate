import { NavLink, Outlet, useLocation } from "react-router";
import { LayoutDashboard, BarChart2, Settings, Globe } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef } from "react";
import { AppProvider } from "../context/AppContext";
import { useApp } from "../context/AppContext";
import { StockDetail } from "./StockDetail";
import { DCAPanel } from "./DCAPanel";
import { t } from "../i18n";

const tabs = [
  { to: "/",         key: "dashboard" as const, icon: LayoutDashboard },
  { to: "/holdings", key: "holdings" as const, icon: BarChart2 },
  { to: "/market",   key: "market" as const, icon: Globe },
  { to: "/settings", key: "settings" as const, icon: Settings },
];

/** Inner layout — can safely call useApp() because AppProvider is its parent */
function LayoutInner() {
  const { detailTarget, closeDetail, dcaPanelOpen, closeDCAPanel, tc, language } = useApp();
  const text = t(language);
  const location = useLocation();
  const previousPathRef = useRef(location.pathname);
  const accent = "var(--app-accent, #4F9CF9)";

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
      style={{
        width: 400, height: 600,
        minWidth: 400, minHeight: 600,
        maxHeight: 600,
        background: tc.bg,
        fontFamily: "'Inter', system-ui, sans-serif",
        /* CSS custom properties for pages to consume */
        ["--bg" as any]:              tc.bg,
        ["--bg-card" as any]:         tc.bgCard,
        ["--bg-surface" as any]:      tc.bgSurface,
        ["--bg-surface2" as any]:     tc.bgSurface2,
        ["--bg-overlay" as any]:      tc.bgOverlay,
        ["--bg-control" as any]:      tc.bgControl,
        ["--control-hover" as any]:   tc.controlHover,
        ["--border" as any]:          tc.border,
        ["--border-sub" as any]:      tc.borderSub,
        ["--text-primary" as any]:    tc.textPrimary,
        ["--text-secondary" as any]:  tc.textSecondary,
        ["--text-muted" as any]:      tc.textMuted,
        ["--text-micro" as any]:      tc.textMicro,
        ["--option-bg" as any]:       tc.optionBg,
        ["--menu-shadow" as any]:     tc.menuShadow,
        ["--scrim" as any]:           tc.scrim,
        ["--app-accent" as any]:      "#4F9CF9",
      }}
    >
      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{
          overscrollBehaviorY: "contain",
        }}
      >
        <Outlet />
      </div>

      {/* Bottom nav — 4 tabs */}
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
