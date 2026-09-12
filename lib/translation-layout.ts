export type SourceRect = { x: number; y: number; width: number; height: number };

export type TranslationSentence = {
  text: string;
  sourceText: string;
  sourceRects: SourceRect[];
};

export type LayoutBlock = {
  kind: "heading" | "paragraph" | "list_item" | "caption" | "spacer" | "page_number" | "image" | "equation" | "code" | "table_header" | "table_row";
  sourceRect?: SourceRect;
  imageRole?: "body" | "decoration";
  fontSize?: number;
  sentences?: TranslationSentence[];
  text: string;
  marker: string;
  trailing: string;
  align: "left" | "center" | "right" | "justify";
  indent: number;
  spaceBefore: "none" | "xs" | "sm" | "md" | "lg" | "xl";
  size: "xs" | "sm" | "md" | "lg" | "xl";
};

const blockKinds = ["heading", "paragraph", "list_item", "caption", "spacer", "page_number", "image", "equation", "code", "table_header", "table_row"] as const;
const blockAlignments = ["left", "center", "right", "justify"] as const;
const blockSpaces = ["none", "xs", "sm", "md", "lg", "xl"] as const;
const blockSizes = ["xs", "sm", "md", "lg", "xl"] as const;

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

// Coordinates are fractions of the displayed page, with the origin at its top left.
export function normalizeSourceRect(value: unknown): SourceRect | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as SourceRect;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || width > 1 || height > 1) return undefined;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

function normalizeSentences(value: unknown, text: string, keepEmpty = false): TranslationSentence[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const sentences = value.map((item) => {
    const sentence = item && typeof item === "object" ? item : {};
    return {
      text: typeof sentence.text === "string" ? sentence.text : "",
      sourceText: typeof sentence.sourceText === "string" ? sentence.sourceText : "",
      sourceRects: Array.isArray(sentence.sourceRects)
        ? sentence.sourceRects.map(normalizeSourceRect).filter((rect: SourceRect | undefined): rect is SourceRect => Boolean(rect))
        : [],
    };
  }).filter((sentence) => keepEmpty || sentence.text);
  // Never substitute an incomplete or reordered sentence mapping for the translation.
  return sentences.length && sentences.map((sentence) => sentence.text).join("") === text ? sentences : undefined;
}

export function hasLayoutContent(blocks: LayoutBlock[]) {
  return blocks.some((block) => block.kind === "image" ? Boolean(block.sourceRect) : block.kind !== "spacer" && Boolean(block.text.trim()));
}

export function normalizeLayoutBlock(value: unknown): LayoutBlock {
  const block = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawKind = block.kind ?? block.type;
  const indent = typeof block.indent === "number" && Number.isFinite(block.indent) ? Math.round(block.indent) : 0;
  const text = typeof block.text === "string" ? block.text : "";
  const sourceRect = normalizeSourceRect(block.sourceRect);
  const imageRole = block.imageRole === "body" || block.imageRole === "decoration" ? block.imageRole : undefined;
  const sentences = normalizeSentences(block.sentences, text, rawKind === "table_header" || rawKind === "table_row");
  const fontSize = typeof block.fontSize === "number" && Number.isFinite(block.fontSize) && block.fontSize > 0 && block.fontSize <= 0.25
    ? block.fontSize : undefined;
  return {
    ...(sourceRect && { sourceRect }),
    ...(imageRole && { imageRole }),
    ...(fontSize && { fontSize }),
    ...(sentences && { sentences }),
    kind: enumValue(rawKind, blockKinds, "paragraph"),
    text: typeof block.text === "string" ? block.text : "",
    marker: typeof block.marker === "string" ? block.marker : "",
    trailing: typeof block.trailing === "string" ? block.trailing : "",
    align: enumValue(block.align, blockAlignments, "left"),
    indent: Math.min(3, Math.max(0, indent)),
    spaceBefore: enumValue(block.spaceBefore, blockSpaces, "none"),
    size: enumValue(block.size, blockSizes, "md"),
  };
}

