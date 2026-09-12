import type { LayoutBlock, SourceRect, TranslationSentence } from "./translation-layout.ts";
import type { SourcePageLayout, SourceWord } from "./source-alignment.ts";

const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function matchCell(sentence: TranslationSentence, words: SourceWord[]): TranslationSentence | undefined {
  let text = "";
  const ordered = [...words].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const spans = ordered.map((word) => { const start = text.length; text += normalized(word.text); return { word, start, end: text.length }; });
  const needle = normalized(sentence.sourceText);
  if (!needle) return;
  const starts = new Set(spans.map((span) => span.start)), ends = new Set(spans.map((span) => span.end));
  const matches: number[] = [];
  for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + 1)) {
    if (starts.has(start) && ends.has(start + needle.length)) matches.push(start);
    if (matches.length > 1) return;
  }
  if (!matches.length) return;
  const start = matches[0];
  const lines = new Map<number, SourceRect>();
  for (const { word } of spans.filter((s) => s.end > start && s.start < start + needle.length)) {
    const rect = word.rect, prev = lines.get(word.line);
    const x = Math.min(prev?.x ?? rect.x, rect.x), y = Math.min(prev?.y ?? rect.y, rect.y);
    lines.set(word.line, { x, y, width: Math.max(prev ? prev.x + prev.width : 0, rect.x + rect.width) - x,
      height: Math.max(prev ? prev.y + prev.height : 0, rect.y + rect.height) - y });
  }
  return { ...sentence, sourceRects: Array.from(lines.values()) };
}

// Upgrade cached prose only when every cell matches its own source column.
// Never split a translated sentence or infer missing cell contents.
export function recoverSourceTables(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  if (layout.method !== "pdf") return blocks;
  const result = [...blocks];
  for (let index = 0; index < blocks.length; index++) {
    const header = blocks[index], rect = header.sourceRect, cells = header.sentences;
    if (!["paragraph", "table_header"].includes(header.kind) || !rect || !cells || cells.length < 2 || cells.length > 8
      || cells.some((s) => s.sourceText.length > 80 || s.sourceText.trim().split(/\s+/).length > 8)) continue;
    const headerWords = layout.words.filter(({ rect: r }) => r.y >= rect.y - .012 && r.y < rect.y + rect.height + .012
      && r.x >= rect.x - .01 && r.x < rect.x + rect.width + .04);
    const alignedHeader = cells.map((cell) => matchCell(cell, headerWords));
    if (alignedHeader.some((cell) => !cell || cell.sourceRects.length !== 1)) continue;
    const headings = alignedHeader as TranslationSentence[];
    const boxes = headings.map((cell) => cell.sourceRects[0]);
    if (boxes.some((r, i) => i && (r.x - boxes[i - 1].x - boxes[i - 1].width < .025 || Math.abs(r.y - boxes[0].y) > .01))) continue;
    const rows: LayoutBlock[] = [];
    let ambiguous = false;
    for (let next = index + 1; next < blocks.length; next++) {
      const row = blocks[next], region = row.sourceRect;
      if (!["paragraph", "table_row"].includes(row.kind) || !region || row.sentences?.length !== cells.length
        || region.y <= rect.y || Math.abs(region.x - rect.x) > .04 || Math.abs(region.width - rect.width) > .08) break;
      const following = blocks[next + 1]?.sourceRect;
      const bottom = Math.min(region.y + region.height + .04, following && following.y > region.y ? following.y - .005 : 1);
      const aligned = row.sentences.map((cell, column) => matchCell(cell, layout.words.filter(({ rect: r }) => {
        const center = r.x + r.width / 2;
        return r.y >= region.y - .015 && r.y < bottom && center >= boxes[column].x - .012
          && center < (boxes[column + 1]?.x ?? rect.x + rect.width + .04) - (column + 1 < boxes.length ? .006 : 0);
      })));
      if (aligned.some((cell) => !cell)) { ambiguous = true; break; }
      rows.push({ ...row, kind: "table_row", sentences: aligned as TranslationSentence[] });
    }
    // Two matching data rows distinguish a table from an isolated line of labels.
    if (rows.length < 2 || ambiguous) continue;
    result[index] = { ...header, kind: "table_header", sentences: headings };
    rows.forEach((row, offset) => { result[index + offset + 1] = row; });
    index += rows.length;
  }
  return result;
}


// Explicit table structure does not need legacy table detection. Use text anchors
// to recover columns even when the model estimated the row positions incorrectly.
export function alignTableCells(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  let columns: number[] | undefined;
  let bottom = 0;
  return blocks.map((row) => {
    if (row.kind !== "table_header" && row.kind !== "table_row") { columns = undefined; bottom = 0; return row; }
    const cells = row.sentences;
    if (!cells?.length || cells.length > 32) return row;
    if (row.kind === "table_header") { columns = undefined; bottom = 0; }
    if (!columns || columns.length !== cells.length) {
      const anchors = cells.map((cell) => {
        const whole = matchCell(cell, layout.words.filter((word) => word.rect.y >= bottom));
        if (whole) return whole.sourceRects[0];
        const words = cell.sourceText.trim().split(/\s+/);
        for (let length = Math.min(3, words.length - 1); length > 0; length--) {
          const prefix = matchCell({ ...cell, sourceText: words.slice(0, length).join(" ") }, layout.words.filter((word) => word.rect.y >= bottom));
          if (prefix) return prefix.sourceRects[0];
        }
      });
      if (anchors.every((anchor) => anchor) && anchors.every((anchor, i) => !i ||
        (anchor!.x > anchors[i - 1]!.x + .02 && Math.abs(anchor!.y - anchors[0]!.y) < .035))) {
        columns = anchors.map((anchor) => anchor!.x);
        bottom = Math.max(bottom, Math.min(...anchors.map((anchor) => anchor!.y)) - .002);
      }
    }
    if (!columns || columns.length !== cells.length) {
      return { ...row, sentences: cells.map((cell) => ({ ...cell, sourceRects: [] })) };
    }
    const starts = columns;
    const columnWords = starts.map((left, column) => layout.words.filter(({ rect }) => {
      const x = rect.x + rect.width / 2;
      return rect.y >= bottom && x >= left - .012 && x < (starts[column + 1] ?? 1) - (column + 1 < starts.length ? .006 : 0);
    }));
    let matches = cells.map((cell, column) => matchCell(cell, columnWords[column]));
    // Repeated short values are disambiguated by the other cells in the same row.
    const located = matches.flatMap((cell) => cell?.sourceRects ?? []);
    if (located.length) {
      const top = Math.min(...located.map((rect) => rect.y)) - .002;
      const end = Math.max(...located.map((rect) => rect.y + rect.height)) + .002;
      matches = matches.map((match, column) => match ?? matchCell(cells[column], columnWords[column].filter((word) => word.rect.y >= top && word.rect.y < end)));
      bottom = end;
    }
    return { ...row, sentences: cells.map((cell, column) => matches[column] ?? { ...cell, sourceRects: [] }) };
  });
}
