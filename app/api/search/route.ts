import { NextRequest, NextResponse } from "next/server";
import { ensureStorageSchema, getStorage } from "../../../db/books";
import { searchTranslationPayload } from "../../../lib/translation-search";

export const runtime = "nodejs";

type SearchInput = {
  documentId?: unknown;
  query?: unknown;
  cacheKeySuffix?: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const input = await request.json() as SearchInput;
    if (
      typeof input.documentId !== "string"
      || !input.documentId
      || input.documentId.length > 128
      || typeof input.query !== "string"
      || !input.query.trim()
      || input.query.length > 200
      || typeof input.cacheKeySuffix !== "string"
      || !input.cacheKeySuffix
      || input.cacheKeySuffix.length > 1800
    ) {
      return NextResponse.json({ error: "Invalid search request." }, { status: 400 });
    }

    const { db } = getStorage();
    await ensureStorageSchema(db);
    const expectedSuffix = `::${input.cacheKeySuffix}`;
    const result = await db.prepare(`SELECT page, payload
      FROM translations
      WHERE document_id = ?1
        AND (
          instr(lower(COALESCE(json_extract(payload, '$.markdown'), '')), lower(?2)) > 0
          OR EXISTS (
            SELECT 1
            FROM json_each(translations.payload, '$.blocks')
            WHERE instr(lower(COALESCE(json_extract(value, '$.text'), '')), lower(?2)) > 0
          )
        )
        AND substr(cache_key, -length(?3)) = ?3
      ORDER BY page
      LIMIT 250`)
      .bind(input.documentId, input.query.trim(), expectedSuffix)
      .all<{ page: number; payload: string }>();

    const matches = result.results
      .flatMap((row) => {
        try {
          return searchTranslationPayload(JSON.parse(row.payload), Number(row.page), input.query as string);
        } catch {
          return [];
        }
      })
      .slice(0, 100);
    return NextResponse.json({ matches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to search translations.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
