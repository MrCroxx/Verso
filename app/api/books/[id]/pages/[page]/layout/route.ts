import { NextRequest, NextResponse } from "next/server";
import { findBook, getStorage } from "../../../../../../../db/books";
import { getSourcePageLayout } from "../../../../../../../lib/server-source-layout";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string; page: string }> }) {
  const { id, page: rawPage } = await context.params;
  const page = Number(rawPage);
  if (!id || id.length > 256 || !Number.isSafeInteger(page) || page < 1) return NextResponse.json({ error: "Invalid source layout request." }, { status: 400 });
  const book = await findBook(getStorage().db, id);
  if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });
  if (page > book.pageCount) return NextResponse.json({ error: "Invalid source layout page." }, { status: 400 });
  try {
    return NextResponse.json(await getSourcePageLayout(book, page), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Source word positions are unavailable." }, { status: 503 });
  }
}
