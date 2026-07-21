import type { PortfolioEvent } from "../services/portfolioEvents";

const NOTICE_EVENT_TYPES = new Set<PortfolioEvent["type"]>([
  "cash_dividend",
  "dividend_reinvest",
  "share_dividend",
  "split",
  "interest",
  "bond_coupon",
]);
export const DISMISSED_NOTICE_STORAGE_KEY = "asset-helper:dismissed-corporate-action-notices:v1";
const DISMISSED_NOTICE_CHANGE_EVENT = "asset-helper:corporate-action-notices-changed";
const MAX_DISMISSED_NOTICE_KEYS = 200;
export const CORPORATE_ACTION_NOTICE_RETENTION_DAYS = 7;

function localYMD(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addLocalDays(date: Date, days: number) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return localYMD(copy);
}

export function corporateActionNoticeKey(event: PortfolioEvent) {
  return event.corporateActionId || event.id;
}

export function readDismissedCorporateActionNoticeKeys() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_NOTICE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && key.length > 0)
      .slice(-MAX_DISMISSED_NOTICE_KEYS);
  } catch {
    return [];
  }
}

export function mergeDismissedCorporateActionNoticeKeys(
  existingKeys: readonly string[],
  events: PortfolioEvent[],
) {
  const keys = new Set(existingKeys);
  for (const event of events) keys.add(corporateActionNoticeKey(event));
  return [...keys].slice(-MAX_DISMISSED_NOTICE_KEYS);
}

export function writeDismissedCorporateActionNoticeKeys(keys: readonly string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DISMISSED_NOTICE_STORAGE_KEY,
      JSON.stringify([...keys].slice(-MAX_DISMISSED_NOTICE_KEYS)),
    );
    window.dispatchEvent(new Event(DISMISSED_NOTICE_CHANGE_EVENT));
  } catch {
    // Notification acknowledgement is non-critical.
  }
}

export function subscribeDismissedCorporateActionNotices(listener: (keys: string[]) => void) {
  if (typeof window === "undefined") return () => undefined;
  const sync = () => listener(readDismissedCorporateActionNoticeKeys());
  const onStorage = (event: StorageEvent) => {
    if (event.key === DISMISSED_NOTICE_STORAGE_KEY) sync();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(DISMISSED_NOTICE_CHANGE_EVENT, sync);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DISMISSED_NOTICE_CHANGE_EVENT, sync);
  };
}

export function getRecentCorporateActionNotices(
  events: PortfolioEvent[],
  today = new Date(),
  days = CORPORATE_ACTION_NOTICE_RETENTION_DAYS,
  dismissedKeys: ReadonlySet<string> = new Set(),
) {
  const end = localYMD(today);
  const start = addLocalDays(today, -(Math.max(1, days) - 1));
  const seen = new Set<string>();

  return events
    .filter((event) => (
      event.source === "auto"
      && NOTICE_EVENT_TYPES.has(event.type)
      && event.date >= start
      && event.date <= end
      && !dismissedKeys.has(corporateActionNoticeKey(event))
    ))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .filter((event) => {
      const key = corporateActionNoticeKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
