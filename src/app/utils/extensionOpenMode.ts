export type ExtensionOpenMode = "popup" | "sidepanel";

export const DEFAULT_OPEN_MODE: ExtensionOpenMode = "popup";

type ChromeRuntimeLike = {
  id?: string;
  lastError?: { message?: string };
  sendMessage?: (
    message: unknown,
    callback: (response: { ok?: boolean; reason?: string } | undefined) => void,
  ) => void;
};

type ChromeApiLike = {
  runtime?: ChromeRuntimeLike;
  windows?: {
    getCurrent?: () => Promise<{ id?: number } | undefined>;
  };
  sidePanel?: {
    open?: (options: { windowId: number }) => Promise<void>;
    setOptions?: (options: { path: string; enabled: boolean }) => Promise<void>;
    setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
  };
  action?: {
    setPopup?: (options: { popup: string }) => Promise<void>;
    openPopup?: () => Promise<void>;
  };
};

export function normalizeOpenMode(value: unknown): ExtensionOpenMode {
  return value === "sidepanel" ? "sidepanel" : "popup";
}

export function getExtensionViewMode(): ExtensionOpenMode {
  if (typeof window === "undefined") return DEFAULT_OPEN_MODE;
  const params = new URLSearchParams(window.location.search);
  return normalizeOpenMode(params.get("view"));
}

function getChromeRuntime() {
  const chromeApi = getChromeApi();
  return chromeApi?.runtime?.id ? chromeApi.runtime : null;
}

function getChromeApi() {
  return (globalThis as { chrome?: ChromeApiLike }).chrome ?? null;
}

export function sendExtensionOpenModeMessage(type: string, payload: Record<string, unknown> = {}) {
  const runtime = getChromeRuntime();
  const sendMessage = runtime?.sendMessage;
  if (!sendMessage) return Promise.resolve({ ok: false, reason: "runtime_unavailable" });
  return new Promise<{ ok?: boolean; reason?: string }>((resolve) => {
    try {
      sendMessage({ type, ...payload }, (response: { ok?: boolean; reason?: string } | undefined) => {
        const lastError = getChromeApi()?.runtime?.lastError;
        if (lastError) {
          resolve({ ok: false, reason: lastError.message });
          return;
        }
        resolve(response ?? { ok: true });
      });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : "send_failed" });
    }
  });
}

export function syncExtensionOpenMode(mode: ExtensionOpenMode) {
  return sendExtensionOpenModeMessage("asset-helper:set-open-mode", { mode });
}

async function getCurrentWindowId() {
  const chromeApi = getChromeApi();
  if (!chromeApi?.windows?.getCurrent) return undefined;
  try {
    const currentWindow = await chromeApi.windows.getCurrent();
    return typeof currentWindow?.id === "number" ? currentWindow.id : undefined;
  } catch {
    return undefined;
  }
}

async function openSidePanelFromCurrentGesture() {
  const chromeApi = getChromeApi();
  if (!chromeApi?.sidePanel?.open) return { ok: false, reason: "sidepanel_unavailable" };
  try {
    if (chromeApi.sidePanel.setOptions) {
      await chromeApi.sidePanel.setOptions({ path: "index.html?view=sidepanel", enabled: true });
    }
    if (chromeApi.sidePanel.setPanelBehavior) {
      await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    if (chromeApi.action?.setPopup) {
      await chromeApi.action.setPopup({ popup: "" });
    }
    const windowId = await getCurrentWindowId();
    if (typeof windowId !== "number") return { ok: false, reason: "window_unavailable" };
    await chromeApi.sidePanel.open({ windowId });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "open_sidepanel_failed" };
  }
}

async function openPopupFromCurrentGesture() {
  const chromeApi = getChromeApi();
  try {
    // Stop the side panel from reopening on action click; the popup takes over.
    if (chromeApi?.sidePanel?.setPanelBehavior) {
      await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
    // Restore the popup path so clicking the toolbar icon opens the popup.
    if (chromeApi?.action?.setPopup) {
      await chromeApi.action.setPopup({ popup: "index.html" });
    }
    if (chromeApi?.action?.openPopup) {
      try {
        await chromeApi.action.openPopup();
      } catch { /* openPopup may fail */ }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "open_popup_failed" };
  }
}

export async function openExtensionMode(mode: ExtensionOpenMode) {
  const directResult = mode === "sidepanel"
    ? await openSidePanelFromCurrentGesture()
    : await openPopupFromCurrentGesture();
  if (directResult.ok) {
    await syncExtensionOpenMode(mode);
    return directResult;
  }
  return sendExtensionOpenModeMessage("asset-helper:open-mode", { mode });
}
