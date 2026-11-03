export const READING_PROGRESS_KEY = "verso-reading-progress";

type ProgressStorage = Pick<Storage, "getItem" | "setItem">;

export function parseReadingProgress(value: string | null): Record<string, number> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const progress: Record<string, number> = {};
    for (const [documentId, page] of Object.entries(parsed)) {
      if (Number.isSafeInteger(page) && (page as number) > 0) progress[documentId] = page as number;
    }
    return progress;
  } catch {
    return {};
  }
}

export function readReadingProgress(documentId: string, storage: ProgressStorage = localStorage): number | undefined {
  try {
    return parseReadingProgress(storage.getItem(READING_PROGRESS_KEY))[documentId];
  } catch {
    return undefined;
  }
}

export function writeReadingProgress(documentId: string, page: number, storage: ProgressStorage = localStorage) {
  if (!documentId || !Number.isSafeInteger(page) || page < 1) return;
  try {
    const progress = parseReadingProgress(storage.getItem(READING_PROGRESS_KEY));
    if (progress[documentId] === page) return;
    progress[documentId] = page;
    storage.setItem(READING_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage can be unavailable or full; reading still works without a cursor.
  }
}
