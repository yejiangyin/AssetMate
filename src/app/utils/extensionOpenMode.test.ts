import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getExtensionViewMode,
  normalizeOpenMode,
  openExtensionMode,
  sendExtensionOpenModeMessage,
  syncExtensionOpenMode,
} from "./extensionOpenMode";
import { withMockWindow } from "../testUtils";

describe("extensionOpenMode", () => {
  test("normalizes and reads view mode from the URL", async () => {
    assert.equal(normalizeOpenMode("sidepanel"), "sidepanel");
    assert.equal(normalizeOpenMode("other"), "popup");

    await withMockWindow({
      location: { search: "?view=sidepanel" } as Location,
    }, async () => {
      assert.equal(getExtensionViewMode(), "sidepanel");
    });
  });

  test("sends runtime messages successfully", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "ext",
        sendMessage: (message: unknown, callback: (response: { ok?: boolean } | undefined) => void) => {
          assert.deepEqual(message, { type: "asset-helper:set-open-mode", mode: "sidepanel" });
          callback({ ok: true });
        },
      },
    };

    try {
      assert.deepEqual(await syncExtensionOpenMode("sidepanel"), { ok: true });
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("surfaces runtime lastError from sendMessage", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    const runtime = {
      id: "ext",
      lastError: undefined as { message?: string } | undefined,
      sendMessage: (_message: unknown, callback: (response: { ok?: boolean } | undefined) => void) => {
        runtime.lastError = { message: "port closed" };
        callback(undefined);
      },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime };

    try {
      assert.deepEqual(await sendExtensionOpenModeMessage("x"), { ok: false, reason: "port closed" });
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("opens sidepanel directly and syncs the selected mode", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    const calls: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "ext",
        sendMessage: (message: unknown, callback: (response: { ok?: boolean } | undefined) => void) => {
          calls.push(`message:${JSON.stringify(message)}`);
          callback({ ok: true });
        },
      },
      windows: {
        getCurrent: async () => ({ id: 7 }),
      },
      sidePanel: {
        setOptions: async (options: { path: string; enabled: boolean }) => {
          calls.push(`setOptions:${options.path}:${options.enabled}`);
        },
        setPanelBehavior: async (options: { openPanelOnActionClick: boolean }) => {
          calls.push(`behavior:${options.openPanelOnActionClick}`);
        },
        open: async (options: { windowId: number }) => {
          calls.push(`open:${options.windowId}`);
        },
      },
      action: {
        setPopup: async (options: { popup: string }) => {
          calls.push(`popup:${options.popup}`);
        },
      },
    };

    try {
      assert.deepEqual(await openExtensionMode("sidepanel"), { ok: true });
      assert.deepEqual(calls, [
        "setOptions:index.html?view=sidepanel:true",
        "behavior:true",
        "popup:",
        "open:7",
        'message:{"type":"asset-helper:set-open-mode","mode":"sidepanel"}',
      ]);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("opens popup directly and syncs the selected mode", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    const calls: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "ext",
        sendMessage: (message: unknown, callback: (response: { ok?: boolean } | undefined) => void) => {
          calls.push(`message:${JSON.stringify(message)}`);
          callback({ ok: true });
        },
      },
      sidePanel: {
        setPanelBehavior: async (options: { openPanelOnActionClick: boolean }) => {
          calls.push(`behavior:${options.openPanelOnActionClick}`);
        },
      },
      action: {
        setPopup: async (options: { popup: string }) => {
          calls.push(`popup:${options.popup}`);
        },
        openPopup: async () => {
          calls.push("openPopup");
        },
      },
    };

    try {
      assert.deepEqual(await openExtensionMode("popup"), { ok: true });
      assert.deepEqual(calls, [
        "behavior:false",
        "popup:index.html",
        "openPopup",
        'message:{"type":"asset-helper:set-open-mode","mode":"popup"}',
      ]);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("reports popup open failures instead of pretending the switch succeeded", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    const calls: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "ext",
        sendMessage: (message: unknown, callback: (response: { ok?: boolean; reason?: string } | undefined) => void) => {
          calls.push(`message:${JSON.stringify(message)}`);
          callback({ ok: false, reason: "open_failed" });
        },
      },
      sidePanel: {
        setPanelBehavior: async (options: { openPanelOnActionClick: boolean }) => {
          calls.push(`behavior:${options.openPanelOnActionClick}`);
        },
      },
      action: {
        setPopup: async (options: { popup: string }) => {
          calls.push(`popup:${options.popup}`);
        },
        openPopup: async () => {
          calls.push("openPopup");
          throw new Error("gesture required");
        },
      },
    };

    try {
      assert.deepEqual(await openExtensionMode("popup"), { ok: false, reason: "open_failed" });
      assert.deepEqual(calls, [
        "behavior:false",
        "popup:index.html",
        "openPopup",
        'message:{"type":"asset-helper:open-mode","mode":"popup"}',
      ]);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("does not claim popup success when openPopup is unavailable", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "ext",
        sendMessage: (_message: unknown, callback: (response: { ok?: boolean; reason?: string } | undefined) => void) => {
          callback({ ok: false, reason: "open_popup_unavailable" });
        },
      },
      action: {
        setPopup: async () => undefined,
      },
    };

    try {
      assert.deepEqual(await openExtensionMode("popup"), { ok: false, reason: "open_popup_unavailable" });
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("falls back when runtime is unavailable", async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;
    try {
      assert.deepEqual(await sendExtensionOpenModeMessage("x"), { ok: false, reason: "runtime_unavailable" });
      assert.deepEqual(await openExtensionMode("sidepanel"), { ok: false, reason: "runtime_unavailable" });
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
    }
  });
});
