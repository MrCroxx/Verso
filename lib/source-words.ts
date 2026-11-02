import type { SourcePageLayout, SourceWord } from "./source-alignment.ts";
import { normalizeSourceRect, type LayoutBlock } from "./translation-layout.ts";

export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

export type PdfTextViewport = {
  width: number;
  height: number;
  transform: number[];
};

// Mirrors pdf.js TextLayer geometry: the viewport transform maps the baseline
// origin while item width and height stay in unscaled text space.
export function layoutFromPdfTextContent(items: PdfTextItem[], viewport: PdfTextViewport): SourcePageLayout {
  const words: SourceWord[] = [];
  const viewportScale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
  let line = 0;
  let previousTop = Number.NaN;
  for (const item of items) {
    const runs = wordRuns(item.str);
    if (!runs.length) {
      if (item.hasEOL) { line += 1; previousTop = Number.NaN; }
      continue;
    }
    const [a, b, c, d, e, f] = multiply(viewport.transform, item.transform);
    // Item width and height are unscaled text space; the viewport transform
    // supplies scale and rotation. The item transform may include font size.
    const fontHeight = item.height * viewportScale || Math.hypot(c, d);
    if (!(fontHeight > 0)) continue;
    const angle = Math.atan2(b, a);
    const left = angle === 0 ? e : e + fontHeight * Math.sin(angle);
    const top = angle === 0 ? f - fontHeight : f - fontHeight * Math.cos(angle);
    if (Number.isFinite(previousTop) && Math.abs(top - previousTop) > fontHeight * 0.6) line += 1;
    previousTop = top;
    const width = item.width * viewportScale;
    const total = item.str.length || 1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const run of runs) {
      const x0 = (run.offset / total) * width;
      const x1 = x0 + Math.max((run.length / total) * width, 1);
      const xs = [left + x0 * cos, left + x1 * cos, left + x1 * cos - fontHeight * sin, left + x0 * cos - fontHeight * sin];
      const ys = [top + x0 * sin, top + x1 * sin, top + x1 * sin + fontHeight * cos, top + x0 * sin + fontHeight * cos];
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const rect = normalizeSourceRect({
        x: minX / viewport.width,
        y: minY / viewport.height,
        width: (Math.max(...xs) - minX) / viewport.width,
        height: (Math.max(...ys) - minY) / viewport.height,
      });
      if (rect) words.push({ text: run.text, rect, line });
    }
    if (item.hasEOL) { line += 1; previousTop = Number.NaN; }
  }
  return { width: viewport.width, height: viewport.height, words, method: "pdf" };
}

// Clicks land on nearest word within a small page-relative radius, so the gaps
// between words or next to punctuation still resolve predictably.
export function wordAtPoint(words: SourceWord[], x: number, y: number, tolerance = 0.012): SourceWord | undefined {
  let best: SourceWord | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const { rect } = word;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      const area = rect.width * rect.height;
      if (area < bestArea) { best = word; bestArea = area; }
    }
  }
  if (best) return best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const { rect } = word;
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
    const distance = Math.hypot(dx, dy);
    if (distance <= tolerance && distance < bestDistance) { best = word; bestDistance = distance; }
  }
  return best;
}

// PDF and OCR tokens often carry trailing punctuation. Shrink the box to the
// letter/number core without changing the hit area used to find the word.
export function trimWordEdge(word: SourceWord): SourceWord {
  const text = word.text;
  const isCore = (character: string) => /[\p{L}\p{N}]/u.test(character);
  const start = Array.from(text).findIndex(isCore);
  if (start < 0) return word;
  const characters = Array.from(text);
  let end = characters.length;
  while (end > start && !isCore(characters[end - 1])) end -= 1;
  if (start === 0 && end === characters.length) return word;
  const total = characters.length;
  const rect = normalizeSourceRect({
    x: word.rect.x + (start / total) * word.rect.width,
    y: word.rect.y,
    width: ((end - start) / total) * word.rect.width,
    height: word.rect.height,
  });
  return rect ? { ...word, rect } : word;
}

