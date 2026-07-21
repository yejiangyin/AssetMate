export interface RequestStartGate {
  waitTurn: () => Promise<void>;
  reset: () => void;
}

/**
 * Spaces request start times without serializing the network work itself.
 * Concurrent callers queue only for their start slot and may execute in
 * parallel after that slot is granted.
 */
export function createRequestStartGate(
  minIntervalMs: number,
  dependencies: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): RequestStartGate {
  const interval = Math.max(0, minIntervalMs);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let nextStartAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    waitTurn() {
      const turn = queue.then(async () => {
        const delay = Math.max(0, nextStartAt - now());
        if (delay > 0) await sleep(delay);
        nextStartAt = now() + interval;
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
    reset() {
      nextStartAt = 0;
      queue = Promise.resolve();
    },
  };
}
