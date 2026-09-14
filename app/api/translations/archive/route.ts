import { NextRequest, NextResponse } from "next/server";
import { exportTranslationArchive, importTranslationArchive, TranslationArchiveError } from "../../../../lib/server-translation-archive";
import { MAX_TRANSLATION_ARCHIVE_BYTES } from "../../../../lib/translation-archive";
import { readLimitedRequestBody, RequestBodyTooLargeError } from "../../../../lib/server-request-body";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "ARCHIVE_TOO_LARGE" }, { status: 413 });
  }
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
    const body = await readLimitedRequestBody(request, MAX_TRANSLATION_ARCHIVE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      throw new TranslationArchiveError("INVALID_ARCHIVE");
    }
    return NextResponse.json(await importTranslationArchive(value, request.nextUrl.searchParams.get("documentId")));
  } catch (error) {
    return failure(error);
  }
}
