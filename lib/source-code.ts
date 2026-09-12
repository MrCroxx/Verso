import type { LayoutBlock, SourceRect } from "./translation-layout.ts";
import type { SourcePageLayout, SourceWord } from "./source-alignment.ts";

const languages = /^(python|javascript|typescript|java|c\+\+|c#|c|go|rust|ruby|php|swift|kotlin|bash|shell|sql|json|yaml|html|css)$/i;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Recover only labelled, monospaced PDF listings. OCR cannot reliably preserve
// operators or indentation, and diagram labels must not become executable text.
export function recoverSourceCodeBlocks(blocks: LayoutBlock[], layout: SourcePageLayout): LayoutBlock[] {
  if (layout.method !== "pdf") return blocks;
  return blocks.map((block) => {
    if (block.kind !== "image" || !block.sourceRect || block.imageRole === "decoration") return block;
    const rect = block.sourceRect;
    const candidates = layout.words.filter(({ rect: r }) => r.x >= rect.x - .005
      && r.x + r.width <= rect.x + rect.width + .005
      && r.y >= rect.y - .005 && r.y < rect.y + rect.height + .035);
    if (candidates.length < 5 || candidates.length > 2500) return block;
    const height = median(candidates.map((w) => w.rect.height));
    const rows: SourceWord[][] = [];
    for (const word of [...candidates].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
      const row = rows.findLast((r) => Math.abs(r[0].rect.y - word.rect.y) < height * .35);
      if (row) row.push(word); else rows.push([word]);
    }
    rows.forEach((row) => row.sort((a, b) => a.rect.x - b.rect.x));
    const label = rows[0];
    if (label.length !== 1 || !languages.test(label[0].text.trim())) return block;
    const codeRows: SourceWord[][] = [];
    for (const row of rows.slice(1)) {
      const previous = codeRows.at(-1) ?? label;
      if (row[0].rect.y - previous[0].rect.y > height * 3.5) break;
      // Do not consume separately translated prose beyond the estimated crop.
      if (blocks.some((other) => other !== block && other.kind !== "image"
        && other.sentences?.some((sentence) => sentence.sourceRects.some((r) =>
          row.some((w) => w.rect.x + w.rect.width / 2 >= r.x && w.rect.x + w.rect.width / 2 <= r.x + r.width
            && w.rect.y + w.rect.height / 2 >= r.y && w.rect.y + w.rect.height / 2 <= r.y + r.height))))) break;
      codeRows.push(row);
    }
    if (codeRows.length < 2) return block;
    const numbered = codeRows.length >= 3 && codeRows.every((row, i) => row.length > 1
      && /^\d+$/.test(row[0].text.trim())
      && Number(row[0].text.trim()) === Number(codeRows[0][0].text.trim()) + i
      && Math.abs(row[0].rect.x - codeRows[0][0].rect.x) < .008
      && row[1].rect.x - row[0].rect.x - row[0].rect.width > row[0].rect.width);
    const lines = codeRows.map((row) => numbered ? row.slice(1) : row);
    const words = lines.flat();
    const widths = words.filter((w) => /^[\x20-\x7e]+$/.test(w.text.trim()) && w.text.trim().length > 1)
      .map((w) => w.rect.width / w.text.trim().length);
    if (widths.length < 3) return block;
    const cell = median(widths);
    if (!(cell > 0) || widths.filter((width) => Math.abs(width / cell - 1) < .12).length / widths.length < .9) return block;
    const left = Math.min(...words.map((w) => w.rect.x));
    let ambiguous = false;
    const code = lines.map((row) => {
      let line = "";
      for (const word of row) {
        const column = Math.round((word.rect.x - left) / cell);
        if (column < line.length - 1 || column > 500) { ambiguous = true; break; }
        line += " ".repeat(Math.max(0, column - line.length)) + word.text.trim();
      }
      return line;
    }).join("\n");
    if (ambiguous || !/(?:\w+\s*=|\b(?:def|class|function|return|import|const|let|var)\b|[{};])/.test(code)) return block;
    const sourceRect: SourceRect = { x: left, y: Math.min(...words.map((w) => w.rect.y)),
      width: Math.max(...words.map((w) => w.rect.x + w.rect.width)) - left,
      height: Math.max(...words.map((w) => w.rect.y + w.rect.height)) - Math.min(...words.map((w) => w.rect.y)) };
    const sizes = words.flatMap((word) => word.fontSize ? [word.fontSize] : []);
    return { ...block, kind: "code", imageRole: undefined, text: code, marker: label[0].text.trim().toLowerCase(),
      sourceRect, fontSize: sizes.length ? median(sizes) : height * layout.height / layout.width,
      align: "left", indent: 0, trailing: "", sentences: [{ text: code, sourceText: code, sourceRects: [sourceRect] }] };
  });
}
