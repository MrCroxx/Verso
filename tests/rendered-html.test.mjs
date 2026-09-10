import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createLocalPdfRangeTransport } from "../lib/local-pdf-range-transport.ts";
import { createConcurrencyLimiter } from "../lib/concurrency-limiter.ts";
import { isDocumentSearchShortcut } from "../lib/keyboard-shortcuts.ts";
import { createLatestTaskRegistry } from "../lib/latest-task-registry.ts";
import {
  calculatePageOffset,
  extractNavigationObservation,
  parsePageReference,
  resolveTocEntryPage,
} from "../lib/document-navigation.ts";
import { deduplicatePageBoundary, normalizeSourceRect, normalizeTranslationPayload } from "../lib/translation-layout.ts";
import { searchTranslationPayload } from "../lib/translation-search.ts";
import { typewriterDuration, typewriterProgress } from "../lib/translation-typewriter.ts";
import { resolveUiLocale, UI_LOCALE_COOKIE } from "../lib/ui-locale.ts";
import { isPageWorkEnabled, pageWorkWindow, shouldStartTranslationRequest } from "../lib/viewport-work.ts";
import nextConfig from "../next.config.ts";

let baseUrl;
let serverProcess;
let testDataDirectory;
let rendererLogPath;

before(async () => {
  testDataDirectory = await mkdtemp(path.join(tmpdir(), "verso-test-"));
  const rendererPath = path.join(testDataDirectory, "pdftocairo");
  rendererLogPath = path.join(testDataDirectory, "renderer.log");
  await writeFile(rendererPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const outputPrefix = process.argv.at(-1);
if (!outputPrefix) process.exit(2);
writeFileSync(outputPrefix + ".jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
if (process.env.VERSO_PDF_RENDERER_LOG) {
  appendFileSync(process.env.VERSO_PDF_RENDERER_LOG, process.argv.join(" ") + "\\n");
}
`);
  await chmod(rendererPath, 0o700);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      VERSO_DATA_DIR: testDataDirectory,
      VERSO_AI_API_KEY: "ignored-environment-key",
      OPENAI_API_KEY: "ignored-environment-fallback",
      VERSO_PDF_RENDERER_LOG: rendererLogPath,
      PATH: `${testDataDirectory}:${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/books`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start.");
});

after(async () => {
  serverProcess?.kill("SIGTERM");
  await rm(testDataDirectory, { recursive: true, force: true });
});

async function render(path = "/", headers = {}) {
  return fetch(`${baseUrl}${path}`, { headers: { accept: "text/html", ...headers } });
}

test("does not open local storage while server modules load", async () => {
  const importDataDirectory = path.join(testDataDirectory, "module-import-only");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", "await import('./db/books.ts')"], {
      cwd: process.cwd(),
      env: { ...process.env, VERSO_DATA_DIR: importDataDirectory },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Module import exited with ${code}.`)));
  });
  await assert.rejects(access(importDataDirectory), { code: "ENOENT" });
});

test("allows development access through homelab proxies", () => {
  assert.deepEqual(nextConfig.allowedDevOrigins, ["homelab", "**.*"]);
});

test("excludes volume-backed storage from the standalone build", () => {
  assert.deepEqual(nextConfig.outputFileTracingExcludes, { "/*": [".data/**/*"] });
});

