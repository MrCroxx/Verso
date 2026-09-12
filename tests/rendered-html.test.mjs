import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { runInNewContext } from "node:vm";
import { applyTheme, watchTheme } from "../lib/theme.ts";
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
import { captionSourceRect, groupTranslationMedia, imagePlacement } from "../lib/translation-media.ts";
import { typewriterDuration, typewriterProgress } from "../lib/translation-typewriter.ts";
import { resolveUiLocale, UI_LOCALE_COOKIE } from "../lib/ui-locale.ts";
import { isPageWorkEnabled, pageWorkWindow, shouldStartTranslationRequest } from "../lib/viewport-work.ts";
import { prepareDisplayEquation, renderMath, splitMathText } from "../lib/math-content.ts";
import { translationCacheKey, translationCacheSuffix } from "../lib/translation-cache.ts";
import { normalizeReaderTypography } from "../lib/reader-typography.ts";
import nextConfig from "../next.config.ts";

let baseUrl;
let serverProcess;
let testDataDirectory;
let rendererLogPath;

test("restores font preferences safely from old or invalid reader settings", () => {
  const defaults = { translationFontSize: 100, translationFontFamily: "serif" };
  assert.deepEqual(normalizeReaderTypography({}), defaults);
  for (const value of [undefined, null, "150", NaN, Infinity]) {
    assert.deepEqual(normalizeReaderTypography({ translationFontSize: value, translationFontFamily: "unknown" }), defaults);
  }
  assert.deepEqual(normalizeReaderTypography({ translationFontSize: 145, translationFontFamily: "sans" }), {
    translationFontSize: 145, translationFontFamily: "sans",
  });
  assert.equal(normalizeReaderTypography({ translationFontSize: -100 }).translationFontSize, 50);
  assert.equal(normalizeReaderTypography({ translationFontSize: 1000 }).translationFontSize, 300);
  assert.equal(normalizeReaderTypography({ translationFontSize: 127 }).translationFontSize, 125);
});

