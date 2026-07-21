import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Navigate } from "react-router";
import { Layout }    from "./components/Layout";
import { appText } from "./i18n";

const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const Holdings = lazy(() => import("./pages/Holdings").then((module) => ({ default: module.Holdings })));
const Returns = lazy(() => import("./pages/Returns").then((module) => ({ default: module.Returns })));
const Market = lazy(() => import("./pages/Market").then((module) => ({ default: module.Market })));
const ResearchHub = lazy(() => import("./pages/ResearchHub").then((module) => ({ default: module.ResearchHub })));
const Settings = lazy(() => import("./pages/Settings").then((module) => ({ default: module.Settings })));
const AISettings = lazy(() => import("./pages/AISettings").then((module) => ({ default: module.AISettings })));

function readRouteLanguage() {
  try {
    const raw = localStorage.getItem("asset-helper:v2");
    if (!raw) return "zh";
    const parsed = JSON.parse(raw) as { language?: string };
    return parsed.language === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

function RouteErrorFallback() {
  const text = appText[readRouteLanguage()].routeError;
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 text-center"
      style={{ background: "var(--bg, #EEF4FB)", color: "var(--text-primary, #0F172A)" }}
    >
      <p style={{ fontSize: 15, fontWeight: 700 }}>{text.title}</p>
      <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary, #64748B)", lineHeight: 1.6 }}>
        {text.desc}
      </p>
      <a
        href="#/"
        style={{
          marginTop: 16,
          borderRadius: 12,
          background: "#4F9CF9",
          color: "#fff",
          padding: "9px 18px",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {text.action}
      </a>
    </div>
  );
}

function RouteLoadingFallback() {
  const text = readRouteLanguage() === "en" ? "Loading..." : "加载中...";
  return (
    <div
      className="flex h-full items-center justify-center"
      style={{ background: "var(--bg, #EEF4FB)", color: "var(--text-secondary, #64748B)", fontSize: 13, fontWeight: 700 }}
    >
      {text}
    </div>
  );
}

function withSuspense(Component: LazyExoticComponent<ComponentType>) {
  return function SuspendedRoute() {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <Component />
      </Suspense>
    );
  };
}

export const appRoutes = [
  {
    path: "/",
    Component: Layout,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true,      Component: withSuspense(Dashboard) },
      { path: "holdings", Component: withSuspense(Holdings)  },
      { path: "returns",  Component: withSuspense(Returns)   },
      { path: "market",   Component: withSuspense(Market)    },
      { path: "research", Component: withSuspense(ResearchHub) },
      { path: "backtest", element: <Navigate to="/research?tab=backtest" replace /> },
      { path: "settings", Component: withSuspense(Settings)  },
      { path: "settings/ai", Component: withSuspense(AISettings) },
      { path: "*",        element: <Navigate to="/" replace /> },
    ],
  },
];
