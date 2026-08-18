import { normalizeLayoutBlocks } from "./translation-layout.ts";

export type TranslationSearchMatch = {
  page: number;
  snippet: string;
};

function searchableText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function translatedText(payload: Record<string, unknown>) {
  const blocks = normalizeLayoutBlocks(payload.blocks);
  const text = blocks.map((block) => block.text).filter(Boolean).join("\n");
  return text || searchableText(payload.markdown);
}

function excerpt(text: string, query: string, radius = 72) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function searchTranslationPayload(payloadValue: unknown, page: number, query: string): TranslationSearchMatch[] {
  const payload = payloadValue && typeof payloadValue === "object" ? payloadValue as Record<string, unknown> : {};
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const snippet = excerpt(translatedText(payload), normalizedQuery);
  return snippet ? [{ page, snippet }] : [];
}
