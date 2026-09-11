import { QUEUE_CONCURRENCY_OPTIONS } from "../../../lib/translation-queue";
import { NextRequest, NextResponse } from "next/server";
import { enqueueBook, listTranslationQueue, stopBookTranslation, getTranslationQueueSettings, setTranslationQueueConcurrency } from "../../../lib/server-translation-queue";

export const runtime = "nodejs";
const validLanguage = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 80 && !value.includes("::");

export async function GET(request: NextRequest) {
  const language = request.nextUrl.searchParams.get("targetLanguage");
  if (language !== null && !validLanguage(language)) return NextResponse.json({ error: "Invalid target language." }, { status: 400 });
  try {
    return NextResponse.json({ jobs: await listTranslationQueue(language ?? undefined), settings: await getTranslationQueueSettings() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read queue." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.bookId !== "string" || !body.bookId || body.bookId.length > 128 || !validLanguage(body.targetLanguage)) {
      return NextResponse.json({ error: "Invalid translation queue request." }, { status: 400 });
    }
    await enqueueBook(body.bookId, body.targetLanguage);
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to queue book." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.action === "configure") {
      if (!QUEUE_CONCURRENCY_OPTIONS.includes(body.concurrency)) {
        return NextResponse.json({ error: "Background concurrency must be an integer between 1 and 10." }, { status: 400 });
      }
      await setTranslationQueueConcurrency(body.concurrency);
      return NextResponse.json({ settings: await getTranslationQueueSettings() });
    }
    if (body.action !== "stop" || typeof body.bookId !== "string" || !body.bookId || body.bookId.length > 128 || !validLanguage(body.targetLanguage)) {
      return NextResponse.json({ error: "Invalid translation queue request." }, { status: 400 });
    }
    await stopBookTranslation(body.bookId, body.targetLanguage);
    return NextResponse.json({ stopped: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to stop translation." }, { status: 503 });
  }
}
