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

function installLocalStorageMock() {
  const store = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  };
  return store;
}

test("mergePointSeries replaces overlapping points and keeps chronological order", () => {
  const merged = mergePointSeries(
    [
      { timestamp: 1000, price: 1 },
      { timestamp: 2000, price: 2 },
    ],
    [
      { timestamp: 2000, price: 3 },
      { timestamp: 3000, price: 4 },
    ],
  );

  assert.deepEqual(merged.map((point) => point.price), [1, 3, 4]);
  assert.equal(newestPointTime(merged), 3000);
});

test("persistent entries honor ttl and full-refresh timestamps", () => {
  installLocalStorageMock();
  const storageKey = "test-cache";

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

test("persistent cache prunes oldest entries", () => {
  installLocalStorageMock();
  const storageKey = "test-cache-prune";

  writePersistentEntry(storageKey, "a", { value: 1 }, { maxEntries: 2, fullRefresh: true });
  writePersistentEntry(storageKey, "b", { value: 2 }, { maxEntries: 2, fullRefresh: true });
  writePersistentEntry(storageKey, "c", { value: 3 }, { maxEntries: 2, fullRefresh: true });

  assert.equal(readPersistentEntry(storageKey, "a"), null);
  assert.equal(readPersistentEntry<{ value: number }>(storageKey, "b")?.data.value, 2);
  assert.equal(readPersistentEntry<{ value: number }>(storageKey, "c")?.data.value, 3);
});