test("server-renders the Verso library home", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Verso — AI Parallel Reader<\/title>/i);
  assert.match(html, /<html lang="en-US">/i);
  assert.match(html, /Verso/);
  assert.match(html, /AI Reader/);
  assert.match(html, /Your library/);
  assert.match(html, /Upload a new PDF/);
  assert.match(html, /Local Library/);
  assert.match(html, /Toggle light or dark mode/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders the preferred interface locale without a hydration switch", async () => {
  const chineseResponse = await render("/", { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
  const chineseHtml = await chineseResponse.text();
  assert.match(chineseHtml, /<html lang="zh-CN">/i);
  assert.match(chineseHtml, /上传新 PDF/);

  const savedEnglishResponse = await render("/", {
    "accept-language": "zh-CN,zh;q=0.9",
    cookie: `${UI_LOCALE_COOKIE}=en-US`,
  });
  const savedEnglishHtml = await savedEnglishResponse.text();
  assert.match(savedEnglishHtml, /<html lang="en-US">/i);
  assert.match(savedEnglishHtml, /Upload a new PDF/);
});

test("resolves an explicit locale before the best supported browser language", () => {
  assert.equal(resolveUiLocale("en-US", "zh-CN,zh;q=0.9"), "en-US");
  assert.equal(resolveUiLocale(undefined, "fr-FR,zh-CN;q=0.8,en-US;q=0.6"), "zh-CN");
  assert.equal(resolveUiLocale(undefined, "fr-FR"), "en-US");
});

test("rejects incomplete translation requests", async () => {
  const response = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Missing target language, page metadata, or page images." });
});

test("ignores provider environment variables and reports SQLite settings without credentials", async () => {
  const response = await fetch(`${baseUrl}/api/settings/ai-provider`, { cache: "no-store" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), {
    provider: "openai",
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    updatedAt: 0,
    configured: false,
    apiKeyConfigured: false,
    apiKeyHint: "",
  });
});

test("does not use provider credentials from environment variables for translation", async () => {
  const response = await fetch(`${baseUrl}/api/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetLanguage: "English",
      page: 1,
      totalPages: 1,
      images: [{ page: 1, dataUrl: "data:image/png;base64,AA==" }],
    }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "AI provider is not configured on the server." });
});

test("stores AI provider settings in SQLite without returning the API key", async () => {
  const apiKey = "test-server-only-secret-1234";
  const saveResponse = await fetch(`${baseUrl}/api/settings/ai-provider`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "compatible",
      endpoint: "http://127.0.0.1:9/v1",
      apiKey,
      model: "test-model",
      reasoningEffort: "low",
    }),
  });
  assert.equal(saveResponse.status, 200);
  const savedText = await saveResponse.text();
  assert.doesNotMatch(savedText, new RegExp(apiKey));
  const saved = JSON.parse(savedText);
  assert.equal(saved.configured, true);
  assert.equal(saved.apiKeyConfigured, true);
  assert.equal(saved.apiKeyHint, "••••1234");
  assert.equal("apiKey" in saved, false);

  const updateResponse = await fetch(`${baseUrl}/api/settings/ai-provider`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "compatible",
      endpoint: "http://127.0.0.1:9/v1",
      model: "test-model-v2",
      reasoningEffort: "medium",
    }),
  });
  assert.equal(updateResponse.status, 200);

  const readResponse = await fetch(`${baseUrl}/api/settings/ai-provider`, { cache: "no-store" });
  const readText = await readResponse.text();
  assert.doesNotMatch(readText, new RegExp(apiKey));
  const settings = JSON.parse(readText);
  assert.equal(settings.model, "test-model-v2");
  assert.equal(settings.apiKeyHint, "••••1234");
  assert.equal("apiKey" in settings, false);

  const database = await stat(path.join(testDataDirectory, "verso.sqlite"));
  assert.equal(database.mode & 0o777, 0o600);
});

test("rejects incomplete search requests", async () => {
  const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: "book", query: "" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid search request." });
});

test("rejects incomplete translation cache index requests", async () => {
  const response = await fetch(`${baseUrl}/api/translations?documentId=book`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid translation cache index request." });
});

test("discards only the requested book translation cache", async () => {
  const firstDocumentId = "discard-cache-book";
  const secondDocumentId = "preserved-cache-book";
  const entries = [
    { documentId: firstDocumentId, page: 1 },
    { documentId: firstDocumentId, page: 2 },
    { documentId: secondDocumentId, page: 1 },
  ];
  for (const entry of entries) {
    const key = `layout-v3::${entry.documentId}::${entry.page}::server-v1::English`;
    const response = await fetch(`${baseUrl}/api/translations`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        documentId: entry.documentId,
        page: entry.page,
        translation: {
          page: entry.page,
          markdown: `${entry.documentId} page ${entry.page}`,
          cachedAt: 1,
        },
      }),
    });
    assert.equal(response.status, 200);
  }

  const deleteResponse = await fetch(
    `${baseUrl}/api/translations?documentId=${encodeURIComponent(firstDocumentId)}`,
    { method: "DELETE" },
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: 2 });

  for (const entry of entries) {
    const key = `layout-v3::${entry.documentId}::${entry.page}::server-v1::English`;
    const response = await fetch(`${baseUrl}/api/translations?key=${encodeURIComponent(key)}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Boolean(result.translation), entry.documentId === secondDocumentId);
  }
});