export function normalizeLayoutBlocks(value: unknown): LayoutBlock[] {
  return Array.isArray(value) ? value.map(normalizeLayoutBlock) : [];
}

export function normalizeTranslationPayload(value: unknown) {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const blocks = normalizeLayoutBlocks(payload.blocks);
  const inferredBlank = !hasLayoutContent(blocks);
  return {
    ...payload,
    blocks,
    isBlank: blocks.length ? inferredBlank : typeof payload.isBlank === "boolean" ? payload.isBlank : inferredBlank,
  };
}

const continuationKinds = new Set<LayoutBlock["kind"]>(["paragraph", "caption"]);
const terminalPunctuation = /[.!?。！？][”’"')\]}】》」』]*$/u;
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const letterOrNumber = /[\p{L}\p{N}]/u;

function meaningfulOverlap(previousText: string, currentText: string, overlap: string) {
  const characters = Array.from(overlap).filter((character) => letterOrNumber.test(character));
  if (cjkCharacter.test(overlap)) return characters.length >= 2;
  if (characters.length < 8) return false;

  const previousBoundary = previousText.at(-(overlap.length + 1)) || "";
  const currentBoundary = currentText.at(overlap.length) || "";
  const startsInsideWord = letterOrNumber.test(previousBoundary) && letterOrNumber.test(overlap[0] || "");
  const endsInsideWord = letterOrNumber.test(overlap.at(-1) || "") && letterOrNumber.test(currentBoundary);
  return !startsInsideWord && !endsInsideWord;
}

export function deduplicatePageBoundary(previousValue: unknown, currentValue: unknown) {
  const previousBlocks = normalizeLayoutBlocks(previousValue);
  const currentBlocks = normalizeLayoutBlocks(currentValue);
  const previousIndex = previousBlocks.findLastIndex((block) => continuationKinds.has(block.kind) && block.text.trim());
  const currentIndex = currentBlocks.findIndex((block) => continuationKinds.has(block.kind) && block.text.trim());
  if (previousIndex < 0 || currentIndex < 0) return { blocks: currentBlocks, removedText: "" };

  const previousBlock = previousBlocks[previousIndex];
  const currentBlock = currentBlocks[currentIndex];
  if (previousBlock.kind !== currentBlock.kind) return { blocks: currentBlocks, removedText: "" };

  const previousText = previousBlock.text.trimEnd();
  const currentText = currentBlock.text.trimStart();
  if (!previousText || !currentText || terminalPunctuation.test(previousText)) {
    return { blocks: currentBlocks, removedText: "" };
  }

  const maximumLength = Math.min(120, previousText.length, currentText.length);
  let removedText = "";
  for (let length = maximumLength; length > 0; length -= 1) {
    const candidate = currentText.slice(0, length);
    if (previousText.endsWith(candidate) && meaningfulOverlap(previousText, currentText, candidate)) {
      removedText = candidate;
      break;
    }
  }
  if (!removedText) return { blocks: currentBlocks, removedText: "" };

  const text = currentText.slice(removedText.length).trimStart();
  let remaining = currentBlock.text.length - text.length;
  const sentences = currentBlock.sentences?.flatMap((sentence) => {
    if (remaining >= sentence.text.length) {
      remaining -= sentence.text.length;
      return [];
    }
    const trimmed = { ...sentence, text: sentence.text.slice(remaining) };
    remaining = 0;
    return [trimmed];
  });
  const blocks = currentBlocks.map((block, index) => index === currentIndex
    ? { ...block, text, ...(sentences && { sentences }) }
    : block);
  if (!blocks[currentIndex].text && !blocks[currentIndex].marker && !blocks[currentIndex].trailing) {
    blocks.splice(currentIndex, 1);
  }
  return { blocks, removedText };
}
