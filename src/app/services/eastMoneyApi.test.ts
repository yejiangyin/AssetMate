import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isEastMoneyFxPer100 } from "./eastMoneyApi";

describe("isEastMoneyFxPer100", () => {
  test("flags JPY/CNY pairs which EastMoney quotes per 100 JPY", () => {
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "FX"), true);
    assert.equal(isEastMoneyFxPer100("jpycny=x", "FX"), true);
  });

  test("does not flag other FX pairs quoted per 1 unit", () => {
    assert.equal(isEastMoneyFxPer100("USDCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("EURCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("HKDCNY=X", "FX"), false);
    assert.equal(isEastMoneyFxPer100("GBPCNY=X", "FX"), false);
  });

  test("does not flag non-FX markets even if the symbol collides", () => {
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "A"), false);
    assert.equal(isEastMoneyFxPer100("JPYCNY=X", "INDEX"), false);
  });
});