test("rejects translation cache deletion without a document ID", async () => {
  const response = await fetch(`${baseUrl}/api/translations`, { method: "DELETE" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid document ID." });
});

test("keeps legacy browser-provider translations readable after server migration", async () => {
  const documentId = "legacy-provider-book";
  const language = "Simplified Chinese";
  const legacyKey = `layout-v3::${documentId}::3::openai::https://api.openai.com/v1/responses::old-model::medium::${language}`;
  const newKey = `layout-v3::${documentId}::3::server-v1::${language}`;
  const translation = {
    page: 3,
    markdown: "Preserved translation",
    blocks: [{ kind: "paragraph", text: "Preserved translation" }],
    cachedAt: 1,
  };
  const putResponse = await fetch(`${baseUrl}/api/translations`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: legacyKey, documentId, page: 3, translation }),
  });
  assert.equal(putResponse.status, 200);

  const fallbackQuery = new URLSearchParams({
    key: newKey,
    documentId,
    page: "3",
    fallbackCacheKeySuffix: language,
  });
  const readResponse = await fetch(`${baseUrl}/api/translations?${fallbackQuery}`);
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json()).translation.markdown, "Preserved translation");

  const indexQuery = new URLSearchParams({
    documentId,
    cacheKeySuffix: `server-v1::${language}`,
    fallbackCacheKeySuffix: language,
  });
  const indexResponse = await fetch(`${baseUrl}/api/translations?${indexQuery}`);
  assert.deepEqual((await indexResponse.json()).pages, [3]);

  const searchResponse = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documentId,
      query: "Preserved",
      cacheKeySuffix: `server-v1::${language}`,
      fallbackCacheKeySuffix: language,
    }),
  });
  assert.equal(searchResponse.status, 200);
  assert.deepEqual((await searchResponse.json()).matches.map(({ page }) => page), [3]);
});

test("searches translated blocks without matching source text", () => {
  const payload = {
    sourceText: "A patient reader gives an argument time to arrive.",
    blocks: [{ kind: "paragraph", text: "耐心的读者愿意等待论证逐渐展开。" }],
  };
  const sourceMatches = searchTranslationPayload(payload, 7, "patient");
  const translatedMatches = searchTranslationPayload(payload, 7, "耐心");

  assert.deepEqual(sourceMatches, []);
  assert.deepEqual(translatedMatches.map(({ page }) => page), [7]);
  assert.match(translatedMatches[0].snippet, /耐心/);
});

test("recognizes browser find shortcuts without hijacking modified keys", () => {
  assert.equal(isDocumentSearchShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false }), true);
  assert.equal(isDocumentSearchShortcut({ key: "F", ctrlKey: false, metaKey: true, altKey: false }), true);
  assert.equal(isDocumentSearchShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: true }), false);
  assert.equal(isDocumentSearchShortcut({ key: "g", ctrlKey: true, metaKey: false, altKey: false }), false);
});

test("reveals translations at a stable characters-per-second rate", () => {
  assert.equal(typewriterDuration(80), 1000);
  assert.equal(typewriterDuration(50, 50), 1000);
  assert.equal(typewriterDuration(500, 50), 10_000);
  assert.equal(typewriterProgress(0, 100, 50), 0);
  assert.equal(typewriterProgress(500, 100, 50), 25);
  assert.equal(typewriterProgress(1000, 100, 50), 50);
  assert.equal(typewriterProgress(2000, 100, 50), 100);
  assert.equal(typewriterProgress(10_000, 100, 50), 100);
});

