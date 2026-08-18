import { NextRequest, NextResponse } from "next/server";
import { ensureStorageSchema, getStorage } from "../../../db/books";
import { normalizeNavigationObservation } from "../../../lib/document-navigation";

export const runtime = "edge";

type NavigationRow = {
  pdf_page: number;
  is_table_of_contents: number;
  toc_entries: string;
  page_label: string | null;
  page_value: number | null;
  numbering: string | null;
};

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function parseEntries(value: string) {
  try {
    const entries = JSON.parse(value);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const documentId = request.nextUrl.searchParams.get("documentId");
    if (!validDocumentId(documentId)) {
      return NextResponse.json({ error: "Invalid document ID." }, { status: 400 });
    }

    const { db } = getStorage();
    await ensureStorageSchema(db);
    const [pages, settings] = await Promise.all([
      db.prepare(`SELECT pdf_page, is_table_of_contents, toc_entries, page_label, page_value, numbering
        FROM navigation_pages WHERE document_id = ?1 ORDER BY pdf_page ASC`)
        .bind(documentId)
        .all<NavigationRow>(),
      db.prepare("SELECT manual_offset FROM navigation_settings WHERE document_id = ?1 LIMIT 1")
        .bind(documentId)
        .first<{ manual_offset: number | null }>(),
    ]);
    const observations = pages.results.map((row) => normalizeNavigationObservation({
      pdfPage: Number(row.pdf_page),
      isTableOfContents: Boolean(row.is_table_of_contents),
      tocEntries: parseEntries(row.toc_entries),
      anchor: row.page_label
        ? {
            label: row.page_label,
            value: row.page_value == null ? null : Number(row.page_value),
            numbering: row.numbering,
          }
        : null,
    })).filter((observation) => observation.pdfPage > 0);

    return NextResponse.json({
      navigation: {
        observations,
        manualOffset: settings?.manual_offset == null ? null : Number(settings.manual_offset),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read document navigation.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const input = await request.json() as Record<string, unknown>;
    if (!validDocumentId(input.documentId)) {
      return NextResponse.json({ error: "Invalid document ID." }, { status: 400 });
    }

    const { db } = getStorage();
    await ensureStorageSchema(db);
    if (Object.prototype.hasOwnProperty.call(input, "manualOffset")) {
      const manualOffset = input.manualOffset;
      if (manualOffset !== null && (!Number.isSafeInteger(manualOffset) || Math.abs(Number(manualOffset)) > 10000)) {
        return NextResponse.json({ error: "Invalid manual page offset." }, { status: 400 });
      }
      await db.prepare(`INSERT INTO navigation_settings (document_id, manual_offset, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(document_id) DO UPDATE SET manual_offset = excluded.manual_offset, updated_at = excluded.updated_at`)
        .bind(input.documentId, manualOffset, Date.now())
        .run();
      return NextResponse.json({ cached: true });
    }

    const observation = normalizeNavigationObservation(input.observation);
    const tocEntries = JSON.stringify(observation.tocEntries);
    if (observation.pdfPage < 1 || tocEntries.length > 256 * 1024) {
      return NextResponse.json({ error: "Invalid navigation observation." }, { status: 400 });
    }
    await db.prepare(`INSERT INTO navigation_pages (
        document_id, pdf_page, is_table_of_contents, toc_entries,
        page_label, page_value, numbering, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(document_id, pdf_page) DO UPDATE SET
        is_table_of_contents = excluded.is_table_of_contents,
        toc_entries = excluded.toc_entries,
        page_label = excluded.page_label,
        page_value = excluded.page_value,
        numbering = excluded.numbering,
        updated_at = excluded.updated_at`)
      .bind(
        input.documentId,
        observation.pdfPage,
        observation.isTableOfContents ? 1 : 0,
        tocEntries,
        observation.anchor?.label || null,
        observation.anchor?.value ?? null,
        observation.anchor?.numbering || null,
        Date.now(),
      )
      .run();
    return NextResponse.json({ cached: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to write document navigation.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
