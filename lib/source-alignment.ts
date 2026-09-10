import { normalizeSourceRect, type LayoutBlock, type SourceRect } from "./translation-layout.ts";

export type SourceWord = { text: string; rect: SourceRect; line: number };
export type SourcePageLayout = { width: number; height: number; words: SourceWord[]; method: "pdf" | "ocr" };

function decodeXml(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const value = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity] || "";
  });
}

export function parsePdfWordLayout(xml: string, rotation = 0): SourcePageLayout {
  const page = /<page\b[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(xml);
  // Poppler rotates word coordinates but reports unrotated CropBox dimensions.
  const sideways = Math.abs(rotation % 180) === 90;
  const width = Number(page?.[sideways ? 2 : 1]);
  const height = Number(page?.[sideways ? 1 : 2]);
  if (!(width > 0 && height > 0)) throw new Error("PDF text extraction returned no page dimensions.");
  const words: SourceWord[] = [];
  let line = 0;
  for (const match of xml.matchAll(/<line\b|<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
    if (match[0] === "<line") { line += 1; continue; }
    const attributes = Object.fromEntries(Array.from(match[1].matchAll(/(xMin|yMin|xMax|yMax)="([\d.-]+)"/g), (part) => [part[1], Number(part[2])]));
    const rect = normalizeSourceRect({ x: attributes.xMin / width, y: attributes.yMin / height, width: (attributes.xMax - attributes.xMin) / width, height: (attributes.yMax - attributes.yMin) / height });
    const text = decodeXml(match[2]);
    if (rect && text.trim()) words.push({ text, rect, line });
  }
  return { width, height, words, method: "pdf" };
}

export function parseOcrWordLayout(tsv: string): SourcePageLayout {
  const rows = tsv.trim().split(/\r?\n/).slice(1).map((line) => line.split("\t"));
  const page = rows.find((row) => row[0] === "1");
  const width = Number(page?.[8]);
  const height = Number(page?.[9]);
  if (!(width > 0 && height > 0)) throw new Error("OCR returned no page dimensions.");
  const words: SourceWord[] = [];
  const lines = new Map<string, number>();
  for (const row of rows) {
    if (row[0] !== "5" || Number(row[10]) < 30) continue;
    const text = row.slice(11).join("\t").trim();
    const rect = normalizeSourceRect({ x: Number(row[6]) / width, y: Number(row[7]) / height, width: Number(row[8]) / width, height: Number(row[9]) / height });
    const lineKey = row.slice(1, 5).join(":");
    if (!lines.has(lineKey)) lines.set(lineKey, lines.size);
    if (rect && text) words.push({ text, rect, line: lines.get(lineKey)! });
  }
  return { width, height, words, method: "ocr" };
}

function matchingText(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function alignSourceBlocks(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  let text = "";
  const ranges = layout.words.map((word) => {
    const start = text.length;
    text += matchingText(word.text);
    return { ...word, start, end: text.length };
  });
  let cursor = 0;
  return blocks.map((block) => {
    if (block.kind === "image" || block.kind === "spacer") return block;
    const matchedWords: SourceWord[] = [];
    const sentences = block.sentences?.map((sentence) => {
      const needle = matchingText(sentence.sourceText);
      let start = needle ? text.indexOf(needle, cursor) : -1;
      if (start < 0 && needle) start = text.indexOf(needle);
      if (start < 0) return { ...sentence, sourceRects: [] };
      const end = start + needle.length;
      cursor = end;
      const words = ranges.filter((word) => word.end > start && word.start < end);
      matchedWords.push(...words);
      const lines = new Map<number, SourceRect>();
      for (const word of words) {
        const previous = lines.get(word.line);
        const rect = word.rect;
        lines.set(word.line, previous ? {
          x: Math.min(previous.x, rect.x), y: Math.min(previous.y, rect.y),
          width: Math.max(previous.x + previous.width, rect.x + rect.width) - Math.min(previous.x, rect.x),
          height: Math.max(previous.y + previous.height, rect.y + rect.height) - Math.min(previous.y, rect.y),
        } : { ...rect });
      }
      return { ...sentence, sourceRects: Array.from(lines.values()) };
    });
    const region = block.sourceRect;
    const regionWords = region ? layout.words.filter(({ rect }) => {
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
    }) : [];
    const fontWords = matchedWords.length ? matchedWords : regionWords.length ? regionWords : layout.words;
    const sizes = fontWords.map((word) => Math.min(word.rect.height * layout.height, word.rect.width * layout.width) / layout.width).sort((a, b) => a - b);
    return { ...block, ...(sentences && { sentences }), ...(sizes.length && (block.fontSize || matchedWords.length) && { fontSize: sizes[Math.floor(sizes.length / 2)] }) };
  });
}
