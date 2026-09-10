import { readProviderStream } from "./server-provider-stream";
import { createTranslationPreview, type TranslationProgress } from "./translation-progress";
import { traceStep, traceAttributes, startSpan } from "./server-translation-trace";
import { getAiProviderSettings } from "../db/ai-provider-settings";
import { findBook, getStorage } from "../db/books";
import { aiProviderEndpoint, type AiProviderSettings } from "./ai-provider-settings";
import { hasLayoutContent, normalizeLayoutBlocks } from "./translation-layout";
import { alignSourceBlocks } from "./source-alignment";
import type { SourcePageLayout } from "./source-alignment";
import { getSourcePageLayout } from "./server-source-layout";
import { getRenderedPage } from "./server-page-renderer";

export type TranslationRequest = {
  targetLanguage: string;
  page: number;
  totalPages: number;
  images?: Array<{ page: number; dataUrl: string }>;
  bookId?: string;
  contextPages?: number[];
  previousTranslationTail?: string;
  force?: boolean;
  translationConcurrency?: number;
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
    imageRole: { anyOf: [{ type: "string", enum: ["body", "decoration"] }, { type: "null" }] },
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
  required: ["kind", "text", "marker", "trailing", "align", "indent", "spaceBefore", "size", "sourceRect", "imageRole", "fontSize", "sentences"],
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

function prompt(body: TranslationRequest, images: TranslationImage[]) {
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
- Preserve every illustration, photograph, diagram, and graphical table as an image block at its reading-order position, with sourceRect enclosing the COMPLETE image to crop from the original scan, including its outermost strokes, labels, legends, and panel markers. Allow a small whitespace border; never place a crop edge through visible artwork. Preserve relative width using sourceRect; the reader centers body illustrations and graphical tables in the translated column. Set imageRole="body" for these images. Set imageRole="decoration" for logos, header/footer marks, ornaments, and other page-design images that must retain their original horizontal placement. Crop the complete mark, including the last letters of wordmarks, and exclude unrelated page separator rules. For non-image blocks set imageRole=null. Do not replace images with spacers or generate image descriptions. Keep captions as separate translated caption blocks immediately adjacent to their image block, with table captions before the image and figure captions after it. Do not insert spacers between an image and its caption. Exclude the original caption from sourceRect so it is not duplicated inside the crop. Use align="center" and indent=0 for captions; the reader groups each caption with its image. For image blocks use empty text, marker, trailing, and sentences.
- Preserve meaningful empty vertical whitespace with spacer blocks; reserve spacers for actual blank gaps.
- Use spaceBefore to approximate smaller gaps before text blocks. Avoid encoding layout with spaces, tabs, or repeated newlines inside text.
- For fields that do not apply, return an empty string for marker and trailing. For spacer blocks, return empty strings for text, marker, and trailing.
- Return an empty blocks array only if the page has neither text nor images. Image-only pages must retain their image blocks. For unavailable sourceRect or fontSize use null; for non-text blocks use an empty sentences array.
- If page ${body.page - 1} ended mid-paragraph and the current page changes its meaning, return a complete corrected block layout for the previous page in previousPageRevision. Its text and the current blocks must remain disjoint with no repeated boundary fragment. Otherwise return null.
- Keep names and technical terminology consistent. Do not add commentary.
- Return JSON matching the supplied schema:\n${JSON.stringify(schema)}`;
}

export function validImages(value: unknown, requestedPage: number, totalPages: number): value is TranslationImage[] {
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

export function validServerImageRequest(body: TranslationRequest) {
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

async function resolveTranslationImages(body: TranslationRequest): Promise<TranslationImage[]> {
  if (validImages(body.images, body.page, body.totalPages)) return body.images;
  if (!validServerImageRequest(body)) throw new Error("Missing target language, page metadata, or page images.");

  const { db } = getStorage();
  const book = await findBook(db, body.bookId!);
  if (!book) throw new Error("Book not found.");
  if (book.pageCount !== body.totalPages) throw new Error("Book page count does not match the translation request.");

  return Promise.all(body.contextPages!.map(async (page) => {
    const rendered = await traceStep("images.page", () => getRenderedPage(book, page, "vision"), { page });
    traceAttributes({ [`image${page}CacheHit`]: rendered.cacheHit });
    return { page, dataUrl: `data:image/jpeg;base64,${rendered.bytes.toString("base64")}` };
  }));
}

export class TranslationProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function generateTranslation(body: TranslationRequest, onProgress?: (progress: TranslationProgress) => void) {
    onProgress?.({ phase: "preparing" });
    const config = await traceStep("settings.load", () => getAiProviderSettings());
    if (!isConfigured(config)) {
      throw new TranslationProviderError("AI provider is not configured on the server.", 503);
    }
    const endpoint = aiProviderEndpoint(config);
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
    traceAttributes({ model: config.model, reasoningEffort: config.reasoningEffort, protocol: config.provider });
    const images = await traceStep("images.prepare", () => resolveTranslationImages(body));
    const encode = startSpan("request.encode");
    const instruction = prompt(body, images);
    const isResponses = config.provider === "openai" || endpoint.endsWith("/responses");
    const payload = isResponses
      ? {
          model: config.model,
          stream: true,
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
          stream: true,
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
          stream_options: { include_usage: true },
        };

    const encoded = JSON.stringify(payload);
    encode("ok", { requestBytes: Buffer.byteLength(encoded), images: images.length });
    // Extract only this page while the provider works; preserve the same OCR and alignment.
    // Attach the rejection handler immediately because the provider may finish much later.
    const sourceLayout: Promise<SourcePageLayout | null> = body.bookId
      ? traceStep("source.prepare", async () => {
          const book = await findBook(getStorage().db, body.bookId!);
          return book ? getSourcePageLayout(book, body.page) : null;
        }).catch(() => { traceAttributes({ alignmentFallback: true }); return null; })
      : Promise.resolve(null);
    onProgress?.({ phase: "waiting" });
    const providerStarted = performance.now();
    const response = await traceStep("provider.wait_headers", () => fetch(endpoint, {
      method: "POST",
      headers,
      body: encoded,
      signal: AbortSignal.timeout(180_000),
    }));
    traceAttributes({ httpStatus: response.status });
    const streaming = response.ok && Boolean(response.headers.get("content-type")?.includes("text/event-stream"));
    traceAttributes({ streamed: streaming });
    const result = streaming ? await traceStep("provider.stream", async () => {
      const firstEvent = startSpan("provider.first_event", {}, providerStarted);
      const firstText = startSpan("provider.first_text", {}, providerStarted);
      const preview = createTranslationPreview();
      let reasoningCharacters = 0, textCharacters = 0;
      return readProviderStream(response, isResponses, {
        event: () => firstEvent(),
        text: (delta) => {
          firstText(); textCharacters += delta.length;
          onProgress?.({ phase: "generating", lastLine: preview(delta), characters: textCharacters });
        },
        reasoning: (characters) => {
          reasoningCharacters += characters;
          if (!textCharacters) onProgress?.({ phase: "thinking", characters: reasoningCharacters });
        },
      });
    }) : await traceStep("provider.read_body", async () => {
      try { return await response.json() as Record<string, unknown>; }
      catch { throw new TranslationProviderError(`Provider returned an invalid JSON response (HTTP ${response.status}).`, response.ok ? 502 : response.status); }
    });
    const usage = result.usage as Record<string, unknown> | undefined;
    if (usage) {
      const details = (usage.output_tokens_details || usage.completion_tokens_details) as Record<string, unknown> | undefined;
      const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries({ inputTokens: usage.input_tokens ?? usage.prompt_tokens, outputTokens: usage.output_tokens ?? usage.completion_tokens,
        reasoningTokens: details?.reasoning_tokens, cachedInputTokens: inputDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens })) {
        if (typeof value === "number" && Number.isFinite(value)) traceAttributes({ [key]: value });
      }
    }
    if (!response.ok) {
      const providerError = (result.error as { message?: string } | undefined)?.message;
      throw new TranslationProviderError(providerError || `Provider returned ${response.status}.`, response.status);
    }

    onProgress?.({ phase: "aligning" });
    const normalize = startSpan("response.normalize");
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
    normalize();
    if (body.bookId) {
      const book = await findBook(getStorage().db, body.bookId);
      if (book) {
        try {
          translation.blocks = await traceStep("alignment.current", async () => {
            const layout = await sourceLayout;
            return layout ? alignSourceBlocks(translation.blocks, layout) : translation.blocks;
          });
          if (translation.previousPageRevision?.page === body.page - 1 && body.page > 1) {
            const revision = translation.previousPageRevision;
            revision.blocks = await traceStep("alignment.previous", async () => alignSourceBlocks(
              revision.blocks, await getSourcePageLayout(book, body.page - 1),
            ));
          }
        } catch { traceAttributes({ alignmentFallback: true }); }
      }
    }
    return translation;
}
