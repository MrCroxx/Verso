import { NextRequest, NextResponse } from "next/server";
import { getAiProviderSettings } from "../../../db/ai-provider-settings";
import { findBook, getStorage } from "../../../db/books";
import type { AiProviderSettings } from "../../../lib/ai-provider-settings";
import { hasLayoutContent, normalizeLayoutBlocks } from "../../../lib/translation-layout";
import { alignSourceBlocks } from "../../../lib/source-alignment";
import { getSourcePageLayout } from "../../../lib/server-source-layout";
import { getRenderedPage, PageRendererUnavailableError } from "../../../lib/server-page-renderer";

export const runtime = "nodejs";

type RequestBody = {
  targetLanguage: string;
  page: number;
  totalPages: number;
  images?: Array<{ page: number; dataUrl: string }>;
  bookId?: string;
  contextPages?: number[];
  previousTranslationTail?: string;
};

type TranslationImage = { page: number; dataUrl: string };

const MAX_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;

function isConfigured(config: AiProviderSettings | null): config is AiProviderSettings {
  return Boolean(config?.apiKey && config.model && config.endpoint);
}

const rectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number", minimum: 0, maximum: 1 },
    y: { type: "number", minimum: 0, maximum: 1 },
    width: { type: "number", minimum: 0, maximum: 1 },
    height: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["x", "y", "width", "height"],
};

const blockSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["heading", "paragraph", "list_item", "caption", "spacer", "page_number", "image"] },
    sourceRect: { anyOf: [rectSchema, { type: "null" }] },
    fontSize: { anyOf: [{ type: "number", minimum: 0, maximum: 0.25 }, { type: "null" }] },
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          sourceText: { type: "string" },
          sourceRects: { type: "array", items: rectSchema },
        },
        required: ["text", "sourceText", "sourceRects"],
      },
    },
    text: { type: "string" },
    marker: { type: "string" },
    trailing: { type: "string" },
    align: { type: "string", enum: ["left", "center", "right", "justify"] },
    indent: { type: "integer", minimum: 0, maximum: 3 },
    spaceBefore: { type: "string", enum: ["none", "xs", "sm", "md", "lg", "xl"] },
    size: { type: "string", enum: ["xs", "sm", "md", "lg", "xl"] },
  },
  required: ["kind", "text", "marker", "trailing", "align", "indent", "spaceBefore", "size", "sourceRect", "fontSize", "sentences"],
};

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer" },
    blocks: { type: "array", items: blockSchema },
    sourceSummary: { type: "string" },
    previousPageRevision: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "integer" },
            blocks: { type: "array", items: blockSchema },
          },
          required: ["page", "blocks"],
        },
      ],
    },
  },
  required: ["page", "blocks", "sourceSummary", "previousPageRevision"],
};

function normalizeTranslationResponse(value: unknown, requestedPage: number) {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const revision = result.previousPageRevision && typeof result.previousPageRevision === "object"
    ? result.previousPageRevision as Record<string, unknown>
    : null;
  const blocks = normalizeLayoutBlocks(result.blocks);
  return {
    page: requestedPage,
    blocks,
    isBlank: !hasLayoutContent(blocks),
    sourceSummary: typeof result.sourceSummary === "string" ? result.sourceSummary : "",
    previousPageRevision: revision
      ? {
          page: typeof revision.page === "number" ? revision.page : requestedPage - 1,
          blocks: normalizeLayoutBlocks(revision.blocks),
        }
      : null,
  };
}

