import { NextResponse } from "next/server";
import { findBook, getStorage } from "../../../../db/books";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id || id.length > 256) {
      return NextResponse.json({ error: "Invalid book ID." }, { status: 400 });
    }
    const { db } = getStorage();
    const book = await findBook(db, id);
    if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });
    return NextResponse.json({ book });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read the local book.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
