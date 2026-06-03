import { Navigate } from "react-router";
import { Layout }    from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Holdings }  from "./pages/Holdings";
import { Settings }  from "./pages/Settings";
import { Market }    from "./pages/Market";
import { appText } from "./i18n";

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

export const appRoutes = [
  {
    path: "/",
    Component: Layout,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true,      Component: Dashboard },
      { path: "holdings", Component: Holdings  },
      { path: "market",   Component: Market    },
      { path: "settings", Component: Settings  },
      { path: "*",        element: <Navigate to="/" replace /> },
    ],
  },
];