before(async () => {
  testDataDirectory = await mkdtemp(path.join(tmpdir(), "verso-test-"));
  // Exercise the upgrade path from the original queue schema on every server test run.
  const legacy = new DatabaseSync(path.join(testDataDirectory, "verso.sqlite"));
  legacy.exec(`CREATE TABLE translation_queue (
    document_id TEXT NOT NULL, target_language TEXT NOT NULL, next_page INTEGER NOT NULL DEFAULT 1,
    concurrency INTEGER NOT NULL DEFAULT 4, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY (document_id, target_language))`);
  legacy.close();
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
  // Deterministic local extraction makes provider/OCR overlap observable without system tools.
  for (const [tool, source] of Object.entries({
    pdftotext: `console.log('<page width="100" height="100"></page>')`,
    pdfinfo: 'console.log("Page rot: 0")',
    tesseract: `setTimeout(() => console.log(${JSON.stringify("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n5\t1\t1\t1\t1\t1\t10\t10\t40\t10\t99\tPage")}), 100)`,
  })) {
    const executable = path.join(testDataDirectory, tool);
    await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
    await chmod(executable, 0o700);
  }
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
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    // Sending a signal is asynchronous; the server can still write render caches
    // until it exits. Wait for its stdio to close before removing the library.
    const closed = new Promise(resolve => serverProcess.once("close", resolve));
    const timeout = setTimeout(() => serverProcess.kill("SIGKILL"), 5000);
    try {
      serverProcess.kill("SIGTERM");
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (testDataDirectory) await rm(testDataDirectory, { recursive: true, force: true });
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

test("separates equation annotations without changing mathematical symbols", () => {
  const expression = String.raw`\hat{X}_l = B_{l-1} X_{l-1} + C_{l-1} Y_{l-1}`;
  const annotation = String.raw`\text{残差更新，对 } n \text{ 进行收缩}`;
  assert.deepEqual(prepareDisplayEquation(`\\[${expression} \\quad ${annotation}\\]`, "3"), {
    expression, annotation, number: "(3)",
  });
  assert.match(renderMath(expression, true), /<math /);
  assert.match(renderMath(annotation, false), /<math /);
  assert.deepEqual(prepareDisplayEquation("$$X_l = A_l X_l$$", " (A.1) "), {
    expression: "X_l = A_l X_l", annotation: "", number: "(A.1)",
  });
  assert.equal(prepareDisplayEquation("x=y", "A.2a").number, "(A.2a)");
  assert.equal(prepareDisplayEquation("x=y", "").number, "");
  assert.equal(prepareDisplayEquation("x=y", "[7]").number, "[7]");
});

test("keeps mathematical spacing inside expressions and environments intact", () => {
  for (const expression of [
    String.raw`X_{l+1}=B_l X_l, \quad (A_l,B_l,C_l)=\mathcal{H}(X_l)`,
    String.raw`\frac{x\quad\text{units}}{n}`,
    String.raw`\begin{cases}x\quad\text{if }x>0\\0\quad\text{otherwise}\end{cases}`,
    String.raw`\left(x\quad\text{units}\right)`,
  ]) {
    assert.deepEqual(prepareDisplayEquation(expression, "2"), { expression, annotation: "", number: "(2)" });
    assert.match(renderMath(expression, true), /<math /);
  }
  assert.deepEqual(prepareDisplayEquation(String.raw`\{x\}\qquad\text{a set}`, ""), {
    expression: String.raw`\{x\}`, annotation: String.raw`\text{a set}`, number: "",
  });
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
  assert.match(html, /<title>Verso — Read beyond language<\/title>/i);
  assert.match(html, /<html lang="en-US">/i);
  assert.match(html, /Verso/);
  assert.match(html, /Read beyond language/);
  assert.match(html, /<h1 id="library-title">Library<\/h1>/);
  assert.match(html, /Upload a new PDF/);
  assert.match(html, />Library</);
  assert.doesNotMatch(html, /Local Library|AI Reader/);
  assert.match(html, /aria-label="Appearance"/);
  assert.match(html, /<option value="system" selected="">System<\/option>/);
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

test("initializes the theme before rendering, respecting saved preferences and blocked storage", async () => {
  const html = await (await render()).text();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .find((match) => match[1].includes("verso-theme"))?.[1];
  assert.ok(script);
  assert.ok(html.indexOf(script) < html.indexOf("<body"));
  for (const saved of [null, "system", "light", "dark", "invalid"]) {
    for (const prefersDark of [false, true]) {
      for (const blocked of [false, true]) {
        const root = { dataset: {} };
        runInNewContext(script, {
          document: { documentElement: root },
          window: { matchMedia: () => ({ matches: prefersDark }) },
          localStorage: { getItem: () => { if (blocked) throw new Error("Storage blocked"); return saved; } },
        });
        const expected = !blocked && ["light", "dark"].includes(saved) ? saved : prefersDark ? "dark" : "light";
        assert.equal(root.dataset.theme, expected, `${saved}, dark=${prefersDark}, blocked=${blocked}`);
      }
    }
  }
});

test("follows live system theme changes and stops following when an explicit theme is chosen", () => {
  const root = { dataset: {} };
  const media = new EventTarget();
  media.matches = false;
  const context = {
    document: { documentElement: root },
    window: { matchMedia: () => media },
  };
  const watch = (theme) => runInNewContext(`${applyTheme.toString()}; (${watchTheme.toString()})(${JSON.stringify(theme)})`, context);
  const stop = watch("system");
  assert.equal(root.dataset.theme, "light");
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  assert.equal(root.dataset.theme, "dark");
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  assert.equal(root.dataset.theme, "light");
  stop();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  assert.equal(root.dataset.theme, "light");
  for (const theme of ["dark", "light"]) {
    assert.equal(watch(theme), undefined);
    media.matches = theme !== "dark";
    media.dispatchEvent(new Event("change"));
    assert.equal(root.dataset.theme, theme);
  }
  const stopAgain = watch("system");
  assert.equal(root.dataset.theme, "dark");
  stopAgain();
});

test("resolves an explicit locale before the best supported browser language", () => {
  assert.equal(resolveUiLocale("en-US", "zh-CN,zh;q=0.9"), "en-US");
  assert.equal(resolveUiLocale(undefined, "fr-FR,zh-CN;q=0.8,en-US;q=0.6"), "zh-CN");
  assert.equal(resolveUiLocale(undefined, "fr-FR"), "en-US");
});

test("serves settings as a localized page with a library navigation link", async () => {
  const home = await (await render()).text();
  assert.match(home, /href="\/settings"/);
  assert.doesNotMatch(home, /translation-transfer/);
  for (const [locale, title] of [["en-US", "Settings"], ["zh-CN", "设置"]]) {
    const response = await render("/settings", { cookie: `${UI_LOCALE_COOKIE}=${locale}` });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${title}</h1>`));
    assert.match(html, new RegExp(`<option value="system" selected="">${locale === "zh-CN" ? "跟随系统" : "System"}</option>`));
    for (const section of ["ai-provider", "translation", "reading", "library", "interface"]) {
      assert.match(html, new RegExp(`id="${section}"`));
    }
    assert.match(html, new RegExp(locale === "zh-CN" ? "导入书库翻译信息" : "Import library translations"));
    assert.match(html, new RegExp(locale === "zh-CN" ? "导出书库翻译信息" : "Export library translations"));
    assert.doesNotMatch(html, /role="dialog"|aria-modal="true"/);
  }
});

test("settings returns to a book and page while rejecting external return destinations", async () => {
  const html = await (await render(`/settings?returnTo=${encodeURIComponent("/?book=sample&page=7")}`)).text();
  assert.match(html, /href="\/\?book=sample&amp;page=7"/);
  assert.match(html, /Back to reading/);
  for (const destination of ["https://example.com/?book=sample", "//example.com/?book=sample", "http://[", "/settings"]) {
    const response = await render(`/settings?returnTo=${encodeURIComponent(destination)}`);
    assert.equal(response.status, 200);
    const fallback = await response.text();
    assert.match(fallback, /Back to library/);
    assert.doesNotMatch(fallback, /href="https?:\/\/example.com/);
  }
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
  const id = response.headers.get("x-verso-trace-id");
  assert.ok(id);
  const traceResponse = await fetch(`${baseUrl}/api/traces?id=${id}`);
  assert.match(traceResponse.headers.get("cache-control"), /no-store/);
  const { traces } = await traceResponse.json();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, "error");
  assert.ok(traces[0].spans.every(span => span.status !== "running"));
});

test("connection testing requires stored credentials", async () => {
  const response = await fetch(`${baseUrl}/api/settings/ai-provider/test`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "not_configured" });
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

test("connection testing checks the saved model through both provider protocols without exposing credentials", async () => {
  const requests = [];
  let mode = "success";
  const secret = "connection-test-private-key";
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader("content-type", "application/json");
    if (mode === "unauthorized") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: secret } }));
    } else if (mode === "invalid") {
      response.end(JSON.stringify({ status: "healthy" }));
    } else {
      response.end(JSON.stringify(request.url.endsWith("/responses")
        ? { output: [{ content: [{ type: "output_text", text: "OK" }] }] }
        : { choices: [{ message: { content: "OK" } }] }));
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    for (const [kind, suffix, expectedPath] of [["compatible", "/v1", "/v1/chat/completions"], ["openai", "/v1", "/v1/responses"], ["openai", "/v1/responses", "/v1/responses"], ["compatible", "/v1/responses", "/v1/responses"]]) {
      const settings = { provider: kind, endpoint: `http://127.0.0.1:${provider.address().port}${suffix}`, apiKey: secret, model: "connection-model", reasoningEffort: "high" };
      assert.equal((await fetch(`${baseUrl}/api/settings/ai-provider`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) })).status, 200);
      const before = await (await fetch(`${baseUrl}/api/settings/ai-provider`)).json();
      const response = await fetch(`${baseUrl}/api/settings/ai-provider/test`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /no-store/);
      const text = await response.text();
      assert.ok(!text.includes(secret));
      const result = JSON.parse(text);
      assert.equal(result.ok, true);
      assert.ok(result.latencyMs >= 0);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/settings/ai-provider`)).json(), before);
      const request = requests.at(-1);
      assert.equal(request.url, expectedPath);
      assert.equal(request.authorization, `Bearer ${secret}`);
      assert.equal(request.body.model, "connection-model");
      if (expectedPath.endsWith("/responses")) {
        assert.equal(request.body.reasoning.effort, "high");
        assert.equal(request.body.input[0].content[0].text, "Reply with exactly OK.");
      } else {
        assert.equal(request.body.reasoning_effort, "high");
        assert.equal(request.body.messages[0].content, "Reply with exactly OK.");
      }
    }
    mode = "unauthorized";
    const failure = await fetch(`${baseUrl}/api/settings/ai-provider/test`, { method: "POST" });
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: "provider_error", status: 401 });
    mode = "invalid";
    const invalid = await fetch(`${baseUrl}/api/settings/ai-provider/test`, { method: "POST" });
    assert.equal(invalid.status, 502);
    assert.deepEqual(await invalid.json(), { error: "invalid_response" });
  } finally {
    await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
  const unreachable = await fetch(`${baseUrl}/api/settings/ai-provider/test`, { method: "POST" });
  assert.equal(unreachable.status, 502);
  assert.deepEqual(await unreachable.json(), { error: "connection_failed" });
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

test("uses a new cache namespace for structured mathematical translations", () => {
  assert.equal(translationCacheSuffix("Simplified Chinese"), "server-v2::Simplified Chinese");
  assert.equal(
    translationCacheKey("book", 15, "Simplified Chinese"),
    "layout-v4::book::15::server-v2::Simplified Chinese",
  );
});

test("renders display and inline mathematics without trusting unsafe LaTeX", () => {
  assert.deepEqual(splitMathText(String.raw`令 \(x_i\) 为词元，并计算 \[\frac{1}{n}\sum_j x_j^2\]。`), [
    { text: "令 ", math: false, display: false, start: 0, end: 2 },
    { text: "x_i", math: true, display: false, start: 2, end: 9 },
    { text: " 为词元，并计算 ", math: false, display: false, start: 9, end: 18 },
    { text: String.raw`\frac{1}{n}\sum_j x_j^2`, math: true, display: true, start: 18, end: 45 },
    { text: "。", math: false, display: false, start: 45, end: 46 },
  ]);
  assert.match(renderMath(String.raw`\Delta_t=\sqrt{n}D_r\widehat{G}_tD_c,\quad \frac{1}{n}\sum_{j=1}^n(\Delta_t)_{ij}^2\approx1`, true), /<math /);
  assert.equal(renderMath(String.raw`\frac{`, true), null);
  assert.equal(renderMath("x".repeat(10_001), false), null);
  assert.doesNotMatch(renderMath(String.raw`\href{javascript:alert(1)}{x}`, false) || "", /<a\b|href=/);
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
  const plainKey = { key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isDocumentSearchShortcut({ ...plainKey, ctrlKey: true }), true);
  assert.equal(isDocumentSearchShortcut({ ...plainKey, key: "F", metaKey: true }), true);
  assert.equal(isDocumentSearchShortcut(plainKey), false);
  assert.equal(isDocumentSearchShortcut({ ...plainKey, key: "g", ctrlKey: true }), false);

  for (const modifier of ["ctrlKey", "metaKey"]) {
    assert.equal(isDocumentSearchShortcut({ ...plainKey, [modifier]: true, altKey: true }), false);
    assert.equal(isDocumentSearchShortcut({ ...plainKey, [modifier]: true, shiftKey: true }), false);
  }
});

test("leaves the macOS fullscreen shortcut to the system", () => {
  assert.equal(isDocumentSearchShortcut({
    key: "f", ctrlKey: true, metaKey: true, altKey: false, shiftKey: false,
  }), false);
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
    ...textBlock, kind: "image", imageRole: "body", text: "", fontSize: null, sentences: [],
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
      assert.equal(response.headers.get("x-verso-trace-id"), translation.trace.id);
      assert.match(response.headers.get("server-timing"), /provider.wait_headers/);
      assert.equal(translation.trace.status, "ok");
      assert.equal(translation.trace.attributes.model, "vision-test");
      assert.doesNotMatch(JSON.stringify(translation.trace), /test-key|data:image|Source sentence|译文/);
      const traceExport = await (await fetch(`${baseUrl}/api/traces?id=${translation.trace.id}&format=chrome`)).json();
      const lanes = traceExport.traceEvents.filter(event => event.ph === "X").map(event => `${event.pid}:${event.tid}`);
      assert.equal(new Set(lanes).size, lanes.length);
      assert.ok(traceExport.traceEvents.some(event => event.ph === "X" && event.name === "provider.wait_headers" && event.dur >= 0));
      assert.deepEqual(translation.blocks[0].sentences, textBlock.sentences);
      assert.equal(translation.blocks[0].fontSize, 0.025);
      assert.deepEqual(translation.blocks[1].sourceRect, imageBlock.sourceRect);
      assert.equal(translation.blocks[1].imageRole, "body");
      assert.deepEqual(translation.previousPageRevision.blocks, translation.blocks);
      const instruction = (incoming.input || incoming.messages)[0].content[0].text;
      assert.match(instruction, /one rectangle per line fragment/);
      assert.match(instruction, /"sourceRects"/);
      assert.match(instruction, /"fontSize"/);
      if (format === "openai") {
        const blockSchema = incoming.text.format.schema.properties.blocks.items;
        assert.ok(blockSchema.required.includes("sentences"));
        assert.ok(blockSchema.required.includes("imageRole"));
        assert.ok(blockSchema.properties.kind.enum.includes("image"));
        assert.ok(blockSchema.properties.kind.enum.includes("equation"));
      }
      assert.match(instruction, /valid KaTeX-compatible LaTeX/);
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

test("repairs a cached cross-page word without repeating it or losing page-local source mappings", async () => {
  const { parsePdfWordLayout, alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const language = "Simplified Chinese";
  const leading = { kind: "heading", text: "推理系统", spaceBefore: "none" };
  const boundary = (text, sourceText) => ({ kind: "paragraph", text, sentences: [{ text, sourceText, sourceRects: [] }] });
  const previousBlocks = [leading, boundary("编码器和解码器", "Encoder and De-")];
  const currentBlocks = [boundary("的 SWA 有界重放路径。", "coder SWA Bounded Replay paths.")];
  const requests = [];
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const content = (input.input || input.messages)[0].content;
    requests.push(content);
    const needsRevision = content[0].text.includes('The cached translation ends with: "编码器和 De-"');
    const result = { page: 2, blocks: currentBlocks, sourceSummary: "", previousPageRevision: needsRevision ? { page: 1, blocks: previousBlocks } : null };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(input.input
      ? { output_text: JSON.stringify(result) }
      : { choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    for (const [index, format] of ["openai", "compatible"].entries()) {
      const book = await uploadQueueBook(`c${index + 1}`.repeat(32), 2);
      const settings = await fetch(`${baseUrl}/api/settings/ai-provider`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: format, endpoint: `http://127.0.0.1:${provider.address().port}/${format === "openai" ? "responses" : "v1"}`, apiKey: "test-key", model: "boundary-test", reasoningEffort: "none" }),
      });
      assert.equal(settings.status, 200);
      const seeded = await fetch(`${baseUrl}/api/translations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: translationCacheKey(book.fingerprint, 1, language), documentId: book.fingerprint, page: 1,
          translation: { page: 1, blocks: [leading, boundary("编码器和 De-", "Encoder and De-")] } }),
      });
      assert.equal(seeded.status, 200);
      const response = await readTestPage(book, 2, { targetLanguage: language, contextPages: [1, 2] });
      assert.equal(response.status, 200);
      const result = await response.json();
      const instruction = requests.at(-1)[0].text;
      assert.match(instruction, /belongs in full to the page where it starts/);
      assert.match(instruction, /even when neither page is cached yet/);
      assert.match(instruction, /Preserve genuine compound hyphens/);
      assert.match(instruction, /its cached translation left a split word incomplete/);
      assert.deepEqual(requests.at(-1).filter((part) => /^Page \d+:$/.test(part.text || "")).map((part) => part.text), ["Page 1:", "Page 2:"]);
      assert.equal(result.previousPageRevision.page, 1);

      const cached = [];
      for (const page of [1, 2]) {
        const reread = await readTestPage(book, page, { targetLanguage: language });
        assert.equal(reread.status, 200);
        cached.push(await reread.json());
      }
      assert.deepEqual(cached[0].blocks, normalizeTranslationPayload({ blocks: previousBlocks }).blocks);
      assert.deepEqual(cached[1].blocks, normalizeTranslationPayload({ blocks: currentBlocks }).blocks);
      assert.equal(cached[0].cacheVersion, cached[1].cacheVersion);
      assert.equal(cached[0].blocks.at(-1).text + cached[1].blocks[0].text, "编码器和解码器的 SWA 有界重放路径。");
      assert.equal(cached[0].markdown, "推理系统\n\n编码器和解码器");
      assert.equal(requests.length, index * 2 + 1);

      // A complete translated word still highlights only the fragment on its own scan.
      for (const [page, sourceText, y] of [[0, "Encoder and De-", 700], [1, "coder SWA Bounded Replay paths.", 80]]) {
        const words = sourceText.split(" ").map((word, position) => `<word xMin="${60 + position * 80}" yMin="${y}" xMax="${130 + position * 80}" yMax="${y + 12}">${word}</word>`).join("");
        const layout = parsePdfWordLayout(`<page width="600" height="800"><line>${words}</line></page>`);
        const blocks = alignSourceBlocks(cached[page].blocks, layout);
        const sentence = blocks.find((block) => block.kind === "paragraph").sentences[0];
        assert.equal(sentence.sourceText, sourceText);
        assert.equal(sentence.sourceRects.length, 1);
        assert.equal(sentence.sourceRects[0].y, y / 800);
      }
      const repeated = await readTestPage(book, 2, { targetLanguage: language, contextPages: [1, 2], force: true });
      assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).previousPageRevision, null);
      assert.match(requests.at(-1)[0].text, /The cached translation ends with: "编码器和解码器"/);
    }
  } finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("preserves equation typography while grounding highlights in small math glyphs", async () => {
  const { parsePdfWordLayout, alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const layout = parsePdfWordLayout(`<page width="600" height="800"><line>
    <word xMin="72" yMin="80" xMax="80" yMax="92">X</word>
    <word xMin="80" yMin="88" xMax="82" yMax="94">l</word>
    <word xMin="90" yMin="80" xMax="98" yMax="92">=</word>
    <word xMin="105" yMin="80" xMax="113" yMax="92">B</word>
    <word xMin="113" yMin="88" xMax="115" yMax="94">l</word>
    <word xMin="120" yMin="80" xMax="128" yMax="92">X</word>
    <word xMin="128" yMin="88" xMax="130" yMax="94">l</word></line></page>`);
  const blocks = normalizeTranslationPayload({ blocks: [{
    kind: "equation", text: "X_l = B_l X_l", fontSize: 0.02,
    sourceRect: { x: 0.1, y: 0.09, width: 0.2, height: 0.04 },
    sentences: [{ text: "X_l = B_l X_l", sourceText: "X_l = B_l X_l", sourceRects: [] }],
  }] }).blocks;
  const aligned = alignSourceBlocks(blocks, layout)[0];
  assert.equal(aligned.fontSize, 0.02);
  assert.equal(aligned.sentences[0].sourceRects.length, 1);
  assert.equal(aligned.sentences[0].sourceRects[0].x, 0.12);
  assert.equal(aligned.text, blocks[0].text);
  const unmapped = { ...blocks[0], sentences: undefined };
  assert.equal(alignSourceBlocks([unmapped], layout)[0].fontSize, 0.02);
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

test("groups cached table captions above their images and absorbs only internal spacers", () => {
  const blocks = normalizeTranslationPayload({ blocks: [
    { kind: "paragraph", text: "Before." },
    { kind: "image", sourceRect: { x: .1, y: .2, width: .4, height: .2 }, spaceBefore: "sm" },
    { kind: "spacer", size: "xl" },
    { kind: "caption", text: "表 1：比较结果", align: "left", indent: 3, spaceBefore: "xl" },
    { kind: "spacer", size: "sm" },
    { kind: "paragraph", text: "After." },
  ] }).blocks;
  const before = structuredClone(blocks);
  const display = groupTranslationMedia(blocks);
  assert.deepEqual(display.map(({ index }) => index), [0, 1, 4, 5]);
  assert.equal(display[1].captionPosition, "top");
  assert.equal(display[1].caption, blocks[3]);
  assert.equal(display[1].spaceBefore, "sm");
  assert.deepEqual(blocks, before);
});

test("places figure captions below images using source labels and preserves sentence mappings", () => {
  const blocks = normalizeTranslationPayload({ blocks: [
    { kind: "caption", text: "架构图", fontSize: .015, spaceBefore: "md", sentences: [
      { text: "架构图", sourceText: "Figure 2: Architecture", sourceRects: [{ x: .1, y: .41, width: .4, height: .03 }] },
    ] },
    { kind: "image", sourceRect: { x: .1, y: .2, width: .4, height: .2 } },
    { kind: "paragraph", text: "Body." },
  ] }).blocks;
  const display = groupTranslationMedia(blocks);
  assert.equal(display.length, 2);
  assert.equal(display[0].captionPosition, "bottom");
  assert.equal(display[0].caption, blocks[0]);
  assert.equal(display[0].spaceBefore, "md");
  assert.equal(display[1].block.text, "Body.");
});

test("pairs consecutive figures and tables without consuming either caption twice", () => {
  const image = { kind: "image", sourceRect: { x: .1, y: .2, width: .4, height: .2 } };
  const blocks = normalizeTranslationPayload({ blocks: [
    image, { kind: "caption", text: "Fig. 1: First" },
    { kind: "caption", text: "Table 1: Second" }, image,
    { kind: "caption", text: "表 2：第三张" }, image,
  ] }).blocks;
  const display = groupTranslationMedia(blocks);
  assert.deepEqual(display.map(({ index }) => index), [0, 3, 5]);
  assert.deepEqual(display.map(({ captionPosition }) => captionPosition), ["bottom", "top", "top"]);
  assert.deepEqual(display.map(({ caption }) => caption.text), ["Fig. 1: First", "Table 1: Second", "表 2：第三张"]);
});

test("uses source geometry to disambiguate captions between images", () => {
  const blocks = normalizeTranslationPayload({ blocks: [
    { kind: "image", sourceRect: { x: .1, y: .1, width: .4, height: .15 } },
    { kind: "caption", text: "Table 2: Results", sourceRect: { x: .1, y: .26, width: .4, height: .02 } },
    { kind: "image", sourceRect: { x: .1, y: .6, width: .4, height: .15 } },
  ] }).blocks;
  const display = groupTranslationMedia(blocks);
  assert.equal(display[0].caption, blocks[1]);
  assert.equal(display[0].captionPosition, "top");
  assert.equal(display[1].caption, undefined);
});

test("leaves standalone images, unrelated captions, and body text in place", () => {
  const blocks = normalizeTranslationPayload({ blocks: [
    { kind: "caption", text: "Table 1", sourceRect: { x: .55, y: .1, width: .35, height: .02 } },
    { kind: "image", sourceRect: { x: .1, y: .13, width: .35, height: .2 } },
    { kind: "paragraph", text: "Intervening text." },
    { kind: "caption", text: "Figure 2" },
    { kind: "image" },
  ] }).blocks;
  assert.deepEqual(groupTranslationMedia(blocks).map(({ block }) => block), blocks);
  assert.ok(groupTranslationMedia(blocks).every(({ caption }) => caption === undefined));
});

test("keeps the original side for unlabelled legacy captions", () => {
  const image = { kind: "image", sourceRect: { x: .1, y: .2, width: .4, height: .2 } };
  const caption = { kind: "caption", text: "An unnumbered illustration." };
  for (const [raw, position] of [[[caption, image], "top"], [[image, caption], "bottom"]]) {
    const display = groupTranslationMedia(normalizeTranslationPayload({ blocks: raw }).blocks);
    assert.equal(display.length, 1);
    assert.equal(display[0].captionPosition, position);
  }
});


test("restores cached header and footer marks to their source position while centering body media", () => {
  const normalize = (value) => normalizeTranslationPayload({ blocks: [{ kind: "image", ...value }] }).blocks[0];
  const header = normalize({ sourceRect: { x: .125, y: .038, width: .18, height: .045 } });
  const footer = normalize({ sourceRect: { x: .7, y: .93, width: .15, height: .04 } });
  const body = normalize({ sourceRect: { x: .1, y: .3, width: .3, height: .2 } });
  assert.equal(imagePlacement(header), "source");
  assert.equal(imagePlacement(footer), "source");
  assert.equal(imagePlacement(body), "center");
  assert.equal(imagePlacement(header, true), "center");
  assert.equal(imagePlacement(normalize({ ...header, imageRole: "body" })), "center");
  assert.equal(imagePlacement(normalize({ ...body, imageRole: "decoration" })), "source");
  assert.equal(normalize({ imageRole: "invalid" }).imageRole, undefined);
  assert.equal(normalize({ imageRole: null }).imageRole, undefined);
});

test("does not attach a nearby figure caption to a decorative mark", () => {
  const blocks = normalizeTranslationPayload({ blocks: [
    { kind: "image", imageRole: "decoration", sourceRect: { x: .1, y: .05, width: .2, height: .04 } },
    { kind: "caption", text: "Figure 1: Results" },
    { kind: "image", imageRole: "body", sourceRect: { x: .1, y: .2, width: .4, height: .2 } },
  ] }).blocks;
  const display = groupTranslationMedia(blocks);
  assert.equal(display.length, 2);
  assert.equal(display[0].caption, undefined);
  assert.equal(display[1].caption, blocks[1]);
  assert.equal(display[1].captionPosition, "bottom");
});

test("recovers clipped wordmarks without letting page rules block crop expansion", async () => {
  const { expandImageCropToWhitespace } = await import("../lib/image-crop.ts");
  for (const ruleY of [12, 63]) {
    const width = 170, height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x, y, w, h) => {
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
        data.set([80, 90, 220, 255], (row * width + col) * 4);
      }
    };
    paint(20, 25, 60, 30);
    paint(84, 25, 10, 30);
    paint(98, 25, 10, 30);
    paint(112, 25, 10, 30);
    paint(10, ruleY, 160, 2);
    paint(10, 85, 150, 5);
    const estimate = { x: 25, y: 10, width: 78, height: 58 };
    const crop = expandImageCropToWhitespace({ width, height, data }, estimate, { ignorePageRules: true });
    assert.ok(crop.x <= 20 && crop.x + crop.width >= 122, JSON.stringify(crop));
    assert.ok(crop.y <= 25 && crop.y + crop.height >= 55);
    assert.ok(ruleY < crop.y || ruleY >= crop.y + crop.height);
    assert.ok(crop.y + crop.height < 85);
  }
});

test("keeps contained illustration borders and bounded crop buffers intact", async () => {
  const { expandImageCropToWhitespace } = await import("../lib/image-crop.ts");
  const width = 140, height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 20; y < 65; y++) for (let x = 20; x < 110; x++) {
    if (x < 22 || x >= 108 || y < 22 || y >= 63) data.set([0, 0, 0, 255], (y * width + x) * 4);
  }
  const crop = expandImageCropToWhitespace({ width, height, data }, { x: 25, y: 20, width: 80, height: 45 }, { ignorePageRules: true });
  assert.ok(crop.x <= 20 && crop.x + crop.width >= 110);
  assert.ok(crop.y <= 20 && crop.y + crop.height >= 65);
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= width && crop.y + crop.height <= height);
});

test("retries a clipped decorative crop beyond its first probe and stops after finding whitespace", async () => {
  const { resolveImageCrop } = await import("../lib/image-crop.ts");
  const page = { width: 1000, height: 1400 };
  const probes = [];
  const readPixels = (region) => {
    probes.push(region);
    const data = new Uint8ClampedArray(region.width * region.height * 4).fill(255);
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
      const px = x + region.x, py = y + region.y;
      const mark = px >= 122 && px < 327 && py >= 60 && py < 105 && (px < 175 || (px - 175) % 14 < 11);
      const rule = px >= 120 && px < 880 && py >= 110 && py < 112;
      const heading = px >= 200 && px < 800 && py >= 165 && py < 185;
      if (mark || rule || heading) data.set([80, 90, 220, 255], (y * region.width + x) * 4);
    }
    return { ...region, data };
  };
  const estimate = { x: 100, y: 35, width: 150, height: 63 };
  const crop = resolveImageCrop(page, estimate, readPixels, { ignorePageRules: true });
  assert.equal(probes.length, 2);
  assert.ok(probes[0].x + probes[0].width < 327);
  assert.ok(crop.x <= 122 && crop.x + crop.width >= 327, JSON.stringify(crop));
  assert.ok(crop.y <= 60 && crop.y + crop.height >= 105);
  assert.ok(crop.y + crop.height <= 110, JSON.stringify(crop));
  assert.deepEqual(estimate, { x: 100, y: 35, width: 150, height: 63 });
});

test("caps crop retries and preserves the single-probe behavior for body illustrations", async () => {
  const { resolveImageCrop } = await import("../lib/image-crop.ts");
  const page = { width: 1000, height: 1400 };
  const estimate = { x: 400, y: 400, width: 150, height: 70 };
  for (const decoration of [true, false]) {
    const probes = [];
    const crop = resolveImageCrop(page, estimate, (region) => {
      probes.push(region);
      const data = new Uint8ClampedArray(region.width * region.height * 4).fill(255);
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
        if (y + region.y >= 410 && y + region.y < 460) data.set([0, 0, 0, 255], (y * region.width + x) * 4);
      }
      return { ...region, data };
    }, { ignorePageRules: decoration });
    assert.equal(probes.length, decoration ? 3 : 1);
    for (const region of probes) {
      assert.ok(region.width <= estimate.width + page.width * .48);
      assert.ok(region.height <= estimate.height + page.height * .24);
      assert.ok(region.x >= 0 && region.y >= 0);
      assert.ok(region.x + region.width <= page.width && region.y + region.height <= page.height);
    }
    assert.ok(crop.x >= 0 && crop.x + crop.width <= page.width);
    if (!decoration) assert.equal(crop.width, estimate.width);
  }
});

function alignmentFixture(sources) {
  return {
    width: 1000, height: 1400, method: "pdf",
    words: sources.flatMap((source, sentence) => source.split(/\s+/).map((text, index) => ({
      text, line: sentence * 10 + Math.floor(index / 10),
      rect: { x: .05 + index % 10 * .08, y: .05 + sentence * .2 + Math.floor(index / 10) * .02, width: .07, height: .015 },
    }))),
  };
}

const pretrainingSource = "We pretrain DeepSeek-V4.1-Flash on a multimodal corpus comprising 45T tokens and conduct comprehensive post-training, yielding strong performance across diverse text-based and multimodal agentic scenarios.";

test("recovers all source lines after a small spelling error without changing either sentence", async () => {
  const { alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const layout = alignmentFixture(["Previous unrelated sentence.", pretrainingSource, "Following unrelated sentence."]);
  for (const sourceText of [
    pretrainingSource.replace("comprising", "comprizing"),
    pretrainingSource.replace("comprehensive", "comprehhensive"),
    pretrainingSource.replace("comprehensive", "comprehnsive"),
  ]) {
    const blocks = normalizeTranslationPayload({ blocks: [{ text: "Translated sentence.", sentences: [
      { text: "Translated sentence.", sourceText, sourceRects: [] },
    ] }] }).blocks;
    const original = structuredClone(blocks);
    const aligned = alignSourceBlocks(blocks, layout)[0].sentences[0];
    assert.equal(aligned.sourceText, sourceText);
    assert.equal(aligned.text, "Translated sentence.");
    assert.equal(aligned.sourceRects.length, Math.ceil(pretrainingSource.split(/\s+/).length / 10));
    assert.ok(aligned.sourceRects.every((rect) => rect.y >= .25 && rect.y < .45));
    assert.deepEqual(blocks, original);
  }
});

test("prefers an exact sentence over an earlier approximate match", async () => {
  const { alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const sourceText = pretrainingSource.replace("comprising", "comprizing");
  const blocks = normalizeTranslationPayload({ blocks: [{ text: "Translation.", sentences: [
    { text: "Translation.", sourceText, sourceRects: [] },
  ] }] }).blocks;
  const aligned = alignSourceBlocks(blocks, alignmentFixture([pretrainingSource, sourceText]))[0].sentences[0];
  assert.ok(aligned.sourceRects.length > 0);
  assert.ok(aligned.sourceRects.every((rect) => rect.y >= .25));
});

test("rejects competing approximate sentences instead of guessing a highlight", async () => {
  const { alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const blocks = normalizeTranslationPayload({ blocks: [{ text: "Translation.", sentences: [
    { text: "Translation.", sourceText: pretrainingSource.replace("comprising", "comprizing"), sourceRects: [{ x: .1, y: .1, width: .8, height: .1 }] },
  ] }] }).blocks;
  const layout = alignmentFixture([pretrainingSource, pretrainingSource.replace("comprising", "comprixing")]);
  assert.deepEqual(alignSourceBlocks(blocks, layout)[0].sentences[0].sourceRects, []);
});

test("keeps approximate repeated sentences in reading order", async () => {
  const { alignSourceBlocks } = await import("../lib/source-alignment.ts");
  const blocks = normalizeTranslationPayload({ blocks: [{ text: "First.Second.", sentences: [
    { text: "First.", sourceText: pretrainingSource.replace("comprising", "comprizing"), sourceRects: [] },
    { text: "Second.", sourceText: pretrainingSource.replace("comprising", "comprizing"), sourceRects: [] },
  ] }] }).blocks;
  const aligned = alignSourceBlocks(blocks, alignmentFixture([pretrainingSource, pretrainingSource]))[0].sentences;
  assert.ok(aligned[0].sourceRects.every((rect) => rect.y < .25));
  assert.ok(aligned[1].sourceRects.every((rect) => rect.y >= .25));
  assert.ok(aligned.every((sentence) => sentence.sourceRects.length > 0));
});

test("refuses approximate matches for short labels and materially different sentences", async () => {
  const { alignSourceBlocks } = await import("../lib/source-alignment.ts");
  for (const [source, sourceText] of [
    ["Figure 1 Results", "Figure 2 Results"],
    [pretrainingSource, pretrainingSource.replace("45T", "200B").replace("comprehensive", "limited")],
  ]) {
    const blocks = normalizeTranslationPayload({ blocks: [{ text: "Translation.", sentences: [
      { text: "Translation.", sourceText, sourceRects: [] },
    ] }] }).blocks;
    assert.deepEqual(alignSourceBlocks(blocks, alignmentFixture([source]))[0].sentences[0].sourceRects, []);
  }
});

test("uses grounded caption lines instead of inaccurate model crop coordinates", () => {
  const caption = normalizeTranslationPayload({ blocks: [{ kind: "caption", text: "Translated caption.",
    sourceRect: { x: .17, y: .365, width: .66, height: .05 },
    sentences: [{ text: "Translated caption.", sourceText: "Figure 2: Caption.", sourceRects: [
      { x: .12, y: .286, width: .76, height: .013 },
      { x: .12, y: .302, width: .60, height: .013 },
    ] }],
  }] }).blocks[0];
  const rect = captionSourceRect(caption);
  assert.equal(rect.y, .286);
  assert.ok(Math.abs(rect.height - .029) < .00001);
  const image = normalizeTranslationPayload({ blocks: [{ kind: "image", sourceRect: { x: .22, y: .08, width: .57, height: .29 } }] }).blocks[0];
  assert.deepEqual(groupTranslationMedia([image, caption])[0].captionRect, rect);
});

test("excludes captions above and below images and prevents crop expansion from reintroducing them", async () => {
  const { excludeImageCaption, resolveImageCrop } = await import("../lib/image-crop.ts");
  const page = { width: 180, height: 160 };
  for (const caption of [
    { x: 10, y: 20, width: 160, height: 10 },
    { x: 10, y: 95, width: 160, height: 20 },
  ]) {
    const estimate = { x: 30, y: 10, width: 120, height: 110 };
    const { crop: initial, bounds } = excludeImageCaption(page, estimate, caption);
    const above = caption.y < 40;
    assert.ok(above ? initial.y > caption.y + caption.height : initial.y + initial.height < caption.y);
    const crop = resolveImageCrop(page, initial, (region) => {
      assert.ok(above ? region.y > caption.y + caption.height : region.y + region.height < caption.y);
      const data = new Uint8ClampedArray(region.width * region.height * 4).fill(255);
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
        const px = x + region.x, py = y + region.y;
        if (px >= 35 && px < 145 && py >= 40 && py < 85) data.set([0, 0, 0, 255], (y * region.width + x) * 4);
      }
      return { ...region, data };
    }, { bounds });
    assert.ok(crop.y <= 40 && crop.y + crop.height >= 85);
    assert.ok(above ? crop.y > caption.y + caption.height : crop.y + crop.height < caption.y);
  }
});

test("preserves uncaptained artwork and rejects incompatible caption bounds", async () => {
  const { excludeImageCaption } = await import("../lib/image-crop.ts");
  const page = { width: 200, height: 200 };
  const estimate = { x: 20, y: 40, width: 70, height: 80 };
  assert.equal(excludeImageCaption(page, estimate).crop, estimate);
  assert.equal(excludeImageCaption(page, estimate, { x: 120, y: 70, width: 60, height: 20 }).crop, estimate);
  assert.equal(excludeImageCaption(page, estimate, { x: 20, y: 40, width: 70, height: 80 }).crop, estimate);
});

test("upgrades a sequential retry without losing its page or double-advancing the cursor", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "verso-queue-upgrade-"));
  try {
    const legacy = new DatabaseSync(path.join(directory, "verso.sqlite"));
    legacy.exec(`CREATE TABLE books (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, name TEXT, object_key TEXT,
      size INTEGER, page_count INTEGER, content_type TEXT, uploaded_at INTEGER);
      INSERT INTO books VALUES ('legacy', 'legacy', 'Legacy.pdf', 'books/legacy.pdf', 10, 5, 'application/pdf', 1);
      CREATE TABLE translation_queue (document_id TEXT NOT NULL, target_language TEXT NOT NULL,
        next_page INTEGER DEFAULT 1, concurrency INTEGER DEFAULT 4, status TEXT DEFAULT 'queued', error TEXT,
        updated_at INTEGER, retry_count INTEGER DEFAULT 0, retry_at INTEGER DEFAULT 0, run_id INTEGER DEFAULT 0,
        PRIMARY KEY (document_id, target_language));
      INSERT INTO translation_queue VALUES ('legacy', 'English', 2, 1, 'retrying', 'Temporary error', 1, 2, 123, 7);`);
    legacy.close();
    const source = `import assert from 'node:assert/strict';
      const { ensureStorageSchema, getStorage } = await import('./db/books.ts');
      await ensureStorageSchema(); const { db } = getStorage();
      const page = await db.prepare('SELECT * FROM translation_queue_pages').first();
      assert.equal(page.page, 2); assert.equal(page.retry_count, 2); assert.equal(page.retry_at, 123);
      assert.equal(page.error, 'Temporary error');
      const job = await db.prepare('SELECT * FROM translation_queue').first();
      assert.equal(job.next_page, 3); assert.equal(job.run_id, 7); assert.equal(job.retry_count, 2);
      assert.equal((await db.prepare('SELECT concurrency FROM translation_queue_settings').first()).concurrency, 4);`;
    for (let restart = 0; restart < 2; restart++) await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: process.cwd(), env: { ...process.env, VERSO_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(output)));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reader and provider limiters allow ten requests and hold the eleventh", async () => {
  const { createPriorityTaskQueue } = await import("../lib/priority-task-queue.ts");
  for (const priority of [false, true]) {
    const queue = priority ? createPriorityTaskQueue() : createConcurrencyLimiter();
    const started = [];
    const releases = [];
    const tasks = Array.from({ length: 11 }, (_, index) => {
      const run = () => new Promise(resolve => { started.push(index); releases[index] = resolve; });
      return priority ? queue.run(String(index), 1, 10, run) : queue.run(10, run);
    });
    await new Promise(setImmediate);
    assert.equal(started.length, 10);
    releases[0]();
    await new Promise(setImmediate);
    assert.equal(started.length, 11);
    for (const release of releases) release();
    await Promise.all(tasks);
  }
});

test("prioritizes reader jobs, promotes pending pages, and shares running translations", async () => {
  const { createPriorityTaskQueue } = await import("../lib/priority-task-queue.ts");
  const queue = createPriorityTaskQueue();
  const order = [];
  let release;
  const first = queue.run("running", 0, 1, () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const shared = queue.run("running", 1, 1, async () => { throw new Error("Duplicate running page"); });
  assert.equal(first, shared);
  const background = queue.run("background", 0, 1, async () => order.push("background"));
  const promoted = queue.run("promoted", 0, 1, async () => order.push("promoted"));
  assert.equal(promoted, queue.run("promoted", 1, 1, async () => { throw new Error("Duplicate pending page"); }));
  const reader = queue.run("reader", 1, 1, async () => order.push("reader"));
  release("shared result");
  assert.equal(await shared, "shared result");
  await Promise.all([first, background, promoted, reader]);
  assert.deepEqual(order, ["promoted", "reader", "background"]);
  await assert.rejects(queue.run("failure", 1, 1, async () => { throw new Error("Provider failed"); }), /Provider failed/);
  assert.equal(await queue.run("failure", 1, 1, async () => "retry"), "retry");
});

async function uploadQueueBook(fingerprint, pageCount) {
  const bytes = new TextEncoder().encode("%PDF-queue-test");
  const metadata = { fingerprint, name: "Queue test.pdf", size: bytes.length, pageCount, contentType: "application/pdf" };
  const session = await (await fetch(`${baseUrl}/api/books/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata),
  })).json();
  const part = await (await fetch(`${baseUrl}/api/books/uploads/${session.uploadId}/parts/1`, {
    method: "PUT", headers: { "x-object-key": session.objectKey }, body: bytes,
  })).json();
  const response = await fetch(`${baseUrl}/api/books/uploads/${session.uploadId}/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...metadata, objectKey: session.objectKey, parts: [part] }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).book;
}

test("translation archives round-trip all languages and navigation while retaining local records", async () => {
  const first = await uploadQueueBook("a1".repeat(32), 3);
  const second = await uploadQueueBook("a2".repeat(32), 2);
  const entries = [
    { book: first, page: 1, language: "Simplified Chinese", text: "译文与公式 $x^2$" },
    { book: first, page: 2, language: "English", text: "Translated paragraph" },
    { book: second, page: 1, language: "Japanese", text: "翻訳" },
  ];
  for (const { book, page, language, text } of entries) {
    const response = await fetch(`${baseUrl}/api/translations`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: translationCacheKey(book.fingerprint, page, language), documentId: book.fingerprint, page,
        translation: { page, markdown: text, blocks: [{ kind: "paragraph", text, sourceRect: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } }], cacheVersion: 42, cachedAt: 1234 } }),
    });
    assert.equal(response.status, 200);
  }
  const observation = { pdfPage: 1, isTableOfContents: true,
    tocEntries: [{ sourcePage: 1, ordinal: 0, title: "Chapter one", label: "1", value: 1, numbering: "arabic", level: 0 }],
    anchor: { pdfPage: 1, label: "i", value: 1, numbering: "roman" } };
  for (const fields of [{ observation }, { manualOffset: 2 }]) {
    assert.equal((await fetch(`${baseUrl}/api/navigation`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: first.fingerprint, ...fields }) })).status, 200);
  }
  const singleResponse = await fetch(`${baseUrl}/api/translations/archive?documentId=${first.id}`);
  assert.equal(singleResponse.status, 200);
  assert.match(singleResponse.headers.get("content-disposition"), /attachment; filename=".*\.json"/);
  assert.equal(singleResponse.headers.get("cache-control"), "no-store");
  const single = await singleResponse.json();
  assert.equal(singleResponse.headers.get("content-disposition"), `attachment; filename="verso-${first.fingerprint.slice(0, 16)}-translations-${Date.parse(single.exportedAt)}.json"`);
  assert.equal(single.format, "verso-translations");
  assert.equal(single.version, 1);
  assert.equal(single.books.length, 1);
  assert.equal(single.books[0].translations.length, 2);
  assert.deepEqual(single.books[0].navigation, { observations: [observation], manualOffset: 2 });
  const allResponse = await fetch(`${baseUrl}/api/translations/archive`);
  const all = await allResponse.json();
  assert.equal(allResponse.headers.get("content-disposition"), `attachment; filename="verso-library-translations-${Date.parse(all.exportedAt)}.json"`);
  assert.ok(all.books.some(book => book.fingerprint === second.fingerprint));
  const archive = { ...all, books: all.books.filter(book => [first.fingerprint, second.fingerprint].includes(book.fingerprint)) };
  const sqlite = new DatabaseSync(path.join(testDataDirectory, "verso.sqlite"));
  try {
    for (const table of ["translations", "navigation_pages", "navigation_settings"]) {
      sqlite.prepare(`DELETE FROM ${table} WHERE document_id IN (?, ?)`).run(first.fingerprint, second.fingerprint);
    }
    // Restore to a library whose local book IDs differ from the export source.
    sqlite.prepare("UPDATE books SET id = ? WHERE fingerprint = ?").run("restored-book-id", first.fingerprint);
    const restored = await fetch(`${baseUrl}/api/translations/archive`, { method: "POST", body: JSON.stringify(archive) });
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { books: 2, imported: 3, retained: 0, missingBooks: 0 });
    const after = await (await fetch(`${baseUrl}/api/translations/archive?documentId=${first.fingerprint}`)).json();
    assert.deepEqual(after.books, single.books);
    for (const { book, page, language, text } of entries) {
      const query = new URLSearchParams({ key: translationCacheKey(book.fingerprint, page, language) });
      const cached = await (await fetch(`${baseUrl}/api/translations?${query}`)).json();
      assert.equal(cached.translation.markdown, text);
    }
    archive.books[0].translations[0].translation.markdown = "Do not replace local work";
    const repeated = await fetch(`${baseUrl}/api/translations/archive`, { method: "POST", body: JSON.stringify(archive) });
    assert.deepEqual(await repeated.json(), { books: 2, imported: 0, retained: 3, missingBooks: 0 });
    assert.deepEqual((await (await fetch(`${baseUrl}/api/translations/archive?documentId=${first.fingerprint}`)).json()).books, single.books);
  } finally { sqlite.close(); }
});

test("translation archive imports reject mismatches and invalid files before writing any records", async () => {
  const book = await uploadQueueBook("a3".repeat(32), 2);
  const entry = { key: translationCacheKey(book.fingerprint, 1, "English"), page: 1,
    translation: { page: 1, markdown: "Page one", blocks: [] }, updatedAt: 100 };
  const archive = { format: "verso-translations", version: 1, books: [{ fingerprint: book.fingerprint, name: book.name, pageCount: 2,
    translations: [entry], navigation: { observations: [], manualOffset: null } }] };
  const invalidArchives = [
    null, {}, { ...archive, version: 99 },
    { ...archive, books: [{ ...archive.books[0], translations: [entry, { ...entry, page: 3 }] }] },
    { ...archive, books: [{ ...archive.books[0], translations: [entry, entry] }] },
    { ...archive, books: [{ ...archive.books[0], translations: [{ ...entry, key: translationCacheKey("a4".repeat(32), 1, "English") }] }] },
    { ...archive, books: [{ ...archive.books[0], translations: [{ ...entry, translation: {} }] }] },
  ];
  for (const value of invalidArchives) {
    const response = await fetch(`${baseUrl}/api/translations/archive`, { method: "POST", body: JSON.stringify(value) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "INVALID_ARCHIVE");
  }
  const malformed = await fetch(`${baseUrl}/api/translations/archive`, { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  const mismatch = await fetch(`${baseUrl}/api/translations/archive?documentId=${book.id}`, {
    method: "POST", body: JSON.stringify({ ...archive, books: [{ ...archive.books[0], fingerprint: "a4".repeat(32), translations: [] }] }),
  });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "BOOK_MISMATCH");
  assert.equal((await fetch(`${baseUrl}/api/translations/archive?documentId=missing-book`)).status, 404);
  const exported = await (await fetch(`${baseUrl}/api/translations/archive?documentId=${book.id}`)).json();
  assert.deepEqual(exported.books[0].translations, []);
  const restored = await fetch(`${baseUrl}/api/translations/archive?documentId=${book.id}`, { method: "POST", body: JSON.stringify(archive) });
  assert.deepEqual(await restored.json(), { books: 1, imported: 1, retained: 0, missingBooks: 0 });
});

test("library translation import reports books whose PDFs have not been uploaded", async () => {
  const archive = { format: "verso-translations", version: 1, books: [{ fingerprint: "a5".repeat(32), name: "Missing.pdf", pageCount: 1,
    translations: [], navigation: { observations: [], manualOffset: null } }] };
  const response = await fetch(`${baseUrl}/api/translations/archive`, { method: "POST", body: JSON.stringify(archive) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { books: 0, imported: 0, retained: 0, missingBooks: 1 });
});

async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for translation work");
}

async function queueStatus(documentId, language = "English") {
  const response = await fetch(`${baseUrl}/api/translation-queue?targetLanguage=${encodeURIComponent(language)}`);
  assert.equal(response.status, 200);
  return (await response.json()).jobs.find((job) => job.documentId === documentId);
}

async function configureQueue(concurrency) {
  const response = await fetch(`${baseUrl}/api/translation-queue`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "configure", concurrency }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.concurrency, concurrency);
}

async function enqueueTestBook(book, language = "English") {
  const response = await fetch(`${baseUrl}/api/translation-queue`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: book.id, targetLanguage: language, translationConcurrency: 1 }),
  });
  assert.equal(response.status, 202);
}

async function readTestPage(book, page, extra = {}) {
  return fetch(`${baseUrl}/api/translate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: book.fingerprint, targetLanguage: "English", page, totalPages: book.pageCount,
      contextPages: [page], translationConcurrency: 1, ...extra }),
  });
}

