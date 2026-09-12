import { normalizeLayoutBlocks, type LayoutBlock, type SourceRect } from "./translation-layout.ts";
import { alignSourceBlocks, type SourcePageLayout, type SourceWord } from "./source-alignment.ts";

export type TextUnit = { id: string; sourceText: string };
export type TextPage = { blocks: LayoutBlock[]; units: TextUnit[][] };

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function bounds(words: SourceWord[]): SourceRect {
  const x = Math.min(...words.map((w) => w.rect.x)), y = Math.min(...words.map((w) => w.rect.y));
  return { x, y, width: Math.max(...words.map((w) => w.rect.x + w.rect.width)) - x,
    height: Math.max(...words.map((w) => w.rect.y + w.rect.height)) - y };
}

// Only ordinary Latin-script prose is eligible initially. Other scripts, formulas,
// lists, columns, unusual typography and uncertain extraction retain vision.
export function buildTextPage(layout: SourcePageLayout): TextPage | null {
  const { words } = layout;
  if (words.length < 20 || words.length > 2500 || words.some((w) => w.block === undefined)) return null;
  const text = words.map((w) => w.text).join(" ");
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}\s]/u.test(text)
    || /[=+<>^_{}\\|]|\.{3}|…/.test(text)
    || words.some((w) => /^[b-hj-zB-HJ-Z]$/.test(w.text))) return null;
  if (words.filter((w) => /[\p{Script=Latin}]{2}/u.test(w.text)).length / words.length < 0.8) return null;
  const groups = new Map<number, SourceWord[]>();
  for (const word of words) {
    if (!(word.rect.width > 0 && word.rect.height > 0)) return null;
    const group = groups.get(word.block!) || [];
    group.push(word); groups.set(word.block!, group);
  }
  if (groups.size > 30) return null;
  const bodyHeight = median(words.map((w) => w.rect.height));
  const blocks: LayoutBlock[] = [], units: TextUnit[][] = [];
  let previousBottom = 0;
  for (const group of groups.values()) {
    const rect = bounds(group);
    if (rect.y < previousBottom - 0.005) return null;
    const lines = new Map<number, SourceWord[]>();
    for (const word of group) { const line = lines.get(word.line) || []; line.push(word); lines.set(word.line, line); }
    let lastY = -1;
    for (const line of lines.values()) {
      if (lastY >= 0 && line[0].rect.y < lastY + bodyHeight * 0.6) return null;
      lastY = line[0].rect.y;
      for (let i = 1; i < line.length; i++) {
        const gap = line[i].rect.x - line[i - 1].rect.x - line[i - 1].rect.width;
        if (gap < -0.005 || gap > 0.04 || Math.abs(line[i].rect.y - line[0].rect.y) > bodyHeight * 0.4) return null;
      }
    }
    const sourceText = group.map((w) => w.text).join(" ");
    const height = median(group.map((w) => w.rect.height));
    if (group.some((w) => w.rect.height < height * 0.75 || w.rect.height > height * 1.3)) return null;
    const pageNumber = /^\d+$/.test(sourceText) && (rect.y < 0.12 || rect.y > 0.88);
    const heading = !pageNumber && height > bodyHeight * 1.2 && sourceText.length < 160;
    if (!pageNumber && !heading && (group.length < 6 || rect.width < 0.5)) return null;
    if (/^(?:\d+[.)]\s|[-•]\s|figure\s|fig\.\s|table\s)/i.test(sourceText)) return null;
    const parts = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(sourceText), (s) => s.segment);
    const index = blocks.length;
    units.push(parts.map((part, i) => ({ id: `b${index}s${i}`, sourceText: part })));
    blocks.push({ kind: pageNumber ? "page_number" : heading ? "heading" : "paragraph", text: sourceText,
      marker: "", trailing: "", align: Math.abs(rect.x + rect.width / 2 - 0.5) < 0.035 && (heading || pageNumber) ? "center" : "left",
      indent: 0, spaceBefore: blocks.length && rect.y - previousBottom > bodyHeight * 1.3 ? "lg" : "sm",
      size: heading ? "lg" : "md", sourceRect: rect, fontSize: height * layout.height / layout.width });
    previousBottom = rect.y + rect.height;
  }
  return { blocks, units };
}

