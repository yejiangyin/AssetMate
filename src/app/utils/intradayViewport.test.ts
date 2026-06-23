import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIntradayViewportPoints } from "./intradayViewport";

describe("buildIntradayViewportPoints", () => {
  test("uses zero-padded trading-day keys when selecting latest US session", () => {
    const result = buildIntradayViewportPoints([
      { time: "21:30", price: 90, timestamp: new Date("2026-09-30T13:30:00Z").getTime() },
      { time: "21:31", price: 91, timestamp: new Date("2026-09-30T13:31:00Z").getTime() },
      { time: "21:30", price: 100, timestamp: new Date("2026-10-01T13:30:00Z").getTime() },
      { time: "21:31", price: 101, timestamp: new Date("2026-10-01T13:31:00Z").getTime() },
    ], "US", "AAPL", "regular");

    const realPrices = result.points
      .map((point) => point.displayPrice)
      .filter((price) => typeof price === "number");

    assert.deepEqual(realPrices, [100, 101]);
  });

  test("keeps only the latest Japan trading day and uses the 14:30 Beijing close", () => {
    // Tokyo 09:00 (UTC+9) = Beijing 08:00 (UTC+8); Tokyo 15:30 = Beijing 14:30
    const previousDay = new Date("2026-06-16T09:00:00+09:00").getTime();
    const latestMorning = new Date("2026-06-22T09:00:00+09:00").getTime();
    const latestClose = new Date("2026-06-22T15:30:00+09:00").getTime();
    const result = buildIntradayViewportPoints([
      { time: "08:00", timestamp: previousDay, dateLabel: "6/16", price: 1763 },
      { time: "08:00", timestamp: latestMorning, dateLabel: "6/22", price: 1600 },
      { time: "14:30", timestamp: latestClose, dateLabel: "6/22", price: 1590 },
    ], "JP", "7501.T");

    const realPoints = result.points.filter((point) => Number.isFinite(point.displayPrice));
    assert.deepEqual(realPoints.map((point) => point.price), [1600, 1590]);
    assert.deepEqual(result.ticks, ["08:00", "09:00", "10:30", "11:30", "13:00", "14:30"]);
  });
});
