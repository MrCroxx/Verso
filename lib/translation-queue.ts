// Count exhausted pages, not retry attempts shared across the book.
export const MAX_PAGE_RETRIES = 3;
export const MAX_FAILED_PAGES = 3;
export const DEFAULT_QUEUE_CONCURRENCY = 4;
export const QUEUE_CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export type BookTranslationJob = {
  documentId: string;
  bookId: string;
  bookName: string;
  targetLanguage: string;
  status: "queued" | "running" | "retrying" | "failed" | "stopped" | "partial" | "completed";
  error: string | null;
  nextPage: number;
  activePages: number;
  retryCount: number;
  retryAt: number;
  maxRetriesPerPage: number;
  failedPages: number;
  failedPageLimit: number;
  pageErrors: Array<{ page: number; status: string; retryCount: number; error: string }>;

  completedPages: number;
  totalPages: number;
};

export function isTranslationActive(status?: string) {
  return status === "queued" || status === "running" || status === "retrying";
}
