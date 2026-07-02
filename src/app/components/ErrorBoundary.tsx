import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ThemeColors } from "../context/AppContext";
import type { AppCopy } from "../i18n";

type Props = {
  children: React.ReactNode;
  tc: ThemeColors;
  text: AppCopy;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (import.meta.env.DEV) {
      console.error("Asset Helper render error", error);
    }
  }

  render() {
    const { children, tc, text } = this.props;
    if (!this.state.error) return children;

    return (
      <div className="h-full flex items-center justify-center p-5" style={{ background: tc.bg }}>
        <div className="w-full rounded-2xl p-5 text-center" style={{ background: tc.bgCard, border: `1px solid ${tc.border}` }}>
          <div className="mx-auto mb-3 flex items-center justify-center rounded-xl" style={{ width: 42, height: 42, background: "rgba(242,78,78,0.12)" }}>
            <AlertCircle size={22} color="#F24E4E" />
          </div>
          <p style={{ color: tc.textPrimary, fontSize: 16, fontWeight: 800 }}>{text.routeError.title}</p>
          <p style={{ color: tc.textMuted, fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>{text.routeError.desc}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2"
            style={{ background: "rgba(79,156,249,0.14)", color: "#4F9CF9", fontSize: 12, fontWeight: 800 }}
          >
            <RefreshCw size={13} />
            {text.common.refresh}
          </button>
        </div>
      </div>
    );
  }
}