test("persists whole-book work, shares reader requests, skips cached blank pages, and retries failures", async () => {
  assert.equal((await (await fetch(`${baseUrl}/api/translation-queue`)).json()).settings.concurrency, 4);
  await configureQueue(1);
  const book = await uploadQueueBook("b".repeat(64), 4);
  const calls = [];
  const responses = new Map();
  let failPage = 0;
  const transientFailures = new Map();
  let hold = true;
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const page = Number(input.messages[0].content[0].text.match(/The requested page is (\d+)/)[1]);
    calls.push(page);
    const finish = () => {
      if (response.writableEnded || response.destroyed) return;
      response.setHeader("Content-Type", "application/json");
      if (transientFailures.get(page) > 0) {
        transientFailures.set(page, transientFailures.get(page) - 1);
        response.end(JSON.stringify({ choices: [{ message: { content: '{"blocks": [invalid json' } }] }));
        return;
      }
      if (page === failPage) { response.writeHead(429); response.end(JSON.stringify({ error: { message: "Rate limit" } })); return; }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ page, blocks: [{ kind: "paragraph", text: `Page ${page}.` }], previousPageRevision: null }) } }] }));
    };
    if (hold) responses.set(page, finish);
    else finish();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const settings = await fetch(`${baseUrl}/api/settings/ai-provider`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        provider: "compatible", endpoint: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "test-key", model: "test", reasoningEffort: "none",
      }),
    });
    assert.equal(settings.status, 200);
    const blank = await fetch(`${baseUrl}/api/translations`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        key: translationCacheKey(book.fingerprint, 1, "English"), documentId: book.fingerprint, page: 1,
        translation: { page: 1, blocks: [], isBlank: true, markdown: "" },
      }),
    });
    assert.equal(blank.status, 200);
    await Promise.all([enqueueTestBook(book), enqueueTestBook(book)]);
    await waitFor(() => responses.has(2));
    const live = await (await fetch(`${baseUrl}/api/traces`)).json();
    assert.ok(live.traces.some(trace => trace.background && trace.page === 2 && trace.status === "running" && trace.spans.some(span => span.name === "provider.wait_headers" && span.status === "running")));
    // A cached blank page must bypass a queue whose only provider slot is occupied.
    const cachedWhileBusy = await fetch(`${baseUrl}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: book.fingerprint, targetLanguage: "English", page: 1, totalPages: book.pageCount, contextPages: [1], translationConcurrency: 1 }),
      signal: AbortSignal.timeout(2000) });
    assert.equal(cachedWhileBusy.status, 200);
    const fast = await cachedWhileBusy.json();
    assert.equal(fast.isBlank, true);
    assert.equal(fast.trace.attributes.cacheHit, true);
    assert.ok(!fast.trace.spans.some(span => span.name === "queue.wait"));
    // OCR must finish while the provider is still deliberately held open.
    await waitFor(async () => {
      const { traces } = await (await fetch(`${baseUrl}/api/traces`)).json();
      return traces.some(trace => trace.bookId === book.fingerprint && trace.page === 2 && trace.status === "running"
        && trace.spans.some(span => span.name === "source.ocr" && span.status === "ok")
        && trace.spans.some(span => span.name === "provider.wait_headers" && span.status === "running"));
    });
    const samePage = readTestPage(book, 2);
    const reader = readTestPage(book, 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(calls, [2]);
    responses.get(2)();
    assert.equal((await samePage).status, 200);
    await waitFor(() => responses.has(4));
    assert.deepEqual(calls, [2, 4]);
    responses.get(4)();
    assert.equal((await reader).status, 200);
    await waitFor(() => responses.has(3));
    responses.get(3)();
    const completed = await waitFor(async () => { const job = await queueStatus(book.fingerprint); return job?.status === "completed" && job; });
    assert.equal(completed.completedPages, 4);
    assert.deepEqual(calls, [2, 4, 3]);
    hold = false;
    const cached = await readTestPage(book, 2);
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).serverManaged, true);
    await enqueueTestBook(book);
    await waitFor(async () => (await queueStatus(book.fingerprint))?.status === "completed");
    assert.deepEqual(calls, [2, 4, 3]);
    assert.equal((await readTestPage(book, 2, { force: true })).status, 200);
    assert.deepEqual(calls, [2, 4, 3, 2]);

    const retryBook = await uploadQueueBook("c".repeat(64), 4);
    calls.length = 0;
    failPage = 2;
    await enqueueTestBook(retryBook);
    const failed = await waitFor(async () => { const job = await queueStatus(retryBook.fingerprint); return job?.status === "partial" && job; });
    assert.equal(failed.completedPages, 3);
    assert.match(failed.error, /Rate limit/);
    assert.equal(failed.retryCount, 3);
    assert.equal(failed.maxRetriesPerPage, 3);
    assert.equal(failed.failedPageLimit, 3);
    assert.equal(failed.failedPages, 1);
    assert.deepEqual(failed.pageErrors.map(page => [page.page, page.retryCount, page.status]), [[2, 3, "failed"]]);
    assert.equal(failed.nextPage, 2);
    assert.deepEqual(calls, [1, 2, 2, 2, 2, 3, 4]);
    failPage = 0;
    // A page recovered by reading must no longer count as an exhausted failure.
    assert.equal((await readTestPage(retryBook, 2)).status, 200);
    const repaired = await queueStatus(retryBook.fingerprint);
    assert.equal(repaired.failedPages, 0);
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.retryCount, 0);
    await enqueueTestBook(retryBook);
    await waitFor(async () => (await queueStatus(retryBook.fingerprint))?.status === "completed");
    assert.deepEqual(calls, [1, 2, 2, 2, 2, 3, 4, 2]);
    await enqueueTestBook(retryBook, "Japanese");
    await waitFor(async () => (await queueStatus(retryBook.fingerprint, "Japanese"))?.status === "completed");
    assert.deepEqual(calls, [1, 2, 2, 2, 2, 3, 4, 2, 1, 2, 3, 4]);

    // Recovered errors across pages must never count as exhausted pages.
    const recoveredBook = await uploadQueueBook("f".repeat(64), 2);
    calls.length = 0;
    transientFailures.set(1, 2);
    transientFailures.set(2, 2);
    await enqueueTestBook(recoveredBook);
    const retrying = await waitFor(async () => {
      const job = await queueStatus(recoveredBook.fingerprint);
      return job?.status === "retrying" && job;
    });
    assert.ok(retrying.error);
    assert.equal(retrying.nextPage, 1);
    const recovered = await waitFor(async () => {
      const job = await queueStatus(recoveredBook.fingerprint);
      return job?.status === "completed" && job;
    });
    assert.equal(recovered.retryCount, 0);
    assert.equal(recovered.error, null);
    assert.deepEqual(calls, [1, 1, 1, 2, 2, 2]);

    // Stop an in-flight page, preserve earlier pages, and immediately resume the same job.
    const stopBook = await uploadQueueBook("8".repeat(64), 3);
    calls.length = 0;
    hold = true;
    responses.clear();
    await enqueueTestBook(stopBook);
    await waitFor(() => responses.has(1));
    await enqueueTestBook(stopBook, "Japanese");
    assert.equal((await fetch(`${baseUrl}/api/translation-queue`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: stopBook.id, targetLanguage: "Japanese", action: "stop" }),
    })).status, 200);
    assert.equal((await queueStatus(stopBook.fingerprint, "Japanese")).status, "stopped");
    assert.equal((await queueStatus(stopBook.fingerprint)).status, "running");
    responses.get(1)();
    await waitFor(() => responses.has(2));
    const lateResponse = responses.get(2);
    const stop = await fetch(`${baseUrl}/api/translation-queue`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: stopBook.id, targetLanguage: "English", action: "stop" }),
    });
    assert.equal(stop.status, 200);
    const stoppedJob = await queueStatus(stopBook.fingerprint);
    assert.equal(stoppedJob.status, "stopped");
    assert.equal(stoppedJob.completedPages, 1);
    assert.equal(stoppedJob.retryCount, 0);
    lateResponse();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(calls, [1, 2]);
    assert.equal((await queueStatus(stopBook.fingerprint)).status, "stopped");
    hold = false;
    await enqueueTestBook(stopBook);
    const resumed = await waitFor(async () => {
      const job = await queueStatus(stopBook.fingerprint);
      return job?.status === "completed" && job;
    });
    assert.equal(resumed.completedPages, 3);
    assert.equal(resumed.error, null);
    assert.deepEqual(calls, [1, 2, 2, 3]);

    // Stop during backoff: no retry fires until the user resumes.
    const backoffBook = await uploadQueueBook("ab".repeat(32), 1);
    failPage = 1;
    calls.length = 0;
    await enqueueTestBook(backoffBook);
    await waitFor(async () => (await queueStatus(backoffBook.fingerprint))?.status === "retrying");
    assert.equal((await fetch(`${baseUrl}/api/translation-queue`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: backoffBook.id, targetLanguage: "English", action: "stop" }),
    })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(calls, [1]);
    assert.equal((await queueStatus(backoffBook.fingerprint)).status, "stopped");
    failPage = 0;
    const allJobs = await (await fetch(`${baseUrl}/api/translation-queue`)).json();
    assert.ok(allJobs.jobs.some(job => job.documentId === retryBook.fingerprint && job.targetLanguage === "Japanese"));
    assert.ok(allJobs.jobs.some(job => job.documentId === retryBook.fingerprint && job.targetLanguage === "English"));
    assert.ok(allJobs.jobs.every(job => job.bookName && job.bookId && job.maxRetriesPerPage === 3 && job.failedPageLimit === 3));

    // Discarding must prevent a still-running provider response from restoring the cache.
    const discardBook = await uploadQueueBook("d".repeat(64), 2);
    hold = true;
    responses.clear();
    await enqueueTestBook(discardBook);
    await waitFor(() => responses.has(1));
    const discard = await fetch(`${baseUrl}/api/translations?documentId=${discardBook.fingerprint}`, { method: "DELETE" });
    assert.equal(discard.status, 200);
    responses.get(1)();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await queueStatus(discardBook.fingerprint), undefined);
    const query = new URLSearchParams({ documentId: discardBook.fingerprint, cacheKeySuffix: translationCacheSuffix("English") });
    assert.deepEqual((await (await fetch(`${baseUrl}/api/translations?${query}`)).json()).pages, []);

    const restartBook = await uploadQueueBook("e".repeat(64), 2);
    calls.length = 0;
    responses.clear();
    await enqueueTestBook(restartBook);
    await waitFor(() => responses.has(1));
    responses.get(1)();
    await waitFor(() => responses.has(2));
    hold = false;
    const stopped = new Promise((resolve) => serverProcess.once("exit", resolve));
    serverProcess.kill("SIGKILL");
    await stopped;
    serverProcess = spawn(process.execPath, [".next/standalone/server.js"], {
      cwd: process.cwd(),
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: new URL(baseUrl).port,
        VERSO_DATA_DIR: testDataDirectory, VERSO_PDF_RENDERER_LOG: rendererLogPath,
        PATH: `${testDataDirectory}:${process.env.PATH || ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(async () => {
      try { return (await fetch(`${baseUrl}/api/books`)).ok; } catch { return false; }
    });
    await waitFor(async () => (await queueStatus(restartBook.fingerprint))?.status === "completed");
    assert.deepEqual(calls, [1, 2, 2]);
    const persistedStop = await queueStatus(backoffBook.fingerprint);
    assert.equal(persistedStop.status, "stopped");
    assert.equal(persistedStop.retryCount, 1);
    assert.equal((await queueStatus(stopBook.fingerprint, "Japanese")).status, "stopped");
  } finally {
    hold = false;
    for (const finish of responses.values()) finish();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("runs ten background pages, applies independent limits live, and resumes out-of-order work", async () => {
  const book = await uploadQueueBook("bc".repeat(32), 15);
  const calls = [];
  const pending = new Map();
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const page = Number(input.messages[0].content[0].text.match(/The requested page is (\d+)/)[1]);
    calls.push(page);
    pending.set(page, response);
    response.on("close", () => { if (pending.get(page) === response) pending.delete(page); });
  });
  const finish = (page, fail = false) => {
    const response = pending.get(page);
    assert.ok(response, `Page ${page} must be in flight`);
    pending.delete(page);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: fail ? "invalid JSON" : JSON.stringify({ page,
      blocks: [{ kind: "paragraph", text: `Concurrent page ${page}.` }],
      previousPageRevision: page === 3 && pending.has(2) ? { page: 2, blocks: [{ kind: "paragraph", text: `Concurrent page ${page}.` }] } : null }) } }] }));
  };
  const stop = async (value) => {
    const response = await fetch(`${baseUrl}/api/translation-queue`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: value.id, targetLanguage: "English", action: "stop" }) });
    assert.equal(response.status, 200);
  };
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(`${baseUrl}/api/settings/ai-provider`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "compatible", endpoint: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "test-key", model: "test", reasoningEffort: "none" }) })).status, 200);
    for (const invalid of [0, 11, 1.5, "10", null]) {
      assert.equal((await fetch(`${baseUrl}/api/translation-queue`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "configure", concurrency: invalid }) })).status, 400);
    }
    await configureQueue(3);
    // The legacy reader concurrency field must not overwrite the background setting.
    await enqueueTestBook(book);
    await waitFor(() => pending.size === 3);
    assert.deepEqual([...pending.keys()].sort((a, b) => a - b), [1, 2, 3]);
    assert.equal((await queueStatus(book.fingerprint)).activePages, 3);
    finish(3);
    await waitFor(() => pending.has(4));
    const parallelPage = await (await readTestPage(book, 3)).json();
    assert.ok(parallelPage.blocks.some(block => block.text === "Concurrent page 3."), "Do not remove text against an unapplied predecessor revision");
    await configureQueue(1);
    finish(4); finish(2);
    await waitFor(async () => (await queueStatus(book.fingerprint)).completedPages === 3);
    assert.deepEqual([...pending.keys()], [1]);
    assert.equal(calls.length, 4);
    finish(1);
    await waitFor(() => pending.has(5));
    await configureQueue(10);
    await waitFor(() => pending.size === 10);
    assert.deepEqual([...pending.keys()].sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index + 5));
    assert.equal((await queueStatus(book.fingerprint)).activePages, 10);
    const interrupted = new Promise(resolve => serverProcess.once("exit", resolve));
    serverProcess.kill("SIGKILL"); await interrupted;
    await waitFor(() => pending.size === 0);
    serverProcess = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(),
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: new URL(baseUrl).port, VERSO_DATA_DIR: testDataDirectory,
        VERSO_PDF_RENDERER_LOG: rendererLogPath, PATH: `${testDataDirectory}:${process.env.PATH || ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(() => pending.size === 10);
    assert.equal((await queueStatus(book.fingerprint)).completedPages, 4);
    assert.deepEqual([...pending.keys()].sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index + 5));
    await stop(book);
    await waitFor(() => pending.size === 0);
    const stopped = await queueStatus(book.fingerprint);
    assert.equal(stopped.completedPages, 4);
    assert.equal(stopped.status, "stopped");
    await enqueueTestBook(book);
    await waitFor(() => pending.size === 10);
    for (let page = 14; page >= 5; page--) finish(page);
    await waitFor(() => pending.has(15));
    finish(15);
    await waitFor(async () => (await queueStatus(book.fingerprint)).status === "completed");
    assert.equal((await queueStatus(book.fingerprint)).completedPages, 15);
    assert.equal(calls.filter(page => page <= 4).length, 4);
    assert.equal((await readTestPage(book, 1, { translationConcurrency: 10 })).status, 200);
    assert.equal((await readTestPage(book, 1, { translationConcurrency: 11 })).status, 400);

    await configureQueue(2);
    const retryBook = await uploadQueueBook("bd".repeat(32), 4);
    await enqueueTestBook(retryBook);
    await waitFor(() => pending.has(1) && pending.has(2));
    finish(1, true);
    await waitFor(() => pending.has(1));
    finish(2, true);
    await waitFor(async () => (await queueStatus(retryBook.fingerprint)).retryCount === 2);
    finish(1);
    await waitFor(async () => (await queueStatus(retryBook.fingerprint)).retryCount === 1);
    assert.equal((await queueStatus(retryBook.fingerprint)).completedPages, 1);
    await waitFor(() => pending.has(2));
    finish(2);
    await waitFor(() => pending.has(3) && pending.has(4));
    finish(3, true); finish(4);
    await waitFor(() => pending.has(3));
    finish(3, true);
    await waitFor(() => pending.has(3));
    finish(3);
    await waitFor(async () => (await queueStatus(retryBook.fingerprint)).status === "completed");
    assert.equal((await queueStatus(retryBook.fingerprint)).retryCount, 0);

    const exhaustedBook = await uploadQueueBook("be".repeat(32), 5);
    const exhaustedCallsStart = calls.length;
    await enqueueTestBook(exhaustedBook);
    // Each of these pages must get its own initial attempt plus all three retries.
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitFor(() => pending.has(1) && pending.has(2));
      finish(1, true); finish(2, true);
    }
    await waitFor(() => pending.has(3) && pending.has(4));
    const continuing = await queueStatus(exhaustedBook.fingerprint);
    assert.equal(continuing.failedPages, 2);
    assert.equal(continuing.nextPage, 3);
    assert.equal(continuing.status, "running");
    assert.equal(continuing.retryCount, 6);
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitFor(() => pending.has(3));
      finish(3, true);
    }
    await waitFor(async () => (await queueStatus(exhaustedBook.fingerprint)).status === "failed");
    await waitFor(() => pending.size === 0);
    const exhausted = await queueStatus(exhaustedBook.fingerprint);
    assert.equal(exhausted.failedPages, 3);
    assert.equal(exhausted.retryCount, 9);
    assert.equal(exhausted.completedPages, 0);
    assert.equal(exhausted.nextPage, 1);
    assert.deepEqual(exhausted.pageErrors.map(page => [page.page, page.retryCount, page.status]), [[1, 3, "failed"], [2, 3, "failed"], [3, 3, "failed"]]);
    const attempted = calls.slice(exhaustedCallsStart);
    for (const page of [1, 2, 3]) assert.equal(attempted.filter(value => value === page).length, 4);
    assert.equal(attempted.filter(value => value === 4).length, 1);
    assert.equal(attempted.includes(5), false);

    // Persist both the independent limit and the stopped/exhausted page records across restart.
    await configureQueue(10);
    const exited = new Promise(resolve => serverProcess.once("exit", resolve));
    serverProcess.kill("SIGKILL"); await exited;
    serverProcess = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(),
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: new URL(baseUrl).port, VERSO_DATA_DIR: testDataDirectory,
        VERSO_PDF_RENDERER_LOG: rendererLogPath, PATH: `${testDataDirectory}:${process.env.PATH || ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(async () => { try { return (await fetch(`${baseUrl}/api/books`)).ok; } catch { return false; } });
    assert.equal((await (await fetch(`${baseUrl}/api/translation-queue`)).json()).settings.concurrency, 10);
    assert.equal((await queueStatus(exhaustedBook.fingerprint)).retryCount, 9);
    assert.equal((await queueStatus(exhaustedBook.fingerprint)).failedPages, 3);
    const recoveredPage = readTestPage(exhaustedBook, 1);
    await waitFor(() => pending.has(1));
    finish(1);
    assert.equal((await recoveredPage).status, 200);
    const recoveredJob = await queueStatus(exhaustedBook.fingerprint);
    assert.equal(recoveredJob.failedPages, 2);
    assert.equal(recoveredJob.retryCount, 6);
    assert.equal(recoveredJob.status, "failed", "Recovery must not silently resume a paused book");
    await enqueueTestBook(exhaustedBook);
    await waitFor(() => pending.size === 4);
    finish(5); finish(4); finish(3); finish(2);
    await waitFor(async () => (await queueStatus(exhaustedBook.fingerprint)).status === "completed");
    assert.equal((await queueStatus(exhaustedBook.fingerprint)).retryCount, 0);
  } finally {
    await stop(book);
    await configureQueue(1);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});

