import { ensureStorageSchema, findBook, getStorage } from "../db/books";
import { getAiProviderSettings } from "../db/ai-provider-settings";
import { createPriorityTaskQueue } from "./priority-task-queue";
import { generateTranslation, type TranslationRequest } from "./server-translation";
import { deduplicatePageBoundary, hasLayoutContent, normalizeTranslationPayload, type LayoutBlock } from "./translation-layout";
import { extractNavigationObservation } from "./document-navigation";

type Result = Awaited<ReturnType<typeof generateTranslation>> & {
  markdown?: string;
  cacheVersion?: number;
  cachedAt?: number;
  serverManaged?: boolean;
};
type QueueRow = { document_id: string; target_language: string; next_page: number; concurrency: number; status: string; error: string | null };
const globalState = globalThis as typeof globalThis & { versoTranslationWorker?: {
  tasks: ReturnType<typeof createPriorityTaskQueue<Result>>;
  timer?: ReturnType<typeof setInterval>;
  pumping: boolean;
  generations: Map<string, number>;
} };
const state: NonNullable<typeof globalState.versoTranslationWorker> = globalState.versoTranslationWorker ??= { tasks: createPriorityTaskQueue<Result>(), pumping: false, generations: new Map() };

function key(documentId: string, page: number, language: string) {
  return `layout-v3::${documentId}::${page}::server-v1::${language}`;
}

async function readTranslation(documentId: string, page: number, language: string) {
  const { db } = getStorage();
  const row = await db.prepare(`SELECT payload FROM translations WHERE document_id = ?1 AND page = ?2
    AND substr(cache_key, -length(?3)) = ?3
    ORDER BY (cache_key = ?4) DESC, updated_at DESC LIMIT 1`)
    .bind(documentId, page, `::${language}`, key(documentId, page, language)).first<{ payload: string }>();
  return row ? normalizeTranslationPayload(JSON.parse(row.payload)) as Result : null;
}

async function saveTranslation(documentId: string, language: string, translation: Result) {
  const { db } = getStorage();
  await db.prepare(`INSERT INTO translations (cache_key, document_id, page, payload, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET
    payload = excluded.payload, updated_at = excluded.updated_at
    WHERE COALESCE(CAST(json_extract(excluded.payload, '$.cacheVersion') AS INTEGER), 0)
      >= COALESCE(CAST(json_extract(translations.payload, '$.cacheVersion') AS INTEGER), 0)`)
    .bind(key(documentId, translation.page, language), documentId, translation.page, JSON.stringify(translation), Date.now()).run();
  const observation = extractNavigationObservation(translation.page, translation);
  await db.prepare(`INSERT INTO navigation_pages (document_id, pdf_page, is_table_of_contents, toc_entries,
    page_label, page_value, numbering, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(document_id, pdf_page) DO UPDATE SET is_table_of_contents = excluded.is_table_of_contents,
    toc_entries = excluded.toc_entries, page_label = excluded.page_label, page_value = excluded.page_value,
    numbering = excluded.numbering, updated_at = excluded.updated_at`)
    .bind(documentId, translation.page, observation.isTableOfContents ? 1 : 0, JSON.stringify(observation.tocEntries),
      observation.anchor?.label ?? null, observation.anchor?.value ?? null, observation.anchor?.numbering ?? null, Date.now()).run();
}

const markdown = (blocks: LayoutBlock[]) => blocks.filter((block) => block.text).map((block) => block.text).join("\n\n");