function prompt(body: RequestBody, images: TranslationImage[]) {
  const available = images.map((image) => image.page).join(", ");
  const previousTranslation = body.previousTranslationTail
    ? `\nThe cached translation ends with: ${JSON.stringify(body.previousTranslationTail)}. Do not repeat this text at the start of page ${body.page}.`
    : "";
  return `You are translating a scanned book into ${body.targetLanguage}.
The requested page is ${body.page} of ${body.totalPages}. Images are supplied in ascending page order for pages: ${available}.
${previousTranslation}

Instructions:
- Read both the text and the page design visually. Reconstruct the requested page as ordered layout blocks.
- Translate only requested page ${body.page}; adjacent pages are context, not additional output.
- Resolve sentences and paragraphs that cross page boundaries using adjacent images.
- Page ownership follows the source scan exactly. Every translated fragment in blocks must correspond to source text visibly printed on page ${body.page}.
- If page ${body.page} begins mid-sentence or mid-phrase, output only its continuation. Never repeat translated words already owned by the previous page merely to make this page read independently.
- Never invent text hidden or absent from the scan. Mark genuinely illegible fragments as [illegible].
- Preserve every source list item as one list_item block. Put its number or bullet in marker, translated content in text, and a right-aligned page number or reference in trailing. Never merge adjacent list items.
- On a table of contents, list of illustrations, or similar navigation page, encode every navigable row as a list_item. Preserve its printed page reference in trailing and represent hierarchy with indent.
- Use heading, paragraph, caption, and page_number blocks according to their visual role. Preserve order, alignment, indentation, and relative typography with align, indent, and size.
- For every block, mark sourceRect around its source region. All coordinates are fractions from 0 to 1 of THAT page image, origin at the top left: x, y, width, height. Use the displayed orientation and full page image, including margins. Never use pixel coordinates or coordinates from an adjacent page.
- Record fontSize as the approximate source glyph/em height divided by the full page image WIDTH (for example 20px glyphs on a 1000px-wide scan = 0.02). Preserve relative typography; use null for non-text blocks.
- Extract each source sentence (or the visible fragment of a sentence crossing a page boundary) into sentences, including headings, captions, list contents, and page numbers. Each entry contains its translated text, verbatim sourceText, and sourceRects tightly enclosing the original words, one rectangle per line fragment. Do not include neighboring sentences in these rectangles. The sentence text strings concatenated in order MUST equal block.text exactly, including punctuation and whitespace. List marker/trailing remain separate from block.text.
- Preserve every illustration, photograph, diagram, and graphical table as an image block at its reading-order position, with sourceRect enclosing the COMPLETE image to crop from the original scan, including its outermost strokes, labels, legends, and panel markers. Allow a small whitespace border; never place a crop edge through visible artwork. Preserve horizontal placement and relative width. Do not replace images with spacers or generate image descriptions. Keep captions as separate translated caption blocks outside the image crop. For image blocks use empty text, marker, trailing, and sentences.
- Preserve meaningful empty vertical whitespace with spacer blocks; reserve spacers for actual blank gaps.
- Use spaceBefore to approximate smaller gaps before text blocks. Avoid encoding layout with spaces, tabs, or repeated newlines inside text.
- For fields that do not apply, return an empty string for marker and trailing. For spacer blocks, return empty strings for text, marker, and trailing.
- Return an empty blocks array only if the page has neither text nor images. Image-only pages must retain their image blocks. For unavailable sourceRect or fontSize use null; for non-text blocks use an empty sentences array.
- If page ${body.page - 1} ended mid-paragraph and the current page changes its meaning, return a complete corrected block layout for the previous page in previousPageRevision. Its text and the current blocks must remain disjoint with no repeated boundary fragment. Otherwise return null.
- Keep names and technical terminology consistent. Do not add commentary.
- Return JSON matching the supplied schema:\n${JSON.stringify(schema)}`;
}

function validImages(value: unknown, requestedPage: number, totalPages: number): value is TranslationImage[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 3
    && value.some((image) => (image as TranslationImage | undefined)?.page === requestedPage)
    && value.every((image) => (
      image
      && typeof image === "object"
      && Number.isSafeInteger((image as TranslationImage).page)
      && (image as TranslationImage).page >= 1
      && (image as TranslationImage).page <= totalPages
      && typeof (image as TranslationImage).dataUrl === "string"
      && (image as TranslationImage).dataUrl.startsWith("data:image/")
      && (image as TranslationImage).dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH
    ));
}

function validServerImageRequest(body: RequestBody) {
  return typeof body.bookId === "string"
    && body.bookId.length > 0
    && body.bookId.length <= 256
    && Array.isArray(body.contextPages)
    && body.contextPages.length > 0
    && body.contextPages.length <= 3
    && body.contextPages.includes(body.page)
    && body.contextPages.every((page) => (
      Number.isSafeInteger(page) && page >= 1 && page <= body.totalPages
    ));
}

