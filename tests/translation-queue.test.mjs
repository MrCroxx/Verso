import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise the real worker and SQLite storage with a controllable provider.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !path.extname(specifier)) specifier += '.ts';
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/lib/server-translation.ts')) return {
      format: 'module', shortCircuit: true,
      source: 'export const generateTranslation = (...args) => globalThis.queueTestProvider(...args);',
    };
    return nextLoad(url, context);
  },
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async check => {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for translation worker');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const result = page => ({ page, blocks: [], isBlank: true, sourceSummary: '', previousPageRevision: null });

test('translation queue stays consistent with saved history', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'verso-queue-'));
  process.env.VERSO_DATA_DIR = directory;
  const { getStorage, ensureStorageSchema } = await import('../db/books.ts');
  const { translationCacheKey } = await import('../lib/translation-cache.ts');
  const queue = await import('../lib/server-translation-queue.ts');
  const { db } = getStorage();
  await ensureStorageSchema(db);
  t.after(async () => {
    clearInterval(globalThis.versoTranslationWorker.timer);
    delete globalThis.queueTestProvider;
    await rm(directory, { recursive: true, force: true });
  });
  await db.prepare(`INSERT INTO ai_provider_settings
    (id, provider, endpoint, api_key, model, reasoning_effort, updated_at)
    VALUES (1, 'compatible', 'https://example.invalid', 'test', 'test', 'none', 0)`).run();
  await db.prepare('UPDATE translation_queue_settings SET concurrency = 1').run();
  const language = 'Simplified Chinese';
  const book = async (id, pages) => db.prepare(`INSERT INTO books
    (id, fingerprint, name, object_key, size, page_count, content_type, uploaded_at)
    VALUES (?1, ?1, ?1, ?1, 1, ?2, 'application/pdf', 0)`).bind(id, pages).run();
  const save = async (id, page, target = language, key = translationCacheKey(id, page, target)) =>
    db.prepare(`INSERT INTO translations (cache_key, document_id, page, payload, updated_at)
      VALUES (?1, ?2, ?3, ?4, 0)`).bind(key, id, page, JSON.stringify(result(page))).run();
  const job = async id => (await queue.listTranslationQueue()).find(value => value.documentId === id);

  await t.test('repairs legacy Completed entries with missing pages and retries only uncached pages', async () => {
    const id = 'legacy';
    await book(id, 4);
    await save(id, 1);
    await save(id, 2, 'French');
    await save(id, 3, language, `layout-v3::${id}::3::server-v2::${language}`);
    await save(id, 5);
    await db.prepare(`INSERT INTO translation_queue (document_id, target_language, next_page, status, updated_at)
      VALUES (?1, ?2, 5, 'completed', 0)`).bind(id, language).run();
    assert.equal((await job(id)).status, 'partial');
    assert.equal((await job(id)).completedPages, 1);
    const generated = [];
    globalThis.queueTestProvider = async input => { generated.push(input.page); return result(input.page); };
    await queue.enqueueBook(id, language);
    await waitFor(async () => (await job(id)).status === 'completed');
    assert.deepEqual(generated, [2, 3, 4]);
    assert.equal((await job(id)).completedPages, 4);
  });

  await t.test('does not report completion when earlier results disappear during a run', async () => {
    const id = 'missing-history';
    await book(id, 2);
    await save(id, 1);
    const started = deferred();
    const finish = deferred();
    globalThis.queueTestProvider = async input => { started.resolve(); await finish.promise; return result(input.page); };
    await queue.enqueueBook(id, language);
    await started.promise;
    await db.prepare('DELETE FROM translations WHERE document_id = ?1').bind(id).run();
    finish.resolve();
    await waitFor(async () => (await job(id)).activePages === 0);
    assert.equal((await job(id)).status, 'partial');
    assert.equal((await job(id)).completedPages, 1);
  });

  await t.test('rescans partial jobs with both missing history and exhausted page records', async () => {
    const id = 'partial-errors';
    await book(id, 3);
    await save(id, 2);
    await db.prepare(`INSERT INTO translation_queue (document_id, target_language, next_page, status, error, updated_at)
      VALUES (?1, ?2, 4, 'partial', 'Provider failed', 0)`).bind(id, language).run();
    await db.prepare(`INSERT INTO translation_queue_pages (document_id, target_language, page, status, retry_count, error)
      VALUES (?1, ?2, 3, 'failed', 3, 'Provider failed')`).bind(id, language).run();
    const generated = [];
    globalThis.queueTestProvider = async input => { generated.push(input.page); return result(input.page); };
    await queue.enqueueBook(id, language);
    await waitFor(async () => (await job(id)).status === 'completed');
    assert.deepEqual(generated, [1, 3]);
    assert.equal((await job(id)).completedPages, 3);
    assert.deepEqual((await job(id)).pageErrors, []);
  });

  await t.test('discard cancels active work, clears every language, and permits a clean re-enqueue', async () => {
    const id = 'discard';
    await book(id, 3);
    await save(id, 1);
    await save(id, 1, 'French');
    const started = deferred();
    const finish = deferred();
    let oldSignal;
    globalThis.queueTestProvider = async (input, progress, signal) => {
      oldSignal = signal;
      started.resolve();
      await finish.promise;
      return result(input.page);
    };
    await queue.enqueueBook(id, language);
    await started.promise;
    assert.equal(await queue.discardBookTranslations(id), 2);
    assert.equal(oldSignal.aborted, true);
    assert.equal(await job(id), undefined);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM translation_queue_pages WHERE document_id = ?1').bind(id).first()).count, 0);
    // Re-create the queue before the discarded provider returns with its old run_id.
    const generated = [];
    globalThis.queueTestProvider = async input => { generated.push(input.page); return result(input.page); };
    await queue.enqueueBook(id, language);
    finish.resolve();
    await waitFor(async () => (await job(id)).status === 'completed');
    assert.deepEqual(generated, [1, 2, 3]);
    assert.equal((await job(id)).completedPages, 3);
    assert.equal((await job(id)).retryCount, 0);
    assert.deepEqual((await job(id)).pageErrors, []);
  });

  await t.test('discard prevents a late foreground result from restoring history', async () => {
    const id = 'foreground';
    await book(id, 1);
    const started = deferred();
    const finish = deferred();
    globalThis.queueTestProvider = async input => { started.resolve(); await finish.promise; return result(input.page); };
    const translating = queue.requestPageTranslation({ bookId: id, page: 1, totalPages: 1, targetLanguage: language });
    const rejected = assert.rejects(translating, /discarded/);
    await started.promise;
    await queue.discardBookTranslations(id);
    finish.resolve();
    await rejected;
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM translations WHERE document_id = ?1').bind(id).first()).count, 0);
    assert.equal(await job(id), undefined);
  });
});
