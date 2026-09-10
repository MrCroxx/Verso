import type { TranslationProgress } from "../../../lib/translation-progress";
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
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const encoder = new TextEncoder();
      const observer = new AbortController();
      let closeStream = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          let pending: TranslationProgress | undefined = { phase: "queued" };
          let lastSent = Date.now();
          const send = (event: string, value: unknown) => {
            if (closed) return;
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
            lastSent = Date.now();
          };
          const timer = setInterval(() => {
            if (closed || (controller.desiredSize ?? 0) <= 0) return;
            if (pending) { send("progress", pending); pending = undefined; }
            else if (Date.now() - lastSent >= 10_000) {
              controller.enqueue(encoder.encode(": keep-alive\n\n")); lastSent = Date.now();
            }
          }, 150);
          closeStream = () => {
            if (closed) return;
            closed = true; clearInterval(timer); observer.abort();
            request.signal.removeEventListener("abort", closeStream);
            try { controller.close(); } catch { /* The browser may already have cancelled its reader. */ }
          };
          request.signal.addEventListener("abort", closeStream, { once: true });
          if (request.signal.aborted) { closeStream(); return; }
          send("progress", pending); pending = undefined;
          void requestPageTranslation(body, false, (value) => { trace = value; }, {
            onProgress: (value) => { pending = value; }, signal: observer.signal,
          }).then((result) => {
            if (pending) send("progress", pending);
            send("result", { ...result, trace });
          }).catch((error) => {
            send("error", { error: error instanceof Error ? error.message : "Unexpected translation error.",
              ...(error instanceof PageRendererUnavailableError && { code: "PAGE_RENDERER_UNAVAILABLE" }), trace });
          }).finally(closeStream);
        },
        cancel() { closeStream(); },
      });
      return new Response(stream, { headers: {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no",
      } });
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
