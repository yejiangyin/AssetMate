/**
 * Historical fund purchase-limit announcements (东方财富基金公告).
 *
 * The daily purchase status (SGZT) in the NAV history only says whether a fund
 * was open / limited / suspended on a date. The limit amount lives in the fund
 * company's announcements, which are fetched and parsed here so a DCA day that
 * the extension never saw can still be judged by the rules in force that day.
 */

import { readPersistentEntry, writePersistentEntry } from "./persistentDataCache";

export interface FundLimitNotice {
  id: string;
  publishDate: string;
  /** First day the rule applies (起始日), never the publish date. */
  effectiveDate: string;
  /** "resume" lifts the large-purchase limit (恢复大额申购). */
  kind: "limit" | "resume";
  /** Single-day DCA/purchase limit for this share class, in the class currency. */
  limit?: number;
  title: string;
}

const LIST_STORAGE_KEY = "asset-helper:fund-limit-notices:v1";
const CONTENT_STORAGE_KEY = "asset-helper:fund-limit-notice-content:v1";
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_NOTICES_PARSED = 8;

/* ─── parsing ───────────────────────────────────────── */

/** Titles about the large-purchase limit; full suspensions are covered by the daily SGZT status. */
export function isFundLimitNoticeTitle(title: string) {
  if (!/申购/.test(title)) return false;
  // Channel-specific rules (e.g. 直销机构) do not bind the platforms users usually buy through.
  if (/直销/.test(title)) return false;
  return /大额|限额|限制金额|限制申购金额/.test(title);
}

function displayWidth(text: string) {
  let width = 0;
  for (const char of text) width += /[ᄀ-￿]/.test(char) ? 2 : 1;
  return width;
}

type Token = { text: string; center: number };

function tokensWithCenters(line: string, pattern: RegExp): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(pattern)) {
    const start = displayWidth(line.slice(0, match.index));
    tokens.push({ text: match[0], center: start + displayWidth(match[0]) / 2 });
  }
  return tokens;
}

