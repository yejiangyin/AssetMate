import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchCnFundTradeStatus, parseFundBuyConfirmDays } from "./securitiesApi";

describe("parseFundBuyConfirmDays", () => {
  test("extracts buy confirmation days from EastMoney fund fee text", () => {
    assert.equal(parseFundBuyConfirmDays("交易确认日 买入确认日 T+3 卖出确认日 T+2"), 3);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T + 10 卖出确认日 T+10"), 10);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T+0 卖出确认日 T+1"), 0);
  });

  test("ignores missing or unreasonable confirmation days", () => {
    assert.equal(parseFundBuyConfirmDays("交易确认日 卖出确认日 T+2"), undefined);
    assert.equal(parseFundBuyConfirmDays("买入确认日 T+99"), undefined);
  });

  test("keeps confirmation days even when the trade status text is not recognized", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () => "<html><body>交易规则 买入确认日 T+2 其他文本</body></html>",
    })) as any;

    try {
      const status = await fetchCnFundTradeStatus("021277");
      assert.equal(status?.status, "normal");
      assert.equal(status?.buyConfirmDays, 2);
      assert.match(status?.note ?? "", /确认规则/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
