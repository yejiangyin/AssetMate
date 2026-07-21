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
});
