import { NextRequest, NextResponse } from "next/server";
import { findBook, getStorage } from "../../../../../db/books";

export const runtime = "edge";

type RouteContext = { params: Promise<{ id: string }> };

function parseRange(header: string | null, size: number): { offset: number; length: number } | undefined {
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

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, bucket } = getStorage();
    const book = await findBook(db, id);
    if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });

    const range = parseRange(request.headers.get("range"), book.size);
    const object = await bucket.get(book.objectKey, range ? { range } : undefined);
    if (!object) return NextResponse.json({ error: "Book file not found." }, { status: 404 });

    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Type": book.contentType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.name)}`,
      ETag: object.httpEtag,
    });
    if (range) {
      const end = range.offset + range.length - 1;
      headers.set("Content-Range", `bytes ${range.offset}-${end}/${book.size}`);
      headers.set("Content-Length", String(range.length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(book.size));
    return new Response(object.body, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read cloud book.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
