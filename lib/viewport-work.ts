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