test("bounds persisted traces and reads them after a process restart", async () => {
  const directory = path.join(testDataDirectory, "trace-retention");
  const run = (source) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(), env: { ...process.env, VERSO_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await run(`
    import { withTranslationTrace, traceStep } from './lib/server-translation-trace.ts';
    for (let page = 1; page <= 205; page++) {
      await withTranslationTrace({ page }, true, () => traceStep('fixture', async () => page));
    }
  `);
  await run(`
    import assert from 'node:assert/strict';
    import { listTranslationTraces } from './lib/server-translation-trace.ts';
    const traces = await listTranslationTraces();
    assert.equal(traces.length, 200);
    assert.ok(traces.every(trace => trace.status === 'ok' && trace.spans[0].durationMs >= 0));
  `);
});

test("parses fragmented SSE without splitting Unicode", async () => {
  const { readEventStream } = await import("../lib/event-stream.ts");
  const bytes = new TextEncoder().encode(': keep-alive\r\nevent: delta\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  for await (const event of readEventStream(stream)) events.push(event);
  assert.deepEqual(events, [{ event: "delta", data: '{"text":\n"中文"}' }]);
});

test("counts received output independently of chunks and calibrates TPS only with consistent usage", async () => {
  const { createTranslationStatistics } = await import("../lib/translation-progress.ts");
  let now = 0;
  const stats = createTranslationStatistics(() => now);
  assert.equal(stats.snapshot().tokensPerSecond, undefined);
  stats.receive("thinking ");
  now = 2000;
  stats.receive("中文");
  stats.receive("\uD83D");
  stats.receive("\uDE00");
  const whole = createTranslationStatistics(() => now);
  whole.receive("thinking 中文😀");
  assert.equal(stats.snapshot().characters, 12);
  assert.equal(stats.snapshot().tokens, whole.snapshot().tokens);
  assert.equal(stats.snapshot().tokensEstimated, true);
  assert.equal(stats.snapshot().tokensPerSecond, stats.snapshot().tokens / 2);
  assert.equal(stats.reportUsage({ completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 30 } }), false);
  assert.equal(stats.snapshot().tokensEstimated, true);
  assert.equal(stats.reportUsage({ completion_tokens: -1 }), false);
  assert.equal(stats.reportUsage({ completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 8 } }), true);
  assert.deepEqual(stats.snapshot(), { characters: 12, tokens: 12, tokensEstimated: false, tokensPerSecond: 6 });
  assert.equal(stats.reportUsage({ output_tokens: 10, output_tokens_details: { reasoning_tokens: 6 } }), true);
  assert.equal(stats.snapshot().tokens, 10);
});

