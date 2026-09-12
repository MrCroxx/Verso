import { MAX_PAGE_RETRIES, MAX_FAILED_PAGES } from "./translation-queue";
import { joinTranslationProgress } from "./server-translation-progress";
import type { TranslationProgress } from "./translation-progress";
import { withTranslationTrace, traceStep, traceAttributes, startSpan, bindTrace } from "./server-translation-trace";
import type { TranslationTrace } from "./translation-trace";
import { ensureStorageSchema, findBook, getStorage } from "../db/books";
import { getAiProviderSettings } from "../db/ai-provider-settings";
import { createPriorityTaskQueue } from "./priority-task-queue";
import { generateTranslation, type TranslationRequest } from "./server-translation";
import { deduplicatePageBoundary, hasLayoutContent, normalizeTranslationPayload, type LayoutBlock } from "./translation-layout";
import { extractNavigationObservation } from "./document-navigation";
import { TRANSLATION_CACHE_LAYOUT_VERSION, translationCacheKey, TRANSLATION_CACHE_SERVER_VERSION } from "./translation-cache";

type Result = Awaited<ReturnType<typeof generateTranslation>> & {
  markdown?: string;
  cacheVersion?: number;
  cachedAt?: number;
  serverManaged?: boolean;
};
type QueueRow = { document_id: string; target_language: string; next_page: number; status: string; run_id: number; total_pages: number };
type PageRow = { page: number; status: string; retry_count: number; retry_at: number; error: string | null };
type ActivePage = { documentId: string; language: string; page: number; controller: AbortController };
const globalState = globalThis as typeof globalThis & { versoTranslationWorker?: {
  tasks: ReturnType<typeof createPriorityTaskQueue<Result>>;
  timer?: ReturnType<typeof setInterval>;
  generations: Map<string, number>;
  active: Map<string, ActivePage>;
  control: Promise<void>;
} };
const state: NonNullable<typeof globalState.versoTranslationWorker> = globalState.versoTranslationWorker ??= {
  tasks: createPriorityTaskQueue<Result>(), generations: new Map(), active: new Map(), control: Promise.resolve(),
};

// Serialize short queue mutations only; provider requests run outside this lock.
function control<T>(work: () => Promise<T>): Promise<T> {
  const result = state.control.then(work);
  state.control = result.then(() => undefined, () => undefined);
  return result;
}

function key(documentId: string, page: number, language: string) {
  return translationCacheKey(documentId, page, language);
}

async function readTranslation(documentId: string, page: number, language: string) {
  const { db } = getStorage();
  const row = await db.prepare("SELECT payload FROM translations WHERE cache_key = ?1 LIMIT 1")
    .bind(key(documentId, page, language)).first<{ payload: string }>();
  return row ? normalizeTranslationPayload(JSON.parse(row.payload)) as Result : null;
}

async function saveTranslation(documentId: string, language: string, translation: Result, expectedVersion?: number) {
  const { db } = getStorage();
  const write = await db.prepare(`INSERT INTO translations (cache_key, document_id, page, payload, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET
    payload = excluded.payload, updated_at = excluded.updated_at
    WHERE COALESCE(CAST(json_extract(excluded.payload, '$.cacheVersion') AS INTEGER), 0)
      >= COALESCE(CAST(json_extract(translations.payload, '$.cacheVersion') AS INTEGER), 0)
    AND (?6 IS NULL OR COALESCE(CAST(json_extract(translations.payload, '$.cacheVersion') AS INTEGER), 0) = ?6)`)
    .bind(key(documentId, translation.page, language), documentId, translation.page, JSON.stringify(translation), Date.now(), expectedVersion ?? null).run();
  if (!write.changes) return false;
  const observation = extractNavigationObservation(translation.page, translation);
  await db.prepare(`INSERT INTO navigation_pages (document_id, pdf_page, is_table_of_contents, toc_entries,
    page_label, page_value, numbering, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(document_id, pdf_page) DO UPDATE SET is_table_of_contents = excluded.is_table_of_contents,
    toc_entries = excluded.toc_entries, page_label = excluded.page_label, page_value = excluded.page_value,
    numbering = excluded.numbering, updated_at = excluded.updated_at`)
    .bind(documentId, translation.page, observation.isTableOfContents ? 1 : 0, JSON.stringify(observation.tocEntries),
      observation.anchor?.label ?? null, observation.anchor?.value ?? null, observation.anchor?.numbering ?? null, Date.now()).run();
  return true;
}

const markdown = (blocks: LayoutBlock[]) => blocks.filter((block) => block.text).map((block) => block.text).join("\n\n");

