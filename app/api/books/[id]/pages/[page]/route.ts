import { NextRequest, NextResponse } from "next/server";
import { findBook, getStorage } from "../../../../../../db/books";
import {
  getRenderedPage,
  PageRendererUnavailableError,
  parsePageRenderProfile,
} from "../../../../../../lib/server-page-renderer";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; page: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id, page: rawPage } = await context.params;
    const page = Number(rawPage);
    const profile = parsePageRenderProfile(request.nextUrl.searchParams.get("profile") || "display");
    if (!id || id.length > 256 || !Number.isSafeInteger(page) || page < 1 || !profile) {
      return NextResponse.json({ error: "Invalid page image request." }, { status: 400 });
    }

    const { db } = getStorage();
    const book = await findBook(db, id);
    if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });
    if (page > book.pageCount) {
      return NextResponse.json({ error: "PDF page is outside the book." }, { status: 400 });
    }

    const rendered = await getRenderedPage(book, page, profile);
    if (request.headers.get("if-none-match") === rendered.etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: rendered.etag, "Cache-Control": "private, max-age=31536000, immutable" },
      });
    }
    return new Response(new Uint8Array(rendered.bytes), {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(rendered.bytes.byteLength),
        "Content-Type": "image/jpeg",
        ETag: rendered.etag,
        "X-Verso-Render-Cache": rendered.cacheHit ? "HIT" : "MISS",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to render PDF page.";
    return NextResponse.json(
      { error: message },
      { status: error instanceof PageRendererUnavailableError ? 503 : 500 },
    );
  }
}
