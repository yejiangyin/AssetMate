import test from "node:test";
import assert from "node:assert/strict";

import {
  mergePointSeries,
  newestPointTime,
  readPersistentEntry,
  shouldFullRefresh,
  shouldUseFreshCache,
  writePersistentEntry,
} from "./persistentDataCache";
import { createLocalStorageMock, withMockWindow } from "../testUtils";

test("mergePointSeries merges overlapping points and keeps chronological order", () => {
  type TestPoint = { timestamp: number; price: number; open?: number; high?: number; low?: number };
  const merged = mergePointSeries<TestPoint>(
    [
      { timestamp: 1000, price: 1, open: 1 },
      { timestamp: 2000, price: 2, open: 1.5, high: 2.5, low: 1.2 },
    ],
    [
      { timestamp: 2000, price: 3 },
      { timestamp: 3000, price: 4 },
    ],
  );

  assert.deepEqual(merged.map((point) => point.price), [1, 3, 4]);
  assert.equal(merged[1]?.open, 1.5);
  assert.equal(merged[1]?.high, 2.5);
  assert.equal(merged[1]?.low, 1.2);
  assert.equal(newestPointTime(merged), 3000);
});

test("persistent entries honor ttl and full-refresh timestamps", async () => {
  const { localStorage } = createLocalStorageMock();
  const storageKey = "test-cache";

  await withMockWindow({ localStorage: localStorage as Storage }, () => {
    const first = writePersistentEntry(storageKey, "a", { value: 1 }, {
      maxEntries: 2,
      fullRefresh: true,
    });
    const readBack = readPersistentEntry<{ value: number }>(storageKey, "a");

    assert.equal(readBack?.data.value, 1);
    assert.equal(shouldUseFreshCache(readBack, 60_000), true);
    assert.equal(shouldFullRefresh(readBack, 60_000), false);
    assert.ok(first.lastFullRefreshAt > 0);
  });
});

test("persistent cache prunes oldest entries", async () => {
  const { localStorage } = createLocalStorageMock();
  const storageKey = "test-cache-prune";

  await withMockWindow({ localStorage: localStorage as Storage }, () => {
    writePersistentEntry(storageKey, "a", { value: 1 }, { maxEntries: 2, fullRefresh: true });
    writePersistentEntry(storageKey, "b", { value: 2 }, { maxEntries: 2, fullRefresh: true });
    writePersistentEntry(storageKey, "c", { value: 3 }, { maxEntries: 2, fullRefresh: true });

    assert.equal(readPersistentEntry(storageKey, "a"), null);
    assert.equal(readPersistentEntry<{ value: number }>(storageKey, "b")?.data.value, 2);
    assert.equal(readPersistentEntry<{ value: number }>(storageKey, "c")?.data.value, 3);
  });
});

test("persistent cache falls back safely for corrupt JSON and storage write failures", async () => {
  const corrupt = createLocalStorageMock({ corrupt: "{not json" });
  await withMockWindow({ localStorage: corrupt.localStorage as Storage }, () => {
    assert.equal(readPersistentEntry("corrupt", "a"), null);
  });

  const throwingStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: () => undefined,
    clear: () => undefined,
  };
  await withMockWindow({ localStorage: throwingStorage as unknown as Storage }, () => {
    const entry = writePersistentEntry("throws", "a", { value: 1 }, { maxEntries: 2, fullRefresh: true });
    assert.equal(entry.data.value, 1);
    assert.equal(readPersistentEntry("throws", "a"), null);
  });
});

test("non-full refresh preserves previous full refresh timestamp", async () => {
  const { localStorage } = createLocalStorageMock();
  await withMockWindow({ localStorage: localStorage as Storage }, () => {
    const first = writePersistentEntry("refresh", "a", { value: 1 }, { maxEntries: 2, fullRefresh: true });
    const second = writePersistentEntry("refresh", "a", { value: 2 }, {
      maxEntries: 2,
      fullRefresh: false,
      previousFullRefreshAt: first.lastFullRefreshAt,
    });

    assert.equal(second.lastFullRefreshAt, first.lastFullRefreshAt);
    assert.equal(readPersistentEntry<{ value: number }>("refresh", "a")?.data.value, 2);
  });
});
