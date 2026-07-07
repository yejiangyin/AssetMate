import type { DCAExecution, DCAPlan } from "./context/AppContext";
import type { Holding } from "./data/mockData";

export function createLocalStorageMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
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
}

export async function withMockWindow<T>(
  windowPatch: Partial<Window> & { localStorage?: Storage },
  run: () => T | Promise<T>,
): Promise<T> {
  const previousWindow = globalThis.window;
  (globalThis as any).window = windowPatch;
  try {
    return await run();
  } finally {
    globalThis.window = previousWindow;
  }
}

export async function withMockFetch<T>(
  fetchMock: typeof fetch,
  run: () => T | Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export function createHolding(patch: Partial<Holding> = {}): Holding {
  return {
    id: "h1",
    groupId: "",
    symbol: "AAPL",
    name: "Apple Inc.",
    market: "US",
    assetType: "stock",
    quantity: 10,
    costPrice: 100,
    currentPrice: 120,
    currency: "USD",
    marketValue: 1200,
    todayPnl: 5,
    todayPnlRate: 0.01,
    totalPnl: 200,
    totalPnlRate: 0.2,
    tradeStatus: "normal",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

export function createDCAPlan(patch: Partial<DCAPlan> = {}): DCAPlan {
  return {
    id: "p1",
    holdingId: "h1",
    name: "Apple Inc.",
    symbol: "AAPL",
    market: "US",
    assetType: "stock",
    amount: 100,
    currency: "USD",
    frequency: "monthly",
    dayOfMonth: 15,
    startDate: "2026-01-01",
    enabled: true,
    nextExecDate: "2026-01-15",
    totalInvested: 0,
    execCount: 0,
    ...patch,
  };
}

export function createDCAExecution(patch: Partial<DCAExecution> = {}): DCAExecution {
  return {
    id: "e1",
    planId: "p1",
    holdingId: "h1",
    scheduledDate: "2026-01-15",
    actualDate: "2026-01-15",
    amount: 100,
    adjusted: false,
    status: "executed",
    ...patch,
  };
}

export function assertClose(actual: number, expected: number, tolerance = 1e-10) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${actual} to be within ${tolerance} of ${expected}`);
  }
}
