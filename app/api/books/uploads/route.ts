import { NextRequest, NextResponse } from "next/server";
import { ensureStorageSchema, findBook, getStorage } from "../../../../db/books";

export const runtime = "edge";

type UploadRequest = {
  fingerprint: string;
  name: string;
  size: number;
  pageCount: number;
  contentType: string;
};

export async function POST(request: NextRequest) {
  try {
    const input = await request.json() as UploadRequest;
    if (
      !/^(?:[a-f0-9]{64}|fnv1a-[a-f0-9]{16})$/.test(input.fingerprint)
      || !input.name
      || !Number.isSafeInteger(input.size)
      || input.size <= 0
      || !Number.isSafeInteger(input.pageCount)
      || input.pageCount <= 0
    ) {
      return NextResponse.json({ error: "Invalid book metadata." }, { status: 400 });
    }
    const { db, bucket } = getStorage();
    await ensureStorageSchema(db);
    const existing = await findBook(db, input.fingerprint);
    if (existing) return NextResponse.json({ exists: true, book: existing });

    const objectKey = `books/${input.fingerprint}.pdf`;
    const upload = await bucket.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: input.contentType || "application/pdf" },
      customMetadata: { name: encodeURIComponent(input.name) },
    });
    return NextResponse.json({ exists: false, uploadId: upload.uploadId, objectKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start cloud upload.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
