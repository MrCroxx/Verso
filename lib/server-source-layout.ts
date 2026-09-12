import { traceStep, startSpan } from "./server-translation-trace.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBookPath, resolveRenderPath, type StoredBook } from "../db/books.ts";
import { createConcurrencyLimiter } from "./concurrency-limiter.ts";
import { getRenderedPage } from "./server-page-renderer.ts";
import { applyPdfFontSizes, parsePdfWordLayout, parseOcrWordLayout, isSourcePageLayout, type SourcePageLayout } from "./source-alignment.ts";

const run = promisify(execFile);
const limiter = createConcurrencyLimiter();
const jobs = new Map<string, Promise<SourcePageLayout>>();
const embeddedJobs = new Map<string, Promise<SourcePageLayout | null>>();

export async function getSourcePageLayout(book: StoredBook, page: number): Promise<SourcePageLayout> {
  if (!Number.isSafeInteger(page) || page < 1 || page > book.pageCount) throw new RangeError("Invalid source layout page.");
  const cachePath = resolveRenderPath(book.fingerprint, "v2", "words", page).replace(/\.jpg$/, ".json");
  const cached = startSpan("source.cache", { page });
  try { const layout = JSON.parse(await readFile(cachePath, "utf8")) as SourcePageLayout; cached("ok", { cacheHit: true }); return layout; }
  catch (error) { cached("ok", { cacheHit: false }); if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Existing OCR remains valid; the new cache version only enriches PDF fonts.
  const legacy = await getCachedSourcePageLayout(book, page);
  if (legacy?.method === "ocr") return legacy;
  const existing = jobs.get(cachePath);
  if (existing) return traceStep("source.shared_wait", () => existing, { page });
  const queued = startSpan("source.queue", { page });
  const job = getEmbeddedPageLayout(book, page).then((embedded) => limiter.run(2, async () => {
    queued();
    let layout: SourcePageLayout | undefined = embedded ?? undefined;
    if (!layout?.words.length) {
      const rendered = await getRenderedPage(book, page, "vision");
      await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      const input = `${cachePath}.${randomUUID()}.jpg`;
      try {
        await writeFile(input, rendered.bytes, { mode: 0o600 });
        const result = await traceStep("source.ocr", () => run("tesseract", [input, "stdout", "-l", "eng+chi_sim+chi_tra+jpn", "tsv"], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: "1" } }), { page });
        layout = parseOcrWordLayout(result.stdout);
      } finally { await rm(input, { force: true }); }
    }
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(layout), { mode: 0o600 });
      await rename(temporary, cachePath);
    } finally { await rm(temporary, { force: true }); }
    return layout;
  }));
  jobs.set(cachePath, job);
  void job.finally(() => jobs.delete(cachePath)).catch(() => undefined);
  return job;
}

// A separate negative cache prevents scans from repeatedly running pdftotext.
// This preflight never waits for OCR; cold OCR still overlaps the provider call.
export async function getEmbeddedPageLayout(book: StoredBook, page: number): Promise<SourcePageLayout | null> {
  if (!Number.isSafeInteger(page) || page < 1 || page > book.pageCount) throw new RangeError("Invalid source layout page.");
  const cachePath = resolveRenderPath(book.fingerprint, "v3", "embedded", page).replace(/\.jpg$/, ".json");
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (value === null || (isSourcePageLayout(value) && value.method === "pdf" && value.words.every((w) => Number.isSafeInteger(w.block)))) return value;
  }
  catch { /* A missing or damaged analysis cache can be regenerated. */ }
  const existing = embeddedJobs.get(cachePath);
  if (existing) return existing;
  const job = limiter.run(2, async () => {
    let layout: SourcePageLayout | null = null;
    try {
      const [result, info] = await traceStep("source.pdf_text", () => Promise.all([
        run("pdftotext", ["-f", String(page), "-l", String(page), "-cropbox", "-bbox-layout", resolveBookPath(book.objectKey), "-"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
        run("pdfinfo", ["-f", String(page), "-l", String(page), "-box", resolveBookPath(book.objectKey)], { timeout: 5000, maxBuffer: 1024 * 1024 }),
      ]), { page });
      const rotation = Number(/Page\s+(?:\d+\s+)?rot:\s*(-?\d+)/i.exec(info.stdout)?.[1] || 0);
      const parsed = parsePdfWordLayout(result.stdout, rotation);
      if (parsed.words.length) {
        layout = parsed;
        if (rotation % 360 === 0) {
          try {
            const fonts = await run("pdftohtml", ["-xml", "-hidden", "-i", "-zoom", "1", "-f", String(page), "-l", String(page),
              "-stdout", resolveBookPath(book.objectKey)], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
            layout = applyPdfFontSizes(parsed, fonts.stdout);
          } catch { /* Font metadata is optional; retain grounded word geometry. */ }
        }
      }
    } catch { return null; }
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(layout), { mode: 0o600 });
      await rename(temporary, cachePath);
    } finally { await rm(temporary, { force: true }); }
    return layout;
  });
  embeddedJobs.set(cachePath, job);
  void job.finally(() => embeddedJobs.delete(cachePath)).catch(() => undefined);
  return job;
}

export async function getCachedSourcePageLayout(book: StoredBook, page: number): Promise<SourcePageLayout | null> {
  for (const version of ["v2", "v1"]) {
    try {
      const value: unknown = JSON.parse(await readFile(resolveRenderPath(book.fingerprint, version, "words", page).replace(/\.jpg$/, ".json"), "utf8"));
      if (isSourcePageLayout(value)) return value;
    } catch { /* Try the previous compatible cache without rerunning OCR. */ }
  }
  return null;
}
