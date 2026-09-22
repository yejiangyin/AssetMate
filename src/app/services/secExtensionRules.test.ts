import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

describe("SEC extension request identity", () => {
  test("enables a narrowly scoped declarative rule with the package version", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const rulesPath = manifest.declarative_net_request.rule_resources[0].path;
    const rules = JSON.parse(readFileSync(`public/${rulesPath}`, "utf8"));

    assert.equal(manifest.permissions.includes("declarativeNetRequest"), true);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((rule: { condition: { urlFilter: string } }) => rule.condition.urlFilter).sort(), [
      "||data.sec.gov/",
      "||www.sec.gov/",
    ]);
    for (const rule of rules) {
      assert.equal(rule.action.type, "modifyHeaders");
      assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
      const userAgent = rule.action.requestHeaders.find((header: { header: string }) => header.header.toLowerCase() === "user-agent");
      assert.equal(userAgent.operation, "set");
      assert.match(userAgent.value, new RegExp(`AssetMate/${packageJson.version.replaceAll(".", "\\.")}`));
      assert.match(userAgent.value, /github\.com\/yejiangyin\/AssetMate\/issues/);
    }
  });

  test("grants the production hosts used by realtime fund valuation", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    assert.equal(manifest.host_permissions.includes("https://fundcomapi.tiantianfunds.com/mm/newCore/*"), true);
    assert.equal(manifest.host_permissions.includes("https://fundcomapi.eastmoney.com/mm/newCore/*"), true);
  });

  test("sends the Referer Eastmoney requires for fund history and announcements", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    const resource = manifest.declarative_net_request.rule_resources.find((item: { id: string }) => item.id === "eastmoney_fund_referer");
    assert.equal(resource?.enabled, true);
    const [rule] = JSON.parse(readFileSync(`public/${resource.path}`, "utf8"));
    assert.equal(rule.condition.urlFilter, "||api.fund.eastmoney.com/f10/");
    assert.deepEqual(rule.action.requestHeaders, [{ header: "Referer", operation: "set", value: "https://fundf10.eastmoney.com/" }]);
    assert.equal(manifest.host_permissions.includes("https://np-cnotice-stock.eastmoney.com/api/content/*"), true);
  });
});
