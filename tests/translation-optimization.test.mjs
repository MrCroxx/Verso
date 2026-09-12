import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTextPage, boundaryText, canCropBoundary, isTextOnlySvg, needsPreviousPageImage,
  restoreCompactBlocks, restoreTextTranslation } from "../lib/translation-source-plan.ts";
import { parsePdfWordLayout } from "../lib/source-alignment.ts";
import { normalizeLayoutBlocks } from "../lib/translation-layout.ts";
import { makeSourcePdf, sourceFixture } from "./fixtures/source-pages.mjs";

const translated = (page) => ({ translations: page.units.flat().map((u, i) => ({ id: u.id, text: `译文${i}。` })) });

test("restores compact prose, equations, images and previous-page block layouts without changing the saved contract", () => {
  const original = normalizeLayoutBlocks([
    { kind: "paragraph", text: "第一句。 第二句。", sentences: [
      { text: "第一句。", sourceText: "First sentence.", sourceRects: [] },
      { text: " 第二句。", sourceText: "Second sentence.", sourceRects: [] }] },
    { kind: "equation", text: String.raw`\hat{x}=\frac{a}{b}`, trailing: "(3)", sentences: [
      { text: String.raw`\hat{x}=\frac{a}{b}`, sourceText: "formula", sourceRects: [] }] },
    { kind: "image", imageRole: "body", sourceRect: { x: .1, y: .2, width: .8, height: .4 }, sentences: [] },
    { kind: "spacer", sentences: [] },
  ]);
  const compact = original.map((block) => { const b = structuredClone(block); delete b.text; return { ...b, sentences: b.sentences || [] }; });
  assert.deepEqual(restoreCompactBlocks(compact), original);
  assert.deepEqual(restoreCompactBlocks(original), original);
  assert.throws(() => restoreCompactBlocks([{ kind: "paragraph", sentences: [] }]), /Empty/);
  assert.throws(() => restoreCompactBlocks(undefined), /no layout/);
});

test("restores every stable source unit with page-local highlights and rejects incomplete or reordered output", () => {
  const source = sourceFixture();
  const page = buildTextPage(source);
  assert.ok(page);
  const result = restoreTextTranslation(translated(page), page, source);
  assert.equal(result.length, page.blocks.length);
  assert.equal(result.flatMap((b) => b.sentences).length, page.units.flat().length);
  assert.ok(result.every((b) => b.text === b.sentences.map((s) => s.text).join("")));
  assert.ok(result.every((b) => b.sentences.every((s) => s.sourceRects.length > 0)));
  assert.deepEqual(result.map((b) => b.sourceRect), page.blocks.map((b) => b.sourceRect));
  for (const corrupt of [
    (rows) => rows.slice(1), (rows) => [...rows].reverse(),
    (rows) => [{ ...rows[0], id: rows[1].id }, ...rows.slice(1)],
    (rows) => [{ ...rows[0], text: "" }, ...rows.slice(1)],
  ]) assert.throws(() => restoreTextTranslation({ translations: corrupt(translated(page).translations) }, page, source));
});

test("keeps printed page numbers unchanged in the stable-ID route", () => {
  const source = sourceFixture();
  source.words.push({ text: "7", block: 3, line: 7, rect: { x: .49, y: .94, width: .02, height: .016 } });
  const page = buildTextPage(source), output = translated(page);
  assert.equal(page.blocks.at(-1).kind, "page_number");
  assert.throws(() => restoreTextTranslation(output, page, source), /page number/);
  output.translations.at(-1).text = "7";
  assert.equal(restoreTextTranslation(output, page, source).at(-1).text, "7");
});

test("rejects formulas, lists, overlapping columns, unsupported scripts and unreliable OCR", () => {
  for (const corrupt of [
    (s) => { s.words[3].text = "x=y"; },
    (s) => { s.words[0].text = "1."; },
    (s) => { s.words[3].text = "\ufffd"; },
    (s) => { s.words[3].text = "数学"; },
    (s) => { s.words.filter((w) => w.block === 2).forEach((w) => { w.rect.y -= .1; }); },
    (s) => { s.words[2].rect.height /= 2; },
  ]) { const s = sourceFixture(); corrupt(s); assert.equal(buildTextPage(s), null); }
  const ocr = { ...sourceFixture(), method: "ocr", confidence: 80, retainedWordRatio: 1 };
  assert.equal(canCropBoundary(ocr, "top"), false);
  ocr.confidence = 99;
  assert.equal(canCropBoundary(ocr, "top"), true);
  assert.equal(canCropBoundary(ocr, "bottom"), false);
  ocr.retainedWordRatio = .8;
  assert.equal(canCropBoundary(ocr, "top"), false);
});

test("retains complete boundary paragraphs and full images for uncertain previous-page revisions", () => {
  const page = buildTextPage(sourceFixture());
  assert.equal(boundaryText(page, "top"), page.blocks.map((b) => b.text).join("\n\n"));
  const long = structuredClone(page); long.blocks[0].text = "x".repeat(3501);
  assert.equal(boundaryText(long, "top"), null);
  assert.equal(needsPreviousPageImage("The incomplete De-"), true);
  assert.equal(needsPreviousPageImage("The completed sentence.”"), false);
  assert.equal(needsPreviousPageImage(), false);
});

