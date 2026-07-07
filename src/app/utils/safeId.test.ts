import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { safeUUID } from "./safeId";

describe("safeUUID", () => {
  test("uses randomUUID when available", () => {
    const previousCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "fixed-id" },
    });

    try {
      assert.equal(safeUUID(), "fixed-id");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto });
    }
  });

  test("falls back to RFC-4122-shaped id from random bytes", () => {
    const previousCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        randomUUID: () => { throw new Error("insecure"); },
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(1);
          return bytes;
        },
      },
    });

    try {
      assert.match(safeUUID(), /^01010101-0101-4101-8101-010101010101$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto });
    }
  });

  test("falls back to timestamp and Math.random when crypto is unavailable", () => {
    const previousCrypto = globalThis.crypto;
    const previousNow = Date.now;
    const previousRandom = Math.random;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    Date.now = () => 0x1234;
    Math.random = () => 0.5;

    try {
      assert.equal(safeUUID(), "1234-8-8");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto });
      Date.now = previousNow;
      Math.random = previousRandom;
    }
  });
});
