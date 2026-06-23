import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatYahooTimestamp } from "./quoteApi";

describe("formatYahooTimestamp", () => {
  test("renders Japan quotes in Beijing time (UTC+8)", () => {
    // Tokyo 15:30 (UTC+9) = Beijing 14:30 (UTC+8)
    const timestampSeconds = new Date("2026-06-22T15:30:00+09:00").getTime() / 1000;
    assert.equal(formatYahooTimestamp(timestampSeconds, "fs", "7203.T"), "14:30");
    assert.equal(formatYahooTimestamp(timestampSeconds, "fs", "^N225"), "14:30");
  });
});
