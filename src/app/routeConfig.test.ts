import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appRoutes } from "./routeConfig";

describe("appRoutes", () => {
  test("redirects unknown hash routes instead of showing router errors", () => {
    const fallback = appRoutes[0]?.children.find((route) => route.path === "*");
    assert.equal(fallback?.path, "*");
    assert.ok("element" in fallback);
  });

  test("registers the primary app routes", () => {
    const root = appRoutes[0];
    assert.equal(root?.path, "/");
    assert.ok(root?.errorElement);

    const children = root?.children ?? [];
    assert.ok(children.some((route) => route.index === true));
    for (const path of ["holdings", "returns", "market", "backtest", "settings"]) {
      assert.ok(children.some((route) => route.path === path), `missing ${path} route`);
    }
  });
});
