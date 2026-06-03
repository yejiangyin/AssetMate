import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appRoutes } from "./routeConfig";

describe("appRoutes", () => {
  test("redirects unknown hash routes instead of showing router errors", () => {
    const fallback = appRoutes[0]?.children.at(-1);
    assert.equal(fallback?.path, "*");
    assert.ok("element" in fallback);
  });
});