test("rejects navigation requests without a document ID", async () => {
  const response = await fetch(`${baseUrl}/api/navigation`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid document ID." });
});

test("stores a multipart PDF locally and serves bounded byte ranges", async () => {
  const fingerprint = "a".repeat(64);
  const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
  bytes.set(new TextEncoder().encode("%PDF-local-test"));
  const metadata = {
    fingerprint,
    name: "book.pdf",
    size: bytes.byteLength,
    pageCount: 1,
    contentType: "application/pdf",
  };
  const initialize = await fetch(`${baseUrl}/api/books/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const session = await initialize.json();
  assert.equal(initialize.status, 200);
  assert.equal(session.exists, false);

  const partResponse = await fetch(`${baseUrl}/api/books/uploads/${session.uploadId}/parts/1`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-object-key": session.objectKey },
    body: bytes,
  });
  const part = await partResponse.json();
  assert.equal(partResponse.status, 200);

  const complete = await fetch(`${baseUrl}/api/books/uploads/${session.uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...metadata, objectKey: session.objectKey, parts: [part] }),
  });
  assert.equal(complete.status, 200);

  const fullResponse = await fetch(`${baseUrl}/api/books/${fingerprint}/file`);
  assert.equal(fullResponse.status, 400);

  const rangeResponse = await fetch(`${baseUrl}/api/books/${fingerprint}/file`, {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-3/${bytes.byteLength}`);
  assert.match(rangeResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.match(rangeResponse.headers.get("vary") ?? "", /Range/i);
  assert.equal(await rangeResponse.text(), "%PDF");

  const oversizedResponse = await fetch(`${baseUrl}/api/books/${fingerprint}/file`, {
    headers: { range: `bytes=0-${2 * 1024 * 1024}` },
  });
  assert.equal(oversizedResponse.status, 416);

  const firstPageImage = await fetch(`${baseUrl}/api/books/${fingerprint}/pages/1?profile=display`);
  assert.equal(firstPageImage.status, 200);
  assert.equal(firstPageImage.headers.get("content-type"), "image/jpeg");
  assert.equal(firstPageImage.headers.get("x-verso-render-cache"), "MISS");
  assert.match(firstPageImage.headers.get("cache-control") ?? "", /immutable/);
  assert.deepEqual(new Uint8Array(await firstPageImage.arrayBuffer()), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

  const cachedPageImage = await fetch(`${baseUrl}/api/books/${fingerprint}/pages/1?profile=display`);
  assert.equal(cachedPageImage.status, 200);
  assert.equal(cachedPageImage.headers.get("x-verso-render-cache"), "HIT");
  const pageEtag = cachedPageImage.headers.get("etag");
  assert.ok(pageEtag);

  const notModifiedPageImage = await fetch(`${baseUrl}/api/books/${fingerprint}/pages/1?profile=display`, {
    headers: { "if-none-match": pageEtag },
  });
  assert.equal(notModifiedPageImage.status, 304);

  const thumbnailImage = await fetch(`${baseUrl}/api/books/${fingerprint}/pages/1?profile=thumbnail`);
  assert.equal(thumbnailImage.status, 200);
  assert.equal(thumbnailImage.headers.get("content-type"), "image/jpeg");
  const invalidPage = await fetch(`${baseUrl}/api/books/${fingerprint}/pages/2?profile=display`);
  assert.equal(invalidPage.status, 400);

  const visionUrl = `${baseUrl}/api/books/${fingerprint}/pages/1?profile=vision`;
  const concurrentVisionImages = await Promise.all([fetch(visionUrl), fetch(visionUrl)]);
  assert.ok(concurrentVisionImages.every((response) => response.status === 200));
  assert.ok(concurrentVisionImages.some((response) => response.headers.get("x-verso-render-cache") === "MISS"));
  const cachedVisionImage = await fetch(visionUrl);
  assert.equal(cachedVisionImage.headers.get("x-verso-render-cache"), "HIT");

  const rendererInvocations = (await readFile(rendererLogPath, "utf8")).trim().split("\n");
  assert.equal(rendererInvocations.length, 3);
});

test("preserves list markers and trailing page references from compatible providers", () => {
  const translation = normalizeTranslationPayload({
    blocks: [{
      type: "list_item",
      text: "电影放映的开端",
      marker: "1 /",
      trailing: "3",
      align: "center",
      indent: 1,
      spaceBefore: "sm",
      size: "md",
    }],
  });

  assert.deepEqual(translation.blocks[0], {
    kind: "list_item",
    text: "电影放映的开端",
    marker: "1 /",
    trailing: "3",
    align: "center",
    indent: 1,
    spaceBefore: "sm",
    size: "md",
  });
});

test("marks an empty translation as a cacheable blank page", () => {
  const translation = normalizeTranslationPayload({
    page: 12,
    markdown: "",
    blocks: [],
    cachedAt: 123,
  });

  assert.equal(translation.isBlank, true);
  assert.deepEqual(translation.blocks, []);
});

test("removes a repeated CJK fragment across a page boundary", () => {
  const previous = [{
    kind: "paragraph",
    text: "这两种潮流在人文学科中引入“症候式",
  }, {
    kind: "page_number",
    text: "ix",
  }];
  const current = [{
    kind: "heading",
    text: "x / Preface",
  }, {
    kind: "paragraph",
    text: "“症候式解读”和宏大理论引入其他领域。",
  }];

  const result = deduplicatePageBoundary(previous, current);

  assert.equal(result.removedText, "“症候式");
  assert.equal(result.blocks[1].text, "解读”和宏大理论引入其他领域。");
});

test("keeps repeated text after a completed sentence", () => {
  const previous = [{ kind: "paragraph", text: "The interpretation is complete." }];
  const current = [{ kind: "paragraph", text: "complete. A new section begins here." }];

  const result = deduplicatePageBoundary(previous, current);

  assert.equal(result.removedText, "");
  assert.equal(result.blocks[0].text, "complete. A new section begins here.");
});

test("keeps short ambiguous boundary matches", () => {
  const previous = [{ kind: "paragraph", text: "上一页末尾的" }];
  const current = [{ kind: "paragraph", text: "的确，这是新一页。" }];

  const result = deduplicatePageBoundary(previous, current);

  assert.equal(result.removedText, "");
});

test("runs translation work with bounded parallelism", async () => {
  const limiter = createConcurrencyLimiter();
  let active = 0;
  let maximumActive = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const tasks = Array.from({ length: 7 }, () => limiter.run(4, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  assert.equal(maximumActive, 4);
  release();
  await Promise.all(tasks);
  assert.equal(maximumActive, 4);
});

test("removes cancelled translation work from the concurrency queue", async () => {
  const limiter = createConcurrencyLimiter();
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = limiter.run(1, async () => firstGate);
  await new Promise((resolve) => setImmediate(resolve));

  const controller = new AbortController();
  let cancelledTaskRan = false;
  const cancelled = limiter.run(1, async () => {
    cancelledTaskRan = true;
  }, controller.signal);
  controller.abort();

  await assert.rejects(cancelled, { name: "AbortError" });
  releaseFirst();
  await first;
  await limiter.run(1, async () => undefined);
  assert.equal(cancelledTaskRan, false);
});

test("keeps a restarted translation current when the cancelled run finishes", () => {
  const registry = createLatestTaskRegistry();
  const first = registry.start("book:12");
  assert.ok(first);
  assert.equal(registry.start("book:12"), null);

  registry.cancel("book:12");
  const restarted = registry.start("book:12");
  assert.ok(restarted);
  assert.equal(registry.finish("book:12", first), false);
  assert.equal(registry.isCurrent("book:12", restarted), true);
  assert.equal(registry.finish("book:12", restarted), true);
});

test("loads local PDFs only through bounded explicit range requests", async () => {
  class TestRangeTransport {
    constructor(length, initialData, progressiveDone, filename) {
      this.length = length;
      this.initialData = initialData;
      this.progressiveDone = progressiveDone;
      this.filename = filename;
    }

    onDataRange() {}
  }

  const data = new Uint8Array(8 * 1024).map((_, index) => index % 251);
  const requestedRanges = [];
  let active = 0;
  let maximumActive = 0;
  const fetcher = async (_url, init) => {
    const range = new Headers(init?.headers).get("range");
    assert.ok(range, "Every local PDF request must include a Range header.");
    assert.equal(init?.cache, "no-store");
    requestedRanges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const begin = Number(match[1]);
    const end = Number(match[2]);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(data.slice(begin, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${begin}-${end}/${data.byteLength}` },
    });
  };
  const { transport, failure } = createLocalPdfRangeTransport({
    Transport: TestRangeTransport,
    url: "/api/books/book-1/file",
    length: data.byteLength,
    filename: "book.pdf",
    fetcher,
  });
  const received = [];
  const complete = new Promise((resolve) => {
    transport.onDataRange = (begin, bytes) => {
      received.push({ begin, bytes });
      if (received.length === 5) resolve();
    };
  });

  for (let index = 0; index < 5; index += 1) {
    transport.requestDataRange(index * 1024, (index + 1) * 1024);
  }
  await Promise.race([complete, failure]);

  assert.equal(maximumActive, 1);
  assert.equal(requestedRanges.length, 5);
  assert.ok(requestedRanges.every((range) => range.startsWith("bytes=")));
  assert.deepEqual(received.map(({ begin, bytes }) => [begin, bytes.byteLength]), [
    [0, 1024],
    [1024, 1024],
    [2048, 1024],
    [3072, 1024],
    [4096, 1024],
  ]);
});

