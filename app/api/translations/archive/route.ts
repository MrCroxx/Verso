import { NextRequest, NextResponse } from "next/server";
import { exportTranslationArchive, importTranslationArchive, TranslationArchiveError } from "../../../../lib/server-translation-archive";
import { MAX_TRANSLATION_ARCHIVE_BYTES } from "../../../../lib/translation-archive";

export const runtime = "nodejs";

function failure(error: unknown) {
  const code = error instanceof TranslationArchiveError ? error.code : "ARCHIVE_FAILED";
  const status = error instanceof TranslationArchiveError ? error.status : 503;
  return NextResponse.json({ error: code }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const { archive, filename } = await exportTranslationArchive(request.nextUrl.searchParams.get("documentId"));
    return new Response(archive, { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (Number(request.headers.get("content-length")) > MAX_TRANSLATION_ARCHIVE_BYTES) throw new TranslationArchiveError("ARCHIVE_TOO_LARGE", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new TranslationArchiveError("INVALID_ARCHIVE");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TRANSLATION_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new TranslationArchiveError("ARCHIVE_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new TranslationArchiveError("INVALID_ARCHIVE"); }
    return NextResponse.json(await importTranslationArchive(value, request.nextUrl.searchParams.get("documentId")));
  } catch (error) {
    return failure(error);
  }
}
