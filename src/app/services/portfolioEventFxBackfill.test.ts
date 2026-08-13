import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PortfolioEvent } from "./portfolioEvents";
import { backfillPortfolioEventFxRates } from "./portfolioEventFxBackfill";

describe("portfolio event FX backfill", () => {
  test("uses the latest event-date FX rate for historical sales", async () => {
    const event: PortfolioEvent = {
      id: "sell", date: "2026-07-02", type: "sell", amount: 20, amountInBase: 140,
      quantity: 1, price: 120, proceeds: 120, capitalFlowInBase: -840,
      currency: "USD", source: "import", createdAt: "2026-07-02T00:00:00.000Z",
      fxRateEstimated: true,
    };
    const result = await backfillPortfolioEventFxRates([event], async () => [
      { date: "2026-07-01", price: 7.1 },
      { date: "2026-07-02", price: 7.2 },
    ]);

    assert.equal(result[0]?.amountInBase, 144);
    assert.equal(result[0]?.capitalFlowInBase, -864);
    assert.equal(result[0]?.fxRateToBase, 7.2);
    assert.equal(result[0]?.fxRateEstimated, undefined);
  });
});
