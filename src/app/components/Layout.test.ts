import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extensionLayoutDimensions } from "./Layout";

describe("extension layout dimensions", () => {
  test("uses intrinsic fixed dimensions for Chrome popup sizing", () => {
    assert.deepEqual(extensionLayoutDimensions(false), {
      width: 400,
      height: 600,
      minWidth: 400,
      minHeight: 600,
      maxHeight: 600,
    });
  });

  test("keeps the side panel responsive to its host viewport", () => {
    assert.deepEqual(extensionLayoutDimensions(true), {
      width: "100vw",
      height: "100vh",
      minWidth: 320,
      minHeight: 0,
      maxHeight: "100vh",
    });
  });
});