test("enables page work only after navigation settles and inside the active window", () => {
  assert.equal(isPageWorkEnabled(200, 200, 2, false), false);
  assert.equal(isPageWorkEnabled(198, 200, 2, true), true);
  assert.equal(isPageWorkEnabled(202, 200, 2, true), true);
  assert.equal(isPageWorkEnabled(197, 200, 2, true), false);
  assert.equal(isPageWorkEnabled(203, 200, 2, true), false);
});

test("anchors the prefetch window to the currently visible page", () => {
  assert.deepEqual(pageWorkWindow(200, 410, 2), [198, 199, 200, 201, 202]);
  assert.deepEqual(pageWorkWindow(1, 410, 2), [1, 2, 3]);
  assert.deepEqual(pageWorkWindow(410, 410, 2), [408, 409, 410]);
});

test("does not replace an in-memory API translation with its cloud cache copy", () => {
  assert.equal(shouldStartTranslationRequest(false, true, false, false, true), false);
  assert.equal(shouldStartTranslationRequest(false, true, false, true, true), false);
  assert.equal(shouldStartTranslationRequest(false, true, true, false, true), true);
});

test("allows bounded cache and API prefetch after the viewport settles", () => {
  assert.equal(shouldStartTranslationRequest(false, false, false, true, true), true);
  assert.equal(shouldStartTranslationRequest(false, false, false, false, true), true);
  assert.equal(shouldStartTranslationRequest(false, false, false, false, false), false);
});

