const OPEN_MODE_KEY = "asset-helper:open-mode";
const DEFAULT_MODE = "popup";
const SIDE_PANEL_PATH = "index.html?view=sidepanel";
const POPUP_PATH = "index.html";
const SNAPSHOT_ALARM = "asset-helper:daily-snapshot-reminder";
const SNAPSHOT_DUE_KEY = "asset-helper:snapshot-due-dates:v1";

function localYMD(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function ensureSnapshotAlarm() {
  const existing = await chrome.alarms.get(SNAPSHOT_ALARM);
  if (existing) return;
  const next = new Date();
  next.setHours(18, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create(SNAPSHOT_ALARM, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

async function markSnapshotDue(date = localYMD()) {
  const data = await chrome.storage.local.get(SNAPSHOT_DUE_KEY);
  const current = Array.isArray(data[SNAPSHOT_DUE_KEY]) ? data[SNAPSHOT_DUE_KEY] : [];
  const dates = [...new Set([...current, date])].sort().slice(-31);
  await chrome.storage.local.set({ [SNAPSHOT_DUE_KEY]: dates });
}

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
  const normalized = normalizeMode(mode);
  await applyOpenMode(normalized);
  if (normalized === "sidepanel") {
    if (!chrome.sidePanel?.open) throw new Error("sidepanel_unavailable");
    const senderWindowId = sender?.tab?.windowId;
    let windowId = typeof senderWindowId === "number" ? senderWindowId : undefined;
    if (typeof windowId !== "number" && chrome.windows?.getCurrent) {
      const currentWindow = await chrome.windows.getCurrent();
      windowId = typeof currentWindow?.id === "number" ? currentWindow.id : undefined;
    }
    if (typeof windowId !== "number") throw new Error("window_unavailable");
    await chrome.sidePanel.open({ windowId });
    await chrome.storage.local.set({ [OPEN_MODE_KEY]: normalized });
    return;
  }

  if (!chrome.action?.openPopup) throw new Error("open_popup_unavailable");
  await chrome.action.openPopup();
  await chrome.storage.local.set({ [OPEN_MODE_KEY]: normalized });
}

chrome.runtime.onInstalled.addListener(() => {
  void getOpenMode().then(applyOpenMode).catch(() => applyOpenMode(DEFAULT_MODE));
  void ensureSnapshotAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void getOpenMode().then(applyOpenMode).catch(() => applyOpenMode(DEFAULT_MODE));
  void ensureSnapshotAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SNAPSHOT_ALARM) void markSnapshotDue();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "asset-helper:set-open-mode") {
    void setOpenMode(message.mode)
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "set_failed" }));
    return true;
  }

  if (message.type === "asset-helper:get-open-mode") {
    void getOpenMode()
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "get_failed" }));
    return true;
  }

  if (message.type === "asset-helper:open-mode") {
    void openMode(message.mode, sender)
      .then(() => sendResponse({ ok: true, mode: normalizeMode(message.mode) }))
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "open_failed" }));
    return true;
  }

  if (message.type === "asset-helper:get-snapshot-due" || message.type === "asset-helper:consume-snapshot-due") {
    void chrome.storage.local.get(SNAPSHOT_DUE_KEY)
      .then((data) => {
        const dates = Array.isArray(data[SNAPSHOT_DUE_KEY]) ? data[SNAPSHOT_DUE_KEY] : [];
        sendResponse({ ok: true, dates });
      })
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "get_due_failed" }));
    return true;
  }

  if (message.type === "asset-helper:ack-snapshot-due") {
    void chrome.storage.local.get(SNAPSHOT_DUE_KEY)
      .then((data) => {
        const current = Array.isArray(data[SNAPSHOT_DUE_KEY]) ? data[SNAPSHOT_DUE_KEY] : [];
        const acknowledged = new Set(Array.isArray(message.dates) ? message.dates : []);
        const remaining = current.filter((date) => !acknowledged.has(date));
        const operation = remaining.length
          ? chrome.storage.local.set({ [SNAPSHOT_DUE_KEY]: remaining })
          : chrome.storage.local.remove(SNAPSHOT_DUE_KEY);
        return operation.then(() => sendResponse({ ok: true, dates: remaining }));
      })
      .catch((error) => sendResponse({ ok: false, reason: error?.message ?? "ack_due_failed" }));
    return true;
  }

  return false;
});

// ChatGPT (Codex) sign-in redirects to the Codex CLI's loopback callback, which nothing
// listens on inside a browser. Capture that navigation, hand the URL to an open settings
// view, or reopen the settings page so the login can finish after the popup closed.
const CODEX_PENDING_KEY = "asset-helper:codex-oauth-pending:v1";
const CODEX_CALLBACK_KEY = "asset-helper:codex-oauth-callback:v1";
const CODEX_CALLBACK_MESSAGE = "asset-helper:codex-oauth-callback";

function isCodexCallbackUrl(value) {
  try {
    const url = new URL(value);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "1455" && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

async function captureCodexCallback(tabId, url) {
  if (!chrome.storage.session) return;
  const data = await chrome.storage.session.get(CODEX_PENDING_KEY);
  const pending = data[CODEX_PENDING_KEY];
  if (!pending || new URL(url).searchParams.get("state") !== pending.state) return;
  await chrome.storage.session.set({ [CODEX_CALLBACK_KEY]: { url, receivedAt: Date.now() } });
  await chrome.tabs.remove(tabId).catch(() => undefined);
  const response = await chrome.runtime.sendMessage({ type: CODEX_CALLBACK_MESSAGE }).catch(() => null);
  if (!response?.handled) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("index.html#/settings/ai?codex=callback") });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && isCodexCallbackUrl(changeInfo.url)) void captureCodexCallback(tabId, changeInfo.url);
});