type ProgressObserver = { onProgress: (progress: TranslationProgress) => void; signal?: AbortSignal };

export async function requestPageTranslation(input: TranslationRequest, background = false, onTrace?: (trace: TranslationTrace) => void, observer?: ProgressObserver, signal?: AbortSignal): Promise<Result> {
  return withTranslationTrace(input, background, () => runPageTranslation(input, background, observer, signal), onTrace);
}

async function runPageTranslation(input: TranslationRequest, background: boolean, observer?: ProgressObserver, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  const prepared = startSpan("storage.prepare");
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const book = input.bookId ? await findBook(db, input.bookId) : null;
  if (input.bookId && !book) throw new Error("Book not found.");
  if (book && (input.page > book.pageCount || input.totalPages !== book.pageCount)) throw new Error("Invalid book page.");
  const documentId = book?.fingerprint;
  prepared();
  // Cached pages must not wait behind slow provider requests.
  if (documentId && !input.force) {
    const cached = await traceStep("cache.lookup", () => readTranslation(documentId, input.page, input.targetLanguage));
    if (cached) {
      traceAttributes({ cacheHit: true });
      return { ...cached, blocks: cached.blocks || [], isBlank: Boolean(cached.isBlank), sourceSummary: cached.sourceSummary || "", previousPageRevision: null, serverManaged: true };
    }
  }
  const generation = documentId ? state.generations.get(documentId) || 0 : 0;
  const taskKey = documentId ? `${key(documentId, input.page, input.targetLanguage)}::${generation}` : crypto.randomUUID();
  const shared = state.tasks.has(taskKey) && !input.force;
  traceAttributes({ shared, cacheHit: false });
  const queued = startSpan(shared ? "queue.shared_wait" : "queue.wait");
  let observing = !input.force;
  const progress = joinTranslationProgress(taskKey, observer ? (value) => { if (observing) observer.onProgress(value); } : undefined, observer?.signal, !input.force);
  try { return await state.tasks.run(taskKey, background ? 0 : 1, input.translationConcurrency || 4, bindTrace(async () => {
    queued();
    signal?.throwIfAborted();
    observing = true;
    progress.publish({ phase: "preparing" });
    if (documentId && (state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    if (documentId && !input.force) {
      const cached = await traceStep("cache.recheck", () => readTranslation(documentId, input.page, input.targetLanguage));
      if (cached) traceAttributes({ cacheHit: true });
      if (cached) return { ...cached, blocks: cached.blocks || [], isBlank: Boolean(cached.isBlank), sourceSummary: cached.sourceSummary || "", previousPageRevision: null, serverManaged: true };
    }
    const previous = documentId && input.page > 1 ? await traceStep("cache.previous", () => readTranslation(documentId, input.page - 1, input.targetLanguage)) : null;
    const version = Date.now() * 1000;
    const result = await generateTranslation({ ...input, previousTranslationTail: previous?.blocks?.findLast((block) =>
      (block.kind === "paragraph" || block.kind === "caption") && block.text.trim())?.text.trimEnd().slice(-160) || input.previousTranslationTail }, progress.publish, signal);
    signal?.throwIfAborted();
    if (!documentId) return result;
    if ((state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    const persisted = startSpan("storage.persist");
    const revision = result.previousPageRevision;
    let revisionApplied = false;
    if (revision?.page === input.page - 1 && previous && revision.blocks.length) {
      revisionApplied = await saveTranslation(documentId, input.targetLanguage, {
        ...previous, ...revision, markdown: markdown(revision.blocks), isBlank: !hasLayoutContent(revision.blocks),
        sourceSummary: previous.sourceSummary || "", previousPageRevision: null, cacheVersion: version, cachedAt: Date.now(),
      }, previous.cacheVersion ?? 0);
    }
    // A parallel predecessor may still be running or may have changed since this request started.
    // Never deduplicate against a revision that was not actually saved.
    const previousBlocks = revisionApplied ? revision!.blocks
      : input.page > 1 ? (await readTranslation(documentId, input.page - 1, input.targetLanguage))?.blocks : undefined;
    const blocks = previousBlocks ? deduplicatePageBoundary(previousBlocks, result.blocks).blocks : result.blocks;
    const saved = { ...result, blocks, isBlank: !hasLayoutContent(blocks), markdown: markdown(blocks), cacheVersion: version, cachedAt: Date.now(), serverManaged: true };
    if ((state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    signal?.throwIfAborted();
    await saveTranslation(documentId, input.targetLanguage, saved);
    persisted();
    return saved;
  }), Boolean(input.force));
  } catch (error) { queued("error"); throw error; }
  finally { queued(); progress.release(); }
}

async function pagesFor(row: Pick<QueueRow, "document_id" | "target_language">) {
  return (await getStorage().db.prepare("SELECT * FROM translation_queue_pages WHERE document_id = ?1 AND target_language = ?2 ORDER BY page")
    .bind(row.document_id, row.target_language).all<PageRow>()).results;
}

async function summarize(row: QueueRow) {
  const pages = await pagesFor(row);
  const failed = pages.filter((page) => page.error);
  const retrying = failed.filter((page) => page.status !== "failed");
  const retryCount = pages.reduce((count, page) => count + page.retry_count, 0);
  const remaining = pages.filter((page) => page.status !== "failed");
  const status = row.next_page > row.total_pages && !remaining.length ? (failed.length ? "partial" : "completed")
    : pages.some((page) => page.status === "running") ? "running" : retrying.length ? "retrying" : "queued";
  await getStorage().db.prepare(`UPDATE translation_queue SET
    status = CASE WHEN status = 'stopped' OR (status = 'failed' AND ?3 <> 'completed') THEN status ELSE ?3 END,
    error = ?4, retry_count = ?5, retry_at = ?6
    WHERE document_id = ?1 AND target_language = ?2`)
    .bind(row.document_id, row.target_language, status,
      failed.length ? failed.map((page) => `Page ${page.page}: ${page.error}`).join("\n") : null,
      retryCount, retrying.length ? Math.min(...retrying.map((page) => page.retry_at)) : 0).run();
}

function abortPages(documentId: string, language?: string) {
  for (const task of state.active.values()) {
    if (task.documentId === documentId && (!language || task.language === language)) {
      task.controller.abort(new Error("Background translation stopped."));
    }
  }
}

async function reconcileSuccessfulPages(row: QueueRow, currentPage?: number) {
  const pages = await pagesFor(row);
  for (const page of pages.filter((value) => value.error || value.page === currentPage)) {
    let cached = false;
    try { cached = Boolean(await readTranslation(row.document_id, page.page, row.target_language)); }
    catch { /* A malformed cached payload still needs a retry. */ }
    if (cached) await getStorage().db.prepare("DELETE FROM translation_queue_pages WHERE document_id = ?1 AND target_language = ?2 AND page = ?3")
      .bind(row.document_id, row.target_language, page.page).run();
  }
}

async function finishPage(row: QueueRow, page: PageRow, error?: unknown) {
  const { db } = getStorage();
  const current = await db.prepare(`SELECT q.*, b.page_count AS total_pages FROM translation_queue q
    JOIN books b ON b.fingerprint = q.document_id WHERE q.document_id = ?1 AND q.target_language = ?2`)
    .bind(row.document_id, row.target_language).first<QueueRow>();
  if (!current || current.run_id !== row.run_id) return;
  if (error === undefined) {
    await db.prepare("DELETE FROM translation_queue_pages WHERE document_id = ?1 AND target_language = ?2 AND page = ?3")
      .bind(row.document_id, row.target_language, page.page).run();
  } else {
    await reconcileSuccessfulPages(current, page.page);
    const pages = await pagesFor(current);
    const currentPage = pages.find((value) => value.page === page.page);
    if (!currentPage) { await summarize(current); return; }
    const exhausted = currentPage.retry_count >= MAX_PAGE_RETRIES;
    await db.prepare(`UPDATE translation_queue_pages SET status = ?4, retry_count = ?5, retry_at = ?6, error = ?7
      WHERE document_id = ?1 AND target_language = ?2 AND page = ?3`)
      .bind(row.document_id, row.target_language, page.page, exhausted ? "failed" : "retrying",
        exhausted ? page.retry_count : page.retry_count + 1,
        exhausted ? 0 : Date.now() + 1000 * 2 ** page.retry_count,
        error instanceof Error ? error.message : "Translation failed.").run();
    const exhaustedPages = (await pagesFor(current)).filter((value) => value.status === "failed").length;
    if (exhaustedPages >= MAX_FAILED_PAGES) {
      await db.prepare("UPDATE translation_queue SET status = 'failed', run_id = run_id + 1 WHERE document_id = ?1 AND target_language = ?2")
        .bind(row.document_id, row.target_language).run();
      await db.prepare("UPDATE translation_queue_pages SET status = 'queued' WHERE document_id = ?1 AND target_language = ?2 AND status = 'running'")
        .bind(row.document_id, row.target_language).run();
      abortPages(row.document_id, row.target_language);
    }
  }
  await summarize(current);
}

async function pump() {
  return control(async () => {
    const { db } = getStorage();
    await ensureStorageSchema(db);
    const { concurrency } = await getTranslationQueueSettings();
    while (state.active.size < concurrency) {
      const rows = (await db.prepare(`SELECT q.*, b.page_count AS total_pages FROM translation_queue q
        JOIN books b ON b.fingerprint = q.document_id WHERE q.status IN ('queued', 'running', 'retrying')
        ORDER BY (q.error IS NOT NULL) DESC, q.updated_at, q.document_id, q.target_language`).all<QueueRow>()).results;
      let selected: { row: QueueRow; page: PageRow } | undefined;
      for (const row of rows) {
        const pages = await pagesFor(row);
        const occupied = (page: number) => state.active.has(key(row.document_id, page, row.target_language));
        const ready = pages.filter((page) => page.status !== "failed" && !occupied(page.page) && page.retry_at <= Date.now())
          .sort((a, b) => Number(Boolean(b.error)) - Number(Boolean(a.error)) || a.page - b.page)[0];
        if (ready) { selected = { row, page: ready }; break; }
        // Retry recoverable errors first; exhausted pages no longer block later pages.
        if (pages.some((page) => page.error && page.status !== "failed")) continue;
        if (row.next_page <= row.total_pages && !occupied(row.next_page)) {
          const page: PageRow = { page: row.next_page, status: "queued", retry_count: 0, retry_at: 0, error: null };
          await db.prepare("INSERT INTO translation_queue_pages (document_id, target_language, page) VALUES (?1, ?2, ?3)")
            .bind(row.document_id, row.target_language, page.page).run();
          row.next_page++;
          await db.prepare("UPDATE translation_queue SET next_page = ?3 WHERE document_id = ?1 AND target_language = ?2")
            .bind(row.document_id, row.target_language, row.next_page).run();
          selected = { row, page }; break;
        }
        if (!pages.some((page) => page.status !== "failed")) await summarize(row);
      }
      if (!selected) break;
      const { row, page } = selected;
      const taskKey = key(row.document_id, page.page, row.target_language);
      const controller = new AbortController();
      state.active.set(taskKey, { documentId: row.document_id, language: row.target_language, page: page.page, controller });
      await db.prepare("UPDATE translation_queue_pages SET status = 'running' WHERE document_id = ?1 AND target_language = ?2 AND page = ?3")
        .bind(row.document_id, row.target_language, page.page).run();
      await db.prepare("UPDATE translation_queue SET status = 'running', updated_at = ?3 WHERE document_id = ?1 AND target_language = ?2")
        .bind(row.document_id, row.target_language, Date.now()).run();
      const finish = (error?: unknown) => control(async () => {
        try { await finishPage(row, page, error); }
        finally { state.active.delete(taskKey); }
      }).finally(() => { void pump().catch(console.error); });
      void requestPageTranslation({ bookId: row.document_id, page: page.page, totalPages: row.total_pages, targetLanguage: row.target_language,
        contextPages: [page.page - 1, page.page, page.page + 1].filter((value) => value > 0 && value <= row.total_pages),
        translationConcurrency: concurrency }, true, undefined, undefined, controller.signal)
        .then(() => finish(), (error) => finish(error)).catch(console.error);
    }
  });
}

export function startTranslationWorker() {
  if (!state.timer) {
    state.timer = setInterval(() => { void pump().catch(console.error); }, 1000);
    state.timer.unref();
  }
  void pump().catch(console.error);
}

export async function getTranslationQueueSettings() {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  return (await db.prepare("SELECT concurrency FROM translation_queue_settings WHERE id = 1").first<{ concurrency: number }>())!;
}

export async function setTranslationQueueConcurrency(concurrency: number) {
  await control(async () => {
    const { db } = getStorage();
    await ensureStorageSchema(db);
    await db.prepare("UPDATE translation_queue_settings SET concurrency = ?1 WHERE id = 1").bind(concurrency).run();
  });
  startTranslationWorker();
}

export async function enqueueBook(bookId: string, language: string) {
  await control(async () => {
    const { db } = getStorage();
    const book = await findBook(db, bookId);
    if (!book) throw new Error("Book not found.");
    const config = await getAiProviderSettings();
    if (!config?.apiKey || !config.endpoint || !config.model) throw new Error("AI provider is not configured on the server.");
    const result = await db.prepare(`INSERT INTO translation_queue (document_id, target_language, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(document_id, target_language) DO UPDATE SET status = 'queued', error = NULL,
      next_page = CASE WHEN translation_queue.status = 'completed' THEN 1 ELSE translation_queue.next_page END,
      retry_count = 0, retry_at = 0, run_id = translation_queue.run_id + 1,
      updated_at = excluded.updated_at WHERE translation_queue.status IN ('failed', 'completed', 'stopped', 'partial')`)
      .bind(book.fingerprint, language, Date.now()).run();
    if (result.changes) await db.prepare(`UPDATE translation_queue_pages SET status = 'queued', retry_count = 0, retry_at = 0, error = NULL
      WHERE document_id = ?1 AND target_language = ?2`).bind(book.fingerprint, language).run();
  });
  startTranslationWorker();
}

export async function listTranslationQueue(language?: string) {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  return control(async () => {
    // Include pages recovered by foreground reading or an explicit cache update.
    const affected = (await db.prepare(`SELECT q.*, b.page_count AS total_pages FROM translation_queue q
      JOIN books b ON b.fingerprint = q.document_id WHERE q.error IS NOT NULL
      AND (?1 IS NULL OR q.target_language = ?1)`).bind(language ?? null).all<QueueRow>()).results;
    for (const row of affected) {
      await reconcileSuccessfulPages(row);
      await summarize(row);
    }
    const result = await db.prepare(`SELECT q.document_id AS documentId, b.id AS bookId, b.name AS bookName,
      q.target_language AS targetLanguage, q.status, q.error,
      COALESCE((SELECT MIN(p.page) FROM translation_queue_pages p WHERE p.document_id = q.document_id AND p.target_language = q.target_language AND p.status = 'running'),
        (SELECT MIN(p.page) FROM translation_queue_pages p WHERE p.document_id = q.document_id AND p.target_language = q.target_language), q.next_page) AS nextPage,
      (SELECT COUNT(*) FROM translation_queue_pages p WHERE p.document_id = q.document_id AND p.target_language = q.target_language AND p.status = 'running') AS activePages, q.retry_count AS retryCount, q.retry_at AS retryAt,
      b.page_count AS totalPages,
      (SELECT COUNT(DISTINCT t.page) FROM translations t WHERE t.document_id = q.document_id
        AND t.page BETWEEN 1 AND b.page_count AND substr(t.cache_key, -length(?2 || q.target_language)) = ?2 || q.target_language
        AND substr(t.cache_key, 1, length(?3)) = ?3) AS completedPages
      FROM translation_queue q JOIN books b ON b.fingerprint = q.document_id
      WHERE (?1 IS NULL OR q.target_language = ?1)
      ORDER BY CASE q.status WHEN 'running' THEN 0 WHEN 'retrying' THEN 1 WHEN 'queued' THEN 2 WHEN 'failed' THEN 3 WHEN 'stopped' THEN 4 ELSE 5 END,
        q.updated_at, q.document_id, q.target_language`)
      .bind(language ?? null, `::${TRANSLATION_CACHE_SERVER_VERSION}::`, `${TRANSLATION_CACHE_LAYOUT_VERSION}::`).all();
    return Promise.all(result.results.map(async (row) => {
      const pages = await pagesFor({ document_id: String(row.documentId), target_language: String(row.targetLanguage) });
      return { ...row, maxRetriesPerPage: MAX_PAGE_RETRIES, failedPageLimit: MAX_FAILED_PAGES,
        failedPages: pages.filter((page) => page.status === "failed").length,
        pageErrors: pages.filter((page) => page.error).map((page) => ({ page: page.page, status: page.status, retryCount: page.retry_count, error: page.error })),
      };
    }));
  });
}

export async function stopBookTranslation(bookId: string, language: string) {
  await control(async () => {
    const { db } = getStorage();
    const book = await findBook(db, bookId);
    if (!book) throw new Error("Book not found.");
    await db.prepare(`UPDATE translation_queue SET status = 'stopped', retry_at = 0, run_id = run_id + 1
      WHERE document_id = ?1 AND target_language = ?2 AND status IN ('queued', 'running', 'retrying')`)
      .bind(book.fingerprint, language).run();
    await db.prepare("UPDATE translation_queue_pages SET status = 'queued' WHERE document_id = ?1 AND target_language = ?2 AND status = 'running'")
      .bind(book.fingerprint, language).run();
    abortPages(book.fingerprint, language);
  });
}

export async function discardBookTranslationJobs(documentId: string) {
  await control(async () => {
    abortPages(documentId);
    state.generations.set(documentId, (state.generations.get(documentId) || 0) + 1);
    await getStorage().db.prepare("DELETE FROM translation_queue WHERE document_id = ?1").bind(documentId).run();
  });
}
