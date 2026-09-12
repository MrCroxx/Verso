import assert from "node:assert/strict";
import test from "node:test";
import { alignSourceBlocks } from "../lib/source-alignment.ts";
import { normalizeLayoutBlocks } from "../lib/translation-layout.ts";
import { groupTranslationMedia } from "../lib/translation-media.ts";
import { excludeImageText, resolveImageCrop } from "../lib/image-crop.ts";

const word = (text, height, line = 1, width = 5, y = 100) => ({ text, line,
  rect: { x: .1, y: y / 800, width: width / 600, height: height / 800 } });
const block = (sourceText, kind = "paragraph", fontSize = .1) => ({ kind, text: "译文", fontSize,
  sentences: [{ text: "译文", sourceText, sourceRects: [] }] });

test("font estimates use text height, preserving narrow letters, CJK and source hierarchy", () => {
  const words = [word("I", 12), word("a", 12), word("中", 12), word("文", 12),
    word("Heading", 24, 2, 100, 150), word("Caption", 9, 3, 50, 200)];
  const blocks = normalizeLayoutBlocks([block("I a 中文"), block("Heading", "heading"), block("Caption", "caption")]);
  const result = alignSourceBlocks(blocks, { width: 600, height: 800, words, method: "pdf" });
  assert.deepEqual(result.map((b) => b.fontSize), [.02, .04, .015]);
  assert.equal(result[0].text, blocks[0].text);
  assert.ok(result.every((b) => b.sentences[0].sourceRects.length));
});

test("OCR line estimates resist punctuation, superscripts, drop caps and uneven word heights", () => {
  const words = [word("A", 38), word("normal", 12), word("sentence", 12), word("1", 5),
    word("...", 3), word("another", 11, 2), word("ordinary", 12, 2), word("line", 9, 2),
    word("readable", 12, 3), word("paragraph", 11, 3)];
  const result = alignSourceBlocks(normalizeLayoutBlocks([block(words.map((w) => w.text).join(" "))]),
    { width: 600, height: 800, words, method: "ocr" });
  assert.equal(result[0].fontSize, .02);
});

test("unmatched headings and equations do not borrow unrelated body typography", () => {
  const blocks = normalizeLayoutBlocks([block("Missing heading", "heading", .05), block("x=1", "equation", .025)]);
  const result = alignSourceBlocks(blocks, { width: 600, height: 800, words: [word("body", 12)], method: "pdf" });
  assert.deepEqual(result.map((b) => b.fontSize), [.05, .025]);
});

const page = { width: 600, height: 800 };
const estimate = { x: 100, y: 200, width: 300, height: 300 };
test("trims separately translated prose from each image edge and bounds later expansion", () => {
  const text = [{ x: 100, y: 190, width: 300, height: 40 },
    { x: 100, y: 470, width: 300, height: 45 },
    { x: 80, y: 240, width: 50, height: 210 },
    { x: 370, y: 240, width: 100, height: 210 }];
  const { crop, bounds } = excludeImageText(page, estimate, text);
  assert.deepEqual(crop, { x: 132, y: 232, width: 236, height: 236 });
  const resolved = resolveImageCrop(page, crop, (region) => {
    assert.ok(region.x >= bounds.x && region.y >= bounds.y);
    assert.ok(region.x + region.width <= bounds.x + bounds.width);
    assert.ok(region.y + region.height <= bounds.y + bounds.height);
    const data = new Uint8ClampedArray(region.width * region.height * 4).fill(255);
    // Interior artwork remains intact; surrounding prose is never read back.
    for (let y = 8; y < region.height - 8; y++) for (let x = 8; x < region.width - 8; x++) {
      const offset = (y * region.width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 0;
    }
    return { ...region, data };
  }, { bounds });
  assert.deepEqual(resolved, crop);
});

test("ambiguous central text and other-column text do not clip artwork", () => {
  for (const text of [[{ x: 150, y: 300, width: 120, height: 50 }],
    [{ x: 450, y: 450, width: 100, height: 60 }], []]) {
    assert.deepEqual(excludeImageText(page, estimate, text).crop, estimate);
  }
});

test("media exclusion uses grounded translated text, leaving diagram labels and unmatched estimates alone", () => {
  const rect = { x: .1, y: .5, width: .8, height: .03 };
  const blocks = normalizeLayoutBlocks([
    { kind: "image", sourceRect: { x: .1, y: .1, width: .8, height: .45 } },
    { ...block("Body text"), sentences: [{ text: "译文", sourceText: "Body text", sourceRects: [rect] }] },
    { ...block("Unmatched label"), sourceRect: { x: .2, y: .2, width: .1, height: .02 } },
    { ...block("x=1", "equation"), sentences: [{ text: "x=1", sourceText: "x=1", sourceRects: [rect] }] },
  ]);
  const image = groupTranslationMedia(blocks)[0];
  assert.equal(image.surroundingTextRects.length, 1);
  for (const key of Object.keys(rect)) assert.ok(Math.abs(image.surroundingTextRects[0][key] - rect[key]) < 1e-12);
  assert.equal(blocks[0].sourceRect.height, .45);
});

test("PDF font metadata corrects inflated bounding boxes without changing source geometry", async () => {
  const { applyPdfFontSizes } = await import("../lib/source-alignment.ts");
  const layout = { width: 600, height: 800, method: "pdf", words: [word("Heading", 36, 1, 100, 100), word("Body", 18, 2, 30, 200)] };
  const xml = `<page width="600" height="800"><fontspec id="0" size="24"/><fontspec id="1" size="12"/>
    <text top="100" left="60" width="100" height="36" font="0">Heading</text>
    <text top="200" left="60" width="30" height="18" font="1"><b>Body</b></text></page>`;
  const enriched = applyPdfFontSizes(layout, xml);
  assert.deepEqual(enriched.words.map((w) => w.rect), layout.words.map((w) => w.rect));
  const result = alignSourceBlocks(normalizeLayoutBlocks([block("Heading", "heading"), block("Body")]), enriched);
  assert.deepEqual(result.map((b) => b.fontSize), [.04, .02]);
  assert.equal(applyPdfFontSizes(layout, xml.replace('width="600"', 'width="800"')), layout);
  assert.equal(applyPdfFontSizes(layout, ""), layout);
});
