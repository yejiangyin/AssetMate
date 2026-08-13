import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHolding } from "../testUtils";
import type { PortfolioEvent } from "../services/portfolioEvents";
import { summarizeHoldingDividends } from "./holdingDividendSummary";

function dividendEvent(patch: Partial<PortfolioEvent>): PortfolioEvent {
  return {
    id: "div-1",
    holdingId: "h1",
    date: "2026-08-01",
    type: "cash_dividend",
    amount: 10,
    amountInBase: 10,
    currency: "CNY",
    source: "auto",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  };
}

describe("holding dividend summary", () => {
  test("counts distinct cash and reinvested distributions", () => {
    const holding = createHolding({ id: "h1", market: "A", assetType: "stock", currency: "CNY", cashDividendTotal: 30 });
    const summary = summarizeHoldingDividends(holding, [
      dividendEvent({ id: "event-a", corporateActionId: "corp-a", amount: 10 }),
      dividendEvent({ id: "event-b", corporateActionId: "corp-b", type: "dividend_reinvest", amount: 20 }),
    ]);
    assert.deepEqual(summary, { amount: 30, count: 2, countIncomplete: false });
  });

  test("does not invent a count for a migrated aggregate", () => {
    const holding = createHolding({ id: "h1", market: "A", assetType: "stock", currency: "CNY", cashDividendTotal: 50 });
    const summary = summarizeHoldingDividends(holding, [
      dividendEvent({ amount: 50, source: "migration", note: "migrated cashDividendTotal summary" }),
    ]);
    assert.deepEqual(summary, { amount: 50, count: 0, countIncomplete: true });
  });
});
