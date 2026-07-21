import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PortfolioEvent } from "../services/portfolioEvents";
import {
  CORPORATE_ACTION_NOTICE_RETENTION_DAYS,
  getRecentCorporateActionNotices,
  mergeDismissedCorporateActionNoticeKeys,
} from "./corporateActionNotices";

function event(patch: Partial<PortfolioEvent>): PortfolioEvent {
  return {
    id: "event-1",
    date: "2026-07-13",
    name: "示例持仓",
    type: "cash_dividend",
    amount: 10,
    amountInBase: 10,
    currency: "CNY",
    source: "auto",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...patch,
  };
}

describe("corporate action notices", () => {
  test("keeps recent automatically posted holding actions", () => {
    const notices = getRecentCorporateActionNotices([
      event({ id: "dividend", type: "cash_dividend" }),
      event({ id: "split", type: "split", date: "2026-07-07" }),
      event({ id: "old", date: "2026-07-06" }),
      event({ id: "future", date: "2026-07-14" }),
      event({ id: "manual", source: "manual" }),
      event({ id: "fee", type: "fee" }),
    ], new Date(2026, 6, 13));

    assert.deepEqual(notices.map((item) => item.id), ["dividend", "split"]);
  });

  test("expires notices after seven calendar days when the user does not dismiss them", () => {
    assert.equal(CORPORATE_ACTION_NOTICE_RETENTION_DAYS, 7);
    const notices = getRecentCorporateActionNotices([
      event({ id: "day-1", date: "2026-07-17" }),
      event({ id: "day-7", date: "2026-07-11" }),
      event({ id: "expired", date: "2026-07-10" }),
    ], new Date(2026, 6, 17));

    assert.deepEqual(notices.map((item) => item.id), ["day-1", "day-7"]);
  });

  test("covers every supported automatic holding action without surfacing fees or taxes", () => {
    const supportedTypes: PortfolioEvent["type"][] = [
      "cash_dividend",
      "dividend_reinvest",
      "share_dividend",
      "split",
      "interest",
      "bond_coupon",
    ];
    const notices = getRecentCorporateActionNotices([
      ...supportedTypes.map((type, index) => event({ id: type, type, createdAt: `2026-07-13T0${index}:00:00.000Z` })),
      event({ id: "fee", type: "fee" }),
      event({ id: "tax", type: "tax" }),
    ], new Date(2026, 6, 13));

    assert.deepEqual(new Set(notices.map((item) => item.type)), new Set(supportedTypes));
  });

  test("deduplicates multiple records for the same corporate action", () => {
    const notices = getRecentCorporateActionNotices([
      event({ id: "newer", corporateActionId: "action-1", createdAt: "2026-07-13T01:00:00.000Z" }),
      event({ id: "older", corporateActionId: "action-1" }),
    ], new Date(2026, 6, 13));

    assert.deepEqual(notices.map((item) => item.id), ["newer"]);
  });

  test("keeps dismissed events hidden while allowing new events to appear", () => {
    const dismissedEvent = event({ id: "old-event", corporateActionId: "action-1" });
    const newEvent = event({ id: "new-event", corporateActionId: "action-2" });
    const dismissedKeys = mergeDismissedCorporateActionNoticeKeys([], [dismissedEvent]);
    const notices = getRecentCorporateActionNotices(
      [dismissedEvent, newEvent],
      new Date(2026, 6, 13),
      30,
      new Set(dismissedKeys),
    );

    assert.deepEqual(dismissedKeys, ["action-1"]);
    assert.deepEqual(notices.map((item) => item.id), ["new-event"]);
  });

  test("bounds stored acknowledgement history", () => {
    const existing = Array.from({ length: 200 }, (_, index) => `old-${index}`);
    const next = mergeDismissedCorporateActionNoticeKeys(existing, [event({ id: "new-event" })]);

    assert.equal(next.length, 200);
    assert.equal(next.includes("old-0"), false);
    assert.equal(next.at(-1), "new-event");
  });
});
