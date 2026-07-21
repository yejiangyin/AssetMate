import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRequestStartGate } from "./requestStartGate";

describe("request start gate", () => {
  test("spaces concurrent request starts without depending on task completion", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const gate = createRequestStartGate(125, {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all([gate.waitTurn(), gate.waitTurn(), gate.waitTurn()]);
    assert.deepEqual(sleeps, [125, 125]);
  });

  test("can reset its schedule", async () => {
    let now = 2_000;
    const sleeps: number[] = [];
    const gate = createRequestStartGate(250, {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await gate.waitTurn();
    gate.reset();
    await gate.waitTurn();
    assert.deepEqual(sleeps, []);
  });
});
