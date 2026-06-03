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
});
