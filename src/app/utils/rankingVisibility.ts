export const DASHBOARD_RANKING_PREVIEW_LIMIT = 20;
export const RETURNS_RANKING_PREVIEW_LIMIT = 8;

export function getVisibleRanking<T>(items: readonly T[], expanded: boolean, previewLimit: number) {
  return expanded ? [...items] : items.slice(0, previewLimit);
}
