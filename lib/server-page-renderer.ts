import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { StoredBook } from "../db/books.ts";
import { resolveBookPath, resolveRenderPath } from "../db/books.ts";
import { createConcurrencyLimiter } from "./concurrency-limiter.ts";

export const PAGE_RENDER_VERSION = "v1";

export type PageRenderProfile = "display" | "thumbnail" | "vision";

const PROFILE_OPTIONS: Record<PageRenderProfile, { maxDimension: number; quality: number }> = {
  display: { maxDimension: 1600, quality: 82 },
  thumbnail: { maxDimension: 480, quality: 76 },
  vision: { maxDimension: 2200, quality: 88 },
};

const RENDER_CONCURRENCY = 2;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_ERROR_OUTPUT_LENGTH = 32 * 1024;
const limiter = createConcurrencyLimiter();
const renderJobs = new Map<string, Promise<RenderedPage>>();

export type RenderedPage = {
  bytes: Buffer;
  cacheHit: boolean;
  etag: string;
};

export class PageRendererUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageRendererUnavailableError";
  }
}

export function parsePageRenderProfile(value: string | null): PageRenderProfile | null {
  return value === "display" || value === "thumbnail" || value === "vision" ? value : null;
}

function pageEtag(book: StoredBook, page: number, profile: PageRenderProfile) {
  return `"${book.fingerprint}-${PAGE_RENDER_VERSION}-${profile}-${page}"`;
}

async function readCachedPage(book: StoredBook, page: number, profile: PageRenderProfile) {
  const filePath = resolveRenderPath(book.fingerprint, PAGE_RENDER_VERSION, profile, page);
  try {
    const file = await stat(/* turbopackIgnore: true */ filePath);
    if (!file.isFile() || file.size === 0) return null;
    return {
      bytes: await readFile(/* turbopackIgnore: true */ filePath),
      cacheHit: true,
      etag: pageEtag(book, page, profile),
    } satisfies RenderedPage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function runRenderer(inputPath: string, outputPrefix: string, page: number, profile: PageRenderProfile) {
  const options = PROFILE_OPTIONS[profile];
  const arguments_ = [
    "-jpeg",
    "-jpegopt",
    `quality=${options.quality}`,
    "-f",
    String(page),
    "-l",
    String(page),
    "-singlefile",
    "-cropbox",
    "-scale-to",
    String(options.maxDimension),
    "-q",
    inputPath,
    outputPrefix,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn("pdftocairo", arguments_, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_ERROR_OUTPUT_LENGTH) {
        stderr += chunk.slice(0, MAX_ERROR_OUTPUT_LENGTH - stderr.length);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(new PageRendererUnavailableError("PDF page renderer is unavailable: pdftocairo."));
        return;
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      if (timedOut) {
        reject(new Error(`PDF page rendering exceeded ${RENDER_TIMEOUT_MS} ms.`));
        return;
      }
      const detail = stderr.trim() || `exit code ${code ?? "unknown"}, signal ${signal ?? "none"}`;
      reject(new Error(`PDF page rendering failed: ${detail}`));
    });
  });
}

async function renderAndCachePage(book: StoredBook, page: number, profile: PageRenderProfile) {
  const cached = await readCachedPage(book, page, profile);
  if (cached) return cached;

  const outputPath = resolveRenderPath(book.fingerprint, PAGE_RENDER_VERSION, profile, page);
  const outputDirectory = path.dirname(/* turbopackIgnore: true */ outputPath);
  const temporaryPrefix = path.join(
    /* turbopackIgnore: true */ outputDirectory,
    `.page-${page}-${randomUUID()}`,
  );
  const temporaryPath = `${temporaryPrefix}.jpg`;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    await runRenderer(resolveBookPath(book.objectKey), temporaryPrefix, page, profile);
    const rendered = await stat(/* turbopackIgnore: true */ temporaryPath);
    if (!rendered.isFile() || rendered.size === 0) {
      throw new Error("PDF page renderer produced an empty image.");
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, outputPath);
    return {
      bytes: await readFile(/* turbopackIgnore: true */ outputPath),
      cacheHit: false,
      etag: pageEtag(book, page, profile),
    } satisfies RenderedPage;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function getRenderedPage(book: StoredBook, page: number, profile: PageRenderProfile) {
  if (!Number.isSafeInteger(page) || page < 1 || page > book.pageCount) {
    throw new RangeError("Invalid PDF page number.");
  }

  const key = `${book.fingerprint}:${PAGE_RENDER_VERSION}:${profile}:${page}`;
  const cached = await readCachedPage(book, page, profile);
  if (cached) return cached;

  let job = renderJobs.get(key);
  if (!job) {
    job = limiter.run(RENDER_CONCURRENCY, () => renderAndCachePage(book, page, profile));
    renderJobs.set(key, job);
    void job.finally(() => renderJobs.delete(key)).catch(() => undefined);
  }
  return job;
}
