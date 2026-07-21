import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DASHBOARD_RANKING_PREVIEW_LIMIT,
  RETURNS_RANKING_PREVIEW_LIMIT,
  getVisibleRanking,
} from "./rankingVisibility";

describe("ranking visibility", () => {
  const ranking = Array.from({ length: 35 }, (_, index) => index + 1);

  test("shows the dashboard preview by default", () => {
    assert.deepEqual(
      getVisibleRanking(ranking, false, DASHBOARD_RANKING_PREVIEW_LIMIT),
      ranking.slice(0, DASHBOARD_RANKING_PREVIEW_LIMIT),
    );
  });

  test("shows the returns preview by default", () => {
    assert.deepEqual(
      getVisibleRanking(ranking, false, RETURNS_RANKING_PREVIEW_LIMIT),
      ranking.slice(0, RETURNS_RANKING_PREVIEW_LIMIT),
    );
  });

  test("shows every ranked holding after expansion", () => {
    assert.deepEqual(getVisibleRanking(ranking, true, RETURNS_RANKING_PREVIEW_LIMIT), ranking);
  });

  test("does not pad rankings shorter than the preview limit", () => {
    assert.deepEqual(getVisibleRanking(ranking.slice(0, 5), false, RETURNS_RANKING_PREVIEW_LIMIT), ranking.slice(0, 5));
  });
});
