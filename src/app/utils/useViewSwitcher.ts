import { useCallback } from "react";
import { useApp } from "../context/AppContext";
import { getExtensionViewMode, openExtensionMode, syncExtensionOpenMode, type ExtensionOpenMode } from "./extensionOpenMode";

function closeCurrentWindow(delay = 0) {
  if (typeof window === "undefined") return;
  const close = () => {
    try { window.close(); } catch { /* ignore */ }
  };
  if (delay > 0) {
    window.setTimeout(close, delay);
  } else {
    close();
  }
}

export function useViewSwitcher(onError?: () => void) {
  const { language, setDefaultOpenMode } = useApp();
  const currentView = getExtensionViewMode();
  const isSidePanel = currentView === "sidepanel";
  const switchTitle = isSidePanel
    ? (language === "en" ? "Switch to popup" : "切换为弹窗")
    : (language === "en" ? "Switch to side panel" : "切换为右侧面板");

  const switchToMode = useCallback((mode: ExtensionOpenMode) => {
    setDefaultOpenMode(mode);
    if (mode === currentView) return;

    if (currentView === "sidepanel" && mode === "popup") {
      void syncExtensionOpenMode(mode)
        .then(() => closeCurrentWindow())
        .catch(() => onError?.());
      return;
    }

    void openExtensionMode(mode)
      .then(() => closeCurrentWindow(150))
      .catch(() => onError?.());
  }, [currentView, onError, setDefaultOpenMode]);

  const toggleView = useCallback(() => {
    switchToMode(isSidePanel ? "popup" : "sidepanel");
  }, [isSidePanel, switchToMode]);

  return { currentView, isSidePanel, switchTitle, switchToMode, toggleView };
}
