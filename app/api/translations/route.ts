import { NextRequest, NextResponse } from "next/server";
import { ensureStorageSchema, getStorage } from "../../../db/books";
import { normalizeTranslationPayload } from "../../../lib/translation-layout";

export const runtime = "edge";

type TranslationCacheInput = {
  key: string;
  documentId: string;
  page: number;
  translation: unknown;
};

function validKey(key: unknown) {
  return typeof key === "string" && key.startsWith("layout-v3::") && key.length <= 2048;
}

export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get("key");
    if (key !== null) {
      if (!validKey(key)) return NextResponse.json({ error: "Invalid cache key." }, { status: 400 });
      const { db } = getStorage();
      await ensureStorageSchema(db);
      const row = await db.prepare("SELECT payload FROM translations WHERE cache_key = ?1 LIMIT 1").bind(key).first<{ payload: string }>();
      return NextResponse.json({ translation: row ? normalizeTranslationPayload(JSON.parse(row.payload)) : null });
    }

    const documentId = request.nextUrl.searchParams.get("documentId");
    const suffix = request.nextUrl.searchParams.get("cacheKeySuffix");
    if (
      !documentId
      || documentId.length > 128
      || !suffix
      || suffix.length > 1800
    ) {
      return NextResponse.json({ error: "Invalid translation cache index request." }, { status: 400 });
    }
    const { db } = getStorage();
    await ensureStorageSchema(db);
    const expectedSuffix = `::${suffix}`;
    const result = await db.prepare(`SELECT DISTINCT page
      FROM translations
      WHERE document_id = ?1
        AND substr(cache_key, -length(?2)) = ?2
      ORDER BY page`)
      .bind(documentId, expectedSuffix)
      .all<{ page: number }>();
    return NextResponse.json({ pages: result.results.map((row) => Number(row.page)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read translation cache.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const input = await request.json() as TranslationCacheInput;
    const payload = JSON.stringify(input.translation);
    if (
      !validKey(input.key)
      || typeof input.documentId !== "string"
      || input.documentId.length > 128
      || !Number.isSafeInteger(input.page)
      || input.page < 1
      || !input.translation
      || payload.length > 1024 * 1024
    ) {
      return NextResponse.json({ error: "Invalid translation cache entry." }, { status: 400 });
    }

    const { db } = getStorage();
    await ensureStorageSchema(db);
    await db.prepare(`INSERT INTO translations (cache_key, document_id, page, payload, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      WHERE COALESCE(CAST(json_extract(excluded.payload, '$.cacheVersion') AS INTEGER), 0)
        >= COALESCE(CAST(json_extract(translations.payload, '$.cacheVersion') AS INTEGER), 0)`)
      .bind(input.key, input.documentId, input.page, payload, Date.now())
      .run();
    return NextResponse.json({ cached: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to write translation cache.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
