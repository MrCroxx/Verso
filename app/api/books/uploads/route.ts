import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { ensureStorageSchema, findBook, getStorage } from "../../../../db/books";

export const runtime = "nodejs";

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
    const { db, uploadsDirectory } = getStorage();
    await ensureStorageSchema(db);
    const existing = await findBook(db, input.fingerprint);
    if (existing) {
      try {
        const file = await stat(`${getStorage().booksDirectory}/${input.fingerprint}.pdf`);
        if (file.isFile() && file.size === input.size) {
          return NextResponse.json({ exists: true, book: existing });
        }
      } catch {
        // A missing or incomplete local file is repaired by a fresh upload.
      }
    }

    const objectKey = `books/${input.fingerprint}.pdf`;
    const uploadId = randomUUID();
    await mkdir(`${uploadsDirectory}/${uploadId}`, { recursive: false });
    return NextResponse.json({ exists: false, uploadId, objectKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start local upload.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
