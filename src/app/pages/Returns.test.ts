import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startOfLocalWeek } from "./Returns";

describe("returns weekly scope", () => {
  test("uses Monday as the start of the current week", () => {
    assert.equal(startOfLocalWeek("2026-07-13"), "2026-07-13");
    assert.equal(startOfLocalWeek("2026-07-19"), "2026-07-13");
  });

  test("handles week boundaries across years", () => {
    assert.equal(startOfLocalWeek("2027-01-01"), "2026-12-28");
  });
});
