import { normalizeLayoutBlock, type LayoutBlock } from "./translation-layout.ts";

export type Continuation = "none" | "from_previous" | "to_next" | "both";

export type RecognitionBlock = LayoutBlock & {
  id: string;
  sourceText: string;
  continuation: Continuation;
  bounds: { x: number; y: number; width: number; height: number };
};

export type PageRecognition = {
  page: number;
  blocks: RecognitionBlock[];
  isBlank: boolean;
  sourceSummary: string;
  model: string;
  cachedAt: number;
};

const continuations = new Set<Continuation>(["none", "from_previous", "to_next", "both"]);

function coordinate(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function normalizePageRecognition(
  value: unknown,
  requestedPage: number,
  model = "",
): PageRecognition {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  const blocks = rawBlocks.map((rawBlock, index): RecognitionBlock => {
    const block = rawBlock && typeof rawBlock === "object" ? rawBlock as Record<string, unknown> : {};
    const layout = normalizeLayoutBlock(block);
    const bounds = block.bounds && typeof block.bounds === "object"
      ? block.bounds as Record<string, unknown>
      : {};
    const continuation = continuations.has(block.continuation as Continuation)
      ? block.continuation as Continuation
      : "none";
    return {
      id: `p${requestedPage}-b${index}`,
      kind: layout.kind,
      sourceText: typeof block.text === "string" ? block.text : "",
      text: typeof block.text === "string" ? block.text : "",
      marker: layout.marker,
      trailing: layout.trailing,
      align: layout.align,
      indent: layout.indent,
      spaceBefore: layout.spaceBefore,
      size: layout.size,
      continuation,
      bounds: {
        x: coordinate(bounds.x),
        y: coordinate(bounds.y),
        width: coordinate(bounds.width),
        height: coordinate(bounds.height),
      },
    };
  });
  return {
    page: requestedPage,
    blocks,
    isBlank: !blocks.some((block) => block.kind !== "spacer" && block.sourceText.trim()),
    sourceSummary: typeof input.sourceSummary === "string" ? input.sourceSummary : "",
    model,
    cachedAt: Date.now(),
  };
}

function continuesFromPrevious(block: RecognitionBlock) {
  return block.continuation === "from_previous" || block.continuation === "both";
}

function continuesToNext(block: RecognitionBlock) {
  return block.continuation === "to_next" || block.continuation === "both";
}

function firstFlowBlock(page: PageRecognition) {
  return page.blocks.find((block) => (
    (block.kind === "paragraph" || block.kind === "caption") && block.sourceText.trim()
  ));
}

function lastFlowBlock(page: PageRecognition) {
  return page.blocks.findLast((block) => (
    (block.kind === "paragraph" || block.kind === "caption") && block.sourceText.trim()
  ));
}

export type BoundaryState = "none" | "waiting_for_neighbor" | "queued" | "translating" | "translated";

export type TranslationPlan = {
  groups: number[][];
  boundaryStates: Record<string, BoundaryState>;
};

export function recognitionBlockKey(page: number, blockId: string) {
  return `${page}:${blockId}`;
}

export function buildTranslationPlan(
  recognitions: PageRecognition[],
  activePages: number[],
  totalPages: number,
): TranslationPlan {
  const pages = new Map(recognitions.map((recognition) => [recognition.page, recognition]));
  const active = new Set(activePages);
  const parent = new Map(activePages.map((page) => [page, page]));
  const boundaryStates: Record<string, BoundaryState> = {};

  const find = (page: number): number => {
    const current = parent.get(page) ?? page;
    if (current === page) return page;
    const root = find(current);
    parent.set(page, root);
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const mark = (page: number, blocks: RecognitionBlock[], state: BoundaryState) => {
    for (const block of blocks) {
      const key = recognitionBlockKey(page, block.id);
      if (boundaryStates[key] === "waiting_for_neighbor" && state !== "waiting_for_neighbor") continue;
      boundaryStates[key] = state;
    }
  };

  for (const page of activePages) {
    const recognition = pages.get(page);
    if (!recognition) continue;
    const incoming = recognition.blocks.filter(continuesFromPrevious);
    const outgoing = recognition.blocks.filter(continuesToNext);
    if (incoming.length && page > 1 && (!active.has(page - 1) || !pages.has(page - 1))) {
      mark(page, incoming, "waiting_for_neighbor");
    }
    if (outgoing.length && page < totalPages && (!active.has(page + 1) || !pages.has(page + 1))) {
      mark(page, outgoing, "waiting_for_neighbor");
    }
  }

  for (let leftPage = 1; leftPage < totalPages; leftPage += 1) {
    const rightPage = leftPage + 1;
    if (!active.has(leftPage) || !active.has(rightPage)) continue;
    const left = pages.get(leftPage);
    const right = pages.get(rightPage);
    if (!left || !right) continue;
    let leftBlocks = left.blocks.filter(continuesToNext);
    let rightBlocks = right.blocks.filter(continuesFromPrevious);
    if (!leftBlocks.length && !rightBlocks.length) continue;
    if (!leftBlocks.length) {
      const fallback = lastFlowBlock(left);
      if (fallback) leftBlocks = [fallback];
    }
    if (!rightBlocks.length) {
      const fallback = firstFlowBlock(right);
      if (fallback) rightBlocks = [fallback];
    }
    union(leftPage, rightPage);
    mark(leftPage, leftBlocks, "queued");
    mark(rightPage, rightBlocks, "queued");
  }

  const waitingRoots = new Set(
    Object.entries(boundaryStates)
      .filter(([, state]) => state === "waiting_for_neighbor")
      .map(([key]) => find(Number(key.split(":", 1)[0]))),
  );
  for (const [key, state] of Object.entries(boundaryStates)) {
    const page = Number(key.split(":", 1)[0]);
    if (state !== "none" && waitingRoots.has(find(page))) {
      boundaryStates[key] = "waiting_for_neighbor";
    }
  }

  const grouped = new Map<number, number[]>();
  for (const page of activePages) {
    const root = find(page);
    const group = grouped.get(root) || [];
    group.push(page);
    grouped.set(root, group);
  }
  return {
    groups: [...grouped.values()].map((group) => group.sort((left, right) => left - right)),
    boundaryStates,
  };
}

export function translationGroupForPage(plan: TranslationPlan, page: number) {
  return plan.groups.find((group) => group.includes(page)) || [page];
}
