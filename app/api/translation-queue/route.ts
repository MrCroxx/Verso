import { NextRequest, NextResponse } from "next/server";
import { enqueueBook, listTranslationQueue } from "../../../lib/server-translation-queue";

export const runtime = "nodejs";
const validLanguage = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 80 && !value.includes("::");

export async function GET(request: NextRequest) {
  const language = request.nextUrl.searchParams.get("targetLanguage");
  if (!validLanguage(language)) return NextResponse.json({ error: "Invalid target language." }, { status: 400 });
  try {
    return NextResponse.json({ jobs: await listTranslationQueue(language) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read queue." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.bookId !== "string" || !body.bookId || body.bookId.length > 128 || !validLanguage(body.targetLanguage)
      || !Number.isInteger(body.translationConcurrency) || body.translationConcurrency < 1 || body.translationConcurrency > 6) {
      return NextResponse.json({ error: "Invalid translation queue request." }, { status: 400 });
    }
    await enqueueBook(body.bookId, body.targetLanguage, body.translationConcurrency);
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to queue book." }, { status: 503 });
  }
}