test("detects a translated table of contents and preserves page references", () => {
  const observation = extractNavigationObservation(7, [
    { kind: "heading", text: "目录" },
    { kind: "list_item", marker: "1 /", text: "The Movie Show Begins", trailing: "3", indent: 0 },
    { kind: "list_item", marker: "2 /", text: "The Nickelodeon Era", trailing: "18", indent: 1 },
  ]);

  assert.equal(observation.isTableOfContents, true);
  assert.deepEqual(observation.tocEntries.map((entry) => ({ title: entry.title, label: entry.label, value: entry.value, level: entry.level })), [
    { title: "1 / The Movie Show Begins", label: "3", value: 3, level: 0 },
    { title: "2 / The Nickelodeon Era", label: "18", value: 18, level: 1 },
  ]);
});

test("does not treat a short numbered list as a table of contents", () => {
  const observation = extractNavigationObservation(12, [
    { kind: "list_item", text: "First reason", trailing: "1" },
    { kind: "list_item", text: "Second reason", trailing: "2" },
  ]);

  assert.equal(observation.isTableOfContents, false);
  assert.deepEqual(observation.tocEntries, []);
});

test("parses roman page labels and resolves a robust PDF page offset", () => {
  assert.deepEqual(parsePageReference("xvii"), { label: "xvii", value: 17, numbering: "roman" });
  const anchors = [
    { pdfPage: 20, label: "1", value: 1, numbering: "arabic" },
    { pdfPage: 37, label: "18", value: 18, numbering: "arabic" },
    { pdfPage: 99, label: "34", value: 34, numbering: "arabic" },
  ];
  assert.equal(calculatePageOffset(anchors), 19);
  assert.deepEqual(resolveTocEntryPage({
    sourcePage: 7,
    ordinal: 0,
    title: "The Nickelodeon Era",
    label: "18",
    value: 18,
    numbering: "arabic",
    level: 0,
  }, anchors, null, 410), { page: 37, offset: 19, calibrated: true });
});

test("uses a manual page offset when automatic calibration needs correction", () => {
  const result = resolveTocEntryPage({
    sourcePage: 7,
    ordinal: 0,
    title: "The Movie Show Begins",
    label: "3",
    value: 3,
    numbering: "arabic",
    level: 0,
  }, [], 21, 410);

  assert.deepEqual(result, { page: 24, offset: 21, calibrated: true });
});

test("validates scan coordinates before cropping or highlighting", () => {
  for (const rect of [null, {}, { x: NaN, y: 0, width: 0.1, height: 0.1 },
    { x: -0.1, y: 0, width: 0.1, height: 0.1 }, { x: 100, y: 20, width: 30, height: 10 },
    { x: 0, y: 0, width: 0, height: 0.1 }, { x: 0, y: 0, width: Infinity, height: 0.1 }]) {
    assert.equal(normalizeSourceRect(rect), undefined);
  }
  const clipped = normalizeSourceRect({ x: 0.9, y: 0.8, width: 0.2, height: 0.3 });
  assert.equal(clipped.x + clipped.width, 1);
  assert.equal(clipped.y + clipped.height, 1);
});

test("preserves image-only pages even when a stale blank flag is present", () => {
  const sourceRect = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
  const translation = normalizeTranslationPayload({ isBlank: true, blocks: [{ kind: "image", sourceRect }] });
  assert.equal(translation.isBlank, false);
  assert.equal(translation.blocks[0].kind, "image");
  assert.deepEqual(translation.blocks[0].sourceRect, sourceRect);
  assert.equal(normalizeTranslationPayload({ blocks: [{ kind: "image" }] }).isBlank, true);
});

test("keeps typography and multi-line sentence mappings without losing translated text", () => {
  const sourceRects = [{ x: 0.1, y: 0.2, width: 0.7, height: 0.02 }, { x: 0.1, y: 0.23, width: 0.3, height: 0.02 }];
  const sentences = [
    { text: "第一句。", sourceText: "First sentence.", sourceRects },
    { text: " 第二句。", sourceText: "Second sentence.", sourceRects: [sourceRects[1]] },
  ];
  const block = { kind: "paragraph", text: "第一句。 第二句。", fontSize: 0.026, sentences };
  const translation = normalizeTranslationPayload({ blocks: [block] });
  assert.equal(translation.blocks[0].fontSize, 0.026);
  assert.deepEqual(translation.blocks[0].sentences, sentences);
  const malformed = normalizeTranslationPayload({ blocks: [{ ...block, fontSize: 26, sentences: [sentences[1]] }] });
  assert.equal(malformed.blocks[0].text, block.text);
  assert.equal(malformed.blocks[0].sentences, undefined);
  assert.equal(malformed.blocks[0].fontSize, undefined);
});

