import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyResearchEmphasis, isKeyFigureText } from "./reportEmphasis";

describe("research report emphasis", () => {
  test("classifies only explicit report semantics", () => {
    assert.equal(classifyResearchEmphasis("一句话结论"), "conclusion");
    assert.equal(classifyResearchEmphasis("核心风险与红线"), "risk");
    assert.equal(classifyResearchEmphasis("看多优势与催化剂"), "positive");
    assert.equal(classifyResearchEmphasis("数据局限与待核验事项"), "warning");
    assert.equal(classifyResearchEmphasis("Bull vs Bear"), "neutral");
    assert.equal(classifyResearchEmphasis("机会成本"), "neutral");
    assert.equal(classifyResearchEmphasis("商业模式"), "neutral");
  });

  test("does not misclassify negated verdicts as positive", () => {
    // "通过" alone is a pass verdict -> positive
    assert.equal(classifyResearchEmphasis("最终结论：通过"), "positive");
    // Negated forms must not be positive (previously "通过$" matched these)
    assert.equal(classifyResearchEmphasis("审计未通过"), "risk");
    assert.equal(classifyResearchEmphasis("审计不通过"), "risk");
    assert.equal(classifyResearchEmphasis("审计没通过"), "risk");
  });

  test("recognizes compact investment figures without highlighting dates or prose", () => {
    assert.equal(isKeyFigureText("目标价 ¥42.00"), true);
    assert.equal(isKeyFigureText("ROE 18.6%"), true);
    assert.equal(isKeyFigureText("2026-07-21"), false);
    assert.equal(isKeyFigureText("收入增长的主要原因仍然需要结合更多证据核验"), false);
  });
});
