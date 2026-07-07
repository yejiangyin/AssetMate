type TimestampedPoint = {
  timestamp?: number;
  date?: string;
  time?: string;
};

export type PersistentCacheEntry<T> = {
  key: string;
  savedAt: number;
  lastFullRefreshAt: number;
  data: T;
};

type CacheBucket<T> = {
  version: number;
  entries: PersistentCacheEntry<T>[];
};

const VERSION = 1;

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readBucket<T>(storageKey: string): CacheBucket<T> {
  if (!canUseStorage()) return { version: VERSION, entries: [] };
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { version: VERSION, entries: [] };
    const parsed = JSON.parse(raw) as CacheBucket<T>;
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.entries)) {
      return { version: VERSION, entries: [] };
    }
    return parsed;
  } catch {
    return { version: VERSION, entries: [] };
  }
}

function writeBucket<T>(storageKey: string, bucket: CacheBucket<T>, maxEntries: number) {
  if (!canUseStorage()) return;
  try {
    const entries = [...bucket.entries]
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, maxEntries);
    window.localStorage.setItem(storageKey, JSON.stringify({ version: VERSION, entries }));
  } catch {
    // Storage quota can be tight in extension contexts; cache failure must not break quotes.
  }
}

export function readPersistentEntry<T>(storageKey: string, key: string): PersistentCacheEntry<T> | null {
  const bucket = readBucket<T>(storageKey);
  return bucket.entries.find((entry) => entry.key === key) ?? null;
}

export function writePersistentEntry<T>(
  storageKey: string,
  key: string,
  data: T,
  options: { maxEntries: number; fullRefresh?: boolean; previousFullRefreshAt?: number },
) {
  const now = Date.now();
  const bucket = readBucket<T>(storageKey);
  const lastFullRefreshAt = options.fullRefresh
    ? now
    : (options.previousFullRefreshAt ?? bucket.entries.find((entry) => entry.key === key)?.lastFullRefreshAt ?? 0);
  const nextEntry: PersistentCacheEntry<T> = { key, savedAt: now, lastFullRefreshAt, data };
  const entries = [nextEntry, ...bucket.entries.filter((entry) => entry.key !== key)];
  writeBucket(storageKey, { version: VERSION, entries }, options.maxEntries);
  return nextEntry;
}

export function shouldUseFreshCache(entry: PersistentCacheEntry<unknown> | null, ttlMs: number) {
  return Boolean(entry && Date.now() - entry.savedAt < ttlMs);
}

export function shouldFullRefresh(entry: PersistentCacheEntry<unknown> | null, fullRefreshMs: number) {
  return !entry || !entry.lastFullRefreshAt || Date.now() - entry.lastFullRefreshAt >= fullRefreshMs;
}

function pointKey(point: TimestampedPoint) {
  if (typeof point.timestamp === "number" && Number.isFinite(point.timestamp)) return `ts:${point.timestamp}`;
  if (typeof point.date === "string" && point.date) return `date:${point.date}`;
  if (typeof point.time === "string" && point.time) return `time:${point.time}`;
  return "";
}

function pointOrder(point: TimestampedPoint) {
  if (typeof point.timestamp === "number" && Number.isFinite(point.timestamp)) return point.timestamp;
  if (typeof point.date === "string") {
    const ms = Date.parse(`${point.date}T00:00:00`);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function mergeDefined<T extends TimestampedPoint>(base: T, incoming: T): T {
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged as T;
}

export function mergePointSeries<T extends TimestampedPoint>(base: T[], incoming: T[], maxPoints = 6000): T[] {
  const map = new Map<string, T>();
  for (const point of base) {
    const key = pointKey(point);
    if (key) map.set(key, point);
  }
  for (const point of incoming) {
    const key = pointKey(point);
    if (key) {
      const existing = map.get(key);
      map.set(key, existing ? mergeDefined(existing, point) : point);
    }
  }
  return [...map.values()]
    .sort((a, b) => pointOrder(a) - pointOrder(b))
    .slice(-maxPoints);
}

export function newestPointTime(points: TimestampedPoint[]) {
  return points.reduce((latest, point) => Math.max(latest, pointOrder(point)), 0);
}
