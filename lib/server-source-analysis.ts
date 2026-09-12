import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBookPath, resolveRenderPath, type StoredBook } from "../db/books.ts";
import { createConcurrencyLimiter } from "./concurrency-limiter.ts";
import { getEmbeddedPageLayout, getCachedSourcePageLayout } from "./server-source-layout.ts";
import { buildTextPage, isTextOnlySvg, type TextPage } from "./translation-source-plan.ts";
import type { SourcePageLayout } from "./source-alignment.ts";
import { traceStep } from "./server-translation-trace.ts";

const run = promisify(execFile);
const limiter = createConcurrencyLimiter();
const jobs = new Map<string, Promise<boolean>>();

async function textOnly(book: StoredBook, page: number, layout: SourcePageLayout): Promise<boolean> {
  const file = resolveRenderPath(book.fingerprint, "v2", "textonly", page).replace(/\.jpg$/, ".json");
  try { const result = JSON.parse(await readFile(file, "utf8")); if (typeof result === "boolean") return result; }
  catch { /* Analysis caches are disposable, unlike saved translations. */ }
  const existing = jobs.get(file);
  if (existing) return existing;
  const job = limiter.run(2, async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}`;
    try {
      // stdout is bounded by execFile, including embedded image data in scans.
      const { stdout } = await traceStep("source.graphics", () => run("pdftocairo",
        ["-svg", "-f", String(page), "-l", String(page), resolveBookPath(book.objectKey), "-"],
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }), { page });
      const result = isTextOnlySvg(stdout, layout);
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
      await rename(temporary, file);
      return result;
    } catch { return false; }
    finally { await rm(temporary, { force: true }); }
  });
  jobs.set(file, job);
  void job.finally(() => jobs.delete(file)).catch(() => undefined);
  return job;
}

export type SourceAnalysis = { layout: SourcePageLayout | null; textPage: TextPage | null };
export async function analyzeSourcePage(book: StoredBook, page: number): Promise<SourceAnalysis> {
  const embedded = await getEmbeddedPageLayout(book, page).catch(() => null);
  if (!embedded) return { layout: await getCachedSourcePageLayout(book, page), textPage: null };
  const candidate = buildTextPage(embedded);
  const verified = candidate && await textOnly(book, page, embedded);
  return { layout: embedded, textPage: verified ? candidate : null };
}
