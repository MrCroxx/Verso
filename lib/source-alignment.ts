import { alignTableCells, recoverSourceTables } from "./source-table.ts";
import { recoverSourceCodeBlocks } from "./source-code.ts";
import { normalizeSourceRect, type LayoutBlock, type SourceRect } from "./translation-layout.ts";

export type SourceWord = { text: string; rect: SourceRect; line: number; block?: number; fontSize?: number };
export type SourcePageLayout = { width: number; height: number; words: SourceWord[]; method: "pdf" | "ocr"; confidence?: number; retainedWordRatio?: number };

export function isSourcePageLayout(value: unknown): value is SourcePageLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as SourcePageLayout;
  return Number.isFinite(layout.width) && layout.width > 0 && Number.isFinite(layout.height) && layout.height > 0
    && ["pdf", "ocr"].includes(layout.method) && Array.isArray(layout.words) && layout.words.length <= 100_000
    && layout.words.every((word) => word && typeof word.text === "string" && Number.isSafeInteger(word.line)
      && Boolean(normalizeSourceRect(word.rect)));
}

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
  let block = 0;
  for (const match of xml.matchAll(/<block\b|<line\b|<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
    if (match[0] === "<block") { block += 1; continue; }
    if (match[0] === "<line") { line += 1; continue; }
    const attributes = Object.fromEntries(Array.from(match[1].matchAll(/(xMin|yMin|xMax|yMax)="([\d.-]+)"/g), (part) => [part[1], Number(part[2])]));
    const rect = normalizeSourceRect({ x: attributes.xMin / width, y: attributes.yMin / height, width: (attributes.xMax - attributes.xMin) / width, height: (attributes.yMax - attributes.yMin) / height });
    const text = decodeXml(match[2]);
    if (rect && text.trim()) words.push({ text, rect, line, block });
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
  const blocks = new Map<string, number>();
  const candidates = rows.filter((row) => row[0] === "5" && row.slice(11).join("\t").trim());
  for (const row of rows) {
    if (row[0] !== "5" || Number(row[10]) < 30) continue;
    const text = row.slice(11).join("\t").trim();
    const rect = normalizeSourceRect({ x: Number(row[6]) / width, y: Number(row[7]) / height, width: Number(row[8]) / width, height: Number(row[9]) / height });
    const lineKey = row.slice(1, 5).join(":");
    const blockKey = row.slice(1, 4).join(":");
    if (!lines.has(lineKey)) lines.set(lineKey, lines.size);
    if (!blocks.has(blockKey)) blocks.set(blockKey, blocks.size);
    if (rect && text) words.push({ text, rect, line: lines.get(lineKey)!, block: blocks.get(blockKey)! });
  }
  return { width, height, words, method: "ocr",
    confidence: candidates.length ? candidates.reduce((sum, row) => sum + Math.max(0, Number(row[10]) || 0), 0) / candidates.length : 0,
    retainedWordRatio: candidates.length ? words.length / candidates.length : 0 };
}

export function applyPdfFontSizes(layout: SourcePageLayout, xml: string): SourcePageLayout {
  const attributes = (value: string) => Object.fromEntries(Array.from(value.matchAll(/([\w]+)="([^"]*)"/g), (m) => [m[1], m[2]]));
  const page = attributes(/<page\b([^>]*)>/.exec(xml)?.[1] ?? "");
  // pdftohtml uses the MediaBox. Refuse mismatched CropBoxes or rotations.
  if (Math.abs(Number(page.width) - layout.width) > 1 || Math.abs(Number(page.height) - layout.height) > 1
    || !(Number(page.width) > 0 && Number(page.height) > 0)) return layout;
  const fonts = new Map(Array.from(xml.matchAll(/<fontspec\b([^>]*)\/>/g), (m) => {
    const attr = attributes(m[1]);
    return [attr.id, Number(attr.size)] as const;
  }));
  const spans = Array.from(xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g), (m) => {
    const attr = attributes(m[1]);
    return { x: Number(attr.left), y: Number(attr.top), width: Number(attr.width), height: Number(attr.height),
      font: fonts.get(attr.font), text: matchingText(decodeXml(m[2].replace(/<[^>]*>/g, ""))) };
  }).filter((span) => span.font && span.font > 0 && span.font <= layout.width * .25);
  if (spans.length * layout.words.length > 2_000_000) return layout;
  return { ...layout, words: layout.words.map((word) => {
    const x = (word.rect.x + word.rect.width / 2) * layout.width;
    const y = (word.rect.y + word.rect.height / 2) * layout.height;
    const text = matchingText(word.text);
    const matches = spans.filter((span) => text && span.text.includes(text)
      && x >= span.x - 1 && x <= span.x + span.width + 1 && y >= span.y - 1 && y <= span.y + span.height + 1);
    const sizes = new Set(matches.map((span) => span.font!));
    return sizes.size === 1 ? { ...word, fontSize: matches[0].font! / layout.width } : word;
  }) };
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

function sourceFontSize(words: SourceWord[], layout: SourcePageLayout): number | undefined {
  const lines = new Map<number, SourceWord[]>();
  for (const word of words) {
    if (!matchingText(word.text)) continue;
    const line = lines.get(word.line) ?? [];
    line.push(word);
    lines.set(word.line, line);
  }
  const heights = Array.from(lines.values(), (line) => {
    // Weight by letters so punctuation, superscripts and drop caps cannot dominate.
    const samples = line.map((word) => ({ height: word.fontSize && Number.isFinite(word.fontSize) && word.fontSize > 0 && word.fontSize <= .25
      ? word.fontSize * layout.width / layout.height : word.rect.height,
      weight: Math.min(12, Array.from(matchingText(word.text)).length) }))
      .sort((a, b) => a.height - b.height);
    const target = samples.reduce((sum, sample) => sum + sample.weight, 0) * (layout.method === "ocr" ? 0.65 : 0.5);
    let weight = 0;
    return samples.find((sample) => { weight += sample.weight; return weight >= target; })!.height;
  }).sort((a, b) => a - b);
  // OCR measures visible ink, whose height varies by word. Aggregate whole lines.
  return heights.length ? heights[Math.floor(heights.length / 2)] * layout.height / layout.width : undefined;
}

export function alignSourceBlocks(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  blocks = recoverSourceTables(recoverSourceCodeBlocks(alignTableCells(blocks, layout), layout), layout);
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
    if (block.kind === "code" || block.kind === "table_header" || block.kind === "table_row") {
      const r = block.sourceRect;
      const words = r ? layout.words.filter(({ rect: w }) => w.x + w.width / 2 >= r.x && w.x + w.width / 2 <= r.x + r.width
        && w.y + w.height / 2 >= r.y && w.y + w.height / 2 <= r.y + r.height) : [];
      const fontSize = sourceFontSize(words, layout);
      return { ...block, ...(fontSize && { fontSize }) };
    }
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
    const fontWords = matchedWords.length ? matchedWords : regionWords;
    const fontSize = sourceFontSize(fontWords, layout);
    return { ...block, ...(sentences && { sentences }), ...(fontSize && { fontSize }) };
  });
}
