import { NextRequest, NextResponse } from "next/server";
import { getAiProviderSettings } from "../../../db/ai-provider-settings";
import { ensureStorageSchema, findBook, getStorage } from "../../../db/books";
import {
  isResponsesEndpoint,
  providerEndpoint,
  providerErrorMessage,
  providerOutputText,
} from "../../../lib/ai-provider-client";
import type { AiProviderSettings } from "../../../lib/ai-provider-settings";
import { normalizePageRecognition } from "../../../lib/page-recognition";
import { getRenderedPage, PageRendererUnavailableError } from "../../../lib/server-page-renderer";

export const runtime = "nodejs";

type RecognitionRequest = {
  documentId: string;
  bookId?: string;
  page: number;
  totalPages: number;
  image?: { dataUrl: string };
  force?: boolean;
};

const MAX_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;

const blockSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["heading", "paragraph", "list_item", "caption", "spacer", "page_number"] },
    text: { type: "string" },
    marker: { type: "string" },
    trailing: { type: "string" },
    align: { type: "string", enum: ["left", "center", "right", "justify"] },
    indent: { type: "integer", minimum: 0, maximum: 3 },
    spaceBefore: { type: "string", enum: ["none", "xs", "sm", "md", "lg", "xl"] },
    size: { type: "string", enum: ["xs", "sm", "md", "lg", "xl"] },
    continuation: { type: "string", enum: ["none", "from_previous", "to_next", "both"] },
    bounds: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        width: { type: "number", minimum: 0, maximum: 1 },
        height: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["x", "y", "width", "height"],
    },
  },
  required: [
    "kind",
    "text",
    "marker",
    "trailing",
    "align",
    "indent",
    "spaceBefore",
    "size",
    "continuation",
    "bounds",
  ],
};

const recognitionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    blocks: { type: "array", items: blockSchema },
    sourceSummary: { type: "string" },
  },
  required: ["blocks", "sourceSummary"],
};

function configured(settings: AiProviderSettings | null): settings is AiProviderSettings {
  return Boolean(settings?.apiKey && settings.endpoint && settings.recognitionModel);
}

function validRequest(body: RecognitionRequest) {
  return typeof body.documentId === "string"
    && body.documentId.length > 0
    && body.documentId.length <= 128
    && Number.isSafeInteger(body.page)
    && body.page >= 1
    && Number.isSafeInteger(body.totalPages)
    && body.totalPages >= body.page
    && (
      (typeof body.bookId === "string" && body.bookId.length > 0 && body.bookId.length <= 256)
      || (
        typeof body.image?.dataUrl === "string"
        && body.image.dataUrl.startsWith("data:image/")
        && body.image.dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH
      )
    );
}

async function resolveImage(body: RecognitionRequest) {
  if (body.image?.dataUrl) return body.image.dataUrl;
  const { db } = getStorage();
  const book = await findBook(db, body.bookId!);
  if (!book) throw new Error("Book not found.");
  if (book.pageCount !== body.totalPages) throw new Error("Book page count does not match the recognition request.");
  const rendered = await getRenderedPage(book, body.page, "vision");
  return `data:image/jpeg;base64,${rendered.bytes.toString("base64")}`;
}

function recognitionPrompt(page: number, totalPages: number) {
  return `Inspect scanned book page ${page} of ${totalPages}. Extract source text and layout only; do not translate.

Return ordered blocks in reading order. Classify headings, body paragraphs, list items, captions, spacers, and page numbers. Preserve list markers and trailing references separately. Bounds are normalized page coordinates.

For every body paragraph or caption, classify its page-boundary relationship:
- from_previous: the visible text begins as the continuation of unfinished prose from page ${page - 1}.
- to_next: the visible text ends with unfinished prose that continues on page ${page + 1}.
- both: both conditions apply to this same visible block.
- none: the block is complete on this page.

Use typography, indentation, capitalization, punctuation, hyphenation, and the physical top/bottom page boundary as evidence. Do not join text that is not visibly printed on this page. Do not invent missing words. Use [illegible] only for genuinely unreadable source text. Return JSON matching the schema.`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RecognitionRequest;
    if (!validRequest(body)) {
      return NextResponse.json({ error: "Missing document, page metadata, or page image." }, { status: 400 });
    }
    const settings = await getAiProviderSettings();
    if (!configured(settings)) {
      return NextResponse.json({ error: "AI provider is not configured on the server." }, { status: 503 });
    }
    const { db } = getStorage();
    await ensureStorageSchema(db);
    const cached = await db.prepare(`SELECT payload FROM page_recognitions
      WHERE document_id = ?1 AND page = ?2 AND model = ?3`)
      .bind(body.documentId, body.page, settings.recognitionModel)
      .first<{ payload: string }>();
    if (cached && !body.force) {
      return NextResponse.json({
        recognition: normalizePageRecognition(JSON.parse(cached.payload), body.page, settings.recognitionModel),
        source: "cache",
      });
    }

    const image = await resolveImage(body);
    const endpoint = providerEndpoint(settings);
    const responsesApi = isResponsesEndpoint(settings, endpoint);
    const instruction = recognitionPrompt(body.page, body.totalPages);
    const payload = responsesApi
      ? {
          model: settings.recognitionModel,
          ...(settings.reasoningEffort !== "none" && { reasoning: { effort: settings.reasoningEffort } }),
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              { type: "input_image", image_url: image, detail: "high" },
            ],
          }],
          text: { format: { type: "json_schema", name: "page_recognition", strict: true, schema: recognitionSchema } },
        }
      : {
          model: settings.recognitionModel,
          ...(settings.reasoningEffort !== "none" && { reasoning_effort: settings.reasoningEffort }),
          messages: [{
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "image_url", image_url: { url: image, detail: "high" } },
            ],
          }],
          response_format: { type: "json_object" },
        };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      return NextResponse.json({ error: providerErrorMessage(result, response.status) }, { status: response.status });
    }
    const text = providerOutputText(result, responsesApi);
    if (!text) throw new Error("The recognition model returned no text.");
    const recognition = normalizePageRecognition(JSON.parse(text), body.page, settings.recognitionModel);
    await db.prepare(`INSERT INTO page_recognitions (document_id, page, model, payload, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(document_id, page, model) DO UPDATE SET
        payload = excluded.payload, updated_at = excluded.updated_at`)
      .bind(body.documentId, body.page, settings.recognitionModel, JSON.stringify(recognition), Date.now())
      .run();
    return NextResponse.json({ recognition, source: "api" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected recognition error.";
    return NextResponse.json(
      {
        error: message,
        ...(error instanceof PageRendererUnavailableError && { code: "PAGE_RENDERER_UNAVAILABLE" }),
      },
      { status: error instanceof PageRendererUnavailableError ? 503 : 500 },
    );
  }
}
