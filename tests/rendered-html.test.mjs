import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyLimiter } from "../lib/concurrency-limiter.ts";
import { isDocumentSearchShortcut } from "../lib/keyboard-shortcuts.ts";
import { deduplicatePageBoundary, normalizeTranslationPayload } from "../lib/translation-layout.ts";
import { searchTranslationPayload } from "../lib/translation-search.ts";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Verso reader shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Verso — AI Parallel Reader<\/title>/i);
  assert.match(html, /Verso/);
  assert.match(html, /AI Reader/);
  assert.match(html, /打开 PDF/);
  assert.match(html, /云端书库/);
  assert.match(html, /Switch interface to English/);
  assert.match(html, /切换明暗模式/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("rejects incomplete translation requests", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-api`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Missing API key, model, or page images." });
});

test("rejects incomplete search requests", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-search-api`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: "book", query: "" }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid search request." });
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
