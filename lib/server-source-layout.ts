import { traceStep, startSpan } from "./server-translation-trace.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBookPath, resolveRenderPath, type StoredBook } from "../db/books.ts";
import { createConcurrencyLimiter } from "./concurrency-limiter.ts";
import { getRenderedPage } from "./server-page-renderer.ts";
import { parsePdfWordLayout, parseOcrWordLayout, type SourcePageLayout } from "./source-alignment.ts";

const run = promisify(execFile);
const limiter = createConcurrencyLimiter();
const jobs = new Map<string, Promise<SourcePageLayout>>();

export async function getSourcePageLayout(book: StoredBook, page: number): Promise<SourcePageLayout> {
  if (!Number.isSafeInteger(page) || page < 1 || page > book.pageCount) throw new RangeError("Invalid source layout page.");
  const cachePath = resolveRenderPath(book.fingerprint, "v1", "words", page).replace(/\.jpg$/, ".json");
  const cached = startSpan("source.cache", { page });
  try { const layout = JSON.parse(await readFile(cachePath, "utf8")) as SourcePageLayout; cached("ok", { cacheHit: true }); return layout; }
  catch (error) { cached("ok", { cacheHit: false }); if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = jobs.get(cachePath);
  if (existing) return traceStep("source.shared_wait", () => existing, { page });
  const queued = startSpan("source.queue", { page });
  const job = limiter.run(2, async () => {
    queued();
    let layout: SourcePageLayout | undefined;
    try {
      const [result, info] = await traceStep("source.pdf_text", () => Promise.all([
        run("pdftotext", ["-f", String(page), "-l", String(page), "-cropbox", "-bbox-layout", resolveBookPath(book.objectKey), "-"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
        run("pdfinfo", ["-f", String(page), "-l", String(page), "-box", resolveBookPath(book.objectKey)], { timeout: 30_000, maxBuffer: 1024 * 1024 }),
      ]), { page });
      const rotation = Number(/Page\s+(?:\d+\s+)?rot:\s*(-?\d+)/i.exec(info.stdout)?.[1] || 0);
      layout = parsePdfWordLayout(result.stdout, rotation);
    } catch { /* Image-only PDFs and unavailable text extractors use local OCR. */ }
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
  });
  jobs.set(cachePath, job);
  void job.finally(() => jobs.delete(cachePath)).catch(() => undefined);
  return job;
}