test("compact and stable-ID contracts reduce serialized output while preserving the same translated text", () => {
  const source = sourceFixture(), page = buildTextPage(source);
  const restored = restoreTextTranslation(translated(page), page, source);
  const compact = restored.map((block) => { const b = structuredClone(block); delete b.text;
    b.sentences.forEach((s) => delete s.sourceRects); return b; });
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
  assert.ok(bytes(compact) < bytes(restored) * .75);
  assert.ok(bytes(translated(page)) < bytes(restored) * .2);
  assert.deepEqual(restoreCompactBlocks(compact).map((b) => b.text), restored.map((b) => b.text));
});

let poppler = true;
try { execFileSync("pdftocairo", ["-v"], { stdio: "ignore" }); execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); }
catch { poppler = false; }

test("real Poppler pages admit ordinary prose and retain vision for diagrams, columns, formulas and hidden text", { skip: !poppler }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "verso-source-"));
  try {
    for (const variant of [{}, { graphics: true }, { columns: true }, { formula: true }, { hidden: true }]) {
      const file = path.join(directory, "page.pdf");
      await writeFile(file, makeSourcePdf(variant));
      const layout = parsePdfWordLayout(execFileSync("pdftotext", ["-bbox-layout", file, "-"], { encoding: "utf8" }));
      const svg = execFileSync("pdftocairo", ["-svg", file, "-"], { encoding: "utf8" });
      const admitted = Boolean(buildTextPage(layout) && isTextOnlySvg(svg, layout));
      assert.equal(admitted, Object.keys(variant).length === 0, JSON.stringify(variant));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native analysis is reusable and native boundary renders keep full-resolution half-page crops", { skip: !poppler }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "verso-analysis-"));
  const oldDirectory = process.env.VERSO_DATA_DIR;
  process.env.VERSO_DATA_DIR = directory;
  try {
    const { mkdir, readFile, stat } = await import("node:fs/promises");
    const { analyzeSourcePage } = await import("../lib/server-source-analysis.ts");
    const { getRenderedBoundaryPage } = await import("../lib/server-page-renderer.ts");
    const fingerprint = "c4".repeat(32);
    const book = { fingerprint, objectKey: `books/${fingerprint}.pdf`, pageCount: 1 };
    await mkdir(path.join(directory, "books"));
    await writeFile(path.join(directory, book.objectKey), makeSourcePdf());
    const first = await analyzeSourcePage(book, 1), second = await analyzeSourcePage(book, 1);
    assert.ok(first.textPage);
    let fontTool = false;
    try { execFileSync("pdftohtml", ["-v"], { stdio: "ignore" }); fontTool = true; } catch { /* Optional native tool. */ }
    if (fontTool) assert.ok(first.layout.words.every((word) => word.fontSize === 12 / 600));
    assert.deepEqual(second, first);
    const cache = path.join(directory, "renders", fingerprint, "v3", "embedded", "000001.json");
    assert.equal((await stat(cache)).mode & 0o777, 0o600);
    const { getSourcePageLayout } = await import("../lib/server-source-layout.ts");
    const legacyPath = path.join(directory, "renders", fingerprint, "v1", "words");
    await mkdir(legacyPath, { recursive: true });
    const legacyOcr = { ...sourceFixture(), method: "ocr" };
    await writeFile(path.join(legacyPath, "000002.json"), JSON.stringify(legacyOcr));
    assert.deepEqual(await getSourcePageLayout({ ...book, pageCount: 2 }, 2), legacyOcr);
    // A syntactically valid but structurally damaged cache must be regenerated.
    await writeFile(cache, '{"words":null}');
    assert.deepEqual(await analyzeSourcePage(book, 1), first);
    for (const side of ["top", "bottom"]) {
      const image = await getRenderedBoundaryPage(book, 1, side, first.layout);
      assert.equal(image.cacheHit, false);
      const cached = await getRenderedBoundaryPage(book, 1, side, first.layout);
      assert.equal(cached.cacheHit, true);
      assert.deepEqual(cached.bytes, image.bytes);
      let offset = 2, dimensions;
      while (offset < image.bytes.length) {
        const marker = image.bytes[offset + 1], length = image.bytes.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          dimensions = { width: image.bytes.readUInt16BE(offset + 7), height: image.bytes.readUInt16BE(offset + 5) }; break;
        }
        offset += length + 2;
      }
      assert.deepEqual(dimensions, { width: 1650, height: 1100 });
    }
    assert.equal(JSON.parse(await readFile(path.join(directory, "renders", fingerprint, "v2", "textonly", "000001.json"), "utf8")), true);
  } finally {
    if (oldDirectory === undefined) delete process.env.VERSO_DATA_DIR; else process.env.VERSO_DATA_DIR = oldDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
