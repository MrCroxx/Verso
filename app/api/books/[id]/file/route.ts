import { NextRequest, NextResponse } from "next/server";
import { findBook, getStorage } from "../../../../../db/books";
import { createConcurrencyLimiter } from "../../../../../lib/concurrency-limiter.ts";

export const runtime = "edge";

type RouteContext = { params: Promise<{ id: string }> };
type ByteRange = { offset: number; length: number };

const MAX_RANGE_LENGTH = 2 * 1024 * 1024;
const RANGE_READ_ATTEMPTS = 3;
const rangeReadLimiter = createConcurrencyLimiter();

function parseRange(header: string | null, size: number): ByteRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match) return undefined;
  if (!match[1] && match[2]) {
    const length = Math.min(size, Number(match[2]));
    return Number.isFinite(length) && length > 0 ? { offset: size - length, length } : undefined;
  }
  const offset = Number(match[1]);
  if (!Number.isFinite(offset) || offset >= size) return undefined;
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(size - 1, requestedEnd);
  return { offset, length: Math.max(0, end - offset + 1) };
}

async function readBufferedRange(
  bucket: R2Bucket,
  objectKey: string,
  range: ByteRange,
  signal: AbortSignal,
) {
  return rangeReadLimiter.run(1, async () => {
    if (signal.aborted) throw new DOMException("Cloud PDF request was aborted.", "AbortError");
    let lastError: unknown;
    for (let attempt = 0; attempt < RANGE_READ_ATTEMPTS; attempt += 1) {
      try {
        const object = await bucket.get(objectKey, { range });
        if (!object) return null;
        return { object, body: await object.arrayBuffer() };
      } catch (error) {
        lastError = error;
        if (signal.aborted) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to read the requested PDF range.");
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, bucket } = getStorage();
    const book = await findBook(db, id);
    if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      return NextResponse.json(
        { error: "A bounded Range header is required for cloud PDF reads." },
        { status: 400, headers: { "Accept-Ranges": "bytes" } },
      );
    }
    const range = parseRange(rangeHeader, book.size);
    if (!range || range.length === 0 || range.length > MAX_RANGE_LENGTH) {
      return NextResponse.json(
        { error: `Requested PDF range must contain at most ${MAX_RANGE_LENGTH} bytes.` },
        {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${book.size}`,
          },
        },
      );
    }
    const buffered = await readBufferedRange(bucket, book.objectKey, range, request.signal);
    if (!buffered) return NextResponse.json({ error: "Book file not found." }, { status: 404 });
    const { object, body } = buffered;

    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Type": book.contentType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.name)}`,
      ETag: object.httpEtag,
    });
    const end = range.offset + range.length - 1;
    headers.set("Content-Range", `bytes ${range.offset}-${end}/${book.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(body, { status: 206, headers });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "Unable to read cloud book.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
