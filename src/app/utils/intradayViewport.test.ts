import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIntradayViewportPoints, filterLatestIntradayDay } from "./intradayViewport";

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

  test("FX intraday keeps only the latest trading day (not the whole 5d Yahoo pull)", () => {
    // Yahoo's fs range pulls 5d of 1m ticks for FX. The viewport must filter
    // to the latest day so the intraday chart shows one session, not a week.
    // Times below are in Beijing (UTC+8) so filterLatestMarketDate groups by day.
    const mondayMorning = new Date("2026-06-22T09:00:00+08:00").getTime();
    const mondayAfternoon = new Date("2026-06-22T16:00:00+08:00").getTime();
    const fridayMorning = new Date("2026-06-26T09:00:00+08:00").getTime();
    const fridayAfternoon = new Date("2026-06-26T16:00:00+08:00").getTime();
    const result = buildIntradayViewportPoints([
      { time: "09:00", timestamp: mondayMorning, price: 6.78, dateLabel: "6/22" },
      { time: "16:00", timestamp: mondayAfternoon, price: 6.79, dateLabel: "6/22" },
      { time: "09:00", timestamp: fridayMorning, price: 6.81, dateLabel: "6/26" },
      { time: "16:00", timestamp: fridayAfternoon, price: 6.82, dateLabel: "6/26" },
    ], "FX", "JPYCNY=X");

    const realPoints = result.points.filter((point) => Number.isFinite(point.displayPrice));
    assert.deepEqual(realPoints.map((point) => point.price), [6.81, 6.82]);
  });

  test("filterLatestIntradayDay keeps only the latest US overnight session", () => {
    // US regular session 21:30-04:00 Beijing crosses midnight. Points after
    // midnight (before noon) belong to the previous calendar day's session.
    const monNight = new Date("2026-06-22T22:00:00+08:00").getTime();
    const tueEarly = new Date("2026-06-23T02:00:00+08:00").getTime();
    const tueNight = new Date("2026-06-23T22:00:00+08:00").getTime();
    const wedEarly = new Date("2026-06-24T02:00:00+08:00").getTime();
    const filtered = filterLatestIntradayDay([
      { time: "22:00", timestamp: monNight, price: 100 },
      { time: "02:00", timestamp: tueEarly, price: 101 },
      { time: "22:00", timestamp: tueNight, price: 102 },
      { time: "02:00", timestamp: wedEarly, price: 103 },
    ], "US", "AAPL");

    assert.deepEqual(filtered.map((point) => point.price), [102, 103]);
  });
});
