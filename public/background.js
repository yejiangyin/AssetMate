const OPEN_MODE_KEY = "asset-helper:open-mode";
const DEFAULT_MODE = "popup";
const SIDE_PANEL_PATH = "index.html?view=sidepanel";
const POPUP_PATH = "index.html";

function normalizeMode(mode) {
  return mode === "sidepanel" ? "sidepanel" : "popup";
}

async function getOpenMode() {
  const data = await chrome.storage.local.get(OPEN_MODE_KEY);
  return normalizeMode(data[OPEN_MODE_KEY]);
}

async function setOpenMode(mode) {
  const normalized = normalizeMode(mode);
  await chrome.storage.local.set({ [OPEN_MODE_KEY]: normalized });
  await applyOpenMode(normalized);
  return normalized;
}

async function applyOpenMode(mode) {
  const normalized = normalizeMode(mode);
  if (chrome.sidePanel?.setOptions) {
    await chrome.sidePanel.setOptions({
      path: SIDE_PANEL_PATH,
      enabled: true,
    });
  }

  if (normalized === "sidepanel") {
    await chrome.action.setPopup({ popup: "" });
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    return;
  }

  // Popup mode: keep side panel enabled (so the user can switch back) but
  // stop it from auto-opening on action click. The popup takes over.
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  }
  await chrome.action.setPopup({ popup: POPUP_PATH });
}

async function openMode(mode, sender) {
  const normalized = await setOpenMode(mode);
  if (normalized === "sidepanel") {
    if (chrome.sidePanel?.open) {
      const senderWindowId = sender?.tab?.windowId;
      let windowId = typeof senderWindowId === "number" ? senderWindowId : undefined;
      if (typeof windowId !== "number" && chrome.windows?.getCurrent) {
        const currentWindow = await chrome.windows.getCurrent();
        windowId = typeof currentWindow?.id === "number" ? currentWindow.id : undefined;
      }
      if (typeof windowId === "number") {
        await chrome.sidePanel.open({ windowId });
      }
    }
    return;
  }

  // Switching to popup: set the popup path and try to open it. The
  // currently-open side panel will be closed by the caller (window.close()
  // from the side panel page) or by Chrome when the popup opens.
  if (chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    } catch { /* ignore */ }
  }
  try {
    await chrome.action.setPopup({ popup: POPUP_PATH });
  } catch { /* ignore */ }

  if (chrome.action.openPopup) {
    try {
      await chrome.action.openPopup();
    } catch { /* openPopup may fail without a user gesture */ }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getOpenMode().then(applyOpenMode).catch(() => applyOpenMode(DEFAULT_MODE));
});

chrome.runtime.onStartup.addListener(() => {
  void getOpenMode().then(applyOpenMode).catch(() => applyOpenMode(DEFAULT_MODE));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "asset-helper:set-open-mode") {
    void setOpenMode(message.mode)
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "set_failed" }));
    return true;
  }

  if (message.type === "asset-helper:open-mode") {
    void openMode(message.mode, sender)
      .then(() => sendResponse({ ok: true, mode: normalizeMode(message.mode) }))
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "open_failed" }));
    return true;
  }

  return false;
});
