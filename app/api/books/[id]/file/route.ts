import { open, stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { findBook, getStorage, resolveBookPath } from "../../../../../db/books";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };
type ByteRange = { offset: number; length: number };

const MAX_RANGE_LENGTH = 2 * 1024 * 1024;

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

async function readRange(filePath: string, range: ByteRange) {
  const file = await open(filePath, "r");
  try {
    const body = Buffer.allocUnsafe(range.length);
    let bytesRead = 0;
    while (bytesRead < body.byteLength) {
      const result = await file.read(body, bytesRead, body.byteLength - bytesRead, range.offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== range.length) {
      throw new Error(`Local PDF returned ${bytesRead} bytes for a ${range.length}-byte range.`);
    }
    return body;
  } finally {
    await file.close();
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = getStorage();
    const book = await findBook(db, id);
    if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });

    const filePath = resolveBookPath(book.objectKey);
    let file;
    try {
      file = await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ error: "Book file not found." }, { status: 404 });
      }
      throw error;
    }
    if (!file.isFile() || file.size !== book.size) {
      throw new Error(`Local PDF size mismatch: found ${file.size} bytes; expected ${book.size}.`);
    }

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      return NextResponse.json(
        { error: "A bounded Range header is required for local PDF reads." },
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

    const body = await readRange(filePath, range);
    const end = range.offset + range.length - 1;
    return new Response(body, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "Content-Type": book.contentType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.name)}`,
        "Content-Range": `bytes ${range.offset}-${end}/${book.size}`,
        "Content-Length": String(range.length),
        ETag: `W/\"${file.size}-${Math.trunc(file.mtimeMs)}\"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read local book.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
