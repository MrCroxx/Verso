import { NextRequest, NextResponse } from "next/server";
import { normalizeLayoutBlocks } from "../../../lib/translation-layout";

export const runtime = "edge";

type RequestBody = {
  settings: {
    provider: "openai" | "compatible";
    endpoint: string;
    apiKey: string;
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    targetLanguage: string;
  };
  page: number;
  totalPages: number;
  images: Array<{ page: number; dataUrl: string }>;
  previousTranslationTail?: string;
};

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
  },
  required: ["kind", "text", "marker", "trailing", "align", "indent", "spaceBefore", "size"],
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
    page: typeof result.page === "number" ? result.page : requestedPage,
    blocks,
    isBlank: !blocks.some((block) => block.kind !== "spacer" && block.text.trim()),
    sourceSummary: typeof result.sourceSummary === "string" ? result.sourceSummary : "",
    previousPageRevision: revision
      ? {
          page: typeof revision.page === "number" ? revision.page : requestedPage - 1,
          blocks: normalizeLayoutBlocks(revision.blocks),
        }
      : null,
  };
}

function prompt(body: RequestBody) {
  const available = body.images.map((image) => image.page).join(", ");
  const previousTranslation = body.previousTranslationTail
    ? `\nThe cached translation ends with: ${JSON.stringify(body.previousTranslationTail)}. Do not repeat this text at the start of page ${body.page}.`
    : "";
  return `You are translating a scanned book into ${body.settings.targetLanguage}.
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
- Use heading, paragraph, caption, and page_number blocks according to their visual role. Preserve order, alignment, indentation, and relative typography with align, indent, and size.
- Preserve meaningful vertical whitespace with spacer blocks. Use size xl for a large illustration/table region, lg for a large section gap, and smaller sizes for ordinary spacing. Do not describe or translate an image inside a spacer.
- Use spaceBefore to approximate smaller gaps before text blocks. Avoid encoding layout with spaces, tabs, or repeated newlines inside text.
- For fields that do not apply, return an empty string for marker and trailing. For spacer blocks, return empty strings for text, marker, and trailing.
- If the requested page contains no readable or translatable text, return an empty blocks array. This is a valid successful result; do not invent content.
- If page ${body.page - 1} ended mid-paragraph and the current page changes its meaning, return a complete corrected block layout for the previous page in previousPageRevision. Its text and the current blocks must remain disjoint with no repeated boundary fragment. Otherwise return null.
- Keep names and technical terminology consistent. Do not add commentary.
- Return JSON matching the supplied schema.`;
}

function endpointFor(body: RequestBody) {
  const raw = body.settings.endpoint.trim().replace(/\/$/, "");
  if (body.settings.provider === "openai") return raw || "https://api.openai.com/v1/responses";
  if (/\/(chat\/completions|responses)$/.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    if (!body.settings?.apiKey || !body.settings?.model || !body.images?.length) {
      return NextResponse.json({ error: "Missing API key, model, or page images." }, { status: 400 });
    }
    if (body.images.length > 3) {
      return NextResponse.json({ error: "At most three adjacent pages are allowed." }, { status: 400 });
    }
    const endpoint = endpointFor(body);
    const headers = { Authorization: `Bearer ${body.settings.apiKey}`, "Content-Type": "application/json" };
    const instruction = prompt(body);
    const isResponses = body.settings.provider === "openai" || endpoint.endsWith("/responses");
    const payload = isResponses
      ? {
          model: body.settings.model,
          ...(body.settings.reasoningEffort !== "none" && { reasoning: { effort: body.settings.reasoningEffort } }),
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              ...body.images.flatMap((image) => [
                { type: "input_text", text: `Page ${image.page}:` },
                { type: "input_image", image_url: image.dataUrl, detail: "high" },
              ]),
            ],
          }],
          text: { format: { type: "json_schema", name: "page_translation", strict: true, schema } },
        }
      : {
          model: body.settings.model,
          ...(body.settings.reasoningEffort !== "none" && { reasoning_effort: body.settings.reasoningEffort }),
          messages: [{
            role: "user",
            content: [
              { type: "text", text: instruction },
              ...body.images.flatMap((image) => [
                { type: "text", text: `Page ${image.page}:` },
                { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } },
              ]),
            ],
          }],
          response_format: { type: "json_object" },
        };

    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
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
    return NextResponse.json(normalizeTranslationResponse(JSON.parse(text), body.page));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected translation error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