export async function requestPageTranslation(input: TranslationRequest, background = false): Promise<Result> {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const book = input.bookId ? await findBook(db, input.bookId) : null;
  if (input.bookId && !book) throw new Error("Book not found.");
  if (book && (input.page > book.pageCount || input.totalPages !== book.pageCount)) throw new Error("Invalid book page.");
  const documentId = book?.fingerprint;
  const generation = documentId ? state.generations.get(documentId) || 0 : 0;
  const taskKey = documentId ? `${key(documentId, input.page, input.targetLanguage)}::${generation}` : crypto.randomUUID();
  return state.tasks.run(taskKey, background ? 0 : 1, input.translationConcurrency || 4, async () => {
    if (documentId && (state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    if (documentId && !input.force) {
      const cached = await readTranslation(documentId, input.page, input.targetLanguage);
      if (cached) return { ...cached, blocks: cached.blocks || [], isBlank: Boolean(cached.isBlank), sourceSummary: cached.sourceSummary || "", previousPageRevision: null, serverManaged: true };
    }
    const previous = documentId && input.page > 1 ? await readTranslation(documentId, input.page - 1, input.targetLanguage) : null;
    const version = Date.now() * 1000;
    const result = await generateTranslation({ ...input, previousTranslationTail: previous?.blocks?.findLast((block) =>
      (block.kind === "paragraph" || block.kind === "caption") && block.text.trim())?.text.trimEnd().slice(-160) || input.previousTranslationTail });
    if (!documentId) return result;
    if ((state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    const revision = result.previousPageRevision;
    if (revision?.page === input.page - 1 && previous && revision.blocks.length) {
      await saveTranslation(documentId, input.targetLanguage, {
        ...previous, ...revision, markdown: markdown(revision.blocks), isBlank: !hasLayoutContent(revision.blocks),
        sourceSummary: previous.sourceSummary || "", previousPageRevision: null, cacheVersion: version, cachedAt: Date.now(),
      });
    }
    const previousBlocks = revision?.page === input.page - 1 ? revision.blocks : previous?.blocks;
    const blocks = previousBlocks ? deduplicatePageBoundary(previousBlocks, result.blocks).blocks : result.blocks;
    const saved = { ...result, blocks, isBlank: !hasLayoutContent(blocks), markdown: markdown(blocks), cacheVersion: version, cachedAt: Date.now(), serverManaged: true };
    if ((state.generations.get(documentId) || 0) !== generation) throw new Error("Translation was discarded.");
    await saveTranslation(documentId, input.targetLanguage, saved);
    return saved;
  }, Boolean(input.force));
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    const { db } = getStorage();
    await ensureStorageSchema(db);
    // Materialize only one background page at a time, even for very large books.
    while (true) {
      const row = await db.prepare("SELECT * FROM translation_queue WHERE status IN ('queued', 'running') ORDER BY updated_at LIMIT 1").first<QueueRow>();
      if (!row) break;
      const generation = state.generations.get(row.document_id) || 0;
      try {
        const book = await findBook(db, row.document_id);
        if (!book) throw new Error("Book not found.");
        if (row.next_page > book.pageCount) {
          await db.prepare("UPDATE translation_queue SET status = 'completed', error = NULL WHERE document_id = ?1 AND target_language = ?2").bind(row.document_id, row.target_language).run();
          continue;
        }
        await db.prepare("UPDATE translation_queue SET status = 'running' WHERE document_id = ?1 AND target_language = ?2").bind(row.document_id, row.target_language).run();
        const page = row.next_page;
        await requestPageTranslation({ bookId: book.fingerprint, page, totalPages: book.pageCount, targetLanguage: row.target_language,
          contextPages: [page - 1, page, page + 1].filter((value) => value > 0 && value <= book.pageCount), translationConcurrency: row.concurrency }, true);
        if ((state.generations.get(row.document_id) || 0) !== generation) continue;
        await db.prepare("UPDATE translation_queue SET next_page = ?3, updated_at = ?4 WHERE document_id = ?1 AND target_language = ?2")
          .bind(row.document_id, row.target_language, page + 1, Date.now()).run();
      } catch (error) {
        if ((state.generations.get(row.document_id) || 0) !== generation) continue;
        await db.prepare("UPDATE translation_queue SET status = 'failed', error = ?3 WHERE document_id = ?1 AND target_language = ?2")
          .bind(row.document_id, row.target_language, error instanceof Error ? error.message : "Translation failed.").run();
      }
    }
  } finally { state.pumping = false; }
}

export function startTranslationWorker() {
  if (!state.timer) {
    state.timer = setInterval(() => { void pump().catch(console.error); }, 1000);
    state.timer.unref();
  }
  void pump().catch(console.error);
}

export async function enqueueBook(bookId: string, language: string, concurrency: number) {
  const { db } = getStorage();
  const book = await findBook(db, bookId);
  if (!book) throw new Error("Book not found.");
  const config = await getAiProviderSettings();
  if (!config?.apiKey || !config.endpoint || !config.model) throw new Error("AI provider is not configured on the server.");
  await db.prepare(`INSERT INTO translation_queue (document_id, target_language, concurrency, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(document_id, target_language) DO UPDATE SET status = 'queued', error = NULL, next_page = 1,
    concurrency = excluded.concurrency, updated_at = excluded.updated_at WHERE translation_queue.status IN ('failed', 'completed')`)
    .bind(book.fingerprint, language, concurrency, Date.now()).run();
  startTranslationWorker();
}

export async function listTranslationQueue(language: string) {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const result = await db.prepare(`SELECT q.document_id AS documentId, q.status, q.error, b.page_count AS totalPages,
    (SELECT COUNT(DISTINCT t.page) FROM translations t WHERE t.document_id = q.document_id
      AND t.page BETWEEN 1 AND b.page_count AND substr(t.cache_key, -length(?2)) = ?2) AS completedPages
    FROM translation_queue q JOIN books b ON b.fingerprint = q.document_id WHERE q.target_language = ?1`)
    .bind(language, `::${language}`).all();
  return result.results;
}

export async function discardBookTranslationJobs(documentId: string) {
  state.generations.set(documentId, (state.generations.get(documentId) || 0) + 1);
  await getStorage().db.prepare("DELETE FROM translation_queue WHERE document_id = ?1").bind(documentId).run();
}
