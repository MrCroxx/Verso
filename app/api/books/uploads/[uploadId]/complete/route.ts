import { NextRequest, NextResponse } from "next/server";
import { ensureStorageSchema, getStorage, mapBook } from "../../../../../../db/books";

export const runtime = "edge";

type RouteContext = { params: Promise<{ uploadId: string }> };

type CompleteRequest = {
  fingerprint: string;
  name: string;
  size: number;
  pageCount: number;
  contentType: string;
  objectKey: string;
  parts: Array<{ partNumber: number; etag: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { uploadId } = await context.params;
    const input = await request.json() as CompleteRequest;
    const validFingerprint = /^(?:[a-f0-9]{64}|fnv1a-[a-f0-9]{16})$/.test(input.fingerprint);
    const validParts = input.parts?.length > 0 && input.parts.every((part, index) => (
      part.partNumber === index + 1 && typeof part.etag === "string" && part.etag.length > 0
    ));
    if (
      !validFingerprint
      || input.objectKey !== `books/${input.fingerprint}.pdf`
      || !input.name
      || !Number.isSafeInteger(input.size)
      || input.size <= 0
      || !Number.isSafeInteger(input.pageCount)
      || input.pageCount <= 0
      || !validParts
    ) {
      return NextResponse.json({ error: "Invalid multipart completion." }, { status: 400 });
    }
    const { db, bucket } = getStorage();
    await bucket.resumeMultipartUpload(input.objectKey, uploadId).complete(input.parts);
    await ensureStorageSchema(db);
    const uploadedAt = Date.now();
    await db.prepare(`INSERT INTO books
      (id, fingerprint, name, object_key, size, page_count, content_type, uploaded_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(fingerprint) DO UPDATE SET
        name = excluded.name,
        size = excluded.size,
        page_count = excluded.page_count,
        content_type = excluded.content_type,
        uploaded_at = excluded.uploaded_at`)
      .bind(input.fingerprint, input.fingerprint, input.name, input.objectKey, input.size, input.pageCount, input.contentType, uploadedAt)
      .run();
    const row = await db.prepare("SELECT * FROM books WHERE fingerprint = ?1").bind(input.fingerprint).first();
    return NextResponse.json({ book: mapBook(row!) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete cloud upload.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
