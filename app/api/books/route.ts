import { NextResponse } from "next/server";
import { ensureStorageSchema, getStorage, mapBook } from "../../../db/books";

export const runtime = "edge";

export async function GET() {
  try {
    const { db } = getStorage();
    await ensureStorageSchema(db);
    const result = await db.prepare("SELECT * FROM books ORDER BY uploaded_at DESC LIMIT 200").all();
    return NextResponse.json({ books: result.results.map((row) => mapBook(row)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list cloud books.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
