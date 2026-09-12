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

type TextMatch = { start: number; end: number; distance: number };

function approximateSentence(text: string, needle: string, cursor: number, starts: Set<number>, ends: Set<number>): TextMatch | undefined {
  // Only repair small transcription errors in long, well-grounded sentences.
  // Short labels and substantially different text must not acquire guessed boxes.
  const limit = Math.min(3, Math.floor(needle.length * 0.02));
  if (!limit) return;
  const candidates = new Set<number>();
  for (let part = 0; part <= limit; part++) {
    const offset = Math.floor(part * needle.length / (limit + 1));
    const seed = needle.slice(offset, Math.floor((part + 1) * needle.length / (limit + 1)));
    // With at most k edits, at least one of k + 1 disjoint seeds is unchanged.
    let found = text.indexOf(seed);
    while (found >= 0) {
      for (let delta = -limit; delta <= limit; delta++) {
        const start = found - offset + delta;
        if (starts.has(start)) candidates.add(start);
      }
      if (candidates.size > 128) return;
      found = text.indexOf(seed, found + 1);
    }
  }
  const matches: TextMatch[] = [];
  for (const start of candidates) {
    const length = Math.min(needle.length + limit, text.length - start);
    if (length < needle.length - limit) continue;
    let previous = new Uint16Array(length + 1).fill(limit + 1);
    let current = new Uint16Array(length + 1);
    for (let j = 0; j <= Math.min(limit, length); j++) previous[j] = j;
    for (let i = 1; i <= needle.length; i++) {
      const first = Math.max(1, i - limit);
      const last = Math.min(length, i + limit);
      current.fill(limit + 1, first - 1, Math.min(length + 1, last + 2));
      current[0] = Math.min(i, limit + 1);
      for (let j = first; j <= last; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
          previous[j - 1] + (needle[i - 1] === text[start + j - 1] ? 0 : 1));
      }
      [previous, current] = [current, previous];
    }
    for (let j = Math.max(1, needle.length - limit); j <= length; j++) {
      if (previous[j] <= limit && ends.has(start + j)) {
        matches.push({ start, end: start + j, distance: previous[j] });
      }
    }
  }
  const bestDistance = Math.min(...matches.map((match) => match.distance));
  const best = matches.filter((match) => match.distance === bestDistance).sort((a, b) => a.start - b.start);
  if (!best.length) return;
  // Identical repeated sentences follow reading order; competing texts are ambiguous.
  const matchedText = text.slice(best[0].start, best[0].end);
  if (best.some((match) => text.slice(match.start, match.end) !== matchedText)) return;
  return best.find((match) => match.start >= cursor) ?? best[0];
}

export function alignSourceBlocks(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  let text = "";
  const ranges = layout.words.map((word) => {
    const start = text.length;
    text += matchingText(word.text);
    return { ...word, start, end: text.length };
  });
  const starts = new Set(ranges.filter((word) => word.end > word.start).map((word) => word.start));
  const ends = new Set(ranges.filter((word) => word.end > word.start).map((word) => word.end));
  let cursor = 0;
  return blocks.map((block) => {
    if (block.kind === "image" || block.kind === "spacer") return block;
    const matchedWords: SourceWord[] = [];
    const sentences = block.sentences?.map((sentence) => {
      const needle = matchingText(sentence.sourceText);
      let start = needle ? text.indexOf(needle, cursor) : -1;
      if (start < 0 && needle) start = text.indexOf(needle);
      const approximate = start < 0 ? approximateSentence(text, needle, cursor, starts, ends) : undefined;
      if (start < 0 && !approximate) return { ...sentence, sourceRects: [] };
      const end = approximate?.end ?? start + needle.length;
      start = approximate?.start ?? start;
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
    // Narrow symbols and script-sized glyphs do not measure an equation's base font.
    if (block.kind === "equation") return { ...block, ...(sentences && { sentences }) };
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
