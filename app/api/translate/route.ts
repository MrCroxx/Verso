import { NextRequest, NextResponse } from "next/server";
import { getAiProviderSettings } from "../../../db/ai-provider-settings";
import {
  isResponsesEndpoint,
  providerEndpoint,
  providerErrorMessage,
  providerOutputText,
} from "../../../lib/ai-provider-client";
import type { AiProviderSettings } from "../../../lib/ai-provider-settings";
import {
  normalizePageRecognition,
  recognitionBlockKey,
  type BoundaryState,
  type PageRecognition,
} from "../../../lib/page-recognition";
import type { LayoutBlock } from "../../../lib/translation-layout";

export const runtime = "nodejs";

type RequestBody = {
  targetLanguage: string;
  totalPages: number;
  requestedPages: number[];
  recognitions: PageRecognition[];
  boundaryStates?: Record<string, BoundaryState>;
};

type ModelBlock = {
  id: string;
  text: string;
  marker: string;
  trailing: string;
};

const translatedBlockSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    marker: { type: "string" },
    trailing: { type: "string" },
  },
  required: ["id", "text", "marker", "trailing"],
};

const translationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer" },
          blocks: { type: "array", items: translatedBlockSchema },
        },
        required: ["page", "blocks"],
      },
    },
  },
  required: ["pages"],
};

function configured(settings: AiProviderSettings | null): settings is AiProviderSettings {
  return Boolean(settings?.apiKey && settings.endpoint && settings.translationModel);
}

function normalizeRequest(body: RequestBody) {
  if (
    typeof body.targetLanguage !== "string"
    || !body.targetLanguage.trim()
    || body.targetLanguage.length > 80
    || !Number.isSafeInteger(body.totalPages)
    || body.totalPages < 1
    || !Array.isArray(body.requestedPages)
    || body.requestedPages.length < 1
    || body.requestedPages.length > 9
    || !Array.isArray(body.recognitions)
    || body.recognitions.length < 1
    || body.recognitions.length > 9
  ) return null;
  const requestedPages = [...new Set(body.requestedPages.map(Number))].sort((left, right) => left - right);
  if (requestedPages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > body.totalPages)) return null;
  const recognitions = body.recognitions.map((recognition) => (
    normalizePageRecognition(recognition, Number(recognition?.page), recognition?.model)
  ));
  if (
    recognitions.some((recognition) => !Number.isSafeInteger(recognition.page) || recognition.page < 1)
    || requestedPages.some((page) => !recognitions.some((recognition) => recognition.page === page))
  ) return null;
  return {
    requestedPages,
    recognitions,
    boundaryStates: body.boundaryStates || {},
  };
}

function translationPrompt(
  targetLanguage: string,
  recognitions: PageRecognition[],
  requestedPages: number[],
  boundaryStates: Record<string, BoundaryState>,
) {
  const pages = recognitions
    .filter((recognition) => requestedPages.includes(recognition.page))
    .map((recognition) => ({
      page: recognition.page,
      blocks: recognition.blocks.map((block) => ({
        id: block.id,
        kind: block.kind,
        text: block.sourceText,
        marker: block.marker,
        trailing: block.trailing,
        continuation: block.continuation,
        translate: boundaryStates[recognitionBlockKey(recognition.page, block.id)] !== "waiting_for_neighbor"
          && block.kind !== "spacer",
      })),
    }));
  return `Translate the supplied, already-recognized book text into ${targetLanguage}. No image interpretation is needed.

The pages form one claimed translation unit. Blocks marked from_previous, to_next, or both across adjacent pages are fragments of the same prose. Interpret those fragments together exactly once, but return a separate translation for each source block ID so physical page ownership remains unchanged. Never repeat translated boundary words on both pages.

Return every block whose translate field is true exactly once, grouped under its source page. Omit blocks whose translate field is false: their missing neighboring page is outside the active prefetch window, so they must remain untranslated. Preserve list markers, printed page references, names, terminology, and block order. Copy page numbers without changing them. Do not add commentary or source text.

Recognized source JSON:
${JSON.stringify(pages)}

Return JSON matching the schema.`;
}