export function wordContext(words: SourceWord[], word: SourceWord, radius = 0): string {
  const lines = words.filter((candidate) => Math.abs(candidate.line - word.line) <= radius)
    .sort((a, b) => a.line - b.line || a.rect.x - b.rect.x);
  return lines.map((candidate) => candidate.text).join(" ");
}

// Scanned pages have no PDF text and may lack OCR. Their translation still
// carries per-sentence source rectangles, so split those sentences into word
// boxes proportionally to each grounded line fragment.
export function layoutFromTranslationBlocks(blocks: LayoutBlock[]): SourcePageLayout | null {
  const words: SourceWord[] = [];
  blocks.forEach((block, blockIndex) => {
    for (const sentence of block.sentences ?? []) {
      const source = sentence.sourceText;
      const rects = sentence.sourceRects
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const tokens = source ? wordRuns(source) : [];
      if (!rects.length || !tokens.length) continue;
      const totalWidth = rects.reduce((sum, rect) => sum + rect.width, 0);
      const lines: Array<{ start: number; end: number; rect: (typeof rects)[number] }> = [];
      let charStart = 0;
      let widthBefore = 0;
      rects.forEach((rect, index) => {
        widthBefore += rect.width;
        const charEnd = index === rects.length - 1 ? source.length : Math.round(source.length * widthBefore / totalWidth);
        lines.push({ start: charStart, end: charEnd, rect });
        charStart = charEnd;
      });
      for (const token of tokens) {
        const tokenEnd = token.offset + token.length;
        let bestOverlap = 0;
        let bestLine = lines[0];
        for (const line of lines) {
          const overlap = Math.min(line.end, tokenEnd) - Math.max(line.start, token.offset);
          if (overlap > bestOverlap) { bestOverlap = overlap; bestLine = line; }
        }
        if (!bestOverlap) continue;
        const span = Math.max(1, bestLine.end - bestLine.start);
        const start = Math.max(token.offset, bestLine.start) - bestLine.start;
        const end = Math.min(tokenEnd, bestLine.end) - bestLine.start;
        const rect = normalizeSourceRect({
          x: bestLine.rect.x + (start / span) * bestLine.rect.width,
          y: bestLine.rect.y,
          width: Math.max(end - start, 1) / span * bestLine.rect.width,
          height: bestLine.rect.height,
        });
        if (rect) words.push({ text: token.text, rect, line: 0, block: blockIndex });
      }
    }
  });
  if (!words.length) return null;
  const rows: Array<{ center: number; height: number; count: number }> = [];
  for (const word of [...words].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    const center = word.rect.y + word.rect.height / 2;
    let row = rows.find((candidate) => Math.abs(candidate.center - center) <= Math.max(candidate.height, word.rect.height) * 0.5);
    if (!row) {
      row = { center, height: word.rect.height, count: 0 };
      rows.push(row);
    }
    word.line = rows.indexOf(row);
    row.center = (row.center * row.count + center) / (row.count + 1);
    row.height = Math.max(row.height, word.rect.height);
    row.count += 1;
  }
  words.sort((a, b) => a.line - b.line || a.rect.x - b.rect.x);
  return { width: 1, height: 1, words, method: "sentence" };
}

const wordSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "word" })
  : null;

function wordRuns(text: string): Array<{ text: string; offset: number; length: number }> {
  if (!text) return [];
  if (wordSegmenter) {
    const runs: Array<{ text: string; offset: number; length: number }> = [];
    for (const part of wordSegmenter.segment(text)) {
      if (!/[\p{L}\p{N}]/u.test(part.segment)) continue;
      runs.push({ text: part.segment, offset: part.index, length: part.segment.length });
    }
    return runs;
  }
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    text: match[0], offset: match.index ?? 0, length: match[0].length,
  }));
}

function multiply(left: number[], right: number[]): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}
