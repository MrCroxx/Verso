import { normalizeLayoutBlocks, type LayoutBlock } from "./translation-layout.ts";

export type PageNumbering = "arabic" | "roman" | "other";

export type PageReference = {
  label: string;
  value: number | null;
  numbering: PageNumbering;
};

export type TocEntry = PageReference & {
  sourcePage: number;
  ordinal: number;
  title: string;
  level: number;
};

export type PageAnchor = PageReference & {
  pdfPage: number;
};

export type NavigationObservation = {
  pdfPage: number;
  isTableOfContents: boolean;
  tocEntries: TocEntry[];
  anchor: PageAnchor | null;
};

export type DocumentNavigation = {
  observations: NavigationObservation[];
  manualOffset: number | null;
};

const tocHeading = /(?:\bcontents?\b|table\s+of\s+contents|\billustrations?\b|目录|目次|索引|插图|sommaire|índice|indice|inhalt)/iu;
const numberingKinds = ["arabic", "roman", "other"] as const;

function romanValue(label: string) {
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  let previous = 0;
  for (const character of label.toLowerCase().split("").reverse()) {
    const current = values[character];
    if (!current) return null;
    total += current < previous ? -current : current;
    previous = Math.max(previous, current);
  }
  return total > 0 ? total : null;
}

export function parsePageReference(value: unknown): PageReference | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label) return null;
  if (/^\d{1,6}$/.test(label)) {
    return { label, value: Number(label), numbering: "arabic" };
  }
  if (/^[ivxlcdm]+$/i.test(label)) {
    return { label, value: romanValue(label), numbering: "roman" };
  }
  return { label, value: null, numbering: "other" };
}

function entryTitle(block: LayoutBlock) {
  return [block.marker.trim(), block.text.trim()].filter(Boolean).join(" ");
}

export function extractNavigationObservation(pdfPage: number, value: unknown): NavigationObservation {
  const blocks = normalizeLayoutBlocks(value);
  const candidates = blocks.flatMap((block, ordinal) => {
    if (block.kind !== "list_item" || !block.text.trim()) return [];
    const reference = parsePageReference(block.trailing);
    if (!reference?.value) return [];
    return [{
      ...reference,
      sourcePage: pdfPage,
      ordinal,
      title: entryTitle(block),
      level: Math.min(3, Math.max(0, block.indent)),
    } satisfies TocEntry];
  });
  const hasHeading = blocks.some((block) => (block.kind === "heading" || block.kind === "paragraph") && tocHeading.test(block.text));
  const isTableOfContents = candidates.length >= 2 && (hasHeading || candidates.length >= 4);
  const printedPage = blocks
    .filter((block) => block.kind === "page_number")
    .map((block) => parsePageReference(block.text))
    .find((reference) => reference?.value != null) || null;

  return {
    pdfPage,
    isTableOfContents,
    tocEntries: isTableOfContents ? candidates : [],
    anchor: printedPage ? { ...printedPage, pdfPage } : null,
  };
}

function numbering(value: unknown): PageNumbering {
  return typeof value === "string" && numberingKinds.includes(value as PageNumbering)
    ? value as PageNumbering
    : "other";
}

function nullablePageValue(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function normalizeNavigationObservation(value: unknown): NavigationObservation {
  const observation = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pdfPage = Number.isSafeInteger(observation.pdfPage) ? Number(observation.pdfPage) : 0;
  const rawEntries = Array.isArray(observation.tocEntries) ? observation.tocEntries.slice(0, 200) : [];
  const tocEntries = rawEntries.flatMap((item, ordinal) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 500) : "";
    const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 40) : "";
    if (!title || !label) return [];
    return [{
      sourcePage: Number.isSafeInteger(entry.sourcePage) ? Number(entry.sourcePage) : pdfPage,
      ordinal: Number.isSafeInteger(entry.ordinal) ? Number(entry.ordinal) : ordinal,
      title,
      label,
      value: nullablePageValue(entry.value),
      numbering: numbering(entry.numbering),
      level: Number.isSafeInteger(entry.level) ? Math.min(3, Math.max(0, Number(entry.level))) : 0,
    } satisfies TocEntry];
  });
  const rawAnchor = observation.anchor && typeof observation.anchor === "object"
    ? observation.anchor as Record<string, unknown>
    : null;
  const anchorLabel = rawAnchor && typeof rawAnchor.label === "string" ? rawAnchor.label.trim().slice(0, 40) : "";
  const anchor = rawAnchor && anchorLabel
    ? {
        pdfPage,
        label: anchorLabel,
        value: nullablePageValue(rawAnchor.value),
        numbering: numbering(rawAnchor.numbering),
      } satisfies PageAnchor
    : null;

  return {
    pdfPage,
    isTableOfContents: Boolean(observation.isTableOfContents) && tocEntries.length > 0,
    tocEntries,
    anchor,
  };
}

export function mergeNavigationObservation(
  observations: NavigationObservation[],
  observation: NavigationObservation,
) {
  return [...observations.filter((item) => item.pdfPage !== observation.pdfPage), observation]
    .sort((left, right) => left.pdfPage - right.pdfPage);
}

export function collectTocEntries(observations: NavigationObservation[]) {
  const seen = new Set<string>();
  return observations.flatMap((observation) => observation.tocEntries)
    .sort((left, right) => left.sourcePage - right.sourcePage || left.ordinal - right.ordinal)
    .filter((entry) => {
      const key = `${entry.title.toLocaleLowerCase()}::${entry.numbering}::${entry.value ?? entry.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function collectPageAnchors(observations: NavigationObservation[]) {
  return observations.flatMap((observation) => observation.anchor ? [observation.anchor] : []);
}

export function calculatePageOffset(anchors: PageAnchor[], targetNumbering: PageNumbering = "arabic") {
  const offsets = anchors
    .filter((anchor) => anchor.numbering === targetNumbering && anchor.value != null)
    .map((anchor) => anchor.pdfPage - (anchor.value as number))
    .sort((left, right) => left - right);
  if (!offsets.length) return null;

  const median = offsets[Math.floor(offsets.length / 2)];
  const counts = new Map<number, number>();
  for (const offset of offsets) counts.set(offset, (counts.get(offset) || 0) + 1);
  return [...counts.entries()]
    .sort(([leftOffset, leftCount], [rightOffset, rightCount]) => (
      rightCount - leftCount
      || Math.abs(leftOffset - median) - Math.abs(rightOffset - median)
      || leftOffset - rightOffset
    ))[0][0];
}

export function resolveTocEntryPage(
  entry: TocEntry,
  anchors: PageAnchor[],
  manualOffset: number | null,
  totalPages: number,
) {
  if (entry.value == null || totalPages < 1) return null;
  const automaticOffset = calculatePageOffset(anchors, entry.numbering);
  const offset = manualOffset ?? automaticOffset ?? 0;
  return {
    page: Math.min(totalPages, Math.max(1, entry.value + offset)),
    offset,
    calibrated: manualOffset != null || automaticOffset != null,
  };
}