// Cairo emits text as glyph uses and diagrams as paths/images. Reject anything
// other than glyph painting, including hidden-text scans and unknown SVG forms.
export function isTextOnlySvg(svg: string, layout: SourcePageLayout): boolean {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/.test(svg) || !svg.includes("</svg>")) return false;
  if (/<(?:image|text|foreignObject|mask|pattern|linearGradient|radialGradient)\b/i.test(svg)) return false;
  const painted = svg.replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/g, "");
  if (/<(?:path|rect|line|polyline|polygon|circle|ellipse)\b/i.test(painted)) return false;
  const uses = [...painted.matchAll(/<use\b([^>]*)>/g)];
  if (!uses.length || uses.some((m) => !/(?:xlink:)?href="#glyph[-\w]+"/.test(m[1]))) return false;
  const characters = layout.words.map((w) => w.text).join(" ").length;
  return uses.length >= characters * 0.85 && uses.length <= characters * 1.15;
}

export function boundaryText(page: TextPage, side: "top" | "bottom"): string | null {
  const content = page.blocks.filter((b) => b.kind !== "page_number");
  const blocks = side === "top" ? content.slice(0, 2) : content.slice(-2);
  const text = blocks.map((b) => b.text).join("\n\n");
  // Never truncate a boundary paragraph or a split word to meet a budget.
  return text && text.length <= 3500 ? text : null;
}

export function canCropBoundary(layout: SourcePageLayout, side: "top" | "bottom"): boolean {
  if (layout.method !== "ocr" || (layout.confidence ?? 0) < 95 || (layout.retainedWordRatio ?? 0) < 0.98) return false;
  const page = buildTextPage(layout);
  if (!page) return false;
  const content = page.blocks.filter((b) => b.kind !== "page_number");
  const blocks = side === "top" ? content.slice(0, 2) : content.slice(-2);
  return blocks.length > 0 && blocks.every((b) => side === "top"
    ? b.sourceRect!.y + b.sourceRect!.height < 0.48 : b.sourceRect!.y > 0.52);
}

export function needsPreviousPageImage(tail?: string) {
  return Boolean(tail?.trim() && !/[.!?。！？][”’"')\]}】》」』]*$/u.test(tail.trim()));
}

export const textTranslationSchema = {
  type: "object", additionalProperties: false,
  properties: { translations: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } } },
  required: ["translations"],
};

export function restoreTextTranslation(value: unknown, page: TextPage, layout: SourcePageLayout): LayoutBlock[] {
  const translations = (value as { translations?: unknown } | null)?.translations;
  const expected = page.units.flat();
  if (!Array.isArray(translations) || translations.length !== expected.length) throw new Error("Text translation omitted source units.");
  for (let i = 0; i < expected.length; i++) {
    if (translations[i]?.id !== expected[i].id || typeof translations[i].text !== "string" || !translations[i].text.trim()) {
      throw new Error("Text translation returned missing, duplicated, reordered, or empty source units.");
    }
  }
  const byId = new Map(translations.map((t) => [t.id, t.text as string]));
  page.blocks.forEach((block, i) => {
    if (block.kind === "page_number" && page.units[i].some((u) => byId.get(u.id)!.trim() !== u.sourceText.trim())) {
      throw new Error("Text translation changed a printed page number.");
    }
  });
  return alignSourceBlocks(page.blocks.map((block, i) => {
    const sentences = page.units[i].map((u) => ({ text: byId.get(u.id)!, sourceText: u.sourceText, sourceRects: [] }));
    return { ...block, text: sentences.map((s) => s.text).join(""), sentences };
  }), layout);
}

// The compact provider contract omits block.text; the persisted/UI contract stays
// unchanged. Legacy provider responses and imported translations remain readable.
export function restoreCompactBlocks(value: unknown): LayoutBlock[] {
  if (!Array.isArray(value)) throw new Error("The model returned no layout blocks.");
  return normalizeLayoutBlocks(value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid layout block.");
    if (typeof item.text === "string") return item;
    if (!Array.isArray(item.sentences)) throw new Error("Missing translated sentences.");
    if (item.sentences.some((s: { text?: unknown }) => typeof s?.text !== "string")) throw new Error("Invalid translated sentence.");
    const text = item.sentences.map((s: { text: string }) => s.text).join("");
    if (!["image", "spacer", "table_header", "table_row"].includes(item.kind) && !text.trim()) throw new Error("Empty translated text block.");
    return { ...item, text };
  }));
}
