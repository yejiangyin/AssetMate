import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchYahooQuoteSummary, resetYahooCrumbStateForTests } from "./quoteApi";

describe("Yahoo quoteSummary crumb coordination", () => {
  test("shares one cookie and crumb request across concurrent summaries", async () => {
    resetYahooCrumbStateForTests();
    const originalFetch = globalThis.fetch;
    let cookieCalls = 0;
    let crumbCalls = 0;
    let summaryCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("fc.yahoo.com")) {
        cookieCalls += 1;
        return new Response("", { status: 404 });
      }
      if (url.includes("/v1/test/getcrumb")) {
        crumbCalls += 1;
        await Promise.resolve();
        return new Response("shared-crumb");
      }
      if (url.includes("/v10/finance/quoteSummary/")) {
        summaryCalls += 1;
        assert.match(url, /crumb=shared-crumb/);
        return new Response(JSON.stringify({ quoteSummary: { result: [{}] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const [apple, microsoft] = await Promise.all([
        fetchYahooQuoteSummary("AAPL"),
        fetchYahooQuoteSummary("MSFT"),
      ]);
      assert.deepEqual(apple, {});
      assert.deepEqual(microsoft, {});
      assert.equal(cookieCalls, 1);
      assert.equal(crumbCalls, 1);
      assert.equal(summaryCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      resetYahooCrumbStateForTests();
    }
  });

  test("coalesces the refresh after concurrent 401 responses", async () => {
    resetYahooCrumbStateForTests();
    const originalFetch = globalThis.fetch;
    let crumbCalls = 0;
    let staleSummaryCalls = 0;
    let freshSummaryCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("fc.yahoo.com")) return new Response("", { status: 404 });
      if (url.includes("/v1/test/getcrumb")) {
        crumbCalls += 1;
        return new Response(crumbCalls === 1 ? "stale-crumb" : "fresh-crumb");
      }
      if (url.includes("crumb=stale-crumb")) {
        staleSummaryCalls += 1;
        return new Response("", { status: 401 });
      }
      if (url.includes("crumb=fresh-crumb")) {
        freshSummaryCalls += 1;
        return new Response(JSON.stringify({ quoteSummary: { result: [{}] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const results = await Promise.all([
        fetchYahooQuoteSummary("AAPL"),
        fetchYahooQuoteSummary("MSFT"),
      ]);
      assert.deepEqual(results, [{}, {}]);
      assert.equal(staleSummaryCalls, 2);
      assert.equal(freshSummaryCalls, 2);
      assert.equal(crumbCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      resetYahooCrumbStateForTests();
    }
  });
});
