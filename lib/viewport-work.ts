export function isPageWorkEnabled(
  page: number,
  currentPage: number,
  nearbyPages: number,
  viewportSettled: boolean,
) {
  if (!viewportSettled) return false;
  const radius = Math.max(1, Math.floor(nearbyPages));
  return Math.abs(page - currentPage) <= radius;
}

export function pageWorkWindow(currentPage: number, totalPages: number, nearbyPages: number) {
  const radius = Math.max(1, Math.floor(nearbyPages));
  const start = Math.max(1, currentPage - radius);
  const end = Math.min(totalPages, currentPage + radius);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function shouldStartTranslationRequest(
  isDemo: boolean,
  hasTranslation: boolean,
  force: boolean,
  cacheOnly: boolean,
  viewportSettled: boolean,
) {
  if (isDemo || (!force && hasTranslation)) return false;
  return force || cacheOnly || viewportSettled;
}