function normalizedTranslations(
  result: unknown,
  recognitions: PageRecognition[],
  requestedPages: number[],
  boundaryStates: Record<string, BoundaryState>,
) {
  const output = result && typeof result === "object" ? result as { pages?: unknown } : {};
  const outputPages = Array.isArray(output.pages) ? output.pages : [];
  const translated = new Map<string, ModelBlock>();
  for (const rawPage of outputPages) {
    if (!rawPage || typeof rawPage !== "object") continue;
    const page = rawPage as { page?: unknown; blocks?: unknown };
    if (!Number.isSafeInteger(page.page) || !Array.isArray(page.blocks)) continue;
    for (const rawBlock of page.blocks) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Partial<ModelBlock>;
      if (typeof block.id !== "string") continue;
      translated.set(recognitionBlockKey(Number(page.page), block.id), {
        id: block.id,
        text: typeof block.text === "string" ? block.text : "",
        marker: typeof block.marker === "string" ? block.marker : "",
        trailing: typeof block.trailing === "string" ? block.trailing : "",
      });
    }
  }

  return recognitions
    .filter((recognition) => requestedPages.includes(recognition.page))
    .map((recognition) => {
      const blocks = recognition.blocks.map((source): LayoutBlock => {
        const key = recognitionBlockKey(recognition.page, source.id);
        const boundaryState = boundaryStates[key] || "none";
        const pending = boundaryState === "waiting_for_neighbor";
        const translation = translated.get(key);
        if (!pending && source.kind !== "spacer" && source.sourceText.trim() && !translation) {
          throw new Error(`The translation model omitted source block ${key}.`);
        }
        return {
          kind: source.kind,
          text: pending ? "" : translation?.text || "",
          marker: pending ? "" : translation?.marker || source.marker,
          trailing: pending ? "" : translation?.trailing || source.trailing,
          align: source.align,
          indent: source.indent,
          spaceBefore: source.spaceBefore,
          size: source.size,
          sourceBlockId: source.id,
          sourceContinuation: source.continuation,
          boundaryStatus: pending ? "waiting_for_neighbor" : boundaryState === "none" ? "none" : "translated",
        };
      });
      return {
        page: recognition.page,
        blocks,
        isBlank: recognition.isBlank,
        sourceSummary: recognition.sourceSummary,
      };
    });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    const normalized = normalizeRequest(body);
    if (!normalized) {
      return NextResponse.json({ error: "Missing target language or recognized page data." }, { status: 400 });
    }
    const settings = await getAiProviderSettings();
    if (!configured(settings)) {
      return NextResponse.json({ error: "AI provider is not configured on the server." }, { status: 503 });
    }
    const endpoint = providerEndpoint(settings);
    const responsesApi = isResponsesEndpoint(settings, endpoint);
    const instruction = translationPrompt(
      body.targetLanguage,
      normalized.recognitions,
      normalized.requestedPages,
      normalized.boundaryStates,
    );
    const payload = responsesApi
      ? {
          model: settings.translationModel,
          ...(settings.reasoningEffort !== "none" && { reasoning: { effort: settings.reasoningEffort } }),
          input: [{ role: "user", content: [{ type: "input_text", text: instruction }] }],
          text: { format: { type: "json_schema", name: "page_translation", strict: true, schema: translationSchema } },
        }
      : {
          model: settings.translationModel,
          ...(settings.reasoningEffort !== "none" && { reasoning_effort: settings.reasoningEffort }),
          messages: [{ role: "user", content: instruction }],
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
    if (!text) throw new Error("The translation model returned no text.");
    return NextResponse.json({
      translations: normalizedTranslations(
        JSON.parse(text),
        normalized.recognitions,
        normalized.requestedPages,
        normalized.boundaryStates,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected translation error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