async function resolveTranslationImages(body: RequestBody): Promise<TranslationImage[]> {
  if (validImages(body.images, body.page, body.totalPages)) return body.images;
  if (!validServerImageRequest(body)) throw new Error("Missing target language, page metadata, or page images.");

  const { db } = getStorage();
  const book = await findBook(db, body.bookId!);
  if (!book) throw new Error("Book not found.");
  if (book.pageCount !== body.totalPages) throw new Error("Book page count does not match the translation request.");

  return Promise.all(body.contextPages!.map(async (page) => {
    const rendered = await getRenderedPage(book, page, "vision");
    return { page, dataUrl: `data:image/jpeg;base64,${rendered.bytes.toString("base64")}` };
  }));
}

function endpointFor(config: AiProviderSettings) {
  const raw = config.endpoint.trim().replace(/\/$/, "");
  if (config.provider === "openai") return raw || "https://api.openai.com/v1/responses";
  if (/\/(chat\/completions|responses)$/.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    if (
      typeof body.targetLanguage !== "string"
      || !body.targetLanguage.trim()
      || body.targetLanguage.length > 80
      || !Number.isSafeInteger(body.page)
      || body.page < 1
      || !Number.isSafeInteger(body.totalPages)
      || body.totalPages < body.page
      || (!validImages(body.images, body.page, body.totalPages) && !validServerImageRequest(body))
    ) {
      return NextResponse.json({ error: "Missing target language, page metadata, or page images." }, { status: 400 });
    }
    const config = await getAiProviderSettings();
    if (!isConfigured(config)) {
      return NextResponse.json({ error: "AI provider is not configured on the server." }, { status: 503 });
    }
    const endpoint = endpointFor(config);
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
    const images = await resolveTranslationImages(body);
    const instruction = prompt(body, images);
    const isResponses = config.provider === "openai" || endpoint.endsWith("/responses");
    const payload = isResponses
      ? {
          model: config.model,
          ...(config.reasoningEffort !== "none" && { reasoning: { effort: config.reasoningEffort } }),
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              ...images.flatMap((image) => [
                { type: "input_text", text: `Page ${image.page}:` },
                { type: "input_image", image_url: image.dataUrl, detail: "high" },
              ]),
            ],
          }],
          text: { format: { type: "json_schema", name: "page_translation", strict: true, schema } },
        }
      : {
          model: config.model,
          ...(config.reasoningEffort !== "none" && { reasoning_effort: config.reasoningEffort }),
          messages: [{
            role: "user",
            content: [
              { type: "text", text: instruction },
              ...images.flatMap((image) => [
                { type: "text", text: `Page ${image.page}:` },
                { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } },
              ]),
            ],
          }],
          response_format: { type: "json_object" },
        };

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const providerError = (result.error as { message?: string } | undefined)?.message;
      return NextResponse.json({ error: providerError || `Provider returned ${response.status}.` }, { status: response.status });
    }

    let text: string | undefined;
    if (isResponses) {
      text = result.output_text as string | undefined;
      if (!text && Array.isArray(result.output)) {
        const output = result.output as Array<{ content?: Array<{ text?: string }> }>;
        text = output.flatMap((item) => item.content || []).find((item) => item.text)?.text;
      }
    } else {
      const choices = result.choices as Array<{ message?: { content?: string } }> | undefined;
      text = choices?.[0]?.message?.content;
    }
    if (!text) throw new Error("The model returned no translation text.");
    const translation = normalizeTranslationResponse(JSON.parse(text), body.page);
    if (body.bookId) {
      const book = await findBook(getStorage().db, body.bookId);
      if (book) {
        try {
          translation.blocks = alignSourceBlocks(translation.blocks, await getSourcePageLayout(book, body.page));
          if (translation.previousPageRevision?.page === body.page - 1 && body.page > 1) {
            translation.previousPageRevision.blocks = alignSourceBlocks(
              translation.previousPageRevision.blocks, await getSourcePageLayout(book, body.page - 1),
            );
          }
        } catch { /* Keep the translation readable if local extraction is temporarily unavailable. */ }
      }
    }
    return NextResponse.json(translation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected translation error.";
    return NextResponse.json(
      {
        error: message,
        ...(error instanceof PageRendererUnavailableError && { code: "PAGE_RENDERER_UNAVAILABLE" }),
      },
      { status: error instanceof PageRendererUnavailableError ? 503 : 500 },
    );
  }
}
