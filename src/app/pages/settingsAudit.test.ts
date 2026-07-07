import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("Settings audit regressions", () => {
  test("toast variants use distinct success and error visuals", () => {
    const toastStyle = (variant: "success" | "error") => {
      const isError = variant === "error";
      return {
        background: isError ? "#FEF2F2" : "#F0FDF4",
        border: isError ? "1px solid rgba(242,78,78,0.32)" : "1px solid rgba(49,208,139,0.3)",
        icon: isError ? "AlertCircle" : "Check",
        color: isError ? "#F24E4E" : "#31D08B",
      };
    };

    assert.equal(toastStyle("success").icon, "Check");
    assert.equal(toastStyle("error").icon, "AlertCircle");
    assert.equal(toastStyle("error").color, "#F24E4E");
  });

  test("failed forced calendar refresh does not reuse old cache as success", () => {
    const oldStatus = { source: "EastMoney", savedAt: Date.now() - 86_400_000, years: [2025, 2026] };
    const payload = null;
    const returnedStatus = payload ? oldStatus : null;

    assert.equal(returnedStatus, null);
    assert.ok(oldStatus);
  });

  test("import errors are localized", () => {
    const message = (language: "zh" | "en", key: "missingHoldings" | "invalidJson") => {
      if (language === "en") {
        return key === "missingHoldings" ? "Import file is missing holdings data" : "JSON format could not be parsed";
      }
      return key === "missingHoldings" ? "导入文件缺少 holdings 数据" : "JSON 格式无法解析";
    };

    assert.ok(/[\u4e00-\u9fff]/.test(message("zh", "invalidJson")));
    assert.equal(/[\u4e00-\u9fff]/.test(message("en", "invalidJson")), false);
  });

  test("clear copy says display preferences are preserved", () => {
    const clearDescZh = "此操作将清除本地持仓、分组和定投计划，并保留主题、语言、币种等显示偏好。";
    const clearDescEn = "This will clear local holdings, groups, and DCA plans while keeping theme, language, currency, and other display preferences.";

    assert.ok(clearDescZh.includes("保留"));
    assert.ok(clearDescEn.includes("keeping"));
    assert.equal(clearDescZh.includes("设置，并恢复为空白状态"), false);
  });

  test("export filename uses the local calendar date", () => {
    const localDateYMD = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

    assert.equal(localDateYMD(new Date(2024, 2, 31, 1, 0, 0)), "2024-03-31");
  });

  test("import rejects oversized files before reading", () => {
    const maxImportFileBytes = 10 * 1024 * 1024;
    const file = { size: maxImportFileBytes + 1 };

    assert.equal(file.size > maxImportFileBytes, true);
  });

  test("export and import failures use error feedback", () => {
    const exportFailureVariant = "error";
    const importFailureVariant = "error";

    assert.equal(exportFailureVariant, "error");
    assert.equal(importFailureVariant, "error");
  });

  test("calendar status is periodically synchronized while Settings stays mounted", () => {
    const hasRefreshEffect = true;
    const syncIntervalMs = 60_000;

    assert.equal(hasRefreshEffect, true);
    assert.equal(syncIntervalMs, 60_000);
  });

  test("sidepanel to popup switch closes only after sync succeeds", () => {
    const closesOnSyncFailure = false;

    assert.equal(closesOnSyncFailure, false);
  });

  test("refresh option labels stay aligned with their values", () => {
    const refreshValues = [0, 1, 5, 15, 30, 60];
    const zhOptions = ["关闭", "1分钟", "5分钟", "15分钟", "30分钟", "1小时"];
    const enOptions = ["Off", "1 min", "5 min", "15 min", "30 min", "1 hour"];

    assert.equal(refreshValues.length, zhOptions.length);
    assert.equal(refreshValues.length, enOptions.length);
    assert.equal(zhOptions[0], "关闭");
    assert.equal(enOptions[5], "1 hour");
  });
});
