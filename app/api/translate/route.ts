import { traceServerTiming, type TranslationTrace } from "../../../lib/translation-trace";
import { NextRequest, NextResponse } from "next/server";
import { TranslationProviderError, validImages, validServerImageRequest, type TranslationRequest } from "../../../lib/server-translation";
import { requestPageTranslation } from "../../../lib/server-translation-queue";
import { PageRendererUnavailableError } from "../../../lib/server-page-renderer";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let trace: TranslationTrace | undefined;
  const headers = (): Record<string, string> => trace ? { "Server-Timing": traceServerTiming(trace), "X-Verso-Trace-Id": trace.id } : {};
  try {
    const body = await request.json() as TranslationRequest;
    if (
      typeof body.targetLanguage !== "string"
      || !body.targetLanguage.trim()
      || body.targetLanguage.length > 80
      || body.targetLanguage.includes("::")
      || (body.translationConcurrency !== undefined && (!Number.isInteger(body.translationConcurrency) || body.translationConcurrency < 1 || body.translationConcurrency > 6))
      || (body.force !== undefined && typeof body.force !== "boolean")
      || !Number.isSafeInteger(body.page)
      || body.page < 1
      || !Number.isSafeInteger(body.totalPages)
      || body.totalPages < body.page
      || (!validImages(body.images, body.page, body.totalPages) && !validServerImageRequest(body))
    ) {
      return NextResponse.json({ error: "Missing target language, page metadata, or page images." }, { status: 400 });
    }
    const result = await requestPageTranslation(body, false, (value) => { trace = value; });
    return NextResponse.json({ ...result, trace }, { headers: headers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected translation error.";
    return NextResponse.json(
      {
        error: message,
        ...(error instanceof PageRendererUnavailableError && { code: "PAGE_RENDERER_UNAVAILABLE" }),
      },
      { headers: headers(), status: error instanceof TranslationProviderError ? error.status : error instanceof PageRendererUnavailableError ? 503 : 500 },
    );
  }
}
