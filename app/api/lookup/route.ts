import { NextRequest, NextResponse } from "next/server";
import { lookupWord, WordLookupError } from "../../../lib/server-word-lookup";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { word?: unknown; context?: unknown; targetLanguage?: unknown };
    const word = typeof body.word === "string" ? body.word.trim() : "";
    const context = typeof body.context === "string" ? body.context.trim() : "";
    const targetLanguage = typeof body.targetLanguage === "string" ? body.targetLanguage.trim() : "";
    if (!word || word.length > 80 || context.length > 600 || !targetLanguage || targetLanguage.length > 80) {
      return NextResponse.json({ error: "Invalid word lookup request." }, { status: 400 });
    }
    const result = await lookupWord({ word, context, targetLanguage });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (error) {
    const status = error instanceof WordLookupError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected word lookup error." },
      { status },
    );
  }
}
