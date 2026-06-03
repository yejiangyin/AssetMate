import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HoldingInput } from "../context/AppContext";
import { canSaveHoldingForm } from "./holdingForm";

function form(patch: Partial<HoldingInput> = {}): HoldingInput {
  return {
    groupId: "",
    symbol: "006479",
    name: "广发纳斯达克100ETF联接人民币(QDII)C",
    market: "FUND",
    assetType: "fund",
    quantity: 10,
    costPrice: 8,
    currentPrice: 0,
    currency: "CNY",
    tradeStatus: "normal",
    tradeStatusNote: "",
    ...patch,
  };
}

describe("canSaveHoldingForm", () => {
  test("allows saving a holding before a live price is available", () => {
    assert.equal(canSaveHoldingForm(form({ currentPrice: 0 })), true);
  });

  test("rejects invalid or incomplete holding inputs", () => {
    assert.equal(canSaveHoldingForm(form({ currentPrice: -1 })), false);
    assert.equal(canSaveHoldingForm(form({ quantity: 0 })), false);
    assert.equal(canSaveHoldingForm(form({ symbol: "" })), false);
  });
});