test("retains sentence ownership when trimming a repeated page-boundary fragment", () => {
  const sourceRects = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }];
  const current = [{ kind: "paragraph", text: "“症候式解读”。下一句。", sentences: [
    { text: "“症候式解读”。", sourceText: "reading continuation", sourceRects },
    { text: "下一句。", sourceText: "Next sentence.", sourceRects },
  ] }];
  const result = deduplicatePageBoundary([{ kind: "paragraph", text: "上一页“症候式" }], current);
  assert.equal(result.blocks[0].text, "解读”。下一句。");
  assert.equal(result.blocks[0].sentences.map((sentence) => sentence.text).join(""), result.blocks[0].text);
  assert.deepEqual(result.blocks[0].sentences[0].sourceRects, sourceRects);
  assert.equal(result.blocks[0].sentences[1].sourceText, "Next sentence.");
});

test("requests and persists image crops, typography, and sentence positions with both provider formats", async () => {
  const rect = { x: 0.15, y: 0.25, width: 0.6, height: 0.04 };
  const textBlock = {
    kind: "paragraph", text: "译文。", marker: "", trailing: "", align: "left", indent: 0,
    spaceBefore: "sm", size: "md", fontSize: 0.025, sourceRect: rect,
    sentences: [{ text: "译文。", sourceText: "Source sentence.", sourceRects: [rect] }],
  };
  const imageBlock = {
    ...textBlock, kind: "image", text: "", fontSize: null, sentences: [],
    sourceRect: { x: 0.1, y: 0.4, width: 0.8, height: 0.3 },
  };
  let incoming;
  const providerResult = { page: 2, blocks: [textBlock, imageBlock], sourceSummary: "", previousPageRevision: { page: 1, blocks: [textBlock, imageBlock] } };
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    incoming = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(incoming.input
      ? { output_text: JSON.stringify(providerResult) }
      : { choices: [{ message: { content: JSON.stringify(providerResult) } }] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    for (const format of ["openai", "compatible"]) {
      const settings = await fetch(`${baseUrl}/api/settings/ai-provider`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: format, endpoint: `http://127.0.0.1:${provider.address().port}/${format === "openai" ? "responses" : "v1"}`, apiKey: "test-key", model: "vision-test", reasoningEffort: "none" }),
      });
      assert.equal(settings.status, 200);
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "Simplified Chinese", page: 2, totalPages: 2, images: [1, 2].map((page) => ({ page, dataUrl: "data:image/png;base64,AA==" })) }),
      });
      assert.equal(response.status, 200);
      const translation = await response.json();
      assert.equal(translation.isBlank, false);
      assert.deepEqual(translation.blocks[0].sentences, textBlock.sentences);
      assert.equal(translation.blocks[0].fontSize, 0.025);
      assert.deepEqual(translation.blocks[1].sourceRect, imageBlock.sourceRect);
      assert.deepEqual(translation.previousPageRevision.blocks, translation.blocks);
      const instruction = (incoming.input || incoming.messages)[0].content[0].text;
      assert.match(instruction, /one rectangle per line fragment/);
      assert.match(instruction, /"sourceRects"/);
      assert.match(instruction, /"fontSize"/);
      if (format === "openai") {
        const blockSchema = incoming.text.format.schema.properties.blocks.items;
        assert.ok(blockSchema.required.includes("sentences"));
        assert.ok(blockSchema.properties.kind.enum.includes("image"));
      }
      const key = `layout-v3::aligned-${format}::2::server-v1::Simplified Chinese`;
      const saved = await fetch(`${baseUrl}/api/translations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, documentId: `aligned-${format}`, page: 2, translation }),
      });
      assert.equal(saved.status, 200);
      const cached = await (await fetch(`${baseUrl}/api/translations?key=${encodeURIComponent(key)}`)).json();
      assert.deepEqual(cached.translation.blocks, translation.blocks);
      assert.equal(searchTranslationPayload(cached.translation, 2, "译文").length, 1);
    }
  } finally {
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("grounds sentence highlights in PDF words instead of estimated model rectangles", async () => {
  const { parsePdfWordLayout, alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const layout = parsePdfWordLayout(`<page width="600" height="800"><line>
    <word xMin="72" yMin="80" xMax="100" yMax="92">First</word>
    <word xMin="105" yMin="80" xMax="160" yMax="92">sentence.</word>
    <word xMin="170" yMin="80" xMax="210" yMax="92">Second</word></line><line>
    <word xMin="72" yMin="100" xMax="130" yMax="112">sentence.</word></line></page>`);
  const block = normalizeTranslationPayload({ blocks: [{ text: "第一句。第二句。", fontSize: 0.013, sentences: [
    { text: "第一句。", sourceText: "First sentence.", sourceRects: [{ x: 0.08, y: 0.1, width: 0.84, height: 0.02 }] },
    { text: "第二句。", sourceText: "Second sentence.", sourceRects: [] },
  ] }] }).blocks;
  const aligned = alignSourceBlocks(block, layout)[0];
  assert.deepEqual(aligned.sentences[0].sourceRects, [{ x: 0.12, y: 0.1, width: 160 / 600 - 0.12, height: 0.015 }]);
  assert.equal(aligned.sentences[1].sourceRects.length, 2);
  assert.equal(aligned.sentences[1].sourceRects[0].x, 170 / 600);
  assert.equal(aligned.fontSize, 0.02);
});

test("aligns ligatures and hyphenated line breaks and refuses ungrounded text", async () => {
  const { parsePdfWordLayout, alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const layout = parsePdfWordLayout(`<page width="600" height="800"><line>
    <word xMin="60" yMin="80" xMax="120" yMax="92">efﬁcient</word>
    <word xMin="125" yMin="80" xMax="160" yMax="92">pre-</word></line><line>
    <word xMin="60" yMin="100" xMax="130" yMax="112">training</word></line></page>`);
  const blocks = normalizeTranslationPayload({ blocks: [{ text: "译文。错误。", sentences: [
    { text: "译文。", sourceText: "efficient pre-training", sourceRects: [] },
    { text: "错误。", sourceText: "invented sentence", sourceRects: [{ x: .1, y: .2, width: .5, height: .1 }] },
  ] }] }).blocks;
  const aligned = alignSourceBlocks(blocks, layout)[0];
  assert.equal(aligned.sentences[0].sourceRects.length, 2);
  assert.deepEqual(aligned.sentences[1].sourceRects, []);
});

test("normalizes local OCR word coordinates and rejects low-confidence words", async () => {
  const { parseOcrWordLayout } = await import("../lib/source-alignment.ts");
  const layout = parseOcrWordLayout("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t1000\t1400\t-1\t\n5\t1\t1\t1\t1\t1\t100\t140\t200\t28\t95\tHello\n5\t1\t1\t1\t1\t2\t310\t140\t100\t28\t10\tnoise");
  assert.equal(layout.method, "ocr");
  assert.equal(layout.words.length, 1);
  assert.deepEqual(layout.words[0].rect, { x: .1, y: .1, width: .2, height: .02 });
});

test("uses displayed page dimensions for rotated CropBox word positions", async () => {
  const { parsePdfWordLayout } = await import("../lib/source-alignment.ts");
  const layout = parsePdfWordLayout('<page width="500" height="600"><line><word xMin="395" yMin="50" xMax="417" yMax="105">Hello</word></line></page>', 90);
  assert.equal(layout.width, 600);
  assert.equal(layout.height, 500);
  assert.deepEqual(layout.words[0].rect, { x: 395 / 600, y: .1, width: 22 / 600, height: .11 });
});

test("extends clipped illustration edges to whitespace without including a nearby caption", async () => {
  const { expandImageCropToWhitespace } = await import("../lib/image-crop.ts");
  const width = 140, height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x, y, w, h) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      data.set([80, 90, 255, 255], (row * width + col) * 4);
    }
  };
  paint(20, 20, 80, 40);
  paint(10, 75, 120, 5);
  const crop = expandImageCropToWhitespace({ width, height, data }, { x: 30, y: 25, width: 50, height: 20 });
  assert.ok(crop.x <= 20 && crop.y <= 20);
  assert.ok(crop.x + crop.width >= 100 && crop.y + crop.height >= 60);
  assert.ok(crop.y + crop.height < 75);
});

test("keeps complete crops stable and bounds corrections to their search region", async () => {
  const { expandImageCropToWhitespace } = await import("../lib/image-crop.ts");
  const width = 100, height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = { x: 10, y: 10, width: 80, height: 80 };
  assert.deepEqual(expandImageCropToWhitespace({ width, height, data }, rect), rect);
  for (let y = 30; y < 70; y++) for (let x = 0; x < width; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);
  const crop = expandImageCropToWhitespace({ width, height, data }, { x: 10, y: 35, width: 80, height: 20 });
  assert.equal(crop.x, 10);
  assert.equal(crop.width, 80);
  assert.ok(crop.y >= 0 && crop.y + crop.height <= height);
});
