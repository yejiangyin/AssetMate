import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fundLimitOnDate, isFundLimitNoticeTitle, parseFundLimitNotice, type FundLimitNotice } from "./fundLimitNotices";
import { parseFundDailyPurchaseStatus } from "./securitiesApi";

// Table rows as flattened by the announcement API (column alignment preserved).
const GF_TABLE = [
  "                                                暂停大额申购起始日                      2026年9月11日",
  "      下属分级基金的交易代码          270042        006479        021778        000055        006480",
  " 该分级基金是否暂停大额申购（转换转      是            是            是              -              -",
  "    入、定期定额和不定额投资）",
  " 下属分级基金的限制申购金额（单位：    2.00          2.00          30.00",
  "              元）",
  "  2.其他需要提示的事项",
  "  本基金A类及C类人民币份额调整投资者单日单个基金账户申购（含定期定额和不定额投资）的业务限额为2.00元。即如申请金额大于2.00元，则超过部分有权确认失败。",
].join("\n");

const MORGAN_TABLE = [
  " 暂停大额申购起始日 2026 年 7 月 27 日",
  " 下属分级基金的交易代码              017641    017642    019305    017643",
  " 下属分级基金的限制申购金额（单位：人 20.00      1.00      20.00      1.00",
  " 下属分级基金的限制转换转入金额（单位：10.00      -          10.00      -",
  " 下属分级基金的限制定期定额投资金额 10.00      1.00      10.00      1.00",
].join("\n");

const notice = (title: string) => ({ id: "AN1", title, publishDate: "2026-09-10" });

describe("fund limit announcements", () => {
  test("keeps large-purchase limit titles and drops direct-sales-only or full-suspension titles", () => {
    assert.equal(isFundLimitNoticeTitle("关于调整大额申购(含定期定额投资)业务限额的公告"), true);
    assert.equal(isFundLimitNoticeTitle("调整直销渠道大额申购、定期定额投资业务限制金额的公告"), false);
    assert.equal(isFundLimitNoticeTitle("关于调整在直销机构大额申购(含定期定额投资)业务的公告"), false);
    assert.equal(isFundLimitNoticeTitle("因境外主要投资市场节假日暂停申购、赎回业务的公告"), false);
  });

  test("reads this share class's column even when blank columns are dropped", () => {
    const parsed = parseFundLimitNotice("006479", notice("人民币份额调整大额申购业务限额的公告"), GF_TABLE);
    assert.deepEqual([parsed?.kind, parsed?.effectiveDate, parsed?.limit], ["limit", "2026-09-11", 2]);
    // A share class whose cell is "-" or missing is not limited by this announcement.
    assert.equal(parseFundLimitNotice("006480", notice("人民币份额调整大额申购业务限额的公告"), GF_TABLE), null);
    assert.equal(parseFundLimitNotice("999999", notice("人民币份额调整大额申购业务限额的公告"), GF_TABLE), null);
  });

  test("prefers the DCA row over the purchase row", () => {
    const parsed = parseFundLimitNotice("019305", notice("调整大额申购、定期定额投资及转换转入业务限制金额的公告"), MORGAN_TABLE);
    assert.deepEqual([parsed?.effectiveDate, parsed?.limit], ["2026-07-27", 10]);
  });

  test("falls back to a single RMB amount stated in the prose", () => {
    const text = "自2026年7月21日起，本基金人民币份额单日申购业务限额为5.00元。本基金美元份额的业务限额为20.00美元。";
    assert.equal(parseFundLimitNotice("006479", notice("调整大额申购业务限额的公告"), text)?.limit, 5);
  });

  test("records resumptions and picks the rule in force on each date", () => {
    const resumed = parseFundLimitNotice("006479", notice("关于恢复大额申购业务的公告"), "恢复大额申购起始日 2026年9月20日");
    assert.deepEqual([resumed?.kind, resumed?.effectiveDate], ["resume", "2026-09-20"]);
    const notices: FundLimitNotice[] = [
      { id: "a", title: "", publishDate: "2026-07-20", effectiveDate: "2026-07-21", kind: "limit", limit: 5 },
      { id: "b", title: "", publishDate: "2026-09-10", effectiveDate: "2026-09-11", kind: "limit", limit: 2 },
      resumed!,
    ];
    assert.equal(fundLimitOnDate(notices, "2026-07-20"), undefined);
    assert.equal(fundLimitOnDate(notices, "2026-09-10")?.limit, 5);
    assert.equal(fundLimitOnDate(notices, "2026-09-11")?.limit, 2);
    assert.equal(fundLimitOnDate(notices, "2026-09-21")?.limit, null);
  });

  test("maps the daily purchase status published with each NAV", () => {
    assert.equal(parseFundDailyPurchaseStatus("开放申购"), "open");
    assert.equal(parseFundDailyPurchaseStatus("限制大额申购"), "limited");
    assert.equal(parseFundDailyPurchaseStatus("暂停申购"), "suspended");
    assert.equal(parseFundDailyPurchaseStatus(""), undefined);
  });
});
