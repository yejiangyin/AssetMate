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
    for (const path of ["holdings", "returns", "market", "research", "backtest", "settings"]) {
      assert.ok(children.some((route) => route.path === path), `missing ${path} route`);
    }
    assert.ok(children.some((route) => route.path === "settings/ai"), "missing AI settings route");
    const legacyBacktest = children.find((route) => route.path === "backtest");
    assert.ok(legacyBacktest && "element" in legacyBacktest, "legacy backtest URL must redirect into Research Center");
  });
});
