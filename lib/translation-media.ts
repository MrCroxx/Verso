import type { LayoutBlock, SourceRect } from "./translation-layout.ts";

export type TranslationDisplayBlock = {
  block: LayoutBlock;
  index: number;
  caption?: LayoutBlock;
  tableRows?: LayoutBlock[];
  captionRect?: SourceRect;
  captionPosition?: "top" | "bottom";
  surroundingTextRects?: SourceRect[];
  spaceBefore: LayoutBlock["spaceBefore"];
};

export function imagePlacement(block: LayoutBlock, hasCaption = false): "center" | "source" {
  if (block.imageRole) return block.imageRole === "decoration" ? "source" : "center";
  if (hasCaption) return "center";
  const rect = block.sourceRect;
  // Older caches do not identify logos; only infer small marks in page margins.
  const marginMark = rect && rect.width <= 0.4 && rect.height <= 0.08
    && (rect.y + rect.height <= 0.12 || rect.y >= 0.88);
  return marginMark ? "source" : "center";
}

function captionPosition(block: LayoutBlock): "top" | "bottom" | undefined {
  const labels = [block.sentences?.map((sentence) => sentence.sourceText).join(""), block.text];
  for (const label of labels) {
    if (!label) continue;
    if (/^\s*(?:table\b|tab\.|表)/iu.test(label)) return "top";
    if (/^\s*(?:figure\b|fig\.|图|圖)/iu.test(label)) return "bottom";
  }
}

export function captionSourceRect(block: LayoutBlock): SourceRect | undefined {
  const rects = block.sentences?.flatMap((sentence) => sentence.sourceRects);
  if (!rects?.length) return block.sourceRect;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x, y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

// Group at display time so cached translations retain their text and source mappings.
export function groupTranslationMedia(blocks: LayoutBlock[]): TranslationDisplayBlock[] {
  // Only locally grounded, separately translated text can constrain artwork.
  // Raw OCR words may be labels inside a diagram and must remain in the image.
  const surroundingTextRects = blocks.flatMap((block) => {
    if (!["paragraph", "heading", "caption", "list_item", "page_number"].includes(block.kind)
      || !block.sentences?.some((sentence) => sentence.sourceRects.length)) return [];
    const rect = captionSourceRect(block);
    return rect ? [rect] : [];
  });
  const candidates: { image: number; caption: number; position: "top" | "bottom"; score: number }[] = [];
  blocks.forEach((caption, index) => {
    if (caption.kind !== "caption" || !caption.text.trim()) return;
    const position = captionPosition(caption);
    const rect = captionSourceRect(caption);
    for (const direction of [-1, 1]) {
      let neighbor = index + direction;
      while (blocks[neighbor]?.kind === "spacer") neighbor += direction;
      const image = blocks[neighbor];
      if (image?.kind !== "image" || !image.sourceRect || image.imageRole === "decoration") continue;
      const naturalPosition = direction === 1 ? "top" : "bottom";
      let score = position === naturalPosition ? 1 : 2;
      if (rect) {
        const source = image.sourceRect;
        const overlap = Math.min(rect.x + rect.width, source.x + source.width) - Math.max(rect.x, source.x);
        // Do not attach a caption from the other column of a scanned page.
        if (overlap <= 0) continue;
        score = Math.max(0, rect.y - source.y - source.height, source.y - rect.y - rect.height);
      }
      candidates.push({ image: neighbor, caption: index, position: position ?? naturalPosition, score });
    }
  });

  const grouped = new Map<number, TranslationDisplayBlock>();
  const consumed = new Set<number>();
  for (const candidate of candidates.sort((a, b) => a.score - b.score)) {
    if (consumed.has(candidate.image) || consumed.has(candidate.caption)) continue;
    const first = Math.min(candidate.image, candidate.caption);
    const last = Math.max(candidate.image, candidate.caption);
    grouped.set(first, {
      block: blocks[candidate.image], index: candidate.image,
      caption: blocks[candidate.caption], captionPosition: candidate.position,
      captionRect: captionSourceRect(blocks[candidate.caption]),
      surroundingTextRects,
      spaceBefore: blocks[first].spaceBefore,
    });
    for (let index = first; index <= last; index++) consumed.add(index);
  }
  const media = blocks.flatMap<TranslationDisplayBlock>((block, index) => {
    const group = grouped.get(index);
    if (group) return [group];
    return consumed.has(index) ? [] : [{ block, index, spaceBefore: block.spaceBefore,
      ...(block.kind === "image" && { surroundingTextRects }) }];
  });
  const display: TranslationDisplayBlock[] = [];
  for (const item of media) {
    if (item.block.kind === "table_header" || item.block.kind === "table_row") {
      const previous = display.at(-1);
      if (item.block.kind === "table_row" && previous?.tableRows) previous.tableRows.push(item.block);
      else display.push({ ...item, tableRows: [item.block] });
    } else display.push(item);
  }
  return display;
}