function parseYMD(text: string, label: RegExp) {
  const collapsed = text.replace(/\s+/g, "");
  const match = collapsed.match(new RegExp(`${label.source}(\\d{4})年(\\d{1,2})月(\\d{1,2})日`));
  if (!match) return null;
  return `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
}

/** Limit for `code` from the flattened 基本信息 table, matching columns by display position. */
function tableLimit(text: string, code: string): number | null | undefined {
  const lines = text.split(/\r?\n/);
  const codeLineIndex = lines.findIndex((line) => new RegExp(`(^|\\D)${code}(\\D|$)`).test(line) && /\d{6}.*\d{6}|交易代码/.test(line));
  if (codeLineIndex < 0) {
    // A table listing other share classes only does not apply to this one.
    return /交易代码/.test(text) && /\d{6}/.test(text) ? null : undefined;
  }
  const codes = tokensWithCenters(lines[codeLineIndex]!, /\b\d{6}\b/g);
  const own = codes.find((token) => token.text === code);
  if (!own) return undefined;
  const rowPriority = [/定期定额.*金额|限制定投/, /限制申购金额|申购.*限制.*金额|申购.*限额/];
  for (const rowPattern of rowPriority) {
    for (let i = codeLineIndex + 1; i < Math.min(lines.length, codeLineIndex + 40); i++) {
      const line = lines[i]!;
      // The prose after the table repeats the same words; only table rows count.
      if (/其他需要提示/.test(line)) break;
      const label = line.split(/\d/)[0] ?? "";
      if (!rowPattern.test(label) || /转换转入/.test(label) && !/申购/.test(label)) continue;
      // Blank out the label but keep every character's display width so columns still line up.
      const cells = line.replace(/[^\d.\s-]/g, (m) => " ".repeat(displayWidth(m)));
      const amounts = tokensWithCenters(cells, /(?<![\d.])(?:\d+(?:\.\d+)?|-)(?![\d.])/g);
      if (!amounts.length) continue;
      if (amounts.length === 1) return amounts[0]!.text === "-" ? null : Number(amounts[0]!.text);
      if (amounts.length === codes.length) {
        const token = amounts[codes.indexOf(own)]!;
        return token.text === "-" ? null : Number(token.text);
      }
      const nearest = amounts.reduce((best, token) => Math.abs(token.center - own.center) < Math.abs(best.center - own.center) ? token : best);
      if (Math.abs(nearest.center - own.center) > 8) return null;
      return nearest.text === "-" ? null : Number(nearest.text);
    }
  }
  return undefined;
}

/** Fallback: the 其他需要提示的事项 prose, when it states a single RMB amount. */
function sentenceLimit(text: string): number | undefined {
  const values = new Set<number>();
  for (const sentence of text.replace(/\s+/g, "").split("。")) {
    if (/美元/.test(sentence) && !/人民币/.test(sentence)) continue;
    for (const match of sentence.matchAll(/限额(?:调整)?为(\d+(?:\.\d+)?)(万)?(?:人民币)?元/g)) {
      values.add(Number(match[1]) * (match[2] ? 10000 : 1));
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
}

export function parseFundLimitNotice(
  code: string,
  notice: { id: string; title: string; publishDate: string },
  text: string,
): FundLimitNotice | null {
  if (!isFundLimitNoticeTitle(notice.title)) return null;
  const resume = /恢复/.test(notice.title) && !/调整|暂停|限制/.test(notice.title);
  const effectiveDate = parseYMD(text, resume ? /恢复[^年]{0,20}?(?:起始日|日期)?/ : /(?:起始日|自)/)
    ?? parseYMD(text, /自/);
  if (!effectiveDate) return null;
  if (resume) return { ...notice, effectiveDate, kind: "resume" };
  const fromTable = tableLimit(text, code);
  if (fromTable === null) return null;
  const limit = fromTable ?? sentenceLimit(text);
  if (limit == null || !Number.isFinite(limit) || limit < 0) return null;
  return { ...notice, effectiveDate, kind: "limit", limit };
}

/** The limit in force on `date`: a number, null when lifted, undefined when unknown. */
export function fundLimitOnDate(notices: FundLimitNotice[] | undefined, date: string) {
  const notice = [...(notices ?? [])]
    .filter((item) => item.effectiveDate <= date)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.publishDate.localeCompare(a.publishDate))[0];
  if (!notice) return undefined;
  return { limit: notice.kind === "resume" ? null : notice.limit ?? null, notice };
}

/* ─── fetching ──────────────────────────────────────── */

type NoticeListRow = { ID?: unknown; TITLE?: unknown; PUBLISHDATEDesc?: unknown; PUBLISHDATE?: unknown };

async function fetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Referer is attached by the eastmoney-fund-referer declarativeNetRequest rule.
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json, text/plain, */*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNoticeText(id: string): Promise<string | null> {
  const cached = readPersistentEntry<string>(CONTENT_STORAGE_KEY, id);
  if (cached) return cached.data;
  const json = await fetchJson(
    `https://np-cnotice-fund.eastmoney.com/api/content/ann?art_code=${encodeURIComponent(id)}&client_source=web_fund&page_index=1`,
    10000,
  );
  const text = String(json?.data?.notice_content ?? "");
  if (!text) return null;
  // Announcements never change once published.
  writePersistentEntry(CONTENT_STORAGE_KEY, id, text, { maxEntries: 200 });
  return text;
}

export async function fetchCnFundLimitNotices(code: string): Promise<FundLimitNotice[] | null> {
  const cached = readPersistentEntry<FundLimitNotice[]>(LIST_STORAGE_KEY, code);
  if (cached && Date.now() - cached.savedAt < LIST_TTL_MS) return cached.data;
  try {
    const json = await fetchJson(
      `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${encodeURIComponent(code)}&pageIndex=1&pageSize=50&type=0&_=${Date.now()}`,
      10000,
    );
    const rows: NoticeListRow[] = Array.isArray(json?.Data) ? json.Data : [];
    const candidates = rows
      .map((row) => ({
        id: String(row.ID ?? ""),
        title: String(row.TITLE ?? ""),
        publishDate: String(row.PUBLISHDATEDesc ?? row.PUBLISHDATE ?? "").slice(0, 10),
      }))
      .filter((row) => row.id && isFundLimitNoticeTitle(row.title))
      .slice(0, MAX_NOTICES_PARSED);
    const notices: FundLimitNotice[] = [];
    for (const candidate of candidates) {
      const text = await fetchNoticeText(candidate.id).catch(() => null);
      const parsed = text ? parseFundLimitNotice(code, candidate, text) : null;
      if (parsed) notices.push(parsed);
    }
    writePersistentEntry(LIST_STORAGE_KEY, code, notices, { maxEntries: 100 });
    return notices;
  } catch {
    return cached?.data ?? null;
  }
}
