import type { PDFDataRangeTransport } from "pdfjs-dist";
import { createConcurrencyLimiter } from "./concurrency-limiter.ts";

export const CLOUD_PDF_RANGE_CHUNK_SIZE = 1024 * 1024;

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 75;

type PDFDataRangeTransportConstructor = new (
  length: number,
  initialData: Uint8Array | null,
  progressiveDone?: boolean,
  contentDispositionFilename?: string,
) => PDFDataRangeTransport;

type RangeFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CloudPdfRangeTransportOptions = {
  Transport: PDFDataRangeTransportConstructor;
  url: string;
  length: number;
  filename: string;
  fetcher?: RangeFetcher;
  chunkSize?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
};

type CloudPdfRangeTransportResult = {
  transport: PDFDataRangeTransport;
  failure: Promise<never>;
};

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error("Unable to read the requested PDF range.");
}

function validateRangeResponse(response: Response, begin: number, end: number, length: number) {
  if (response.status !== 206) {
    throw new Error(`Expected a partial PDF response, received HTTP ${response.status}.`);
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") || "");
  if (!match || Number(match[1]) !== begin || Number(match[2]) !== end - 1 || Number(match[3]) !== length) {
    throw new Error("Cloud PDF returned an invalid Content-Range header.");
  }
}

export function createCloudPdfRangeTransport({
  Transport,
  url,
  length,
  filename,
  fetcher = fetch,
  chunkSize = CLOUD_PDF_RANGE_CHUNK_SIZE,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: CloudPdfRangeTransportOptions): CloudPdfRangeTransportResult {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error("Cloud PDF has an invalid file size.");
  }

  const normalizedChunkSize = Math.max(64 * 1024, Math.floor(chunkSize));
  const normalizedAttempts = Math.max(1, Math.floor(maxAttempts));
  const limiter = createConcurrencyLimiter();
  const requests = new Map<string, Promise<Uint8Array>>();
  const controllers = new Set<AbortController>();
  let aborted = false;
  let failed = false;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);

  async function fetchChunk(begin: number, end: number) {
    let lastError: unknown;
    for (let attempt = 0; attempt < normalizedAttempts; attempt += 1) {
      if (aborted) throw new DOMException("Cloud PDF request was aborted.", "AbortError");
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const response = await fetcher(url, {
          headers: { Range: `bytes=${begin}-${end - 1}` },
          signal: controller.signal,
        });
        validateRangeResponse(response, begin, end, length);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== end - begin) {
          throw new Error(`Cloud PDF returned ${bytes.byteLength} bytes for a ${end - begin}-byte range.`);
        }
        return bytes;
      } catch (error) {
        lastError = error;
        if (aborted || controller.signal.aborted) throw error;
        if (attempt + 1 < normalizedAttempts) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
        }
      } finally {
        controllers.delete(controller);
      }
    }
    throw normalizeError(lastError);
  }

  async function fetchRange(begin: number, end: number) {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for (let offset = begin; offset < end; offset += normalizedChunkSize) {
      const chunkEnd = Math.min(end, offset + normalizedChunkSize);
      const chunk = await fetchChunk(offset, chunkEnd);
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
    if (chunks.length === 1) return chunks[0];

    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  class CloudPdfRangeTransport extends Transport {
    requestDataRange(begin: number, end: number) {
      if (aborted) return;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > length) {
        this.fail(new Error(`PDF.js requested an invalid byte range: ${begin}-${end}.`));
        return;
      }

      const key = `${begin}-${end}`;
      let request = requests.get(key);
      if (!request) {
        request = limiter.run(maxConcurrency, () => fetchRange(begin, end));
        requests.set(key, request);
        void request.finally(() => requests.delete(key)).catch(() => undefined);
      }

      void request.then((bytes) => {
        if (!aborted) this.onDataRange(begin, bytes.slice());
      }).catch((error) => {
        if (!aborted) this.fail(normalizeError(error));
      });
    }

    abort() {
      if (aborted) return;
      aborted = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      requests.clear();
    }

    private fail(error: Error) {
      if (failed) return;
      failed = true;
      rejectFailure(error);
      this.abort();
    }
  }

  return {
    transport: new CloudPdfRangeTransport(length, null, false, filename),
    failure,
  };
}