test("rejects interrupted, truncated, refused, and failed provider streams", async () => {
  const { readProviderStream } = await import("../lib/server-provider-stream.ts");
  const { readTranslationResponse } = await import("../lib/translation-progress.ts");
  const handlers = { event() {}, text() {}, reasoning() {} };
  for (const [responses, events] of [
    [false, [{ choices: [{ delta: { content: '{"blocks":[]}' } }] }]],
    [false, [{ choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"]],
    [false, [{ choices: [{ delta: { refusal: "No" } }] }, "[DONE]"]],
    [true, [{ type: "response.incomplete", response: {} }]],
    [true, [{ type: "error", message: "secret error detail" }]],
  ]) {
    const body = events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
    await assert.rejects(readProviderStream(new Response(body), responses, handlers));
  }
  await assert.rejects(readTranslationResponse(new Response('event: progress\ndata: {"phase":"thinking"}\n\n', { headers: { "Content-Type": "text/event-stream" } }), () => {}), /before the result/);
});

test("streams numeric progress to late readers of background work and saves only complete results", async () => {
  const { readTranslationResponse } = await import("../lib/translation-progress.ts");
  const calls = [];
  let providerResponse;
  let incoming;
  const provider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    incoming = JSON.parse(Buffer.concat(chunks));
    calls.push(incoming);
    providerResponse = response;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(': keep-alive\n\n');
    response.write(`data: ${JSON.stringify(incoming.input
      ? { type: "response.reasoning_summary_text.delta", delta: "private reasoning" }
      : { choices: [{ index: 0, delta: { reasoning_content: "private reasoning" } }] })}\n\n`);
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    for (const [index, format] of ["compatible", "openai"].entries()) {
      const book = await uploadQueueBook((index ? "7" : "6").repeat(64), 1);
      const saved = await fetch(`${baseUrl}/api/settings/ai-provider`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: format, endpoint: `http://127.0.0.1:${provider.address().port}/${index ? "responses" : "v1"}`, apiKey: "stream-secret", model: "stream-model", reasoningEffort: "high" }) });
      assert.equal(saved.status, 200);
      providerResponse = undefined;
      await enqueueTestBook(book);
      await waitFor(() => providerResponse);
      assert.equal(incoming.stream, true);
      if (!index) assert.equal(incoming.stream_options.include_usage, true);
      const progress = [];
      const connect = (signal) => fetch(`${baseUrl}/api/translate`, { method: "POST", signal, headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ bookId: book.fingerprint, page: 1, totalPages: 1, contextPages: [1], targetLanguage: "English", translationConcurrency: 1 }) });
      const response = await connect();
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      let finished = false;
      const resultPromise = readTranslationResponse(response, value => progress.push(value)).then(value => { finished = true; return value; });
      await waitFor(() => progress.some(value => value.phase === "thinking"));
      const partial = '{"page":1,"blocks":[{"kind":"paragraph","text":"实时译文';
      const delta = content => index ? { type: "response.output_text.delta", delta: content } : { choices: [{ index: 0, delta: { content } }] };
      providerResponse.write(`data: ${JSON.stringify(delta(partial))}\n\n`);
      await waitFor(() => progress.some(value => value.phase === "generating" && value.characters === 17 + Array.from(partial).length));
      assert.equal(finished, false);
      assert.equal((await queueStatus(book.fingerprint)).completedPages, 0);
      assert.equal(calls.length, index + 1);
      // Disconnecting an observer must not cancel the job or another observer.
      const controller = new AbortController();
      const second = await connect(controller.signal);
      const secondProgress = [];
      const secondResult = readTranslationResponse(second, value => secondProgress.push(value)).catch(() => undefined);
      await waitFor(() => secondProgress.some(value => value.phase === "generating" && value.characters === 17 + Array.from(partial).length));
      controller.abort();
      await secondResult;
      const tail = '。"}],"previousPageRevision":null}';
      providerResponse.write(`data: ${JSON.stringify(delta(tail))}\n\n`);
      const usage = index ? { input_tokens: 123, output_tokens: 45, output_tokens_details: { reasoning_tokens: 12 } }
        : { prompt_tokens: 123, completion_tokens: 45, completion_tokens_details: { reasoning_tokens: 12 } };
      providerResponse.end(index ? `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
      const result = await resultPromise;
      assert.equal(result.blocks[0].text, "实时译文。");
      assert.doesNotMatch(JSON.stringify(progress), /private reasoning|实时译文|lastLine/);
      const aligned = progress.find(value => value.phase === "aligning");
      assert.equal(aligned.characters, 17 + Array.from(partial + tail).length);
      assert.equal(aligned.tokens, 45);
      assert.equal(aligned.tokensEstimated, false);
      assert.equal(result.trace.attributes.shared, true);
      await waitFor(async () => (await queueStatus(book.fingerprint)).status === "completed");
      const { traces } = await (await fetch(`${baseUrl}/api/traces`)).json();
      const trace = traces.find(value => value.bookId === book.fingerprint && value.background);
      assert.equal(trace.attributes.streamed, true);
      assert.equal(trace.attributes.outputTokens, 45);
      assert.equal(trace.attributes.reasoningTokens, 12);
      assert.equal(trace.attributes.outputUsageConsistent, true);
      const span = name => trace.spans.find(value => value.name === name);
      assert.ok(span("provider.first_text").durationMs > span("provider.wait_headers").durationMs);
      assert.ok(span("provider.first_event").durationMs <= span("provider.first_text").durationMs);
      assert.ok(span("provider.first_output").durationMs <= span("provider.first_text").durationMs);
      assert.ok(span("provider.first_reasoning").durationMs <= span("provider.first_text").durationMs);
      assert.equal(span("provider.stream").status, "ok");
      assert.doesNotMatch(JSON.stringify(traces), /private reasoning|stream-secret|实时译文/);
      const cached = await readTestPage(book, 1);
      assert.equal((await cached.json()).blocks[0].text, "实时译文。");
    }
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});

test("reports streamed failures without saving a partial translation", async () => {
  const { readTranslationResponse } = await import("../lib/translation-progress.ts");
  const provider = createHttpServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"blocks":[{"text":"Partial"}]}' }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const book = await uploadQueueBook("9".repeat(64), 1);
    await fetch(`${baseUrl}/api/settings/ai-provider`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "compatible", endpoint: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture", model: "fixture", reasoningEffort: "none" }) });
    const response = await fetch(`${baseUrl}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ bookId: book.fingerprint, page: 1, totalPages: 1, contextPages: [1], targetLanguage: "English" }) });
    const result = await readTranslationResponse(response, () => {});
    assert.match(result.error, /length/);
    assert.equal(result.trace.status, "error");
    assert.ok(result.trace.spans.some(span => span.name === "provider.stream" && span.status === "error"));
    const key = translationCacheKey(book.fingerprint, 1, "English");
    const cached = await (await fetch(`${baseUrl}/api/translations?key=${encodeURIComponent(key)}`)).json();
    assert.equal(cached.translation, null);
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
